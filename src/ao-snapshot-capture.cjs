"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AO_PIN, AO_FORMAT, convertAoHistory } = require("./ao-history-export.cjs");
const { validateExport } = require("./offline-history.cjs");

const MAX_CAPTURE = 16 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const PAGE_LIMIT = 80;
const MAX_PAGES = 200;
const ID = /^[\w-]{1,128}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

function snapshotPage({ port, token, sessionId, beforeSequence, maxBytes, signal }) {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT), trimLargeFields: "0" });
  if (beforeSequence !== null) query.set("beforeSequence", String(beforeSequence));
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, agent: false, signal,
      path: `/api/v1/sessions/${sessionId}/conversation?${query}`, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, res => {
      const read = async () => {
        if (res.statusCode !== 200 || res.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          throw fail("HISTORY_CAPTURE_REFUSED", "The isolated AO endpoint did not return a JSON snapshot");
        }
        if (Number(res.headers["content-length"]) > maxBytes) throw fail("HISTORY_LIMIT", "The AO page exceeds the capture budget");
        const chunks = [];
        let bytes = 0;
        for await (const chunk of res) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw fail("HISTORY_LIMIT", "The AO page exceeds the capture budget");
          chunks.push(chunk);
        }
        try {
          const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
          return { snapshot, bytes };
        } catch { throw fail("HISTORY_AO_INVALID", "AO returned a malformed snapshot page"); }
      };
      read().then(resolve, error => { res.destroy(); reject(error); });
    });
    req.once("error", () => reject(fail("HISTORY_CAPTURE_UNAVAILABLE", "The isolated AO snapshot could not be read")));
  });
}

async function publishNew(file, bytes) {
  const pending = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(pending, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.link(pending, file);
  } catch {
    throw fail("HISTORY_CAPTURE_WRITE_FAILED", "Could not create the new export; existing files were not replaced");
  } finally { await fs.unlink(pending); }
}

async function captureAoHistory({ origin, sourceCommit, sessionId, workspaceId, exportId, file, token } = {}) {
  const endpoint = typeof origin === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin);
  if (!endpoint || Number(endpoint[1]) > 65535 || sourceCommit !== AO_PIN
    || ![sessionId, workspaceId, exportId].every(value => typeof value === "string" && ID.test(value))
    || typeof token !== "string" || !/^[!-~]{1,4096}$/.test(token)
    || typeof file !== "string" || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".json") {
    throw fail("HISTORY_CAPTURE_USAGE", "Provide the pinned revision, an explicit authorized AO loopback endpoint, one session, and a new absolute JSON path");
  }
  try { await fs.lstat(file); throw fail("HISTORY_CAPTURE_EXISTS", "The export path already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const total = AbortSignal.timeout(120000);
  const pages = [];
  let remaining = MAX_CAPTURE, beforeSequence = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { snapshot, bytes } = await snapshotPage({ port: Number(endpoint[1]), token, sessionId, beforeSequence,
      maxBytes: Math.min(MAX_PAGE, remaining), signal: AbortSignal.any([total, AbortSignal.timeout(10000)]) });
    remaining -= bytes;
    if (snapshot?.sessionId !== sessionId || snapshot.controller !== "stopped" || snapshot.mode !== "chat"
      || typeof snapshot.hasMoreBefore !== "boolean" || !Number.isSafeInteger(snapshot.oldestSequence) || snapshot.oldestSequence < 1
      || (beforeSequence !== null && snapshot.oldestSequence >= beforeSequence)) throw fail("HISTORY_AO_INCOMPLETE", "The captured session or page cursor did not match a finished AO chat");
    pages.push({ beforeSequence, snapshot });
    if (!snapshot.hasMoreBefore) break;
    beforeSequence = snapshot.oldestSequence;
  }
  const capture = { format: AO_FORMAT, schemaVersion: 1, sourceCommit, exportId, trimLargeFields: false, conversations: [{ workspaceId, pages }], blobs: [] };
  const checked = validateExport(convertAoHistory(capture));
  const data = JSON.stringify(capture) + "\n";
  if (Buffer.byteLength(data) > MAX_CAPTURE) throw fail("HISTORY_LIMIT", "The AO capture exceeds the archive limit");
  await publishNew(file, data);
  return { ok: true, pages: pages.length, events: checked.eventCount, digest: checked.digest };
}

module.exports = { captureAoHistory };
