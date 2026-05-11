import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

/**
 * Tier 1.4 — dispatch CLI orchestration E2E.
 *
 * These tests wire a real control-plane on an ephemeral port + a stub sbx
 * binary + a tempdir workspace and walk the CLI through its full lifecycle.
 * The invariants locked here are the security-critical ones (registration
 * is always cleaned up; .mcp.json is only written after a successful register;
 * a non-zero agent exit propagates; a deregister leak surfaces as exit 70).
 */

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

const TOKEN = "a".repeat(64);
let TMP_ROOT: string;
let STUB_PATH: string;
let CALLS_FILE: string;

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
# Only honor SBX_STUB_FAIL_CREATE when first arg is "create"
if [[ "$1" == "create" && -n "$SBX_STUB_FAIL_CREATE" ]]; then
  exit "$SBX_STUB_FAIL_CREATE"
fi
if [[ "$1" == "exec" && -n "$SBX_STUB_EXEC_EXIT" ]]; then
  exit "$SBX_STUB_EXEC_EXIT"
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

interface Harness {
  registry: SessionRegistry;
  cpClient: ControlPlaneClient;
  sbxRunner: SbxRunner;
  server: Server;
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
      mintSessionId: () => "fixed1234fixed1234fixed1234fixed",
      hostEnv: envBase(),
    });
    expect(code).toBe(0);
    expect(harness.registry.size()).toBe(0);
    // .mcp.json must have been written with the right session ID
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
      mintSessionId: () => "exit42exit42exit42exit42exit42aa",
      hostEnv: envBase({ SBX_STUB_EXEC_EXIT: "42" }),
    });
    expect(code).toBe(42);
    expect(harness.registry.size()).toBe(0);
  });

  it("register fails (wrong token): no .mcp.json written, no sbx create, exit 66", async () => {
    harness = await buildHarness();
    const badClient = createControlPlaneClient({
      token: "b".repeat(64),
      baseUrl: harness.cpClient ? undefined : undefined,
      retryDelaysMs: [],
    });
    // Rebuild with a wrong-token client pointing at the real server.
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
      mintSessionId: () => "auth1auth1auth1auth1auth1auth1aa",
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
      mintSessionId: () => "crash1crash1crash1crash1crash1aa",
      hostEnv: envBase({ SBX_STUB_FAIL_CREATE: "1" }),
    });
    expect(code).toBe(EXIT_CODES.SBX_FAIL);
    expect(harness.registry.size()).toBe(0);
  });

  it("DELETE fails after retries: exits with cleanup-leak code 70 and logs a leak warning", async () => {
    // Build a custom control plane that always returns 5xx on DELETE so the
    // CLI's deregister exhausts its retry budget. POST still succeeds.
    const registry = createSessionRegistry();
    const realApp = createControlPlaneServer({ registry, token: TOKEN });
    // Wrap the real app with a router that intercepts DELETE before it hits realApp.
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
        mintSessionId: () => "leak1leak1leak1leak1leak1leak1aa",
        hostEnv: envBase(),
      });
      expect(code).toBe(EXIT_CODES.CLEANUP_LEAK);
      expect(registry.size()).toBe(1); // proves the leak: server still has it
      // Operator-visible warning must be emitted
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
      mintSessionId: () => "noTokenNoTokenNoTokenNoTokenNoTokenAA",
      hostEnv: hostEnvNoToken,
    });
    expect(code).toBe(EXIT_CODES.MISSING_TOKEN);
    expect(harness.registry.size()).toBe(0);
  });

  it("manifest with multiple agents in Tier 1.4: exit 64 (guardrail)", async () => {
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
      mintSessionId: () => "multi1multi1multi1multi1multi1aa",
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
      mintSessionId: () => "x".repeat(32),
      hostEnv: envBase(),
    });
    expect(code).toBe(EXIT_CODES.MANIFEST_INVALID);
  });
});
