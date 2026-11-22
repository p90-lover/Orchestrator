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
  await assert.rejects(run(async () => { throw new Error("storage unavailable"); }), error => error.message === "storage unavailable" && error.uncertain === true);
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
  await assert.rejects(run(), { code: "INVALID_PROTOCOL", uncertain: true });
  await assert.rejects(run(), { code: "SESSION_REATTACH_REQUIRED" });
  assert.equal(starts, 1);
  await driver.close();
});

test("Codex deltas reach the bounded batcher before earlier writes finish", async () => {
  let hooks;
  const driver = createCodexDriver({ launch: async () => ({}), createClient(options) {
    hooks = options;
    return { async request(method) {
      if (method === "initialize") return {};
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") return { turn: { id: "turn" } };
    }, notify() {}, async close() { hooks.onClose(new Error("closed")); } };
  } });
  const writes = [];
  let finished = false;
  const running = driver.run({ session, turn: { id: "local", prompt: "test" }, signal: new AbortController().signal,
    emitText: text => new Promise(resolve => writes.push({ text, resolve })) }).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  for (const delta of ["first", "second", "third"]) hooks.onNotification("item/agentMessage/delta", { threadId: "thread", turnId: "turn", delta });
  hooks.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  assert.deepEqual(writes.map(write => write.text), ["first", "second", "third"]);
  assert.equal(finished, false);
  for (const write of writes) write.resolve();
  await running;
  assert.equal(finished, true);
  await driver.close();
});

for (const outcome of ["interrupted", "completed", "unconfirmed"]) {
  test(`Codex cancellation preserves the exact ${outcome} outcome`, async t => {
    const interrupts = [];
    let hooks, turns = 0, closes = 0;
    const driver = createCodexDriver({ interruptTimeoutMs: outcome === "unconfirmed" ? 80 : 2000,
      launch: async () => ({}), createClient(options) {
        hooks = options;
        return { async request(method, params) {
          if (method === "initialize") return {};
          if (method === "thread/start") return { thread: { id: "thread" } };
          if (method === "turn/start") return { turn: { id: `turn-${++turns}` } };
          if (method === "turn/interrupt") { interrupts.push(params); return {}; }
          throw new Error("Unexpected request");
        }, notify() {}, async close() { closes += 1; hooks.onClose(new Error("connection closed")); } };
      },
    });
    t.after(() => driver.close());
    const start = id => driver.run({ session, turn: { id, prompt: "test" }, signal: new AbortController().signal,
      emitText: async () => {} }).then(() => null, error => error);
    const running = start("local");
    await new Promise(setImmediate);
    assert.equal(await driver.cancel({ sessionId: session.id, turnId: "old-local" }), false);
    let resolved = false;
    const stopping = driver.cancel({ sessionId: session.id, turnId: "local" }).then(value => { resolved = true; return value; });
    await new Promise(setImmediate);
    assert.deepEqual(interrupts, [{ threadId: "thread", turnId: "turn-1" }]);
    hooks.onNotification("turn/completed", { threadId: "other-thread", turn: { id: "turn-1", status: "interrupted" } });
    hooks.onNotification("turn/completed", { threadId: "thread", turnId: "turn-1", turn: { id: "old-turn", status: "interrupted" } });
    await new Promise(setImmediate);
    assert.equal(resolved, false);
    if (outcome !== "unconfirmed") {
      hooks.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn-1", status: outcome } });
    }
    assert.equal(await stopping, outcome === "interrupted");
    const error = await running;
    if (outcome === "unconfirmed") {
      assert.equal(error?.code, "INTERRUPT_UNCONFIRMED");
      assert.equal(error?.uncertain, true);
      assert.equal((await start("must-not-run"))?.code, "SESSION_REATTACH_REQUIRED");
      assert.equal(turns, 1);
    } else {
      assert.equal(error?.code ?? null, outcome === "interrupted" ? "TURN_CANCELLED" : null);
      assert.equal(closes, 0, "a confirmed terminal turn keeps the original thread available");
      const next = start("next-local");
      await new Promise(setImmediate);
      hooks.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn-2", status: "completed" } });
      assert.equal(await next, null);
    }
  });
}

test("a host abort while Codex turn start waits closes the connection without confirming cancellation", async t => {
  const controller = new AbortController();
  let lostStart, requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  const driver = createCodexDriver({ launch: async () => ({}), createClient({ onClose }) {
    return { async request(method) {
      if (method === "initialize") return {};
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method !== "turn/start") throw new Error("Unexpected request");
      return new Promise((_resolve, reject) => { lostStart = reject; requested(); });
    }, notify() {}, async close() {
      const error = new Error("The start reply was lost");
      lostStart?.(error);
      onClose(error);
    } };
  } });
  t.after(() => driver.close());
  const run = driver.run({ session, turn: { id: "local", prompt: "test" }, signal: controller.signal, emitText: async () => {} });
  await waiting;
  controller.abort();
  await assert.rejects(run, { uncertain: true });
  assert.equal(await driver.cancel({ sessionId: session.id, turnId: "local" }), false);
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
