# Sprint Guide

You describe a product idea. `/office-hours` challenges it. `/autoplan` reviews it. You build it. `/review` catches bugs. `/ship` opens the PR. `/retro` tells you what went well.

**Think → Plan → Build → Review → Test → Ship → Reflect**

Each skill writes output that the next skill reads. This guide walks through each phase.

---

## Think: `/office-hours`

Start here. Before you plan, before you review, before you write code.

You describe what you're building. `/office-hours` asks hard questions, challenges your framing, and makes you prove the problem is real. Two modes:

- **Startup mode** for founders. Six forcing questions about demand, status quo, target user, narrowest wedge, observation, and future-fit. These are uncomfortable on purpose.
- **Builder mode** for hackathons, side projects, open source. Helps you find the coolest version of your idea.

Both end with a design doc written to disk. That doc feeds directly into every downstream skill.

### Example

```
You:    I want to build a daily briefing app for my calendar.
        /office-hours

Claude: [asks about the pain, specific examples, not hypotheticals]

You:    Multiple Google calendars, events with stale info, wrong locations.
        Prep takes forever and the results aren't good enough...

Claude: I'm going to push back on the framing. You said "daily briefing
        app." But what you actually described is a personal chief of
        staff AI.
        [extracts 5 capabilities you didn't realize you were describing]
        [challenges 4 premises, you agree, disagree, or adjust]
        [generates 3 implementation approaches with effort estimates]
        RECOMMENDATION: Ship the narrowest wedge tomorrow, learn from
        real usage.
        [writes design doc → feeds into downstream skills automatically]
```

You said "daily briefing app." The agent said "you're building a chief of staff AI" because it listened to your pain, not your feature request.

---

## Plan: `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan`

Lock in the plan before writing code. Four review specialists, each with a different lens:

| Skill | What it does |
|-------|-------------|
| `/plan-ceo-review` | Rethink the problem. Find the 10-star product. Challenge scope. |
| `/plan-eng-review` | Lock architecture, data flow, edge cases, test coverage. |
| `/plan-design-review` | Rate each design dimension 0-10. Fix the plan to get there. |
| `/plan-devex-review` | DX audit for developer-facing products. |

Or run `/autoplan` to execute all applicable reviews in sequence. It reads the design doc from `/office-hours`, figures out which reviews apply, runs them, and surfaces only the taste decisions for your approval.

---

## Build

Exit plan mode and implement. The plan is your spec. Claude writes the code.

This phase doesn't have a dedicated skill yet. Coming soon: `/build`.

---

## Review: `/review`, `/codex`

Find the bugs that pass CI but blow up in production.

| Skill | What it does |
|-------|-------------|
| `/review` | Staff-engineer code review. Auto-fixes obvious issues. Currently SWE-focused. |
| `/codex` | Independent second opinion from OpenAI Codex CLI. Three modes: review, adversarial challenge, open consultation. |

When both have reviewed the same branch, you get a cross-model analysis showing which findings overlap and which are unique to each model.

---

## Test: `/qa`, `/qa-only`, `/benchmark`

Real browser. Real clicks. Real bugs found.

| Skill | What it does |
|-------|-------------|
| `/qa` | Open your app in a real Chromium browser. Click through flows. Find bugs. Fix them. Auto-generate regression tests. |
| `/qa-only` | Same methodology, report only. No code changes. |
| `/benchmark` | Page load times, Core Web Vitals, resource sizes. Compare before/after. |

The agent has eyes. `/browse` gives it a persistent Chromium daemon with ~100ms per command.

---

## Ship: `/ship`, `/land-and-deploy`, `/canary`

PR to production.

| Skill | What it does |
|-------|-------------|
| `/ship` | Tests, coverage audit, PR. Bootstraps test frameworks if you don't have one. |
| `/land-and-deploy` | Merge, deploy, verify production health. |
| `/canary` | Post-deploy monitoring. Watches for errors and regressions. |

---

## Reflect: `/retro`, `/document-release`

Learn from what you shipped. Keep docs current.

| Skill | What it does |
|-------|-------------|
| `/retro` | Weekly retro. Per-person breakdowns, shipping streaks, test health trends. `/retro global` runs across all your projects. |
| `/document-release` | Reads every doc, cross-references the diff, updates everything that drifted. |

`/ship` auto-invokes `/document-release` so docs stay current without an extra command.

---

## Running multiple sprints at once

nstack is useful with one sprint. It gets interesting with ten running at once.

[Conductor](https://conductor.build) runs multiple Claude Code sessions in parallel, each in its own isolated workspace. One session running `/office-hours` on a new idea, another doing `/review` on a PR, a third implementing a feature, a fourth running `/qa` on staging. The sprint structure is what makes this work. Without a process, ten agents is ten sources of chaos. With a process, each agent knows what to do and when to stop.

### Design pipeline

`/design-consultation` builds your design system from scratch. `/design-shotgun` generates 4-6 AI mockup variants and opens a comparison board in your browser. `/design-html` turns the approved mockup into production HTML.

### Browser

`/open-nstack-browser` launches NStack Browser -- AI-controlled Chromium with anti-bot stealth and the sidebar extension built in. The sidebar agent accepts natural language commands. `/pair-agent` lets multiple AI agents coordinate through a shared browser with tab isolation.

### Safety

`/careful` warns before destructive commands. `/freeze` locks edits to one directory while debugging. `/guard` activates both.

### Troubleshooting

**Skill not showing up?** `cd ~/.claude/skills/nstack && ./setup`

**`/browse` fails?** `cd ~/.claude/skills/nstack && bun install && bun run build`

**Stale install?** Run `/nstack-upgrade` or set `auto_upgrade: true` in `~/.nstack/config.yaml`

---

## Further reading

- [Skill Deep Dives](skills.md) -- philosophy, examples, and workflow for every skill
- [Builder Ethos](../ETHOS.md) -- the principles behind nstack
- [Browser Reference](../BROWSER.md) -- full `/browse` command reference
