"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { AO_PIN } = require("../src/ao-history-export.cjs");
const { importOfflineHistory, readOfflineHistory, rollbackOfflineHistory, exportOfflineHistory } = require("../src/offline-history.cjs");
const { openNativeStore } = require("../src/native-store.cjs");

const timestamp = "2026-11-20T01:00:00Z";
const attachment = "attachment://fixture-image";
const turnId = "turn-fixture";
const message = (id, sequence, role, text, extra) => ({ id, kind: "message", sequence, turnId, revision: 1,
  role, origin: role === "user" ? "human" : "provider", streaming: false, text, editAvailable: false, createdAt: timestamp, ...extra });
const activity = (id, sequence, activityKind, status, detail) => ({ id, kind: "activity", sequence, turnId, revision: 2,
  activityKind, status, summary: activityKind, detail, createdAt: timestamp });
const approval = { ...activity("approve-1", 3, "approval", "resolved", { decision: "deny", rationale: "outside workspace" }), requestId: "req-fixture" };
const tool = activity("tool-1", 2, "mcp_tool", "failed", { server: "fixture", toolName: "read", error: "denied", success: false });

function fixture(t) {
  const parent = path.resolve(__dirname, "../aiTemp/ao-snapshot-export");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = { conversationId: "ao-conversation", sessionId: "ao-session", activeBranchId: "branch-root", branchedFromEarlierMessage: false,
    harness: "codex", mode: "chat", controller: "stopped", latestSequence: 4, title: "Finished fixture", nativeForkAvailableAfterSequence: 1,
    settings: { model: "fixture" }, turns: [{ id: turnId, state: "completed", requestedAt: timestamp, completedAt: timestamp }] };
  const bytes = Buffer.from("isolated attachment");
  const capture = { format: "ao-conversation-pages", schemaVersion: 1, sourceCommit: AO_PIN, exportId: "ao-export-fixture", trimLargeFields: false,
    conversations: [{ workspaceId: "isolated-project", pages: [
      { beforeSequence: null, snapshot: { ...structuredClone(snapshot), oldestSequence: 3, hasMoreBefore: true,
        messages: [message("reply-1", 4, "assistant", "done")], activities: [approval] } },
      { beforeSequence: 3, snapshot: { ...structuredClone(snapshot), oldestSequence: 1, hasMoreBefore: false,
        messages: [message("prompt-1", 1, "user", "test", { content: [{ type: "image", mimeType: "image/png", uri: attachment }] })], activities: [tool] } },
    ] }], blobs: [{ uri: attachment, id: "image-fixture", mediaType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") }] };
  const options = { exportFile: path.join(root, "capture.json"), dataRoot: path.join(root, "archive"), fromAo: true };
  const save = value => fs.writeFileSync(options.exportFile, JSON.stringify(value));
  save(capture);
  return { capture, options, save, query: { dataRoot: options.dataRoot, exportId: capture.exportId } };
}

test("imports a complete pinned AO snapshot chain and rolls back without dropping original history", t => {
  const { capture, options, query } = fixture(t), before = fs.readFileSync(options.exportFile);
  const receipt = importOfflineHistory(options);
  assert.equal(receipt.events, 5);
  const archive = exportOfflineHistory(query);
  const [chat] = archive.conversations;
  assert.equal(chat.id, "ao-conversation");
  assert.equal(chat.engine, "legacy-ao");
  assert.deepEqual(chat.events.map(event => event.sequence), [0, 1, 2, 3, 4]);
  assert.equal(chat.events[0].data.sessionId, "ao-session");
  assert.equal(chat.events[0].data.sourceCommit, AO_PIN);
  assert.deepEqual(chat.events[0].data.turns, capture.conversations[0].pages[0].snapshot.turns);
  assert.deepEqual(chat.events[1].blobIds, ["image-fixture"]);
  assert.deepEqual(chat.events[2].data, tool);
  assert.deepEqual(chat.events[3].data, approval);
  assert.equal(archive.blobs[0].dataBase64, capture.blobs[0].dataBase64);
  assert.equal(rollbackOfflineHistory(query).digest, receipt.digest);
  assert.throws(() => readOfflineHistory(query), { code: "HISTORY_NOT_FOUND" });
  assert.deepEqual(exportOfflineHistory({ ...query, includeInactive: true }), archive);
  assert.equal(importOfflineHistory(options).reactivated, true);
  assert.deepEqual(fs.readFileSync(options.exportFile), before);
  assert.equal(fs.existsSync(path.join(options.dataRoot, "orchestrator.sqlite")), false, "history never creates runnable sessions");
});

test("AO archive rollback preserves uncertain and queued native turns and unrelated history", async t => {
  const { capture, options, query } = fixture(t);
  const { dataRoot, exportFile } = options;
  const root = path.dirname(exportFile);
  const id = "queue-session";
  const coordinator = path.join(dataRoot, "orchestrator.sqlite");
  const fileDigest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const store = await openNativeStore({ dataRoot });
  let first, successor;
  try {
    await store.call("create", { id, workspaceId: "isolated-project", harness: "fixture", root });
    first = await store.call("enqueue", { id, clientMessageId: "uncertain-input", prompt: "Original" });
    successor = await store.call("enqueue", { id, clientMessageId: "queued-input", prompt: "Wait for original" });
    assert.equal((await store.call("claim", { id })).id, first.id);
    await store.call("append", { id, turnId: first.id, delta: "Unconfirmed partial answer" });
  } finally { await store.close(); }

  const observeNative = async () => {
    const reopened = await openNativeStore({ dataRoot });
    try {
      const { turn: uncertain } = await reopened.call("observe", { id, turnId: first.id });
      const { turn: queued } = await reopened.call("observe", { id, turnId: successor.id });
      assert.equal(uncertain.client_id, "uncertain-input");
      assert.equal(uncertain.state, "unknown");
      assert.equal(uncertain.answer, "Unconfirmed partial answer");
      assert.equal(queued.client_id, "queued-input");
      assert.equal(queued.state, "queued");
      assert.equal(await reopened.call("claim", { id }), null);
    } finally { await reopened.close(); }
  };
  await observeNative();
  const sourceDigest = fileDigest(exportFile), coordinatorDigest = fileDigest(coordinator);
  const other = { format: "orchestrator-finished-history", schemaVersion: 1, exportId: "other-export", blobs: [],
    conversations: [{ id: "native:other-chat", workspaceId: "other-project", engine: "orchestrator-native", name: "Unrelated history", state: "completed",
      events: [{ id: "other-event", sequence: 1, type: "message.user", data: { text: "retained" } }] }] };
  const otherFile = path.join(root, "other.json");
  fs.writeFileSync(otherFile, JSON.stringify(other));
  importOfflineHistory({ dataRoot, exportFile: otherFile });

  const imported = importOfflineHistory(options);
  assert.equal(imported.state, "active");
  assert.equal(imported.duplicate, false);
  const active = exportOfflineHistory(query);
  const eventQuery = { ...query, conversationId: "ao-conversation" };
  const page = readOfflineHistory({ ...eventQuery, limit: 2 });
  assert.equal(page.hasMore, true);
  const tail = readOfflineHistory({ ...eventQuery, after: page.cursor, limit: 3 });
  assert.equal(tail.hasMore, false);
  assert.deepEqual([...page.items, ...tail.items], active.conversations[0].events);

  const { exportId } = query;
  const reversed = { exportId, digest: imported.digest, state: "inactive", retained: true };
  assert.deepEqual(rollbackOfflineHistory(query), reversed);
  assert.deepEqual(rollbackOfflineHistory(query), reversed);
  assert.throws(() => readOfflineHistory(query), { code: "HISTORY_NOT_FOUND" });
  assert.throws(() => exportOfflineHistory(query), { code: "HISTORY_NOT_FOUND" });
  assert.deepEqual(exportOfflineHistory({ dataRoot, exportId: other.exportId }), other);

  const conflicting = structuredClone(capture);
  for (const { snapshot } of conflicting.conversations[0].pages) snapshot.title = "Different conversation content";
  const conflictingFile = path.join(root, "conflicting.json");
  fs.writeFileSync(conflictingFile, JSON.stringify(conflicting));
  assert.throws(() => importOfflineHistory({ ...options, exportFile: conflictingFile }), { code: "HISTORY_CONFLICT" });
  assert.throws(() => readOfflineHistory(query), { code: "HISTORY_NOT_FOUND" });
  assert.deepEqual(exportOfflineHistory({ ...query, includeInactive: true }), active);
  assert.deepEqual(importOfflineHistory(options), { exportId, digest: imported.digest, state: "active", duplicate: true, reactivated: true });
  assert.deepEqual(exportOfflineHistory(query), active);
  assert.equal(fileDigest(exportFile), sourceDigest);
  assert.equal(fileDigest(coordinator), coordinatorDigest);
  await observeNative();
});

test("invalid or incomplete AO captures fail before writing any archive", t => {
  const { capture, options, save } = fixture(t);
  const mutations = [
    ["HISTORY_SCHEMA_UNSUPPORTED", value => { value.sourceCommit = "0".repeat(40); }],
    ["HISTORY_AO_INVALID", value => { value.trimLargeFields = true; }],
    ["HISTORY_AO_INVALID", value => { value.unknownField = "not silently dropped"; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages.pop(); }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[1].beforeSequence = 2; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[1].snapshot.activeBranchId = "different-branch"; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[0].snapshot.branchedFromEarlierMessage = true; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[0].snapshot.turns[0].state = "running"; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[0].snapshot.activities[0].status = "pending"; }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[1].snapshot.activities[0].detail.outputTruncated = true; }],
    ["HISTORY_AO_INCOMPLETE", value => { value.blobs = []; }],
    ["HISTORY_INVALID", value => { value.blobs[0].sha256 = "0".repeat(64); }],
    ["HISTORY_AO_INCOMPLETE", (_value, pages) => { pages[0].snapshot.messages = []; }],
  ];
  for (const [code, mutate] of mutations) {
    const value = structuredClone(capture);
    mutate(value, value.conversations[0].pages);
    save(value);
    assert.throws(() => importOfflineHistory(options), { code });
    assert.equal(fs.existsSync(options.dataRoot), false);
  }
});

test("offline importer does not read through an alias to a multiply linked file", t => {
  const { options } = fixture(t);
  const alias = path.join(path.dirname(options.exportFile), "alias.json");
  fs.linkSync(options.exportFile, alias);
  assert.throws(() => importOfflineHistory({ ...options, exportFile: alias }), { code: "HISTORY_EXPORT_REQUIRED" });
  assert.equal(fs.existsSync(options.dataRoot), false);
});
