# gstack development

## Commands

```bash
bun install          # install dependencies
bun test             # run integration tests (browse + snapshot)
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # compile binary to browse/dist/browse
```

## Project structure

```
gstack/
├── browse/                          # Headless browser CLI (Playwright)
│   ├── src/                         # CLI + server + commands
│   ├── test/                        # Integration tests + fixtures
│   └── dist/                        # Compiled binary
├── ship/                            # Ship workflow skill
├── review/                          # PR review skill
├── plan-ceo-review/                 # /plan-ceo-review skill
├── plan-eng-review/                 # /plan-eng-review skill
├── retro/                           # Retrospective skill
├── qa/                              # QA testing skill
│
│ ── Cybereum Platform Skills ──
│
│   Dev Team (building Cybereum):
├── cybereum-schedule-intelligence/  # P6/XER schedule analysis, DCMA 14-Point
├── cybereum-decision-ai/            # Schwerpunkt decision engine
├── cybereum-risk-engine/            # Risk register, scoring, mitigation
├── cybereum-evm-control/            # Earned Value Management analytics
│
│   PM Team (inside Cybereum):
├── cybereum-completion-prediction/  # Monte Carlo, P50/P80 forecasting
├── cybereum-reference-class/        # Flyvbjerg RCF, optimism bias correction
├── cybereum-executive-reporting/    # Board/PMO/lender report generation
├── cybereum-sales-intelligence/     # BD, prospect research, pitch materials
│
├── setup                            # One-time setup: build binary + symlink skills
├── SKILL.md                         # Browse skill (Claude discovers this)
└── package.json                     # Build scripts for browse
```

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binary directly: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
