# Adding a New Host to gstack

gstack uses a declarative host config system. Each supported AI coding agent
(Claude, Codex, Factory, Kiro, OpenCode, Slate, Cursor, OpenClaw, Hermes,
GBrain, Copilot, Antigravity) is defined as a typed TypeScript config object built by the
`defineHost()` factory. Rendering a new host means creating one file and
re-exporting it: the generator, tests, and validation pick it up. Installing
it is not free: setup still has one install arm per installable host (see
"What setup changes on disk" below), so an installable host also needs a setup
arm, an entry in the install registry tier table, and a certification run
before it is labelled `full`.

## Install ownership rules

These rules hold for every host, every scope, and every upgrade path
(`./setup`, `./setup --refresh-registered`, `/gstack-upgrade`, the team-mode
auto-update). Each refusal names what was left alone, the rule that applied,
and the exact command to proceed.

1. **Project-local setup never silently replaces a global install.** Setup
   run from a project-vendored copy, or from any checkout other than the one a
   global install links to, leaves that global install alone and prints
   `./setup --global` as the way to replace it on purpose. (Codex:
   `setup:186-207`, #2879. Claude: the global `~/.claude/skills/gstack` link.)
2. **An explicit `--host X` never mutates another host.** `--host codex`
   writes only Codex's skills directory and the checkout's own `.agents/`
   render. It does not heal, register, or remove Claude Code hooks in
   `settings.json`, and it does not touch the Claude gbrain render (#2347).
   One deliberate exception: the one-time `/claude` → `/claude-code` rename
   repair (`bin/gstack-migrate-claude-code`) renames gstack-owned entries in
   every install that shares the checkout.
3. **Upgrades refresh exactly the registered installs.** Every install setup
   activates is recorded in the install registry. Upgrades run
   `./setup --refresh-registered`, which runs setup once per registered host
   of that checkout (printing the source first) and nothing else. Installs
   owned by another checkout, and project installs of another project, are
   listed with the command that refreshes them there; they are never repointed
   (#1925).
4. **User-owned files survive.** Setup, `gstack-relink`, and
   `gstack-uninstall` delete or link over an entry only with proof that gstack
   created it (the #2119 ownership gate); anything else is reported and left.

### The install registry

`$GSTACK_STATE_ROOT/installs.tsv` (mode 0600) is the one record of installs.
Only `bin/gstack-install-registry.sh` writes it, under a lock directory with an
atomic rename. Columns: host, scope (`global`/`project`), project, destination
(the skills directory the host discovers), install root, source realpath,
version, prefix setting, render, updated-at. A row publishes only after the
host arm finished activating. Rows whose install root is gone are dropped
(`gstack_install_registry_reconcile`) by every refresh and by
`gstack-uninstall`, so an upgrade never resurrects an uninstalled host.

`./setup --status` prints one row per install (host, tier, scope, result,
version, destination, source) without building or writing anything, plus any
pre-registry install it finds on disk, labelled `unregistered` with the
command that registers it. A Codex install captured by a project-vendored copy
(#2879) is reported with both choices instead of being repointed. The setup
summary, the `/gstack-upgrade` summary, and `--status` share one renderer
(`gstack_install_registry_render`).

### Migrations

`gstack-upgrade/migrations/v*.sh` are state-root migrations. Their marker is
`$GSTACK_STATE_ROOT/.last-setup-version` (read from `~/.gstack` once for
installs that predate the move). It advances only past migrations that
succeeded; a failed migration stops the sequence, prints a `failed` row with
the retry command, and runs again on the next `./setup`. Install and host
migrations are tracked per install by the registry row's version.

### What setup changes on disk

Inventory of every setup side effect, by phase (line numbers are approximate):

| Phase | Writes | Scope |
|---|---|---|
| Build | `browse/dist`, `design/dist`, `make-pdf/dist`, `bin/gstack-cso-*` in the source checkout | source |
| Generation | `.agents/`, `.kiro/`, `.factory/`, `.opencode/`, `.cursor/`, `.copilot/`, `.agy/` renders in the source checkout; `gstack-patch-names` rewrites Claude `name:` fields in place | source |
| Chromium | Playwright cache (`~/.cache/ms-playwright`), lock under the state root | machine |
| Config | `skill_prefix`, `timeline_stop_hook`, team-mode keys in `$GSTACK_STATE_ROOT/config.yaml` | state root |
| Claude arm | `~/.claude/skills/gstack` link, one dir per skill with a `SKILL.md` link, alias copies | selected host |
| Codex arm | `${CODEX_HOME:-~/.codex}/skills/gstack` runtime root, `gstack-*` links into `.agents/skills`, `.agents/skills/gstack` sidecar | selected host |
| Kiro, Factory, OpenCode, Cursor, Copilot, Antigravity arms | the host's `skills/gstack` runtime root (built beside the live one and swapped in) and `gstack-*` links | selected host |
| OpenCode commands | `~/.config/opencode/commands/gstack-*.md` with a managed marker (#2629); user command files are never touched | selected host |
| Registry | one row per activated install in `installs.tsv` | state root |
| Migrations | whatever each `v*.sh` repairs; marker in the state root | state root |
| Claude hooks | `~/.claude/settings.json` (heal, SessionStart, plan-tune, Stop) — only when Claude is selected | Claude |
| gbrain | `gbrain-detection.json`; the Claude render in `$GSTACK_STATE_ROOT/render/claude` — only when Claude is selected | state root / Claude |

Activation today: on macOS and Linux every install is a set of symlinks into
the source checkout, so a `git pull` changes the active payload before setup
runs and "keep the prior payload" means "keep the prior checkout" — which the
upgrade skill does on the vendored path (`.bak` restore) and records on the
git path (`PRE_UPGRADE_COMMIT`). On Windows, where setup copies instead of
linking, every copy is staged as `<dst>.gstack-new.<pid>` and swapped in only
when complete; an interrupted swap is repaired on the next run (a missing
destination is restored from `<dst>.gstack-old.<pid>`). Versioned payload
directories for the symlink platforms are not built yet.

### Install-context render contract

Committed renders name each host's default install root. A render for any
other root (project install, `CLAUDE_CONFIG_DIR`, renamed checkout) is made
with `gen-skill-docs --host <h> --install-root <abs path> --out-dir <tmp>
--link-root <dir>`: every default-root path becomes the given root, and
resolvers see it as `TemplateContext.installRoot` (null keeps committed bytes).
Per-install renders live in `$GSTACK_STATE_ROOT/render/installs/<host>-<id>/`
(`<id>` keyed by the root's realpath) and are recorded in the registry's render
column. Setup makes one for a Claude install outside `~/.claude/skills/gstack`
(renamed checkout, project-vendored copy, `CLAUDE_CONFIG_DIR`) and a global Codex
install outside `~/.codex/skills/gstack` (`CODEX_HOME`); repo-local Codex installs
resolve their root at run time. A root that is not a plain path (whitespace,
shell metacharacters) is named through a `<host>-<id>.root` alias symlink:
worktree-isolated Claude Code refuses a command path containing a space in any
quoting.

## Host tiers and capabilities

Every host declares `tier` and `capabilities` (`scripts/host-config.ts`).
One vocabulary is used everywhere: `./setup --help`, setup and `--status`
rows, host errors, and the README host matrix, all checked against
`hosts/index.ts` by `test/host-config.test.ts`.

| Tier | Meaning |
|---|---|
| `full` | Installs, renders, passes the conformance kit, and has a dated certification record below. |
| `experimental` | Installs and renders and passes the conformance kit; no certification record yet. |
| `instruction-only` | No install arm. `./setup --host X` prints what to copy and changes nothing. |

Rendering alone never certifies `full`.

| Capability | Values | Used for |
|---|---|---|
| `toolExecution` | boolean | preambles and `bin/` helpers run |
| `questions` | `native` / `prose` | structured question tool vs plain-text questions |
| `planMode` | boolean | plan-mode transitions |
| `delegation` | boolean | sub-agents |
| `browser` | boolean (needs `toolExecution`) | gstack's browser |
| `safetyHooks` | `enforced` / `advisory` | `/careful`, `/freeze`, `/guard` block (Claude) or only warn |

Hosts with `safetyHooks: 'advisory'` get one line at the top of `/careful`,
`/freeze` and `/guard`: "not enforced on <host>: advisory, not blocked".

## Certify your host

1. Pass the conformance kit: `bun test test/host-conformance.test.ts` installs
   every installable host into a temp HOME, checks discovery directories, no
   other host's variant, no duplicates, `./setup --status`, and an upgrade from
   the previous release's install layout.
2. Run one representative workflow for real on the host (for example
   `/review` on a small diff), and an upgrade from an existing install.
3. Add a row below with the date, host version, gstack version, and where the
   transcript lives, then set `tier: 'full'`.

| Host | Date | Host version | gstack version | Evidence |
|---|---|---|---|---|
| claude | 2026-10-02 | Claude Code 2.1.284 (CI image pin) | v1.91.13.0 (1c54555) | gate-tier evals, real Claude Code sessions: https://github.com/garrytan/gstack/actions/runs/37033755821 |

Codex stays `experimental` until its periodic cases (`codex-discover-skill`,
`codex-review`) pass on the CI image's pinned Codex CLI and a row is added.

## GitHub Copilot CLI (#393)

Shipped as `experimental` (`hosts/copilot.ts`, `./setup --host copilot`):
skills in `~/.copilot/skills/gstack-*`, runtime root `~/.copilot/skills/gstack`
with a `.source-path` marker so `/gstack-upgrade` finds the checkout, names
prefixed `gstack-` (Copilot's built-in `/review` would win otherwise),
`disable-model-invocation: true` on sensitive skills, and a one-paragraph
tool-name glossary (`ask_user`, `exit_plan_mode`, `task`, `view`, `skill`)
inserted ahead of the preamble's STATUS rules. A shared directory was not
enough: Copilot CLI stopped reading `~/.claude/skills` in 1.0.36, gstack never
writes `~/.agents/skills`, and a Codex render carries Codex paths and the
Codex model profile.

Disposition of the community attempts:

| PR | Decision | Why |
|---|---|---|
| #2323 (@andrey-esipov) | Selectively reused, with credit | Kept: `~/.copilot/skills` and `.github/skills` roots, `copilot`-binary detection, `.source-path`, the `gstack-` prefix, the 1024-char description limit, uninstall coverage. Not kept: new schema fields and generator edits (predate `defineHost()`), an unguarded `rm -rf` of the runtime root (#2142), links to `setup`/`scripts`/Claude sources inside a recursively scanned dir, a test-only install backdoor in setup, and a blanket AskUserQuestion → `ask_user` rewrite. |
| #396 (@ridermw) | Rejected | Sed-rewrites Codex output into a shared `.agents/skills`; its E2E runner copies real `~/.copilot` credentials into a temp HOME. Its session scanner is a candidate for a later `/retro global` change. |
| #487 (@ridermw) | Rejected | Relies on `~/.claude/skills`, which Copilot CLI no longer reads. |
| #1852 (@lolisaigao1234) | Rejected | Detects `gh` instead of `copilot`, installs to a directory Copilot does not scan, links `bin` without `lib`. |

Unverified without a real Copilot CLI (why it is not `full`): autopilot may
answer `ask_user` itself, plan mode blocks mutating shell commands, symlinked
skill dirs need Copilot CLI 1.0.62 or later, and `COPILOT_HOME` other than
`~/.copilot` is refused for now.

## Antigravity CLI

Shipped as `experimental` (`hosts/agy.ts`, `./setup --host agy`, alias
`--host antigravity`) for Google's Antigravity CLI. The host is named after the
`agy` binary: with the longer name, the per-fence runtime prelude was 408 bytes
against its 400-byte budget (the global root is long); `agy` renders at
exactly 400, so the next byte added to that prelude must come with a budget
change. Verified against Google's docs on 2026-10-08:

| Fact | Value | Source |
|---|---|---|
| Global skills | `~/.gemini/antigravity-cli/skills/<skill>/SKILL.md` | [Agent skills](https://antigravity.google/docs/skills/) (CLI section), [Plugins & skills](https://antigravity.google/docs/cli/plugins/), [Migrating from Gemini CLI](https://antigravity.google/docs/cli/gcli-migration/) |
| Workspace skills | `.agents/skills/<skill>/SKILL.md` | same pages |
| Frontmatter | `name` (optional, defaults to the directory), `description` (required) | [Agent skills](https://antigravity.google/docs/skills/) |
| Description limit | 1024 characters (Agent Skills format) | [What are Agent Skills?](https://cloud.google.com/discover/ai-agent-skills) |
| Tool names | `run_command`, `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `grep_search`, `find_by_name`, `invoke_subagent`, `ask_question` | [Hooks: supported tools](https://antigravity.google/docs/hooks/) |
| Plan mode | `agy --mode=plan` / `/plan`, no exit-plan tool | [Execution modes](https://antigravity.google/docs/cli/modes/) |
| Binary | `agy`, installed to `~/.local/bin/agy`; config in `~/.gemini/antigravity-cli/` | [Installation](https://antigravity.google/docs/cli/install/), [Settings](https://antigravity.google/docs/cli/settings/) |

What the host does: skills in `~/.gemini/antigravity-cli/skills/gstack-*`,
runtime root `~/.gemini/antigravity-cli/skills/gstack` with `.source-path` for
`/gstack-upgrade`, `name:` equal to the `gstack-<skill>` directory (the CLI
turns each name into a slash command, and has `/plan`, `/diff`, `/skills` and
other built-ins), frontmatter limited to `name` and `description`, the Gemini
model overlay, and a one-paragraph tool glossary ahead of the preamble's STATUS
rules. The glossary also tells the agent to keep reading when `view_file`
returns only part of a long SKILL.md: users report a first read that stops at
800 lines ([forum](https://discuss.ai.google.dev/t/make-the-800-line-forced-first-read-in-view-file-configurable-or-opt-out/172257)),
which Google's docs do not state, so the rendered text names no number.

**Shared `~/.gemini`.** Antigravity CLI and Gemini CLI both live under
`~/.gemini`. Gemini CLI reads `~/.gemini/skills` (and `~/.agents/skills`);
Antigravity CLI reads `~/.gemini/antigravity-cli/skills`. Setup writes only
gstack entries in the latter, uninstall removes only gstack-managed entries
there, and `--host auto` selects Antigravity only for `agy` on `PATH` or an
existing `~/.gemini/antigravity-cli`, never for a bare `~/.gemini`.
`test/setup-install-registry.test.ts` holds both directions. Gemini CLI as a
host is not supported. Two overlaps remain: workspace `.agents/skills` is also
where a project-local Codex install puts its Codex-flavored `gstack-*`
skills, which Antigravity will list in that repo, and the Antigravity 2.0 app
and IDE read `~/.gemini/config/skills`, which this host does not install
(Google's codelab says that directory also reaches the CLI; the CLI docs do
not, so setup follows the CLI docs).

Disposition of the community attempts:

| PR | Decision | Why |
|---|---|---|
| #2134 (@0xshae) | Selectively reused, with credit | Kept: `agy` as the host name and binary, `.agents/skills` as the workspace root, and a `.agy` render directory separate from Codex's `.agents`. Not kept: the hand-written config (predates `defineHost()`), `~/.gemini/config/skills` as the CLI root, and the setup arm without the ownership gates. |
| #2893 (@ManchalaSashank) | Selectively reused, with credit | Kept: `agy`/`antigravity` as host name and alias in setup and generation, the Gemini overlay, uninstall coverage. Not kept: `~/.gemini/config/skills`, auto-detect on a bare `~/.gemini` (Gemini CLI's directory), `.gemini` as the render directory, and the repo-local `.gemini/skills` sidecar. |
| #2726 (@voipexpert) | Selectively reused, with credit | Kept: Antigravity's tool names from its own docs, and that `manage_task` (background processes) is not a to-do tool. Not kept: blanket tool-name rewrites (a preamble glossary replaces them) and suppressing outside reviews, which run through the shell. |
| #2244 (@KiDDarn) | Selectively reused, with credit | Kept: fail the install when no skill was linked. Not kept: the `~/.gemini/config/plugins` plugin layout (CLI plugins live under `~/.gemini/antigravity-cli/plugins` and are installed by `agy plugin install`), the benchmark provider work, and extra frontmatter fields. |
| #413 (@jnMetaCode) | Rejected | Installs to `~/.gemini/skills` and detects `gemini`: that is Gemini CLI. A comment there (@doogiehowzer) reported the partial `view_file` read the glossary now handles. |
| #2079 (@FACUTUCCI10) | Rejected | Gemini CLI paths (`~/.gemini/skills`). |
| #2187 (@NotArsal) | Rejected | Duplicate of #2134 without setup. |
| #1490 (@7H0M45-4N70NY) | Rejected | `~/.antigravity/skills`, which no Antigravity surface reads. |
| #565 (@ChetanTekur) | Rejected | Gemini CLI `GEMINI.md` support; Gemini CLI is out of scope. |

Unverified without a real Antigravity CLI (why it is not `full`): that the
CLI follows symlinked skill directories, that it does not import the runtime
root's extra markdown files (`ETHOS.md`, `review/*.md`) as skills, the
partial-read behavior of `view_file` on long skills, `ask_question` option
handling, and an upgrade from an existing install.

## Instruction-only hosts

OpenClaw, Hermes, Slate and GBrain have no install arm. Hermes stays
instruction-only until someone certifies a native install (#2826 measured one
on Hermes 0.21.0): `./setup --host hermes` prints the digest path and the
generator command, and the Hermes render writes `name: gstack-<skill>` so
Hermes, which indexes skills by frontmatter name, cannot shadow them (#2825).

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
├── copilot.ts       # GitHub Copilot CLI
├── agy.ts           # Google Antigravity CLI
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
- `generation`: no metadata file, `skipSkills: []` (both outside-review skills are enabled; Claude and Codex explicitly omit their own wrapper)
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
`CROSS_MODEL_RESOLVERS` (outside-provider review resolvers plus Review Army,
suppressed on hosts that opt out; Codex keeps outside reviews and suppresses
Review Army), `GBRAIN_RESOLVERS` (the default
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

# Verify output exists
ls .myhost/skills/gstack-*/SKILL.md

# Generate for all hosts (includes the new one)
bun run gen:skill-docs --host all

# Validate all host content and tracked output freshness, including the new host
bun run skill:check
# Claude install paths are rejected in prose; legitimate Bash fallbacks are allowed.
```

### 5. Run tests

```bash
bun test test/gen-skill-docs.test.ts
bun test test/host-config.test.ts
```

The parameterized smoke tests automatically pick up the new host. They verify: output exists, no path leakage, valid frontmatter,
freshness check passes, and outside-review skills match each host's exclusions.

### 6. Update README.md

Add install instructions for the new host in the appropriate section.

## Config field reference

See `scripts/host-config.ts` for the full `HostConfig` interface with JSDoc
comments on every field.

Key fields:

| Field | Purpose |
|-------|---------|
| `tier` | `full`, `experimental`, or `instruction-only` (see Host tiers) |
| `capabilities` | What the host runtime offers; rendering and docs must not claim more |
| `frontmatter.nameMatchesDirectory` | Write `gstack-<skill>` into `name:` for hosts that index by frontmatter name |
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
