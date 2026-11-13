"use strict";
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "echo") process.stdout.write(JSON.stringify({ id: message.id, result: message.params }) + "\n");
  if (message.method === "exit") process.exit(1);
  if (message.method === "malformed") process.stdout.write("not-json\n");
  if (message.method === "request") {
    process.stdout.write(JSON.stringify({ id: "server-request", method: "permission", params: {} }) + "\n");
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  }
});
