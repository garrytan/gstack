# Session Intelligence Layer

## The Problem

Claude Code's context window is ephemeral. Every session starts fresh. When
auto-compaction fires at ~167K tokens, it preserves a generic summary but
destroys file reads, reasoning chains, and intermediate decisions.

gstack already produces valuable artifacts that survive on disk: CEO plans,
eng reviews, design reviews, QA reports, learnings. These files contain
decisions, constraints, and context that shaped the current work. But Claude
doesn't know they exist. After compaction, the plans and reviews that
informed every decision silently vanish from context.

The ecosystem is working on this. claude-mem (9K+ stars) captures tool usage
and injects context into future sessions. Claude HUD shows real-time agent
status. Anthropic's own `claude-progress.txt` pattern uses a progress file
that agents read at the start of each session.

Nobody is solving the specific problem of making **skill-produced artifacts**
survive compaction. Because nobody else has gstack's artifact architecture.

## The Insight

gstack already writes structured artifacts to `~/.gstack/projects/$SLUG/`:
- CEO plans: `ceo-plans/`
- Design reviews: `design-reviews/`
- Eng reviews: `eng-reviews/`
- Learnings: `learnings.jsonl`
- Skill usage: `../analytics/skill-usage.jsonl`

The missing piece is not storage. It's awareness. The preamble needs to tell
the agent: "These files exist. They contain decisions you've already made.
After compaction, re-read them."

## The Architecture

```
                   ┌─────────────────────────────────────┐
                   │        Claude Context Window         │
                   │   (ephemeral, ~167K token limit)     │
                   │                                      │
                   │   Compaction fires ──► summary only   │
                   └──────────────┬──────────────────────┘
                                  │
                          reads on start / after compaction
                                  │
                   ┌──────────────▼──────────────────────┐
                   │    ~/.gstack/projects/$SLUG/         │
                   │    (persistent, survives everything) │
                   │                                      │
                   │  ceo-plans/         ← /plan-ceo-review
                   │  eng-reviews/       ← /plan-eng-review
                   │  design-reviews/    ← /plan-design-review
                   │  checkpoints/       ← /checkpoint (new)
                   │  timeline.jsonl     ← every skill (new)
                   │  learnings.jsonl    ← /learn
                   └─────────────────────────────────────┘
                                  │
                          rolled up weekly
                                  │
                   ┌──────────────▼──────────────────────┐
                   │           /retro                      │
                   │  Timeline: 3 /review, 2 /ship, ...   │
                   │  Health trends: compile 8/10 (↑2)     │
                   │  Learnings applied: 4 this week       │
                   └─────────────────────────────────────┘
```

## The Features

### Layer 1: Context Recovery (preamble, all skills)
~10 lines of prose in the preamble. After compaction or context degradation,
the agent checks `~/.gstack/projects/$SLUG/` for recent plans, reviews, and
checkpoints. Lists the directory, reads the most recent file.

Cost: near-zero. Benefit: every skill's plans/reviews survive compaction.

### Layer 2: Session Timeline (preamble, all skills)
Every skill appends a one-line JSONL entry to `timeline.jsonl`: timestamp,
skill name, branch, key outcome. `/retro` renders it.

Makes the project's AI-assisted work history visible. "This week: 3 /review,
2 /ship, 1 /investigate across branches feature-auth and fix-billing."

### Layer 3: Cross-Session Injection (preamble, all skills)
When a new session starts on a branch with recent artifacts, the preamble
prints a one-liner: "Last session: implemented JWT auth, 3/5 tasks done.
Plan: ~/.gstack/projects/$SLUG/checkpoints/latest.md"

The agent knows where you left off before reading any files.

### Layer 4: /checkpoint (opt-in skill)
Manual snapshot of working state: what's being done, files being edited,
decisions made, what's remaining. Useful before stepping away, before
complex operations, for workspace handoffs, or coming back after days.

### Layer 5: /health (opt-in skill)
Code quality dashboard: type-check, lint, test suite, dead code scan.
Composite 0-10 score. Tracks over time. `/retro` shows trends. `/ship`
gates on configurable threshold.

## The Compounding Effect

Each feature is independently useful. Together, they create something
that compounds:

Session 1: /plan-ceo-review produces a plan. Saved to disk.
Session 2: Agent reads the plan after preamble. Doesn't re-ask decisions.
Session 3: /checkpoint saves progress. Timeline shows 2 /review, 1 /ship.
Session 4: Compaction fires mid-refactor. Agent re-reads the checkpoint.
           Recovers key decisions, types, remaining work. Continues.
Session 5: /retro rolls up the week. Health trend: 6/10 → 8/10.
           Timeline shows 12 skill invocations across 3 branches.

The project's AI history is no longer ephemeral. It persists, compounds,
and makes every future session smarter. That's the session intelligence
layer.

## What This Is Not

- Not a replacement for Claude's built-in compaction (that handles session
  state; we handle gstack artifacts)
- Not a full memory system like claude-mem (that handles cross-session
  memory via SQLite; we handle structured skill artifacts)
- Not a database or service (just markdown files on disk)

## Research Sources

- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [claude-mem](https://github.com/thedotmack/claude-mem)
- [Claude HUD](https://github.com/jarrodwatts/claude-hud)
- [CodeScene: Agentic AI coding best practices](https://codescene.com/blog/agentic-ai-coding-best-practice-patterns-for-speed-with-quality)
- [Post-compaction recovery via git-persisted state (Beads)](https://dev.to/jeremy_longshore/building-post-compaction-recovery-for-ai-agent-workflows-with-beads-207l)
