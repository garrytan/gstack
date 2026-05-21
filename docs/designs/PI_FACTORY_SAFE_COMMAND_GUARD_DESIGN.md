# Pi Factory Safe Command Guard Design

Status: proposed contract for enabling write-capable factory QA fix runs safely. The pure classifier slice is implemented in `lib/factory-command-guard.ts`; runtime wrapper/attestation is still future work.

The host-side enforcement contract that pairs with this design — per-run guarded agent sessions, file-write classifier, browser sidecar output-dir constraint, capability attestation, validation, and the explicit blockers that keep `/factory-qa-fix` hidden — lives in `docs/designs/PI_FACTORY_HOST_GUARD_ENFORCEMENT_DESIGN.md`.

## Goal

Define a real runtime guard for `commandSafetyProfile: 'non-destructive-write'` so Pi can eventually expose write-capable `qa-fix` runs without relying on prompt prose alone.

This is a design/contract artifact. It does not expose `/factory-qa-fix` and does not broaden current automation authority.

## Current state

The core factory already models safety intent:

- `CommandSafetyProfile = 'read-only' | 'non-destructive-write' | 'release-action'` in `lib/factory-core.ts`.
- `qa-fix` requires:
  - explicit write policy;
  - `commandSafetyProfile: 'non-destructive-write'`;
  - capabilities: `filesystem`, `git`, `test-runner`, and `safe-command-guard`.
- The Pi extension intentionally does not expose `/factory-qa-fix` because the adapter cannot currently attest a real command guard.

The missing piece is an enforceable action boundary: a runtime/tool wrapper that sees every shell/tool command before execution and denies commands outside the selected safety profile.

## Non-goals

- Do not implement release/deploy automation here.
- Do not expose `/factory-qa-fix` until runtime enforcement exists and tests pass.
- Do not depend on model compliance or prompt wording as the only safety layer.
- Do not mutate `lib/factory-core.ts` into an action module.
- Do not attempt perfect shell sandboxing in G1; this guard is a fail-closed command policy layer, not a container or OS sandbox.

## Safety profiles

### `read-only`

Allows inspection commands only.

Examples:

- `git status`, `git diff`, `git log`, `git show`;
- `rg`, `grep`, `find` without delete/exec side effects;
- test discovery commands that do not write artifacts;
- package manager read/info commands.

Blocks:

- file writes;
- mutating git commands;
- package installs;
- publish/deploy;
- secret/environment dumping.

### `non-destructive-write`

Allows local, reversible development writes inside the workspace when explicitly requested.

Examples:

- editing source/test/docs through approved file-write tools;
- `git diff`, `git status`, `git add` for local staging if explicitly part of workflow;
- project test commands;
- formatters that only affect workspace files;
- local build commands that do not publish/deploy.

Blocks:

- destructive filesystem deletion;
- hard resets and cleans;
- force pushes;
- tags/releases/publish/deploy;
- migration/application against external systems;
- credential/env dumping;
- commands outside the workspace unless allowlisted.

### `release-action`

Reserved for future explicit release workflows. Not part of `qa-fix`.

## Proposed architecture

```text
Factory workflow plan
  -> policy.commandSafetyProfile
  -> runtime capability attestation: safe-command-guard
  -> guarded runtime/tool adapter
  -> command classification
  -> allow/deny decision
  -> audit event/artifact
```

### Guard location

Recommended first implementation: **runtime wrapper around command-capable actions**, not core.

Reasons:

- Core remains pure data/calculation.
- Runtime/tool adapter is where commands actually cross into filesystem/shell/browser/CI.
- The facade can require the `safe-command-guard` capability without knowing how a host enforces it.
- Pi can attest capability only when its adapter routes shell/file actions through the guard.

### Guard interface

Proposed pure calculation contract:

```ts
export interface CommandGuardRequest {
  readonly command: string;
  readonly cwd: string;
  readonly profile: CommandSafetyProfile;
  readonly workspaceRoot: string;
  readonly context?: {
    readonly workflowId?: string;
    readonly phaseId?: string;
    readonly runId?: string;
  };
}

export interface CommandGuardDecision {
  readonly allowed: boolean;
  readonly severity: 'allow' | 'warn' | 'block';
  readonly reason: string;
  readonly matchedRuleId?: string;
  readonly normalizedCommand: string;
}
```

Keep classification pure and unit-testable. The action-backed runtime wrapper should call it before execution and fail closed on parser errors.

## Classification strategy

G1 should use conservative lexical + token classification, not a full shell interpreter.

Recommended steps:

1. Normalize whitespace and strip benign wrapping quotes where safe.
2. Reject control operators that obscure intent unless explicitly allowed:
   - `;`, `&&`, `||`, pipes, command substitution, backticks, process substitution.
3. Tokenize the first command and arguments.
4. Match known-deny rules first.
5. Match narrow allow rules second.
6. Default deny for unknown mutating commands under `read-only` and high-risk commands under `non-destructive-write`.

## Minimum deny rules

### Filesystem destruction

Block at minimum:

```text
rm -rf
rm -fr
rm --recursive --force
find ... -delete
find ... -exec rm ...
trash / delete helpers when targeting broad dirs
```

Also block deleting high-risk roots:

- `/`, `/home`, `$HOME`, `~`, workspace root;
- `.git`, `.gstack`, `.claude`, `.pi`, `.agents` unless a future migration explicitly allows it.

### Git destructive operations

Block:

```text
git reset --hard
git clean
git checkout -- .
git restore .
git push --force
git push -f
git tag -d
git branch -D
git rebase --abort/--skip/--continue when not explicitly in a rebase workflow
```

For `qa-fix`, also block normal push/tag/release commands:

```text
git push
git tag
gh release
```

### Publish/deploy/release

Block:

```text
npm publish
bun publish
pnpm publish
yarn npm publish
cargo publish
twine upload
docker push
kubectl apply/delete/rollout
terraform apply/destroy
pulumi up/destroy
vercel deploy
netlify deploy
fly deploy
railway up
wrangler deploy
aws cloudformation deploy
az deployment
```

### Secret and environment dumping

Block:

```text
env
printenv
set
export -p
cat .env
cat ~/.ssh/*
cat ~/.config/env-master/*
grep/ripgrep over env-master, .env, key/token/password files
```

Allow narrow `echo $KNOWN_NON_SECRET_VAR` only if there is a concrete need; default deny for secret-like variable names.

### External-system mutation

Block commands that can mutate external state unless a future workflow/profile explicitly permits them:

- Stripe CLI write operations;
- GitHub/GitLab mutation commands beyond local PR inspection;
- cloud CLIs;
- database migration/apply commands;
- OAuth/app management CLIs.

## Allow examples for `non-destructive-write`

Narrow allowlist examples:

```text
git status
git diff
git log
git show
git add <workspace paths>
bun test ...
tsc --noEmit
rg ...
find ... (without -delete/-exec mutators)
```

Caveat: package scripts can hide dangerous commands. The implemented pure G1 classifier denies package-manager scripts such as `npm run lint`, `npm test`, `pnpm typecheck`, and `yarn test` until a runtime wrapper can read the project manifest and classify the underlying script recursively. Future expansion may allow them only when:

- script name is in a safe category (`test`, `lint`, `typecheck`, `format`);
- command is read from project manifest and classified recursively;
- otherwise warn/deny and ask for explicit human execution.

## Runtime behavior

When denied:

- do not execute the command;
- return a structured error to the phase runtime;
- append a safety artifact/event with command hash, rule id, and reason;
- keep the factory run failed or paused depending on workflow policy;
- show user-facing copy explaining that the guard blocked a dangerous action.

Do not include full command text if it may contain secrets. Store/display a redacted command plus digest.

When allowed:

- execute normally through the existing adapter;
- optionally record guard decision metadata for audit.

## Capability attestation

`safe-command-guard` should only appear in `availableCapabilities` when all command-capable pathways for the workflow are wrapped.

For Pi `qa-fix`, attestation requires:

- shell/exec commands pass through guard;
- file-write tools are scoped to workspace and protected paths are blocked;
- browser tooling cannot trigger filesystem/deploy side effects outside the guard;
- generated skill dispatch cannot bypass into an unguarded agent session.

If any pathway cannot be guarded, `safe-command-guard` must be absent and `qa-fix` remains blocked.

## Tests required before exposing `/factory-qa-fix`

### Pure command guard tests

Add unit tests for:

- `rm -rf` variants blocked;
- `git reset --hard` blocked;
- `git clean` blocked;
- `git push --force` and `git push` blocked for `qa-fix`;
- publish/deploy commands blocked;
- env/secret dumping blocked;
- direct safe test/status/typecheck commands allowed;
- secret-like glob operands and backslash/Windows-style path syntax fail closed;
- command chaining/substitution denied or classified fail-closed;
- workspace path traversal denied.

### Runtime wrapper tests

Add integration tests proving:

- denied commands are not executed;
- allowed commands execute;
- guard decisions are recorded;
- parser/classifier errors fail closed;
- `safe-command-guard` is not advertised unless wrapper is active.

### Pi extension tests

Before exposing `/factory-qa-fix`:

- command remains hidden when guard absent;
- command appears only when guard attestation is available;
- guard denial surfaces clear user copy;
- denied command does not modify the repo;
- audit/no-fix `/factory-qa` remains unaffected.

## Open questions

1. Should the first guard wrap only shell commands, or also file-write tools?
   - Recommendation: both before exposing `qa-fix`.

2. Should denied commands pause for user override or fail closed?
   - Recommendation: fail closed for G1. Add override only with explicit one-way approval and audit trail later.

3. Should project scripts be recursively inspected?
   - Recommendation: yes for known package managers where practical; otherwise deny ambiguous write-capable scripts under `qa-fix`.

4. Should the guard live in `lib/` or Pi extension code?
   - Recommendation: pure classifier in `lib/factory-command-guard.ts`; host-specific execution wrappers in adapters.

## Recommended implementation sequence

1. Add pure `lib/factory-command-guard.ts` classifier and unit tests. **Done.** Current G1 behavior denies package-manager scripts and formatter/linter write commands until recursive manifest inspection and runtime realpath/symlink checks exist; it also fails closed on backslash/Windows-style path syntax.
2. Add a guarded command execution interface to runtime capabilities or a host adapter.
3. Teach Pi runtime adapter to advertise `safe-command-guard` only when all command/file-write pathways are wrapped.
4. Add denied-command audit artifact/event.
5. Add integration tests with harmless fixture commands.
6. Only then expose `/factory-qa-fix`.

## Decision

Recommended G1 decision:

- implement a pure deny-first classifier;
- wrap action-backed command execution outside core;
- fail closed on unknown high-risk commands and parser ambiguity;
- require guard attestation before `qa-fix` can run;
- keep `/factory-qa-fix` hidden until those tests pass.

## Appendix A: Live execution path inventory (A2.1)

Status: written as the Alpha 2 A2.1 live attestation pass for the
`sf/live-guard-alpha2` branch. Conclusion is that `/factory-qa-fix` MUST remain
hidden because at least one required write path is not enforceable from
repository code today.

This appendix enumerates every path a hypothetical QA-fix agent could use to
mutate files or run commands once Pi dispatches a `qa-fix` run, and classifies
each as `guarded`, `guardable`, `not-enforceable-from-repo`, or `out-of-scope`.

| # | Path | Where in repo | Classification | Notes |
|---|------|---------------|----------------|-------|
| 1 | Factory runtime command execution wrapper | `lib/factory-guarded-runtime.ts` | `guardable` (currently dormant) | Implements deny-first guard + fail-closed behavior + capability attestation. No current factory runtime adapter calls `executeCommand`; it is wiring waiting for a host that actually executes shell commands inside factory code. |
| 2 | Pi extension review/QA dispatch runtime | `.pi/extensions/pi-gstack/index.ts` (`createPiReviewDispatchRuntime`) | `not-enforceable-from-repo` for `qa-execution`; `guarded` for everything it directly writes | Phases write artifact records via `artifactStore.writeText` and dispatch a generated skill with `pi.sendUserMessage`. The adapter itself does not execute repo-mutating shell commands — but the message it sends hands the work to Claude's host, whose tool layer is outside factory control. |
| 3 | Generated `qa` / `qa-only` skill instructions | `qa/SKILL.md.tmpl`, `qa-only/SKILL.md.tmpl` | `not-enforceable-from-repo` | The skill frontmatter declares `allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, WebSearch`. These resolve to the executing host (Claude Code, Pi internal Claude runtime). The repo cannot intercept Claude's Bash / Edit / Write invocations once the skill is dispatched. Prompt-prose safety contracts inside the skill are advisory, not enforced. |
| 4 | Pi custom tool `gstack_browser` | `.pi/extensions/pi-gstack/index.ts` (`registerTool`) | `partially guarded` | `normalizePiBrowserCommandRequest` validates command + args against an allowlist; arguments are passed through `spawn` with a known browse binary path. File writes inside the browse binary (screenshots, `.gstack/browse.json`, downloaded assets) are NOT classified by `factory-command-guard`. |
| 5 | Pi custom tool `ask_user_question` | `.pi/extensions/pi-gstack/index.ts` (`registerTool`) | `out-of-scope` | No execution surface; only collects a user answer through Pi UI. |
| 6 | Browser sidecar (browse binary) subprocess tree | `gstack browse` (`spawn(browseBinary, ...)`) | `not-enforceable-from-repo` | The browse binary launches Playwright/Chromium, which can read/write files inside the workspace (state file, screenshot directories) and reach the network. The Pi extension constrains the entrypoint arguments only. Browse-internal command execution is not routed through `factory-command-guard`. |
| 7 | Host Bash invocations from a dispatched skill | Claude Code / Pi Claude host | `not-enforceable-from-repo` | Once `pi.sendUserMessage('/skill:gstack-qa ...')` is queued, every shell command the agent executes goes through the host's `Bash` tool, not through `lib/factory-guarded-runtime.ts`. The factory has no in-process interception point. |
| 8 | Host filesystem tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`) from a dispatched skill | Claude Code / Pi Claude host | `not-enforceable-from-repo` | Same as #7. The host's file-write tools are not workspace-scoped from the repo's vantage; the repo can only request scoping via prose. |
| 9 | `bin/gstack-slug` invocation inside the Pi extension | `spawnSync(join(REPO_ROOT, 'bin', 'gstack-slug'), ...)` with `minimalGstackEnv()` | `guarded` (by design) | Hard-coded path to a known repo binary, minimal env, 2s timeout, output validated by `parseGstackSlugAssignments` + `isSafeGstackPathSegment`. Cannot be redirected by attacker-supplied input. |
| 10 | `git rev-parse --show-toplevel` / `git rev-parse --short HEAD` in Pi extension | `spawnSync('git', ...)` | `guarded` (by design) | Fixed argument vectors, no user input flows in. Used only for read-only git introspection. |
| 11 | Filesystem operations performed directly by `lib/factory-*` modules | `lib/factory-event-store.ts`, `lib/factory-artifact-store.ts`, `lib/factory-project-store.ts`, `lib/factory-distribution.ts` | `guarded` (by design) | All writes are scoped to `runsRoot` / `.gstack/...` and reject unsafe IDs/paths via existing tests. Not part of the QA-fix mutation surface. |
| 12 | Release / publish / deploy automation | none (intentionally absent) | `out-of-scope` | No `qa-fix`, ship, or factory code performs publish/tag/push/deploy. The pure classifier already denies these tokens; the Pi `factory-decide` handler additionally short-circuits ship approvals because no ship-capable runtime exists. |

### Required capability ⇆ enforceable surface mapping

`FACTORY_QA_FIX_WORKFLOW` requires:

```
agent-session, artifact-store, browser, filesystem, git, safe-command-guard, test-runner
```

| Required capability | Enforceable from repo code today? | Why |
|---|---|---|
| `agent-session` | No | Provided by host; factory cannot supervise host tool layer (paths #7, #8). |
| `artifact-store` | Yes | `FileFactoryArtifactStore` scoped to `runsRoot`. |
| `browser` | Partially | Pi tool entrypoint is allowlisted (#4) but browse-internal writes are out (#6). |
| `filesystem` | No | Host tools (#8); no in-process interception. |
| `git` | No | Host Bash (#7) can run arbitrary git; in-extension git is read-only (#10) but does not cover skill-side use. |
| `safe-command-guard` | No (today) | Wrapper exists (#1) but is dormant; no live shell execution flows through it. Skill-side commands (#7) cannot be routed through it from repo code. |
| `test-runner` | No | Same as `filesystem` — provided by host Bash. |

`safe-command-guard` MUST NOT be advertised by `createPiReviewDispatchRuntime`
in its default invocation because the wrapper is not active on any real
execution surface. The current default (`options.safeCommandGuardActive` left
unset, defaulting to `false`) is correct.

### Exit rule (from §A2 plan, applied)

> If any required write path is not enforceable, do not expose `/factory-qa-fix`.

Paths #3, #7, and #8 are not enforceable from repository code. Therefore:

- `/factory-qa-fix` remains UNREGISTERED in `.pi/extensions/pi-gstack/index.ts`.
- `safe-command-guard` remains absent from the Pi adapter's
  `availableCapabilities` by default.
- The `FACTORY_QA_FIX_WORKFLOW` definition continues to require
  `safe-command-guard` so any future runtime that advertises that capability
  must have actually wrapped command execution.
- A negative test in `test/pi-extension.test.ts` asserts that
  `commands.has('factory-qa-fix') === false` after registration; this guard
  remains green.

### What it would take to unblock

The blocker is structural: there is no in-process boundary the repo controls
between the Pi adapter's `sendUserMessage` and the host's Bash/Edit/Write
tools. Unblocking `/factory-qa-fix` requires one of:

1. A host runtime that exposes a sub-agent execution mode whose tool layer
   routes through a factory-owned command/file-write interceptor (i.e., the
   factory provides the implementation of `Bash` and `Edit` for that
   sub-agent, rather than the host providing them). At that point, the
   adapter would construct a `FactoryGuardedCommandRuntime` from
   `lib/factory-guarded-runtime.ts`, wire its `executeCommand` to the
   host-provided exec hook, and pass `safeCommandGuardActive: true` to
   `createPiReviewDispatchRuntime`.
2. OR a process-level sandbox (container/OS-level confinement of the agent
   session) that enforces filesystem and network policy independent of
   prompt prose. This is explicitly out of scope for G1 per §Non-goals.

Either route still needs:

- guarded entrypoint for browse-internal writes (path #6) — likely by
  constraining browse to a per-run output directory and rejecting
  non-allowlisted browse subcommands at the binary boundary;
- denial-artifact emission so blocked attempts produce inspectable
  evidence (see Appendix B).

### Audit posture artifacts

To support the eventual integration, `lib/factory-guarded-runtime.ts` exposes
two additive seams (see Appendix B):

- a `sanitizeFactoryGuardDecisionForAudit` helper that converts a guard
  decision into a secret-safe shape (command digest + first token + rule
  metadata, no full command text);
- an optional `onCommandDecision` callback on
  `FactoryGuardedCommandRuntimeOptions` that fires for both allowed and
  blocked decisions, intended to feed durable denial artifact emission once
  a live wrapper is wired. The callback is best-effort: thrown errors do not
  block or override the underlying guard outcome.

Neither seam is wired into the Pi extension at this branch. They exist so
the integration that closes the blocker above can land additively, with
denial-evidence tests, instead of redesigning the guard surface.

## Appendix B: Denial audit emission seams

This appendix documents the additive seams in `lib/factory-guarded-runtime.ts`
that future runtime adapters will use to record denial evidence without
leaking secret values.

### `sanitizeFactoryGuardDecisionForAudit(decision)`

Purpose: produce a stable, secret-safe view of a `FactoryCommandGuardDecision`
suitable for inclusion in artifact metadata or audit events.

Output shape:

```ts
{
  allowed: boolean;
  severity: 'allow' | 'warn' | 'block';
  reason: string;             // rule reason; no command text
  matchedRuleId?: string;
  commandHead: string;        // first whitespace-separated token, basename-style
  commandDigest: string;      // sha256(normalizedCommand) hex, 16-char prefix
}
```

Rationale:

- The `normalizedCommand` field of `FactoryCommandGuardDecision` may contain
  user-supplied or attacker-supplied content (e.g., `cat $RANDOM_VAR=secret`
  was denied by `secret-dump`/`non-destructive-default-deny` but the value
  itself is still in the string). Durable artifacts and run logs MUST NOT
  include that string verbatim.
- `commandDigest` lets two denial records be correlated without exposing
  the command itself.
- `commandHead` keeps a low-information identifier (e.g., `rm`, `npm`, `cat`)
  so operators can scan a denial log meaningfully.

### `FactoryGuardedCommandRuntimeOptions.onCommandDecision`

Optional callback fired by `createFactoryGuardedCommandRuntime` for every
guard decision, both allowed and blocked. Signature:

```ts
onCommandDecision?(input: {
  request: FactoryCommandGuardRequest;
  decision: FactoryCommandGuardDecision;
  sanitized: SanitizedFactoryGuardDecision;
}): void | Promise<void>;
```

Behavior contract:

- Called BEFORE the executor runs for `allow` decisions, and BEFORE the
  `FactoryCommandGuardBlockedError` is thrown for `block` decisions. The
  callback therefore observes every decision the wrapper makes.
- Errors thrown from the callback are swallowed; they do not change the
  underlying guard outcome and they do not prevent execution. This is
  intentional: audit emission must never be load-bearing for safety.
- The callback receives the full `FactoryCommandGuardRequest` (including
  `command`) plus the raw and sanitized decision. Implementations that
  persist to disk MUST use `sanitized`, not `decision.normalizedCommand`,
  for any durable record.
- The guard remains inactive when `guardActive: false`; the callback is
  still invoked once per `executeCommand` call with a synthetic
  `guard-inactive-pass-through` decision so an adapter can prove which
  commands ran without the guard.

Tests in `test/factory-guarded-runtime.test.ts` cover:

- callback fires on allow, block, and guard-inactive paths;
- callback errors are swallowed (do not surface to the caller, do not change
  the executor's exit state);
- `sanitizeFactoryGuardDecisionForAudit` keeps `commandHead`, hashes the
  rest, and does not return the original command string in any field.
