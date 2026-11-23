"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
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

test("owned child exit invalidates inherited pipes before they close", async t => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let signals = 0, notices = 0;
  child.kill = () => { signals += 1; return true; };
  t.mock.method(childProcess, "spawn", () => child);
  const closed = [];
  const client = createJsonLineClient({ ...launch, onNotification: () => { notices += 1; }, onClose: error => closed.push(error.code) });
  const request = client.request("pending");
  child.emit("exit", 0, null);
  child.stdout.write('{"id":1,"result":"late reply"}\n{"method":"late notification"}\n');
  await assert.rejects(request, { code: "DRIVER_EXITED" });
  await client.close();
  child.emit("close", 0, null);
  assert.deepEqual(closed, ["DRIVER_EXITED"]);
  assert.equal(notices, 0);
  assert.equal(signals, 0);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
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
