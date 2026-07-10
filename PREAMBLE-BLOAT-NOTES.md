# Preamble Bloat — Findings & Safe Trim Strategy

Date: 2026-07-05. Investigated on branch `feat/pr-prep-skill`
(merge-base with `upstream/main` = `11de390b`, v1.58.5.0).

**Verdict: do NOT trim locally.** The bloat is upstream-owned, generated
content, churned in every upstream release. Any fork-side edit to the
source (resolvers or templates) or to the committed generated files
guarantees rebase conflicts on every `/gstack-upgrade` (this fork is
maintained by rebasing onto `upstream/main`). The safe path is an
upstream PR that extends the repo's own `sections/` carving mechanism
to the preamble. Details below.

---

## 1. Where the bytes come from

Every `~/.claude/skills/<name>/SKILL.md` is a **symlink** into this repo.
Each `SKILL.md` here is **generated** by `scripts/gen-skill-docs.ts` from
`<skill>/SKILL.md.tmpl`: placeholders (`{{PREAMBLE}}`, `{{SLUG_SETUP}}`,
`{{QA_METHODOLOGY}}`, …) are resolved from `scripts/resolvers/**`.

The dominant placeholder is `{{PREAMBLE}}`, composed in
`scripts/resolvers/preamble.ts` from ~24 generator files under
`scripts/resolvers/preamble/`, gated by `preamble-tier: 1-4` in each
template's frontmatter (missing tier defaults to 4).

Rendered preamble size (measured by invoking `generatePreamble()`
directly; host=claude, model=claude, interactive):

| Tier | Bytes | ~Tokens (4 B/tok) | Skills at this tier |
|------|-------|-------------------|---------------------|
| 1 | 25,690 | ~6.4k | 6 |
| 2 | 45,295 | ~11.3k | 16 |
| 3 | 46,336 | ~11.6k | 15 |
| 4 | 46,336 | ~11.6k | 7 (+ untiered, e.g. `spec`) |

So a tier-2 skill like `context-save` (54,971 B total) is **84% preamble**
(46,112 B before the first body heading). Across the whole install,
~1.9 MB of the 3.57 MB of installed SKILL.md bytes is the same preamble
duplicated ~44 times (~53%).

Per-section breakdown of the tier-4 preamble (rendered bytes):

| Section | Bytes | Nature |
|---|---|---|
| ask-user-format | 10,546 | prose — interaction framework |
| preamble-bash | 6,169 | **functional** — session/telemetry bootstrap |
| brain-sync-block | 5,785 | **functional** — gbrain sync bash |
| plan-mode-info | 2,888 | prose + env contract |
| question-tuning | 2,494 | prose |
| context-recovery | 2,378 | prose |
| first-run-guidance | 1,715 | one-time onboarding gate |
| routing-injection | 1,624 | one-time onboarding gate |
| voice-directive | 1,350 | prose |
| upgrade-check | 1,186 | **functional** — bash |
| writing-style | 1,113 | prose |
| vendoring-deprecation | 975 | one-time gate |
| model-overlay | 947 | behavioural patch |
| continuous-checkpoint | 922 | prose |
| telemetry-prompt | 829 | one-time gate |
| 9 further sections | ~4,182 | mixed, ≤700 B each |
| **Total** | **~45.1k** | |

## 2. Ten largest installed SKILL.md files (symlink-resolved bytes)

```txt
126,959  spec            (untiered -> T4)
105,796  review          (T4)
105,734  design-review   (T4)
101,167  land-and-deploy (T4)
100,590  autoplan        (T3)
 97,744  office-hours    (T3)
 93,248  retro           (T2)
 90,397  setup-gbrain
 90,000  codex           (T3)
 89,827  plan-ceo-review (T3)
```

(Also notable: `qa` 83,941; `context-save` 54,971; `browse` 54,983.)
Non-gstack skills are far smaller: `graphify` 37,070, `impeccable`
19,981, `undercover-agent` 12,653 — the bloat is specifically the
gstack preamble plus a handful of intentionally large bodies.

## 3. Why fork-side trimming is unsafe (the evidence)

1. **Upstream owns and churns every layer.** The last three upstream
   releases (v1.57.5.0 `45cc95d5`, v1.58.1.0 `c7ae6320`, v1.58.5.0
   `11de390b`) each modified `scripts/resolvers/preamble/` AND the
   committed generated `SKILL.md` files (e.g. `context-save/SKILL.md`
   changed in all three). A single release delta
   (`upstream/main~1..upstream/main`) touched **51 files / 1,469
   insertions** across `*/SKILL.md`, `*/SKILL.md.tmpl`, and
   `scripts/resolvers/`. A local diff in those paths conflicts on
   every rebase.
2. **CI freshness gate pins generated output to default flags.**
   `gen-skill-docs.ts --dry-run` (used by `skill:check` / CI) exits 1
   if committed SKILL.md ≠ generator output. A committed trim therefore
   cannot live only in the generated files — it must be sourced in the
   resolvers/templates, which are exactly the upstream-churned files.
3. **This fork's own discipline confirms the pain.** The 12 local
   commits ahead of upstream confine themselves to a new fork-owned
   skill (`pr-prep/`) plus a ~50-line `ship/SKILL.md.tmpl` addition;
   none touch `scripts/resolvers/`. That boundary is what keeps
   rebases cheap today.
4. **Preamble composition is behaviour-sensitive upstream territory.**
   `preamble.ts` documents ordering constraints in-line (e.g.
   AskUserQuestion Format must render before the model overlay;
   "reversing this order regresses plan-review cadence (v1.6.4.0
   bug)"). Relocating sections is not a mechanical move.
5. **Upstream's stated stance tolerates the size.** The generator's
   token-ceiling guardrail (gen-skill-docs.ts, ~line 1013) warns only
   above 160 KB/file and explicitly defends 25-35k-token skills as
   intentional. A quiet local fork of that philosophy would fight
   upstream on every release.

## 4. The safe trim strategy

**A. Upstream PR (recommended, durable).** The machinery already
exists: carved skills render on-demand `sections/*.md` for the Claude
host (`discoverSectionTemplates` in `scripts/discover-skills.ts`,
section generation in `gen-skill-docs.ts`; live examples:
`plan-eng-review/sections/`, `qa/references/`, `qa/templates/`).
Extend it to the preamble:

- Move the tier-2+ interaction-framework prose — ask-user-format,
  question-tuning, context-recovery, writing-style, completeness,
  confusion-protocol, continuous-checkpoint, context-health, plus the
  tier-3 repo-mode and search-before-building blocks (~20.5 KB
  rendered) — into a generated shared section file (e.g.
  `<skill>/sections/interaction-framework.md`), leaving a 2-3 line
  pointer in the inline preamble ("Read
  `~/.claude/skills/gstack/<skill>/sections/interaction-framework.md`
  before your first AskUserQuestion / when the framework applies").
- Keep byte-identical inline: the functional bash bootstrap
  (preamble-bash, upgrade-check, brain-sync-block, telemetry), the
  one-time onboarding gates, model overlay, and frontmatter/triggers.
- Non-Claude hosts already inline sections via `{{SECTION:id}}`, so
  the change is Claude-host-only, mirroring the existing carve.

Run `/pr-prep` first (built in this fork for exactly this) to check
upstream for an existing issue/PR on preamble slimming before opening.

**B. Zero-conflict local interim (nothing committed).** Render a
user-local variant to an untracked directory with the existing
`--out-dir` flag and re-point the `~/.claude/skills/<name>/SKILL.md`
symlinks there. Supported knob today: `--explain-level=terse`
compresses four prose sections to pointer lines — but it saves only
~2.2 KB (46,336 → 44,179 B), which is why A is the real fix. Note the
working tree already carries expected uncommitted SKILL.md dirt from
`gen:skill-docs:user` (gbrain detection); an out-dir render avoids
adding to it.

**C. Not recommended.** Fork-local edits to
`scripts/resolvers/preamble/**` or committing regenerated SKILL.md
files: recurring semantic conflicts against ~50 files/1.5k lines of
upstream churn per release.

## 5. Estimated savings (strategy A)

- Per invocation, tier 2-4 skill: ~20.5 KB relocated ≈ **~5.1k tokens
  saved** (at the generator's own 4-chars/token heuristic), i.e. the
  preamble drops ~44% (46.3 KB → ~25.8 KB) and e.g. `context-save`
  goes 55 KB → ~34 KB, `qa` 84 KB → ~63 KB.
- Applies to 38 tier-2+ skills; tier-1 skills (browse, benchmark, …)
  are unaffected by design.
- Install-wide: ~0.8 MB less duplicated preamble on disk; every
  gstack skill invocation on this machine starts ~5k tokens lighter.
- Getting the top offenders under ~15 KB would additionally require
  carving their bodies (spec 95 KB body, review ~60 KB body) — that is
  upstream-owned, intentionally-tuned behaviour per the token-ceiling
  comment, so propose it upstream per-skill via the same `sections/`
  mechanism rather than forking it.

---

## 6. Upstream duplicate check (2026-07-05, Opus session)

Ran the check the strategy said to do first. Findings on garrytan/gstack:

- **#1572 (open) — "skill: cache preamble bash output within session to
  reduce duplication"** is the closest existing issue: same preamble-duplication
  concern, no PR carving the interaction-framework prose yet. Our proposal is
  complementary, not a duplicate.
- Active adjacent preamble work (do NOT collide): #2001/#2022 gate
  upgrade-handling prose; #1150/#1188 gate telemetry session tracking; #1982
  surface failed update-checks; #1972 shrink skill descriptions (codex budget).
- No open PR implements a `sections/` carve of the preamble prose.

Verification blockers confirming proposal-first:
- `bun run skill:check` is **red on a clean `11de390b` checkout** — unrelated
  cause: `.gbrain/skills/gstack-*/SKILL.md` stale under `gen:skill-docs --host
  gbrain` detection. A fork can't cleanly prove Claude-host freshness in
  isolation against that baseline.
- Real behaviour gate is `test:evals` (EVALS=1, live model calls) — API-gated.

Deliverable: `~/worktrees/gstack-preamble-trim/PR-PROPOSAL.md` — maintainer-ready
text to post on #1572 for buy-in before implementing. Branch `pr/preamble-trim`
sits on clean upstream; no code committed (proposal-first, per above).
