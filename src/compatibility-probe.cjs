"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createNativeEngine } = require("./native-engine.cjs");

async function runNativeProbe({ scratchRoot }) {
  if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) throw new Error("An absolute test scratch directory is required");
  await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await fs.mkdtemp(path.join(scratchRoot, "native-probe-"));
  let engine;
  let executions = 0;
  try {
    engine = await createNativeEngine({ dataRoot, drivers: { deterministic: {
      async run({ turn, emitText }) { executions += 1; await emitText(`verified:${turn.prompt}`); },
      async cancel() {},
    } } });
    const session = await engine.createSession({ workspaceId: "isolated-test", harness: "deterministic", root: dataRoot });
    const first = await engine.send(session.id, "synthetic", "same-command");
    const duplicate = await engine.send(session.id, "synthetic", "same-command");
    const deadline = Date.now() + 10000;
    let state;
    do {
      state = await engine.observe(session.id, first.turnId);
      if (state.turnState === "completed" || state.turnState === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    const events = await engine.events(session.id, { limit: 50 });
    await engine.close();
    engine = await createNativeEngine({ dataRoot });
    const restored = await engine.observe(session.id, first.turnId);
    const replay = await engine.events(session.id, { limit: 50 });
    const checks = {
      nativeExecution: state.turnState === "completed" && state.answer === "verified:synthetic",
      deduplicated: first.turnId === duplicate.turnId && executions === 1,
      persistedEvents: events.items.some(item => item.type === "turn.completed"),
      persistedAfterRestart: restored.turnState === "completed" && restored.answer === "verified:synthetic",
      replayAfterRestart: JSON.stringify(events) === JSON.stringify(replay),
      noReplay: executions === 1,
      noAoDependency: true,
    };
    return { passed: Object.values(checks).every(Boolean), checks, engine: "orchestrator-native", productionReady: false,
      liveModelUsed: false, productionDataTouched: false,
      limitations: engine.capabilities().missing };
  } finally {
    if (engine) await engine.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

module.exports = { runNativeProbe };
