# Check a first version before its owner tries it

When an agent builds the first version of something for a person, every review can pass and the first thing the owner tries can still be broken, or do less than he asked. Six first versions in November 2026 all drew a complaint first: in at least four the gap was written down before he touched it, and in none did anyone run the exact steps we then asked him to do on his real setup. Two things close that gap.

1. **The plan and the try-it message start from the owner's own words.** A first version's plan quotes each message of the owner's that states the job, with its time, and gives each one a line: it does it, or it leaves it as a lettered choice. Nothing his words asked for sits under "What it won't do yet". The five things he'll do on day one cite those quotes.
2. **An agent runs his exact try-it steps on the real target first.** Before a build reaches its owner as "ready to try", a fresh agent from a **different model family** than the one that built it follows the exact message we're about to send, step by step, on the real target, and records a verdict and one line per step. Only when nothing is broken, wrong or asks him for something an agent could look up does `gstack-first-use` print the message.

It gates two things: the message that asks the owner to try a build, and any "v1 is ready" report. It does not gate `/ship`: code review and the first-use check answer different questions. Any report of a passing test on a build the owner doesn't hold yet also names the build he does hold and its known defects.

## The owner's words and the day-one table

A plan is a first version when it has a `Day one` section or the run passes `--first-version` (on `gstack-autoplan next` or in the plan's scope marker). Both kinds of plan use the same two sections: the plan `/autoplan` puts on its approval page, and the one-page list of the first five things the owner does on day one.

```markdown
### Owner's words

- Ada Example, 2026-11-18 09:12Z: "I keep forgetting which plant needs water" → does it
- Ada Example, 2026-11-18 09:14Z: "and tell my partner when I'm away" → choice; size: two days; leave out: needs a second account
```

Each bullet is who, when, the words in quotes, then an arrow (`→` or `->`) and the line:

| Line | Meaning | At the gate |
|---|---|---|
| `does it` | this version does what the words ask | a reviewer who finds it does less files a `narrows_quote` finding, and the gate asks |
| `choice` | this version doesn't fully do it yet | one lettered choice quoting the words: a) build it in this version, b) leave it out. It recommends a, unless the line says `leave out: <reason>`, shown on the choice. `size: <n>` is shown as the cost |

A public export (`gstack-autoplan export --public`) drops the owner's words: every quote, however short, wherever it appears in quote marks, and every `leave out:` reason, wherever the gate shows it. A quote of three or more words is also caught where it is repeated without quote marks.

A cut under `### What it won't do yet` that drops a quoted line becomes that quote's choice and leaves the list. On a first version every other cut gets its own letter. The owner brief shows the quotes and their lines first, then the day-one table, then the remaining cuts.

The day-one table needs a heading named `Day one` (any level; `Day-one page` also works) followed by a table with these seven columns, in any order:

| action | frequency | source | feature | route | first build | check |
|---|---|---|---|---|---|---|
| sees which plant needs water today | daily | owner words 1 | Today list | root screen | build 1 | the plant due today is at the top, marked due |

The table needs at least five rows, and every cell of the first five needs a value; the check freezes those five in table order. Each of the five cites a quote with `owner words <n>`. A row whose source starts with `assumed` must be confirmed with the owner first; once he confirms it, add his answer to Owner's words and cite it. `test/first-use.test.ts` pins this format, so a change to the parser fails that test instead of quietly changing what gets checked.

## The steps

Run these from the thread that owns the build (on Capy, a Captain or the agent building it).

1. **Freeze the steps, the build and what the owner holds now.**

   ```bash
   gstack-first-use start --app plantpal --plan plan.md --play play.json \
     --platform ios --commit <full commit sha> --testflight 17 --phone-build <mobile build id> \
     --holding "TestFlight build 16" --holding-defects "the care card shows yesterday's date" \
     --builder anthropic/claude-opus-5-5 --checker openai/gpt-6.2-sol
   ```

   Platforms are `ios`, `android`, `web`, `macos` (a Mac app or helper) and `server` (software on the owner's box); give `--deploy <version>` for anything not on TestFlight. An ios or android check also needs `--phone-build <id>`: the 26-character id of Capy's mobile build (`tools.mobile.build`) of the same commit. The cloud phone installs only that kind of build, never a TestFlight or store number, so `start` refuses a phone build without it. gstack can't check that this build is the same code TestFlight ships. The builder names it, and the brief records which one the checker installed. `--holding none --holding-defects none` marks a first build. `start` freezes the owner's quotes, the play spec's numbered steps followed by the five day-one actions, and the try-it text into a write-once `manifest.json`, with a hash over the rows and the text of every quote, and prints `FIRST_USE_RUN: <dir>`. It refuses a plan whose table or quotes are missing or malformed, a play spec that misses a part, and a checker from the builder's model family.

2. **Hand the checker its brief.** `gstack-first-use brief --run <dir>` prints everything the checker gets: the target and its rules, the exact try-it message, and each step with what it writes and the commands to record it. Give it to one fresh agent on the `--checker` model and nothing else about the build: no plan, no code, no notes. On Capy, start a subagent with that model on `machine: "fresh"`. For a phone build it attaches a cloud phone (`tools.capy.phone`), installs the `--phone-build` build on it and points it at the target; for a Mac build on the owner's own Mac it drives Aside over Tailscale; for a server build it works over the box's shell. It runs its own gstack install check first.

3. **The checker records each step and predicts the score.**

   ```bash
   gstack-first-use record --run <dir> --step 3 --verdict useful --line "three plants show with their names" \
     --evidence today.png --device "iPhone 17 Pro (cloud)" --account "a fresh Apple ID" \
     --target "the Plantpal test account" --by openai/gpt-6.2-sol
   gstack-first-use predict --run <dir> --score 6 --why "reminders work, adding plants is slow" --by openai/gpt-6.2-sol
   ```

   A verdict is `useful` (does what he asked, well), `thin` (works but does little), `wrong` (does something other than what he asked) or `broken` (fails). `--needs-lookup <what>` marks a step that asks the owner for something an agent could look up or do; `--notice <text>` marks a system notice or prompt the message doesn't warn about. Evidence is a screenshot, short video or terminal capture (PNG, JPEG, GIF, WebP, HEIC, MP4, MOV, WebM, TXT or LOG, up to 100 MB), copied into the run with its hash. Only the checker's family may record, and `--account` and `--target` must match the play spec exactly. The checker's text is kept to one plain line. Replaying a step adds a new result; the newest one counts.

4. **Check the links right before sending.** `gstack-first-use links --run <dir> --account "<the play spec's account>" --device-class ios` opens every link and writes a dated receipt bound to that audience. A link passes on a 2xx or 3xx answer; a 401 or 403 passes only when the play spec marks it `"login_gated": true`.

5. **Print the message.** `gstack-first-use message --run <dir> --platform ios --commit <sha> --testflight 17` prints the try-it message only when every check below passes, and refuses otherwise, printing nothing on stdout. It opens with the owner's quotes and what this version does with each, then the ten play parts with the numbered steps, then "What you'll notice" (every thin step and notice), "The build on your device now" (its known defects, or that this is his first build) and one verdict line per step. Send it as it is. For a "v1 is ready" report, run `gstack-first-use check` with the same flags and paste its `FIRST_USE: pass …` line.

6. **Save the owner's reaction.** When the owner replies, `gstack-first-use score --run <dir> --score 4 --words "4, Talk is slow" --by "<who relayed it>"`. `gstack-first-use show --run <dir>` prints each step's verdict, the predicted score, the owner's score and words, and the gap between them.

## What the gate refuses

`check` and `message` pass only when all of these hold. Each failure is listed in the `FIRST_USE_REFUSED` line ([troubleshooting](troubleshooting.md#first-use-refused)).

- The build you're about to send is the one that was checked (`build_mismatch`).
- The first five day-one rows and the owner's quotes haven't changed since `start` (`source_changed`, `source_missing`), and neither has the frozen try-it text (`try_text_changed`). An edit elsewhere in the plan doesn't count.
- Every step's newest result, from the checker's family on the owner-equivalent account and the play spec's target, has intact evidence (`step_<n>_not_played`, `step_<n>_evidence_stale`) and is not `wrong` or `broken` (`step_<n>_wrong`, `step_<n>_broken`).
- No step asks the owner for something an agent could look up or do (`step_<n>_needs_lookup`).
- No day-one action is `thin` (`step_<n>_thin`): each one comes from his words. A thin play step passes and is named in the message.
- Every link has a live receipt from the last 15 minutes (`link_unchecked`, `link_down`, `link_stale`).
- The checker predicted a score (`no_predicted_score`).

The message never shows the predicted score, so it can't anchor the owner's own.

<a id="play-spec"></a>
## Play-message requirements

Every ask to play or try a build carries full play instructions in the same message (the factory's play-instructions rule, R47). The play spec is a JSON file with one field per part, and `start` refuses one that's missing any:

| Part | Field | Notes |
|---|---|---|
| 1. The links | `links`: `[{ "label", "url", "login_gated"? }]` | http or https; each checked live within 15 minutes of sending |
| 2. Device and setup | `device`, `setup`, `account`, `target` | `target` is `{ "kind": "realistic-copy", "name", "data" }` (the default kind: a copy loaded with realistic data, named) or `{ "kind": "real", "name" }` for the owner's own setup |
| 3. What it is, in a sentence | `what` | |
| 4. How to start | `start`, `steps` | `steps` is `[{ "text", "writes", "approved_write"? }]`: what the owner does, and what it writes (`"none"` or what). A step that writes on a `real` target needs `approved_write` naming the owner's lettered approval for that write. On a `real` target `action_writes` is also required: five `{ "writes", "approved_write"? }` entries, one per day-one row in table order, under the same rule; on a copy an action without one is briefed as `unknown, so treat it as a write` |
| 5. Controls | `controls` | |
| 6. How long to play | `minutes` | a whole number from 1 to 240 |
| 7. What we want to learn | `learn` | |
| 8. How to report back | `report` | the message adds "a score from 1 to 10 and one line" |
| 9. Known quirks | `quirks` | "none" is fine; empty isn't |
| 10. Reply word | `reply_word` | one word |

On the owner's real setup the checker only reads: the brief forbids sending anything as the owner, writing to his setup except an approved write, and raising a prompt on his machine while he is using it. It also tells the checker that what it reads goes to its model provider.

## Where the record lives

The record holds the owner's own scores and words, so it stays private. On Capy it lives in the owner's user-level Capy Drive folder (`~/.capy/drive/user-*/first-use/<app>/<run>/`), which every thread the owner has opened can read and nobody else's can. If none or several such folders are mounted, the tool refuses rather than fall back to the machine's throwaway folder. Off Capy it lives under the gstack state root (`first-use/`). `GSTACK_FIRST_USE_DIR` overrides both. Nothing from a run belongs in a public repository or a PR body.

A run directory holds `manifest.json`, `results/`, `evidence/`, `links/`, `prediction.json` and `owner/`. Every file is written once; to check again (a new build, changed day-one rows or quotes, a new prediction), start a new run. Runs started before the try-it steps were checked (schema 1), and ios or android runs started without `--phone-build`, refuse with a line saying to start a new one.

## How we'll know it helps

With a handful of builds, this is a case series, not an eval. For each first version, keep the step verdicts, the owner's score and his first words, the predicted score, and any escape: a step that failed or disappointed him after the check passed it, or a first reply that names something his quoted words asked for. The targets are zero escapes and a median owner score of 7 or more across the next three first versions; the factory's weekly first-use table tracks them. If two of the next three still draw a complaint about something the check passed or the quotes covered, the check goes back for a "Why null?" review.

## What it doesn't do yet

- It doesn't prove the target is real: the checker declares it, as it declares the account, and the record names it.
- It doesn't dispatch the checker by itself; the thread that owns the build starts it with the brief.
- It doesn't check the wording of other messages sent to the owner.
