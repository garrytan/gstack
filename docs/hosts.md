# Running gstack on other agents

The README has the host matrix: one row per agent with its tier, install
command and first invocation. This page has the rest: agent harnesses (OpenClaw,
Hermes, dots, QM, Muse Code, Grok and any other), how a checkout
decides which agents it renders for, the per-host notes, outside-review
providers, the Codex behavioral profile, model tiers, and the design binary's
models.

## Agent harnesses

Installing gstack inside an agent harness registers its skills the harness's
own way, in the same `./setup` run. `bin/gstack-harness` does the work and
`lib/harness-register.ts` holds one target per harness.

**When it is automatic.** `./setup` with no `--host` (or `--host auto`)
registers with the harness it runs inside: OpenClaw (its exec tool sets
`OPENCLAW_SHELL=exec`), Hermes (`HERMES_AGENT=true`) or a Dot (`HOME=/home/dot`
on a Dot's computer), or a harness found among setup's parent processes. It
prints every path it wrote and the command that removes them. An explicit
`--host claude` (or any other host) never writes under a harness folder, and
neither does `./setup --local`.
`./setup --no-harness-auto` or `GSTACK_HARNESS_AUTO=0` turns the automatic step off.

**What it writes.** Copies in the harness's own skills folder, never edits to
`openclaw.json`, Hermes's `config.yaml` or any context file you did not name.
A context block is opt-in: `gstack-harness register openclaw|hermes|generic
--context <file>` writes the marked block into that file only, after printing
the file and its scope (`profile` inside the harness's own home, else
`project`). Setup, upgrades and refresh never add one, a block you delete stays
deleted, a second `--context` file keeps the first (the ledger keys blocks by
file), and uninstall restores each file byte for byte. It refuses `SOUL.md`,
and for Hermes a new file that would outrank rules Hermes loads now
(`.hermes.md`/`HERMES.md` load before `AGENTS.md`): `HARNESS_CONTEXT_REFUSED`.
Every file goes into a ledger, `$GSTACK_STATE_ROOT/harness/<id>.ledger`, with
its sha256. Registering again changes only what changed; a folder or skill name
gstack did not write stops it (`HARNESS_UNOWNED_ENTRY`); `gstack-uninstall`
and `gstack-harness unregister` remove exactly the ledger's files, never
through a symlink, and rename any file you edited to `<file>.edited-<time>`
beside itself, where uninstall cannot take it. A context block is cut only
when it is the one gstack wrote; an edited block is left for you. `./setup
--refresh-registered` (what `/gstack-upgrade` runs) refreshes every registration.
`gstack-harness status` lists them and runs the harness's own skill list where
it has one (`visible to harness: yes`). Errors: [troubleshooting](troubleshooting.md#agent-harnesses-gstack-harness).

**Registered, listed, used.** These are three separate facts, and this page
claims only the first two. *Registered*: gstack's files are in the harness's
skills folder and its ledger (`gstack-harness status`). *Listed*: the harness
puts the skill in the skills section of the model's prompt (`visible to
harness: yes`, from the harness's own skill list). *Used*: in a task that fits,
the model opens the matching skill and runs its first step. Use rates are
pending HARN-5's fixed panel (OpenClaw and Hermes chat mode, five trials per
cell). When they land they are measured under the eval adapter's
`GSTACK_SESSION_KIND=spawned` marker, which auto-decides gstack's questions, so
they say nothing yet about interactive sessions. Two levers aim at use:
each router line opens with the skill's own trigger sentence ("Use when asked
to ..."), and each Hermes description opens with a trigger list of at most 57
characters, the part of a description Hermes's skills index shows.

| Harness | What gstack registers | Install | Verify | Remove |
|---|---|---|---|---|
| OpenClaw | default `--skills hybrid`: `gstack-review`, `gstack-investigate`, `gstack-qa`, `gstack-ship` and `gstack-plan-eng-review` as top-level skills plus one `gstack` router skill whose body lists every other skill and its path, in `${OPENCLAW_STATE_DIR:-~/.openclaw}/skills`. With OpenClaw 2026.10.6's 19 eligible bundled skills, hybrid's skills section is 10,290 characters, full format, under its 18,000-character budget; `--skills all` (17,971, compact format, descriptions cut) lists every skill as its own folder, `--skills router` (6,701) only the router. OpenClaw serves a registered skill's `SKILL.md` whole or refuses it ("Skill instructions cannot be partially served"), at most 32,768 bytes when its model catalog has no context window for the model and 32,000 characters with a 100K-200K-token window, so any registered skill over 32,000 bytes (four of the five in hybrid, 26 of 63 in `all` today) is a short entry `SKILL.md` with the same name and description that sends the agent to its full `SKILL.md` in a plain copy of every skill (the router's `gstack/skills/`, or `.gstack-skills/` under `--skills all`, a folder OpenClaw's skill scan skips), which OpenClaw reads in pages. A context window under 100K tokens lowers that budget to 16,000 characters, which this limit does not cover | `./setup --host openclaw`, or `./setup` inside OpenClaw | `openclaw skills list --json` shows `gstack` and the five task skills (source `openclaw-managed`, eligible) | `gstack-harness unregister openclaw` |
| Hermes | every skill, as `gstack-<skill>` in one `gstack` category, in `${HERMES_HOME:-~/.hermes}/skills/gstack`. Hermes's skills index lists only skills registered as folders, so a router would leave the rest out of the listing (`skill_view` still loads an unlisted skill by name, but nothing tells the model it exists) | `./setup --host hermes`, or `./setup` inside Hermes | `hermes skills list` shows the `gstack-*` skills in category `gstack` | `gstack-harness unregister hermes` |
| dots (feder-cr) | the `gstack` router in `/home/dot/skills/gstack`, which the Dot lists every turn | `./setup` on the Dot's computer, or `gstack-harness register dots` | the Dot's Skills page, or `GET /skills` | `gstack-harness unregister dots` |
| QM | **not available yet.** QM imports a skill pack by cloning the whole repository and caps it at 32 MiB and 5,000 files; gstack's repository is about 73 MiB, so `gstack-harness register qm --yes` stops before sending anything ([why](troubleshooting.md#harness-qm-pack-too-large)) | meanwhile, paste `gstack-harness register generic --print` into the agent's instructions | ask it for a gstack skill | delete the pasted text |
| Muse Code, Grok Build | nothing: both read `~/.claude/skills`, so the Claude install (`./setup`) is what they see, with Claude tool names | `./setup` | `gstack-harness status` runs `muse skills list` / `grok inspect` and reports *discovered (Claude-rendered, unverified)* | `gstack-uninstall` |
| Grok Bot, any chat-only skill library | nothing on disk | `gstack-harness register generic --print`, then paste the router and block into the app | ask it for a gstack skill | delete the pasted text |
| any other harness | the router in an Agent Skills folder you name, and/or a 600-byte routing block between `<!-- gstack:begin harness-routing -->` markers in a context file you name | `gstack-harness register generic --skills-dir <dir>` and/or `--context <file>`; `gstack-harness manifest generic` prints every skill as JSON | the harness's own skill list | `gstack-harness unregister generic` |

OpenClaw's ACP route below is unchanged: native registration gives OpenClaw's
own agent gstack's skills; ACP spawns Claude Code with the full install.

## OpenClaw

OpenClaw spawns Claude Code sessions via ACP, so every gstack skill just works
when Claude Code has gstack installed. Paste this to your OpenClaw agent:

> Install gstack: run `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` to install gstack for Claude Code. Then add a "Coding Tasks" section to AGENTS.md that says: when spawning Claude Code sessions for coding work, tell the session to use gstack skills. Include these examples — security audit: "Load gstack. Run /cso", code review: "Load gstack. Run /review", QA test a URL: "Load gstack. Run /qa https://...", build a feature end-to-end: "Load gstack. Run /autoplan, implement the plan, then run /ship", plan before building: "Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement."

**After setup, just talk to your OpenClaw agent naturally:**

| You say | What happens |
|---------|-------------|
| "Fix the typo in README" | Simple — Claude Code session, no gstack needed |
| "Run a security audit on this repo" | Spawns Claude Code with `Run /cso` |
| "Build me a notifications feature" | Spawns Claude Code with /autoplan → implement → /ship |
| "Help me plan the v2 API redesign" | Spawns Claude Code with /office-hours → /autoplan, saves plan |

See [docs/OPENCLAW.md](OPENCLAW.md) for advanced dispatch routing and
the gstack-lite/gstack-full prompt templates.

## Native OpenClaw Skills (via ClawHub)

Four methodology skills that work directly in your OpenClaw agent, no Claude Code
session needed. Install from ClawHub:

```
clawhub install gstack-openclaw-office-hours gstack-openclaw-ceo-review gstack-openclaw-investigate gstack-openclaw-retro
```

| Skill | What it does |
|-------|-------------|
| `gstack-openclaw-office-hours` | Product interrogation with 6 forcing questions |
| `gstack-openclaw-ceo-review` | Strategic challenge with 4 scope modes |
| `gstack-openclaw-investigate` | Root cause debugging methodology |
| `gstack-openclaw-retro` | Weekly engineering retrospective |

These are conversational skills. Your OpenClaw agent runs them directly via chat.

## Which agents a checkout renders for

An explicit `--host X` installs for X only and never changes another agent's
install. `/gstack-upgrade` refreshes every install it registered, one row per
host, and says which ones failed.

A checkout carries skills only for the agents installed from it. Setup records
them in `.gstack-installed-hosts` and never drops one, so adding an agent later
is just `./setup --host <name>`. Copies rendered for other agents are pruned:
generated files move to `~/.gstack/backups/host-renders/`, and files gstack
can't prove it generated stay where they are. A global Claude install went
from 632 `SKILL.md` files (34.7 MB) to its own 63 (2.5 MB), which keeps Cursor-agent
from freezing on the skills tree (#1694). In a development checkout,
`bun run build` still renders every agent; inside an install it renders the
recorded ones, and `GSTACK_RENDER_HOSTS=all bun run build` renders them all.

## Per-host notes

Copilot invokes gstack skills by their prefixed names (`/gstack-review`) because
`/review` is a Copilot built-in. Copilot ignores skill hooks, so `/careful` and
`/freeze` only advise there, and `COPILOT_HOME` other than `~/.copilot` is not
supported yet (setup refuses and changes nothing).

Antigravity CLI also invokes skills by prefixed name (`/gstack-review`). Setup
writes only `~/.gemini/antigravity-cli/skills/gstack*`: Gemini CLI's
`~/.gemini/skills` and settings are never touched, and `--host auto` selects
Antigravity only when `agy` is on `PATH` or `~/.gemini/antigravity-cli` exists,
never for a Gemini-CLI-only `~/.gemini`. The Antigravity 2.0 app and IDE read
`~/.gemini/config/skills`, which this host does not install.

Outside reviews require the selected CLI to be installed and authenticated: Claude Code when using gstack in Codex, or Codex on other harnesses. External harnesses discover these commands as `/gstack-claude-code` and `/gstack-codex`; each harness omits its own wrapper. Explicit provider requests keep that provider. The existing `codex_reviews` setting controls automatic outside reviews where supported, regardless of the provider selected.

`/claude` has been renamed to `/claude-code`. Re-run `./setup --host <name>` to migrate managed installations, including other harnesses sharing the checkout. Setup preserves the previous installation if replacement generation or installation fails and prints repair instructions.

## Instruction-only agents

**Instruction-only tier (any rules-reading agent that loads no skills — Zed, Amp, Jules, side projects):**
copy the 2KB digest at [`agents-digest/gstack-AGENTS.md`](../agents-digest/gstack-AGENTS.md)
into a location your agent reads (for example, append it to your project's `AGENTS.md`).
It carries gstack's ethos, reuse ladder, and voice rules — no install required. The
digest's first line shows its gstack version; re-copy it after upgrading.

## Codex: the behavioral profile and model selection

For Codex, setup reads the top-level `model` from
`${CODEX_HOME:-~/.codex}/config.toml` and generates the matching behavioral
profile, falling back to `gpt-6-astra` when no usable model is configured.
`gpt-5.6-sol` automatically receives bounded-scope instructions that
finish the requested lake without expanding into adjacent cleanup or speculative
hardening. The Sol profile is exact-match only: dated snapshots and other 5.6
variants get the generic GPT profile, and setup warns on near-misses like
`gpt-5.6-sol-2026-08-01`. Override detection with `./setup --host codex --model <id>` — the
override applies to that run only; set `model` in your Codex `config.toml` to
make it stick across upgrades. After changing your Codex model, rerun
`./setup --host codex` to regenerate the skills.

**Plan-review and implementation tiers.** Plan workflows use an independent
`frontier` reviewer: Fable 5.1 from Codex, or GPT-6 Astra from Claude Code.
Implementation handoffs recommend the `smart` tier: Opus 5.5 or GPT-6.1 Sol.
Choose a different tier, pin either provider's model, or use `host` mode to
preserve native model settings. The read-only `gstack-models` command explains
the effective choices; changing these settings does not require regenerating
skills or switch your running session. A weekly maintenance check flags changed
official recommendations and retirement notices without automatically changing
models. See [model policy: setup, overrides and freshness](model-policy.md).

**Other Codex calls keep their existing selection.** Without the explicit
`plan-review` role (including ordinary review and ship adversarial passes), gstack picks the model in this
order: a model you name for that request, then `GSTACK_CODEX_MODEL`, then
`model` in your Codex `config.toml` (for native `codex review`, `review_model`
first; a custom `CODEX_HOME` is honored), and only then gstack's default,
`gpt-6-astra`. Before spending anything, it prints the choice and where it came
from, for example `CODEX_MODEL: gpt-5.6-terra (exec; source: ~/.codex/config.toml model)`.
If your choice is invalid or your account cannot use it, gstack stops with a
repair message and reports the outside review as unavailable. It never silently
switches to its default. Nested Codex reviews also run with installed skills
hidden (`-c skills.include_instructions=false`), so a review cannot turn into a
whole nested skill run. Runtime model selection is separate from the setup-time
behavioral profile above. Without the plan-review role, `/claude-code` (`gstack-claude-code`
on Codex) preserves Claude's configured model. Set `GSTACK_CLAUDE_MODEL=<model>`
or name a model in your request to override it for the invocation, including
resumed consultations. See [eval defaults and overrides](../CONTRIBUTING.md#testing--evals)
for capture, judge, and benchmark model selection.

## The design binary's models

The design binary (`$D`) uses OpenAI's `gpt-5.5` by default, with image
generation through `gpt-image-2`. Set `GSTACK_DESIGN_MODEL=<model>` to use
another gpt-5-class model for both image generation and screenshot analysis;
if OpenAI rejects it, the error names `GSTACK_DESIGN_MODEL`. Set
`GSTACK_DESIGN_IMAGE_MODEL=<gpt-image model>` to change the image tool model; a
value that is not a gpt-image model name is refused before any request. Check a
key against the defaults with `bun run design/scripts/live-model-check.ts`,
which always tests the default models and ignores both overrides; the weekly
periodic census runs the same check. Set `OPENAI_BASE_URL` to send every `$D`
call to an OpenAI-compatible gateway instead of `api.openai.com`; egress
receipts record the gateway host. On Codex, `/design-shotgun` generates mockups
with Codex's built-in `$imagegen` skill instead, so it needs no
`OPENAI_API_KEY`; `$D` still builds and serves the comparison board.

## Adding a host

**Want to add support for another agent?** See [docs/ADDING_A_HOST.md](ADDING_A_HOST.md).
Rendering a new agent is one TypeScript config file; installing it also needs a
setup arm and the conformance kit, and it starts as experimental.
