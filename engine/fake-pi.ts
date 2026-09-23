// Test helper: a fake `pi --mode rpc` that speaks just enough of the RPC
// protocol. FAKE_PI_MODE picks a scenario; argv is recorded to FAKE_PI_ARGV
// and the pid to FAKE_PI_PIDFILE when those are set.

import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_PI_MODE || "ok";
if (process.env.FAKE_PI_ARGV) fs.writeFileSync(process.env.FAKE_PI_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_PI_PIDFILE) fs.writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));
if (process.argv.includes("--list-models")) {
  process.stdout.write("provider      model         context  max-out  thinking  images\\n" +
    "openai-codex  gpt-5.6-luna  272K     128K     yes       yes\\n" +
    "openai-codex  gpt-5.5       272K     128K     yes       yes\\n" +
    "kimi-coding   k3            256K     32K      yes       no\\n");
  process.exit(0);
}
const model = process.argv[process.argv.indexOf("--model") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\r\\n");
const reply = (cmd, data, extra = {}) =>
  out({ type: "response", id: cmd.id, command: cmd.type, success: true, data, ...extra });
process.stdout.write("not json, ignored\\n\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    handle(cmd);
  }
});
function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      if (mode === "fail") return out({ type: "response", id: cmd.id, success: false, error: "boom" });
      return reply(cmd, { model: { id: process.env.FAKE_PI_MODEL_ID || model.split("/").pop() } });
    case "prompt":
      reply(cmd);
      if (mode === "crash") {
        process.stderr.write("fatal: provider exploded\\n");
        process.exit(3);
      }
      if (mode === "hang") return;
      out({ type: "turn_end" });
      if (mode !== "no-message") {
        out({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "echo: " }, { type: "tool" }, { type: "text", text: cmd.message }] } });
      }
      out({ type: "turn_end" });
      return out({ type: "agent_settled" });
    case "abort":
      reply(cmd);
      return out({ type: "agent_settled" });
    case "get_last_assistant_text":
      return reply(cmd, { text: "from get_last_assistant_text" });
    case "get_session_stats":
      return reply(cmd, { tokens: { input: 10, output: 5 }, cost: 0.25 });
  }
}
`;
/** Write the fake as an executable named `pi` in dir; returns its path. */
export function writeFakePi(dir: string): string {
  const bin = path.join(dir, "pi");
  writeFileSync(bin, FAKE_PI);
  chmodSync(bin, 0o755);
  return bin;
}
