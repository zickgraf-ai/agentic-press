import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, chmodSync } from "node:fs";
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
    const m = computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW);
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
    const m = computeMetrics(invocations, skills, NOW.toISOString(), NOW.toISOString(), NOW);
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
    const m = computeMetrics(completed, skills, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.perSkill[0]!.completionRate).toBeCloseTo(2 / 3, 5);

    const noClassified = computeMetrics(
      [inv({ skillName: "brainstorming", outcome: "unknown" })],
      skills,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW
    );
    expect(noClassified.perSkill[0]!.completionRate).toBe(0);
  });

  it("computes skillAgeDays from now - mtime", () => {
    const skills = [skill("brainstorming", 14)];
    const m = computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.perSkill[0]!.skillAgeDays).toBe(14);
  });

  it("distinguishes trial invocations (vendored skills only) from total Skill activity", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      // Non-vendored Skill invocations — should count in totals only, not the per-skill table.
      inv({ skillName: "pr-review-toolkit:review-pr", outcome: "completed", sessionId: "s2" }),
      inv({ skillName: "loop", outcome: "completed", sessionId: "s3" }),
    ];
    const m = computeMetrics(invocations, skills, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.trialInvocations).toBe(1);
    expect(m.totalInvocations).toBe(3);
    expect(m.trialSessionsUsedIn).toBe(1);
    expect(m.totalSessionsWithSkillActivity).toBe(3);
    // The non-trial invocations must NOT leak into the per-skill table.
    expect(m.perSkill.find((r) => r.skillName === "brainstorming")!.invocations).toBe(1);
    expect(m.perSkill.map((r) => r.skillName)).toEqual(["brainstorming"]);
  });

  it("trialInvocations equals totalInvocations when all invocations are for vendored skills", () => {
    const skills = [skill("brainstorming", 7), skill("systematic-debugging", 7)];
    const invocations: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s2" }),
    ];
    const m = computeMetrics(invocations, skills, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.trialInvocations).toBe(m.totalInvocations);
    expect(m.trialSessionsUsedIn).toBe(m.totalSessionsWithSkillActivity);
  });

  it("counts a session once in both trial and total when it has both types", () => {
    // Same sessionId for a vendored invocation AND a non-trial invocation —
    // both Set-based session counters must dedupe to 1 each.
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "pr-review-toolkit:review-pr", outcome: "completed", sessionId: "s1" }),
    ];
    const m = computeMetrics(invocations, skills, NOW.toISOString(), NOW.toISOString(), NOW);
    expect(m.totalSessionsWithSkillActivity).toBe(1);
    expect(m.trialSessionsUsedIn).toBe(1);
    expect(m.totalInvocations).toBe(2);
    expect(m.trialInvocations).toBe(1);
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

  it("DROP boundary: 1 invocation at age 21 still DROPs (below threshold)", () => {
    const one: ClassifiedInvocation[] = [
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("systematic-debugging", one, 21)).toBe("DROP");
  });

  it("DROP boundary: 2 invocations at age 21 do NOT DROP (at/above threshold)", () => {
    const two: ClassifiedInvocation[] = [
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s2" }),
    ];
    // 2 invocations < dropBelowInvocations (2) is FALSE, so we don't DROP. 2 sessions/2 invocations
    // doesn't meet KEEP for systematic-debugging (needs 3 sessions) → UNDECIDED.
    expect(verdictFor("systematic-debugging", two, 21)).toBe("UNDECIDED");
  });

  it("grace boundary: 1 invocation at age 13 (within grace) is UNDECIDED, NOT DROP", () => {
    const one: ClassifiedInvocation[] = [
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("systematic-debugging", one, 13)).toBe("UNDECIDED");
  });

  it("grace boundary: 1 invocation at age 14 (exactly grace) DROPs", () => {
    const one: ClassifiedInvocation[] = [
      inv({ skillName: "systematic-debugging", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("systematic-debugging", one, 14)).toBe("DROP");
  });

  it("verification-before-completion: 1 invocation at age 21 DROPs", () => {
    const one: ClassifiedInvocation[] = [
      inv({ skillName: "verification-before-completion", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("verification-before-completion", one, 21)).toBe("DROP");
  });

  it("verification-before-completion: 2 invocations at age 21 — does NOT DROP", () => {
    const two: ClassifiedInvocation[] = [
      inv({ skillName: "verification-before-completion", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "verification-before-completion", outcome: "completed", sessionId: "s2" }),
    ];
    // 2 invocations not below threshold → not DROP; doesn't meet KEEP (needs 5) → UNDECIDED.
    expect(verdictFor("verification-before-completion", two, 21)).toBe("UNDECIDED");
  });

  it("UNDECIDED when invocations exist but neither KEEP nor DROP threshold is met", () => {
    // 2 invocations is above DROP threshold (<2) but only 1 session — below KEEP's 2-session bar.
    const invs: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
    ];
    expect(verdictFor("brainstorming", invs)).toBe("UNDECIDED");
  });
});

describe("renderReport", () => {
  it("includes the lookback window in the header", () => {
    const skills = [skill("brainstorming", 14)];
    const m = computeMetrics(
      [],
      skills,
      "2026-04-09T00:00:00.000Z",
      "2026-05-09T00:00:00.000Z",
      NOW
    );
    const out = renderReport(m);
    expect(out).toMatch(/Window:.*2026-04-09.*2026-05-09/);
  });

  it("shows trial-skill activity separately from total Skill-tool activity in the header", () => {
    const skills = [skill("brainstorming", 7)];
    const invocations: ClassifiedInvocation[] = [
      inv({ skillName: "brainstorming", outcome: "completed", sessionId: "s1" }),
      inv({ skillName: "pr-review-toolkit:review-pr", outcome: "completed", sessionId: "s2" }),
      inv({ skillName: "loop", outcome: "completed", sessionId: "s3" }),
    ];
    const out = renderReport(
      computeMetrics(invocations, skills, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toMatch(/Trial-skill activity:.*1 invocation across 1 session/);
    expect(out).toMatch(/All Skill-tool activity in window:.*3 invocations across 3 sessions/);
    expect(out).toMatch(/includes non-trial skills/);
  });

  it("flags malformed transcript lines in the report header when parseStats.malformedLines > 0", () => {
    const skills = [skill("brainstorming", 7)];
    const m = computeMetrics(
      [],
      skills,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW,
      { filesScanned: 5, missingFiles: 0, totalLines: 200, malformedLines: 7 }
    );
    const out = renderReport(m);
    expect(out).toMatch(/Transcripts scanned:.*5/);
    expect(out).toMatch(/200 lines, 7 malformed/);
    // Warning glyph must be present so the reader can't miss the signal.
    expect(out).toContain("⚠️");
  });

  it("singular/plural agreement in the trial vs total activity counts", () => {
    const skills = [skill("brainstorming", 7)];
    const out = renderReport(
      computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toMatch(/Trial-skill activity:.*0 invocations across 0 sessions/);
  });

  it("renders one row per skill in the table", () => {
    const skills = [skill("brainstorming", 7), skill("verification-before-completion", 7)];
    const out = renderReport(
      computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toContain("| brainstorming");
    expect(out).toContain("| verification-before-completion");
  });

  it("marks 0-invocation rows with em-dash for completion-rate", () => {
    const skills = [skill("brainstorming", 7)];
    const out = renderReport(
      computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW)
    );
    expect(out).toMatch(/\|\s*—\s*\|/); // em-dash placeholder somewhere in the row
  });

  it("ends with a per-skill verdict block", () => {
    const skills = [skill("systematic-debugging", 21)];
    const out = renderReport(
      computeMetrics([], skills, NOW.toISOString(), NOW.toISOString(), NOW)
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

  it("warns and continues when a SKILL.md is unreadable, returning the readable skills", () => {
    // Skip under root (e.g., some CI / docker images) where chmod 000 doesn't
    // produce EACCES on read — the test then can't provoke the catch path.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const skillsRoot = join(tmpRoot, ".claude", "skills");
    mkdirSync(join(skillsRoot, "readable"), { recursive: true });
    mkdirSync(join(skillsRoot, "unreadable"), { recursive: true });
    const readableMd = join(skillsRoot, "readable", "SKILL.md");
    const unreadableMd = join(skillsRoot, "unreadable", "SKILL.md");
    writeFileSync(
      readableMd,
      "---\nname: readable\n---\n\n# X\n\n## Provenance\n\nVendored.\n"
    );
    writeFileSync(
      unreadableMd,
      "---\nname: unreadable\n---\n\n# X\n\n## Provenance\n\nVendored.\n"
    );
    chmodSync(unreadableMd, 0o000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skills = readVendoredSkills(skillsRoot);
      expect(skills.map((s) => s.name)).toEqual(["readable"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]![0]);
      expect(message).toMatch(/^\[readVendoredSkills\] skipped unreadable: /);
    } finally {
      // Restore perms so afterEach rmSync can clean up the tmp dir.
      chmodSync(unreadableMd, 0o644);
      warnSpy.mockRestore();
    }
  });
});
