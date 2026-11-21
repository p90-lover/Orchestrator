"use strict";

const fail = message => Object.assign(new Error(message), { code: "INVALID_SESSION_CONFIG" });
const FIELDS = new Set(["model", "effort", "contextWindow", "approvalMode", "plain", "subagent", "engineVersion"]);
function sessionConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.has(key))) throw fail("Session settings contain unsupported or secret-bearing fields");
  const result = {};
  for (const key of [...FIELDS].sort()) {
    const item = value[key];
    if (item === undefined || item === null) continue;
    if (["plain", "subagent"].includes(key)) {
      if (typeof item !== "boolean") throw fail("Session flags must be boolean");
    } else if (key === "contextWindow") {
      if (!Number.isSafeInteger(item) || item < 0 || item > 10_000_000) throw fail("Invalid context window");
    } else if (typeof item !== "string" || !item || item.length > 256 || /[\x00-\x1f]/.test(item)) throw fail("Invalid session setting");
    result[key] = item;
  }
  return result;
}
module.exports = { sessionConfig };
