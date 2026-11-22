# Third-Party Notices

gstack is MIT. The files below contain material derived from Apache-2.0 and MIT
works, rewritten in gstack's voice and modified. Rewriting is not an exemption:
the license texts are in `licenses/`, and each file derived from an Apache-2.0
work carries a notice that it was changed. Unmodified copies (the rule-registry fixture, the
license text) carry no header and are listed here instead.

## impeccable — Copyright Paul Bakaus — Apache License 2.0

https://github.com/pbakaus/impeccable

Derived, modified:

- `lib/design-catalog.ts`: rule ids and names from `crates/live/assets/antipatterns.json`; the prose is gstack's.
- `scripts/resolvers/design.ts`: the Persuade / Operate / Read / Experience visitor modes, the craft-floor reflexes (browser surfaces, one authored motion moment, depth has an offset, tinted secondary text, space above headings, light-or-dark from the use scene), and the three-looks calibration, from `SKILL.md`, `reference/craft-floor.md`, and `reference/new-work.md`, rewritten.
- `design-consultation/sections/proposal-and-preview.md.tmpl`: the font-selection procedure and the calibration paragraph, rewritten; and the `SKILL.md` / `sections/*.md` files generated from these sources.

Unmodified copy:

- `test/fixtures/impeccable-antipatterns.json`: `crates/live/assets/antipatterns.json` at commit 87d8f6d6 (engine-v0.1.3), wrapped in a `_source` provenance object.

Not distributed: `bin/gstack-design-detect.ts` invokes an impeccable engine the
user installed. gstack does not ship or mirror that engine and never runs impeccable's
installer or launcher. The one download gstack can make is the engine binary
itself, only after the user accepts a design skill's one-time offer: fetched from
impeccable's own GitHub release into `~/.impeccable/bin/<version>/`, verified
against the checksum pinned in `lib/design-detect-contract.ts`, and recorded in
the egress ledger first. gstack does not audit the engine's network behavior; the
wrapper refuses URL targets so gstack never asks it to touch the network.

## ai-design-skills and redesign-skill — Copyright (c) 2026 Elaya — MIT License

https://github.com/elayadesign/ai-design-skills (`skills/landing-page-design`,
`skills/design-to-motion`, at 38bbe576) and
https://github.com/elayadesign/redesign-skill (`skills/redesign-existing-projects`,
at 64627f6e). License text: `licenses/MIT-elaya.txt`.

Derived, modified (rules rewritten in gstack's voice and reconciled with its
design rules; Elaya's fixed fonts, colors, spacing values, icon sets and
signature components are not carried over):

- `design-html/sections/craft.md.tmpl`: the Persuade intake, page archetypes,
  page structure, conversion and copy rules, indexing and build order from
  landing-page-design Part A; the content-realism, ship-floor, scale-snapping,
  line-break and motion rules from landing-page-design Part B, the website
  context of design-to-motion and the redesign-skill audit; and the generated
  `design-html/SKILL.md` / `sections/craft.md`.
- `lib/design-lint/rules/copy.ts`: the content-realism and ship-floor tells,
  the design lint's copy tier.
- `design-shotgun/SKILL.md.tmpl`: page archetypes as a variant axis.
- `design-review/sections/craft-audit.md.tmpl` (and the generated
  `sections/craft-audit.md`): the redesign-skill audit of an existing site,
  its fix-priority order and Tailwind version check; `scripts/resolvers/design-craft.ts`:
  the Persuade conversion checks, also rendered into
  `plan-design-review/sections/review-sections.md`; and the craft-tell entries
  in `lib/design-catalog.ts`.
- `design-motion/SKILL.md.tmpl` and `design-motion/sections/fidelity.md.tmpl`,
  `motion.md.tmpl` and `figma.md.tmpl` (and the generated `design-motion/SKILL.md`
  and `sections/*.md`): design-to-motion's fidelity rules, Figma layer-export
  table (now an optional source path), loading choreography, story loops,
  loop cycle, easing, checks and export formats, reconciled with gstack's one
  authored motion moment, content visible without script, and the slop
  catalog's motion tells.
- `lib/motion-capture.ts` and `bin/gstack-motion-capture.ts`: design-to-motion's
  deterministic capture (fake clock, whole-millisecond steps averaging 1000/60,
  the `__start`/`__tick`/`__lt` page contract, PRE frames).
- `lib/motion-encode.ts` and `bin/gstack-motion-encode`: design-to-motion's
  ffmpeg recipes for the MP4, loop GIF and 800x500 GIF, and its seam,
  empty-beat, rest and overflow checks as ffmpeg PSNR comparisons.

## hallmark — Copyright (c) 2026 Hallmark contributors — MIT License

https://github.com/Nutlope/hallmark (`skills/hallmark/scripts/sloplint.mjs`,
`sloplint-render.mjs`, `references/gates.md`, `scripts/fixtures/`, at 7ec8682).
License text: `licenses/MIT-hallmark.txt`.

Derived, modified (every gate rewritten in TypeScript and in gstack's voice,
mapped onto gstack's severity words; hallmark's theme stamp, genres, posture
guards, photo index and judged gates are not carried over):

- `lib/design-lint/` and `bin/gstack-design-lint`: the static tier's parsers
  (CSS rules and tokens, HTML and component pseudo-HTML, Tailwind class
  strings), the colour maths, the waiver record, and the rule families under
  `lib/design-lint/rules/`; the render tier in `lib/design-lint/render*.ts`,
  driving gstack's own browser instead of puppeteer.
- `test/fixtures/design-lint/{slopped.html,eyebrow-pass,eyebrow-fail,tailwind-pass,tailwind-fail,waiver}`:
  the fixtures, with their waiver comments rewritten to the lint's form.

## DESIGN.md specification — Copyright Google LLC — Apache License 2.0

https://github.com/google-labs-code/design.md

`lib/design-md.ts`, `bin/gstack-design-md.ts`, and the Phase 6 template in
`design-consultation/sections/proposal-and-preview.md.tmpl` implement the
format (YAML token front matter in five groups, eight canonical sections in
spec order, `{path}` token references). No specification text is reproduced.

## skill-diet — Copyright Nico Bailon — MIT License

https://github.com/nicobailon/skill-diet (at 5f41df1; license text: `licenses/MIT-skill-diet.txt`).
Adapted, not vendored: the levels table, the five-step edit ladder and the size-budget rule in
`write-skill/SKILL.md.tmpl`, and the full-diet procedure in `write-skill/references/diet.md`,
rewritten for gstack's templates, carved sections, bins and ratchet tests. The before/after/none
scoring rules in `docs/designs/SKILL_EVAL_CONTRACT.md` follow skill-diet's `scripts/eval.mjs`.

## tstack — Copyright Theo Browne — MIT License

https://github.com/t3dotgg/tstack (`skills/sol-loop`, at 7de017b3). Ideas, not text: the
three-word severity glossary (blocker, should, nit) and the two stop rules (a review that
grew the diff cuts first; the end of the budget is not approval) in
`ship/sections/review-army.md.tmpl`, `review/checklist.md` and `docs/review-policy.md`
are written in gstack's words and mapped onto gstack's blocking floor. No sentence is copied,
so no license text is carried; this entry is a courtesy.
Also ideas, not text (`skills/modernize`, `skills/leaving-pr-comments`, `skills/full-send`,
`agents/openai.yaml`, at 7de017b3): the MODERNIZE / REWORK / CLOSE verdict names in
`modernize/SKILL.md.tmpl`, the `> [!NOTE]` author callout behind `gstack-post --attribute`, the
three-bullet unattended grant in `docs/unattended.md`, and a per-skill Codex `default_prompt`;
all written fresh in gstack's words.

Design port (`skills/babysit-pr/scripts/pr-wait`, at 7de017b3; license text:
`licenses/MIT-tstack.txt`): `bin/gstack-pr-wait`, `lib/pr-wait.ts` and
`lib/pr-wait-github.ts` follow pr-wait's design (one stdout line per real event,
`--until green|ready|any-change`, exit 0/1/2, required checks from rulesets and
classic protection, two identical polls before green, the base-moved-and-touches-
this-PR event, BEHIND and DIRTY, a per-PR lock, a 6-hour baseline), rewritten in
TypeScript on gstack's bun shebang, state root, result codes and config keys;
no Python line is carried. Each file names the source in its header.

## pstack — Copyright Lauren Tan — MIT License

https://github.com/cursor/plugins (`pstack/skills/interrogate`, `lead-judgment.md`). Ideas,
not text: the lead-judgment filters applied before a merged review finding counts (nit
gravity, hypothetical versus actual, structure for a case that does not exist, a different
design is not a defect, missing context; independent agreement as the strongest signal;
`NO FINDINGS` as a correct result) in `scripts/resolvers/review-army.ts` stage 4 and
`docs/review-policy.md` are written in gstack's words. No sentence is copied, so no license
text is carried; this entry is a courtesy.
Also ideas, not text, from `pstack/skills/blast-radius`, `recall`, `benchmark-checklist`,
`architect` (`references/design-red-flags.md`) and `principle-attack-the-premise`
(Garry, 2026-10-26: "Do it, send"): the one safety fact and the five-rung evidence ladder in
/ship's Blast radius PR section (`ship/sections/pr-body.md.tmpl`); the transcript-mining fallback and its status-tagged brief in
`context-restore/sections/transcripts.md.tmpl`; the seven questions in
`benchmark/sections/vet-the-number.md.tmpl`; the second-shape comparison and the eight
design red flags in Section 1 of `plan-eng-review/sections/review-sections.md.tmpl`; and the generated
`SKILL.md` / `sections/*.md` files. Each section names its source in a first-line comment.
Written in gstack's words; no sentence is copied, so no license text is carried.

Also ideas, not text, from `pstack/skills/principle-*`, `poteto-mode` and its eval playbook: ETHOS.md principles 5 to 8, the observable-questions rule in `plan-tune/SKILL.md.tmpl` and `docs/proactive.md`, the blinding rules in `eval-plan/SKILL.md.tmpl` and `docs/TESTING_INTERNALS.md`, and the limiter sentence in AGENTS.md step 4 (GSTA-124).

## pstack, ported scripts — Copyright (c) 2026 Lauren Tan — MIT License

https://github.com/cursor/plugins (`pstack/` at 99b609a7). License text:
`licenses/MIT-pstack.txt`. Unlike the ideas entry above, these two are code
ports, so the license text is carried and each file's header names its source.

Derived, modified:

- `bin/gstack-decision-trail`: `pstack/skills/show-me-your-work/scripts/log.sh`
  in TypeScript: the header-once append, the one-line cells and the
  spreadsheet formula guard (a leading quote on cells starting with `=`, `+`,
  `-` or `@`). The `start` subcommand and the `--run` admission check are
  gstack's.
- `bin/gstack-worktree-audit`: `pstack/skills/poteto-mode/scripts/worktree-audit.sh`,
  with the PR column read through `gh --jq` alone, the chat column read from
  Claude Code's per-worktree transcript directory, and a `--no-fetch` flag.

## pstack (unslop) — Copyright Lauren Tan — MIT License

https://github.com/cursor/plugins (`pstack/skills/unslop/SKILL.md`, at 99b609a7). The
word lists in `lib/prose-lint.ts` (the autopilot vocabulary and the metaphor nouns with
their plain replacements) are facts taken from unslop's rules 7 and 26; the rules a
regular expression decides (the "not just X, but Y" shape, the mid-sentence colon, the
bold label that restates its line, arrows and dropped articles) are written in gstack's
words, scoped to the CHANGELOG entry and PR body /ship writes, and report-only elsewhere.
No sentence is copied, so no license text is carried; this entry is a courtesy.
