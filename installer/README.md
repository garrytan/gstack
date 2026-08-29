# `@garrytan/gstack` — installer CLI

Interactive installer for [gstack](https://github.com/garrytan/gstack), Garry Tan's Claude Code skill pack and workflow tooling.

## Usage

```bash
# Zero-friction: interactive wizard
npx @garrytan/gstack

# Scripted: verb-based subcommands
npx @garrytan/gstack install --host claude,codex
npx @garrytan/gstack install --local           # vendored (deprecated — prefer team mode)
npx @garrytan/gstack init --tier required
npx @garrytan/gstack upgrade
npx @garrytan/gstack uninstall --project --yes
npx @garrytan/gstack uninstall --local --yes    # remove vendored project install
npx @garrytan/gstack doctor
npx @garrytan/gstack status
npx @garrytan/gstack list
npx @garrytan/gstack disable /qa
npx @garrytan/gstack enable /qa
```

Works with `npx`, `bunx`, and `pnpm dlx`.

## What it does

**`install`** — clones gstack into `~/.claude/skills/gstack`, builds the browse/design binaries via `bun`, registers with your chosen AI hosts (Claude Code, Codex, Factory Droid, OpenCode, Kiro), and inserts a `<!-- gstack:begin -->` / `<!-- gstack:end -->` block into `~/.claude/CLAUDE.md` documenting the available skills.

**`install --local`** — vendored mode: installs gstack into `<cwd>/.claude/skills/gstack` instead of the home directory. Everything stays inside the project. **Deprecated upstream** in favor of team mode (`init`) because vendoring means no cross-project auto-update and ~100MB duplicated per project. Exposed here because `./setup --local` still supports it. Claude Code only (other hosts skipped).

**`init`** — runs inside a git repo. Installs globally if needed, enables team mode (the SessionStart auto-update hook), runs `gstack-team-init <tier>` to bootstrap the repo, and stages/commits the changes. Teammates get gstack automatically on their next session.

**`uninstall`** — removes the install and walks every host's skills directory (`~/.claude/skills`, `~/.codex/skills`, `~/.factory/skills`, `~/.config/opencode/skills`, `~/.kiro/skills`) removing any symlink or directory whose `SKILL.md` points into the gstack install. Cleans the CLAUDE.md block and scrubs the PreToolUse hook from project `settings.json`. `~/.gstack/` (session state) is preserved.

**`upgrade`** — `git fetch` + hard reset to `origin/main` in `~/.claude/skills/gstack`, then re-runs `./setup --host auto` to rebuild and re-link.

**`doctor`** — checks git, bun, install state, binary freshness, skill count, and per-host registration. Exit code 1 if any check fails.

**`status`** — one-screen summary: version, install path, team mode, auto-upgrade, skill prefix mode, per-host registration, per-project disabled-skills list.

**`list`** — enumerates installed skills with descriptions parsed from each `SKILL.md` frontmatter.

**`enable <skill>` / `disable <skill>`** — toggle skills per-project via `.claude/settings.local.json`'s `disabledSkills` array. Names can be `qa`, `/qa`, or `gstack-qa` — all normalize to the same entry.

## Requirements

- Node.js 18+ (for the installer itself)
- [bun](https://bun.sh/) 1.0+ (for building gstack binaries)
- git
- bash (Windows: Git Bash or WSL)

## Philosophy

The installer is a thin wrapper around gstack's existing [`./setup`](https://github.com/garrytan/gstack/blob/main/setup) bash script — no logic is duplicated. This keeps the installer small, auditable, and guaranteed to stay in sync with upstream. If `setup` learns a new flag, the installer picks it up by exposing a new option.

## Development

```bash
cd installer
npm install
npm run build        # compile TS to dist/
npm start -- --help  # run the built CLI

# Watch mode
npm run dev

# Smoke test locally
npm link
gstack --help
```

To test without publishing:

```bash
# From anywhere, use the local checkout:
npx /absolute/path/to/gstack/installer install
```

## License

MIT — same as gstack.
