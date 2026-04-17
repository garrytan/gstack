# Changelog

## [1.2.0.0] - 2026-04-17 — Musk 5-step algorithm baked into every skill

Every cavestack skill now applies the Musk 5-step algorithm before scoping
work. Question every requirement, delete first, simplify, accelerate,
automate — in **strict order**, never reverse, never skip ahead. No new
commands, no new flags. Sharper scope, fewer half-finished features.

The directive ships verbose at tier 2-3 (workflow + planning skills) and
compact at tier 4 (ship/review/qa/qa-only/design-review/land-and-deploy).
Tier 1 utility skills (browse, setup-cookies, benchmark) skip it entirely
since they don't author code or scope tasks.

### Added

- **Musk 5-Step Algorithm directive** in every tier 2+ cavestack skill.
  Caveman-styled to pass the existing voice-density Stop hook. Strict-order
  reinforcement: caught on step 4-5 without finishing 1-3 = stop and restart
  at step 1.
- **Opt-in CLAUDE.md injection.** After accepting the proactive setting,
  the next cavestack skill invocation in a project offers to append a
  `## Build philosophy` section to your CLAUDE.md (~10 lines). Same UX as
  the routing-injection prompt. Decline once and we never ask again. Gate
  is the HTML comment marker `<!-- cavestack-build-philosophy -->`, not the
  H2 header — so CHANGELOG quotes won't trip the gate.

### For contributors

- New `MUSK_RULES_FULL`, `MUSK_RULES_COMPACT`, and
  `BUILD_PHILOSOPHY_CLAUDE_MD_SECTION` constants in
  `scripts/resolvers/behavioral-protocols.ts`. Single source of truth — the
  CLAUDE.md template body derives from `MUSK_RULES_COMPACT` via H2→H3
  string interpolation, not literal duplication. Editing the constant
  propagates everywhere.
- Tier 4 skills get the compact variant to bound SKILL.md growth
  (`ship/SKILL.md` pre-existing 112KB; this change adds ~1.7KB). Tier 1
  skills skip the directive entirely.
- New tests in `test/gen-skill-docs.test.ts` `build philosophy directive`
  describe block: tier-3 inclusion, tier-4 compact variant, tier-1 exclusion,
  CLAUDE.md template structure, opt-in flow, marker-comment gate.
- Golden files `test/fixtures/golden/{claude,codex,factory}-ship-SKILL.md`
  regenerated. Diff is the new directive content only.

## [1.1.1.0] - 2026-04-17 — Voice-verify hardening + review comparison relaunch

Patch release on top of v1.1.0.0. Plugs four evasion paths the `/review`
skill surfaced right after shipping closed-loop voice enforcement, and
restores the text side-by-side `/review` comparison on the marketing site.

### Voice-verify hardening

- **Unclosed code fences no longer silence density scoring.** Previously,
  an assistant could emit ```` ```bash ```` and talk prose afterward without
  ever closing the fence — the rest of the response read as "code" and
  passed density unchecked. Now an unclosed fence reverts the opening
  line to prose and the whole body scores normally.
- **YAML frontmatter bounded to the first 20 lines.** Starting a message
  with `---` and never closing used to strip everything until the next
  stray `---`. Now the closing delimiter must appear within 20 lines;
  otherwise the leading `---` is treated as prose and the rest scores.
- **Retry detection simplified to Claude Code's authoritative flag.**
  Dropped the "previous assistant message less than 5 seconds ago"
  fallback. That fallback false-positived on fast legitimate
  conversations — a genuinely over-floor turn right after a passing
  turn got soft-markered instead of blocked. Now `stop_hook_active`
  from Claude Code is the only retry signal.
- **Stop hook timeout bumped 1s → 5s.** Matches the other caveman
  hooks. p95 is 183ms on Windows, but cold-start Node + antivirus
  scan + a near-cap transcript could previously exceed 1 second and
  trigger a silent fail-open. 5s absorbs that variance.
- **Installing caveman now also installs the voice-verify Stop hook.**
  Previously, a user who ran `./setup --no-caveman` and later enabled
  caveman via `install-caveman` would end up with SessionStart +
  UserPromptSubmit hooks registered but no Stop hook, because the
  v1.1.0.0 migration marker blocked a rerun. Now `install-caveman`
  bundles `install-voice-verify`, and `remove-caveman` is symmetric.
- **Minor fixes:** `computeDensity` verbose-phrase count now stays in
  sync with the flagged-items list when a phrase appears multiple
  times on one line; `readStdin` clears its safety timeout on
  success/error instead of leaking a stale callback.

### Marketing site

- Replaced the PNG carousel with a text side-by-side rendition of the
  exact `/review` output a user sees in default verbose mode vs CaveStack
  caveman mode. Same findings, 82% less prose, rendered as panes users
  can scroll independently.

### Tests

Three new regression tests cover the evasion guards (unclosed fence,
unbounded YAML, bounded YAML). Scenario 4 of the Stop hook integration
suite rewritten as a regression guard asserting fast legitimate turns
still block on first attempt. Total suite: 41 pass, 0 fail (up from 38).

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

