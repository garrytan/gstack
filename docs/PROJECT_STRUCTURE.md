# Project structure

Moved verbatim from CLAUDE.md (token-load reduction).

## Directory tree

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
│   ├── claude/hooks/  # Claude Code lifecycle hooks (AUQ capture + enforcement, spawned-session directive, timeline stop)
│   ├── codex.ts, factory.ts, kiro.ts  # Existing hosts
│   ├── opencode.ts, slate.ts, cursor.ts, openclaw.ts  # IDE hosts
│   ├── hermes.ts, gbrain.ts  # Agent runtime hosts
│   └── index.ts     # Registry: exports all, derives Host type
├── scripts/         # Build + DX tooling
│   ├── gen-skill-docs.ts  # Template → SKILL.md generator (config-driven)
│   ├── gen-agents-digest.ts  # Generates the budget-capped instruction-tier digest (agents-digest/)
│   ├── host-config.ts     # HostConfig interface + validator
│   ├── host-config-export.ts  # Shell bridge for setup script
│   ├── resolvers/   # Template resolver modules (preamble, design, review, gbrain, etc.)
│   ├── skill-check.ts     # Health dashboard
│   ├── test-free-shards.ts  # Strict parallel free-suite runner (GSTACK_FREE_JOBS, opt-in flaky retry)
│   ├── test-paid-shards.ts  # Sharded paid-tier runner (one Bun process per shard)
│   ├── eval-flake-rank.ts  # Flake-telemetry dial: ranks tests by retried passes across eval runs + the free-lane ledger
│   ├── sandbox-doctor.sh  # One-command cloud-sandbox fixer: makes the free suite run green
│   └── dev-skill.ts       # Watch mode
├── test/            # Skill validation + eval tests
│   ├── helpers/     # skill-parser.ts, session-runner.ts, llm-judge.ts, eval-store.ts
│   ├── fixtures/    # Ground truth JSON, planted-bug fixtures, eval baselines
│   ├── skill-validation.test.ts  # Tier 1: static validation (free, <1s)
│   ├── gen-skill-docs.test.ts    # Tier 1: generator quality (free, <1s)
│   ├── setup-*.test.ts, relink.test.ts, hook-scripts.test.ts  # Tier 1: setup linker ownership + Chromium bootstrap (anchor-sliced from setup), gstack-relink, PreToolUse hooks (free)
│   ├── skill-llm-eval.test.ts   # Tier 3: LLM-as-judge (~$0.15/run)
│   └── skill-e2e-*.test.ts       # Tier 2: E2E via claude -p (~$3.85/run, split by category)
├── qa-only/         # /qa-only skill (report-only QA, no fixes)
├── plan-design-review/  # /plan-design-review skill (report-only design audit)
├── design-review/    # /design-review skill (design audit + fix loop)
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── autoplan/        # /autoplan skill (auto-review pipeline: CEO → design → DX → eng, eng always last)
├── benchmark/       # /benchmark skill (performance regression detection)
├── canary/          # /canary skill (post-deploy monitoring loop)
├── codex/           # /codex skill (multi-AI second opinion via OpenAI Codex CLI)
├── land-and-deploy/ # /land-and-deploy skill (merge → deploy → canary verify)
├── office-hours/    # /office-hours skill (YC Office Hours — startup diagnostic + builder brainstorm)
├── investigate/     # /investigate skill (systematic root-cause debugging)
├── spec/            # /spec skill (five-phase spec → GitHub issue, optional agent spawn, /ship auto-closes)
├── retro/           # Retrospective skill (includes /retro global cross-project mode)
├── careful/         # /careful skill; bin/check-careful.sh (PreToolUse destructive-command hook) + bin/hook-extract.sh (shared hook helpers: payload extraction, deny JSON, gstack_hook_state_root)
├── freeze/          # /freeze skill; bin/check-freeze.sh (PreToolUse edit-boundary hook; sources careful/bin/hook-extract.sh, fails closed)
├── guard/, unfreeze/  # /guard (careful + freeze in one), /unfreeze
├── gstack-upgrade/  # /gstack-upgrade skill + migrations/ (run after ./setup during an upgrade)
├── bin/             # CLI utilities (gstack-repo-mode, gstack-slug, gstack-config, gstack-wtree, gstack-evidence, gstack-issue-guard, gstack-relink, etc.)
├── document-release/ # /document-release skill (post-ship doc updates + Diataxis coverage map)
├── document-generate/ # /document-generate skill (Diataxis doc generator: tutorial/how-to/reference/explanation)
├── cso/             # /cso skill (OWASP Top 10 + STRIDE security audit)
├── design-consultation/ # /design-consultation skill (design system from scratch)
├── design-shotgun/  # /design-shotgun skill (visual design exploration)
├── open-gstack-browser/  # /open-gstack-browser skill (launch GStack Browser)
├── connect-chrome/  # symlink → open-gstack-browser (backwards compat)
├── design/          # Design binary CLI (GPT Image API)
│   ├── src/         # CLI + commands (generate, variants, compare, serve, etc.)
│   ├── test/        # Integration tests
│   └── dist/        # Compiled binary
├── agents-digest/   # Committed 2KB instruction-tier rules digest (gstack-AGENTS.md) for rules-reading hosts
├── extension/       # Chrome extension (side panel + activity feed + CSS inspector)
├── lib/             # Shared libraries (worktree.ts, egress-receipt.ts, context-bill.ts, redact-engine.ts, tracker-guard.ts, version-source.ts, code-intelligence/)
├── patches/         # bun `patchedDependencies` patches (playwright-core windowsHide)
├── docs/designs/    # Design documents (incl. fork-port-residual-2026-09/ evaluation evidence)
├── setup-deploy/    # /setup-deploy skill (one-time deploy config)
├── .github/         # CI workflows + shared composite actions (.github/actions/) + Docker image (claude CLI pinned)
│   ├── workflows/   # evals.yml (E2E on Ubicloud), quality-gate.yml (secret scan), dependency-review.yml, osv-scanner.yml, skill-docs.yml, actionlint.yml, and 8 more (windows, periodic evals, release gates, ci-image)
│   └── docker/      # Dockerfile.ci (pre-baked toolchain + Playwright/Chromium)
├── contrib/         # Contributor-only tools (never installed for users)
│   └── add-host/    # /gstack-contrib-add-host skill
├── setup            # One-time setup: build binary + best-effort Chromium bootstrap + link skills (ownership-gated)
├── SKILL.md         # Generated from SKILL.md.tmpl (don't edit directly)
├── SKILL.md.tmpl    # Template: edit this, run gen:skill-docs
├── ETHOS.md         # Builder philosophy (Boil the Ocean, Search Before Building)
└── package.json     # Build scripts for browse
```
