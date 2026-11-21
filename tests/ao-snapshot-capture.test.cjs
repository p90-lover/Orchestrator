"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { test } = require("node:test");
const { captureAoHistory } = require("../src/ao-snapshot-capture.cjs");
const { AO_PIN } = require("../src/ao-history-export.cjs");
const { importOfflineHistory, readOfflineHistory, rollbackOfflineHistory, exportOfflineHistory } = require("../src/offline-history.cjs");

const meta = { sessionId: "fixture-session", conversationId: "fixture-thread", mode: "chat", controller: "stopped", latestSequence: 4 };
const stamp = "2026-11-21T00:30:00Z";
const message = (sequence, turnId, role) => ({ kind: "message", id: `message-${sequence}`, turnId, sequence, role, text: `fixture-${sequence}`, streaming: false, createdAt: stamp });
const page = (earlier, extra) => {
  const turnId = earlier ? "opening-turn" : "closing-turn";
  return { ...meta, oldestSequence: earlier ? 1 : 3, hasMoreBefore: !earlier, turns: [{ id: turnId, state: "completed", requestedAt: stamp }],
    messages: [message(earlier ? 1 : 3, turnId, "user")],
    activities: [{ kind: "activity", id: `outcome-${turnId}`, turnId, sequence: earlier ? 2 : 4,
      activityKind: earlier ? "approval" : "mcp_tool", status: "resolved", detail: { decision: "deny", rationale: "fixture" } }], ...extra };
};

async function fixture(t, reply) {
  const parent = path.resolve(__dirname, "../aiTemp/ao-capture-test");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "case-"));
  const calls = [];
  const token = "synthetic-operator-token";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push({ method: request.method, pathname: url.pathname, before: url.searchParams.get("beforeSequence"),
      trim: url.searchParams.get("trimLargeFields"), authMatches: request.headers.authorization === `Bearer ${token}` });
    const snapshot = page(Boolean(calls.at(-1).before));
    if (reply) return reply(response, snapshot, calls.length);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(snapshot));
  });
  server.listen(0, "127.0.0.1");
  t.after(async () => { try { await new Promise(resolve => server.close(resolve)); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  await once(server, "listening");
  return { root, calls, options: { origin: `http://127.0.0.1:${server.address().port}`, sourceCommit: AO_PIN, sessionId: meta.sessionId,
    workspaceId: "fixture-workspace", exportId: "fixture-export", file: path.join(root, "capture.json"), token } };
}

test("captures page-local AO turn lists, imports exact ordered events and reverses archive visibility", async t => {
  const { root, calls, options } = await fixture(t);
  const captured = await captureAoHistory(options);
  assert.equal(captured.pages, 2);
  for (const [index, request] of calls.entries()) {
    assert.deepEqual(request, { method: "GET", pathname: `/api/v1/sessions/${meta.sessionId}/conversation`, before: index ? "3" : null, trim: "0", authMatches: true });
  }
  const dataRoot = path.join(root, "archive");
  const imported = importOfflineHistory({ dataRoot, exportFile: options.file, fromAo: true });
  assert.equal(imported.digest, captured.digest);
  const lookup = { dataRoot, exportId: options.exportId };
  const archive = exportOfflineHistory(lookup);
  const { events } = archive.conversations[0];
  assert.deepEqual(events.map(event => event.sequence), [0, 1, 2, 3, 4]);
  assert.deepEqual(events[0].data.turns.map(turn => turn.id), ["opening-turn", "closing-turn"]);
  assert.equal(events[2].data.detail.rationale, "fixture");
  assert.equal(events[4].type, "ao.activity.mcp_tool");
  assert.equal(rollbackOfflineHistory(lookup).state, "inactive");
  assert.throws(() => readOfflineHistory(lookup), { code: "HISTORY_NOT_FOUND" });
  assert.deepEqual(exportOfflineHistory({ ...lookup, includeInactive: true }), archive);
  await assert.rejects(captureAoHistory(options), { code: "HISTORY_CAPTURE_EXISTS" });
  assert.equal(calls.length, 2);
});

test("refuses an unapproved source, redirected request, and partial or changed history without publishing", async t => {
  let mode = "redirect";
  const { options, calls } = await fixture(t, (res, snapshot, count) => {
    if (mode === "redirect") { res.writeHead(302, { Location: "/not-a-snapshot" }); res.end(); return; }
    if (mode === "changed" && count === 3) snapshot.title = "changed between pages";
    if (mode === "gap" && snapshot.oldestSequence === 1) snapshot.activities.length = 0;
    if (mode === "attachment") snapshot.messages[0].content = [{ type: "image", uri: "opaque-missing-image" }];
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(snapshot));
  });
  await assert.rejects(captureAoHistory({ ...options, origin: "http://localhost:1010" }), { code: "HISTORY_CAPTURE_USAGE" });
  await assert.rejects(captureAoHistory({ ...options, sourceCommit: "0".repeat(40) }), { code: "HISTORY_CAPTURE_USAGE" });
  await assert.rejects(captureAoHistory({ ...options, token: "" }), { code: "HISTORY_CAPTURE_USAGE" });
  assert.equal(calls.length, 0);
  await assert.rejects(captureAoHistory(options), { code: "HISTORY_CAPTURE_REFUSED" });
  assert.equal(calls.length, 1, "no redirect or retry was followed");
  for (const condition of ["changed", "gap", "attachment"]) {
    mode = condition;
    await assert.rejects(captureAoHistory(options), { code: "HISTORY_AO_INCOMPLETE" });
    await assert.rejects(fs.stat(options.file), { code: "ENOENT" });
  }
});
