## Synthetic Memory Protocol

This skill uses file-backed memory to survive context compaction. Follow these
rules strictly — they prevent silent information loss during long sessions.

### Initialization

At the start of every skill invocation:
1. Run `bash ~/.claude/skills/gstack/scripts/init-memory.sh` if `.gstack/` doesn't exist
2. Read `.gstack/session.json` to check if a previous skill left state
3. If `session.json` has a different skill name and unresolved findings, warn the user:
   "Previous session from /[skill] has N unresolved findings. Review .gstack/findings.md?"
4. Update `session.json` with current skill name, timestamp, and initial phase

### Session State Updates

After every significant action, update `.gstack/session.json`:
- **Finding discovered** -> append to `critical_findings` array AND write to `.gstack/findings.md`
- **Check completed** -> move from `pending_checks` to `completed_checks`
- **User decision** -> append to `decisions` array AND append to `.gstack/decisions.log`
- **Phase change** -> update `phase` field
- **Every tool call** -> increment `turn_count`

Use this exact JSON schema for session.json:

```json
{
  "skill": "review",
  "started_at": "2026-03-20T14:30:00Z",
  "phase": "security_scan",
  "turn_count": 12,
  "critical_findings": [
    {
      "id": "F001",
      "file": "src/auth.py",
      "line": 42,
      "severity": "P0",
      "type": "sql_injection",
      "status": "unresolved",
      "summary": "User input passed directly to cursor.execute()"
    }
  ],
  "decisions": [
    {
      "timestamp": "2026-03-20T14:35:00Z",
      "decision": "Skip CSS linting — out of scope for this review",
      "context": "User confirmed backend-only review"
    }
  ],
  "completed_checks": ["dependency_audit", "type_safety"],
  "pending_checks": ["security_scan", "race_conditions", "error_handling"],
  "context_warnings": []
}
```

### Finding Protocol

When you discover a bug, vulnerability, or issue:

1. **IMMEDIATELY** append to `.gstack/findings.md` using this format:

   ```
   ### F{NNN} — [{severity}] {title}
   - **Status:** UNRESOLVED
   - **File:** {filepath}:{line}
   - **Type:** {category}/{specific_type}
   - **Description:** {1-2 sentence description}
   - **Evidence:** {the relevant 3-5 lines of code, indented}
   - **Discovered:** {timestamp}
   - **Resolved:** —
   ```

2. **IMMEDIATELY** update `.gstack/session.json` `critical_findings` array
3. Only THEN continue with the next check

**RULE: If a finding is not in `.gstack/findings.md`, it does not exist.**
Never hold a finding only in conversation memory.

When a finding is resolved:
1. Update its status in `findings.md` to `RESOLVED` with resolution details
2. Update its status in `session.json`
3. If a fix was applied, note the commit or file change

### Decision Protocol

When the user makes a scope, priority, or approach decision:

1. Append to `.gstack/decisions.log`:
   ```
   [2026-03-20T14:35:00Z] DECISION: Skip CSS linting — out of scope
   CONTEXT: User confirmed backend-only review
   SKILL: /review
   ```

2. Update `session.json` `decisions` array

**RULE: If a decision is not in `.gstack/decisions.log`, it was never made.**
Never rely on conversation memory for what the user approved or rejected.

### Checkpoint Protocol

Every 5 tool calls (tracked via `turn_count` in session.json):

1. Read `.gstack/session.json` (the file, not your memory of it)
2. Read `.gstack/findings.md` header to count unresolved findings
3. Compare your understanding against the files — if there's any discrepancy, **trust the files**. If `findings.md` and `session.json` disagree on finding count or status, `findings.md` wins (it's append-only and more durable)
4. Print a brief checkpoint status:

```
--- CHECKPOINT ------------------------------------
Skill: /review | Phase: security_scan | Turn: 15
Completed: dependency_audit, type_safety
Unresolved: F001 (P0 sql_injection), F003 (P1 race_condition)
Remaining: error_handling, test_coverage
Decisions: skip CSS lint, auth module in scope
---------------------------------------------------
```

5. Save a checkpoint snapshot: copy `session.json` to `.gstack/checkpoints/checkpoint-{turn_count}.json`
6. Continue with the next action

**WHY:** After compaction, you may have lost details from earlier turns. The checkpoint
re-injects critical state into the most recent (uncompacted) context. The printed
status ensures the information is in your working memory for subsequent reasoning.

### Skill Handoff Protocol

When completing a skill invocation:

1. Write `.gstack/handoff.md`:
   ```markdown
   # Skill Handoff: /review -> next skill
   ## Completed: 2026-03-20T15:45:00Z

   ## Summary
   Reviewed 12 files across 3 modules. Found 2 P0 and 1 P1 issues.

   ## Unresolved Findings
   - F001 [P0] SQL injection in auth.py:42
   - F003 [P1] Race condition in payment.py:187

   ## Resolved Findings
   - F002 [P1] Missing null check in user.py:23 — fixed, commit abc123

   ## Key Decisions
   - Backend-only review (CSS lint skipped)
   - Auth module confirmed in scope

   ## Recommendations for Next Skill
   - /qa should verify F001 fix once applied
   - /ship should block until F001 and F003 are resolved
   ```

2. Update `session.json` phase to "completed"

When starting a new skill:
1. Check for `.gstack/handoff.md` — if present, read it and incorporate context
2. Check `session.json` for unresolved findings from previous skill
