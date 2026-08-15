# python-heredoc-scale-failure

**Type:** HABIT
**First seen:** 2026-04-10
**Frequency:** 2x in one session
**Status:** open

## What happens

When generating large HTML files (>~15KB) using inline Python heredocs in bash:

```bash
python3 << 'PYEOF'
...large script...
PYEOF
```

The command fails silently or throws a syntax error due to argument length limits and f-string brace conflicts with the shell expansion filter.

## Why it matters

Causes generation to fail mid-flow, requiring a manual retry with a different approach. Wastes a turn and produces a confusing error. Affects any skill that generates large files: `/internal-comms`, future report generators, HTML builders.

## Suggested fix

All generation skills that produce files >50 lines of Python should use the `/tmp/script.py` pattern instead:

```bash
cat > /tmp/build_X.py << 'SCRIPTEOF'
# script content here — no shell expansion conflicts
SCRIPTEOF
python3 /tmp/build_X.py && rm /tmp/build_X.py
```

This should be documented as the **default pattern** in:
- `internal-comms/SKILL.md` Phase 3 (Templates)
- Any future skill that generates HTML, reports, or large structured files

## Evidence

- Session `~/.copilot/sessions/2026-04-10/session-2154.md`
- Failed build: `comms-2026-04-10-1557-a-rising-tide-lifts-all-boats.html` (inline heredoc attempt)
- Successful builds: used `/tmp/build_newsletter.py` and `/tmp/build_outlook.py`

## Resolution

Not yet addressed in SKILL.md templates. Pattern logged here for contributor pick-up.
