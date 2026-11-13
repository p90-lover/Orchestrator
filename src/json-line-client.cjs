"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const failure = (code, message) => Object.assign(new Error(message), { code });

function createJsonLineClient({ executable, args = [], cwd, env, onNotification = () => {}, onRequest, onClose = () => {}, maxMessageBytes = 2 * 1024 * 1024, requestTimeoutMs = 30000 }) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || !path.isAbsolute(cwd)) throw failure("INVALID_LAUNCH", "Absolute executable and working directory are required");
  if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) throw failure("INVALID_LAUNCH", "Invalid launch arguments");
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const decoder = new StringDecoder("utf8");
  let buffer = "", sequence = 0, closed = false, requestCount = 0;
  const exited = new Promise(resolve => child.once("close", resolve));
  function shutdown(error) {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    try { onClose(error); } catch {}
    child.kill();
  }
  function send(value) {
    if (closed) throw failure("DRIVER_CLOSED", "Harness connection is closed");
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > maxMessageBytes || child.stdin.writableLength > maxMessageBytes) throw failure("DRIVER_BACKPRESSURE", "Harness request exceeds its transport budget");
    child.stdin.write(line);
  }
  function receive(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw failure("INVALID_PROTOCOL", "Invalid harness message");
    if (typeof message.method === "string") {
      if (!Object.hasOwn(message, "id")) { onNotification(message.method, message.params ?? {}); return; }
      if (++requestCount > 32) throw failure("DRIVER_BACKPRESSURE", "Too many outstanding harness requests");
      Promise.resolve().then(() => {
        if (typeof onRequest !== "function") throw failure("UNSUPPORTED_REQUEST", "Harness request is not supported");
        return onRequest(message.method, message.params ?? {});
      }).then(result => { if (!closed) send({ id: message.id, result }); }, () => {
        if (!closed) send({ id: message.id, error: { code: -32601, message: "Request is unsupported or denied by the host" } });
      }).catch(error => shutdown(error)).finally(() => { requestCount -= 1; });
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(failure("HARNESS_REQUEST_FAILED", "Harness rejected the protocol request"));
    else if (Object.hasOwn(message, "result")) request.resolve(message.result);
    else request.reject(failure("INVALID_PROTOCOL", "Harness reply has no result"));
  }
  child.stdout.on("data", chunk => {
    try {
      buffer += decoder.write(chunk);
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > maxMessageBytes) throw failure("PROTOCOL_LIMIT", "Harness message is too large");
        if (line.trim()) receive(JSON.parse(line));
      }
      if (Buffer.byteLength(buffer) > maxMessageBytes) throw failure("PROTOCOL_LIMIT", "Harness message is too large");
    } catch (error) { shutdown(error); }
  });
  // Drain diagnostics without retaining them or persisting provider output.
  child.stderr.on("data", () => {});
  child.on("error", () => shutdown(failure("DRIVER_SPAWN_FAILED", "Harness process could not start")));
  child.on("close", () => shutdown(failure("DRIVER_EXITED", "Harness process exited before its outcome was confirmed")));
  child.stdin.on("error", () => shutdown(failure("DRIVER_WRITE_FAILED", "Harness request delivery is uncertain")));
  return Object.freeze({
    request(method, params = {}) {
      if (closed) return Promise.reject(failure("DRIVER_CLOSED", "Harness connection is closed"));
      if (pending.size >= 64) return Promise.reject(failure("DRIVER_BACKPRESSURE", "Too many harness requests"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => shutdown(failure("DRIVER_TIMEOUT", "Harness request outcome is unknown")), requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    notify(method, params = {}) { send({ method, params }); },
    async close() { shutdown(failure("DRIVER_CLOSED", "Harness connection closed by its owner")); await exited; },
  });
}

module.exports = { createJsonLineClient };
