# Engineering Review: Prism Triad MVP
Date: 2026-03-20
Status: CLEARED (0 unresolved, 2 critical gaps mitigated)
Reviewed: CEO plan at ~/.gstack/projects/prism/ceo-plans/2026-03-20-prism-triad-mvp.md
Codex review: included (GPT-5.4, 14 issues, incorporated into review)

## 10 Decisions Locked In

### 1. Precedence hierarchy for verification
Tests are ground truth (pass/fail). LLM comparison is advisory (surfaces concerns but doesn't block). User judgment is final override (can dismiss either, but overrides are logged with reason).
```
Tests PASS + LLM OK      → auto-proceed
Tests PASS + LLM flags   → surface advisory to user
Tests FAIL               → always block, regardless of LLM
User override            → log override + reason, proceed
```

### 2. Hybrid ordering: Claude engineers, user vibes
Claude silently handles: dependency analysis, build order optimization, sub-chunk splitting, technical sequencing.
Claude asks the user (plain language only): "Which part matters most to you?" / "Should we start with what people see, or what makes everything work?"
NEVER asks engineering questions: "Auth depends on DB schema, build first?"

### 3. Two-layer acceptance criteria
- **User-facing** (acceptance-criteria.md): plain language, experience-focused. "People can sign up in under 30 seconds."
- **Machine-facing** (.prism/test-criteria.json): testable assertions Claude derives silently. "POST /signup returns 201 within 2s."
- User only ever sees user-facing layer.

### 4. Smart interrupts (not blocking checkpoints)
Prism verifies every chunk silently. Only interrupts when:
- Tests fail (after 2 silent fix attempts)
- LLM detects significant intent drift
- A feature is substantially different from what was described
Green chunks auto-proceed with a brief status message. Result: ~1-2 interruptions per build instead of 5-10.

### 5. Graceful exit for Socratic questioning
Max rounds per depth: Quick (2), Standard (5), Deep (10). At max, Prism says "I have enough to start — we'll refine as we go" and generates best-effort acceptance criteria.

### 6. State migration for existing sessions
When resuming a session without acceptance-criteria.md: generate silently from intent.md features. Without config.json: use defaults. No user interruption.

### 7. Socratic rejection UX
When user rejects a chunk with vague feedback ("it feels off"), Prism asks follow-ups: "Is it doing the wrong thing, or doing the right thing the wrong way?" / "What did you picture instead?" Claude translates vibe into engineering changes silently.

### 8. Test generation from machine-layer criteria
tdd-guide receives machine-layer assertions (testable, specific), not user-layer criteria (vibes). Translation from vibes to assertions happens once during criteria generation.

### 9. Lightweight instrumentation
Log to history.jsonl: verification outcomes (pass/fail/override), Socratic depth used, chunks rejected vs accepted, time per chunk. Not a formal eval — just enough data to learn.

### 10. Test efficiency
Generate tests once per feature during criteria generation. On verification, run existing tests inline — don't re-invoke tdd-guide. Only re-invoke if fix changes feature scope.

## Critical Gaps (mitigated)
1. **Vague machine-layer criteria** → Add self-check during generation: "Could each assertion actually fail?" (Included in Phase 1)
2. **Silent protocol export failure** → Log to history.jsonl, mention in status message.

## Phase 1 Implementation Scope (Core Triad)
Items 1-3 from CEO plan + acceptance criteria self-check:
- Deeper Socratic questioning with adaptive depth + max rounds
- Two-layer acceptance criteria generation with self-check
- Smart verification loop (silent verify, interrupt only on problems)
- Socratic rejection UX for vague feedback
- State migration for existing sessions
- Lightweight instrumentation logging

## Phase 2 Implementation Scope (Expansions)
Items 4-7 from CEO plan:
- Protocol Template Export
- Obsidian vault write-only integration
- Full verification loop (belt-and-suspenders with tdd-guide)
- Socratic Depth Calibration UI

## Files
- Test plan: ~/.gstack/projects/prism/foxy-no-branch-test-plan-20260320-230000.md
- TODOS: ~/.gstack/projects/prism/TODOS.md
- CEO plan: ~/.gstack/projects/prism/ceo-plans/2026-03-20-prism-triad-mvp.md
- Design doc: ~/.gstack/projects/prism/foxy-unknown-design-20260320-221541.md
- Existing skill: ~/.claude/skills/gstack/prism/SKILL.md (915 lines)
