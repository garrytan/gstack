# Capture Libraries — `/qa-headless`

Which existing per-language HTTP/SMTP mock libraries `/qa-headless` drives, and why we drive them instead of writing custom shims.

## The principle

Reinventing HTTP capture per language is a maintenance sinkhole. Every Python project that does HTTP testing already has `responses`, `vcrpy`, `requests-mock`, `respx`, or `aioresponses` in its test suite. Driving the library the user already has is faster, more compatible, and produces output formats users already understand.

The skill's job: detect which library to use, set it up to capture during the dry-run invocation, then translate captured payloads into the renderers in Phase 6.

## Python (v1 — fully supported)

| HTTP client | Capture library | Why this one | Install if missing |
|---|---|---|---|
| `requests` (sync) | `responses` (preferred) or `requests-mock` | Both are widely adopted; `responses` has slightly better support for assertions on calls made | `pip install responses` |
| `httpx` (sync or async) | `respx` | The standard `httpx` mock library; handles both sync and `httpx.AsyncClient` from one API | `pip install respx` |
| `aiohttp` | `aioresponses` | The standard `aiohttp` mock; required because `responses` doesn't intercept aiohttp | `pip install aioresponses` |
| `urllib` / `urllib3` | `responses` (transitive — `responses` patches the underlying urllib3 transport) | Free coverage if `requests` is also in the project. Otherwise `unittest.mock.patch` on `urllib.request.urlopen` | (none — stdlib) |
| `smtplib` | Two options: (1) `aiosmtpd` local server on `127.0.0.1:1025`, or (2) `unittest.mock.patch` on `smtplib.SMTP.sendmail`. Pick (1) if the script reads SMTP responses, (2) otherwise | `pip install aiosmtpd` |

### Library selection algorithm

1. Read the target file + transitively imported modules.
2. Identify every HTTP/SMTP client used.
3. For each client, check if the corresponding capture lib is in `requirements.txt` / `pyproject.toml` / `Pipfile`. Use what's installed.
4. If multiple clients are in use (common: `requests` for one API + `httpx.AsyncClient` for another), set up multiple capture libs. They don't conflict.
5. If no capture lib is installed, install the preferred one into a temp venv: `python3 -m venv /tmp/qa-headless-venv && /tmp/qa-headless-venv/bin/pip install <lib>`. **Never** modify the user's dependency files.

### Installation invariant

The skill never writes to the user's `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py`, or `setup.cfg`. Capture is an out-of-band operation; it must not pollute the user's actual dependency graph. Temp venvs are disposable.

## Node (v1 — shape detection only, no capture)

Planned capture for follow-up PR (issue #TBD-node):

| HTTP client | Capture library |
|---|---|
| `axios` | `nock` or `axios-mock-adapter` |
| `fetch` (global) | `nock`, `msw`, or `undici` MockAgent |
| `node-fetch` | `nock` |
| `got` | `nock` |
| `nodemailer` | `nodemailer-mock` |

In v1, when Node is detected, the skill prints manual guidance referencing these libraries and exits cleanly.

## Ruby (v1 — shape detection only, no capture)

Planned capture for follow-up PR (issue #TBD-ruby):

| HTTP client | Capture library |
|---|---|
| `Net::HTTP` | `WebMock` or `VCR` |
| `Faraday` | `WebMock` (transitive) or `Faraday::Adapter::Test` |
| `HTTParty` | `WebMock` |
| `Mail` (ActionMailer) | `ActionMailer::Base.deliveries` (built-in) |

In v1, when Ruby is detected, the skill prints manual guidance referencing these libraries and exits cleanly.

## Go (v1 — shape detection only, no capture)

Planned capture for follow-up PR (issue #TBD-go):

| HTTP client | Capture library |
|---|---|
| `net/http` (`http.Client`) | `httpmock` or `gock`. Or: pass a `RoundTripper` that records calls. |
| `net/smtp` | Custom SMTP server on `127.0.0.1` |
| `gRPC` | `grpcmock` (limited coverage; v2 candidate) |

Go is fundamentally harder than Python/Node/Ruby because it's compiled — no monkeypatching. Capture relies on either dependency injection (passing a custom `http.Client`) or a local proxy. v1 defers entirely; v1.x will likely require the user to opt into a proxy mode.

## Out-of-scope transports (v1)

These print a clear "unsupported in v1" message rather than running blind:

- **gRPC** — needs language-specific mock libraries; v2 candidate
- **WebSockets** — bidirectional; capture needs per-message handling; v2 candidate
- **GraphQL over `requests`/`httpx`** — works (it's just HTTP POST), but the renderer in Phase 6 doesn't pretty-print GraphQL operations yet; v1.1 candidate
- **Kafka / RabbitMQ / SQS produce** — message-broker side effects; needs broker-specific mocks; v2 candidate
- **DB writes** — captured only for trivial ORM hooks; full DB-write capture across SQLAlchemy / ActiveRecord / Sequelize / GORM is a separate design effort

When the skill detects one of these, it prints which transport is unsupported and exits the affected payload from capture (other captureable transports in the same script still get captured).
