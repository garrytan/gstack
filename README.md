```
   ___                ___  _             _   
  / __\__ ___   _____/ __\| |_ __ _  ___| | __
 / /  / _` \ \ / / _ \__ \| __/ _` |/ __| |/ /
/ /__| (_| |\ V /  __/___) | || (_| | (__|   < 
\____/\__,_| \_/ \___|____/ \__\__,_|\___|_|\_\
```

> AI talk too much. CaveStack fix.

![same /review, same patch, different default](docs/images/sidebyside-review.png)

*Left: default verbose `/review`. Right: CaveStack `/review`, same patch. Same findings. ~250 words vs ~40.*

---

## What This

Fork of [gstack](https://github.com/garrytan/gstack). Caveman mode = default. Every response: short, direct, no fluff. Same 40 skills. Same power. 75% fewer words.

Other AI tools: walls of text. Filler words. "I'd be happy to help you with that." Apologies for things that aren't wrong. Summaries of what you just said back to you.

CaveStack: answer. Done.

## Install (30 grunt)

Need [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [bun](https://bun.sh/) v1.0+, [Node.js](https://nodejs.org/), Git.

```bash
git clone https://github.com/JerkyJesse/cavestack.git ~/.claude/skills/cavestack
cd ~/.claude/skills/cavestack && ./setup
```

Open new Claude Code session. Caveman mode active. No `/caveman` needed. Just works.

## What You Get

| Thing | What It Do |
|-------|-----------|
| 40 skills | `/review`, `/ship`, `/qa`, `/investigate`, `/office-hours`, `/cso`... all work |
| Caveman default | No command needed. First response = terse. Automatic. |
| Intensity dial | `/caveman lite` (gentle), `full` (default), `ultra` (maximum grunt) |
| Windows-first | Bun compiles, Git Bash symlinks, PowerShell statusline. All work. |
| Reversible | `cavestack-uninstall`. Clean removal. Your files untouched. |
| Headless browser | `/browse` for QA, screenshots, page testing. Built in. |
| Design tools | `/design-consultation`, `/design-review`, `/design-shotgun` |
| Security audit | `/cso` — OWASP Top 10 + STRIDE threat modeling |

## Before / After

| Verbose Claude | CaveStack Claude |
|---------------|-----------------|
| "I'd be happy to help you with that! Let me take a look at your code..." | *[reads code]* |
| "The issue appears to be related to the authentication middleware where the token expiry check is using a less-than operator instead of less-than-or-equal-to..." | "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:" |
| "Sure! I'll analyze the changes and provide a comprehensive review..." | *[reviews diff, reports findings]* |
| 47 lines explaining what it's about to do | 5 lines doing it |

## Why Fork, Not Plugin

Default behavior win. Every opt-in terse workaround — `/caveman` plugin, `be terse` in CLAUDE.md, hand-written prompts — require user to remember. They don't. Tool stay verbose. Senior eng close window, go back to grepping.

Only way change default = fork framework, ship terse as baseline.

Also: caveman need fire *before* first prompt. Need SessionStart hook owned by install. Fork own that. Plugin can't.

## Caveman Control

```bash
# During session:
stop caveman          # back to verbose (why though)
normal mode           # same thing
/caveman              # re-enable (default: full)
/caveman lite         # gentle compression
/caveman full         # classic caveman
/caveman ultra        # maximum grunt. fragments only.
```

```bash
# Permanent:
cavestack-settings-hook remove-caveman   # disable hooks entirely
cavestack-settings-hook install-caveman  # re-enable
```

## All Skills

```
/review          code review your diff
/ship            test, review, version, push, PR
/qa              QA test site + fix bugs
/investigate     systematic root-cause debugging
/office-hours    brainstorm ideas, startup diagnostic
/cso             security audit (OWASP + STRIDE)
/design-review   visual QA + fix loop
/browse          headless browser commands
/retro           weekly engineering retrospective
/codex           second opinion from OpenAI Codex
/plan-ceo-review     CEO-mode plan review
/plan-eng-review     architecture + test review
/plan-design-review  UI/UX design review
/autoplan        run all reviews in sequence
/checkpoint      save/resume work state
/health          code quality dashboard
...and 25 more. Full list: /caveman-help
```

## Trouble?

**Skill not show up?** `cd ~/.claude/skills/cavestack && ./setup`

**`/browse` fail?** `cd ~/.claude/skills/cavestack && bun install && bun run build`

**Stale install?** `/cavestack-upgrade` — or `auto_upgrade: true` in `~/.cavestack/config.yaml`.

**Caveman not fire on new session?** Check `~/.claude/settings.json` has `hooks.SessionStart` pointing at `caveman-activate.js` and `hooks.UserPromptSubmit` pointing at `caveman-mode-tracker.js`. Re-register: `cavestack-settings-hook install-caveman`. Need Node.js on PATH — hooks run under Node, not Bun.

**Windows?** Works on Windows 10/11 via Git Bash or WSL. Both `bun` and `node` on PATH. Bun has known Playwright pipe issue ([bun#4253](https://github.com/oven-sh/bun/issues/4253)), `browse` falls back to Node for server.

**`./setup` build error on Windows?** Known upstream glob issue in `browse/scripts/build-node-server.sh`. Main binaries still build. Non-blocking.

**Claude can't see skills?** Add cavestack section to project's `CLAUDE.md`. `/office-hours` does this automatically on first run.

**Bug?** [github.com/JerkyJesse/cavestack/issues](https://github.com/JerkyJesse/cavestack/issues) — include OS, `bun --version`, `node --version`, exact error.

## Uninstall

```bash
~/.claude/skills/cavestack/bin/cavestack-uninstall
```

Remove symlinks, hooks, state. Your files untouched.

## Credit

MIT. Upstream: [gstack](https://github.com/garrytan/gstack). Caveman hooks: [Julius Brussee](https://github.com/JuliusBrussee/caveman). This fork: [JerkyJesse](https://github.com/JerkyJesse). See [LICENSE](LICENSE).

---

<details>
<summary>Want verbose README? (weak, but available)</summary>

### What is CaveStack?

CaveStack is a fork of gstack that ships with "caveman mode" enabled by default. Caveman mode compresses AI responses by approximately 75% without losing technical accuracy. Instead of opting into terse responses, CaveStack makes them the default behavior.

### Why does this exist?

Every AI coding tool ships with verbose output as the default. Users who prefer concise responses must remember to configure terse mode each session. Most don't. CaveStack solves this by forking the framework and making terse the baseline.

### Installation

CaveStack requires Claude Code, Bun v1.0+, Node.js, and Git. Clone the repository to your Claude skills directory and run the setup script. After setup, open a new Claude Code session and caveman mode will be active automatically.

### Features

CaveStack includes all 40 skills from the upstream gstack framework, including code review, shipping workflows, QA testing, security audits, design tools, and debugging utilities. It adds always-on caveman mode with three intensity levels (lite, full, ultra), Windows-first installation support, and a fully reversible uninstall process.

</details>
