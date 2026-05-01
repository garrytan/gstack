# gstack development

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

**Where the keys live on this machine.** Conductor workspaces don't inherit the
user's interactive shell env, so `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` aren't
in the default process env. Before running any paid eval / E2E, source them from
`~/.zshrc` (that's where Garry keeps them):

```bash
bash -c '
  eval "$(grep -E "^export (ANTHROPIC_API_KEY|OPENAI_API_KEY)=" ~/.zshrc)"
  export ANTHROPIC_API_KEY OPENAI_API_KEY
  EVALS=1 EVALS_TIER=periodic bun test test/skill-e2e-<whatever>.test.ts
'
```

Do not echo the key value anywhere (stdout, logs, shell history). The grep+eval
pattern keeps it in process env only. When passing to a test's Agent SDK, do NOT
pass `env: {...}` to `runAgentSdkTest` — the SDK's auth pipeline doesn't pick up
the key the same way when env is supplied as an object (confirmed failure mode).
Instead, mutate `process.env.ANTHROPIC_API_KEY` ambiently before the call and
restore in `finally`.
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

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   │   ├── commands.ts  # Command registry (single source of truth)
│   │   └── snapshot.ts  # SNAPSHOT_FLAGS metadata array
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary
├── hosts/           # Typed host configs (one per AI agent)
│   ├── claude.ts    # Primary host config
│   ├── codex.ts, factory.ts, kiro.ts  # Existing hosts
│   ├── opencode.ts, slate.ts, cursor.ts, openclaw.ts  # IDE hosts
│   ├── hermes.ts, gbrain.ts  # Agent runtime hosts
│   └── index.ts     # Registry: exports all, derives Host type
├── scripts/         # Build + DX tooling
│   ├── gen-skill-docs.ts  # Template → SKILL.md generator (config-driven)
│   ├── host-config.ts     # HostConfig interface + validator
│   ├── host-config-export.ts  # Shell bridge for setup script
│   ├── host-adapters/     # Host-specific adapters (OpenClaw tool mapping)
│   ├── resolvers/   # Template resolver modules (preamble, design, review, gbrain, etc.)
│   ├── skill-check.ts     # Health dashboard
│   └── dev-skill.ts       # Watch mode
├── test/            # Skill validation + eval tests
│   ├── helpers/     # skill-parser.ts, session-runner.ts, llm-judge.ts, eval-store.ts
│   ├── fixtures/    # Ground truth JSON, planted-bug fixtures, eval baselines
│   ├── skill-validation.test.ts  # Tier 1: static validation (free, <1s)
│   ├── gen-skill-docs.test.ts    # Tier 1: generator quality (free, <1s)
│   ├── skill-llm-eval.test.ts   # Tier 3: LLM-as-judge (~$0.15/run)
│   └── skill-e2e-*.test.ts       # Tier 2: E2E via claude -p (~$3.85/run, split by category)
├── qa-only/         # /qa-only skill (report-only QA, no fixes)
├── plan-design-review/  # /plan-design-review skill (report-only design audit)
├── design-review/    # /design-review skill (design audit + fix loop)
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── autoplan/        # /autoplan skill (auto-review pipeline: CEO → design → eng)
├── benchmark/       # /benchmark skill (performance regression detection)
├── canary/          # /canary skill (post-deploy monitoring loop)
├── codex/           # /codex skill (multi-AI second opinion via OpenAI Codex CLI)
├── land-and-deploy/ # /land-and-deploy skill (merge → deploy → canary verify)
├── office-hours/    # /office-hours skill (YC Office Hours — startup diagnostic + builder brainstorm)
├── investigate/     # /investigate skill (systematic root-cause debugging)
├── retro/           # Retrospective skill (includes /retro global cross-project mode)
├── bin/             # CLI utilities (gstack-repo-mode, gstack-slug, gstack-config, etc.)
├── document-release/ # /document-release skill (post-ship doc updates)
├── cso/             # /cso skill (OWASP Top 10 + STRIDE security audit)
├── design-consultation/ # /design-consultation skill (design system from scratch)
├── design-shotgun/  # /design-shotgun skill (visual design exploration)
├── open-gstack-browser/  # /open-gstack-browser skill (launch GStack Browser)
├── connect-chrome/  # symlink → open-gstack-browser (backwards compat)
├── design/          # Design binary CLI (GPT Image API)
│   ├── src/         # CLI + commands (generate, variants, compare, serve, etc.)
│   ├── test/        # Integration tests
│   └── dist/        # Compiled binary
├── extension/       # Chrome extension (side panel + activity feed + CSS inspector)
├── lib/             # Shared libraries (worktree.ts)
├── docs/designs/    # Design documents
├── setup-deploy/    # /setup-deploy skill (one-time deploy config)
├── .github/         # CI workflows + Docker image
│   ├── workflows/   # evals.yml (E2E on Ubicloud), skill-docs.yml, actionlint.yml
│   └── docker/      # Dockerfile.ci (pre-baked toolchain + Playwright/Chromium)
├── contrib/         # Contributor-only tools (never installed for users)
│   └── add-host/    # /gstack-contrib-add-host skill
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Generated from SKILL.md.tmpl (don't edit directly)
├── SKILL.md.tmpl    # Template: edit this, run gen:skill-docs
├── ETHOS.md         # Builder philosophy (Boil the Lake, Search Before Building)
└── package.json     # Build scripts for browse
```

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates. To update docs:

1. Edit the `.tmpl` file (e.g. `SKILL.md.tmpl` or `browse/SKILL.md.tmpl`)
2. Run `bun run gen:skill-docs` (or `bun run build` which does it automatically)
3. Commit both the `.tmpl` and generated `.md` files

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

**Sidebar architecture:** Before modifying `sidepanel.js`, `background.js`,
`content.js`, `terminal-agent.ts`, or sidebar-related server endpoints,
read `docs/designs/SIDEBAR_MESSAGE_FLOW.md`. The sidebar has one primary
surface — the **Terminal** pane (interactive `claude` PTY) — with
Activity / Refs / Inspector as debug overlays behind the footer's
`debug` toggle. The chat queue path was ripped once the PTY proved out;
`sidebar-agent.ts` and the `/sidebar-command` / `/sidebar-chat` /
`/sidebar-agent/event` endpoints are gone. The doc covers the WS auth
flow, dual-token model, and threat-model boundary — silent failures
here usually trace to not understanding the cross-component flow.

**WebSocket auth uses Sec-WebSocket-Protocol, not cookies.** Browsers
can't set `Authorization` on a WebSocket upgrade, but they CAN set
`Sec-WebSocket-Protocol` via `new WebSocket(url, [token])`. The agent
reads it, validates against `validTokens`, and MUST echo the protocol
back in the upgrade response — without the echo, Chromium closes the
connection immediately. `Set-Cookie: gstack_pty=...` is kept as a
fallback for non-browser callers (the cross-port `SameSite=Strict`
cookie path doesn't survive from a chrome-extension origin).

**Cross-pane PTY injection.** The toolbar's Cleanup button and the
Inspector's "Send to Code" action both pipe text into the live claude
PTY via `window.gstackInjectToTerminal(text)`, exposed by
`sidepanel-terminal.js`. No `/sidebar-command` POST — the live REPL is
the only execution surface in the sidebar now.

**`/health` MUST NOT surface any shell-grant token.** It already leaks
`AUTH_TOKEN` to localhost callers in headed mode (a v1.1+ TODO). Don't
make that worse by adding the PTY session token there. PTY auth flows
through `POST /pty-session` only.

**Transport-layer security** (v1.6.0.0+). When `pair-agent` starts an ngrok tunnel,
the daemon binds two HTTP listeners: a local listener (127.0.0.1, full command
surface, never forwarded) and a tunnel listener (locked allowlist: `/connect`,
`/command` with a scoped token + 26-command browser-driving allowlist,
`/sidebar-chat`). ngrok forwards only the tunnel port. Root tokens over the tunnel
return 403. SSE endpoints use a 30-minute HttpOnly `gstack_sse` cookie minted via
`POST /sse-session` (never valid against `/command`). Tunnel-surface rejections go
to `~/.gstack/security/attempts.jsonl` via `tunnel-denial-log.ts`. Before editing
`server.ts`, `sse-session-cookie.ts`, or `tunnel-denial-log.ts`, read
[ARCHITECTURE.md](ARCHITECTURE.md#dual-listener-tunnel-architecture-v1600) —
the module boundary (no imports from `token-registry.ts` into `sse-session-cookie.ts`)
is load-bearing for scope isolation.

**Sidebar security stack** (layered defense against prompt injection):

| Layer | Module | Lives in |
|-------|--------|----------|
| L1-L3 | `content-security.ts` | both server and agent — datamarking, hidden element strip, ARIA regex, URL blocklist, envelope wrapping |
| L4 | `security-classifier.ts` (TestSavantAI ONNX) | **sidebar-agent only** |
| L4b | `security-classifier.ts` (Claude Haiku transcript) | **sidebar-agent only** |
| L5 | `security.ts` (canary) | both — inject in compiled, check in agent |
| L6 | `security.ts` (combineVerdict ensemble) | both |

**Critical constraint:** `security-classifier.ts` CANNOT be imported from the
compiled browse binary. `@huggingface/transformers` v4 requires `onnxruntime-node`
which fails to `dlopen` from Bun compile's temp extract dir. Only `security.ts`
(pure-string operations — canary, verdict combiner, attack log, status) is safe
for `server.ts`. See `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-19-prompt-injection-guard.md`
§"Pre-Impl Gate 1 Outcome" for full architectural decision.

**Thresholds** (in `security.ts`):
- `BLOCK: 0.85` — single-layer score that would cause BLOCK if cross-confirmed
- `WARN: 0.75` — cross-confirm threshold. When L4 AND L4b both >= 0.75 → BLOCK
- `LOG_ONLY: 0.40` — gates transcript classifier (skip Haiku when all layers < 0.40)
- `SOLO_CONTENT_BLOCK: 0.92` — single-layer threshold for label-less content classifiers
  (testsavant, deberta). Intentionally higher than `BLOCK` because these layers can't
  distinguish "this is an injection" from "this looks like phishing aimed at the user."
  The transcript classifier keeps a separate, label-gated solo path at `BLOCK` (0.85).

**Ensemble rule:** BLOCK only when the ML content classifier AND the transcript
classifier both report >= WARN. Single-layer high confidence degrades to WARN —
this is the Stack Overflow instruction-writing FP mitigation. Canary leak
always BLOCKs (deterministic).

**Env knobs:**
- `GSTACK_SECURITY_OFF=1` — emergency kill switch. Classifier stays off even if
  warmed. Canary is still injected; just the ML scan is skipped.
- `GSTACK_SECURITY_ENSEMBLE=deberta` — opt-in DeBERTa-v3 ensemble. Adds
  ProtectAI DeBERTa-v3-base-injection-onnx as L4c classifier for cross-model
  agreement. 721MB first-run download. With ensemble enabled, BLOCK requires
  2-of-3 ML classifiers agreeing at >= WARN (testsavant, deberta, transcript).
  Without ensemble (default), BLOCK requires testsavant + transcript at >= WARN.
- Classifier model cache: `~/.gstack/models/testsavant-small/` (112MB, first run only)
  plus `~/.gstack/models/deberta-v3-injection/` (721MB, only when ensemble enabled)
- Attack log: `~/.gstack/security/attempts.jsonl` (salted sha256 + domain only,
  rotates at 10MB, 5 generations)
- Per-device salt: `~/.gstack/security/device-salt` (0600)
- Session state: `~/.gstack/security/session-state.json` (cross-process, atomic)

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
with a SKILL.md symlink inside (e.g., `qa/SKILL.md -> gstack/qa/SKILL.md`). This
ensures Claude discovers them as top-level skills, not nested under `gstack/`.
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

## Compiled binaries — NEVER commit browse/dist/ or design/dist/

The `browse/dist/` and `design/dist/` directories contain compiled Bun binaries
(`browse`, `find-browse`, `design`, ~58MB each). These are Mach-O arm64 only — they
do NOT work on Linux, Windows, or Intel Macs. The `./setup` script already builds
from source for every platform, so the checked-in binaries are redundant. They are
tracked by git due to a historical mistake and should eventually be removed with
`git rm --cached`.

**NEVER stage or commit these files.** They show up as modified in `git status`
because they're tracked despite `.gitignore` — ignore them. When staging files,
always use specific filenames (`git add file1 file2`) — never `git add .` or
`git add -A`, which will accidentally include the binaries.

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

### What to fix (genuine quality improvements)

- **Empty catches around file ops** — use `safeUnlink()` (ignores ENOENT, rethrows
  EPERM/EIO). A swallowed EPERM in cleanup means silent data loss.
- **Empty catches around process kills** — use `safeKill()` (ignores ESRCH, rethrows
  EPERM). A swallowed EPERM means you think you killed something you didn't.
- **Redundant `return await`** — remove when there's no enclosing try block. Saves a
  microtask, signals intent.
- **Typed exception catches** — `catch (err) { if (!(err instanceof TypeError)) throw err }`
  is genuinely better than `catch {}` when the try block does URL parsing or DOM work.
  You know what error you expect, so say so.

### What NOT to fix (linter gaming, not quality)

- **String-matching on error messages** — `err.message.includes('closed')` is brittle.
  Playwright/Chrome can change wording anytime. If a fire-and-forget operation can fail
  for ANY reason and you don't care, `catch {}` is the correct pattern.
- **Adding comments to exempt pass-through wrappers** — "alias for active session" above
  a method just to trip slop-scan's exemption rule is noise, not documentation.
- **Converting extension catch-and-log to selective rethrow** — Chrome extensions crash
  entirely on uncaught errors. If the catch logs and continues, that IS the right pattern
  for extension code. Don't make it throw.
- **Tightening best-effort cleanup paths** — shutdown, emergency cleanup, and disconnect
  code should use `safeUnlinkQuiet()` (swallows ALL errors). A cleanup path that throws
  on EPERM means the rest of cleanup doesn't run. That's worse.

### Utilities in `browse/src/error-handling.ts`

| Function | Use when | Behavior |
|----------|----------|----------|
| `safeUnlink(path)` | Normal file deletion | Ignores ENOENT, rethrows others |
| `safeUnlinkQuiet(path)` | Shutdown/emergency cleanup | Swallows all errors |
| `safeKill(pid, signal)` | Sending signals | Ignores ESRCH, rethrows others |
| `isProcessAlive(pid)` | Boolean process checks | Returns true/false, never throws |

### Score tracking

Baseline (2026-04-09, before cleanup): 100 findings, 432.8 score, 2.38 score/file.
After cleanup: 90 findings, 358.1 score, 1.96 score/file.

Don't chase the number. Fix patterns that represent actual code quality problems.
Accept findings where the "sloppy" pattern is the correct engineering choice.

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

### Release-summary format (every `## [X.Y.Z]` entry)

Every version entry in `CHANGELOG.md` MUST start with a release-summary section in
the GStack/Garry voice, one viewport's worth of prose + tables that lands like a
verdict, not marketing. The itemized changelog (subsections, bullets, files) goes
BELOW that summary, separated by a `### Itemized changes` header.

The release-summary section gets read by humans, by the auto-update agent, and by
anyone deciding whether to upgrade. The itemized list is for agents that need to
know exactly what changed.

Structure for the top of every `## [X.Y.Z]` entry:

1. **Two-line bold headline** (10-14 words total). Should land like a verdict, not
   marketing. Sound like someone who shipped today and cares whether it works.
2. **Lead paragraph** (3-5 sentences). What shipped, what changed for the user.
   Specific, concrete, no AI vocabulary, no em dashes, no hype.
3. **A "The X numbers that matter" section** with:
   - One short setup paragraph naming the source of the numbers (real production
     deployment OR a reproducible benchmark, name the file/command to run).
   - A table of 3-6 key metrics with BEFORE / AFTER / Δ columns.
   - A second optional table for per-category breakdown if relevant.
   - 1-2 sentences interpreting the most striking number in concrete user terms.
4. **A "What this means for [audience]" closing paragraph** (2-4 sentences) tying
   the metrics to a real workflow shift. End with what to do.

Voice rules for the release summary:
- No em dashes (use commas, periods, "...").
- No AI vocabulary (delve, robust, comprehensive, nuanced, fundamental, etc.) or
  banned phrases ("here's the kicker", "the bottom line", etc.).
- Real numbers, real file names, real commands. Not "fast" but "~30s on 30K pages."
- Short paragraphs, mix one-sentence punches with 2-3 sentence runs.
- Connect to user outcomes: "the agent does ~3x less reading" beats "improved precision."
- Be direct about quality. "Well-designed" or "this is a mess." No dancing.

Source material:
- CHANGELOG previous entry for prior context.
- Benchmark files or `/retro` output for headline numbers.
- Recent commits (`git log <prev-version>..HEAD --oneline`) for what shipped.
- Don't make up numbers. If a metric isn't in a benchmark or production data,
  don't include it. Say "no measurement yet" if asked.

Target length: ~250-350 words for the summary. Should render as one viewport.

### Itemized changes (below the release summary)

Write `### Itemized changes` and continue with the detailed subsections (Added,
Changed, Fixed, For contributors). Same rules as the user-facing voice guidance
above, plus:

- **Always credit community contributions.** When an entry includes work from a
  community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.

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

Native OpenClaw skills live in `openclaw/skills/gstack-openclaw-*/SKILL.md`. These are
hand-crafted methodology skills (not generated by the pipeline) published to ClawHub
so any OpenClaw user can install them.

**Publishing:** The command is `clawhub publish` (NOT `clawhub skill publish`):

```bash
clawhub publish openclaw/skills/gstack-openclaw-office-hours \
  --slug gstack-openclaw-office-hours --name "gstack Office Hours" \
  --version 1.0.0 --changelog "description of changes"
```

Repeat for each skill: `gstack-openclaw-ceo-review`, `gstack-openclaw-investigate`,
`gstack-openclaw-retro`. Bump `--version` on each update.

**Auth:** `clawhub login` (opens browser for GitHub auth). `clawhub whoami` to verify.

**Updating:** Same `clawhub publish` command with a higher `--version` and `--changelog`.

**Verification:** `clawhub search gstack` to confirm they're live.

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

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
