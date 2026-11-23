"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { sessionConfig } = require("./session-config.cjs");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const VALID_SETTLE_STATES = new Set(["completed", "failed", "cancelled", "unknown"]);
const MAX_TEXT = 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_PAGE_BYTES = 256 * 1024;
const MAX_STEERS_PER_SESSION = 256;
const STEER_RESULTS = new Set(["accepted", "not_sent", "unknown"]);
const WAL_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_RETRY_MS = 250;
const STORE_BUSY_TIMEOUT_MS = 1000;
let db;
let owner;
let walPath, walBudget, nextCheckpoint = 0, writeRefusal = null;
const fail = (code, message) => Object.assign(new Error(message), { code });
function reportError(error) {
  if (!error.code?.startsWith("ERR_SQLITE")) return { code: error.code ?? "STORE_ERROR", message: error.message };
  if (error.errcode === 13) return { code: "STORE_FULL", message: "Native storage is full; existing work was kept" };
  return { code: error.code, message: "Native storage operation failed" };
}
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
function requireWritable() { if (writeRefusal) throw writeRefusal; }
const run = (sql, ...values) => { requireWritable(); return db.prepare(sql).run(...values); };
const sessionValue = row => row ? { ...row, config: sessionConfig(JSON.parse(row.config ?? "{}")) } : row;
const session = id => sessionValue(query("SELECT * FROM sessions WHERE id=?", identifier(id)));
const turn = (sessionId, turnId) => query("SELECT * FROM turns WHERE session_id=? AND id=?", identifier(sessionId), identifier(turnId));
function requireSession(id) {
  const value = session(id);
  if (!value) throw fail("SESSION_NOT_FOUND", "Session does not exist");
  return value;
}
function event(sessionId, turnId, type, payload = {}) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw fail("EVENT_TOO_LARGE", "Event exceeds its limit");
  const result = run("INSERT INTO events(session_id,turn_id,type,payload,created_at) VALUES(?,?,?,?,?)", sessionId, turnId, type, body, stamp());
  return Number(result.lastInsertRowid);
}
function walWriteRefusal(settlement) {
  const walBytes = () => fs.statSync(walPath, { throwIfNoEntry: false })?.size ?? 0;
  try {
    let size = walBytes();
    if (size >= walBudget && performance.now() >= nextCheckpoint) {
      nextCheckpoint = performance.now() + CHECKPOINT_RETRY_MS;
      // A pinned reader must not make the only storage worker wait for a checkpoint lock.
      db.exec("PRAGMA busy_timeout=0");
      try { if (query("PRAGMA wal_checkpoint(TRUNCATE)").busy === 0) nextCheckpoint = 0; }
      finally { db.exec(`PRAGMA busy_timeout=${STORE_BUSY_TIMEOUT_MS}`); }
      size = walBytes();
    }
    // Admission is checked before a transaction. Terminal writes get a separate bounded reserve.
    if (size >= walBudget * (settlement ? 2 : 1)) {
      return fail("STORE_WAL_BUSY", "Native storage maintenance is blocked; existing work was kept");
    }
    return null;
  } catch (error) {
    return error.code?.startsWith("ERR_SQLITE") ? error
      : fail("STORE_WAL_UNAVAILABLE", "Native storage maintenance could not be verified; existing work was kept");
  }
}
function transaction(work, { settlement = false } = {}) {
  const refusal = walWriteRefusal(settlement);
  db.exec("BEGIN IMMEDIATE");
  writeRefusal = refusal;
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* SQLite can already have rolled back on a full disk. */ }
    throw error;
  } finally { writeRefusal = null; }
}
function settleSession(id) {
  const unresolved = query("SELECT state FROM turns WHERE session_id=? AND state IN ('running','unknown','queued') ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, ordinal LIMIT 1", id);
  run("UPDATE sessions SET state=?,updated_at=? WHERE id=?", unresolved?.state === "unknown" ? "unknown" : unresolved ? "working" : "idle", stamp(), id);
}

function createSessionRecord({ id = randomUUID(), workspaceId, harness, root, name = "", config = {} }) {
  identifier(id); identifier(workspaceId); identifier(harness); text(root, 4096); text(name, 200);
  if (!path.isAbsolute(root)) throw fail("INVALID_ROOT", "Session root must be absolute");
  const options = JSON.stringify(sessionConfig(config));
  const previous = session(id);
  if (previous) {
    if (previous.workspace_id !== workspaceId || previous.harness !== harness || previous.root !== root || previous.name !== name
      || JSON.stringify(previous.config) !== options) throw fail("IDEMPOTENCY_CONFLICT", "Session identity belongs to another launch");
    return { ...previous, duplicate: true };
  }
  const at = stamp();
  run("INSERT INTO sessions(id,workspace_id,harness,root,name,state,created_at,updated_at,config) VALUES(?,?,?,?,?,'idle',?,?,?)", id, workspaceId, harness, root, name, at, at, options);
  event(id, null, "session.created");
  return session(id);
}
function enqueueTurnRecord({ id, prompt, clientMessageId, capacity = 32 }) {
  identifier(clientMessageId); text(prompt);
  if (!prompt.trim()) throw fail("INVALID_INPUT", "Message must not be empty");
  const digest = createHash("sha256").update(prompt).digest("hex");
  const current = requireSession(id);
  if (current.state === "closed") throw fail("SESSION_CLOSED", "Session has ended");
  const previous = query("SELECT * FROM turns WHERE session_id=? AND client_id=?", id, clientMessageId);
  if (previous) {
    if (previous.digest !== digest) throw fail("IDEMPOTENCY_CONFLICT", "Client message ID belongs to different input");
    return { ...previous, duplicate: true };
  }
  const steer = query("SELECT state,digest FROM steers WHERE session_id=? AND client_id=?", id, clientMessageId);
  if (steer && (steer.state !== "not_sent" || steer.digest !== digest)) {
    throw fail("IDEMPOTENCY_CONFLICT", "This input belongs to a steer and cannot be sent as a new turn");
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw fail("INVALID_CAPACITY", "Queue capacity must be 1-100");
  const queued = query("SELECT COUNT(*) AS count FROM turns WHERE session_id=? AND state IN ('queued','running','unknown')", id).count;
  if (queued >= capacity) throw fail("QUEUE_FULL", "Session queue is full");
  const turnId = randomUUID(), at = stamp();
  run("INSERT INTO turns(id,session_id,client_id,digest,prompt,state,answer,error,created_at,updated_at) VALUES(?,?,?,?,?,'queued','','',?,?)", turnId, id, clientMessageId, digest, prompt, at, at);
  settleSession(id);
  event(id, turnId, "turn.accepted");
  return { ...turn(id, turnId), startsQueue: queued === 0 };
}

const operations = {
  create(args) { return transaction(() => createSessionRecord(args)); },
  launch({ session: options, prompt, capacity }) {
    return transaction(() => {
      const { id } = createSessionRecord(options);
      const accepted = enqueueTurnRecord({ id, prompt, clientMessageId: "initial", capacity });
      return { sessionId: id, turnId: accepted.id, state: accepted.state, duplicate: accepted.duplicate === true, startsQueue: accepted.startsQueue === true };
    });
  },
  get({ id }) { return requireSession(id); },
  list({ after = "", limit = 50 } = {}) {
    text(after, 128);
    return db.prepare("SELECT * FROM sessions WHERE id>? ORDER BY id LIMIT ?").all(after, pageSize(limit)).map(sessionValue);
  },
  enqueue(args) { return transaction(() => enqueueTurnRecord(args)); },
  reserveSteer({ id, turnId, prompt, clientMessageId }) {
    identifier(clientMessageId); text(prompt, 32768);
    if (!prompt.trim()) throw fail("INVALID_INPUT", "Message must not be empty");
    const digest = createHash("sha256").update(prompt).digest("hex");
    return transaction(() => {
      const current = turn(id, turnId);
      if (!current) throw fail("TURN_NOT_FOUND", "Turn does not belong to this session");
      const previous = query("SELECT digest,turn_id,state FROM steers WHERE session_id=? AND client_id=?", id, clientMessageId);
      if (previous) {
        if (previous.digest !== digest || previous.turn_id !== turnId) throw fail("IDEMPOTENCY_CONFLICT", "The steer ID belongs to a different input or turn");
        return { state: previous.state, duplicate: true };
      }
      if (current.state !== "running") return { state: "not_sent" };
      if (query("SELECT 1 FROM turns WHERE session_id=? AND client_id=?", id, clientMessageId)) {
        throw fail("IDEMPOTENCY_CONFLICT", "This input already belongs to an accepted turn");
      }
      const count = query("SELECT COUNT(*) AS count FROM steers WHERE session_id=?", id).count;
      if (count >= MAX_STEERS_PER_SESSION) throw fail("STEER_LIMIT", "This session cannot store more steer receipts");
      run("INSERT INTO steers(session_id,client_id,turn_id,digest,prompt,state) VALUES(?,?,?,?,?,'dispatching')", id, clientMessageId, turnId, digest, prompt);
      return { state: "dispatching" };
    });
  },
  readSendReceipt({ id, requestId, workspaceId }) {
    const accepted = query(`SELECT turn.id FROM turns AS turn JOIN sessions AS session ON turn.session_id=session.id
      WHERE turn.session_id=? AND turn.client_id=? AND session.workspace_id=?`, identifier(id), identifier(requestId), identifier(workspaceId));
    return accepted ? { workspaceId, sessionId: id, requestId, turnId: accepted.id } : null;
  },
  readSteerReceipt({ id, turnId, clientMessageId, workspaceId }) {
    const row = query(`SELECT 1 FROM steers AS receipt JOIN sessions AS session ON session.id=receipt.session_id
      WHERE receipt.session_id=? AND receipt.turn_id=? AND receipt.client_id=? AND session.workspace_id=? AND receipt.state='accepted'`,
    identifier(id), identifier(turnId), identifier(clientMessageId), identifier(workspaceId));
    return row ? { state: "accepted", sessionId: id, turnId, inputId: clientMessageId, workspaceId } : null;
  },
  finishSteer({ id, turnId, clientMessageId, state }) {
    identifier(clientMessageId);
    if (!STEER_RESULTS.has(state)) throw fail("INVALID_STATE", "Invalid steer outcome");
    return transaction(() => {
      const row = query("SELECT turn_id,state,prompt FROM steers WHERE session_id=? AND client_id=?", identifier(id), clientMessageId);
      if (!row || row.turn_id !== turnId || row.state !== "dispatching") throw fail("STEER_RECEIPT_CONFLICT", "There is no matching unsettled steer");
      run("UPDATE steers SET state=? WHERE session_id=? AND client_id=?", state, id, clientMessageId);
      if (state === "accepted") event(id, turnId, "steer.accepted", { clientMessageId, text: row.prompt });
      return { state };
    }, { settlement: true });
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
  settle({ id, turnId, state, error = "", expectedState }) {
    if (!VALID_SETTLE_STATES.has(state)) throw fail("INVALID_STATE", "Invalid terminal state");
    text(error, 2000);
    return transaction(() => {
      const current = turn(id, turnId);
      if (!current) throw fail("TURN_NOT_FOUND", "Turn does not exist");
      if (TERMINAL.has(current.state)) return current;
      if (current.state === "unknown" || (expectedState !== undefined && current.state !== expectedState)) {
        throw fail("TURN_OWNERSHIP_UNCONFIRMED", "The original turn outcome must be confirmed before changing its state");
      }
      if (state !== "cancelled" && current.state !== "running") throw fail("INVALID_TRANSITION", "Only a running turn can complete or fail");
      run("UPDATE turns SET state=?,error=?,updated_at=? WHERE id=?", state, error, stamp(), turnId);
      settleSession(id);
      event(id, turnId, `turn.${state}`, { error });
      return turn(id, turnId);
    }, { settlement: true });
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
    const count = pageSize(limit), items = [];
    const rows = db.prepare("SELECT sequence,turn_id AS turnId,type,payload,created_at AS createdAt FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?");
    let bytes = 0, hasMore = false;
    for (const row of rows.iterate(id, after, count + 1)) {
      const size = Buffer.byteLength(row.payload);
      if (size > MAX_EVENT_BYTES) throw fail("EVENT_TOO_LARGE", "Stored event exceeds its supported size");
      if (items.length === count || bytes + size > MAX_EVENT_PAGE_BYTES) { hasMore = true; break; }
      bytes += size;
      items.push({ ...row, payload: JSON.parse(row.payload) });
    }
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore };
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
  const { dataRoot: root, maxDatabaseBytes } = workerData;
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("INVALID_DATA_ROOT", "Native store requires an explicit absolute data directory");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // A separate SQLite lock is released by the OS after a crash; holding it does
  // not keep the product database in an uncommitted transaction.
  owner = new DatabaseSync(path.join(root, "coordinator-owner.sqlite"));
  try { owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { throw fail("STORE_IN_USE", "Another coordinator owns this data directory"); }
  const file = path.join(root, "orchestrator.sqlite");
  db = new DatabaseSync(file);
  walPath = `${file}-wal`;
  walBudget = Math.min(maxDatabaseBytes, WAL_HIGH_WATER_BYTES);
  let version;
  try {
    const row = query("PRAGMA user_version");
    if (!row || typeof row.user_version !== "number") {
      throw fail("DATABASE_CORRUPT", "Database header is invalid");
    }
    version = row.user_version;
    if ([1, 2, 3].includes(version)) {
      db.prepare("SELECT id,workspace_id,harness,root,name,state,created_at,updated_at FROM sessions LIMIT 0").all();
      db.prepare("SELECT ordinal,id,session_id,client_id,digest,prompt,state,answer,error,created_at,updated_at FROM turns LIMIT 0").all();
      db.prepare("SELECT sequence,session_id,turn_id,type,payload,created_at FROM events LIMIT 0").all();
      if (version >= 2) db.prepare("SELECT config FROM sessions LIMIT 0").all();
      if (version >= 3) db.prepare("SELECT session_id,client_id,turn_id,digest,prompt,state FROM steers LIMIT 0").all();
    }
  } catch (err) {
    if (err.code === "DATABASE_CORRUPT") throw err;
    throw fail("DATABASE_CORRUPT", `Database header or schema check failed: ${err.message}`);
  }
  if (![0, 1, 2, 3].includes(version)) throw fail("SCHEMA_UNSUPPORTED", "Native store schema is newer than this runtime");
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=${STORE_BUSY_TIMEOUT_MS}; PRAGMA journal_size_limit=${walBudget}; PRAGMA wal_autocheckpoint=0`);
  const maxPages = Math.floor(maxDatabaseBytes / query("PRAGMA page_size").page_size);
  db.exec(`PRAGMA max_page_count=${maxPages}`);
  if (version === 0) transaction(() => {
    requireWritable();
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,harness TEXT NOT NULL,root TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE turns(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES sessions(id),client_id TEXT NOT NULL,digest TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,answer TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,client_id));
      CREATE INDEX turn_queue ON turns(session_id,state,ordinal);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),turn_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX session_events ON events(session_id,sequence); PRAGMA user_version=1;`);
  });
  if (version < 2) transaction(() => {
    requireWritable();
    db.exec("ALTER TABLE sessions ADD COLUMN config TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=2;");
  });
  if (version < 3) transaction(() => {
    requireWritable();
    db.exec(`CREATE TABLE steers(
      session_id TEXT NOT NULL REFERENCES sessions(id), client_id TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES turns(id), digest TEXT NOT NULL, prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','unknown','not_sent')),
      PRIMARY KEY(session_id,client_id)); PRAGMA user_version=3;`);
  });
  transaction(() => {
    if (query("SELECT 1 FROM steers WHERE state='dispatching' LIMIT 1")) run("UPDATE steers SET state='unknown' WHERE state='dispatching'");
    const running = db.prepare("SELECT id,session_id FROM turns WHERE state='running'").all();
    const touchedSessions = new Set();
    for (const item of running) {
      run("UPDATE turns SET state='unknown',error='Coordinator stopped before outcome was confirmed',updated_at=? WHERE id=?", stamp(), item.id);
      event(item.session_id, item.id, "turn.unknown");
      touchedSessions.add(item.session_id);
    }
    for (const sessionId of touchedSessions) {
      settleSession(sessionId);
    }
  }, { settlement: true });
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
    } catch (error) { parentPort.postMessage({ requestId, error: reportError(error) }); }
  });
} catch (error) {
  try { db?.close(); } catch {}
  try { owner?.close(); } catch {}
  parentPort.postMessage({ startupError: reportError(error) });
  parentPort.close();
}
