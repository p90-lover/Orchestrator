"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: wait } = require("node:timers/promises");
const test = require("node:test");
const { createChatsProvider } = require("../src/chats-provider.cjs");

async function ended(call, sessionId, expected) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = await call({ action: "read", sessionId });
    if (page.turn?.state === expected) return page;
    if (["completed", "failed", "unknown"].includes(page.turn?.state)) assert.equal(page.turn.state, expected);
    await wait(20);
  }
  throw new Error("The isolated native turn did not settle");
}

test("Chats persists exact input receipts and paged text on its own native engine", async t => {
  const parent = path.resolve(__dirname, "../aiTemp/native-chats-test");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "case-"));
  const calls = [];
  const peer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, "fixture-model");
      assert.equal(body.stream, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.at(-1).role, "user");
      calls.push(body.messages);
      if (body.messages.at(-1).content === "redirect") {
        res.writeHead(307, { location: `http://127.0.0.1:${peer.address().port}/wrong` }).end();
      } else res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `Fixture reply ${calls.length}` } }] }));
    } catch (error) { res.writeHead(500).end(); peer.emit("fixture-error", error); }
  });
  const errors = [], runtimes = [];
  peer.on("fixture-error", error => errors.push(error));
  t.after(async () => {
    try { await Promise.all(runtimes.map(runtime => runtime.close())); }
    finally {
      await new Promise(resolve => peer.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const binding = { endpoint: `http://127.0.0.1:${peer.address().port}/v1`, protocol: "openai-completions", model: "fixture-model",
    token: "fixture-token", workspaceId: "test-scope", workspaceRoot: root, dataRoot: path.join(root, "data") };
  assert.throws(() => createChatsProvider({ ...binding, endpoint: "http://example.test/v1" }), { code: "CHATS_BINDING_REQUIRED" });
  assert.throws(() => createChatsProvider({ ...binding, protocol: "responses" }), { code: "CHATS_BINDING_REQUIRED" });
  const open = (options = binding) => { const runtime = createChatsProvider(options); runtimes.push(runtime); return runtime; };
  const runtime = open();
  const call = args => runtime.call("chats", args);
  assert.equal((await call({ action: "status" })).ready, false);
  await assert.rejects(call({ action: "list" }), { code: "CHATS_NOT_OPEN" });
  await assert.rejects(call({ action: "open", endpoint: "http://127.0.0.1" }), { code: "CHATS_REQUEST" });
  await call({ action: "open" });
  assert.equal(calls.length, 0);
  const first = await call({ action: "send", inputId: "saved-a", text: "same text" });
  assert.match(first.sessionId, /^native:/);
  assert.equal(first.inputId, "saved-a");
  assert.deepEqual(await call({ action: "receipt", inputId: "saved-a" }), { receipt: first });
  assert.equal((await ended(call, first.sessionId, "completed")).turn.answer, "Fixture reply 1");
  assert.deepEqual(await call({ action: "send", inputId: "saved-a", text: "same text" }), first);
  await assert.rejects(call({ action: "send", inputId: "saved-a", text: "different" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(call({ action: "read", sessionId: "legacy-ao" }), { code: "CHATS_SESSION_SCOPE" });
  const second = await call({ action: "send", sessionId: first.sessionId, inputId: "saved-b", text: "same text" });
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(await call({ action: "receipt", sessionId: second.sessionId, inputId: "saved-b" }), { receipt: second });
  const latest = await ended(call, second.sessionId, "completed");
  assert.equal(latest.turn.answer, "Fixture reply 2");
  assert.deepEqual(calls[1], [{ role: "user", content: "same text" }, { role: "assistant", content: "Fixture reply 1" }, { role: "user", content: "same text" }]);
  const earlier = await call({ action: "read", sessionId: second.sessionId, before: latest.cursor });
  assert.equal(earlier.turn.id, first.turnId);
  assert.equal(earlier.cursor, null);
  const redirected = await call({ action: "send", inputId: "redirect", text: "redirect" });
  await ended(call, redirected.sessionId, "failed");
  assert.equal(calls.length, 3);
  assert.deepEqual(errors, []);
  await runtime.close();
  const reopened = open();
  const read = args => reopened.call("chats", args);
  await read({ action: "open" });
  assert.deepEqual(await read({ action: "receipt", inputId: "saved-a" }), { receipt: first });
  assert.equal((await read({ action: "read", sessionId: first.sessionId })).continuable, false);
  await assert.rejects(read({ action: "send", sessionId: first.sessionId, inputId: "saved-c", text: "must not replay" }), { code: "CHATS_REATTACH_REQUIRED" });
  await reopened.close();
  const foreign = open({ ...binding, workspaceId: "foreign" });
  await foreign.call("chats", { action: "open" });
  assert.deepEqual(await foreign.call("chats", { action: "list" }), { chats: [], cursor: null });
  await assert.rejects(foreign.call("chats", { action: "read", sessionId: first.sessionId }), { code: "CHATS_SESSION_SCOPE" });
  assert.equal(calls.length, 3);
});
