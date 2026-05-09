# Superpowers cherry-pick: trial criteria and "is this skill paying off?"

**Date:** 2026-05-09
**Category:** process / observability
**Issue:** #55

## Lesson

When you vendor or install a skill from an external marketplace, define the success criteria *before* the trial starts and instrument the metric, or you'll never know whether the skill is pulling its weight. Calendar-based "let's check back in a few weeks" prompts are noise — the only useful check is one tied to data you can see.

## Why this matters

In #55 we cherry-picked 5 skills from `obra/superpowers` rather than installing the full plugin (most of the plugin overlapped with existing `CLAUDE.md` directives and the installed `pr-review-toolkit`). Without measurement, "did this help?" becomes vibes-driven a month later. With measurement, we have a defensible keep/drop decision per skill based on real session data.

## How to apply

When considering whether a vendored skill is providing value, **read the latest report** rather than relying on impression:

```bash
ls -t .improvements/metrics/skill-usage-*.md | head -1 | xargs cat
```

The report's per-skill verdict line uses these criteria (also encoded in `src/improvements/skill-usage-report.ts:VERDICT_RULES`):

- `systematic-debugging`: KEEP if ≥3 sessions used and completion ≥70%; DROP if <2 invocations after 14-day grace.
- `brainstorming`: KEEP if ≥2 sessions used and completion ≥70%; DROP if <2 invocations after 14-day grace.
- `verification-before-completion`: KEEP if ≥5 invocations (high-frequency reflexive skill, low bar); DROP if <2 invocations after 14-day grace.
- `writing-skills`: MEASURE only — meta-skill, naturally low frequency, never auto-flagged.
- `subagent-driven-development`: KEEP if ≥2 sessions used and completion ≥70%; DROP if <2 invocations after 14-day grace.

Anti-signal Suggestions also fire automatically into `.improvements/<id>.md` for actionable cases (never-used after grace; ≥3 invocations with ≥50% abandonment).

If a skill fires its anti-signal in week 2 AND week 3, the week-3 report flags it DROP — but the action is human-driven (`git rm -r .claude/skills/<name>` + this CLAUDE.md update), never automatic.

**For future skill adoptions:** before vendoring a new skill, write the criteria first. If you can't articulate "what would it look like for this skill to be valuable," don't vendor it.

## See also

- `~/Obsidian/claude-workspace/Plans/superpowers-cherrypick.md` — full design plan
- `.improvements/README.md` — *Skill-usage metrics* section
- `src/improvements/skill-usage-report.ts` — verdict-rule source of truth
