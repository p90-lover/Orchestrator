"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { openNativeStore } = require("./native-store.cjs");

const failure = (code, message) => Object.assign(new Error(message), { code });

async function createNativeEngine({ dataRoot, drivers = {}, queueCapacity = 32, maxActiveSessions = 8 } = {}) {
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
      let writes = Promise.resolve();
      let outputFailure = null;
      const emitText = delta => {
        if (closed || slot.controller.signal.aborted || active.get(id) !== slot || slot.turn !== accepted) return Promise.reject(failure("TURN_NOT_RUNNING", "Output belongs to an inactive turn"));
        const write = writes.then(() => store.call("append", { id, turnId: accepted.id, delta }));
        writes = write.catch(error => { outputFailure ??= error; });
        write.then(() => notify(id), () => {});
        return write;
      };
      try {
        await driver.run({ session: { ...session }, turn: { ...accepted }, signal: slot.controller.signal, emitText });
        await writes;
        if (outputFailure) throw outputFailure;
        await store.call("settle", { id, turnId: accepted.id, state: slot.controller.signal.aborted ? "cancelled" : "completed" });
      } catch (error) {
        await writes;
        await store.call("settle", { id, turnId: accepted.id, state: slot.controller.signal.aborted ? "cancelled" : "failed",
          error: slot.controller.signal.aborted ? "" : outputFailure ? "Native output could not be persisted" : "Harness execution failed" });
      } finally { slot.turn = null; notify(id); }
    }
  }

  const engine = {
    capabilities() {
      return { engine: "orchestrator-native", schemaVersion: 1, productionReady: false,
        supported: ["sessions", "durable-turns", "deduplication", "queued-send", "text-output", "event-pages", "explicit-recovery", "cancellation"],
        missing: ["live-harness-parity", "tool-approvals", "input-questions", "steering", "compaction", "offline-AO-import", "Coding-Tools-cutover"],
        drivers: [...available.keys()] };
    },
    async createSession({ workspaceId, harness, root, name = "" }) {
      checkOpen();
      if (!available.has(harness)) throw failure("DRIVER_UNAVAILABLE", "Requested native driver is unavailable");
      if (typeof root !== "string" || !path.isAbsolute(root)) throw failure("INVALID_ROOT", "Workspace root must be absolute");
      return store.call("create", { id: randomUUID(), workspaceId, harness, root, name });
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
    async recover(id, turnId) {
      const value = await engine.observe(id, turnId);
      return { ...value, replayed: false, recovery: value.turnState === "unknown" ? "unresolved" : "observed" };
    },
    async cancel(id, turnId) {
      checkOpen();
      if (typeof turnId !== "string" || !turnId) throw failure("INVALID_ID", "Choose the exact turn to cancel");
      // Check ownership before signalling anything; a stale UI must not stop a
      // different turn merely because the same session now has new work.
      const { session, turn } = await store.call("observe", { id, turnId });
      const slot = active.get(id);
      if (slot?.turn?.id === turn.id) {
        slot.controller.abort();
        await available.get(session.harness).cancel({ sessionId: id, turnId });
        await slot.job;
      }
      const result = await store.call("settle", { id, turnId, state: "cancelled" });
      schedule(id);
      notify(id);
      return { turnId: result.id, state: result.state };
    },
    events(id, options = {}) { checkOpen(); return store.call("events", { ...options, id }); },
    sessions(options = {}) { checkOpen(); return store.call("list", options); },
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
