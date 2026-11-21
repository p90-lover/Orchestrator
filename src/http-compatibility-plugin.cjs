"use strict";

const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { timingSafeEqual } = require("node:crypto");
const { createCompatibilityPlugin } = require("./compatibility-plugin.cjs");

const MAX_BODY = 64 * 1024;
const ENDPOINT = "/mcp";

function authorized(value, expected) {
  if (typeof value !== "string") return false;
  const received = Buffer.from(value);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function requestBody(request) {
  if (Number(request.headers["content-length"]) > MAX_BODY) return undefined;
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
}

async function startCompatibilityHttp({ scratchRoot, token, port = 0, probe } = {}) {
  if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) throw new Error("Provide an absolute isolated scratch directory");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)) throw new Error("Provide a fresh 32-byte hexadecimal compatibility token");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Choose a valid loopback port");
  const expected = Buffer.from(`Bearer ${token}`);
  const handle = createCompatibilityPlugin({ scratchRoot, probe, stateless: true });
  let authority, probing = false, closing;
  const server = http.createServer({ requestTimeout: 8000, headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const reply = (status, json, headers = {}) => {
      response.writeHead(status, { "Cache-Control": "no-store", ...headers, ...(json === undefined ? {} : { "Content-Type": "application/json" }) });
      response.end(json === undefined ? undefined : JSON.stringify(json));
    };
    const refused = (status, headers = {}) => reply(status, undefined, { Connection: "close", ...headers });
    void (async () => {
      if (request.headersDistinct.host?.length !== 1 || request.headers.host !== authority || request.headers.origin !== undefined) return refused(403);
      if (request.url !== ENDPOINT) return refused(404);
      if (request.headersDistinct.authorization?.length !== 1 || !authorized(request.headers.authorization, expected)) {
        return refused(401, { "WWW-Authenticate": "Bearer" });
      }
      if (request.method !== "POST") return refused(405, { Allow: "POST" });
      if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return refused(415);
      let message;
      try {
        const body = await requestBody(request);
        if (body === undefined) return refused(413);
        message = JSON.parse(body);
      } catch {
        return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON request" } }, { Connection: "close" });
      }
      const selfTest = message?.method === "tools/call" && message.params?.name === "orchestrator_self_test";
      if (selfTest && probing) return refused(429, { "Retry-After": "1" });
      if (selfTest) probing = true;
      try {
        const result = await handle(message);
        reply(result === null ? 202 : 200, result ?? undefined);
      } finally { if (selfTest) probing = false; }
    })().catch(() => {
      if (response.headersSent) response.destroy();
      else refused(500);
    });
  });
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 32;
  server.listen({ host: "127.0.0.1", port });
  await once(server, "listening");
  authority = `127.0.0.1:${server.address().port}`;
  return Object.freeze({ url: `http://${authority}${ENDPOINT}`,
    close: () => closing ??= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) });
}

module.exports = { startCompatibilityHttp };
