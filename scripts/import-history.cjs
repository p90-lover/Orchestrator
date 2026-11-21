"use strict";

const { importOfflineHistory, rollbackOfflineHistory, readOfflineHistory, exportOfflineHistory } = require("../src/offline-history.cjs");

try {
  const [operation, ...argv] = process.argv.slice(2);
  const args = {};
  const allowed = {
    import: ["data-root", "export"], "import-ao": ["data-root", "export"], rollback: ["data-root", "export-id"],
    read: ["data-root", "export-id", "conversation-id", "after", "limit", "include-inactive"],
    export: ["data-root", "export-id", "include-inactive"],
  }[operation];
  if (!allowed || argv.length % 2) throw Object.assign(new Error("Use import, import-ao, rollback, read or export with explicit --data-root and --export/--export-id"), { code: "HISTORY_USAGE" });
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].slice(2);
    if (!argv[index].startsWith("--") || !allowed.includes(key) || Object.hasOwn(args, key)) throw Object.assign(new Error("Unknown or duplicate history option"), { code: "HISTORY_USAGE" });
    args[key] = argv[index + 1];
  }
  if (args["include-inactive"] !== undefined && !["true", "false"].includes(args["include-inactive"])) throw Object.assign(new Error("include-inactive must be true or false"), { code: "HISTORY_USAGE" });
  const options = { dataRoot: args["data-root"], exportFile: args.export, exportId: args["export-id"],
    ...(args["conversation-id"] === undefined ? {} : { conversationId: args["conversation-id"] }),
    ...(args.after === undefined ? {} : { after: Number(args.after) }), ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    includeInactive: args["include-inactive"] === "true" };
  const result = { import: importOfflineHistory, "import-ao": () => importOfflineHistory({ ...options, fromAo: true }),
    rollback: rollbackOfflineHistory, read: readOfflineHistory, export: exportOfflineHistory }[operation](options);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const known = typeof error?.code === "string" && error.code.startsWith("HISTORY_");
  process.stderr.write(JSON.stringify({ error: known ? error.code : "HISTORY_FAILED", message: known ? error.message : "Offline history operation failed; source export was not modified" }) + "\n");
  process.exitCode = 1;
}
