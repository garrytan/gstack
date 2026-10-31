**On Claude Code, `/land-and-deploy` loads about 15 KB less skill text per session.** Step 7's canary instructions (the canary script, third-party dashboard actions, Aside setup and the browser fallback) moved out of `land-and-deploy/SKILL.md` into an on-demand `sections/canary.md`, which the skill reads only when it reaches the canary step or a browser or third-party site action. `SKILL.md` drops from 51,992 to 32,216 bytes. Codex and Factory renders inline every section, so they stay about the same size. In a paid before/after run (Opus 5.5, 10 tasks, 3 trials per arm; GSTA-161), mean loaded skill bytes fell from 109,334 to 93,828 (-14%), the pass rate held (after 97%, before 80%, a second before panel 87%), and mean cost per session stayed flat. Pass rates are graded on the transcript. These numbers are exploratory, from one eval suite.

### Changed
- **`land-and-deploy/sections/canary.md`** holds the post-deploy canary procedure; the routing paragraph stays in `SKILL.md`. Shared resolvers are unchanged.

### Tests
- `test/fixtures/skill-evals/land-and-deploy/` adds a 10-task eval suite (happy path, CI-red override, conflicts, already merged, dirty checkout, first run, deploy success and failure, canary without a browser, Render hook) with a `gh` stub and a state check per task.
- Size, parity and section-loading guards re-pinned for the smaller skeleton and the new section.
