import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSbxRunner } from "../../src/dispatch/sbx-runner.js";

/**
 * Tier 1.4 — sbx-runner tests.
 *
 * Security-critical invariant locked here: `execAgent` MUST NOT propagate
 * MCP_CONTROL_TOKEN (or any AP_TOKEN-prefixed var) into the sbx child process
 * environment. Defense-in-depth on top of sbx's own env isolation.
 */

let TMP_ROOT: string;
let STUB_BIN_DIR: string;
let STUB_PATH: string;
let CALLS_FILE: string;

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "ap-sbx-runner-"));
  STUB_BIN_DIR = join(TMP_ROOT, "bin");
  mkdirSync(STUB_BIN_DIR);
  STUB_PATH = join(STUB_BIN_DIR, "sbx");
  CALLS_FILE = join(TMP_ROOT, "calls.ndjson");

  // Stub sbx that:
  //  - emits a JSON line per invocation containing argv and full env
  //  - returns the value of $SBX_STUB_EXIT (default 0)
  //  - if first arg is "policy" and second "allow", prints fake UUIDs so
  //    allowNetwork's regex can extract them
  const stub = `#!/bin/bash
node -e '
const fs = require("fs");
fs.appendFileSync(process.env.SBX_STUB_CALLS, JSON.stringify({ argv: process.argv.slice(1), env: process.env }) + "\\n");
' -- "$@"
if [[ "$1" == "policy" && "$2" == "allow" ]]; then
  echo "Allowed network policy 11111111-2222-3333-4444-555555555555"
  echo "Allowed network policy aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
fi
exit "\${SBX_STUB_EXIT:-0}"
`;
  writeFileSync(STUB_PATH, stub, "utf8");
  chmodSync(STUB_PATH, 0o755);
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(CALLS_FILE)) rmSync(CALLS_FILE);
  writeFileSync(CALLS_FILE, "");
});

interface RecordedCall {
  argv: string[];
  env: Record<string, string>;
}

function readCalls(): RecordedCall[] {
  const raw = readFileSync(CALLS_FILE, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedCall);
}

function envBase(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SBX_STUB_CALLS: CALLS_FILE,
    ...extra,
  };
}

describe("sbx-runner", () => {
  it("createSandbox invokes `sbx create --name <n> shell <ws>`", async () => {
    const runner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    await runner.createSandbox({ name: "ap-test", workspace: "/some/ws" });
    const calls = readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["create", "--name", "ap-test", "shell", "/some/ws"]);
  });

  it("createSandbox appends extraSbxArgs after the default flags", async () => {
    const runner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    await runner.createSandbox({ name: "ap-test", workspace: "/ws", extraArgs: ["--cpu", "2"] });
    const calls = readCalls();
    expect(calls[0].argv).toEqual(["create", "--name", "ap-test", "shell", "/ws", "--cpu", "2"]);
  });

  it("allowNetwork parses policy UUIDs from stub output", async () => {
    const runner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    const { policyIds } = await runner.allowNetwork(18923);
    expect(policyIds).toEqual([
      "11111111-2222-3333-4444-555555555555",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ]);
    const calls = readCalls();
    expect(calls[0].argv).toEqual([
      "policy",
      "allow",
      "network",
      "host.docker.internal:18923,localhost:18923",
    ]);
  });

  it("execAgent propagates non-zero exit codes without throwing", async () => {
    const runner = createSbxRunner({
      sbxBinary: STUB_PATH,
      hostEnv: envBase({ SBX_STUB_EXIT: "42" }),
    });
    const { exitCode } = await runner.execAgent({ name: "ap-test", command: ["claude"] });
    expect(exitCode).toBe(42);
  });

  it("execAgent STRIPS MCP_CONTROL_TOKEN and AP_TOKEN_* from child env (threat row 3)", async () => {
    const runner = createSbxRunner({
      sbxBinary: STUB_PATH,
      hostEnv: envBase({
        MCP_CONTROL_TOKEN: "should-never-reach-child-abcdef1234567890",
        AP_TOKEN_SECRET: "also-should-never-reach-abcdef",
      }),
    });
    await runner.execAgent({ name: "ap-test", command: ["claude"] });
    const calls = readCalls();
    const childEnv = calls[0].env;
    expect(childEnv.MCP_CONTROL_TOKEN).toBeUndefined();
    expect(childEnv.AP_TOKEN_SECRET).toBeUndefined();
    // Token bytes do not appear ANYWHERE in the child env, even smuggled
    // into another var:
    const envBlob = JSON.stringify(childEnv);
    expect(envBlob).not.toContain("should-never-reach-child-abcdef1234567890");
    expect(envBlob).not.toContain("also-should-never-reach-abcdef");
  });

  it("tearDown calls sbx stop, sbx rm, and sbx policy rm for each policy ID; tolerates errors", async () => {
    const runner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    await runner.tearDown({
      name: "ap-test",
      policyIds: ["11111111-2222-3333-4444-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });
    const calls = readCalls();
    const subcommands = calls.map((c) => c.argv.slice(0, 3).join(" "));
    expect(subcommands).toContain("stop ap-test");
    expect(subcommands).toContain("rm ap-test");
    expect(subcommands.some((s) => s.startsWith("policy rm"))).toBe(true);
  });
});
