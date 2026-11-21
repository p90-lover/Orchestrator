"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPiDriver } = require("../src/pi-driver.cjs");

const model = { id: "fixture-model", provider: "isolated-fixture", baseUrl: "http://127.0.0.1:1/v1" };
const session = { id: "session", root: __dirname, config: { model: model.id } };
const turn = { id: "turn", prompt: "fixture prompt" };

function fixture(onPrompt, activeTools = []) {
  let providerCalls = 0, stops = 0, disposed = 0, release;
  const sdk = {
    createExtensionRuntime: () => ({}), SessionManager: { inMemory: cwd => ({ cwd }) }, SettingsManager: { inMemory: values => values },
    async createAgentSession(options) {
      assert.deepEqual(options.tools, []);
      assert.equal(options.noTools, "all");
      assert.equal(options.settingsManager.cacheWarming, "off");
      assert.equal(options.settingsManager.retry.provider.maxRetries, 0);
      assert.deepEqual(options.resourceLoader.getAgentsFiles(), { agentsFiles: [] });
      let handler;
      return { session: {
        model: options.model, getActiveToolNames: () => activeTools,
        subscribe(listener) { handler = listener; return () => { handler = null; }; },
        async prompt() { await onPrompt(options, event => handler?.(event), new Promise(resolve => { release = resolve; })); },
        abort() { stops += 1; release?.(); }, dispose() { disposed += 1; },
      } };
    },
  };
  const modelRuntime = { streamSimple() { providerCalls += 1; } };
  const driver = createPiDriver({ sdk, agentDir: __dirname, resolveModel: async () => ({ model, modelRuntime }) });
  return { driver, providerCalls: () => providerCalls, stops: () => stops, disposed: () => disposed };
}
const run = (driver, emitText = async () => {}) => driver.run({ session, turn, signal: new AbortController().signal, emitText });

test("Pi verifies complete streamed text and never lets a discovered tool execute", async t => {
  const prompt = (options, emit) => {
    options.modelRuntime.streamSimple(options.model, { tools: [] });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first last" }] } });
  };
  const normal = fixture(prompt), tools = fixture(prompt, ["unapproved-tool"]);
  t.after(async () => { await Promise.all([normal.driver.close(), tools.driver.close()]); });
  const output = [];
  await run(normal.driver, async text => output.push(text));
  assert.equal(output.join(""), "first last");
  assert.equal(normal.providerCalls(), 1);
  await assert.rejects(run(tools.driver), { code: "PI_SCOPE" });
  assert.equal(tools.providerCalls(), 0);
  assert.equal(tools.disposed(), 1);
});

test("Pi rejects a retry or changed provider and retires the unconfirmed session", async t => {
  const replay = fixture(options => {
    options.modelRuntime.streamSimple(options.model, {});
    options.modelRuntime.streamSimple(options.model, {});
  });
  const changed = fixture(options => options.modelRuntime.streamSimple({ ...options.model, baseUrl: "http://127.0.0.1:2/v1" }, {}));
  t.after(async () => { await Promise.all([replay.driver.close(), changed.driver.close()]); });
  await assert.rejects(run(replay.driver), { code: "PI_TURN_UNCONFIRMED", uncertain: true });
  await assert.rejects(run(replay.driver), { code: "SESSION_REATTACH_REQUIRED" });
  assert.equal(replay.providerCalls(), 1);
  await assert.rejects(run(changed.driver), { code: "PI_TURN_UNCONFIRMED", uncertain: true });
  assert.equal(changed.providerCalls(), 0);
});

test("Pi cancellation addresses only the active turn", async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { driver, stops } = fixture(async (options, _emit, wait) => {
    options.modelRuntime.streamSimple(options.model, {});
    ready();
    await wait;
  });
  t.after(() => driver.close());
  const result = run(driver);
  await started;
  await driver.cancel({ sessionId: session.id, turnId: "different" });
  assert.equal(stops(), 0);
  await driver.cancel({ sessionId: session.id, turnId: turn.id });
  await result;
  assert.equal(stops(), 1);
});
