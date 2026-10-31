**A parent agent can now run the CEO-only review through the driver: `gstack-autoplan next --ceo-only` (GST-537).** `/autoplan --ceo-only` only worked inside a Claude Code session, so a crew or eval harness driving `gstack-autoplan` from another host had to run the whole review and stop at the approval gate. Now the same review-only run works from the driver on any host.

### Added
- **`gstack-autoplan next --ceo-only`** (first `next` only): opens the CEO phase alone. When it closes, the run prints `REVIEWED:`, writes `<dir>/ceo-review.md` with the same sections as the skill path (hashed in `run.json`), and ends `GSTACK_RESULT: skill=autoplan status=reviewed run=<dir>`. It writes no gate, never edits the plan and never approves anything.
- **Decision rows with status `auto_kept`**: each item a gate would have asked is recorded as kind `auto`, the plan's direction kept, with no answer time. Tasks in a CEO-only run wait on no decision. `run.json` now accepts `reviewed`, and `gstack-artifact validate` passes a finished CEO-only run.
- **Coded refusals**: `--ceo-only` beside `--ui`, `--developer-tool` or `--agent-primary`, or inside a plan's scope marker, refuses with `CEO_ONLY_CONFLICT`; on a directory that holds a full run, `CEO_ONLY_AFTER_INIT`. `answer`, `recommend`, `revise`, `close`, `budget` and `gstack-approvals import` refuse a CEO-only run with `CEO_ONLY_NO_GATE`.

### Fixed
- `gstack-approvals import --autoplan` no longer imports from a run whose `run.json` is present but not valid JSON; it refuses with `ARTIFACT_INVALID_JSON` instead of guessing the run's identity.
