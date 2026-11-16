"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: pause } = require("node:timers/promises");
const { createTextBatcher } = require("../src/text-batcher.cjs");

test("text batcher combines rapid writes into a single flush within delay limit", async () => {
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text);
      return { offset: flushes.length };
    },
    delayMs: 25,
  });

  const p1 = batcher.append("hello ");
  const p2 = batcher.append("world");
  assert.equal(flushes.length, 0);

  await Promise.all([p1, p2]);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], "hello world");
});

test("text batcher flushes immediately when batch reaches 16 KiB without waiting for timer", async () => {
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text.length);
    },
    delayMs: 100,
    maxBatchBytes: 16384,
  });

  const chunk = "a".repeat(8192);
  const p1 = batcher.append(chunk);
  assert.equal(flushes.length, 0);

  const p2 = batcher.append(chunk);
  await Promise.all([p1, p2]);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], 16384);
});

test("text batcher handles multiple consecutive batches exceeding 16 KiB", async () => {
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text.length);
    },
    delayMs: 50,
    maxBatchBytes: 16384,
    maxBufferedBytes: 65536,
  });

  const chunk = "x".repeat(8192);
  const p1 = batcher.append(chunk);
  const p2 = batcher.append(chunk); // Batch 1: 16384
  const p3 = batcher.append(chunk);
  const p4 = batcher.append(chunk); // Batch 2: 16384

  await Promise.all([p1, p2, p3, p4]);
  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes, [16384, 16384]);
});

test("drivers awaiting emitText sequentially do not deadlock", async () => {
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text);
    },
    delayMs: 10,
  });

  await batcher.append("token1");
  await batcher.append("token2");
  await batcher.append("token3");

  assert.equal(flushes.length, 3);
  assert.deepEqual(flushes, ["token1", "token2", "token3"]);
});

test("flush failure rejects emitText promises and does not acknowledge success", async () => {
  const batcher = createTextBatcher({
    onFlush: async () => {
      throw Object.assign(new Error("disk write error"), { code: "STORAGE_FAILED" });
    },
    delayMs: 10,
  });

  const p = batcher.append("unpersisted");
  await assert.rejects(p, { code: "STORAGE_FAILED" });
  await assert.rejects(batcher.flush(), { code: "STORAGE_FAILED" });
});

test("onFlush failure with multiple queued batches settles all append promises without calling flush and without unhandledRejection", async () => {
  let unhandledRejections = 0;
  const onUnhandled = () => { unhandledRejections++; };
  process.on("unhandledRejection", onUnhandled);

  try {
    const batcher = createTextBatcher({
      onFlush: async () => {
        throw Object.assign(new Error("disk write error"), { code: "STORAGE_FAILED" });
      },
      delayMs: 20,
      maxBatchBytes: 10,
      maxBufferedBytes: 100,
    });

    // Batch 1: 10 bytes (fills maxBatchBytes, triggers flush)
    const p1 = batcher.append("1234567890");
    // Batch 2: 10 bytes (fills maxBatchBytes while batch 1 in-flight, queued)
    const p2 = batcher.append("abcdefghij");
    // Batch 3: 5 bytes (queued behind batch 2)
    const p3 = batcher.append("klmno");

    // Do NOT call batcher.flush()!
    // All promises must settle and reject
    await assert.rejects(p1, { code: "STORAGE_FAILED" });
    await assert.rejects(p2, { code: "STORAGE_FAILED" });
    await assert.rejects(p3, { code: "STORAGE_FAILED" });

    // Allow event loop to turn to ensure no unhandledRejection
    await pause(50);
    assert.equal(unhandledRejections, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("dispose awaits in-flight write without issuing queued writes afterward", async () => {
  let inFlightFinished = false;
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text);
      await pause(40);
      inFlightFinished = true;
    },
    delayMs: 100,
    maxBatchBytes: 10,
    maxBufferedBytes: 100,
  });

  const p1 = batcher.append("1234567890"); // Batch 1 triggers flush
  await pause(10); // Allow performFlush to start and enter onFlush
  const p2 = batcher.append("abcdefghij"); // Batch 2 queued while batch 1 is in-flight

  const rejectP2 = assert.rejects(p2, { code: "BATCHER_CLOSED" });

  await batcher.dispose();
  await rejectP2;
  await p1;

  // in-flight batch 1 was awaited and completed
  assert.equal(inFlightFinished, true);
  // Queued batch 2 was NOT issued as a write
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], "1234567890");
});

test("zero-length delta is ignored without accumulating queue entries and entry count is capped", async () => {
  const batcher = createTextBatcher({
    onFlush: async () => {},
    delayMs: 100,
    maxQueueEntries: 5,
  });

  // Zero-length deltas resolve immediately without adding queue entries
  await batcher.append("");
  await batcher.append("");
  assert.equal(batcher.queueLength, 0);

  // Adding up to limit
  for (let i = 0; i < 5; i++) {
    batcher.append(`x${i}`);
  }
  assert.equal(batcher.queueLength, 5);

  // 6th entry exceeds maxQueueEntries
  await assert.rejects(batcher.append("overflow"), { code: "BUFFER_OVERFLOW" });
  await batcher.flush();
});

test("explicit flush commits pending buffer immediately before terminal state", async () => {
  const flushes = [];
  const batcher = createTextBatcher({
    onFlush: async text => {
      flushes.push(text);
    },
    delayMs: 100,
  });

  const p = batcher.append("immediate");
  assert.equal(flushes.length, 0);
  await batcher.flush();
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], "immediate");
  await p;
});

test("buffer overflow rejects when total buffered bytes exceeds maxBufferedBytes", async () => {
  const batcher = createTextBatcher({
    onFlush: async () => {},
    delayMs: 50,
    maxBatchBytes: 150,
    maxBufferedBytes: 150,
  });

  batcher.append("a".repeat(80)); // pendingBytes: 80
  batcher.append("b".repeat(60)); // pendingBytes: 140
  // Adding 20 more exceeds maxBufferedBytes (140 + 20 = 160 > 150)
  await assert.rejects(batcher.append("c".repeat(20)), { code: "BUFFER_OVERFLOW" });
  await batcher.flush();
});
