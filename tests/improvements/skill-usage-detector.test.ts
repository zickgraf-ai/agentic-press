import { describe, it, expect } from "vitest";
import { detectSkillUsageImprovements } from "../../src/improvements/detector.js";
import type { ClassifiedInvocation, VendoredSkill } from "../../src/improvements/types.js";

const NOW = new Date("2026-05-09T00:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function skill(name: string, ageDays: number): VendoredSkill {
  return {
    name,
    skillMdPath: `.claude/skills/${name}/SKILL.md`,
    skillMdMtime: daysAgo(ageDays),
  };
}

function invocation(
  overrides: Partial<ClassifiedInvocation> & Pick<ClassifiedInvocation, "skillName" | "outcome">
): ClassifiedInvocation {
  return {
    sessionId: "session-1",
    timestamp: NOW.toISOString(),
    transcriptPath: "/tmp/session-1.jsonl",
    eventUuid: "uuid-1",
    parentUuid: undefined,
    ...overrides,
  };
}

describe("skill-usage detector — never-used signal", () => {
  it("does not fire for a skill within the 14-day grace window", () => {
    const skills = [skill("systematic-debugging", 7)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    expect(out.filter((s) => s.category === "skill-usage")).toHaveLength(0);
  });

  it("fires never-used at 14 days, medium confidence", () => {
    const skills = [skill("systematic-debugging", 14)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug).toBeDefined();
    expect(sug!.evidence.skillName).toBe("systematic-debugging");
    expect(sug!.confidence).toBe("medium");
    expect(sug!.evidence.invocations).toBe(0);
  });

  it("escalates never-used to high confidence at 21 days", () => {
    const skills = [skill("systematic-debugging", 21)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug).toBeDefined();
    expect(sug!.confidence).toBe("high");
  });

  it("exempts writing-skills from never-used signal regardless of age", () => {
    const skills = [skill("writing-skills", 30)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    expect(out.filter((s) => s.category === "skill-usage")).toHaveLength(0);
  });

  it("does not fire never-used if there are any invocations, even one", () => {
    const skills = [skill("systematic-debugging", 21)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "systematic-debugging", outcome: "completed" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    expect(out.filter((s) => s.category === "skill-usage")).toHaveLength(0);
  });
});

describe("skill-usage detector — high abandonment signal", () => {
  it("fires when ≥3 invocations and ≥50% abandoned, medium confidence below 67%", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s3" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug).toBeDefined();
    expect(sug!.evidence.skillName).toBe("brainstorming");
    expect(sug!.confidence).toBe("medium");
    expect(sug!.evidence.abandoned).toBe(2);
    expect(sug!.evidence.completed).toBe(1);
    expect(sug!.evidence.invocations).toBe(3);
  });

  it("escalates to high confidence at ≥67% abandonment", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s3" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s4" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug).toBeDefined();
    expect(sug!.confidence).toBe("high");
  });

  it("does not fire abandonment below 50% threshold", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s2" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s3" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s4" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s5" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    expect(out.filter((s) => s.category === "skill-usage")).toHaveLength(0);
  });

  it("does not fire abandonment below the minimum invocation count", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    expect(out.filter((s) => s.category === "skill-usage")).toHaveLength(0);
  });

  it("ignores 'unknown' outcomes when computing abandonment rate", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
      invocation({ skillName: "brainstorming", outcome: "completed", sessionId: "s3" }),
      invocation({ skillName: "brainstorming", outcome: "unknown", sessionId: "s4" }),
      invocation({ skillName: "brainstorming", outcome: "unknown", sessionId: "s5" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug).toBeDefined();
    expect(sug!.evidence.abandoned).toBe(2);
    expect(sug!.evidence.completed).toBe(1);
  });
});

describe("skill-usage detector — evidence shape", () => {
  it("captures sessionsUsedIn (distinct sessions) in evidence", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s1" }),
      invocation({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug!.evidence.sessionsUsedIn).toBe(2);
  });

  it("captures skillAgeDays in evidence", () => {
    const skills = [skill("systematic-debugging", 14)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    const sug = out.find((s) => s.category === "skill-usage");
    expect(sug!.evidence.skillAgeDays).toBe(14);
  });
});

describe("skill-usage detector — multiple skills", () => {
  it("emits independent suggestions per skill", () => {
    const skills = [skill("systematic-debugging", 21), skill("subagent-driven-development", 21)];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    const sugs = out.filter((s) => s.category === "skill-usage");
    expect(sugs).toHaveLength(2);
    const names = sugs.map((s) => s.evidence.skillName).sort();
    expect(names).toEqual(["subagent-driven-development", "systematic-debugging"]);
  });

  it("only flags skills meeting their criterion (drift OR abandonment), not unused-but-young skills", () => {
    const skills = [
      skill("brainstorming", 7), // young, no invocations — should NOT fire
      skill("systematic-debugging", 21), // old, no invocations — should fire never-used
    ];
    const out = detectSkillUsageImprovements([], skills, { now: NOW });
    const sugs = out.filter((s) => s.category === "skill-usage");
    expect(sugs).toHaveLength(1);
    expect(sugs[0]!.evidence.skillName).toBe("systematic-debugging");
  });

  it("invocations for one skill do not silence never-used for a different skill", () => {
    const skills = [skill("systematic-debugging", 21), skill("subagent-driven-development", 21)];
    const invocations: ClassifiedInvocation[] = [
      invocation({ skillName: "systematic-debugging", outcome: "completed" }),
    ];
    const out = detectSkillUsageImprovements(invocations, skills, { now: NOW });
    const sugs = out.filter((s) => s.category === "skill-usage");
    expect(sugs).toHaveLength(1);
    expect(sugs[0]!.evidence.skillName).toBe("subagent-driven-development");
  });
});
