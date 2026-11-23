"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createNativeEngine } = require("./native-engine.cjs");
const { sessionConfig } = require("./session-config.cjs");

const CHAT_CONTRACT_VERSION = 1;
const ENGINE = "orchestrator-native";
const AGENT = "orchestrator-chats";
const PAGE = 32;
const FIELDS = Object.freeze({ status: [], open: [], list: ["after"], read: ["sessionId", "before"],
  send: ["sessionId", "inputId", "text"], receipt: ["sessionId", "inputId"] });
const fail = (code, message) => Object.assign(new Error(message), { code });
const identity = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const digest = value => createHash("sha256").update(value).digest("hex");
const external = id => `native:${id}`;

function createChatsRuntime({ dataRoot, workspaceId, workspaceRoot, model, driverFactory, createEngine = createNativeEngine } = {}) {
  if (!path.isAbsolute(dataRoot ?? "") || !path.isAbsolute(workspaceRoot ?? "") || !identity(workspaceId)
    || typeof model !== "string" || !model.trim() || Buffer.byteLength(model) > 200 || typeof driverFactory !== "function") {
    throw fail("CHATS_BINDING_REQUIRED", "Chats needs an explicit isolated workspace and model binding");
  }
  const owned = new Set(), dispatching = new Set();
  let engine, opening, root, closed = false;
  const status = () => ({ available: !closed, ready: Boolean(engine) && !closed, engine: ENGINE, workspaceId, model, contractVersion: CHAT_CONTRACT_VERSION });
  const launchId = inputId => digest(JSON.stringify(["chats", workspaceId, inputId]));
  const nativeId = sessionId => {
    if (typeof sessionId !== "string" || !/^native:[a-f0-9]{64}$/.test(sessionId)) throw fail("CHATS_SESSION_SCOPE", "Choose a native Chats session");
    return sessionId.slice(7);
  };
  async function open() {
    if (closed) throw fail("CHATS_CLOSED", "Chats has closed");
    if (!engine && !opening) opening = (async () => {
      root = await fs.realpath(workspaceRoot);
      if (!(await fs.stat(root)).isDirectory()) throw fail("CHATS_WORKSPACE_SCOPE", "The bound workspace is unavailable");
      const driver = await driverFactory();
      try { engine = await createEngine({ dataRoot, drivers: { [AGENT]: driver }, queueCapacity: 1 }); }
      catch (error) { await driver?.close?.(); throw error; }
    })().finally(() => { opening = null; });
    await opening;
    return status();
  }
  async function scoped(sessionId) {
    const id = nativeId(sessionId);
    const row = await engine.session(id);
    if (row.workspace_id !== workspaceId || row.root !== root || row.harness !== AGENT || row.config?.model !== model) {
      throw fail("CHATS_SESSION_SCOPE", "That chat belongs to a different workspace or model binding");
    }
    return row;
  }
  async function receipt(sessionId, inputId) {
    if (!identity(inputId) || inputId === "initial") throw fail("CHATS_INPUT_ID", "Choose the saved input identity");
    const id = sessionId == null ? launchId(inputId) : (await scoped(sessionId)).id;
    const found = await engine.readSendReceipt(id, sessionId == null ? "initial" : inputId, workspaceId);
    if (!found) return null;
    await scoped(external(id));
    return { inputId, sessionId: external(id), turnId: found.turnId };
  }
  async function send(sessionId, inputId, text) {
    if (!identity(inputId) || inputId === "initial") throw fail("CHATS_INPUT_ID", "Choose a stable input identity");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(JSON.stringify(text)) > 16384) throw fail("CHATS_INPUT", "Enter text within the 16 KiB native message limit");
    if (await fs.realpath(workspaceRoot) !== root) throw fail("CHATS_WORKSPACE_SCOPE", "The bound workspace changed");
    const id = sessionId == null ? launchId(inputId) : (await scoped(sessionId)).id;
    if (dispatching.has(id)) throw fail("CHATS_BUSY", "Wait for the current input receipt");
    dispatching.add(id);
    try {
      if (sessionId == null) {
        const name = Array.from(text.trim().split(/\r?\n/, 1)[0]).slice(0, 48).join("");
        const result = await engine.launch({ id, workspaceId, harness: AGENT, root, name,
          config: sessionConfig({ model, approvalMode: "read-only", plain: true, engineVersion: "chats-1" }) }, text);
        if (!result.duplicate) owned.add(id);
        return { inputId, sessionId: external(id), turnId: result.turnId };
      }
      const existing = await receipt(sessionId, inputId);
      if (existing) {
        const answer = await engine.send(id, text, inputId);
        return { inputId, sessionId, turnId: answer.turnId };
      }
      if (!owned.has(id)) throw fail("CHATS_REATTACH_REQUIRED", "This provider session cannot continue after reopening. Its history is kept; start a new chat.");
      if ((await scoped(sessionId)).state !== "idle") throw fail("CHATS_BUSY", "Wait for this chat to finish its current turn");
      const accepted = await engine.send(id, text, inputId);
      return { inputId, sessionId, turnId: accepted.turnId };
    } finally { dispatching.delete(id); }
  }
  return Object.freeze({
    async call(operation, args = {}) {
      if (operation !== "chats" || !args || typeof args !== "object" || Array.isArray(args) || !Object.hasOwn(FIELDS, args.action)
        || Object.keys(args).some(key => key !== "action" && !FIELDS[args.action].includes(key))) {
        throw fail("CHATS_REQUEST", "Choose a supported native Chats action");
      }
      if (args.action === "status") return status();
      if (args.action === "open") return open();
      if (closed || !engine) throw fail("CHATS_NOT_OPEN", "Open the native Chats workspace first");
      if (args.action === "send") return send(args.sessionId, args.inputId, args.text);
      if (args.action === "receipt") return { receipt: await receipt(args.sessionId, args.inputId) };
      if (args.action === "list") {
        if (args.after !== undefined && (typeof args.after !== "string" || !/^[a-f0-9]{64}$/.test(args.after))) throw fail("CHATS_CURSOR", "Choose a valid chat-list cursor");
        const rows = await engine.sessions({ workspaceId, after: args.after ?? "", limit: PAGE + 1 });
        const chats = rows.slice(0, PAGE).filter(row => row.root === root && row.harness === AGENT && row.config?.model === model)
          .map(row => ({ sessionId: external(row.id), name: row.name, state: row.state, updatedAt: row.updated_at }));
        return { chats, cursor: rows.length > PAGE ? rows[PAGE - 1].id : null };
      }
      const session = await scoped(args.sessionId);
      const page = await engine.transcript(session.id, { workspaceId, before: args.before });
      return { ...page, sessionId: args.sessionId, continuable: owned.has(session.id) && session.state !== "unknown", name: session.name };
    },
    async close() {
      closed = true;
      await opening?.catch(() => {});
      await engine?.close();
    },
  });
}

module.exports = { CHAT_CONTRACT_VERSION, createChatsRuntime };
