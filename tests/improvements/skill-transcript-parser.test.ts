import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscript,
  extractSkillInvocations,
  classifyInvocation,
  collectInvocations,
  findSessionLogDir,
  type SessionEvent,
} from "../../src/improvements/skill-transcript.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skill-transcript-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function ndjson(events: SessionEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function assistantEvent(opts: {
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  toolUses?: Array<{ name: string; input?: Record<string, unknown>; caller?: { type: string } }>;
}): SessionEvent {
  return {
    type: "assistant",
    uuid: opts.uuid ?? "u-" + Math.random().toString(36).slice(2, 10),
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId ?? "session-1",
    timestamp: opts.timestamp ?? "2026-05-09T12:00:00.000Z",
    message: {
      content: (opts.toolUses ?? []).map((t) => ({
        type: "tool_use",
        name: t.name,
        input: t.input ?? {},
        ...(t.caller ? { caller: t.caller } : {}),
      })),
    },
  };
}

function userTextEvent(opts: {
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  text: string;
}): SessionEvent {
  return {
    type: "user",
    uuid: opts.uuid ?? "u-" + Math.random().toString(36).slice(2, 10),
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId ?? "session-1",
    timestamp: opts.timestamp ?? "2026-05-09T12:01:00.000Z",
    message: { content: [{ type: "text", text: opts.text } as any] },
  };
}

describe("extractSkillInvocations", () => {
  it("extracts a Skill tool_use as a SkillInvocation", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        uuid: "ev-1",
        sessionId: "s1",
        timestamp: "2026-05-09T12:00:00.000Z",
        toolUses: [{ name: "Skill", input: { skill: "systematic-debugging" } }],
      }),
    ];
    const out = extractSkillInvocations(events, "/tmp/x.jsonl");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sessionId: "s1",
      skillName: "systematic-debugging",
      timestamp: "2026-05-09T12:00:00.000Z",
      eventUuid: "ev-1",
      transcriptPath: "/tmp/x.jsonl",
    });
  });

  it("ignores non-Skill tool_use", () => {
    const events: SessionEvent[] = [
      assistantEvent({ toolUses: [{ name: "Read", input: { file_path: "/x" } }] }),
      assistantEvent({ toolUses: [{ name: "Bash", input: { command: "ls" } }] }),
    ];
    expect(extractSkillInvocations(events, "/tmp/x.jsonl")).toHaveLength(0);
  });

  it("ignores user-type events even if they accidentally carry tool_use shape", () => {
    const events: SessionEvent[] = [
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-05-09T12:00:00.000Z",
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "x" } } as any] },
      },
    ];
    expect(extractSkillInvocations(events, "/tmp/x.jsonl")).toHaveLength(0);
  });

  it("ignores caller.type === 'skill' invocations (nested skill calls)", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        toolUses: [{ name: "Skill", input: { skill: "x" }, caller: { type: "skill" } }],
      }),
    ];
    expect(extractSkillInvocations(events, "/tmp/x.jsonl")).toHaveLength(0);
  });

  it("counts caller.type === 'direct' (or missing) as a top-level invocation", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        toolUses: [{ name: "Skill", input: { skill: "x" }, caller: { type: "direct" } }],
      }),
      assistantEvent({
        toolUses: [{ name: "Skill", input: { skill: "y" } }], // no caller field
      }),
    ];
    const out = extractSkillInvocations(events, "/tmp/x.jsonl");
    expect(out.map((i) => i.skillName).sort()).toEqual(["x", "y"]);
  });

  it("handles multiple tool_use blocks in a single assistant event", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        toolUses: [
          { name: "Read", input: {} },
          { name: "Skill", input: { skill: "a" } },
          { name: "Skill", input: { skill: "b" } },
        ],
      }),
    ];
    const out = extractSkillInvocations(events, "/tmp/x.jsonl");
    expect(out.map((i) => i.skillName).sort()).toEqual(["a", "b"]);
  });

  it("preserves sessionId per invocation", () => {
    const events: SessionEvent[] = [
      assistantEvent({ sessionId: "s1", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      assistantEvent({ sessionId: "s2", toolUses: [{ name: "Skill", input: { skill: "y" } }] }),
    ];
    const out = extractSkillInvocations(events, "/tmp/x.jsonl");
    expect(out.find((i) => i.skillName === "x")!.sessionId).toBe("s1");
    expect(out.find((i) => i.skillName === "y")!.sessionId).toBe("s2");
  });
});

describe("parseTranscript", () => {
  it("parses a clean NDJSON file", () => {
    const file = join(workDir, "session.jsonl");
    const events: SessionEvent[] = [
      assistantEvent({ uuid: "a" }),
      userTextEvent({ uuid: "b", text: "ok" }),
    ];
    writeFileSync(file, ndjson(events));
    const parsed = parseTranscript(file);
    expect(parsed.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  it("tolerates malformed lines (pino diagnostics + truncated JSON)", () => {
    const file = join(workDir, "session.jsonl");
    const lines = [
      JSON.stringify(assistantEvent({ uuid: "a" })),
      `{"level":30,"time":1234,"msg":"pino log line, not a session event"}`,
      `{"type":"assistant","uuid":"truncated`, // missing closing
      ``, // blank
      JSON.stringify(userTextEvent({ uuid: "b", text: "fine" })),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const parsed = parseTranscript(file);
    // The pino line parses as JSON but lacks "type" — we keep it (the caller filters by type).
    // The truncated JSON is skipped without throwing.
    expect(parsed.find((e) => e.uuid === "a")).toBeDefined();
    expect(parsed.find((e) => e.uuid === "b")).toBeDefined();
  });

  it("returns empty array for a missing file (caller decides if that's an error)", () => {
    expect(parseTranscript(join(workDir, "nonexistent.jsonl"))).toEqual([]);
  });
});

describe("classifyInvocation", () => {
  function buildSession(eventList: SessionEvent[]): SessionEvent[] {
    let prev: string | undefined;
    return eventList.map((e, i) => {
      const uuid = e.uuid ?? `ev-${i}`;
      const out = { ...e, uuid, parentUuid: e.parentUuid ?? prev };
      prev = uuid;
      return out;
    });
  }

  it("marks abandoned on stop-word in the next user message within 5 turns", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "actually stop, this is the wrong direction" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
  });

  it("marks abandoned on pivot to a different skill within 3 turns", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      assistantEvent({ toolUses: [{ name: "Read", input: {} }] }),
      assistantEvent({ toolUses: [{ name: "Skill", input: { skill: "y" } }] }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
  });

  it("does NOT mark abandoned when the next skill invoked is the SAME skill (continued use)", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      assistantEvent({ toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "yes that's right" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });

  it("marks completed on benign next-user-message within 20 turns", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "great, looks good" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });

  it("does not match stop-words inside larger words (e.g. 'backup' vs 'back up')", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "let's create a backup before we touch the database" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });

  it("returns unknown when the session ends right after the invocation with no follow-up", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("unknown");
  });

  it("ignores tool_result user events when looking for the next user MESSAGE", () => {
    // tool_result events are type:user too; they should not count as the "next user message".
    // A benign text reply 2 events later should still classify as completed.
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      {
        type: "user",
        uuid: "tr-1",
        sessionId: "session-1",
        timestamp: "2026-05-09T12:01:00.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "irrelevant", content: "fake tool result" } as any,
          ],
        },
      },
      userTextEvent({ text: "thanks, continue" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });
});

describe("findSessionLogDir", () => {
  it("encodes the absolute path with leading dash and slash-to-dash substitution", () => {
    const dir = findSessionLogDir("/Users/x/Code/agentic-press", { home: "/home/test" });
    expect(dir).toBe("/home/test/.claude/projects/-Users-x-Code-agentic-press");
  });

  it("preserves nested path segments", () => {
    const dir = findSessionLogDir("/a/b/c/d", { home: "/home/test" });
    expect(dir).toBe("/home/test/.claude/projects/-a-b-c-d");
  });
});

describe("collectInvocations", () => {
  it("walks all .jsonl files in a directory and returns classified invocations", () => {
    // Two session files in workDir, each with one Skill invocation.
    const file1 = join(workDir, "session-a.jsonl");
    const file2 = join(workDir, "session-b.jsonl");
    writeFileSync(
      file1,
      ndjson([
        assistantEvent({
          sessionId: "s-a",
          uuid: "a-inv",
          timestamp: "2026-05-08T12:00:00.000Z",
          toolUses: [{ name: "Skill", input: { skill: "systematic-debugging" } }],
        }),
        userTextEvent({ sessionId: "s-a", parentUuid: "a-inv", text: "thanks" }),
      ])
    );
    writeFileSync(
      file2,
      ndjson([
        assistantEvent({
          sessionId: "s-b",
          uuid: "b-inv",
          timestamp: "2026-05-08T12:00:00.000Z",
          toolUses: [{ name: "Skill", input: { skill: "brainstorming" } }],
        }),
        userTextEvent({ sessionId: "s-b", parentUuid: "b-inv", text: "stop, wrong direction" }),
      ])
    );

    const out = collectInvocations(workDir, "2026-05-01T00:00:00.000Z");
    expect(out).toHaveLength(2);
    const skills = out.map((i) => i.skillName).sort();
    expect(skills).toEqual(["brainstorming", "systematic-debugging"]);
    const brainstorming = out.find((i) => i.skillName === "brainstorming")!;
    const systematic = out.find((i) => i.skillName === "systematic-debugging")!;
    expect(brainstorming.outcome).toBe("abandoned");
    expect(systematic.outcome).toBe("completed");
  });

  it("filters by lookback (sinceISO) — older invocations excluded", () => {
    const file = join(workDir, "session.jsonl");
    writeFileSync(
      file,
      ndjson([
        assistantEvent({
          sessionId: "s",
          uuid: "old",
          timestamp: "2026-04-01T12:00:00.000Z",
          toolUses: [{ name: "Skill", input: { skill: "x" } }],
        }),
        assistantEvent({
          sessionId: "s",
          uuid: "new",
          timestamp: "2026-05-08T12:00:00.000Z",
          toolUses: [{ name: "Skill", input: { skill: "y" } }],
        }),
      ])
    );
    const out = collectInvocations(workDir, "2026-05-01T00:00:00.000Z");
    const skills = out.map((i) => i.skillName);
    expect(skills).toContain("y");
    expect(skills).not.toContain("x");
  });

  it("returns empty array when the directory does not exist", () => {
    expect(collectInvocations(join(workDir, "missing"), "2026-01-01T00:00:00.000Z")).toEqual([]);
  });
});
