---
paths:
  - "CHANGELOG.md"
  - "VERSION"
  - "bin/gstack-next-version"
---

# CHANGELOG + VERSION style

**Versioning invariant (workspace-aware ship).** VERSION is a monotonic ordered
release identifier, not a strict semver commitment. The bump level
(major/minor/patch/micro) expresses intent at ship time. Queue-advancing past a
claimed version within the same bump level is explicitly permitted — if branch A
claims v1.7.0.0 as a MINOR and branch B is also a MINOR, B lands at v1.8.0.0
(still a MINOR relative to main). Downstream consumers must NOT rely on
"MINOR = feature-only, PATCH = fix-only" as a strict contract. This is why
`bin/gstack-next-version` advances within the chosen bump level rather than
repicking the level when collisions happen.

**Scale-aware bumps — use common sense.** When the diff is big, bump MINOR (or
MAJOR), not PATCH. PATCH is for bug fixes and small additions; MINOR is for
substantial new capability or substantial reduction; MAJOR is for breaking
changes. Rough guideposts (don't treat as rules, treat as smell-checks):

- **PATCH (X.Y.Z+1.0)**: bug fix, doc tweak, small additive change, single
  test/file added. Net diff under ~500 lines, no new user-facing capability.
- **MINOR (X.Y+1.0.0)**: new capability shipped (skill, harness, command, big
  refactor), substantial code reduction (compression, migration), or coordinated
  multi-file change. Net diff over ~2000 lines added/removed, OR a user-visible
  feature you'd put in a tweet.
- **MAJOR (X+1.0.0.0)**: breaking change to public surface (CLI flag rename,
  skill removed, config format changed), OR a release big enough to be the
  headline of a blog post.

If you find yourself debating "is 10K added + 24K removed really a PATCH?" — it
isn't. Bump MINOR. Same for "this adds a whole new test harness with 6 new E2E
tests + helper utilities" — MINOR. The bump level is communication to the user
about what kind of release this is; don't undersell it.

When merging origin/main brings a higher VERSION, re-evaluate the bump level
against the SCALE of your branch's work, not just whether main moved forward.
If main bumped MINOR and your branch is also a substantial change, you bump
MINOR again on top (e.g., main at v1.14.0.0, your branch lands v1.15.0.0).

**VERSION and CHANGELOG are branch-scoped.** Every feature branch that ships gets its
own version bump and CHANGELOG entry. The entry describes what THIS branch adds —
not what was already on main.

**The CHANGELOG entry is the diff between main and the shipping branch — what users
get when they upgrade. NOT how the branch got there.** A reader landing on the entry
should learn what they can do now that they couldn't before; they should not learn
about the branch's internal version bumps, the bugs we caught and fixed mid-branch,
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
- Never fold new work into an existing CHANGELOG entry from a prior version that
  already landed on main. If main has v0.10.0.0 and your branch adds features,
  bump to v0.10.1.0 with a new entry — don't edit the v0.10.0.0 entry.

**Key questions before writing:**
1. What branch am I on? What did THIS branch change?
2. Is the base branch version already released? (If yes, bump and create new entry.)
3. Does an existing entry on this branch already cover earlier work? (If yes, replace
   it with one unified entry for the final version.)

**Merging main does NOT mean adopting main's version.** When you merge origin/main into
a feature branch, main may bring new CHANGELOG entries and a higher VERSION. Your branch
still needs its OWN version bump on top. If main is at v0.13.8.0 and your branch adds
features, bump to v0.13.9.0 with a new entry. Never jam your changes into an entry that
already landed on main. Your entry goes on top because your branch lands next.

**After merging main, always check:**
- Does CHANGELOG have your branch's own entry separate from main's entries?
- Is VERSION higher than main's VERSION?
- Is your entry the topmost entry in CHANGELOG (above main's latest)?
If any answer is no, fix it before continuing.

**After any CHANGELOG edit that moves, adds, or removes entries,** immediately run
`grep "^## \[" CHANGELOG.md` to verify no duplicates and a sensible reverse-chronological
order. Gaps between version numbers are fine. A branch that ships at v1.6.4.0 without
a prior v1.5.2.0 or v1.5.3.0 entry on main is correct — those were branch-internal
version numbers that never landed. Do not back-fill gaps with placeholder entries.

**Never orphan branch-internal versions.** If your branch bumped VERSION several times
during development (v1.5.1.0 → v1.5.2.0 → v1.6.4.0, say) and those earlier entries were
never released to main, the final ship consolidates ALL of them into a single entry at
the final version (v1.6.4.0). Collapse them — delete the old entries and move their
content into the final entry, re-version table columns accordingly. Readers see one
release, not a branch diary. Gaps are fine (v1.6.3.0 → v1.6.4.0 with no v1.5.x
in between on main is correct).

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

If the diff between the base branch version and this version has no user-facing change
(only merges, only CHANGELOG edits, only placeholder work), the honest entry is one
sentence: "Version bump for branch-ahead discipline. No user-facing changes yet." Stop
there. Do not pad. Do not explain the plan that will ship eventually. Do not narrate
the branch's history. When real work lands, the entry will replace this at /ship time.

## Release-summary format (every `## [X.Y.Z]` entry)

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

## Itemized changes (below the release summary)

Write `### Itemized changes` and continue with the detailed subsections (Added,
Changed, Fixed, For contributors). Same rules as the user-facing voice guidance
above, plus:

- **Always credit community contributions.** When an entry includes work from a
  community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.
