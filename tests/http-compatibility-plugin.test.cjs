"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { test } = require("node:test");
const { startCompatibilityHttp } = require("../src/http-compatibility-plugin.cjs");

const scratchRoot = path.resolve(__dirname, "../aiTemp/http-plugin-test");
const request = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

async function fixture(t, probe) {
  const token = randomBytes(32).toString("hex");
  const server = await startCompatibilityHttp({ token, scratchRoot, probe });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = (body, overrides = {}) => fetch(server.url, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { ...server, headers, post };
}

test("HTTP compatibility tool fails closed before dispatch and exposes only a loopback MCP endpoint", async t => {
  let runs = 0;
  const server = await fixture(t, async () => { runs += 1; return { passed: true }; });
  const tool = request("tools/call", { name: "orchestrator_self_test" });
  assert.equal(new URL(server.url).hostname, "127.0.0.1");
  assert.equal((await server.post(tool, { Authorization: "" })).status, 401);
  assert.equal((await server.post(tool, { Authorization: `Bearer ${"0".repeat(64)}` })).status, 401);
  assert.equal((await server.post(tool, { Origin: "http://127.0.0.1:1234" })).status, 403);
  const wrongAuthority = await new Promise((resolve, reject) => {
    const req = http.request(server.url, { method: "POST", headers: { ...server.headers, Host: "other.invalid" } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(JSON.stringify(tool));
  });
  assert.equal(wrongAuthority, 403);
  assert.equal((await server.post(tool, { "Content-Type": "text/plain" })).status, 415);
  const oversized = await server.post({ ...tool, tooLarge: "x".repeat(64 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(server.url, { headers: server.headers })).status, 405);
  assert.equal((await fetch(`${server.url}/other`, { headers: server.headers })).status, 404);
  assert.equal(runs, 0);
  assert.equal((await server.post(tool)).status, 200);
  assert.equal(runs, 1);
});

test("HTTP MCP uses stateless JSON responses and runs at most one isolated self-test at once", async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const server = await fixture(t, async () => { started(); await gate; return { passed: true }; });
  const init = await (await server.post(request("initialize", { protocolVersion: "2025-11-25" }))).json();
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.equal((await server.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const listed = await (await server.post(request("tools/list"))).json();
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["orchestrator_status", "orchestrator_self_test"]);
  const status = await (await server.post(request("tools/call", { name: "orchestrator_status" }))).json();
  assert.equal(status.result.structuredContent.productionReady, false);
  const tool = request("tools/call", { name: "orchestrator_self_test" });
  const first = server.post(tool);
  try {
    await Promise.race([running, first.then(() => assert.fail("the self-test returned before it started"))]);
    assert.equal((await server.post(tool)).status, 429);
  } finally { release(); }
  assert.equal((await (await first).json()).result.structuredContent.passed, true);
});
