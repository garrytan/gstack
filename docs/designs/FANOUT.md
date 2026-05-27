# /fanout — Design Doc

**Status:** v0 proposal (not yet implemented).
**Author:** sohmn, with AI-assisted brainstorming via Claude Opus 4.7.
**Target reviewer:** Garry Tan (PR review).
**Scope:** New gstack skill. No changes to existing skills.

## Problem

The current "vague idea → working code" path in gstack runs serially:

1. `/office-hours` explores the idea, validates it's worth building.
2. `/plan-eng-review` (or `/autoplan`) reviews architecture.
3. Author writes a design doc to `docs/designs/`.
4. A single agent picks up the design doc and implements it.

Step 4 is the bottleneck. A finished design doc with 3 independent subsystems still runs one agent at a time, end to end. Modern design docs commonly describe work that is structurally parallelizable: backend + frontend, schema migration + business logic + UI, API surface + client + CLI. The serial flow leaves wall-clock time on the table.

`/spec` already exists and handles a different shape of the problem: vague intent → filed GitHub issue → single agent via `--execute`. It does not consume an existing design doc and it does not fan out across multiple agents.

The gap: nothing in gstack takes a finished design doc and turns it into N parallel agent tasks.

## Why now

The user has run office-hours + eng-review + design enough times to feel the wall-clock cost of single-agent execution. Worktrees + multiple `claude -p` instances are already part of the gstack toolkit (used by `/ship`, `/spec --execute`, plan-review skills). The plumbing is there. What's missing is the orchestration layer that decides which slabs of a design doc are independent and emits the dispatch commands.

This is a small surface area: read a markdown file, identify slabs, write a section back to the file, write a shell script next to it. No new infrastructure, no new binaries, no eval cost.

## Scope for v0

The MVP is intentionally narrow. It produces the plan and stops. The user runs the dispatch script themselves when ready.

1. **New skill `/fanout`** in `fanout/SKILL.md.tmpl`. Generated `fanout/SKILL.md` via `bun run gen:skill-docs`.
2. **Single invocation form:** `/fanout <path-to-design-doc>`. Markdown file paths only in v0. GitHub issue URLs deferred.
3. **In-place append.** Skill writes a new `## Parallel Execution Plan` section to the bottom of the input file.
4. **Sidecar dispatch script.** Skill writes `worktree-dispatch.sh` next to the design doc, executable, with Slab 0 ready to run and Slabs 1-N commented out.
5. **No auto-execution.** v0 never calls `git worktree add` or `claude -p`. User runs the script when Slab 0 lands.
6. **Cap at 3 slabs.** Default `--max 3`. Override via `--max N`. Reasoning: more than 3 parallel agents on a single design is usually false parallelism. Coordination overhead eats the wins.

## Skill design

### Invocation

```
/fanout docs/designs/MY_FEATURE.md
/fanout docs/designs/MY_FEATURE.md --max 5
```

### Process

The skill runs as a single-phase agent prompt (no AskUserQuestion ping-pong unless a conflict needs disambiguation):

1. **Read the file.** Fail fast if the path doesn't exist or isn't markdown.
2. **Parse structure.** Look for slab candidates in this order:
   - `## Phase N` / `## Part N` / `## Component N` headers
   - `## Implementation Details` subsections
   - "Files Reference" tables (cluster files by top-level directory)
   - Natural seams (backend/frontend, schema/logic/UI, API/client/CLI)
3. **Identify Slab 0.** Scan for shared groundwork: type definitions, schema migrations, fixtures, shared constants, public interfaces. Anything referenced by 2+ slab candidates goes to Slab 0.
4. **Build slab matrix.** For each non-Slab-0 candidate, compute Writes / Reads / Public interface / Verification gate / ETA.
5. **Detect conflicts.** Any file that two slabs both write to is a conflict. Resolution order:
   - If the file is type/schema/constant: promote to Slab 0.
   - Otherwise: AskUserQuestion to pick which slab owns the file (or merge the two slabs).
6. **Enforce the slab cap.** If parsing yielded more slabs than `--max`, propose a merge: combine the two smallest by ETA, repeat until at or under the cap. AskUserQuestion before committing each merge so the user can veto a bad pairing.
7. **Write the section.** Append `## Parallel Execution Plan` to the design doc.
8. **Write the dispatch script.** Generate `worktree-dispatch.sh` next to the doc.
9. **Report.** One paragraph summary: N slabs identified, Slab 0 has X files, estimated wall-clock from M hours serial to K hours parallel.

### Output: `## Parallel Execution Plan` section template

```markdown
## Parallel Execution Plan

### Slab 0 — Synchronous prep

**Lands first.** One agent, single PR, ~30 min.

- **Writes:** [interfaces, types, schema migrations, fixtures, shared constants]
- **Verification gate:** [what proves Slab 0 is integratable — usually "tests pass + types compile"]

### Slab matrix

| # | Slab | Writes | Reads | Public interface | Verification gate | ETA |
|---|------|--------|-------|------------------|-------------------|-----|
| 1 | <name> | `path/a.ts`, `path/b.ts` | Slab 0: `types.ts` | exports `Foo` | `bun test path/a.test.ts` | 1h |
| 2 | <name> | `path/c.ts` | Slab 0: `types.ts` | exports `Bar` | `bun test path/c.test.ts` | 1.5h |
| 3 | <name> | `path/d.tsx` | Slab 0: `types.ts` | UI route `/x` | screenshot diff | 2h |

**Cross-slab reads (Slab N reads Slab M's output, M > 0) break parallelism.** When `/fanout` detects one, it picks one of three resolutions and asks the user to confirm: (a) promote Slab M's interface to Slab 0; (b) merge the two slabs; (c) accept the dependency and chain them in Merge order. Option (a) is the default proposal because it preserves the most parallelism.

### Conflict map

*(empty if no file is touched by 2+ slabs after Slab 0 promotion)*

### Merge order

1. Slab 0 → main (blocking).
2. Slabs 1, 2, 3 → rebase on Slab 0 after it lands. Any order.
3. Resolve CHANGELOG.md / VERSION conflicts via standard gstack queue rules.

### Dispatch

See [`worktree-dispatch.sh`](./worktree-dispatch.sh). Run Slab 0 first, wait for it to land on main, then uncomment Slabs 1-N and run in parallel.
```

### Output: `worktree-dispatch.sh` template

```bash
#!/usr/bin/env bash
# Generated by /fanout from <design-doc-path> on <date>.
# Step 1: Run Slab 0. Wait for it to land on main.
# Step 2: Uncomment Slabs 1-N. Run them in parallel.

set -e
cd "$(git rev-parse --show-toplevel)"

# Slab 0 — Synchronous prep
git worktree add ../<repo>-slab-0 -b slab-0/<topic>
(
  cd ../<repo>-slab-0
  claude -p "$(cat <<'EOF'
Read <design-doc-path>. Implement Slab 0 from the Parallel Execution Plan section:
- Writes: <files>
- Verification gate: <gate>
When the gate passes, commit, push, and open a PR via /ship.
EOF
)"
)

# After Slab 0 lands on main, uncomment and run these in parallel:
#
# git worktree add ../<repo>-slab-1 -b slab-1/<topic>
# (cd ../<repo>-slab-1 && claude -p "...Slab 1 prompt...") &
#
# git worktree add ../<repo>-slab-2 -b slab-2/<topic>
# (cd ../<repo>-slab-2 && claude -p "...Slab 2 prompt...") &
#
# git worktree add ../<repo>-slab-3 -b slab-3/<topic>
# (cd ../<repo>-slab-3 && claude -p "...Slab 3 prompt...") &
#
# wait
```

The commented-out lines for Slabs 1-N are intentional. Auto-running them before Slab 0 lands would have every parallel agent fighting over uncommitted shared types. The commented form makes the dependency explicit.

## Edge cases

1. **Design doc has no parsable structure.** Skill falls back to AskUserQuestion: "I couldn't auto-identify slabs. Want to walk through this interactively, or stop?"
2. **Only one slab identified.** Skill reports "this design doesn't decompose, single-agent execution recommended" and exits without writing the section or script.
3. **Slab 0 is empty.** Possible for designs where slabs share nothing. Section still gets written, Slab 0 row reads "None, no shared groundwork detected." The "lands first, blocking" semantics drop: Slabs 1-N can run in parallel from the start. Dispatch script reflects this by uncommenting Slabs 1-N immediately and omitting the Slab 0 worktree.
4. **All slabs write to one file.** Common for design docs that touch a single large file. Skill detects this and recommends "this isn't parallelizable as written. Either decompose the file first or accept single-agent execution."
5. **Design doc already has a `## Parallel Execution Plan` section.** Skill detects, AskUserQuestion: overwrite, append a v2, or abort?
6. **User passes a non-markdown file.** Hard fail with clear error.

## Out of scope (v0)

- GitHub issue URLs as input.
- Auto-spawning agents (`--execute` flag deferred to v1).
- Interactive dispatch (per-slab "spawn now?" prompts deferred to v1).
- Cross-repo slabs (all slabs assumed to be in the current repo).
- Re-running `/fanout` to update an existing plan after the design doc changes.
- Eval coverage. Skill is deterministic enough that a free `bun test` fixture is sufficient; paid E2E deferred until v1 adds dispatch.

## Files in the PR

```
fanout/
├── SKILL.md.tmpl          (new)
└── SKILL.md               (generated by bun run gen:skill-docs)

CHANGELOG.md               (new entry at top, release-summary format)
VERSION                    (MINOR bump — new user-facing capability)
README.md                  (one-line addition to skill list)
CLAUDE.md                  (one-line addition to "Skill routing" section)
setup                      (symlink line for fanout/, matches qa/, spec/, etc.)
test/                      (optional free test fixture for matrix-shape sanity)
```

No changes to `browse/`, `design/`, hosts/, or any existing skill template.

## CHANGELOG + VERSION

MINOR bump (new capability shipped, scale-aware bump per CLAUDE.md guidance). Release-summary section follows the format in CLAUDE.md: two-line bold headline, lead paragraph, "The numbers that matter" table (slabs identified per doc, estimated time saved vs serial), and "What this means for builders" closer. Itemized changes go in a separate `### Itemized changes` block below.

Voice: gstack direct, no em dashes, no AI vocabulary, real file names. Headline frames the wall-clock win, not the technical mechanism.

## Open questions

1. **Should `worktree-dispatch.sh` write to a non-default location?** Sitting next to the design doc means `docs/designs/worktree-dispatch.sh`. That directory becomes cluttered if multiple designs run `/fanout`. Alternative: `~/.gstack-dev/dispatch/<doc-name>.sh`. v0 choice: alongside the doc for visibility. Revisit if it becomes noisy.
2. **Slab naming convention.** `slab-0`, `slab-1` for branches is generic. Better to derive from the slab's content (`slab-schema-migration`, `slab-ui`). v0 choice: descriptive names derived from slab title, with `slab-` prefix.
3. **What if the user runs `/fanout` on a design doc that was authored by `/spec`?** `/spec` outputs to GitHub issues, not files. v0 only handles files. If user pulls a `/spec`-authored issue body into a markdown file first, `/fanout` works on it normally. Documented in the skill prompt.

## Definition of done

1. `/fanout docs/designs/SOMETHING.md` runs to completion on a real design doc and produces a valid Parallel Execution Plan section + dispatch script.
2. Generated SKILL.md passes `bun test` (skill validation + gen-skill-docs quality checks).
3. CHANGELOG entry follows the release-summary format. VERSION bumped MINOR.
4. README + CLAUDE.md routing lines added.
5. PR review pass via `/review`. No regressions to existing skills.
