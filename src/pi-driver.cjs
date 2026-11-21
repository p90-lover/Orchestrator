"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fail = (code, message) => Object.assign(new Error(message), { code });
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FIXTURE_TOOL = "read_canary_fact";
const FIXTURE_VALUE = "orchestrator-canary-fact";
const DECISIONS = Object.freeze([
  Object.freeze({ id: "allow_once", kind: "allow_once", label: "Allow once" }),
  Object.freeze({ id: "reject_once", kind: "reject_once", label: "Deny" }),
]);

function createPiDriver({ sdk, agentDir, resolveModel, maxSessions = 8, fixtureSchema, approvalWaitMs = 30_000 } = {}) {
  if (!sdk?.createAgentSession || !sdk?.createExtensionRuntime || !sdk?.SessionManager?.inMemory || !sdk?.SettingsManager?.inMemory
    || typeof agentDir !== "string" || !path.isAbsolute(agentDir) || typeof resolveModel !== "function"
    || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw fail("INVALID_PI_HOST", "Pi needs an explicit trusted SDK, model resolver and data root");
  if (fixtureSchema !== undefined && (fixtureSchema?.type !== "object" || fixtureSchema.additionalProperties !== false
    || Object.keys(fixtureSchema.properties ?? {}).length || !Number.isInteger(approvalWaitMs) || approvalWaitMs < 1 || approvalWaitMs > 30_000)) {
    throw fail("INVALID_PI_HOST", "The approval fixture requires an empty strict input schema and a bounded wait");
  }
  const fixture = fixtureSchema !== undefined;
  const toolNames = fixture ? [FIXTURE_TOOL] : [];
  const matches = names => Array.isArray(names) && names.length === toolNames.length && names.every((name, index) => name === toolNames[index]);
  function scopedTools(context) {
    const active = new Set((context?.tools ?? []).map(tool => tool.name));
    if ([...active].some(name => !toolNames.includes(name))) return false;
    for (const message of context?.messages ?? []) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) {
        if (!toolNames.includes(tool.name)) return false;
        active.add(tool.name);
      }
    }
    return matches([...active]);
  }
  const sessions = new Map();
  let closed = false;
  const checkTools = session => {
    if (!matches(session.getActiveToolNames()) || session.isStreaming) throw fail("PI_SCOPE", "Pi must be idle with only its explicitly configured tools");
  };

  function ask(entry, args, signal) {
    const owner = entry.active;
    if (!owner?.prompting || owner.stopping || owner.toolAsked || owner.providerCalls !== 1 || signal?.aborted
      || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw fail("PI_TOOL_SCOPE", "The fixture tool is not available to this request");
    }
    owner.toolAsked = true;
    return new Promise(resolve => {
      const request = { id: randomUUID(), deadline: Date.now() + approvalWaitMs, finish };
      const timeout = setTimeout(() => finish(false, "Approval expired"), approvalWaitMs);
      const abort = () => finish(false, "Turn stopped");
      function finish(allow, reason) {
        if (owner.approval !== request) return;
        owner.approval = null;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        owner.toolAnswered = !owner.stopping && !signal?.aborted;
        resolve({ content: [{ type: "text", text: allow && owner.toolAnswered ? FIXTURE_VALUE : reason }], details: {} });
        owner.notify?.();
      }
      owner.approval = request;
      signal?.addEventListener("abort", abort, { once: true });
      owner.notify?.();
    });
  }

  async function open(spec, entry) {
    const { model, modelRuntime } = await resolveModel(spec) ?? {};
    if (typeof modelRuntime?.streamSimple !== "function" || !model?.provider || typeof spec.config?.model !== "string" || model.id !== spec.config.model) {
      throw fail("PI_MODEL_UNAVAILABLE", "Pi must use the exact model selected by the host");
    }
    const runtime = sdk.createExtensionRuntime();
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => fixture ? "Use only the provided fixture tool if the user asks for the canary fact." : "Answer the user in plain text. Tools are not available.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
    };
    const scopedRuntime = new Proxy(modelRuntime, { get(target, key) {
      if (key === "streamSimple") return (selected, context, options) => {
        const owner = entry.active;
        if (!owner?.prompting || owner.stopping
          || (owner.providerCalls !== 0 && !(fixture && owner.providerCalls === 1 && owner.toolAnswered))
          || selected?.id !== model.id || selected?.provider !== model.provider || selected?.baseUrl !== model.baseUrl
          || !scopedTools(context)) {
          throw fail("PI_PROVIDER_SCOPE", "Pi attempted work outside the approved model and tool scope");
        }
        owner.providerCalls += 1;
        return target.streamSimple(selected, context, options);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const { session } = await sdk.createAgentSession({ cwd: spec.root, agentDir, model, modelRuntime: scopedRuntime, resourceLoader,
      tools: toolNames, noTools: "all", thinkingLevel: "off", sessionManager: sdk.SessionManager.inMemory(spec.root),
      ...(fixture ? { customTools: [{ name: FIXTURE_TOOL, label: "Read the canary fact",
        description: "Return a fixed test value. No file or network access. This requires explicit manual approval.", parameters: fixtureSchema,
        execute: async (_callId, args, signal) => ask(entry, args, signal),
      }] } : {}),
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30_000 } },
        compaction: { enabled: false }, cacheWarming: "off", transport: "sse" }),
    });
    try {
      if (session.model?.id !== model.id || session.model.provider !== model.provider) throw fail("PI_MODEL_UNAVAILABLE", "Pi selected a different provider or model");
      checkTools(session);
      return session;
    } catch (error) { session.dispose(); throw error; }
  }

  function stop(owner) {
    owner.stopping = true;
    owner.approval?.finish(false, "Turn stopped");
    if (owner.pi) return owner.stop ??= Promise.resolve().then(() => owner.pi.abort());
  }

  return Object.freeze({
    capabilities: Object.freeze({ textOnly: !fixture, fixtureApproval: fixture, interactiveApprovals: false, steering: false, resumeAfterRestart: false, productionReady: false }),
    async run({ session, turn, signal, emitText, onStateChange }) {
      if (closed) throw fail("DRIVER_CLOSED", "Pi driver has closed");
      let entry = sessions.get(session.id);
      if (!entry) {
        if (sessions.size >= maxSessions) throw fail("PI_SESSION_LIMIT", "Pi has no free in-memory session slots");
        entry = { active: null, lost: false };
        entry.opened = open(session, entry);
        sessions.set(session.id, entry);
      }
      if (entry.lost) throw fail("SESSION_REATTACH_REQUIRED", "Pi cannot reattach a lost provider conversation");
      if (entry.active) throw fail("SESSION_BUSY", "Pi already owns a turn for this session");
      const owner = { turnId: turn.id, workspaceId: session.workspace_id, providerCalls: 0, notify: onStateChange };
      const abort = () => { void Promise.resolve(stop(owner)).catch(() => {}); };
      entry.active = owner;
      signal.addEventListener("abort", abort, { once: true });
      let unsubscribe, dispatched = false, outputFailure, finalMessage;
      let seen = "", bytes = 0;
      const pending = new Set();
      const append = delta => {
        if (outputFailure || owner.stopping) return;
        bytes += Buffer.byteLength(delta);
        if (bytes > MAX_OUTPUT_BYTES || pending.size >= 128) {
          outputFailure = fail("PI_OUTPUT_LIMIT", "Pi output exceeds the bounded stream capacity");
          abort();
          return;
        }
        seen += delta;
        const written = Promise.resolve().then(() => emitText(delta)).catch(error => { outputFailure ??= error; abort(); });
        pending.add(written);
        void written.then(() => pending.delete(written));
      };
      try {
        const pi = owner.pi = await entry.opened;
        if (owner.stopping || signal.aborted || closed) return;
        checkTools(pi);
        unsubscribe = pi.subscribe(event => {
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") append(event.assistantMessageEvent.delta);
          else if (event.type === "message_end" && event.message?.role === "assistant") finalMessage = event.message;
        });
        owner.prompting = true;
        dispatched = true;
        await pi.prompt(turn.prompt, { expandPromptTemplates: false });
        owner.prompting = false;
        if (outputFailure) throw outputFailure;
        if (owner.stopping || signal.aborted) return;
        const answer = finalMessage?.content?.filter(item => item.type === "text").map(item => item.text).join("");
        if (finalMessage?.stopReason !== "stop" || !answer || !answer.startsWith(seen)) {
          throw fail("PI_TURN_UNCONFIRMED", "Pi did not confirm its complete text reply");
        }
        if (answer.length > seen.length) append(answer.slice(seen.length));
        await Promise.all([...pending]);
        if (outputFailure) throw outputFailure;
      } catch (error) {
        entry.lost = true;
        owner.pi?.dispose();
        if (dispatched && !signal.aborted) throw Object.assign(fail("PI_TURN_UNCONFIRMED", "Pi turn outcome is not confirmed"), { uncertain: true });
        throw error;
      } finally {
        owner.approval?.finish(false, "Turn ended before approval");
        await Promise.all([...pending]);
        unsubscribe?.();
        signal.removeEventListener("abort", abort);
        if (entry.active === owner) entry.active = null;
      }
    },
    pendingApprovals({ sessionId, turnId }) {
      const owner = sessions.get(sessionId)?.active, request = owner?.approval;
      if (owner?.turnId !== turnId || !request || Date.now() >= request.deadline) return [];
      return [{ approval_id: request.id, turn_id: turnId, source: "ao", kind: "permission", tool: FIXTURE_TOOL,
        summary: "Read the fixed canary fact. No file or network access.", decisions: DECISIONS }];
    },
    resolveApproval({ sessionId, workspaceId, turnId, requestId, decision }) {
      const owner = sessions.get(sessionId)?.active, request = owner?.approval;
      if (!owner || owner.workspaceId !== workspaceId || owner.turnId !== turnId || !request || request.id !== requestId
        || owner.stopping || Date.now() >= request.deadline) throw fail("PI_APPROVAL_SCOPE", "This approval no longer belongs to the active Pi turn");
      if (!DECISIONS.some(option => option.id === decision)) throw fail("PI_APPROVAL_SCOPE", "Choose one of this request's single-use decisions");
      request.finish(decision === "allow_once", "The operator denied this fixture tool");
      return { ok: true };
    },
    async cancel({ sessionId, turnId }) {
      const owner = sessions.get(sessionId)?.active;
      if (owner?.turnId !== turnId) return false;
      await stop(owner);
      return true;
    },
    async releaseSession(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry?.active) throw fail("SESSION_BUSY", "Pi still owns a running turn");
      sessions.delete(sessionId);
      if (!entry?.lost) (await entry?.opened)?.dispose();
    },
    async close() {
      closed = true;
      await Promise.allSettled([...sessions.values()].map(async entry => {
        if (entry.active) await stop(entry.active);
        if (!entry.lost) (await entry.opened).dispose();
      }));
      sessions.clear();
    },
  });
}

module.exports = { createPiDriver };
