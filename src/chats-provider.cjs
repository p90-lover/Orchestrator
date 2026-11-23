"use strict";

const http = require("node:http");
const https = require("node:https");
const { createChatsRuntime, CHAT_CONTRACT_VERSION } = require("./chats.cjs");

const MAX_BODY = 1024 * 1024;
const MAX_CONTEXT = 128 * 1024;
const MAX_TURNS = 32;
const fail = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });

function complete(endpoint, token, body, signal) {
  return new Promise((resolve, reject) => {
    const request = (endpoint.protocol === "https:" ? https : http).request(endpoint, { method: "POST",
      agent: false, signal, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(fail("CHATS_PROVIDER_REFUSED", "The approved provider did not accept the request", response.statusCode >= 500));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { reject(fail("CHATS_OUTPUT_LIMIT", "Provider output exceeds the response limit", true)); response.destroy(); }
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const choices = JSON.parse(Buffer.concat(chunks).toString("utf8")).choices;
          const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
          const text = choice?.message?.content;
          if (choice?.finish_reason !== "stop" || choice.message?.tool_calls?.length || typeof text !== "string" || !text.trim()) throw new Error();
          if (Buffer.byteLength(JSON.stringify(text)) > 256 * 1024) { reject(fail("CHATS_OUTPUT_LIMIT", "Provider output exceeds the chat limit", true)); return; }
          resolve(text);
        } catch { reject(fail("CHATS_PROVIDER_UNCONFIRMED", "Provider did not return a complete text response", true)); }
      });
      response.once("error", () => reject(fail("CHATS_PROVIDER_UNCONFIRMED", "Provider response was interrupted", true)));
    });
    const timer = setTimeout(() => request.destroy(), 45_000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", () => reject(fail("CHATS_PROVIDER_UNCONFIRMED", "Provider delivery was not confirmed", true)));
    request.end(body);
  });
}

function createChatsProvider({ endpoint, protocol, model, token, ...scope } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw fail("CHATS_BINDING_REQUIRED", "An approved provider URL is required"); }
  if (protocol !== "openai-completions" || url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    || (token !== undefined && (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)))) {
    throw fail("CHATS_BINDING_REQUIRED", "Use an approved HTTPS or loopback chat-completions binding");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return createChatsRuntime({ ...scope, model, driverFactory() {
    const history = new Map();
    let closed = false;
    return {
      async run({ session, turn, signal, emitText }) {
        const previous = history.get(session.id) ?? [];
        if (closed || signal.aborted || session.config.model !== model) throw fail("CHATS_PROVIDER_SCOPE", "The selected model binding changed");
        const messages = [...previous, { role: "user", content: turn.prompt }];
        const body = JSON.stringify({ model, messages, stream: false });
        if (previous.length >= MAX_TURNS * 2 || Buffer.byteLength(body) > MAX_CONTEXT || (!history.has(session.id) && history.size >= 64)) {
          throw fail("CHATS_CONTEXT_LIMIT", "This chat reached the provider context budget; start a new chat");
        }
        const reply = await complete(url, token, body, signal);
        for (let offset = 0; offset < reply.length;) {
          let end = Math.min(reply.length, offset + 4096);
          if (end < reply.length && /[\uD800-\uDBFF]/.test(reply[end - 1])) end--;
          await emitText(reply.slice(offset, end));
          offset = end;
        }
        history.set(session.id, [...messages, { role: "assistant", content: reply }]);
      },
      async cancel() { return false; },
      async close() { closed = true; history.clear(); },
    };
  } });
}

module.exports = { CHAT_CONTRACT_VERSION, createChatsProvider };
