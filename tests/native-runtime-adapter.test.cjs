"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createNativeRuntimeAdapter } = require("../src/native-runtime-adapter.cjs");
const { inspectRuntime } = require("../src/orchestrator-handler.cjs");
const { openNativeStore } = require("../src/native-store.cjs");

function fixture(t) {
  const parent = path.resolve(__dirname, "../aiTemp/native-adapter");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const runtimes = [], runs = [];
  const options = { dataRoot: root, drivers: { "orchestrator-fixture": {
    async run({ session, turn, emitText }) { runs.push({ session, turn }); await emitText(`reply:${turn.prompt}`); }, async cancel() {},
  } }, catalog: [{ id: "orchestrator-fixture", models: ["fixture-model"] }],
    resolveWorkspace: async workspaceId => ({ workspaceId, root: __dirname }) };
  const create = extra => { const runtime = createNativeRuntimeAdapter({ ...options, ...extra }); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, options, create };
}
async function settled(runtime, id, turn) {
  for (let count = 0; count < 300; count += 1) {
    const value = await runtime.harness.observe(id, turn);
    if (value.turnState === "completed") return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Native adapter turn did not settle");
}

test("native adapter implements the boundary and persists launch affinity without AO", async t => {
  const f = fixture(t), runtime = f.create();
  assert.equal(inspectRuntime(runtime).shapeCompatible, true);
  assert.equal(runtime.snapshot().state, "stopped");
  const input = { workspaceId: "workspace", agent: "orchestrator-fixture", model: "fixture-model", prompt: "first", requestId: "stable-launch", plain: true };
  const id = await runtime.harness.spawn(input);
  assert.match(id, /^native:/);
  assert.equal(await runtime.harness.spawn(input), id);
  const done = await settled(runtime, id);
  assert.equal(done.answer, "reply:first"); assert.equal(done.timeline[0].text, "reply:first");
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].session.config.model, "fixture-model");
  assert.deepEqual(await runtime.harness.sessionWorkspace(id, "workspace"), { root: await fs.promises.realpath(__dirname), projectFolder: await fs.promises.realpath(__dirname), ready: true });
  await assert.rejects(runtime.harness.sessionWorkspace(id, "other"), { code: "WORKSPACE_SCOPE" });
  await assert.rejects(runtime.harness.resolveApproval(id, "request", "allow"), { code: "APPROVAL_SCOPE_REQUIRED" });
  const observed = await runtime.harness.recover(id, done.turnId);
  assert.equal(observed.recovery, "observed"); assert.equal(observed.replayed, false); assert.equal(f.runs.length, 1);
  await runtime.stop();
  const reopened = f.create(); await reopened.start();
  assert.equal((await reopened.harness.observe(id, done.turnId)).answer, "reply:first");
  assert.equal(await reopened.harness.continuable(id), false);
  await assert.rejects(reopened.harness.send(id, "followup", "new-input"), { code: "NATIVE_REATTACH_REQUIRED" });
  assert.equal(f.runs.length, 1);
});

test("native adapter refuses unsupported settings before engine startup or launch", async t => {
  const f = fixture(t);
  let starts = 0;
  const runtime = f.create({ createEngine: async () => { starts += 1; throw new Error("must not start"); } });
  for (const extra of [{ gateway: { provider: "cpa" } }, { approvalMode: "bypass-permissions" }, { effort: "high" }, { contextWindow: 1000 }, { subagent: true }, { warm: true }, { mcpServers: [] }]) {
    await assert.rejects(runtime.harness.spawn({ workspaceId: "workspace", agent: "orchestrator-fixture", model: "fixture-model", prompt: "test", ...extra }), { code: "NATIVE_CAPABILITY_UNSUPPORTED" });
  }
  assert.equal(starts, 0); assert.equal(f.runs.length, 0);
});

test("native follow-up receipt survives reopen and matches the reservation, not the latest turn or text", async t => {
  const f = fixture(t), runtime = f.create();
  const workspaceId = "workspace";
  const id = await runtime.harness.spawn({ workspaceId, agent: "orchestrator-fixture", model: "fixture-model", prompt: "start" });
  await settled(runtime, id);
  const first = await runtime.harness.send(id, "same input", "reservation-a");
  const second = await runtime.harness.send(id, "same input", "reservation-b");
  assert.notEqual(first.turnId, second.turnId);
  await settled(runtime, id, second.turnId);
  await runtime.stop();
  const reopened = f.create(); await reopened.start();
  const exact = await reopened.harness.recover(id, null, { workspaceId, requestId: "reservation-a" });
  assert.equal(exact.replayed, false);
  assert.deepEqual(exact.sendReceipt, { workspaceId, sessionId: id, requestId: "reservation-a", turnId: first.turnId });
  for (const wrong of [{ workspaceId, requestId: "missing" }, { workspaceId: "other", requestId: "reservation-a" }]) {
    assert.equal((await reopened.harness.recover(id, null, wrong)).sendReceipt, null);
  }
  assert.equal(f.runs.length, 3, "Receipt reads must not run another inference");
});

test("host recover never dispatches a safe queued turn", async t => {
  const f = fixture(t);
  const store = await openNativeStore({ dataRoot: f.root });
  const session = await store.call("create", { workspaceId: "workspace", harness: "orchestrator-fixture", root: __dirname, config: { model: "fixture-model" } });
  const turn = await store.call("enqueue", { id: session.id, prompt: "do not execute during inspection", clientMessageId: "queued" });
  await store.close();
  const runtime = f.create(); await runtime.start();
  const read = await runtime.harness.recover(`native:${session.id}`, turn.id);
  assert.equal(read.turnState, "queued"); assert.equal(read.replayed, false);
  const receipt = await runtime.harness.recover(`native:${session.id}`, null, { workspaceId: "workspace", requestId: "queued" });
  assert.equal(receipt.sendReceipt.turnId, turn.id);
  assert.equal(receipt.replayed, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.runs.length, 0);
});

test("native session settings cannot persist credentials or arbitrary launch commands", async t => {
  const f = fixture(t), store = await openNativeStore({ dataRoot: f.root });
  try {
    await assert.rejects(store.call("create", { workspaceId: "workspace", harness: "orchestrator-fixture", root: __dirname,
      config: { model: "fixture-model", apiKey: "synthetic-not-a-real-key" } }), { code: "INVALID_SESSION_CONFIG" });
    assert.equal((await store.call("list")).length, 0);
  } finally { await store.close(); }
});
