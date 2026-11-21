"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: pause } = require("node:timers/promises");
const { openNativeStore } = require("../src/native-store.cjs");
const { createNativeEngine } = require("../src/native-engine.cjs");

const temporaryRoots = [];
test.after(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });

function directory(t) {
  const parent = path.resolve(__dirname, "../aiTemp/native-core");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  temporaryRoots.push(root);
  return root;
}
async function until(read, predicate, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const value = await read(); if (predicate(value)) return value; await pause(5); }
  throw new Error("Condition did not settle");
}
const abortWait = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });

test("native storage persists acceptance, deduplicates requests and scopes all reads", async t => {
  const store = await openNativeStore({ dataRoot: directory(t) });
  t.after(() => store.close());
  const session = await store.call("create", { workspaceId: "workspace", harness: "fixture", root: __dirname });
  const accepted = await store.call("enqueue", { id: session.id, prompt: "hello", clientMessageId: "client-1" });
  const again = await store.call("enqueue", { id: session.id, prompt: "hello", clientMessageId: "client-1" });
  assert.equal(again.id, accepted.id);
  assert.equal(again.duplicate, true);
  await assert.rejects(store.call("enqueue", { id: session.id, prompt: "changed", clientMessageId: "client-1" }), { code: "IDEMPOTENCY_CONFLICT" });
  const other = await store.call("create", { workspaceId: "workspace", harness: "fixture", root: __dirname });
  await assert.rejects(store.call("observe", { id: other.id, turnId: accepted.id }), { code: "TURN_NOT_FOUND" });
  assert.equal((await store.call("claim", { id: session.id })).id, accepted.id);
  assert.equal(await store.call("claim", { id: session.id }), null);
  await store.call("append", { id: session.id, turnId: accepted.id, delta: "answer" });
  await store.call("settle", { id: session.id, turnId: accepted.id, state: "completed" });
  const events = await store.call("events", { id: session.id, limit: 2 });
  assert.equal(events.items.length, 2);
  assert.equal(events.hasMore, true);
  const next = await store.call("events", { id: session.id, after: events.cursor, limit: 2 });
  assert.ok(next.items.every(item => item.sequence > events.cursor));
});

test("restart keeps unresolved work unknown and never claims it automatically", async t => {
  const dataRoot = directory(t);
  let store = await openNativeStore({ dataRoot });
  const session = await store.call("create", { workspaceId: "workspace", harness: "fixture", root: __dirname });
  const a = await store.call("enqueue", { id: session.id, prompt: "first", clientMessageId: "one" });
  const b = await store.call("enqueue", { id: session.id, prompt: "second", clientMessageId: "two" });
  await store.call("claim", { id: session.id });
  await assert.rejects(store.call("settle", { id: session.id, turnId: a.id, state: "cancelled", expectedState: "queued" }), { code: "TURN_OWNERSHIP_UNCONFIRMED" });
  await store.close();
  store = await openNativeStore({ dataRoot });
  t.after(() => store.close());
  assert.equal((await store.call("observe", { id: session.id, turnId: a.id })).turn.state, "unknown");
  assert.equal((await store.call("observe", { id: session.id, turnId: b.id })).turn.state, "queued");
  assert.equal(await store.call("claim", { id: session.id }), null);
  await assert.rejects(store.call("settle", { id: session.id, turnId: a.id, state: "cancelled" }), { code: "TURN_OWNERSHIP_UNCONFIRMED" });
  assert.equal(await store.call("claim", { id: session.id }), null);
  assert.equal((await store.call("settle", { id: session.id, turnId: b.id, state: "cancelled", expectedState: "queued" })).state, "cancelled");
  assert.equal((await store.call("observe", { id: session.id, turnId: a.id })).session.state, "unknown");
});

test("one coordinator owns a data root and bounded admission survives duplicates", async t => {
  const dataRoot = directory(t);
  const store = await openNativeStore({ dataRoot });
  t.after(() => store.close());
  await assert.rejects(openNativeStore({ dataRoot }), { code: "STORE_IN_USE" });
  const session = await store.call("create", { workspaceId: "workspace", harness: "fixture", root: __dirname });
  await store.call("enqueue", { id: session.id, prompt: "first", clientMessageId: "one", capacity: 1 });
  assert.equal((await store.call("enqueue", { id: session.id, prompt: "first", clientMessageId: "one", capacity: 1 })).duplicate, true);
  await assert.rejects(store.call("enqueue", { id: session.id, prompt: "second", clientMessageId: "two", capacity: 1 }), { code: "QUEUE_FULL" });
  await assert.rejects(store.call("events", { id: session.id, after: -1 }), { code: "INVALID_CURSOR" });
});

test("native engine executes without AO, queues in order and does not replay duplicate input", async t => {
  const runs = [];
  const driver = { async run({ turn, emitText }) { runs.push(turn.prompt); await emitText(`reply:${turn.prompt}`); }, async cancel() {} };
  const engine = await createNativeEngine({ dataRoot: directory(t), drivers: { fixture: driver } });
  t.after(() => engine.close());
  const session = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => engine.send(session.id, `message-${i}`, `client-${i}`)));
  await engine.send(session.id, "message-0", "client-0");
  await until(() => engine.observe(session.id, replies[4].turnId), value => value.turnState === "completed");
  assert.deepEqual(runs, ["message-0", "message-1", "message-2", "message-3", "message-4"]);
  assert.equal((await engine.observe(session.id, replies[0].turnId)).answer, "reply:message-0");
  assert.equal(engine.capabilities().productionReady, false);
  assert.ok(engine.capabilities().missing.includes("Coding-Tools-cutover"));
});

test("cancel is turn-scoped and lets the queued follow-up run after the old driver ends", async t => {
  let started = false;
  const driver = { async run({ turn, signal, emitText }) { if (turn.prompt === "hold") { started = true; await emitText("pre-cancel text"); await abortWait(signal); } else await emitText("next"); }, async cancel() {} };
  const engine = await createNativeEngine({ dataRoot: directory(t), drivers: { fixture: driver } });
  t.after(() => engine.close());
  const session = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const a = await engine.send(session.id, "hold", "first");
  await until(async () => started, Boolean);
  const b = await engine.send(session.id, "next", "second");
  const other = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  await assert.rejects(engine.cancel(other.id, a.turnId), { code: "TURN_NOT_FOUND" });
  await engine.cancel(session.id, a.turnId);
  await until(() => engine.observe(session.id, b.turnId), value => value.turnState === "completed");
  assert.equal((await engine.observe(session.id, a.turnId)).turnState, "cancelled");
  assert.equal((await engine.observe(session.id, a.turnId)).answer, "pre-cancel text");
});

test("driver failures do not claim success or expose arbitrary driver error text", async t => {
  const engine = await createNativeEngine({ dataRoot: directory(t), drivers: { fixture: { async run() { throw new Error("private fixture detail"); }, async cancel() {} } } });
  t.after(() => engine.close());
  const session = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const turn = await engine.send(session.id, "hello", "client");
  const result = await until(() => engine.observe(session.id, turn.turnId), value => value.turnState === "failed");
  assert.equal(result.error, "Harness execution failed");
  assert.doesNotMatch(JSON.stringify(await engine.events(session.id)), /private fixture detail/);
});

test("queued recovery executes queued work only under explicit engine.recover and preserves deduplication", async t => {
  const dataRoot = directory(t);
  const runs = [];
  const driver = {
    async run({ turn, emitText }) {
      runs.push(turn.prompt);
      await emitText(`done:${turn.prompt}`);
    },
    async cancel() {},
  };

  const store = await openNativeStore({ dataRoot });
  const session = await store.call("create", { workspaceId: "workspace", harness: "fixture", root: __dirname });
  const previous = await store.call("enqueue", { id: session.id, prompt: "already finished", clientMessageId: "finished" });
  await store.call("claim", { id: session.id });
  await store.call("settle", { id: session.id, turnId: previous.id, state: "completed" });
  const turnA = await store.call("enqueue", { id: session.id, prompt: "first-queued", clientMessageId: "c-1" });
  await store.close();

  // Step 2: Restart engine. The turn remains queued and is NOT automatically claimed or dispatched
  let engine = await createNativeEngine({ dataRoot, drivers: { fixture: driver } });
  t.after(() => engine?.close());

  const observed = await engine.observe(session.id, turnA.id);
  assert.equal(observed.turnState, "queued");
  assert.equal((await engine.recover(session.id, previous.id)).recovery, "observed");
  assert.equal((await engine.recover(session.id)).recovery, "observed");
  await pause(100);
  assert.equal((await engine.observe(session.id, turnA.id)).turnState, "queued");
  assert.deepEqual(runs, []);

  // Step 3: Explicit recover schedules the queued turn
  const recovered = await engine.recover(session.id, turnA.id);
  assert.equal(recovered.recovery, "scheduled");
  assert.equal(recovered.replayed, false);

  await until(() => engine.observe(session.id, turnA.id), v => v.turnState === "completed");
  assert.deepEqual(runs, ["first-queued"]);
  assert.equal((await engine.observe(session.id, turnA.id)).answer, "done:first-queued");

  // Step 4: Deduplication is preserved across restart
  const duplicateSend = await engine.send(session.id, "first-queued", "c-1");
  assert.equal(duplicateSend.turnId, turnA.id);
  assert.equal(duplicateSend.duplicate, true);
  assert.equal(runs.length, 1);
});

test("ambiguous driver outcomes remain unknown after a cancel request without an owner", async t => {
  const dataRoot = directory(t);
  let shouldFailAmbiguous = true;
  const runs = [];
  const driver = {
    async run({ turn, emitText }) {
      runs.push(turn.prompt);
      if (shouldFailAmbiguous) {
        await emitText("partial output before crash");
        const err = new Error("Transport lost during generation");
        err.code = "TRANSPORT_ERROR";
        err.uncertain = true;
        throw err;
      }
      await emitText(`success:${turn.prompt}`);
    },
    async cancel() {},
  };

  const engine = await createNativeEngine({ dataRoot, drivers: { fixture: driver } });
  t.after(() => engine.close());

  const session = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const first = await engine.send(session.id, "task-1", "msg-1");

  // First turn encounters ambiguous failure -> settles as 'unknown'
  const firstObs = await until(() => engine.observe(session.id, first.turnId), v => v.turnState === "unknown");
  assert.equal(firstObs.turnState, "unknown");
  assert.equal(firstObs.status, "unknown");
  assert.equal(firstObs.recoveryRequired, true);

  // Send subsequent queued turn while session has unknown barrier
  shouldFailAmbiguous = false;
  const second = await engine.send(session.id, "task-2", "msg-2");
  await pause(100);

  // Second turn is blocked behind unknown barrier
  const secondObs = await engine.observe(session.id, second.turnId);
  assert.equal(secondObs.turnState, "queued");
  assert.equal(runs.length, 1); // Second turn has NOT been executed

  // Explicit recover while unknown barrier exists refuses dispatch
  const recoverAttempt = await engine.recover(session.id, second.turnId);
  assert.equal(recoverAttempt.recovery, "unresolved");
  assert.equal(recoverAttempt.replayed, false);
  assert.equal(runs.length, 1);

  await assert.rejects(engine.cancel(session.id, first.turnId), { code: "TURN_OWNERSHIP_UNCONFIRMED" });
  assert.equal((await engine.observe(session.id, first.turnId)).turnState, "unknown");
  assert.equal((await engine.observe(session.id, second.turnId)).turnState, "queued");
  assert.deepEqual(runs, ["task-1"]);
});

test("streaming text buffering flushes before terminal state and storage failures reject without success", async t => {
  const dataRoot = directory(t);
  const driver = {
    async run({ emitText }) {
      await emitText("chunk-1");
      await emitText("chunk-2");
      await emitText("chunk-3");
    },
    async cancel() {},
  };

  const engine = await createNativeEngine({ dataRoot, drivers: { fixture: driver } });
  t.after(() => engine.close());

  const session = await engine.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const turn = await engine.send(session.id, "prompt", "c-stream");

  const completed = await until(() => engine.observe(session.id, turn.turnId), v => v.turnState === "completed");
  assert.equal(completed.answer, "chunk-1chunk-2chunk-3");

  // Storage failure during output: append exceeds limit or fails
  const oversizedDriver = {
    async run({ emitText }) {
      // Worker rejects text delta > 16384 bytes
      await emitText("x".repeat(20000));
    },
    async cancel() {},
  };

  const engine2 = await createNativeEngine({ dataRoot: directory(t), drivers: { fixture: oversizedDriver } });
  t.after(() => engine2.close());

  const session2 = await engine2.createSession({ workspaceId: "workspace", harness: "fixture", root: __dirname });
  const turn2 = await engine2.send(session2.id, "overflow", "c-overflow");

  const failed = await until(() => engine2.observe(session2.id, turn2.turnId), v => v.turnState === "failed");
  assert.equal(failed.error, "Native output could not be persisted");
  assert.notEqual(failed.turnState, "completed");
});

test("schema verification rejects unsupported or corrupt databases without mutating them", async t => {
  const { DatabaseSync } = require("node:sqlite");

  // A future schema must be rejected before any storage configuration changes.
  const rootUnsupported = directory(t);
  const dbUnsupported = new DatabaseSync(path.join(rootUnsupported, "orchestrator.sqlite"));
  dbUnsupported.exec("PRAGMA user_version = 99");
  dbUnsupported.close();

  await assert.rejects(openNativeStore({ dataRoot: rootUnsupported }), { code: "SCHEMA_UNSUPPORTED" });

  // Verify file was not mutated
  const verifyDb = new DatabaseSync(path.join(rootUnsupported, "orchestrator.sqlite"));
  assert.equal(verifyDb.prepare("PRAGMA user_version").get().user_version, 99);
  verifyDb.close();

  // Case 2: Corrupt database file
  const rootCorrupt = directory(t);
  fs.writeFileSync(path.join(rootCorrupt, "orchestrator.sqlite"), Buffer.from("NOT_A_VALID_SQLITE_FILE"));

  await assert.rejects(openNativeStore({ dataRoot: rootCorrupt }), { code: "DATABASE_CORRUPT" });

  const rootIncomplete = directory(t);
  const incompleteFile = path.join(rootIncomplete, "orchestrator.sqlite");
  const incomplete = new DatabaseSync(incompleteFile);
  incomplete.exec("CREATE TABLE turns(id TEXT); PRAGMA user_version=1;");
  incomplete.close();
  const before = fs.readFileSync(incompleteFile);
  await assert.rejects(openNativeStore({ dataRoot: rootIncomplete }), { code: "DATABASE_CORRUPT" });
  assert.deepEqual(fs.readFileSync(incompleteFile), before);
});
