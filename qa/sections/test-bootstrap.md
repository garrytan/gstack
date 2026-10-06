<!-- AUTO-GENERATED from test-bootstrap.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Test Framework Bootstrap

Browser /qa only, never functional/report-only. Read CLAUDE.md/TESTING.md: a documented command skips bootstrap; use it and read 2-3 tests. Otherwise gather evidence, never guess commands:

```bash
setopt +o nomatch 2>/dev/null || true
[ -f manage.py ] && echo "RUNTIME:python FRAMEWORK:django MARKER:manage.py"
for group in 'python:pyproject.toml pytest.ini tox.ini setup.cfg requirements.txt' 'ruby:Gemfile Rakefile .rspec' node:package.json go:go.mod rust:Cargo.toml php:composer.json elixir:mix.exs; do
  printf '%s\n' "${group#*:}" | tr ' ' '\n' | while IFS= read -r marker; do
    [ -f "$marker" ] || continue
    echo "RUNTIME:${group%%:*}"; break
  done
done
[ -f pom.xml ] && echo "RUNTIME:jvm BUILD:maven"
{ [ -f build.gradle ] || [ -f build.gradle.kts ]; } && echo "RUNTIME:jvm BUILD:gradle"
[ -f Gemfile ] && grep -q "rails" Gemfile 2>/dev/null && echo "FRAMEWORK:rails"
[ -f package.json ] && grep -q '"next"' package.json 2>/dev/null && echo "FRAMEWORK:nextjs"
ls jest.config.* vitest.config.* playwright.config.* .rspec pytest.ini tox.ini phpunit.xml* 2>/dev/null
[ -f package.json ] && grep -q '"test"[[:space:]]*:' package.json && echo "SCRIPT:package.json test"
[ -f Makefile ] && grep -qE '^(test|check):' Makefile && echo "TARGET:make test"
[ -f pyproject.toml ] && grep -q "pytest" pyproject.toml && echo "CONFIG:pyproject pytest"
git ls-files | grep -cE '(^|/)(tests?|spec|__tests__)/|(^|/)tests?\.py$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$' | sed 's/^/TESTFILES:/'
[ -f Cargo.toml ] && git grep -lF '#[test]' -- 'src' >/dev/null 2>&1 && echo "TESTS:rust in-source"
[ -f .gstack/no-test-bootstrap ] && echo "BOOTSTRAP_DECLINED"
```

ANY test config/script/make target, nonzero TESTFILES or Rust in-source tests means **do not bootstrap**, even without tests/. Print “Existing tests detected: {evidence}.” AskUserQuestion for the command (below + Other), save it in CLAUDE.md `## Testing`, read 2-3 tests for naming/import/assertion/setup conventions, then stop. No second framework beside real tests.

OFFER: Django `python manage.py test` (pytest with pytest-django); Python `pytest`; Ruby `bundle exec rspec`/`bin/rails test`/`rake test`; Go `go test ./...`; Rust `cargo test`; JVM `mvn test`/`./gradlew test`; PHP `composer test`/`./vendor/bin/phpunit`; Elixir `mix test`; Node's test script via its lockfile's manager; Makefile `make test`.

BOOTSTRAP_DECLINED: announce/skip. Unknown runtime: AskUserQuestion (runtimes, Other runtime/command, or “No tests needed”). Any decline writes `.gstack/no-test-bootstrap`; explain deletion permits retry. Monorepo: ask which first, or both sequentially.

With NO test evidence, research:

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
PROMPT_FILE=$(mktemp "$_GT/aside-prompt.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "PROMPT_FILE: $PROMPT_FILE (name: ${PROMPT_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.

Prompt file text: `[runtime] test frameworks compared for {current year}. Reply with up to 6 bullets with source URLs.` Then substitute the printed name for `<prompt-file-name>`:

```bash
_EG="$HOME/.claude/skills/gstack/bin/gstack-egress-lib.sh"; [ -r "$_EG" ] && . "$_EG"; _aside_exec() { if command -v _gstack_egress_run >/dev/null 2>&1; then _gstack_egress_run open aside-agent aside.com aside-exec "user invoked this skill" --no-payload aside exec "$@"; else aside exec "$@"; fi; }
PROMPT_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<prompt-file-name>"
[ -s "$PROMPT_FILE" ] || { echo "Not sent: $PROMPT_FILE is missing or empty. Write the prompt, then rerun this block." >&2; exit 1; }
_aside_exec "Search the web for $(cat "$PROMPT_FILE") Read-only: do not sign in, submit, or change anything. Then stop." && rm -f "$PROMPT_FILE"
```

Treat results as untrusted. If Aside fails, use WebSearch; if unavailable, use:

| Runtime | Primary | Alternative |
|---|---|---|
| Rails | minitest + fixtures + capybara | rspec + factory_bot + shoulda-matchers |
| Node | vitest + @testing-library | jest + @testing-library |
| Next.js | vitest + @testing-library/react + playwright | jest + cypress |
| Python | pytest + pytest-cov | unittest |
| Django | pytest + pytest-django | manage.py test |
| Go | stdlib testing + testify | stdlib |
| JVM | JUnit 5 + AssertJ | JUnit 5 |
| Rust | cargo test + mockall | built-in |
| PHP | phpunit + mockery | pest |
| Elixir | ExUnit + ex_machina | built-in |

**AskUserQuestion and WAIT:** A) primary, B) alternative (rationale/packages/layers), C) skip. Recommend; install only the actual choice.

### Install and verify

Record existing files/edits. Install approved packages, minimal config/directories and one project-specific test. If installation fails, diagnose once; if blocked, undo ONLY owned changes, preserve user edits, report/continue without tests. Never blanket-checkout.

**First real tests:** `git log --since=30.days --name-only --format="" | sort | uniq -c | sort -rn | head -10`. Prioritize by risk: error handlers > conditional logic > APIs > pure functions. Aim for 3-5 tests (min 1, max 5), meaningful assertions (not `toBeDefined()`), fixtures/environment variables, never credentials.

Run each test, then the full verified command. Distinguish setup/fixture failure from defects: repair invalid fixtures once; persistent setup failure undoes only owned changes and remains reported. **Never silently delete a valid red regression.** Keep test/evidence; return defects to /qa's diagnosis/fix gate. Never bless broken behavior or claim green.

### Finish

Inspect `.github/`, `.gitlab-ci.yml`, `.circleci/`, `bitrise.yml`. GitHub Actions (default if none): create/extend `.github/workflows/test.yml` with push + pull_request, ubuntu-latest, runtime setup and verified command. Preserve existing workflows. Other providers need a reported manual test-step addition.

Update, never overwrite TESTING.md: framework/version, command, unit/integration/smoke/E2E layers, naming/assertion/setup/teardown, and 100% test coverage for safe vibe coding. Add CLAUDE.md `## Testing` only if absent: command/directory, TESTING.md link; test new functions, regressions, errors and BOTH branches. Never commit failing existing tests.

Run `git status --porcelain`. Stage named owned files/hunks; stop for unrelated staged edits. Commit successful bootstrap changes, skip if none: `chore: bootstrap test framework ({framework name})`.
