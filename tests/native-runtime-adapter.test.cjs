"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createNativeRuntimeAdapter } = require("../src/native-runtime-adapter.cjs");
const { createNativeEngine } = require("../src/native-engine.cjs");
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
  const [id, sameId] = await Promise.all([runtime.harness.spawn(input), runtime.harness.spawn(input)]);
  assert.match(id, /^native:/);
  assert.equal(sameId, id);
  await assert.rejects(runtime.harness.spawn({ ...input, prompt: "different input under the same reservation" }), { code: "IDEMPOTENCY_CONFLICT" });
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

test("a refused native first-turn write does not leave a committed empty session", async t => {
  const f = fixture(t), maxDatabaseBytes = 256 * 1024;
  const workspaceId = "workspace", harness = "orchestrator-fixture";
  const open = () => openNativeStore({ dataRoot: f.root, maxDatabaseBytes });
  const filler = await open(), prompt = "x".repeat(65536);
  let firstTurnId;
  try {
    await filler.call("create", { id: "existing", workspaceId, harness, root: __dirname });
    firstTurnId = (await filler.call("enqueue", { id: "existing", clientMessageId: "keep", prompt })).id;
    let full = false;
    for (let i = 0; i < 8; i++) {
      try { await filler.call("enqueue", { id: "existing", clientMessageId: `fill-${i}`, prompt }); }
      catch (error) { assert.equal(error.code, "STORE_FULL"); full = true; break; }
    }
    assert.equal(full, true, "the test must exhaust the real page budget");
    assert.equal((await filler.call("readSendReceipt", { id: "existing", requestId: "keep", workspaceId })).turnId, firstTurnId);
  } finally { await filler.close(); }
  const runtime = f.create({ createEngine: options => createNativeEngine({ ...options, maxDatabaseBytes }) });
  const scope = { workspaceId, agent: harness, requestId: "refused-launch" };
  await assert.rejects(runtime.harness.spawn({ ...scope, model: "fixture-model", prompt }), { code: "STORE_FULL" });
  assert.equal((await runtime.call("native_launch_receipt", scope)).launchReceipt, null);
  assert.equal(f.runs.length, 0);
  await runtime.stop();
  const reopened = await open();
  try {
    assert.deepEqual((await reopened.call("list")).map(session => session.id), ["existing"]);
    assert.equal((await reopened.call("readSendReceipt", { id: "existing", requestId: "keep", workspaceId })).turnId, firstTurnId);
  } finally { await reopened.close(); }
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

test("native launch receipt reads the original accepted turn without starting a stopped runtime", async t => {
  const f = fixture(t), runtime = f.create();
  const scope = { workspaceId: "workspace", agent: "orchestrator-fixture", requestId: "cold-reservation" };
  const read = (target, keys = scope) => target.call("native_launch_receipt", keys);
  assert.equal((await read(runtime)).launchReceipt, null);
  assert.equal(runtime.snapshot().state, "stopped");
  const sessionId = await runtime.harness.spawn({ ...scope, model: "fixture-model", prompt: "same text" });
  const first = await settled(runtime, sessionId);
  const later = await runtime.harness.send(sessionId, "same text", "followup");
  await settled(runtime, sessionId, later.turnId);
  await runtime.stop();
  const reopened = f.create();
  assert.equal((await read(reopened)).launchReceipt, null);
  await reopened.start();
  assert.deepEqual((await read(reopened)).launchReceipt, { ...scope, sessionId, turnId: first.turnId });
  assert.equal((await read(reopened, { ...scope, workspaceId: "other" })).launchReceipt, null);
  assert.equal((await read(reopened, { ...scope, requestId: "different" })).launchReceipt, null);
  await assert.rejects(read(reopened, { ...scope, agent: "unconfigured" }), { code: "DRIVER_UNAVAILABLE" });
  assert.equal(f.runs.length, 2);
});

test("host recover never dispatches a safe queued turn", async t => {
  const f = fixture(t);
  const store = await openNativeStore({ dataRoot: f.root });
  const scope = { workspaceId: "workspace", agent: "orchestrator-fixture", requestId: "previous-format" };
  const id = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.requestId])).digest("hex");
  const session = await store.call("create", { id, workspaceId: scope.workspaceId, harness: scope.agent, root: __dirname, config: { model: "fixture-model" } });
  const initial = await store.call("enqueue", { id, prompt: "original first turn", clientMessageId: "initial" });
  const turn = await store.call("enqueue", { id, prompt: "do not execute during inspection", clientMessageId: "queued" });
  await store.close();
  const runtime = f.create(); await runtime.start();
  assert.deepEqual((await runtime.call("native_launch_receipt", scope)).launchReceipt, { ...scope, sessionId: `native:${id}`, turnId: initial.id });
  const read = await runtime.harness.recover(`native:${session.id}`, turn.id);
  assert.equal(read.turnState, "queued"); assert.equal(read.replayed, false);
  const receipt = await runtime.harness.recover(`native:${session.id}`, null, { workspaceId: "workspace", requestId: "queued" });
  assert.equal(receipt.sendReceipt.turnId, turn.id);
  assert.equal(receipt.replayed, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.runs.length, 0);
});

test("duplicate native launch receipts do not re-own or dispatch a persisted queued turn", async t => {
  const f = fixture(t);
  const scope = { workspaceId: "workspace", agent: "orchestrator-fixture", requestId: "saved-launch" };
  const model = "fixture-model", prompt = "saved first turn";
  const id = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.requestId])).digest("hex");
  const store = await openNativeStore({ dataRoot: f.root });
  let accepted;
  try {
    accepted = await store.call("launch", { session: { id, workspaceId: scope.workspaceId, harness: scope.agent,
      root: await fs.promises.realpath(__dirname), config: { model, approvalMode: "read-only", plain: false, subagent: false, engineVersion: "0.2-native-adapter" } }, prompt });
  } finally { await store.close(); }
  const sessionId = `native:${id}`, reopened = f.create();
  assert.equal(await reopened.harness.spawn({ ...scope, model, prompt }), sessionId);
  assert.equal(await reopened.harness.continuable(sessionId), false);
  await assert.rejects(reopened.harness.send(sessionId, "not attached", "next-input"), { code: "NATIVE_REATTACH_REQUIRED" });
  assert.deepEqual((await reopened.call("native_launch_receipt", scope)).launchReceipt, { ...scope, sessionId, turnId: accepted.turnId });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await reopened.harness.recover(sessionId, accepted.turnId)).turnState, "queued");
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
