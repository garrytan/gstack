# gstack development

## Commands

```bash
bun install          # install dependencies
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run typecheck    # strict tsc over product code (zero errors required)
bun run typecheck:test  # test-code type-debt ratchet
bun run build        # gen docs + compile binaries
bun run gen:skill-docs  # regenerate SKILL.md files from templates
bun run skill:check  # health dashboard for all skills
bun run dev:skill    # watch mode: auto-regen + validate on change
bun run slop          # full slop-scan report (all files)
bun run slop:diff     # slop findings in files changed on this branch only
bun run audit:manifest  # file slices for /claude-api prompt-audit; rerun it at each frontier-model release (CONTRIBUTING.md)
```

Test and eval commands, their cost and what each needs live in one table:
[Which command do I run?](CONTRIBUTING.md#which-command-do-i-run). The two you
need most are `bun run test` (free acceptance) and `bun run eval:bg:pr` (paid,
changed coverage). Retired names such as `test:evals` and `test:e2e` print their
replacement and exit 1.

Paid evals require `ANTHROPIC_API_KEY`. Codex E2E tests (`test/codex-e2e.test.ts`,
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

**Test selection and tiers:** the sharded paid runner (`test:pr`,
`eval:bg:pr`, `test:gate:sharded`) selects tests from `git diff` through the
dependency lists in `test/helpers/touchfiles.ts` (`EVALS_ALL=1` forces
everything; `eval:select` previews the PR profile, `--profile full` the plain
touchfile selection). Classify every new E2E test in `E2E_TIERS`: safety guardrail or
deterministic functional test -> `gate`; quality benchmark, Opus model test,
non-deterministic, or external service (Codex, Gemini) -> `periodic`.
`test/e2e-tier-alignment.test.ts` enforces the tiers. CI lanes and periodic
exclusions: [docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md#test-selection-and-tiers).

## Testing

```bash
bun run test         # final full free acceptance after focused repairs and source freeze
bun run eval:bg:pr   # required changed PR coverage, with explicit deferrals
```

Follow [Validation discipline in AGENTS.md](AGENTS.md#validation-discipline):
prove repairs with focused checks first, complete required selected evaluations,
then run the full free suite once on the final integrated code. During repairs,
focused checks replace a full-suite run before every commit.

`bun run test` routes through `scripts/test-free-shards.ts`, whose strict
per-shard classification fails a shard that lacks bun's summary line.
`TREE_MUTATING` lists the files that still run in their own trailing serial
shard (today only `test/bootstrap-retention.test.ts`). Never type
bare `bun test` for the suite: it walks the whole repo, loading paid eval files
and missing the strict classifier. `bun run test:pr` runs the selected short
live behaviors and quality judges and reports deferred broad coverage. Full free
acceptance and required PR checks must pass before publishing. See
[testing policy](CONTRIBUTING.md#test-tiers) for commands and measured targets.
Tests that need Aside itself self-skip unless a Mac has the Aside app open.
Shard packing, judge reuse and engine skips:
[docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md#free-suite-runner-judge-reuse-and-engine-skips).

New or changed tests follow the [test value bar](docs/test-value-bar.md): each one
protects behavior a real regression would break, and contract tests (SKILL.md
goldens, and prompt bytes that are a contract as defined below) stay. The bar's
source is `scripts/resolvers/test-value.ts`.

In this repo, prompt bytes are a contract only when software reads them (a
parser, hook, grader or another skill consumes the exact text) or a recorded
eval shows the wording matters. Tests on skill templates and generated SKILL.md
pin structure, step order, routing tables, machine-read markers and
safety-critical lines; check safety lines case-insensitively, on meaning rather
than capitals. Leave behavior to E2E cases and judges. Don't pin emphasis,
capitalization, issue numbers, or a sentence a behavioral check already covers,
and when a rewrite changes a pinned sentence, replace the pin with a structural
or meaning-level check instead of pinning the new sentence. The terms are defined
in [docs/test-value-bar.md](docs/test-value-bar.md) ("Prompt-byte contract",
"Sentence pin"). Use `test/helpers/prompt-structure.ts` (`between`,
`expectTokens`, `expectAbsent`, `expectOrdered`, `expectMentions`) for
template/SKILL.md checks: tokens and order exactly, safety rules as
case-insensitive keyword co-occurrence in one sentence.
Projects tune `/ship`'s coverage gate with optional CLAUDE.md `## Test Coverage`
keys, all absent by default: `Minimum:`, `Target:`, `Generation cap:` (default 5),
`Base control:` (`auto` or `off`), `Base control budget:` (seconds, default 90) and
`Star rating:` (`auto` or `off`).

## Project structure

Full annotated tree: [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md).
Quick map: `browse/` gstack's own headless-browser CLI (the fallback
engine) plus the `/browse` skill, `design/` design binary, `make-pdf/` PDF
binary, `hosts/` typed host configs, `scripts/` build+DX tooling
(gen-skill-docs, resolvers — `resolvers/aside.ts` is the Aside contract),
`test/` validation+evals, `lib/` shared libraries (`aside-render.ts` renders
local HTML through Aside, falling back to the engine; `design-catalog.ts` is
the typed design anti-pattern catalog every design skill renders from), `bin/`
CLI utilities (`gstack-render.ts` is the render CLI skills call;
`gstack-design-detect.ts` and `gstack-design-md.ts` are the design detector
and open-DESIGN.md tools), `extension/` Chrome
extension, one directory per skill (`ship/`, `review/`, `qa/`, ...),
`.github/` CI, `contrib/` contributor tools, `docs/designs/` design documents.

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates. To update docs:

1. Edit the `.tmpl` file (e.g. `SKILL.md.tmpl` or `browse/SKILL.md.tmpl`)
2. Run `bun run gen:skill-docs` (or `bun run build` which does it automatically)
3. Commit both the `.tmpl` and generated `.md` files

The same `gen:skill-docs` run writes two more generated files from `lib/`:
`review/design-checklist.md` (from `lib/design-catalog.ts`, through
`scripts/resolvers/design-checklist.ts`) and `lib/dom-dump.js` (from
`lib/dom-dump-script.ts`). Edit the catalog or the script source, regenerate,
and commit both; never edit the generated file
(`test/design-checklist-sync.test.ts` fails on drift).

Generation uses each host's `defaultModel` (`claude` for existing hosts, `gpt`
for Codex) unless `--model` is explicit. Codex installs additionally read the
top-level model from `${CODEX_HOME:-~/.codex}/config.toml`; rerun
`./setup --host codex` after changing that model. Note: `bun run build` and a
bare `gen:skill-docs --host codex` render the host default (gpt) — if your
Codex config.toml pins a different model, rerun `./setup --host codex`
afterwards to restore your profile (single-owner persistence is filed in
TODOS.md).

Browser steps in skills are `aside repl` scripts per
`scripts/resolvers/aside.ts`, each with its `$B` equivalent for the fallback
engine. To add a new browse command: add it to `browse/src/commands.ts` and
rebuild. To add a snapshot flag: add it to `SNAPSHOT_FLAGS` in
`browse/src/snapshot.ts` and rebuild. Local-HTML rendering in a skill template
is a `bun run ~/.claude/skills/gstack/bin/gstack-render.ts` call; new render
options go into `lib/aside-render.ts` (which handles the fallback), never into
a skill's own bash.

**Size budgets:** generated SKILL.md files warn above 160KB (~40K tokens);
`test/catalog-budget.test.ts` caps the always-loaded skill catalog at
`CATALOG_BUDGET_TOKEN_EQUIVALENTS` (1,194 today; each new skill ratchets it); and
`test/context-budget-ratchet.test.ts` pins per-skill token ceilings against
`test/fixtures/context-budget.json` (for legitimate growth or a landed
reduction, re-run `bun test/helpers/capture-context-budget.ts` and commit the
refreshed fixture in the same commit). Rationale and protocol:
[docs/CONTRIBUTOR_REFERENCE.md](docs/CONTRIBUTOR_REFERENCE.md#skill-size-budgets).

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
`scripts/resolvers/preamble/generate-writing-style.ts`: jargon glossed on first
use (curated list in `scripts/jargon-list.json`, which the skill Reads at runtime
on the first jargon term), questions framed in
outcome terms ("what breaks for your users if...") not implementation terms,
short sentences, decisions close with user impact. Power users who want the
tighter V0 prose set `gstack-config set explain_level terse` (binary switch,
no middle mode). See `docs/designs/PLAN_TUNING_V1.md` for the full design
rationale. The review pacing overhaul that originally tried to ride alongside
writing-style was extracted to V1.1 — see `docs/designs/PACING_UPDATES_V0.md`.

## Browser interaction

gstack drives the Aside AI browser (macOS 15+) first and falls back to its own
browser engine when Aside is absent. When you need to interact with a browser
(QA, dogfooding, inspecting a page), use the `/browse` skill: it probes Aside
and, on `READY`, drives it — the user's real browser with their real sessions —
through `aside repl` scripts that follow the contract in
`scripts/resolvers/aside.ts` (`{{ASIDE_SETUP}}`). Every browser skill (`/qa`,
`/qa-only`, `/design-review`, `/canary`, `/benchmark`, `/scrape`) does the same,
and web research in skills runs through Aside's agent (`{{ASIDE_RESEARCH}}`)
before the WebSearch tool. When the probe says `NEEDS_ASIDE` or
`ASIDE_NOT_RUNNING` (Linux, Windows, a closed Aside app), the skill resolves
`$B` per `{{BROWSE_FALLBACK}}` and runs the browse binary instead — `$B <command>`
is a legitimate tool in that context, and cookie import, GStack Browser headed
mode, `/pair-agent`, and browser-skills/`/skillify` belong to it. Local HTML a
skill generated itself (make-pdf, diagram, design previews) renders through
`bin/gstack-render.ts` / `lib/aside-render.ts`, which serve the file on
loopback and print or screenshot it in Aside, or in the engine when Aside is
absent — never point the renderer at a site. NEVER use
`mcp__claude-in-chrome__*` tools — they are slow, unreliable, and not what this
project uses.

**Server / sidebar / extension internals:** before editing `browse/src/server.ts`,
`extension/`, the sidebar PTY, any SSE endpoint, or CDP session code, read
[docs/BROWSER_INTERNALS.md](docs/BROWSER_INTERNALS.md) — sidebar message flow,
WebSocket auth, tunnel dual-listener rules, Unicode sanitization at egress,
SSE/CDP helpers, setup symlink hardening, and the sidebar security stack all
live there, each pinned by a CI tripwire.

**Egress receipts at every off-machine sink** (v1.63.0.0+). Every gstack-initiated
send off the machine MUST write a receipt BEFORE the send: TypeScript callers use
`writeReceipt` from `lib/egress-receipt.ts`; shell scripts source
`bin/gstack-egress-lib.sh` and use `_receipted_curl` / `_receipted_git`.
`test/egress-receipt-wiring.test.ts` fails CI on an unreceipted new sink.
Failure polarity, scanner exemptions and the `_aside_exec` wrapper:
[docs/CONTRIBUTOR_REFERENCE.md](docs/CONTRIBUTOR_REFERENCE.md#egress-receipts).

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

**Skill linking and ownership (#2119):** setup installs each skill as a
top-level directory (short `qa` or namespaced `gstack-qa`, per `skill_prefix`),
and `setup` and `bin/gstack-relink` only delete or link over an entry they can
prove is gstack's; keep those two copies of the rule in sync. Proof rules,
prune behavior and pinning tests:
[docs/CONTRIBUTOR_REFERENCE.md](docs/CONTRIBUTOR_REFERENCE.md#skill-linking-and-ownership).

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

`lib/redact-patterns.ts` + `lib/redact-engine.ts` (CLI `bin/gstack-redact`,
opt-in hook `bin/gstack-redact-prepush`) catch credentials, PII and legal content
before an external sink. It is a **guardrail, not airtight enforcement**; never
claim it stops a determined leaker. Always scan the EXACT bytes that will be
sent, and render skill docs from `scripts/resolvers/redact-doc.ts`. Tiers,
visibility, fences and config keys:
[docs/CONTRIBUTOR_REFERENCE.md](docs/CONTRIBUTOR_REFERENCE.md#redaction-guard).

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
Utilities live in `lib/error-handling.ts`. Don't chase the score.

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

Fork PRs (for example from `garrytan-agents/gstack`) get no base-repo secrets,
so eval CI fails with empty-env auth. Unless the user says to leave it as a fork
PR, push the branch to `garrytan/gstack` and re-target the PR from there:
[docs/CONTRIBUTOR_REFERENCE.md](docs/CONTRIBUTOR_REFERENCE.md#checking-out-prs-from-garrytan-agents).

## CHANGELOG + VERSION style

**Choose versions autonomously; default to PATCH.** Garry delegates release
version decisions to the agent. Do not ask him to choose or approve a version,
including when an already-approved version collides with another PR. This policy
overrides generic version-approval prompts in `/ship` and `/document-release`.

Prefer **PATCH (X.Y.Z+1.0)** for ordinary releases, including fixes, additions,
refactors, test infrastructure and coordinated multi-file work. Diff size alone
is not a reason to choose MINOR. Choose **MINOR (X.Y+1.0.0)** or **MAJOR
(X+1.0.0.0)** only when calling the release a patch would be plainly misleading
("ridiculous"), such as an incompatible public-interface change or a genuinely
new product-scale release. Make that judgment without another approval question.

Use `bin/gstack-next-version` to check the live release queue before publishing.
If a slot is claimed, advance to the next available version at the chosen bump
level and use `bin/gstack-version-bump` to synchronize release metadata. A higher
base version does not itself require a MINOR bump. Keep the PR ready for Garry to
merge; autonomous version decisions do not authorize merging, deploying or
skipping required validation.

**VERSION and CHANGELOG are branch-scoped.** Each shipping branch gets its own
bump and one entry, written at `/ship` time, that describes what THIS branch
adds versus main, for users, with no branch-internal versions or development
narrative. VERSION stays 4-digit; package.json carries the 3-digit npm
translation owned by `bin/gstack-version-bump`, so never hand-edit it. Read
[docs/CHANGELOG_STYLE.md](docs/CHANGELOG_STYLE.md) BEFORE writing an entry: it
holds the versioning invariant, the merge-main checks, what stays out and the
entry format. Always credit community contributions with
`Contributed by @username`.

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

## Running evals as an agent: always detach (SIGTERM-proof)

Never run a long eval as a plain backgrounded Bash task: a turn-boundary SIGTERM
kills it mid-flight. Run paid evals in the background with `bun run eval:bg:pr`
(diff-selected PR gate) or `bun run eval:bg:release` (full gate + periodic);
`eval:bg:gate` and `eval:bg:periodic` run one tier. All four run
`scripts/eval-bg.ts`, which prints `[eval-bg] backend=<dispatch|local> …` and
`gstack-detach LOG <path>`, then returns immediately.

- **Dispatch backend** (default when HEAD is clean and pushed to garrytan/gstack
  and `gh` can dispatch): CI runs the lane on the pushed revision (`evals.yml`
  and/or `evals-periodic.yml`, verified by `expected_sha`); the local log follows
  the run and names its URL. Dispatched runs are validation runs: fresh, never
  writing PR receipts. Commit and push first; uncommitted files or unpushed
  commits fall back to local and the log says why.
- **Local backend** (dirty tree, unpushed commits, a fork, no `gh`, or `--local`):
  the sharded runner on this machine, capped at ceil(1.5 × planned serial seconds
  / EVALS_JOBS) + 20 min, at most 4 h (`--timeout SECS` overrides). Export
  `ANTHROPIC_API_KEY` first (never pass keys in argv).
- **Forcing**: `--dispatch` refuses with the fix ("commit and push, or rerun with
  --local") instead of falling back; `--local` or `GSTACK_EVAL_BG_MODE=local`
  always runs here.
- **Waiting**: poll the log until `### gstack-detach EXIT=<code> ###` (0 passed,
  1 failed, 130 cancelled, 2 other); silence is not success. Keep checking until
  it appears or the user tells you to stop, and report progress at each check.
  `bun run scripts/eval-bg.ts status <log-or-run-id>` prints running, passed,
  failed, cancelled or incomplete (died without a sentinel).
- Both backends hold the machine-wide `gstack-evals` lock, so concurrent
  worktrees queue instead of saturating the API; logs live under
  `~/.gstack-dev/eval-runs/`. A second `eval:bg:<lane>` for the same revision and
  base follows the queued, running or green dispatch instead of dispatching again.

Humans running evals in their own terminal don't need this. Backends, caps and
knobs: [docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md#running-evals-as-an-agent-detach).

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
- `cp make-pdf/dist/pdf ~/.claude/skills/gstack/make-pdf/dist/pdf`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

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
