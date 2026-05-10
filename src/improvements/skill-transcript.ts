/**
 * Parse Claude Code session transcripts (NDJSON `.jsonl` files under
 * `~/.claude/projects/<encoded-cwd>/`) and extract Skill-tool invocations
 * with outcome classification.
 *
 * Producer for the `skill-usage` improvement category. See
 * `src/improvements/detector.ts:detectSkillUsageImprovements`.
 *
 * Heuristics are intentionally conservative — false positives surface as
 * raw counts in the metrics report; the anti-signal Suggestion fires only
 * when classified counts cross a threshold, so a few mis-classifications
 * are absorbed by the higher-level signal.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SkillInvocation,
  ClassifiedInvocation,
  InvocationOutcome,
} from "./types.js";

/**
 * Minimal shape of a session-transcript event that we care about. The file
 * format carries many other fields (cwd, gitBranch, version, ...) — they're
 * preserved as `unknown` keys via the index signature, but unused here.
 */
export interface SessionEvent {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    content?: ContentBlock[] | string;
  };
  // Allow additional fields without making them required.
  [key: string]: unknown;
}

export interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: { skill?: string;[k: string]: unknown };
  caller?: { type?: string };
  // Allow additional fields without making them required.
  [key: string]: unknown;
}

const ABANDONMENT_TURN_WINDOW_USER = 5;
const ABANDONMENT_TURN_WINDOW_PIVOT = 3;
const COMPLETION_TURN_WINDOW = 20;

const STOP_PATTERNS: readonly RegExp[] = [
  /\bstop\b/i,
  /\bcancel\b/i,
  /\bwrong\b/i,
  /\bback up\b/i,
  /don'?t do that/i,
  /no\s+don'?t/i,
  /\/stop\b/i,
];

/**
 * Resolve the Claude Code session-log directory for a given working directory.
 * Encoding rule: replace every `/` with `-` and prefix with the home
 * `.claude/projects/` path. (Verified live: `/Users/x/Code/y` →
 * `~/.claude/projects/-Users-x-Code-y`.)
 *
 * The returned path is NOT guaranteed to exist — callers should handle
 * missing directories gracefully (this is normal on a fresh machine).
 */
export function findSessionLogDir(cwd: string, opts?: { home?: string }): string {
  const home = opts?.home ?? homedir();
  const encoded = cwd.replace(/\//g, "-");
  return join(home, ".claude", "projects", encoded);
}

/**
 * Per-file parser telemetry. Surfaced through `collectInvocations` so the
 * weekly report header can flag transcript-format drift: if Claude Code
 * ships a schema change, every skill silently shows "0 invocations" → DROP
 * unless we count and report parse failures.
 */
export interface ParseStats {
  /** Files attempted (including missing ones — see missingFiles for that subset). */
  readonly filesScanned: number;
  /** Files that did not exist on disk (counted, not errored). */
  readonly missingFiles: number;
  /** Total non-blank lines seen across all files. */
  readonly totalLines: number;
  /** Lines that failed `JSON.parse` (truncated, pino-interleaved, corrupt). */
  readonly malformedLines: number;
}

/**
 * Parse one NDJSON transcript file. Malformed lines (truncated JSON, blank
 * lines, lines without recognizable structure) are skipped — the file is
 * best-effort observability data, not a load-bearing data source.
 *
 * Returns an empty array for missing files (the consumer handles the
 * empty-glob case as a no-op rather than throwing).
 *
 * For per-file telemetry, use `parseTranscriptWithStats` instead.
 */
export function parseTranscript(filePath: string): SessionEvent[] {
  return parseTranscriptWithStats(filePath).events;
}

export function parseTranscriptWithStats(
  filePath: string
): { events: SessionEvent[]; malformedLines: number; totalLines: number; missing: boolean } {
  if (!existsSync(filePath)) {
    return { events: [], malformedLines: 0, totalLines: 0, missing: true };
  }
  const raw = readFileSync(filePath, "utf8");
  const events: SessionEvent[] = [];
  let malformed = 0;
  let total = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    total++;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as SessionEvent);
      } else {
        // JSON.parse succeeded but yielded a primitive/array — not a session event.
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { events, malformedLines: malformed, totalLines: total, missing: false };
}

/**
 * Walk a transcript's events and yield one SkillInvocation per top-level
 * Skill tool_use. "Top-level" means `caller.type !== "skill"` — nested
 * skill-dispatched tool calls aren't double-counted.
 */
export function extractSkillInvocations(
  events: readonly SessionEvent[],
  transcriptPath: string
): SkillInvocation[] {
  const out: SkillInvocation[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (block.name !== "Skill") continue;
      const skillName = block.input?.skill;
      if (typeof skillName !== "string" || skillName.length === 0) continue;
      // Skip nested invocations dispatched by another skill — those re-fire on
      // every contained tool call, which would double-count for our purposes.
      if (block.caller?.type === "skill") continue;
      // Required fields: drop the invocation if uuid/sessionId/timestamp is missing.
      // Stamping a placeholder ("unknown") would poison findIndex in classifyInvocation —
      // two such invocations both resolve to the first one and silently corrupt outcomes.
      if (typeof ev.uuid !== "string" || ev.uuid.length === 0) continue;
      if (typeof ev.sessionId !== "string" || ev.sessionId.length === 0) continue;
      if (typeof ev.timestamp !== "string" || ev.timestamp.length === 0) continue;
      out.push({
        sessionId: ev.sessionId,
        timestamp: ev.timestamp,
        skillName,
        transcriptPath,
        eventUuid: ev.uuid,
        parentUuid: typeof ev.parentUuid === "string" ? ev.parentUuid : undefined,
      });
    }
  }
  return out;
}

/**
 * Apply the abandonment heuristic to a single invocation against its session's
 * event stream. Walks forward up to COMPLETION_TURN_WINDOW total turns and
 * decides at the end:
 *
 *  - abandoned: within 5 user-message turns, a user TEXT message contains
 *    a stop-word; OR within 3 assistant turns, a *different* Skill is invoked
 *    (top-level, same session). Returns immediately when either fires.
 *  - completed: walked past the abandonment windows without those signals
 *    AND saw at least one benign user text message — the conversation
 *    continued normally.
 *  - unknown: never saw a benign user message (typically the session
 *    was cut short before classification was possible).
 *
 * Critical invariant (was a bug pre-#57 review): we MUST NOT return
 * "completed" on the first benign user message. Doing so would make the
 * 5-turn abandonment window unreachable past turn 1 and silently inflate
 * trial completion rates.
 */
export function classifyInvocation(
  events: readonly SessionEvent[],
  invocation: SkillInvocation
): InvocationOutcome {
  const idx = events.findIndex((e) => e.uuid === invocation.eventUuid);
  if (idx === -1) return "unknown";

  let assistantTurns = 0;
  let userMessageTurns = 0;
  let totalTurns = 0;
  let sawBenignUserMessage = false;

  for (let i = idx + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.sessionId !== invocation.sessionId) continue;

    if (ev.type === "assistant") {
      assistantTurns++;
      totalTurns++;
      if (assistantTurns <= ABANDONMENT_TURN_WINDOW_PIVOT) {
        const pivotedSkill = findTopLevelSkillInvocation(ev);
        if (pivotedSkill && pivotedSkill !== invocation.skillName) {
          return "abandoned";
        }
      }
    } else if (ev.type === "user") {
      const text = extractUserText(ev);
      if (text === null) continue; // tool_result wrappers don't count as user turns
      userMessageTurns++;
      totalTurns++;
      if (userMessageTurns <= ABANDONMENT_TURN_WINDOW_USER && containsStopWord(text)) {
        return "abandoned";
      }
      sawBenignUserMessage = true;
    }

    if (totalTurns >= COMPLETION_TURN_WINDOW) break;
  }

  return sawBenignUserMessage ? "completed" : "unknown";
}

function findTopLevelSkillInvocation(ev: SessionEvent): string | null {
  const content = ev.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (block.name !== "Skill") continue;
    if (block.caller?.type === "skill") continue;
    if (typeof block.input?.skill === "string") return block.input.skill;
  }
  return null;
}

function extractUserText(ev: SessionEvent): string | null {
  const content = ev.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // tool_result wrappers carry no user-authored text; skip them entirely.
  const isToolResultOnly = content.every((b) => b.type === "tool_result");
  if (isToolResultOnly) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function containsStopWord(text: string): boolean {
  return STOP_PATTERNS.some((re) => re.test(text));
}

/**
 * Walk every `.jsonl` file under sessionDir, extract Skill invocations,
 * filter by `sinceISO` (lookback start), classify each, and return the
 * combined list together with parse telemetry. Idempotent (no side effects
 * beyond fs reads).
 *
 * Surfacing `parseStats` in the caller (the metrics report) is what makes
 * Claude Code transcript-format drift visible — without it, a future schema
 * change would silently zero out every skill's invocation count and the
 * trial verdict would flip to DROP for everything.
 */
export function collectInvocations(
  sessionDir: string,
  sinceISO: string
): { invocations: ClassifiedInvocation[]; parseStats: ParseStats } {
  if (!existsSync(sessionDir)) {
    return {
      invocations: [],
      parseStats: { filesScanned: 0, missingFiles: 0, totalLines: 0, malformedLines: 0 },
    };
  }
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const invocations: ClassifiedInvocation[] = [];
  let totalLines = 0;
  let malformedLines = 0;
  let missingFiles = 0;
  for (const f of files) {
    const filePath = join(sessionDir, f);
    const result = parseTranscriptWithStats(filePath);
    if (result.missing) missingFiles++;
    totalLines += result.totalLines;
    malformedLines += result.malformedLines;
    const fileInvocations = extractSkillInvocations(result.events, filePath).filter(
      (i) => i.timestamp >= sinceISO
    );
    for (const inv of fileInvocations) {
      invocations.push({ ...inv, outcome: classifyInvocation(result.events, inv) });
    }
  }
  return {
    invocations,
    parseStats: { filesScanned: files.length, missingFiles, totalLines, malformedLines },
  };
}
