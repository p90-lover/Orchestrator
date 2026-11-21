"use strict";

const { isDeepStrictEqual } = require("node:util");

const AO_PIN = "5e7875d476da8119419dbf3b3e6a51568a5d6a90";
const AO_FORMAT = "ao-conversation-pages";
const FINISHED_TURNS = new Set(["completed", "recovered", "interrupted", "failed", "cancelled"]);
const FINISHED_ACTIVITIES = new Set(["completed", "recovered", "failed", "cancelled", "resolved"]);
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => failure("HISTORY_AO_INVALID", message);
const missing = message => failure("HISTORY_AO_INCOMPLETE", message);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const sequence = value => Number.isSafeInteger(value) && value > 0;

function convertAoHistory(value) {
  if (!record(value) || value.format !== AO_FORMAT || value.schemaVersion !== 1 || value.sourceCommit !== AO_PIN) {
    throw failure("HISTORY_SCHEMA_UNSUPPORTED", "Choose an offline AO snapshot capture from the supported source revision");
  }
  if (!only(value, ["format", "schemaVersion", "sourceCommit", "exportId", "trimLargeFields", "conversations", "blobs"])
    || !id(value.exportId) || value.trimLargeFields !== false || !Array.isArray(value.conversations) || value.conversations.length < 1
    || value.conversations.length > 500 || !Array.isArray(value.blobs) || value.blobs.length > 1000) {
    throw invalid("Choose a bounded, untrimmed AO capture with an export ID");
  }
  const aliases = new Map();
  const blobs = value.blobs.map(blob => {
    if (!record(blob) || typeof blob.uri !== "string" || !blob.uri || blob.uri.length > 4096 || aliases.has(blob.uri)) throw invalid("AO blob references must be unique");
    const { uri, ...bytes } = blob;
    aliases.set(uri, bytes.id);
    return bytes;
  });
  let events = 0;
  const conversations = value.conversations.map(conversation => {
    if (!only(conversation, ["workspaceId", "pages"])) throw invalid("Invalid AO conversation record");
    const { workspaceId, pages } = conversation;
    if (!id(workspaceId) || !Array.isArray(pages) || !pages.length || pages.length > 200) throw invalid("AO capture needs a workspace and a bounded page chain");
    let before = null, metadata, turnIds, state;
    const result = [];
    for (const [index, page] of pages.entries()) {
      if (!only(page, ["beforeSequence", "snapshot"]) || !record(page.snapshot) || page.beforeSequence !== before) throw missing("AO snapshot cursor chain is incomplete");
      const { turns, messages, activities, hasMoreBefore, oldestSequence, ...identity } = page.snapshot;
      if (!id(identity.conversationId) || !id(identity.sessionId) || identity.mode !== "chat" || identity.controller !== "stopped"
        || !sequence(identity.latestSequence) || typeof hasMoreBefore !== "boolean" || !sequence(oldestSequence)
        || !Array.isArray(turns) || !turns.length || !Array.isArray(messages) || !Array.isArray(activities)) {
        throw invalid("Only complete snapshots of stopped AO chats may be imported");
      }
      if (identity.branchedFromEarlierMessage || identity.branchPoints?.length || identity.threadState?.status === "active" || identity.threadState?.waitingOn?.length
        || turns.some(turn => !record(turn) || !id(turn.id) || !FINISHED_TURNS.has(turn.state) || turn.rolledBack)) {
        throw missing("AO capture contains branched history, active work or a turn not visible in the snapshot");
      }
      if (index === 0) {
        metadata = { ...identity, turns };
        turnIds = new Set(turns.map(turn => turn.id));
        if (turnIds.size !== turns.length) throw invalid("AO turn identities must be unique");
        const last = turns.at(-1).state;
        state = last === "failed" ? "failed" : ["cancelled", "interrupted"].includes(last) ? "cancelled" : "completed";
      } else if (!isDeepStrictEqual({ ...identity, turns }, metadata)) throw missing("The AO chat changed between capture pages");
      if ((!hasMoreBefore) !== (index === pages.length - 1)) throw missing("AO capture does not end at the oldest page");
      const rows = [];
      for (const [kind, entries] of [["message", messages], ["activity", activities]]) {
        for (const row of entries) {
          if (!record(row) || row.kind !== kind || !id(row.id) || !sequence(row.sequence) || (row.turnId && !turnIds.has(row.turnId))) {
            throw invalid("AO snapshot has an invalid timeline identity");
          }
          if (kind === "message" && (typeof row.text !== "string" || !["user", "assistant"].includes(row.role) || row.streaming !== false)
            || kind === "activity" && (typeof row.activityKind !== "string" || !/^[a-z][a-z0-9_]{0,60}$/.test(row.activityKind)
              || !FINISHED_ACTIVITIES.has(row.status) || row.detail?.outputTruncated || row.detail?.outputMayBePartial)) {
            throw missing("AO capture has unfinished or truncated timeline data");
          }
          if (row.content !== undefined && !Array.isArray(row.content)) throw invalid("AO message content is not a list");
          const refs = new Set();
          for (const part of row.content ?? []) {
            if (!record(part) || typeof part.type !== "string") throw invalid("Invalid AO message content");
            if (part.type === "text" && !part.uri) continue;
            if (!aliases.has(part.uri)) throw missing("The offline capture is missing a referenced AO blob");
            refs.add(aliases.get(part.uri));
          }
          rows.push({ id: row.id, sequence: row.sequence, type: `ao.${kind}.${kind === "message" ? row.role : row.activityKind}`,
            data: row, ...(refs.size ? { blobIds: [...refs] } : {}) });
          if (++events > 10000 || result.length + rows.length >= 2000) throw failure("HISTORY_LIMIT", "AO capture exceeds the bounded archive limits");
        }
      }
      rows.sort((a, b) => a.sequence - b.sequence);
      if (rows[0]?.sequence !== oldestSequence || (before === null ? rows.at(-1)?.sequence !== identity.latestSequence
        : rows.at(-1)?.sequence >= before)) throw missing("AO snapshot page does not match its cursor bounds");
      result.push(...rows);
      before = oldestSequence;
    }
    result.sort((a, b) => a.sequence - b.sequence);
    return { id: metadata.conversationId, workspaceId, engine: "legacy-ao", name: metadata.title ?? "", state,
      events: [{ id: "ao-snapshot-metadata", sequence: 0, type: "ao.snapshot", data: { ...metadata, sourceCommit: AO_PIN } }, ...result] };
  });
  return { format: "orchestrator-finished-history", schemaVersion: 1, exportId: value.exportId, conversations, blobs };
}

module.exports = { AO_PIN, AO_FORMAT, convertAoHistory };
