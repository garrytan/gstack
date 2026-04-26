---
name: claude
preamble-tier: 3
version: 1.0.0
description: |
  Claude Code CLI wrapper for non-Claude hosts - three modes. Review: independent
  diff review via claude -p. Challenge: adversarial failure-mode review. Consult:
  ask Claude about the repo with read-only file tools. Use when asked for "claude
  review", "claude challenge", "ask claude", "second opinion from claude", or
  "outside voice". (gstack)
triggers:
  - claude review
  - claude challenge
  - ask claude
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

{{PREAMBLE}}

{{BASE_BRANCH_DETECT}}

# /claude - Claude Outside Voice

You are running the `/claude` skill from a non-Claude host. This wraps `claude -p`
to get an independent Claude Code second opinion without allowing nested Claude to
modify files.

The generated external invocation name is `gstack-claude`.

---

## Step 0: Check Claude CLI

```bash
CLAUDE_BIN=$(command -v claude 2>/dev/null || echo "")
[ -z "$CLAUDE_BIN" ] && echo "NOT_FOUND" || echo "FOUND: $CLAUDE_BIN"
```

If `NOT_FOUND`, stop and tell the user:
"Claude CLI not found. Install Claude Code, then re-run this skill."

Check auth:

```bash
if [ -f "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "AUTH_FOUND"
else
  echo "AUTH_MISSING"
fi
```

If `AUTH_MISSING`, stop and tell the user:
"No Claude authentication found. Run `claude` interactively to log in, or export `ANTHROPIC_API_KEY`, then re-run this skill."

---

## Safety Boundary

Nested Claude must stay focused on the user's repository and must not run gstack
skills from inside this skill.

All `claude -p` calls MUST include:

- `--disable-slash-commands`
- Review/challenge: `--tools ""`
- Consult: `--allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write`

Never pass `Bash`, `Edit`, or `Write` to nested Claude in this skill.

All prompts MUST be written to a temp file and fed through stdin. Never interpolate
user text directly into the shell command.

---

## Step 1: Detect Mode

Parse the user's input:

1. `/claude review` or `/claude review <instructions>` - **Review mode** (Step 2A)
2. `/claude challenge` or `/claude challenge <focus>` - **Challenge mode** (Step 2B)
3. `/claude` with no arguments, or `/claude <anything else>` - **Consult mode** (Step 2C)

If no mode is obvious and a diff exists, ask whether to review, challenge, or consult.

---

## Shared Helpers

Use these shell snippets in every mode.

Create temp files:

```bash
PROMPT_FILE=$(mktemp /tmp/gstack-claude-prompt-XXXXXX)
RESP_FILE=$(mktemp /tmp/gstack-claude-response-XXXXXX.json)
ERR_FILE=$(mktemp /tmp/gstack-claude-error-XXXXXX.txt)
```

Cleanup at the end of every mode:

```bash
rm -f "$PROMPT_FILE" "$RESP_FILE" "$ERR_FILE"
```

Parse JSON output:

```bash
python3 - "$RESP_FILE" <<'PY'
import json, sys
path = sys.argv[1]
try:
    obj = json.load(open(path))
except Exception as exc:
    print(f"CLAUDE_JSON_PARSE_ERROR: {exc}")
    sys.exit(0)

if obj.get("is_error"):
    print("CLAUDE_ERROR: true")

result = obj.get("result") or obj.get("response") or ""
if result:
    print(result)

usage = obj.get("usage") or {}
input_tokens = usage.get("input_tokens", 0) or 0
output_tokens = usage.get("output_tokens", 0) or 0
cache_read = usage.get("cache_read_input_tokens", 0) or 0
model = obj.get("model") or "unknown"
session_id = obj.get("session_id") or ""

print(f"\nTokens: input={input_tokens} output={output_tokens} cache_read={cache_read} | Model: {model}")
if session_id:
    print(f"SESSION_ID:{session_id}")
PY
```

If stderr contains `auth`, `login`, or `unauthorized`, tell the user:
"Claude authentication failed. Run `claude` interactively to authenticate or export `ANTHROPIC_API_KEY`."

---

## Step 2A: Review Mode

Review the current branch diff with nested Claude in tool-less mode.

1. Fetch base and capture diff:

```bash
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
DIFF_FILE=$(mktemp /tmp/gstack-claude-diff-XXXXXX.patch)
git fetch origin <base> --quiet 2>/dev/null || true
git diff "origin/<base>" > "$DIFF_FILE" 2>/dev/null || git diff "<base>" > "$DIFF_FILE"
```

If the diff file is empty, stop and say:
"Nothing to review - no changes against the base branch."

2. Write the prompt file:

```bash
cat > "$PROMPT_FILE" <<'EOF'
You are a brutally honest Claude Code reviewer. Review this git diff for bugs,
production failure modes, security issues, missing tests, and maintainability
problems. Be direct. No compliments. Reference files and changed code where possible.

Additional user instructions, if any:
<custom review instructions>

DIFF:
EOF
cat "$DIFF_FILE" >> "$PROMPT_FILE"
```

3. Run Claude:

```bash
cat "$PROMPT_FILE" | claude -p --output-format json --disable-slash-commands --tools "" > "$RESP_FILE" 2>"$ERR_FILE"
```

4. Present the parsed output:

```
CLAUDE SAYS (code review):
============================================================
<parsed result from RESP_FILE>
============================================================
```

5. Cleanup:

```bash
rm -f "$DIFF_FILE" "$PROMPT_FILE" "$RESP_FILE" "$ERR_FILE"
```

---

## Step 2B: Challenge Mode

Run an adversarial failure-mode review with nested Claude in tool-less mode.

1. Capture the diff using the same diff commands from Review mode.

2. Write the prompt:

```bash
cat > "$PROMPT_FILE" <<'EOF'
You are an adversarial Claude Code reviewer. Try to break this change before users do.
Find edge cases, race conditions, security holes, resource leaks, silent data
corruption, bad error handling, and operational failure modes. Be thorough. No
compliments. If the user provided a focus area, prioritize it.

Focus area, if any:
<focus>

DIFF:
EOF
cat "$DIFF_FILE" >> "$PROMPT_FILE"
```

3. Run Claude:

```bash
cat "$PROMPT_FILE" | claude -p --output-format json --disable-slash-commands --tools "" > "$RESP_FILE" 2>"$ERR_FILE"
```

4. Present the parsed output:

```
CLAUDE SAYS (adversarial challenge):
============================================================
<parsed result from RESP_FILE>
============================================================
```

5. Cleanup:

```bash
rm -f "$DIFF_FILE" "$PROMPT_FILE" "$RESP_FILE" "$ERR_FILE"
```

---

## Step 2C: Consult Mode

Ask Claude about the repository. Consult mode may inspect files, but only with
read-only tools.

1. Check for an existing Claude session:

```bash
cat .context/claude-session-id 2>/dev/null || echo "NO_SESSION"
```

If a session exists, ask the user whether to continue it or start fresh.

2. Write the prompt:

```bash
cat > "$PROMPT_FILE" <<'EOF'
You are Claude Code acting as an independent outside voice for this repository.
Answer the user's question directly. You may inspect repository files with Read,
Grep, and Glob only. Do not use Bash. Do not edit or write files. Do not invoke
slash commands or gstack skills.

USER QUESTION:
<user prompt>
EOF
```

3. Run Claude.

For a new session:

```bash
cat "$PROMPT_FILE" | claude -p --output-format json --disable-slash-commands --allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write > "$RESP_FILE" 2>"$ERR_FILE"
```

For a resumed session:

```bash
cat "$PROMPT_FILE" | claude -p --resume "<session-id>" --output-format json --disable-slash-commands --allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write > "$RESP_FILE" 2>"$ERR_FILE"
```

4. Parse and save the session id:

```bash
SESSION_ID=$(python3 - "$RESP_FILE" <<'PY'
import json, sys
try:
    obj = json.load(open(sys.argv[1]))
    print(obj.get("session_id") or "")
except Exception:
    print("")
PY
)
if [ -n "$SESSION_ID" ]; then
  mkdir -p .context
  printf "%s\n" "$SESSION_ID" > .context/claude-session-id
fi
```

5. Present the parsed output:

```
CLAUDE SAYS (consult):
============================================================
<parsed result from RESP_FILE>
============================================================
Session saved - run /claude again to continue this conversation.
```

6. Cleanup:

```bash
rm -f "$PROMPT_FILE" "$RESP_FILE" "$ERR_FILE"
```

---

## Error Handling

- **Binary not found:** Stop with install instructions.
- **Auth missing:** Stop with login/API key instructions.
- **Auth failure from stderr:** Surface the stderr line and ask the user to re-authenticate.
- **JSON parse failure:** Show raw stdout from `$RESP_FILE` and stderr from `$ERR_FILE`.
- **Empty response:** Tell the user "Claude returned no response. Check stderr for errors."
- **Resume failure:** Delete `.context/claude-session-id` and retry with a fresh session.

---

## Important Rules

- Nested Claude is read-only in consult mode and tool-less in review/challenge.
- Always include `--disable-slash-commands`.
- Never pass nested Claude `Bash`, `Edit`, or `Write`.
- Never interpolate user text into a shell command.
- Present Claude's response faithfully, then add any host-agent synthesis after it.
