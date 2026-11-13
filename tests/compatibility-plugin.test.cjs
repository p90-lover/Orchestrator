"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createCompatibilityPlugin } = require("../src/compatibility-plugin.cjs");
const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

test("test plugin advertises only bounded compatibility tools and honest readiness", async () => {
  const handle = createCompatibilityPlugin();
  assert.equal((await handle(request(1, "tools/list"))).error.code, -32002);
  const hello = await handle(request(2, "initialize", { protocolVersion: "2025-03-26" }));
  assert.equal(hello.result.protocolVersion, "2025-03-26");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const listed = await handle(request(3, "tools/list"));
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["orchestrator_status", "orchestrator_self_test"]);
  const status = await handle(request(4, "tools/call", { name: "orchestrator_status" }));
  assert.equal(status.result.structuredContent.productionReady, false);
  const injection = await handle(request(5, "tools/call", { name: "orchestrator_self_test", arguments: { path: "unapproved" } }));
  assert.equal(injection.error.code, -32602);
});

test("MCP self-test runs the real native engine without AO or a live model", async () => {
  const handle = createCompatibilityPlugin({ scratchRoot: path.resolve(__dirname, "../aiTemp/plugin-test") });
  await handle(request(1, "initialize", { protocolVersion: "2025-03-26" }));
  const response = await handle(request(2, "tools/call", { name: "orchestrator_self_test", arguments: {} }));
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.passed, true);
  assert.equal(response.result.structuredContent.checks.persistedAfterRestart, true);
  assert.equal(response.result.structuredContent.checks.replayAfterRestart, true);
  assert.equal(response.result.structuredContent.checks.noReplay, true);
  assert.equal(response.result.structuredContent.liveModelUsed, false);
  assert.equal(response.result.structuredContent.productionDataTouched, false);
});
