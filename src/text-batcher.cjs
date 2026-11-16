"use strict";

const failure = (code, message) => Object.assign(new Error(message), { code });
const MAX_QUEUE_ENTRIES = 1000;

function createTextBatcher({
  onFlush,
  delayMs = 100,
  maxBatchBytes = 16384,
  maxBufferedBytes = 65536,
  maxQueueEntries = MAX_QUEUE_ENTRIES,
} = {}) {
  if (typeof onFlush !== "function") throw failure("INVALID_ARGUMENT", "onFlush function is required");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 100) {
    throw failure("INVALID_DELAY", "Flush delay must be between 0 and 100 ms");
  }
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < 1 || maxBatchBytes > 16384) {
    throw failure("INVALID_BATCH_SIZE", "Max batch size must be 1-16384 bytes");
  }
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < maxBatchBytes) {
    throw failure("INVALID_BUFFER_SIZE", "Max buffered bytes must be at least maxBatchBytes");
  }

  let queue = [];
  let pendingBytes = 0;
  let inFlightBytes = 0;
  let timer = null;
  let inFlight = Promise.resolve();
  let closed = false;
  let storedError = null;

  async function performFlush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;

    const currentBatch = [];
    let batchBytes = 0;
    while (queue.length > 0) {
      const next = queue[0];
      if (currentBatch.length > 0 && batchBytes + next.byteLength > maxBatchBytes) {
        break;
      }
      currentBatch.push(queue.shift());
      batchBytes += next.byteLength;
    }

    pendingBytes -= batchBytes;
    inFlightBytes += batchBytes;

    const combinedText = currentBatch.map(item => item.text).join("");
    try {
      const result = await onFlush(combinedText);
      for (const item of currentBatch) {
        item.resolve(result);
      }
      return result;
    } catch (err) {
      storedError ??= err;
      for (const item of currentBatch) {
        item.reject(err);
      }
      const remaining = queue;
      queue = [];
      pendingBytes = 0;
      for (const item of remaining) {
        item.reject(err);
      }
      throw err;
    } finally {
      inFlightBytes -= batchBytes;
      if (queue.length > 0 && !closed && !storedError) {
        triggerFlush();
      }
    }
  }

  function triggerFlush() {
    inFlight = inFlight.then(() => performFlush(), () => performFlush());
    inFlight.catch(() => {});
  }

  function scheduleFlush() {
    if (timer === null && !closed) {
      timer = setTimeout(() => {
        timer = null;
        triggerFlush();
      }, delayMs);
      if (typeof timer?.unref === "function") {
        timer.unref();
      }
    }
  }

  function append(delta) {
    if (typeof delta !== "string") {
      return Promise.reject(failure("INVALID_INPUT", "Text delta must be a string"));
    }
    if (delta.length === 0) {
      return Promise.resolve();
    }
    const byteLength = Buffer.byteLength(delta);
    if (byteLength > maxBatchBytes) {
      return Promise.reject(failure("INVALID_INPUT", "Single text delta exceeds max batch size"));
    }
    if (closed) {
      return Promise.reject(failure("BATCHER_CLOSED", "Text batcher is closed"));
    }
    if (storedError) {
      return Promise.reject(storedError);
    }
    if (queue.length >= maxQueueEntries) {
      return Promise.reject(failure("BUFFER_OVERFLOW", "Queue entry limit exceeded"));
    }
    if (inFlightBytes + pendingBytes + byteLength > maxBufferedBytes) {
      return Promise.reject(failure("BUFFER_OVERFLOW", "Buffered text limit exceeded"));
    }

    pendingBytes += byteLength;

    return new Promise((resolve, reject) => {
      queue.push({ text: delta, byteLength, resolve, reject });

      let currentQueueBytes = 0;
      for (const item of queue) currentQueueBytes += item.byteLength;

      if (currentQueueBytes >= maxBatchBytes) {
        triggerFlush();
      } else {
        scheduleFlush();
      }
    });
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (queue.length > 0) {
      triggerFlush();
      try { await inFlight; } catch {}
    }
    try { await inFlight; } catch {}
    if (storedError) throw storedError;
  }

  async function dispose() {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const discarded = queue;
    queue = [];
    pendingBytes = 0;
    for (const item of discarded) {
      item.reject(storedError ?? failure("BATCHER_CLOSED", "Text batcher closed before flush"));
    }
    try { await inFlight; } catch {}
  }

  return {
    append,
    flush,
    dispose,
    get pendingBytes() { return pendingBytes; },
    get inFlightBytes() { return inFlightBytes; },
    get queueLength() { return queue.length; },
  };
}

module.exports = { createTextBatcher };
