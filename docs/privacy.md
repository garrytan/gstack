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
  ID; `anonymous` sends no ID. Prompt-injection detections add the attacking
  page's domain, a payload hash, a confidence score, the detection layer and
  the verdict.
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

- **Session markers:** `~/.gstack/sessions/<pid>`, one empty file per live agent
  session, touched at skill start and deleted after 120 minutes. The count lets
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
