"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CONTRACT_VERSION, RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime, createOrchestratorHandler } = require("../src/orchestrator-handler.cjs");

function fixture(implementation = () => undefined) {
  const runtime = { harness: {} };
  for (const [target, names] of [[runtime, RUNTIME_METHODS], [runtime.harness, HARNESS_METHODS]]) {
    for (const name of names) target[name] = function (...args) { return implementation.call(this, name, args); };
  }
  return runtime;
}

test("constructing and inspecting a handler never invokes the engine", () => {
  const runtime = fixture(() => assert.fail("engine operation during construction"));
  assert.equal(inspectRuntime(runtime).shapeCompatible, true);
  const handler = createOrchestratorHandler({ runtime });
  assert.deepEqual(Object.keys(handler).sort(), [...RUNTIME_METHODS, "harness"].sort());
  assert.deepEqual(Object.keys(handler.harness).sort(), [...HARNESS_METHODS].sort());
  assert.ok(Object.isFrozen(handler));
  assert.ok(Object.isFrozen(handler.harness));
});

test("every operation preserves arguments, receiver and result, with one invocation", () => {
  let calls = [];
  const result = { sessionId: "existing-session", turnId: "accepted-turn" };
  const runtime = fixture(function (name, args) { calls.push({ receiver: this, name, args }); return result; });
  const handler = createOrchestratorHandler({ runtime });
  const request = { approvalMode: "default", gateway: { provider: "test", model: "test-model" }, mcpServers: [] };
  for (const [target, proxy, names] of [[runtime, handler, RUNTIME_METHODS], [runtime.harness, handler.harness, HARNESS_METHODS]]) {
    for (const name of names) {
      calls = [];
      const extracted = proxy[name];
      assert.strictEqual(extracted(request, undefined, "turn-1", null), result, name);
      assert.equal(calls.length, 1, name);
      assert.strictEqual(calls[0].receiver, target, name);
      assert.equal(calls[0].name, name);
      assert.deepEqual(calls[0].args, [request, undefined, "turn-1", null], name);
      assert.strictEqual(calls[0].args[0], request, name);
    }
  }
});

test("zero arguments are not changed to an explicit undefined argument", () => {
  const runtime = fixture((_name, args) => args.length);
  const handler = createOrchestratorHandler({ runtime });
  assert.equal(handler.snapshot(), 0);
  assert.equal(handler.harness.catalog(), 0);
  assert.equal(handler.harness.catalog(undefined), 1);
});

test("watch stays synchronous and preserves unsubscribe and event identities", () => {
  let received;
  let disconnected = 0;
  const event = { sessionId: "session-1", type: "turn_updated" };
  const unsubscribe = () => { disconnected += 1; };
  const runtime = fixture();
  runtime.harness.watch = listener => { listener(event); return unsubscribe; };
  const handler = createOrchestratorHandler({ runtime });
  const close = handler.harness.watch(value => { received = value; });
  assert.strictEqual(received, event);
  assert.strictEqual(close, unsubscribe);
  close();
  assert.equal(disconnected, 1);
});

test("promises and synchronous errors pass through without retries or translation", async () => {
  const failure = Object.assign(new Error("transport outcome unknown"), { code: "UNKNOWN_OUTCOME", status: 504 });
  let calls = 0;
  const runtime = fixture(() => { calls += 1; throw failure; });
  const handler = createOrchestratorHandler({ runtime });
  assert.throws(() => handler.harness.spawn({}), error => error === failure);
  assert.equal(calls, 1);
  const pending = Promise.reject(failure);
  const asyncRuntime = fixture(() => { calls += 1; return pending; });
  const asyncHandler = createOrchestratorHandler({ runtime: asyncRuntime });
  const received = asyncHandler.harness.send("session-1", "text", "request-1");
  assert.strictEqual(received, pending);
  await assert.rejects(received, error => error === failure);
  assert.equal(calls, 2);
});

test("approval arguments, cancellation signals and callback identity remain opaque", () => {
  const controller = new AbortController();
  const callback = () => undefined;
  const request = Object.freeze({ signal: controller.signal, beforeSubmit: callback });
  const runtime = fixture((_name, args) => args);
  const handler = createOrchestratorHandler({ runtime });
  const approval = handler.harness.resolveApproval("session-1", "request-1", "deny", "do not publish");
  assert.deepEqual(approval, ["session-1", "request-1", "deny", "do not publish"]);
  assert.strictEqual(handler.harness.compact("session-1", request)[1], request);
});

test("missing methods fail before any engine operation, including all harness methods", () => {
  for (const [scope, names] of [["runtime", RUNTIME_METHODS], ["harness", HARNESS_METHODS]]) {
    for (const name of names) {
      const runtime = fixture(() => assert.fail("must not invoke incomplete engine"));
      delete (scope === "runtime" ? runtime : runtime.harness)[name];
      const expected = scope === "runtime" ? name : `harness.${name}`;
      const report = inspectRuntime(runtime);
      assert.equal(report.shapeCompatible, false);
      assert.deepEqual(report.missing, [expected]);
      assert.throws(() => createOrchestratorHandler({ runtime }), error => error.message.includes(expected));
    }
  }
  assert.equal(inspectRuntime(null).missing.length, RUNTIME_METHODS.length + HARNESS_METHODS.length);
  assert.throws(() => createOrchestratorHandler(), /Incompatible Orchestrator runtime/);
});

test("unsupported contract versions fail before calling the engine", () => {
  const runtime = fixture(() => assert.fail("version mismatch must not invoke engine"));
  for (const version of [0, CONTRACT_VERSION + 1, "1", null]) {
    assert.throws(() => createOrchestratorHandler({ runtime, contractVersion: version }), /Unsupported Orchestrator contract version/);
  }
});

test("binding one handler cannot replace the driver of another handler", () => {
  const first = fixture(() => "first");
  const second = fixture(() => "second");
  const a = createOrchestratorHandler({ runtime: first });
  const b = createOrchestratorHandler({ runtime: second });
  first.harness.send = () => "replacement";
  assert.equal(a.harness.send(), "first");
  assert.equal(b.harness.send(), "second");
  assert.throws(() => { a.harness = second.harness; }, TypeError);
});
