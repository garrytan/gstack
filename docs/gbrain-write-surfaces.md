# gbrain write surfaces — what lands where, and how to verify

This doc serves two audiences:

1. **Agents**: when a planning skill renders the compact `## Brain Context
   Load` or `## Save Results to Brain` blocks, those blocks reference this
   doc. Read §Context Load or §Save Template here on-demand when you're
   actually using gbrain. Skip entirely if `gbrain` is not on PATH.
2. **Humans**: after running a planning skill against a real brain, use
   the manual-probe sections to confirm the page actually landed.

## What lands where

| Host + detection state | What renders in the planning-skill SKILL.md |
|---|---|
| Any host + `gstack-config gbrain-refresh` reports `gbrain_local_status: "ok"` | Compressed brain-aware blocks render. Agent reads this doc on-demand when it actually saves. ~250 token overhead per planning skill. |
| Any host + gbrain not detected | Blocks suppressed at gen-time. Zero token overhead. Calibration takes still render (separate resolver, host-agnostic). |
| GBrain or Hermes host | Blocks always render regardless of detection — these hosts ship gbrain integration as a first-class concern. |

`.gbrain-source` selects the source for **reads and writes** made from that
directory, including `gbrain put`. It does not select a storage engine: the
engine is configured separately in `~/.gbrain/config.json`. GBrain resolves
an explicit `--source` first, then `GBRAIN_SOURCE`, then the nearest trusted
`.gbrain-source`, followed by registered path and default-source rules. If a
page lands in an unexpected source, check the effective source selection
before treating a successful `put` as proof it reached the intended corpus.

Trust policy (`personal` vs `shared`, per endpoint hash) gates auto-push
and writeback. Set via `gstack-config set
brain_trust_policy@<endpoint-hash> personal`. Local PGLite installs
auto-default to `personal`; remote-MCP installs prompt during
`/setup-gbrain` step 9.5.

## §Context Load (agent reads this when running a planning skill)

Before starting, search the brain for relevant context:

1. **Extract 2-4 keywords** from the user's request. Pick nouns, error
   names, file paths, technical terms — NOT verbs or adjectives.
   Example: for "the login page is broken after deploy", search for
   `login broken deploy`.
2. **Search**: `gbrain search "<keyword1 keyword2>"`. Returns lines like
   `[slug] Title (score: 0.85) - first line of content...`.
3. **If few results** (under 3): broaden to the single most specific
   keyword and search again. If still few, proceed without brain context.
4. **Read top 3 results**: `gbrain get "<slug>"` for each. Stop
   after 3 — diminishing returns past that.
5. **Use the context** to inform your analysis. Cite specific slugs in
   your output when a brain page changed your thinking.

If `gbrain search` returns any non-zero exit (gbrain not on PATH, network
flake, throttle), treat as transient: proceed without brain context. Do
not retry inline — the user can re-run the skill later.

## §Save Template (agent reads this when actually saving)

After completing the skill, save the output. The compact resolver block
already shows the slug prefix + title + tag for your specific skill (e.g.
`gbrain put "ceo-plans/<feature-slug>" ...`). The page is free text, so it
never goes into a shell command, heredoc or quoted argument: create a private
file at the repo root, write the page into it with your file-write tool, and
let `gbrain put` read it on stdin.

```bash
mkdir -p .gstack/tmp && mktemp .gstack/tmp/page.XXXXXX
```

Write into the printed file, exactly as the page should read:

```markdown
---
title: "<Title>: <feature name>"
tags: [<tag>, <feature-slug>]
---
<skill output in markdown — the actual deliverable, not a summary>
```

Then save it, substituting the printed path for `<page-file>`:

```bash
gbrain put "<slug-prefix>/<feature-slug>" < "<page-file>" && rm -f "<page-file>"
```

If the file write fails or is refused, do not save: report the cause and keep
the output for the user.

Read the page back from the **same working directory and account** before
reporting it as saved:

```bash
gbrain get "<slug-prefix>/<feature-slug>"
```

Confirm that the returned page contains the intended title and substantive
output. If the read fails or returns another page, report the save as
unverified and retain the output for retry; do not claim a durable result.
The same rule applies to entity stubs.

**Slug guidance**: `<feature-slug>` should be kebab-case, lowercase, and
unique within the prefix. Prefer concrete project/feature names over
abstract labels. Example: `auth-rate-limit` not `security-fix`.

**Title guidance**: the constant prefix (e.g. "CEO Plan", "Eng Review")
is fixed; the suffix is the human-readable name of the feature/topic.

**Tag guidance**: the first tag is the constant `<tag>` from the skill's
metadata (e.g. `ceo-plan`, `eng-review`). The second tag is the
`<feature-slug>` so cross-page traversal works. Add more tags if obvious
relationships exist (e.g. `[ceo-plan, auth-rate-limit, security]`).

### Entity-stub enrichment

After saving the main page, extract person and organization names
mentioned in the output. For each one:

```bash
# Check if a page exists first
gbrain search "<entity name>"

# If no match, create a stub from a private file you write with your
# file-write tool (same pattern as the page above)
mktemp .gstack/tmp/entity.XXXXXX
gbrain put "entities/<entity-slug>" < "<entity-file>" && rm -f "<entity-file>"
```

The stub file holds:

```markdown
---
title: "<Person or Company Name>"
tags: [entity, person]
---
Stub page. Mentioned in <skill name> output. Replace with real bio when relevant.
```

**Only extract real names** — actual person names (e.g. "Garry Tan") and
company/organization names (e.g. "Y Combinator"). Skip product names,
feature names, section headings, technical terms (CSS class names,
function names), and file paths. When in doubt, skip.

`tags: [entity, person]` for people, `tags: [entity, organization]` for
companies/teams.

### Error handling

- **Throttle**: exit code 1 with stderr containing `throttle`, `rate
  limit`, `capacity`, or `busy`. Defer the save and move on — the brain
  is busy; the content isn't lost, just not persisted this run.
- **Any other non-zero exit**: treat as transient failure. Do not retry
  inline — the user can re-run the skill or run
  `gstack-config gbrain-refresh` if they suspect gbrain itself is
  misconfigured.
- **`gbrain: command not found`**: gbrain isn't on PATH. The compact
  resolver block told you to skip — you shouldn't reach this code. If
  you somehow did, silently skip and continue.

### Backlinks

If your save output mentions another brain page by name or topic, add a
backlink line at the bottom of the markdown body:

```
Related: [[other-page-slug]], [[another-slug]]
```

gbrain auto-resolves `[[slug]]` syntax into a clickable link in the
rendered page. Add backlinks only when the relationship is concrete
(e.g. "this CEO plan depends on the eng review at
`eng-reviews/auth-rate-limit`"). Don't fabricate connections.

### Completion summary

In your final skill output, note brain utilization in one line:
"Brain: read 3 pages, saved and read back 1 page, enriched 2 entity stubs,
0 throttles." Count a page as saved only after its readback succeeds.
This helps the user see brain coverage growing over time.

## Persistence verification (automated)

The matched-pair "is the data we hope to save actually being saved?"
question is covered by `test/skill-e2e-gbrain-roundtrip-local.test.ts`:
real `gbrain init --pglite` + `gbrain put` + `gbrain get` round-trip
against an isolated temp HOME. Periodic-tier. Skips when
`VOYAGE_API_KEY` is unset or gbrain CLI is missing from PATH.

Run it before opening a PR that touches the resolver:

```bash
EVALS=1 EVALS_TIER=periodic VOYAGE_API_KEY=$VOYAGE_API_KEY \
  bun test test/skill-e2e-gbrain-roundtrip-local.test.ts
```

If you do want to spot-check by hand against your own brain after a
real planning-skill run (debugging a specific page that the agent
should have saved):

```bash
gbrain get "<prefix>/<slug>"           # expect markdown + frontmatter
gbrain search "<slug fragment>"        # expect slug in top results
gbrain sources list                    # confirm gstack-brain-<user> source
gbrain get "entities/<person>"         # expect stub per named person
```

## Remote / Supabase / thin-client-MCP routing

The resolver emits a single CLI shape — `gbrain put "<slug>" < "<page-file>"`,
the page on stdin — that works against every engine gbrain supports. The CLI
internally routes to local PGLite, remote Supabase, or a remote MCP
endpoint depending on the user's `~/.gbrain/config.json`. **gstack
doesn't test that routing**: the storage layer is gbrain's contract to
honor, and the same CLI invocation we test against local PGLite is the
one that fires against any other engine.

If you're on Supabase or thin-client MCP and writes aren't landing:

1. `gbrain doctor --fast --json` — engine health check. If anything
   reports `error`, fix that first.
2. `gstack-config get brain_trust_policy@<endpoint-hash>` must be
   `personal` for auto-write. Run `gstack-config endpoint-hash` to get
   the active hash. If `shared`, the agent prompts before writes — if
   you declined, re-run the skill.
3. If trust policy is `personal` and `gbrain doctor` is clean but the
   page still isn't there, file an issue against gbrain — gstack's
   CLI call shape is the same as what T11 (`gbrain-roundtrip-local`)
   exercises.

## What's NOT verified by automation

- **Calibration takes (`takes_add`)**: today these fall back to
  fence-block writes inside a `gbrain put` because
  `BRAIN_CALIBRATION_WRITEBACK` is FALSE pending gbrain v0.42+ shipping
  the `takes_add` MCP op. When the flag flips, re-run the probe in this
  doc against `/office-hours` and confirm `gbrain takes_list` surfaces a
  `kind=bet` entry with the expected weight (0.9 for office-hours, per
  `scripts/brain-cache-spec.ts:151-157`).
- **Per-skill E2E for the other 4 planning skills**: only `/office-hours`
  has fake-CLI E2E coverage (`test/skill-e2e-office-hours-brain-writeback.test.ts`).
  The resolver unit test (`test/resolvers-gbrain-save-results.test.ts`)
  covers wiring for all 5. Per-skill E2E expansion is tracked in TODOS.md.
- **`.gbrain-source` write semantics**: gstack treats the documented
  reads-only contract as load-bearing, but doesn't independently verify
  that gbrain CLI never re-routes writes based on the pin. If you find a
  case where it does, that's a gbrain bug to file upstream.
