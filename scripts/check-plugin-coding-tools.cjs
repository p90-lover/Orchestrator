"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");

async function main() {
  const appRoot = process.argv[2];
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) throw new Error("Provide an absolute trusted Coding Tools source checkout");
  const { createChatMcpServers } = require(path.join(appRoot, "desktop-electron/electron/chat-mcp-servers.cjs"));
  const appRequire = createRequire(path.join(appRoot, "runtime-web/package.json"));
  const { Client } = appRequire("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport, getDefaultEnvironment } = appRequire("@modelcontextprotocol/sdk/client/stdio.js");
  const parent = path.resolve(__dirname, "../aiTemp/host-plugin-check");
  await fs.mkdir(parent, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(parent, "case-"));
  let client;
  try {
    const options = { filePath: path.join(scratch, "chat-mcp-servers.json"), environment: {}, npmCacheRoots: [] };
    const store = createChatMcpServers(options);
    await store.preload();
    const entry = {
      name: "orchestrator-compat", type: "stdio", enabled: true,
      command: process.execPath,
      args: [path.resolve(__dirname, "mcp-plugin.cjs"), path.join(scratch, "probe")],
      env: { TEMP: scratch, TMP: scratch },
    };
    store.save(entry);
    await store.saved();
    const reloaded = createChatMcpServers(options);
    await reloaded.preload();
    const [launch] = reloaded.forSession("codex", [{ name: "coding-tools" }]);
    assert.equal(launch.name, entry.name);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, entry.args);
    const transport = new StdioClientTransport({
      command: launch.command, args: launch.args,
      env: { ...getDefaultEnvironment(), ...launch.env },
      cwd: scratch, stderr: "pipe", maxBufferSize: 1024 * 1024,
    });
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "coding-tools-plugin-contract-check", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport, { timeout: 30000 });
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map(tool => tool.name), ["orchestrator_status", "orchestrator_self_test"]);
    const status = await client.callTool({ name: "orchestrator_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.productionReady, false);
    const result = await client.callTool({ name: "orchestrator_self_test", arguments: {} }, undefined, { timeout: 30000 });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.passed, true);
    assert.equal(result.structuredContent.checks.persistedAfterRestart, true);
    assert.equal(result.structuredContent.liveModelUsed, false);
    console.log(JSON.stringify({ passed: true, scope: "isolated Coding Tools MCP registration, session injection and real stdio calls", checks: result.structuredContent.checks,
      installedAppChanged: false, liveChatTested: false, replacementEngineCompatible: false }, null, 2));
  } finally {
    try { await client?.close(); } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
