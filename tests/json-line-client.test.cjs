"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createJsonLineClient } = require("../src/json-line-client.cjs");
const launch = { executable: process.execPath, args: [path.join(__dirname, "fixtures/json-peer.cjs")], cwd: __dirname, env: { ...process.env } };

test("direct transport preserves JSON and Unicode through a real child process", async t => {
  const client = createJsonLineClient(launch);
  t.after(() => client.close());
  const payload = { text: "中文 😀", nested: { value: 1 } };
  assert.deepEqual(await client.request("echo", payload), payload);
});

test("child exit rejects ambiguous outstanding requests", async t => {
  const client = createJsonLineClient(launch);
  t.after(() => client.close());
  await assert.rejects(client.request("exit"), { code: "DRIVER_EXITED" });
});

test("malformed output closes the channel rather than consuming further messages", async t => {
  const client = createJsonLineClient(launch);
  t.after(() => client.close());
  await assert.rejects(client.request("malformed"));
  await assert.rejects(client.request("echo"), { code: "DRIVER_CLOSED" });
});

test("unknown request timeout is bounded and never replayed", async t => {
  const client = createJsonLineClient({ ...launch, requestTimeoutMs: 150 });
  t.after(() => client.close());
  await assert.rejects(client.request("never-respond"), { code: "DRIVER_TIMEOUT" });
});
