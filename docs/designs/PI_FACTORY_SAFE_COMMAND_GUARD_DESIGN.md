# Pi Factory Safe Command Guard Design

Status: proposed contract for enabling write-capable factory QA fix runs safely. The pure classifier slice is implemented in `lib/factory-command-guard.ts`; runtime wrapper/attestation is still future work.

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
