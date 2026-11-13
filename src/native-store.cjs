"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const failure = (code, message) => Object.assign(new Error(message), { code });

async function openNativeStore({ dataRoot, maxPending = 128, startupTimeoutMs = 30000 } = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw failure("INVALID_DATA_ROOT", "Choose an absolute native data directory");
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1024) throw failure("INVALID_CAPACITY", "Invalid storage request capacity");
  const worker = new Worker(path.join(__dirname, "native-store-worker.cjs"), { workerData: { dataRoot } });
  const exited = new Promise(resolve => worker.once("exit", resolve));
  let sequence = 0, closed = false, closing = null;
  const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function failAll(error) {
    closed = true;
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  const timer = setTimeout(() => {
    failAll(failure("STORE_START_TIMEOUT", "Native storage did not become ready"));
    void worker.terminate();
  }, startupTimeoutMs);
  worker.on("message", message => {
    if (message.ready) { clearTimeout(timer); resolveReady(); return; }
    if (message.startupError) { clearTimeout(timer); failAll(failure(message.startupError.code, message.startupError.message)); return; }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) request.reject(failure(message.error.code, message.error.message));
    else request.resolve(message.result);
  });
  worker.on("error", () => { clearTimeout(timer); failAll(failure("STORE_WORKER_FAILED", "Native storage worker failed; operation outcome may be unknown")); });
  worker.on("exit", () => { clearTimeout(timer); failAll(failure("STORE_CLOSED", "Native storage is closed")); });
  try { await ready; } catch (error) { await worker.terminate(); throw error; }
  function call(operation, args = {}) {
    if (closed || closing && operation !== "close") return Promise.reject(failure("STORE_CLOSED", "Native storage is closing"));
    if (pending.size >= maxPending && operation !== "close") return Promise.reject(failure("STORE_BUSY", "Native storage request queue is full"));
    return new Promise((resolve, reject) => {
      const requestId = ++sequence;
      pending.set(requestId, { resolve, reject });
      try { worker.postMessage({ requestId, operation, args }); }
      catch (error) { pending.delete(requestId); reject(error); }
    });
  }
  return Object.freeze({
    call,
    close() {
      closing ??= call("close").then(async value => { await exited; return value; }).finally(() => { closed = true; });
      return closing;
    },
  });
}

module.exports = { openNativeStore };
