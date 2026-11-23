"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { createNativeEngine } = require("./native-engine.cjs");
const { sessionConfig } = require("./session-config.cjs");
const { RUNTIME_METHODS, HARNESS_METHODS } = require("./orchestrator-handler.cjs");

const PREFIX = "native:";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const fail = (code, message) => Object.assign(new Error(message), { code });
const unsupported = capability => { throw fail("NATIVE_CAPABILITY_UNSUPPORTED", `Native Orchestrator does not yet support ${capability}`); };
function internalId(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.slice(PREFIX.length))) throw fail("NATIVE_SESSION_REQUIRED", "Choose a native session identity");
  return value.slice(PREFIX.length);
}
function externalId(value) { return PREFIX + value; }
const validWorkspace = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validLaunchRequest = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const launchSessionId = (workspaceId, requestId) => createHash("sha256").update(JSON.stringify([workspaceId, requestId])).digest("hex");

function createNativeRuntimeAdapter({ dataRoot, drivers, driverFactory = null, catalog = [], resolveWorkspace, createEngine = createNativeEngine } = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot) || typeof resolveWorkspace !== "function") throw fail("INVALID_NATIVE_HOST", "Native runtime needs explicit storage and a host workspace resolver");
  const descriptors = new Map();
  for (const row of catalog) {
    if (!row || typeof row.id !== "string" || !drivers?.[row.id] && typeof driverFactory !== "function" || descriptors.has(row.id)) throw fail("INVALID_NATIVE_HOST", "Native catalog must name unique configured drivers");
    descriptors.set(row.id, Object.freeze({ ...row, models: Object.freeze([...(row.models ?? [])]) }));
  }
  const listeners = new Set(), ownedSessions = new Set();
  let engine = null, starting = null, stopping = null, unwatch = null, lastError = null, liveDrivers = null, consumed = false;
  async function start() {
    if (stopping) throw fail("NATIVE_STOPPING", "Native runtime is stopping");
    if (engine) return snapshot();
    if (consumed && !driverFactory) throw fail("NATIVE_RESTART_REQUIRES_FACTORY", "Restart requires fresh host-owned driver instances");
    if (!starting) starting = (async () => {
      liveDrivers = driverFactory ? await driverFactory() : drivers;
      for (const id of descriptors.keys()) if (!liveDrivers?.[id]) throw fail("DRIVER_UNAVAILABLE", "Native driver factory did not provide the configured catalog");
      const opened = await createEngine({ dataRoot, drivers: liveDrivers });
      engine = opened;
      unwatch = opened.watch(event => {
        const change = { ...event, sessionId: externalId(event.sessionId), type: "conversation", engine: "orchestrator-native" };
        for (const listener of listeners) { try { listener(change); } catch {} }
      });
      lastError = null;
      return snapshot();
    })().catch(error => { lastError = error.code ?? "NATIVE_START_FAILED"; throw error; }).finally(() => { starting = null; });
    return starting;
  }
  const live = () => {
    if (!engine || stopping) throw fail("NATIVE_NOT_RUNNING", "Native runtime is not running; no work was restarted");
    return engine;
  };
  function snapshot() {
    return { state: engine ? "ready" : starting ? "starting" : "stopped", engine: "orchestrator-native", contractVersion: 1,
      productionReady: false, error: lastError, capabilities: engine?.capabilities() ?? null };
  }
  async function allSessions() {
    const current = live(), items = [];
    let after = "";
    for (let page = 0; page < 100; page += 1) {
      const rows = await current.sessions({ after, limit: 200 });
      items.push(...rows);
      if (rows.length < 200) return items;
      after = rows.at(-1).id;
    }
    throw fail("NATIVE_PAGE_LIMIT", "Session inventory exceeds its bounded read; use paged native history");
  }
  async function observation(id, expectedTurn) {
    const current = live(), value = await current.observe(internalId(id), expectedTurn ?? null);
    const terminal = TERMINAL.has(value.turnState);
    const timeline = value.answer ? [{ id: `answer-${value.turnId}`, kind: "message", status: terminal ? "completed" : "running", text: value.answer, turnId: value.turnId }] : [];
    return { ...value, sessionId: id, status: value.status === "unknown" ? "unknown" : terminal || !value.turnId ? "idle" : "working",
      exited: value.status === "closed", answer: terminal ? value.answer : "", liveOutput: value.answer, timeline, approvals: value.approvals ?? [],
      needsInput: value.needsInput === true, engine: "orchestrator-native", productionReady: false };
  }
  const harness = {
    watch(listener) {
      if (typeof listener !== "function") throw fail("INVALID_LISTENER", "Choose a change listener");
      listeners.add(listener); return () => listeners.delete(listener);
    },
    async catalog() {
      return [...descriptors.values()].map(item => ({ id: item.id, name: item.name ?? item.id, installed: true, authStatus: "host-resolved",
        chat: true, native: true, productionReady: false, capabilities: item.capabilities ?? {} }));
    },
    async models(agent) {
      const descriptor = descriptors.get(agent);
      if (!descriptor) throw fail("DRIVER_UNAVAILABLE", "Native driver is not configured");
      return descriptor.models.map(id => ({ id, label: id, isDefault: false, efforts: [] }));
    },
    async spawn(options = {}) {
      const fields = new Set(["workspaceId", "agent", "model", "prompt", "name", "gateway", "effort", "contextWindow", "approvalMode", "autoReview", "plain", "warm", "subagent", "requestId"]);
      if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !fields.has(key))) unsupported("unrecognized launch settings");
      const { workspaceId, agent, model, prompt = "", name = "", gateway = null, effort = null, contextWindow = null,
        approvalMode = null, autoReview = false, plain = false, warm = false, subagent = false, requestId } = options;
      if (!validWorkspace(workspaceId)) throw fail("WORKSPACE_SCOPE", "Choose a valid workspace identity");
      if (requestId !== undefined && !validLaunchRequest(requestId)) throw fail("INVALID_INPUT", "Choose a stable launch request identity");
      const descriptor = descriptors.get(agent);
      if (!descriptor) throw fail("DRIVER_UNAVAILABLE", "Native driver is not configured");
      if (typeof model !== "string" || !descriptor.models.includes(model)) unsupported("the selected model");
      if (gateway) unsupported("provider gateway routing");
      if (approvalMode && approvalMode !== "read-only") unsupported("this permission mode");
      if (autoReview) unsupported("automatic approval review");
      if (effort) unsupported("effort selection");
      if (contextWindow != null) unsupported("context-window selection");
      if (subagent && descriptor.capabilities?.subagent !== true) unsupported("subagent tool grants");
      if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 65536 || !warm && !prompt.trim()) throw fail("INVALID_INPUT", "Native prompt is empty or oversized");
      if (warm) unsupported("prewarming");
      const workspace = await resolveWorkspace(workspaceId);
      if (workspace?.workspaceId !== workspaceId || typeof workspace.root !== "string" || !path.isAbsolute(workspace.root)) throw fail("WORKSPACE_SCOPE", "Host did not resolve this workspace");
      const root = await fs.realpath(workspace.root);
      if (!(await fs.stat(root)).isDirectory()) throw fail("WORKSPACE_SCOPE", "Workspace root is not a directory");
      const config = sessionConfig({ model, approvalMode: "read-only", plain, subagent, engineVersion: "0.2-native-adapter" });
      const id = requestId === undefined ? randomUUID() : launchSessionId(workspaceId, requestId);
      await start();
      const accepted = await live().launch({ id, workspaceId, harness: agent, root, name, config }, prompt);
      if (!accepted.duplicate) ownedSessions.add(accepted.sessionId);
      return externalId(accepted.sessionId);
    },
    async observe(id, expectedTurn) { return observation(id, expectedTurn); },
    async recover(id, expectedTurn, { workspaceId, inputId, requestId } = {}) {
      if (!engine || stopping || (!expectedTurn && requestId === undefined)) {
        return { recovery: "unavailable", status: "unknown", message: "The existing native turn cannot be inspected; no work was started" };
      }
      if (requestId !== undefined) {
        if (expectedTurn || inputId !== undefined) throw fail("INVALID_INPUT", "Read a native send receipt by its reservation identity only");
        const receipt = await live().readSendReceipt(internalId(id), requestId, workspaceId);
        return { recovery: receipt ? "observed" : "unresolved", replayed: false,
          sendReceipt: receipt ? { ...receipt, sessionId: id } : null };
      }
      if (inputId !== undefined) {
        const receipt = await live().readSteerReceipt(internalId(id), expectedTurn, inputId, workspaceId);
        return { recovery: receipt ? "observed" : "unresolved", replayed: false,
          steerReceipt: receipt ? { ...receipt, sessionId: id } : null };
      }
      const value = await observation(id, expectedTurn);
      return { ...value, recovery: value.recoveryRequired ? "unresolved" : "observed", replayed: false,
        message: "Observed the recorded native turn; no queue was drained or prompt replayed" };
    },
    async continuable(id) {
      const session = await live().session(internalId(id));
      return session.state !== "closed" && session.state !== "unknown" && descriptors.has(session.harness)
        && (ownedSessions.has(session.id) || liveDrivers?.[session.harness]?.capabilities?.resumeAfterRestart === true);
    },
    async send(id, text, clientMessageId) {
      if (!clientMessageId) throw fail("INPUT_ID_REQUIRED", "Native send requires a stable input identity");
      if (!await harness.continuable(id)) throw fail("NATIVE_REATTACH_REQUIRED", "The original provider conversation cannot be safely reattached by this driver");
      return live().send(internalId(id), text, clientMessageId);
    },
    async steer(id, text, clientMessageId, { turnId, workspaceId } = {}) {
      return live().steer(internalId(id), turnId, text, clientMessageId, workspaceId);
    },
    async resolveApproval(id, requestId, decision, _reason, { turnId, workspaceId } = {}) {
      return live().resolveApproval(internalId(id), turnId, requestId, decision, workspaceId);
    },
    async interrupt(id, options = {}) {
      const turnId = typeof options === "string" ? options : options.turnId ?? options.expectedTurn;
      if (!turnId) throw fail("TURN_ID_REQUIRED", "Native interruption requires the exact turn identity");
      return live().cancel(internalId(id), turnId);
    },
    async timeline(id, turnId) { return (await observation(id, turnId)).timeline; },
    async sessionWorkspace(id, workspaceId = null) {
      const session = await live().session(internalId(id));
      if (workspaceId && session.workspace_id !== workspaceId) throw fail("WORKSPACE_SCOPE", "Native session belongs to a different workspace");
      const workspace = await resolveWorkspace(session.workspace_id);
      if (workspace?.workspaceId !== session.workspace_id || await fs.realpath(workspace.root) !== session.root) throw fail("WORKSPACE_SCOPE", "Native workspace binding changed");
      return session.state === "closed" ? { ended: true } : { root: session.root, projectFolder: session.root, ready: true };
    },
    async anySessionWorking() { return (await allSessions()).some(session => ["working", "unknown"].includes(session.state)); },
    async idleChatSessions(idleMs, now = Date.now()) {
      return (await allSessions()).filter(session => session.state === "idle" && now - Date.parse(session.updated_at) >= idleMs).map(session => externalId(session.id));
    },
    async quietWorkingChatSessions() { return []; },
    async staleSessions(workspaceIds, idleMs, now = Date.now()) {
      const allowed = new Set(workspaceIds);
      return (await allSessions()).filter(session => allowed.has(session.workspace_id) && session.state === "idle" && now - Date.parse(session.updated_at) >= idleMs).map(session => externalId(session.id));
    },
    async warmSessions() { return []; },
    async kill(id) { await harness.exitAgent(id); await live().closeSession(internalId(id)); return { ok: true }; },
    async exitAgent(id) {
      const current = live(), session = await current.session(internalId(id));
      const driver = liveDrivers?.[session.harness];
      if (typeof driver?.releaseSession !== "function") unsupported("session-scoped agent release");
      if (session.state !== "idle") throw fail("SESSION_BUSY", "Stop the exact active turn before releasing its agent");
      await driver.releaseSession(session.id); ownedSessions.delete(session.id); return { ok: true };
    },
    async releaseAgent(id) { return { ...await harness.exitAgent(id), exiting: false }; },
  };
  for (const name of HARNESS_METHODS) if (!Object.hasOwn(harness, name)) harness[name] = () => unsupported(name);
  const runtime = {
    harness: Object.freeze(harness), start, snapshot,
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => { if (starting) await starting.catch(() => {}); unwatch?.(); unwatch = null; const current = engine; engine = null; ownedSessions.clear(); if (current) consumed = true; await current?.close(); liveDrivers = null; })();
      try { await stopping; return { ok: true }; } finally { stopping = null; }
    },
    async call(operation, args = {}) {
      if (operation === "native_launch_receipt") {
        const { workspaceId, agent, requestId } = args;
        if (!validWorkspace(workspaceId) || !validLaunchRequest(requestId)) throw fail("INVALID_INPUT", "Choose the original native launch scope");
        if (!descriptors.has(agent)) throw fail("DRIVER_UNAVAILABLE", "Native driver is not configured");
        if (!engine || stopping) return { launchReceipt: null };
        const current = live(), id = launchSessionId(workspaceId, requestId);
        const first = await current.readSendReceipt(id, "initial", workspaceId);
        if (!first || (await current.session(id)).harness !== agent) return { launchReceipt: null };
        return { launchReceipt: { workspaceId, agent, requestId, sessionId: externalId(id), turnId: first.turnId } };
      }
      if (operation === "native_status") return snapshot();
      if (operation === "native_start") return start();
      if (operation === "native_stop") return runtime.stop();
      if (operation === "native_sessions") return live().sessions(args);
      unsupported(operation);
    },
    async survivingChatHosts() { return []; },
    async endChatHosts() { return runtime.stop(); },
    hide() {},
  };
  for (const name of RUNTIME_METHODS) if (!Object.hasOwn(runtime, name)) runtime[name] = () => unsupported(name);
  return Object.freeze(runtime);
}

module.exports = { createNativeRuntimeAdapter, internalId, externalId, NATIVE_SESSION_PREFIX: PREFIX };
