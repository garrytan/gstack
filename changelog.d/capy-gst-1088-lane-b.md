**/investigate, /review, /qa and /verify now say when to use them, and /investigate and /review declare what "done" means (GST-1088 lane B).** Untold, Opus 5.5 never opened /investigate in 252 trials (Run D, gstack-evals#140). A when-to-use description raised GPT-6.1 Sol's open rate from 9.5% to 27.0% in the same run. Claude Code's catalog shows only a description's first sentence, so each of the four now opens with a "Use when ..." sentence. The routing hook and the contract check that read the new frontmatter ship separately (lane A), both off by default.

### Changed
- **Descriptions**: the first sentence of each is now a when-clause, for example /investigate's "Use when a test fails, code errors or output is wrong: find the root cause, then fix it." Hosts that show the full description also get the longer list of situations. The catalog stays within its existing budget.
- **Triggers**: /investigate, /review and /verify list the prompts people actually type, such as "test fails", "look over my diff" and "make it green". /qa keeps its three triggers because its size cap had 9 bytes of room.

### Added
- **`contract:` frontmatter** (frozen v1 schema) on /investigate (the DEBUG REPORT labels, and a test or repro run after the last edit) and /review (one Agent dispatch per selected specialist, the adversarial pass, the Pre-Landing Review report). `{{CONTRACT_DONE_MEANS}}` (`scripts/resolvers/contract-done-means.ts`) renders each block as a short "Done means" list at the top of the skill, so the list and the block can't drift.

### Tests
- `test/skill-descriptions.test.ts`: each of the four opens with a when-clause within the catalog, lead and host caps; triggers are short and don't overlap; ten sample prompts match exactly the intended skill; every template's contract block passes the v1 schema and names markers the skill text actually prints; the renderer covers each item kind; and malformed blocks fail with the file and the fix.
