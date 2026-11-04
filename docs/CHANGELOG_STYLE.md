# CHANGELOG + VERSION style

Moved verbatim from CLAUDE.md (token-load reduction). Read this BEFORE
writing a CHANGELOG entry. In gstack the entry is a fragment,
`changelog.d/<branch-slug>.md`, and the merge step gives it its `## [X.Y.Z.W]`
heading ([changelog fragments](ship-policy.md#changelog-fragments)).

## Versioning and branch-scoped entries

Moved verbatim from CLAUDE.md (#2096 size limit). The autonomous version
policy (choose versions without asking; default to PATCH) stays in CLAUDE.md
as the single source.

**Versioning invariant.** VERSION is a monotonic ordered release identifier,
not a strict semver commitment. The bump level (major/minor/patch/micro)
expresses intent. Versions are assigned at merge, in merge order (under
`merge: direct`, at release: one release PR folds every landed fragment under
one new version, [ship-policy.md](ship-policy.md#release-stamp)): each stamp
takes the version before it plus the effective bump, which is the policy's
PATCH raised by any folded fragment's `bump:` front matter. If PR A and PR B
both ask for MINOR and land back to back on v1.6.0.0, A lands at v1.7.0.0 and
B at v1.8.0.0 (still a MINOR relative to the version before it). Downstream
consumers must NOT rely on "MINOR = feature-only, PATCH = fix-only" as a
strict contract.

**package.json carries the npm-valid translation, not VERSION verbatim.**
VERSION stays the 4-digit source of truth (e.g. `1.67.0.0`); package.json and
any subdirectory manifests with a `version` field get the 3-digit npm-valid
translation (`1.67.0`), and lockfile `version` fields sync only when the
lockfile already exists. `bin/gstack-version-bump` (via `lib/version-source.ts`)
owns the translation and judges drift on translated forms — do NOT "fix" the
apparent mismatch by hand, and do not write a 4-digit version into
package.json (npm rejects it). A branch never writes either one: the merge
stamp does, through `bin/gstack-version-bump`. Rationale and translation rules live in the
`lib/version-source.ts` header; `test/gstack-version-bump.test.ts` pins the
contract.

**The CHANGELOG entry is branch-scoped; the version is not.** Every feature
branch that ships writes one entry as `changelog.d/<branch-slug>.md`: the entry
text only, with no `## [x]` heading, and `bump: minor` or `bump: major` front
matter only when the change warrants more than a PATCH. A branch never edits
VERSION, package.json's version or a released CHANGELOG.md section. At merge,
`train land` (or `gstack-ship-queue land`) assigns the version (under
`merge: direct`, the release PR from `gstack-release-stamp open` does), folds the
fragment into one `## [<version>] - <date>` section at the top of CHANGELOG.md
and deletes the file. The entry describes what THIS branch adds — not what was
already on main.

**The CHANGELOG entry is the diff between main and the shipping branch — what users
get when they upgrade. NOT how the branch got there.** A reader landing on the entry
should learn what they can do now that they couldn't before; they should not learn
about versions the branch carried during development, the bugs we caught and fixed mid-branch,
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
- `/ship` lints the fragment with `bin/gstack-prose-lint changelog.d/<branch-slug>.md --gate`.
  Rewrite each `PROSE:` line it names ([docs/troubleshooting.md](troubleshooting.md#prose-lint-found)).
- Never fold new work into a CHANGELOG.md section that already landed on main.
  New work goes in this branch's fragment, and the merge stamp gives it its own
  section at the next version.

**Key questions before writing:**
1. What branch am I on? What did THIS branch change?
2. Does this change warrant more than a PATCH? (If yes, open the fragment with
   `bump: minor` or `bump: major` front matter; otherwise add none.)
3. Does this branch's fragment already cover earlier work? (If yes, rewrite it as
   one unified entry.)

**Merging main never gives your branch a version.** When you merge origin/main into
a feature branch, main may bring new CHANGELOG sections and a higher VERSION. Take them
exactly as main has them. Your branch still carries only its fragment, and never jams its
changes into a section that already landed on main; the merge stamp puts its section on top.

**After merging main, always check:**
- Is your fragment still in `changelog.d/`, with its own text, separate from main's sections?
- Are VERSION, package.json's version and every released CHANGELOG.md section exactly
  main's? (The Version Gate check requires this of a head the merge step did not stamp.)
If any answer is no, fix it before continuing.

**After any CHANGELOG edit that moves, adds, or removes entries,** immediately run
`grep "^## \[" CHANGELOG.md` to verify no duplicates and a sensible reverse-chronological
order. Gaps between version numbers are fine. A branch that ships at v1.6.4.0 without
a prior v1.5.2.0 or v1.5.3.0 entry on main is correct — those were branch-internal
version numbers that never landed. Do not back-fill gaps with placeholder entries.

**Keep one entry per branch.** When the branch's work grows after its fragment was
written, rewrite that fragment as one unified entry instead of adding a second file
beside it. Readers see one release, not a branch diary.

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

If the diff between the base branch and this branch has no user-facing change
(only merges, only CHANGELOG edits, only placeholder work), the honest fragment is one
sentence: "No user-facing changes yet." Stop
there. Do not pad. Do not explain the plan that will ship eventually. Do not narrate
the branch's history. When real work lands, the entry will replace this at /ship time.

### Raising the supported minimum (`capy/support.env`)

Release stamping can also raise `GSTACK_MIN_REVISION` in `capy/support.env`.
Every Capy machine below it is fast-forwarded at its next session start, so
raise it only for install-honesty or security fixes, and set it at stamp time
to the VERSION being released. It never exceeds VERSION
(test/capy-skill-wrapper.test.ts pins this). Details:
[capy-install.md](capy-install.md#raising-the-supported-minimum).

## Entry format

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
