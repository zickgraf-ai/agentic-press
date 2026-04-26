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
  | "stale-setup-command";

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
