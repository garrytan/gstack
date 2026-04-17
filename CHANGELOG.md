# Changelog

## [1.1.0.0] - 2026-04-17 — Closed-loop voice enforcement

Caveman voice is no longer a suggestion. Every assistant response now passes
through a density check before it reaches you. If the model drifts verbose
mid-session, the response is blocked and rewritten. No more "starts tight,
ends verbose by turn 40." Voice invariance over time, not just at turn 1.

### What you can now do

- **See voice drift die at the gate.** A new Stop hook reads your last
  message, counts articles/filler/hedges/verbose phrases per 100 words,
  and blocks if it fails your active profile's floor. The model rewrites
  once, then ships (with a marker if still over-floor) so you're never stuck.
- **Pick your intensity.** Each caveman profile has its own runtime floor:
  `caveman-full` (default, articles ≤2.0/100w), `caveman-lite` (looser,
  ≤3.0/100w — keeps articles + sentences), `caveman-ultra` (strictest,
  ≤1.0/100w — fragments + tables). `none` profile stays exempt.
- **Stop writing Phase 2 / future work / later TODOs.** A second terminal
  rule ("NO DEFERRED WORK") lives in every caveman profile and in
  CLAUDE.md. Ship scope complete in one shot or cut scope — no third state.
  Design docs, plans, and TODOs all get this guardrail.
- **Opt out without uninstalling.** `CAVESTACK_VOICE_VERIFY=0` per-session,
  or `cavestack-config set voice_verify false` persistent. Hook fails open
  on any error (missing transcript, bad config, timeout) — never traps you.
- **Keep your code/commits/PRs normal.** Code blocks, inline backtick code,
  GitHub markdown tables, YAML frontmatter, and HTML comments are stripped
  before scoring. Only prose is checked. Security warnings stay verbose.

### Under the hood

- New shared density math at `scripts/lib/voice-density.ts` — single source
  of truth for `voice-audit.ts` (build-time template check) and
  `caveman-voice-verify.js` (runtime Stop hook). No duplication.
- New `hooks/caveman-voice-verify.ts` source compiles to
  `hooks/caveman-voice-verify.js` via `bun run build:hook`. Node-compatible,
  no dependencies, p95 latency 183ms on Windows (300ms budget).
- `density_thresholds` object populated in every caveman profile JSON.
  Schema already supported it — no schema change needed.
- `voices/README.md` documents threshold derivation and when to adjust.
- `setup` auto-registers the Stop hook when caveman mode is installed.
  `setup --no-caveman` removes it. Existing installs get it via the
  `v1.1.0.0.sh` upgrade migration.
- `bin/cavestack-settings-hook` gains `install-voice-verify` and
  `remove-voice-verify` subcommands.

### Tests

- 26 unit tests for the density lib (computeDensity, checkThresholds,
  extractNonFloorText, loadProfile).
- 11 integration scenarios for the Stop hook (pass, block, two retry
  paths, opt-out, short-message guard, profile=none, missing transcript,
  no-stdin, code stripping, profile comparison) plus a latency benchmark.
- 12 validation assertions for the new profile clauses and threshold
  ordering invariant.

## [1.0.1.0] - 2026-04-17 — Cave Mural website redesign

The marketing site now looks like the tool itself feels: cave wall, torch glow,
hand-drawn petroglyphs, zero clickthrough. Every pitch fact is visible in the
first screen. Everything verbose hides in a single collapsible at the bottom.

### What you can now do

- **Visit one page and get the whole pitch.** Hero + terminal demo + 9 skills
  grid + collapsible deep-dive. No nav, no tabs, no "learn more" round trips.
- **Copy-paste install in one click.** The install box has an amber border,
  a firelight glow, and a big copy button that turns green when it worked.
- **Read the docs without leaving the page.** Everything you'd want on a
  "How it works" page is folded into a single `<details>` at the bottom —
  install, voice, philosophy, character-based metrics, what's on disk, team
  mode, troubleshooting, license.
- **Tell a story with cave art.** Four hand-authored petroglyph SVGs (handprint,
  mammoth, spiral, torch) anchor the sections without stock-clipart energy.
  Amber is rare and meaningful: only on torch, install border, `<details>` marker.

### Accessibility + SEO upgrades

- Skip link to content (WCAG 2.4.1 now A-level compliant).
- Every interactive surface has a visible focus ring (amber outline, 2px).
- Torch cursor auto-disables on touch and on `prefers-reduced-motion`.
- Terminal `aria-live` is off so screen readers don't narrate every keystroke.
- JSON-LD SoftwareApplication schema so Google gets the name, price, license,
  download URL right.
- `sitemap.xml` and `robots.txt` so search engines can actually crawl the site.
- Proper `og:` and `twitter:` tags so the link preview on Twitter/X, Slack,
  Discord, LinkedIn all look right.

### What's gone

- `docs/methodology.html` and `docs/roadmap.md` — both were dead ends that
  distracted from the pitch. Deferred items now live as GitHub Issues.
- The benchmark table on the marketing page — moved to the collapsible docs
  section. The front page is for "what and why", not "prove it to me".

### For contributors

- Inline `<style>` in `docs/index.html` extracted to `docs/styles.css` so the
  two pages share a stylesheet and CSS caches across navigation.
- `docs/install` (no extension) mirrors `docs/install.sh` so the one-liner
  resolves. GitHub Pages serves the extensionless file as octet-stream; curl
  still pipes it to sh without issue.
- 8-token color palette locked in CSS custom properties. Anyone contributing
  a new skill card should use `var(--heading)` / `var(--cave-brown)` and
  keep amber off the chrome.
- `TODOS.md` preamble updated: deferred ideas → GitHub Issues, not a
  phantom roadmap doc.

## [1.0.0.0] - 2026-04-16 — v1.0 finished product

CaveStack is now a **finished product**. You can install it in one line, see
every skill from inside your terminal, and know exactly what's getting
measured — without running a single line of telemetry anywhere.

**Savings now measured in characters, not tokens.** Every model counts tokens
differently (GPT, Claude, Gemini all use different tokenizers). Characters are
universal. `stdout.length` is the same number on every machine, every model.
Anyone can reproduce the benchmark without an API key — Claude Code Pro
subscription is enough.

### What you can now do

- **Install in one line.** `curl -fsSL https://cavestack.jerkyjesse.com/install | sh` —
  detects and installs bun if missing (with SHA256-verified installer), clones
  cavestack into the right place, builds binaries, wires hooks, and prints
  a post-install message pointing you at your first three skills.
- **Discover every skill without leaving your terminal.** New
  `cavestack-skills list` shows all 40 installed skills with one-line
  descriptions, hero six highlighted. `cavestack-skills search <term>`
  fuzzy-matches. `cavestack-skills info <name>` shows details.
- **Ask `/help` from inside Claude Code** to see the same catalog. No website
  round-trip needed.
- **Type `cs-*` instead of `cavestack-*`.** 20+ shortcut aliases installed
  automatically: `cs-skills`, `cs-config`, `cs-analytics`, `cs-dx`, `cs-run`,
  `cs-replay`. Same CLIs, fewer keystrokes.
- **Measure your own DX locally.** `cavestack-dx show` displays your
  personal time-to-hello-world and skill discovery events. Zero network.
  Zero telemetry. Purge with `rm ~/.cavestack/analytics/dx-metrics.jsonl`.
- **See the benchmark proof.** New `/methodology` page shows exactly what
  tasks we ran, on what hardware, with what model — and how to rerun yourself.
  Honest about three trust tiers (verifiable, probabilistic, unaudited).
- **Wrap Claude Code for productivity.** New `cavestack run "<task>"` command
  opts into session replay with redact-on-record. Built-in redaction catches
  AWS/Anthropic/GitHub/GitLab tokens, JWTs, `.env` fragments, and URL-embedded
  credentials. The `share` command refuses to publish non-redacted records.
- **Every error you hit now tells you what broke + why + the exact fix +
  a docs link.** New Tier-2 error pattern (`CS001`-`CS901`) shared across
  every CLI via `lib/error.sh` and `lib/error.ts`.
- **Rebuilt github.io landing.** Identity-first hero (brand before benchmark),
  typeset skill list (anti-slop — no generic 3-col feature grid), bespoke
  SVG cave-painting silhouettes replace decorative emoji layer, quiet
  breather section breaks section rhythm, methodology page for transparency.
- **Zero skills removed.** All 40 skills ship in 1.0. Hero six are featured
  on the landing page.

### Under the hood

- **`lib/error-codes.json` + `lib/error.ts` + `lib/error.sh`** — shared
  error registry. Bash and TypeScript print identical output.
- **`lib/redact.ts`** — reusable redaction pipeline. `redact(text)` replaces
  matches with `[REDACTED:<type>]`. `verifyRedacted(text)` returns an array
  of remaining findings (share command refuses if nonempty).
- **`bin/cavestack-skills`** — skill catalog CLI. List, info, search, count.
- **`bin/cavestack-dx`** — local DX metrics. Tracks `install_completed`,
  `first_skill_run`, `skill_list_viewed`. Shows TTHW classification.
- **`bin/cavestack-run`** — Claude Code wrapper with `--record` +
  `--no-redact` flags for session replay with redact-on-record.
- **`bin/cavestack-replay`** — replay sessions, `share` gates on redaction.
- **`bin/cavestack-cs-aliases`** — idempotent short-alias generator. Creates
  `cs-*` for every `cavestack-*` CLI.
- **`bin/cavestack-redact-stream.ts`** — stdin→stdout redaction filter used
  by `cavestack run --record`.
- **`cavestack-upgrade/migrations/v1.0.0.0.sh`** — idempotent upgrade.
  Bootstraps DX metrics file, records `install_completed`, creates cs-* aliases.
- **`test/benchmarks/`** — benchmark harness + 10 fixed tasks + methodology
  README. Runs via `bun run bench` on maintainer machine only. Pre-release.
- **`docs/methodology.html`, `docs/skills.html`** — new static pages.
- **`docs/install.sh`** — one-liner installer with auto-bun-detect + verify.
- **`docs/roadmap.md`** — deferred items from prior TODOs moved here.
  Not promised, no version targets.

### For contributors

- Error codes live in `lib/error-codes.json`. Any new error site: add a code,
  call `cavestack_error CSXXX` from bash or `throw new CavestackError("CSXXX")`
  from TS.
- Benchmark harness scaffolded but not wired to actual invocation. Maintainer
  runs `bun run bench` once before v1.0.0.0 release tag to populate
  `docs/benchmarks/v1.0.0.0.json`. See `test/benchmarks/README.md`.
- `docs/roadmap.md` is the new home for deferred ideas. `TODOS.md` is only
  for active work. If it's not happening soon, move it.

