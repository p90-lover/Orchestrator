"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { HANDLER_VERSION, CONTRACT_VERSION, RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime, createOrchestratorHandler } = require("../src/orchestrator-handler.cjs");

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Pass an absolute Coding Tools source checkout path");
const { createAgentOrchestratorUpstream } = require(path.join(root, "desktop-electron/electron/agent-orchestrator-upstream.cjs"));
const runtime = createAgentOrchestratorUpstream({
  resourceRoot: path.join(root, "aiTemp/orchestrator-contract/resources"),
  dataRoot: path.join(root, "aiTemp/orchestrator-contract/data"),
});
const inspection = inspectRuntime(runtime);
assert.equal(inspection.shapeCompatible, true, inspection.missing.join(", "));
assert.deepEqual(Object.keys(runtime).sort(), [...RUNTIME_METHODS, "harness"].sort());
assert.deepEqual(Object.keys(runtime.harness).sort(), [...HARNESS_METHODS].sort());
const handler = createOrchestratorHandler({ runtime });
assert.deepEqual(handler.snapshot(), runtime.snapshot());
assert.equal(handler.snapshot().state, "stopped");
console.log(JSON.stringify({
  handlerVersion: HANDLER_VERSION, contractVersion: CONTRACT_VERSION,
  shapeCompatible: true, runtimeMethods: RUNTIME_METHODS.length, harnessMethods: HARNESS_METHODS.length,
  engineStarted: false, replacementEngineBehavioralParity: "not_certified",
}, null, 2));
