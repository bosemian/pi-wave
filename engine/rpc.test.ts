// Tests for the pi RPC client against a fake `pi --mode rpc` (no network,
// no real pi required). Run from the repo root: npm test

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeFakePi } from "./fake-pi.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-rpc-"));
// Read once at import time by rpc.ts, so set it before the dynamic import.
process.env.PI_WAVE_MCP_ADAPTER = path.join(tmp, "no-such-adapter.ts");
const { PiRpcError, PiRpcSession, listPiModels, mcpFlags } = await import("./rpc.ts");
const { AgentTimeoutError } = await import("./errors.ts");

const piBin = writeFakePi(tmp);
const argvFile = path.join(tmp, "argv.json");
process.env.FAKE_PI_ARGV = argvFile;

const sessions: InstanceType<typeof PiRpcSession>[] = [];

function session(mode: string, over: Record<string, unknown> = {}) {
  process.env.FAKE_PI_MODE = mode;
  const events: unknown[] = [];
  const s = new PiRpcSession({
    agentName: "wave-1-code",
    cwd: tmp,
    model: "kimi-coding/k3",
    thinking: "low",
    onEvent: (name, ev) => events.push({ name, ...ev }),
    piBin,
    ...over,
  });
  sessions.push(s);
  return { s, events };
}

afterEach(async () => {
  delete process.env.FAKE_PI_MODEL_ID;
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("PiRpcSession", () => {
  it("starts pi with the recursion guard and the requested model", async () => {
    const { s } = session("ok", { provider: "kimi-coding" });
    const state = await s.start();
    s.verifyModel(state);
    assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), [
      "--mode", "rpc", "--no-session", "--model", "kimi-coding/k3", "--thinking", "low",
      "--provider", "kimi-coding", "--no-extensions",
    ]);
  });

  it("omits --no-extensions when load_extensions is set", async () => {
    const { s } = session("ok", { loadExtensions: true });
    await s.start();
    assert.ok(!JSON.parse(readFileSync(argvFile, "utf8")).includes("--no-extensions"));
  });

  it("verifyModel rejects a model pi resolved differently", async () => {
    process.env.FAKE_PI_MODEL_ID = "gemini-3";
    const { s } = session("ok");
    const state = await s.start();
    assert.throws(() => s.verifyModel(state), (e: Error) =>
      e instanceof PiRpcError && e.message.includes("model mismatch") && e.message.includes("'gemini-3'"));
  });

  it("prompts until agent_settled, reporting turns and the final text", async () => {
    const { s, events } = session("ok");
    await s.start();
    await s.promptAndSettle("hi there", 5);
    assert.equal(await s.lastText(), "echo: hi there");
    assert.deepEqual(events, [
      { name: "wave-1-code", type: "progress", turn: 1 },
      { name: "wave-1-code", type: "progress", turn: 2 },
    ]);
    assert.deepEqual(await s.stats(), { tokens: { input: 10, output: 5 }, cost: 0.25 });
  });

  it("falls back to get_last_assistant_text without a message_end", async () => {
    const { s } = session("no-message");
    await s.start();
    await s.promptAndSettle("hi", 5);
    assert.equal(await s.lastText(), "from get_last_assistant_text");
  });

  it("times out a prompt that never settles, after aborting it", async () => {
    const { s } = session("hang");
    await s.start();
    await assert.rejects(s.promptAndSettle("hi", 0.3), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("did not settle within 0s"));
  });

  it("surfaces an unexpected exit with the stderr tail", async () => {
    const { s } = session("crash");
    await s.start();
    await assert.rejects(s.promptAndSettle("hi", 5), (e: Error) =>
      e instanceof PiRpcError && e.message.includes("exited unexpectedly") &&
      e.message.includes("provider exploded"));
    // later calls on the dead session fail fast instead of hanging
    await assert.rejects(s.request({ type: "get_state" }, 5), PiRpcError);
    assert.deepEqual(await s.stats(), {});
  });

  it("raises on a success:false response", async () => {
    const { s } = session("fail");
    await assert.rejects(s.start(), (e: Error) =>
      e instanceof PiRpcError && e.message.includes("get_state failed: boom"));
  });

  it("reports a missing pi binary instead of hanging", async () => {
    const { s } = session("ok", { piBin: path.join(tmp, "no-such-pi") });
    await assert.rejects(s.start(), (e: Error) =>
      e instanceof PiRpcError && e.message.includes("ENOENT"));
  });

  it("close terminates the process", async () => {
    const { s } = session("hang");
    await s.start();
    await s.close();
    assert.ok(s.proc!.exitCode !== null || s.proc!.signalCode !== null);
    await s.close(); // idempotent
  });

  it("refuses requests before start", async () => {
    const { s } = session("ok");
    await assert.rejects(s.request({ type: "get_state" }), /session not started/);
  });
});

describe("mcpFlags", () => {
  it("is empty without an mcp_config", () => {
    assert.deepEqual(mcpFlags(""), []);
  });

  it("requires the pi-mcp-adapter entry", () => {
    assert.throws(() => mcpFlags("~/mcp.json"), /pi-mcp-adapter/);
  });

  it("loads only the adapter and expands ~", () => {
    const entry = process.env.PI_WAVE_MCP_ADAPTER!;
    writeFileSync(entry, "");
    assert.deepEqual(mcpFlags("~/mcp.json"), [
      "--no-extensions", "-e", entry, "--mcp-config", path.join(os.homedir(), "mcp.json"),
    ]);
  });
});

describe("listPiModels", () => {
  it("parses pi --list-models into provider/model ids", async () => {
    assert.deepEqual(
      await listPiModels(piBin),
      new Set(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.5", "kimi-coding/k3"]),
    );
  });

  it("returns null when pi cannot be run", async () => {
    assert.equal(await listPiModels(path.join(tmp, "no-such-pi")), null);
  });
});
