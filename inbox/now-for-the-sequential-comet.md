# Plan: Backup Model Fallback for primaryImpl, testFixer, ship, land

## Context

When Kimi (the primary provider for `primaryImpl`, `testFixer`, `ship`, and `land`) fails — either a non-zero exit code or a timeout that persisted through its built-in retry — the build orchestrator currently surfaces the failure immediately to the caller, which pauses/fails the feature. The user wants a backup model (Gemini) to be automatically substituted when the primary fails, so transient Kimi outages don't halt a build.

No backup concept exists anywhere in the codebase today. This adds it as a first-class optional field on `RoleConfig`, wired through the existing `runConfiguredRoleTask()` dispatch function.

---

## Files to Modify

| File | Change |
|------|--------|
| `build/orchestrator/role-config.ts` | Add `backupProvider?` / `backupModel?` to interface + env var parsing |
| `build/orchestrator/sub-agents.ts` | Restructure `runConfiguredRoleTask()` to capture result, check for backup |
| `build/configure.cm` | Set `backupProvider: "gemini"` / `backupModel: "gemini-2.5-pro"` on four roles |
| `build/orchestrator/__tests__/role-config.test.ts` | Tests for BACKUP env var parsing + configure.cm defaults |
| `build/orchestrator/__tests__/sub-agents.test.ts` | Integration test for fallback using fake KIMI_BIN/GEMINI_BIN |
| `build/SKILL.md.tmpl` | Document backupProvider/backupModel fields + env vars |
| `build/SKILL.md` | Regenerated from template (`bun run gen:skill-docs`) |

---

## Implementation

### Fix 1 — `build/orchestrator/role-config.ts`

**Extend `RoleConfig` interface** (after `command?` field, line 10):
```typescript
export interface RoleConfig {
  provider: RoleProvider;
  model: string;
  reasoning: RoleReasoning;
  command?: string;
  backupProvider?: RoleProvider;   // ← new
  backupModel?: string;            // ← new
}
```

**Extend `RoleField` type** (line 62):
```typescript
export type RoleField = "provider" | "model" | "reasoning" | "command" | "backupProvider" | "backupModel";
```

**`applyEnvRoleConfig()`** — add two new env lookups after the existing `command` block (after line 90–91):
```typescript
const backupProvider = env[`${prefix}_BACKUP_PROVIDER`];
const backupModel    = env[`${prefix}_BACKUP_MODEL`];
if (backupProvider)
  next[key].backupProvider = parseProvider(backupProvider, `${prefix}_BACKUP_PROVIDER`);
if (backupModel) next[key].backupModel = backupModel;
```

**`applyRoleOverride()`** — add two new branches after the existing `model` branch (line 107):
```typescript
else if (field === "backupProvider")
  roles[role].backupProvider = parseProvider(value, `${role}.backupProvider`);
else if (field === "backupModel") roles[role].backupModel = value;
```

No change needed to `cloneRoleConfigs()` — it deep-clones via `JSON.parse(JSON.stringify(...))`, so optional fields are preserved automatically.

---

### Fix 2 — `build/orchestrator/sub-agents.ts` (`runConfiguredRoleTask`, lines 989–1072)

Change `opts.role` parameter type from the current inline type to `RoleConfig` (superset, callers unaffected — all their fields are still valid). Then restructure from early-return branches to a single captured result + backup check:

```typescript
// Import RoleConfig at top of file (add to existing role-config import)
import type { RoleConfig, RoleProvider, RoleReasoning } from "./role-config";

export async function runConfiguredRoleTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: RoleConfig;   // ← was inline type; RoleConfig is superset, no callers break
  timeoutMs?: number;
  gate?: boolean;
  sandbox?: CodexSandbox;
  codexDefaultCommand?: string;
}): Promise<SubAgentResult> {
  let result: SubAgentResult;

  if (opts.role.provider === "claude") {
    result = await runClaudeTask({ /* same args as before */ });
  } else if (opts.role.provider === "gemini") {
    result = await runRoleTask({ /* same args */ });
  } else if (opts.role.provider === "kimi") {
    result = await runKimi({ /* same args */ });
  } else {
    result = await runCodexReview({ /* same args */ });
  }

  // Backup model fallback. backupProvider is absent from the backup role object,
  // so the recursive call cannot fall back again (no infinite loop).
  if ((result.timedOut || result.exitCode !== 0) && opts.role.backupProvider) {
    console.warn(
      `[gstack-build] ${opts.logPrefix}: primary ${opts.role.provider} failed ` +
      `(exit=${result.exitCode ?? "null"}, timedOut=${result.timedOut}); ` +
      `falling back to ${opts.role.backupProvider}`,
    );
    return runConfiguredRoleTask({
      ...opts,
      role: {
        provider: opts.role.backupProvider,
        model: opts.role.backupModel ?? "",
        reasoning: opts.role.reasoning,
        command: opts.role.command,
        // backupProvider intentionally absent → one level of fallback only
      },
    });
  }

  return result;
}
```

---

### Fix 3 — `build/configure.cm`

Add `backupProvider` + `backupModel` to the four targeted roles only (not to `monitorAgent`, `secondaryImpl`, `testWriter`, etc.):

```json
"primaryImpl": {
  "provider": "kimi",
  "model": "kimi-code/kimi-for-coding",
  "reasoning": "high",
  "backupProvider": "gemini",
  "backupModel": "gemini-2.5-pro"
},
"testFixer": {
  "provider": "kimi",
  "model": "kimi-code/kimi-for-coding",
  "reasoning": "high",
  "backupProvider": "gemini",
  "backupModel": "gemini-2.5-pro"
},
"ship": {
  "provider": "kimi",
  "model": "kimi-code/kimi-for-coding",
  "reasoning": "high",
  "command": "/ship",
  "backupProvider": "gemini",
  "backupModel": "gemini-2.5-pro"
},
"land": {
  "provider": "kimi",
  "model": "kimi-code/kimi-for-coding",
  "reasoning": "high",
  "command": "/land-and-deploy",
  "backupProvider": "gemini",
  "backupModel": "gemini-2.5-pro"
},
```

---

### Fix 4 — `build/orchestrator/__tests__/role-config.test.ts`

Add tests after the existing `"accepts kimi as a role provider"` block:

```typescript
it("honors BACKUP_PROVIDER / BACKUP_MODEL env overrides for primaryImpl", () => {
  const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
    GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER: "gemini",
    GSTACK_BUILD_PRIMARY_IMPL_BACKUP_MODEL: "gemini-2.5-pro",
  });
  expect(roles.primaryImpl.backupProvider).toBe("gemini");
  expect(roles.primaryImpl.backupModel).toBe("gemini-2.5-pro");
});

it("rejects invalid backup provider in env", () => {
  expect(() =>
    applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER: "unsupported-model",
    }),
  ).toThrow("GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER");
});

it("configure.cm sets gemini backup for primaryImpl, testFixer, ship, land", () => {
  const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
  for (const role of ["primaryImpl", "testFixer", "ship", "land"] as const) {
    expect(defaults.roles[role].backupProvider).toBe("gemini");
    expect(defaults.roles[role].backupModel).toBe("gemini-2.5-pro");
  }
});
```

---

### Fix 5 — `build/orchestrator/__tests__/sub-agents.test.ts`

Add integration test using `KIMI_BIN` and `GEMINI_BIN` env overrides (both already used by `kimiBin()` and `geminiBin()` internally):

The test creates:
1. A fake kimi bin (`#!/bin/sh\nexit 1`) that always fails
2. A fake gemini bin (`#!/bin/sh\necho "$outPath"\necho "backup ok" > "$outPath"`) that writes to the output file
3. Calls `runConfiguredRoleTask` with `provider: "kimi"` + `backupProvider: "gemini"`
4. Asserts the result has `exitCode === 0` and stdout contains "backup ok"

Restore `KIMI_BIN`/`GEMINI_BIN` in `finally`.

---

### Fix 6 — `build/SKILL.md.tmpl`

In the section documenting role configuration fields (wherever `provider`, `model`, `reasoning`, `command` are listed), add:

```markdown
- **`backupProvider`** _(optional)_: Provider to substitute when the primary fails (non-zero exit or timeout after retry). Same valid values as `provider`: `claude`, `codex`, `gemini`, `kimi`. One level of fallback — if the backup also fails, the error propagates normally.
- **`backupModel`** _(optional)_: Model to pass to the backup provider. If omitted, no `-m` flag is passed (backup CLI uses its default).

Env overrides follow the same `_BACKUP_PROVIDER` / `_BACKUP_MODEL` suffix:
```
GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER=gemini
GSTACK_BUILD_PRIMARY_IMPL_BACKUP_MODEL=gemini-2.5-pro
```

The default `configure.cm` sets Gemini as backup for `primaryImpl`, `testFixer`, `ship`, and `land`.
```

---

## Verification

```bash
# 1. TypeScript: no new type errors
bun run build 2>&1 | grep -E "error TS"

# 2. Role config tests (parsing + configure.cm assertion)
bun test build/orchestrator/__tests__/role-config.test.ts

# 3. Sub-agents fallback integration test
bun test build/orchestrator/__tests__/sub-agents.test.ts

# 4. Full free test suite
bun test

# 5. Regenerate SKILL.md
bun run gen:skill-docs

# 6. Smoke: verify configure.cm has backup fields
node -e "
const c = require('./build/configure.cm');
for (const r of ['primaryImpl','testFixer','ship','land']) {
  console.log(r, c.roles[r].backupProvider, c.roles[r].backupModel);
}
"
# Expected: each line → gemini  gemini-2.5-pro
```

---

## Engineering Review Amendments (2026-05-10, /plan-eng-review)

Three gaps found. Addressed below before implementation.

### Amendment A — `validateRoles()` must check `backupProvider` (`build/orchestrator/build-config.ts`)

`validateRoles()` validates `provider`, `model`, `reasoning`, `command` but not `backupProvider` / `backupModel`. An invalid `"backupProvider": "grok"` in configure.cm would pass load-time validation silently and only fail at runtime when the backup fires. Add inside `validateRoles()`, after the `command` check:

```typescript
if (role.backupProvider != null && !PROVIDERS.includes(role.backupProvider)) {
  throw new Error(
    `${filePath}:roles.${key}.backupProvider must be one of: ${PROVIDERS.join(", ")}`,
  );
}
if (role.backupModel != null && typeof role.backupModel !== "string") {
  throw new Error(
    `${filePath}:roles.${key}.backupModel must be a string when present`,
  );
}
```

Add corresponding test: loading a configure.cm with `"backupProvider": "bad"` should throw.

### Amendment B — Fix fake gemini binary in sub-agents.test.ts

The plan's fake gemini spec `echo "backup ok" > "$outPath"` is wrong. `$outPath` is not an env var — the output path is embedded in the `-p` prompt arg as `"Write your complete output to /tmp/staged-output.md"`. `runRoleTask()` uses staged IO: it copies input to a temp dir, passes staged paths to gemini, then reads staged output back via `mergeOutputFile()`.

Correct fake gemini binary:
```sh
#!/bin/sh
# The -p prompt arg contains "Write your complete output to <path>."
# Extract the staged output path from the prompt.
for arg in "$@"; do
  case "$arg" in
    *"Write your complete output to "*)
      OUTPUT=$(printf '%s' "$arg" | grep -oE 'to [^ ]+\.md' | awk '{print $2}' | head -1)
      ;;
  esac
done
[ -n "$OUTPUT" ] && printf 'backup ok' > "$OUTPUT"
exit 0
```

The test assertion reads `opts.outputFilePath` (the non-staged path) and verifies it contains "backup ok" — `mergeOutputFile()` copies staged → final on success.

### Amendment C — Document double-timeout cost in `build/SKILL.md.tmpl`

Both `runKimi()` and `runRoleTask()` (Gemini) have an internal 1-retry on timeout. When kimi times out, its retry fires first; then if the backup also times out, Gemini retries too. Worst case: `kimi → kimi-retry → gemini → gemini-retry` = 4× the base timeout. At the default 900s, that is ~60 minutes total before error propagates.

Add to the SKILL.md.tmpl backup documentation note:

> **Timeout cost:** both the primary and backup runners have a built-in timeout retry. A primary timeout causes `primary → retry → backup → backup-retry`. At the 900s default, worst-case wait is ~60 min before the error surfaces. Adjust `timeoutMs` for roles with a backup if 60-min stalls are unacceptable.

---

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|------|--------|----------|
| 1 | REVIEWED — /plan-eng-review (2026-05-10) | 3 gaps: validateRoles() hole (A), fake gemini binary (B), double-timeout docs (C) |
| — | — | — |
| — | — | — |
| — | — | — |
| — | — | — |
