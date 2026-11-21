"use strict";

const { startCompatibilityHttp } = require("../src/http-compatibility-plugin.cjs");
const [scratchRoot, portArg, ...extra] = process.argv.slice(2);
const port = portArg === undefined ? 0 : /^\d{1,5}$/.test(portArg) ? Number(portArg) : NaN;
if (extra.length) {
  process.stderr.write("Use mcp-http-plugin.cjs with an isolated scratch directory and optional port.\n");
  process.exitCode = 1;
} else {
  startCompatibilityHttp({ scratchRoot, port, token: process.env.ORCHESTRATOR_COMPAT_TOKEN }).then(server => {
    process.stdout.write(`${server.url}\n`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void server.close(); });
  }).catch(() => {
    process.stderr.write("Could not start the compatibility plugin. Check the isolated scratch path, loopback port, and ORCHESTRATOR_COMPAT_TOKEN.\n");
    process.exitCode = 1;
  });
}
