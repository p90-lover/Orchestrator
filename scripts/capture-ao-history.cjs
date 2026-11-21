"use strict";

const { captureAoHistory } = require("../src/ao-snapshot-capture.cjs");

const args = process.argv.slice(2);
if (args.length !== 6) {
  process.stderr.write("Usage: capture-ao-history.cjs <isolated-loopback-origin> <source-commit> <session-id> <workspace-id> <export-id> <new-absolute-json-file>; provide AO_CAPTURE_TOKEN separately.\n");
  process.exitCode = 1;
} else {
  const [origin, sourceCommit, sessionId, workspaceId, exportId, file] = args;
  captureAoHistory({ origin, sourceCommit, sessionId, workspaceId, exportId, file, token: process.env.AO_CAPTURE_TOKEN }).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n");
  }, error => {
    const known = typeof error?.code === "string" && error.code.startsWith("HISTORY_");
    process.stderr.write(JSON.stringify({ error: known ? error.code : "HISTORY_CAPTURE_FAILED",
      message: known ? error.message : "The AO capture did not complete" }) + "\n");
    process.exitCode = 1;
  });
}
