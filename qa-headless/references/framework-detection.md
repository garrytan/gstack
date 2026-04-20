# Framework Detection — `/qa-headless`

How the skill classifies a target file/diff as one of the 6 supported shapes. Used by Phase 1 of `qa-headless/SKILL.md`.

## Shape definitions

A "shape" is a behavioral category, not a framework. Two cron jobs in different languages have the same shape and the same QA loop (find entrypoint → invoke → capture side effect → diff). Capture mechanics differ by language; classification logic does not.

The six shapes:

1. **cron / scheduled job** — runs on a schedule, not in response to an HTTP request
2. **queue worker** — pops jobs off a queue, processes them, often emits side effects
3. **webhook handler** — HTTP route whose meaningful output is a side effect (DB write, outbound HTTP), not the response body
4. **notifier** — function/script whose primary purpose is to emit a notification (Slack, email, SMS, push)
5. **CLI / management command** — operator-invoked script with explicit args, often single-shot
6. **data pipeline / ETL** — batch processing of records, side effects on storage

A single file can match multiple shapes (e.g., a CLI that's also a notifier). Phase 1's confirmation gate lets the user disambiguate.

## Shape markers per language

### Python

| Shape | Strong markers | Weak markers |
|---|---|---|
| cron | `import APScheduler`, `from celery.schedules import crontab`, `beat_schedule = {...}`, `if __name__ == "__main__":` in `scripts/`/`jobs/`/`cron/` directories, k8s `kind: CronJob` | hardcoded time-of-day strings, `schedule` library import |
| queue worker | `@celery.task`, `@shared_task`, `from celery import Celery`, RQ `Worker`, Dramatiq `@actor`, `from huey import` | functions named `process_*`, `handle_*` in `workers/`/`tasks/` |
| webhook handler | `@app.route` / `@router.post` / `@app.post` with side-effect imports (`requests`, `httpx`, ORM writes) and returns 200/204 | route returns no JSON, only status code |
| notifier | `requests.post("https://hooks.slack.com/...")`, `httpx.post` to known notification APIs, `smtplib.SMTP`, `boto3.client('sns')`, Twilio/SendGrid/Postmark client imports | function name contains `notify`, `send_`, `dispatch_`, `email_` |
| CLI | `argparse.ArgumentParser`, `import click` + `@click.command`, `import typer`, Django `BaseCommand`, `if __name__ == "__main__"` with `sys.argv` parsing | `entry_points` in `setup.py`/`pyproject.toml` |
| ETL | `import pandas`, `import polars`, `import dbt`, raw SQL strings with `INSERT`/`UPDATE`/`DELETE` in `pipelines/`/`etl/`/`migrations/` | reads from one source, writes to another |

### Node

| Shape | Strong markers | Weak markers |
|---|---|---|
| cron | `import { CronJob } from 'cron'`, `node-cron`, `agenda`, `bree`, Procfile `clock`/`scheduler`, k8s CronJob | filename `cron.js`, `scheduler.js` |
| queue worker | `import { Worker } from 'bullmq'`, `bee-queue`, `agenda.define(...)`, `faktory-worker` | files in `workers/`/`processors/`/`jobs/` |
| webhook handler | Express/Fastify/Hono route handler with side-effect imports and 200/204 response | controller with side effects but minimal response body |
| notifier | `axios.post('https://hooks.slack.com/...')`, `nodemailer`, Twilio/SendGrid SDK | function name `notify*`, `send*` |
| CLI | `commander`, `yargs`, `oclif`, `meow`, `process.argv` parsing in `bin/` | `bin` field in `package.json` |
| ETL | batch processors, `node-streams`, scripts that read CSVs and write to DB | files in `etl/`/`migrate/`/`seeds/` |

### Ruby

| Shape | Strong markers | Weak markers |
|---|---|---|
| cron | `whenever` gem, `config/schedule.rb`, `Rake::Task` invoked by external scheduler, k8s CronJob | rake task with no args |
| queue worker | `Sidekiq::Worker`, `class X < ApplicationJob`, `ActiveJob::Base`, `Resque @queue` | classes in `app/workers/`/`app/jobs/` |
| webhook handler | Rails route + controller with side-effect calls returning 200/204 | controller with `head :ok` and significant body |
| notifier | `Net::HTTP.post` to known APIs, `Mail.deliver`, `ActionMailer::Base`, Twilio/SendGrid gems | classes in `app/mailers/`, `app/notifiers/` |
| CLI | `thor`, `OptionParser`, `rails runner`, rake tasks taking args | files in `bin/`, executables in `exe/` |
| ETL | rake tasks doing batch DB work, scripts in `lib/tasks/` with raw SQL | filenames `import_*.rb`, `migrate_*.rb` |

### Go

| Shape | Strong markers | Weak markers |
|---|---|---|
| cron | `time.Tick` patterns in `cmd/*/main.go`, `gocron` library, k8s CronJob | binary names containing `cron` |
| queue worker | channel-based `for { select { case ... } }` workers, `asynq`, `machinery` | files in `internal/workers/` |
| webhook handler | `http.HandlerFunc` / `gin.HandlerFunc` with side-effect calls and `WriteHeader(200)` | minimal response body |
| notifier | `http.Post` to known notification URLs, `net/smtp`, AWS SDK SNS/SES clients | function names `Notify*`, `Send*` |
| CLI | `cobra`, `urfave/cli`, `flag` package in `cmd/*/main.go` | `cmd/` directory structure |
| ETL | batch processors, files in `cmd/etl/`, `cmd/migrate/` | binary writes to multiple destinations |

## Disambiguation rules

When a file matches multiple shapes, prefer the more specific:

- **webhook handler** beats **notifier** when the file is also a route — the route is the entry point, the notification is downstream
- **queue worker** beats **notifier** when the worker class wraps notification logic — the worker is the trigger, the notifier is one of its actions
- **CLI** beats **cron** when the file accepts args — cron-scheduled scripts often *are* CLIs invoked by a scheduler; the CLI shape is more useful for QA (we can vary the args)
- **ETL** beats **cron** when batch data work is the primary behavior — ETL pipelines are often cron-scheduled but their interesting QA surface is the data transform

When in doubt, the confirmation gate (Phase 1) lets the user pick.

## Empty-diff fallback

When `git diff <base>...HEAD` returns no files matching any shape marker, scan the repo for entry points:

```bash
# Python entry points
find . -name "*.py" -path "*/scripts/*" -o -path "*/jobs/*" -o -path "*/cron/*" -o -path "*/workers/*" -o -path "*/tasks/*" 2>/dev/null
# CLI binaries
find . -path "*/bin/*" -type f 2>/dev/null
# k8s CronJob manifests
find . -name "*.yaml" -o -name "*.yml" 2>/dev/null | xargs grep -l "kind: CronJob" 2>/dev/null
# Procfile entries
cat Procfile 2>/dev/null | grep -E "^(clock|scheduler|worker):"
```

Rank candidates by recency (`git log -1 --format=%at <file>`), present top 5 via AskUserQuestion. The user picks one, the skill classifies it, then proceeds.
