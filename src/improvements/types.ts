/**
 * Self-improvement system types — issue #20.
 *
 * The system observes patterns in the proxy's audit log and surfaces them as
 * markdown files in `.improvements/` for human triage. The agent never
 * applies its own suggestions; a human reviews and either dismisses, edits,
 * or dispatches an agent (which opens a draft PR for further review).
 *
 * Security model: nothing in `.improvements/` is auto-loaded into agent
 * context. All effects flow through human-reviewed PRs.
 */

export type ImprovementCategory =
  | "allowlist-drift"
  | "tool-failure"
  | "bridge-timeout"
  | "token-heavy"
  | "stale-setup-command"
  | "skill-usage";

export type Confidence = "low" | "medium" | "high";

export type Status = "open" | "dismissed" | "addressed";

export interface SuggestionEvidence {
  /** Tool name for tool-keyed categories (allowlist-drift, tool-failure, bridge-timeout). */
  readonly tool?: string;
  /** Number of matching audit entries observed. */
  readonly count?: number;
  /** ISO timestamp of the earliest matching entry. */
  readonly firstSeen?: string;
  /** ISO timestamp of the most recent matching entry. */
  readonly lastSeen?: string;
  /** Up to 3 sample error messages from matching entries (tool-failure, bridge-timeout). */
  readonly sampleErrors?: readonly string[];
  /** Skill name for skill-usage category. */
  readonly skillName?: string;
  /** Total Skill-tool invocations observed in the lookback window (skill-usage). */
  readonly invocations?: number;
  /** Invocations classified as completed (skill-usage). */
  readonly completed?: number;
  /** Invocations classified as abandoned (skill-usage). */
  readonly abandoned?: number;
  /** Distinct sessions that used the skill at least once (skill-usage). */
  readonly sessionsUsedIn?: number;
  /** Days since the skill's SKILL.md was added/modified — proxy for trial age (skill-usage). */
  readonly skillAgeDays?: number;
  /**
   * Open-ended metadata bucket for category-specific fields that don't have a
   * dedicated typed slot. Kept narrow on purpose — the typed fields above
   * cover all current categories and a typo like `evidence.tol` would
   * otherwise compile silently.
   *
   * TODO: when more categories land, refactor SuggestionEvidence into a
   * discriminated union keyed on `category` so each category gets exactly the
   * fields it needs.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Suggestion {
  readonly category: ImprovementCategory;
  readonly confidence: Confidence;
  readonly title: string;
  readonly summary: string;
  readonly evidence: SuggestionEvidence;
}

export interface DetectorOptions {
  /** Minimum number of blocked entries for the same tool to flag allowlist drift. Default 3. */
  readonly allowlistDriftThreshold?: number;
  /** Minimum number of error entries for the same tool to flag a failure pattern. Default 3. */
  readonly toolFailureThreshold?: number;
}

/**
 * One Skill-tool invocation extracted from a Claude Code session transcript,
 * with an outcome classification produced by the abandonment heuristic.
 *
 * See `src/improvements/skill-transcript.ts` for the producer.
 */
export interface ClassifiedInvocation {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly skillName: string;
  readonly transcriptPath: string;
  readonly eventUuid: string;
  readonly parentUuid?: string;
  readonly outcome: InvocationOutcome;
}

export type InvocationOutcome = "completed" | "abandoned" | "unknown";

/**
 * A skill that has been vendored into the project at `.claude/skills/<name>/`
 * and is participating in the trial. Used by the never-used detector to
 * distinguish "skill is too new to draw conclusions" from "skill has been
 * present long enough that zero usage is signal."
 */
export interface VendoredSkill {
  readonly name: string;
  readonly skillMdPath: string;
  readonly skillMdMtime: Date;
}

export interface SkillDetectorOptions {
  /** Days a skill must exist before zero-usage becomes signal. Default 14. */
  readonly neverUsedGraceDays?: number;
  /** Days at which never-used confidence escalates from medium to high. Default 21. */
  readonly neverUsedHighConfidenceDays?: number;
  /** Abandonment rate at which the high-abandonment signal fires. Default 0.5. */
  readonly abandonmentThreshold?: number;
  /** Minimum classified-invocation count for the abandonment signal. Default 3. */
  readonly minInvocationsForAbandonment?: number;
  /** Skills exempt from the never-used signal (e.g., meta-skills with naturally low frequency). */
  readonly neverUsedExemptSkills?: readonly string[];
  /** Anchor "now" — used to compute skill age. Defaults to new Date() at call time. */
  readonly now?: Date;
}
