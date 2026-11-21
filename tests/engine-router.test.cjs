"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngineRouter } = require("../src/engine-router.cjs");
const { RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime } = require("../src/orchestrator-handler.cjs");
function runtime(label) {
  const calls = [];
  const engine = Object.fromEntries(RUNTIME_METHODS.map(name => [name, (...args) => { calls.push({ name, args }); return label; }]));
  engine.harness = Object.fromEntries(HARNESS_METHODS.map(name => [name, (...args) => { calls.push({ name, args }); return label; }]));
  engine.harness.catalog = async () => [{ id: label === "native" ? "orchestrator-fixture" : "legacy-fixture" }];
  engine.harness.watch = listener => { calls.push({ name: "watch", args: [listener] }); return () => calls.push({ name: "unwatch" }); };
  return { engine, calls };
}

test("engine router keeps existing sessions on their owning engine without retry", () => {
  const legacy = runtime("legacy"), native = runtime("native");
  const router = createEngineRouter({ legacy: legacy.engine, native: native.engine, nativeAgents: ["orchestrator-fixture"] });
  assert.equal(inspectRuntime(router).shapeCompatible, true);
  assert.equal(router.harness.send("native:one", "hello", "id"), "native");
  assert.equal(router.harness.send("legacy-id", "hello", "id"), "legacy");
  assert.equal(native.calls.length, 1); assert.equal(legacy.calls.length, 1);
  const failure = new Error("native response lost");
  native.engine.harness.send = () => { throw failure; };
  assert.throws(() => router.harness.send("native:one", "hello", "id"), error => error === failure);
  assert.equal(legacy.calls.length, 1);
  assert.throws(() => router.harness.observe("unknown:one"), { code: "ENGINE_ID_UNKNOWN" });
});

test("engine router requires opt-in native launch and cannot fall back when unavailable", async () => {
  const legacy = runtime("legacy"), native = runtime("native");
  const off = createEngineRouter({ legacy: legacy.engine, native: native.engine });
  assert.deepEqual(await off.harness.catalog(), [{ id: "legacy-fixture" }]);
  assert.throws(() => off.harness.spawn({ agent: "orchestrator-fixture" }), { code: "NATIVE_UNAVAILABLE" });
  const missing = createEngineRouter({ legacy: legacy.engine, nativeAgents: ["orchestrator-fixture"] });
  assert.throws(() => missing.harness.spawn({ agent: "orchestrator-fixture" }), { code: "NATIVE_UNAVAILABLE" });
  assert.throws(() => missing.harness.observe("native:one"), { code: "NATIVE_UNAVAILABLE" });
  assert.equal(legacy.calls.length, 0);
});

test("engine router stops both engines even when one stop fails", async () => {
  const legacy = runtime("legacy"), native = runtime("native");
  let nativeStops = 0;
  legacy.engine.stop = async () => { throw new Error("legacy stop failed"); };
  native.engine.stop = async () => { nativeStops += 1; return { ok: true }; };
  legacy.engine.snapshot = function () { assert.equal(this, legacy.engine); return { state: "ready" }; };
  const router = createEngineRouter({ legacy: legacy.engine, native: native.engine });
  assert.deepEqual(router.snapshot(), { state: "ready" });
  await assert.rejects(router.stop(), AggregateError);
  assert.equal(nativeStops, 1);
  assert.equal(router.call("native_status"), "native");
  assert.equal(router.call("legacy_status"), "legacy");
});

test("engine router preserves synchronous watch subscription and cleanup", () => {
  const legacy = runtime("legacy"), native = runtime("native");
  const router = createEngineRouter({ legacy: legacy.engine, native: native.engine });
  const listener = () => {};
  const stop = router.harness.watch(listener);
  assert.equal(typeof stop, "function");
  assert.equal(legacy.calls[0].args[0], listener); assert.equal(native.calls[0].args[0], listener);
  stop();
  assert.equal(legacy.calls[1].name, "unwatch"); assert.equal(native.calls[1].name, "unwatch");
});
