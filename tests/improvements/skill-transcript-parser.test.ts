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

  it("drops invocations missing uuid/sessionId/timestamp instead of stamping a placeholder (S5)", () => {
    // Two invocations both missing uuid would, with a placeholder stamp,
    // collide in findIndex inside classifyInvocation. We drop them instead.
    const events: SessionEvent[] = [
      {
        type: "assistant",
        // no uuid
        sessionId: "s1",
        timestamp: "2026-05-09T12:00:00Z",
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "x" } }] },
      },
      assistantEvent({
        uuid: "good",
        sessionId: "s2",
        toolUses: [{ name: "Skill", input: { skill: "y" } }],
      }),
    ];
    const out = extractSkillInvocations(events, "/t/x.jsonl");
    expect(out).toHaveLength(1);
    expect(out[0]!.skillName).toBe("y");
    expect(out[0]!.eventUuid).toBe("good");
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

  it("regression (B1): a stop-word at user turn 3 abandons even after benign turns 1-2", () => {
    // The original implementation returned "completed" on the FIRST benign user message,
    // so the 5-turn abandonment window was unreachable past iteration 1. This test exposes
    // that bug by interleaving benign messages before the abandonment-triggering one.
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "ok let's see" }),
      assistantEvent({ toolUses: [{ name: "Read", input: { file_path: "/x" } }] }),
      userTextEvent({ text: "hmm, keep going" }),
      assistantEvent({ toolUses: [{ name: "Bash", input: { command: "ls" } }] }),
      userTextEvent({ text: "actually, stop — this is the wrong direction" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
  });

  it("stop-word at user turn 5 (boundary, inside window) abandons", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "ok 1" }),
      userTextEvent({ text: "ok 2" }),
      userTextEvent({ text: "ok 3" }),
      userTextEvent({ text: "ok 4" }),
      userTextEvent({ text: "stop, please" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
  });

  it("stop-word at user turn 6 (outside window) classifies as completed", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text: "ok 1" }),
      userTextEvent({ text: "ok 2" }),
      userTextEvent({ text: "ok 3" }),
      userTextEvent({ text: "ok 4" }),
      userTextEvent({ text: "ok 5" }),
      userTextEvent({ text: "stop, please" }), // turn 6 — outside the 5-turn window
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });

  it("pivot at assistant turn 3 (boundary, inside window) abandons", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      assistantEvent({ toolUses: [{ name: "Read", input: {} }] }),
      assistantEvent({ toolUses: [{ name: "Bash", input: { command: "" } }] }),
      assistantEvent({ toolUses: [{ name: "Skill", input: { skill: "y" } }] }), // assistant turn 3
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
  });

  it("pivot at assistant turn 4 (outside window) classifies as completed when benign user replies appear", () => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      assistantEvent({ toolUses: [{ name: "Read", input: {} }] }),
      assistantEvent({ toolUses: [{ name: "Bash", input: { command: "" } }] }),
      assistantEvent({ toolUses: [{ name: "Read", input: {} }] }),
      assistantEvent({ toolUses: [{ name: "Skill", input: { skill: "y" } }] }), // assistant turn 4 — outside window
      userTextEvent({ text: "great" }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("completed");
  });

  it.each([
    ["please cancel that", "cancel"],
    ["back up to the previous step", "back up"],
    ["don't do that", "don't do that"],
    ["don't do that, restart instead", "don't do that"],
    ["dont do that", "dont do that (apostrophe optional)"],
    ["no don't continue", "no don't"],
    ["/stop", "/stop slash command"],
  ])("matches stop-word: %s", (text) => {
    const events = buildSession([
      assistantEvent({ uuid: "inv", toolUses: [{ name: "Skill", input: { skill: "x" } }] }),
      userTextEvent({ text }),
    ]);
    const inv = extractSkillInvocations(events, "/t/x.jsonl")[0]!;
    expect(classifyInvocation(events, inv)).toBe("abandoned");
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

    const { invocations, parseStats } = collectInvocations(workDir, "2026-05-01T00:00:00.000Z");
    expect(invocations).toHaveLength(2);
    const skills = invocations.map((i) => i.skillName).sort();
    expect(skills).toEqual(["brainstorming", "systematic-debugging"]);
    expect(invocations.find((i) => i.skillName === "brainstorming")!.outcome).toBe("abandoned");
    expect(invocations.find((i) => i.skillName === "systematic-debugging")!.outcome).toBe("completed");
    expect(parseStats.filesScanned).toBe(2);
    expect(parseStats.malformedLines).toBe(0);
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
    const { invocations } = collectInvocations(workDir, "2026-05-01T00:00:00.000Z");
    const skills = invocations.map((i) => i.skillName);
    expect(skills).toContain("y");
    expect(skills).not.toContain("x");
  });

  it("returns zero-counts when the directory does not exist", () => {
    const out = collectInvocations(join(workDir, "missing"), "2026-01-01T00:00:00.000Z");
    expect(out.invocations).toEqual([]);
    expect(out.parseStats).toEqual({ filesScanned: 0, missingFiles: 0, totalLines: 0, malformedLines: 0 });
  });

  it("counts malformed lines so transcript-format drift is visible", () => {
    const file = join(workDir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(
          assistantEvent({
            sessionId: "s",
            uuid: "ev",
            timestamp: "2026-05-08T12:00:00.000Z",
            toolUses: [{ name: "Skill", input: { skill: "x" } }],
          })
        ),
        // Three malformed lines (truncated, primitive, interleaved pino).
        `{"truncated`,
        `42`,
        `{"level":30,"msg":"pino"}`, // valid JSON, but an object — counts as event, not malformed
      ].join("\n") + "\n"
    );
    const { parseStats } = collectInvocations(workDir, "2026-05-01T00:00:00.000Z");
    expect(parseStats.totalLines).toBe(4);
    // Truncated + bare primitive = 2 malformed; pino object passes JSON.parse and is kept as a session event.
    expect(parseStats.malformedLines).toBe(2);
  });
});
