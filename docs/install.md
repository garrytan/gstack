# Install details

The README covers the two-step install. This page holds the details: what
setup needs and how long it takes, the team-mode hook, the hooks setup
registers in Claude Code, agent harness registration, and how to remove gstack.

## How long setup takes

`./setup` took 31 seconds after the clone on a 4-vCPU Linux cloud machine (v1.91.13.0, clean HOME, including the binary build and the Chromium download). Slower networks and laptops take longer.

## Requirements, in detail

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.4.2+ (the tested version; setup refuses Bun older than 1.3.3, which would let compiled tools read a project's `.env`, and warns in between), [Node.js](https://nodejs.org/) (Windows only). **Recommended on macOS:** the [Aside](https://aside.com) browser (macOS 15+) — browser skills, `/make-pdf`, and `/diagram` drive it first, with your real logged-in sessions. Without it, `./setup` builds gstack's own bundled browser and the same skills use that. `/cso` additionally needs a Bun release with all four `--no-compile-autoload-*` build flags plus a native toolchain: a static-capable C compiler on Linux, Xcode command-line tools on macOS, or Visual Studio 2022 Build Tools with Desktop development with C++ on Windows. If those are absent, setup installs everything else, removes stale CSO helpers, and `/cso` reports `not assessed` with the prerequisite.

When qualified CSO runtime images are published, setup gives each automatic preload a 30-second window plus a bounded setup allowance for the declared catalog. For slower registries, set an integer such as `GSTACK_CSO_IMAGE_PULL_TIMEOUT_SECONDS=120` (accepted range: 5–300 seconds). One image timing out does not consume the remaining images' windows; setup reports partial progress and a later run resumes from exact digests already present in local Docker. The complete preload is capped at one hour.

## Team mode

From inside your repo, `(cd ~/.claude/skills/gstack && ./setup --team) && ~/.claude/skills/gstack/bin/gstack-team-init required` switches you to team mode and bootstraps the repo so teammates get gstack automatically (the README has the full paste, which also commits the change).

No vendored files in your repo, no version drift, no manual upgrades. Every Claude Code session starts with a fast auto-update check (throttled to once/hour, network-failure-safe, completely silent). Team mode follows the `stable` channel, as every new install does: the tagged release cut Monday and Thursday mornings, never more than once every 72 hours except for an important change (within about a day) or a security or regression fix, and never more than a week stale, not every merge to main. `gstack-config set update_channel main` follows every merge instead; see [releases.md](releases.md#channels).

Swap `required` for `optional` if you'd rather nudge teammates than block them.

`required` blocks skills with a hook that runs on [Node.js](https://nodejs.org/), so every teammate needs Node.js on PATH, on every OS. With Claude Code 2.1.295 or later the hook also blocks when it can't run (no Node.js, or a missing `.claude/hooks/check-gstack.cjs`); older Claude Code lets skills through in that case.

## Hooks that `./setup` registers

`./setup` registers up to three hook families in `~/.claude/settings.json`, every one pointing at the canonical install. In team mode it registers the `SessionStart` auto-update hook (`gstack-session-update`; `./setup --no-team` skips it). It asks before registering the AskUserQuestion `PreToolUse` (preference enforcement) and `PostToolUse` (deterministic answer capture) hooks that `/plan-tune` uses at runtime; `./setup` never writes them silently. `docs/uninstall.md` lists the same families when telling you what to remove by hand.

`./setup` also registers one default-on Stop hook:
`gstack-timeline-stop` (closes dangling session-timeline entries when a session
is interrupted; fail-open — 2s internal budget, always exits 0, can never block
a session). Opt out persistently with `./setup --no-timeline-stop-hook` — the
choice lands in the `timeline_stop_hook` config key, survives upgrades, and an
explicit "no" removes a live registration. `GSTACK_TIMELINE_STOP_HOOK=no` and
`gstack-config set timeline_stop_hook no` work too (flag > env > config).
`./setup --no-team` skips it for that run, `gstack-settings-hook remove-source
--source gstack-timeline-stop` removes it by hand, and `gstack-uninstall`
removes it too.

Hook registration is canonical-only: every hook command points at the stable
`~/.claude/skills/gstack` install, never the tree setup ran from, so deleting
a worktree or Conductor workspace can't leave dead hooks erroring in your
sessions. Every `./setup` run also heals first: `gstack-settings-hook
prune-stale --repoint` removes dead gstack hook entries, re-points stale ones
at the stable install, and collapses duplicates, printing one line (and
writing a backup beside the file) only when it changed something.

## Agent harnesses

Run inside OpenClaw, Hermes or a Dot, `./setup` also registers gstack's skills
with that harness, in the harness's own skills folder, and prints every path
it wrote. It never does this when `--host` names another host or with
`--local`. Turn it off with `./setup --no-harness-auto` or
`GSTACK_HARNESS_AUTO=0`. Per-harness details, any other harness, and why QM is not available yet: [hosts.md](hosts.md#agent-harnesses).

## Uninstall

See [uninstall.md](uninstall.md).
