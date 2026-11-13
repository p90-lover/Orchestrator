"use strict";
const path = require("node:path");
const { serveStdio } = require("../src/compatibility-plugin.cjs");
const scratchRoot = process.argv[2];
if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) {
  process.stderr.write("Provide an explicit absolute scratch directory for isolated compatibility tests.\n");
  process.exitCode = 1;
} else {
  serveStdio({ scratchRoot }).catch(() => { process.stderr.write("Orchestrator test plugin stopped.\n"); process.exitCode = 1; });
}
