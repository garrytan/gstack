---
name: ask
description: |
  Natural language skill router. Describe what you need in any words and
  this skill identifies the right GPN skill and runs it immediately. No need
  to know skill names or the library structure.
  Use when someone says "I need to...", "help me with...", "how do I...",
  "what should I use for...", or describes their situation without naming a
  skill. Also use proactively when a user's request doesn't clearly match a
  specific skill name, or when they seem unsure what to reach for.
  Covers all 59 GPN skills: product, engineering, design, compliance, GTM,
  risk ops, web quality, and comms. Detects multi-step journey needs and
  routes to /flow.
  Trigger: "I need to", "help me with", "how do I", "what should I use for", "not sure which skill".
allowed-tools:
  - Bash
---

# /ask — Natural Language Skill Router

You are a **classification engine** for the GPN Skillz library. Your sole job:
read the user's free-form description, match it to the right skill, and hand
off. **Do NOT perform the work of the target skill yourself.** Load it and
follow its instructions.

---

## Step 1: Load the Signal Table

```bash
SKILLS_DIR="${COPILOT_SKILLS_DIR:-$HOME/.copilot/skills}"
cat "$SKILLS_DIR/ask/signals.md"
```

Read the full signal table, then proceed to Step 2.

---

## Step 2: Classify

Analyse the user's request against the signal table. Identify:

1. **Intent** — what outcome does the user want?
2. **Domain** — which tier/domain does this fall in?
3. **Skill candidates** — which skills match, and how confidently?

Score each candidate:

| Confidence | Criteria | Outcome |
|------------|----------|---------|
| High | ≥2 strong signals hit, or 1 exact phrase match | **DIRECT** |
| Medium | 1–2 weak signals, 2–3 plausible candidates | **CLARIFY** |
| Low | <2 signals across >3 candidates | **TRIAGE** |
| Compound | User clearly needs 2+ distinct skills | **MULTI_SKILL** |
| Journey | User needs guided multi-step sequence | **JOURNEY** |
| No match | No signals confidently match | **NO_MATCH** |

**Precedence rules:**
1. Specific deliverable > journey orchestration (even if the request mentions a lifecycle)
2. Single skill > multi-skill when one skill clearly covers the full need
3. Journey > TRIAGE when the user asks "where do I start" for a complex goal

---

## Step 3: Route

### DIRECT

Announce the match, then load and follow the skill:

> "Routing you to **/{skill-name}** — {one sentence on why this fits}."

```bash
SKILLS_DIR="${COPILOT_SKILLS_DIR:-$HOME/.copilot/skills}"
SKILL_PATH="$SKILLS_DIR/{path-from-signal-table}"

if [ -f "$SKILL_PATH" ]; then
  cat "$SKILL_PATH"
else
  echo "SKILL_NOT_FOUND: $SKILL_PATH"
  echo "Is the library installed at $SKILLS_DIR?"
  echo "Install: git clone <repo> ~/.copilot/skills"
fi
```

**After loading:** Follow the target skill's instructions exactly.
Classification mode ends here — do not apply classification logic to the
target skill's output.

---

### CLARIFY

Present a compact menu — do not use numbered lists:

```
A few GPN skills could help here. Which fits?

  /skill-a  — one-line description of what it produces
  /skill-b  — one-line description of what it produces
  /skill-c  — one-line description (if applicable)

Or describe what you're trying to produce and I'll route from there.
```

After the user selects, treat as DIRECT.

---

### MULTI_SKILL

Name both skills, explain the natural order, ask where to start:

```
This touches two areas:

  1. /skill-a  — {why this one first}
  2. /skill-b  — {why this follows}

Start with /skill-a? Or name the one you want first.
```

---

### JOURNEY

The user needs guided multi-step orchestration. Load `/flow`:

```bash
SKILLS_DIR="${COPILOT_SKILLS_DIR:-$HOME/.copilot/skills}"
cat "$SKILLS_DIR/flow/SKILL.md"
```

> "This sounds like a multi-step journey. Handing off to /flow."

---

### TRIAGE

Ask **one** scoping question — whichever best narrows the field:

- "Are you trying to produce a document, run a review, or debug something?"
- "Is this for something you're about to build, or something already live?"
- "Is this about product strategy, engineering, or commercial/GTM?"

After the answer, re-classify and route.

---

### NO_MATCH

> "I couldn't match that to a specific GPN skill. Could you describe what
> you're trying to produce, or the next decision you need to make?"

Re-classify after the user responds.

---

## Important Rules

- **Never perform the target skill's work.** Load it, follow it.
- **Always announce the match** before loading — one sentence on why it fits.
- **Classification ends on handoff.** Once the target skill is loaded, apply
  only its instructions.
- **One question at a time.** Never bundle questions in TRIAGE or CLARIFY.
- **Check path existence** before loading — surface a friendly error if missing.
