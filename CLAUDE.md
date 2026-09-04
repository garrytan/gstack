# gstack development

## Commands

```bash
bun install          # install dependencies
bun run test         # run free tests via the strict parallel runner (~90-100s full suite)
bun run test:evals   # run paid evals: LLM judge + E2E (diff-based, ~$4.35/run max)
bun run test:evals:all  # run ALL paid evals regardless of diff
bun run test:gate    # run gate-tier tests only (CI default, blocks merge)
bun run test:periodic  # run periodic-tier tests only (weekly cron / manual)
bun run test:gate:sharded    # gate tier via the sharded paid runner (one Bun process per test file)
bun run test:periodic:sharded  # periodic tier via the sharded paid runner (implies EVALS_ALL=1)
bun run test:e2e     # run E2E tests only (diff-based, ~$4.20/run max)
bun run test:e2e:all # run ALL E2E tests regardless of diff
bun run eval:select  # show which tests would run based on current diff
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # gen docs + compile binaries
bun run gen:skill-docs  # regenerate SKILL.md files from templates
bun run skill:check  # health dashboard for all skills
bun run dev:skill    # watch mode: auto-regen + validate on change
bun run eval:list    # list all eval runs from ~/.gstack/projects/<slug>/evals/
bun run eval:compare # compare two eval runs (auto-picks most recent)
bun run eval:summary # aggregate stats across all eval runs
bun run eval:flake-rank  # rank tests by flake signal (retried passes first; --json, --dir, --since-days)
bun run slop          # full slop-scan report (all files)
bun run slop:diff     # slop findings in files changed on this branch only
```

`test:evals` requires `ANTHROPIC_API_KEY`. Codex E2E tests (`test/codex-e2e.test.ts`,
`test/codex-e2e-sol-scope.test.ts`) use Codex's own auth — the hermetic runner copies
only `auth.json` from `${CODEX_HOME:-~/.codex}` and pins `CODEX_HOME` in the child
env — no `OPENAI_API_KEY` env var needed.

**Hermetic E2E + env keys:** every E2E runner spawns children through
`test/helpers/hermetic-env.ts` (allowlist-scrubbed env, fresh seeded
`CLAUDE_CONFIG_DIR`, temp `GSTACK_HOME`, `--strict-mcp-config`); per-test
`env:` overrides merge last onto a COMPLETE hermetic env, so they're safe.
A PTY test that types a `/skill` command must pass `seedSkills: true`.
Debug against real operator state with `EVALS_HERMETIC=0`. Full detail
(env-shim, seeding tripwires, wiring tests):
[docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md).

**Diff-based test selection:** `test:evals` and `test:e2e` auto-select tests based
on `git diff` against the base branch. Each test declares its file dependencies in
`test/helpers/touchfiles.ts`. Changes to global touchfiles (session-runner, eval-store,
touchfiles.ts itself) trigger all tests. Use `EVALS_ALL=1` or the `:all` script
variants to force all tests. Run `eval:select` to preview which tests would run.

**Two-tier system:** Tests are classified as `gate` or `periodic` in `E2E_TIERS`
(in `test/helpers/touchfiles.ts` — a facade over `touchfiles-data.ts` +
`test-selection.ts`). CI runs gate tests per PR via evals.yml's sliced lane
(planner manifest → executors → fail-closed report; engine =
scripts/test-paid-shards.ts, the same runner as local eval:bg:gate); the free
suite runs on every PR via `.github/workflows/free-tests.yml` (a REQUIRED
check, secretless — fork PRs get real signal); ALL periodic tests run weekly
via evals-periodic.yml (EVALS_ALL, minus the reasoned exclusions in
`test/helpers/periodic-exclude-data.ts` — reason + tracking required per
entry), plus a weekly EVALS_ALL gate census. Use `EVALS_TIER=gate` or
`EVALS_TIER=periodic` to filter locally. When adding new E2E tests, classify them:
1. Safety guardrail or deterministic functional test? -> `gate`
2. Quality benchmark, Opus model test, or non-deterministic? -> `periodic`
3. Requires external service (Codex, Gemini)? -> `periodic`

Tier declarations are enforced by `test/e2e-tier-alignment.test.ts` (free, runs
in `bun test`): a `skill-e2e-*` file named in a touchfiles dep list whose
`EVALS_TIER` self-gate disagrees with its declared tier in `E2E_TIERS` fails the
suite. Files not named in any dep list are reported, not enforced — keep both
in sync.

## Testing

```bash
bun run test         # run before every commit — free, ~90-100s for the full ~8,700-test suite
bun run test:evals   # run before shipping — paid, diff-based (~$4.35/run max)
```

`bun run test` routes through `scripts/test-free-shards.ts` (N concurrent
shard processes, serial within each, packed by recorded per-file durations
when `scripts/free-test-durations.json` exists — refresh occasionally with
`bun run test:free --record-durations`; strict-output classification per
shard: a shard without bun's terminal summary line FAILS — silent truncation
cannot report green). The former trailing serial tree-mutating shard is
gone: `TREE_MUTATING` is empty (gen-skill-docs has a main() guard and
`--out-dir` renders every host, so tests render into mkdtemps — see
docs/TESTING_INTERNALS.md). Never type bare `bun test` for the suite: it
walks the whole repo, loading paid eval files and missing the strict
classifier.
It covers skill validation, gen-skill-docs quality checks, and browse
integration tests. `bun run test:evals` runs LLM-judge quality evals and E2E
tests via `claude -p`. Both must pass before creating a PR.

## Project structure

Full annotated tree: [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md).
Quick map: `browse/` headless-browser CLI, `design/` design binary,
`hosts/` typed host configs, `scripts/` build+DX tooling (gen-skill-docs,
resolvers), `test/` validation+evals, `lib/` shared libraries, `bin/` CLI
utilities, `extension/` Chrome extension, one directory per skill
(`ship/`, `review/`, `qa/`, ...), `.github/` CI, `contrib/` contributor
tools, `docs/designs/` design documents.

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates. To update docs:

1. Edit the `.tmpl` file (e.g. `SKILL.md.tmpl` or `browse/SKILL.md.tmpl`)
2. Run `bun run gen:skill-docs` (or `bun run build` which does it automatically)
3. Commit both the `.tmpl` and generated `.md` files

Generation uses each host's `defaultModel` (`claude` for existing hosts, `gpt`
for Codex) unless `--model` is explicit. Codex installs additionally read the
top-level model from `${CODEX_HOME:-~/.codex}/config.toml`; rerun
`./setup --host codex` after changing that model. Note: `bun run build` and a
bare `gen:skill-docs --host codex` render the host default (gpt) — if your
Codex config.toml pins a different model, rerun `./setup --host codex`
afterwards to restore your profile (single-owner persistence is filed in
TODOS.md).

To add a new browse command: add it to `browse/src/commands.ts` and rebuild.
To add a snapshot flag: add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts` and rebuild.

**Token ceiling:** Generated SKILL.md files trip a warning above 160KB (~40K tokens).
This is a "watch for feature bloat" guardrail, not a hard gate. Modern flagship
models have 200K-1M context windows, so 40K is 4-20% of window, and prompt caching
makes the marginal cost of larger skills small. The ceiling exists to catch runaway
preamble/resolver growth, not to force compression on carefully-tuned big skills
(`ship`, `plan-ceo-review`, `office-hours` legitimately pack 25-35K tokens of
behavior). If you blow past 40K, the right fix is usually: (1) look at WHAT grew,
(2) if one resolver added 10K+ in a single PR, question whether it belongs inline
or as a reference doc, (3) only compress carefully-tuned prose as a last resort —
cuts to the coverage audit, review army, or voice directive have real quality cost.

A second, harder ceiling guards the DISCOVERY surface: `test/catalog-budget.test.ts`
caps the aggregate frontmatter `name` + `description` across all skills at 1,150
token-equivalents (260-byte per-skill sub-cap), counted through the shared census
in `test/helpers/skill-census.ts`. This one is enforced, not a warning — every
host loads the full catalog every session, so growth here taxes every
conversation. The failure message carries the re-measure + ratchet protocol.
`bin/gstack-context-bill` shows the full token bill-of-materials for a skills
tree (always-on vs per-invocation, `--diff`, `--budget`; `--exact` opts into the
real tokenizer and POSTs file text to api.anthropic.com with an egress receipt).

The context-budget ratchet (`test/context-budget-ratchet.test.ts`, free, runs
in `bun run test`) pins ABSOLUTE ceilings on two more ledgers: the always-on
FULL-frontmatter aggregate (catalog-budget counts only name+description) and
each skill's per-invocation eager tokens (SKILL.md + forced-read references —
size floors and parity ratios guard these relatively, not absolutely), graded
against `test/fixtures/context-budget.json`. A skill that grows past its
ceiling fails; a new skill fails until it's consciously budgeted. For
legitimate growth or a landed reduction, re-run
`bun test/helpers/capture-context-budget.ts` and commit the refreshed fixture
in the same commit, so ceilings ratchet down and every win is locked.

**Merge conflicts on SKILL.md files:** NEVER resolve conflicts on generated SKILL.md
files by accepting either side. Instead: (1) resolve conflicts on the `.tmpl` templates
and `scripts/gen-skill-docs.ts` (the sources of truth), (2) run `bun run gen:skill-docs`
to regenerate all SKILL.md files, (3) stage the regenerated files. Accepting one side's
generated output silently drops the other side's template changes.

## Platform-agnostic design

Skills must NEVER hardcode framework-specific commands, file patterns, or directory
structures. Instead:

1. **Read CLAUDE.md** for project-specific config (test commands, eval commands, etc.)
2. **If missing, AskUserQuestion** — let the user tell you or let gstack search the repo
3. **Persist the answer to CLAUDE.md** so we never have to ask again

This applies to test commands, eval commands, deploy commands, and any other
project-specific behavior. The project owns its config; gstack reads it.

## Writing SKILL templates

SKILL.md.tmpl files are **prompt templates read by Claude**, not bash scripts.
Each bash code block runs in a separate shell — variables do not persist between blocks.

Rules:
- **Use natural language for logic and state.** Don't use shell variables to pass
  state between code blocks. Instead, tell Claude what to remember and reference
  it in prose (e.g., "the base branch detected in Step 0").
- **Don't hardcode branch names.** Detect `main`/`master`/etc dynamically via
  `gh pr view` or `gh repo view`. Use `{{BASE_BRANCH_DETECT}}` for PR-targeting
  skills. Use "the base branch" in prose, `<base>` in code block placeholders.
- **Keep bash blocks self-contained.** Each code block should work independently.
  If a block needs context from a previous step, restate it in the prose above.
- **Express conditionals as English.** Instead of nested `if/elif/else` in bash,
  write numbered decision steps: "1. If X, do Y. 2. Otherwise, do Z."

## Writing style (V1)

Default output from every tier-≥2 skill follows the Writing Style section in
`scripts/resolvers/preamble.ts`: jargon glossed on first use (curated list in
`scripts/jargon-list.json`, baked at gen-skill-docs time), questions framed in
outcome terms ("what breaks for your users if...") not implementation terms,
short sentences, decisions close with user impact. Power users who want the
tighter V0 prose set `gstack-config set explain_level terse` (binary switch,
no middle mode). See `docs/designs/PLAN_TUNING_V1.md` for the full design
rationale. The review pacing overhaul that originally tried to ride alongside
writing-style was extracted to V1.1 — see `docs/designs/PACING_UPDATES_V0.md`.

## Browser interaction

When you need to interact with a browser (QA, dogfooding, cookie setup), use the
`/browse` skill or run the browse binary directly via `$B <command>`. NEVER use
`mcp__claude-in-chrome__*` tools — they are slow, unreliable, and not what this
project uses.

**Server / sidebar / extension internals:** before editing `browse/src/server.ts`,
`extension/`, the sidebar PTY, any SSE endpoint, or CDP session code, read
[docs/BROWSER_INTERNALS.md](docs/BROWSER_INTERNALS.md) — sidebar message flow,
WebSocket auth, tunnel dual-listener rules, Unicode sanitization at egress,
SSE/CDP helpers, setup symlink hardening, and the sidebar security stack all
live there, each pinned by a CI tripwire.

**Egress receipts at every off-machine sink** (v1.63.0.0+). Every gstack-initiated
send off the machine MUST write a hash-chained receipt to
`~/.gstack/security/egress.jsonl` BEFORE the send: TypeScript callers use
`writeReceipt` from `lib/egress-receipt.ts`; shell scripts source
`bin/gstack-egress-lib.sh` and use `_receipted_curl` / `_receipted_git`. Failure
polarity is per-class: fail-closed for sensitive sinks (brain-sync, memory-ingest,
gbrain-sync, telemetry, ngrok tunnels, mcp-verify, supabase-provision), fail-open
+ stderr warning for user-facing ones (design OpenAI calls, update-check,
dashboards, git-class ops). The new-sink scanner in
`test/egress-receipt-wiring.test.ts` fails CI on an unreceipted `curl` /
`git push` / `fetch` to a non-loopback host unless the file carries a reasoned
entry in its `SCANNER_EXEMPT` list (user-directed page fetches, reachability
probes, instruction strings, skill prose) — if you add a new off-machine sink,
wire it through the helpers and add it to the enumerated sink list. Inspect with
`bin/gstack-egress` (`list` | `verify`, exit 3 on tamper | `grants`). Threat
model: forensic observability of ATTEMPTED egress, not an exfiltration control.

## Dev symlink awareness

When developing gstack, `.claude/skills/gstack` may be a symlink back to this
working directory (gitignored). This means skill changes are **live immediately**,
great for rapid iteration, risky during big refactors where half-written skills
could break other Claude Code sessions using gstack concurrently.

**Check once per session:** Run `ls -la .claude/skills/gstack` to see if it's a
symlink or a real copy. If it's a symlink to your working directory, be aware that:
- Template changes + `bun run gen:skill-docs` immediately affect all gstack invocations
- Breaking changes to SKILL.md.tmpl files can break concurrent gstack sessions
- During large refactors, remove the symlink (`rm .claude/skills/gstack`) so the
  global install at `~/.claude/skills/gstack/` is used instead

**Prefix setting:** Setup creates real directories (not symlinks) at the top level
with a SKILL.md symlink inside (e.g., `qa/SKILL.md -> gstack/qa/SKILL.md`), plus
links to each skill's runtime assets (sections/, templates, checklists — everything
except SKILL.md, tests, build output, and `.tmpl` sources). Alias skills
(`_gstack-command`, `connect-chrome`) install as rewritten copies, never symlinks.
This ensures Claude discovers them as top-level skills, not nested under `gstack/`.
Names are either short (`qa`) or namespaced (`gstack-qa`), controlled by
`skill_prefix` in `~/.gstack/config.yaml`. Pass `--no-prefix` or `--prefix` to
skip the interactive prompt.

**Note:** Vendoring gstack into a project's repo is deprecated. Use global install
+ `./setup --team` instead. See README.md for team mode instructions.

**For plan reviews:** When reviewing plans that modify skill templates or the
gen-skill-docs pipeline, consider whether the changes should be tested in isolation
before going live (especially if the user is actively using gstack in other windows).

**Upgrade migrations:** When a change modifies on-disk state (directory structure,
config format, stale files) in ways that could break existing user installs, add a
migration script to `gstack-upgrade/migrations/`. Read CONTRIBUTING.md's "Upgrade
migrations" section for the format and testing requirements. The upgrade skill runs
these automatically after `./setup` during `/gstack-upgrade`.

## Compiled binaries — never commit browse/dist/, design/dist/, or make-pdf/dist/

The `browse/dist/`, `design/dist/`, and `make-pdf/dist/` directories contain
compiled Bun binaries (`browse`, `find-browse`, `design`, ~62MB each). These are
Mach-O arm64 only — they do NOT work on Linux, Windows, or Intel Macs. The
`./setup` script builds from source for every platform.

These directories are **untracked and gitignored** (`.gitignore:3-6`; the
`browse/dist/` binaries were untracked in `64d5a3e4`, v0.11.16.0; the others were
never tracked). They will NOT appear in `git status`. If a dist binary ever does
show up in `git status`, something force-added it (`git add -f`) — do not commit
it; unstage it and find out how it got there.

When staging files, always use specific filenames (`git add file1 file2`) — never
`git add .` or `git add -A`, which can sweep in build outputs and junk.

## Redaction guard (PII / secrets / legal content)

Shared redaction engine catches credentials, PII, and legal/damaging content
before it reaches an external sink (codex dispatch, GitHub issue/PR body, pushed
commit). It is a **guardrail, not airtight enforcement** — `git push --no-verify`,
direct `gh issue create`, and `GSTACK_REDACT_PREPUSH=skip` all bypass it. It
catches accidents and carelessness, the 99% case. Do not claim it stops a
determined leaker (a CHANGELOG line that does would fail a hostile screenshotter).

- **Engine + taxonomy:** `lib/redact-patterns.ts` (the single source of truth —
  3 tiers; HIGH = genuinely-secret credentials that block, MEDIUM = PII/legal/
  internal + high-FP credential shapes that confirm via AskUserQuestion, LOW =
  FYI) and `lib/redact-engine.ts` (pure `scan()` + `applyRedactions()`).
  Calibration matters: a gate that cries wolf gets ignored, so context-variable
  shapes (Stripe `pk_live_`, Google `AIza`, JWT, env `*_KEY=`) sit at MEDIUM.
- **CLI:** `bin/gstack-redact` (exit 0 clean / 2 MEDIUM / 3 HIGH; `--json`,
  `--auto-redact`, `--repo-visibility`, `--from-file`). `bin/gstack-redact-prepush`
  is the opt-in git hook.
- **Skill docs are generated** from `scripts/resolvers/redact-doc.ts`
  (`{{REDACT_INVOCATION_BLOCK:<sink>}}`) so /spec,
  /cso, /ship, /document-release, /document-generate never drift from the engine.
- **Scan-at-sink:** always scan the EXACT bytes that will be sent — write to a
  temp file, scan that file, pass the SAME file to `gh`/`git`. Never scan a string
  then re-render (that reopens a scan-vs-send gap).
- **Visibility (no tier promotion):** resolve once per run, order = local config
  (`gstack-config get redact_repo_visibility`, ~/.gstack so never committed) → gh
  → glab → unknown(=public-strict). Public repos get STERNER per-finding
  confirmation (no batch-acknowledge, no silent-proceed); MEDIUM is never
  auto-promoted to HIGH.
- **Tool-attributed fences:** wrap Codex/Greptile/eval output in ` ```codex-review `
  / ` ```greptile ` fences so example credentials those tools quote WARN-degrade
  instead of blocking. A live-format credential inside the fence still blocks.
- **Config keys:** `redact_repo_visibility` (public|private|unknown, local-only
  override for repos gh/glab can't read), `redact_prepush_hook` (true|false).
  There is intentionally NO key to disable HIGH blocking.
- **Audit:** the /spec semantic pass appends a content-free record (categories +
  body sha256, no spec text) to `~/.gstack/security/semantic-reviews.jsonl` (0600).

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

## Slop-scan: AI code quality, not AI code hiding

We use [slop-scan](https://github.com/benvinegar/slop-scan) to catch patterns where
AI-generated code is genuinely worse than what a human would write. We are NOT trying
to pass as human code. We are AI-coded and proud of it. The goal is code quality.

```bash
npx slop-scan scan .          # human-readable report
npx slop-scan scan . --json   # machine-readable for diffing
```

Config: `slop-scan.config.json` at repo root (currently excludes `**/vendor/**`).

Before fixing any finding, read [docs/SLOP_SCAN.md](docs/SLOP_SCAN.md):
it separates genuine quality fixes (empty catches around file ops → 
`safeUnlink()`, process kills → `safeKill()`) from linter gaming we
reject (string-matching error messages, tightening best-effort cleanup).
Utilities live in `browse/src/error-handling.ts`. Don't chase the score.

## Community PR guardrails

When reviewing or merging community PRs, **always AskUserQuestion** before accepting
any commit that:

1. **Touches ETHOS.md** — this file is Garry's personal builder philosophy. No edits
   from external contributors or AI agents, period.
2. **Removes or softens promotional material** — YC references, founder perspective,
   and product voice are intentional. PRs that frame these as "unnecessary" or
   "too promotional" must be rejected.
3. **Changes Garry's voice** — the tone, humor, directness, and perspective in skill
   templates, CHANGELOG, and docs are not generic. PRs that rewrite voice to be
   more "neutral" or "professional" must be rejected.

Even if the agent strongly believes a change improves the project, these three
categories require explicit user approval via AskUserQuestion. No exceptions.
No auto-merging. No "I'll just clean this up."

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

## CHANGELOG + VERSION style

**Versioning invariant (workspace-aware ship).** VERSION is a monotonic ordered
release identifier, not a strict semver commitment. The bump level
(major/minor/patch/micro) expresses intent at ship time. Queue-advancing past a
claimed version within the same bump level is explicitly permitted — if branch A
claims v1.7.0.0 as a MINOR and branch B is also a MINOR, B lands at v1.8.0.0
(still a MINOR relative to main). Downstream consumers must NOT rely on
"MINOR = feature-only, PATCH = fix-only" as a strict contract. This is why
`bin/gstack-next-version` advances within the chosen bump level rather than
repicking the level when collisions happen.

**package.json carries the npm-valid translation, not VERSION verbatim.**
VERSION stays the 4-digit source of truth (e.g. `1.67.0.0`); package.json and
any subdirectory manifests with a `version` field get the 3-digit npm-valid
translation (`1.67.0`), and lockfile `version` fields sync only when the
lockfile already exists. `bin/gstack-version-bump` (via `lib/version-source.ts`)
owns the translation and judges drift on translated forms — do NOT "fix" the
apparent mismatch by hand, and do not write a 4-digit version into
package.json (npm rejects it). Rationale and translation rules live in the
`lib/version-source.ts` header; `test/gstack-version-bump.test.ts` pins the
contract.

**Scale-aware bumps — use common sense.** When the diff is big, bump MINOR (or
MAJOR), not PATCH. PATCH is for bug fixes and small additions; MINOR is for
substantial new capability or substantial reduction; MAJOR is for breaking
changes. Rough guideposts (don't treat as rules, treat as smell-checks):

- **PATCH (X.Y.Z+1.0)**: bug fix, doc tweak, small additive change, single
  test/file added. Net diff under ~500 lines, no new user-facing capability.
- **MINOR (X.Y+1.0.0)**: new capability shipped (skill, harness, command, big
  refactor), substantial code reduction (compression, migration), or coordinated
  multi-file change. Net diff over ~2000 lines added/removed, OR a user-visible
  feature you'd put in a tweet.
- **MAJOR (X+1.0.0.0)**: breaking change to public surface (CLI flag rename,
  skill removed, config format changed), OR a release big enough to be the
  headline of a blog post.

If you find yourself debating "is 10K added + 24K removed really a PATCH?" — it
isn't. Bump MINOR. Same for "this adds a whole new test harness with 6 new E2E
tests + helper utilities" — MINOR. The bump level is communication to the user
about what kind of release this is; don't undersell it.

When merging origin/main brings a higher VERSION, re-evaluate the bump level
against the SCALE of your branch's work, not just whether main moved forward.
If main bumped MINOR and your branch is also a substantial change, you bump
MINOR again on top (e.g., main at v1.14.0.0, your branch lands v1.15.0.0).

**VERSION and CHANGELOG are branch-scoped.** Every feature branch that ships gets its
own version bump and CHANGELOG entry. The entry describes what THIS branch adds —
not what was already on main.

**The CHANGELOG entry is the diff between main and the shipping branch — what users
get when they upgrade. NOT how the branch got there.** A reader landing on the entry
should learn what they can do now that they couldn't before; they should not learn
about the branch's internal version bumps, the bugs we caught and fixed mid-branch,
the plan reviews we ran, or the commits we squashed. That is branch development
narrative. It belongs in PR descriptions and commit messages, not CHANGELOG.

**Never reference branch-internal versions in a CHANGELOG entry.** If your branch
bumped VERSION from v1.5.0.0 → v1.5.1.0 → v1.6.0.0 during development and only the
final v1.6.0.0 ships to main, the entry must read as if v1.5.1.0 never existed.
Concretely, NEVER write:
- "v1.5.1.0 had a bug that v1.6.0.0 fixes" — readers don't know about v1.5.1.0; it's
  a branch-internal artifact.
- "The shipping headline of v1.5.1.0 was broken because..." — same reason. From main's
  perspective, v1.5.1.0 was never released.
- "Pre-fix tests encoded the broken behavior" — that's a contributor's victory lap,
  not a user benefit.
- "Two surgical edits, both in the dispatch path" — micro-narrative of the patch.

Instead, describe the released system: "Browser-skills run end-to-end with the
expected tab-access semantics." If a property of the shipped system is worth calling
out (e.g., "skill spawns get permissive tab access; pair-agent tunnel tokens require
ownership"), document it as a property, not as a fix. The shipped system is what
the user gets; the path to that system is invisible to them.

**When to write the CHANGELOG entry:**
- At `/ship` time (Step 13), not during development or mid-branch.
- The entry covers ALL commits on this branch vs the base branch.
- Never fold new work into an existing CHANGELOG entry from a prior version that
  already landed on main. If main has v0.10.0.0 and your branch adds features,
  bump to v0.10.1.0 with a new entry — don't edit the v0.10.0.0 entry.

**Key questions before writing:**
1. What branch am I on? What did THIS branch change?
2. Is the base branch version already released? (If yes, bump and create new entry.)
3. Does an existing entry on this branch already cover earlier work? (If yes, replace
   it with one unified entry for the final version.)

**Merging main does NOT mean adopting main's version.** When you merge origin/main into
a feature branch, main may bring new CHANGELOG entries and a higher VERSION. Your branch
still needs its OWN version bump on top. If main is at v0.13.8.0 and your branch adds
features, bump to v0.13.9.0 with a new entry. Never jam your changes into an entry that
already landed on main. Your entry goes on top because your branch lands next.

**After merging main, always check:**
- Does CHANGELOG have your branch's own entry separate from main's entries?
- Is VERSION higher than main's VERSION?
- Is your entry the topmost entry in CHANGELOG (above main's latest)?
If any answer is no, fix it before continuing.

**After any CHANGELOG edit that moves, adds, or removes entries,** immediately run
`grep "^## \[" CHANGELOG.md` to verify no duplicates and a sensible reverse-chronological
order. Gaps between version numbers are fine. A branch that ships at v1.6.4.0 without
a prior v1.5.2.0 or v1.5.3.0 entry on main is correct — those were branch-internal
version numbers that never landed. Do not back-fill gaps with placeholder entries.

**Never orphan branch-internal versions.** If your branch bumped VERSION several times
during development (v1.5.1.0 → v1.5.2.0 → v1.6.4.0, say) and those earlier entries were
never released to main, the final ship consolidates ALL of them into a single entry at
the final version (v1.6.4.0). Collapse them — delete the old entries and move their
content into the final entry, re-version table columns accordingly. Readers see one
release, not a branch diary. Gaps are fine (v1.6.3.0 → v1.6.4.0 with no v1.5.x
in between on main is correct).

CHANGELOG.md is **for users**, not contributors. Write it like product release notes:

- Lead with what the user can now **do** that they couldn't before. Sell the feature.
- Use plain language, not implementation details. "You can now..." not "Refactored the..."
- **Never mention TODOS.md, internal tracking, eval infrastructure, or contributor-facing
  details.** These are invisible to users and meaningless to them.
- Put contributor/internal changes in a separate "For contributors" section at the bottom.
- Every entry should make someone think "oh nice, I want to try that."
- No jargon: say "every question now tells you which project and branch you're in" not
  "AskUserQuestion format standardized across skill templates via preamble resolver."

**Only document what shipped between main and this change.** Readers do not care how
we got here. Keep out of the CHANGELOG, always:

- Branch resyncs, merge commits with main, rebase activity.
- Plan approvals, review outcomes (CEO / eng / design / outside-voice / codex findings),
  AskUserQuestion decisions, scope negotiations.
- "Work queued," "plan approved," "in-progress," "will ship later" — the CHANGELOG
  documents what DID ship, not what MIGHT ship.
- Version-bump housekeeping when no user-facing work actually landed.

If the diff between the base branch version and this version has no user-facing change
(only merges, only CHANGELOG edits, only placeholder work), the honest entry is one
sentence: "Version bump for branch-ahead discipline. No user-facing changes yet." Stop
there. Do not pad. Do not explain the plan that will ship eventually. Do not narrate
the branch's history. When real work lands, the entry will replace this at /ship time.

### Entry format

Every `## [X.Y.Z]` entry starts with a release summary (two-line bold
headline, lead paragraph, numbers table, closing paragraph) followed by an
`### Itemized changes` section. Read
[docs/CHANGELOG_STYLE.md](docs/CHANGELOG_STYLE.md) for the full format spec
and voice rules BEFORE writing an entry. Always credit community
contributions with `Contributed by @username`.

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
is achievable. Boil the ocean — the complete thing is the goal; only genuinely
unrelated multi-quarter migrations are separate scope, never an excuse for a
shortcut. See the Completeness Principle in the skill preamble for the full
philosophy.

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

## Running evals as an agent: always detach (SIGTERM-proof)

When **you (an agent/harness)** launch a long eval/benchmark run, run it through
`bin/gstack-detach` — NEVER as a plain backgrounded Bash task. A plain background
task lives in the harness's process group, so a SIGTERM ("polite quit") on a turn
boundary, a stopped Monitor, or an interruption kills the run mid-flight (observed:
`script "test:gate" was terminated by signal SIGTERM` ~40 min into a run). On macOS
the run can also die to idle-sleep. `gstack-detach` fixes both: a fresh session
(escapes the group SIGTERM) wrapped in `caffeinate -i` (blocks idle-sleep).

- Use the `eval:bg*` scripts (`eval:bg`, `eval:bg:all`, `eval:bg:gate`,
  `eval:bg:periodic`) — they wrap the eval command in `gstack-detach` with the
  machine-wide `gstack-evals` lock (concurrent worktrees serialize instead of
  saturating the shared model API), a per-tier watchdog, and a **run-scoped** log
  under `~/.gstack-dev/eval-runs/` (no shared-`/tmp` collision). Each prints its
  log path. `eval:bg:gate` / `eval:bg:periodic` run their tier through the
  sharded paid runner (`scripts/test-paid-shards.ts`, also exposed as
  `test:gate:sharded` / `test:periodic:sharded`): one Bun process per test
  file, an external wall-clock timeout that kills the shard's process GROUP
  (stray `claude`/`codex` grandchildren included), a per-shard
  `GSTACK_EVAL_DIR=<evalDir>/shards/<slug>/` honored by the `EvalCollector`
  constructor, and an aggregate that separates failed vs timed-out vs
  never-started shards — the detach timeouts (25200s gate / 37800s periodic;
  floor enforced against the live shard census by
  test/eval-detach-timeout-floor.test.ts)
  are sized against worst-case shard wall clock. `EVALS_JOBS` sets the shard
  process count (default 8); `EVALS_CONCURRENCY` is bun's --max-concurrency
  WITHIN a shard (default 2) — they are deliberately separate knobs. `eval:list` / `eval:compare` /
  `eval:summary` / `eval:flake-rank` read the shard dirs too. Or call
  `gstack-detach [--lock NAME] [--timeout SECS] [--label LBL] --
  <cmd>` directly for any long agent job. Export `ANTHROPIC_API_KEY` first (never
  pass keys in argv).
- Then **poll the printed logfile** with a death-aware watcher: break on the
  guaranteed `### gstack-detach EXIT=<code> ###` sentinel (success AND failure are
  both marked, so silence is never mistaken for success). The detached run survives
  even if your watcher gets reaped, so re-checking the log always works.
- Why the lock: a shared dev box with several Conductor worktrees will rate-limit
  the model API if two eval suites run at once (15-way concurrency each), which
  mass-times-out E2E tests. The lock makes the second run WAIT, not collide.
- Humans running `bun run test:evals` foreground in their own terminal don't need
  this — Ctrl-C is intended there. Detachment is for agent-launched runs only.

## E2E test fixtures: extract, don't copy

**NEVER copy a full SKILL.md file into an E2E test fixture.** SKILL.md files are
1500-2000 lines. When `claude -p` reads a file that large, context bloat causes
timeouts, flaky turn limits, and tests that take 5-10x longer than necessary.

Instead, extract only the section the test actually needs:

```typescript
// BAD — agent reads 1900 lines, burns tokens on irrelevant sections
fs.copyFileSync(path.join(ROOT, 'ship', 'SKILL.md'), path.join(dir, 'ship-SKILL.md'));

// GOOD — agent reads ~60 lines, finishes in 38s instead of timing out
const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
const start = full.indexOf('## Review Readiness Dashboard');
const end = full.indexOf('\n---\n', start);
fs.writeFileSync(path.join(dir, 'ship-SKILL.md'), full.slice(start, end > start ? end : undefined));
```

Also when running targeted E2E tests to debug failures:
- Run in **foreground** (`bun test ...`), not background with `&` and `tee`
- Never `pkill` running eval processes and restart — you lose results and waste money
- One clean run beats three killed-and-restarted runs

## Publishing native OpenClaw skills to ClawHub

Native OpenClaw skills live in `openclaw/skills/gstack-openclaw-*/SKILL.md`.
The command is `clawhub publish` (NOT `clawhub skill publish`) — full
workflow, auth, and verification:
[docs/OPENCLAW_PUBLISHING.md](docs/OPENCLAW_PUBLISHING.md).

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

**If you use gbrain:** the `git reset --hard` in step 2 reverts the brain-aware
(`GBRAIN_CONTEXT_LOAD` / `GBRAIN_SAVE_RESULTS`) blocks that `gstack-config
gbrain-refresh` renders into the install (those generated blocks differ from
`main` by design). After deploying, re-run `gstack-config gbrain-refresh` to
restore them across all your projects' Claude sessions. It's idempotent.

Or copy the binaries directly:
- `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
- `cp design/dist/design ~/.claude/skills/gstack/design/dist/design`

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

## Cross-session decision memory

Durable decisions and their rationale are captured in an append-only, event-sourced
store at `~/.gstack/projects/<slug>/decisions.jsonl` so neither you nor the user
re-litigates a settled call or loses the "why" across sessions. This is the reliable,
file-only path: it works with gbrain OFF. (gbrain semantic recall is an optional
enhancement layered on top, never a dependency.)

- **Resurface** active decisions before re-deciding: `bin/gstack-decision-search`
  (`--recent N`, `--scope repo|branch|issue`, `--query KW`, `--all`, `--json`).
  Add `--semantic` (with `--query`) to append related hits from gbrain memory when
  it's up; it degrades silently to the reliable file results when gbrain is off.
  Session start already surfaces scope-relevant active decisions via Context Recovery.
  If a decision is listed, treat it as settled with its rationale; if you're about to
  reverse it, say so explicitly.
- **Capture** a DURABLE decision when you or the user make one:
  `bin/gstack-decision-log '{"decision":"...","rationale":"...","scope":"repo|branch|issue","source":"user|skill|agent","confidence":1-10}'`.
  Reverse a prior call with `--supersede <id>`; expunge an accidental secret with
  `--redact <id>`; rewrite the log to the active set with `--compact`. Non-interactive
  (never prompts), injection-sanitized, and HIGH-secret-blocking on write.
- **Durable means:** architecture choice, scope cut, tool/vendor choice, or a reversal
  of a prior call. NOT a turn-level edit, a phrasing tweak, or anything trivially
  re-derivable. Capture is curated at the source — log durable decisions only, or the
  store becomes noise.

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

Safety: don't run `/sync-gbrain` while `gbrain autopilot` is active — the
orchestrator refuses destructive source ops when it detects a running autopilot
to avoid racing it (#1734). Prefer registering user repos with `gbrain sources
add --path <dir>` (no `--url`): URL-managed sources can auto-reclone, and the
sync code walk for them requires an explicit `--allow-reclone` opt-in.

<!-- gstack-gbrain-search-guidance:end -->
