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

`test:evals` requires `ANTHROPIC_API_KEY`. Codex E2E tests use Codex's own auth from `~/.codex/` — no `OPENAI_API_KEY` needed.

**Env keys in Conductor workspaces.** The `GSTACK_*` env-shim (v1.39.2.0+, `lib/conductor-env-shim.ts`) promotes `GSTACK_ANTHROPIC_API_KEY` / `GSTACK_OPENAI_API_KEY` to their canonical names. Don't echo key values to stdout. When passing to Agent SDK, do NOT pass `env: {...}` to `runAgentSdkTest` — mutate `process.env.ANTHROPIC_API_KEY` ambiently and restore in `finally`.

E2E tests stream progress in real-time. Results persist to `~/.gstack-dev/evals/` with auto-comparison against the previous run.

**Diff-based test selection:** `test:evals` and `test:e2e` auto-select tests based on `git diff` against the base branch. Each test declares dependencies in `test/helpers/touchfiles.ts`. Use `EVALS_ALL=1` or `:all` variants to force all tests.

**Two-tier system:** Tests are `gate` or `periodic` (in `test/helpers/touchfiles.ts`). CI runs only gate tests; periodic run weekly or manually. Classify new E2E tests:
1. Safety guardrail or deterministic functional → `gate`
2. Quality benchmark, Opus model, or non-deterministic → `periodic`
3. Requires external service (Codex, Gemini) → `periodic`

## Testing

```bash
bun test             # run before every commit — free, <2s
bun run test:evals   # run before shipping — paid, diff-based (~$4/run max)
```

Both must pass before creating a PR.

## Project structure

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
├── hosts/           # Typed host configs (claude.ts, codex.ts, opencode.ts, etc.)
├── scripts/         # Build + DX tooling (gen-skill-docs.ts, host-config.ts, resolvers/)
├── test/            # Skill validation + eval tests
├── lib/             # Shared libraries
├── docs/            # Design documents (see docs/designs/ for arch decisions)
├── bin/             # CLI utilities (gstack-repo-mode, gstack-slug, gstack-config, etc.)
├── extension/       # Chrome extension (side panel + activity feed + CSS inspector)
├── design/          # Design binary CLI (GPT Image API)
├── contrib/         # Contributor-only tools
├── [skill dirs]/    # One dir per skill: qa-only, ship, review, spec, retro, etc.
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Generated from SKILL.md.tmpl (don't edit directly)
├── SKILL.md.tmpl    # Template: edit this, run gen:skill-docs
└── ETHOS.md         # Builder philosophy
```

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates:

1. Edit the `.tmpl` file
2. Run `bun run gen:skill-docs` (or `bun run build`)
3. Commit both `.tmpl` and generated `.md` files

**Token ceiling:** Generated SKILL.md files warn above 160KB (~40K tokens). This catches runaway growth, not carefully-tuned big skills (`ship`, `plan-ceo-review`, `office-hours` legitimately pack 25-35K tokens). If you blow past 40K: (1) look at WHAT grew, (2) question whether a resolver that added 10K+ belongs inline or as a reference doc, (3) only compress carefully-tuned prose as a last resort.

**Merge conflicts on SKILL.md files:** NEVER resolve by accepting either side. Resolve conflicts on `.tmpl` templates and `scripts/gen-skill-docs.ts`, then run `bun run gen:skill-docs` to regenerate.

## Platform-agnostic design

Skills must NEVER hardcode framework-specific commands or directory structures. Instead:
1. **Read CLAUDE.md** for project-specific config
2. **If missing, AskUserQuestion** — let the user tell you or let gstack search the repo
3. **Persist the answer to CLAUDE.md** so we never ask again

## Writing SKILL templates

SKILL.md.tmpl files are **prompt templates read by Claude**, not bash scripts. Each bash block runs in a separate shell — variables do not persist between blocks.

- **Use natural language for logic and state.** Don't use shell variables to pass state between blocks.
- **Don't hardcode branch names.** Use `{{BASE_BRANCH_DETECT}}` for PR-targeting skills.
- **Keep bash blocks self-contained.** Restate needed context in prose above each block.
- **Express conditionals as English.** Numbered decision steps, not nested if/elif.

## Writing style (V1)

Default output follows the Writing Style in `scripts/resolvers/preamble.ts`: jargon glossed on first use, questions in outcome terms, short sentences. Power users wanting tighter V0 prose: `gstack-config set explain_level terse`. See `docs/designs/PLAN_TUNING_V1.md`.

## Browser interaction

Use `/browse` skill or `$B <command>`. **NEVER use `mcp__claude-in-chrome__*` tools** — slow, unreliable, not what this project uses.

**Key architecture docs** (read before modifying browser/sidebar/security code):
- `docs/designs/SIDEBAR_MESSAGE_FLOW.md` — WS auth flow, dual-token model, PTY architecture
- `ARCHITECTURE.md#dual-listener-tunnel-architecture-v1600` — transport-layer security
- `ARCHITECTURE.md#unicode-sanitization-at-server-egress-v13800` — surrogate handling

**Critical constraints:**
- `security-classifier.ts` CANNOT be imported from the compiled browse binary (`@huggingface/transformers` v4 fails to `dlopen` from Bun compile's temp dir). Only `security.ts` (pure-string ops) is safe for `server.ts`.
- New SSE endpoints MUST route through `createSseEndpoint(req, config)` from `browse/src/sse-helpers.ts`.
- CDP sessions MUST use `withCdpSession()` or `getOrCreateCdpSession()` from `browse/src/cdp-bridge.ts` — direct `newCDPSession()` calls fail CI.
- Every server egress shipping page-content-derived strings MUST go through `sanitizeLoneSurrogates` / `sanitizeReplacer`. Post-stringify regex is a no-op.
- **`/health` MUST NOT surface any shell-grant token.**
- WebSocket auth uses `Sec-WebSocket-Protocol`, not cookies. Must echo the protocol back in the upgrade response.

**Embedder terminal-agent ownership** (`ServerConfig.ownsTerminalAgent?`, default `true`). Embedders that pre-launch their own PTY server must pass `false` so their discovery files survive gstack teardown. CLI `start()` always passes `true` explicitly — static-grep test fails CI if dropped.

**Setup symlinks** — all link sites in `setup` MUST use `_link_or_copy SRC DST`. On Windows without Developer Mode, plain `ln -snf` produces frozen copies. `test/setup-windows-fallback.test.ts` enforces this.

**Security stack thresholds** (in `security.ts`):
- `BLOCK: 0.85`, `WARN: 0.75`, `LOG_ONLY: 0.40`, `SOLO_CONTENT_BLOCK: 0.92`
- BLOCK only when ML content classifier AND transcript classifier both >= WARN.
- `GSTACK_SECURITY_OFF=1` — emergency kill switch.
- `GSTACK_SECURITY_ENSEMBLE=deberta` — opt-in DeBERTa-v3 ensemble (2-of-3 agreement).

## Dev symlink awareness

`.claude/skills/gstack` may be a symlink to this working directory. Check: `ls -la .claude/skills/gstack`. If symlinked, template changes + `bun run gen:skill-docs` immediately affect all gstack invocations. During large refactors, remove the symlink so the global install at `~/.claude/skills/gstack/` is used.

## Compiled binaries — NEVER commit browse/dist/ or design/dist/

Mach-O arm64 only — do NOT work on Linux, Windows, or Intel Macs. `./setup` builds from source. **Never `git add .` or `git add -A`** — always stage specific filenames.

## Redaction guard

Shared engine (`lib/redact-patterns.ts` + `lib/redact-engine.ts`) catches credentials, PII, and legal content before external sinks. It's a guardrail, not airtight — `git push --no-verify` bypasses it.

- **3 tiers:** HIGH = block; MEDIUM = confirm via AskUserQuestion; LOW = FYI.
- **Scan-at-sink:** always scan the EXACT bytes being sent — write to temp file, scan, pass same file to `gh`/`git`.
- **Visibility:** resolve once per run (local config → gh → unknown=public-strict). Public repos get per-finding confirmation; no batch-acknowledge.
- **No key disables HIGH blocking.**
- CLI: `bin/gstack-redact` (exit 0 clean / 2 MEDIUM / 3 HIGH).

## Commit style

**Always bisect commits.** Single logical change per commit — independently understandable and revertable. Split: renames separate from rewrites, test infra separate from implementations, template changes separate from generated regeneration, mechanical refactors separate from features.

## Slop-scan

Catches patterns where AI-generated code is genuinely worse. We are AI-coded and proud — goal is code quality, not hiding AI origin.

**Fix:** empty catches around file/process ops (use `safeUnlink()`, `safeKill()`), redundant `return await`, untyped exception catches where you know the error type.

**Don't fix:** string-matching on error messages (brittle), comments added just to exempt pass-throughs, tightening best-effort cleanup paths (use `safeUnlinkQuiet()` — shutdown code that throws means rest of cleanup doesn't run).

Utilities in `browse/src/error-handling.ts`: `safeUnlink`, `safeUnlinkQuiet`, `safeKill`, `isProcessAlive`.

## Community PR guardrails

**Always AskUserQuestion** before accepting commits that:
1. Touch `ETHOS.md` — Garry's personal philosophy, no external edits, period.
2. Remove or soften promotional material (YC references, founder perspective).
3. Change Garry's voice to be more "neutral" or "professional."

No auto-merging. No exceptions.

## Checking out PRs from garrytan-agents

Fork PRs don't receive base-repo secrets, so eval/E2E CI fails. After `gh pr checkout <N>`:

1. Push to base repo: `git push origin HEAD:<branch-name>`
2. Close fork PR: `gh pr close <N> --comment "moving to base-repo branch for secret access"`
3. Open new PR: `gh pr create --base main --head <branch-name>`

## CHANGELOG + VERSION style

**Versioning:** VERSION is a monotonic ordered identifier. Bump level expresses intent — queue-advancing past a claimed version within the same bump level is permitted. Downstream consumers must NOT rely on strict semver semantics.

**Scale-aware bumps:**
- **PATCH**: bug fix, doc tweak, small addition. Net diff under ~500 lines, no new user-facing capability.
- **MINOR**: new capability, substantial refactor, or coordinated multi-file change. Net diff over ~2000 lines OR a user-visible feature you'd tweet.
- **MAJOR**: breaking change to public surface, OR a blog-post-level release.

**Branch discipline:**
- VERSION and CHANGELOG are branch-scoped. Every shipping branch gets its own bump and entry.
- The CHANGELOG entry is the diff between main and the shipping branch — what users get when they upgrade. NOT how the branch got there.
- **Never reference branch-internal versions.** If your branch went v1.5.0→v1.5.1→v1.6.0 and only v1.6.0 ships, write as if v1.5.1 never existed.
- After merging main: verify your entry is topmost, VERSION is higher than main's, your entry is separate from main's entries.
- After any CHANGELOG edit: `grep "^## \[" CHANGELOG.md` to verify no duplicates and reverse-chronological order.
- **Never orphan branch-internal versions.** Collapse multiple development bumps into one entry at the final version.

**CHANGELOG is for users, not contributors:**
- Lead with what users can now **do**. Sell the feature.
- Plain language, no implementation details. "You can now..." not "Refactored the..."
- Never mention TODOS.md, eval infrastructure, or contributor-facing details.
- Every entry should make someone think "oh nice, I want to try that."
- Keep out: branch resyncs, plan approvals, review outcomes, "work queued" notes.

**Release-summary format** (every `## [X.Y.Z]` entry):

1. **Two-line bold headline** (10-14 words). Verdict, not marketing.
2. **Lead paragraph** (3-5 sentences). Specific, concrete, no AI vocabulary, no em dashes.
3. **"The X numbers that matter"** — setup paragraph naming the source, table with BEFORE/AFTER/Δ, 1-2 sentences on the most striking number.
4. **"What this means for [audience]"** closing (2-4 sentences). End with what to do.

Voice: no em dashes, no AI vocabulary (delve, robust, comprehensive...), real numbers and file names, short paragraphs. ~250-350 words for the summary.

Below the summary: `### Itemized changes` with Added/Changed/Fixed/For contributors subsections. **Always credit community contributions** with `Contributed by @username`.

## AI effort compression

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

Completeness is cheap. Boil the ocean — only genuinely unrelated multi-quarter migrations are separate scope.

## Search before building

Before designing any solution involving concurrency, unfamiliar patterns, or infrastructure: search for "{runtime} {thing} built-in", "{thing} best practice {year}", check official docs. Prize first-principles (Layer 3) above all. See ETHOS.md.

## Local plans

Long-range vision docs in `~/.gstack-dev/plans/` (local-only). Check when reviewing TODOS.md for candidates ready to promote.

## E2E eval failure blame protocol

**Never claim "not related to our changes" without proving it.** Required before attributing a failure to "pre-existing":
1. Run the same eval on main and show it fails there too.
2. If it passes on main but fails on the branch — it IS your change.
3. If you can't run on main, say "unverified — may or may not be related."

## Long-running tasks: don't give up

Poll until completion. Use `sleep 180 && echo "ready"` + `TaskOutput` in a loop every 3 minutes. The full E2E suite takes 30-45 minutes — do all polling cycles. Never say "I'll be notified" and stop checking.

## E2E test fixtures: extract, don't copy

**NEVER copy a full SKILL.md into an E2E test fixture.** Extract only the section the test needs:

```typescript
// BAD — agent reads 1900 lines
fs.copyFileSync(path.join(ROOT, 'ship', 'SKILL.md'), path.join(dir, 'ship-SKILL.md'));

// GOOD — agent reads ~60 lines
const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
const start = full.indexOf('## Review Readiness Dashboard');
const end = full.indexOf('\n---\n', start);
fs.writeFileSync(path.join(dir, 'ship-SKILL.md'), full.slice(start, end > start ? end : undefined));
```

Run targeted E2E tests in **foreground**, not background with `&`. Never `pkill` running eval processes — you lose results and waste money.

## Publishing native OpenClaw skills to ClawHub

```bash
clawhub publish openclaw/skills/gstack-openclaw-office-hours \
  --slug gstack-openclaw-office-hours --name "gstack Office Hours" \
  --version 1.0.0 --changelog "description of changes"
```

Auth: `clawhub login`. Verify: `clawhub search gstack`. Repeat for each skill with bumped `--version`.

## Deploying to the active skill

```bash
cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main && bun run build
```

Or copy binaries directly: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool.

| Request type | Skill |
|---|---|
| Product ideas/brainstorming | /office-hours |
| Strategy/scope | /plan-ceo-review |
| Architecture | /plan-eng-review |
| Design system/plan review | /design-consultation or /plan-design-review |
| Full review pipeline | /autoplan |
| Bugs/errors | /investigate |
| QA/testing site behavior | /qa or /qa-only |
| Code review/diff check | /review |
| Visual polish | /design-review |
| Ship/deploy/PR | /ship or /land-and-deploy |
| Save/resume context | /context-save or /context-restore |
| workflow testing/workflow QA/ | worklow-qa
| Design / Build | req-spec

## Cross-session decision memory

Durable decisions in `~/.gstack/projects/<slug>/decisions.jsonl` (append-only, event-sourced).

- **Resurface:** `bin/gstack-decision-search` (`--recent N`, `--scope repo|branch|issue`, `--query KW`, `--semantic`).
- **Capture:** `bin/gstack-decision-log '{"decision":"...","rationale":"...","scope":"...","source":"...","confidence":1-10}'`. Reverse with `--supersede <id>`, expunge secrets with `--redact <id>`.
- **Durable means:** architecture choice, scope cut, tool/vendor choice, or a reversal. NOT a turn-level edit or anything trivially re-derivable.

## GBrain Search Guidance
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced. Prefer gbrain over Grep for semantic questions or when you don't know the exact identifier yet. This worktree is pinned to a worktree-scoped code source via `.gbrain-source` — no `--source` flag needed.

**Prefer gbrain when:**
- "Where is X handled?" → `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" → `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" → `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" → `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and file globs.

Don't run `/sync-gbrain` while `gbrain autopilot` is active (#1734). Prefer `gbrain sources add --path <dir>` over `--url` (URL-managed sources can auto-reclone).

<!-- gstack-gbrain-search-guidance:end -->