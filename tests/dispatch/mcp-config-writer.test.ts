import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpConfig, MCP_CONFIG_FILENAME } from "../../src/dispatch/mcp-config-writer.js";

let TMP_ROOT: string;

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "ap-mcp-config-"));
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function freshWorkspace(): string {
  const ws = mkdtempSync(join(TMP_ROOT, "ws-"));
  return ws;
}

const SAMPLE = {
  sessionId: "1234567890abcdef1234567890abcdef",
  agentType: "reviewer",
  proxyUrl: "http://host.docker.internal:18923/mcp",
};

describe("writeMcpConfig", () => {
  it("writes a .mcp.json with the expected schema", () => {
    const ws = freshWorkspace();
    const written = writeMcpConfig({ workspace: ws, ...SAMPLE });
    expect(written).toBe(join(ws, MCP_CONFIG_FILENAME));
    const content = JSON.parse(readFileSync(written, "utf8"));
    expect(content).toEqual({
      mcpServers: {
        "agentic-press": {
          type: "http",
          url: SAMPLE.proxyUrl,
          headers: {
            "X-Agent-Session-Id": SAMPLE.sessionId,
            "X-Agent-Type": SAMPLE.agentType,
          },
        },
      },
    });
  });

  it("writes the file with mode 0644", () => {
    const ws = freshWorkspace();
    const written = writeMcpConfig({ workspace: ws, ...SAMPLE });
    const stat = statSync(written);
    // mask off file-type bits
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it("canonicalizes workspace through realpath before joining", () => {
    const realWs = freshWorkspace();
    const linkPath = join(TMP_ROOT, `link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(realWs, linkPath, "dir");
    const written = writeMcpConfig({ workspace: linkPath, ...SAMPLE });
    // Should be inside the real workspace, not under the symlink path.
    expect(written).toBe(join(realWs, MCP_CONFIG_FILENAME));
  });

  it("is a no-op when the existing file is identical", () => {
    const ws = freshWorkspace();
    const first = writeMcpConfig({ workspace: ws, ...SAMPLE });
    const before = statSync(first).mtimeMs;
    // Sleep tiny then re-run — mtime should not advance if no write occurred.
    const second = writeMcpConfig({ workspace: ws, ...SAMPLE });
    const after = statSync(second).mtimeMs;
    expect(before).toBe(after);
  });

  it("refuses to overwrite a conflicting .mcp.json without force", () => {
    const ws = freshWorkspace();
    writeFileSync(
      join(ws, MCP_CONFIG_FILENAME),
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x", args: [] } } }),
      "utf8"
    );
    expect(() => writeMcpConfig({ workspace: ws, ...SAMPLE })).toThrow(/already exists|--force/i);
  });

  it("overwrites a conflicting .mcp.json with force: true", () => {
    const ws = freshWorkspace();
    const path = join(ws, MCP_CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { type: "stdio" } } }), "utf8");
    const written = writeMcpConfig({ workspace: ws, ...SAMPLE, force: true });
    expect(written).toBe(path);
    const content = JSON.parse(readFileSync(written, "utf8"));
    expect(content.mcpServers["agentic-press"]).toBeDefined();
    expect(content.mcpServers.other).toBeUndefined();
  });
});
