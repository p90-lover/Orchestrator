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
async function until(read, predicate, timeoutMs = 5000) {
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
  await store.close();
  store = await openNativeStore({ dataRoot });
  t.after(() => store.close());
  assert.equal((await store.call("observe", { id: session.id, turnId: a.id })).turn.state, "unknown");
  assert.equal((await store.call("observe", { id: session.id, turnId: b.id })).turn.state, "unknown");
  assert.equal(await store.call("claim", { id: session.id }), null);
  await store.call("settle", { id: session.id, turnId: a.id, state: "cancelled" });
  assert.equal(await store.call("claim", { id: session.id }), null);
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
  const driver = { async run({ turn, signal, emitText }) { if (turn.prompt === "hold") { started = true; await abortWait(signal); } else await emitText("next"); }, async cancel() {} };
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
