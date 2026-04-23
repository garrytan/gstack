## Coding Tasks (gstack)

### Rules (non-negotiable)

1. **You ARE the agent.** When the user asks to use ANY gstack skill, load the
   skill and run it directly. Do NOT tell the user to open Claude Code or any
   other tool. Never say "this needs to run in Claude Code." Just do it.

2. **Resolve the repo.** If the user names a repo or project, set the working
   directory to that repo path. If the repo path isn't known, ask which repo —
   don't punt to telling the user to open another agent.

3. **Planning runs end-to-end.** For /office-hours, /autoplan, /plan-ceo-review,
   /plan-eng-review, /plan-design-review: load the skill, run the full review
   pipeline, and report the plan back here in chat. Write the plan to a file in
   the repo (e.g., `plans/<slug>-plan-<date>.md`) and report the path. The user
   should never have to leave this session.

### Dispatch Routing

When asked for coding work, pick the dispatch tier:

**SIMPLE:** "fix this typo," "update that config," single-file changes
→ Run directly with Hermes tools (terminal, read_file, patch, write_file)

**MEDIUM:** multi-file features, refactors, skill edits
→ Load gstack-lite discipline, then run directly
  ```
  Load skill: ~/.hermes/skills/gstack/SKILL.md (lite section)
  Run the task directly. Report what shipped and any decisions.
  ```

**HEAVY:** needs a specific gstack methodology
→ Load the specific skill and run it directly
  Skills: /cso, /review, /qa, /qa-only, /ship, /investigate, /design-review,
  /benchmark, /gstack-upgrade, /health, /canary
  ```
  Load skill: ~/.hermes/skills/gstack-<skill-name>/SKILL.md
  Follow the skill instructions using Hermes tools.
  For browse-heavy skills, use Hermes browser_* tools instead of $B.
  ```

**FULL:** build a complete feature, multi-day scope, needs planning + review + ship
→ Load gstack-full discipline, plan, then delegate implementation if needed
  ```
  1. Load skill: ~/.hermes/skills/gstack/SKILL.md (full section)
  2. Run /autoplan → review → approve plan
  3. Implement using Hermes tools OR delegate via delegate_task
  4. Run /ship (or equivalent validation)
  5. Report back: PR URL, what shipped, decisions made, anything uncertain
  ```

**PLAN:** user wants to plan a project, spec out a feature, or design something
  before any code is written
→ Load gstack-plan discipline and run the planning gauntlet
  ```
  1. Load skill: ~/.hermes/skills/gstack/SKILL.md (plan section)
  2. Run /office-hours → /autoplan → save plan file
  3. Write plan to: plans/<project-slug>-plan-<date>.md
  4. Report back: plan file path, summary, key decisions, recommended next step
  ```
  Persist the plan link to memory so the user can find it later.
  When the user is ready to implement, run a new FULL session pointing at the plan.

### Decision Heuristic

- Can it be done in <10 lines of code? → **SIMPLE**
- Does it touch multiple files but the approach is obvious? → **MEDIUM**
- Does the user name a specific skill (/cso, /review, /qa)? → **HEAVY**
- "Upgrade gstack", "update gstack" → **HEAVY** with `Run /gstack-upgrade`
- Is it a feature, project, or objective (not a task)? → **FULL**
- Does the user want to PLAN something without implementing yet? → **PLAN**

### Hermes Tool Mapping for gstack

When gstack skills reference Claude-specific tools, map to Hermes equivalents:

| gstack / Claude | Hermes |
|---|---|
| Bash tool | terminal tool |
| Read tool | read_file tool |
| Write tool | write_file or patch tool |
| Edit tool | patch tool |
| Agent tool | delegate_task |
| AskUserQuestion | clarify tool |
| $B goto | browser_navigate |
| $B click | browser_click |
| $B text / html / links / forms | browser_snapshot (full=true for html) |
| $B screenshot | browser_vision |
| $B scroll | browser_scroll |
| $B press | browser_press |
| $B type | browser_type |
| $B eval | browser_console |
| WebSearch | web_search or web_extract |

### Browser Work in Hermes

For skills like /qa, /qa-only, /browse that rely heavily on the browse binary:

1. Use `browser_navigate` to open pages
2. Use `browser_snapshot` (full=false for compact, full=true for complete) to read content
3. Use `browser_click`, `browser_type`, `browser_press` to interact
4. Use `browser_vision` for visual verification (screenshots)
5. Use `browser_scroll` to reveal more content

The Hermes browser tools provide the same coverage as gstack's `$B` commands.
When a skill says `$B goto <url>`, use `browser_navigate`.
When a skill says `$B text`, use `browser_snapshot`.
When a skill says `$B screenshot`, use `browser_vision`.
