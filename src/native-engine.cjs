"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { openNativeStore } = require("./native-store.cjs");
const { createTextBatcher } = require("./text-batcher.cjs");

const failure = (code, message) => Object.assign(new Error(message), { code });

async function createNativeEngine({ dataRoot, drivers = {}, queueCapacity = 32, maxActiveSessions = 8, flushDelayMs = 50 } = {}) {
  if (!Number.isInteger(maxActiveSessions) || maxActiveSessions < 1 || maxActiveSessions > 64) throw failure("INVALID_CAPACITY", "Invalid active session limit");
  const available = new Map(Object.entries(drivers));
  for (const [id, driver] of available) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || typeof driver?.run !== "function" || typeof driver?.cancel !== "function") throw failure("INVALID_DRIVER", "Drivers must implement run and cancel");
  }
  const store = await openNativeStore({ dataRoot });
  const active = new Map();
  const waiting = new Set();
  const jobs = new Set();
  const listeners = new Set();
  let closed = false, shuttingDown = null;

  function checkOpen() { if (closed) throw failure("ENGINE_CLOSED", "Native engine is closed"); }
  function notify(id) { for (const listener of listeners) { try { listener({ sessionId: id }); } catch {} } }
  function dispatch() {
    if (closed) return;
    while (active.size < maxActiveSessions && waiting.size) {
      const id = [...waiting].find(candidate => !active.has(candidate));
      if (id === undefined) break;
      waiting.delete(id);
      const slot = { controller: new AbortController(), turn: null, job: null };
      active.set(id, slot);
      const job = runSession(id, slot).catch(() => notify(id)).finally(() => {
        if (active.get(id) === slot) active.delete(id);
        jobs.delete(job);
        dispatch();
      });
      slot.job = job;
      jobs.add(job);
    }
  }
  function schedule(id) { if (!closed) { waiting.add(id); dispatch(); } }
  async function runSession(id, slot) {
    const session = await store.call("get", { id });
    const driver = available.get(session.harness);
    if (!driver) return;
    while (!closed && !slot.controller.signal.aborted) {
      const accepted = await store.call("claim", { id });
      if (!accepted) return;
      slot.turn = accepted;
      notify(id);
      if (closed || slot.controller.signal.aborted) {
        await store.call("settle", { id, turnId: accepted.id, state: "cancelled" });
        return;
      }
      let outputFailure = null;
      const batcher = createTextBatcher({
        onFlush: async combinedDelta => {
          if (closed || active.get(id) !== slot || slot.turn !== accepted) {
            throw failure("TURN_NOT_RUNNING", "Output belongs to an inactive turn");
          }
          const result = await store.call("append", { id, turnId: accepted.id, delta: combinedDelta });
          notify(id);
          return result;
        },
        delayMs: Math.min(Math.max(Number.isInteger(flushDelayMs) ? flushDelayMs : 50, 1), 100),
        maxBatchBytes: 16384,
        maxBufferedBytes: 65536,
      });
      const emitText = delta => {
        if (closed || slot.controller.signal.aborted || active.get(id) !== slot || slot.turn !== accepted) {
          return Promise.reject(failure("TURN_NOT_RUNNING", "Output belongs to an inactive turn"));
        }
        return batcher.append(delta).catch(error => {
          outputFailure ??= error;
          throw error;
        });
      };
      try {
        await driver.run({ session: { ...session }, turn: { ...accepted }, signal: slot.controller.signal, emitText });
        await batcher.flush();
        if (outputFailure) throw outputFailure;
        await slot.cancellation;
        await store.call("settle", { id, turnId: accepted.id, state: slot.controller.signal.aborted ? "cancelled" : "completed" });
      } catch (error) {
        await slot.cancellation;
        if (slot.controller.signal.aborted) {
          await batcher.flush().catch(() => {});
          await batcher.dispose();
          await store.call("settle", { id, turnId: accepted.id, state: "cancelled" });
        } else {
          await batcher.dispose();
          const isAmbiguous = Boolean(
            error?.uncertain ||
            error?.code === "UNCERTAIN" ||
            error?.code === "DRIVER_UNCERTAIN" ||
            error?.code === "TRANSPORT_ERROR" ||
            error?.ambiguous
          );
          if (isAmbiguous) {
            await store.call("settle", {
              id,
              turnId: accepted.id,
              state: "unknown",
              error: "Driver outcome is uncertain",
            });
          } else {
            await store.call("settle", {
              id,
              turnId: accepted.id,
              state: "failed",
              error: outputFailure ? "Native output could not be persisted" : "Harness execution failed",
            });
          }
        }
      } finally { slot.turn = null; slot.cancellation = null; notify(id); }
    }
  }

  const engine = {
    capabilities() {
      return { engine: "orchestrator-native", schemaVersion: 2, productionReady: false,
        supported: ["sessions", "durable-turns", "deduplication", "queued-send", "text-output", "event-pages", "explicit-recovery", "cancellation"],
        missing: ["live-harness-parity", "tool-approvals", "input-questions", "steering", "compaction", "offline-AO-import", "Coding-Tools-cutover"],
        drivers: [...available.keys()] };
    },
    async createSession({ id = randomUUID(), workspaceId, harness, root, name = "", config = {} }) {
      checkOpen();
      if (!available.has(harness)) throw failure("DRIVER_UNAVAILABLE", "Requested native driver is unavailable");
      if (typeof root !== "string" || !path.isAbsolute(root)) throw failure("INVALID_ROOT", "Workspace root must be absolute");
      return store.call("create", { id, workspaceId, harness, root, name, config });
    },
    async send(id, prompt, clientMessageId) {
      checkOpen();
      const accepted = await store.call("enqueue", { id, prompt, clientMessageId, capacity: queueCapacity });
      if (accepted.state === "queued") schedule(id);
      return { turnId: accepted.id, state: accepted.state, duplicate: accepted.duplicate === true };
    },
    async observe(id, turnId = null) {
      checkOpen();
      const value = await store.call("observe", { id, turnId });
      const selected = value.turn;
      return { sessionId: id, status: value.session.state, turnId: selected?.id ?? null, turnState: selected?.state ?? null,
        answer: selected?.answer ?? "", error: selected?.error || null, needsInput: false,
        recoveryRequired: value.session.state === "unknown", productionReady: false };
    },
    async recover(id, turnId = null) {
      checkOpen();
      const value = await engine.observe(id, turnId);
      if (value.status === "unknown" || value.recoveryRequired) {
        return { ...value, replayed: false, recovery: "unresolved" };
      }
      schedule(id);
      const isQueued = value.turnState === "queued";
      return { ...value, replayed: false, recovery: isQueued ? "scheduled" : "observed" };
    },
    async cancel(id, turnId) {
      checkOpen();
      if (typeof turnId !== "string" || !turnId) throw failure("INVALID_ID", "Choose the exact turn to cancel");
      // Check ownership before signalling anything; a stale UI must not stop a
      // different turn merely because the same session now has new work.
      const { session, turn } = await store.call("observe", { id, turnId });
      if (["completed", "failed", "cancelled"].includes(turn.state)) return { turnId, state: turn.state };
      const slot = active.get(id);
      if (turn.state === "unknown" || (turn.state === "running" && slot?.turn?.id !== turnId)) {
        throw failure("TURN_OWNERSHIP_UNCONFIRMED", "No verified owner can confirm this turn stopped; queued work was not started");
      }
      if (turn.state === "running") {
        slot.cancellation ??= Promise.resolve().then(async () => {
          try { await available.get(session.harness).cancel({ sessionId: id, turnId }); }
          catch { return false; }
          if (slot.turn?.id === turnId) slot.controller.abort();
          return true;
        });
        if (!await slot.cancellation) throw failure("TURN_OWNERSHIP_UNCONFIRMED", "The driver did not confirm the turn stopped");
        if (slot.turn?.id === turnId) await slot.job;
        return { turnId, state: (await store.call("observe", { id, turnId })).turn.state };
      }
      const result = await store.call("settle", { id, turnId, state: "cancelled", expectedState: "queued" });
      notify(id);
      return { turnId: result.id, state: result.state };
    },
    events(id, options = {}) { checkOpen(); return store.call("events", { ...options, id }); },
    sessions(options = {}) { checkOpen(); return store.call("list", options); },
    session(id) { checkOpen(); return store.call("get", { id }); },
    closeSession(id) { checkOpen(); return store.call("closeSession", { id }); },
    watch(listener) {
      checkOpen();
      if (typeof listener !== "function") throw failure("INVALID_LISTENER", "A listener function is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (shuttingDown) return shuttingDown;
      closed = true; waiting.clear(); listeners.clear();
      shuttingDown = (async () => {
        const cancellations = [];
        for (const [id, slot] of active) {
          slot.controller.abort();
          if (slot.turn) cancellations.push(store.call("get", { id }).then(session => available.get(session.harness).cancel({ sessionId: id, turnId: slot.turn.id })));
        }
        await Promise.allSettled(cancellations);
        await Promise.allSettled([...available.values()].map(driver => driver.close?.()));
        await Promise.allSettled([...jobs]);
        await store.close();
      })();
      return shuttingDown;
    },
  };
  return Object.freeze(engine);
}

module.exports = { createNativeEngine };
