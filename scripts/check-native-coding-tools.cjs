"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createNativeRuntimeAdapter } = require("../src/native-runtime-adapter.cjs");
const { createCodexDriver } = require("../src/codex-driver.cjs");
const { createEngineRouter } = require("../src/engine-router.cjs");
const { CONTRACT_VERSION } = require("../src/orchestrator-handler.cjs");

function protocolPeer(calls, openingTurn) {
  let turns = 0;
  return createCodexDriver({
    launch: async () => ({}),
    createClient({ onNotification, onRequest }) {
      return {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "initialize") return {};
          if (method === "thread/start") {
            assert.equal(params.sandbox, "read-only");
            assert.equal(params.model, "fixture-model");
            return { thread: { id: "fixture-thread" } };
          }
          if (method === "turn/steer") {
            assert.equal(params.threadId, "fixture-thread");
            assert.equal(params.expectedTurnId, "provider-turn-1");
            return { turnId: params.clientUserMessageId === "fixture-lost" ? "mismatched-ack" : params.expectedTurnId };
          }
          assert.equal(method, "turn/start");
          assert.equal(params.threadId, "fixture-thread");
          const turnId = `provider-turn-${++turns}`;
          const finish = () => {
            const scope = { threadId: params.threadId, turnId };
            assert.deepEqual(onRequest("item/commandExecution/requestApproval", scope), { decision: "decline" });
            assert.throws(() => onRequest("item/fileChange/requestApproval", { ...scope, turnId: "stale-turn" }), { code: "REQUEST_SCOPE" });
            onNotification("item/agentMessage/delta", { ...scope, delta: `fixture reply: ${params.input[0].text}` });
            onNotification("turn/completed", { ...scope, turn: { id: turnId, status: "completed" } });
          };
          if (turns === 1) setImmediate(() => { openingTurn.finish = finish; });
          else setImmediate(finish);
          return { turn: { id: turnId } };
        },
        notify() {},
        async close() {},
      };
    },
  });
}

async function until(read, done) {
  for (let i = 0; i < 200; i++) {
    const result = await read();
    if (done(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Native host probe did not settle");
}

async function main() {
  const appRoot = process.argv[2];
  if (!appRoot || !path.isAbsolute(appRoot)) throw new Error("Pass an absolute trusted Coding Tools source checkout path");
  const electron = path.join(appRoot, "desktop-electron/electron");
  const { createAgentOrchestratorWorkflow } = require(path.join(electron, "agent-orchestrator-workflow.cjs"));
  const { createAgentOrchestratorUpstream } = require(path.join(electron, "agent-orchestrator-upstream.cjs"));
  const { createChatInputService } = require(path.join(electron, "chat-input-service.cjs"));
  assert.equal(require(path.join(electron, "orchestrator-handler.cjs")).CONTRACT_VERSION, CONTRACT_VERSION);
  const parent = path.resolve(__dirname, "../aiTemp/host-native-check");
  await fs.mkdir(parent, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(parent, "case-"));
  const workspaceId = "fixture-workspace", agent = "orchestrator-fixture", requestKey = "fixture-launch-receipt";
  const route = { harness_id: `ao:${agent}`, provider_id: "agent-orchestrator", account_id: "ao-local", model: "fixture-model", permission_profile: ":read-only" };
  const node = { id: "fixture-node", role: "planner", parents: [], state: "pending", route };
  const run = { id: "fixture-run", workspace_id: workspaceId, project_id: "fixture-task", execution_mode: "single", cancelled: false, revision: 1, nodes: [node] };
  const protocol = [], starts = [], runtimes = [], openingTurn = {};
  const journal = createChatInputService({ file: path.join(scratch, "inputs.sqlite"), attachmentsRoot: path.join(scratch, "attachments") });
  const open = () => {
    const runtime = createNativeRuntimeAdapter({ dataRoot: scratch, drivers: { [agent]: protocolPeer(protocol, openingTurn) },
      catalog: [{ id: agent, name: "Fixture harness", models: [route.model] }],
      resolveWorkspace: async id => id === workspaceId ? { workspaceId, root: scratch } : null });
    runtimes.push(runtime);
    return runtime;
  };
  let workflow;
  try {
    const runtime = open();
    const native = { ...runtime, harness: { ...runtime.harness, spawn(options) { starts.push(options); return runtime.harness.spawn(options); } } };
    let composed = false;
    const handler = createAgentOrchestratorUpstream({
      resourceRoot: path.join(scratch, "no-ao-binary"), dataRoot: path.join(scratch, "no-ao-data"),
      composeRuntime(legacy) {
        composed = true;
        assert.equal(legacy.snapshot().state, "stopped");
        return createEngineRouter({ legacy, native, nativeAgents: [agent] });
      },
    });
    assert.equal(composed, true, "Use a checkout with the trusted engine composition hook");
    assert.equal(handler.snapshot().state, "stopped");
    workflow = createAgentOrchestratorWorkflow({ aoHarness: handler.harness, inputJournal: journal, confirm: async () => true,
      requestHeadless: async (endpoint, body) => {
        assert.equal(body.workspace_id, workspaceId);
        if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)] };
        if (endpoint === "/api/v1/ao/external/reserve") {
          assert.equal(body.confirm, true);
          node.state = "reserved";
          return { ok: true, request_key: requestKey, prompt: "first native turn" };
        }
        if (endpoint === "/api/v1/ao/external/submitted") {
          assert.equal(body.request_key, requestKey);
          assert.ok(body.session_id, body.error);
          node.state = "running";
          node.receipt = { request_key: requestKey, thread_id: body.session_id };
          return { ok: true, run: structuredClone(run) };
        }
        if (endpoint === "/api/v1/ao/external/terminal") {
          assert.equal(body.session_id, node.receipt.thread_id);
          assert.equal(body.completed, true);
          node.state = "finished";
          node.receipt = { ...node.receipt, turn_id: body.turn_id, answer: body.answer };
          return { ok: true, run: structuredClone(run) };
        }
        throw new Error(`Unexpected fixture headless route: ${endpoint}`);
      },
    });
    const input = { workspaceId, runId: run.id };
    await workflow.call("advance", input);
    await until(() => openingTurn.finish, Boolean);
    const sessionId = node.receipt.thread_id;
    const { turnId: firstTurn } = await handler.harness.observe(sessionId);
    node.receipt.turn_id = firstTurn;
    const taskId = run.project_id, message = "fixture steering input";
    async function saveSteer(inputId) {
      const saved = await workflow.call("chat_input", { action: "accept", workspaceId, key: taskId, inputId, mode: "steer",
        payload: { text: message, attachments: [], annotations: [] }, destination: { taskId, message } });
      assert.equal(saved.state, "queued");
      return { workspaceId, taskId, inputId, message };
    }
    const first = await saveSteer("fixture-steer-1"), second = await saveSteer("fixture-steer-2");
    for (const result of await Promise.all([workflow.call("chat_steer", first), workflow.call("chat_steer", second)])) {
      assert.equal(result.steered, true);
      assert.equal(result.turnId, firstTurn);
      assert.equal(result.sessionId, sessionId);
    }
    assert.equal((await workflow.call("chat_steer", first)).inputId, first.inputId);
    const lost = await saveSteer("fixture-lost");
    await assert.rejects(workflow.call("chat_steer", lost), { code: "STEER_DELIVERY_UNKNOWN" });
    await assert.rejects(workflow.call("chat_steer", lost), { code: "INPUT_DELIVERY_UNKNOWN" });
    assert.equal((await journal.get(workspaceId, lost.inputId)).state, "unknown");
    assert.deepEqual(protocol.filter(row => row.method === "turn/steer").map(row => row.params.clientUserMessageId).sort(),
      [first.inputId, second.inputId, lost.inputId].sort());
    openingTurn.finish();
    await until(() => workflow.call("observe", { ...input, nodeId: node.id }), () => node.state === "finished");
    assert.equal(node.receipt.turn_id, firstTurn);
    assert.equal(node.receipt.answer, "fixture reply: first native turn");
    assert.equal(sessionId, "native:" + createHash("sha256").update(JSON.stringify([workspaceId, requestKey])).digest("hex"),
      "The product reserve ID must reach the native adapter before the initial turn is accepted");
    assert.equal(await handler.harness.spawn(starts[0]), sessionId);
    assert.equal(protocol.filter(item => item.method === "turn/start").length, 1);
    await assert.rejects(handler.harness.spawn({ ...starts[0], requestId: "wrong-scope", approvalMode: "bypass-permissions" }), { code: "NATIVE_CAPABILITY_UNSUPPORTED" });
    await assert.rejects(handler.harness.steer(sessionId, "missing scope"), { code: "STEER_SCOPE_REQUIRED" });
    const followup = await handler.harness.send(sessionId, "follow-up", "follow-up-input");
    assert.equal((await handler.harness.send(sessionId, "follow-up", "follow-up-input")).turnId, followup.turnId);
    await until(() => handler.harness.observe(sessionId, followup.turnId), value => value.turnState === "completed");
    await runtime.stop();
    const reopened = open();
    await reopened.start();
    assert.equal((await reopened.harness.timeline(sessionId, firstTurn))[0].text, "fixture reply: first native turn");
    assert.equal((await reopened.harness.timeline(sessionId, followup.turnId))[0].text, "fixture reply: follow-up");
    assert.equal((await reopened.harness.recover(sessionId, followup.turnId)).replayed, false);
    assert.equal(protocol.filter(item => item.method === "thread/start").length, 1);
    assert.equal(protocol.filter(item => item.method === "turn/start").length, 2);
    assert.equal(handler.snapshot().state, "stopped", "The native route never started the isolated legacy runtime");
    console.log(JSON.stringify({ passed: true, workflow: "Coding Tools advance, observe and steer", handler: "v1 host factory with native affinity", legacyStarted: false,
      durableSteering: true, provider: "in-process Codex protocol fixture", restart: "isolated native storage", liveChatTested: false, productionReady: false }));
  } finally {
    workflow?.dispose();
    try { await Promise.all([journal.close(), ...runtimes.map(runtime => runtime.stop())]); }
    finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
