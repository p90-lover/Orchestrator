"use strict";

// This synchronous archive API is for the offline CLI, never Electron main.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { convertAoHistory } = require("./ao-history-export.cjs");

const FORMAT = "orchestrator-finished-history";
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const identifier = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail("HISTORY_INVALID", "History identity is invalid");
  return value;
};
const conversationIdentity = (value, engine) => {
  if ((engine === undefined || engine === "orchestrator-native") && typeof value === "string" && value.startsWith("native:")) {
    identifier(value.slice("native:".length));
    return value;
  }
  return identifier(value);
};
const fields = (value, names) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw fail("HISTORY_INVALID", "Unsupported history fields");
};
function canonical(value, depth = 0) {
  if (depth > 32) throw fail("HISTORY_LIMIT", "History JSON exceeds its nesting limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  throw fail("HISTORY_INVALID", "History contains a non-JSON value");
}
function validateExport(value) {
  fields(value, ["format", "schemaVersion", "exportId", "conversations", "blobs"]);
  if (value.format !== FORMAT || value.schemaVersion !== 1) throw fail("HISTORY_SCHEMA_UNSUPPORTED", "Unsupported finished-history export version");
  identifier(value.exportId);
  if (!Array.isArray(value.conversations) || value.conversations.length < 1 || value.conversations.length > 500
    || !Array.isArray(value.blobs) || value.blobs.length > 1000) throw fail("HISTORY_LIMIT", "History collection limit exceeded");
  const blobIds = new Set(), ids = new Set();
  let blobBytes = 0, eventCount = 0;
  for (const blob of value.blobs) {
    fields(blob, ["id", "mediaType", "dataBase64", "sha256"]);
    identifier(blob.id);
    if (blobIds.has(blob.id)) throw fail("HISTORY_CONFLICT", "Duplicate blob identity");
    blobIds.add(blob.id);
    if (typeof blob.mediaType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(blob.mediaType) || blob.mediaType.length > 128
      || typeof blob.dataBase64 !== "string" || blob.dataBase64.length > 1400000) throw fail("HISTORY_INVALID", "Invalid blob metadata");
    const bytes = Buffer.from(blob.dataBase64, "base64");
    blobBytes += bytes.length;
    if (bytes.toString("base64") !== blob.dataBase64 || bytes.length > 1024 * 1024 || blobBytes > 8 * 1024 * 1024
      || digest(bytes) !== blob.sha256) throw fail("HISTORY_INVALID", "History blob checksum or size is invalid");
  }
  for (const conversation of value.conversations) {
    fields(conversation, ["id", "workspaceId", "engine", "name", "state", "events"]);
    conversationIdentity(conversation.id, conversation.engine); identifier(conversation.workspaceId);
    if (ids.has(conversation.id)) throw fail("HISTORY_CONFLICT", "Duplicate conversation identity");
    ids.add(conversation.id);
    if (!["legacy-ao", "orchestrator-native"].includes(conversation.engine)
      || !["completed", "failed", "cancelled"].includes(conversation.state)
      || typeof conversation.name !== "string" || Buffer.byteLength(conversation.name) > 1024) throw fail("HISTORY_INVALID", "Only identified finished conversations can be imported");
    if (!Array.isArray(conversation.events) || conversation.events.length > 2000) throw fail("HISTORY_LIMIT", "Conversation event limit exceeded");
    eventCount += conversation.events.length;
    if (eventCount > 10000) throw fail("HISTORY_LIMIT", "Export event limit exceeded");
    const events = new Set();
    let previous = -1;
    for (const event of conversation.events) {
      fields(event, ["id", "sequence", "type", "data", "blobIds"]);
      identifier(event.id);
      if (events.has(event.id) || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= previous) throw fail("HISTORY_CONFLICT", "Event identities and ordering must be unique");
      events.add(event.id); previous = event.sequence;
      if (typeof event.type !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/.test(event.type)
        || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw fail("HISTORY_INVALID", "Invalid history event");
      if (Buffer.byteLength(JSON.stringify(canonical(event.data))) > 65536) throw fail("HISTORY_LIMIT", "Event data exceeds its limit");
      if (event.blobIds !== undefined && (!Array.isArray(event.blobIds) || event.blobIds.length > 100
        || new Set(event.blobIds).size !== event.blobIds.length || event.blobIds.some(id => !blobIds.has(id)))) throw fail("HISTORY_INVALID", "Event refers to missing or duplicate blobs");
    }
  }
  const encoded = JSON.stringify(canonical(value));
  if (Buffer.byteLength(encoded) > MAX_EXPORT_BYTES) throw fail("HISTORY_LIMIT", "Export exceeds its byte limit");
  return { value: JSON.parse(encoded), digest: digest(encoded), eventCount };
}
function openArchive(dataRoot, writable, create = false) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw fail("HISTORY_ROOT_REQUIRED", "Choose an explicit absolute archive directory");
  if (create) fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const file = path.join(fs.realpathSync(dataRoot), "offline-history.sqlite");
  if (!create && !fs.existsSync(file)) throw fail("HISTORY_NOT_FOUND", "Archive does not exist");
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(file).nlink > 1)) throw fail("HISTORY_INVALID", "Archive must be an unlinked regular file");
  const db = new DatabaseSync(file, { readOnly: !writable });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 1 && !(writable && version === 0 && db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n === 0)) {
      throw fail("HISTORY_SCHEMA_UNSUPPORTED", "Archive schema is unsupported; no downgrade was attempted");
    }
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
    if (writable) {
      db.exec("PRAGMA synchronous=FULL");
      const pageSize = db.prepare("PRAGMA page_size").get().page_size;
      const pages = db.prepare("PRAGMA page_count").get().page_count;
      if (pages * pageSize >= MAX_ARCHIVE_BYTES) throw fail("HISTORY_LIMIT", "Archive is full; existing history was retained");
      db.exec(`PRAGMA max_page_count=${Math.floor(MAX_ARCHIVE_BYTES / pageSize)}`);
      if (version === 0) transaction(db, () => db.exec(`
        CREATE TABLE imports(export_id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE conversations(export_id TEXT NOT NULL REFERENCES imports(export_id),id TEXT NOT NULL,ordinal INTEGER NOT NULL,workspace_id TEXT NOT NULL,engine TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(export_id,id),UNIQUE(engine,id));
        CREATE TABLE events(export_id TEXT NOT NULL,conversation_id TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(export_id,conversation_id,id),UNIQUE(export_id,conversation_id,sequence),FOREIGN KEY(export_id,conversation_id) REFERENCES conversations(export_id,id));
        CREATE TABLE blobs(export_id TEXT NOT NULL REFERENCES imports(export_id),id TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(export_id,id));
        CREATE INDEX conversation_order ON conversations(export_id,ordinal);
        PRAGMA user_version=1;`));
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function requireImport(db, exportId, includeInactive = false) {
  identifier(exportId);
  const row = db.prepare("SELECT * FROM imports WHERE export_id=?").get(exportId);
  if (!row || !includeInactive && row.state !== "active") throw fail("HISTORY_NOT_FOUND", "No active import has that identity");
  return row;
}
function importOfflineHistory({ dataRoot, exportFile, fromAo = false }) {
  if (typeof exportFile !== "string" || !path.isAbsolute(exportFile) || path.extname(exportFile).toLowerCase() !== ".json") throw fail("HISTORY_EXPORT_REQUIRED", "Choose an absolute offline JSON export path, not a database");
  if (!fs.lstatSync(exportFile).isFile() || path.extname(fs.realpathSync(exportFile)).toLowerCase() !== ".json") throw fail("HISTORY_EXPORT_REQUIRED", "Offline export must be a regular JSON file, not a link");
  const handle = fs.openSync(exportFile, "r");
  let parsed;
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.nlink !== 1) throw fail("HISTORY_EXPORT_REQUIRED", "Offline export must be an unlinked regular JSON file");
    if (info.size > MAX_EXPORT_BYTES) throw fail("HISTORY_LIMIT", "Offline export exceeds the byte limit");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0, count;
    while (offset < bytes.length && (count = fs.readSync(handle, bytes, offset, bytes.length - offset, null)) > 0) offset += count;
    const after = fs.fstatSync(handle);
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1) {
      throw fail("HISTORY_CHANGED", "Offline export changed while it was read");
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { fs.closeSync(handle); }
  const checked = validateExport(fromAo === true ? convertAoHistory(parsed) : parsed), value = checked.value;
  const db = openArchive(dataRoot, true, true);
  try {
    return transaction(db, () => {
      const previous = db.prepare("SELECT * FROM imports WHERE export_id=?").get(value.exportId);
      if (previous && previous.digest !== checked.digest) throw fail("HISTORY_CONFLICT", "Export identity belongs to different content");
      const at = new Date().toISOString();
      if (previous) {
        if (previous.state !== "active") db.prepare("UPDATE imports SET state='active',updated_at=? WHERE export_id=?").run(at, value.exportId);
        return { exportId: value.exportId, digest: checked.digest, state: "active", duplicate: true, reactivated: previous.state !== "active" };
      }
      for (const conversation of value.conversations) {
        if (db.prepare("SELECT 1 FROM conversations WHERE engine=? AND id=?").get(conversation.engine, conversation.id)) throw fail("HISTORY_CONFLICT", "Conversation identity is already retained by another import");
      }
      db.prepare("INSERT INTO imports VALUES(?,?,'active',?,?)").run(value.exportId, checked.digest, at, at);
      const addConversation = db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?)");
      const addEvent = db.prepare("INSERT INTO events VALUES(?,?,?,?,?)");
      value.conversations.forEach((conversation, ordinal) => {
        addConversation.run(value.exportId, conversation.id, ordinal, conversation.workspaceId, conversation.engine, conversation.name, conversation.state);
        for (const event of conversation.events) addEvent.run(value.exportId, conversation.id, event.id, event.sequence, JSON.stringify(event));
      });
      const addBlob = db.prepare("INSERT INTO blobs VALUES(?,?,?,?,?)");
      for (const blob of value.blobs) addBlob.run(value.exportId, blob.id, blob.mediaType, blob.sha256, Buffer.from(blob.dataBase64, "base64"));
      return { exportId: value.exportId, digest: checked.digest, state: "active", duplicate: false, conversations: value.conversations.length, events: checked.eventCount };
    });
  } finally { db.close(); }
}
function rollbackOfflineHistory({ dataRoot, exportId }) {
  const db = openArchive(dataRoot, true);
  try { return transaction(db, () => {
    const previous = requireImport(db, exportId, true);
    if (previous.state !== "inactive") db.prepare("UPDATE imports SET state='inactive',updated_at=? WHERE export_id=?").run(new Date().toISOString(), exportId);
    return { exportId, digest: previous.digest, state: "inactive", retained: true };
  }); } finally { db.close(); }
}
function readOfflineHistory({ dataRoot, exportId, conversationId, after = -1, limit = 50, includeInactive = false }) {
  if (!Number.isSafeInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw fail("HISTORY_CURSOR", "Invalid bounded history page");
  const db = openArchive(dataRoot, false);
  try {
    requireImport(db, exportId, includeInactive === true);
    let rows;
    if (conversationId !== undefined) {
      conversationIdentity(conversationId);
      if (!db.prepare("SELECT 1 FROM conversations WHERE export_id=? AND id=?").get(exportId, conversationId)) throw fail("HISTORY_NOT_FOUND", "Conversation is not in this import");
      rows = db.prepare("SELECT sequence AS cursor,body FROM events WHERE export_id=? AND conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(exportId, conversationId, after, limit + 1);
    } else rows = db.prepare("SELECT ordinal AS cursor,id,workspace_id AS workspaceId,engine,name,state FROM conversations WHERE export_id=? AND ordinal>? ORDER BY ordinal LIMIT ?").all(exportId, after, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { items: rows.map(row => row.body === undefined ? row : JSON.parse(row.body)), cursor: rows.at(-1)?.cursor ?? after, hasMore };
  } finally { db.close(); }
}
function exportOfflineHistory({ dataRoot, exportId, includeInactive = false }) {
  const db = openArchive(dataRoot, false);
  try {
    const receipt = requireImport(db, exportId, includeInactive === true);
    const conversations = db.prepare("SELECT id,workspace_id AS workspaceId,engine,name,state FROM conversations WHERE export_id=? ORDER BY ordinal").all(exportId);
    for (const conversation of conversations) conversation.events = db.prepare("SELECT body FROM events WHERE export_id=? AND conversation_id=? ORDER BY sequence").all(exportId, conversation.id).map(row => JSON.parse(row.body));
    const blobs = db.prepare("SELECT id,media_type AS mediaType,sha256,bytes FROM blobs WHERE export_id=? ORDER BY rowid").all(exportId).map(({ bytes, ...blob }) => ({ ...blob, dataBase64: Buffer.from(bytes).toString("base64") }));
    const checked = validateExport({ format: FORMAT, schemaVersion: 1, exportId, conversations, blobs });
    if (checked.digest !== receipt.digest) throw fail("HISTORY_CORRUPT", "Archive content does not match its import receipt");
    return checked.value;
  } finally { db.close(); }
}

module.exports = { importOfflineHistory, rollbackOfflineHistory, readOfflineHistory, exportOfflineHistory };
