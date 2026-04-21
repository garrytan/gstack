# RFC: Windows CI for gstack

**Status:** Draft for discussion
**Author:** @scarson
**Target:** @garrytan + reviewers
**Last updated:** 2026-04-21

## TL;DR

gstack ships Windows bugs that no CI job ever sees, because no workflow runs on Windows. Five instances of this pattern have been filed in the last month (one merged in #1024, four open from me in the last 24 hours: #1118, #1119, #1120, #1121). This RFC proposes a phased rollout, starting with a cheap smoke CI that would have surfaced four of the five at PR time (one is covered partially — see the coverage table). It builds on the root-cause fix in #1024 (v0.18.0.1) — that PR made CI failures loud; this RFC makes the right code paths actually run.

## Background

In #1024 (v0.18.0.1, 2026-04-16), Garry landed a fix for a silent-CI bug: `|| true` in `package.json`'s build script was swallowing failures across the entire `&&` chain, so a broken Windows build step reported green in CI. His comment on my #1013 captured the root cause:

> *"Your diagnosis was particularly sharp: you caught that the bug had been shipping silently since v0.15.12 (which explained why Windows users were running a stale v0.15.11-era server bundle). That was the insight that motivated adding the root-cause fix — the `|| true` in the package.json build command that let the build step fail silently in CI."*

That fix closed the **symptom**: CI failures are no longer suppressed.

The **underlying coverage gap** remains: even with `|| true` fixed, Windows code paths still don't get executed. Every workflow under `.github/workflows/` runs exclusively on `ubuntu-latest`, `macos-latest`, or `ubicloud-standard-2` (Linux). The closest thing to a Windows plan in the repo is a commented-out `# - os: windows-latest` block at `.github/workflows/make-pdf-gate.yml:32` with a "Codex round 2 #18" TODO about pdftotext output tolerance.

## Evidence: the pattern is recurring

Windows-specific bugs merged or open in the last ~month:

| PR / Issue | Who | What | Shipped because |
|---|---|---|---|
| #1013 → #1024 | @scarson, @tomasmontbrun-hash | `@ngrok/ngrok` native addon broke bun build on Windows | No Windows CI job exercised the Node server bundle build |
| #1094 / #1118 | @BkashJEE / @scarson | `make-pdf` couldn't resolve `browse.exe` / `pdf.exe` | Binary-resolution code paths never ran on Windows |
| #1119 | @scarson | Telemetry bash-script `spawn()` silently `ENOENT`s on Windows | `CreateProcess` semantics never exercised |
| #1120 | @scarson | `process.env.HOME \|\| '/tmp'` fallback mislocates `.gstack/` state | `HOME`-unset Windows-shell invocation never tested |
| #1121 | @scarson | `fs.chmodSync(path, 0o600)` is a no-op on Windows; secrets end up world-readable to inherited ACEs | NTFS ACL assertions don't exist in any test |
| #748 | @Gonzih | Hardcoded `/tmp` in `cookie-import-browser` | `/tmp` writability never tested on Windows |
| #558 | @HMAKT99 | Bare `~` in preamble bash paths didn't expand under some Windows shells | Preamble never executed in a Windows shell |
| #843 | @mvanhorn | Bare `~` in generated SKILL.md browse/design binary paths | No Windows shell ever ran a generated SKILL.md preamble |
| #1051 | @walton-chris | Line-ending normalization in template reads | CRLF paths never parsed in test env |
| #797 | @49EHyeon42 | Codex browse runtime failed on Windows | Codex host adapter not exercised on Windows |
| #719 | @jeffrichley | `extraEnv` dropped on Windows launcher | Detached-process env propagation untested |
| #486, #490, #493 | multiple | `findPort()` `EADDRINUSE` race | Windows Bun.serve polyfill paths untested |

Plus open bug reports still waiting for a fix: #807 (chrome-headless-shell orphan processes), #764 (cookie-import on Windows), #763 (extraEnv for connect-chrome). This isn't a one-off; it's a monthly rate.

Several of these PR bodies (including all four of mine) include a "why this shipped unnoticed" paragraph that resolves to the same sentence: no gstack workflow runs on Windows. The rest fit the same shape whether or not they spell it out.

## Goals and non-goals

**Goals:**
- Surface the next #1118-class bug (Windows-only code path fails / misbehaves) as a PR check before merge. Whether that check is merge-blocking or merely informational is an open question — see the section at the end.
- Start cheap. Any new CI spend must be justified per-bug-prevented.
- Compose with the existing Tier 1 / Tier 2 / Tier 3 structure in `CONTRIBUTING.md`, not replace it.
- Give contributors a signal they're not breaking Windows without paying the cost of a Windows dev box.

**Non-goals:**
- Full Windows feature parity. Things like the macOS-Keychain cookie-decryption path aren't in scope; this RFC is about testing what the project *already says* works on Windows.
- Solving the pdftotext tolerance question from `make-pdf-gate.yml`. That's a real but separate piece of work; Phase 3 gates on it.
- 100% test coverage on Windows. The existing test suite has known-flaky tests on Windows (documented below) that would make day-one full-matrix hostile to contributors.
- Replacing the Dockerfile.ci pattern. Any Windows image follows the same "pre-bake the toolchain" approach.

## Proposal: phased rollout

### Phase 1 — Windows Smoke (this RFC's primary deliverable)

**Scope:** Build the binaries, assert they land as `.exe`, execute them, run four Windows-specific unit-test files plus a make-pdf render smoke.

A Phase 1 run exists to answer *one question*: "does the code path through a Windows-critical module actually run on Windows." That's a much lower bar than "does every test pass," and it's high-value — see the "What this catches" table for the specific bug-class coverage breakdown.

**Phase 1 is valuable standalone.** If Phases 2 and 3 never ship, Phase 1 alone still catches the entire `.exe` / shebang / binary-resolution class of bugs that drove this RFC. No commitment to landing Phase 2 is implicit in agreeing to Phase 1.

**Proposed `.github/workflows/windows-smoke.yml`:**

```yaml
name: windows-smoke
on:
  pull_request:
    branches: [main]
    paths:
      - 'browse/**'
      - 'make-pdf/**'
      - 'design/**'
      - 'scripts/**'
      - 'bin/**'
      - 'package.json'
      - 'bun.lockb'
      - '.github/workflows/windows-smoke.yml'
  push:
    branches: [main]
    paths:
      - 'browse/**'
      - 'make-pdf/**'
      - 'design/**'
      - 'scripts/**'
      - 'bin/**'
      - 'package.json'
      - 'bun.lockb'
  workflow_dispatch:

jobs:
  smoke:
    runs-on: windows-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build binaries
        run: bun run build

      - name: Assert Windows binary layout
        shell: pwsh
        run: |
          $missing = @()
          foreach ($p in @(
            'browse/dist/browse.exe',
            'browse/dist/find-browse.exe',
            'browse/dist/server-node.mjs',
            'make-pdf/dist/pdf.exe',
            'design/dist/design.exe'
          )) { if (-not (Test-Path $p)) { $missing += $p } }
          if ($missing.Count -gt 0) {
            Write-Error "Missing build artifacts: $($missing -join ', ')"
            exit 1
          }

      - name: Windows-specific unit tests
        # Single bun test invocation so a failure in any file reliably fails
        # the step. Default PowerShell error-handling masks all-but-the-last
        # command's exit code across separate `run:` lines.
        run: bun test browse/test/security.test.ts browse/test/file-permissions.test.ts browse/test/home-dir-resolution.test.ts make-pdf/test/browseClient.test.ts make-pdf/test/pdftotext.test.ts

      - name: make-pdf render smoke
        run: bun test make-pdf/test/render.test.ts
```

**What this catches that the current matrix doesn't:**

Every row below has been demonstrated on a live CI run. The "Demo" links point to PRs on scarson/gstack where Phase 1 was pointed at a pre-fix state of the corresponding bug; each link lands on a red CI run that fails at exactly the step noted. The "Green baseline" link ([PR #4](https://github.com/scarson/gstack/pull/4)) shows Phase 1 passing end-to-end against the state where all four fix PRs are applied.

| Class | Example PR | Phase 1 catches it? | Demo run |
|---|---|---|---|
| Build fails to produce `.exe` on Windows | #1013 / #1024 | ✅ Fails at "Assert Windows binary layout" step | [PR scarson/gstack#2](https://github.com/scarson/gstack/pull/2) — pinned to `6a785c5^` (pre-v0.18.0.1) |
| Binary-resolution probes the wrong filename | #1118 / #1094 | ✅ Fails in `browseClient.test.ts` | [PR scarson/gstack#3](https://github.com/scarson/gstack/pull/3) — main + #1118 tests only, no src fix |
| Home-directory fallback misroutes state | #1120 | ✅ Fails in `home-dir-resolution.test.ts` (new regression test, added as part of this RFC) | [PR scarson/gstack#7](https://github.com/scarson/gstack/pull/7) — main + new test, no #1120 src fix |
| Sensitive files written without ACL restriction | #1121 | ✅ Fails in `file-permissions.test.ts` (Cannot find module) | [PR scarson/gstack#6](https://github.com/scarson/gstack/pull/6) — main + #1121 test only, no src fix |
| Shebang bash script spawn fails | #1119 | ✅ Fails in `security.test.ts` `buildTelemetrySpawnCommand` assertion | [PR scarson/gstack#5](https://github.com/scarson/gstack/pull/5) — main + #1119 tests only, no src fix |
| `{ mode: 0o600 }` silently ignored | Pre-#1121 state | ✅ Caught by `file-permissions.test.ts` POSIX mode-bit assertion | Same demo as #1121 row above |

**Bug-class totals:** five of five recent PRs caught by Phase 1 — #1024 build, #1118 binary resolution, #1119 shebang spawn, #1120 home-dir, #1121 ACL. The #1120 row was originally a ❌ in an earlier draft of this RFC; the regression test I wrote while preparing the RFC (`browse/test/home-dir-resolution.test.ts`, included in this branch) closes that gap.

**Test-file dependency:** four of the test files Phase 1 invokes live in my currently-open PRs (#1118, #1119, #1121 — their test additions, plus the new home-dir-resolution.test.ts in this RFC branch). If those PRs land before this workflow lands, coverage is as advertised. If the workflow lands first, the "Windows-specific unit tests" step should either (a) be narrowed to tests already on main, or (b) fail gracefully on missing files and expand as each PR merges. The YAML above assumes "my open PRs merge first" — I'd sequence it that way and can trim to a narrower set if you'd rather sequence differently.

### Phase 2 — Unit test subset

Extends Phase 1 with the rest of the existing test suite, minus a curated skip list.

**Known pre-existing Windows test failures** (surfaced during PR #1120 / #1121 verification; each needs its own issue + triage owner before Phase 2 can run clean):

- `browse/test/bun-polyfill.test.ts` (4 failing tests: `Bun.serve`, `Bun.spawn`, `Bun.spawnSync`, `Bun.sleep`) — all return empty stdout from child processes. Likely an MSYS2/Git Bash subshell-capture quirk, not a product bug, but the test assumes POSIX semantics.
- `browse/test/batch.test.ts` — `beforeEach` hook times out at 5s. Not-yet-diagnosed.
- `browse/test/compare-board.test.ts` — same.
- `browse/test/sidebar-integration.test.ts`, `browse/test/sidebar-agent-roundtrip.test.ts` — ~5 tests around agent status transitions and message-queue routing (`agent events appear in /sidebar-chat`, `agent_done transitions status to idle`, `queues message when agent is processing`, `kill adds error entry and returns to idle`, plus a `(unnamed) [5016.00ms]` that's probably a `beforeAll` variant). Same 5s hook-timeout pattern.

Per-test issues to be filed. A `windows-skip.txt` (or `.skip` annotations) keeps the skip list reviewable.

Phase 2 is merge-gating only once the skip list is empty or explicitly signed off as known-acceptable.

### Phase 3 — E2E + make-pdf-gate on Windows

Gated on two prior pieces of work:

1. **Widen `pdftotext.normalize()`** to absorb the Xpdf / Poppler-Windows output divergences flagged in the `make-pdf-gate.yml:26` comment. Known divergences from the comment: whitespace, line wrap, Unicode normalization, form feeds, extraction order. Options: broader normalize rules, or a "tolerant gate" mode that asserts content presence but not layout.
2. **Phase 2 skip list curated to empty** so the broader test set is green on Windows.

Phase 3 enables the existing `make-pdf-gate` matrix's commented-out Windows entry and extends `evals.yml` to a Windows matrix. Runtime grows from the 3-5 min of Phase 1 to whatever the slowest Windows E2E suite clocks — worth it for the catch rate, not worth it before the prerequisites.

## Runner sourcing

gstack's Linux workflows run on `ubicloud-standard-2` (every workflow under `.github/workflows/` except the lightweight `actionlint.yml` and `skill-docs.yml`, which stay on `ubuntu-latest`). That predates this RFC and appears to be a speed / concurrency choice, not a dollar-cost one — gstack is a public repository, and [GitHub's January 2026 pricing update](https://resources.github.com/actions/2026-pricing-changes-for-github-actions/) keeps GitHub-hosted Actions minutes free for public repos, including exemption from the new $0.002/min cloud-platform charge.

[Ubicloud is Linux-only](https://www.ubicloud.com/use-cases/github-actions) — no Windows runner in their offering as of April 2026. Phase 1 therefore targets `windows-latest` on GitHub-hosted runners, which is (a) the same free tier the project's lightweight jobs already use and (b) the only drop-in option that doesn't require standing up a new provider. If a third-party Windows runner (RunsOn is the most commonly cited alternative for Windows-hosted CI as of April 2026) ever makes sense for gstack, that's a Phase 2+ migration — not a Phase 1 prerequisite.

**Real costs:** zero dollars. The budget line items are maintainer attention for the workflow file and any flake triage that lands on @garrytan's plate. Phase 1 completes in **under 1:15 wall-clock** on GitHub-hosted `windows-latest` with a cold runner — well under the `timeout-minutes: 10` I set. Measurements come from the demo runs on scarson/gstack linked below; green-baseline runs clocked 50s–1:15 across 7 pushes.

## Implementation concerns

**Toolchain pre-baking.** The existing `Dockerfile.ci` pre-bakes Bun + Playwright + Chromium so Linux jobs skip the cold-install cost. An equivalent `Dockerfile.ci.windows` (or a `.github/actions/setup-windows` composite action) would cut Phase 2/3 runtime. Skip for Phase 1 — the smoke set doesn't need Chromium, so `bun install` is the only cold-cache cost.

**Shell.** GitHub Actions' default `run:` shell on `windows-latest` is PowerShell (either Windows PowerShell 5.1 via `powershell`, or PowerShell Core via `pwsh` — both are installed on the runner image). The "Assert Windows binary layout" step marks `shell: pwsh` explicitly so its array-literal / `foreach` syntax is unambiguously parsed by PS 7+. The `bun test` and `./...exe --version` invocations work correctly under either PS version — forward slashes in paths are fine, and `bun` doesn't use PS-incompatible syntax. Git Bash also ships on the runner and is available via `shell: bash` if a future step needs it.

**Cross-platform line endings.** `actions/checkout@v4` normalizes to LF by default. The repo's `.gitattributes` should be checked to ensure no critical file is getting CRLF-converted during clone — worth a one-line audit before Phase 1 merges.

## Open question for @garrytan

**Gate or continue-on-error for the first 2 weeks?** My default: `continue-on-error: true`, report failures in the PR Checks tab, flip to gating after a clean-signal review. This is the one judgment call I don't want to make unilaterally — you have better context on gstack's flake-tolerance norms and on whether a fresh red Windows check would be useful signal or unwelcome blocker during the bake-in period.

Everything else (runner sourcing, scope of the YAML, Phase 2 skip-list ownership) is proposed with a defensible default in the body. Push back inline if any of them land wrong.

## Precedents

Two Node-ecosystem projects already run GitHub-hosted Windows CI in the pattern Phase 1 follows:

- **[npm/cli](https://github.com/npm/cli/blob/latest/.github/workflows/ci.yml)** — matrix with `os: [ubuntu-latest, macos-latest, macos-15-intel, windows-latest]`, `runs-on: ${{ matrix.platform.os }}`. Platform-specific shell overrides are done per-matrix-entry (`shell: bash` on Windows rows where the test commands assume POSIX tooling).
- **[microsoft/playwright](https://github.com/microsoft/playwright/blob/main/.github/workflows/tests_primary.yml)** — core tests run on `[ubuntu-latest, macos-latest]` base matrix with explicit `include:` entries for `os: windows-latest` covering the hot-path browsers. Same GitHub-hosted `windows-latest` runner gstack would target.

Both projects are public repos, both use the free GitHub-hosted tier this RFC proposes, and both have been stable on Windows long enough that their Windows matrix has become expected rather than controversial. The path isn't novel — it's catching up to the ecosystem norm.

## Receipts

Everything in this RFC is demonstrable on live CI on [scarson/gstack](https://github.com/scarson/gstack). The table below is the full dashboard; the coverage table above links to individual runs inline.

| What | PR | Status | Run | Wall clock |
|---|---|---|---|---|
| **Green baseline** (all four fix PRs applied) | [#4](https://github.com/scarson/gstack/pull/4) | ✅ success | [run 24713325443](https://github.com/scarson/gstack/actions/runs/24713325443) | 59s |
| Catches #1024 build-fail | [#2](https://github.com/scarson/gstack/pull/2) | ❌ failure (expected; `bun run build` errors) | [run 24713460340](https://github.com/scarson/gstack/actions/runs/24713460340) | ~1m |
| Catches #1118 binary-resolution | [#3](https://github.com/scarson/gstack/pull/3) | ❌ failure (expected; `browseClient.test.ts` fails) | [run 24713462662](https://github.com/scarson/gstack/actions/runs/24713462662) | ~1m |
| Catches #1119 shebang-spawn | [#5](https://github.com/scarson/gstack/pull/5) | ❌ failure (expected; `security.test.ts` fails) | [run 24713463096](https://github.com/scarson/gstack/actions/runs/24713463096) | ~1m |
| Catches #1120 home-dir (via new regression test) | [#7](https://github.com/scarson/gstack/pull/7) | ❌ failure (expected; `home-dir-resolution.test.ts` enumerates offenders) | [run 24713464002](https://github.com/scarson/gstack/actions/runs/24713464002) | ~1m |
| Catches #1121 ACL / `chmod` no-op | [#6](https://github.com/scarson/gstack/pull/6) | ❌ failure (expected; `file-permissions.test.ts` module not found) | [run 24713465618](https://github.com/scarson/gstack/actions/runs/24713465618) | ~1m |

**Stability proof:** [PR #4](https://github.com/scarson/gstack/pull/4) is also the target for N≥2 consecutive green runs (the green baseline + subsequent re-triggers). At time of writing, the first green run is linked above; additional runs on the same HEAD are visible in the PR's Checks tab as they complete.

**Contributor UX:** the [Checks tab on PR #4](https://github.com/scarson/gstack/pull/4/checks) shows exactly what a contributor would see if this workflow were live on upstream — one `windows-smoke / smoke` check alongside the existing Linux/macOS checks, green in under 1:15.

## What happens next

If this proposal is directionally OK:

1. **File the draft PR** on garrytan/gstack — the `.github/workflows/windows-smoke.yml` in this branch, plus the `browse/test/home-dir-resolution.test.ts` regression test, as a single artifact. Sequenced after #1118 / #1119 / #1121 merge so the test files the workflow invokes actually exist on main. If you'd rather I land it earlier with a narrower test set, say so — cutting is straightforward.
2. **Phase 2 skip list** — once Phase 1 is live on upstream main, I'll file per-test issues for the 7 known-flaky Windows tests with repro details and suspected fix paths. Holding those until Phase 1 lands so they don't clutter the issue tracker pre-direction.
3. **Phase 3** (widened `pdftotext.normalize()` + Windows `make-pdf-gate` matrix) is not volunteered work on my end — flagging the path forward but leaving it unowned.

If there's a reason this shape is wrong — or the coverage gap isn't worth the maintainer attention to the project — I'd rather know now than after the workflow PR is open. Pushback welcome.
