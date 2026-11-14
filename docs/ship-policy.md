# The repo ship policy: `.gstack/ship-policy.json`

`/ship` reads one machine-readable file per repository that says how releases
are stamped and merged: the bump level, the queue mode, the repo's own release
tool, the paths where version mentions are rewritten, the CHANGELOG, a paired
mirror, the history policy and the preregistered evals. Without the file
nothing changes: every key has a default that reproduces today's behavior.

The file is **read from the committed copy on the base branch**
(`origin/<base>`), never from the PR's working tree, so a PR cannot smuggle a
command into its own gate. **File presence never authorizes execution:**
`gstack-restamp` runs `release_tool` only under `/ship` or with
`--allow-repo-commands`; standalone it lists the commands and exits 3 with
`repo commands not executed (pass --allow-repo-commands)`. A PR that
introduces or changes the policy runs under the reviewed bootstrap path
(`--policy-from head --allow-repo-commands`) and its receipt says
`policy: head (unreviewed)`.

Tools: `gstack-ship-policy init|validate|show-effective|check-history`,
`gstack-restamp`, `gstack-tree-receipt`, `gstack-ship-receipt`,
`gstack-ship-queue` ([shared merge queue](#run-a-shared-merge-queue), [merge trains](#run-a-merge-train)),
`gstack-evidence bundle|ancestor`. They share the exit table (`0` ok, `1`
fail, `2` usage, `3` refused or needs a flag) and end every error line with a
code from [troubleshooting.md](troubleshooting.md#queue-aware-ship-policy-restamp-tree-receipt-ship-receipt).

<a id="schema-v1"></a>
## Schema v1

`gstack-ship-policy init` writes every key at its default; `init --explain`
prints this table. JSON carries no comments, so examples live in
`.gstack/ship-policy.example.json`. Unknown top-level keys are errors: a key
from a newer gstack, or a misspelled one, fails closed (`POLICY_INVALID`)
instead of being ignored. The one extension point is a key inside `land` or
`docs_only`: this gstack and later ones ignore it with a `WARN` line
(`validate --json` lists it under `warnings`), so a later release can add a
nested key without breaking readers that carry this rule. A nested key that
must be enforced still names its own introducing version, as
`land.docs_only_skip` does, so `validate` asks for `min_gstack_version`. Every key has an
introducing version (`init --explain` and `validate` print it). A key newer
than 1.91.98.0 set to a non-default value requires `min_gstack_version` at
least at its introducing version, and a gstack older than `min_gstack_version`
refuses the file (`POLICY_GSTACK_TOO_OLD`). `validate` ends with
`MIN_READER: gstack <version>`, the floor every lane reading the policy needs.
`validate` also refuses a `min_gstack_version` above the newest stable gstack
release (`POLICY_FLOOR_ABOVE_STABLE`, naming both versions): every
stable-channel lane would refuse that policy until a later release is cut. The
release is the highest `v<version>` tag at the commit gstack's origin `stable`
branch points to (a tag a half-way cut left above stable does not count), else
the VERSION at the local stable ref, else the highest local release tag
(`GSTACK_STABLE_REPO` names another gstack checkout); when none resolves it warns (`STABLE_RELEASE_UNKNOWN`) and says the
floor was not compared. The pregate `policy-floor` check does the same on a
branch that changes the policy.

| Key | Values | Default | Meaning |
|---|---|---|---|
| `bump` | `patch` \| `ask` \| `never` | `ask` | `patch` skips the MINOR/MAJOR prompt in `/ship` Step 12 and `gstack-restamp --next` bumps PATCH; `ask` keeps the prompt, and in a session no person answers any version Step 12 would write (`--bump` on a fresh branch, `--version <v>` on a bumped one) stops with `BUMP_ANSWER_REQUIRED` until `--answer "<the owner's words>"`; `never` is for a repo whose unit PRs never change VERSION: Step 12 keeps it with no question, refuses `--bump`, and `gstack-restamp --next` needs an explicit `--bump` or `--version` (the release process bumps). CI's Version Gate passes a head that keeps VERSION; a release PR that moves it takes the ordinary bump and collision rules. `never` needs `min_gstack_version` at its introducing release and cannot be combined with `queue_mode: stamp-at-merge`, `train` or `changelog_fragments`, which stamp a version at every merge. |
| `queue_mode` | `claim-at-open` \| `stamp-at-merge` | `claim-at-open` | See [stamp-at-merge](#stamp-at-merge). `claim-at-open` is today's queue (`gstack-next-version` claims a slot when the PR opens). |
| `release_tool` | command or `null` | `null` | The repo's own release command (`bun run release:restamp`). Runs in an isolated staging worktree under the [release-tool contract](#release-tool-contract). |
| `release_outputs` | globs | `[]` | Paths the release tool may write beyond the version files, lockfiles, CHANGELOG and `stamp_paths`. Anything else is `RESTAMP_OUTPUT_OUTSIDE_ALLOWED`. |
| `stamp_paths` | globs | `[]` | Where exact `(was X)`, `since: X` and `vX` mentions of the branch's tentative version (quoted or bare: `since: 'X'` counts) are rewritten on a restamp. |
| `changelog` | path or `null` | `CHANGELOG.md` | Re-headed on a restamp: the PR's `## [Unreleased]` (or old-version) section moves to the top as `## [<version>] - <date>`. |
| `mirror` | relative path or `null` | `null` | A paired checkout to restamp identically (tier 2: validated and confined today, not yet run). |
| `history` | `merge-only` \| `squash-ok` | `squash-ok` | `merge-only` makes `/ship` refuse a squash or rebase plan; `gstack-ship-policy check-history` reports a rewritten branch (`HISTORY_POLICY_VIOLATION`). |
| `preregistration_shas` | commit ids | `[]` | Each must be an ancestor of HEAD before push: `gstack-evidence ancestor --from-policy`; the ship receipt records the result. |
| `stamp_sensitive_gates` | evidence labels | `[]` | Gates that read VERSION or generated bytes (gstack's own `tests` lane does, through the agents-digest freshness test). The tree receipt never marks them reusable. |
| `pr_count` | `{ default_pr_count, split_requires_owner }` | `{1, true}` | The PR-count row in plan reviews. |
| `maintainers` | GitHub logins | `[]` | Maintainer set for `/review` contributor mode; empty means repository push permission. |
| `stamp_files` | globs | `[]` | The repo's stamp rule: when set, only these files may differ by a stamp (list the version file, manifests, plugin trees and the files holding the PR's own `since:` rows). It applies before every other stamp rule, so a doc `vX` mention outside it is a difference. |
| `stamp_patterns` | literal templates | `[]` | At most 16 templates of at most 128 characters, each with exactly one `{version}` slot (`"version": "{version}"`, `since: '{version}'`, `<!-- x-stamp: {version} -->`); matched literally at a version boundary, never as a regex. The restamp writer, its mention scanner and the tree receipt use them beside the built-in forms. |
| `stamp_placeholders` | literal placeholders | `[]` | At most 16 one-line literals of at most 32 characters, never `{version}` and never a version (`["TBD"]`). On a line the branch added itself, a placeholder inside a `stamp_patterns` template (`since: 'TBD'` under `since: '{version}'`) may become that template at the new version, and finish's route, the receipt carry and the tree receipt read the change as a stamp. The built-in forms never take a placeholder, and neither does a base line, even one whose text duplicates a branch line. The writer does not fill placeholders: the repo's `restamp_command` does. A newer key: set `min_gstack_version` to the release `gstack-ship-policy validate` names. Empty accepts no placeholder. |
| `restamp_command` | command or `null` | `null` | The repo's own restamp, run first in the staging worktree; see [restamp_command](#restamp-command). |
| `migrations` | `{ dir, id }` or `null` | `null` | The migration directory and a regex with exactly one capture group for the number in a file name (`"^v(\\d+)-"`); `gstack-pregate regate` reports `MIGRATION_COLLISION`. |
| `gate_command` | command or `null` | `null` | The repo's full pre-merge gate. `gstack-ship-queue gate-ahead` and `ready` print it for the caller to run (in the background or in CI); gstack never executes it. Needs `min_gstack_version`. |
| `full_e2e` | `true` \| `false` | `false` | `true`: every merge needs a passing full-gate result bound to a tree equal to the merging one modulo stamps; `gstack-ship-queue ready`, `stamp` and `verify` refuse without one (`QUEUE_GATE_MISSING`): a gate-ahead record, or the lane's `--gate-exit 0 --gate-log <file>` from its run on the gated head. Needs `min_gstack_version`. |
| `review_scope` | `frozen` \| `diff-plus-blocking` \| `all` | `frozen` | The finding scope of `/ship`'s review loop; see [review_scope](#review-scope). `frozen` fixes the diff on pass 1, lists blocking findings in unchanged code as deferred in the PR body (never as issues), and later passes read only the range since the previous pass. `diff-plus-blocking` is the same but fixes a blocking finding in unchanged code in this PR instead of deferring it. `all` is the earlier loop: every finding is fixed on every pass. Needs `min_gstack_version` when not `frozen`. |
| `review_exclude_paths` | git glob pathspecs | `[]` | Content files `/ship`'s reviewers leave out: data, docs, `.log`, and binaries under a content extension (images, fonts, archives and the like) that do not start with executable magic. Read from the base only. Code (native libraries and every other binary outside the content extensions included), gate paths, agent prose, config, executables, links, `.gstack/` and `.github/` files, gate-tagged, secret-line and named-by-code files stay in review. See [review_exclude_paths](#review-exclude-paths). Needs `min_gstack_version`. |
| `review` | `{ panel?, reader_model?, platform?, risk_paths? }` | `{ all, lane, off, [] }` | Who does `/ship`'s review, read from the base only; see [Who reads](review-policy.md#who-reads-r65-the-base-policys-review-key). `panel`: `all` (today's panel on every class) \| `risk` \| `off` (the opt-in one-reader shapes); `reader_model`: `lane`, `cross-family` or a model id; `platform`: `off` \| `on` (a docs or tests diff with no numeric, results or prereg claims whose PR carries capy-ai[bot]'s review at the exact head skips the readers); `risk_paths`: globs of code paths that count as risk class `policy`. Introduced at 1.94.30.0; needs `min_gstack_version` when set to a non-default value. |
| `readers` | `{ forbid_fetch?, forbid_paths?, brief_note? }` | `{ [], [], null }` | What `/ship`'s readers may not reach beyond the fetch rule every brief carries; see [readers](#readers). Read from the base; the head may add `forbid_fetch` entries, never remove one. Needs `min_gstack_version`. |
| `min_gstack_version` | version or `null` | `null` | The oldest gstack that may read the file; see the compatibility rule above. |
| `docs` | `{ caps: [{ path, max_bytes }] }` or `null` | `null` | Documentation files with a byte cap. `/ship` Step 14.5 runs `gstack-ship-receipt docs-caps --base <base>` (the caps come from `origin/<base>`'s policy, never the branch's copy; `--policy <file>` is for a repository bootstrapping its policy) before the verification gate and prints one `DOCS_CAP: <path> <bytes>/<max> ok\|over` line per cap; any `over` (an absent file counts) exits 1 and blocks the ship until the file is trimmed or the cap raised on the base branch (`DOCS_AUDIT_BLOCKED`). At most 64 caps, each path contained. See [the ship receipt](#ship-receipt). Needs `min_gstack_version`. |
| `train` | `{ gate_workflow, free_workflow, full_gate_check, record_artifact, max_size, fill_hours, screen_selection, trial_reservation_usd, land? }`, `{ gates, land, max_size, fill_hours }` or `null` | `null` | Turns on [merge trains](#run-a-merge-train), read from the base revision only. Every field is required and an unknown field is `POLICY_INVALID`: `max_size` 1 to 6, `fill_hours` above 0 and at most 24, `screen_selection` `gstack-paid` \| `none`, `trial_reservation_usd` above 0 and at most 100. A block with `gates` ([any repository](#train-gates)) takes `max_size` 1 to 5 and needs `min_gstack_version` at least `TRAIN_GATES_KEY_VERSION`. `null` keeps the per-PR queue exactly as it is. Needs `min_gstack_version`. |
| `merge` | `train` \| `direct` | `train` | `direct` lands each READY PR at its own green head with [`land --pr <n> --pin <sha>`](#land-direct): no train and no stamp commit, and `train build` refuses. A PR then leaves VERSION, the `package.json` version and the CHANGELOG at its merge base, and the release sets them. Needs `changelog_fragments`, and the stamping `land --pr <n>` refuses under it. `train` keeps merge trains. Read from the base revision only. Needs `min_gstack_version`. |
| `land` | `{ merged_checks, docs_only_skip? }` or `null` | `null` | Under `merge: direct`, the shell commands (1 to 16, one line of at most 512 characters each, 15 minutes each) [`land --pin`](#land-direct) runs on the pin merged onto the base tip when the base moved past the pin's merge base; it lands only when every one exits 0. They are repo commands, so land runs them only with `--allow-repo-commands`, never under `--dry-run`. `null` lands a stale base untested with a `STALE_BASE: warn` line. `docs_only_skip` lists `merged_checks` commands to skip for a docs-only pin ([pregate.md](pregate.md#docs-only)) and needs `min_gstack_version` at its own release (`LAND_DOCS_ONLY_SKIP_KEY_VERSION`), because older releases refuse it. Any other key under `land` is a warning, ignored. Read from the base revision only. Needs `min_gstack_version`. |
| `docs_only` | `{ allow, deny?, tests? }` or `null` | `null` | Human-docs paths beyond `README.md`, `docs/**.md` and `changelog.d/*.md` for the [docs-only class](pregate.md#repo-docs-paths) (`{ "allow": ["wiki/board/**.md"] }`). `allow` (1 to 16) takes narrow Markdown globs: each ends in `.md`, starts with a literal directory or file name, and passes through no hidden, code, test or agent directory; `**`, `*`, `*.md` and patterns naming agent files are `POLICY_INVALID` with an example of a narrow one. `deny` (up to 64 globs) removes paths, built-in ones included. `tests` (up to 16 test files) are the repository's checks for those directories: the docs lane runs them, and a non-prose file that reads an allowed directory refuses the class unless it is tied to one; a listed test missing from the branch refuses it too. The built-in deny list always wins. Any other key under `docs_only` is a warning, and the classifier then ignores `allow`. Read from the base revision only; a pull request that edits this file is never docs-only. Needs `min_gstack_version`. |
| `release_gate` | `{ cadence_hours, gate_workflow, branch, stable_ref, check_name, on_red, bisect_spend_cap_usd }` or `null` | `null` | One full paid gate on main every `cadence_hours` (8 to 168) instead of the per-push main backstop, feeding the stable release; see [release_gate](#release-gate). Every field is required: `on_red` is `hold-release`, `bisect_spend_cap_usd` 0 to 500 (0 skips the bisect). `null` keeps the per-push backstop. Needs `min_gstack_version`. |
| `bookkeeping` | glob list | `[]` | <a id="bookkeeping"></a>Root-anchored globs of bookkeeping tables a verify or ratchet step rewrites (size baselines, serial lists, limits), each ending in `.tsv`, `.csv` or `.txt` and never under `.gstack/` or `.github/` (`["scripts/*-baseline.tsv"]`). A matching file changed at most 20 lines after review binds, first touched or not, takes finish's [one scoped reader](review-policy.md#bounded-post-review-edits) instead of Steps 5–11.5; the reader still reads every changed row. Read from the base revision only. Needs `min_gstack_version`. |
| `mechanical_retake` | `[{ path, template, fields, regen }]` | `[]` | A version or rules constant a branch may have to retake after a base merge, next to `bookkeeping`'s bounded kind: `path` is one literal file, `template` the whole line with one `{n}` (`const RULE_NUMBERS := {n}`), `fields` the `{ glob, field }` fixture fields that carry the same value, and `regen` the [`.gstack/generated.json`](pregate.md#generated) entry ids whose command regenerates its goldens. A post-review edit finish proves to be only that retake routes as `mechanical=`, with no reader and no review round; see [mechanical retakes](#mechanical-retake). At most 8 constants and 16 fields or ids each; no glob, `..`, `.gstack/` or `.github/` path. Read from the base revision only. Needs `min_gstack_version`. |
| `test_code` | glob list | `[]` | Root-anchored globs of test code the built-in test names miss, never under `.gstack/` or `.github/`, and never matching a file there (`["tests/**/*.gd"]` for GDScript checks). A matching file changed after review routes as test code, one scoped reader of its test hunks, instead of behavior, beside the built-in globs; shared `helpers/` and `fixtures/` files stay behavior. See [test code and Godot UID sidecars](#test-code). Read from the base revision only. Needs `min_gstack_version`. |
| `plan_record` | `off` \| `warn` \| `require` | `off` | <a id="plan-record"></a>Whether `gstack-ship-queue ready` and `land` (direct, stamp and train land) and `/ship`'s `gstack-ship-release finish --plan "<line>"` check the PR body's `Plan:` line (GST-1751). The line is the brief's (`Plan: approved: <run id or row id>`, `Plan: exempt: <reason>` or `Plan: required`), written under `## Approvals` by `gstack-approvals render --plan`. `ready` resolves it with lib/plan-record.ts against every branch's approval rows on the lane machine: a run id needs the newest gate revision's plan approval answered `approved`, in the owner's words, with no decision of that revision left unanswered; a row id needs an approved row that is not a ruling or grant, and a row from an autoplan run stands for that run's gate the same way; a broken or unreadable store refuses (`PLAN_STORE_UNAVAILABLE`) and never throws, and under `off` changes nothing; an exemption must be one crew/docs/captain.md lists or `crew:<rule>`; a diff of changelog fragments only needs no line. `finish` resolves the brief's line the same way before its first stage. `ready` (train ready included) prints `PLAN:` and writes the resolved record into the READY note; `land` checks that the note carries the PR body's current line and never reads the store. `warn` prints and continues; `require` refuses (`PLAN_RECORD_MISSING`, `PLAN_UNRESOLVED`, `PLAN_NOT_APPROVED`, `PLAN_EXEMPT_UNKNOWN`, `PLAN_STORE_UNAVAILABLE`, `QUEUE_PLAN_MISMATCH`). When this key is `off` or absent, the mode comes from `GSTACK_PLAN_RECORD` (a crew's opt-in), then `plan_record` in `<state root>/config.yaml` (`gstack-config set plan_record off|warn|require`: the untracked source for a repo that commits no `.gstack/`; a typo is rejected, and the `PLAN:` line names the file), then `warn` in a Capy session (`GSTACK_CAPY=1`), then `off`; a machine's key never loosens a tracked `warn` or `require`. A repo with no tracked policy gets the check at `ready` and `finish` only: ready writes no READY note there and `land` refuses before its plan step. Capy's state root does not survive a fresh machine, so a Capy crew that wants more than `warn` sets `GSTACK_PLAN_RECORD` in its project env. On a public or unknown-visibility repository `render --plan` writes `Plan: approved (record r-<12 hex>)`, an opaque id of the approval row (opaque, not secret), so no run id, row id or path reaches the PR body or the READY note pushed to origin; `ready` resolves it by hashing every row id it reads and then applies the row-id rules, and render refuses with no output when an approved line does not resolve. gstack never infers a feature from the diff, title or changelog. Read from the base revision only. Needs `min_gstack_version`. |
| `ci_record_timeout_s` | integer seconds, at least 60 | `600` | <a id="ci-record-timeout"></a>How long `gstack-ship-release accept` lets one `gstack-evidence record-ci` run before it stops that lane. A value over 3600 is clamped to 3600. accept prints the bound it used as `CI_RECORD_TIMEOUT: <n>s (default)`, `(origin/<base> ci_record_timeout_s)` or `(… <value> is over the 3600s ceiling)`. Raise it when record-ci runs long, for example when it reruns a per_file remainder of CI-skipped files here (harness-evals #271 needed about 745 s). Read from the base revision only, so a branch can't raise its own bound. Needs `min_gstack_version`. |
| `base_red` | `{ setup, select, timeout_sec }` or `null` | `null` | How `/ship` Step 5 proves a failure is the base branch's own before pausing on it; see [base_red](#base-red). Read from the base revision only. Needs `min_gstack_version`. |
| `changelog_fragments` | `{ dir, required_checks? }` or `null` | `null` | PRs carry unversioned [CHANGELOG fragments](#changelog-fragments) in `dir` (one flat, repo-relative directory, no `..`) and the merge step ([`land`](#land)) assigns the version (under `merge: direct`, the [release PR](#release-stamp) does). `required_checks` (up to 50 distinct names) are the checks [`train land`](#stamped-trains-under-changelog_fragments-train-land) requires present and green on a stamp commit. `null` keeps `[Unreleased]` sections and per-PR stamps. Needs `min_gstack_version`. |

Containment, checked by `validate` and again at write time: paths and globs are
repo-relative with no `..` segment, under 256 characters, at most 64 per list,
and a glob's regex expansion under 512 characters; `release_tool` is under 512
characters with no newline; a matched file that resolves through a symlink to
outside the repository is refused (`POLICY_CONTAINMENT`). A mirror may start
with `..` (a sibling checkout) but has no interior `..`; mirror writes are
confined to that directory.

## gstack's own files

gstack's policy (`.gstack/ship-policy.json`, tracked beside `generated.json`
and `pregate.json` under the otherwise ignored `.gstack/`) runs the repo on
stamp-at-merge: the version is allocated once, when the PR is next in the queue,
every bump is PATCH, and `/review` reads the maintainer set from the file. It
names the one release tool `gstack-version-bump --regen-digest` used to
hard-code:

```json
{
  "bump": "patch",
  "queue_mode": "stamp-at-merge",
  "release_tool": "bun scripts/gen-agents-digest.ts",
  "release_outputs": ["agents-digest/gstack-AGENTS.md"],
  "stamp_paths": ["lib/ship-policy.ts"],
  "stamp_patterns": ["_KEY_VERSION = '{version}'"],
  "changelog": "CHANGELOG.md",
  "history": "squash-ok",
  "stamp_sensitive_gates": ["tests"],
  "changelog_fragments": { "dir": "changelog.d", "required_checks": ["free-tests", "windows-smoke", "Check VERSION is not stale vs queue", "quality", "check-freshness", "actionlint", "Plain title"] },
  "min_gstack_version": "1.91.340.0"
}
```

gstack itself runs on [changelog fragments](#changelog-fragments): a PR adds
`changelog.d/<branch-slug>.md` and never a version, and trains merge through
[`train land`](#stamped-trains-under-changelog_fragments-train-land) instead
of slot calls. `required_checks` names the pull_request checks that run on
every PR (branch protection enforces only `free-tests`); a workflow with a path
filter (Windows Setup E2E, make-pdf gate, Native ARM Setup Smoke, Dependency
Review) is left out, because a stamp commit of a PR outside its paths never
gets that check and `train land` would hold on it. `min_gstack_version` is
1.91.340.0, the first release that reads `required_checks` and counts a
stamped slot as merged only when GitHub reports it MERGED, so an older gstack
refuses the file by name (`POLICY_GSTACK_TOO_OLD`).

`.gstack/ship-policy.example.json` shows every key set the way a serial-merge
repo with a release script, docs mentions and a mirror would set them.

<a id="queue-side-procedure-for-gstack"></a>
### Queue-side procedure under `stamp-at-merge` without fragments

gstack itself no longer follows these steps. Since #3654 (v1.91.342.0) its
policy sets [`changelog_fragments`](#changelog-fragments), so a gstack PR adds
a fragment and never a version, and trains merge through
[`train land`](#train-land). The steps
below are for a repo on `stamp-at-merge` whose policy has no
`changelog_fragments`. Who does what there, for the PR author and for the
thread running the merge queue:

1. **Open.** The branch carries a tentative stamp of the base's version plus
   PATCH (`gstack-version-bump write --version <base+patch> --regen-digest`)
   and its CHANGELOG section headed with that version directly under
   `# Changelog`; `## [Unreleased]` is also accepted. Nothing is claimed and
   `gstack-next-version` is not consulted; the tentative version is only the
   guess that makes the common case free. CI runs on this head as usual.
2. **Register.** The queue records the PR and its intended order.
3. **Stamp when next.** With every check green on the current head and
   `origin/main` at the SHA the queue assumed, the PR owner (never the queue)
   runs on the branch:
   `gstack-restamp --next --base main --allow-repo-commands --pr <n> --expect-base <main-sha> --expect-order <pr,...>`.
   When the base has not moved past the tentative stamp it prints
   `RESTAMP: X -> X (noop)` and `FILES: (none)`, and the green head is the
   merge candidate with no further CI. When the base moved, it stamps base +
   PATCH, re-heads the CHANGELOG above the base's top entry, reruns the
   release tool, prints `STAMP_VERSION: <X>` and the stamp diff, and refuses
   with `QUEUE_STALE` (nothing written) when the base or order moved after
   `--expect-base` was read. The owner commits and pushes the stamp commit,
   lets CI run on it, and reports `READY #<n> <sha> STAMP_VERSION=<X>`.
4. **Merge.** The queue verifies on that exact SHA: `VERSION` equals
   `STAMP_VERSION`, the CHANGELOG's top heading is `[<X>]` and the heading
   below it is the base's current version, every check is green on that SHA,
   and, when a stamp commit was pushed, it changed only `VERSION`,
   `package.json`, `CHANGELOG.md` and the release outputs
   (`gstack-tree-receipt --gated <green-head> --current <sha>` prints the
   per-file verdict). It then squash-merges with the merge API's expected-head
   `sha` set to that SHA, so a late push is rejected by the server. "VERSION
   above main" is replaced by "VERSION equals the restamp's STAMP_VERSION on
   the SHA being merged, and that version is base + PATCH at merge time".
5. **Not next.** A PR waiting behind another may gate ahead locally with
   `gstack-restamp --after <predecessor-pr>`; it pushes nothing. When the
   predecessor lands, the waiting PR merges `origin/main` in (never a rebase),
   keeping its own CHANGELOG section above the newly merged one, and step 3
   runs.

Until this policy is on `origin/main`, `gstack-restamp --next` reads the base's
`bump: ask` and falls back to a MICRO bump; pass `--bump patch` on the first
PR stamped after the flip if its base predates it.

<a id="run-a-shared-merge-queue"></a>
## Run a shared merge queue

`gstack-ship-queue` strings `gstack-restamp`, `gstack-tree-receipt` and the
ship receipt into the coordinator protocol, so nobody proves a stamp diff by
hand. Lanes own their PRs and never merge; the coordinator owns the order and
every merge. Each step ends in a line the other side acts on, then
`GSTACK_RESULT: skill=ship-queue status=complete|refused run=<path>`. Nothing
here pushes, except `ready` under `changelog_fragments` (its READY receipt goes
to `refs/notes/gstack-trains`) and [`land`](#land).

**1. Lane: report ready (unstamped).** After the gate and pregate pass on the
pushed head:

```bash
gstack-pregate run --allow-repo-commands
git push
gstack-ship-queue ready --pr 42
```

```
READY #42 <head> STAMP_VERSION=unstamped
pr: https://github.com/<owner>/<repo>/pull/42
head: <head>
version: unstamped
base: origin/main@<sha>
ci: green at <head12> (passed=31 failed=0 pending=0 skipped=2)
PREGATE: pass tree=<tree12> head=<head12> checks=6
gate: command="<gate_command>" full_e2e=no gate-ahead=none
SHIP_RECEIPT: pr=42 head=<head12> …
READY_RECEIPT: <state root>/ship-queue/ready/<repo key>/42-<head>.json (notes pushed to origin refs/notes/gstack-trains)
```

Under `changelog_fragments`, a `READY_RECEIPT:` line follows, written only when
every check above passed; `land` refuses a pin without one. It says `notes
pushed` only once origin holds the note; otherwise `ready` refuses with
[`QUEUE_READY_NOTE_UNPUSHED`](troubleshooting.md#queue-ready-note-unpushed),
as it does under a train, because `land` reads the note on origin.

CI's Version Gate (`scripts/compare-pr-version.ts`) accepts that head as
unstamped when `VERSION` and `package.json`'s version match its merge base, the
CHANGELOG change is confined to `[Unreleased]`, and any changed release output
is byte for byte what `release_tool` generates at the head's merge base
`VERSION` (the head's own, so a later stamp on main changes nothing), so a
generator change ships with its regenerated output and the slot's restamp
regenerates it again. A release output that differs from that (a hand edit, one generated at a
bumped version, or one the tool never writes), a `VERSION` bump or a
`package.json` version change classifies the head as stamped, and it must then
carry base + bump. The tool runs as head code in a throwaway worktree with a
bare environment and no tokens; one that fails at the head is an error, never
a pass.

**A PR that conflicts with the base on CHANGELOG.md alone.** GitHub shows every
READY PR as conflicting each time main stamps; the train merges the CHANGELOG
by section, so the lane never merges main for it. The conflict does mean GitHub
has no merge ref for the PR, so no `pull_request` CI runs on the head and
`ready` prints `ci: none at <head12>` with a `ci-hint:` line. The lane then
runs `ready … --dispatch-ci free-tests.yml,windows-smoke.yml [--timeout
<s>]` (under a train policy): it dispatches each named workflow on the branch
(`gh workflow run <wf> --ref <branch>`, skipped when a run at this head already
concluded, and skipped with a note when the base has the workflow file but the
branch predates it, since GitHub reads the file from the branch), waits for the
runs (`CI_DISPATCH: <wf> --ref <branch> run <id> <url> <conclusion>`), clears
every requires-remote pregate lane whose workflow is one of them with the run
URL (`PREGATE_CLEARED: <lane> <url>`; a lane of another workflow stays
uncleared and is named in the refusal), and then reads the head as usual,
which passes because the dispatched check runs attach to the commit; the
`ci-hint:` line then says those non-pull_request runs count. A red run clears
no lane and refuses (`QUEUE_NOT_READY`); a run still going at `--timeout`
(default 2700 s) is `QUEUE_TRAIN_PENDING`, and rerunning the command keeps
waiting; a fork head is never dispatched here (`QUEUE_TRAIN_UNTRUSTED`). By hand the same four steps are `gh workflow
run <wf> --ref <branch>`, wait, `gstack-pregate clear --remote <lane> --run-url
<run>`, rerun `ready`. The `ci-hint:` line is advisory text for the lane;
nothing parses it. `ready --screen` on such a PR has no merge ref to screen,
so it builds the scratch merge described below (`SCREEN_MERGE:`, pushed as
`screen/<pr>-<head12>`) and screens that; only a real conflict with the base
(or a remote whose refs cannot be listed) is `QUEUE_SCREEN_STALE_REF`. A CHANGELOG-only conflict is screenable, and a
lane whose skill's own paid cases ran focused may still READY with `--no-screen`.

`ci:` reads every attempt of each check suite and judges a suite by its latest
attempt that has jobs (earlier attempts count only when the latest has none).
It keeps the newest run per check (one app's check name): a check that was
re-run or superseded on the same commit is judged by its newest run (latest `completed_at`, then id; a run still in
progress is newest); two apps reporting the same name stay separate; a run with
no name or no readable `completed_at` counts on its own; commit-status contexts
are counted one each. A workflow run that failed without starting any job
counts as a failed check `<workflow> (run <id>, no jobs)` unless a later run of
the same workflow replaced it; a run cancelled before any job is not counted.
An unreadable list is unknown, never green.

When a check counts as passing only because a newer run from another check
suite replaced a red one (a branch-only `free-tests.yml` dispatch beside the red
`pull_request` run, which tested the merge with the base), `ready` prints
`CI_SUPERSEDED: <check> red run <id> replaced by <id> (suite <a> → <b>)` under
the `ci:` line, one per replaced run, and `land` prints the same under its `CI:`
line. It is a warning and changes no verdict; a rerun in the same suite prints
nothing ([what to do](troubleshooting.md#ci-superseded)).

It refuses (`QUEUE_NOT_READY`) when the working tree has tracked edits, HEAD
is not the PR's pushed head, CI at that exact head is not green, or the pregate
result is not a current pass, and (`QUEUE_RECEIPT_MISSING`,
`QUEUE_RECEIPT_STALE`) when the PR body carries no /ship receipt for that
head: /ship runs before every READY ([details](#ship-before-ready)). It also
refuses `QUEUE_RECEIPT_DEPTH_RAISED` when the receipt's review depth is below
what the head needs, `QUEUE_RECEIPT_TARGETED_MISSING` when a targeted class
the head needs has no done targeted pass in the receipt, and
`QUEUE_RECEIPT_EXCEPTION_INVALID` when an owner exception the receipt records
does not stand ([the ship receipt](#ship-receipt)).
Send the block as printed.

**2. Lane behind another PR: gate ahead.** Gate the tree the queue will have
once the predecessor lands, while it is still open:

```bash
git fetch origin pull/41/head
gstack-ship-queue gate-ahead --after 41 --pr 42 --predecessor-ref FETCH_HEAD --allow-repo-commands
```

prints `GATE_AHEAD: pr=42 attempt=<id> gated=<sha> tree=<tree> merge_tree=<tree>
predecessor=#41@<sha12> version=<N+1>`, the attempt's own `worktree:`, its
`record:` file, `GATE_COMMAND:` (the policy's `gate_command`) and the exact
`next:` line. Run the gate there, in the background or in CI, then bind it:

```bash
(cd <worktree> && <gate command>) > gate.log 2>&1
gstack-ship-queue gate-ahead --record --pr 42 --attempt <id> --exit $? --log gate.log
```

`GATE_RECORD: pr=42 attempt=<id> exit=0 gated_tree=<tree> log_sha256=<sha256>
current=yes`. The record keeps the log and removes only that attempt's
worktree, and refuses (`GATE_AHEAD_ATTEMPT_INVALID`) when the worktree no
longer holds the gated commit. If the predecessor moves, prepare a new
attempt; attempts never share a worktree, the newest is current, and
recording an older one later prints `current=no (superseded by <id>)`.
`gate-ahead --list --pr 42` shows them all. Send the record file with READY.

**3. Coordinator: call the slot.** Name the version, the base sha and the
order: "#42 next at 1.2.7.0, base `<sha>`, order 41,42".

**4. Lane: stamp.** A gate-ahead lane first merges `origin/main` (with the
predecessor in it) into its branch, never a rebase. Then:

```bash
gstack-ship-queue stamp --pr 42 --version 1.2.7.0 --expect-gated <gated> \
  --expect-base <sha> --expect-order 41,42 --allow-repo-commands
```

`<gated>` is the head the gate ran on: the pushed head the lane gated, or the
record's `gated=` after a gate-ahead. The preflight refuses before anything is
written unless the tree to stamp equals the gated one modulo stamps, the base
is `<sha>` and, under `full_e2e`, a passing gate result is bound to the gated
head. Then it runs the restamp, commits, reruns the tree receipt and prints

```
QUEUE_STAMP: 42 1.2.7.0 head=<sha> gated=<sha> tree=same-modulo-stamps receipt=<sha256>
```

Each stage is journaled in `.gstack/tmp/ship-queue/stamp-42.json`; the
identical command resumes at the first unfinished stage, or returns the stored
`QUEUE_STAMP` when it already finished. A refusal prints
`QUEUE_STAMP_REFUSED: 42 head=<sha> committed=no|yes <sha> stage=<stage>`
and the coded line (`QUEUE_STALE` carries a `recompute:` command). Push the
stamp commit, wait for CI on it, run `ready` again
(`READY #42 <head> STAMP_VERSION=1.2.7.0`) and send it with the
`QUEUE_STAMP` line.

**5. Coordinator: verify, then merge.** From the coordinator's own clone:

```bash
gstack-ship-queue verify --pr 42 --gated <gated> --receipt <sha256> --expect-head <head> [--gate-exit 0 --gate-log <file>]
gstack-ship-queue verify --pr 42 --record <gate-ahead record> --receipt <sha256> --expect-head <head>
```

It fetches `refs/pull/42/head` and reruns the tree receipt there, so
`QUEUE_STAMP` is never a pasted claim: `VERIFY: 42 1.2.7.0 head=<sha>
gated=<sha> tree=same-modulo-stamps receipt=<same sha256>`. Under `full_e2e`,
`--gated` also needs the lane's passing gate log from its run on that head
(`--gate-exit 0 --gate-log <file>`), else `QUEUE_GATE_MISSING`. With a gate-ahead
record, whose gated commit never left the lane's machine, it first recomputes
the merge with `git merge-tree --write-tree <branch head> <predecessor head>`
and compares it with the recorded merge tree, rebuilds the gated tree from
the recorded stamp patch and compares it with the recorded `gated_tree`,
proves that patch is stamps only, checks the predecessor did not move, and
prints `merge_tree:`, `gated_tree:` and `gate:` lines. The last line is
`MERGE_CONDITION: sha=<head>`: merge with that expected head. Any
`QUEUE_VERIFY_MISMATCH` means do not merge.

**Rolling out `gate_command` and `full_e2e`.** Commit them (with
`min_gstack_version` at their introducing version, which `init --explain`
prints) only after every lane's gstack is at least that version, the crew's
install floor (`GSTACK_MIN_REVISION`). A lane on an older gstack refuses the
policy by name rather than reading it differently.

<a id="run-a-merge-train"></a>
## Run a merge train

A merge train gates several READY PRs with one full gate instead of one gate
each. The coordinator merges the pinned, unstamped PR heads in slot order onto
main in a scratch worktree, records each prefix tree (T0 is main, Tk is the
train head), runs the free tests and then one full gate on the train head, and
merges the PRs one at a time, each only while main's tree equals the prefix
the gate covered modulo stamps. A red train is bisected on its red cases only.

The surface is off unless the base revision's `.gstack/ship-policy.json`
declares a `train` block. Without one, `train …` and `verify --train` refuse
with `QUEUE_TRAIN_OFF`, and `ready --pr <n>` prints exactly the per-PR READY
block above (`--screen`, `--no-screen` and `--broad` are ignored with a
warning on stderr). A repository without gstack's eval workflow declares
[`gates`](#train-gates) instead. A block for gstack itself would read:

```json
"train": {
  "gate_workflow": "evals.yml", "free_workflow": "free-tests.yml",
  "full_gate_check": "gstack/full-gate", "record_artifact": "gstack-train-record",
  "max_size": 5, "fill_hours": 1, "screen_selection": "gstack-paid",
  "trial_reservation_usd": 1.5
},
"min_gstack_version": "<the version that introduced train>"
```

gstack's own policy carries this block. It went live after the workflow side
(the train-nonce record, the `cases` and `prefix_shas` inputs, the dispatched
screen) merged and one dry-run train passed: two unstamped scratch docs PRs on
a scratch base whose `route` step read the policy from that base instead of
the default branch. `gate_workflow` is dispatched with
`evals_all`, `expected_sha` and `nonce` (bisects add `cases` and
`prefix_shas`, screens add `screen_pr`, `screen_merge_sha` and
`screen_policy`). That run publishes `full_gate_check` as a check run on the
train head and the train record as the `record_artifact` artifact only when
its census is complete and green; gstack reads both and never writes a
check. `screen_selection: gstack-paid` computes gstack's paid case selection
for the screen recommendation; `none` leaves the choice to the lane.
`trial_reservation_usd` is what the bisect reserves for a trial without cost
data.

Every command prints its lines, the coded error line on stderr, then
`NEXT: <command>` and `GSTACK_RESULT: skill=ship-queue status=… run=<record>`.
Records live under `$GSTACK_STATE_ROOT/ship-queue/` (`trains/<nonce>/train.json`
with one attempt record per dispatch, `ready/` receipts and `freeze/`) and
are mirrored to origin as git notes on `refs/notes/gstack-trains` before any
remote effect, so a lost machine loses nothing: `train status` on a clean
state root rebuilds them. `GSTACK_SHIP_QUEUE_NOW` pins the clock for tests.

<a id="train-land"></a>
### Stamped trains under `changelog_fragments`: `train land`

When the base policy also declares [`changelog_fragments`](#changelog-fragments),
`train build` builds every prefix twice. T_i is the plain chain above. S_i is
what slot i publishes: S_0 is the base and S_i = stamp(merge(S_(i-1), pin_i)),
stamped by `gstack-restamp` with S_(i-1) as its base, so slot i folds only its
own fragments (a stacked pin's parent fragments are already folded) and the
versions run in slot order, each with its slot's effective bump. Before
anything is pushed, each S_i must be merge(S_(i-1), pin_i) modulo stamps,
keep every release entry of S_(i-1) byte for byte, and equal T_i outside
release paths (version files, CHANGELOG, fragments, `release_outputs`,
`stamp_paths`, `stamp_files`); otherwise `QUEUE_TRAIN_STAMP_MISMATCH`. Pass
`--allow-repo-commands` when the policy has a `restamp_command` or
`release_tool`. The record keeps both chains (`prefixes` and `stamped`), the
train head and branch are S_k, and the one full gate runs on S_k, the exact
tree the last merge publishes.

**One land lock.** `train land` takes the same repository land lock as
[`land`](#land), `refs/notes/gstack-land`, as `train <nonce> slot <i> (#<pr>)`,
before its first read of main, so a standalone land and a train slot never
both publish onto one main: whichever starts second refuses with
`QUEUE_LAND_LOCKED`, naming the holder. Once a slot has merged, the train keeps
the lock in phase `between`, which only the same train's next slot takes over,
until its last landable slot lands; a refusal before a later slot's push (a
failed `gh` or `git fetch` read, say) keeps it too, so no standalone land slips
in while the train waits on a rerun. Before any slot merged, a refusal before
the push releases it. After a push, a failure keeps the lock in its phase and a
rerun of the same slot takes it back. A stop that freezes the queue
leaves the lock in phase `freeze`, which `--break-lock` never breaks: only the
repair train the freeze admits takes it over, and it is released when that
train clears the freeze. `--break-lock` prints the holder (`LOCK_HOLDER:`),
keeps land's staleness, mid-push and drift rules, refuses a `between` lock
younger than 10 minutes, and refuses a live train run's lock unless
`--break-train-lock` is also given. `train watch --land` goes through `train
land`, so it stops with `NEXT:` on `QUEUE_LAND_LOCKED` like any refusal. A train
`train land` refuses (one built without stamped prefixes or a gate) still merges
through `verify --train` and `gh pr merge`, which neither take nor check this
lock.

Slots merge with `train land --train <nonce> --pr <n>`, never a slot call:

1. The record must be the gated head's own chain. Walking first parents from
   S_k gives T0 and S_1..S_k with the recorded commits and trees, and each
   S_i's second parent is slot i's pin. A record rebuilt from notes that
   differs anywhere refuses (`QUEUE_PROOF_MISSING`), and every later step uses
   only that verified chain. main's tree must equal S_(i-1)'s exactly (slot 1:
   the train base), and the PR's head its pin, with its /ship receipt. main
   equal to an earlier prefix refuses and names the slot to land first; main
   equal to a later prefix confirms the slot (a rerun). A base that cannot be
   fetched refuses (`QUEUE_PROOF_MISSING`), a fork head refuses
   (`QUEUE_TRAIN_UNTRUSTED`), and a PR whose base is no longer the train's
   base refuses (`QUEUE_NOT_READY`), here and again before the merge.
2. It commits S_i's tree with parents [pin, main], adds the
   `evals-no-debounce` label (a tool-made head gets no later push, so the
   10-minute quiet window protects nothing), and pushes under
   `--force-with-lease=<branch>:<pin>`; a foreign push is never overwritten
   (`QUEUE_TRAIN_MOVED`). The stamp commit is deterministic and journaled
   (`land-<n>.json` beside the train record) before the push, so a rerun
   adopts its own stamp head instead of reading it as a move. A push that
   fails while the branch still reads the pin is `QUEUE_NOT_READY`; rerun.
3. It waits for the PR's checks on that commit (`--no-wait` prints the
   command). Required checks run live at the slot until GSTA-156's exact-tree
   reuse is on main. Every name in `changelog_fragments.required_checks` must
   be present and green on the stamp commit (a check run of that name, all of
   its `<name> (…)` matrix runs, or a status context); a missing one holds the
   merge (`QUEUE_NOT_READY`) and the fix names it. Without the list, any green
   set counts, so set it to the checks branch protection does not enforce.
4. It refuses if main moved during the checks, merges with
   `--match-head-commit`, and confirms main's tree is S_i exactly. Any other
   main is the freeze path above (`QUEUE_TRAIN_TREE_MISMATCH`, backstop).
   A slot counts as merged only when GitHub reports its PR MERGED. Main at
   S_i with the PR still open refuses (`QUEUE_PROOF_MISSING`), and the
   train's merged count, its freeze decision and the freeze record read
   GitHub's state for every slot, never the record's `merged` list alone.

`verify --train` refuses a stamped train and names `train land`. The backstop
covers main only when its exact tree is some S_i of a green record (plain
T_i records still cover modulo stamps). A dropped slot changes every later
version, so the train is rebuilt, as today.

<a id="train-gates"></a>
### Trains for any repository: `gates`

A repository without gstack's eval workflow declares its own gates instead of
`gate_workflow` and the other gstack-evals keys. Such a train gates every
prefix, not just its tip, so a red train names its culprit without a bisect:

```json
"train": {
  "gates": [
    { "kind": "workflows", "workflows": ["ci.yml"], "required_jobs": ["ci.yml/test", "ci.yml/lint"] },
    { "kind": "command", "command": "bun test", "timeout_sec": 1800, "spend_cap_usd": 3 }
  ],
  "land": { "merge_method": "squash", "required_checks": ["test", "lint"] },
  "max_size": 5, "fill_hours": 3
},
"min_gstack_version": "1.92.0.0"
```

A block with `gates` holds exactly these four keys; a gstack-evals key beside
them is refused, and a block without `gates` is the gstack-evals kind and
behaves exactly as above. `min_gstack_version` must be at least
`TRAIN_GATES_KEY_VERSION` (lib/ship-policy.ts), so an older gstack refuses the
policy by name. `max_size` is at most 5, because each gate runs on k+1
prefixes.

- **`workflows` gates.** Each workflow is dispatched on a pushed
  `train-prefix/<nonce>/t<i>` ref with a `nonce` input; the train records the
  nonce before it sends the dispatch and adopts only the workflow_dispatch run
  whose run-name carries `[eval-bg <nonce>]`, never a run found by commit.
  A prefix is GREEN only when that run tested the prefix head exactly, every
  `required_jobs` entry (`<workflow file>/<job name as GitHub reports it>`)
  concluded success and the run concluded success. With `record` set (an
  artifact name), the run must also upload a JUnit XML or `{ "tests": [...] }`
  JSON file reporting at least one executed test, and failed test ids become
  the red cases. A red run gets one `gh run rerun --failed`: green on the
  rerun is GREEN with a `FLAKY:` line, red again is real, and both attempts'
  jobs stay in the record. `post_merge_checks` names checks that must succeed
  on main after each land before the next slot lands (`verify --post-merge
  <sha> --checks <names>`; `train land` checks the previous slot's merge and
  refuses the next slot until they are green, and `train watch --land` runs it
  between slots). A workflow whose concurrency
  group is not keyed by `github.ref` (or the nonce) gets one prefix at a
  time.
- **`command` gates.** Each prefix is checked out clean and detached and runs
  `command` on a Ubicloud VM through scripts/ubicloud/ubi-runner.sh
  (standard-16, `UBI_OWNER` required). The VM's `git write-tree` must equal
  the prefix tree, and exit 0 is GREEN. Only names in `pass_env` reach the VM
  (`UBICLOUD_*` never). Each run reserves its timeout plus 10 minutes at the
  list price, and each command gate's `spend_cap_usd` covers every run of that
  gate in the train, reruns included (3 dollars covers six prefixes and one rerun at 1800 s; `train init`
  prints that default and `train doctor` flags a cap below a full train). The
  next run past the cap refuses (`QUEUE_TRAIN_SPEND_CAP`); raising the cap is a
  policy commit that moves main, so it is followed by a new train.

**The verdict.** T0 red is red on main (`QUEUE_TRAIN_RED_ON_MAIN`, fix
forward). Otherwise the first non-green prefix decides: incomplete stops the
train, red with a later prefix green is unattributed (repair or a new order,
never an unchanged rebuild), and red with every later prefix red names its
slot as the culprit (`QUEUE_TRAIN_RED`); the slots before it may land.
`train bisect` and `train rebuild` refuse such trains, since every prefix
already has its verdict. A green T0 run of the same gate at main's exact
commit in another train is reused instead of run again.

**Base-red PRs.** A lane whose /ship paused on a red base (its receipt carries
`base_red`) READYs with `ready --pr <n> --no-screen --base-red --fixer <pr>`:
the condition must have been classified on today's base and not have expired.
The fixer READYs with `--fixes-base-red <case,...>`. The fixer rides at slot 1
(moved there unless `--order` says otherwise, which then refuses), T0 may be
red on exactly the fixer's cases and nothing else, and every conditional PR
behind it is gated on its own prefix with nothing excluded. A conditional PR
without its fixer at slot 1, or on a gstack-evals train, refuses
(`QUEUE_TRAIN_BASE_RED`, `QUEUE_BASE_RED_NO_TRAIN`).

**Landing.** `train land` publishes T_i, or S_i when the train stamps
(`changelog_fragments`, or `gates` with `queue_mode: stamp-at-merge`), with
main's tree equal to the prefix before it. It records the mode, and the update
commit when there is one, before its first remote effect:

1. `direct`: `gh pr merge --<merge_method> --match-head-commit <pin>`, used
   only when branch protection is readable and not strict, the pin merges onto
   main as the gated tree exactly, and the pin's own checks (every
   `required_checks` name) are green.
2. `update`: the gated tree committed on [pin, main], pushed under the pin's
   lease, its checks waited for, then merged at that commit. It is forced for
   a stamped train, strict or unreadable protection, a conditional PR, a merge
   that resolved release files, and a pin whose checks are red. `rebase`
   always refuses (`QUEUE_TRAIN_LAND_METHOD`): it would replay commits, and
   the replayed tree is not the gated one.

Required checks are `changelog_fragments.required_checks`, else
`train.land.required_checks`. Fork heads refuse. Either way main's tree must
be the prefix afterwards, or the queue freezes as above; the backstop
dispatches each gate workflow on main by nonce. `train watch --train <nonce>
--land` runs build, verdict and every landable slot's land in order, and stops
at the first refusal.

**Setting one up.** `train init [--command "<test command>"]` reads branch
protection, the base's workflows and the open PRs, and prints a block mapping
each required check to its workflow job, the `nonce` input, run-name and
concurrency snippet each gate workflow needs, and the land mode slots will
use. It recommends `changelog_fragments` when open PRs bump the version, and
refuses (`QUEUE_TRAIN_INIT_REFUSED`) only when they do and the policy neither
declares fragments nor stamps at merge. After the block lands on the base,
`train doctor` re-checks it: a missing workflow, nonce input or run-name, a
required job no workflow defines, a concurrency group not keyed by ref, a push
trigger that matches `train-prefix/` refs, a workflow never green on the base,
a command gate cap below what a full train reserves, a merge method GitHub has
turned off, and `rebase` as the merge method (`QUEUE_TRAIN_DOCTOR_FINDINGS`).
Neither command writes anything.

<a id="wave-prs"></a>
### Wave PRs: several PRs in one slot

When the queue is long, PRs that touch the same part of the code travel
together as one **wave PR**: one integrator branch, one /ship, one READY, one
train slot and one version (Garry's rule R46, 2026-10-31: "consolidating
functional areas into larger wave PRs ... so we can land them faster with fewer
test passes"). Each slot otherwise costs its own stamp commit and a full round
of required checks before it merges, one slot after another, so a wave of
three saves two of those rounds and two versions.

```bash
gstack-ship-queue wave plan                                     # read-only (merge-tree scratch objects aside): QUEUE, WAVE_ADVISED, WAVE_GROUP lines
gstack-ship-queue wave build --area ship --prs 41@<sha>,42@<sha>,43@<sha>
gstack-ship-queue wave build --wave <nonce> --continue          # after resolving a conflict in the printed worktree
gstack-ship-queue wave build --wave <nonce> --drop 42           # rebuild without #42 as a new wave
gstack-ship-queue wave build --wave <nonce> --release           # end the wave unlanded; its PRs ride alone
gstack-ship-queue wave status [--wave <nonce>]
gstack-ship-queue wave settle --wave <nonce> [--dry-run]        # after the wave PR merged
```

- **When.** `wave plan` counts the live READY PRs (open, head equal to their
  READY receipt, CI green at that head; a READY head whose CI is red, still
  running or absent prints a `NOT_GREEN` line and stays out of the plan; a
  READY head that does not merge onto main with the train's merge rules prints
  `NOT_MERGEABLE` with the conflicting files and stays out too, while a
  conflict only in the CHANGELOG, which the train merges, does not count). A
  READY PR whose CI, head, diff or merge onto main cannot be read fails the
  whole plan with `QUEUE_PROOF_MISSING`. Over the
  trigger (6) it prints `WAVE_ADVISED` and suggested groups of 3 to 6: PRs
  whose changes to a common code file conflict (`git merge-tree` cannot merge
  the two heads, or the check itself fails) always share a group, so that
  conflict is resolved once. A PR that renames a file and one that edits the
  old path are linked when the edit conflicts at the new path. A group of
  linked PRs is never split across waves: one larger than the wave maximum
  prints `WAVE_OVERSIZE` with no build command (land part of it as single
  slots, then plan again). Hub
  files never link PRs: anything under `docs/`, Markdown (generated skill
  renders included; their `.tmpl` sources still link) and every `.json` or
  `.jsonl` file (ledgers and registries). Most PRs append to them, and
  linking through them once chained a 55-PR queue into a single area
  (GST-770). Each group takes its largest PR's functional
  area (a skill directory, the first word of a `lib/`, `bin/` or `test/`
  module name, or `docs`), smaller groups ride solo, and the integrator is
  the PR with the most changed lines. `train build` handed more than 6 pins
  prints the same `WAVE_ADVISED` line. It is advice: urgent and repair PRs
  still ride alone. While the queue stays long, plan new work as area waves
  from the start, so each piece skips its own /ship.
- **Build.** `wave build` checks every pin is an open, same-repository PR at
  that head (`QUEUE_WAVE_MOVED`, `QUEUE_TRAIN_UNTRUSTED`), not already in a
  live wave (`QUEUE_WAVE_DUPLICATE`), 3 to 6 of them (`QUEUE_WAVE_SIZE`;
  `--min`/`--max` change it). It merges the heads in order onto main with the
  train's merge rules, each as a merge commit whose second parent is the pin,
  so no constituent is rebased or squashed. The wave record (kind `wave`) is
  written locally and to `refs/notes/gstack-trains` before `wave/<nonce>` is
  pushed, and each constituent gets one "frozen in wave" comment. Then the
  integrator opens the wave PR (the printed `gh pr create` and body file, or
  the host's PR tool), runs /ship on it and READYs it.
- **Conflicts.** A merge that conflicts outside the CHANGELOG and the stamp
  files stops with `QUEUE_WAVE_CONFLICT` and leaves the merge in progress in a
  worktree under the state root. The integrator resolves and commits it there,
  then `--continue` checks that commit merges exactly that pin onto the
  recorded commit and finishes the chain.
- **Frozen heads.** Once in, a constituent's head does not move. Fixes go on
  the wave branch as integrator commits, which the chain check allows. A
  constituent that has to change goes back to its owner: `--drop <pr>` builds
  a new wave on a new branch (never a force-push; the integrator closes the
  old wave PR first, and the old record is marked superseded), refused with
  `QUEUE_WAVE_DEPENDENT` when another pin contains the dropped one. A drop
  that would leave fewer PRs than the minimum releases the wave instead, and
  `--release` does the same for a wave PR closed without merging: the record
  is marked released and every constituent can be READY'd on its own again.
  Both wait until the wave PR is closed, since a train that already admitted
  it would still land it. A constituent must target the base branch; a
  stacked PR is refused, because its pin carries its parent's commits.
- **READY and the train.** `ready --pr <wave pr>` and `train build` read the
  wave record for a `wave/<nonce>` head branch (rebuilt from the notes ref on a
  fresh machine; `QUEUE_WAVE_UNKNOWN` when there is none). They walk the
  branch's first parents back to the recorded base: every pin must be merged
  unchanged, in order, and any other merge is refused. Every constituent must
  still be open at its pin. READY gains `WAVE:` and `CONSTITUENTS:` lines.
  `ready` and `train build` refuse a constituent of a live wave on its own
  (`QUEUE_WAVE_DUPLICATE`), so it cannot land twice. A wave head may carry
  train land's stamp commits after its last constituent, so a stamped wave
  is re-READY'd like any stamped PR. From there the wave PR is an ordinary slot: `train
  land`, `verify`, the stamp and the backstop treat it like any PR, and under
  `changelog_fragments` its one stamp folds every constituent's fragment into
  one version section.
- **After the merge.** `wave settle` finds the wave PR merged into the base
  branch, checks that its merge commit is on that branch and carries its head
  (the head's tree, or the head merged onto the merge's parent when the train
  merged the PR directly), and walks its chain (train land's stamp or update
  commits on top are allowed). A
  constituent still at its pin gets a "Landed in wave #W as vX (sha)" comment
  naming any integrator commits or hand-resolved merges that touched its
  files, and is closed. One whose head moved after the wave froze stays open
  with a comment saying its newer work did not land. Comments carry a marker, so a
  rerun posts nothing twice; `--dry-run` shows the plan.

<a id="ship-before-ready"></a>
**0. Lane: /ship before READY.** Every READY follows a /ship run on the branch
at the head being READY'd, including a re-READY after a push (Garry,
2026-10-25: "we should really be using the gstack ship skill before merging
PRs"). /ship runs the tests, both reviews, the gate-integrity list and the docs
audit, and ends by writing its receipt into the PR body
(`gstack-ship-receipt write --pr <n> … --body <file>`, posted with
`gstack-post pr-body`). Under `queue_mode: stamp-at-merge` it bumps no version
and never merges or merges main into the branch; the train still stamps at the
slot. The queue enforces this at every step from the PR body alone:

- `ready` refuses with `QUEUE_RECEIPT_MISSING` when the body has no valid
  receipt and with `QUEUE_RECEIPT_STALE` when the receipt's `head` is not the
  head being READY'd (or its `pr` is another PR); the informational
  `SHIP_RECEIPT:` line still prints. It refuses `QUEUE_RECEIPT_DEPTH_RAISED`
  (with a `REVIEW_DEPTH:` line) when the receipt records a review depth below
  what the head needs, `QUEUE_RECEIPT_TARGETED_MISSING` (with a
  `REVIEW_TARGETED:` line) when a targeted class the head needs has no done
  targeted pass in the receipt, and `QUEUE_RECEIPT_EXCEPTION_INVALID` when an
  owner exception it records does not stand ([the ship receipt](#ship-receipt)).
  There is no flag around it. Before any of these checks, and before it
  chooses the train or plain path from the policy, `ready` fetches
  `origin/<base>` and reads the policy and every receipt field against that
  fresh ref (a clone with a missing or stale base ref would otherwise run plain
  `ready` under a train policy and skip the screen, conflict and READY-receipt
  steps), so a lane clone whose base is behind the remote never turns a good
  receipt into `RECEIPT_INVALID` (GST-2232); a failed fetch refuses with
  `QUEUE_BASE_UNFETCHED` before anything is compared. The stamp path of `land`
  refuses the same way; `land --pin` (`merge: direct`) refuses a failed fetch
  with `QUEUE_NOT_READY`, as it already did.
- `train build` refuses a pin whose PR has no current receipt with the same
  codes, naming the PR, before anything is written, pushed or dispatched,
  `--dry-run` included.
- `verify --train` refuses the slot with `QUEUE_RECEIPT_MISSING` or
  `QUEUE_RECEIPT_STALE` before printing `MERGE_CONDITION`; it does not
  recompute the review depth.

**The stamp keeps the pin's receipt.** The slot's stamp commit changes only
stamp files (and, from slot 2 on, merges main into the pin), so no /ship runs
on it: the receipt written for the pinned head stays the binding one. `verify
--train` accepts a receipt whose `head` is either the slot's pinned head or
the current head, and the re-READY after the stamp push (`ready` at the stamp
commit) accepts the receipt for the pin when HEAD is the pin plus stamp files,
or (from slot 2 on) the pin merged with main plus stamp files on top of the
merge; any other head is `QUEUE_RECEIPT_STALE`, including a merge of main with
no stamp above it (a lane's own push under rule 14) and a merge whose pin side
carries an edit made after /ship.

This is a process gate, not an authenticity check: the receipt is a block in
the PR body, which the PR author writes, so the codes prove that /ship was run
and recorded for this head, not that nobody typed the block by hand. Fork heads
are already refused (`QUEUE_TRAIN_UNTRUSTED`). The `ship-run.json` that
`gstack-ship-receipt result` writes under the lane's state root is a
normalized copy of that same block bound to the head it was run at, not an
authenticity proof either.

**1. Lane: READY with a screen choice.** Under a train policy READY needs an
explicit choice:

```bash
gstack-ship-queue ready --pr 42                    # prints SCREEN: lines and the recommendation, refuses
gstack-ship-queue ready --pr 42 --no-screen        # READY receipt; the PR rides unscreened
gstack-ship-queue ready --pr 42 --screen [--broad] # dispatches one paid screen on the PR's merge SHA (a scratch merge when GitHub's merge ref lags the head; QUEUE_SCREEN_STALE_REF only on a real conflict)
```

Without a choice it prints the `SCREEN:` selection (with
`screen_selection: gstack-paid`, the skill's own cases, the selector's mode and
`recommend --screen` or `--no-screen`: `--screen` only when the selector's
mode is `full-fallback`, an unknown dependency or a shared runtime input that
restores every case, or when it cannot select at all; every other PR rides
unscreened, and the train gate's full census runs its cases on the tree that
merges) and refuses with `READY_SCREEN_CHOICE_REQUIRED`. The price line says
the dollar figure is pending the cost replay; until it lands, `SCREEN:` shows
case counts and the recommendation only. A lane that already ran focused
local cases says so in the READY block and may pass `--no-screen`. `--screen`
dispatches `gate_workflow` with `screen_pr`, `screen_merge_sha` (the
`refs/pull/<n>/merge` SHA) and `screen_policy` (`narrow`, or `broad` with
`--broad`, the full PR selection). A narrow screen, and `eval:bg:pr`, skip a
changed file whose derived references reach every gate case and nothing
narrower selects, along with its derived judges: the plan's reason names it,
and the train gate's full census runs those cases. A `pull_request` run, the
merge gate when the base has no `train` block, keeps the broad selection. Full-gate files, shared runtime and paid-runner
inputs, and files the derivation cannot place still run the full gate on a
narrow screen, except `setup`, which no paid run executes: a narrow screen
derives it like any other file. The nonce key carries the purpose and
the policy, so a repeat follows the same run and a broad screen never adopts
a narrow one. The READY block gains `screen: …`, and the receipt is written
locally and to the notes ref. `READY_RECEIPT:` says `notes pushed` only after
`ready` reads origin's notes ref back and finds the note; after three tries
without it, `ready` refuses with
[`QUEUE_READY_NOTE_UNPUSHED`](troubleshooting.md#queue-ready-note-unpushed),
because `land` reads the note on origin. `--dry-run` prints the dispatch without sending
it. Before dispatching, `ready` fetches the merge ref and requires its second
parent to be the PR head and its first parent the current base: a missing,
lagging or unfetchable merge ref (GitHub stops recomputing it while the PR
conflicts with the base, CHANGELOG-only conflicts included) is replaced by a
scratch merge of the head onto the base, pushed as `screen/<pr>-<head12>`
(the `SCREEN_MERGE:` line says which); a screen dispatched on a stale ref would
plan no cases and report success. Only a real conflict with the base (or a
remote whose refs cannot be listed) is `QUEUE_SCREEN_STALE_REF`. Under either
choice `ready` first reads what `gstack-pr-wait`'s base-overlap event reports,
from git: when the base moved since the head forked and its new commits touch
files the PR changes, `BASE_OVERLAP: <base> moved to <sha7> and touches files
in this PR: <files>; the train's merge onto <base> is clean` (or `conflicts
beyond the CHANGELOG and the stamp files (<files>)`), the train's own merge
rules run as a dry run in object storage; a git read that fails prints
`conflicts unknown` and refuses nothing. A conflict under `--no-screen` is
`QUEUE_TRAIN_CONFLICT` at READY, since the train would stop at this PR: the
lane reports it to the controller and, on its word (crew template rule 14),
merges the base into the pin, resolves, pushes and runs /ship before READY,
instead of learning it when the train is built. A finished screen that planned no cases (no
`paid-plan` artifact, which a superseded run never uploads, or a plan manifest
with nothing planned) is never followed as a screen: `ready --screen`
dispatches a fresh one and `train build` prints `SCREEN: #<n> run <id> planned
no cases …; counted as not-run` and seats the slot unscreened. A plan the
queue cannot read keeps the slot screened, with `SCREEN: #<n> <reason>;
counted as screened, unverified`.

**2. Coordinator: build.** Name the pins exactly as READY reported them:

```bash
gstack-ship-queue train build --prs 41@<sha>,42@<sha>,43@<sha> --dry-run
gstack-ship-queue train build --prs 41@<sha>,42@<sha>,43@<sha>
```

It prints `ORDER:` (the slot order to announce: screened PRs first in READY
order, then unscreened PRs fill the remaining seats, and `HELD:` lists the PRs
over `max_size`; `--order <pr>,<pr>,...` naming every
pinned PR once replaces that rule, for a PR that must merge before another,
and the train's later `NEXT:` rebuilds keep it), one `PREFIX: T<i> <commit>
tree=<tree>` per prefix and one `SLOT:` per PR. `--dry-run` adds the
`ESTIMATE:` line and writes, pushes and dispatches nothing. Otherwise it
writes `train.json`, pushes `train/<nonce>`, dispatches `free_workflow` there
and waits (`--free-timeout <s>`, default 2700) for a green
`workflow_dispatch` run on that exact SHA, then dispatches the full gate
through eval-bg's nonce. A train fills at `max_size` READY PRs or when its
oldest READY has waited `fill_hours`, whichever comes first; until then
`QUEUE_TRAIN_WAITING` names the time, and `--urgent` dispatches a one-PR
train at once. The scratch merges run before the fill rule: every `train
build` prints `#<pr> BASE_OVERLAP: <base> moved to <sha7> and touches files in
this PR: <files>` for a seated pin whose files the base moved onto since it
forked (the chain's merge onto the pin's own prefix is the verdict), refuses
`QUEUE_TRAIN_CONFLICT` for a pin that does not merge, and otherwise prints
`MERGE_CHECK: T1..T<k> merge clean onto <base>@<sha>`, so a
`QUEUE_TRAIN_WAITING` result is also a clean dry-run merge of the pool (the
crew template's sibling trial merge, done by the tool). gstack's own block fills at 5 PRs or one hour (it was 5 PRs or
three hours until 2026-10-26, which left READY PRs waiting most of a day, then 3 PRs or one hour until 2026-10-31). The same pins on the same base return the live train
instead of a second one; `train build --train <nonce>` resumes a train from
its record. Refusals, all before any spend: `QUEUE_TRAIN_UNTRUSTED` (a fork
head), `QUEUE_TRAIN_MOVED` (a head moved from its pin),
`QUEUE_RECEIPT_MISSING` and `QUEUE_RECEIPT_STALE` (the PR body has no /ship
receipt for the pin; see [/ship before READY](#ship-before-ready)),
`QUEUE_RECEIPT_DEPTH_RAISED`, `QUEUE_RECEIPT_TARGETED_MISSING` and
`QUEUE_RECEIPT_EXCEPTION_INVALID` (the receipt's review depth is below what
the pin needs, a targeted class the pin needs has no done targeted pass, or an
owner exception it records does not stand; see [the ship receipt](#ship-receipt)),
`QUEUE_NOT_READY` (no READY receipt at that head), `QUEUE_TRAIN_CONFLICT` (the printed
`QUEUE_TRAIN_CONFLICT: train <id> stopped at #<pr> (conflicts: <files>) after
merging #<a>,#<b>; nothing dispatched, no branch pushed; fix: …` line names
the build without that PR) and `QUEUE_TRAIN_FREE_RED` (free tests red,
missing, cancelled or on another SHA). In a merge, the version file takes the
prefix's side, a manifest or npm lockfile conflict merges three-way with the
prefix's version (so a pin's dependency edit survives), and the CHANGELOG
merges by section, since the stamp at merge rewrites them; a PR whose CHANGELOG drops or renames a released heading (or
carries a released entry's text in a section of its own) is a CHANGELOG
conflict, never merged with the damage, except the stacked child whose parent
was released since their merge base, which `mergeChangelogs` carries (see *A
stacked child whose parent merged earlier*, below). READY receipts and train records are
keyed on origin's GitHub owner/repo, so lanes whose origin uses another URL
form (git.capy.ai, ssh, a token URL) share the coordinator's queue.

**3. Coordinator: status and verdict.**

```bash
gstack-ship-queue train status [--train <nonce>]
gstack-ship-queue train verdict --train <nonce>
```

`status` never spends. When a dispatch was attempted but its run never showed
up (`QUEUE_TRAIN_DISPATCH_UNKNOWN`), it lists the workflow's dispatch runs and
either adopts the run carrying the nonce or marks the dispatch `absent`; only
an absent dispatch is sent again, by `train build --train <nonce>`, under the
same nonce. `verdict` reads the run, its record and the `full_gate_check`
check: `GREEN` only for a complete census bound to the train nonce, head and
tree; `QUEUE_TRAIN_PENDING` while it runs; `QUEUE_TRAIN_INCOMPLETE` for INFRA
or INCOMPLETE panels, unbound, partial or cancelled shards, a slice killed
before upload, or no record (never green); `QUEUE_TRAIN_RED` with the red
cases.

**4. A red train: bisect, then at most one rebuild.**

```bash
gstack-ship-queue train bisect --train <nonce> --spend-cap 5 --dry-run
gstack-ship-queue train bisect --train <nonce> --spend-cap 5
gstack-ship-queue train rebuild --train <nonce>
```

The bisect dispatches the red cases (`cases`) on every prefix T0..Tk
(`prefix_shas`; for a [stamped train](#train-land), T0 and S_1..S_k, the
chain its gate ran), one trial each, after checking every prefix is an ancestor
of `train/<nonce>` (`QUEUE_TRAIN_PREFIX_INVALID`). It reserves every
case×prefix trial (unknown costs at `trial_reservation_usd`) and launches only
the prefixes that fit the cap (`QUEUE_TRAIN_BISECT_CAPPED`; completed prefixes
are kept and a rerun with a higher cap runs only the rest). Rerun it to read
the results. The pattern decides: `ATTRIBUTED #<pr>` only when monotone
(green before, red from that PR on), and `NEXT:` builds the train without it;
red on every prefix with T0 included is `QUEUE_TRAIN_RED_ON_MAIN` (fix forward
on main first); anything else is `QUEUE_TRAIN_UNATTRIBUTED`. An all-green
bisect earns exactly one unchanged rebuild (`train rebuild`, reporting both
runs); a non-monotone pattern earns none and goes to a repair lane. Every
other rebuild is `QUEUE_TRAIN_REBUILD_REFUSED`, and a second red stays red.
An INFRA/INCOMPLETE-only census earns the single re-dispatch
EVAL_POLICY.infraRedispatch allows: `train rebuild --train <nonce> --infra`.
The rebuild-once rule lives in the train module beside that constant until
EVAL_POLICY records it. Bisect results never turn a train green.

**Stamping a slot.** When the slot is called, the lane stamps it at main plus PATCH. Slot 1's pin applies cleanly to main. From slot 2 on, main already carries the earlier slots' stamps, so the pin conflicts on CHANGELOG.md and GitHub can't merge it. The lane merges main into the pin first, then stamps:

```bash
git fetch origin main
git merge --no-ff --no-commit origin/main        # expect a CHANGELOG.md conflict only
bun --no-env-file --config=/dev/null -e "import { mergeChangelogsWithNotes } from './lib/changelog-check'; import { spawnSync } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const s = (n) => spawnSync('git', ['show', ':' + n + ':CHANGELOG.md'], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 30000 }).stdout; const m = mergeChangelogsWithNotes(s(2), s(3), s(1)); for (const n of m.notes) console.error('CHANGELOG: carried as a Gate integrity correction: ' + n); if (!m.text) { console.error('CHANGELOG needs a hand merge'); process.exit(1); } writeFileSync('CHANGELOG.md', m.text);"
git add CHANGELOG.md && git commit --no-edit
gstack-restamp --next --base main --pr 42 --expect-base <main sha> --expect-order <order> --allow-repo-commands   # stages what it writes (STAGED:)
git commit -m "v<X> stamp" && git push
```

A conflict in any file other than CHANGELOG.md means the merge isn't the train's prefix. Stop and report it. When the helper says the CHANGELOG needs a hand merge, take main's CHANGELOG unchanged and put your own entry above it. `verify` accepts the resulting head because it contains main and its tree equals T<i> modulo stamps, with its CHANGELOG judged as main's plus lines your pin added, however the conflict was resolved; the `head:` line says "T<i> with main merged in".

**The stamp commit is the base merge plus the stamp files, never a fifth.** The
restamp writes the version files, the CHANGELOG, the `release_outputs` and the
`stamp_paths` lines the branch itself added (gstack: `CHANGELOG.md`, `VERSION`,
`package.json`, `agents-digest/gstack-AGENTS.md`, and a `*_KEY_VERSION` the PR
introduced). A line the base added since the pin's fork point is the base's,
whether the base merge is committed or still staged (`stage stamp_paths` says
"N line(s) the base added since the fork point are the base's"; train 24,
2026-10-27, moved main's `DOCS_CAPS_KEY_VERSION` in both slots before this
rule). Restamp stages what it writes and prints `STAGED:`; commit what restamp
staged. A file the slot call does not name is not a stamp: `git restore --staged
--worktree` it and report it. A stamp file holding unstaged edits of your own refuses before
anything is written (`RESTAMP_UNSTAGED_EDITS`), and a staging failure leaves the
files written for the noop rerun to stage (`RESTAMP_NOT_STAGED`), so a bare
commit after a `--no-commit` base merge can no longer drop the stamp (#3527). The tree receipt refuses such a move after the fact
only while the moved version is older than the base's at the build, so the
restamp, not the receipt, is what keeps the base's key in place.

**Size caps compose; nothing re-pins at the slot.** Ship's union-size cap is a
ledger, `test/size-ledger/ship/`: `base.json` plus one `<branch>.json` per
branch that changed ship's union bytes (`{ "bytes": <signed>, "why": "…" }`),
and the parity suite requires ship's union bytes to equal the base plus every
entry, exactly. A lane records its own change once, before /ship, with `bun
--no-env-file --config=/dev/null scripts/size-ledger.ts record ship --why
"<what changed>"`. The entry is a property of the branch's own diff, so it
stays right across base merges, and each prefix carries the entries of the
slots in it, so T<k> passes with no re-pin and the stamp commit stays the four
files (a cap re-pinned at the slot would be a fifth file on a tree the gate
never ran). A clean merge adds byte deltas exactly; overlapping hunks are a
train conflict anyway, and two branches making an identical edit (git keeps
one copy, both entries count) fail closed with the same record command as the
fix. A branch that grows ship beyond its entry, or shrinks it without a
negative one, fails on its own tree and on every prefix that includes it.
`scripts/size-ledger.ts check ship` prints the ledger; `fold ship
--measured-at <tree>` moves the entries into `base.json` in a tidy-up PR,
never in a stamp commit. Other skills keep their `maxSizeRatio` caps in
`test/helpers/carve-guards.ts`.

**A stacked child whose parent merged earlier.** When the pin was stacked on a
PR that squash-merged in an earlier slot or train, the base merge conflicts
beyond the CHANGELOG wherever the parent's squash and the pin touched the same
lines. Take the pin's bytes for those files: `verify` checks the tree against
T<i>, the train's own merge of that pin, so the parent's content is already in
the prefix. The CHANGELOG is `mergeChangelogs`' job and needs no hand merge for
this shape: the pin's `[Unreleased]` still holds the parent's entry (as forked,
maybe edited) while main carries it under a released heading the merge base
lacks, so the parent's lines leave the child's section and each edit the child
made to them becomes a `- Correction to the <version> entry below: "<old>"
should read "<new>".` bullet under the child's own `### Gate integrity` (the
one-liner prints each carried correction). The released entry stays main's byte
for byte, and `verify` accepts those bullets as the pin's own lines because
the tool writes them. A pin that does not carry base can still be refused here
(`ours's Unreleased section holds released <version> text`): that is the
GSTA-67 shape, a released heading dropped by hand, and stays a hand merge.

**A generator change on an unstamped head.** A release output such as
`agents-digest/gstack-AGENTS.md` is stamped at the slot, and an unstamped PR
changes it the ordinary way, which is to edit the generator, regenerate at the
branch's own `VERSION` (its merge base's), and commit both. CI's Version Gate
regenerates the output at that VERSION and reads a byte-identical result as
unstamped ([what /ship reads](#ship), since 1.91.237.0); the freshness test
compares against the checkout's VERSION, so it passes before and after the
slot's restamp regenerates the file at the new version. Never revert a
regenerated output to the base's bytes to get past the gate (#3434 did, on a
gate older than that rule, and shipped a stale digest line until its merge).

**5. Coordinator: verify, merge, verify again.** For each slot in order:

```bash
gstack-ship-queue verify --pr 41 --train <nonce>   # MERGE_CONDITION: sha=<head>
# merge #41 with that expected head; gstack-restamp stamps it at merge
gstack-ship-queue verify --pr 41 --train <nonce>   # VERIFY_TRAIN: #41 merged; main's tree is T1 …
```

Before a merge, main's tree must equal the prefix before the PR modulo stamps
and the PR must be at its pin (stamps aside) or contain main and be T<i>
modulo stamps (its pin with main merged in; its CHANGELOG must be main's with
only lines from the pin's own CHANGELOG diff, or lines `mergeChangelogs`
writes for that pin against main, above it); after it, main's tree must equal
the prefix after it modulo stamps, or differ from it in the CHANGELOG alone
while being its own first parent's CHANGELOG (the main the pre-merge verify
saw, itself the prefix before modulo stamps) plus the PR's own entry under the
same rule. One CHANGELOG rule applies before and after, so a head the pre-merge
verify accepted confirms after its squash merge with the same CHANGELOG, and a
stacked child whose one `[Unreleased]` became two released sections is not a
mismatch (train 24, 2026-10-27, froze on exactly that). Before
`MERGE_CONDITION`, the head must also carry its own stamp: its `VERSION` above
main's, and its CHANGELOG headed with that version directly above main's top
release, with no `[Unreleased]` section main does not have; otherwise
`QUEUE_TRAIN_UNSTAMPED` names the rule and both versions (train 33 merged #3527
under #3526's version without it). verify prints `STAMP_VERSION:` from the head
itself. A post-merge confirmation needs GitHub to report the PR MERGED: an open
PR whose stamp-only diff already matches main (a release-only PR, #3530) takes
the pre-merge path, and any other open or unreadable PR refuses
`QUEUE_PROOF_MISSING` without freezing, as does a verify that could not read
the PR's current head (`--no-fetch` or a failed fetch) instead of judging the
unstamped pin. Anything else is
`QUEUE_TRAIN_TREE_MISMATCH` (or `QUEUE_TRAIN_MOVED`). When nothing of the train
has merged, that is a plain refusal, and a new train is built on current main. When
earlier slots already merged, main holds a prefix no gate covered on its own,
so verify freezes the queue (under `merge: direct`, where only the main
backstop freezes, see [direct freeze](#direct-freeze)). The freeze goes to local state and the notes ref
first, then the full gate is dispatched on main's SHA at once (the backstop),
and the `QUEUE_TRAIN_FROZEN:` line lists the merged PRs, main's tree and the
backstop run. A slot GitHub reports MERGED counts as merged in that record,
verified tree or not, so the rebuild after the repair never seats it again
(the reason says "merged on GitHub without a verified tree"); a first slot
whose squash GitHub reports MERGED but whose tree fails the post-merge check
freezes the same way, since main already holds the unverified squash. The
record comes from the one GitHub read that decided to freeze, never a second
one: a slot that read MERGED stays merged even when GitHub stops answering
before the record is written, and a slot unreadable beside a merged one is
left out of `unmerged`, recorded under `unreadable` and printed on an
`unreadable:` line; the `NEXT:` after the repair names it (`gh pr view <n>
--json state,headRefOid (unreadable at the freeze: #<n>@<sha>); seat each
that is OPEN in a train`).
When every slot of the train already merged on GitHub and main's SHA is a
prefix another train's verify confirmed (read after the notes ref, so a
machine that never ran that train still sees it), the mismatch says nothing
about this train: verify refuses with `QUEUE_TRAIN_STALE` and `NEXT:
gstack-ship-queue train prune --stale --train <nonce>`, freezing nothing and
dispatching no backstop (train 24's record froze the queue that way on a main
train 28 had verified, #3519). Only a verify that fetched main takes this
exit: under `--no-fetch` the local main may be older than GitHub's, so the
mismatch freezes as before. When
whether a slot merged on GitHub cannot be read, verify refuses
(`QUEUE_PROOF_MISSING`, "whether #<n> merged on GitHub could not be read")
and asks to be rerun once `gh pr view` answers; an unreadable state is never
"nothing merged". While frozen, ordinary trains and other trains' merges are refused
(`QUEUE_TRAIN_FROZEN`). Admit one repair PR at its exact head:

```bash
gstack-ship-queue train build --repair --prs 44@<sha>
```

It runs the normal free tests, full gate and verification on main plus the
repair. When verify confirms the repair merged, it prints `FREEZE: cleared`
and `NEXT:` builds a train of the PRs still unmerged.

**5b. Coordinator: after the merge.** `gstack-ship-queue verify --post-merge
<sha> [--timeout <s>] [--checks <a,b>]` (the merged commit's full 40-character SHA) watches
every check run attached to it (the push workflows: free tests, the Windows
subset, the main backstop) and every commit status until none is still
running, prints one `CHECK: <name> <conclusion>` per check and
`POST_MERGE: <sha12> green|red|pending|none (passed= failed= pending= skipped=)`.
Green needs at least one completed check and no failure; `neutral` and
`skipped` (the backstop superseding itself) count as skipped; a pending
commit status keeps the commit pending and a failed one makes it red. A
failure is `QUEUE_POST_MERGE_RED` naming the checks; a timeout (default 2700 s) is
`QUEUE_TRAIN_PENDING` with the same command as `NEXT:`. With `--checks` (a
workflows gate's `post_merge_checks`), each named check must also run and
succeed: one that did not succeed is `QUEUE_POST_MERGE_RED`, and one that
never ran is `QUEUE_TRAIN_PENDING` at the timeout. It keeps no process
state, so rerunning it after a machine restart continues the watch.

**6. Clean up.** `gstack-ship-queue train prune [--train <nonce>] [--dry-run]`
deletes the `train/<nonce>` branches of merged, superseded and dropped trains
(`WOULD-DELETE:`, `DELETED:`, `GONE:`). `train prune --stale` also settles a
`merging` or `green` train whose every PR is MERGED or CLOSED on GitHub (its
PRs landed through another train or by hand): it logs each PR's state on a
`STALE:` line, marks the record `stale` and deletes its branch; a train with an
OPEN PR is kept (`KEEP: … still needs the train`). The same run deletes every
`screen/<pr>-*` scratch branch whose PR is MERGED or CLOSED and keeps one whose
PR is still OPEN. `train forget --train <nonce> | --receipt
<pr>@<sha> [--dry-run]` removes one record (a settled train with its attempts,
or one READY receipt) from local state and from `refs/notes/gstack-trains`
with an exact lease on the notes ref, printing `FORGET:` then `FORGOTTEN:`; a
train that is still building, running or merging (`built`, `pushed`,
`free-pending`, `free-green`, `dispatch-unknown`, `dispatch-absent`,
`gate-pending`, `merging`) is refused; a rejected lease removes nothing and
restores the local notes ref.

**Following a train without a daemon.** `gstack-ship-queue train watch --train
<nonce> [--timeout <s>]` is the one resumable follow command: it reads the
record, runs the step its state asks for (`train build --train` to push, run
the free tests and dispatch the gate; `train status` to settle an unconfirmed
dispatch), waits for the pending run by polling gh, reads the verdict and
prints the last step's `NEXT:`. It never dispatches anything the record would
not dispatch on its own, so rerunning it after an interruption continues from
the record (`WATCH:` lines say what it did; a timeout, default 7200 s, is
`QUEUE_TRAIN_PENDING` with the same command as `NEXT:`; `--free-timeout <s>`,
default 2700, bounds the wait for the free tests).

**Screens are read from the run.** `ready --screen` and `verify --pr <n>
--screen` read a dispatched screen's verdict from the run's own artifacts
(`gate-binding-a<attempt>`, `report-verdict-a<attempt>`), never from a lane's
prose, and record it in the READY receipt (`screen.verdict`): `SCREEN_VERDICT:
#<n> run <id> GREEN|RED|NOT-RUN|INCOMPLETE [red=…] [flaky=…]` plus one
`FLAKY:` line per rule-16 flaky case. `PENDING` is a run still going,
`UNKNOWN` one the queue cannot read, and `INCOMPLETE` a finished run that bound
no verdict (its report job did not finish): `ready --screen` dispatches afresh
instead of following it, `verify --screen` refuses it (`QUEUE_PROOF_MISSING`)
and `train build` seats the pin unscreened, as for `NOT-RUN`. A RED screen refuses `ready` under
either choice, is never re-dispatched at the same merge SHA and is not seated
by `train build`, whose `NEXT:` names the build without that PR
(`QUEUE_SCREEN_RED`); a run that concluded success with no slice (its route
job found the head superseded or the plan selected nothing) is `NOT-RUN`:
`verify --screen` refuses with `QUEUE_SCREEN_NOT_RUN`, `ready --screen`
dispatches afresh instead of following it, and `train build` seats the pin
unscreened with a `SCREEN: … counted as not-run` line. When GitHub's
`refs/pull/<n>/merge` lags the PR head or is missing, `ready --screen` plans
the screen on a scratch merge of the head onto the base, pushed as
`screen/<pr>-<head12>` (`SCREEN_MERGE:` names it; `prune --stale` deletes it
once the PR merged or closed); only a real conflict with the base (or a remote
whose refs cannot be listed) is `QUEUE_SCREEN_STALE_REF`.

**Stacked tests before the gate.** `train build --prs … --dry-run --stack-tests
[--stack-tests-command "<cmd>"]` runs each PR's new test files (added relative
to the base, with a name ending in `.test`, `_test`, `.spec` or `_spec` and a
JS or TS extension, bun's own rule, so a helper or fixture under `test/` is not
one) on the integrated prefix that includes it, T<k>, in a scratch worktree, and prints
`STACK_TESTS: #<pr> T<k> <n> new test file(s) pass|FAIL (<files>)` or `no new
test files`. A failure is `QUEUE_TRAIN_STACK_RED` (nothing written, pushed or
dispatched): the tests pass on the PR head alone only because nothing before
it in the train had changed what they read, so fix them against that prefix or
reorder with `--order`. The default command is `bun --no-env-file
--config=/dev/null test` with the files appended.

**Escape hatches.** Remove the `train` block on the base branch to return
every lane to the per-PR queue at once. `--urgent` ships one PR alone,
`--no-screen` skips the paid screen, `--broad` widens it to the full PR selection,
and `train build --prs <list without it>` drops a PR at any step.

<a id="release-gate"></a>
## `release_gate`: one full gate on main every 8 hours

Trains gate each batch of PRs, and the main backstop gates every push. The
release gate replaces the backstop with one full paid gate on main's head at
most every `cadence_hours`, and only when main moved since the last gate. It
feeds the stable release (docs/releases.md) and never writes `stable` itself:
`crew/scripts/release-cut.ts` stays the only writer, with its floors (72 hours, 24
for an important change) and its security and regression exceptions unchanged.

The surface is off unless main's `.gstack/ship-policy.json` declares the
block, with `min_gstack_version` at least the release that introduced the key
(validation names it):

```json
"release_gate": {
  "cadence_hours": 8, "gate_workflow": "evals.yml", "branch": "main",
  "stable_ref": "stable", "check_name": "main-backstop",
  "on_red": "hold-release", "bisect_spend_cap_usd": 40
}
```

Every field is required. `cadence_hours` runs from 8 (the workflow's
schedule) to 168. `check_name` is the check run release-cut reads as gated,
so gstack keeps `main-backstop`. `bisect_spend_cap_usd` caps one red gate's
bisect (0 skips it). Each case reserves two trials on every prefix, one trial
and its one rule-16 rerun, and books the trials it ran at $1.50 each, since
prefix records carry no cost. So the cap bounds trials at that price, not
the bill: trials that cost more can carry a bisect past it. A running bisect
follows the policy's cap (lowering it to 0 stops it, and `bisect` resumes a
capped one once the cap exceeds what it spent); `bisect --spend-cap` applies
to that one run only.

**What runs.** `.github/workflows/release-gate.yml` fires every 8 hours and
on a manual dispatch from main. Without the block it stops after a git-and-jq
policy read, so no paid work starts and nothing is written. With the block it runs
`gstack-release-gate run`, which:

1. first finishes an open gate on an older commit (a run that outlived its
   budget, or a red gate's unfinished bisect), so main moving never orphans a
   verdict; only then does it look at main's head. An open gate older than
   three cadences stops holding up the head;
2. skips when main has not moved since `stable` or since the last gate, or
   when the last gate is younger than `cadence_hours` (`--ignore-cadence`
   overrides only the age);
3. writes a `release` record (`gstack-trains:release:<repo>:<sha>`) to
   `refs/notes/gstack-trains` before it dispatches, so a lost run resumes;
4. dispatches the full gate on that sha and reads its verdict and flake
   records. A case that failed once and passed its one rule-16 rerun is green
   and is listed as flaky;
5. records GREEN, RED or INCOMPLETE. GREEN needs the run's success and a
   report that says GREEN, so a missing report artifact is INCOMPLETE. An
   INCOMPLETE gate is re-dispatched once by the next run, then left for a
   person;
6. on RED, bisects the red cases over main's first-parent commits since the
   last green gate (at most 4 rounds, within the spend cap) and records the
   first bad commit;
7. publishes `check_name` on the gated commit from a separate job that holds
   `checks: write` and runs no repository code: success for a green gate,
   failure for a red one, and neutral when the gate has no verdict yet (still
   running at the budget, or incomplete), so a later green on the same commit
   is not undercut by an earlier failure. A run that fails before it has a
   commit to gate (a refused policy, unreadable notes, an unresolved branch)
   publishes no check run, so it fails the workflow job instead. That failed
   job is a red check run on main's head, so release-cut refuses that commit
   until a later release-gate run on it succeeds (release-cut reads the
   latest check run of each name).

**What release-cut reads.** A GREEN release record on a commit counts as
gated, the same as a successful `main-backstop` check run. A RED record
with no GREEN record on a later commit that contains it holds every cut, like a
queue freeze: the `REFUSED` line names the red sha and cases. Land the revert
or the fix-forward, then gate again with `gstack-release-gate run
--ignore-cadence` (or dispatch the workflow). Nothing else clears a hold.

**The per-push backstop stands down.** `evals-main-backstop.yml` keeps its
push trigger. While the block is set, its policy step reports `train=false`,
so a push dispatches no gate, freezes nothing and publishes no check run. Main
is never gated twice. Trains keep running until the train lane retires them.

```bash
gstack-release-gate run [--dry-run] [--sha <sha>] [--ignore-cadence]
gstack-release-gate status     # the newest record, the hold if any, pending commits
gstack-release-gate bisect [--sha <sha>] [--spend-cap <usd>] [--dry-run]
```

Common flags: `--repo`, `--policy <file>` (read the block from a file instead
of main, for a dry run or a proof before adoption), `--remote`,
`--summary`, `--outputs`, `--poll-seconds`, `--budget-minutes`. Every line
starts with `RELEASE:`. Exit 0 means gated, skipped, inert or a dry run; 1
means held (red), failed, incomplete or a refused policy; 2 is a usage error.

**Escape hatch.** Remove the block on main. The per-push backstop gates the
next push again, and release-cut reads its check runs as before.

<a id="ship"></a>
## What `/ship` reads from it

`/ship` Step 3 runs `show-effective --base <base>` and follows its `ship:` lines,
which carry the workflow consequences the skill prose would otherwise spell out:

| Line | Effect |
|---|---|
| `ship: history merge-only: …` | never rebase, squash or force-push; `check-history --plan <merge\|squash\|rebase>` refuses a rewrite plan (`HISTORY_POLICY_VIOLATION`, exit 3) |
| `ship: queue_mode stamp-at-merge: …` | Step 12 items 1–4 are replaced by `gstack-restamp --next --base <base> --pr <n> --expect-base <sha>` when the PR is next, `--after <predecessor-pr>` when it is not; the restamp's own `next:` line says what follows: under `stamp-at-merge`, `commit and push only the stamp diff above (FILES), with no edit of your own` and the merge's expected head (the stamp commit holds restamp's output alone); under the per-PR queue, NEW_VERSION and the CHANGELOG entry text |
| `ship: shared merge queue: …` | in a coordinator-run queue, `gstack-ship-queue ready`, `gate-ahead` and `stamp` replace the restamp calls; see [Run a shared merge queue](#run-a-shared-merge-queue) |
| `ship: gate-ahead: …` | with `.gstack/tmp/gate-ahead.json` present, Step 16 reuses only the lanes `gstack-tree-receipt … --json > .gstack/tmp/tree-receipt.json` marks reusable; stamp-sensitive and not-eligible lanes run live; `--force-gate <reason>` is the coordinator's call |
| `ship: bump patch: …` | Step 12 never asks for MINOR or MAJOR; PATCH or MICRO by size |
| `ship: bump never: …` | Step 12 prints `VERSION: <v> kept (policy: bump never; no write)`, asks nothing and refuses `--bump`; a branch that moved VERSION stops until it is put back |
| `ship: bump ask: …` | Step 12 asks for MINOR and MAJOR; on FRESH, `--keep-current` (or `--version <current>`) keeps VERSION, and in a session no person answers any version Step 12 would write waits for `--answer` |
| `ship: preregistration: …` | `gstack-evidence ancestor --from-policy --base <base>` must print only `ANCESTOR: ok` before push |
| `ship: release_tool: …` | the command runs only inside `gstack-restamp` (staging worktree, outputs confined to `release_outputs`) |
| `ship: review_scope …` | Step 9.4 item 0 runs `gstack-review-scope classify` on each pass's findings; see [review_scope](#review-scope) |
| `ship: changelog_fragments <dir>: …` | Step 12 writes no version; Step 13 writes the entry as `<dir>/<branch-slug>.md` (entry text only, `bump:` front matter only when the change warrants more than the policy bump), never an `[Unreleased]` section, linted with `gstack-prose-lint <file> --gate`; `gstack-ship-queue land` assigns the version; see [changelog fragments](#changelog-fragments) |

The ship receipt (`gstack-ship-receipt write … --body`) goes in the PR body's closing Agent notes
section, written by the pr-body section of `/ship` after the body is composed. A body from before that
layout keeps its receipt at the top. That receipt is still read while it opens the body, also after the
body gains an Agent notes section with no receipt in it; once an edit or a post puts an opening paragraph
above it, it is no longer read, and the pull request needs a fresh receipt. A receipt posted on its own
with `gstack-post pr-body` to a body that has the section replaces the receipt inside it. In a body with
the section, a receipt block quoted in the readable part stays where it is and is never read as the
receipt; a body without the section is read whole, so there a quoted block can be read as the receipt.

<a id="ship-receipt"></a>
## The ship receipt

The ```` ```gstack-ship-receipt ```` block is the handoff record: identifiers
first (`pr`, `head`, `version`, `base`), then the evidence (`gate`, `ci`,
`head_tree`, `product_patch_id`, `gstack_version`, `review_depth`, `pregate`,
`issues`, `approval`, `docs`, `review_loop`, `review_loop_exception`, `design`,
`carry`, `no_stop`), validated
against the `ship-receipt` schema (`gstack-artifact schema ship-receipt`) and
read back by `gstack-ship-receipt read`, `result`, `carry` and the queue.

**`version`.** The version source at HEAD: the path `.gstack/version-path`
pins, else `VERSION`, else `package.json#version`. A repository with none of
those, none of the policy's `stamp_files` and no CHANGELOG (the policy's
`changelog`, or `CHANGELOG.md`) at HEAD has no release version to record, and
the receipt says so with `"version": "none"`: `/ship` Step 12 printed
`Version bump: skipped (no version source: <what was looked for>)` and Step 13
`CHANGELOG: skipped (none at <path>)`, the PR title carries no version prefix,
and `read`, `result`, `gstack-ship-queue ready`, `train build` and `verify
--train` accept the receipt like any other. A repository that has a CHANGELOG
but no version source records no `version` at all (the audit still says what
it looked for); pass `--version` to name one.

**`design`.** On a rendered-UI diff (`gstack-diff-scope` reports
`SCOPE_FRONTEND=true` for the committed range, which counts CSS, views,
components and, since GST-1718, Lit or htm tagged templates in .ts/.js files
whose changed lines sit inside a tagged template or carry markup), write records
`{ "mode": "static", "reason": "no preview declared" }`: /ship ran only the
static design-lite check, and the PR body's `## Design Review` line says the
same. It is advisory and nothing refuses on it. Other diffs record no
`design` field, and receipts written before it stay valid. A carry copies it
unchanged.

**`docs`.** Step 14.5's outcome, from `gstack-ship-receipt write --docs
<json|@file>`: `{ status: updated | current | blocked, scope, exception? }`,
where `scope` names the docs roots the audit covered and `exception` is
`{ accepted_by, date, via, reason }`, the owner's acceptance of a risk the
audit could not clear. A `blocked` status with no exception is
[`DOCS_AUDIT_BLOCKED`](troubleshooting.md#docs-audit-blocked) and nothing is
written: only the owner accepts a documentation risk, so an unattended run
stops there. With `--body`, the body's `## Documentation` section must carry
the exception word for word (`Documentation exception: accepted by <owner>
<date> via <ref>: <reason>`), or the write refuses with the same code. Doc
caps: a repository declares `docs.caps: [{ path, max_bytes }]` in its policy,
and Step 14.5 runs `gstack-ship-receipt docs-caps --base <base>` before the
verification gate, reading the caps from `origin/<base>`'s policy so the branch
cannot raise its own (`--policy <file>` only while bootstrapping a policy; an
unreadable base policy is `POLICY_SOURCE_UNAVAILABLE`); one
`DOCS_CAP: <path> <bytes>/<max> ok|over` line per cap
(`absent/<max> over` for a path the tree lacks), exit 1 on any `over`, whose
repair is trimming the file, never raising the cap in the same PR.

**`review_depth` and `gstack_version`.** `write` records the gstack release
that wrote the receipt (its `VERSION` file, never the newer policy-key version
an unstamped tree reads policies as) and the review depth at the checked-out head
([review-policy.md#review-depth](review-policy.md#review-depth)):
`{ depth, class, runtime_lines, rules, base, registry, gate_scan: { tagged, head }, reasons, risk, mode }`
(`mode` is lean, panel or platform; `declared` and `detected` appear with `write --declare-risk`, and the platform depth adds `platform_review`, see [review-policy.md](review-policy.md#review-depth)),
computed from git objects for the range against `origin/<base>`
(`gstack-diff-scope <base> --head <sha>` for the scope signals), with the gate
scan run on that head. `--head` must be the checked-out HEAD
(`RECEIPT_INVALID` otherwise), so the record and `head_tree` describe the
tree the review read; tracked edits in the checkout make the scan unavailable,
which records `full`. `gstack-ship-queue ready` and `train build` recompute
the depth the head needs from the same range and scope and print `REVIEW_DEPTH: receipt=<d> required=<d>
runtime_lines=<n> class=<c> reasons=<…> inputs=base@<sha>,registry@<sha>,gate_scan@<sha|missing>`;
a recorded gate scan counts only when its `head` is the full bound commit,
otherwise the scan is unavailable and the head needs `full`. A receipt below the required
depth, or one whose writer records `gstack_version` but no `review_depth`, is
[`QUEUE_RECEIPT_DEPTH_RAISED`](troubleshooting.md#queue-receipt-depth-raised):
the receipt is left unchanged and the fix is /ship on that head. A receipt with
neither field predates depth receipts and is accepted as legacy. A carry
recomputes the depth at the new head, rebinds the gate scan, and refuses when
the new head needs a deeper review than the receipt records (a test change that
skips a test raises the diff to gate class), when `--head` is not the
checked-out HEAD, when the receipt records `gstack_version` without
`review_depth`, or when an owner exception no longer stands, each as
[`RECEIPT_CARRY_REFUSED`](troubleshooting.md#receipt-carry-refused).

**`no_stop`.** The routine stops the run recorded and went on past, from
`write --no-stop <json|@file>`: an array of `{ class, reason, evidence }`, with
`class` one of the five no-stop defaults. /ship passes the branch's
`gstack-no-stop` ledger here ([review-policy.md#no-stop](review-policy.md#no-stop)).

**`review_loop_exception`.** The owner's acceptance of a stop after a
fix-check edit under frozen scope (#3559), from `write --review-loop-exception
<json|@file>`: `{ accepted_by, date, via, reason, fix_check: { head, findings[, files] } }`.
It needs `--review-loop` with `fix_checks` of 1 or more, a `fix_check.head`
that is the receipt head or its ancestor, and, with `--body`, the line
`Review-loop exception: accepted by <owner> <date> via <ref>: <reason> (fix-check at <sha12>, <n> findings)`
word for word. A stop after the second full pass that left a finding open
(TRUT-7) takes `second_pass: { head, deferred: [<finding id>] }` in place of
`fix_check`, with `--review-loop` counting 2 or more passes and 1 or more
deferred, and the line ends `(second full pass at <sha12>, deferred <ids>)`;
finish does not take it, since it accepts an open finding, not edits. Otherwise
[`REVIEW_LOOP_EXCEPTION_INVALID`](troubleshooting.md#review-loop-exception-invalid)
and nothing is written. The queue checks both owner exceptions the same way
before READY and train build: the record must parse, the body must still
carry its line, and the exception's head (the fix-check's or the second
pass's) must be the bound head or its ancestor (after a carry across rewritten
history the old commit is off the branch, so that check is skipped), or the receipt is
[`QUEUE_RECEIPT_EXCEPTION_INVALID`](troubleshooting.md#queue-receipt-exception-invalid).

**Prose against the receipt.** `gstack-ship-receipt read --pr <n> --check-prose`
(or `--body <file>`) compares every counter the body quotes with the receipt's
integers under `review_loop`, `gate` and `ci`: `passes=2`, `passes: 2` and
`2 passes` are claims about `review_loop.passes`, `1 deferred` about
`review_loop.deferred`, `passed: 41` about `gate.passed` (a leaf key shared by
several counters, `passed` under `gate` and `ci` or `pass` under every gate
lane, matches when the number equals any of them; an underscore in a key
matches `_`, a space or `-`; a name inside a longer word, `3 pass-through`, is
not a claim; a number that is the value of a `key=` or `key:` pair is that
key's claim alone, so `passes=2 blocking_found=1` is two claims, never a
`2 blocking_found` one, #3513). A body that quotes a different number is
`RECEIPT_PROSE_MISMATCH` (exit 1) and the `PROSE:` line names each field with
both values; prose that quotes no counter is not a claim. The `## Approvals`
block `gstack-approvals` renders (its heading, the Date | Asked | Exact words
table and the `Source: gstack-approvals record` line) quotes the owner's
words, not this PR's numbers, so it is skipped: "one Step 11 pass" in that table
is not a `pass` claim. Text you write under the heading after that block is
still checked. The `Review-loop exception: …` line (GST-977) and the
`Documentation exception: …` line (GST-983) the receipt's own exceptions
require are skipped the same way: they quote the owner's reason, so "outside 1
and 2 skip detector" is not a `2 skip` claim. Only a line that matches the
rendered line exactly is skipped; the same words inside a longer line are still
checked. A closed code fence is skipped too (GST-984): pasted test output
("113 pass, 0 fail") and quoted code are evidence, not this PR's counters, so
put a count you mean as a claim outside the fence. A line like ```` ```npm test``` ran ````
opens no fence, and a fence that never closes stays prose, along with the rest
of the body. Data PRs (evals,
measurements, sweeps) run it before READY so the body's numbers are the run's.

<a id="review-exclude-paths"></a>
## `review_exclude_paths`: what reviewers leave out

Since the release that added it (`REVIEW_EXCLUDE_KEY_VERSION` in
`lib/ship-policy.ts`). A results PR can carry thousands of receipt files that
no reviewer needs to read. `review_exclude_paths` lists git glob pathspecs
whose content files `/ship`'s reviewers leave out:

```json
{ "review_exclude_paths": ["receipts/**"], "min_gstack_version": "<the release that introduced review_exclude_paths>" }
```

**Read from the base only.** `gstack-review-plan` reads the policy committed on
the base commit it already resolved (`origin/<base>`, or `<base>`), never
the branch's copy, so a branch cannot exclude its own files. A branch that adds
the key gets `REVIEW_EXCLUDE: none (head sets review_exclude_paths; it applies
after it lands on <base>)` and a normal review. A base policy that does not
validate stops the plan (`POLICY_INVALID`), and a base git cannot read stops it
(`POLICY_SOURCE_UNAVAILABLE`); neither turns exclusion off quietly.

**Git's glob dialect.** Each pattern is a `:(top,glob)` pathspec: root-anchored
and case-sensitive. The matched set comes from git itself (`git diff --raw -z`),
so the plan, the receipt and what readers see are one set. Untracked files are never part of it: no reader's `git diff` shows them, and the receipt reads the committed head.

| Pattern | gitignore would match | `review_exclude_paths` matches |
|---|---|---|
| `receipts/**` | everything under `receipts/` at any depth | everything under the top-level `receipts/` |
| `receipts/*` | files directly in `receipts/` | files directly in `receipts/` only (`*` never crosses `/`) |
| `data/` | any `data/` directory at any depth | nothing: write `data/**` (and `**/data/**` for any depth) |

A pattern that matches no changed file is listed as `unmatched=` on the plan line.

**What is excluded, and what is kept.** A matched file is excluded only when it
is content: a data file (JSON, JSONL, CSV, TSV, images), a docs-class file, a
`.log` file, or a binary file: one git reports as binary (`-\t-` in `--numstat`; readers would only see `Binary files differ`) under the branch's attributes or with no attributes from the tree, so a branch's `.gitattributes` cannot make an executable read as text, and whose bytes hold a NUL in their first 8,000, so it cannot make a text file binary content either. A binary file is content only under a known content extension (images, fonts, media, documents, compressed archives, `.bin`, `.dat`, and data blobs such as `.parquet`, `.npy` or `.sqlite`) and only when its bytes do not start with an executable image's magic (ELF, Mach-O including universal binaries, PE, WebAssembly, `#!`). Under those rules it is content even under
`config/` or in a skill directory, and only `policy-dir`, `gate-path`, `executable`, `link` or `gate-tagged` keep it. Every other binary file is `code`: source with a NUL, a native library (`.node`, `.so`, `.dylib`, `.dll`), a compiled executable, a key store, a pickle, or a file with no extension.
Everything else stays in every reader's diff with one reason code:

| Reason | Kept because |
|---|---|
| `policy-dir` | it is under `.gstack/` or `.github/` |
| `gate-path` | it is a gate path (lib/review-depth.ts), such as `lib/review-exclude.ts` or `lib/default-base.ts` |
| `executable` | its old or new mode is executable |
| `link` | its old or new mode is a symlink or a submodule commit |
| `agent-prose` | it is a skill, section, resolver, template or rule file |
| `config` | it is a data-shaped config file (`package.json`, `tsconfig*.json`, `manifest.json`, `config/`, dotfiles, `scripts/harness-pins/`) and no pattern names it by file name: a pattern whose last segment is the file's exact name with no glob character (`docs/benchmarks/*/results*/**/manifest.json`) makes a matched data file content, so it is excluded and names nothing; a broader pattern (`results/**`, `**/*.json`) keeps it |
| `gate-tagged` | the gate scan tagged one of its hunks |
| `code` | it is code or a test, not content; a binary file outside the content extensions above, or one with executable magic, counts as code |
| `secret-line` | an added line names a credential (the targeted pass's secret rule, or a key name given a value such as `OPENAI_API_KEY=`) and carries a value: the credential scan finds a secret on the line, or a run of 20 or more base64 or token characters mixing upper case, lower case and digits follows a name within 200 characters. A line that only names a variable or a credential store (`${OPENAI_API_KEY}`, `$GH_TOKEN`, `process.env.X`, `os.environ["X"]`, a keychain command) keeps nothing (GST-1967: harness-evals #333's captured prompts kept 2,610 files that way). For a file git calls binary only because of its attributes, the added lines come from `git diff --text`, which `.gitattributes` cannot change (readers' own diffs still follow the attributes and show the kept file as binary). When this is the only reason, pass readers get an excerpt, not the whole file ([secret-line excerpts](#secret-line-excerpts)) |
| `named-by-code` | a code or test file that stays in review (not docs, a data file, a `.log` or binary, and not itself excluded) names its full repository path, at the head or the merge base |
| `consumer-scan-unavailable` | the `git grep` for those names failed, so every candidate is kept; also a live binary file whose bytes could not be read, and a text file with changed lines the collector read no lines for |
| `gate-scan-unavailable` | the gate scan failed or did not run at the head, so no hunk's tag is known and every candidate is kept |

Only a full path counts as a name. A basename such as `result.json` would keep
every receipt in the tree, and a directory reference such as `receipts/` (the
harness that writes the receipts names it) keeps nothing: the plan prints an
informational `REVIEW_EXCLUDE_REFERENCE:` line naming the code that reads the
folder. A data file never keeps another file: a results manifest such as
`docs/receipts-manifest.json` lists every receipt by full path, and it is
content, not a program that reads them. The name scan is an uncapped `git grep -F -f` of the candidates'
paths over the consumer files alone (the head's and the merge base's trees filtered to code and tests and written into a
scratch index that one `git grep` per tree reads), never the data under the patterns, so its cost follows the code a results PR
can be read by and not the receipts it adds (GST-1435), and its git calls stay the same however many files the tree holds
(GST-1442); it is not the collector's capped consumer scan.

**What readers run.** Every reader's `DIFF_CMD:` gains one
`':(top,exclude,glob)<pattern>'` item per applied pattern, and the fixture
command the security specialist, the Red Team and the native adversarial pass
read through gets the same items. A git exclude beats any positive pathspec, so
kept files under an applied pattern come back through a second command,
`DIFF_KEEP: <reader> git diff <diff-base> -- ':(top,literal)<path>' …`, which every
brief names. That command is bounded by its argument bytes (24,000 across all
patterns, under Windows' command-line limit): a pattern whose kept files would
pass the bound is not applied, and the plan line says so as
`skipped=<pattern>:kept=<n>:bytes=<b>`. Files that reach readers as
[secret-line excerpts](#secret-line-excerpts) are not on that command, so they
do not count toward the bound, and gstack reads them in git calls of at most
24,000 argument bytes each (GST-1967). Every brief also gets one line:
`Excluded by base policy <ref>@<sha12> (selection <digest>): <n> files, <bytes> bytes
on this branch matching <patterns>. They are not in your diff; do not report on
their absence.`

<a id="secret-line-excerpts"></a>
**Secret-line excerpts (GST-1447).** A kept file whose only reason is
`secret-line` (under an applied pattern, not named by code, with the gate scan
and the name scan both read) is left out of `DIFF_KEEP:`, and
`gstack-review-dispatch pass` gives its readers an excerpt instead: every changed
line the secret-line rule matches or the credential scanner finds a secret-shaped
value on, with up to 3 lines of context, the path and the match counts. A line
over 400 characters shows 160 characters on each side of each match. The excerpt
is read with `git diff --text`, written once beside the briefs, and each brief
names its file, bytes and sha256; the outside voice's supplied diff ends with it.
Only the excerpt counts toward the review ceiling. The plan prints
`REVIEW_EXCLUDE_EXCERPT: <n> kept files …` when any file qualifies. Building
it fails closed per file: a section it cannot tie to its path, one with no
matched added line, and one whose hunks or scanner result cannot be read (a
single changed line over the scanner's 1 MiB cap, for example) go to the reader
whole through its keep command. Results PRs that capture model requests need
this: their system prompts name `${…_API_KEY}` variables and keychain commands
(harness-evals #269: 75 such files, 12.9 MB whole).

<a id="one-selection-every-reader"></a>
**One selection for every reader (GST-1476).** Every path that renders a
reader's brief builds its diff from the same selection: the policy's
`:(top,exclude,glob)` items, the readers policy's `forbid_paths`, the kept files
and the secret-line excerpts. That covers the pass manifest's stages, a fresh
pass after a failed reader, and a standalone `gstack-review-dispatch render` (a
reader rendered on its own, or rendered again after a failed dispatch). A
standalone render reads the selection from `gstack-review-plan --json` when the
base may declare `review_exclude_paths`, adds whatever its `--exclude` and
`--keep` lack, writes the excerpt beside the brief and carries the disclosure
line, so its ceiling check counts the same bytes as the pass's readers. A plan
that fails stops the render. Before this, the Red Team's own render on
harness-evals #269 counted the whole 30.3 MB diff while the pass's readers read
2 MB.

**Depth, numbers and the targeted pass.** Excluded paths count as docs for the
review depth everywhere it is computed (`gstack-review-plan`, the receipt
writer, carry and the queue), and their lines never trigger the numeric-claim
scan or the targeted money, gate, auth and secret classes. Defects inside a
correctly excluded data file are coverage the owner gives up by policy.

**The plan line.** `REVIEW_EXCLUDE: patterns=<applied>/<declared> excluded=<files>
bytes=<b> kept=<k> content=<kind>:<n>,… source=<ref>@<sha12> digest=<sha256>`
(`content=` counts the excluded files by kind: `binary`, `data`, `docs`, `log`), then up to 20
`REVIEW_EXCLUDE_KEPT: <reason> <path>` lines (`--json` lists every one). A
repository with no key anywhere prints none of these lines, and its plan, briefs
and diff commands are byte for byte what they were.

**The receipt, carry and the queue.** Each rendered brief records the digest it
names in the review ledger, and `gstack-review-dispatch verify` prints
`REVIEW_EXCLUDE_RECORD: digest=<d>` when every reader's newest brief names the
same one (a mixed set makes it `VERIFY: dirty`). `gstack-ship-receipt write
--review-exclude <d>`, with that digest, records `review_exclude` (source, patterns, counts, the gate-tagged kept
paths and three hashes). The `digest` hashes the declared patterns and the
excluded and kept lists; `source` is provenance only. Write, carry and the queue
each recompute the digest at the current base and compare it (the queue fetches
that base first), over the PR's own files: the diff from the head's merge base
with that base, never a two-dot diff against the base tip, so a base merge
or a moved base that leaves the patterns and the lists unchanged still carries
and binds. A different digest means the digest write was given (or the receipt recorded) names another selection than the head has now:
write refuses with `RECEIPT_INVALID field=review_exclude`, carry with
`RECEIPT_CARRY_REFUSED review_exclude changed`, and the queue with
`RECEIPT_INVALID field=review_exclude expected=<digest> recorded=<digest>`. The
fix is to rerun the review and write with the digest its `verify` prints. Write
checks the digest against the base policy, so a stale selection cannot be
recorded by accident, but it does not read the review ledger: a write given the
`expected=` digest passes without a review, and only the review run shows that
the reviewers read that selection.
Write, carry and the queue make one exception (GST-1408, GST-1415, GST-1434, GST-1446): when the digests differ but the recorded selection and HEAD's give the PR's files the same selection, meaning the same applied patterns, the same excluded files and the same kept files with their reasons, write records HEAD's digest, carry carries the receipt and records HEAD's digest, and the queue (`ready`, train build, land) binds it. So a pattern the base gains, adds, removes or reverts that changes nothing about the PR's files does not void the review. No recorded selection (`none`) counts as the empty one. A receipt's record counts only when its digest is built from its list hash. Write gets only a digest, so it rebuilds the recorded selection: the digest binds when the `review_exclude_paths` the base held at some commit that changed the policy file, combined with HEAD's list hash, gives that digest. It prints `REVIEW_EXCLUDE_POLICY_MOVED:`. A digest no such policy gives, an omitted `--review-exclude`, a selection that differs over the PR's files and an unreadable base policy still refuse.
Write makes one exception for Step 14.5's docs audit, which runs after the review (GST-1429): with `--docs-post <audit-id>-post.json` it accepts the reviewed digest when that digest is HEAD's selection with every file under a pattern that changed since the snapshot's HEAD reset to it, each such file is uncommitted in the snapshot with the content HEAD holds, each is excluded or kept only because code names it, and every other file is excluded or kept alike on both sides. With `--docs-pre <Prepare snapshot>` only the files whose content changed between the audit's two snapshots reset, to their Prepare content, so uncommitted docs the reviewers read stay as they are; content compares as git stores it or as it checks out (autocrlf, filters). It prints `REVIEW_EXCLUDE_DOCS_AUDIT:` and records HEAD's digest. Any other change to the selection, an audit file the exclusion keeps for another reason, an edit after the snapshot and a missing or unreadable snapshot still refuse. When one `/ship` run audits twice (a re-audit after a base merge and restamp), every snapshot names the run (`--run <invocation record>`), each post snapshot names its Prepare snapshot (`--pre`, recording the files the audit edited), and the re-audit's post snapshot carries the earlier one (`--carry <earlier -post.json>`; GST-1616). Write then also resets each file an earlier audit of the run edited, to its content before that audit, when HEAD (or the re-audit's Prepare snapshot) holds what the audit left; a file no audit edited still refuses, and a carried audit of another run is refused by the snapshot and by write.

**Adopting it.** (1) Open a PR on the base that adds the patterns and
`min_gstack_version` at least `REVIEW_EXCLUDE_KEY_VERSION`, and ship it like any
policy change. (2) Once it merges, bring the base into the results branch (a
crew needs its coordinator's word for that merge) and rerun `/ship`; the plan
prints `REVIEW_EXCLUDE:`. (3) Check the kept list: a file you expected to be
excluded names its reason.

<a id="review-diff-ceiling"></a>
**The review ceiling.** Independently of the key, `gstack-review-dispatch` reads
each reviewer's diff once before it writes a manifest or a brief (`pass`, `stage`
and `render`). A diff over 2,000,000 bytes (about 500K tokens) stops with
[`REVIEW_DIFF_TOO_LARGE`](troubleshooting.md#review-diff-too-large), exit 3, and a
fix chosen by where the policy stands; a `git diff` that fails or runs past
120 seconds stops with
[`REVIEW_DIFF_UNREADABLE`](troubleshooting.md#review-diff-unreadable), exit 1.
There is no override flag: the recovery is a policy PR on the base, or a split.

<a id="readers"></a>
## `readers`: what reviewers may not fetch or open

Since the release that added it (`READERS_KEY_VERSION` in `lib/ship-policy-keys.ts`).
Every reader brief already carries the fetch rule. It says to review only this
checkout and its local git history, and never to clone, fetch or download another
repository, dataset or archive ([review-policy.md](review-policy.md#what-readers-may-fetch)).
A repository that holds sealed data adds what no reader may reach at all:

```json
{ "readers": { "forbid_fetch": ["github.com/example-org/beam", "huggingface.co"], "forbid_paths": ["sealed/**"], "brief_note": "sealed/ is custody: never read plaintext." }, "min_gstack_version": "<the release that introduced readers>" }
```

- `forbid_fetch`: lowercase hosts (`huggingface.co`, subdomains included) or
  `host/owner/repo` (`github.com/example-org/beam`, with or without `.git`). Every
  brief names them, and web page reads under them are forbidden too.
- `forbid_paths`: git glob pathspecs in the `review_exclude_paths` dialect. They
  are cut out of every reader's diff as `:(top,exclude,glob)` items, the outside
  voice's embedded diff included, and are never kept back the way
  `review_exclude_paths` keeps code. Every brief says not to open them.
- `brief_note`: one line of at most 400 characters that every brief carries,
  for example a custody note. A credential-shaped note is `POLICY_INVALID`.

**Read from the base.** `gstack-review-plan` reads the policy on the base commit
it resolved and adds any `forbid_fetch` entry the head's policy adds, so a
branch can tighten the rule and never loosen it. The head's `forbid_paths` and
`brief_note` are ignored: a path the head adds would cut the branch's own code
out of its review, and its text would reach every brief. A directory pattern
(`sealed`) covers every file under it, as in git. An invalid base policy stops the plan
(`POLICY_INVALID`), and so does a base git cannot read
(`POLICY_SOURCE_UNAVAILABLE`). The plan prints `READERS: default (fetch rule
only)` or `READERS: forbid_fetch=<n> forbid_paths=<n> note=yes|no head_added=<n>
digest=<d>`, and every brief's ledger event records the digest.

<a id="review-scope"></a>
## `review_scope`: how the review loop converges

Since the release that added `review_scope` (`REVIEW_SCOPE_KEY_VERSION` in
`lib/ship-policy.ts`). `/ship` Step 9 runs the pre-landing review in passes and fixes
what it finds between them ([review-policy.md](review-policy.md) is the canonical
statement). Under `review_scope: frozen` (the default) the loop converges by
construction:

1. **Pass 1 reviews the whole diff.** Every finding goes through
   `gstack-review-scope classify --base <base> --pass 1 --findings <file>`, which
   gives each one a `locus` (`diff`: a hunk the PR changed, with three lines of
   context; `outside`: anything else), a `kind`, `blocking` and a `scope`.
   `blocking` is a CRITICAL defect: a test that would fail, a production break, a
   security or data-loss defect. Everything else (an advisory, an informational
   item, a test gap, a wording note) is below the floor. Pass 1 fixes findings in
   the diff (`scope: fix`). A blocking finding in code the PR did not change is
   `scope: defer`: `gstack-review-scope defer` records it for the PR, files no
   issue, and `render` writes it under `## Deferred findings` in the PR body, which
   goes through the PR body's publication scan. Below-floor findings outside the diff,
   every below-floor finding from pass 2 on, and every below-floor finding from
   Step 11's voices or a fix-check (`raised_by` `adversarial-native`,
   `outside-voice` or `fix-check`, even classified at `--pass 1`) are
   `scope: note` and go under `## Review notes` in the PR body.
2. **Pass 2 and later review the range since the previous pass.** Each pass saves
   `PASS_HEAD`; the next pass sets `RANGE_BASE` to it, diffs `RANGE_BASE..HEAD`
   for every reviewer (the core checklist, specialists, Red Team, the outside
   voice; the gate scan and QA probes keep the whole candidate) and classifies
   with `--range-base <sha>`. Only a blocking finding in that range (`locus:
   fix-range`) or in the diff is `scope: fix`; nothing below the floor earns a
   pass. `NO FINDINGS` is the expected reviewer result for a clean range, never a
   failed review.
3. **Two rounds is the cap** (R51), stepped by the
   [transition table](review-policy.md#transitions); a full pass, a
   [scoped pass](review-policy.md#scoped-pass) and a fix-check each count as a round. A pass that applied no edits
   continues to Step 10: the loop ships with its deferred and noted items named in
   the PR body. A blocking finding still open after the last allowed step stops
   the run and names the finding (path, severity, problem) for the owner instead
   of a third round; the owner may grant one scoped fix-check.

<a id="ruled-notes"></a>
**Ruled notes (GST-1537).** R51's other answer to an open finding is the owner's
ruling that it ships as a disclosed note, with the note listed. The owner records
each ruling, one finding per row, through the approval record, outside the lane's
/ship run, naming the stop head it ruled at (the commit a `review_loop_grant` names):

```bash
gstack-approvals rule --finding '<the finding's fingerprint>' --head <stop head> \
  --reason '<why it ships as a note, one line>' --words '<the owner's exact words>' --by '<who ruled>'
```

The row is an approved `gstack-approvals` row with scope `ruled_note <fingerprint> <head>`
and ask `ruled_note <fingerprint> at <head>: <reason>`, with the head's full sha, so
two findings ruled with the same reason in one reply get two rows, and a ruling at
a later head is a new row. Its `by` is the ruler and its `recorded_at` the time.
`rule` refuses a `--head` that is not a commit in the repository, a reason with a
newline or control character, a `--by` naming gstack, and any ruling while this
checkout holds an open /ship run's marker (the lane's own runner). `add` refuses a
`ruled_note` scope, so `rule` is the only path. A review-log field never makes a
ruling: `ruled`, `action: "ruled"` or any other claim the lane writes on its own
row is ignored. Step 16's `finish` reads the branch's rulings
(`lib/ruled-notes.ts`) and prints each as `RULED_NOTE: <fingerprint> at <head12>
ruled by <who> at <time>: <reason> (approval <id>)`. A ruling closes a finding on
a `review-fix-check` row finish counts (the newest, or an earlier link of its
[chain](#fix-check-chain); action `open`, `skipped`, `noted` or `deferred`, not a
gate finding) when its head lies inside that row's `range_base..commit`, the same
test a `review_loop_grant` passes. So the order of ruling and fix-check doesn't
matter, and a ruling made at an earlier /ship's head closes nothing: its
`RULED_NOTE:` line ends `(outside this fix-check's range; not applied)`. A granted
fix-check whose other findings are all below the floor then reads CURRENT and
counts. That includes the usual order, where the fix-check finds a new CRITICAL,
logs it `open` with `converged:false` and stops for the owner, and the owner rules
afterwards: the row's `incomplete` binding still names the one tree it read, so
once every blocking finding on it is ruled it binds at that tree as a clean read
(harness-evals#361, GST-2251). A CRITICAL with no ruling stays open, and while one
does, finish prints `FIX_CHECK_OPEN: <fingerprints> on the fix-check at <commit12>`
naming the `gstack-approvals rule` command for each
([troubleshooting](troubleshooting.md#fix-check-open)). A review-loop exception is
not a ruling: it accepts edits after a fix-check, never the fix-check's own
findings. Nothing ruled is hidden:
`gstack-approvals rulings` prints one `Ruled note: …` line per ruling for the
Pre-Landing Review and the PR body, `gstack-ship-receipt write` records them as
`ruled_notes` (each with its `head`) and refuses a `--body` that does not carry each
line word for word, and the READY block prints each as `RULED_NOTE:`.

<a id="gate-dispositions"></a>
**Gate dispositions (GST-2491).** A ruling never closes a gate finding (a loosened
gate the review logged with a `gate` tag and the hunk identity `gate_id`). In an
interactive session the human answers `review-gate-disposition`; in an unattended
one `gstack-review-log` logs every gate finding `open`, and the log stays so. When
the owner approved the gate change, the owner's answer goes through the approval
record instead, recorded outside the lane's /ship run at the stop head, one finding
per row:

```bash
gstack-approvals gate --finding '<the gate finding's fingerprint>' --gate-id <its gate_id> --head <stop head> \
  --reason '<the gate change, one line>' --words '<the owner's exact words>' --by '<who recorded>'
```

The row is an approved `gstack-approvals` row with scope `gate_disposition
<fingerprint> <gate_id> <head>`, ask `gate_disposition <fingerprint> <gate_id> at
<head>: <reason>` and the owner's words in `words` (`lib/gate-dispositions.ts`).
`gate` refuses a missing `--gate-id` (or a literal `undefined` or `null`), empty
`--words`, a reason, words or `--by` with a newline or control character (each is
trimmed first), a `--head` that is not a commit, a `--by` naming gstack, a row that
`dispositions` would not list (a head that is not 40 hex, for one), and any call
while a /ship run is open on the branch in any worktree of the repository: its
marker counts while its lease is open, the same test preflight uses, so a run parked
before finish stops counting once its 120-minute lease ends. It finds those worktrees
through the git common dir, and it checks and appends under a lock there that
/ship's preflight also takes to write its marker. `add` refuses the scope and
`--source gate`, so `gate` is the only writer. A row counts only when it has every
field `gate` writes: an approval-shaped id that its hash reproduces, `source: gate`,
`pending: none`, the store's own branch, `date`, `recorded_at`, `by`, one-line
`words` and a `digest` over those fields. The digest catches a row that was edited
or typed by hand. It isn't authentication: anyone who can read the code can compute
it. A gate finding with no `gate_id` is never closed, and a row gstack wrote is
ignored. A
disposition closes a gate finding only on a review row that carries that exact
fingerprint and `gate_id` and whose `range_base..commit` holds the head (a first
pass, with no `range_base`: its own commit), so a later, different loosening of the
same line (a new `gate_id`) stays open. Anything else closes nothing, and a
review-log field (`kept`, `reason`, `disposition`, `gate_dispositions` or any claim
the lane writes on its row) never makes one. `gstack-review-read` shows each closed
finding as `kept` with `reason: owner disposition <id>: <reason>` and
`disposition: <id>`, lists the ids in the row's `gate_dispositions` and grades the
row as if the findings were kept, so /ship's gate rules (`--blocking-open`,
`--gate-open`, the draft state, the `Gate edits:` counts) read them as kept once it
reads the row again. As with rulings, a row derived from a findings file
(`status_source: derived`) is not cleared. Nothing is hidden: finish prints each as
`GATE_DISPOSITION: <fingerprint> [gate <gate_id>] at <head12> by <who> at <time>:
<reason> — "<words>" (approval <id>)`, ending `(… not applied)` when no review row's
range holds it; `gstack-approvals dispositions` prints one `Gate disposition: …`
line each for the PR body; `gstack-ship-receipt write` records them as
`gate_dispositions` and refuses a `--body` that does not carry each line word for
word; and the READY block prints each as `GATE_DISPOSITION:`
([troubleshooting](troubleshooting.md#gate-finding-open-unattended)).

<a id="gate-disposition-acceptance"></a>
**Who authorizes a disposition.** A lane is a same-user agent, so it can still forge
a well-formed disposition row in its own approval store. What authorizes a
disposition is the lander's explicit acceptance: `gstack-ship-queue land --pin`
merges one only when the lander passes `--accept-gate-disposition <approval id>`
for it.

Land works the dispositions out again at the pin from the PR branch's approval
store: the local record and its mirror. A lander on another machine reads the
mirror the owner recorded into, so set `GSTACK_APPROVALS_DIR` to that directory
when it isn't the default. Land counts every disposition whose head the pin
contains. In a full clone, a row whose head commit is gone (the branch was
rewritten and garbage-collected, or the name reused) doesn't apply, because the
pin's history is all there and can't contain it. A pin missing from the clone
refuses, and so does a shallow clone that can't prove a row's ancestry: deepen it
with `git fetch --unshallow` and rerun. It never trusts the receipt or the PR body for this, because the lane
writes both. It prints each one as a `GATE_DISPOSITION:` line, then
`GATE_DISPOSITIONS: applied=<ids> accepted=<ids> store=<file>`. It refuses with
[`QUEUE_GATE_DISPOSITION`](troubleshooting.md#queue-gate-disposition), and merges
nothing, when an applied disposition isn't accepted, an accepted id isn't applied,
the receipt's `gate_dispositions` leave one out, change one or add one, or the PR
body lacks its `Gate disposition:` line. The review rows stay on the lane's
machine, so land can't tell which finding a disposition closed. It asks the lander
to accept every disposition the store holds for the pin, which is never fewer.

`gstack-ship-queue verify --pr <n> --pin <sha> [--accept-gate-disposition <id>]...`
runs the same check read-only (`pinAcceptance`, the function land calls), for a
lander that merges some other way, such as a REST merge pinned to the head. It
exits 0 only when every disposition is accepted. `ready` prints the same lines and
refuses the same receipt and body mismatches, but asks for no acceptance.
`gstack-ship-receipt write` refuses to write a receipt while a disposition applies
at HEAD unless `--body` carries each `Gate disposition:` line.

The receipt always records `gate_dispositions`, as an empty list when none
applies, and write refuses, writing nothing, when the store or git can't be read.
Land, verify and ready refuse when the receipt's set and the store's set at the pin
differ either way. A receipt id the store lacks usually means the lander reads
another `GSTACK_STATE_ROOT` or approvals mirror than the owner recorded into, or
that the row was removed. A git error while checking a head refuses too. A receipt
with no `gate_dispositions` field was written before receipts recorded it, and it
lands only when the store applies nothing. The receipt is written by the lane, like
every other gate signal it carries. The lander's acceptance guards against a
mistaken or missing store, not against a lane that falsifies its own receipt.

<a id="test-lane-exceptions"></a>
**Test-lane exceptions (GST-1595).** A lane `accept` carries from CI refuses with
`inventory_uncovered` when an inventory file is in no run's `tree.json`; when bun
hid it under an importing test file, the refusal says so
([pregate.md](pregate.md#carry-imported-tests)). The owner, never the lane, can
grant that the lane counts anyway at one pushed head, for exactly those files,
through the same approval record as a ruling:

```bash
gstack-approvals lane-exception --head <pushed head> --files <f1,f2> \
  --reason '<why, one line>' --words '<the owner's exact words>' --by '<who granted>'
```

The row is an approved `gstack-approvals` row with scope `test_lane_exception <head>
<files>` and ask `test_lane_exception at <head>: <files>: <reason>`
(`lib/test-lane-exception.ts`). `lane-exception` refuses a head that is not a
commit, a file with whitespace, a multi-line reason, a `--by` naming gstack and
any grant while this checkout holds an open /ship run's marker, and `add` refuses
the scope, so the lane's own runner cannot write one; a row by gstack is ignored
wherever it came from. `gstack-evidence record-ci` binds a grant only when its
head is HEAD and its files are exactly the uncovered set, and only after a local
preflight of each of those files, one at a time, with the lane's `per_file` runner
passes with a counted test at that head (a lane with no `per_file` runner cannot
use one). Grants are kept per head and file set (the newest wins), so two lanes at
one head each bind their own. Nothing about it is
hidden: `accept` prints `TEST_LANE_EXCEPTION: …` and names the body line in its
`NEXT:`, the receipt's `ci_carried` entry records `exception` (head, files, by,
reason, time, approval id and the preflight's label and test count),
`gstack-ship-receipt write --body` refuses a body that does not carry
`Test-lane exception: …` word for word, and the READY block prints each as
`TEST_LANE_EXCEPTION:`. A new push needs a new grant at the new head.

`gstack-review-scope summary --since <REVIEW_SINCE> --run <run dir>` reads the branch's review-log
rows for this invocation and its dispatch ledgers, and writes the counters the ship receipt carries
(`gstack-ship-receipt write … --review-loop @<file>`): `review_loop: { passes,
blocking_found, deferred, noted, fixed, scope }`, plus `fix_checks`, `dispatches`,
`est_input_tokens`, `unrecorded` and `ledgers_read` when the run recorded them, printed on the receipt summary
line as `passes=<n> blocking_found=<k> deferred=<m>`, so a scorecard can track
passes per PR.

The floor and the pass structure are stated once, in
[review-policy.md](review-policy.md); this section documents the knob.

`review_scope: diff-plus-blocking` is the documented fallback for a repository
where deferred findings pile up: the same passes and range as `frozen`, but a
blocking finding in code the PR did not change is `scope: fix` in this PR
instead of `defer`, and the loop stops at Step 9.4's third fixing cycle
(`CYCLES >= 3`): only `frozen` runs the review plan's two-round cap. `review_scope: all` is the opt-back to the earlier loop:
every finding is `scope: fix` on every pass, reviewers read the whole diff each
time, and only the three-cycle fix cap stops the loop. `show-effective` prints the choice as a `ship: review_scope …`
line, and the codes a refusal ends with are
[`REVIEW_SCOPE_INPUT`](troubleshooting.md#review-scope-input),
[`REVIEW_SCOPE_RANGE`](troubleshooting.md#review-scope-range) and
[`REVIEW_SCOPE_LEDGER`](troubleshooting.md#review-scope-ledger).

<a id="base-red"></a>
## `base_red`: pausing /ship on a red base

When the base branch is red for a reason outside the PR (Truther's #815/#818
pair each failed only on the other's broken cases), /ship's Step 5 used to fail
or ask the T3 triage question. With a `base_red` block on the base branch it can
prove the failure is the base's and pause instead:

```json
"base_red": { "setup": "bun install --frozen-lockfile", "select": "bun test {files}", "timeout_sec": 900 },
"min_gstack_version": "<the release that introduced base_red>"
```

`setup` installs dependencies in a scratch checkout (`null` when none are
needed); `select` is the lane command with a `{files}` slot that receives the
failing test files, shell-quoted; `timeout_sec` (10–7200) bounds each command.
`gstack-base-red classify --failures <evidence.json> --base <base> --pause`
reads the block from `origin/<base>` (a PR cannot declare its own) and calls a
failure base-red only when all of these hold:

1. The evidence names every failure the lane reported (`total` equals the
   number of `failures`), else `BASE_RED_UNNAMED`.
2. No failing test file, and no path of the PR's diff (`git diff --name-only
   <merge-base>..HEAD`) that a failure's signature names, is changed by the PR.
3. In scratch worktrees under the state root, `setup` then `select` fails at
   the base head and at HEAD, each output naming the same test id and the same
   first error line (digits and whitespace normalized). A setup that fails is
   `BASE_RED_REPRO_ERROR`.

Anything else is `IN_BRANCH` and /ship continues its usual triage, exactly as
without the block. A base-red run writes a pause record (`PAUSE: <file>` under
`$GSTACK_STATE_ROOT/ship/base-red/`, repository and branch hashed, 24-hour
expiry), finishes every other step, and writes its receipt with `--base-red
<file>`: the receipt's `base_red` block (`cases`, `files`, `base`, `lane`,
`expires_at`) makes it **conditional**. `gstack-ship-receipt result` prints
`SHIP_PAUSED: base-red …` and `status=incomplete`; `ready`, `train build`,
`verify --train`, `carry` and every other receipt consumer refuse a conditional
receipt with `QUEUE_RECEIPT_CONDITIONAL`. The one exception is a train with
`gates`: `ready --base-red --fixer <pr>` READYs the PR to ride behind its fixer
([base-red PRs](#train-gates)).

To resume, a parent runs `gstack-base-red wait --pause <file>` as a background
operation. On each new base head (`git ls-remote`) it reruns `setup` and
`select` on the paused files there and exits 0 (`BASE_GREEN: <sha>`) on the
first head that passes; a head that still fails keeps it waiting, and it exits 3
on its timeout (`BASE_RED_WAIT_TIMEOUT`) or the pause's expiry
(`BASE_RED_PAUSE_EXPIRED`). Then `/ship --resume <record>` reruns Step 5 on HEAD
merged with the new base in a scratch worktree and, when every lane passes,
rewrites the receipt without `base_red`.

<a id="receipt-carry"></a>
<a id="mechanical-retake"></a>
## `mechanical_retake`: a version or rules number retaken after a base merge

Some repositories number things in one constant: a save version, a rules
number, a schema version. Two branches can take the same next number. When
the base lands the other one first, the branch merges the base and takes the
number after it: one literal on the constant's line, the same value in every
save fixture, and goldens rebuilt from the generator. founderstar#563 did
this after two full review passes (rules number 80 to 81 in
`scripts/core/game.gd`, `save_version` in 8 fixtures under `fixtures/`, one
golden). `finish` routed all 10 paths as behavior and said to insert Steps
5–11.5, while `gstack-review-plan` at the round cap said `done`, so the only
way out was a fresh /ship (GST-1560).

A base policy that declares the constant lets `finish` prove the retake
instead:

```json
"mechanical_retake": [{
  "path": "scripts/core/game.gd",
  "template": "const RULE_NUMBERS := {n}",
  "fields": [{ "glob": "fixtures/saves/*.json", "field": "save_version" }],
  "regen": ["rules-golden"]
}]
```

`finish` runs with `--reviewed-base` and checks each declared path that
changed since review:

| Path | Proof |
|---|---|
| the constant (`path`) | Exactly one line matches `template` at the reviewed base, the reviewed tree, the current base and now. The reviewed branch took the number (its value differs from the reviewed base's), and the current value is above both the reviewed value and the current base's. With that one line masked on every side, the file's patch is the reviewed patch (the same comparison base paths use). |
| a fixture (`fields`) | A matching file holds the same number of `field` lines (`field: n`, `field = n` or `"field": n,`) at the reviewed tree and now. Each one either kept its value or moved from the constant's reviewed value to its current value. With those lines masked, its patch is the reviewed patch. |
| a golden (`regen`) | An output of a named entry in the base's `.gstack/generated.json` that the entry's command recreates byte-identically in a scratch worktree (the pregate `regen` check's proof run). |

Each proven path prints `MECHANICAL: <path> (<what>)` and counts as
`mechanical=<n>` on `ROUTE:`. It needs no reader and no review round, and
the docs audit carries it like a base path. A declared path that fails its
proof keeps its route from before, and `finish` prints
`ROUTE_MECHANICAL_REFUSED: <path> <reason>`
([troubleshooting](troubleshooting.md#route-mechanical-refused)). That covers
any other edit in the constant's file, a fixture value that doesn't match, a
golden that doesn't regenerate, a constant the reviewed branch never took, a
gate path and a landed stack parent. A fixture or golden whose constant isn't a
proven retake is refused too. Nothing is inferred: an undeclared file never
routes as mechanical.

`finish` records the proven paths for the tree it routed, and
`gstack-ship-receipt write` copies them into the receipt's `mechanical` list
as `Mechanical retake: <path> (<what>)`. With `--body` it refuses a PR body
that doesn't carry each of those lines word for word.

**When the route still says behavior at the round cap.** `finish`'s behavior
STOP tells the lane to plan the inserted Step 9 with `gstack-review-plan
--post-review` (plus `--pass`, `--last` and `--fix-checks` as the loop left
them). Edits after the review bound plan as a fix to a gate-class path, never
as a note. The exception is a range after the last fix-check whose edits are
only release stamps and docs (`docsChangeSince`): it plans `NEXT: done`, or
`NEXT: targeted` for a docs claim on a targeted-class diff, with no grant
([review-policy.md](review-policy.md#transitions), GST-1702). Below the round cap that's a pass on the range (a fix-check under
the lean panel). At the cap it stops for the owner, whose recorded grant
(`--grant`) adds one scoped fix-check, never `done`. When the last step was a
fix-check, pass `--range-base` at that fix-check's commit: a new grant at a
stop head after it plans the next link of the chain below (GST-1676), and the
last link's own grant is refused. So `finish` never asks for a step the
planner refuses. In the loop, a fix-check that stops is answered the same way:
a new grant naming that fix-check's commit (`--range-base`, the stop it
answers) plans one more fix-check, the next link of the chain, however many
fix-checks ran before (GST-1681, GEVA-363's third round). The previous link's
grant is refused: it names an earlier stop head, or it was recorded before a
later logged fix-check (a post-review link's grant names the commit its
fix-check read). A grant at any other commit plans nothing: one grant, one link.

<a id="fix-check-chain"></a>**Chained fix-checks (GST-1627).** A second granted
fix-check after the first one (a merge resolution, say) logs its row with
`range_base` at the first fix-check's commit. finish used to read only the newest
row and refuse any range that didn't start at the reviewed tree, so the later
fix-check unbound the earlier one and lanes logged a synthetic combined row
(#4063: fc3 at 265d868, then fc4 over the merge). finish now walks back from the
newest row: while a row's `range_base` doesn't hold the reviewed tree, the link
before it is the newest earlier row whose commit is that `range_base`. The chain
counts only when it reaches a row whose `range_base` holds the reviewed tree,
every link is a committed read with its own approved `review_loop_grant`, and
the newest link is clean. An earlier link that found issues (logged
`converged:false`, as review-army.md requires) still links when it finished its
read bound to its own commit, its findings account for its counts, and every
open or blocking finding names a file it read (GBRA-386, GST-1973): it counts
no path itself, a path its findings name counts only through a clean link
after it, and the line marks it `(found issues)`. A link's grant may name any
stop head inside its `range_base..commit`, its own commit included: the post-review flow grants
each fix-check at the commit it reads, so link 1's stop head is link 2's
`range_base` (founderstar#634, GST-1676). Grants are assigned newest link
first and a grant counts for one link only, so one grant never covers two
fix-checks: a lone grant naming that boundary goes to the newer link and leaves
the older one ungranted. A path counts as `fix_checked` when some clean link's
range touched it and it is unchanged since that link (or its patch against the
base is still the one that link read). The line reads `FIX_CHECK: reviewed <paths>
(fix-check chain of <n> from <range_base12>: at <commit12> grant <id>; …)`. A
`range_base` no earlier row ends at is a gap and refuses with the single-row
reason (`range_base <sha12> does not hold the reviewed tree`); a link that is
stale or ungranted refuses with its reason and `; fix-check at <sha12>, link <k>
of <n>`. Either way nothing in the chain counts.

<a id="fix-check-docs-bridge"></a>One gap is not a gap: the oldest link's `range_base` may follow the reviewed
tree's commit by commits that change only authored docs or release metadata,
such as the Step 14.5 docs commit (harness-evals#361, GST-2294). finish walks
`range_base`'s first parents back to the nearest commit holding the reviewed tree
and accepts the range when every commit after it is a single-parent commit whose
every path it routes as docs or release metadata, printing
`FIX_CHECK_DOCS_BRIDGE: range_base <sha12> follows the reviewed commit <sha12> by
docs or release metadata only (<commits>)`. Those docs still take the docs route
and its recheck. A code or test commit in between, a merge, a `range_base` the
reviewed commit descends from, and a `range_base` on another branch still refuse.
Pass `--reviewed-tree` as the tree the bound review read, never the fix-check's
own tree: with the fix-check's tree, `range_base` sits before the "reviewed"
commit and finish refuses (#4267, #4270).

<a id="test-code"></a>
<a id="uid-sidecar"></a>
## `test_code` and Godot UID sidecars after review

founderstar#611 (GST-1604) hit two gaps after the owner's granted fix-check.
CI forced one more `scripts/ui/cutscene.gd` edit, which the owner accepted
under the review-loop exception. Lint then wanted
`tests/cutscene_check.gd.uid`, the UID sidecar of a test script the PR added
before review. `finish` routed the sidecar as behavior, so a one-line random
id cost another fix-check or a fresh /ship. GDScript tests also match none of
the built-in test globs, so an edit to `tests/*_check.gd` after review routed
as behavior too.

**`test_code`.** A base policy can declare its own test files:

```json
"test_code": ["tests/**/*.gd"]
```

`finish` then routes a matching file changed after review like a built-in
test file. It takes the scoped reader of its test hunks, and a removed or
gate-tagged line still routes as behavior. The globs are read from the base
only, so a branch that declares them changes nothing until the declaration
lands.

**Godot UID sidecars.** Godot 4.4 and later write `<file>.uid` beside each
script or shader they give a UID. The file is one line,
`uid://<id>`, where `<id>` is a random non-negative 63-bit number in base 34
over `a`–`y` and `0`–`8` (Godot's alphabet skips `z` and `9`, GH-83843),
followed by a newline. A reader has nothing to read in it, and no generator
reproduces it. So `finish`, with `--reviewed-base`, proves each `.uid` that
would route as behavior and routes it as `sidecar=<n>` on `ROUTE:`, with no
reader, when all of these hold:

- the branch adds it after review: the path is absent at the reviewed tree
  and at the current base, since a changed UID re-identifies the script for
  every `uid://` reference to it;
- its sibling (the path without `.uid`) is a regular file now, and one the
  reviewed range added or modified (present at the reviewed tree), or one the
  review-loop exception (`finish --review-loop-exception`) accepted; a sibling that is declared `test_code` follows the same rule;
- it is a regular, non-executable file (mode `100644`, never a symlink) whose
  whole content is `uid://<id>` with an optional trailing `\n`: the id
  canonical (no leading `a` digit unless it is `a`), at most 13 digits and at
  most 2^63−1 (`d4n4ub6itg400`);
- no other file in the current tree declares the same `uid://<id>`: another
  `.uid` holding it, a `[gd_scene]` or `[gd_resource]` header, or an
  `.import` file's `uid=` line. A copied sidecar would give two resources one
  UID; a scene that only references the script by it (`[ext_resource … uid=]`)
  doesn't count;
- neither it nor its sibling matches the base policy's
  [`review_exclude_paths`](#review-exclude-paths) or `readers.forbid_paths`,
  since no reader saw an excluded script.

Each proven sidecar prints `UID_SIDECAR: <path> (beside <sibling>)`. Any other
`.uid` keeps its old route, usually behavior, and `finish` prints
`ROUTE_SIDECAR_REFUSED: <path> <reason>`
([troubleshooting](troubleshooting.md#route-sidecar-refused)). A `.import` file
is never a candidate: its `[remap]` and `[params]` sections vary by importer,
so nothing pins its content as tightly. A `.uid` a landed stack parent ships
isn't a candidate either. `finish` records the proven sidecars with the
mechanical retakes, and `gstack-ship-receipt write` copies them into the
receipt's `mechanical` list as `Godot UID sidecar: <path> (beside <sibling>)`.
With `--body` it refuses a PR body that doesn't carry each of those lines
word for word.

## Carrying a receipt across a base merge or a test-only fix

**Merge main into a reviewed branch; never rebase it.** What happens to the
receipt when the base moves:

| What changed since /ship | The receipt |
|---|---|
| a merge of the base, product diff unchanged (tests, release metadata, registered outputs the pregate's regen check proved) | carries; no review reruns |
| a merge of the base that edited lines next to the branch's unchanged hunks (the branch's +/- lines identical and in the same places) | carries after one fix-check reviewer reads the hunks and comes back clean (`RECEIPT_CARRY_SCOPED_REVIEW`, then `carry --scoped-review <record.json>`) |
| a merge of the base whose resolution changed product code, or moved the branch's lines elsewhere | a fresh /ship (`RECEIPT_CARRY_PRODUCT_CHANGED`) |
| a rebase or force-push onto a tree the receipt covers, product diff against the new base unchanged | carries (`carry.ancestry: rewritten`) |
| any other rebase or force-push | a fresh /ship (`RECEIPT_CARRY_TREE_MISMATCH`) |
| a stacked PR whose parent landed (squash or merge), retargeted to the base with the base merged in, HEAD's product diff exactly the one reviewed against the parent branch | carries (reason `stack parent <branch> landed`) |
| a stacked PR whose receipt was written against the base, after its parent landed and the base was merged in, HEAD's product diff exactly the reviewed range from the parent's head | carries (reason `stack parent <sha12> landed`); base context next to the child's hunks is `RECEIPT_CARRY_SCOPED_REVIEW` |
| a stamp on the branch's own rows in a stamp file the branch also changed as product: every changed line at a branch-added position, the file's mode unchanged, the base not touching it, the rest of the product diff unchanged | carries (reason `a stamp on the branch's own rows (<file>)`) |
| a stamp file the branch changes, against each head's base, by no more than a stamp (back at the base's content after a changelog-fragment conversion, or only its version field moved), whatever else the base changed in it | carries (reason `release metadata`, GST-1210) |

**Stacked PRs (#3570).** A child PR's receipt is written against its parent
branch, so its `base` names that branch and its `product_patch_id` is the
child's own range. After the parent lands, the PR is retargeted to the base, and
/ship's carry check runs with `--base <base>`. When that base differs from the
receipt's, the carry compares the reviewed range (the recorded
`product_patch_id`, or for an older receipt the range against
`origin/<parent>` while that branch still resolves) with HEAD's whole product
diff against the base, computed the way `write` records it, so a parent's
release-metadata change that never reached the base counts too. Equal means
the parent fully landed and the child is unchanged, so the receipt carries
and from then on names the base it was carried to. A parent that has not landed, a child edited
since, or a parent that landed with changes the child never merged all leave a
different diff and refuse with `RECEIPT_CARRY_PRODUCT_CHANGED`. An older
receipt whose parent branch is gone refuses with `RECEIPT_CARRY_REFUSED`.
Until the carry moves it, `ready`, `land --pin` and train build refuse a
receipt whose `base` is not the queue's base with
`QUEUE_RECEIPT_BASE_MISMATCH` (GST-2153): a child retargeted to the base while
its parent is still open would otherwise land the parent's commits under a
receipt that reviewed only the child.

**Stacked PRs reviewed against the base (GST-1199).** A child PR that targets
the base while stacked has a receipt whose `base` is the base and whose
reviewed range holds the parent's hunks too, and the receipt records no stack
parent. Once the parent squash-merges and the base is merged into the child,
the two heads' product diffs differ by exactly the parent's hunks, which now
sit in the base. When they differ, the carry looks for the newest commit inside
the reviewed range (the reviewed head excluded, at most 100 commits) whose
product change the current base already holds: `git merge-tree` of that commit
into the base changes no product path. A conflicted product path never counts,
so a parent that never landed is never treated as one, even when the child's
merge dropped its change. The comparison then runs from that commit, leaving out
every path whose content at the reviewed head is the base's (a base merge the
child made before its receipt brought it in) unless HEAD changed it against the
base (GST-1214): an equal
patch-id carries with reason `stack parent <sha12> landed`, base context next
to the child's unchanged hunks is `RECEIPT_CARRY_SCOPED_REVIEW`, and any other
difference refuses with `RECEIPT_CARRY_PRODUCT_CHANGED`. When merging the commit
into the current base conflicts because the base edited the landed lines
afterwards, the base commits since the fork that touched every path of its
change are tried newest first (at most 200), so the squash itself still counts
(GST-1399).

**finish after a stack parent lands (GST-1399).** A child reviewed against its
parent branch passes the parent's head to `gstack-ship-release finish
--reviewed-base`, even after the parent squash-merged and the child merged the
base. finish takes it when the branch contains it and a base commit holds its
change outside release metadata and changelog fragments (a release folds every
fragment on the base), found as the carry finds a landed parent, and
prints `REVIEWED_BASE: stack parent <sha12> landed on origin/<base> at <sha12>`.
The route, a granted fix-check's sides, the scoped-review packet and the docs
carry then compare each commit's patch from that parent, so the parent's and the
base's edits route as `base=`. The route also reads every path the branch ships
against the base, changed since review or not, and judges every shipped path's
release-metadata class against the base, so a parent change the base never
received (a `package.json` script, even after the child's version bump) or a
merge that kept a line the base changed since still stops. Both the landed check
and this class count a `stamp_paths` or `release_outputs` file as metadata only
while its edit is a version stamp, as `stamp_files` are; any other edit to one
must be held by the base or stop. A landed stack parent never takes the bounded
route: a post-review edit that a child reviewed against the base would send to
one scoped reader stops for Steps 5–11.5 instead. A path the child no longer changes against the base routes as base only
when the base already holds the reviewed change to it (a three-way merge of the
reviewed change into the base leaves the base's bytes, and a reviewed mode change
is the base's mode); a post-review revert to the base's content or mode still
stops. Any other commit
off the base, a parent the base never received included, stops with
`--reviewed-base <sha> is not on origin/<base>, nor a landed stack parent`.

Since the release that added `review_scope`. A `/ship` receipt names the head it
reviewed, so a conflict-only merge of the base or a test-only fix used to
invalidate it and cost a full re-run on identical product code.
`gstack-ship-receipt carry --pr <n> --base <base>` (or `--body <file>`) moves
the receipt to HEAD when the working tree is clean, the receipt's head is an
ancestor of HEAD and `git patch-id --verbatim` of the product diff against the
base is the same at both heads (verbatim: whitespace counts, hunk line numbers
do not). `--verbatim` needs git 2.39 or later: the carry probes `git --version`
first and refuses an older git by name
([`RECEIPT_GIT_TOO_OLD`](troubleshooting.md#receipt-git-too-old)) instead of
falling back to the whitespace-stripping default, and a `git diff` or
`patch-id` failure is reported with git's own first stderr line. When the
patch-ids differ, the refusal names up to `CARRY_NAMED_PATHS` (20) product
paths whose patch against the base changed, walking only the paths the branch
itself touched at either head (a base merge brings in every path the base
changed, none of which can differ between the two base diffs), and of those
only the paths that changed between the two heads or the two bases (a path with
the same blob on both sides has the same patch). The product diff streams
through a file under the git directory (`.git/gstack-patch-id`) into
`git patch-id --verbatim`, so a PR with thousands of paths is not held in
memory; a directory a killed run left there is removed after an hour. Product means every changed path that is not test code (`test/**`,
`spec/**`, `e2e/**`, `**/*.test.<code ext>`, `**/*.spec.<code ext>` and the
other `CARRY_TEST_GLOBS` in `lib/ship-receipt.ts`; an `openapi.spec.yaml` is
product) or release metadata (`CHANGELOG.md`, `agents-digest/**`, each
`<changelog_fragments.dir>/<slug>.md` fragment when the base policy sets
`changelog_fragments` (not the directory's README.md or a nested path; a README
change the branch itself makes also makes the range's fragments product, while one
a base merge brings in does not), and `VERSION`
or `package.json` only while the change is a version stamp and nothing else: a
dependency, a script or a new key makes them product). A path the policy's
`stamp_files`, `stamp_paths` or `release_outputs` name is metadata only while
its change is a stamp, the rule the tree receipt applies to the same paths: a
manifest by its version key, any other file when its new text reads as the old
once the new release version is replaced by the old one, or when every changed
line is a stamp-form rewrite to the new version of the old version or of a
newer tentative one the stamp moved (a `*_KEY_VERSION` written as the next
minor, #3512; a version older than the old one or of another width is a hand
edit). A logic change in a
stamped source file is product. Lockfiles are product unless the policy names
them. An output of an entry with a `command` in origin/<base>'s
`.gstack/generated.json` is `generated`, not product, only when the
`--pregate` result passed for HEAD lists it under the `regen` check's
`proven` paths (the check deleted the touched output in its scratch worktree
and the command recreated it byte-identically) and that check ran the same
registry, origin/<base> at the commit the carry reads. A file that matches an
output glob but that the command never writes is not proven. Without that
evidence, or for an entry with no command or one only the branch registers,
the output is product (U1 on gstack-evals paid a
full rerun because a merge changed its generated index's diff). A base merge
contributes no product change of its own. A receipt carried twice keeps the reviewed head as
`carry.from` and adds up the merges and paths. The carried receipt records
`carry: { from, reason, product_patch_id, changed_paths, merge_commits,
range_diff, covers, reruns, ancestry, trees }` (`ancestry` is `linear`
along the receipt's own history, `rewritten` once any hop was a rebase;
`trees` lists the earlier covered trees) with the `git range-diff` evidence, prints
`CARRY: carried from <old> to <new> (<reason>)` and the `GSTACK_RESULT:
skill=ship status=complete` line, and its summary line ends with
`carried_from=<old12>`. `CARRY: current` means the receipt already names HEAD;
`--dry-run` prints `CARRY: would carry …` and writes nothing. When the only
difference is base context next to the branch's unchanged hunks and none of
carry's other checks would refuse, `--dry-run` refuses
`RECEIPT_CARRY_SCOPED_REVIEW` without writing the packet; carry without
`--dry-run` writes it.

A changed product path, or a product patch-id that differs, is
[`RECEIPT_CARRY_PRODUCT_CHANGED`](troubleshooting.md#receipt-carry-product-changed)
(exit 3; the refusal names the paths), except when the only difference is
base context next to the branch's unchanged hunks, which is
[`RECEIPT_CARRY_SCOPED_REVIEW`](troubleshooting.md#receipt-carry-scoped-review)
until one fix-check reviewer clears the packet; a working tree with uncommitted
changes is [`RECEIPT_CARRY_REFUSED`](troubleshooting.md#receipt-carry-refused).
A `RECEIPT_CARRY_PRODUCT_CHANGED` on linear history against the reviewed base
whose range-diff, plus the diff of the changed product paths, is at most 400
lines and 64 KB, with no binary path and a receipt that
records its review depth, also prints `RECHECK: eligible … packet=<file>`: one reader on that
packet and `carry --recheck <record.json>` rebind the receipt instead of a
full second /ship, unless HEAD needs a deeper review depth or another risk
class ([scoped re-check](troubleshooting.md#receipt-carry-recheck), J1).

**Changed and context paths together (GST-1561).** When the base also moved
context next to reviewed hunks in other paths, the scoped review and J1 compose
into one bounded re-check instead of refusing each other (founderstar#563 hit
this on every rules-number PR). The one packet holds the range-diff and the
changed paths' diff, then the scoped-review sections of the context paths. The
400-line and 64 KB caps count the whole packet, and `range_diff_sha256` binds
all of it. The record also names `range_base`, the commit the reviewed range
starts from (the fork point, or a landed stack parent), and the carry reason
logs the context paths and that `range_base`. A context section with over 200
of the branch's own +/- lines, or a packet over the caps, prints `RECHECK: not eligible (<why>)` and stays
`RECEIPT_CARRY_PRODUCT_CHANGED`. A changed path alone, or context paths alone,
keep the routes above, and their output is unchanged.

The same scoped review also covers a hunk whose only difference from the
reviewed one is the base's edit of the lines the branch replaces. The base took
`SAVE_VERSION := 83` while the branch's `:= 84` line, reviewed against `82`,
stays byte-identical. The branch's added lines must match byte for byte, and
the lines just outside the reviewed hunk's removed range must be lines the base
kept, landing just outside the current hunk's range (`lib/ship-patch.ts`
`comparePath`). The path then counts as a context path. Carry and finish put it
in the scoped-review packet, and the reader checks that the branch's value
still holds next to the base's. It never carries without a reader. A hunk whose
added lines changed, that now also removes a line the base never touched, or
whose range holds a line the base added (a base hunk at or next to the replaced
lines that adds more lines than it removes) stays a changed path. A [mechanical retake](#mechanical-retake) does not apply
here, since the branch retook nothing.

**Rewritten history.** `write` records `head_tree` (the reviewed head's tree)
and `product_patch_id` (its product patch against the base), and every carry
rebinds both to the new head and keeps the earlier trees in `carry.trees`.
When the receipt's head is no longer in HEAD's history, the carry follows only
when HEAD's tree is one of those trees and HEAD's product patch-id against the
current base equals the recorded one; it records `carry.ancestry: rewritten`
and `range_diff: tree-equal`, and needs neither the old commit nor its
history, so a fresh clone carries too. The tree alone is not enough: a stacked
branch rebased onto main after its base closed unmerged keeps its tree while
its diff grows by the base's code, and that is `RECEIPT_CARRY_PRODUCT_CHANGED`.
Any other tree is
[`RECEIPT_CARRY_TREE_MISMATCH`](troubleshooting.md#receipt-carry-tree-mismatch),
which names HEAD's tree and the covered trees. A receipt from before
`head_tree` existed, whose head is not in this clone, is
`RECEIPT_CARRY_REFUSED`: run `/ship` on the new head. A refusal never
rewrites the body. The queue's `ready`, `train build` and `verify --train` read the
carried receipt like any other.

**Delta /ship: eligibility, then checks, then publication.** `/ship` Step 1 runs
the carry when the branch has an open PR, in this order, and never reruns the
review loop or Step 14.5's docs audit for a carried receipt:

1. At the pushed HEAD (carry refuses an unpushed one, `--dry-run` included),
   `gstack-ship-receipt carry --pr <n> --base <base> --dry-run`. `CARRY: would
   carry` is eligibility only; a refusal continues the full ship, except
   `RECEIPT_CARRY_SCOPED_REVIEW`, for which `gstack-ship-preflight` prints
   `NEXT: carry route`: fix what the base merge broke, commit and push, run carry
   without `--dry-run` to write the packet, have one fix-check reviewer read it,
   then carry with `--scoped-review <record.json>` and `--pregate`. A blocking
   finding continues the full ship.
2. Fix what the base merge broke (the CHANGELOG, the size caps the policy
   declares) and commit, `gstack-ship-release push --branch <branch-name> --early`,
   `gstack-ci-carry wait --base <base>` (`CI_CARRY: none` is not a stop), then
   `gstack-pregate --allow-repo-commands` at that pinned HEAD (the remote tests stage when `requires_remote` asks for it).
   A failing check, or HEAD moving after the pregate, continues the full ship
   from Step 2.
3. `gstack-ship-receipt carry --pr <n> --base <base> --pregate <pregate.json>`
   rebinds the receipt with a pregate current for HEAD and ends the run with its
   `GSTACK_RESULT:` line.

A receipt that records a pregate never rebinds without a current one:
`carry` without `--pregate` (or with a stale one) is
[`RECEIPT_CARRY_PREGATE_STALE`](troubleshooting.md#receipt-carry-pregate-stale)
and leaves the body unchanged. A crew that reran the whole `/ship` after every
base merge should run this sequence instead.

## What `/land-and-deploy` reads from it

Step 3.4 runs `show-effective --base <base>` before the merge and prints one
`VERSION_CHECK:` verdict for the PR head:

| Policy | Stops when | Passes |
|---|---|---|
| `queue_mode: stamp-at-merge` | the head's VERSION is not the base's version plus one bump, or the changelog's top two headings at the head are not that version and then the base's top entry (`STOP stamp stale`: run `gstack-restamp --next` on the branch, push the stamp, rerun) | an exact stamp; other open PRs' tentative stamps are ignored |
| `queue_mode: claim-at-open` (and no policy file) | another open PR holds the same VERSION, or the base is already at or above it (`VERSION drift detected`: rerun `/ship`) | any unique VERSION above the base, including a MICRO bump or one below a sibling's claim |

An invalid policy, an unreadable claim list or a missing VERSION is `unavailable`:
the skill reports it and CI's version gate is the backstop. A base at or above the
branch VERSION still stops.

<a id="stamp-at-merge"></a>
## `queue_mode: stamp-at-merge`

Under `stamp-at-merge` nothing is claimed when a PR opens. The stamp happens
when the PR is next, from the base branch's version at that moment, through
the repo's own release tool, across every stamp location at once:

```bash
gstack-restamp --next --base main --allow-repo-commands --pr 42 \
  --expect-base <sha of origin/main the queue assumed> --expect-order 40,41,42
```

prints `ship, next in queue at <version>`, `STAMP_VERSION: <version>`, one
line per stage, the diff limited to stamp files, `MERGE_CONDITION: sha=<head>`
(pass it to the merge API's expected-head `sha` so a check-to-merge race is
rejected by the server) and the `GSTACK_RESULT:` line. `claims: ignored
(stamp-at-merge)` says the legacy claim reader was not consulted. When the base
or the order moved, the result is `QUEUE_STALE` (exit 3) with the exact
`recompute` command; nothing is written.

Stages, each journaled in `.gstack/tmp/restamp-journal.json`:

0. **restamp_command** (only when the policy sets it): the repo's own restamp, see [restamp_command](#restamp-command).
1. **version**: `gstack-version-bump write --version <X>` in the staging worktree (VERSION, the manifest, npm lockfiles); skipped when `restamp_command` owns the version. The manifest gets the npm-valid three-part form, except when the policy lists it in `stamp_paths` or `stamp_files` and its copy at the base holds four parts (gbrain's convention): then it keeps the full version (`--manifest-form full`) and the stage detail says so.
2. **release_tool**: the policy command, under the contract below.
3. **changelog**: the PR's `[Unreleased]` or old-version section moves to the top under `<X>`, above its predecessor's entry. A duplicate heading the PR introduces (`CHANGELOG_DUPLICATE_HEADING`: the headings are counted against the base's CHANGELOG at `origin/<base>` and at the fork point, so a version the base already heads twice passes as long as the PR adds no further copy) and a top entry that is not `<X>` (`CHANGELOG_TOP_MISMATCH`) are errors; the section being re-headed itself may exist only once.
4. **stamp_paths**: exact `(was X)`, `since: X` and `vX` rewrites, plus every `stamp_patterns` template, within `stamp_paths` and `stamp_files`. A quote around X in the first two forms is part of the form and is kept as written: `since: 'X'`, `since: "X"`, `(was 'X')` and `(was "X")` move like the bare ones (the shape of a quoted source row such as gbrain's `{ since: '0.60.468.0', … }`), an opened quote must close right after X (`since: '1.2.3-beta'` and `since: '1.2.3"` are not the form, in the writer and in the tree receipt alike), and `vX` already accepts a quote before the `v`. Which X moves is decided by provenance. The branch's own tentative stamp (its VERSION when it moved past base) and `--was <X>`, when given, are each rewritten on every line of every stamp file. Beyond that, only lines the branch itself added are read, by their position in the file (`git diff --unified=0` from the fork point), so a base line with the same text, or a CRLF checkout whose diff is LF-normalized, is told apart: a stamp-form mention there of a version newer than the version at the branch's fork point is a tentative stamp and moves (this is what finds a quoted row after a lost slot and a merge of the base, since the base's release is newer than the fork point), with one limit on the built-in forms: a version newer than the one being stamped moves only when the branch itself recorded it (its version source at the fork point or at any commit in `<base>..HEAD`, every parent walked, so a train or land merge of the pin still reads the pin's own claims), because no queue handed the branch a version above the one it gets now, so a third party's `QM v0.1.15` on a line the branch added to a README in `stamp_files` stays exactly as written (GST-1245). A `stamp_patterns` slot keeps the plain fork-point bound (#3512), and a version only a slot vouches for moves inside that slot alone, never in a built-in form beside it. A third-party version between the fork point and the version being stamped is still read as a tentative stamp: keep such references out of stamp files, or out of a stamp form. So does one of the fork-point version itself (a row the branch wrote at the version it forked from instead of a next version is its own stale stamp; a branch-added mention older than the fork point stays), and when the branch has no stamp of its own because its VERSION equals the base's and its fork point is the base itself (a branch rebased onto the base after it reached X, or one never stamped) a mention of the base version on a line it added is its stale stamp and moves too, while the same version on a line the base already carries is the base's release and stays. The stage detail names both counts per file (`VERSION equals base X, so X moved only on lines this branch added and stayed on the base's own lines (<file>: N moved, M kept)`), so the stamp commit shows which lines moved and why. A line the base added since the fork point is the base's even when that diff shows it (a merge of the base on the branch, committed or still staged, brings every line the base added since the fork into the diff from the fork point, main's own release keys included): it is left out, the detail says `N line(s) the base added since the fork point are the base's, not this branch's, and stay (<file>: N)`, and a base diff git cannot run refuses the stage (`POLICY_SOURCE_UNAVAILABLE`, `cannot diff <since>..<base> for the stamp_paths stage`) rather than reading as an empty set that would move the base's lines again. The rule reads line ownership, not meaning: a branch-added line inside `stamp_paths` that means the base's own release in a stamp form (`Requires vX or later` written on a branch forked at X) moves with it, which the `--dry-run` diff and the per-file counts show before anything is written; write such a reference outside a stamp form, or keep that file out of `stamp_paths`. `--was X` is the opposite tool: it rewrites X everywhere, the base's own lines included, and re-heads the CHANGELOG section `## [X]`. Only the repo's own version width counts, so a 3-digit dependency pin in a 4-digit repo is never a candidate. The checks that accept a stamp commit read the same bound as the writer (`stampOnlyLine` with the branch's side in `lib/stamp-only.ts`): the tree receipt behind `stamp`, `verify` and the gate-ahead replay, the merge train's stamp and verify checks (each reading the slot's predecessor, the gated commit's first parent, as the base), the /ship receipt carry, and finish's route each take a moved version on a line the branch added at or above the fork-point version, and on any other line at or above the gated head's VERSION; in a built-in form a moved version above the new one must also be one the writer moves there (the gated head's VERSION on any line, a version the branch recorded on its own lines), so a rewritten third-party version reads as product (GST-1245). A branch line is named by its position in the gated file, so a base line whose text duplicates a line the branch added keeps the gated head's bound (GST-979). When the stamp keeps the VERSION (a slot that keeps its claim), only the branch's own lines may move, so a base line moved by hand is refused. The carry follows a stamp on the branch's own rows in a stamp file the branch also changed as product when every changed line of that file sits at a branch-added position, the file keeps its mode, the base did not touch it and the rest of the product diff is unchanged (`a stamp on the branch's own rows` in the carry reason, GST-980).
5. **mirror**: tier 2; declared and validated, reported as not run.
6. **apply**: every changed file is written to the branch only after all stages validated, each against the fingerprinted preimage; a file edited meanwhile is `RESTAMP_CONFLICT` and the applied writes roll back (rollback refuses to overwrite a file whose bytes differ from the recorded postimage).

Idempotent: a second run with the same version is `noop`. `--dry-run` prints
the full diff and writes nothing (not even the journal). `--version <X>` stamps
exactly X; `--bump` overrides the level; `--queue-mode` overrides the policy.

### Gate-ahead: `--after <pr>`

A reorder is cheap only when the gate can run before the predecessor merges.
`gstack-restamp --after <pr> --predecessor-ref <ref>` merges HEAD and the
predecessor's head in a throwaway worktree (`.gstack/tmp/gate-ahead-worktree`),
resolving only version-file and CHANGELOG-ordering conflicts, stamps N+1
relative to the predecessor's version there, commits, and records
`.gstack/tmp/gate-ahead.json` (`predecessor_head`, `branch_head`,
`gated_head`, `gated_tree`, `version`, `evidence_branch_key`). The PR branch's
history is never touched, so squash-history PRs stay clean. The gate runs in
that worktree; `gstack-evidence bundle` there exports the evidence.

<a id="release-tool-contract"></a>
### The release-tool contract

The release tool runs in an isolated staging worktree seeded from the working
tree's content fingerprint (`gstack-wtree`), with the repo's ignored
`node_modules` linked in. Its outputs are enumerated: the version files,
lockfiles, the CHANGELOG, `stamp_paths` and `release_outputs`. A write outside
that set refuses the whole restamp before anything reaches the branch
(`RESTAMP_OUTPUT_OUTSIDE_ALLOWED`); a non-zero exit is
`RESTAMP_RELEASE_TOOL_FAILED`. Preimages and postimages of every write are
recorded in the journal. Pinning the command string does not freeze its
implementation (`bun run release:restamp` still runs the PR's package script),
so the receipt names the policy revision, the command, its working directory
and the trust scope (`policy: base origin/main@<sha>` or `head (unreviewed)`).

<a id="restamp-command"></a>
### `restamp_command`: the repo owns the stamp

A repo whose own tool knows its stamp locations sets `restamp_command`.
`gstack-restamp` runs it as the first stage inside its staging worktree, a
clean checkout of HEAD, with the allocated version as the last argument and in
`GSTACK_RESTAMP_VERSION`. The caller's HEAD, index and worktree must be clean
first (`RESTAMP_CONFLICT`, nothing written); the generic path keeps its
working-tree fingerprint seed. Anything the command stages or commits in the
staging worktree is folded back into plain edits; then output confinement
applies as for the release tool (`RESTAMP_OUTPUT_OUTSIDE_ALLOWED`), the
version file must hold the target version (`RESTAMP_VERSION_SOURCE`), and a
non-zero exit is `RESTAMP_RELEASE_TOOL_FAILED`. In every failure nothing
reaches the branch. gstack's version writer is skipped; the CHANGELOG and
`stamp_paths` stages still run (a no-op when the tool already did the work).
Read from the base branch and run only with `--allow-repo-commands`, like
`release_tool`. A tool that fetches, merges the base branch or needs a version
of its own choosing cannot run here; give it a mode that takes the version and
writes only stamps.

The command also gets `GSTACK_RESTAMP_BASE_SHA`, the release predecessor: the
base branch commit the version is allocated after (origin/<base> for a per-PR
restamp and for `land`, S_(i-1) for a [stamped train](#train-land)'s S_i). A repo counter that must be predecessor + 1 (a
SAVE_VERSION, a rules number) reads its old value from that commit
(`git show "$GSTACK_RESTAMP_BASE_SHA:<file>"`), never from the branch, so two PRs
cut from one base never both claim the same number. Regenerated goldens go in
`release_outputs`.

<a id="changelog-fragments"></a>
## `changelog_fragments`: entries without versions, versioned at merge

With `changelog_fragments: { "dir": "changelog.d" }` on the base branch, a PR
never edits VERSION, the manifest `version` key or a released CHANGELOG
section. It adds one or more fragments, and the merge step assigns the
version, so two PRs cut from one base cannot collide and no lane redoes a
stamp after another PR merges.

A fragment is `<dir>/<slug>.md`, one regular file directly in `dir`
(`README.md` there is skipped). Its body is the entry text, exactly what the
CHANGELOG section will hold, with no `## [x]` heading. It may open with front
matter that raises the bump:

```markdown
---
bump: minor
---
**What changed, in one sentence.**

### Fixed
- ...
```

The front matter may also mark the change important for the stable release:
`important: security|regression|data-loss|blocker` (one value, beside any
`bump:`; any other key or value is `CHANGELOG_FRAGMENT_INVALID`). A gated change
with that field reaches `stable` through [the daily
check](releases.md#the-daily-check) once `stable` is 24 hours old, instead of
waiting for Monday or Thursday. Mark only what the table there allows; the
reviewer checks the claim with the diff. A READY whose fragment carries the
field says `rides the daily cut` and names the value, and the Captain stamps a
release PR in the same turn it lands the PR. The field does not change the
CHANGELOG text: the fold drops front matter.

The effective bump of a stamp is the highest of the policy bump and every
folded fragment's `bump:` (`micro` < `patch` < `minor` < `major`). Fragments
are read as Git blobs at the commit being stamped (`git ls-tree` and
`git cat-file`, never the working tree), so a symlink, a gitlink, a nested
path, a non-`.md` file, an empty fragment, one over 64 KiB, one carrying a
release heading, or one whose name already landed on the base with other text
is `CHANGELOG_FRAGMENT_INVALID`, and nothing is allocated. Only fragments the
branch adds against the base count.

**/ship.** `show-effective` prints a `ship: changelog_fragments` line, so /ship
writes no version in Step 12 and writes Step 13's entry as
`<dir>/<branch-slug>.md`, linted with `gstack-prose-lint <file> --gate`, never an
`[Unreleased]` section.

**The fold.** `gstack-restamp` (and so `land`) concatenates the fragment
bodies in path order above any legacy `[Unreleased]` section, re-heads both as
one `## [<version>] - <date>` section at the top, and deletes the fragment
files, in one stamp. The tree receipt, and so `gstack-pregate clear`'s
stamp-only substitution, calls a deleted fragment a stamp (rule
`changelog_fragments`) only when the new CHANGELOG section is exactly the
deleted fragments' bodies in path order above any legacy `[Unreleased]` text
(rule `changelog-fragments`); an edited fold, or a fragment deleted without
its text, is a change.

**Version Gate.** The workflow runs on every PR (no path filter), so a PR
that touches no release file still has to prove its entry. Under the key, an
unstamped head must keep VERSION, the manifest `version` key and every
released CHANGELOG section at its merge base's values, and add at least one
valid fragment (a legacy `[Unreleased]`-only entry passes during migration;
a `[bot]` author, such as Dependabot, needs none). Other manifest edits, a
dependency or a script, pass. A head made by the merge step, a commit whose
parents are [pin, base], must carry the base's version plus the effective
bump of the fragments its pin adds; a stacked pin's parent fragment whose
text the base already released is skipped, not counted again. Under a train policy `gstack-ship-queue
ready` applies the same rule itself; without one, `ready` requires the head's
checks green, Version Gate included.

<a id="land"></a>
## `gstack-ship-queue land`: the per-PR merge step

`land --pr <n>` merges one READY PR whose head is unstamped. It replaces the
lane's stamp round trip. Nobody stamps by hand; the tool makes and pushes the
stamp commit. Steps, each journaled in
`.gstack/tmp/ship-queue/land/<n>.json` and resumable by rerunning the same
command. A journal that pushed a stamp whose branch was then reset to the reviewed
pin is discarded and the pin is restamped
(`JOURNAL: #<n>'s head is the reviewed pin …; discarding the journal and
restamping`, GST-1245), so a reset stamp needs no hand cleanup:

1. **Refuse** a fork head, a closed PR, a PR whose base is another branch, a
   base policy with `changelog_fragments` off (`QUEUE_NOT_READY`), a pin
   without a READY receipt (`gstack-ship-queue ready --pr <n>` records one
   on `refs/notes/gstack-trains` once its pregate, full_e2e and receipt checks
   pass; land checks nothing weaker), a /ship receipt that is missing or
   bound to another head (`QUEUE_RECEIPT_MISSING`, `QUEUE_RECEIPT_STALE`) or
   reviewed against another branch than the base
   (`QUEUE_RECEIPT_BASE_MISMATCH`), and required checks that are not green at the pin.
2. **Lock.** Take the repository land lock, `refs/notes/gstack-land` (its own
   ref, never the trains notes ref), by exact lease. It records the PR, holder,
   phase and journal. A held lock is `QUEUE_LAND_LOCKED` naming the holder;
   `--break-lock` prints the holder (`LOCK_HOLDER:`), takes over a crashed
   holder's lock and is refused while that holder entered a push or a merge
   less than 10 minutes ago, and for a drift lock. `train land` shares this
   lock ([one land lock](#train-land)); a train slot's lock needs
   `--break-train-lock` as well while its train still lands, and a `freeze`
   lock is never broken. A refusal before the push releases the lock.
3. **Merge and stamp.** In a scratch worktree, merge the base into the pin.
   Conflicts in release fields only (the version file and `release_outputs`
   take the base's side, the CHANGELOG merges by section, a manifest or npm
   lockfile is re-merged with every side's release version set to the base's,
   so a clean dependency edit survives) are resolved; anything else is
   `QUEUE_LAND_CONFLICT`, nothing pushed, back to the lane. A legacy pin that
   bumped VERSION itself has its release fields put back to its merge base
   first and its entry re-headed `[Unreleased]` (a manifest version source
   keeps its other edits; a symlinked release file refuses). A PR with no entry gets a
   fragment written from its title. Then `gstack-restamp --next` folds and
   allocates (`restamp_command` and `release_tool` need
   `--allow-repo-commands`, as everywhere).
4. **Push.** `commit-tree` the stamped tree with parents [pin, base] and push
   it to the PR branch under `--force-with-lease=<branch>:<pin>`. The journal
   keeps the reviewed pin apart from the last pushed head, so a rerun leases
   on what it pushed and never on a head someone else pushed
   (`QUEUE_TRAIN_MOVED`, never overwritten).
5. **Wait** for the PR's checks on the stamp commit, polling every 60 seconds or more (lib/gh-poll.ts)
   with the same check read the pin passed (`--timeout <min>`, default 60). `--no-wait`
   stops after the push and prints `gstack-pr-wait <n> --until green &&
   gstack-ship-queue land --pr <n>` to run instead.
   CI runs for real on the stamp commit in this mode.
6. **Merge.** Re-read the base first: if it moved, restamp from the new base
   and push again under the last-pushed lease, at most twice
   (`QUEUE_LAND_BASE_BUSY` on a third move, which releases the lock). Then
   `gh pr merge --squash --match-head-commit <stamp>` (`--merge` under
   `history: merge-only`) and confirm the base's
   tree is the stamped tree on the base land stamped. The stamp date is taken
   once and reused by every restamp. A rerun after GitHub merged the PR
   (an error reply, a crash) goes straight to that tree check.
7. **Drift.** GitHub's merge API cannot bind the base, so a merge made outside
   `land` can slip in between the check and the squash. The post-merge check
   then fails with `QUEUE_LAND_DRIFT` and keeps the lock.
   `land --pr <n> --repair` opens a PR from the base whose only change is a
   fragment for what the outside merge brought (its unfolded fragments, moved,
   or one entry naming its commits) and records it on the lock; /ship and land
   that PR, from any checkout, and its land takes over the drift lock and
   releases it. A rerun of `--repair` finds the PR it already opened.

`--dry-run` merges and stamps in a scratch worktree and prints the version and
tree, taking no lock and pushing nothing.

<a id="land-direct"></a>
### `land --pin`: merge at the PR's own green head (`merge: direct`)

Under `"merge": "direct"` in the base policy, the Captain merges one READY PR
at a time with `gstack-ship-queue land --pr <n> --pin <sha>`, where `<sha>`
is the head the READY names. There's no train and no stamp commit. GitHub's
required checks plus `--match-head-commit` stay the gate. When the pin
doesn't hold the tip of `origin/main`, those checks never ran on the tree that
would land, so land tests that tree itself with the base policy's
`land.merged_checks` (below). Versions aren't set per PR: a PR carries only its
`changelog.d` fragment, VERSION stays where it is, and the
[release PR](#release-stamp) stamps the version and folds the fragments. Land
refuses, and merges nothing, unless all of these hold (a `release/<version>`
head is checked by the release rules below instead of the receipt, READY and
release-file rows):

| Check | Refusal |
|---|---|
| the base policy sets `merge: direct` | `QUEUE_NOT_READY` |
| the PR is open, on the base, from this repository | `QUEUE_NOT_READY`, `QUEUE_TRAIN_UNTRUSTED` |
| the PR head is the pin | [`QUEUE_LAND_PIN_MOVED`](troubleshooting.md#queue-land-pin-moved) |
| the PR body's /ship receipt is bound to the pin | `QUEUE_RECEIPT_MISSING`, `QUEUE_RECEIPT_STALE` |
| the receipt's `base` is the queue's base | [`QUEUE_RECEIPT_BASE_MISMATCH`](troubleshooting.md#queue-receipt-base-mismatch) |
| every owner gate disposition the approval store applies at the pin is accepted with `--accept-gate-disposition <id>`, every accepted id is applied, and the receipt and PR body list exactly those ([gate dispositions](#gate-disposition-acceptance)) | [`QUEUE_GATE_DISPOSITION`](troubleshooting.md#queue-gate-disposition) |
| a READY note from `ready` exists at the pin | `QUEUE_NOT_READY` |
| no freeze is active (with `--repair`: one is, and its repair slot is free or already this pin; a backstop freeze left from before `release_gate` only warns; see [direct freeze](#direct-freeze)) and no land lock is held | [`QUEUE_TRAIN_FROZEN`](troubleshooting.md#queue-train-frozen), `QUEUE_NOT_READY`, `QUEUE_LAND_LOCKED` |
| VERSION, the `package.json` version, the CHANGELOG and `.gstack/version-path` are unchanged since the merge base | [`QUEUE_LAND_STAMPED`](troubleshooting.md#queue-land-stamped) |
| every check at the pin is green with none pending, and each `changelog_fragments.required_checks` entry passed there | [`QUEUE_LAND_CHECKS`](troubleshooting.md#queue-land-checks) |
| GitHub reports the PR `MERGEABLE` and `CLEAN` | [`QUEUE_LAND_NOT_CLEAN`](troubleshooting.md#queue-land-not-clean) |
| land takes the land lock (`land-pin:<pin>` journal, phase `merging`) and re-fetches `origin/main`; it takes over a lock an earlier `land --pin` run of the same PR left, and `--break-lock` breaks another lander's stale lock under the usual rules | `QUEUE_LAND_LOCKED`, `QUEUE_NOT_READY` |
| when the base moved past the pin's merge base and the base policy lists `land.merged_checks`: `--allow-repo-commands` was passed, the pin merges onto the tip without a conflict, and every command passes on that merged tree | [`REPO_COMMANDS_NOT_ALLOWED`](troubleshooting.md#repo-commands-not-allowed), [`QUEUE_LAND_NOT_CLEAN`](troubleshooting.md#queue-land-not-clean), [`QUEUE_LAND_MERGED_CHECKS`](troubleshooting.md#queue-land-merged-checks) |

Release outputs (the agents digest) are checked by the Version Gate, which must
be green at the pin: it accepts an output only when it equals what the release
tool generates at the merge base's VERSION. A green PR merged onto newer
commits can still break main (#3886 pushed ship/DRIVER.md past its size cap
that way). So when the base moved, land builds the pin merged onto the tip of
`origin/main` in a throwaway worktree (the checkout's `node_modules` linked
in), runs each `land.merged_checks` command there in order, and prints
`MERGED_CHECKS: pass tree=<tree> base=<tip> pin=<pin> checks: …`. The
commands are repo commands: the merged tree's `package.json` decides what
`bun run` does, so the PR controls them. Land runs them only with
`--allow-repo-commands`, with `PATH` and the locale as the whole environment
and a throwaway `HOME`, so no token reaches them through the environment,
runs git around them with hooks and fsmonitor off, and kills a command's whole
process group with SIGKILL when it ends or times out. A scrubbed environment
alone doesn't stop a check reading land's own through `/proc/$PPID/environ`
or a `/proc` scan (GST-1421), so on Linux land makes itself non-dumpable before
the first check, which closes its `/proc` environment, memory and ptrace to
processes of the same user. The `git` and `gh` processes land starts
afterward still carry its environment, so land also becomes the subreaper of
everything the checks start and kills whatever a check leaves running, even a
process that left its group with `setsid` or a double fork. When land can't
set either, the checks don't run. macOS has no `/proc`, but `ps -E` still shows
land's starting environment to a same-user process. A check that moves HEAD
off the merged commit fails. Land re-reads the base policy after the locked
fetch, so a `land.merged_checks` that main gained meanwhile applies. When the
merged tree's lockfile or `package.json` dependencies differ from the
checkout's, the linked `node_modules` can't vouch for it: land refuses with
`QUEUE_NOT_READY` before any check runs, and the lane merges main and re-ships. It doesn't sandbox
the filesystem: a command can still write the checkout's `.git` (the worktree
shares it) and the linked `node_modules`, and read anything the user can (other
processes' environments, credential files), so pass the flag only for a base
policy and PRs you trust to run. A list such
as typecheck plus the size ratchets takes about two minutes, against a main
merge, a CI round and a new receipt per PR. gstack's own policy runs
typecheck, the generated-docs freshness check, and the size and budget guards
plus the core files of `test:quick` through the strict free runner on
`test/land-merged-checks.txt` (`test/ship-driver.test.ts` holds the
`ship/DRIVER.md` cap #3886 broke). Raw `bun test` exits 0 when a test calls
`process.exit(0)` or a listed file is missing; the runner fails both. It
doesn't run `test:quick` itself, because its browser tests find no Chromium
under the throwaway `HOME`. Without the key, land prints
`STALE_BASE: warn … no land.merged_checks configured` and merges the stale
base untested, as it did before the key. Then land runs `gh pr merge
--squash --match-head-commit <pin>` (`--merge` under `history: merge-only`),
reads the merge commit, and checks that its tree is the pin merged onto the
merge commit's parent. The land lock keeps other gstack landers off main
from the re-fetch to the merge, but a merge outside gstack can still land in
between. When that parent is neither the base land checked nor
one the pin contains, main moved between the check and the merge: land runs
`land.merged_checks` again on the landed tree, and reports
[`QUEUE_LAND_UNVERIFIED`](troubleshooting.md#queue-land-unverified) when they
fail or the key is absent. Last, it writes a `land` note on `refs/notes/gstack-trains`
and releases the lock. Land refreshes the lock right before the merge and
refuses if another lander broke it meanwhile. A rerun after GitHub merged goes
straight to the tree check and releases a lock an earlier run of the same land
left. It doesn't know which base the first run checked, so when GitHub merged
onto a base the pin doesn't contain, it runs `land.merged_checks` on the landed
tree (they need `--allow-repo-commands` there too), and without the key it
prints a `STALE_BASE: warn` line and checks the tree only. `--dry-run` takes
no lock, runs every other check, prints `DRY-RUN: land.merged_checks not run`
in place of the merged checks, and merges nothing; on a PR that already
merged it verifies nothing. Under `merge: direct`, `train build` refuses and
names this command.

<a id="direct-freeze"></a>
#### The freeze under `merge: direct`: `land --pin --repair`

While main's policy keeps a `train` block, the main backstop gates every push
to main, and a red gate writes a freeze record (`train backstop`) to
`refs/notes/gstack-trains`. `land --pin` and `release-cut` refuse while it is
active (`QUEUE_TRAIN_FROZEN`), and `train build --repair` is off with the
trains. Once main's policy declares [`release_gate`](#release-gate) the
backstop stands down and writes no freeze, so `land --pin` prints a
`FREEZE: warn only:` line for a backstop freeze left from before and lands;
a train's freeze still refuses. `release-cut` keeps refusing on that freeze
until a green release gate sits on a commit that contains its main
(`gstack-release-gate run --ignore-cadence` runs one now). Otherwise the repair goes through land:

1. `gstack-ship-queue land --pr <n> --pin <sha> --repair` admits exactly one PR.
   It runs every check in the table above. Then, under the land lock and after
   fetching the notes ref, it records `repair: { pr, head, train: null }` on the
   freeze, prints `REPAIR: #<n>@<sha> admitted under the land lock`, and lands
   the PR. The freeze stays active. Without an active freeze, `--repair`
   refuses with `QUEUE_NOT_READY`; a land without `--repair` stays refused.
   A train's freeze and a `release/<version>` head are refused with
   `QUEUE_TRAIN_FROZEN`: only a backstop freeze takes a land repair, and a
   release never repairs main.
2. A second `--repair` at another pin is refused while the admitted repair
   has merged on GitHub at its recorded pin (or GitHub can't say). One that
   never merged there, such as a land refused after the record was written or
   a PR merged by hand at another head, gives way to the next. A repair
   train's slot (`train` set) is never taken.
3. The backstop on the repair's main clears the freeze only on evidence: its
   gate is green on a commit at or after the freeze's main (by ancestry) that
   contains the merge the repair's `land` note names, and main is still that
   commit. While a freeze is active, a green-train record never stands in for
   the gate. It writes `cleared_at`
   and `cleared_by: "repair #<n>; backstop <run> green on <sha>"` and prints
   `BACKSTOP: freeze cleared (…)`. A green gate without that evidence prints
   [`BACKSTOP: green, but the freeze stands: <why>`](troubleshooting.md#backstop-freeze-stands).
   No green gate, no clear.
4. A red gate keeps the freeze and rewrites its reason with the new run
   ([`BACKSTOP: red, and the queue is already frozen`](troubleshooting.md#backstop-red-frozen)).
   When that main contains the admitted repair's merge and the gate concluded
   `failure`, the repair is spent: the slot is freed for the next `--repair`. A
   gate that never judged it (no run, cancelled, past the deadline) keeps the
   slot and says so in the reason. Main doesn't move while frozen, so both
   lines name `gh run rerun <backstop run id>` to gate the same commit again
   once the cause is fixed. Both steps rewrite the freeze by compare-and-swap
   after the gate finishes: they start from origin's notes, push without
   merging, and start over when the push is rejected. So a repair recorded
   while a gate ran is never overwritten, and a freeze the notes fetch can't
   read is never rewritten (`failed`).

A tooling fix merged by hand while frozen (`gh pr merge --squash
--match-head-commit`) clears nothing: its backstop, green or red, finds no
admitted repair. Train freezes keep their own path: `train build --repair`,
cleared by that train's verify.

<a id="release-stamp"></a>
### Versions at release: the release PR (`merge: direct`)

Under `merge: direct`, VERSION, the `package.json` version, CHANGELOG.md, the
release outputs and the `stamp_paths` constants move only in a release PR.
Before each regular stable cut (Monday and Thursday), and in the same turn it
lands a PR whose fragment carries `important:` ([the daily
check](releases.md#the-daily-check)), the Captain runs:

```bash
gstack-release-stamp open            # --dry-run prints the stamp and creates nothing
```

It stamps a fresh worktree of `origin/main` with `gstack-restamp --release`,
commits the result on `release/<version>`, pushes that branch and opens its PR.
The release stamp folds every fragment in `changelog.d/` under one new CHANGELOG
heading and deletes the files. The new version is the base's plus the highest
bump any fragment declares (the policy `bump` when none does). It reruns the
release tool, and it moves a tentative `stamp_paths` mention (a `*_KEY_VERSION`
a PR wrote ahead of its release) on lines added since the last version change.
With no fragment on main it refuses with
[`RELEASE_STAMP_EMPTY`](troubleshooting.md#release-stamp-empty).

When the release PR's checks are green, the Captain lands it like any other PR:
`gstack-ship-queue land --pr <n> --pin <head>`. On a `release/<version>`
branch, land needs no /ship receipt or READY note. Instead it checks that the
head is exactly the release stamp of its merge base, and that the merge base is
still the tip of `origin/main` (open the release again if main moved, so no PR
ships under a version its fragment missed): every fragment there folded and
none added, the version equal to the base's plus their bump, every
other change a stamp by the [tree receipt](#tree-receipt)'s rules, and a
changed release output equal to what the release tool generates at the new
version. A release may not delete a release output. Anything more is
[`RELEASE_STAMP_INVALID`](troubleshooting.md#release-stamp-invalid), and
nothing merges. A rerun after GitHub merged the release fetches the pin first,
then reads the pin's parent, the main commit it was stamped on, and checks that
the release merged onto it; a parent it can't read is `QUEUE_NOT_READY`, never
a pass. The Version Gate (`Check VERSION is not stale vs queue`)
applies the same test, so a release head passes it while any other PR that
changes VERSION still fails it. Once the release PR lands, the next stable cut
tags `v<version>` ([releases.md](releases.md)).

<a id="migrating-to-fragments"></a>
### Migrating to fragments

Before turning the key on, run `gstack-ship-queue land --census` (read-only).
It prints one line per open PR, saying whether land would fold its fragments, re-head a legacy
`[Unreleased]`, rewrite a tentative per-PR VERSION bump, resolve a
release-field-only conflict, write an entry from the title, or refuse on a
product conflict. Then set `changelog_fragments` and `min_gstack_version` in
one policy PR; a claim-at-open repository switches `queue_mode` to
`stamp-at-merge` in the same PR. Open PRs need no change: `land` handles each
census case. Rollback is removing the key. With it off, `gstack-restamp`
neither folds nor deletes fragment files, so first land every open PR that
carries a fragment (`land --census` lists them) or move each fragment's text
under `[Unreleased]` in its PR; otherwise that entry never reaches CHANGELOG.md.

<a id="tree-receipt"></a>
## The tree receipt

```bash
gstack-tree-receipt --from .gstack/tmp/gate-ahead.json --predecessor-pr 41 --bundle evidence-bundle.json
gstack-tree-receipt --gated <sha> --current HEAD --json
```

Compares two **committed heads** (a working-tree fingerprint can name objects
unreachable once the gate VM is gone) and prints the gated and current heads,
both tree ids, the version pair, the predecessor the gate assumed, the diff
limited to stamp files, one line per file with its rule and verdict, one line
per gate, then two verdict lines:

```
TREE: same-modulo-stamps | changed (<residual paths>)
gate-reuse: eligible (reusable: tests; rerun: digest) | not-eligible (<what changed>) — fix: <rerun command> (GATE_REUSE_NOT_ELIGIBLE)
```

Hunks are classified per file type: the version file (old → new only), the
manifest (`version` key only), npm and bun lockfiles (root `version` keys
only, where `gstack-version-bump` writes; a dependency entry is `changed`),
the CHANGELOG (a heading move or re-heading, compared as an order-independent
multiset of entries; under `changelog_fragments`, also exactly the deleted
fragments folded under the new heading, and those deletions are stamps), `stamp_paths` and `release_outputs` (every
removed/added pair must be an exact `(was X)` / `since: X` / `vX` rewrite (a quote around X in the first two forms included) with
X the gated version, or a newer version of the repo's width that the
stamp_paths stage moves (a tentative `*_KEY_VERSION` written as the next
minor, #3512; a version older than the gated one, or of another width, is a
hand edit), and the replacement the current one, so a dependency pin
that happens to equal the old version is `changed`; `stamp_patterns`
templates count as stamp forms too). A `release_outputs` file that is more than
those rewrites (a release tool that renders content, GST-1176), or that the
stamp adds, is a stamp, rule
`release_tool`, when the policy's `release_tool`, rerun on the current head at
its version, writes it byte for byte: the release PR's and the Version Gate's
rule. The tool is repo code, so the receipt reruns it only with
`--allow-repo-commands`, and `train build --allow-repo-commands` applies it to
each stamped prefix; without the flag the file stays `changed`. The rerun is
the Version Gate's: the stamped head (CHANGELOG folded, fragments deleted), a
bare environment and a 120-second limit, so an output that depends on anything
else fails closed as `changed`. With `stamp_files` set, a file outside it
is `changed (stamp_files: not in the repo's stamp_files allowlist)` whatever
its diff. Any other byte is a change. A diff git cannot produce between the two
heads fails closed with `EVIDENCE_IDENTITY_UNKNOWN` and git's reason; it never
reads as no change.

Equivalence is decided per gate. A lane in `stamp_sensitive_gates` always
`rerun`s; a verified lane is `reusable` only when the tree is same-modulo-stamps
and the execution identity in the bundle equals the current one: Bun and Node
versions, OS and arch, every lockfile's identity (root version normalized
away), the `.github/workflows` tree id, runtime pin files and
`package.json#engines`, and the runner image when either side knows it. Without
a bundle the identity is unknown and the receipt is `not-eligible`. When the
recorded predecessor head is no longer the predecessor PR's head (checked
through `--predecessor-ref` or `gh pr view --predecessor-pr`) the receipt
prints `PREDECESSOR MOVED <old> -> <new> — fix: gstack-restamp --after <pr>
again (RESTAMP_PREDECESSOR_MOVED)` and refuses `eligible`.
<a id="plain-titles"></a>
## Plain titles: `.gstack/plain-titles.json`

People outside a project read its pull requests and commit log to decide
whether it is worth using. So PR titles (and the squash commit titles they
become), branch names, the opening of each PR body, changelog entries and commit
subjects say in everyday words what changed for someone using the project, for
example "Stop gstack from hitting GitHub's rate limit while it waits on PRs".

**Front for humans, end for machines.** The rule applies to the readable front.
A title may end with one group of references, such as `(GST-1713)`,
`(GST-1808, GST-1809)` or `(#4122)`; that group is never checked. A branch
may end with one tracker code (`capy/github-rate-limit-gst-1713`). A PR body
opens with one or two plain sentences (what changed and which goal of the
project it serves) and keeps tracker codes, the ship record and other
machine-read lines in the Agent notes section at the end, below the
`<!-- gstack:agent-notes -->` marker. The checker skips that section.

What the checker refuses in the front:

- a tracker code matching one of the policy's `codes` patterns;
- a word or phrase from `terms` (whole words, any case; in branch names a
  hyphen or underscore counts as a space);
- in titles and commit subjects, a `word(scope):` prefix, since the scope is
  usually an internal module name. A bare `fix:` or `docs:` is allowed, and so
  is a leading version such as `v1.98.0.0 release`;
- in the PR opening, a first block that is a heading, code block, list, table,
  HTML or image, or a paragraph longer than two sentences;
- in a changelog entry, a tracker code anywhere, and a listed word in the bold
  lead. Code spans, code blocks, links and quoted words are skipped.

### The policy file

Each repository opts in by committing `.gstack/plain-titles.json`
(`gstack-plain-title init` writes an example; `gstack-plain-title validate`
checks it). Without the file every check passes with
`PLAIN_TITLE: none (no policy)`, so gstack's own word list never blocks
another project. The keys:

| Key | Meaning |
|-----|---------|
| `codes` | Regex patterns for tracker codes, matched in any case. Keep them narrow: `\\b(?:GST\|GSTA)-\\d+\\b`, not every `ABC-123`, so `UTF-8` stays readable. |
| `terms` | The project's own words that mean nothing to an outside reader. |
| `allow` | `{ "text", "reason" }` entries. A refused match inside an allowed phrase passes. Every entry says why. |
| `since` | A date (`YYYY-MM-DD`, midnight UTC). PRs created before it are exempt, so nothing already open breaks. |
| `exempt_branch_prefixes` | Branch prefixes that gstack's own tools generate; those branches are not checked. |

gstack's own file lists its tracker prefixes (GST, GSTA, GBRA, GEVA, FOUN, HARN,
ALPH) and R-numbers (`R76`), the crew and Captain names, and the words last
week's titles used most: voices, outside voice, pregate, fix-check, ledger,
receipt, train, wave, lane, restamp and no-stop, with their plurals where
they were used. It exempts `release/` (the release PR), `wave/` (wave PRs) and
`gstack-land-repair/` (land's repair PR). The allow list is one entry, kept short
on purpose:

| Allowed | Why |
|---------|-----|
| `R2` | Cloudflare R2, the storage service, not a rules number. |

"merge train" is not allowed: to a reader outside the crew it still names
gstack's own merge process, so titles say "merge several PRs together" instead.

### Where it runs

1. **/ship, before posting.** /ship writes a plain title and runs
   `gstack-plain-title check` on the title, the branch (before its first
   push), the PR opening and the changelog fragment, and rewrites anything it
   refuses.
2. **gstack-post, before posting.** `gstack-post pr-title` and `pr-create`
   run the title check first and post nothing when it refuses.
3. **The "Plain title" CI check** (`.github/workflows/plain-title.yml`). It
   runs on every new PR, on each push, and when the title or body is edited.
   It fails on a refused title and only warns about the branch name, the
   opening and commit subjects, because those cannot always be fixed in place.
   It runs on `pull_request_target` with a read-only token and the base
   repository's checkout, so a PR is checked against the policy and checker
   already on main and cannot change either; the PR text reaches the checker
   only as files. The PR that first adds the workflow does not run it for the
   same reason.

`gstack-plain-title check` exits 0 when everything passes, the policy is
missing, the PR is exempt or there are only warnings; 1 when something is
refused; 2 on a usage error; 3 when the policy is invalid. Each finding is
one `PLAIN_TITLE:` line naming only the matched words, and the last line is
`PLAIN_TITLE: ok | refused=<n> | warned=<n> | exempt (created before <since>) | none (no policy)`.
Codes and fixes: [troubleshooting.md](troubleshooting.md#plain-title-refused).

### Making it a required check

The rollout took two merges. The first shipped the checker, the writers and the
workflow. The second added `"Plain title"` to gstack's
`changelog_fragments.required_checks`, so `gstack-ship-queue land` refuses a
PR whose check is red or missing. A PR opened before the workflow existed has no
run until its title or body is edited or a commit is pushed; do one of those
before landing it. The workflow reads the PR body from the event file, not an
environment variable, so a very long body still reaches the checker.
