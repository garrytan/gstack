# gstack — AI Engineering Workflow

gstack is a collection of SKILL.md files that give AI agents structured roles for
software development. Each skill is a specialist: CEO reviewer, eng manager,
designer, QA lead, release engineer, debugger, and more.

## Available skills

Skills live in `.agents/skills/` (or `~/.claude/skills/gstack/` on Claude Code).
Invoke them by name (e.g., `/office-hours`).

### Plan-mode reviews

| Skill | What it does |
|-------|-------------|
| `/office-hours` | Start here. Reframes your product idea before you write code. |
| `/plan-ceo-review` | CEO-level review: find the 10-star product in the request. |
| `/plan-eng-review` | Lock architecture, data flow, edge cases, and tests. |
| `/plan-design-review` | Rate each design dimension 0-10, explain what a 10 looks like. |
| `/plan-devex-review` | DX-mode review: TTHW, magical moments, friction points, persona traces. |
| `/plan-tune` | Self-tune AskUserQuestion sensitivity per question. |
| `/autoplan` | One command runs CEO → design → DX → eng review (eng always last). |
| `/design-consultation` | Build a complete design system from scratch. |
| `/spec` | Turn vague intent into a precise, executable spec in five phases. Files a GitHub issue, optionally spawns a Claude Code agent in a fresh worktree, and lets `/ship` close the source issue on merge. |

### Implementation + review

| Skill | What it does |
|-------|-------------|
| `/review` | Pre-landing PR review. Finds bugs that pass CI but break in prod. |
| `/deslop-shared-libs` | Find worthwhile shared-code extractions in recent work. Recommendations only. |
| `/codex` | Second opinion via OpenAI Codex. Review, challenge, or consult modes. Available outside the Codex harness. |
| `/claude-code` | Second opinion via Claude Code. Review, challenge, or consult modes. Available outside the Claude Code harness. |
| `/investigate` | Systematic root-cause debugging. No fixes without investigation. |
| `/design-review` | Live-site visual audit + fix loop with atomic commits. |
| `/design-shotgun` | Generate multiple AI design variants, comparison board, iterate. |
| `/design-html` | Generate production-quality Pretext-native HTML/CSS. |
| `/devex-review` | Live developer experience audit (TTHW measured against the real flow). |
| `/qa` | Open a real browser, find bugs, fix them, re-verify. |
| `/qa-only` | Same methodology as /qa but report only — no code changes. |
| `/scrape` | Pull data from a web page in your Aside browser, with your real logged-in state. Read-only. On the fallback browser a codified browser-skill answers a repeat intent in ~200ms. |
| `/skillify` | Codify the most recent successful `/scrape` flow into a permanent browser-skill (fallback browser only). |

### Release + deploy

| Skill | What it does |
|-------|-------------|
| `/ship` | Run tests, review, push, open PR. Workspace-aware version queue. |
| `/land-and-deploy` | Merge the PR, wait for CI and deploy, verify production health. |
| `/canary` | Post-deploy monitoring loop in your Aside browser (or gstack's own when Aside is absent). |
| `/landing-report` | Read-only dashboard for the workspace-aware ship queue. |
| `/document-release` | Update all docs to match what you just shipped. |
| `/document-generate` | Generate Diataxis docs (tutorial / how-to / reference / explanation) from code. |
| `/setup-deploy` | One-time deploy config detection (Fly.io, Render, Vercel, etc.). |
| `/gstack-upgrade` | Update gstack to the latest version. |

### Operational + memory

| Skill | What it does |
|-------|-------------|
| `/context-save` | Save working context (git state, decisions, remaining work). |
| `/context-restore` | Resume from a saved context, even across Conductor workspaces. |
| `/learn` | Manage what gstack learned across sessions. |
| `/retro` | Weekly retro with per-person breakdowns and shipping streaks. |
| `/health` | Code quality dashboard (type checker, linter, tests, dead code). |
| `/benchmark` | Performance regression detection (page load, Core Web Vitals). |
| `/benchmark-models` | Cross-model benchmark for skills (Claude, GPT, Gemini side-by-side). |
| `/cso` | Supported security findings with explicit coverage. Static assessment remains available without catalog profiles; contained runtime/scanner execution requires matching qualified profiles. Runtime-tested bundles authenticate separate external assertions. Project-test completion remains `self_reported` because target code controls the test process; `tested` is reserved for a future target-independent completion witness. |
| `/setup-gbrain` | Set up gbrain for cross-machine session memory sync. |
| `/sync-gbrain` | Keep gbrain current with this repo's code; refresh agent search guidance in CLAUDE.md. |

### Browser + agent integration

Every browser skill drives the Aside AI browser first (macOS 15+, aside.com) —
the user's real browser with their real sessions, through `aside repl` scripts;
gstack never installs it. When Aside is not installed or not running (Linux,
Windows, a closed Aside app) the same skills fall back automatically to gstack's
own headless Chromium (`$B`), which is where the three skills under `/browse` apply.

| Skill | What it does |
|-------|-------------|
| `/browse` | Drive a browser: open a page, read it, click through a flow, screenshots, console errors. Aside first; gstack's own Chromium (~100ms/command) as the fallback. Every other browser skill stands on it. |
| `/open-gstack-browser` | Launch the visible GStack Browser with sidebar + stealth — the headed face of the fallback engine. |
| `/setup-browser-cookies` | Import cookies from your real browser into the fallback engine for authenticated testing. Unnecessary on Aside. |
| `/pair-agent` | Pair a remote AI agent (OpenClaw, Codex, etc.) with gstack's own browser over a scoped tunnel. |

### iOS QA — drive real iPhones over USB or Tailscale (v1.43.0.0+)

| Skill | What it does |
|-------|-------------|
| `/ios-qa` | Live-device iOS QA via USB CoreDevice tunnel + embedded StateServer. Optionally exposes the device over Tailscale so remote agents can drive it. |
| `/ios-fix` | Autonomous iOS bug fixer with regression snapshot capture. |
| `/ios-design-review` | Designer's-eye QA on a real iPhone — 10-dimension Apple HIG rubric. |
| `/ios-clean` | Convenience: strip DebugBridge + #if DEBUG wiring before a Release build. |
| `/ios-sync` | Regenerate the iOS debug bridge against the latest upstream templates. |

Companion CLIs (run on the Mac that's plugged into the device):

| Command | What it does |
|---------|-------------|
| `gstack-ios-qa-daemon` | Mac-side broker. Loopback by default; `--tailnet` adds a Tailscale-facing listener with capability tiers and audit logging. |
| `gstack-ios-qa-mint` | Owner-grant CLI for the tailnet allowlist (`grant`/`revoke`/`list`). |
| `gstack-ios-qa-regen` | Regenerate the canonical local DebugBridge package and typed accessors (`--app-source` / `--bridge-dir`). |

End-to-end walkthrough: [docs/howto-ios-testing-with-gstack.md](docs/howto-ios-testing-with-gstack.md).

### Safety + scoping

| Skill | What it does |
|-------|-------------|
| `/careful` | Warn before destructive commands (rm -rf, DROP TABLE, force-push). |
| `/freeze` | Lock edits to one directory. Hard block, not just a warning. |
| `/guard` | Activate both careful + freeze at once. |
| `/unfreeze` | Remove directory edit restrictions. |
| `/make-pdf` | Turn any markdown file into a publication-quality PDF. Renders through Aside, or gstack's own browser when Aside is absent. |
| `/diagram` | English in, diagram out: mermaid source + editable .excalidraw + SVG/PNG, offline. Renders through Aside, or gstack's own browser when Aside is absent. |

## Validation discipline

When fixing failures or preparing `/ship`, follow this order:

1. List the known failing cases, their logs and source revision, the demonstrated
   cause, and the smallest check that can prove each repair. Keep one current
   list in `.context/`; update it instead of starting overlapping repair plans.
   Reconcile the runner's failure total with named failures and unhandled or
   module-load errors; the named-test footer alone is not the complete inventory.
2. Resolve base-branch integration and assign one owner per shared file before
   editing. Keep repairs within the observed failures and the user's scope.
   Before a fixture writes through a link, resolve its target and verify it stays
   inside that fixture's temporary root; live skill registrations can point back
   into this checkout.
   When upstream replaces a helper API, inventory every direct caller, mock
   adapter, source snapshot, generated golden, and selection edge before choosing
   focused checks. Verify extracted test adapters supply the current imports and
   result schema; an adapter failure is not evidence that production failed.
   Schedule independent checks independently. Gate a check only on inputs or
   prerequisites it actually needs; an unrelated failure must not serialize the
   whole validation plan. Keep source fixed while tests live-link its files.
3. Diagnose before changing code. Distinguish a product defect, an invalid test
   expectation, a detector/fixture defect, and a launch/environment failure.
   Preserve the original failure. Do not call it pre-existing without evidence.
   Verify pinned runtime tool schemas and defaults before treating omitted fields
   as model noncompliance.
   Check that a bounded evaluation’s fixture scope and automated answers support
   its metric. Do not let the driver approve unrelated expansion, then blame the
   skill for the extra work; preserve required findings and evidence limits.
4. Reproduce with the smallest relevant test. For agent tests, reuse captured
   public events in free regressions, including negative controls, before paying
   for another agent run. Check behavior and acknowledgments; match exact prose
   only when that prose is the contract. Do not lower thresholds, increase model
   budgets, skip cases, or rejudge a failure to manufacture a pass.
   For policy or validation repairs, exercise the actual registered callback with
   representative native input and assert that it uses the helper’s result.
   When renderer or parser failures recur at the same boundary, verify the
   supported input class against the pinned runtime. Keep adversarial controls;
   do not add one spelling or glyph per paid failure.
   For workflow clarity failures, read the complete evaluated excerpt and its
   referenced source. Resolve all demonstrated ambiguities together: order,
   definitions, ownership and approval. Consolidate dense instructions into
   executable steps instead of appending more clauses. Review the resulting
   workflow as a whole; prose snapshots alone do not prove it is clear.
   For each gate, identify when its inputs exist and trace normal,
   skipped/unavailable and late-change paths to catch circular prerequisites or
   bypassed checks.
5. Run required cheap CI checks, including credential scanning, before paid work.
   Also run adjacent cheap checks: generated-content freshness, prompt-size/parity
   limits, source assertions, fixture checks, and dependency selection as
   applicable. A changed prompt must clear these before its eval.
   For skill edits, include `bun test test/parity-suite.test.ts`: its historical
   union-size cap is separate from the other prompt-size and context budgets.
   When workflow wording changes, search the entire test tree for removed
   clauses, including always-loaded prompt guards. Test fixtures containing
   subprocess examples must pass `test/spawnsync-timeout-tripwire.test.ts`;
   its scanner also checks quoted code.
   Run its selected quality judge before long behavioral evaluations that read
   the same changed prompt. If a repair supersedes an active run's inputs, cancel
   that run, preserve completed outcomes, and label unfinished cases as cancelled.
   Check each edit or setup command’s result before running dependent checks. A
   failed edit is not a reason to test the unchanged input again.
6. Declare a fixture actor’s supported interactions before the model starts.
   Keep its answers and permission handling within that declared interface.
   Bind artifact ownership to the same isolated state passed to the child;
   ambient environment paths do not establish ownership. Check whole-file and
   CI supervision against every case and configured retry, not just one attempt.
   Preflight the actual launcher: required binaries, isolated state, display when
   needed, explicit test tier, selection, and expected executed-case counts.
   Match the runtime versions pinned by the workflow and its container image.
   Keep socket-bearing temporary paths short after the runner adds its nested
   directories; exercise that exact layout in the smoke check. Store long-lived
   logs separately from socket directories.
   Verify required tool execution with a no-cost smoke check under that launch
   environment; versions and authentication alone do not prove it works. Set
   private artifact modes explicitly and preserve normal fixture permissions.
   Prove a diagnostic snapshot survives fixture cleanup in the final artifact
   directory before paid work; native snapshots require EVALS_RUN_ID or GSTACK_EVAL_DIR.
   Bind complete spool filenames and classify Bun's out-of-tier describe.skip
   placeholders separately, with zero selected-case credit.
   Put standalone Git fixtures outside another checkout; verify their resolved
   project slug and state root before interpreting a failure.
   Prove a seed commit succeeds there: repository-local author configuration
   does not establish the identity available to a fresh fixture repository.
   Reject missing explicit test files before invoking Bun; it can silently ignore
   a nonexistent file selector and pass the remaining files.
   Preserve exit status through logging. Use the documented detached runner and
   eval lock. Review the final launcher after edits; preparation and `--list`
   modes must not start monitors, retainers, or test processes. Verify this with
   a before/after process check. During long runs, inspect the last public tool
   result and pending permission state; diagnose a blocked actor before waiting
   through its deadline. Preserve cancellation separately from a test verdict.
   Skipped or unstarted cases
   do not satisfy coverage; preserve configured retries and every attempt.
7. Prove all known repairs with focused tests, including affected paid cases.
   Rerun a failed case only after a concrete repair or a demonstrated launch
   correction. Run the remaining required selected evaluations on the integrated
   code. Do not use the full free suite to discover predictable adjacent failures.
   Reuse a passing check when its consumed inputs and relevant environment are
   unchanged. For model judges, compare the expanded prompt, rubric, parameters
   and dependencies; a different commit alone does not invalidate the result.
   Do not resample an unchanged passing judge to simplify launcher configuration.
   Preserve its original source and label the result as reused evidence.
   Use actual prompt builders and compare complete bytes when proving model-input
   identity; preserve literal text in excerpts and record the consumed inputs.
8. Finish review fixes, generation, release metadata, and build before final
   acceptance. Freeze the code, then run `bun run test` once at the end. During
   repair, focused checks replace a full-suite run before every commit. If final
   acceptance unexpectedly fails, retain the failure, diagnose it narrowly, and
   report the changed validation plan before another full run; never retry it
   blindly or claim a pass from an older revision.
9. Publish only with passing required checks, unless the user explicitly grants
   an exception for identified failures. Report revision, actual pass/fail/skip
   counts, and incomplete coverage. A passing subset is not release acceptance.

## Build commands

```bash
bun install              # install dependencies
bun run test:quick       # fast measured free subset for edit feedback (not acceptance)
bun run test             # complete free suite via the strict shard runner (no API spend)
bun run eval:bg:pr       # changed fast live probes + selected judges, with explicit deferrals
bun run eval:bg:release  # fresh complete gate + periodic live coverage
bun run test:windows     # curated Windows-safe subset (runs on windows-latest)
bun run build            # generate docs + compile binaries
bun run gen:skill-docs   # regenerate SKILL.md files from templates
bun run skill:check      # health dashboard for all skills
```

## Platform support

- **macOS** + **Linux**: full test suite supported.
- **Windows**: curated Windows-safe subset runs on `windows-latest` via the
  `windows-free-tests` CI job. Setup script (`./setup`) requires Git Bash or
  MSYS today; native PowerShell support is a future expansion. The `bin/gstack-paths`
  helper resolves state roots through `CLAUDE_PLUGIN_DATA` / `GSTACK_HOME` so plugin
  installs work on every platform.
- **CSO native helper**: `/cso` additionally needs Bun's four
  `--no-compile-autoload-*` flags and a native toolchain (static-capable C on
  Linux, Xcode command-line tools on macOS, or VS 2022 C++ Build Tools on
  Windows). Setup installs everything else and leaves `/cso` explicitly
  unavailable when that optional toolchain is absent.
- **Browser and renderer**: the browser skills, `/make-pdf`, and `/diagram` drive
  the Aside browser first, which is macOS 15+ only. On Linux and Windows (or a
  Mac with Aside closed) the readiness check says so once and the same skills use
  gstack's own bundled browser, built by `./setup`.

## Key conventions

- SKILL.md files are **generated** from `.tmpl` templates. Edit the template, not the output.
- Run `bun run gen:skill-docs --host codex` to regenerate Codex-specific output.
- Browser steps in skills are `aside repl` scripts per `scripts/resolvers/aside.ts` (Aside first), each with a `$B` equivalent for the fallback engine — `$B <command>` is the browse binary and is a legitimate tool when the Aside probe does not print `READY`. Local HTML renders through `bin/gstack-render.ts`, which picks the same way.
- Safety skills (careful, freeze, guard) use inline advisory prose — always confirm before destructive operations.
- State paths resolve via `bin/gstack-paths` (sourced via `eval "$(...)"`). Honors `GSTACK_HOME`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLANS_DIR`.
- The `claude` CLI binary resolves via `lib/claude-bin.ts` (re-exported from `browse/src/claude-bin.ts` for browse internals; `Bun.which()` + `GSTACK_CLAUDE_BIN` override). Set `GSTACK_CLAUDE_BIN=wsl` plus `GSTACK_CLAUDE_BIN_ARGS='["claude"]'` to run Claude through WSL on Windows.
