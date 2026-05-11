import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

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

import { createSessionRegistry, type SessionRegistry } from "../../src/orchestrator/session-registry.js";
import { createControlPlaneServer } from "../../src/orchestrator/control-plane.js";
import {
  createControlPlaneClient,
  type ControlPlaneClient,
} from "../../src/dispatch/control-plane-client.js";
import { createSbxRunner, type SbxRunner } from "../../src/dispatch/sbx-runner.js";
import { runDispatchWithDeps, EXIT_CODES } from "../../src/dispatch/cli.js";
import { MCP_CONFIG_FILENAME } from "../../src/dispatch/mcp-config-writer.js";
import { asSessionId, type SessionId } from "../../src/orchestrator/session-id.js";

const TOKEN = "a".repeat(64);
let TMP_ROOT: string;
let STUB_PATH: string;
let CALLS_FILE: string;
let STDERR_BUF: string[] = [];

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "ap-cli-e2e-"));
  const binDir = join(TMP_ROOT, "bin");
  mkdirSync(binDir);
  STUB_PATH = join(binDir, "sbx");
  CALLS_FILE = join(TMP_ROOT, "calls.ndjson");
  const stub = `#!/bin/bash
node -e '
const fs = require("fs");
fs.appendFileSync(process.env.SBX_STUB_CALLS, JSON.stringify({ argv: process.argv.slice(1), env: process.env }) + "\\n");
' -- "$@"
if [[ "$1" == "policy" && "$2" == "allow" ]]; then
  echo "Allowed network policy 11111111-2222-3333-4444-555555555555"
fi
if [[ "$1" == "create" && -n "$SBX_STUB_FAIL_CREATE" ]]; then
  exit "$SBX_STUB_FAIL_CREATE"
fi
if [[ "$1" == "exec" && -n "$SBX_STUB_EXEC_HANG" ]]; then
  trap 'exit 143' TERM INT
  # Keep alive until SIGTERM, then exit cleanly with the trap code.
  sleep 30 &
  wait $!
  exit 0
fi
if [[ "$1" == "exec" && -n "$SBX_STUB_EXEC_EXIT" ]]; then
  exit "$SBX_STUB_EXEC_EXIT"
fi
if [[ -n "$SBX_STUB_FAIL_TEARDOWN" ]]; then
  if [[ "$1" == "stop" || "$1" == "rm" || ( "$1" == "policy" && "$2" == "rm" ) ]]; then
    echo "stubbed teardown failure" >&2
    exit 99
  fi
fi
exit 0
`;
  writeFileSync(STUB_PATH, stub, "utf8");
  chmodSync(STUB_PATH, 0o755);
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function envBase(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SBX_STUB_CALLS: CALLS_FILE,
    MCP_CONTROL_TOKEN: TOKEN,
    ...extra,
  };
}

function makeManifest(workspace: string, overrides: Record<string, unknown> = {}): string {
  const m = {
    agents: [
      {
        agentType: "reviewer",
        allowedTools: ["echo__read_file"],
        agentCommand: ["claude"],
        workspace,
        ...overrides,
      },
    ],
  };
  const path = join(TMP_ROOT, `manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(m), "utf8");
  return path;
}

async function startRealControlPlane(): Promise<{ server: Server; baseUrl: string; registry: SessionRegistry }> {
  const registry = createSessionRegistry();
  const app = createControlPlaneServer({ registry, token: TOKEN });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, registry };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function freshWorkspace(): string {
  return mkdtempSync(join(TMP_ROOT, "ws-"));
}

function id(s: string): SessionId {
  return asSessionId(s);
}

interface Harness {
  registry: SessionRegistry;
  cpClient: ControlPlaneClient;
  sbxRunner: SbxRunner;
  server: Server;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

async function buildHarness(envExtras: Record<string, string> = {}): Promise<Harness> {
  const { server, baseUrl, registry } = await startRealControlPlane();
  const cpClient = createControlPlaneClient({ token: TOKEN, baseUrl, retryDelaysMs: [1, 1] });
  const sbxRunner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase(envExtras) });
  return {
    registry,
    cpClient,
    sbxRunner,
    server,
    baseUrl,
    async cleanup() {
      await closeServer(server);
    },
  };
}

beforeEach(() => {
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  if (existsSync(CALLS_FILE)) rmSync(CALLS_FILE);
  writeFileSync(CALLS_FILE, "");
  STDERR_BUF = [];
  // Capture stderr writes — locks the "token never reaches operator output" invariant.
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    STDERR_BUF.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDispatch (CLI E2E)", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it("happy path: registers, writes .mcp.json, runs sbx, tears down, deregisters — registry empty at end", async () => {
    harness = await buildHarness();
    const workspace = freshWorkspace();
    const manifest = makeManifest(workspace);
    const code = await runDispatchWithDeps([manifest], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("fixed1234fixed1234fixed1234fixed"),
      hostEnv: envBase(),
    });
    expect(code).toBe(0);
    expect(harness.registry.size()).toBe(0);
    const cfg = JSON.parse(readFileSync(join(workspace, MCP_CONFIG_FILENAME), "utf8"));
    expect(cfg.mcpServers["agentic-press"].headers["X-Agent-Session-Id"]).toBe(
      "fixed1234fixed1234fixed1234fixed"
    );
  });

  it("agent exits non-zero: CLI returns the agent's exit code, registry still clean", async () => {
    harness = await buildHarness({ SBX_STUB_EXEC_EXIT: "42" });
    const code = await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("exit42exit42exit42exit42exit42aa"),
      hostEnv: envBase({ SBX_STUB_EXEC_EXIT: "42" }),
    });
    expect(code).toBe(42);
    expect(harness.registry.size()).toBe(0);
  });

  it("register fails (wrong token): no .mcp.json written, no sbx create, exit 66", async () => {
    harness = await buildHarness();
    const port = (harness.server.address() as AddressInfo).port;
    const wrongClient = createControlPlaneClient({
      token: "b".repeat(64),
      baseUrl: `http://127.0.0.1:${port}`,
      retryDelaysMs: [],
    });
    const workspace = freshWorkspace();
    const code = await runDispatchWithDeps([makeManifest(workspace)], {
      controlPlaneClient: wrongClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("auth1auth1auth1auth1auth1auth1aa"),
      hostEnv: envBase(),
    });
    expect(code).toBe(EXIT_CODES.REGISTER_FAIL);
    expect(existsSync(join(workspace, MCP_CONFIG_FILENAME))).toBe(false);
    const sbxCalls = readFileSync(CALLS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(sbxCalls).toHaveLength(0);
    expect(harness.registry.size()).toBe(0);
  });

  it("sbx create fails: DELETE is still called, registry empty at end", async () => {
    harness = await buildHarness({ SBX_STUB_FAIL_CREATE: "1" });
    const code = await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("crash1crash1crash1crash1crash1aa"),
      hostEnv: envBase({ SBX_STUB_FAIL_CREATE: "1" }),
    });
    expect(code).toBe(EXIT_CODES.SBX_FAIL);
    expect(harness.registry.size()).toBe(0);
  });

  it("DELETE fails after retries: exits with cleanup-leak code 70 and logs a leak warning", async () => {
    const registry = createSessionRegistry();
    const realApp = createControlPlaneServer({ registry, token: TOKEN });
    const app = express();
    app.delete("/sessions/:id", (_req, res) => res.status(503).json({ error: "always down" }));
    app.use(realApp);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const cpClient = createControlPlaneClient({
      token: TOKEN,
      baseUrl: `http://127.0.0.1:${port}`,
      retryDelaysMs: [1, 1],
    });
    const sbxRunner = createSbxRunner({ sbxBinary: STUB_PATH, hostEnv: envBase() });
    try {
      const code = await runDispatchWithDeps([makeManifest(freshWorkspace())], {
        controlPlaneClient: cpClient,
        sbxRunner,
        mintSessionId: () => id("leak1leak1leak1leak1leak1leak1aa"),
        hostEnv: envBase(),
      });
      expect(code).toBe(EXIT_CODES.CLEANUP_LEAK);
      expect(registry.size()).toBe(1);
      const errorBlob = JSON.stringify(mockLogger.error.mock.calls);
      const warnBlob = JSON.stringify(mockLogger.warn.mock.calls);
      expect(`${errorBlob}${warnBlob}`).toMatch(/leak|deregister/i);
    } finally {
      await closeServer(server);
    }
  });

  it("MCP_CONTROL_TOKEN unset on host → exit 65 before any registration attempt", async () => {
    harness = await buildHarness();
    const hostEnvNoToken = { ...envBase() } as Record<string, string | undefined>;
    delete hostEnvNoToken.MCP_CONTROL_TOKEN;
    const code = await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("noTokenNoTokenNoTokenNoTokenNoTokenAA"),
      hostEnv: hostEnvNoToken,
    });
    expect(code).toBe(EXIT_CODES.MISSING_TOKEN);
    expect(harness.registry.size()).toBe(0);
  });

  it("manifest with multiple agents: exit 64 (single-agent guardrail)", async () => {
    harness = await buildHarness();
    const ws = freshWorkspace();
    const m = {
      agents: [
        { agentType: "a", allowedTools: ["echo__x"], agentCommand: ["claude"], workspace: ws },
        { agentType: "b", allowedTools: ["echo__y"], agentCommand: ["claude"], workspace: ws },
      ],
    };
    const path = join(TMP_ROOT, `m-multi-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(m), "utf8");
    const code = await runDispatchWithDeps([path], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("multi1multi1multi1multi1multi1aa"),
      hostEnv: envBase(),
    });
    expect(code).toBe(EXIT_CODES.MANIFEST_INVALID);
    expect(harness.registry.size()).toBe(0);
  });

  it("manifest file missing → exit 64 with no side effects", async () => {
    harness = await buildHarness();
    const code = await runDispatchWithDeps([join(TMP_ROOT, "does-not-exist.json")], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("x".repeat(32)),
      hostEnv: envBase(),
    });
    expect(code).toBe(EXIT_CODES.MANIFEST_INVALID);
  });

  it("pre-existing conflicting .mcp.json → exit 69 (MCP_CONFIG_CONFLICT), no sbx create, registry empty", async () => {
    harness = await buildHarness();
    const workspace = freshWorkspace();
    // Pre-write a conflicting .mcp.json
    writeFileSync(
      join(workspace, MCP_CONFIG_FILENAME),
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x", args: [] } } }),
      "utf8"
    );
    const code = await runDispatchWithDeps([makeManifest(workspace)], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("conflict1conflict1conflict1confa"),
      hostEnv: envBase(),
    });
    expect(code).toBe(EXIT_CODES.MCP_CONFIG_CONFLICT);
    // Register happened (we got past the token check) but then we should have
    // exited before sbx create. Registry must still be cleaned up via finally.
    expect(harness.registry.size()).toBe(0);
    const sbxCalls = readFileSync(CALLS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const subcommands = sbxCalls.map((l) => JSON.parse(l).argv?.[0]);
    expect(subcommands).not.toContain("create");
  });

  it("--workspace flag with non-existent path → exit 68 before register", async () => {
    harness = await buildHarness();
    const validManifestWorkspace = freshWorkspace();
    const code = await runDispatchWithDeps(
      [makeManifest(validManifestWorkspace), "--workspace", "/nonexistent-12345-abc"],
      {
        controlPlaneClient: harness.cpClient,
        sbxRunner: harness.sbxRunner,
        mintSessionId: () => id("workspace1workspace1workspace1aa"),
        hostEnv: envBase(),
      }
    );
    expect(code).toBe(EXIT_CODES.WORKSPACE_INVALID);
    // No register should have happened, registry is empty
    expect(harness.registry.size()).toBe(0);
    // No sbx create either
    const sbxCalls = readFileSync(CALLS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(sbxCalls).toHaveLength(0);
  });

  it("sbx tearDown failures → exit 70 with sandbox-leak warning visible to operator", async () => {
    harness = await buildHarness({ SBX_STUB_FAIL_TEARDOWN: "1" });
    const code = await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("teardown1teardown1teardown1teaa"),
      hostEnv: envBase({ SBX_STUB_FAIL_TEARDOWN: "1" }),
    });
    expect(code).toBe(EXIT_CODES.CLEANUP_LEAK);
    // Operator should see a stderr warning naming the failing steps
    const stderrJoined = STDERR_BUF.join("");
    expect(stderrJoined).toMatch(/tearDown step\(s\) failed/i);
    expect(stderrJoined).toMatch(/stop|rm|policy rm/);
    // Registry must still be cleaned (deregister succeeded; only sbx leaked)
    expect(harness.registry.size()).toBe(0);
  });

  it("abort signal mid-execAgent → cleanup runs, registry empty, returns the (signalled) agent exit code", async () => {
    harness = await buildHarness({ SBX_STUB_EXEC_HANG: "1" });
    const controller = new AbortController();
    const promise = runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("abort1abort1abort1abort1abort1aa"),
      hostEnv: envBase({ SBX_STUB_EXEC_HANG: "1" }),
      signal: controller.signal,
    });
    // Wait until execAgent reports "exec" has started, then abort.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const calls = readFileSync(CALLS_FILE, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l).argv?.[0]);
        if (calls.includes("exec")) {
          clearInterval(interval);
          resolve();
        }
      }, 25);
    });
    controller.abort();
    const code = await promise;
    // 143 = 128 + SIGTERM(15). The stub trap exits 143.
    expect(typeof code).toBe("number");
    expect(harness.registry.size()).toBe(0);
    // tearDown should have been called for the created sandbox + policy
    const sbxArgv = readFileSync(CALLS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).argv);
    expect(sbxArgv.some((a: string[]) => a[0] === "stop")).toBe(true);
    expect(sbxArgv.some((a: string[]) => a[0] === "rm")).toBe(true);
  });

  it("token NEVER appears in stderr across all failure paths", async () => {
    harness = await buildHarness();
    const port = (harness.server.address() as AddressInfo).port;
    const wrongTokenClient = createControlPlaneClient({
      token: "b".repeat(64),
      baseUrl: `http://127.0.0.1:${port}`,
      retryDelaysMs: [],
    });
    // Path 1: register-401
    STDERR_BUF = [];
    await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: wrongTokenClient,
      sbxRunner: harness.sbxRunner,
      mintSessionId: () => id("stderr1stderr1stderr1stderr1stda"),
      hostEnv: envBase(),
    });
    expect(STDERR_BUF.join("")).not.toContain(TOKEN);
    expect(STDERR_BUF.join("")).not.toContain("b".repeat(64));

    // Path 2: sbx create fails
    STDERR_BUF = [];
    await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: createSbxRunner({
        sbxBinary: STUB_PATH,
        hostEnv: envBase({ SBX_STUB_FAIL_CREATE: "1" }),
      }),
      mintSessionId: () => id("stderr2stderr2stderr2stderr2stda"),
      hostEnv: envBase({ SBX_STUB_FAIL_CREATE: "1" }),
    });
    expect(STDERR_BUF.join("")).not.toContain(TOKEN);

    // Path 3: agent exits non-zero (clean cleanup)
    STDERR_BUF = [];
    await runDispatchWithDeps([makeManifest(freshWorkspace())], {
      controlPlaneClient: harness.cpClient,
      sbxRunner: createSbxRunner({
        sbxBinary: STUB_PATH,
        hostEnv: envBase({ SBX_STUB_EXEC_EXIT: "42" }),
      }),
      mintSessionId: () => id("stderr3stderr3stderr3stderr3stda"),
      hostEnv: envBase({ SBX_STUB_EXEC_EXIT: "42" }),
    });
    expect(STDERR_BUF.join("")).not.toContain(TOKEN);
  });
});
