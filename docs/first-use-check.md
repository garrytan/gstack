# Check an app build before its owner tries it

When an agent builds an app for someone, every review can pass and the first thing the owner taps can still be broken. `gstack-first-use` closes that gap. Before a build reaches its owner as "ready to try", a fresh agent from a **different model family** than the one that built it plays that exact build cold, on the same kind of device and account the owner uses. It does the first five things the plan says the owner will do on day one, saves a screenshot or short video of each, checks that every link in the message is live, and predicts the owner's score from 1 to 10. Only when all of that passes does the tool print the "try this build" message.

It gates two things: the message that asks the owner to try a build, and any "v1 is ready" report. It does not gate `/ship`: code review and the first-use check answer different questions.

## The steps

Run these from the thread that owns the build (on Capy, a Captain or the agent building the app).

1. **Freeze the five actions and the build.**

   ```bash
   gstack-first-use start --app plantpal --plan plan.md --play play.json \
     --platform ios --commit <full commit sha> --testflight 17 \
     --builder anthropic/claude-opus-5-5 --checker openai/gpt-6.2-sol
   ```

   It reads the first five rows of the plan's day-one table, records their hash, the play spec and the build fingerprint (the commit plus the TestFlight build number, or `--deploy <version>` for a web or Android build) in a write-once `manifest.json`, and prints `FIRST_USE_RUN: <dir>`. It refuses when the table is missing or malformed, has fewer than five rows, has an empty cell in its first five rows or still has a row marked `assumed` among them, when the play spec misses a part, or when the checker's model family is the builder's.

2. **Hand the checker its brief.** `gstack-first-use brief --run <dir>` prints everything the checker gets: the device and account, the play text, and the five frozen actions with the commands to record each. Give it to one fresh agent on the `--checker` model and nothing else about the build: no plan, no code, no notes. Every value the brief puts into a command is shell-quoted, so the checker can paste the lines as they are. On Capy, start a subagent with that model on `machine: "fresh"`; it attaches a cloud phone with `tools.capy.phone` (`attach`, then `install` with the build from `tools.mobile.build`) and drives the screen with `tools.capy.computer`, or opens a web build in the browser. It runs its own gstack install check first.

3. **The checker records each action and predicts the score.**

   ```bash
   gstack-first-use record --run <dir> --action 1 --verdict pass --evidence today.png \
     --device "iPhone 17 Pro (cloud)" --account "fresh Apple ID" --by openai/gpt-6.2-sol
   gstack-first-use predict --run <dir> --score 6 --why "reminders work, adding plants is slow" --by openai/gpt-6.2-sol
   ```

   The evidence file (PNG, JPEG, GIF, WebP, HEIC, MP4, MOV or WebM, up to 100 MB) is copied into the run and recorded with its hash and size. A fail needs `--note` saying what happened. Only the checker's family may record, and `--account` must be the play spec's owner-equivalent account exactly (the brief prints it), so a pass on a developer or admin account doesn't count. Replaying an action adds a new result; the newest one counts.

4. **Check the links right before sending.** `gstack-first-use links --run <dir> --account "<the play spec's account>" --device-class ios` opens every link in the play spec and writes a dated receipt for each, bound to that audience: the owner-equivalent account and the build's device class. It refuses any other audience, and the gate counts only receipts for this one. A link passes on a 2xx or 3xx answer. A 401 or 403 passes only when the play spec marks the link `"login_gated": true`. The request itself carries no sign-in, so for a login-gated link the receipt proves the link is up and gated; the checker's played results on that account prove the sign-in works.

5. **Print the message.** `gstack-first-use message --run <dir> --platform ios --commit <sha> --testflight 17` prints the "try this build" text only when every check below passes, and refuses otherwise, printing nothing on stdout. Send that text as it is. For a "v1 is ready" report, run `gstack-first-use check` with the same flags and paste its `FIRST_USE: pass …` line.

6. **Save the owner's reaction.** When the owner replies, `gstack-first-use score --run <dir> --score 4 --words "4, Talk is slow" --by "<who relayed it>"`. `gstack-first-use show --run <dir>` prints the predicted score, the owner's score and words, and the gap between them.

## What the gate refuses

`check` and `message` pass only when all of these hold. Each failure is listed in the `FIRST_USE_REFUSED` line ([troubleshooting](troubleshooting.md#first-use-refused)).

- The build you're about to send is the one that was checked (`build_mismatch`).
- The plan's first five day-one rows haven't changed since `start` (`source_changed`, `source_missing`). An edit elsewhere in the plan doesn't count.
- Every frozen action's newest result, from the checker's family on the owner-equivalent account, is a pass, and its evidence file still matches its hash (`action_<n>_not_played`, `action_<n>_failed`, `action_<n>_evidence_stale`).
- Every link has a live receipt from the last 15 minutes, checked as the owner-equivalent account and device class (`link_unchecked`, `link_down`, `link_stale`).
- The checker predicted a score (`no_predicted_score`).

The message never shows the predicted score, so it can't anchor the owner's own.

## The day-one table

Both kinds of plan feed the check in one format: the day-one table that `/autoplan` puts on the plan-approval page, and the one-page list of the first five things the owner does on day one. Either one needs a heading named `Day one` (any level; `Day-one page` also works) followed by a table with these seven columns, in any order:

| action | frequency | source | feature | route | first build | check |
|---|---|---|---|---|---|---|
| sees which plant needs water today | daily | owner words 1 | Today list | root screen | build 1 | the plant due today is at the top, marked due |

The table needs at least five rows, and every cell of the first five needs a value; the check freezes those five in table order. A row whose source starts with `assumed` must be confirmed with the owner before `start` will freeze it. `test/first-use.test.ts` pins this format with one fixture of each kind, so a change to the table parser fails that test instead of quietly changing what gets checked.

<a id="play-spec"></a>
## Play-message requirements

Every ask to play or try a build carries full play instructions in the same message (the factory's play-instructions rule, R47). The play spec is a JSON file with one field per part, and `start` refuses one that's missing any:

| Part | Field | Notes |
|---|---|---|
| 1. The links | `links`: `[{ "label", "url", "login_gated"? }]` | http or https; each checked live within 15 minutes of sending |
| 2. Device and setup | `device`, `setup`, `account` | the owner's device kind and account kind; the checker plays on the same kind, and results and link receipts are bound to `account` and the build's platform |
| 3. What it is, in a sentence | `what` | |
| 4. How to start | `start` | |
| 5. Controls | `controls` | |
| 6. How long to play | `minutes` | a whole number from 1 to 240 |
| 7. What we want to learn | `learn` | |
| 8. How to report back | `report` | the message adds "a score from 1 to 10 and one line" |
| 9. Known quirks | `quirks` | "none" is fine; empty isn't |
| 10. Reply word | `reply_word` | one word |

## Where the record lives

The record holds the owner's own scores and words, so it stays private. On Capy it lives in the owner's user-level Capy Drive folder (`~/.capy/drive/user-*/first-use/<app>/<run>/`), which every thread the owner has opened can read and nobody else's can. If none or several such folders are mounted, the tool refuses rather than fall back to the machine's throwaway folder. Off Capy it lives under the gstack state root (`first-use/`). `GSTACK_FIRST_USE_DIR` overrides both. Nothing from a run belongs in a public repository or a PR body.

A run directory holds `manifest.json`, `results/`, `evidence/`, `links/`, `prediction.json` and `owner/`. Every file is written once; to check again (a new build, changed day-one rows, a new prediction), start a new run.

## How we'll know it helps

With a handful of builds, this is a case series, not an eval. For each build, keep the pass count, the owner's score and words, the predicted score, and any escape: a day-one action that failed on the owner's device after the check passed it. The targets are zero escapes and a median owner score of 7 or more across the next three app builds. `gstack-first-use show --json` prints each run's numbers.

## What it doesn't do yet

- It doesn't drive the owner's own phone; it plays on a cloud device of the same kind.
- It doesn't dispatch the checker by itself; the thread that owns the build starts it with the brief.
- It doesn't check the wording of other messages sent to the owner.
