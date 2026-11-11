# Releases and update channels

gstack used to stamp a version at every merge to main. Under `merge: direct`
PRs land unstamped, with a `changelog.d` fragment each, and the version moves
only when the Captain lands a release PR (`gstack-release-stamp open`, see
[ship-policy.md](ship-policy.md#release-stamp)). Since late October 2026 there
is also a tagged release, and new installs and team-mode installs follow it
instead of every merge. It is cut twice a week, and since November 2026 a daily
check also cuts it within about a day of an important change and never lets it
go more than a week stale while main has gated changes ([the daily
check](#the-daily-check)).

Land a release PR before each cut. The cut tags the VERSION it finds, and a
version is tagged once: if no release PR landed since the last cut, the next
cut finds that version's tag on an older commit and refuses with
`NO_RELEASE_PR` (a dry run reports it and exits 0). A release PR
lands only on the main it was stamped on, so open it again if main moved. The
cut tags the newest green commit, so a PR that lands between the release PR
and the cut ships in that tag, and its CHANGELOG entry appears in the next
release.

## What a release is

Every day at 14:00 UTC (07:00 Pacific, 06:00 in winter) the **Stable
release** workflow (`.github/workflows/weekly-release.yml`, which runs
`crew/scripts/release-cut.ts --daily`; the file kept its old name so its run
history and the `gh workflow run` commands below stay valid) runs the daily
check. On Monday and Thursday that is the regular cut; on any day an important
change or a week-old stable can trigger one. A cut takes the newest green
commit on main and:

1. tags it `v<VERSION>` (the VERSION file at that commit, an annotated tag);
2. publishes a GitHub Release whose notes are one line per CHANGELOG version
   since the previous release, with a compare link and a link to the full
   CHANGELOG at that tag;
3. fast-forwards the `stable` branch to it.

A tag and its release never change. `stable` is a moving pointer: always a
commit on main's first-parent history, moved only by this workflow, only
forward, and at most once every 72 hours, except for an important change
(24 hours, [the daily check](#the-daily-check)) or a verified security or
regression fix (below).

**Green** means, on that exact commit: the `free-tests` check run succeeded
(the status main requires), the commit was gated (below), every check run on
it has completed and none failed, and `refs/notes/gstack-trains` holds no
active freeze. A cancelled check run counts as red. A commit with a check run
still going is skipped and the next older one is considered, back through 7
days or 200 first-parent commits. The cut's own job lands a check run on
main's head, the very commit it may cut, so check runs from this workflow's
own runs (its file path, `.github/workflows/weekly-release.yml`, matched
by the job ids of those workflow runs) are set aside whether running or
failed; every other check run counts as above. The lookup needs the
workflow's `actions: read` permission; when it cannot read those runs, nothing
is set aside. The workflow runs no tests and no paid evals
of its own; it only reads what the trains, the backstop and the release gate
already recorded.
With nothing green in the window it fails and lists why each commit was
skipped.

**Gated** means one of three pieces of evidence. The first is the
`main-backstop` check run: the Main backstop gate workflow publishes it on
each push to main from a job of its own, success when a green train record
covers the tree or the backstop gated it green, neutral when main moved past
the push before it was gated (superseded) or a freeze's own backstop run owns
it (deferred), failure when it froze the queue or could not finish. The second
is a train record in `refs/notes/gstack-trains` (kind `train`, state
`green`, `merging` or `merged`) whose `merged[]` lists the commit's sha or
its tree: those entries are the main commits `gstack-ship-queue verify
--train` confirmed, so a commit a green train merged is gated even when trains
merged faster than the backstop could settle and its own backstop run ended
neutral or never ran. The `CANDIDATE` line says which: `gated by
main-backstop` or `gated by train <nonce>`. The third is a GREEN release
record (kind `release`) on the commit, written by the release gate
([docs/ship-policy.md#release-gate](ship-policy.md#release-gate)) when the
policy declares `release_gate`; the line then says `gated by release gate run
<id>`. A RED release record with no GREEN one on a later commit that
contains it refuses the cut like a freeze. Train evidence relaxes nothing
else: a red backstop run, a failed or missing `free-tests` run, any other red
check run or a run still going keeps the commit out, and a record in any other
state (`red`, `superseded`, `free-green`, …) is not evidence. A commit with
none of the three (no successful backstop run, train record or GREEN release
record) is not released: a
dependabot push, a policy without a train block, or a tree that was never
gated.

Another repository runs the same script with its own names:
`--required-check <name>` (default `free-tests`), `--backstop-check <name>`
(default `main-backstop`) and `--notes-ref <ref>` (default
`refs/notes/gstack-trains`). `weekly-release.yml` passes none of them.

A cut that stopped half-way (tag and `stable` pushed, release not created) is
finished by the next run, by cron or by hand: `stable` itself stays a
candidate until its release exists, and its notes compare against the release
tag before it.

<a id="the-daily-check"></a>
## The daily check

Garry, 2026-11-06 (R74): "make sure anything important makes it to stable as
frequently as once a day and as infrequently as once a week". Every scheduled
run is the daily check (`crew/scripts/release-cut.ts --daily`, decision logic in
`crew/scripts/release-cadence.ts`). It picks the candidate exactly as any cut does
(the newest green, gated commit; nothing ungated ever ships) and then cuts when
one of three triggers holds, each over its own floor since `stable` last moved:

| Trigger | When | Floor |
|---|---|---|
| important | a commit in `stable`..candidate added a `changelog.d` fragment marked `important:` | 24 hours |
| forced | `stable` is 7 days old and the candidate is newer than `stable` | 168 hours |
| regular | it is Monday or Thursday (UTC) | 72 hours ([the floor](#the-72-hour-floor)) |

A scheduled run gets the same 3-hour grace for late cron starts on every floor
(21, 165 and 69 hours); a hand-run daily check gets none. With no trigger the
run changes nothing, exits 0 with a notice and says why:
`DAILY: no-op: nothing important since stable; stable moved 50.0 h ago; …`. An
important change still under its floor is `DAILY: wait: …` with
`NEXT_ALLOWED:`. An important change that landed after the candidate (the
release gate has not gated it yet) is listed as `IMPORTANT_UNGATED:` and
counts toward nothing until a green, gated commit holds it.

**Marking a change important.** The PR's fragment carries the field in its
front matter, beside any `bump:`, so every reviewer and the Captain read it in
the PR diff before it lands:

```markdown
---
important: security
---
**Fixed the tar path traversal in gstack-upgrade.**
```

| Value | Use it for |
|---|---|
| `security` | a fix for a vulnerability or a leaked secret path |
| `regression` | behavior that worked in an earlier stable release and is broken on the current one |
| `data-loss` | a fix that stops gstack destroying or corrupting a user's files, state or work |
| `blocker` | a fix for something that stops crews or users from working (an install, upgrade or core skill that fails) |

Any other value is `CHANGELOG_FRAGMENT_INVALID`. The marker is attested, not
verified: it is the PR author's claim, reviewed with the diff like `bump:`.
The words match the two verified exceptions: a fix that cannot wait 24 hours
still uses a hand-run [security](#security-releases) or
[regression](#regression-releases) cut, which checks labels and passes the
floor. The daily check reads each fragment at the commit that added it, so the
release stamp folding and deleting the file does not hide it. A fragment that
lands after the release PR was stamped still ships its code in the next cut;
its CHANGELOG entry appears in the release after that.

**The release PR.** A cut tags the VERSION it finds, so an important change
needs a release PR after it. The daily run never stamps or opens one: the
Captain runs `gstack-release-stamp open` in the same turn it lands a PR whose
fragment carries `important:`, and lands the release PR once its checks pass
([captain.md](../crew/docs/captain.md#direct-land-merge-direct)). When any trigger is due
but the candidate's VERSION is already released on an older commit, the run is
`NO_RELEASE_PR: important change waiting, no release PR: …` (or `stable is 7
days old, no release PR`, or `regular cut due, no release PR`) and goes red
so someone stamps. A week-old `stable` whose main moved but holds nothing
newer that is green and gated is `STABLE_STALE`, also red: the gate or the
checks are holding main.

**How long it takes.** An important PR lands; the Captain stamps and lands the
release PR; the [release gate](ship-policy.md#release-gate) gates main's head
at its next 8-hour slot (up to about 4.5 hours of run); the next 14:00 UTC run
cuts once `stable` is 24 hours old. That is usually within a day and at worst
about 40 hours (estimated, not measured). Running the daily check by hand once
the gate is green skips the wait for 14:00:

```bash
gh workflow run weekly-release.yml -f daily=true -f dry_run=false
```

| Daily outcome | Real run | Dry run |
|---|---|---|
| `DAILY: cut (…)`, then the plan and `TAG:` / `STABLE:` / `RELEASE:` | exit 0 (1 if a cut step fails) | plan, exit 0 |
| `DAILY: no-op: …` or `DAILY: wait: …` | exit 0, notice | exit 0, notice |
| `NO_RELEASE_PR: …` or `STABLE_STALE: …` | exit 1, error | exit 0, warning |
| any other refusal (a freeze, `NO_GREEN_COMMIT`, `FLOOR_UNKNOWN`, a non-fast-forward, a version tagged on an unrelated commit) | exit 1, as for any cut | as for any dry run |

## The 72-hour floor

`stable` moves at most once every 72 hours (Garry, 2026-10-27), except for an
important change, whose floor is 24 hours ([the daily check](#the-daily-check),
R74). Every cut, scheduled or by hand, with or without `ref`, checks when
`stable` last moved:
the creation time of the annotated `v<VERSION>` tag (VERSION read at `stable`)
pointing at `stable`, or the publish time of that tag's GitHub Release when it
is later (a cut whose `stable` push was retried after the tag was pushed is
dated by its release). Any other tag on that commit is ignored, so a hand-made
extra tag can neither date the move nor stall later cuts.
A cut inside the floor changes nothing and prints, as its first two lines:

```
REFUSED_FLOOR: stable moved to v1.91.300.0 at 2026-11-02T14:04:51Z, 47.2 h ago; a hand-run cut needs 72 h; a security fix passes with --security "<GHSA-…|CVE-…|#n>: why" --ref <fix sha>, a regression fix with --regression "#n: worked in v<X>: why" --ref <fix sha>
NEXT_ALLOWED: 2026-11-05T14:04:51Z for a hand-run cut; 2026-11-05T11:04:51Z for a scheduled run
```

followed by the plan it would have run. Monday to Thursday is exactly 72
hours, so scheduled runs, and only scheduled runs (`GITHUB_EVENT_NAME=schedule`,
which no dispatch input can set), get a 3-hour grace for GitHub's late cron
starts: a Thursday run 69 hours after a late Monday cut still cuts. Two
regular moves are therefore never less than 69 hours apart, and a hand-run cut
always needs the full 72. Thursday to Monday is 96 hours.

A refused hand cut exits 1 with an error annotation. A refused scheduled run
exits 0 with a notice annotation and the same lines in the step summary: that
is the policy working (a security or regression cut on Wednesday restarts the
floor and holds Thursday, and Monday's cut carries everything), not a fault. A dry run prints the plan and
the floor verdict (`FLOOR:` line) and exits 0.

Two cases are not held. The first cut, before `stable` exists, has nothing to
measure. Finishing a half-done cut (`stable` already at the candidate, release
missing) is not a new move, and a run without `ref` finishes that cut before
it considers anything newer.

The floor fails closed when it cannot date the move. Three cases are
`FLOOR_UNKNOWN`, red on every trigger, and only a verified security cut gets
past them (a regression cut passes a dated floor only). They are a `stable` that no annotated `v<VERSION>` tag dates
(only this tool moves `stable` and it tags first, so that state means someone
moved it by hand), a release that cannot be read (a GitHub API error is not
"no release"), and a `ref` cut while `stable`'s own release is still
unpublished (its tag may be days older than the push). A tag dated in the
future holds the floor from now, not from that date. The floor binds the
release tool, not a writer pushing `stable` directly; that would take a branch
ruleset limiting `stable` to the Actions bot.

Breakage that is not a regression of an earlier stable release (a new
feature that misbehaves, say) waits for the floor; an affected install can
follow main meanwhile (`gstack-config set update_channel main`) and the next
scheduled cut brings it back.

## Security releases

A security fix is one of the two exceptions to the floor (the other is a
regression fix, below); a cut carries one exception, never both. Run the workflow by hand
with `ref` set to the fix commit on main and `security` set to a reason that
names what it fixes:

```bash
gh workflow run weekly-release.yml -f ref=<full sha of the fix> -f security="GHSA-xxxx-xxxx-xxxx: tar path traversal" -f dry_run=false
```

The reason must name a `GHSA-…`, a `CVE-…` or an issue or pull request
`#<n>`, and the tool checks that it is tied to the commits being released
(`stable`..`ref`). One of these must hold:

1. a commit message in that span names the same GHSA or CVE;
2. issue or pull request `#<n>` carries the `security` label and a commit in
   the span references `#<n>` (the squash subject `(#<n>)` does);
3. the GitHub Advisory Database entry for the GHSA or CVE (the data OSV
   imports) lists an npm package whose own entry changes in the span's
   `package.json` or `bun.lock` (a dependency line or a lockfile package key,
   never a name listed inside another package's entry): a dependency bump that
   fixes a known advisory. The direction of the bump and the patched range are
   not checked.

**Verified:** the identifier exists in the reason, the label exists on the
issue, and the link between the identifier and a released commit or bumped
package. **Attested, not verified:** that the change actually fixes the
vulnerability, how severe it is, and that it cannot wait; the `security`
label itself is applied by a person with triage access. A reason the tool
cannot tie to the span is `REFUSED_SECURITY` with what it checked, red on
every trigger, as is `security` without `ref`: a security cut releases up to
the fix, never whatever happens to be newest. Every version between `stable`
and the fix still ships with it (there are no cherry-picks); the plan's
`RIDING_ALONG:` line counts them.

The reason is public. It goes, as one line of at most 300 characters (control
characters become spaces and backticks become apostrophes), into the tag
message and the release notes: ``**Security release:** `<reason>` (verified: <evidence>)``. For an
embargoed fix, use path 2 with a neutral commit subject and a labelled issue
whose title says no more than the fix does, and keep advisory details out of
the reason until disclosure.
A security cut that stopped half-way after moving `stable` is finished by
the next run with the reason and evidence its tag recorded, without checking
them again. A tag that records a security cut but never moved `stable` gets
no such pass: the cut is refused (`REFUSED_SECURITY`) until it runs again
with `security`, `ref` and the reason its tag recorded, and verifies. The floor then counts from the security
release, and the next regular cut's notes list only the versions after it.

## Regression releases

A regression fix is the other exception (Garry, 2026-10-28: "Regression"). A
regression is a fix for behavior that worked in an earlier stable release and
is broken on the current one. A maintainer declares it by putting the
`regression` label on the issue or pull request (labelling needs triage
access; create the label once if the repository lacks it), and the person
running the cut names it in the `regression` input, with `ref` set to the
fix commit on main:

```bash
gh workflow run weekly-release.yml -f ref=<full sha of the fix> -f regression="#3601: worked in v1.91.300.0: the update check stopped running" -f dry_run=false
```

The reason must name exactly one release `v<X>` and at least one `#<n>`.
All of these must hold, or the cut is `REFUSED_REGRESSION` with what it
checked:

1. `v<X>` is an annotated release tag strictly behind the current `stable`
   whose GitHub Release is published (not a draft): an earlier stable release
   team installs actually ran, which a tag left behind by a half-done cut is
   not. The current stable
   itself does not count, since a fix for something it still does right needs
   no exception.
2. `#<n>` carries the `regression` label (a `security` label does not count,
   nor the reverse) and a commit in `stable`..`ref` references it (the squash
   subject `(#<n>)` does).

**Verified:** the release tag, its place behind `stable` and its published
release, the label, and
that the labelled issue or PR is in the released span. **Attested, not
verified:** that the behavior really worked in `v<X>` and that this change
restores it; the label and the public reason carry that claim.

Everything else matches a security cut. `ref` is required, `regression` and
`security` together are refused, every version between `stable` and the fix
rides along (`RIDING_ALONG:`), and the sanitized reason and evidence go into
the tag message (`Regression:` / `Verified:`) and the notes
(``**Regression release:** `<reason>` (verified: <evidence>)``). A half-done
regression cut finishes from its tag's record, and a regression tag that never
moved `stable` is refused until it runs again with `regression` and the reason
its tag recorded, and verifies.
Unlike a security cut, a regression cut does not pass `FLOOR_UNKNOWN`. The
floor counts from the regression release, so the next scheduled cut may be
held.

## Channels

| Channel | Follows | Who |
|---|---|---|
| `stable` | `refs/heads/stable`: the twice-weekly release (at most once per 72 hours), an important change's cut within about a day (24-hour floor), a forced cut when it is a week old, plus any security or regression cut off-cycle | new installs, team mode (`./setup --team`) |
| `main` | every merge to main | contributor checkouts, installs set up before stable became the default, Capy crew machines |

The config key is `update_channel` (`bin/gstack-config`):

```bash
gstack-config get update_channel          # auto (default) | stable | main
gstack-config set update_channel main     # a team install that wants every merge
gstack-config set update_channel stable   # a solo install that wants stable releases
gstack-config unset update_channel        # back to auto
```

Which channel an install gets:

- **A new install follows `stable`.** The first `./setup` on a machine (no
  `.last-setup-version` or `config.yaml` in the state root, and no legacy
  `~/.gstack/.last-setup-version` or `~/.gstack/config.yaml`) records `update_channel: stable` and prints
  `Update channel: stable (new install)` with the command that switches. When
  `GSTACK_UPDATE_CHANNEL` is set during that first setup, its value is
  recorded instead, and a Capy machine (`CAPY_MACHINE_CONFIG` or
  `~/.capy/system`) records `main`. The clone starts at main's latest
  commit; since nothing moves a checkout backwards, a new stable install runs
  that build until the next cut passes it, then follows releases.
- **A contributor checkout follows `main`.** That first setup records nothing,
  so the key stays `auto`, when the checkout is a contributor's:
  `git config gstack.contributor true` (what `bin/dev-setup` writes) or
  `GSTACK_CONTRIBUTOR=1`, `CI` set, a directory that is not its own git
  repository, a detached HEAD, a branch other than origin's default, no
  upstream branch, or commits the upstream does not have. Setup prints the
  reason.
- **An existing install keeps what it had.** `auto` resolves to `stable` when
  `team_mode` is true and to `main` otherwise, so installs set up before this
  default keep following `main` (team installs keep `stable`) and nothing is
  switched under them. The updater never moves a checkout backwards, so an
  install that has lived at main's head and switched to stable would sit
  still until the next cut passes its version; switching is one command for
  anyone who wants it, never a silent change.
- **Capy crew machines follow `main`.** `bin/gstack-capy-session` sets
  `GSTACK_UPDATE_CHANNEL=main` for everything a session start runs (the
  self-upgrade, `./setup`, the installer) unless the variable already names a
  channel, so a fresh Capy machine records `main` and an existing one follows
  main whatever its own config says. `GSTACK_UPDATE_CHANNEL=stable` in the
  session's environment follows the release instead.

`GSTACK_UPDATE_CHANNEL=stable|main` overrides the key for one command. The resolution lives in one helper,
`bin/gstack-update-channel.sh`, used by:

- `bin/gstack-session-update`, the team-mode session-start hook: it fetches
  the channel ref and fast-forwards to it. Its log
  (`<state root>/analytics/session-update.log`) carries `CHANNEL stable target=<sha>`
  when it follows a release.
- `bin/gstack-update-check`, the "update available" line in every skill
  preamble: it reads `<channel>/VERSION` and compares with `refs/heads/<channel>`,
  so a stable install is not told every hour that main moved.
- `bin/gstack-upgrade` and `/gstack-upgrade`: they fast-forward to the channel
  ref (`UPSTREAM_REF=origin/stable` in the skill's output) and say which channel
  they followed.
- `capy/skill/gstack/scripts/install.sh`, the Capy skill's installer: from
  wrapper revision 5 a fresh clone or a floor upgrade follows `stable` only when
  `GSTACK_UPDATE_CHANNEL=stable` and `stable` meets the support floor, and
  follows main otherwise (revision 4 also followed the machine's own channel).
  `--revision` still pins an exact commit.

Two edge cases are handled on purpose:

- **Before the first release exists** origin has no `stable`. Every caller then
  follows main and says so (`CHANNEL_FALLBACK stable->main` in the hook log,
  `channel stable has no release on origin yet` from `gstack-upgrade`).
- **An install already past the release** (it followed main until now, or a
  hotfix was cut below it) stays where it is until stable passes it. The
  updater never moves a checkout backwards. A depth-1 clone cannot see that an
  older release is its ancestor, so the VERSIONs decide: main stamps a higher
  version at every merge (under `merge: direct`, at every release PR) and stable is
  always a main commit.

The local branch stays `main` either way. A stable install is a `main`
checkout parked at the last released commit, which is why fast-forward-only
still holds and nothing about version stamping changed.

## Cutting a release by hand (hotfixes)

A hotfix is an ordinary PR: it merges to main through a train and gets its
version like any other change (under `merge: direct`, from the next [release
PR](ship-policy.md#release-stamp), which has to land before the cut). To put it on stable before the next scheduled
cut, run the workflow by hand with the merge commit's SHA, once the 72-hour
floor allows it (a security or regression fix uses its input instead):

```bash
gh workflow run weekly-release.yml -f ref=<full sha on main> -f dry_run=false
```

or open Actions, pick **Stable release** and press Run workflow, on main (the cut job runs
only from `refs/heads/main`, with main's tooling; `ref` must be the full
40-hex SHA). The same green checks apply. The commit is tagged with its VERSION, the release notes say "hotfix release"
and list every version since the previous release (everything merged in
between ships with it), and stable fast-forwards. Team installs pick it up at
their next hourly check.

There is no release branch and no cherry-picking: stable only ever names main
commits. If main carries a change that must not ship yet, revert it on main
first, then promote.

## Dry runs

Run the workflow with `dry_run=true` (the default for a manual run) to see the
plan without changing anything: the candidate, its VERSION and tag, the stable
move, how many version lines the notes would carry, every skipped commit with
its reason, the floor verdict, and the exact commands a real cut would run. The scheduled
runs are never dry runs.

```bash
gh workflow run weekly-release.yml -f dry_run=true
gh workflow run weekly-release.yml -f dry_run=true -f daily=true   # the daily check's decision
gh run watch
```

The step summary carries the same plan plus the full release notes.

A pull request that touches `.github/workflows/weekly-release.yml`,
`crew/scripts/release-cut.ts`, `crew/scripts/release-cadence.ts` or
`lib/changelog-fragments.ts` runs the same dry run against main as its own job
(`Dry run against main`, read-only token), once plain and once as the daily
check, so a change to the release tooling is exercised against real check runs
before it merges.

<a id="rolling-stable-back"></a>
## Rolling stable back

`stable` only moves forward through the tool, and the updater never moves an
install backwards, so a rollback stops the bad release from reaching more
installs and the fix ships forward. Installs that already updated stay on the
bad release until the fix-forward cut. Do the steps in order; step 1 matters,
because the next daily run would otherwise cut the bad commit again (the floor
dates the move by the older release's tag, so nothing holds it).

1. Hold every cut, scheduled and hand-run:

   ```bash
   gh workflow disable weekly-release.yml
   ```

2. Move `stable` back to the last good release, leased on the bad commit so a
   concurrent move fails instead of being overwritten:

   ```bash
   git fetch origin '+refs/heads/stable:refs/remotes/origin/stable' --tags
   BAD=$(git rev-parse origin/stable)
   GOOD=$(git rev-parse 'v<good version>^{commit}')
   git merge-base --is-ancestor "$GOOD" "$BAD" && \
     git push --force-with-lease=refs/heads/stable:"$BAD" origin "$GOOD:refs/heads/stable"
   ```

   Team installs that have not updated yet now stay on `v<good version>` at
   their next hourly check. The bad tag and its release stay (a tag never
   changes); say so on the release, which release-cut reads only for existence
   and publish time:

   ```bash
   gh release edit v<bad version> --prerelease --title "gstack v<bad version> (withdrawn)"
   ```

3. Fix forward on main: a revert or fix PR whose fragment carries
   `important: regression` (or `security`, `data-loss`). The Captain lands
   it, stamps and lands the release PR, and the release gate gates it.

4. Release the fix and lift the hold. The floor counts from the good release,
   so it is clear; the dry run shows the candidate first:

   ```bash
   gh workflow enable weekly-release.yml
   gh workflow run weekly-release.yml -f daily=true -f dry_run=true
   gh workflow run weekly-release.yml -f daily=true -f dry_run=false
   ```

   Or cut the fix commit itself: `gh workflow run weekly-release.yml -f
   ref=<full sha> -f dry_run=false`. The notes list every version since
   `v<good version>`, the withdrawn one included.

One install that must leave the bad release before the fix-forward cut can be
parked on the good one by hand (it discards local changes in that checkout):
`git -C <install checkout> fetch --tags origin && git -C <install checkout>
reset --hard 'v<good version>'`. Its next update check fast-forwards it to
`stable` again.

## Outcomes

| Line | Meaning |
|---|---|
| `CANDIDATE: <sha> (<date>) gated by main-backstop|train <nonce>|release gate run <id>` | the commit that will be (or was) released, and which evidence gated it (`[hotfix: --ref]` before `gated by` on a `--ref` cut) |
| `NOTHING_NEW: origin/main <sha> is already released as v<X>` | nothing merged since the last release; exit 0 |
| `NO_GREEN_COMMIT: ...` with `SKIPPED:` lines | nothing in the window passed the gate; exit 1 (a dry run exits 0: the skips are its answer) |
| `REFUSED: non-fast-forward: ...` | the candidate is behind stable; stable only moves forward |
| `REFUSED: queue frozen since train ...` | the main backstop froze the queue; clear it first (docs/ship-policy.md) |
| `REFUSED: release gate red on <sha> (<cases>) and no gate on a later commit is green; ...` | the release gate's hold: land the revert or fix-forward, then `gstack-release-gate run --ignore-cadence` ([docs/ship-policy.md#release-gate](ship-policy.md#release-gate)) |
| `REFUSED: tag v<X> already names <other sha>` | a version was stamped twice (the tag is on a commit that is not an ancestor of the candidate); needs a look before anything is cut |
| `REFUSED_FLOOR: stable moved to v<X> at <time>, <h> h ago; ...` | inside the 72-hour floor; nothing changed. Exit 1 by hand, 0 on the schedule or a dry run |
| `NEXT_ALLOWED: <time> for a hand-run cut; <time> for a scheduled run` | follows every `REFUSED_FLOOR` (and `FLOOR_UNKNOWN`, where it says why there is no time) |
| `FLOOR_UNKNOWN: ...` | stable's last move cannot be dated (no annotated `v<VERSION>` tag, an unreadable release, or an unpublished release under a `ref` cut); exit 1 on every trigger |
| `REFUSED_SECURITY: ...` | `security` without `ref`, a reason the tool cannot tie to the released commits, a security tag that never moved stable run without `security`, or a rerun whose reason differs from the one its unmoved tag recorded; exit 1 on every trigger (the workflow stops `security` without `ref` before the script runs) |
| `REFUSED_REGRESSION: ...` | `regression` without `ref` or beside `security`, a reason without one earlier stable `v<X>` and a regression-labelled `#<n>` in the span, a regression tag that never moved stable run without `regression`, or a rerun whose reason differs from the one its unmoved tag recorded; exit 1 on every trigger (the workflow stops `regression` without `ref` before the script runs) |
| `FLOOR: clear|refused|unknown|none|not applied|bypassed by the security|regression exception (...)` | the floor verdict, in every plan |
| ``SECURITY: `<reason>` (verified: <evidence>)`` or ``REGRESSION: `<reason>` (verified: <evidence>)``, `RIDING_ALONG: <n> other versions ship with the fix` | an exception cut's plan |
| `TAG:`, `STABLE:`, `RELEASE:` | what the cut did; a re-run reports each step as already done and finishes a step an earlier run did not reach |
| `DAILY: cut (important|forced|regular: ...)` | the daily check's trigger and floor; the plan and the cut follow |
| `DAILY: no-op: ...`, `DAILY: wait: ...` | the daily check found no trigger, or an important change still under its 24-hour floor (`NEXT_ALLOWED:` follows); exit 0 with a notice |
| `IMPORTANT_UNGATED: ...` | an important change landed but no green, gated commit holds it yet; informational |
| `NO_RELEASE_PR: ...` | the candidate's VERSION is already released on an earlier commit (no release PR landed since that cut): the Captain stamps a release PR. A plain cut always reports it; the daily check reports it only when a trigger is due. Exit 1 (0, with a warning, on a dry run) |
| `STABLE_STALE: ...` | stable is 7 days old and main moved, but nothing newer is green and gated; exit 1 (0 on a dry run) |
