"use strict";

const path = require("node:path");
const fail = (code, message) => Object.assign(new Error(message), { code });
const MAX_OUTPUT_BYTES = 1024 * 1024;

function createPiDriver({ sdk, agentDir, resolveModel, maxSessions = 8 } = {}) {
  if (!sdk?.createAgentSession || !sdk?.createExtensionRuntime || !sdk?.SessionManager?.inMemory || !sdk?.SettingsManager?.inMemory
    || typeof agentDir !== "string" || !path.isAbsolute(agentDir) || typeof resolveModel !== "function"
    || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw fail("INVALID_PI_HOST", "Pi needs an explicit trusted SDK, model resolver and data root");
  const sessions = new Map();
  let closed = false;
  const noTools = session => {
    if (session.getActiveToolNames().length || session.isStreaming) throw fail("PI_SCOPE", "In-memory Pi sessions must be idle and tool-free before prompting");
  };

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
      getSystemPrompt: () => "Answer the user in plain text. Tools are not available.", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
    };
    const scopedRuntime = new Proxy(modelRuntime, { get(target, key) {
      if (key === "streamSimple") return (selected, context, options) => {
        const owner = entry.active;
        if (!owner?.prompting || owner.stopping || owner.providerStarted
          || selected?.id !== model.id || selected?.provider !== model.provider || selected?.baseUrl !== model.baseUrl
          || context?.tools?.length) {
          throw fail("PI_PROVIDER_SCOPE", "Pi attempted work outside the original text-only model request");
        }
        owner.providerStarted = true;
        return target.streamSimple(selected, context, options);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const { session } = await sdk.createAgentSession({ cwd: spec.root, agentDir, model, modelRuntime: scopedRuntime, resourceLoader,
      tools: [], noTools: "all", thinkingLevel: "off", sessionManager: sdk.SessionManager.inMemory(spec.root),
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30_000 } },
        compaction: { enabled: false }, cacheWarming: "off", transport: "sse" }),
    });
    try {
      if (session.model?.id !== model.id || session.model.provider !== model.provider) throw fail("PI_MODEL_UNAVAILABLE", "Pi selected a different provider or model");
      noTools(session);
      return session;
    } catch (error) { session.dispose(); throw error; }
  }

  function stop(owner) {
    owner.stopping = true;
    if (owner.pi) return owner.stop ??= Promise.resolve().then(() => owner.pi.abort());
  }

  return Object.freeze({
    capabilities: Object.freeze({ textOnly: true, interactiveApprovals: false, steering: false, resumeAfterRestart: false, productionReady: false }),
    async run({ session, turn, signal, emitText }) {
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
      const owner = { turnId: turn.id }, abort = () => { void Promise.resolve(stop(owner)).catch(() => {}); };
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
        noTools(pi);
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
        await Promise.all([...pending]);
        unsubscribe?.();
        signal.removeEventListener("abort", abort);
        if (entry.active === owner) entry.active = null;
      }
    },
    async cancel({ sessionId, turnId }) {
      const owner = sessions.get(sessionId)?.active;
      if (owner?.turnId === turnId) await stop(owner);
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
