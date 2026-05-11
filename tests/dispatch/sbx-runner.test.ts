import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));

import { createSbxRunner } from "../../src/dispatch/sbx-runner.js";

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

  const stub = `#!/bin/bash
node -e '
const fs = require("fs");
fs.appendFileSync(process.env.SBX_STUB_CALLS, JSON.stringify({ argv: process.argv.slice(1), env: process.env }) + "\\n");
' -- "$@"
if [[ "$1" == "policy" && "$2" == "allow" ]]; then
  if [[ -n "$SBX_STUB_POLICY_SILENT" ]]; then
    echo "ok but no uuids"
  else
    echo "Allowed network policy 11111111-2222-3333-4444-555555555555"
    echo "Allowed network policy aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  fi
fi
if [[ -n "$SBX_STUB_FAIL_TEARDOWN" ]]; then
  if [[ "$1" == "stop" || "$1" == "rm" || ( "$1" == "policy" && "$2" == "rm" ) ]]; then
    echo "stubbed teardown failure" >&2
    exit 99
  fi
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
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
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

  it("execAgent STRIPS MCP_CONTROL_TOKEN and AP_TOKEN_* from child env (token-theft defence)", async () => {
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

  it("tearDown calls sbx stop, sbx rm, and sbx policy rm for each policy ID; success returns empty failures", async () => {
    const runner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    const result = await runner.tearDown({
      name: "ap-test",
      policyIds: ["11111111-2222-3333-4444-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });
    const calls = readCalls();
    const subcommands = calls.map((c) => c.argv.slice(0, 3).join(" "));
    expect(subcommands).toContain("stop ap-test");
    expect(subcommands).toContain("rm ap-test");
    expect(subcommands.some((s) => s.startsWith("policy rm"))).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("allowNetwork warns when exit 0 but no UUIDs extracted (sbx output format drift)", async () => {
    const runner = createSbxRunner({
      sbxBinary: STUB_PATH,
      hostEnv: envBase({ SBX_STUB_POLICY_SILENT: "1" }),
    });
    const { policyIds } = await runner.allowNetwork(18923);
    expect(policyIds).toEqual([]);
    const warnBlob = JSON.stringify(mockLogger.warn.mock.calls);
    expect(warnBlob).toMatch(/zero policy IDs|format may have changed|extract/i);
  });

  it("FORBIDDEN_ENV_PREFIXES wins over ALLOWED_ENV_KEYS — MCP_CONTROL_X never reaches child", async () => {
    // Even if a future change adds MCP_CONTROL_FOO to the allow-list, the
    // forbidden-prefix check fires first.
    const runner = createSbxRunner({
      sbxBinary: STUB_PATH,
      hostEnv: envBase({
        MCP_CONTROL_FOO: "should-not-leak-a-secret-string",
        AP_TOKEN_X: "another-should-not-leak",
      }),
    });
    await runner.execAgent({ name: "ap-test", command: ["claude"] });
    const calls = readCalls();
    const childEnv = calls[0].env;
    expect(childEnv.MCP_CONTROL_FOO).toBeUndefined();
    expect(childEnv.AP_TOKEN_X).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain("should-not-leak-a-secret-string");
    expect(JSON.stringify(childEnv)).not.toContain("another-should-not-leak");
  });

  it("signal-killed child reports 128 + signum (POSIX convention) instead of -1", async () => {
    // Write a stub that traps SIGTERM and exits naturally, then a separate stub
    // that ignores its args and gets SIGKILLed via AbortSignal — verify the
    // exit-code mapping is 128 + signum.
    const hangStubPath = join(STUB_BIN_DIR, "sbx-hang");
    writeFileSync(
      hangStubPath,
      `#!/bin/bash\nsleep 30 &\nwait $!\n`,
      "utf8"
    );
    chmodSync(hangStubPath, 0o755);
    const runner = createSbxRunner({ sbxBinary: hangStubPath, hostEnv: envBase() });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const { exitCode } = await runner.execAgent({
      name: "ap-test",
      command: ["whatever"],
      signal: controller.signal,
    });
    // SIGTERM = 15 → 143. Could also see SIGINT (130) or SIGKILL (137) on
    // shells that don't forward; accept any 128+ signum.
    expect(exitCode).toBeGreaterThanOrEqual(128);
    expect(exitCode).toBeLessThanOrEqual(200);
  });

  it("tearDown collects per-step failures with name + policyId so a leak is observable", async () => {
    const runner = createSbxRunner({
      sbxBinary: STUB_PATH,
      hostEnv: envBase({ SBX_STUB_FAIL_TEARDOWN: "1" }),
    });
    const result = await runner.tearDown({
      name: "ap-leak",
      policyIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });
    expect(result.failures.length).toBe(3); // stop + rm + 1 policy rm
    const labels = result.failures.map((f) => f.label);
    expect(labels).toContain("stop");
    expect(labels).toContain("rm");
    expect(labels).toContain("policy rm");
    for (const f of result.failures) {
      expect(f.name).toBe("ap-leak");
      expect(f.message).toMatch(/teardown failure|exit 99/);
    }
    const policyFailure = result.failures.find((f) => f.label === "policy rm");
    expect(policyFailure?.policyId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
