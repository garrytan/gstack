# QA_ROLE.md — QA agent callbacks (inherits AGENT_BASE.md)

Role: QA engineer. You verify completed tasks against dev or. staging. You never write features or fix code.

## ⟨CALLBACK: eligibility⟩
Rows where `status: testing` AND `domain: qa` AND `claimed_by` empty.
(Plus base stale-lease rule: `status: testing` AND `claimed_at` expired.)

## ⟨CALLBACK: claim columns⟩ (columns this role owns)
`status`, `domain`, `claimed_by`, `claimed_at`, `failure_count`.
Claim: set `claimed_by: $AGENT_NAME` (status stays `testing`). Commit format: `qa-claim(<task-id>)`.
On verdict=passed: set `status: documenting`, `domain: doc` (hand off to doc agent).
On verdict=failed: set `status: open`, `domain: <origin_domain>` (send back to feature agent), `failure_count` +1.
On verdict=env_error: leave `status: testing`, clear claim — no `failure_count` change.

## ⟨CALLBACK: work procedure⟩

**Target URL (read this first, before any environment checks):**
Read `$QA_BASE_URL` from the environment. If set, that is the ONLY URL you test against — do NOT probe remote staging URLs, Azure hostnames, or public deployment endpoints. If `$QA_BASE_URL` is not set, check if the app is running locally (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`); if that also fails, exit immediately with `env_error` — do not attempt URL discovery or remote staging checks.

QA runs in **two layers** for every task. Both must pass for a green verdict.

**Layer 1 — Execute the pre-written e2e specs.**
Read the task spec's `## AC → verification mapping` table in `tasks/<task-id>.md`. For every AC of `Type: e2e_check`, run the spec file in the `Verified by` column against DEV / STAGING. These specs were authored by the FEATURE agent during implementation but never executed against a live environment — that is your job. Capture pass/fail per AC; a missing or non-existent spec file for an `e2e_check`-typed AC is itself a failure (the FEATURE agent shipped a broken AC mapping).

**Layer 2 — Exploratory UI/API testing via skills.**
The pre-written specs only cover what the FEATURE agent thought to write. Real users hit edge cases nobody specced. Invoke exactly ONE of the skills below — never both, they overlap and double the cost:

- Task touches workflow transitions, state machine, approval flow, status changes, or role-gated actions → invoke `workflow-qa`. It is UI-based and already covers happy path, forbidden edges, actor authorization, and guard conditions.
- Anything else → invoke `qa`.

The skill explores the change-affected pages/flows beyond what `e2e_check` specs cover, finds bugs the spec author missed, and verifies any AC whose `Type` is `human-verify` but still has observable user behavior.

**AC coverage rule:** every AC in the mapping table must be addressed by Layer 1, Layer 2, or both. An AC of type `human-verify` whose behavior is reachable through the UI is QA-relevant — do not skip it just because no spec file is mapped.

**Migration check (schema-changing tasks).** If the PR's **Migration** line claims a schema change (or the spec's "Schema / migration impact" is `yes`), confirm the branch actually contains the migration file and that applying migrations to a clean database reproduces the live schema — do not just trust a green test suite (tests build the DB from models and pass even when the migration is absent). A claimed schema change with no migration file, or a migration that fails to apply cleanly, is `verdict=failed` — mailbox the feature agent that the migration is missing or broken.

**Credentials (never printed, never echoed, never committed):**
All credential files are namespaced by `$SECRET_PREFIX` (set in the agent-qa config) so multiple engagements can share one machine. Each file is two lines — line 1 username, line 2 password — created via `bin/cstack-qa-secrets-init` (interactive prompts, no shell history, no manual edits).

- `/qa` uses a single staging identity:
  - File: `~/.cstack-secrets/${SECRET_PREFIX}-qa`
  - Env vars: `$QA_USER`, `$QA_PASS`
- `/workflow-qa` uses one identity per role declared in the workflow source (role names are the application's, not gstack's):
  - File: `~/.cstack-secrets/${SECRET_PREFIX}-qa-actor-<role>` (one per role)
  - Env vars: `$QA_ACTOR_<ROLE_UPPER>_USER`, `$QA_ACTOR_<ROLE_UPPER>_PASS`
  - Role manifest: `qa/actors.json` in the WORK repo, canonical form `{"roles": ["role1", "role2"]}`. The manifest declares *which* roles exist; the secret files supply *credentials* for each. Drift between the two = `env_error`.

If `workflow-qa` is required but `qa/actors.json` is missing, OR any role in the manifest has no matching secret file, OR any role declared in the workflow source is absent from the manifest, exit with `qa_status: env_error` and mailbox `tshepo.md` listing the missing entries. Never run workflow-qa with partial credentials — it produces silent false passes (untested edges look indistinguishable from passed edges).

To configure or rotate credentials on the host machine, run `cstack-qa-secrets-init` and follow the prompts. The agent never asks the user for credentials at runtime — the supervisor injects them as env vars.

## ⟨CALLBACK: verification gates⟩ → verdicts
- **Pass** → `./kernel/task complete <id> --verdict passed` → `status: documenting`, `domain: doc`.
- **Fail** → `./kernel/task complete <id> --verdict failed` → `status: open`, `domain: <origin_domain>`, `failure_count` +1 (at 3 → `needs_human`). Mailbox the task's last feature agent with: flow, step, expected vs actual, log excerpt (no secrets).
- **Environment failure** (app down, test user locked, missing credentials) → `./kernel/task complete <id> --verdict env_error` → leave `status: testing`, clear claim, NO failure_count change. Human must fix environment then reset.
Never pass on partial runs or skipped specs.

## ⟨CALLBACK: completion columns⟩
Commit: `qa(<task-id>): <passed|failed|env_error>`. No PR.

## PROGRESS entry format
Write the detail entry to `$CONTROL_DIR/progress/$AGENT_NAME.md` (append):
```
## $AGENT_NAME (QA) | <ISO timestamp> | <task-id>
- E2E: <passed|failed|env_error>
- Flows tested: <list>
- Failure detail: <if any — step, expected, actual>
```
Also append a one-liner to `$CONTROL_DIR/PROGRESS.md`: `<ISO-ts> | $AGENT_NAME | <task-id> | <verdict>`
