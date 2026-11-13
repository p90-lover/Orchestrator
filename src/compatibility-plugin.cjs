"use strict";

const { once } = require("node:events");
const { runNativeProbe } = require("./compatibility-probe.cjs");
const VERSION = require("../package.json").version;
const TOOLS = [
  { name: "orchestrator_status", description: "Report the native Orchestrator prototype's actual capabilities and incomplete replacement status. Does not start a model or access existing chats.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "orchestrator_self_test", description: "Run isolated synthetic native-engine tests for durable turns, event reads and duplicate-message protection. No live model, AO process or production chat is used. Temporary test state is removed afterwards; success does not certify full Coding Tools compatibility.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

function createCompatibilityPlugin({ scratchRoot, probe = runNativeProbe } = {}) {
  let initialized = false;
  const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  return async function handle(request) {
    const id = request?.id ?? null;
    if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") return error(id, -32600, "Invalid request");
    if (!Object.hasOwn(request, "id")) return null;
    if (!["string", "number"].includes(typeof id)) return error(null, -32600, "Invalid request ID");
    if (request.method === "initialize") {
      initialized = true;
      const requested = request.params?.protocolVersion;
      return { jsonrpc: "2.0", id, result: { protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(requested) ? requested : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "orchestrator-compatibility", version: VERSION } } };
    }
    if (!initialized) return error(id, -32002, "Initialize first");
    if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (request.method !== "tools/call") return error(id, -32601, "Method not found");
    const args = request.params?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return error(id, -32602, "This tool takes no arguments");
    const name = request.params?.name;
    if (!TOOLS.some(tool => tool.name === name)) return error(id, -32602, "Unknown tool");
    try {
      const result = name === "orchestrator_self_test" ? await probe({ scratchRoot }) : {
        engine: "orchestrator-native", version: VERSION, productionReady: false, aoRequiredForThisPlugin: false,
        implemented: ["native-state-worker", "durable-turns", "deduplicated-queue", "bounded-event-pages", "explicit-recovery", "read-only-Codex-protocol-prototype"],
        incomplete: ["full-harness-parity", "interactive-approvals", "history-migration", "Coding-Tools-engine-cutover", "AO-removal"] };
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, ...(result.passed === false ? { isError: true } : {}) } };
    } catch { return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Native compatibility test failed. Production state was not selected." }] } }; }
  };
}

async function serveStdio({ input = process.stdin, output = process.stdout, scratchRoot } = {}) {
  const handle = createCompatibilityPlugin({ scratchRoot });
  let pending = Buffer.alloc(0);
  const write = async value => { if (value && !output.write(JSON.stringify(value) + "\n")) await once(output, "drain"); };
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > 65536) throw new Error("MCP request is too large");
      const line = pending.subarray(0, newline).toString("utf8").trim();
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); }
      catch { await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      await write(await handle(request));
    }
    if (pending.length > 65536) throw new Error("MCP request is too large");
  }
}

module.exports = { createCompatibilityPlugin, serveStdio };
