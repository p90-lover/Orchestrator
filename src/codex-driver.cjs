"use strict";

const { createJsonLineClient } = require("./json-line-client.cjs");
const failure = (code, message) => Object.assign(new Error(message), { code });

function createCodexDriver({ launch, model, createClient = createJsonLineClient, interruptTimeoutMs = 5000 } = {}) {
  if (typeof launch !== "function") throw failure("INVALID_DRIVER", "A host-owned launch resolver is required");
  if (!Number.isInteger(interruptTimeoutMs) || interruptTimeoutMs < 1 || interruptTimeoutMs > 30000) {
    throw failure("INVALID_DRIVER", "Choose a bounded interrupt confirmation timeout");
  }
  const connections = new Map();
  const lostSessions = new Set();
  let closed = false;
  function writeDelta(turn, delta) {
    if (turn.outputFailed) return;
    let write;
    try { write = Promise.resolve(turn.emitText(delta)); }
    catch (error) { write = Promise.reject(error); }
    turn.writes = Promise.all([turn.writes, write]).then(() => undefined);
    turn.writes.catch(error => { turn.outputFailed = true; turn.reject(error); });
  }
  function receiveTurnEvent(turn, method, params) {
    if (turn.ended) return;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      writeDelta(turn, params.delta);
    } else if (method === "turn/completed" && params.turn?.id === turn.providerId) {
      const { status } = params.turn;
      if (!["completed", "failed", "interrupted"].includes(status)) return;
      turn.ended = true;
      turn.noteTerminal(status);
      turn.writes.then(() => {
        if (status === "completed") turn.resolve();
        else if (status === "interrupted") turn.reject(failure("TURN_CANCELLED", "Harness confirmed the turn was interrupted"));
        else turn.reject(failure("HARNESS_TURN_FAILED", "Harness turn did not complete"));
      }, turn.reject);
    }
  }
  function endWithoutReceipt(turn, error) {
    if (!turn || turn.ended) return;
    turn.ended = true;
    turn.noteTerminal(null);
    turn.reject(error);
  }
  async function interrupt(state, turn) {
    let timer;
    try {
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), interruptTimeoutMs); });
      const reply = state.client.request("turn/interrupt", { threadId: state.threadId, turnId: turn.providerId });
      // An empty RPC reply acknowledges the request, not the provider's turn outcome.
      const status = await Promise.race([turn.terminal, reply.then(() => turn.terminal), deadline]);
      if (status) return status === "interrupted";
    } catch { /* A failed or missing reply cannot confirm cancellation. */ }
    finally { clearTimeout(timer); }
    endWithoutReceipt(turn, failure("INTERRUPT_UNCONFIRMED", "Harness did not confirm that the original turn stopped"));
    return (await turn.terminal) === "interrupted";
  }
  async function connection(session) {
    if (closed) throw failure("DRIVER_CLOSED", "Native driver has closed");
    if (lostSessions.has(session.id)) throw failure("SESSION_REATTACH_REQUIRED", "The previous harness thread cannot be safely reattached by this prototype");
    if (connections.has(session.id)) return connections.get(session.id);
    const pending = (async () => {
      const state = { client: null, threadId: null, turn: null };
      const options = await launch(session);
      state.client = createClient({ ...options, cwd: session.root,
        onClose(error) {
          if (state.threadId) lostSessions.add(session.id);
          connections.delete(session.id);
          endWithoutReceipt(state.turn, error);
        },
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
          receiveTurnEvent(turn, method, params);
        },
      });
      try {
        await state.client.request("initialize", { clientInfo: { name: "coding_tools_orchestrator", title: "Orchestrator", version: "0.2.0" }, capabilities: {} });
        state.client.notify("initialized", {});
        const selectedModel = session.config?.model ?? model;
        const response = await state.client.request("thread/start", { cwd: session.root, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true, ...(selectedModel ? { model: selectedModel } : {}) });
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
    capabilities: Object.freeze({ sandbox: "read-only", interactiveApprovals: false, steering: true, resumeAfterRestart: false, productionReady: false }),
    async run({ session, turn: localTurn, signal, emitText }) {
      const state = await connection(session);
      if (signal.aborted) return;
      if (state.turn) throw failure("SESSION_BUSY", "Harness already has an active turn");
      let resolve, reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      finished.catch(() => {});
      let noteTerminal;
      const terminal = new Promise(done => { noteTerminal = done; });
      const turn = { localId: localTurn.id, providerId: null, emitText, writes: Promise.resolve(), early: [], resolve, reject, noteTerminal, terminal };
      state.turn = turn;
      const abort = () => {
        if (turn.ended) return;
        endWithoutReceipt(turn, failure("INTERRUPT_UNCONFIRMED", "Host stopped before the harness confirmed the turn outcome"));
        void state.client.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await state.client.request("turn/start", { threadId: state.threadId, input: [{ type: "text", text: localTurn.prompt, text_elements: [] }] });
        if (typeof response?.turn?.id !== "string") throw failure("INVALID_PROTOCOL", "Harness did not return a turn ID");
        turn.providerId = response.turn.id;
        for (const [method, params] of turn.early) {
          if ((params.turnId ?? params.turn?.id) !== turn.providerId) continue;
          receiveTurnEvent(turn, method, params);
        }
        await finished;
        await turn.writes;
      } catch (error) {
        // Only a confirmed interrupt leaves this connection reusable after a failed run.
        if (error?.code !== "TURN_CANCELLED") {
          endWithoutReceipt(turn, error);
          try { await state.client.close(); } catch {}
        }
        if (!["HARNESS_TURN_FAILED", "TURN_CANCELLED"].includes(error?.code)) {
          const uncertain = error instanceof Error ? error : failure("DRIVER_UNCERTAIN", "Harness delivery outcome is uncertain");
          uncertain.uncertain = true;
          throw uncertain;
        }
        throw error;
      } finally { signal.removeEventListener("abort", abort); if (state.turn === turn) state.turn = null; }
    },
    async steer({ sessionId, turnId, text, clientMessageId }) {
      const state = await connections.get(sessionId);
      const turn = state?.turn;
      if (!turn?.providerId || turn.localId !== turnId || turn.ended || closed) return { steered: false, dispatched: false };
      const response = await state.client.request("turn/steer", {
        threadId: state.threadId, expectedTurnId: turn.providerId, clientUserMessageId: clientMessageId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (response?.turnId !== turn.providerId) throw failure("INVALID_PROTOCOL", "Steer receipt does not identify the original provider turn");
      return { steered: true, turnId };
    },
    async cancel({ sessionId, turnId }) {
      const state = await connections.get(sessionId);
      const turn = state?.turn;
      if (!turn?.providerId || turn.localId !== turnId || turn.ended || closed) return false;
      return turn.interruption ??= interrupt(state, turn);
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
