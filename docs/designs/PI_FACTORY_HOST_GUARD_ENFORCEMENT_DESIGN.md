# Pi Factory Host Guard Enforcement Design

Status: proposed contract for the host-level integration that would allow a
factory `qa-fix` agent to actually be safe. This is a design/contract artifact.
It does not expose `/factory-qa-fix`, does not modify any host runtime, and does
not advertise the `safe-command-guard` capability anywhere new. `/factory-qa-fix`
remains hidden until every section of this design is implemented and validated
on a real host.

## Companion docs

- `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md` (classifier + runtime
  wrapper contract; includes Appendix A live execution-path inventory and
  Appendix B audit seam)
- `docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md` §5.3 Alpha 2
  (defines the exit rule this design is trying to satisfy)
- `docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md` "Next Chunk 3 — QA-fix
  host-enforcement solution"
- `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md`
- `docs/designs/PI_SOFTWARE_FACTORY_BETA_OPERATIONS_SECURITY_CONTRACT.md`

## 1. Goal

Specify the host-level boundary that must exist before a `qa-fix` agent's
Bash / Read / Write / Edit / Glob / Grep / WebSearch / browser activity can be
considered safe under `commandSafetyProfile: 'non-destructive-write'`.

The pure classifier (`lib/factory-command-guard.ts`) and runtime wrapper
(`lib/factory-guarded-runtime.ts`) are already implemented. The blocker is
structural: dispatched skill tool calls execute inside the host's tool layer,
not inside a factory-owned runtime. This document defines the host-side contract
that would close that gap.

This is a contract, not an implementation. No host runtime in the repository
satisfies it today. `/factory-qa-fix` MUST stay hidden until it does.

## 2. Non-goals

- Do not expose `/factory-qa-fix`. Exposure is gated by the validation in §11.
- Do not modify host code in this repository. The contract is described so a
  host vendor (Pi, an internal Claude runtime, or a future sandbox) can
  implement it externally.
- Do not implement OS- or container-level sandboxing in this slice. This guard
  is a fail-closed policy layer in the host tool dispatcher, not a kernel
  sandbox.
- Do not broaden the autonomy envelope from
  `PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md` §2. The same protected
  files (`CLAUDE.md`, `package-lock.json`, package manifests) remain off-limits
  to a guarded `qa-fix` run too.
- Do not extend the guard to `release-action`. Releases remain explicitly out
  of scope; the pure classifier already denies `release-action` profile.
- Do not depend on prompt prose or model compliance as a safety layer.

## 3. Background: why prose safety contracts are not enough

`Appendix A` of `PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md` enumerates every
mutation path a `qa-fix` agent could use today and classifies which the
repository can enforce. The result:

| Path | Enforceable from repo? |
|---|---|
| Factory runtime command exec wrapper (`lib/factory-guarded-runtime.ts`) | Guardable but dormant: nothing calls it |
| Pi extension review/QA dispatch runtime | Guarded for what the adapter writes; not for what the dispatched skill writes |
| Generated `qa` / `qa-only` skill instructions | Not enforceable — prose contract only |
| `gstack_browser` custom tool entrypoint | Argument allowlist only; browse-internal writes uncovered |
| `ask_user_question` custom tool | Out of scope (no execution surface) |
| Browse binary subprocess tree | Not enforceable — Playwright/Chromium can write inside workspace |
| Host Bash / Edit / Write / Read / Glob / Grep from dispatched skill | Not enforceable — the host owns the tool layer |

The repository can only safely expose `/factory-qa-fix` once the dispatched
skill's tool calls flow through a guard the repository (or a host that has
adopted the contract here) controls.

## 4. Architecture overview

```text
Pi extension / factory adapter
  └─ planFactoryRun(workflow=qa-fix, policy.commandSafetyProfile=non-destructive-write)
       └─ requests a GuardedAgentSession from the host via the
          HostGuardEnforcement contract (§5)
            └─ Host returns a session handle whose tool layer is reimplemented:
                  ├─ Bash    → FactoryGuardedCommandRuntime.executeCommand
                  ├─ Edit    → FactoryGuardedFileWrite.applyEdit
                  ├─ Write   → FactoryGuardedFileWrite.applyWrite
                  ├─ Read    → FactoryGuardedFileRead.read
                  ├─ Glob    → FactoryGuardedFileRead.glob
                  ├─ Grep    → FactoryGuardedFileRead.grep
                  ├─ WebSearch / WebFetch → denied or out-of-scope per policy
                  └─ gstack_browser → guarded entrypoint + workspace-scoped
                                       output dir (§8)
            └─ Session ID is bound to a single factory runId + phaseId.
       └─ Adapter advertises `safe-command-guard` ONLY because the host
          returned a session whose attestation matches §9.
```

The factory side already exists. The only new component is the
**Host Guard Enforcement** interface: a small, host-side contract that lets a
factory adapter say "give me an agent session whose tool layer is implemented
by these guard callbacks." Without that, no guarantee is possible.

## 5. Required host APIs and capabilities

A host that intends to satisfy this contract MUST expose, in some form, the
following surface. The names below are illustrative; the contract is the shape,
not the spelling.

### 5.1 `host.createGuardedAgentSession(spec)` — required

```ts
interface HostGuardedAgentSessionSpec {
  readonly factoryRunId: string;
  readonly phaseId: string;
  readonly workspaceRoot: string;          // absolute, canonicalized
  readonly profile: 'non-destructive-write';
  readonly toolHooks: {
    readonly executeCommand: ExecuteCommandHook;
    readonly applyEdit: ApplyEditHook;
    readonly applyWrite: ApplyWriteHook;
    readonly read: ReadHook;
    readonly glob: GlobHook;
    readonly grep: GrepHook;
    readonly onUnsupportedTool: UnsupportedToolHook;
  };
  readonly browserPolicy: {
    readonly outputDirRelativeToRun: string;   // see §8
    readonly allowlistedSubcommands: readonly string[];
  };
  readonly capabilityAttestation: HostGuardAttestationRequirements;
}

interface HostGuardedAgentSessionHandle {
  readonly sessionId: string;
  readonly attestation: HostGuardAttestation;  // §9
  readonly dispatch: (message: string) => Promise<void>;
  readonly close: () => Promise<void>;
}
```

The host MUST guarantee, for the lifetime of `sessionId`:

1. Every Bash invocation from the agent is routed through `executeCommand`.
   The host MUST NOT provide a parallel exec surface the agent can reach.
2. Every Edit/Write goes through `applyEdit`/`applyWrite`.
3. Every Read/Glob/Grep goes through `read`/`glob`/`grep`.
4. Any tool not in the hook table is treated as `onUnsupportedTool`, which
   MUST default to deny.
5. The session has no implicit network capability beyond what `executeCommand`
   denies via the classifier.
6. The session cannot escalate to a non-guarded agent session.

If the host cannot make these guarantees, it MUST NOT return a handle. The
factory adapter MUST treat a missing handle as "guard not active" and refuse
to advertise `safe-command-guard`.

### 5.2 `host.spawnGuardedSubprocess(spec)` — required for browser

Same idea, applied to the browser sidecar (§8). The host MUST provide a
subprocess primitive that:

- accepts a fixed executable path (the factory's known browse binary);
- accepts an argument vector that has already passed
  `normalizePiBrowserCommandRequest` plus the per-run output dir injection;
- routes the subprocess's filesystem writes through the same workspace-root
  enforcement that `applyWrite` uses, OR is run inside an OS sandbox that
  pins writes to the per-run output dir;
- denies network egress to anything outside the browse binary's documented
  needs (Playwright/Chromium download endpoints, target URLs the agent
  passes in arguments).

### 5.3 `host.signalDenial(sessionId, denial)` — required

Hook for the factory to push a sanitized denial record back to the host's
denial telemetry channel, in addition to writing a factory artifact. Lets host
operators surface guard denials in their own UI without parsing factory
artifact stores.

### 5.4 Capabilities required of the host adapter, not the agent

When `qa-fix` requests these capabilities, they must mean the **guarded**
versions:

| Required capability | What "guarded" means here |
|---|---|
| `filesystem` | Host routes Read/Write/Edit/Glob/Grep through the hooks |
| `git` | All `git` invocations are Bash invocations under the guard |
| `test-runner` | All test commands are Bash invocations under the guard |
| `browser` | Browse subprocess uses §5.2 + §8 |
| `agent-session` | The agent session is the one returned by §5.1 |
| `safe-command-guard` | All of the above are simultaneously true (§9) |

`artifact-store` and `questions` remain factory-side and are unaffected.

## 6. Per-run guard session lifecycle

```text
qa-fix start
  ├─ adapter computes plan, profile, workspaceRoot
  ├─ adapter calls host.createGuardedAgentSession(spec) with factoryRunId+phaseId
  ├─ if no handle → mark phase failed, surface "guard not available"
  ├─ if handle returned → record attestation digest in artifact store
  ├─ dispatch the qa-fix skill prompt via handle.dispatch(message)
  │     (host MUST guarantee this message is queued only inside the bound
  │      session; it cannot leak into a sibling unguarded session)
  ├─ guard observes every tool call via the hooks (§7, §8)
  │     · allowed calls execute and return their result to the agent
  │     · denied calls return a structured error to the agent (so the model
  │       sees the denial reason without secret command text) and also fire
  │       onCommandDecision for audit emission
  ├─ on phase completion (success, failure, or denial-driven abort):
  │     · adapter writes a denial-summary artifact if any denials occurred
  │     · adapter calls handle.close()
  │     · the session ID is invalidated; further tool calls bearing it MUST
  │       be rejected by the host
  └─ subsequent phases re-acquire a fresh session (no reuse across phases)
```

Sessions are single-phase, single-run. The host MUST NOT recycle a session
across runs or across phases; a new session per phase makes the
`(runId, phaseId)` tuple authoritative for every audit row.

## 7. Command and file-write policy

### 7.1 Command (Bash) policy

Every Bash call routes through `FactoryGuardedCommandRuntime.executeCommand`
with the existing classifier. Deny rules from
`lib/factory-command-guard.ts` already cover: destructive `rm`/`find`,
`git reset --hard`, `git clean`, `git push`, `git tag`, force pushes, bulk
`git add`, package publish/deploy, secret/env dumping, shell substitution,
chaining, pipes, redirection, backslash escapes, path traversal, Windows
absolute paths, attached-short-option ambiguity, `rg --pre`, `bun test`
snapshot mutation, `tsc` output flags. The host adds nothing to the policy;
it only routes calls through it.

### 7.2 File-write policy (Edit / Write)

The factory needs a thin pure helper (proposed location:
`lib/factory-file-write-guard.ts`, new module — not implemented here; see
§10 migration). The helper takes:

```ts
interface FactoryFileWriteRequest {
  readonly absolutePath: string;       // host already resolved
  readonly workspaceRoot: string;
  readonly profile: 'non-destructive-write';
  readonly context: { runId: string; phaseId: string };
  readonly intent: 'create' | 'overwrite' | 'edit-existing';
}
```

and returns a `FactoryCommandGuardDecision`-shaped decision. The classifier
mirrors the command-guard logic with these additional deny rules specific to
writes:

1. **Outside workspace**: any path whose canonical form is not under
   `workspaceRoot` is `outside-workspace-path`.
2. **Protected files**: deny writes to `CLAUDE.md`, `package-lock.json`,
   `package.json`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`,
   `.npmrc`, `.git/**`, `.gstack/**` outside `.gstack/factory/<runId>/...`,
   `.pi/**`, `.agents/**`, `.claude/**`, `.env*`, anything matching the
   `SECRET_PATH_RE` from the command guard.
3. **Hidden bootstrap files**: deny writes to dotfiles at the workspace root
   (`.gitignore`, `.gitattributes`, `.editorconfig`, etc.) unless an explicit
   allowlist override is approved by a future workflow.
4. **Generated files**: deny writes to `**/dist/**`, `**/build/**`,
   `**/node_modules/**`, `**/.next/**`, `**/.turbo/**` — these are tool output
   and modifying them masks regressions.
5. **Submodule boundaries**: deny writes whose path crosses a submodule
   boundary (host MUST resolve submodules before calling).
6. **Symlink resolution**: the host MUST canonicalize via real-path before
   calling. The classifier does not see the input string; it sees the
   canonical absolute path. Symlinked escapes that the host fails to resolve
   are a host conformance bug, not a classifier bug.
7. **Path traversal**: same `../` rules as the command guard.
8. **Backslash / Windows path**: fail closed (mirrors command guard).
9. **Default-deny extension**: writes outside the explicit allowlist for
   `qa-fix` (source/test/docs under workspace) require an explicit reason in
   the request. Without one, deny.

`applyEdit` additionally requires:

- the old content to be a verbatim substring of the current file content (the
  host MUST verify before applying — no fuzzy match);
- the file must exist (cannot be used to create new files; that's `applyWrite`
  with `intent: 'create'`);
- the host MUST hold an exclusive lock between read and write so a concurrent
  agent cannot wedge a TOCTOU race.

`applyWrite` with `intent: 'overwrite'` is treated as an edit for policy
purposes: must satisfy the same protected-path rules, but also requires the
target to already exist.

### 7.3 Read policy (Read / Glob / Grep)

Reads are mostly allowed but still classified to:

- deny reads of secret paths (`SECRET_PATH_RE`);
- deny reads of `~/.ssh`, `~/.config/env-master`, `**/credentials*`,
  `**/.env*`, `**/secrets*`, `**/id_rsa*`, `**/id_ed25519*`;
- deny reads that escape the workspace root via realpath, with one exception:
  reads of `/etc/os-release` and similar host metadata MAY be allow-listed,
  but only via narrow rules approved out-of-band;
- emit a sanitized observation for every denied read (helps debug stuck
  agents who keep retrying a path they cannot reach);
- allow reads inside `workspaceRoot` that don't trip a secret rule.

Reads do not require workspace-modify locks, but `grep`/`glob` MUST be bounded
(host enforces a node-count cap) so a maliciously crafted glob cannot DoS the
classifier.

### 7.4 WebSearch / WebFetch / network policy

For `qa-fix`, the default is **deny**. Web access is not required for QA fix
work and introduces an exfiltration channel. If a future workflow needs
narrow web access, it goes through a separate profile.

The host MUST NOT silently degrade `WebSearch` to a no-op — denial must be
observable to both the agent (so it stops retrying) and the audit channel.

### 7.5 Unsupported tools

Anything not enumerated above (NotebookEdit, BashOutput, KillShell, Skill
invocation, agent spawning, MCP server tool calls, etc.) is unsupported and
fail-closed. The host's `onUnsupportedTool` hook MUST default to deny with an
audit record. Adding a new tool to a guarded session requires extending this
design, not the host implementation.

## 8. Browser sidecar output directory constraint

The browse binary is a real subprocess with real Playwright access to a real
Chromium. The argument allowlist alone is insufficient because the binary can
write screenshots, snapshots, and `.gstack/browse.json` anywhere it likes.

### 8.1 Per-run output dir

Every guarded `qa-fix` run gets a single output directory:

```text
.gstack/factory/<runId>/browse-output/
```

The factory adapter constructs this path, ensures it exists with mode 0700,
and passes it to the browse subprocess via:

1. an explicit `--output-dir <abs path>` argument (browse binary must respect
   this flag; if it doesn't, the binary is not ready for guarded use); and
2. an environment overlay that forces:
   - `GSTACK_BROWSE_OUTPUT_DIR=<abs path>`
   - `GSTACK_BROWSE_CWD=<workspaceRoot>` (so relative paths resolve sanely)
   - `HOME=<abs path>/home-shim` (a writable shim that contains nothing real
     so even buggy Playwright cache writes land here)
   - PATH minimized to the bare set the browse binary needs (matches the
     existing `minimalGstackEnv()` pattern).

### 8.2 Browse subcommand allowlist

Today the Pi adapter accepts whatever `normalizePiBrowserCommandRequest`
parses. Under guarded `qa-fix`, the allowlist tightens to read-only browse
subcommands plus the screenshot/snapshot commands that respect
`--output-dir`. Specifically:

- allowed: `goto`, `snapshot`, `screenshot`, `console`, `wait`, `text`,
  `title`, `url`, `dialog` (read-only), `responsive`;
- denied: anything that uploads to a remote service, anything that writes to
  the user's home or `~/.gstack/` outside the per-run dir, anything that
  forks long-running processes, anything that connects to the GStack Browser
  sidebar extension.

The allowlist is enforced **before** spawning the subprocess. The host's
`spawnGuardedSubprocess` MUST refuse to launch a subprocess whose argv head
is not in the allowlist.

### 8.3 OS-level confinement (optional but preferred)

When the host can provide it (Linux user namespaces, macOS `sandbox-exec`,
Windows AppContainer), the browse subprocess SHOULD be run with:

- writable: only `<output-dir>`;
- readable: workspace root, the browse binary, system libs;
- network: outbound only, denylist for cloud metadata endpoints
  (`169.254.169.254`, `metadata.google.internal`, etc.) and known telemetry
  endpoints of common dev tools;
- no execve of new binaries outside the browse binary and bundled Playwright
  helpers.

OS confinement is a defense-in-depth layer. The classifier is still the
primary policy. If the host cannot offer OS confinement, guarded `qa-fix`
MAY still proceed, but the attestation record (§9) MUST mark
`osConfinement: 'absent'` so operators know the trust posture.

## 9. Capability attestation

`safe-command-guard` is the capability that gates `/factory-qa-fix` exposure.
This design extends the existing capability advertisement rule:

```
advertise safe-command-guard iff ALL of the following are true at session
acquisition time:
```

1. `host.createGuardedAgentSession` returned a non-null handle bound to the
   current `(runId, phaseId)`.
2. The returned `attestation` includes:
   - `bashGuarded: true`
   - `editGuarded: true`
   - `writeGuarded: true`
   - `readGuarded: true`
   - `globGuarded: true`
   - `grepGuarded: true`
   - `webGuarded: 'denied'` (for `qa-fix`)
   - `unsupportedToolDefault: 'deny'`
   - `browserGuarded: true` (or `false` if browser capability is not requested)
   - `browseOutputDir: <abs path under .gstack/factory/<runId>>` (when
     `browserGuarded: true`)
   - `osConfinement: 'present' | 'absent'`
   - `attestedAt: <ISO timestamp>`
   - `hostId: <string>` (used by audit consumers to attribute denials)
   - `attestationDigest: <sha256 of the above fields, hex>`
3. The factory adapter verified the digest matches the fields and is fresh
   (within an `attestationFreshnessWindowMs` it controls — default 10s).
4. The factory adapter wrote the attestation to the run's artifact store
   under a stable artifact id (`<phaseId>-attestation`) so /factory-status
   can show "this run was guarded by host X at time T."

If any of these fail, the adapter MUST:

- not call `withSafeCommandGuardCapability(..., true)`;
- emit a `guard-attestation-failed` artifact;
- treat the phase as failed-closed rather than retry.

The existing `FactoryGuardedCommandRuntime.guardActive` already returns the
boolean. This design adds the *attestation record* alongside it so the
audit trail can prove the wrapper was active at execution time and on which
host.

## 10. Migration path

The work to satisfy this design is partitioned so each step lands behind the
existing `/factory-qa-fix`-hidden gate. No step exposes the command.

### Step 1 — factory-side primitives (no host changes)

- Add `lib/factory-file-write-guard.ts` mirroring the command-guard structure.
  Same shape: pure classifier, `FactoryFileWriteRequest` →
  `FactoryFileWriteDecision`. Unit-tested for every deny rule in §7.2.
- Add `lib/factory-host-attestation.ts` (or extend the guarded-runtime module)
  with the attestation digest helper, `verifyHostGuardAttestation`, and the
  sanitized attestation-artifact shape from §9.
- Add a `FactoryGuardedAgentSessionSpec` type and the
  `createGuardedAgentSession` adapter shim that simply returns
  `{ supported: false, reason: 'no-host' }` for every existing host. Each
  host can opt in by overriding the shim.
- Tests: file-write classifier negative tests, attestation digest stability,
  shim defaults.

After Step 1 the factory has the contract surface but no host implements it.
`/factory-qa-fix` remains hidden.

### Step 2 — Pi adapter wiring (still hidden)

- Teach `.pi/extensions/pi-gstack/index.ts` to call the shim. With no host
  support, it gets `supported: false` and the existing behavior is
  unchanged: `safeCommandGuardActive` stays `false`, `/factory-qa-fix`
  remains unregistered.
- Add an internal-only env knob (`FACTORY_FAKE_GUARDED_HOST=1`) that
  installs a test-only fake host returning a valid attestation but routing
  every hook to a deny-everything implementation. This lets integration
  tests prove the adapter would correctly:
  - advertise `safe-command-guard` only when the fake host returns
    attestation;
  - emit attestation artifacts;
  - block `qa-fix` runs on attestation digest mismatch;
  - still keep `/factory-qa-fix` unregistered as a public command (the env
    knob is for tests, never end users).
- Tests: `test/pi-extension.test.ts` adds negative cases asserting
  `safe-command-guard` absent without the fake, present with it; assertion
  that the public command list does not include `factory-qa-fix` even with
  the fake enabled.

### Step 3 — real host integration (per-host, out of repo scope)

- The host vendor implements `createGuardedAgentSession` and
  `spawnGuardedSubprocess` per §5.
- The host produces a static attestation document for its build (which
  `hookGuarded` booleans it can actually honor) and ships it with the
  binary so the factory adapter can verify it.
- Step 3 lands in the host repo, not this one. This repo's role is to
  publish the contract and the verification helpers.

### Step 4 — guarded exposure decision

Only after Steps 1–3 are real, AND the validation in §11 passes against the
real host, may a separate change land that:

- registers `/factory-qa-fix` in the Pi extension behind an explicit opt-in
  flag (`factoryQaFixEnabled` runtime option that defaults to `false`);
- defaults the flag to `false` everywhere; flipping it requires the
  user-facing copy from §11.4 and a passing integration test on the real
  host;
- never auto-exposes the command based purely on attestation presence —
  the operator must affirmatively opt in.

The Step 4 change is small (registration + tests). Most of the surface
area is in Steps 1–3.

### Step 5 — broader rollout

Subsequent hosts adopt the contract independently. The factory does not
need to change again.

## 11. Validation contract

Before any host or any flag can expose `/factory-qa-fix`, ALL of the
following must pass.

### 11.1 Pure unit tests

`test/factory-command-guard.test.ts` (exists) plus:

- `test/factory-file-write-guard.test.ts` (new) covering every §7.2 rule:
  - workspace escape via realpath;
  - protected file enumeration (`CLAUDE.md`, lockfiles, `.git`, `.env*`,
    `.gstack/**` outside the runId tree, `.pi/**`, `.agents/**`, `.claude/**`);
  - hidden bootstrap dotfile denial;
  - generated dir denial (`dist`, `build`, `node_modules`, `.next`, `.turbo`);
  - symlink escape (test feeds the canonical path and asserts deny);
  - backslash / Windows path fail-closed;
  - applyEdit fail-closed when old content doesn't match.
- `test/factory-host-attestation.test.ts` (new) covering:
  - digest stability across field order;
  - digest mismatch detection;
  - missing-field rejection;
  - freshness window enforcement;
  - sanitized attestation artifact shape (no secrets, includes hostId +
    digest + timestamp).

### 11.2 Runtime wrapper integration tests

`test/factory-guarded-runtime.test.ts` (exists) plus:

- a new test asserting `onCommandDecision` fires for every hook type in the
  HostGuardEnforcement contract (Bash, Edit, Write, Read, Glob, Grep,
  unsupported, browser);
- a new test asserting that with `guardActive: true` but a missing
  attestation, the adapter does not advertise `safe-command-guard`.

### 11.3 Pi adapter negative tests

`test/pi-extension.test.ts` (exists) plus:

- `expect(commands.has('factory-qa-fix')).toBe(false)` remains green
  under: default install, `FACTORY_FAKE_GUARDED_HOST=1`, attestation
  mismatch, attestation expired, hook returning `supported: false`.
- adversarial command sweep: a fixture of ~50 commands derived from the
  Appendix A inventory (publish, deploy, secret dump, force push, env
  dump, shell substitution, path traversal, Windows path, attached short
  opt, `rg --pre`, etc.) is fed through the fake host's executeCommand
  hook and every one is denied; the test asserts each command produced an
  audit record with a sanitized digest and never the raw command text;
- adversarial file-write sweep: fixture of ~20 paths
  (`CLAUDE.md`, `package-lock.json`, `../etc/passwd`, `~/.ssh/id_rsa`,
  `node_modules/.bin/foo`, `dist/index.js`, `.git/HEAD`, symlink
  pointing outside workspace, etc.) is fed through `applyWrite` and
  every one is denied with a sanitized record.

### 11.4 User-visible copy tests

When `/factory-qa-fix` is eventually exposed (Step 4), the status copy
emitted by the Pi adapter MUST:

- explicitly say "QA fix: safe local writes were approved for this run.
  Non-destructive checks only; no push, deploy, publish, force reset,
  git clean, or secret/env dumping." (mirrors existing `formatFactoryState`
  copy);
- name the host that attested the guard (`Guarded by: <hostId>`);
- show the attestation digest and timestamp;
- show a per-phase denial count if any denials occurred;
- never include raw denied command text or denied file paths beyond the
  sanitized `commandHead` / path basename.

A `test/factory-qa-fix-copy.test.ts` (new) asserts each line is present
on the rendered status when `qa-fix` runs against the fake host.

### 11.5 End-to-end test against a real host (gating)

This is the gating test. It cannot run in CI without a host that
satisfies §5. It is described here so a future change can land it
alongside Step 4.

- Spin up the real host in a hermetic mode.
- Start a `qa-fix` run against a fixture workspace containing a
  deliberately broken test file.
- Assert:
  - the agent gets a guarded session attestation;
  - the agent successfully reads the failing test;
  - the agent successfully edits the source file to fix the test
    (one allowed `applyEdit` recorded);
  - the agent's attempt to run `git push` is denied with a sanitized
    audit row;
  - the agent's attempt to read `~/.ssh/id_rsa` is denied;
  - the agent's attempt to write `CLAUDE.md` is denied;
  - the browse subprocess writes only inside
    `.gstack/factory/<runId>/browse-output/`;
  - the run completes with a `qa-fix-fixed` artifact;
  - the run's artifact store contains a `guard-attestation` artifact
    with all §9 fields populated;
  - `/factory-status` renders all §11.4 copy lines.

### 11.6 Performance and stability gate

- p99 hook latency under 5ms for `executeCommand`,
  `applyEdit`/`applyWrite`, `read` (the classifier is pure; the budget is
  for the hook plumbing on the host side);
- a 1k-call adversarial sweep does not leak memory above a 50MB ceiling;
- guard never panics — every parser/classifier exception is converted to
  a `block` decision per the existing `evaluateFailClosed` path.

## 12. Explicit blockers

`/factory-qa-fix` MUST remain hidden until ALL of the following are true.
This list is canonical; it supersedes any other "remaining work" notes that
might suggest a narrower bar.

1. `lib/factory-file-write-guard.ts` exists with unit tests for every §7.2
   rule. **Not done.**
2. `lib/factory-host-attestation.ts` (or the equivalent attestation helpers
   in the guarded-runtime module) exists with digest + verification tests.
   **Not done.**
3. The factory adapter has a `createGuardedAgentSession` shim that defaults
   to "no host support" and is wired through to capability attestation.
   **Not done.**
4. At least one host implements §5 and §5.2 in a way the adapter can
   verify, including OS-level confinement of the browse subprocess where
   the host can offer it. **Not done; outside repo scope.**
5. The browse binary respects `--output-dir` / `GSTACK_BROWSE_OUTPUT_DIR`
   and refuses to write outside it. This is a browse-binary contract gap
   that must close before §8 can be considered live. **Status: not
   verified.** A negative test asserting browse refuses to honor a write
   outside the dir must land before §8 is treated as enforced.
6. §11.1–§11.4 pass. **Not done.**
7. §11.5 passes against the real host. **Not done; requires §4 host.**
8. §11.6 passes under load. **Not done.**
9. A user-facing release note exists describing the safety posture, the
   exact deny list, the denial-artifact location, and the opt-out path.
   The release note is part of the Step 4 change. **Not done.**

Until items 1–9 are all true and demonstrated, `/factory-qa-fix` stays
unregistered, `safe-command-guard` stays absent from the Pi adapter's
default capability advertisement, and any documentation that suggests
`/factory-qa-fix` is "almost ready" is wrong.

## 13. Open questions

1. **Multi-tenant hosts.** Future hosted modes will run agents for
   multiple users. The session attestation needs a `workspaceTenantId`
   alongside `workspaceRoot` so guard denials cannot be correlated across
   tenants. Recommendation: add the field in Step 1's attestation type
   even though the local-only host always passes `local`. Out-of-band
   review by the security-auditor agent before Step 4.

2. **Process-exec hooks vs. argv interception.** Some hosts may only be
   able to intercept commands at argv level, not at the `child_process`
   boundary. Argv-level is sufficient for the classifier (it works on
   argv strings) but allows a buggy host to spawn auxiliary processes
   the guard never sees. Recommendation: the attestation field
   `bashGuarded` must distinguish `argv-only` from `process-boundary`,
   and `argv-only` hosts must run with OS confinement.

3. **MCP server tool calls.** A guarded session might still allow MCP
   server tool calls (e.g., Microsoft Docs search) that have no factory
   side. Recommendation: §7.5 says deny by default; an opt-in MCP
   allowlist requires a separate design pass.

4. **Concurrent guarded sessions.** Can two `qa-fix` runs share a host?
   §6 says each session is single-run, but the host must also enforce
   one-write-timeline-per-workspace if both runs target the same tree.
   Recommendation: the scheduler (`lib/factory-scheduler.ts`) already
   restricts write timelines; the host adapter should reject
   `createGuardedAgentSession` calls whose workspaceRoot collides with
   an active session. Add this as an attestation field
   (`activeSessionsAtAttestation`) so the factory can sanity-check.

5. **Symlinks to outside the workspace.** §7.2 places symlink
   resolution on the host. Recommendation: also make the file-write
   classifier compute a second-pass realpath check on the canonical
   path the host returns, so a malicious host that resolves incorrectly
   still fails closed at the classifier.

6. **Revocation.** If the host detects a violation mid-session (e.g.,
   the agent spawned a sibling unguarded session), it must be able to
   tear the session down immediately. Recommendation: `handle.close()`
   is the user-initiated path; the host should also expose a
   `host.revokeSession(sessionId, reason)` callable from telemetry,
   independent of the factory.

7. **Audit-log retention.** Denial artifacts grow over time. The
   beta-ops doc already covers backup; this design adds nothing new on
   retention. But the per-run `guard-denials.jsonl` should be capped
   (e.g., 10k denials per run) so a malicious or stuck agent can't
   blow up the artifact store.

## 14. Decision

- `/factory-qa-fix` remains hidden in the Pi adapter.
- `safe-command-guard` remains absent from the Pi adapter's default
  capability advertisement.
- `FACTORY_QA_FIX_WORKFLOW` continues to require `safe-command-guard` so
  any host adopting this design must actually wrap the surfaces.
- This design is the canonical contract. Subsequent factory-side changes
  for `qa-fix` enforcement (`lib/factory-file-write-guard.ts`, attestation
  helpers, shim, fake host, integration tests) should implement the
  sections above without re-deriving the contract.
- Updates to `PI_SOFTWARE_FACTORY_ROADMAP.md` "Next Chunk 3" and the
  production-readiness map should treat this doc as the design-of-record
  for the QA-fix host-enforcement work and reference it explicitly rather
  than restating the contract.
