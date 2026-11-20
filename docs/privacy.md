# Privacy & Telemetry

gstack sends nothing about how you use it unless you opt in. Three kinds of
network traffic exist, and each has its own switch.

**Telemetry (opt-in, default off).** On first run gstack asks once. You can say
no, and `gstack-config set telemetry off` turns it off at any time.

- **What's sent, per skill run:** skill name, event type, outcome
  (success/error/abort), duration, gstack version, OS and CPU architecture,
  whether the browser was used, whether the run was live or a test, a session
  id, the count of live session markers (below), the error class, the failed step, and an error message passed through gstack's
  secret redaction (cut to 200 characters). `community` adds a stable device
  ID; `anonymous` sends no device ID. Prompt-injection detections add the attacking
  page's domain, a payload hash, a confidence score, the detection layer and
  the verdict.
- **Each skill run also sends** these labels, each a pick from a
  fixed list (anything else is sent as `unknown`):
  - `host`: which coding agent ran it (`claude_code`, `codex`, `cursor`,
    `openclaw`, `hermes` or `other`), read from the agent's environment.
  - `model_family`: `claude_opus`, `claude_sonnet`, `claude_haiku`,
    `claude_other`, `gpt`, `gemini` or `other`, as the model reports it about itself.
  - `invoked`: started by you, by the model, or chained from another skill.
  - `exit_reason`: completed, stopped by you, blocked, a tool error, a test
    failure, the context limit, or gave up.
  - `checks`: whether the skill's own checks passed, failed or weren't run.
  - `routing`: whether your CLAUDE.md/AGENTS.md has gstack's routing section
    and whether gstack hooks are installed (`none`, `block`, `hooks`,
    `both`). The files are read on your machine; only that word is sent.
  - `harness_session_id`: a random 16-character id for one agent session. It
    is created on first use, kept in that session's marker file below, and
    ends when the marker does (120 idle minutes). It is never your device ID
    and never reused, so it links the skills of one session and nothing
    across sessions or machines. It is sent on both tiers, except under a
    harness that runs every session in one process (Capy's capy-server).
  - Upgrades send one `upgrade_completed` event: success or the failure
    reason (`refused_dirty`, `busy`, `fetch_failed`, `setup_failed`,
    `other`) and the version you came from. `--check` and unattended
    sessions send nothing.
  - `source` is set to `ci` under CI and `eval` inside gstack's eval runs,
    so lab traffic stays out of real-use numbers. gstack's own use on Capy is
    labelled `capy` (or `gt`, below) and kept out of them too. A duration gstack can't
    measure is sent empty instead of 0.
- **On Capy:** sessions an agent drives there send nothing unless the owner's
  `preferences.yaml` beside the Capy gstack skill holds the line
  `telemetry_capy: anonymous`. Then each skill run sends one row at the
  `anonymous` tier (no device ID, even on a machine set to `community`),
  labelled `capy`. Any other value, or two such lines, is off. A second line,
  `telemetry_capy_source: gt`, labels the rows `gt` instead (gstack's
  maintainer's own machines); any other label is `capy`.
- **What's never sent:** code, file paths, repo names, branch names, prompts,
  or any other content you write.
- **What stays on your machine:** opted in, each run is also logged to
  `~/.gstack/analytics/skill-usage.jsonl` (under your state root; see
  [docs/state-root.md](state-root.md)) with the repo name and branch, so
  `gstack-analytics` can show your own dashboard. `gstack-telemetry-sync`
  deletes those two fields (and, for `anonymous`, the device ID) before
  anything is uploaded. With telemetry off, gstack logs no usage analytics at
  all; nothing new is written there.
- **Where it goes:** [Supabase](https://supabase.com) (an open-source Firebase
  alternative). The schema is in [`supabase/migrations/`](../supabase/migrations/),
  so you can verify what's collected. The publishable key in the repo is a
  public key that can neither read nor write those tables; every write goes
  through edge functions that enforce schema checks, event allowlists and
  field length limits. gstack never uses Supabase sign-in, and signed-in users
  are denied everything too. gstack's own test suite never sends telemetry
  to the live project.

**Update check (on by default, regardless of telemetry).** Every interactive
skill start runs `gstack-update-check`. When its cache is stale (60 minutes after an
up-to-date result, 12 hours while an upgrade is pending, 10 minutes after a
failure) it asks GitHub for the latest version: a `git ls-remote` of
`github.com/garrytan/gstack`, a GET of the `VERSION` file from
`raw.githubusercontent.com` and, when that version equals yours but `main` has
moved past your checkout, a GET of `api.github.com`'s compare endpoint for the
two commit SHAs. GitHub sees your IP address; nothing about you or your code is
sent. With telemetry on, the same check also posts your gstack
version and OS to gstack's Supabase. Turn the check off with
`gstack-config set update_check false`.

**Outside reviews (on by default; the first one prints a notice).** Plan
reviews, `/autoplan`, `/review` and `/ship` adversarial passes, `/ship`'s design
check, `/design-review`, `/design-consultation`, `/office-hours`,
`/document-release` and `/spec` can
ask a second model for an independent review: Codex under Claude Code, Claude
Code under Codex. That sends the review prompt and the relevant code, diff or
plan to that provider, using your own Codex or Claude Code login. The first
send on a machine says which provider and which account. Turn it off with
`gstack-config set codex_reviews disabled`; the binaries that send then refuse
(`not_run`, `consent_missing`) and start nothing, and an unreadable config
counts as disabled. `/codex` and `/claude-code` still run when you ask for
them by name.

**Local state that is not telemetry.** gstack keeps a few local files whatever
your telemetry setting. They are functional state, not usage logs, and the
files are never sent:

- **Session markers:** `~/.gstack/sessions/<pid>`, one file per live agent
  session, touched at skill start and deleted after 120 idle minutes. With
  telemetry on it holds that session's random `harness_session_id`. The count lets
  skills notice several sessions on one machine; with telemetry on, that number
  is the session count above.
- **Project timeline:** `~/.gstack/projects/<repo>/timeline.jsonl` records skill
  starts and finishes with the branch name, for `/context-restore` and `/retro`.
  It leaves the machine only if you turn on `artifacts_sync_mode full`
  ([docs/gbrain-sync.md](gbrain-sync.md)).

**Every off-machine send is receipted.** Any gstack-initiated network send,
telemetry included, writes a hash-chained, tamper-evident receipt to
`~/.gstack/security/egress.jsonl` before the send; sensitive sinks refuse to
send at all if the receipt can't be written. Audit with `gstack-egress list`,
verify the chain with `gstack-egress verify` (exit 3 on tamper), and see the
standing consent settings with `gstack-egress grants`. The ledger records
attempted sends so accidents are auditable; it's an audit trail, not a network
firewall.

**Optional third-party bridges are off by default and receipted too.** The one
that exists today, the [Memorable recall bridge](memorable-workflow-memory.md),
hands your prompt to a locally installed vendor binary only after you run
`gstack-memorable enable`; every hand-off writes a receipt first, the consent
shows up in `gstack-egress grants`, and what the vendor then sends is
documented as the vendor's claim.
