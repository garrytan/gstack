# skill-forge-missing-registry-update

**Type:** WORKAROUND
**First seen:** 2026-04-10
**Frequency:** 4 skills affected in one session
**Status:** addressed

## What happens

`/skill-forge` creates `SKILL.md`, updates `CATALOG.md`, and optionally updates `README.md` — but previously did **not** update `~/.copilot/copilot-instructions.md`. This meant every skill created via `/skill-forge` would exist on disk and in the repo but Copilot would not know when to invoke it. It would fail silently.

Affected skills (all created in the same session, all missing from registry):
- `/session-learn`
- `/skill-forge`
- `/fin-model`
- `/internal-comms`

Discovered when user said "session-learn doesn't run" — it was in the skills directory but absent from `copilot-instructions.md`.

## Why it matters

High-impact silent failure. Every skill built via `/skill-forge` is unusable until manually registered. Zero feedback to the user that registration is missing.

## Suggested fix

Add a mandatory Phase 5.5 to `/skill-forge` that:
1. Inserts the new skill row into the correct table section in `copilot-instructions.md`
2. Appends a default trigger rule to the `## Defaults` section
3. Verifies with `grep "{name}" copilot-instructions.md`

## Evidence

- Session `~/.copilot/sessions/2026-04-10/session-1435.md`
- Manual copilot-instructions.md fix required for 4 skills post-hoc

## Resolution

✅ **Fixed** — commit `da68b3c`: added Phase 5.5 to `skill-forge/SKILL.md` with Python-based table insertion and default trigger rule append. All future skills created via `/skill-forge` will auto-register.
