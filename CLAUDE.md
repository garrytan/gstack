# gstack development

Topic-specific guidance is split into `.claude/rules/*.md` that load lazily when
Claude reads matching files. This file holds always-on universal context.

## Commands

```bash
bun install          # install dependencies
bun test             # run free tests (browse + snapshot + skill validation)
bun run test:evals   # run paid evals: LLM judge + E2E (diff-based, ~$4/run max)
bun run test:evals:all  # run ALL paid evals regardless of diff
bun run test:gate    # run gate-tier tests only (CI default, blocks merge)
bun run test:periodic  # run periodic-tier tests only (weekly cron / manual)
bun run test:e2e     # run E2E tests only (diff-based, ~$3.85/run max)
bun run test:e2e:all # run ALL E2E tests regardless of diff
bun run eval:select  # show which tests would run based on current diff
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # gen docs + compile binaries
bun run gen:skill-docs  # regenerate SKILL.md files from templates
bun run skill:check  # health dashboard for all skills
bun run dev:skill    # watch mode: auto-regen + validate on change
bun run eval:list    # list all eval runs from ~/.gstack-dev/evals/
bun run eval:compare # compare two eval runs (auto-picks most recent)
bun run eval:summary # aggregate stats across all eval runs
bun run slop          # full slop-scan report (all files)
bun run slop:diff     # slop findings in files changed on this branch only
```

`test:evals` requires `ANTHROPIC_API_KEY`. Codex E2E tests (`test/codex-e2e.test.ts`)
use Codex's own auth from `~/.codex/` config — no `OPENAI_API_KEY` env var needed.

**Env keys in Conductor workspaces.** The `GSTACK_*` env-shim (v1.39.2.0+,
`lib/conductor-env-shim.ts`) promotes `GSTACK_ANTHROPIC_API_KEY` /
`GSTACK_OPENAI_API_KEY` to their canonical names inside gstack's TS binaries.
Tests run through gstack entrypoints inherit this promotion automatically.
Don't echo the key value to stdout, logs, or shell history. When passing to a
test's Agent SDK, do NOT pass `env: {...}` to `runAgentSdkTest` — the SDK's
auth pipeline doesn't pick up the key the same way when env is supplied as an
object (confirmed failure mode). Mutate `process.env.ANTHROPIC_API_KEY`
ambiently before the call and restore in `finally`.

E2E tests stream progress in real-time (tool-by-tool via `--output-format stream-json
--verbose`). Results are persisted to `~/.gstack-dev/evals/` with auto-comparison
against the previous run.

**Diff-based test selection:** `test:evals` and `test:e2e` auto-select tests based
on `git diff` against the base branch. Each test declares its file dependencies in
`test/helpers/touchfiles.ts`. Changes to global touchfiles (session-runner, eval-store,
touchfiles.ts itself) trigger all tests. Use `EVALS_ALL=1` or the `:all` script
variants to force all tests. Run `eval:select` to preview which tests would run.

**Two-tier system:** Tests are classified as `gate` or `periodic` in `E2E_TIERS`
(in `test/helpers/touchfiles.ts`). CI runs only gate tests (`EVALS_TIER=gate`);
periodic tests run weekly via cron or manually. Use `EVALS_TIER=gate` or
`EVALS_TIER=periodic` to filter. When adding new E2E tests, classify them:
1. Safety guardrail or deterministic functional test? -> `gate`
2. Quality benchmark, Opus model test, or non-deterministic? -> `periodic`
3. Requires external service (Codex, Gemini)? -> `periodic`

## Testing

```bash
bun test             # run before every commit — free, <2s
bun run test:evals   # run before shipping — paid, diff-based (~$4/run max)
```

`bun test` runs skill validation, gen-skill-docs quality checks, and browse
integration tests. `bun run test:evals` runs LLM-judge quality evals and E2E
tests via `claude -p`. Both must pass before creating a PR.

## Project structure

| Area | Purpose |
|---|---|
| `browse/` | Headless browser CLI (Playwright). `browse/src/commands.ts` is the command registry; `browse/src/snapshot.ts` has `SNAPSHOT_FLAGS`. |
| `design/` | Design binary CLI (GPT Image API). |
| `extension/` | Chrome extension (side panel + terminal pane + activity feed). |
| `hosts/` | Typed host configs (one per AI agent: claude, codex, openclaw, etc.). |
| `scripts/` | Build + DX tooling. `gen-skill-docs.ts` generates SKILL.md from `.tmpl`; `resolvers/` are template fragments. |
| `test/` | Skill validation + eval tests. Tier 1 (free, <1s), Tier 2 E2E (~$3.85/run), Tier 3 LLM-judge (~$0.15/run). |
| `lib/` | Shared libraries (worktree.ts, conductor-env-shim.ts). |
| `bin/` | CLI utilities (gstack-repo-mode, gstack-slug, gstack-config, gstack-next-version, etc.). |
| `<skill-name>/` | Each skill is a top-level directory with `SKILL.md.tmpl` (source) and `SKILL.md` (generated). |
| `openclaw/skills/` | Hand-crafted methodology skills published to ClawHub. |
| `contrib/` | Contributor-only tools (never installed for users). |
| `.github/` | CI workflows + Docker image. |
| `docs/designs/` | Design documents. |
| `setup` | One-time setup: build binary + symlink skills. |
| `SKILL.md.tmpl` | Edit this; `SKILL.md` is generated. |
| `ETHOS.md` | Builder philosophy (Boil the Lake, Search Before Building). |

Full directory tree: see `ARCHITECTURE.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore

## Browser interaction

Use the `/browse` skill or run the browse binary directly via `$B <command>`. NEVER
use `mcp__claude-in-chrome__*` tools — they are slow, unreliable, and not what this
project uses.

## Dev symlink awareness

When developing gstack, `.claude/skills/gstack` may be a symlink back to this
working directory (gitignored). Skill changes are **live immediately** — great for
rapid iteration, risky during big refactors where half-written skills could break
concurrent gstack sessions.

**Check once per session:** Run `ls -la .claude/skills/gstack`. If it's a symlink
to your working directory, template edits + `bun run gen:skill-docs` immediately
affect all gstack invocations. During large refactors, remove the symlink
(`rm .claude/skills/gstack`) so the global install at `~/.claude/skills/gstack/`
is used instead.

**Prefix setting:** Setup creates real directories (not symlinks) at the top level
with a SKILL.md symlink inside (e.g., `qa/SKILL.md -> gstack/qa/SKILL.md`). Names
are either short (`qa`) or namespaced (`gstack-qa`), controlled by `skill_prefix`
in `~/.gstack/config.yaml`. Pass `--no-prefix` or `--prefix` to skip the prompt.

**Note:** Vendoring gstack into a project's repo is deprecated. Use global install
+ `./setup --team` instead. See README.md for team mode instructions.

## Commit style

**Always bisect commits.** Every commit should be a single logical change. When
you've made multiple changes (e.g., a rename + a rewrite + new tests), split them
into separate commits before pushing. Each commit should be independently
understandable and revertable.

Examples of good bisection:
- Rename/move separate from behavior changes
- Test infrastructure (touchfiles, helpers) separate from test implementations
- Template changes separate from generated file regeneration
- Mechanical refactors separate from new features

When the user says "bisect commit" or "bisect and push," split staged/unstaged
changes into logical commits and push.

**When staging files, use specific filenames** (`git add file1 file2`) — never
`git add .` or `git add -A`. The `browse/dist/` and `design/dist/` directories are
tracked but should never be re-staged. See `.claude/rules/binaries.md`.

## Checking out PRs from garrytan-agents

When the user says "check out <PR link>" and the PR is from `garrytan-agents/gstack`
(or any other fork that is NOT a collaborator on `garrytan/gstack`), do NOT just
`gh pr checkout`. Fork PRs don't receive base-repo secrets (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, etc.), so the eval/E2E CI jobs fail with empty-env auth errors
regardless of what's set on the base repo.

**Workflow:** push the branch to `garrytan/gstack` (the base repo) and re-target
the PR from there.

Concretely, after `gh pr checkout <N>`:

1. Note the original PR number and head branch name.
2. Push the same branch to the base repo: `git push origin HEAD:<branch-name>`
   (origin = `garrytan/gstack`, since the worktree is set up with that remote).
3. Close the fork PR (`gh pr close <N> --comment "moving to base-repo branch for secret access"`).
4. Open a new PR from the base-repo branch: `gh pr create --base main --head <branch-name>`.
5. New PR's workflows will get secrets automatically.

Why not fix it on the fork side? `garrytan-agents` isn't a collaborator on
`garrytan/gstack`. Adding it as a collaborator (option A) or flipping the
repo-wide "send secrets to fork PRs" toggle (option B) would let secrets reach
fork PRs from anyone — broader blast radius than just moving this one branch.
Option C (this section) keeps secret-distribution scope tight.

If the user asks you to skip the move (e.g., "just leave it as a fork PR"),
respect that — eval CI will fail with empty-env auth, but check-freshness,
workflow-lint, and windows-tests will still pass on the fork PR.

## AI effort compression

When estimating or discussing effort, always show both human-team and CC+gstack time:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

Completeness is cheap. Don't recommend shortcuts when the complete implementation
is a "lake" (achievable) not an "ocean" (multi-quarter migration). See the
Completeness Principle in the skill preamble for the full philosophy.

## Search before building

Before designing any solution that involves concurrency, unfamiliar patterns,
infrastructure, or anything where the runtime/framework might have a built-in:

1. Search for "{runtime} {thing} built-in"
2. Search for "{thing} best practice {current year}"
3. Check official runtime/framework docs

Three layers of knowledge: tried-and-true (Layer 1), new-and-popular (Layer 2),
first-principles (Layer 3). Prize Layer 3 above all. See ETHOS.md for the full
builder philosophy.

## Local plans

Contributors can store long-range vision docs and design documents in `~/.gstack-dev/plans/`.
These are local-only (not checked in). When reviewing TODOS.md, check `plans/` for candidates
that may be ready to promote to TODOs or implement.

## E2E eval failure blame protocol

When an E2E eval fails during `/ship` or any other workflow, **never claim "not
related to our changes" without proving it.** These systems have invisible couplings —
a preamble text change affects agent behavior, a new helper changes timing, a
regenerated SKILL.md shifts prompt context.

**Required before attributing a failure to "pre-existing":**
1. Run the same eval on main (or base branch) and show it fails there too
2. If it passes on main but fails on the branch — it IS your change. Trace the blame.
3. If you can't run on main, say "unverified — may or may not be related" and flag it
   as a risk in the PR body

"Pre-existing" without receipts is a lazy claim. Prove it or don't say it.

## Long-running tasks: don't give up

When running evals, E2E tests, or any long-running background task, **poll until
completion**. Use `sleep 180 && echo "ready"` + `TaskOutput` in a loop every 3
minutes. Never switch to blocking mode and give up when the poll times out. Never
say "I'll be notified when it completes" and stop checking — keep the loop going
until the task finishes or the user tells you to stop.

The full E2E suite can take 30-45 minutes. That's 10-15 polling cycles. Do all of
them. Report progress at each check (which tests passed, which are running, any
failures so far). The user wants to see the run complete, not a promise that
you'll check later.

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context). Any
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, or `query`
call from anywhere under this worktree routes to that source by default —
no `--source` flag needed. Conductor sibling worktrees of the same repo
each have their own pin and their own indexed pages, so semantic results
match the actual code on disk in this worktree.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

<!-- gstack-gbrain-search-guidance:end -->
