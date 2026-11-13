"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_TEXT = 1024 * 1024;
let db;
let owner;
const fail = (code, message) => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();
const text = (value, max = 65536) => {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) throw fail("INVALID_INPUT", "Invalid or oversized text");
  return value;
};
const identifier = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail("INVALID_ID", "Invalid identifier");
  return value;
};
const pageSize = value => Number.isInteger(value) && value > 0 && value <= 200 ? value : 50;
const query = (sql, ...values) => db.prepare(sql).get(...values);
const run = (sql, ...values) => db.prepare(sql).run(...values);
const session = id => query("SELECT * FROM sessions WHERE id=?", identifier(id));
const turn = (sessionId, turnId) => query("SELECT * FROM turns WHERE session_id=? AND id=?", identifier(sessionId), identifier(turnId));
function requireSession(id) {
  const value = session(id);
  if (!value) throw fail("SESSION_NOT_FOUND", "Session does not exist");
  return value;
}
function event(sessionId, turnId, type, payload = {}) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 65536) throw fail("EVENT_TOO_LARGE", "Event exceeds its limit");
  const result = run("INSERT INTO events(session_id,turn_id,type,payload,created_at) VALUES(?,?,?,?,?)", sessionId, turnId, type, body, stamp());
  return Number(result.lastInsertRowid);
}
function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function settleSession(id) {
  const unresolved = query("SELECT state FROM turns WHERE session_id=? AND state IN ('running','unknown','queued') ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, ordinal LIMIT 1", id);
  run("UPDATE sessions SET state=?,updated_at=? WHERE id=?", unresolved?.state === "unknown" ? "unknown" : unresolved ? "working" : "idle", stamp(), id);
}

const operations = {
  create({ id = randomUUID(), workspaceId, harness, root, name = "" }) {
    identifier(id); identifier(workspaceId); identifier(harness); text(root, 4096); text(name, 200);
    if (!path.isAbsolute(root)) throw fail("INVALID_ROOT", "Session root must be absolute");
    return transaction(() => {
      const at = stamp();
      run("INSERT INTO sessions(id,workspace_id,harness,root,name,state,created_at,updated_at) VALUES(?,?,?,?,?,'idle',?,?)", id, workspaceId, harness, root, name, at, at);
      event(id, null, "session.created");
      return session(id);
    });
  },
  get({ id }) { return requireSession(id); },
  list({ after = "", limit = 50 } = {}) {
    text(after, 128);
    return db.prepare("SELECT * FROM sessions WHERE id>? ORDER BY id LIMIT ?").all(after, pageSize(limit));
  },
  enqueue({ id, prompt, clientMessageId, capacity = 32 }) {
    identifier(clientMessageId); text(prompt);
    if (!prompt.trim()) throw fail("INVALID_INPUT", "Message must not be empty");
    const digest = createHash("sha256").update(prompt).digest("hex");
    return transaction(() => {
      const current = requireSession(id);
      if (current.state === "closed") throw fail("SESSION_CLOSED", "Session has ended");
      const previous = query("SELECT * FROM turns WHERE session_id=? AND client_id=?", id, clientMessageId);
      if (previous) {
        if (previous.digest !== digest) throw fail("IDEMPOTENCY_CONFLICT", "Client message ID belongs to different input");
        return { ...previous, duplicate: true };
      }
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw fail("INVALID_CAPACITY", "Queue capacity must be 1-100");
      const queued = query("SELECT COUNT(*) AS count FROM turns WHERE session_id=? AND state IN ('queued','running','unknown')", id).count;
      if (queued >= capacity) throw fail("QUEUE_FULL", "Session queue is full");
      const turnId = randomUUID(), at = stamp();
      run("INSERT INTO turns(id,session_id,client_id,digest,prompt,state,answer,error,created_at,updated_at) VALUES(?,?,?,?,?,'queued','','',?,?)", turnId, id, clientMessageId, digest, prompt, at, at);
      settleSession(id);
      event(id, turnId, "turn.accepted");
      return turn(id, turnId);
    });
  },
  claim({ id }) {
    return transaction(() => {
      const current = requireSession(id);
      if (current.state === "closed" || query("SELECT id FROM turns WHERE session_id=? AND state IN ('running','unknown') LIMIT 1", id)) return null;
      const next = query("SELECT * FROM turns WHERE session_id=? AND state='queued' ORDER BY ordinal LIMIT 1", id);
      if (!next) return null;
      const at = stamp();
      run("UPDATE turns SET state='running',updated_at=? WHERE id=?", at, next.id);
      settleSession(id);
      event(id, next.id, "turn.started");
      return turn(id, next.id);
    });
  },
  append({ id, turnId, delta }) {
    text(delta, 16384);
    return transaction(() => {
      const current = turn(id, turnId);
      if (!current) throw fail("TURN_NOT_FOUND", "Turn does not exist");
      if (current.state !== "running") throw fail("TURN_NOT_RUNNING", "Turn no longer accepts output");
      if (Buffer.byteLength(current.answer) + Buffer.byteLength(delta) > MAX_TEXT) throw fail("OUTPUT_LIMIT", "Turn output exceeds its limit");
      run("UPDATE turns SET answer=answer||?,updated_at=? WHERE id=?", delta, stamp(), turnId);
      return { sequence: event(id, turnId, "text.delta", { text: delta }) };
    });
  },
  settle({ id, turnId, state, error = "" }) {
    if (!TERMINAL.has(state)) throw fail("INVALID_STATE", "Invalid terminal state");
    text(error, 2000);
    return transaction(() => {
      const current = turn(id, turnId);
      if (!current) throw fail("TURN_NOT_FOUND", "Turn does not exist");
      if (TERMINAL.has(current.state)) return current;
      if (state !== "cancelled" && current.state !== "running") throw fail("INVALID_TRANSITION", "Only a running turn can complete or fail");
      run("UPDATE turns SET state=?,error=?,updated_at=? WHERE id=?", state, error, stamp(), turnId);
      settleSession(id);
      event(id, turnId, `turn.${state}`, { error });
      return turn(id, turnId);
    });
  },
  observe({ id, turnId = null }) {
    const current = requireSession(id);
    const selected = turnId ? turn(id, turnId) : query("SELECT * FROM turns WHERE session_id=? ORDER BY ordinal DESC LIMIT 1", id);
    if (turnId && !selected) throw fail("TURN_NOT_FOUND", "Turn does not belong to this session");
    return { session: current, turn: selected ?? null };
  },
  events({ id, after = 0, limit = 50 }) {
    requireSession(id);
    if (!Number.isSafeInteger(after) || after < 0) throw fail("INVALID_CURSOR", "Invalid event cursor");
    const items = db.prepare("SELECT sequence,turn_id AS turnId,type,payload,created_at AS createdAt FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(id, after, pageSize(limit) + 1);
    const hasMore = items.length > pageSize(limit);
    if (hasMore) items.pop();
    return { items: items.map(item => ({ ...item, payload: JSON.parse(item.payload) })), cursor: items.at(-1)?.sequence ?? after, hasMore };
  },
  closeSession({ id }) {
    return transaction(() => {
      requireSession(id);
      if (query("SELECT id FROM turns WHERE session_id=? AND state IN ('running','queued','unknown') LIMIT 1", id)) throw fail("SESSION_BUSY", "Cancel unresolved turns before closing a session");
      run("UPDATE sessions SET state='closed',updated_at=? WHERE id=?", stamp(), id);
      event(id, null, "session.closed");
      return { ok: true };
    });
  },
};

try {
  const root = workerData.dataRoot;
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("INVALID_DATA_ROOT", "Native store requires an explicit absolute data directory");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // A separate SQLite lock is released by the OS after a crash; holding it does
  // not keep the product database in an uncommitted transaction.
  owner = new DatabaseSync(path.join(root, "coordinator-owner.sqlite"));
  try { owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { throw fail("STORE_IN_USE", "Another coordinator owns this data directory"); }
  db = new DatabaseSync(path.join(root, "orchestrator.sqlite"));
  const version = query("PRAGMA user_version").user_version;
  if (![0, 1].includes(version)) throw fail("SCHEMA_UNSUPPORTED", "Native store schema is newer than this runtime");
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000");
  if (version === 0) transaction(() => {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,harness TEXT NOT NULL,root TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE turns(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES sessions(id),client_id TEXT NOT NULL,digest TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,answer TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,client_id));
      CREATE INDEX turn_queue ON turns(session_id,state,ordinal);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),turn_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX session_events ON events(session_id,sequence); PRAGMA user_version=1;`);
  });
  transaction(() => {
    const interrupted = db.prepare("SELECT id,session_id FROM turns WHERE state IN ('queued','running')").all();
    for (const item of interrupted) {
      run("UPDATE turns SET state='unknown',error='Coordinator stopped before outcome was confirmed',updated_at=? WHERE id=?", stamp(), item.id);
      event(item.session_id, item.id, "turn.unknown");
    }
    run("UPDATE sessions SET state='unknown' WHERE id IN (SELECT session_id FROM turns WHERE state='unknown')");
  });
  parentPort.postMessage({ ready: true });
  parentPort.on("message", ({ requestId, operation, args }) => {
    try {
      if (operation === "close") {
        db.close(); owner.close();
        parentPort.postMessage({ requestId, result: { ok: true } });
        parentPort.close();
        return;
      }
      if (!Object.hasOwn(operations, operation)) throw fail("UNKNOWN_OPERATION", "Unsupported store operation");
      parentPort.postMessage({ requestId, result: operations[operation](args ?? {}) });
    } catch (error) { parentPort.postMessage({ requestId, error: { code: error.code ?? "STORE_ERROR", message: error.code?.startsWith("ERR_SQLITE") ? "Native storage operation failed" : error.message } }); }
  });
} catch (error) {
  try { db?.close(); } catch {}
  try { owner?.close(); } catch {}
  parentPort.postMessage({ startupError: { code: error.code ?? "STORE_ERROR", message: error.message } });
  parentPort.close();
}
