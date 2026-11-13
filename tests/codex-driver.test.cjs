"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCodexDriver } = require("../src/codex-driver.cjs");

function fakePeer({ early = false, fail = false } = {}) {
  let hooks, activeTurn = 0;
  const requests = [], replies = [];
  return {
    requests, replies,
    createClient(options) {
      hooks = options;
      return {
        async request(method, params) {
          requests.push({ method, params });
          if (method === "initialize") return {};
          if (method === "thread/start") return { thread: { id: "thread-1" } };
          if (method === "turn/start") {
            const id = `turn-${++activeTurn}`;
            const events = () => {
              hooks.onNotification("item/agentMessage/delta", { threadId: "other-thread", turnId: id, delta: "foreign" });
              hooks.onNotification("item/agentMessage/delta", { threadId: "thread-1", turnId: "old-turn", delta: "stale" });
              hooks.onNotification("item/agentMessage/delta", { threadId: "thread-1", turnId: id, delta: "hello" });
              hooks.onNotification("turn/completed", { threadId: "thread-1", turn: { id, status: fail ? "failed" : "completed" } });
            };
            if (early) events(); else setImmediate(events);
            return { turn: { id } };
          }
          throw new Error("Unexpected request");
        },
        notify(method) { replies.push(method); },
        async close() { hooks.onClose(new Error("closed")); },
      };
    },
    request: (...args) => hooks.onRequest(...args),
  };
}
const session = { id: "session-1", root: __dirname };

for (const early of [false, true]) {
  test(`direct Codex protocol owns thread and turn, including ${early ? "early" : "normal"} events`, async () => {
    const peer = fakePeer({ early });
    const driver = createCodexDriver({ launch: async () => ({}), createClient: options => peer.createClient(options), model: "synthetic-model" });
    const output = [];
    for (let i = 0; i < 2; i += 1) await driver.run({ session, turn: { id: `local-${i}`, prompt: "synthetic prompt" }, signal: new AbortController().signal, emitText: async value => output.push(value) });
    assert.deepEqual(output, ["hello", "hello"]);
    assert.equal(peer.requests.filter(request => request.method === "thread/start").length, 1);
    const start = peer.requests.find(request => request.method === "thread/start");
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.approvalPolicy, "on-request");
    assert.equal(start.params.ephemeral, true);
    assert.deepEqual(peer.replies, ["initialized"]);
    assert.equal(driver.capabilities.productionReady, false);
    await assert.rejects(Promise.resolve().then(() => peer.request("item/commandExecution/requestApproval", { threadId: "other", turnId: "turn-2" })), { code: "REQUEST_SCOPE" });
    await driver.close();
  });
}

test("failed native turns fail the caller instead of appearing complete", async () => {
  const peer = fakePeer({ fail: true });
  const driver = createCodexDriver({ launch: async () => ({}), createClient: options => peer.createClient(options) });
  await assert.rejects(driver.run({ session, turn: { id: "local", prompt: "test" }, signal: new AbortController().signal, emitText: async () => {} }), { code: "HARNESS_TURN_FAILED" });
  await driver.close();
});

test("output failure retires the provider connection before another turn", async () => {
  const peer = fakePeer();
  const driver = createCodexDriver({ launch: async () => ({}), createClient: options => peer.createClient(options) });
  const run = emitText => driver.run({ session, turn: { id: "local", prompt: "test" }, signal: new AbortController().signal, emitText });
  await assert.rejects(run(async () => { throw new Error("storage unavailable"); }), /storage unavailable/);
  await assert.rejects(run(async () => {}), { code: "SESSION_REATTACH_REQUIRED" });
  assert.equal(peer.requests.filter(item => item.method === "turn/start").length, 1);
  await driver.close();
});

test("an invalid turn acknowledgement never permits a second inference", async () => {
  let hooks, starts = 0;
  const driver = createCodexDriver({ launch: async () => ({}), createClient(options) {
    hooks = options;
    return {
      async request(method) {
        if (method === "initialize") return {};
        if (method === "thread/start") return { thread: { id: "thread" } };
        if (method === "turn/start") { starts += 1; return { turn: {} }; }
      }, notify() {}, async close() { hooks.onClose(new Error("closed")); },
    };
  } });
  const run = () => driver.run({ session, turn: { id: "local", prompt: "test" }, signal: new AbortController().signal, emitText: async () => {} });
  await assert.rejects(run(), { code: "INVALID_PROTOCOL" });
  await assert.rejects(run(), { code: "SESSION_REATTACH_REQUIRED" });
  assert.equal(starts, 1);
  await driver.close();
});

test("approval requests are denied by the prototype, never auto-granted", async () => {
  let hooks, complete;
  const driver = createCodexDriver({ launch: async () => ({}), createClient(options) {
    hooks = options;
    return {
      async request(method) {
        if (method === "initialize") return {};
        if (method === "thread/start") return { thread: { id: "thread" } };
        if (method === "turn/start") { complete = () => hooks.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } }); return { turn: { id: "turn" } }; }
      }, notify() {}, async close() { hooks.onClose(new Error("closed")); },
    };
  } });
  const running = driver.run({ session, turn: { id: "local", prompt: "test" }, signal: new AbortController().signal, emitText: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(hooks.onRequest("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn" }), { decision: "decline" });
  assert.throws(() => hooks.onRequest("unknown", { threadId: "thread", turnId: "turn" }), { code: "UNSUPPORTED_REQUEST" });
  complete(); await running; await driver.close();
});
