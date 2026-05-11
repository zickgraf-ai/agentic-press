import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestFile } from "../../src/dispatch/manifest.js";

let TMP_ROOT: string;
let TMP_WS: string;
let TMP_NOT_A_DIR: string;
let MANIFEST_PATH: string;

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "ap-dispatch-manifest-"));
  TMP_WS = join(TMP_ROOT, "workspace");
  mkdirSync(TMP_WS, { recursive: true });
  TMP_NOT_A_DIR = join(TMP_ROOT, "i-am-a-file");
  writeFileSync(TMP_NOT_A_DIR, "not a directory", "utf8");
  MANIFEST_PATH = join(TMP_ROOT, "manifest.json");
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function write(obj: unknown): string {
  writeFileSync(MANIFEST_PATH, JSON.stringify(obj), "utf8");
  return MANIFEST_PATH;
}

function happyAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentType: "reviewer",
    allowedTools: ["echo__read_file"],
    agentCommand: ["claude", "--continue"],
    workspace: TMP_WS,
    ...overrides,
  };
}

describe("parseManifestFile", () => {
  it("parses a minimal valid manifest", () => {
    const path = write({ agents: [happyAgent()] });
    const manifest = parseManifestFile(path);
    expect(manifest.agents).toHaveLength(1);
    expect(manifest.agents[0].agentType).toBe("reviewer");
    expect(manifest.agents[0].allowedTools).toEqual(["echo__read_file"]);
    expect(manifest.agents[0].agentCommand).toEqual(["claude", "--continue"]);
    expect(manifest.agents[0].workspace).toBe(TMP_WS);
  });

  it("preserves optional fields sandboxName and extraSbxArgs", () => {
    const path = write({
      agents: [happyAgent({ sandboxName: "ap-reviewer-99", extraSbxArgs: ["--cpu", "2"] })],
    });
    const m = parseManifestFile(path);
    expect(m.agents[0].sandboxName).toBe("ap-reviewer-99");
    expect(m.agents[0].extraSbxArgs).toEqual(["--cpu", "2"]);
  });

  it("rejects a missing manifest file with an actionable error", () => {
    expect(() => parseManifestFile(join(TMP_ROOT, "does-not-exist.json"))).toThrow(
      /manifest file/i
    );
  });

  it("rejects invalid JSON", () => {
    writeFileSync(MANIFEST_PATH, "{ not json", "utf8");
    expect(() => parseManifestFile(MANIFEST_PATH)).toThrow(/parse/i);
  });

  it("rejects missing 'agents' key", () => {
    const path = write({ other: [] });
    expect(() => parseManifestFile(path)).toThrow(/agents/);
  });

  it("rejects a top-level array (Tier 1.5 shape)", () => {
    writeFileSync(MANIFEST_PATH, JSON.stringify([happyAgent()]), "utf8");
    expect(() => parseManifestFile(MANIFEST_PATH)).toThrow(/object|agents/i);
  });

  it("rejects empty agents array", () => {
    const path = write({ agents: [] });
    expect(() => parseManifestFile(path)).toThrow(/at least one agent/i);
  });

  describe("agentType validation (shared contract with validateSessionInput)", () => {
    it("rejects empty agentType", () => {
      const path = write({ agents: [happyAgent({ agentType: "" })] });
      expect(() => parseManifestFile(path)).toThrow(/agentType/);
    });

    it("rejects agentType > 32 chars", () => {
      const path = write({ agents: [happyAgent({ agentType: "x".repeat(33) })] });
      expect(() => parseManifestFile(path)).toThrow(/agentType/);
    });

    it("rejects agentType with bad charset", () => {
      const path = write({ agents: [happyAgent({ agentType: "has space" })] });
      expect(() => parseManifestFile(path)).toThrow(/agentType/);
    });
  });

  describe("allowedTools validation", () => {
    it("rejects empty allowedTools array", () => {
      const path = write({ agents: [happyAgent({ allowedTools: [] })] });
      expect(() => parseManifestFile(path)).toThrow(/allowedTools/);
    });

    it("rejects bare '*' wildcard", () => {
      const path = write({ agents: [happyAgent({ allowedTools: ["*"] })] });
      expect(() => parseManifestFile(path)).toThrow(/catch-all|allowedTools/);
    });

    it("rejects entry with bad charset", () => {
      const path = write({ agents: [happyAgent({ allowedTools: ["bad space"] })] });
      expect(() => parseManifestFile(path)).toThrow(/allowedTools/);
    });
  });

  describe("workspace validation", () => {
    it("rejects relative workspace path", () => {
      const path = write({ agents: [happyAgent({ workspace: "relative/path" })] });
      expect(() => parseManifestFile(path)).toThrow(/workspace.*absolute/i);
    });

    it("rejects workspace that does not exist", () => {
      const path = write({ agents: [happyAgent({ workspace: "/this/does/not/exist/12345" })] });
      expect(() => parseManifestFile(path)).toThrow(/workspace/);
    });

    it("rejects workspace that is a file, not a directory", () => {
      const path = write({ agents: [happyAgent({ workspace: TMP_NOT_A_DIR })] });
      expect(() => parseManifestFile(path)).toThrow(/directory/i);
    });
  });

  describe("agentCommand validation", () => {
    it("rejects missing agentCommand", () => {
      const path = write({ agents: [happyAgent({ agentCommand: undefined })] });
      expect(() => parseManifestFile(path)).toThrow(/agentCommand/);
    });

    it("rejects empty agentCommand array", () => {
      const path = write({ agents: [happyAgent({ agentCommand: [] })] });
      expect(() => parseManifestFile(path)).toThrow(/agentCommand/);
    });

    it("rejects non-string entries in agentCommand", () => {
      const path = write({ agents: [happyAgent({ agentCommand: ["claude", 42] })] });
      expect(() => parseManifestFile(path)).toThrow(/agentCommand/);
    });

    it("rejects empty-string entries in agentCommand", () => {
      const path = write({ agents: [happyAgent({ agentCommand: ["claude", ""] })] });
      expect(() => parseManifestFile(path)).toThrow(/agentCommand/);
    });
  });

  it("rejects sandboxName with bad charset", () => {
    const path = write({ agents: [happyAgent({ sandboxName: "BadName!" })] });
    expect(() => parseManifestFile(path)).toThrow(/sandboxName/);
  });

  it("rejects extraSbxArgs that is not an array", () => {
    const path = write({ agents: [happyAgent({ extraSbxArgs: { wrong: "shape" } })] });
    expect(() => parseManifestFile(path)).toThrow(/extraSbxArgs/);
  });

  it("emits agents[i].field path in error messages", () => {
    const path = write({
      agents: [happyAgent(), happyAgent({ agentType: "bad space" })],
    });
    expect(() => parseManifestFile(path)).toThrow(/agents\[1\]/);
  });
});
