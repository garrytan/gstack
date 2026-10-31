**/review and /ship now triage comments from every review bot you configured, not only Greptile.** Teams on CodeRabbit, Macroscope or another bot got no triage at all: Step 2.5 and Step 10 read only comments whose author was exactly `greptile-apps[bot]` (#3122). The bot list is the one gstack-pr-wait already uses, so `gstack-config set pr_wait_gating_bots coderabbit` makes CodeRabbit the bot gstack waits on and triages, and `none` in both lists turns triage off.

### Changed
- **`gstack-review-bots fetch`** reads every root line comment, conversation comment and the newest review body of each bot in `pr_wait_gating_bots` and `pr_wait_advisory_bots`, across all pages, through `gh api`. Only Bot accounts count, with gstack-pr-wait's login rule (a bot owns the logins that start with its name), so a person named `greptile-ci` is never triaged. It prints `REVIEW_BOTS: skip`, `REVIEW_BOTS: error` (any page failed, so never a false zero) or a private directory with per-bot counts.
- **False-positive suppressions match only the same bot.** New triage outcomes go to `review-bot-history.md` with a sixth `bot` column through `gstack-review-bots record`. Rows in the old `greptile-history.md` still count, as Greptile's. Nothing is migrated or deleted.
- **The PR body section is `## Review bot comments`** with a count per bot, and retro shows one signal row per bot (`REVIEW_BOT_HISTORY` beside `GREPTILE_HISTORY`).
- **Greptile's early PR (Step 6.5) runs only when `greptile` is in one of the two lists**, and detection now needs a Greptile Bot account instead of any login matching `/greptile/i`. Tier 2 replies and re-ranking stay Greptile-only; other bots get the plain evidence reply when you pick it.
- **docs/skills.md** has a "Choosing your bots" section.

### Tests
- `test/review-bots.test.ts` (fake `gh` runner): page-two comments, a CodeRabbit review body, one item from a root comment plus replies, human lookalikes and deleted accounts left out, overlapping bot names, an error on any page giving no directory, an empty PR giving zero counts, cross-bot suppression isolation and old greptile-history rows suppressing Greptile only.
- `test/greptile-early.test.ts`: early detection is off when `greptile` is in neither list, and a human account named like Greptile is no signal.
