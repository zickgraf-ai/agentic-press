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
 * Parse one NDJSON transcript file. Malformed lines (truncated JSON, blank
 * lines, lines without recognizable structure) are skipped silently — the
 * file is best-effort observability data, not a load-bearing data source.
 *
 * Returns an empty array for missing files (the consumer handles the
 * empty-glob case as a no-op rather than throwing).
 */
export function parseTranscript(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const out: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as SessionEvent);
      }
    } catch {
      // Truncated/corrupt line — skip.
    }
  }
  return out;
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
      out.push({
        sessionId: typeof ev.sessionId === "string" ? ev.sessionId : "unknown",
        timestamp: typeof ev.timestamp === "string" ? ev.timestamp : new Date(0).toISOString(),
        skillName,
        transcriptPath,
        eventUuid: typeof ev.uuid === "string" ? ev.uuid : "unknown",
        parentUuid: typeof ev.parentUuid === "string" ? ev.parentUuid : undefined,
      });
    }
  }
  return out;
}

/**
 * Apply the abandonment heuristic to a single invocation against its session's
 * event stream. Walks forward from the invocation's event:
 *
 *  - abandoned: within 5 user-message turns, the next user TEXT message
 *    contains a stop-word; OR within 3 assistant turns, a *different*
 *    Skill is invoked (top-level, same session).
 *  - completed: within 20 turns, a benign user message arrives.
 *  - unknown: neither signal observed within the windows (typically the
 *    session was cut short).
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

  for (let i = idx + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.sessionId !== invocation.sessionId) continue;

    if (ev.type === "assistant") {
      assistantTurns++;
      totalTurns++;
      // Pivot to a different Skill within 3 assistant turns → abandoned.
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
      if (userMessageTurns <= ABANDONMENT_TURN_WINDOW_USER) {
        if (containsStopWord(text)) return "abandoned";
      }
      if (totalTurns <= COMPLETION_TURN_WINDOW) {
        return "completed";
      }
    }

    if (totalTurns > COMPLETION_TURN_WINDOW) break;
  }

  return "unknown";
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
 * combined list. Idempotent (no side effects beyond fs reads).
 */
export function collectInvocations(
  sessionDir: string,
  sinceISO: string
): ClassifiedInvocation[] {
  if (!existsSync(sessionDir)) return [];
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const out: ClassifiedInvocation[] = [];
  for (const f of files) {
    const filePath = join(sessionDir, f);
    const events = parseTranscript(filePath);
    const invocations = extractSkillInvocations(events, filePath).filter(
      (i) => i.timestamp >= sinceISO
    );
    for (const inv of invocations) {
      out.push({ ...inv, outcome: classifyInvocation(events, inv) });
    }
  }
  return out;
}
