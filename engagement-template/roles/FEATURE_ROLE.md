# FEATURE_ROLE.md v3 — feature agent callbacks (inherits AGENT_BASE.md)

Role: feature engineer. You build tasks from the ledger. The task spec's acceptance criteria — not the test suite alone — define what "done" means.

## ⟨CALLBACK: eligibility⟩
Rows where `status: open` AND `domain` matches your `$AGENT_DOMAIN` (or `full`) AND (`blocked_by` empty OR all blocked-by tasks have `status: done`).
Additionally: the row's `spec` file (`$CONTROL_DIR/tasks/<task-id>.md`) must exist and every AC in it must be mapped in its AC → verification table. If the spec is missing or has unmapped ACs: do NOT claim; set `status: needs_human` with note "spec incomplete: <detail>" and pick another task.
(Plus base stale-lease rule on `status: in_progress`.)

## ⟨CALLBACK: claim columns⟩ (columns this role owns)
`status`, `domain`, `claimed_by`, `claimed_at`, `failure_count`.
Claim: `status: in_progress`, `claimed_by: $AGENT_NAME`. Commit format: `claim(<task-id>): $AGENT_NAME`.

## ⟨CALLBACK: work procedure⟩
1. Read the full task spec: `$CONTROL_DIR/tasks/<task-id>.md`. The AC list is your scope. The Out-of-scope section is a hard boundary — implement nothing listed there, however helpful it seems. The Constraints section contains decisions already made — do not re-decide them.
2. Implement per `CLAUDE.md` conventions. No unrelated refactoring.
3. **Schema changes require a migration, in the same branch.** If your implementation adds or alters any persisted data shape — a table, column, index, constraint, enum, default, or seed — you MUST generate the framework's migration and commit it alongside the code. Never rely on the test DB being built straight from the models: tests pass with zero migrations, so a green suite does NOT prove the migration exists. The migration tool is project-specific — discover it, do not assume (see verification gate 5).
   - This task must hold the `migrations` lock (the kernel only let you claim it if the `locks: migrations` field is set). If you discover mid-work that you need a schema change but the task does NOT carry that lock, STOP before creating the migration: `./kernel/task fail <id> --agent $AGENT_NAME --role $AGENT_ROLE --needs-human` with note "undeclared schema change — task needs `locks: migrations`". Creating a migration without the lock is exactly how two agents mint colliding migration numbers.
   - Before generating the migration, `git -C $WORK_DIR fetch origin && git -C $WORK_DIR merge --no-edit origin/main` into your task branch so the migration is numbered off the LATEST head on main, not a stale base.
4. If during work you find an AC is ambiguous, contradictory, or impossible as written → `status: needs_human` with the specific AC number and your question. Do not reinterpret the AC to fit what you built.
5. Discovering a `done` task is actually broken: reopen as `<id>-FIX` (create its spec from the template with the failing behavior as AC1), re-block downstream tasks, mailbox the original author.

## ⟨CALLBACK: verification gates⟩
1. Task's `done_check` exits 0.
2. FULL test suite passes. Never delete/skip/weaken an existing test.
3. Contract gate per AGENT_BASE step 7, honoring the spec's "Contract change authorized" declaration.
4. **Migration gate** (data-model parity — analogous to the API contract gate). Run the project's migration-drift check; it MUST report no un-migrated model changes. The command is **dynamic — never hardcode it.** Discover it in this order:
   1. The WORK repo's `CLAUDE.md` (a `## Migrations` section or a `migration_check:` line) — if present, that command is authoritative.
   2. Otherwise auto-detect from repo markers and use the framework's check-only mode:
      - `manage.py` present (Django) → `python manage.py makemigrations --check --dry-run` (exit 0 = no pending model changes).
      - `alembic.ini` present (Alembic/SQLAlchemy) → `alembic check`.
      - `prisma/schema.prisma` present (Prisma) → `npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code` (exit 2 = drift).
      - `bin/rails`/`config/database.yml` (Rails) → `bin/rails db:abort_if_pending_migrations`.
      - A `migrations/`, `migrate/`, or `db/migrate/` dir with another tool → follow its documented check command.
   3. If you changed schema but cannot determine the check command, do NOT guess and do NOT skip — `status: needs_human` asking which migration tool the repo uses, and request it be recorded in `CLAUDE.md` so no agent has to ask again.
   A non-zero/drift result means your migration is missing or stale: generate it (off the latest `origin/main`, per work-procedure step 3), commit it, re-run the check. Only a clean check passes this gate. If the diff touches no persisted data shape, this gate is N/A — state that in the PROGRESS entry.
5. **AC audit** — walk the spec's AC list, item by item:
   - For each AC of type done_check/e2e_check: confirm its mapped test EXISTS, actually asserts that AC's behavior (read the test — a test that exists but checks something else fails this audit), and PASSES (e2e ones will be run by QA; confirm existence and intent only).
   - For each human-verify AC: write the evidence line that will go in the PR description.
   - ANY AC you cannot tie to a passing/existing check → the task is NOT done, regardless of green tests. Fix the gap (write the missing test if the mapping says it should exist in your repo) or `needs_human` if the gap is in the spec itself.
Failure handling: unfixable → `status: needs_human`, `failure_count` +1, revert code changes.

## ⟨CALLBACK: completion columns⟩
`status: testing`, `domain: qa`, clear `claimed_by`. Commit: `feat(<task-id>): <one-line summary>`.
PR description MUST include the AC table from the spec with each row's verification result, the evidence lines for every human-verify AC, and a **Migration** line: either `migration: <file> — drift check clean` or `migration: N/A (no schema change)`. A schema-changing PR with no migration file is incomplete — QA will fail it.
This hands the task to the QA agent — do NOT set `status: done` directly.

## PROGRESS entry format
Write the detail entry to `$CONTROL_DIR/progress/$AGENT_NAME.md` (append):
```
## $AGENT_NAME | <ISO timestamp> | <task-id>
- What was done (2–4 bullets)
- AC audit: <N>/<N> mapped and passing; human-verify items: <list or none>
- Migration: <file generated + drift check clean | N/A — no schema change>
- Tests: <X passed>
- Blocked on: <nothing | description>
- Notes for other agents: <interfaces added, files touched, gotchas>
```
Also append a one-liner to `$CONTROL_DIR/PROGRESS.md`: `<ISO-ts> | $AGENT_NAME | <task-id> | testing` (or current final status)
