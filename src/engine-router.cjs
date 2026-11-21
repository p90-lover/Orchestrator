"use strict";

const { RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime } = require("./orchestrator-handler.cjs");
const { NATIVE_SESSION_PREFIX } = require("./native-runtime-adapter.cjs");
const fail = (code, message) => Object.assign(new Error(message), { code });
const SESSION_METHODS = new Set(["recover", "observe", "continuable", "setContextWindow", "exitAgent", "releaseAgent", "send", "steer", "kill", "sessionWorkspace", "resolveInput", "resolveApproval", "timeline", "compact", "compactionStatus", "interrupt", "openTerminal", "closeTerminal"]);

function createEngineRouter({ legacy, native, nativeAgents = [] } = {}) {
  if (!inspectRuntime(legacy).shapeCompatible || native && !inspectRuntime(native).shapeCompatible) throw fail("INCOMPATIBLE_RUNTIME", "Each registered engine must implement the handler contract");
  const allowed = new Set(nativeAgents);
  for (const agent of allowed) if (typeof agent !== "string" || !agent.startsWith("orchestrator-")) throw fail("INVALID_NATIVE_AGENT", "Native catalog entries need an explicit orchestrator prefix");
  const runtimeFor = id => {
    if (typeof id !== "string" || !id) throw fail("SESSION_ID_REQUIRED", "Choose a session identity");
    if (id.startsWith(NATIVE_SESSION_PREFIX)) {
      if (!native) throw fail("NATIVE_UNAVAILABLE", "The native engine owning this session is unavailable; legacy fallback is forbidden");
      return native;
    }
    if (id.includes(":")) throw fail("ENGINE_ID_UNKNOWN", "Session belongs to an unknown engine");
    return legacy;
  };
  const harness = {};
  for (const name of SESSION_METHODS) harness[name] = (id, ...args) => runtimeFor(id).harness[name](id, ...args);
  harness.watch = listener => {
    const stops = [legacy.harness.watch(listener)];
    try { if (native) stops.push(native.harness.watch(listener)); }
    catch (error) { for (const stop of stops) stop(); throw error; }
    return () => { for (const stop of stops) stop(); };
  };
  harness.catalog = async () => {
    const rows = await legacy.harness.catalog();
    if (!native) return rows;
    const additions = (await native.harness.catalog()).filter(row => allowed.has(row.id));
    const ids = new Set(rows.map(row => row.id));
    if (additions.some(row => ids.has(row.id))) throw fail("AGENT_ID_COLLISION", "Legacy and native catalogs overlap");
    return [...rows, ...additions];
  };
  harness.models = (agent, ...args) => {
    if (allowed.has(agent)) {
      if (!native) throw fail("NATIVE_UNAVAILABLE", "Native provider is unavailable");
      return native.harness.models(agent, ...args);
    }
    if (String(agent).startsWith("orchestrator-")) throw fail("NATIVE_UNAVAILABLE", "Native provider is not enabled");
    return legacy.harness.models(agent, ...args);
  };
  harness.spawn = options => {
    if (allowed.has(options?.agent)) {
      if (!native) throw fail("NATIVE_UNAVAILABLE", "Native provider is unavailable");
      return native.harness.spawn(options);
    }
    if (String(options?.agent).startsWith("orchestrator-")) throw fail("NATIVE_UNAVAILABLE", "Native provider is not enabled");
    return legacy.harness.spawn(options);
  };
  for (const name of ["idleChatSessions", "quietWorkingChatSessions", "staleSessions", "warmSessions"]) {
    harness[name] = async (...args) => [...await legacy.harness[name](...args), ...(native ? await native.harness[name](...args) : [])];
  }
  if (typeof legacy.harness.busyChatSessions === "function") harness.busyChatSessions = (...args) => legacy.harness.busyChatSessions(...args);
  harness.anySessionWorking = async (...args) => Boolean(await legacy.harness.anySessionWorking(...args) || native && await native.harness.anySessionWorking(...args));
  for (const name of HARNESS_METHODS) if (typeof harness[name] !== "function") throw fail("ROUTER_CONTRACT_MISSING", `Unrouted harness operation: ${name}`);
  const runtime = Object.fromEntries(RUNTIME_METHODS.map(name => [name, (...args) => Reflect.apply(legacy[name], legacy, args)]));
  const both = async (method, args) => {
    const engines = native ? [legacy, native] : [legacy];
    const results = await Promise.allSettled(engines.map(engine => Promise.resolve().then(() => Reflect.apply(engine[method], engine, args))));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `One or more engines could not complete ${method}`);
    return results.map(result => result.value);
  };
  runtime.stop = async (...args) => { await both("stop", args); return { ok: true }; };
  runtime.endChatHosts = async (...args) => { await both("endChatHosts", args); return { ok: true }; };
  runtime.survivingChatHosts = async (...args) => (await both("survivingChatHosts", args)).flat();
  runtime.call = (operation, ...args) => {
    if (typeof operation === "string" && operation.startsWith("native_")) {
      if (!native) throw fail("NATIVE_UNAVAILABLE", "Native provider is unavailable");
      return native.call(operation, ...args);
    }
    return legacy.call(operation, ...args);
  };
  return Object.freeze({ ...runtime, harness: Object.freeze(harness) });
}

module.exports = { createEngineRouter };
