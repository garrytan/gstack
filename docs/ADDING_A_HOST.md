# Adding a New Host to gstack

gstack uses a declarative host config system. Each supported AI coding agent
(Claude, Codex, Factory, Kiro, OpenCode, Slate, Cursor, OpenClaw, Hermes,
GBrain) is defined as a typed TypeScript config object built by the
`defineHost()` factory. Adding a new host means creating one file and
re-exporting it. Zero code changes to the generator, setup, or tooling.

## How it works

```
hosts/
├── define-host.ts   # defineHost() factory: shared defaults + derived fields
├── claude.ts        # Primary host
├── codex.ts         # OpenAI Codex CLI
├── factory.ts       # Factory Droid
├── kiro.ts          # Amazon Kiro
├── opencode.ts      # OpenCode
├── slate.ts         # Slate (Random Labs)
├── cursor.ts        # Cursor
├── openclaw.ts      # OpenClaw
├── hermes.ts        # Hermes (Nous Research)
├── gbrain.ts        # GBrain
└── index.ts         # Registry: imports all, derives Host type
```

Each config file calls `defineHost()` and exports the resulting `HostConfig`
object, which tells the generator:
- Where to put generated skills (paths)
- How to transform frontmatter (allowlist/denylist fields)
- What Claude-specific references to rewrite (paths, tool names)
- What binary to detect for auto-install
- What resolver sections to suppress
- What assets to symlink at install time

The generator, setup script, platform-detect, uninstall, health checks, worktree
copy, and tests all read from these configs. None of them have per-host code.

## Step-by-step: add a new host

### 1. Create the config file

Configs are built with the `defineHost()` factory in `hosts/define-host.ts`.
You only write the fields that differ from the common external-host defaults;
everything else is derived from the host name. A fully-default host is two
fields (see `hosts/slate.ts` or `hosts/cursor.ts`):

```typescript
import { defineHost } from './define-host';

const myhost = defineHost({
  name: 'myhost',
  displayName: 'MyHost',
});

export default myhost;
```

That expands to the full `HostConfig` with these defaults:

- `cliCommand: 'myhost'` (the name; binary for `command -v` detection)
- `cliAliases: []`
- `defaultModel: 'claude'` (model overlay used when generation gets no explicit `--model`; codex overrides to `'gpt'`)
- `globalRoot` / `localSkillRoot`: `.myhost/skills/gstack`, `hostSubdir`: `.myhost`
- `usesEnvVars: true` (false only for Claude, which uses literal `~` paths)
- `frontmatter`: allowlist keeping `name` + `description`, no description limit
- `generation`: no metadata file, `skipSkills: ['codex']` (codex skill is Claude-only)
- `pathRewrites`: the standard trio derived from the resolved paths
  (`~/.claude/skills/gstack` → `~/{globalRoot}`, `.claude/skills/gstack` →
  `{localSkillRoot}`, `.claude/skills` → `{hostSubdir}/skills`)
- `suppressedResolvers`: the GBrain pair (`GBRAIN_CONTEXT_LOAD`, `GBRAIN_SAVE_RESULTS`)
- `runtimeRoot`: the shared asset list (`bin`, `browse/dist`, `browse/bin`,
  `gstack-upgrade`, `ETHOS.md` + review checklist files)
- `install`: `{ linkingStrategy: 'symlink-generated' }`
- `learningsMode: 'basic'`

Override any field by passing it to `defineHost()`. Two path-rewrite options:

- `extraPathRewrites`: appends entries AFTER the derived trio (e.g. kiro's
  codex-path cleanup, or `{ from: 'CLAUDE.md', to: 'AGENTS.md' }` for
  AGENTS.md hosts). Use this when the standard trio is right but you need more.
- `pathRewrites`: replaces the derived list entirely. Only for non-mechanical
  cases — codex and factory rewrite the global path to `$GSTACK_ROOT` and add
  an extra review-path rewrite; claude has an empty list.

The two are mutually exclusive (the factory throws if you pass both).

Shared constants exported from `define-host.ts` for spread-composition:
`CROSS_MODEL_RESOLVERS` (the five Codex-invoking resolvers suppressed on
hosts that can't invoke other models), `GBRAIN_RESOLVERS` (the default
suppression pair), and `EXEC_STYLE_TOOL_REWRITES` (the OpenClaw-style
lowercase-tool rewrites shared by openclaw and gbrain).

Good examples: `hosts/opencode.ts` (path + runtimeRoot overrides),
`hosts/factory.ts` (tool rewrites and conditional fields), `hosts/hermes.ts`
(AGENTS.md host with custom tool rewrites and resolver composition).

### 2. Register in the index

Edit `hosts/index.ts`:

```typescript
import myhost from './myhost';

// Add to ALL_HOST_CONFIGS array:
export const ALL_HOST_CONFIGS: HostConfig[] = [
  claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, myhost
];

// Add to re-exports:
export { claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, myhost };
```

### 3. Add to .gitignore

Add `.myhost/` to `.gitignore` (generated skill docs are gitignored).

### 4. Generate and verify

```bash
# Generate skill docs for the new host
bun run gen:skill-docs --host myhost

# Verify output exists and has no .claude/skills leakage
ls .myhost/skills/gstack-*/SKILL.md
grep -r ".claude/skills" .myhost/skills/ | head -5
# (should be empty)

# Generate for all hosts (includes the new one)
bun run gen:skill-docs --host all

# Health dashboard shows the new host
bun run skill:check
```

### 5. Run tests

```bash
bun test test/gen-skill-docs.test.ts
bun test test/host-config.test.ts
```

The parameterized smoke tests automatically pick up the new host. Zero test
code to write. They verify: output exists, no path leakage, valid frontmatter,
freshness check passes, codex skill excluded.

### 6. Update README.md

Add install instructions for the new host in the appropriate section.

## Config field reference

See `scripts/host-config.ts` for the full `HostConfig` interface with JSDoc
comments on every field.

Key fields:

| Field | Purpose |
|-------|---------|
| `defaultModel` | Model overlay rendered when generation gets no explicit `--model` (validated against `ALL_MODEL_NAMES` in `scripts/models.ts`) |
| `frontmatter.mode` | `allowlist` (keep only listed) or `denylist` (strip listed) |
| `frontmatter.descriptionLimit` | Max chars, `null` for no limit |
| `frontmatter.descriptionLimitBehavior` | `error` (fail build), `truncate`, `warn` |
| `frontmatter.conditionalFields` | Add fields based on template values (e.g., sensitive → disable-model-invocation) |
| `frontmatter.renameFields` | Rename template fields (e.g., voice-triggers → triggers) |
| `pathRewrites` | Literal replaceAll on content. Order matters. Replaces the derived trio. |
| `extraPathRewrites` | (defineHost input only) Appended after the derived trio. |
| `toolRewrites` | Rewrite Claude tool names (e.g., "use the Bash tool" → "run this command") |
| `suppressedResolvers` | Resolver functions that return empty for this host |
| `coAuthorTrailer` | Git co-author string for commits |
| `boundaryInstruction` | Anti-prompt-injection warning for cross-model invocations |

## Validation

The `validateHostConfig()` function in `scripts/host-config.ts` checks:
- Name: lowercase alphanumeric with hyphens
- CLI command: alphanumeric with hyphens/underscores
- `defaultModel`: must be a known model family from `scripts/models.ts` `ALL_MODEL_NAMES`
- Paths: safe characters only (alphanumeric, `.`, `/`, `$`, `{}`, `~`, `-`, `_`)
- No duplicate names, hostSubdirs, or globalRoots across configs

Run `bun run scripts/host-config-export.ts validate` to check all configs.
