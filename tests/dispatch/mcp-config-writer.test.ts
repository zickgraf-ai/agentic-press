import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpConfig, MCP_CONFIG_FILENAME, McpConfigConflictError } from "../../src/dispatch/mcp-config-writer.js";
import { asSessionId } from "../../src/orchestrator/session-id.js";

let TMP_ROOT: string;

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "ap-mcp-config-"));
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function freshWorkspace(): string {
  return mkdtempSync(join(TMP_ROOT, "ws-"));
}

const SAMPLE = {
  sessionId: asSessionId("1234567890abcdef1234567890abcdef"),
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
    expect(statSync(written).mode & 0o777).toBe(0o644);
  });

  it("canonicalizes workspace through realpath before joining", () => {
    const realWs = freshWorkspace();
    const linkPath = join(TMP_ROOT, `link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(realWs, linkPath, "dir");
    const written = writeMcpConfig({ workspace: linkPath, ...SAMPLE });
    expect(written).toBe(join(realWs, MCP_CONFIG_FILENAME));
  });

  it("repeats are idempotent: identical content doesn't bump mtime", () => {
    const ws = freshWorkspace();
    const first = writeMcpConfig({ workspace: ws, ...SAMPLE });
    const before = statSync(first).mtimeMs;
    const second = writeMcpConfig({ workspace: ws, ...SAMPLE });
    const after = statSync(second).mtimeMs;
    expect(before).toBe(after);
  });

  it("idempotent path also re-asserts mode 0644 (operator may have chmod'd)", () => {
    const ws = freshWorkspace();
    const written = writeMcpConfig({ workspace: ws, ...SAMPLE });
    chmodSync(written, 0o600);
    expect(statSync(written).mode & 0o777).toBe(0o600);
    writeMcpConfig({ workspace: ws, ...SAMPLE });
    expect(statSync(written).mode & 0o777).toBe(0o644);
  });

  it("refuses to overwrite a conflicting .mcp.json without force (throws McpConfigConflictError)", () => {
    const ws = freshWorkspace();
    writeFileSync(
      join(ws, MCP_CONFIG_FILENAME),
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x", args: [] } } }),
      "utf8"
    );
    expect(() => writeMcpConfig({ workspace: ws, ...SAMPLE })).toThrow(McpConfigConflictError);
    expect(() => writeMcpConfig({ workspace: ws, ...SAMPLE })).toThrow(/already exists|--force/i);
  });

  it("realpathSync errors throw a non-conflict Error (so CLI maps to exit 68, not 69)", () => {
    const linkPath = join(TMP_ROOT, `broken-rl-${Date.now()}`);
    symlinkSync(join(TMP_ROOT, "does-not-exist-target"), linkPath, "dir");
    let caught: unknown;
    try {
      writeMcpConfig({ workspace: linkPath, ...SAMPLE });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(McpConfigConflictError);
    expect((caught as Error).message).toMatch(/canonicalize|ENOENT/i);
  });

  it("overwrites a conflicting .mcp.json with force: true and lands at 0644", () => {
    const ws = freshWorkspace();
    const path = join(ws, MCP_CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { type: "stdio" } } }), "utf8");
    chmodSync(path, 0o600);
    const written = writeMcpConfig({ workspace: ws, ...SAMPLE, force: true });
    expect(written).toBe(path);
    const content = JSON.parse(readFileSync(written, "utf8"));
    expect(content.mcpServers["agentic-press"]).toBeDefined();
    expect(content.mcpServers.other).toBeUndefined();
    expect(statSync(written).mode & 0o777).toBe(0o644);
  });

  it("broken symlink throws an actionable error", () => {
    const linkPath = join(TMP_ROOT, `broken-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(join(TMP_ROOT, "does-not-exist-target"), linkPath, "dir");
    expect(() => writeMcpConfig({ workspace: linkPath, ...SAMPLE })).toThrow();
  });

  it("symlink pointing at a file (not a directory) fails before writing", () => {
    const filePath = join(TMP_ROOT, `target-file-${Date.now()}`);
    writeFileSync(filePath, "not a directory", "utf8");
    const linkPath = join(TMP_ROOT, `link-to-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(filePath, linkPath, "file");
    // realpathSync resolves to the file path, then join produces <file>/.mcp.json,
    // and writeFileSync fails with ENOTDIR.
    expect(() => writeMcpConfig({ workspace: linkPath, ...SAMPLE })).toThrow();
  });
});
