"use strict";

const { createJsonLineClient } = require("./json-line-client.cjs");
const failure = (code, message) => Object.assign(new Error(message), { code });

function createCodexDriver({ launch, model, createClient = createJsonLineClient } = {}) {
  if (typeof launch !== "function") throw failure("INVALID_DRIVER", "A host-owned launch resolver is required");
  const connections = new Map();
  const lostSessions = new Set();
  let closed = false;
  async function connection(session) {
    if (closed) throw failure("DRIVER_CLOSED", "Native driver has closed");
    if (lostSessions.has(session.id)) throw failure("SESSION_REATTACH_REQUIRED", "The previous harness thread cannot be safely reattached by this prototype");
    if (connections.has(session.id)) return connections.get(session.id);
    const pending = (async () => {
      const state = { client: null, threadId: null, turn: null };
      const options = await launch(session);
      state.client = createClient({ ...options, cwd: session.root,
        onClose(error) { if (state.threadId) lostSessions.add(session.id); connections.delete(session.id); state.turn?.reject(error); },
        onRequest(method, params) {
          if (params.threadId !== state.threadId || params.turnId !== state.turn?.providerId) throw failure("REQUEST_SCOPE", "Harness request does not belong to the active turn");
          if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) return { decision: "decline" };
          throw failure("UNSUPPORTED_REQUEST", "This prototype does not implement interactive requests");
        },
        onNotification(method, params) {
          const turn = state.turn;
          if (!turn || params.threadId !== state.threadId) return;
          const providerId = params.turnId ?? params.turn?.id;
          if (!turn.providerId) { if (turn.early.length >= 128) throw failure("PROTOCOL_LIMIT", "Too many early turn events"); turn.early.push([method, params]); return; }
          if (providerId !== turn.providerId) return;
          if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
            turn.writes = turn.writes.then(() => turn.emitText(params.delta));
            turn.writes.catch(error => turn.reject(error));
          } else if (method === "turn/completed") {
            turn.writes.then(() => {
              if (params.turn?.status === "completed") turn.resolve();
              else turn.reject(failure("HARNESS_TURN_FAILED", "Harness turn did not complete"));
            }, turn.reject);
          }
        },
      });
      try {
        await state.client.request("initialize", { clientInfo: { name: "coding_tools_orchestrator", title: "Orchestrator", version: "0.2.0" }, capabilities: {} });
        state.client.notify("initialized", {});
        const response = await state.client.request("thread/start", { cwd: session.root, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true, ...(model ? { model } : {}) });
        if (typeof response?.thread?.id !== "string") throw failure("INVALID_PROTOCOL", "Harness did not return a thread ID");
        state.threadId = response.thread.id;
        return state;
      } catch (error) { await state.client.close(); throw error; }
    })();
    connections.set(session.id, pending);
    pending.catch(() => { if (connections.get(session.id) === pending) connections.delete(session.id); });
    return pending;
  }
  return Object.freeze({
    capabilities: Object.freeze({ sandbox: "read-only", interactiveApprovals: false, resumeAfterRestart: false, productionReady: false }),
    async run({ session, turn: localTurn, signal, emitText }) {
      const state = await connection(session);
      if (signal.aborted) return;
      if (state.turn) throw failure("SESSION_BUSY", "Harness already has an active turn");
      let resolve, reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      finished.catch(() => {});
      const turn = { localId: localTurn.id, providerId: null, emitText, writes: Promise.resolve(), early: [], resolve, reject };
      state.turn = turn;
      const abort = () => { void state.client.close(); reject(failure("TURN_CANCELLED", "Turn cancelled by host")); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await state.client.request("turn/start", { threadId: state.threadId, input: [{ type: "text", text: localTurn.prompt, text_elements: [] }] });
        if (typeof response?.turn?.id !== "string") throw failure("INVALID_PROTOCOL", "Harness did not return a turn ID");
        turn.providerId = response.turn.id;
        for (const [method, params] of turn.early) {
          if ((params.turnId ?? params.turn?.id) !== turn.providerId) continue;
          if (method === "item/agentMessage/delta" && typeof params.delta === "string") turn.writes = turn.writes.then(() => emitText(params.delta));
          if (method === "turn/completed") turn.writes.then(() => params.turn?.status === "completed" ? resolve() : reject(failure("HARNESS_TURN_FAILED", "Harness turn did not complete")), reject);
        }
        await finished;
        await turn.writes;
      } catch (error) {
        // A failed acknowledgement or output write does not prove the provider
        // stopped. Retire this connection before accepting another turn.
        try { await state.client.close(); } catch {}
        throw error;
      } finally { signal.removeEventListener("abort", abort); if (state.turn === turn) state.turn = null; }
    },
    async cancel({ sessionId, turnId }) {
      const state = await connections.get(sessionId);
      if (!state || state.turn?.localId !== turnId) return;
      const error = failure("TURN_CANCELLED", "Turn cancelled by host");
      state.turn.reject(error);
      await state.client.close();
    },
    async close() {
      closed = true;
      const current = await Promise.allSettled(connections.values());
      await Promise.allSettled(current.filter(item => item.status === "fulfilled").map(item => item.value.client.close()));
      connections.clear();
    },
  });
}

module.exports = { createCodexDriver };
