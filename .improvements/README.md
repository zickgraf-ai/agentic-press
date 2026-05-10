# `.improvements/` — Self-Improvement Suggestions

Closes [#20](https://github.com/zickgraf-ai/agentic-press/issues/20).

This directory holds **agent-suggested improvement candidates** waiting for human triage. Each `.md` file is one suggestion. The system observes patterns in the proxy's audit log and surfaces them here — it never applies its own suggestions. Effects only flow through human-reviewed PRs.

## How it works

```
audit.ndjson  ───►  scripts/sweep-improvements.mjs  ─►  .improvements/<id>.md  ─►  human triage
                                                                                    │
                                                                                    ├─► dismiss (edit frontmatter or delete)
                                                                                    ├─► edit (open the file, refine the suggestion)
                                                                                    └─► address (npm run address-improvement -- <id>)
                                                                                                │
                                                                                                └─► draft PR with suggestion as description
                                                                                                    │
                                                                                                    └─► you (or another Claude Code session) implement,
                                                                                                        mark ready for review, merge as usual
```

The MVP reads only the audit NDJSON. Future categories will pull in additional inputs (git log for TDD-skip detection, test outcomes for flake detection, Langfuse traces for token-heavy session detection) — see "Categories" below for the roadmap.

## Categories detected today

| Category | Trigger |
|---|---|
| `allowlist-drift` | Same tool blocked ≥3 times across recent sessions |
| `tool-failure` | Same tool returned `status=error` ≥3 times |
| `skill-usage` | Vendored skill never invoked after 14d grace, OR ≥3 invocations with ≥50% abandonment |

Future categories (bridge timeout, token-heavy session, stale setup commands) plug in as additional grouping passes — see `src/improvements/detector.ts`.

## Sweep

The cleanest workflow is to capture audit entries to a dedicated file via the proxy's `AUDIT_LOG_FILE` env var, then sweep that file. Synchronous writes mean no buffering surprises, and no need to filter pino diagnostics out of stdout.

```bash
# 1. start the proxy with AUDIT_LOG_FILE set (in your shell or .env)
AUDIT_LOG_FILE=/tmp/proxy-audit.ndjson npm run dev

# 2. (in another terminal, after some traffic has flowed)
npm run sweep-improvements -- --input /tmp/proxy-audit.ndjson
```

Without `AUDIT_LOG_FILE`, audit entries go to stdout interleaved with pino diagnostics. You can still sweep by filtering out the pino lines, but the dedicated-file path is recommended:

```bash
# legacy: pipe stdout through grep, then to sweep
grep -v '"level":' /tmp/proxy-stdout.log | npm run sweep-improvements
```

Other options:

```bash
# specify directory and per-run cap (default 3)
npm run sweep-improvements -- --dir .improvements --max 5

# pipe directly via stdin (e.g., from a tail process)
tail -f /tmp/proxy-audit.ndjson | npm run sweep-improvements
```

Idempotent: re-running on the same day with the same evidence is a no-op (deterministic IDs from date + category + evidence key).

## Address

Once you've reviewed a suggestion:

```bash
npm run address-improvement -- 2026-04-26-allowlist-drift-execute
```

This creates `improvement/<id>` branch, marks the file as `addressed`, commits, pushes, and opens a **draft PR** seeded with the suggestion as the description. The draft state means it can't be accidentally merged — you (or a follow-on session) implement, then mark ready.

## Mission Control review (optional)

Mission Control's Memory Browser can render this directory as a tree view if you point it at the worktree. The "Address" action in MC's UI calls the same `address-improvement` script. MC integration is opt-in — everything works equally well with `cat`, `code .improvements/`, or GitHub's directory browser.

## Security model

- **Nothing in `.improvements/` is auto-loaded into agent context.** CLAUDE.md describes the directory's *existence and workflow*, but doesn't include suggestion contents — the `@.learnings/LEARNING_INDEX.md` import is the only auto-loaded reflective content.
- **Memory poisoning vector closed by design.** The agent observes; the human decides; only human-merged PRs propagate effects.
- **Trust boundary unchanged.** Files in `.improvements/` have the same trust as any other tracked file in the repo — i.e., none until you read and merge them.

## Skill-usage metrics (#55 trial)

The 5 vendored Superpowers skills under `.claude/skills/` are on a 3-week trial. Each weekly sweep produces a regenerated dashboard at `.improvements/metrics/skill-usage-YYYY-MM-DD.md` (gitignored — local only) and writes anti-signal Suggestions for never-used or high-abandonment skills using the `skill-usage` category above.

Inputs:
- Vendored skills are detected by the `## Provenance` footer in their `SKILL.md` (so project-authored skills aren't mixed in).
- Skill invocations come from Claude Code session transcripts at `~/.claude/projects/<encoded-cwd>/*.jsonl`. The parser counts top-level `Skill` tool_use events (skips `caller.type === "skill"` nested calls) and classifies each by the next-N-turns heuristic (`src/improvements/skill-transcript.ts`).

Run on demand:

```bash
npm run sweep-skill-metrics
```

Or schedule weekly via the macOS launchd job:

```bash
./scripts/install-skill-metrics-cron.sh   # Mondays 09:00 local
```

### Trial criteria (decision date 2026-05-30)

| Skill | KEEP | DROP | Notes |
|---|---|---|---|
| `systematic-debugging` | ≥3 sessions, completion ≥70% | <2 invocations after 14d | |
| `brainstorming` | ≥2 sessions, completion ≥70% | <2 invocations after 14d | |
| `verification-before-completion` | ≥5 invocations | <2 invocations after 14d | High-frequency reflexive skill — low bar |
| `writing-skills` | (measure only) | (measure only) | Meta-skill, exempt from auto-drop |
| `subagent-driven-development` | ≥2 sessions, completion ≥70% | <2 invocations after 14d | |

A skill that fires its `skill-usage` Suggestion in week 2 AND week 3 is auto-flagged DROP in the week-3 report. The drop action is human-driven (`git rm -r .claude/skills/<name>` + CLAUDE.md update). Verdicts in the report (`KEEP`/`DROP`/`MEASURE`/`UNDECIDED`) are recommendations, not automatic actions.

### Source-of-truth files

- Detector: `src/improvements/detector.ts:detectSkillUsageImprovements`
- Parser: `src/improvements/skill-transcript.ts`
- Report: `src/improvements/skill-usage-report.ts`
- Sweep wiring: `scripts/sweep-improvements.mjs` (Phase 2 block)
- Trial criteria: this file (above) + per-skill rules in `src/improvements/skill-usage-report.ts:VERDICT_RULES`

## Relationship to `.learnings/`

`.learnings/` holds **validated, human-curated lessons** — referenced by `CLAUDE.md` and auto-loaded into project context. `.improvements/` holds **raw signal awaiting triage** — never auto-loaded.

When you address a suggestion and discover a generalizable rule, write a corresponding `.learnings/` entry by hand. The two directories complement each other: `.improvements/` is the inbox, `.learnings/` is the playbook.
