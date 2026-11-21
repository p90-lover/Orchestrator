"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createCodexDriver } = require("../src/codex-driver.cjs");
const { openNativeStore } = require("../src/native-store.cjs");
const { createNativeRuntimeAdapter } = require("../src/native-runtime-adapter.cjs");

const workspaceId = "fixture-project";
const agent = "orchestrator-fixture";
const optionsFor = turnId => ({ workspaceId, turnId });

function peer() {
  let started, complete;
  const ready = new Promise(resolve => { started = resolve; });
  const steers = [];
  const driver = createCodexDriver({ launch: async () => ({}), createClient({ onNotification, onClose }) {
    return {
      async request(method, params) {
        if (method === "initialize") return {};
        if (method === "thread/start") return { thread: { id: "provider-thread" } };
        if (method === "turn/start") {
          complete = () => onNotification("turn/completed", { threadId: "provider-thread", turn: { id: "provider-turn", status: "completed" } });
          setImmediate(started);
          return { turn: { id: "provider-turn" } };
        }
        assert.equal(method, "turn/steer");
        steers.push(params);
        return { turnId: params.clientUserMessageId === "missing-ack" ? "wrong-provider-turn" : "provider-turn" };
      },
      notify() {},
      async close() { onClose(new Error("fixture closed")); },
    };
  } });
  return { driver, steers, ready, complete: () => complete() };
}

async function fixture(t) {
  const parent = path.resolve(__dirname, "../aiTemp/native-steering");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "case-"));
  const runtimes = [];
  t.after(async () => {
    try { await Promise.all(runtimes.map(runtime => runtime.stop())); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  const open = driver => {
    const runtime = createNativeRuntimeAdapter({ dataRoot: root, drivers: { [agent]: driver },
      catalog: [{ id: agent, models: ["fixture-model"] }], resolveWorkspace: async id => id === workspaceId ? { workspaceId, root } : null });
    runtimes.push(runtime);
    return runtime;
  };
  return { root, open };
}

async function settled(runtime, sessionId, turnId) {
  for (let i = 0; i < 150; i++) {
    const value = await runtime.harness.observe(sessionId, turnId);
    if (value.turnState === "completed") return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("The fixture turn did not settle");
}

test("native steering binds both turn identities and never replays an acknowledged or unknown input", async t => {
  const { open } = await fixture(t);
  const p = peer(), runtime = open(p.driver);
  const id = await runtime.harness.spawn({ workspaceId, agent, model: "fixture-model", prompt: "fixture start", requestId: "launch" });
  await p.ready;
  const { turnId } = await runtime.harness.observe(id);
  const opts = optionsFor(turnId);
  const text = "keep the original request";
  await assert.rejects(runtime.harness.steer(id, text, "first", { turnId }), { code: "STEER_SCOPE_REQUIRED" });
  await assert.rejects(runtime.harness.steer(id, text, "first", { ...opts, workspaceId: "other" }), { code: "WORKSPACE_SCOPE" });
  await assert.rejects(runtime.harness.steer(id, text, "first", optionsFor("old-turn")), { code: "TURN_NOT_FOUND" });
  assert.equal(p.steers.length, 0);
  assert.deepEqual(await runtime.harness.steer(id, text, "first", opts), { steered: true, inputId: "first", turnId, duplicate: false });
  assert.equal((await runtime.harness.steer(id, text, "first", opts)).duplicate, true);
  await assert.rejects(runtime.harness.steer(id, "changed", "first", opts), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal((await runtime.harness.steer(id, text, "second", opts)).steered, true, "same text with a new input identity is a new steer");
  await assert.rejects(runtime.harness.steer(id, text, "missing-ack", opts), { code: "STEER_DELIVERY_UNKNOWN" });
  await assert.rejects(runtime.harness.send(id, text, "missing-ack"), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(p.steers.map(row => [row.threadId, row.expectedTurnId, row.clientUserMessageId]), [
    ["provider-thread", "provider-turn", "first"], ["provider-thread", "provider-turn", "second"], ["provider-thread", "provider-turn", "missing-ack"],
  ]);
  p.complete();
  await settled(runtime, id, turnId);
  assert.deepEqual(await runtime.harness.steer(id, text, "after-end", opts), { steered: false });
  await runtime.stop();
  const next = peer(), reopened = open(next.driver);
  await reopened.start();
  const found = await reopened.harness.recover(id, turnId, { workspaceId, inputId: "first" });
  assert.deepEqual(found.steerReceipt, { state: "accepted", sessionId: id, turnId, workspaceId, inputId: "first" });
  assert.equal(found.replayed, false);
  assert.equal((await reopened.harness.recover(id, turnId, { workspaceId: "other", inputId: "first" })).steerReceipt, null);
  assert.equal((await reopened.harness.recover(id, "other-turn", { workspaceId, inputId: "first" })).steerReceipt, null);
  assert.equal((await reopened.harness.recover(id, turnId, { workspaceId, inputId: "missing-ack" })).steerReceipt, null);
  assert.equal((await reopened.harness.steer(id, text, "first", opts)).duplicate, true);
  await assert.rejects(reopened.harness.steer(id, text, "missing-ack", opts), { code: "STEER_DELIVERY_UNKNOWN" });
  assert.deepEqual(next.steers, []);
});

test("upgrading a v2 scratch store preserves its turn and a later interrupted steer becomes unknown", async t => {
  const { root } = await fixture(t);
  const options = { dataRoot: root };
  let store = await openNativeStore(options);
  let id, turnId;
  try {
    const session = await store.call("create", { workspaceId, harness: agent, root });
    id = session.id;
    turnId = (await store.call("enqueue", { id, prompt: "fixture", clientMessageId: "opening" })).id;
  } finally { await store.close(); }
  const db = new DatabaseSync(path.join(root, "orchestrator.sqlite"));
  try { db.exec("DROP TABLE steers; PRAGMA user_version=2"); } finally { db.close(); }
  const scope = { id, turnId, prompt: "keep it read-only", clientMessageId: "steer-one" };
  store = await openNativeStore(options);
  try {
    assert.equal((await store.call("observe", { id, turnId })).turn.state, "queued");
    assert.equal((await store.call("claim", { id })).id, turnId);
    assert.equal((await store.call("reserveSteer", scope)).state, "dispatching");
  } finally { await store.close(); }
  store = await openNativeStore(options);
  try {
    assert.equal((await store.call("observe", { id, turnId })).turn.state, "unknown");
    assert.deepEqual(await store.call("reserveSteer", scope), { state: "unknown", duplicate: true });
    await assert.rejects(store.call("enqueue", scope), { code: "IDEMPOTENCY_CONFLICT" });
    assert.equal((await store.call("events", { id })).items.filter(event => event.type === "steer.accepted").length, 0);
  } finally { await store.close(); }
});
