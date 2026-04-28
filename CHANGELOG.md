# Changelog

## 1.1.0 — Rename "provenance" to "research log"

### What's new

- **Clearer terminology.** The reproducibility record produced by every experiment
  run is now called the **research log** instead of "provenance bundle". This
  better matches what the file actually captures: the trace of code, environment,
  and parameters that led to a given result. The file written next to results
  is now `research-log.json` (was `provenance.json`).
- **Backward compatible reads.** `/report`, `/discuss`, and `/peer-review` read
  `research-log.json` first and fall back to `provenance.json` if it does not
  exist. Past experiments keep working without manual changes.
- **Migration script.** Run `bin/rstack-migrate-provenance` (or
  `--dry-run` first) to rename existing `provenance.json` files in bulk under
  `research/results/`. Optional — only needed if you want consistent naming
  across old and new runs.

### Internal

- `generateProvenanceSpec` → `generateResearchLogSpec`,
  template variable `{{PROVENANCE_SPEC}}` → `{{RESEARCH_LOG_SPEC}}`,
  Python helper `capture_provenance` → `capture_research_log`.

## 1.0.0 — Public Release

### What's new

- **Standalone identity.** All internal tooling renamed from `gstack-*` to `rstack-*`.
  State directory moved from `~/.gstack/` to `~/.research-stack/`.
  Environment variables: `RSTACK_HOME`, `RSTACK_STATE_DIR`.
- **Clean repository.** Removed orphaned documentation inherited from the gstack fork
  (AGENTS.md, BROWSER.md, DESIGN.md, TODOS.md, docs/designs/, docs/images/).
- **Updated metadata.** LICENSE copyright, package.json repository/homepage fields,
  and .gitignore entries updated for the public repository.

### Internal

- 8 bisected commits for clean git history and safe rollback.
- All 117 tests passing.

## 0.3.0 — Workflow Improvements

### What's new

- **Workflow continuity.** Each skill now suggests the next step in the research cycle
  (hypothesis -> run-experiment -> report -> discuss -> peer-review -> hypothesis).
- **Skill decision tree.** Root SKILL.md includes "Which Skill Do I Need?" guidance
  for new users.
- **Learnings search in /discuss.** Discussions now search past learnings for context
  before starting.
- **Interactive dead-end detection in /hypothesis.** Detects when a hypothesis has been
  tried before and offers to skip, pivot, or proceed.
- **Reduced prompt fatigue.** /discuss uses natural conversation flow instead of
  per-turn AskUserQuestion prompts.

## 0.2.1 — Smoke Tests

### What's new

- **Resolver smoke tests.** Validates resolver output for all template variables.
- **Gen-skill-docs pipeline tests.** Ensures generated SKILL.md files stay fresh.
- **Cross-skill data chain tests.** Verifies artifact handoff between skills.

## 0.2.0 — Five Skills Complete

### What's new

- **/discuss** skill for interactive report discussions with data-grounded analysis.
- **/peer-review** skill for critical methodology and statistics review.
- Root SKILL.md routing for all 5 skills.
- Learnings system integration across all skills.

## 0.1.0 — Initial Research Stack

### What's new

- **/hypothesis** skill for structuring research ideas into testable specs.
- **/run-experiment** skill with approval gate and provenance tracking.
- **/report** skill for result analysis, baseline comparison, and plot generation.
- Template system with resolvers for research conventions, provenance, and experiment structure.
- CLI utilities for slug detection, learnings, and timeline logging.
