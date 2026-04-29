# Domain Skills

Per-site notes the agent writes for itself. Compounds across sessions: once an
agent figures out something non-obvious about a website, it saves a skill, and
future sessions on that host get the note injected into their prompt context.

This is gstack's borrow from [browser-use/browser-harness](https://github.com/browser-use/browser-harness).
gstack copies the per-site-notes pattern, NOT the self-modifying-runtime
pattern. Skills are markdown text loaded into prompts; they are not executable
code.

## How agents use it

```bash
# Agent wrote down what it learned about a site after a successful task.
# The host is taken from the active tab automatically (no agent argument).
echo "# LinkedIn Apply Button

The Apply button on /jobs/view pages is inside an iframe with a class
matching 'jobs-apply-button-iframe'. Use \$B frame --url 'apply' first,
then snapshot." | $B domain-skill save

# See what's saved
$B domain-skill list

# Read the body of a specific host's skill
$B domain-skill show linkedin.com

# Edit interactively in $EDITOR
$B domain-skill edit linkedin.com

# Promote an active per-project skill to global (cross-project)
$B domain-skill promote-to-global linkedin.com

# Roll back a recent edit
$B domain-skill rollback linkedin.com

# Delete (tombstone — recoverable via rollback)
$B domain-skill rm linkedin.com
```

## State machine

```
  ┌──────────────┐  3 successful uses        ┌────────┐  promote-to-global   ┌────────┐
  │ quarantined  │ ─────────────────────▶  │ active │ ──────────────────▶  │ global │
  │ (per-project)│  (no classifier flags)   │(project)│  (manual command)    │        │
  └──────────────┘                          └────────┘                      └────────┘
         ▲                                       │
         │  classifier flag during use           │  rollback (version log)
         └───────────────────────────────────────┘
```

A new save lands as **quarantined** and does NOT auto-fire in prompts. After 3
uses on this host without the L4 ML classifier flagging the skill content, the
skill auto-promotes to **active** in the project. Active skills fire on every
new sidebar-agent session for that hostname.

To make a skill fire across projects (for example, "I want my LinkedIn skill
on every gstack project I work on"), explicitly run
`$B domain-skill promote-to-global <host>`. This is opt-in by design (Codex T4
outside-voice review): blanket cross-project compounding leaks context across
unrelated work.

## Storage

Skills live in two places:

- **Per-project**: `~/.gstack/projects/<slug>/learnings.jsonl` — same JSONL
  file the `/learn` skill uses. Domain skills are `type:"domain"` rows.
- **Global**: `~/.gstack/global-domain-skills.jsonl` — only `state:"global"`
  rows.

Both files are append-only JSONL. Tombstones for deletes; an idle compactor
rewrites files periodically. Tolerant parser drops partial trailing lines on
read so a crash mid-write doesn't poison subsequent reads.

## Security model

Skills are agent-authored content loaded into future prompt context. That makes
them a classic agent-to-agent prompt-injection vector. The plan explicitly
addresses this with multiple layers:

| Layer | What | Where |
|-------|------|-------|
| L1-L3 | Datamarking, hidden-element strip, ARIA regex, URL blocklist | `content-security.ts` (compiled binary) |
| L4 | TestSavantAI ONNX classifier | `security-classifier.ts` (sidebar-agent, non-compiled) |
| L4b | Claude Haiku transcript classifier | `security-classifier.ts` (sidebar-agent) |
| L5 | Canary token leak detection | `security.ts` |

L1-L3 checks run at **save time** (in the daemon). The L4 ML classifier runs at
**load time** (in sidebar-agent), so each session that loads a skill into its
prompt also re-validates the content. This catches issues that only manifest
after a classifier model update.

The save command derives the hostname from the **active tab's top-level
origin**, not from agent arguments. This closes a confused-deputy bug Codex
flagged: a malicious page redirect chain could otherwise trick the agent into
poisoning a different domain.

## Error reference

| Error | Cause | Action |
|-------|-------|--------|
| `Save blocked: classifier flagged content as potential injection` | L4 score ≥ 0.85 at save | Rewrite the skill removing instruction-like prose; retry. |
| `Save blocked: <L1-L3 message>` | URL blocklist match or ARIA injection at save | Review skill body for suspicious patterns. |
| `Save failed: empty body` | No content via stdin or `--from-file` | Pipe markdown into `$B domain-skill save`, or pass `--from-file <path>`. |
| `Cannot save domain-skill: no top-level URL on active tab` | Tab is `about:blank` or `chrome://...` | `$B goto <target-site>` first, then save. |
| `Cannot promote: skill is in state "quarantined"` | Skill hasn't auto-promoted yet | Use it in this project until 3 successful runs without classifier flags. |
| `Cannot rollback: <host> has fewer than 2 versions` | Only one version exists | Use `$B domain-skill rm` to delete instead. |

## Telemetry

When telemetry is enabled (default `community` mode unless turned off), the
following events are written to `~/.gstack/analytics/browse-telemetry.jsonl`:

- `domain_skill_saved {host, scope, state, bytes}`
- `domain_skill_save_blocked {host, reason}`
- `domain_skill_fired {host, source, version}`
- `domain_skill_state_changed {host, from_state, to_state}` (planned)

Hostname only — no body content, no agent text. Disable entirely with
`gstack-config set telemetry off` or `GSTACK_TELEMETRY_OFF=1`.
