# GStack 2.0 test evidence

## Candidate checkpoint — 2026-07-17

These results describe the working tree at the documentation checkpoint. They
are deliberately narrower than the P0 release matrix. Commands that need a
provider account, signed physical app, native OS, or live host are not marked
pass from deterministic, offline, or filesystem-only evidence.

| Command / probe | Observed result | What it proves / does not prove |
|---|---|---|
| Earlier focused macOS `bun test test/gstack2-*.test.ts` candidate run | **Exit 0: 136 pass / 0 fail**, 1,128 assertions across 15 files. Log: `/tmp/gstack2-test-command-candidate-final2.log`. | Historical focused checkpoint retained rather than overwritten. |
| Current macOS `bun run test:gstack2`, commit `a8a5fa1a` | **Exit 0: 150 pass / 0 fail**, 1,189 assertions across 16 files. | Current generated freshness, routing, runtime, privacy, installer, upgrade, parity, and adversarial-harness surface is green. Native and broad evidence are recorded separately. |
| `bun test --timeout 30000 test/gstack2-skills.test.ts test/gstack2-skills-routing.test.ts` after regeneration | **Exit 0: 3 pass / 0 fail**, 81 assertions. | The pinned corpus/parity test and both 25-scenario structured-routing tests are green. This remains structural/fixture evidence, not specialist live execution. |
| `bun run scripts/gstack2/run-parity.ts`, 2026-07-17 rerun | **Exit 0: 4,681 checks passed**; 55 modules, 16 sections, 25 scenarios, 16 regressions, 78 assets. | Current source/render/provenance/contract/asset/fixture parity is green. It is deterministic parity, not live-host behavior. |
| Earlier regenerated structural parity checkpoint | **Exit 0: 2,403 checks passed** with the then-current 55/16/25/16/45 inventory. | Historical candidate checkpoint before later thin-prelude and asset coverage; superseded by the current 4,681-check rerun. |
| Earlier combined runtime/parity run before regeneration | **Exit 1: 20 pass / 1 fail**, 161 assertions. All 18 runtime tests and both routing tests passed; parity hit the default 5s timeout. A separate long-timeout attempt reported 29 stale-generation checks. | Preserved as history: generator inputs had changed. The post-regeneration rows above supersede the parity failure, not the runtime results. |
| `bun run scripts/gstack2/semantic-parity.ts` and `bun test test/gstack2-semantic-parity.test.ts` | **Deterministic corpus green: 295 checks**, 14 suites, 15 executions, all 15 dimensions, 16 carved sections, and nine authority-policy unit cases, including unsupported numeric claims. | Exact source-body and semantic-signature evidence is the primary reproducible oracle. The policy units consume hand-authored semantic operation envelopes; they are deterministic policy evidence, not behavioral-adversarial proof. |
| Retained Claude Haiku live semantic transcripts | **Three retained samples, all classified `REGRESSION`.** Two samples used now-obsolete visible-wrapper prompts. The current office-hours sample also penalizes independently sampled omissions even though those details remain byte-preserved in the candidate source. | Live-model sampling is supplemental and currently not green. These results must not be retried until favorable, cherry-picked, or used to overrule deterministic source loss. See [SEMANTIC-PARITY.md](./SEMANTIC-PARITY.md). |
| Installed-host adversarial v1 | **FAILED.** The immutable v1 slash-invocation artifact is retained. | Unfavorable activation/classifier evidence; not a behavioral pass. See [eval overview](../../evals/host-adversarial/README.md). |
| Installed-host adversarial v2 | **FAILED.** QA passed, while debug, review, and ship were false negatives from the v2 read-only-Git warning classifier. | All four dispatchers activated, but the top-level run failed and must stay failed. Immutable artifact: [`2026-07-17T04-09-01-809Z-3d23a270.json`](../../evals/host-adversarial/runs/2026-07-17T04-09-01-809Z-3d23a270.json), SHA-256 `7ab15ea575cb9a634b7d00212dd9d74902b1188281ae6a503a32ccf382facbf5`. |
| Installed-host adversarial v3 offline harness | **18 pass / 0 fail**, 111 assertions. | The classifier fix and offline harness are covered. This deterministic result does not override the failed paid live run. |
| Installed-host adversarial v3 paid live run | **FAILED 3/4.** Debug, QA, and ship passed; review failed compound inspection. This was the one-shot run, with zero retries. | Unfavorable evidence is immutable and must not be retried or relabeled. Artifact: [`2026-07-17T19-48-45Z-v3-live-gpt-5-4.json`](../../evals/host-adversarial/runs/2026-07-17T19-48-45Z-v3-live-gpt-5-4.json), SHA-256 `fcffdf2b0ee7bb9ac1351e246546af2cd352779bda7b1f8dc4a08f51fc66ef2f`. |
| Six-skill catalog measurement after regeneration | Six names/descriptions total 982 characters, about 246 four-character token-equivalents; baseline correctly parsed catalog was about 1,100. | 77.6% reduction, above the 75% gate. Re-measure if frontmatter changes. The buggy 4,214 baseline estimate is not used. |
| `bun test ios-qa/daemon/test` | **95 pass / 0 fail**, 229 assertions. | Covers daemon regressions including malformed device JSON, hardware-UDID/CoreDevice selection, bounded proxy timeout, and expected-bundle mutation header. It is not a signed-app live pass. |
| Focused DebugBridge/template build tests | **33 pass / 0 fail** in the candidate run, including Swift debug compilation/XCTest and Release symbol absence. | Static/build evidence for debug-only bridge wiring; still not an installed physical-app journey. |
| Physical-iOS E2E preflight | **9 pass / 0 fail / 1 deploy check skipped**, 29 assertions. | The earlier connected-device/setup and unsigned Release checks pass. The deploy skip leaves the signed-device P0 gate open. |
| Direct physical-device smoke | **Incomplete, not a pass:** one target returned `signing_unavailable`; the legacy iPhone10,6 target returned `device_not_wired` / CoreDevice error 1011; the subsequently authorized CoreDevice-compatible phone passed pairing, signing, build, install, launch, and tunnel setup but `POST /session/acquire` closed its socket before the five-check loop completed. | The harness process was stopped at the user's request. At harness stop, the signed fixture was left installed with data intact and no device session remained attached. These are retained operator observations; no pass artifact was written. Further iPhone testing is waived and unauthorized for this checkpoint. |
| Context.dev contract (`gstack2-runtime-context.test.ts`) | **22 pass / 0 fail**, 139 assertions. | Persists explicit host/local-browser/none choices without consent, rejects private/credential URLs and request material plus private DNS, proves zero lookup/fetch before mode+consent, validates documented endpoint paths and exact failure taxonomy, and makes search typed unsupported without network. |
| `gstack context smoke --url https://www.context.dev --json` | **PASS:** the official `/web/scrape/markdown` endpoint returned `ok: true` and credit metadata. | The verified key entered through protected stdin/environment worked. The temporary secrets file was mode `0600`, the isolated home was removed, and the safe output did not contain the key. Committed redacted artifact: [`evals/context-dev/live-smoke-2026-07-17.json`](../../evals/context-dev/live-smoke-2026-07-17.json). |
| Standard installer matrix | **PASS: 470/470 checks**, 16 install cases, two removal cases, `skills` CLI 1.5.19. | Project/global installs pass for six hosts, selected-skill and opt-in compatibility-alias cases, copies, and hashes. This remains installer/filesystem evidence. Committed artifact: [`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json). |
| Standard Agent Skills install + actual runtime-absent Codex invocation | **PASS.** Root `--list` returned exactly six. The selected source was `time-attack/gstack/skills --skill qa`; despite `skills` 1.5.19's pre-filter display counting hidden aliases, exactly one skill (`qa`) installed byte-identically. Codex exited 0 with `gstack` absent, reported `NEEDS_SETUP` and one approval prompt, changed no files, and created no runtime/browser/external-service activity. | Closes the actual-host runtime-absent judgment gate for Codex without overstating six-host UI coverage. Artifact: [`standard-codex-runtime-absent-2026-07-17.json`](../../evals/installation/standard-codex-runtime-absent-2026-07-17.json). |
| `bun test test/gstack2-runtime-install.test.ts` | **Exit 0: 25 pass / 0 fail**, 341 assertions. | Managed allowlist, hashes, spaces, source/internal-link rejection, production-only frozen dependencies, deterministic exact Sharp/ngrok platform closure, native-load rollback smoke, rollback/recovery, stable launchers, wrapper neutrality, and state-preserving uninstall pass. |
| Deterministic clean macOS arm64 managed runtime bundle audit | **110 components, 1,829 files, 450,044,315 bytes, 50 capability launchers.** | This is a platform-specific bundle measurement, not a universal byte count; platform-native package payloads differ. Setup includes the Sharp/ngrok closure and excludes the development-only Claude Agent SDK. The Hugging Face sidecar is outside the bundle and its package is development-only, so production setup installs neither its inference runtime nor model weights; the L4 capability reports unavailable. The standard skill installer remains Markdown-only. Committed artifact: [`evals/runtime-bundle/darwin-arm64.json`](../../evals/runtime-bundle/darwin-arm64.json); reproduce with `bun run scripts/gstack2/audit-runtime-bundle.ts --output evals/runtime-bundle/darwin-arm64.json`. |
| Earlier declared Linux Dev Container plus `bun run test:gstack2` inside it | **Exit 0: 136 pass / 0 fail, 1,127 assertions across 15 files.** Log: `/tmp/gstack2-devcontainer-gate-candidate-final4.log`. | Historical container checkpoint retained rather than overwritten; the current 150-test container result is recorded in the native-CI row below. |
| `scripts/gstack2/runtime-install-smoke.sh` in the clean Linux arm64 container | **Pass:** production-only frozen dependencies installed with the development Agent SDK and Hugging Face/ONNX runtime absent; the managed Anthropic SDK, Sharp, and ngrok imports passed; prebuilt capabilities rebuilt; setup/doctor/version/design/PDF passed; a local-browser journey and Sharp full-page screenshot passed; uninstall preserved state. | Proves a source copy with spaces can build and complete the managed runtime lifecycle without Git history, an executable local-model stack, or Darwin-only iOS artifacts. It is not native Windows evidence. |
| Runtime lifecycle and external-effect matrix | **Pass:** real filesystem/subprocess tests cover clean install/uninstall, paths with spaces, source symlinks and internal-link rejection, macOS read-only reporting, interrupted-pointer rollback, crash-journal repair, last-known-good launcher recovery, and an actual local Git push that executes at most once across resume. | Closes the named local filesystem/recovery/idempotency gates. Aggregate cancellation evidence is recorded separately below. |
| `bun test design/test` | **101 pass / 0 fail**, 381 assertions. | The retained design suite is green and is also included in the later uninterrupted broad pass. |
| `bun test make-pdf/test` plus combined-fixture render | **189 pass / 0 fail, 398 assertions;** four PDF pages rendered to PNG and visually inspected with no detected layout defect. | Retained strict PDF tests and a live internal render are green on this macOS host. Cross-platform visual equivalence remains a separate platform claim. |
| Diagram suites | **51 pass / 0 fail / 1 skip**, 120 assertions; the opt-in paid lane recorded two skips. | Offline Mermaid/SVG/PNG/Excalidraw coverage is green. Skipped paid-provider cases are not live evidence. |
| Isolated local-browser journey plus stop regression | Navigation, snapshot, screenshot, and status passed; stop returned success and left no observed process leak. `browse/test/stop-ack-before-shutdown.test.ts` is **2 pass / 0 fail**. | Provides one real local Chromium journey and a focused regression for acknowledging stop/restart before delayed shutdown. The complete browser suite is included in the later broad pass. |
| Live local-browser SIGINT aggregate | **PASS.** An isolated local-file journey completed `goto`, `status`, and `snapshot`; SIGINT produced an in-memory authenticated `503`, reduced five owned processes to zero, and left no listener, root credential state, credential-shaped file, or device session. The unrelated browser daemon survived. Focused regression: 34 pass / 0 fail, 62 assertions. | Closes the requested aggregate process/listener/state/credential cleanup gate without claiming device interaction. Artifact: [`evals/browser/cancellation-2026-07-17.json`](../../evals/browser/cancellation-2026-07-17.json). |
| Native CI run `29615621805`, commit `a8a5fa1a` | **PASS:** installer 470/470; macOS 150/0/1,189; Ubuntu 150/0/1,189; native Windows 150/0/1,145; Dev Container 150/0/1,188. All native installer-discovery steps found exactly six skills. | Complete native matrix evidence. Sanitized artifact: [`evals/ci/native-2026-07-17.json`](../../evals/ci/native-2026-07-17.json). Runs `29608904265`, `29611504979`, `29611757175`, `29612056517` (cancelled), `29613668419`, `29614448170`, and `29614899434` remain superseded diagnostics. |
| Earlier `bun test` strict singleton checkpoint | **Exit 0: 6,240 pass / 226 expected skips / 0 fail**, 25,449 assertions across 383 files. Log: `/tmp/gstack2-full-singleton-final-committed.log`. | Historical broad checkpoint retained rather than overwritten. |
| Current `bun test` through the strict singleton runner | **Exit 0: 6,255 pass / 226 expected skips / 0 fail**, 25,509 assertions; 384/384 shard headers and terminal single-file summaries. | One uninterrupted current-head macOS broad pass. Expected skips are provider, credential, Poppler-environment, paid, or model-sidecar gates declared by their tests; external/live evidence remains separate. |
| Earlier local `bun run test:windows` singleton checkpoint | **Exit 0: 2,815 pass / 57 expected skips / 0 fail**, 8,586 assertions across 213 files. Log: `/tmp/gstack2-windows-singleton-final-committed.log`. | Historical curated-lane checkpoint retained rather than overwritten. |
| Current local `bun run test:windows` through singleton shards | **Exit 0: 2,829 pass / 57 expected skips / 0 fail**, 8,648 assertions; all 214 selected files completed. | The current curated Windows-safe subset is locally green. Native Windows is independently green in run `29615621805`. |
| Forbidden production-scope audit | Production dependencies and the 110-component managed bundle contain no cloud-browser provider, Hugging Face/ONNX inference runtime, model weights, or alternative physical-iOS backend. Transformers remains development-only for retained tests; CoreDevice/`devicectl` is the sole physical-iOS path. | Deterministic dependency/bundle/backend evidence. It does not substitute for native-platform, signed-device, or live-provider behavior. |

### Required final command ledger

Append exact exit codes, aggregate counts, environment/version metadata, and
artifact/log locations for all of the following before changing status to
`DONE`:

```text
bun run gen:gstack2
bun run test:gstack2
bun run scripts/gstack2/run-parity.ts
bun run scripts/gstack2/semantic-parity.ts
bun run build
bun test
bun run test:windows
bun test design/test
bun test ios-qa/daemon/test
host UI/process launch for six installer-verified hosts
passing live installed-host adversarial gate (live v3 one-shot is retained failed evidence)
runtime-absent judgment through an actual host invocation (Codex passed; broader host UI coverage remains)
macOS + Linux + native Windows + Dev Container
local browser live journey + cancellation/leak cleanup (passed)
PDF strict + diagram suites
Context.dev verified-key public-page smoke
physical signed-iPhone five-check loop + Release symbol check (waived; partial evidence is not a pass)
upgrade/fail/recover/rollback/uninstall end-to-end
```

The focused results above should remain in the ledger even after a later pass;
record the newer SHA/time beside the newer result rather than overwriting the
history.

## Baseline evidence — 2026-07-16

Scope: detached base worktree `/tmp/gstack2-baseline.e2qk7F`, commit
`bb57306d98c97011b0919c6132705a15b1579781`, captured 2026-07-16. These are
baseline observations only; no result below was produced by the GStack 2.0
implementation.

## Command ledger

| Command | Evidence | Observed result |
|---|---|---|
| `bun install` | `/tmp/gstack2-baseline-logs/bun-install.log` | Completed; Bun 1.3.14 reported 297 packages installed. |
| `bun run gen:skill-docs --host all` | `/tmp/gstack2-baseline-logs/gen-all.log` | Reached the final GBrain token table and `llms.txt` summary (`55 skills, 76 browse commands`); no error marker is present. |
| `bun run skill:check` | `/tmp/gstack2-baseline-logs/skill-check.log` | **Exit 1**: `claude/SKILL.md — generated file missing`. The same run reported 54/54 outputs for each of the 10 hosts and fresh generated files, but the missing primary output keeps the command red. |
| `bun run build` | `/tmp/gstack2-baseline-logs/build.log` | Reached the final Node-compatible server bundle (`server-node.mjs`, 0.83 MB); no error marker is present. |
| `bun test` | `/tmp/gstack2-baseline-logs/bun-test.log` | **Not green and incompletely terminated**: 4,292 `(pass)` markers, 488 `(skip)` markers, seven explicit `(fail)` markers, and one unhandled between-tests error. The capture ends after `browse/test/findport.test.ts` without Bun's aggregate summary or exit record. |
| `bun run test:windows` | `/tmp/gstack2-baseline-logs/test-windows.log` | **Exit 1** on shard 5/20. The runner selected 189 Windows-safe files and excluded 155. Completed shard summaries contain 593 passes, 14 skips, and one failed test before the run stopped. |
| `bun test design/test` | `/tmp/gstack2-baseline-logs/design-test.log` | **Not green**: 64 pass markers and one explicit failure. The log ends on daemon shutdown without an aggregate summary or exit record. |
| `bun test ios-qa/daemon/test` | `/tmp/gstack2-baseline-logs/ios-daemon-test.log` | **Pass**: 91 pass, 0 fail, 217 assertions across 10 files. |

`/tmp/gstack2-baseline-logs/git-status-after.txt` is empty, recording no status
entries after the runner. The logs are external audit artifacts and are not
vendored into the repository.

## Pre-existing `bun test` failures

The broad-suite log records these seven explicit failures:

1. `gstack-decision-search --recent / --scope / datamark > --scope filters by scope`
   expected output containing `branch-call` and received an empty string.
2. `gstack-gbrain-detect > emits valid JSON even when nothing is configured`
   expected status 0 and received 127.
3. `gstack-gbrain-detect > reports gstack_brain_git: true when GSTACK_HOME has a .git dir`
   attempted to parse empty output and raised `Unexpected EOF`.
4. `gstack-gbrain-detect > reports gbrain_config + engine when ~/.gbrain/config.json exists`
   attempted to parse empty output and raised `Unexpected EOF`.
5. `gstack-gbrain-detect > malformed config returns null engine, does not crash`
   expected status 0 and received 127.
6. `gstack-gbrain-detect > detects a mocked gbrain binary on PATH and reports its version`
   expected status 0 and received 127.
7. `resolve-user-slug fallback chain > persists resolution to user_slug_at_<hash> on first call`
   expected a hashed key and observed `user_slug_at_local: persisttest`.

Separately, `test/gbrain-refresh-install-render.test.ts` raised an unhandled
between-tests error: `Could not locate gbrain-refresh ok) branch`. Because the
log has no terminal Bun summary, the marker counts are evidence of what ran,
not a claim that all files were reached or that the command had only those
failures.

## Other pre-existing failures

- `skill:check`: the primary `claude/SKILL.md` generated file was absent; the
  script explicitly exited with code 1.
- Windows-safe shard 5:
  `Source-level guard: terminal-agent > lazy spawn: claude PTY is spawned in message handler, not on upgrade`
  still looked for `spawnClaude(`, while the source excerpt used
  `maybeSpawnPty(...)`. The shard reported 82 pass / 1 skip / 1 fail and the
  remaining 15 shards did not run.
- Design target:
  `generateVariant Retry-After handling > HTTP-date: honors a future date with no extra leading exponential`
  expected a delay of at least 2,500 ms and observed 2,246 ms.

## What this evidence does not establish

- It does not establish a green baseline.
- It does not establish that GStack 2.0 preserves behavior; replacement
  contract tests have not yet been implemented.
- It does not turn incomplete logs into passes.
- It does not attribute these failures to later changes; every failure above
  was captured from the stated base SHA before GStack 2.0 work.
