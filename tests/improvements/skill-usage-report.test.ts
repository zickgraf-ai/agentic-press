import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeMetrics,
  renderReport,
  readVendoredSkills,
  reportFileName,
  type PerSkillMetrics,
} from "../../src/improvements/skill-usage-report.js";
import type { ClassifiedInvocation, VendoredSkill } from "../../src/improvements/types.js";

const NOW = new Date("2026-05-09T00:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function skill(name: string, ageDays: number): VendoredSkill {
  return { name, skillMdPath: `.claude/skills/${name}/SKILL.md`, skillMdMtime: daysAgo(ageDays) };
}

function inv(
  overrides: Partial<ClassifiedInvocation> & Pick<ClassifiedInvocation, "skillName" | "outcome">
): ClassifiedInvocation {
  return {
    sessionId: "session-1",
    timestamp: NOW.toISOString(),
    transcriptPath: "/t/x.jsonl",
    eventUuid: "u",
    parentUuid: undefined,
    ...overrides,
  };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-report-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("computeMetrics", () => {
  it("emits one row per vendored skill, alphabetical by name", () => {
    const skills = [skill("subagent-driven-development", 14), skill("brainstorming", 7)];
    const m = computeMetrics([], skills, 0, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.perSkill.map((r) => r.skillName)).toEqual([
      "brainstorming",
      "subagent-driven-development",
    ]);
  });

  it("counts invocations / completed / abandoned / sessionsUsedIn correctly", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s2" }),
      inv({ skillName: "brainstorming", outcome: "unknown", sessionId: "s3" }),
    ];
    const m = computeMetrics(invocations, skills, 5, NOW.toISOString(), NOW.toISOString(), NOW);
    const row = m.perSkill[0]!;
    expect(row.invocations).toBe(4);
    expect(row.completed).toBe(2);
    expect(row.abandoned).toBe(1);
    expect(row.unknown).toBe(1);
    expect(row.sessionsUsedIn).toBe(3);
  });

  it("computes completion rate as completed / (completed + abandoned), 0 if denominator is 0", () => {
    const skills = [skill("brainstorming", 7)];
    const completed: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s2" }),
      inv({ skillName: "brainstorming", outcome: "abandoned", sessionId: "s3" }),
    ];
    const m = computeMetrics(completed, skills, 3, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.perSkill[0]!.completionRate).toBeCloseTo(2 / 3, 5);

    const noClassified = computeMetrics(
      [inv({ skillName: "brainstorming", outcome: "unknown" })],
      skills,
      1,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW
    );
    expect(noClassified.perSkill[0]!.completionRate).toBe(0);
  });

  it("computes skillAgeDays from now - mtime", () => {
    const skills = [skill("brainstorming", 14)];
    const m = computeMetrics([], skills, 0, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.perSkill[0]!.skillAgeDays).toBe(14);
  });
});

describe("computeMetrics — verdicts", () => {
  function verdictFor(
    skillName: string,
    invocations: ClassifiedInvocation[],
    ageDays = 21
  ): PerSkillMetrics["verdict"] {
    const m = computeMetrics(
      invocations,
      [skill(skillName, ageDays)],
      Math.max(invocations.length, 1),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW
    );
    return m.perSkill[0]!.verdict;
  }

  it("writing-skills always reads MEASURE (meta-skill, exempt)", () => {
    expect(verdictFor("writing-skills", [])).toBe("MEASURE");
    expect(
      verdictFor("writing-skills", [
        inv({ skillName: "writing-skills", outcome: "completed", sessionId: "s1" }),
      ])
    ).toBe("MEASURE");
  });

  it("0 invocations after grace period reads DROP", () => {
    expect(verdictFor("systematic-debugging", [], 21)).toBe("DROP");
  });

  it("0 invocations during grace period reads UNDECIDED", () => {
    expect(verdictFor("systematic-debugging", [], 7)).toBe("UNDECIDED");
  });

  it("KEEP fires when systematic-debugging hits ≥3 sessions and ≥70% completion", () => {
    const invs: ClassifiedInvocation[] = [
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s2" }),
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s3" }),
      inv({ skillName: "systematic-debugging", outcome: "abandoned", sessionId: "s4" }),
    ];
    expect(verdictFor("systematic-debugging", invs)).toBe("KEEP");
  });

  it("verification-before-completion KEEP fires at ≥5 invocations regardless of session count", () => {
    const invs: ClassifiedInvocation[] = Array.from({ length: 5 }, (_, i) =>
      inv({
        skillName: "verification-before-completion",
        outcome: "completed",
        sessionId: `s${i}`,
      })
    );
    expect(verdictFor("verification-before-completion", invs)).toBe("KEEP");
  });

  it("verification-before-completion DROP fires at <2 invocations after grace period", () => {
    expect(verdictFor("verification-before-completion", [], 21)).toBe("DROP");
  });

  it("UNDECIDED when invocations exist but neither KEEP nor DROP threshold is met", () => {
    const invs: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("brainstorming", invs)).toBe("UNDECIDED");
  });
});

describe("renderReport", () => {
  it("includes the lookback window and total session count in the header", () => {
    const skills = [skill("brainstorming", 14)];
    const m = computeMetrics(
      [],
      skills,
      42,
      "2026-04-09T00:00:00.000Z",
      "2026-05-09T00:00:00.000Z",
      NOW
    );
    const out = renderReport(m);
    expect(out).toMatch(/Window:.*2026-04-09.*2026-05-09/);
    expect(out).toMatch(/Sessions analyzed:.*42/);
  });

  it("renders one row per skill in the table", () => {
    const skills = [skill("brainstorming", 7), skill("verification-before-completion", 7)];
    const out = renderReport(
      computeMetrics([], skills, 0, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toContain("| brainstorming");
    expect(out).toContain("| verification-before-completion");
  });

  it("marks 0-invocation rows with em-dash for completion-rate", () => {
    const skills = [skill("brainstorming", 7)];
    const out = renderReport(
      computeMetrics([], skills, 0, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toMatch(/\|\s*—\s*\|/); // em-dash placeholder somewhere in the row
  });

  it("ends with a per-skill verdict block", () => {
    const skills = [skill("systematic-debugging", 21)];
    const out = renderReport(
      computeMetrics([], skills, 0, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toMatch(/Verdict/);
    expect(out).toMatch(/systematic-debugging.*DROP/);
  });
});

describe("reportFileName", () => {
  it("formats as skill-usage-YYYY-MM-DD.md", () => {
    expect(reportFileName(new Date("2026-05-09T08:00:00Z"))).toBe("skill-usage-2026-05-09.md");
  });
});

describe("readVendoredSkills", () => {
  it("returns skills whose SKILL.md contains a Provenance footer marker", () => {
    const skillsRoot = join(tmpRoot, ".claude", "skills");
    mkdirSync(join(skillsRoot, "vendored-one"), { recursive: true });
    mkdirSync(join(skillsRoot, "project-skill"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "vendored-one", "SKILL.md"),
      "---\nname: vendored-one\n---\n\n# X\n\n## Provenance\n\nVendored from upstream.\n"
    );
    writeFileSync(
      join(skillsRoot, "project-skill", "SKILL.md"),
      "---\nname: project-skill\n---\n\n# Y\n\nProject-authored, no provenance footer.\n"
    );
    // Pin mtimes for determinism
    const past = new Date("2026-05-01T00:00:00Z");
    utimesSync(join(skillsRoot, "vendored-one", "SKILL.md"), past, past);
    utimesSync(join(skillsRoot, "project-skill", "SKILL.md"), past, past);

    const skills = readVendoredSkills(skillsRoot);
    expect(skills.map((s) => s.name)).toEqual(["vendored-one"]);
    expect(skills[0]!.skillMdPath).toContain("vendored-one/SKILL.md");
    expect(skills[0]!.skillMdMtime.toISOString()).toBe(past.toISOString());
  });

  it("returns empty array when skills directory does not exist", () => {
    expect(readVendoredSkills(join(tmpRoot, "nonexistent"))).toEqual([]);
  });

  it("ignores entries that aren't directories or are missing SKILL.md", () => {
    const skillsRoot = join(tmpRoot, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(join(skillsRoot, "loose-file.md"), "## Provenance\n");
    mkdirSync(join(skillsRoot, "no-skill-md-here"));
    expect(readVendoredSkills(skillsRoot)).toEqual([]);
  });
});
