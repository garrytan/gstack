---
name: pair-agent
description: Use when pair a remote ai agent with your browser. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/pair-agent/SKILL.md
---
## When to Use

One command generates a setup key and
prints instructions the other agent can follow to connect. Works with OpenClaw,
Hermes, Codex, Cursor, or any agent that can make HTTP requests. The remote agent
gets its own tab with full page access by default (the pairing ceremony is the
trust boundary; --restrict narrows it).
Use when asked to "pair agent", "connect agent", "share browser", "remote browser",
"let another agent use my browser", or "give browser access".

Voice triggers (speech-to-text aliases): "pair agent", "connect agent", "share my browser", "remote browser access".

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Decision-Brief Format

_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

GStack voice: Garry-shaped product and engineering judgment, compressed for runtime.

- Lead with the point. Say what it does, why it matters, and what changes for the builder.
- Be concrete. Name files, functions, line numbers, commands, outputs, evals, and real numbers.
- Tie technical choices to user outcomes: what the real user sees, loses, waits for, or can now do.
- Be direct about quality. Bugs matter. Edge cases matter. Fix the whole thing, not the demo path.
- Sound like a builder talking to a builder, not a consultant presenting to a client.
- Never corporate, academic, PR, or hype. Avoid filler, throat-clearing, generic optimism, and founder cosplay.
- No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant.
- The user has context you do not: domain knowledge, timing, relationships, taste. Cross-model agreement is a recommendation, not a decision. The user decides.

Good: "auth.ts:47 returns undefined when the session cookie expires. Users hit a white screen. Fix: add a null check and redirect to /login. Two lines."
Bad: "I've identified a potential issue in the authentication flow that may cause problems under certain conditions."

## Context Recovery

At session start or after compaction, recover recent project context.

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)"
_PROJ="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  if [ -f "$_PROJ/decisions.active.json" ]; then
    echo "--- ACTIVE DECISIONS (recent, scope-relevant) ---"
    ~/.hermes/skills/gstack/# session_search tool --recent 5 2>/dev/null
    echo "--- END DECISIONS ---"
  fi
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, read the newest useful one. If `LAST_SESSION` or `LATEST_CHECKPOINT` appears, give a 2-sentence welcome back summary. If `RECENT_PATTERN` clearly implies a next skill, suggest it once.

**Cross-session decisions.** If `ACTIVE DECISIONS` are listed, treat them as prior settled calls with their rationale — do not silently re-litigate them; if you're about to reverse one, say so explicitly. Reach for `~/.hermes/skills/gstack/# session_search tool` whenever a question touches a past decision ("what did we decide / why / did we try"). When you or the user make a DURABLE decision (architecture, scope, tool/vendor choice, or a reversal) — NOT a turn-level or trivial choice — log it with `~/.hermes/skills/gstack/# memory tool` (`--supersede <id>` for a reversal). Reliable and local; gbrain not required.

## Writing Style (skip entirely if `EXPLAIN_LEVEL: terse` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at `~/.hermes/skills/gstack/scripts/jargon-list.json` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the `terms` array as the canonical list. The list is repo-owned and may grow between releases.


## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include `Completeness: X/10` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: `Note: options differ in kind, not coverage — no completeness score.` Do not fabricate scores.

## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.

## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## How it works

Your gstack browser runs a local HTTP server. This skill creates a one-time setup key,
prints a block of instructions, and you paste those instructions into the other agent.
The other agent exchanges the key for a session token, creates its own tab, and starts
browsing. Each agent gets its own tab. They can't mess with each other's tabs.

The setup key expires in 5 minutes and can only be used once. If it leaks, it's dead
before anyone can abuse it. The session token lasts 24 hours.

**Same machine:** If the other agent is on the same machine (like OpenClaw running
locally), you can skip the copy-paste ceremony and write the credentials directly to
the agent's config directory.

**Remote:** If the other agent is on a different machine, you need an ngrok tunnel.
The skill will tell you if one is needed and how to set it up.

## Step 1: Check prerequisites

```bash
terminal status 2>/dev/null
```

If the browse server is not running, start it:

```bash
terminal goto about:blank
```

This ensures the server is up and healthy before pairing.

## Step 2: Ask what they want

Use AskUserQuestion:

> Which agent do you want to pair with your browser? This determines the
> instructions format and where credentials get written.

Options:
- A) OpenClaw (local or remote)
- B) Codex / OpenAI Agents (local)
- C) Cursor (local)
- D) Another Claude Code session (local or remote)
- E) Something else (generic HTTP instructions — use this for Hermes)

Based on the answer, set `TARGET_HOST`:
- A → `openclaw`
- B → `codex`
- C → `cursor`
- D → `claude`
- E → generic (no host-specific config)

## Step 3: Local or remote?

Use AskUserQuestion:

> Is the other agent running on this same machine, or on a different machine/server?
>
> **Same machine** skips the copy-paste ceremony. Credentials are written directly to
> the agent's config directory. No tunnel needed.
>
> **Different machine** generates a setup key and instruction block. If ngrok is
> installed, the tunnel starts automatically. If not, I'll walk you through setup.
>
> RECOMMENDATION: Choose A if the agent is local. It's instant, no copy-paste needed.

Options:
- A) Same machine (write credentials directly)
- B) Different machine (generate instruction block for copy-paste)

## Step 4: Execute pairing

**Live-daemon consent (one-way door).** Pairing can relaunch the browser
daemon; a relaunch KILLS the running headless daemon — open tabs, cookies,
and logged-in sessions die with it. The CLI honors the iron rule (only an
explicit `--force-restart` may kill a live daemon), so check first:

```bash
terminal status 2>/dev/null | head -5
```

If a daemon is running, ask via AskUserQuestion (one-way door — lost
tabs/cookies/logins cannot be recovered):

> "A headless browser daemon is live (tabs and logins may be active). Pairing
> headed requires relaunching it — everything in the current daemon is lost.
>
> RECOMMENDATION: Choose B unless the remote agent specifically needs a
> visible browser window; pairing works against the existing daemon."

Options:
- A) Relaunch (pass `--force-restart`; current tabs/cookies/logins are lost)
- B) Keep the live daemon (recommended — pair against it as-is)

Only pass `--force-restart` to the commands below after an explicit A. Never
default to A on a vague reply — this is a destructive confirmation.

### If same machine (option A):

Run pair-agent with --local flag:

```bash
terminal pair-agent --local TARGET_HOST
```

Replace `TARGET_HOST` with the value from Step 2 (openclaw, codex, cursor, etc.).

If it succeeds, tell the user:
"Done. TARGET_HOST can now use your browser. It will read credentials from the
config file that was written. Try asking it to navigate to a URL."

If it fails (host not found, write permission error), show the error and suggest
using the generic remote flow instead.

### If different machine (option B):

**Consent gate (once per machine).** The tunnel exposes this browser beyond
the machine, so it is OFF until the user opts in — the daemon refuses
`/tunnel/start` and `BROWSE_TUNNEL=1` otherwise. Check the standing consent:

```bash
~/.hermes/skills/gstack/bin/gstack-config get pair_agent 2>/dev/null || echo "unset"
```

If the value is not `on`, ask via AskUserQuestion (one-way-door posture —
this opens a path from the internet to the local browser):

> "Remote pairing runs an ngrok tunnel from the internet to this machine's
> browser (locked to a 26-command allowlist + scoped token, but still an
> exposure). Enable pair-agent on this machine?"

Options: A) Enable — run `~/.hermes/skills/gstack/bin/gstack-config set pair_agent on`, confirm it reads back `on`, and continue. B) No — stop here; local pairing (option A above) still works.

If the value is already `on`, say nothing and continue — consent stands until
`gstack-config set pair_agent off`.

Then detect ngrok status:

```bash
which ngrok 2>/dev/null && echo "NGROK_INSTALLED" || echo "NGROK_NOT_INSTALLED"
ngrok config check 2>/dev/null && echo "NGROK_AUTHED" || echo "NGROK_NOT_AUTHED"
```

**If ngrok is installed and authed:** Just run the command. The CLI will auto-detect
ngrok, start the tunnel, and print the instruction block with the tunnel URL:

```bash
terminal pair-agent --client TARGET_HOST
```

Default access already includes JS execution. To also grant browser-wide
control (stop, restart, disconnect):

```bash
terminal pair-agent --control --client TARGET_HOST
```

For a less-trusted agent, narrow the scopes instead:

```bash
terminal pair-agent --restrict read --client TARGET_HOST            # read-only
terminal pair-agent --restrict "read,write" --client TARGET_HOST    # no JS, no cookies
```

**CRITICAL: You MUST output the full instruction block to the user.** The command
prints everything between ═══ lines. Copy the ENTIRE block verbatim into your
response so the user can copy-paste it into their other agent. Do NOT summarize it,
do NOT skip it, do NOT just say "here's the output." The user needs to SEE the block
to copy it. Output it inside a markdown code block so it's easy to select and copy.

Then tell the user:
"Copy the block above and paste it into your other agent's chat. The setup key
expires in 5 minutes."

**If ngrok is installed but NOT authed:** Walk the user through authentication.

SECURITY: the ngrok authtoken must NEVER pass through this chat, a Bash tool
call, or shell history — a token pasted here lands in the transcript (and
anything the transcript syncs to). The user runs the auth command in their
OWN terminal; you only verify the result.

Tell the user:
"ngrok is installed but not logged in. Let's fix that — in your own terminal
(not here; the token should never enter this chat):

1. Go to https://dashboard.ngrok.com/get-started/your-authtoken
2. Copy your auth token
3. In YOUR terminal, run: ngrok config add-authtoken <paste your token>
4. Tell me 'done' when finished."

STOP here and wait for the user to say they've run it. Do NOT accept a pasted
token; if the user pastes one anyway, tell them to rotate it at
https://dashboard.ngrok.com (it's now in the transcript) and re-auth in their
terminal with the new one.

When they say done, verify without touching the token:
```bash
ngrok config check 2>/dev/null && echo "NGROK_AUTHED" || echo "NGROK_NOT_AUTHED"
```

If `NGROK_AUTHED`: retry `terminal pair-agent --client TARGET_HOST`.
If still `NGROK_NOT_AUTHED`: ask them to re-run the command in their terminal.

**If ngrok is NOT installed:** Walk the user through installation:

Tell the user:
"To connect a remote agent, we need ngrok (a tunnel that exposes your local
browser to the internet securely).

1. Go to https://ngrok.com and sign up (free tier works)
2. Install ngrok:
   - macOS: `brew install ngrok`
   - Linux: `snap install ngrok` or download from ngrok.com/download
3. Auth it: `ngrok config add-authtoken YOUR_TOKEN`
   (get your token from https://dashboard.ngrok.com/get-started/your-authtoken)
4. Come back here and run `/pair-agent` again."

STOP here. Wait for the user to install ngrok and re-invoke.

## Step 5: Verify connection

After the user pastes the instructions into the other agent, wait a moment then check:

```bash
terminal status
```

Look for the connected agent in the status output. If it appears, tell the user:
"The remote agent is connected and has its own tab. You'll see its activity in the
side panel if you have GStack Browser open."

## What the remote agent can do

Default access is read+write+admin+meta. The trust boundary is the pairing
ceremony, not the scope:
- Navigate to URLs, click elements, fill forms, take screenshots
- Read page content (text, HTML, snapshot)
- Create new tabs (each agent gets its own)
- Execute JavaScript via `eval`
- Cannot stop or restart the browser, or disconnect headed mode (needs --control)

Remote agents go through the tunnel command allowlist: `eval` works, but the
`js`, `cookies`, and `storage` commands are not dispatchable over the tunnel
even with admin scope. Agents paired with `--local` get all four.

With --restrict (`--restrict read`, `--restrict "read,write"`):
- Sandboxed sessions: read-only, or read+write with no JS, cookie, or storage
  access. Pair this way when the remote agent will read untrusted web content:
  a trusted agent can be prompt-injected by pages it reads, and scope caps the
  blast radius (eval works over the tunnel).
- `--restrict` never grants `control`; that scope stays behind --control.
- To tighten an agent that is ALREADY paired, re-pair it with the **same
  `--client` name** and the narrower `--restrict`/`--domain`. A reducing re-pair
  revokes the previous session immediately and releases its tabs — the agent
  must reconnect with the new key, so the old wide access does not linger.
  Re-pairing without `--client` mints a brand-new agent and leaves the old one
  untouched. Broadening or refreshing keeps the working session (no outage).
- `root` is a reserved `--client` name (it would bypass all scope enforcement).

With --control (--admin is the legacy alias):
- Everything, plus browser-wide destructive ops (stop, restart, disconnect)
- Only for agents you fully trust.

## Troubleshooting

**"Tab not owned by your agent"** — The remote agent tried to interact with a tab
it didn't create. Tell it to run `newtab` first to get its own tab.

**"Domain not allowed"** — The token has domain restrictions. Re-pair with the
same `--client` name and broader (or no) `--domain`. A broadening re-pair keeps
the working session; a narrowing one revokes it immediately.

**"Rate limit exceeded"** — The agent is sending > 10 requests/second. It should
wait for the Retry-After header and slow down.

**"Token expired"** — The 24-hour session expired. Run `/pair-agent` again to
generate a new setup key.

**Agent can't reach the server** — If remote, check the ngrok tunnel is running
(`terminal status`). If local, check the browse server is running.

## Platform-specific notes

### OpenClaw / AlphaClaw

OpenClaw agents use the `exec` tool instead of `Bash`. The instruction block uses
`exec curl` syntax which OpenClaw understands natively. When using `--local openclaw`,
credentials are written to `~/.openclaw/skills/gstack/browse-remote.json`.


### Codex

Codex agents can execute shell commands via `codex exec`. The instruction block's
curl commands work directly. When using `--local codex`, credentials are written
to `~/.codex/skills/gstack/browse-remote.json`.

### Cursor

Cursor's AI can run terminal commands. The instruction block works as-is.
When using `--local cursor`, credentials are written to
`~/.cursor/skills/gstack/browse-remote.json`.

## Revoking access

To disconnect a specific agent:

```bash
terminal tunnel revoke AGENT_NAME
```

The command deletes every token for that agent (the session and any pending
setup keys) and re-reads the agent list to prove it's gone.

See who's paired:

```bash
terminal tunnel agents
```

Unexchanged setup keys show as "(pending)"; `tunnel revoke` removes them too.

To disconnect ALL agents at once, stop the daemon. Scoped tokens live in
daemon memory and never survive a restart; the next command boots a fresh
daemon with a new root token:

```bash
terminal stop
```
