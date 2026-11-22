"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");
const { createPiDriver } = require("../src/pi-driver.cjs");
const { createNativeRuntimeAdapter } = require("../src/native-runtime-adapter.cjs");
const { createEngineRouter } = require("../src/engine-router.cjs");

const MODEL = "fixture-model";
const PROVIDER = "orchestrator-isolated-fixture";
const AGENT = "orchestrator-pi";
const KEY = "synthetic-model-key";

function fixtureProvider(calls, askApproval) {
  return http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      assert.ok(req.headers.authorization === `Bearer ${KEY}`);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) throw new Error("Fixture input too large");
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.model, MODEL);
      assert.deepEqual((request.tools ?? []).map(tool => tool.function.name), askApproval ? ["read_canary_fact"] : []);
      const messages = request.messages;
      calls.push(messages);
      const user = messages.filter(entry => entry.role === "user").map(entry => Array.isArray(entry.content)
        ? entry.content.filter(part => part.type === "text").map(part => part.text).join("") : entry.content);
      const response = `fixture reply: ${user.at(-1)}`;
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (askApproval && calls.length === 1) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "fixture-tool-call", type: "function",
          function: { name: "read_canary_fact", arguments: "{}" } }] }, null));
        res.end(chunk({}, "tool_calls") + "data: [DONE]\n\n");
        return;
      }
      res.write(chunk({ role: "assistant", content: response.slice(0, 8) }, null));
      res.end(chunk({ content: response.slice(8) }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
}

async function main() {
  const [appRoot, sdkRoot, mode, ...extra] = process.argv.slice(2);
  if (!(appRoot && sdkRoot && path.isAbsolute(appRoot) && path.isAbsolute(sdkRoot)) || extra.length || (mode !== undefined && mode !== "--approval-fixture")) {
    throw new Error("Pass absolute trusted Coding Tools checkout and installed Pi SDK package paths, with optional --approval-fixture");
  }
  const askApproval = mode === "--approval-fixture";
  const info = JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8"));
  assert.equal(info.name, "@earendil-works/pi-coding-agent");
  assert.equal(info.version, "1.5.0");
  const electron = path.join(appRoot, "desktop-electron/electron");
  const { createAgentOrchestratorWorkflow } = require(path.join(electron, "agent-orchestrator-workflow.cjs"));
  const { createAgentOrchestratorUpstream } = require(path.join(electron, "agent-orchestrator-upstream.cjs"));
  const parent = path.resolve(__dirname, "../aiTemp/embedded-pi-check");
  await fs.mkdir(parent, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(parent, "case-"));
  const workspace = path.join(scratch, "workspace"), agentDir = path.join(scratch, "pi-profile");
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[name] = workspace;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_TELEMETRY = "0";
  process.env.PI_OFFLINE = "1";
  process.env.NO_PROXY = "127.0.0.1";
  const calls = [], server = fixtureProvider(calls, askApproval);
  let runtime, workflow;
  try {
    await fs.mkdir(workspace);
    const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
    const ai = await import(pathToFileURL(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerProvider(PROVIDER, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: KEY,
      models: [{ id: MODEL, name: "Isolated fixture", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const model = modelRuntime.getModel(PROVIDER, MODEL);
    assert.ok(model);
    const { Type } = await import(pathToFileURL(path.join(sdkRoot, "node_modules/typebox/build/index.mjs")).href);
    const driver = createPiDriver({ sdk, agentDir, resolveModel: async () => ({ model, modelRuntime }),
      ...(askApproval ? { fixtureSchema: Type.Object({}, { additionalProperties: false }) } : {}),
    });
    const workspaceId = "fixture-workspace";
    runtime = createNativeRuntimeAdapter({ dataRoot: path.join(scratch, "native"), drivers: { [AGENT]: driver },
      catalog: [{ id: AGENT, models: [MODEL] }], resolveWorkspace: async id => id === workspaceId ? { workspaceId, root: workspace } : null });
    const handler = createAgentOrchestratorUpstream({ resourceRoot: path.join(scratch, "no-ao-binary"), dataRoot: path.join(scratch, "no-ao-data"),
      composeRuntime: legacy => createEngineRouter({ legacy, native: runtime, nativeAgents: [AGENT] }),
    });
    const route = { harness_id: `ao:${AGENT}`, provider_id: "agent-orchestrator", account_id: "ao-local", model: MODEL, permission_profile: ":read-only" };
    const node = { id: "fixture-node", role: "planner", parents: [], state: "pending", route };
    const run = { id: "fixture-run", workspace_id: workspaceId, project_id: "fixture-task", execution_mode: "single", cancelled: false, revision: 1, nodes: [node] };
    let confirmApproval = false, confirmations = 0;
    workflow = createAgentOrchestratorWorkflow({ aoHarness: handler.harness,
      readNativeLaunchReceipt: async scope => (await handler.call("native_launch_receipt", scope)).launchReceipt,
      confirm: async ({ message }) => {
        if (message !== "Allow once?") return true;
        confirmations += 1;
        return confirmApproval;
      },
      confirmToolRequest: async () => assert.fail("Native approval must not take the legacy remembered confirmation path"),
      requestHeadless: async (endpoint, body) => {
        assert.equal(body.workspace_id, workspaceId);
        if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)] };
        if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
        if (endpoint === "/api/v1/ao/external/reserve") { node.state = "reserved"; return { ok: true, request_key: "fixture-launch", prompt: "first embedded turn" }; }
        if (endpoint === "/api/v1/ao/external/submitted") {
          assert.ok(body.session_id, body.error);
          node.state = "running";
          assert.ok(body.turn_id);
          node.receipt = { request_key: body.request_key, thread_id: body.session_id, turn_id: body.turn_id };
          return { ok: true, run: structuredClone(run) };
        }
        if (endpoint === "/api/v1/ao/external/terminal") {
          assert.equal(body.completed, true);
          node.state = "finished";
          node.receipt = { ...node.receipt, turn_id: body.turn_id, answer: body.answer };
          return { ok: true, run: structuredClone(run) };
        }
        throw new Error(`Unexpected fixture headless request: ${endpoint}`);
      },
    });
    const input = { workspaceId, runId: run.id };
    await workflow.call("advance", input);
    if (askApproval) {
      let pending;
      for (let i = 0; i < 150 && !pending; i++) {
        const observed = await workflow.call("observe", { ...input, nodeId: node.id });
        pending = observed.pending_approvals?.[0];
        if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(pending, `The isolated SDK fixture must pause for a native approval; state=${(await handler.harness.observe(node.receipt.thread_id)).turnState}, providerRequests=${calls.length}`);
      const { approval_id: approvalId, turn_id: turnId, thread_id: sessionId } = pending;
      assert.equal(pending.tool, "read_canary_fact");
      node.receipt.turn_id = turnId;
      await assert.rejects(handler.harness.resolveApproval(sessionId, approvalId, "allow_once"), { code: "APPROVAL_SCOPE_REQUIRED" });
      await assert.rejects(handler.harness.resolveApproval(sessionId, approvalId, "allow_once", "", { workspaceId: "other", turnId }), { code: "APPROVAL_SCOPE_REQUIRED" });
      const decision = { ...input, nodeId: node.id, approvalId, decisionId: "allow_once" };
      assert.equal((await workflow.call("approve_harness", decision)).cancelled, true);
      assert.equal(calls.length, 1, "Refusing the confirmation must not release the tool or model continuation");
      confirmApproval = true;
      assert.equal((await workflow.call("approve_harness", decision)).ok, true);
      await assert.rejects(workflow.call("approve_harness", decision));
      assert.equal(confirmations, 2);
    }
    for (let i = 0; i < 150 && node.state !== "finished"; i++) {
      await workflow.call("observe", { ...input, nodeId: node.id });
      if (node.state !== "finished") await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(node.receipt.answer, "fixture reply: first embedded turn");
    const sessionId = node.receipt.thread_id;
    await assert.rejects(handler.harness.steer(sessionId, "unsupported steer", "steer", { workspaceId, turnId: node.receipt.turn_id }), { code: "NATIVE_CAPABILITY_UNSUPPORTED" });
    const followUp = await handler.harness.send(sessionId, "second embedded turn", "follow-up");
    let latest;
    for (let i = 0; i < 150; i++) {
      latest = await handler.harness.observe(sessionId, followUp.turnId);
      if (latest.turnState === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(latest.answer, "fixture reply: second embedded turn");
    assert.equal(calls.length, askApproval ? 3 : 2);
    if (askApproval) assert.ok(calls[1].some(message => message.role === "tool" && JSON.stringify(message.content).includes("orchestrator-canary-fact")));
    assert.equal(calls.at(-1).filter(message => message.role === "user").length, 2);
    assert.equal(handler.snapshot().state, "stopped");
    await runtime.stop();
    const files = (await fs.readdir(scratch, { recursive: true })).map(name => name.split(path.sep).join("/"));
    assert.deepEqual(files.filter(name => !["workspace", "native"].includes(name)
      && !/^native\/(coordinator-owner|orchestrator)\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)), []);
    console.log(JSON.stringify({ passed: true, harness: `Pi SDK ${info.version}`, provider: "deterministic loopback fixture", nativeTurns: 2,
      harnessFilesWritten: false, approvalFixture: askApproval, legacyStarted: false, externalInference: false, installedChatTested: false }));
  } finally {
    workflow?.dispose();
    try { await runtime?.stop(); } finally {
      await new Promise(resolve => server.close(resolve));
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
