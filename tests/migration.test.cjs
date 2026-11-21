"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { DatabaseSync } = require("node:sqlite");
const { importOfflineHistory, rollbackOfflineHistory, readOfflineHistory, exportOfflineHistory } = require("../src/offline-history.cjs");
const hash = value => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const parent = path.resolve(__dirname, "../aiTemp/migration");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "archive"), exportFile = path.join(root, "offline.json");
  const image = Buffer.from("synthetic image bytes");
  const value = { format: "orchestrator-finished-history", schemaVersion: 1, exportId: "migration-one", conversations: [
    { id: "chat-one", workspaceId: "workspace-one", engine: "legacy-ao", name: "Fixture", state: "completed", events: [
      { id: "user-one", sequence: 2, type: "message.user", data: { text: "inspect fixture" }, blobIds: ["image-one"] },
      { id: "tool-one", sequence: 4, type: "tool.result", data: { callId: "call-one", outcome: "denied", result: { code: "not-authorized" } } },
      { id: "approval-one", sequence: 9, type: "approval.resolved", data: { requestId: "request-one", decision: "deny", reason: "outside the fixture workspace", extra: [null, true, 3] } },
    ] },
    { id: "native:chat-two", workspaceId: "workspace-one", engine: "orchestrator-native", name: "Stopped", state: "cancelled", events: [] },
  ], blobs: [{ id: "image-one", mediaType: "image/png", dataBase64: image.toString("base64"), sha256: hash(image) }] };
  const save = (next = value) => fs.writeFileSync(exportFile, JSON.stringify(next));
  save();
  return { root, dataRoot, exportFile, value, save, options: { dataRoot, exportFile }, read: { dataRoot, exportId: value.exportId } };
}

test("offline import preserves exact identities, event order, tools, approval rationale and blob bytes", t => {
  const f = fixture(t), source = fs.readFileSync(f.exportFile);
  const receipt = importOfflineHistory(f.options);
  assert.equal(receipt.events, 3);
  assert.equal(receipt.conversations, 2);
  assert.deepEqual(exportOfflineHistory(f.read), f.value);
  assert.deepEqual(fs.readFileSync(f.exportFile), source);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "orchestrator.sqlite")), false, "archive never creates executable coordinator state");
  const first = readOfflineHistory({ ...f.read, limit: 1 });
  assert.equal(first.items[0].id, "chat-one"); assert.equal(first.hasMore, true);
  assert.equal(readOfflineHistory({ ...f.read, after: first.cursor, limit: 1 }).items[0].id, "native:chat-two");
  assert.deepEqual(readOfflineHistory({ ...f.read, conversationId: "native:chat-two" }).items, []);
  const events = readOfflineHistory({ ...f.read, conversationId: "chat-one", limit: 2 });
  assert.deepEqual(events.items.map(event => event.sequence), [2, 4]); assert.equal(events.hasMore, true);
  assert.deepEqual(readOfflineHistory({ ...f.read, conversationId: "chat-one", after: events.cursor }).items, [f.value.conversations[0].events[2]]);
  assert.throws(() => readOfflineHistory({ ...f.read, conversationId: "other" }), { code: "HISTORY_NOT_FOUND" });
  assert.throws(() => readOfflineHistory({ ...f.read, limit: 201 }), { code: "HISTORY_CURSOR" });
});

test("import is idempotent and rollback retains a recoverable archive without inference", t => {
  const f = fixture(t), receipt = importOfflineHistory(f.options);
  assert.equal(importOfflineHistory(f.options).duplicate, true);
  const rolled = rollbackOfflineHistory(f.read);
  assert.equal(rolled.digest, receipt.digest); assert.equal(rolled.retained, true);
  assert.throws(() => readOfflineHistory(f.read), { code: "HISTORY_NOT_FOUND" });
  assert.deepEqual(exportOfflineHistory({ ...f.read, includeInactive: true }), f.value);
  assert.equal(rollbackOfflineHistory(f.read).state, "inactive");
  assert.equal(importOfflineHistory(f.options).reactivated, true);
  assert.deepEqual(exportOfflineHistory(f.read), f.value);
});

test("same ID with changed content or an overlapping conversation cannot overwrite history", t => {
  const f = fixture(t); importOfflineHistory(f.options);
  const changed = structuredClone(f.value); changed.conversations[0].name = "changed"; f.save(changed);
  assert.throws(() => importOfflineHistory(f.options), { code: "HISTORY_CONFLICT" });
  changed.exportId = "another-import"; f.save(changed);
  assert.throws(() => importOfflineHistory(f.options), { code: "HISTORY_CONFLICT" });
  assert.deepEqual(exportOfflineHistory(f.read), f.value);
  assert.throws(() => readOfflineHistory({ ...f.read, exportId: "another-import" }), { code: "HISTORY_NOT_FOUND" });
});

test("invalid, active, oversized and corrupted history is rejected before archive creation", t => {
  const f = fixture(t);
  const mutations = [
    value => { value.schemaVersion = 2; },
    value => { value.conversations[0].state = "running"; },
    value => { value.conversations[0].id = "native:legacy-chat"; },
    value => { value.conversations[0].events[1].sequence = 1; },
    value => { value.conversations[0].events[1].id = "user-one"; },
    value => { value.conversations[0].events[0].blobIds = ["missing"]; },
    value => { value.conversations[0].events[0].data.text = "x".repeat(65537); },
    value => { value.blobs[0].sha256 = "0".repeat(64); },
    value => { value.blobs[0].dataBase64 += "!"; },
    value => { value.unrecognized = "must not be silently dropped"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(f.value); mutate(value); f.save(value);
    assert.throws(() => importOfflineHistory(f.options));
    assert.equal(fs.existsSync(f.dataRoot), false);
  }
  assert.throws(() => importOfflineHistory({ ...f.options, exportFile: path.join(f.root, "ao.db") }), { code: "HISTORY_EXPORT_REQUIRED" });
  f.save(); assert.throws(() => importOfflineHistory({ ...f.options, dataRoot: "relative" }), { code: "HISTORY_ROOT_REQUIRED" });
});

test("a mid-import storage failure rolls back every new row and keeps the previous import", t => {
  const f = fixture(t); importOfflineHistory(f.options);
  const db = new DatabaseSync(path.join(f.dataRoot, "offline-history.sqlite"));
  db.exec("CREATE TRIGGER fail_fixture BEFORE INSERT ON events WHEN NEW.id='fail-event' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); db.close();
  const next = structuredClone(f.value); next.exportId = "second";
  for (const conversation of next.conversations) conversation.id += "-second";
  next.conversations[0].events[1].id = "fail-event"; f.save(next);
  const before = hash(fs.readFileSync(f.exportFile));
  assert.throws(() => importOfflineHistory(f.options), /fixture write failure/);
  assert.equal(hash(fs.readFileSync(f.exportFile)), before);
  assert.deepEqual(exportOfflineHistory(f.read), f.value);
  assert.throws(() => readOfflineHistory({ ...f.read, exportId: "second" }), { code: "HISTORY_NOT_FOUND" });
});

test("a newer archive schema is refused without rewriting or downgrade", t => {
  const f = fixture(t); importOfflineHistory(f.options);
  const file = path.join(f.dataRoot, "offline-history.sqlite");
  const db = new DatabaseSync(file); db.exec("PRAGMA user_version=99"); db.close();
  const before = hash(fs.readFileSync(file));
  assert.throws(() => importOfflineHistory(f.options), { code: "HISTORY_SCHEMA_UNSUPPORTED" });
  assert.throws(() => rollbackOfflineHistory(f.read), { code: "HISTORY_SCHEMA_UNSUPPORTED" });
  assert.equal(hash(fs.readFileSync(file)), before);
});

test("archive corruption is detected during round-trip export", t => {
  const f = fixture(t); importOfflineHistory(f.options);
  const db = new DatabaseSync(path.join(f.dataRoot, "offline-history.sqlite"));
  db.prepare("UPDATE conversations SET name=? WHERE id=?").run("tampered", "chat-one"); db.close();
  assert.throws(() => exportOfflineHistory(f.read), { code: "HISTORY_CORRUPT" });
});

test("offline CLI imports, rolls back and exports the retained receipt without database discovery", t => {
  const f = fixture(t), script = path.resolve(__dirname, "../scripts/import-history.cjs");
  const run = (...args) => {
    const result = { status: 0, stdout: "", stderr: "" };
    const cliProcess = { argv: [process.execPath, script, ...args],
      stdout: { write: text => { result.stdout += text; } }, stderr: { write: text => { result.stderr += text; } },
      set exitCode(value) { result.status = value; } };
    vm.runInNewContext(fs.readFileSync(script, "utf8"), { require: createRequire(script), process: cliProcess });
    return result;
  };
  const imported = run("import", "--data-root", f.dataRoot, "--export", f.exportFile);
  assert.equal(imported.status, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).state, "active");
  const rolled = run("rollback", "--data-root", f.dataRoot, "--export-id", f.value.exportId);
  assert.equal(rolled.status, 0, rolled.stderr);
  const exported = run("export", "--data-root", f.dataRoot, "--export-id", f.value.exportId, "--include-inactive", "true");
  assert.equal(exported.status, 0, exported.stderr); assert.deepEqual(JSON.parse(exported.stdout), f.value);
  const refused = run("import", "--data-root", f.dataRoot, "--export", path.join(f.root, "ao.db"));
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stderr).error, "HISTORY_EXPORT_REQUIRED");
});
