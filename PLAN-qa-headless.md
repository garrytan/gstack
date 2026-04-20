# Plan: /qa-headless skill (v1, revised after eng review)

**Source:** https://github.com/garrytan/gstack/issues/1038
**Branch:** plan/qa-headless
**Revision:** post `/plan-eng-review` — scope tightened to Python-only, HTTP capture rebuilt around existing libs, evals added, boot-requirements detection added.

## Goal
Add a new gstack skill `/qa-headless` that QA-tests backend features with no UI — cron jobs, queue workers, webhook handlers, notifiers, CLIs, ETL/data pipelines — and fixes bugs it finds. Pairs with `/qa` (browser) to close the backend QA gap. **v1 ships Python-only end-to-end.** Shape detection recognizes Node / Ruby / Go and routes the user to manual guidance; HTTP capture for those languages ships in follow-up PRs.

## Problem
`/qa`, `/qa-only`, `/browse`, `/benchmark`, `/canary` all drive a headless browser. Backend features whose observable output is a side effect (Slack message, DB row, MIME email, log line) are untestable with gstack today. Issue #608 hit the same gap with no resolution. Motivating case: a daily 10am CT Slack digest cron that groups `CallSession` rows and POSTs Block Kit messages — today the only way to "QA" it is production.

## v1 scope (this plan)
A new skill at `qa-headless/SKILL.md.tmpl` (~340 lines, mirroring `qa/SKILL.md.tmpl`; generated `SKILL.md` via `bun run gen:skill-docs`). Companion `qa-headless/references/` (framework-detection tables) and `qa-headless/fixtures/` (self-test projects for the eval suite).

The skill does the following:

### 1. Detects feature shape (all 4 languages, day-one)
Input sources, in order of preference:
1. **User-specified target** — `/qa-headless scripts/run_call_digest.py` or `/qa-headless app/workers/send_digest.rb`. Always honored.
2. **`git diff`** — scan changed files for shape markers.
3. **Empty-diff fallback** — if no diff match (the common case: "QA this cron that's been live for months"), scan the repo for cron-like / worker-like / CLI-like entry points and ask the user which one to QA (AskUserQuestion with the top 5 candidates). Never silently dead-end on empty diff.

Markers for each shape:

- **cron / scheduled job** — Procfile `clock`/`scheduler`, APScheduler, Celery beat, Rails `cron.rb`, `config/schedule.rb`, k8s CronJob manifests, Heroku Scheduler markers, Go `time.Tick` patterns in a `cmd/` entry point
- **queue worker** — Celery task, Sidekiq worker, BullMQ processor, Faktory, Rails ActiveJob, Go channel-based workers
- **webhook handler** — FastAPI / Flask / Express / Fastify / Rails route that writes side effects and returns 200; distinguished from plain endpoints by presence of side-effect imports (`requests`, `Net::HTTP`, `fetch`, DB writes)
- **notifier** — outbound HTTP to Slack / Twilio / SendGrid / Postmark / SES, or SMTP
- **CLI / management command** — argparse, click, typer, commander, thor, cobra, `manage.py`, `rake`, `rails runner`
- **data pipeline / ETL** — pandas/polars scripts, dbt models, SQL scripts with side effects

**Confirmation gate:** after classification, skill shows the user what it detected (via AskUserQuestion) and asks for confirmation before proceeding. Prevents silent misclassification on ambiguous routes.

### 2. Discovers trigger inputs (new — required)
Shape detection tells you *what* to run; this step tells you *how to invoke it*. Without this step, "run the script" is a no-op for anything that takes args or a payload.

Per shape:
- **CLI / management command** — parse the argparse / click / typer spec. Extract required args, optional args with defaults, help text. Present discovered args; let the user fill or override via AskUserQuestion.
- **cron / scheduled job** — check for example invocations in `README.md`, `Procfile`, `config/schedule.rb`, `Makefile`, CI workflows, or existing tests. Offer those as starting points.
- **queue worker / Celery task** — execute **synchronously**: `task.apply(args=..., kwargs=...)` for Celery, `perform_now` for ActiveJob, `Worker.new.perform(...)` for Sidekiq. Discover kwargs from the task signature + any example invocations in tests. Never boot a full broker + worker process in v1.
- **webhook handler** — scan `tests/` for sample request payloads. If none, prompt user for a JSON body. Invoke the route handler directly (FastAPI: call the function with a `Request` mock; Express: synthesize a `req` object).
- **notifier** — whatever function triggers the send. Discover signature from imports at the call site.

If trigger inputs can't be discovered, skill prompts user explicitly with the detected signature. No silent guessing.

### 3. Detects boot requirements (new — required)
Two-phase check — static scan identifies what's needed, then **live probes** verify it's actually reachable.

**Static scan:**
- imports that imply external services (`psycopg`, `redis`, `celery`, `boto3`, `kafka`, `pymongo`)
- `os.environ["..."]` / `os.getenv` references
- `.env.example`, `docker-compose.yml`, `Procfile`, `config/database.yml` in the repo root

**Live probes (required — static alone is not enough):**
- Postgres: `pg_isready -h $HOST -p $PORT` or TCP `socket.connect((host, port))` with 1s timeout
- Redis: `redis-cli -h $HOST -p $PORT ping` or TCP probe
- Generic TCP services: 1s-timeout `socket.connect((host, port))`
- Env vars: check `os.environ` at probe time, not just "is it in `.env.example`"

Classify each requirement as (a) reachable (live probe succeeded), (b) satisfiable by `docker compose up <svc>` (service defined in user's compose file but not running), or (c) missing with no automatic fix (env var unset with no default, or required service not defined anywhere).

If (c): surface a clear pre-run error — "this script needs Postgres on localhost:5432, pg_isready returned not-ready. Start it with `X` and re-run." No silent failures. Never proceed with a guess.

### 4. Finds or proposes a dry-run harness
Detect existing `--dry-run` flag, `DRY_RUN=1` env var, or `dry_run` kwarg.

If none present: show the user the diff to add one (argparse flag → passes through to all side-effect callsites) and **require explicit approval before writing**. Matches `/qa` fix-loop pattern — skill mutates user code only with approval, commits atomically.

### 5. Captures side effects by driving existing libraries (v1 = Python only)
**Do not reinvent HTTP capture.** Use what's already proven in the ecosystem. Must cover both **sync and async** Python — FastAPI apps are overwhelmingly async; a sync-only capture layer silently misses most real backend traffic.

Library selection per HTTP client:
- `requests` (sync) → `responses` or `requests-mock`
- `httpx` (sync) → `respx`
- `httpx.AsyncClient` (async) → `respx` (handles both)
- `aiohttp` (async) → `aioresponses`
- `urllib` / `urllib3` (sync) → `responses` handles transitively; fallback `unittest.mock.patch` on `urlopen`
- SMTP → `aiosmtpd` local server or `unittest.mock.patch` on `smtplib.SMTP`
- `grpc`, websockets → deferred to v2 (flag explicitly if detected; skill tells user "this feature uses gRPC / websockets — capture not in v1")

Skill inspects the script's imports to pick the right lib. Prefer already-installed; install into a temp venv only if nothing is available. Never modify user's `requirements.txt` or `pyproject.toml`.

For Node / Ruby / Go in v1: shape detection works, capture does not. Skill prints: "Detected a [node BullMQ worker]. HTTP capture for Node ships in a follow-up PR. Here's the manual path: [3-step guidance]." Follow-up issues filed.

### 6. Renders captured payloads readably
- Slack Block Kit → **structured tree** in v1 (type / text / fields / actions, indented). Faux-Slack visual preview deferred to v2. Diff-friendly, unambiguous.
- MIME email → `From / To / Subject / Body (first 40 lines)`.
- Twilio SMS → `To / From / Body`.
- Generic JSON POST → method, URL, auth-redacted headers, pretty-printed body.
- DB writes → deferred to v2 (requires per-ORM hooks).

### 7. Optional golden-file diff
Goldens live in **user's repo** at `.gstack/qa-headless/golden/<feature>.json` (not in the skill directory — per eng review). Skill diffs on re-run, offers to update on explicit approval.

### 8. Interactive fix loop (same shape as /qa)
Find issue → propose fix with diff → apply on approval → re-run dry-run → confirm output changed → commit atomically. User can reject any fix; skill falls back to report-only behavior for that issue.

### 9. Report
Pass/fail per scenario. Feeds `/ship` review readiness dashboard (same tier as `/qa` — optional, recommended when applicable).

## DRY — shared sections with /qa
Extract the duplicated sections (fix loop framing, report format, commit-on-approval pattern) into new resolvers under `scripts/resolvers/qa-shared.ts`:

- `{{QA_FIX_LOOP}}` — find → propose → approve → apply → re-run → commit
- `{{QA_REPORT_FORMAT}}` — pass/fail per scenario, severity tiers, ship-readiness line

Both `qa/SKILL.md.tmpl` and `qa-headless/SKILL.md.tmpl` reference these placeholders. Any future change propagates to both skills automatically.

## Test plan — evals and fixtures (MANDATORY)
No skill ships without evals in gstack. Adding:

### Fixture projects
Under `qa-headless/fixtures/`:

- `py-cron-slack/` — minimal FastAPI + Postgres + Slack digest cron (motivating case; includes `--dry-run` flag)
- `py-cron-slack-no-dryrun/` — same, but missing `--dry-run` (tests proposal flow)
- `py-worker-celery/` — Celery task that sends notifications
- `py-webhook-handler/` — FastAPI endpoint that writes DB + POSTs to Slack
- `node-worker-bullmq/` — shape detection only (no capture in v1)
- `ruby-notifier-activejob/` — shape detection only
- `go-cmd-notifier/` — shape detection only

### Eval tests (`test/`)
- `qa-headless-shape-detection.eval.test.ts` — gate tier. Deterministic. Runs shape detection across all 7 fixtures, asserts correct classification. Fails CI on regression.
- `qa-headless-python-cron.eval.test.ts` — periodic tier. Drives motivating fixture end-to-end, asserts Block Kit tree output matches golden ("9 groups, 47 calls, Block Kit valid").
- `qa-headless-dry-run-proposal.eval.test.ts` — periodic tier. Runs against `py-cron-slack-no-dryrun`, asserts skill proposes adding `--dry-run`, asserts nothing is committed without approval.
- `qa-headless-boot-requirements.eval.test.ts` — periodic tier. Runs against fixture with Postgres not reachable, asserts skill live-probes and surfaces clear prereq error (not silent failure).
- `qa-headless-empty-diff-fallback.eval.test.ts` — periodic tier. Runs against clean repo with no diff, asserts skill scans for entry points and prompts user rather than dead-ending.
- `qa-headless-trigger-discovery.eval.test.ts` — periodic tier. Runs against CLI fixture with argparse; asserts skill extracts the arg spec and prompts for missing required args.
- `qa-headless-async-capture.eval.test.ts` — periodic tier. Fixture uses `httpx.AsyncClient` to POST to Slack; asserts `respx` captures the call (not just `responses`).
- `qa-headless-celery-sync.eval.test.ts` — periodic tier. Fixture is a Celery task with `.apply()` invocation; asserts skill runs synchronously without requiring a broker.
- `qa-headless-regression.eval.test.ts` — gate tier. Golden-diff against frozen motivating-case output. Any change to skill or fixture that breaks the reproduction trips CI.

Classify per `test/helpers/touchfiles.ts` — touchfiles for this skill: `qa-headless/**/*`, `scripts/resolvers/qa-shared.ts`.

### Coverage target
24 paths identified (19 original + 5 added post-Codex: trigger discovery, empty-diff fallback, live probes, async capture, sync Celery invocation). v1 targets 100% coverage with the eval suite above (shape detection × 7 fixtures + 8 behavioral evals + 1 regression).

## Touched files
- `qa-headless/SKILL.md.tmpl` (new, ~340 lines)
- `qa-headless/SKILL.md` (generated by `bun run gen:skill-docs`)
- `qa-headless/references/framework-detection.md` (new — classification matrix)
- `qa-headless/references/capture-libs.md` (new — which Python libs the skill drives and why)
- `qa-headless/fixtures/` (new — 7 fixture projects)
- `scripts/resolvers/qa-shared.ts` (new — shared `/qa` + `/qa-headless` placeholders)
- `qa/SKILL.md.tmpl` (edit — use `{{QA_FIX_LOOP}}` / `{{QA_REPORT_FORMAT}}` placeholders)
- `test/qa-headless-*.eval.test.ts` (new, 5 files)
- `test/helpers/touchfiles.ts` (edit — add `qa-headless` touchfile entries)
- `README.md` (edit — short blurb positioning `/qa-headless` vs `/qa`)
- `CHANGELOG.md` (edit)
- `DESIGN.md` (edit if skill count is documented there)

Skills are auto-discovered by `scripts/discover-skills.ts` (filesystem glob). No registry edits needed.

## NOT in scope (v1)
- Node / Ruby / Go HTTP capture. Shape detection included; capture deferred to language-specific follow-up PRs. Filed as issues #TBD-node, #TBD-ruby, #TBD-go.
- Faux-Slack visual preview. v1 ships structured tree. Visual preview is v2.
- DB-write capture. Requires per-ORM hooks (SQLAlchemy, ActiveRecord, Sequelize, GORM). Separate design effort.
- Running against real staging environments. v1 is dry-run / local-isolation only.
- Integration edits to `/plan-eng-review`, `/office-hours`, `/review`, `/ship` recommending `/qa-headless`. Filed as follow-up issues per source issue's explicit ask.
- `/qa-headless-only` (report-only variant, no fix loop). Follow-up.

## What already exists (leverage, don't rebuild)
- `qa/SKILL.md.tmpl` (340 lines) — fix loop, report format, setup. Extracting shared resolvers instead of copying.
- `qa-only/SKILL.md.tmpl` (114 lines) — report-only shape reference for the future `/qa-headless-only`.
- `scripts/resolvers/preamble.ts`, `scripts/resolvers/testing.ts` — preamble and test-bootstrap placeholders already reusable.
- `scripts/discover-skills.ts` — auto-register, zero registry work.
- `bun run skill:check` — skill validation gate, wired to CI.
- `bun run test:evals` — diff-based eval runner, wired to CI, already handles $-budget tracking.
- Per-language HTTP mock libraries (`responses`, `vcrpy`, `nock`, `WebMock`) — drive these instead of reinventing.

## Failure modes registry

| Codepath | Failure mode | Test | Error handling | Visibility |
|---|---|---|---|---|
| Shape detection | Misclassification | `qa-headless-shape-detection.eval` | Confirmation gate (AskUserQuestion) | Loud — user confirms |
| Boot requirements | DB / Redis missing | `qa-headless-boot-requirements.eval` | Pre-run check | Loud — explicit "missing X, start with Y" |
| HTTP capture | User has no `responses`/`vcrpy` installed | (covered by python-cron eval env) | Fallback to `unittest.mock`, never mutate user deps | Loud — skill states which lib it's using |
| Fix loop | User rejects fix | `qa-headless-dry-run-proposal.eval` | Fall back to report-only, continue | Loud — skill confirms rejection, no silent commit |
| Golden diff | Stale golden after legitimate change | Standard diff UX | Offer update on approval | Loud — user approves each update |
| Trigger discovery | Script takes args skill can't infer | `qa-headless-trigger-discovery.eval` | Prompt user with detected signature | Loud — user fills args |
| Empty diff | No changed files, primary use case | `qa-headless-empty-diff-fallback.eval` | Repo scan + AskUserQuestion for entry point | Loud — user picks target |
| Async HTTP | `httpx.AsyncClient` / `aiohttp` traffic | `qa-headless-async-capture.eval` | `respx` / `aioresponses` library selection | Loud — skill states which lib it's using |
| Celery broker | Script uses `@task.delay()` needing Redis | `qa-headless-celery-sync.eval` | Invoke via `.apply()` synchronously, no broker | Loud — skill states sync invocation mode |
| gRPC / websockets | Feature uses unsupported transport | (detected at import scan) | Flag explicitly, tell user v1 doesn't cover this | Loud — skill refuses rather than running blind |

Zero critical gaps after revision. Pre-revision had 2 (silent shape misclass + silent boot failure); both resolved.

## Worktree parallelization
Sequential implementation. Single skill, one language end-to-end. No parallel lanes.

## Implementation order
1. Extract `scripts/resolvers/qa-shared.ts` + migrate `qa/SKILL.md.tmpl` to use placeholders. Verify `/qa` still works (`bun run skill:check`, regen, eyeball the diff).
2. Write `qa-headless/SKILL.md.tmpl` (shape detection + boot requirements + fix loop). Regen, `skill:check`.
3. Write `qa-headless/references/` reference docs.
4. Build fixture: `qa-headless/fixtures/py-cron-slack/` (motivating case).
5. Write `qa-headless-shape-detection.eval.test.ts` + `qa-headless-python-cron.eval.test.ts`. Run, iterate.
6. Remaining 5 fixtures (Node / Ruby / Go shape detection + 2 Python edge cases).
7. Remaining evals (boot-req, dry-run proposal, regression).
8. README + CHANGELOG + DESIGN.md.
9. `bun test && bun run test:evals` green.
10. Ship.

## Open questions (still)
- `scripts/resolvers/qa-shared.ts` extraction could inadvertently change existing `/qa` behavior. Mitigation: CI eval suite for `/qa` must stay green after the extraction — if missing, adds a minor detour to step 1.
- Fixture hosting — do fixtures need `docker-compose.yml` or can they all run with SQLite + in-process Redis alternative? Affects whether evals need Docker in CI. Decision: design fixtures to be runnable with pure-Python deps (SQLite, fakeredis) to keep CI simple. If a real Postgres/Redis is needed for a fixture, mark that eval as `periodic` only (not `gate`), so CI doesn't need Docker.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` (outside voice) | Independent 2nd opinion | 1 | ISSUES_FOUND | 6 findings, 5 applied (C1–C5), 1 deferred (C6 = minor gate-tier note) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN → APPLIED | 4 scope + 2 arch + 1 DRY + 1 critical test gap, all applied to plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | skipped — no UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | skipped — internal tooling |

**CROSS-MODEL:** Eng and Codex converged on the same blind spot — plan under-specified execution mechanics. Eng caught library-reuse and boot-req; Codex caught trigger inputs, live probing, async HTTP, and the empty-diff primary use case. No conflicts.

**VERDICT:** ENG CLEARED with Codex concerns incorporated — ready to implement. Next: `/ship` when implementation is done.
