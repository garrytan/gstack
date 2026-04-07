# Adding a New Host to gstack

gstack uses a declarative host config system. Each supported AI coding agent
(Claude, Codex, Factory, Kiro, OpenCode, Slate, Cursor, OpenClaw) is defined
as a typed TypeScript config object. Adding a new host means creating one file
and re-exporting it. Zero code changes to the generator, setup, or tooling.

## How it works

```
hosts/
├── claude.ts        # Primary host
├── codex.ts         # OpenAI Codex CLI
├── factory.ts       # Factory Droid
├── kiro.ts          # Amazon Kiro
├── opencode.ts      # OpenCode
├── slate.ts         # Slate (Random Labs)
├── cursor.ts        # Cursor
├── openclaw.ts      # OpenClaw (hybrid: config + adapter)
└── index.ts         # Registry: imports all, derives Host type
```

Each config file exports a `HostConfig` object that tells the generator:
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

Copy an existing config as a starting point. `hosts/opencode.ts` is a good
minimal example. `hosts/factory.ts` shows tool rewrites and conditional fields.
`hosts/openclaw.ts` shows the adapter pattern for hosts with different tool models.

Create `hosts/myhost.ts`:

```typescript
import type { HostConfig } from '../scripts/host-config';

const myhost: HostConfig = {
  name: 'myhost',
  displayName: 'MyHost',
  cliCommand: 'myhost',        // binary name for `command -v` detection
  cliAliases: [],              // alternative binary names

  globalRoot: '.myhost/skills/gstack',
  localSkillRoot: '.myhost/skills/gstack',
  hostSubdir: '.myhost',
  usesEnvVars: true,           // false only for Claude (uses literal ~ paths)

  frontmatter: {
    mode: 'allowlist',         // 'allowlist' keeps only listed fields
    keepFields: ['name', 'description'],
    descriptionLimit: null,    // set to 1024 for hosts with limits
  },

  generation: {
    generateMetadata: false,   // true only for Codex (openai.yaml)
    skipSkills: ['codex'],     // codex skill is Claude-only
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.myhost/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.myhost/skills/gstack' },
    { from: '.claude/skills', to: '.myhost/skills' },
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: { 'review': ['checklist.md', 'TODOS-format.md'] },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default myhost;
```

### 2. Register in the index

Edit `hosts/index.ts`:

```typescript
import myhost from './myhost';

// Add to ALL_HOST_CONFIGS array:
export const ALL_HOST_CONFIGS: HostConfig[] = [
  claude, codex, factory, kiro, opencode, slate, cursor, openclaw, myhost
];

// Add to re-exports:
export { claude, codex, factory, kiro, opencode, slate, cursor, openclaw, myhost };
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
| `frontmatter.mode` | `allowlist` (keep only listed) or `denylist` (strip listed) |
| `frontmatter.descriptionLimit` | Max chars, `null` for no limit |
| `frontmatter.descriptionLimitBehavior` | `error` (fail build), `truncate`, `warn` |
| `frontmatter.conditionalFields` | Add fields based on template values (e.g., sensitive → disable-model-invocation) |
| `frontmatter.renameFields` | Rename template fields (e.g., voice-triggers → triggers) |
| `pathRewrites` | Literal replaceAll on content. Order matters. |
| `toolRewrites` | Rewrite Claude tool names (e.g., "use the Bash tool" → "run this command") |
| `suppressedResolvers` | Resolver functions that return empty for this host |
| `coAuthorTrailer` | Git co-author string for commits |
| `boundaryInstruction` | Anti-prompt-injection warning for cross-model invocations |
| `adapter` | Path to adapter module for complex transformations |

## Adapter pattern (for hosts with different tool models)

If string-replace tool rewrites aren't enough (the host has fundamentally
different tool semantics), use the adapter pattern. See `hosts/openclaw.ts`
and `scripts/host-adapters/openclaw-adapter.ts`.

The adapter runs as a post-processing step after all generic rewrites. It
exports `transform(content: string, config: HostConfig): string`.

## Validation

The `validateHostConfig()` function in `scripts/host-config.ts` checks:
- Name: lowercase alphanumeric with hyphens
- CLI command: alphanumeric with hyphens/underscores
- Paths: safe characters only (alphanumeric, `.`, `/`, `$`, `{}`, `~`, `-`, `_`)
- No duplicate names, hostSubdirs, or globalRoots across configs

Run `bun run scripts/host-config-export.ts validate` to check all configs.
