# Skill routing and skill contracts

Two opt-in Claude Code hooks that help a model actually run gstack's skills (GST-1088). Both are **off by default**, and with both off nothing changes.

- **Skill routing** (`skill_routing`, a UserPromptSubmit hook). When a prompt matches an installed skill's `triggers:`, the hook adds one line of context naming that skill, for example "this request fits /investigate. Run /investigate with the Skill tool before you start".
- **Skill contracts** (`skill_contracts`, a Stop hook). A skill can declare the outputs that must exist before it is done. When the model tries to stop without them, the hook blocks once and names what is missing.

## Turn them on or off

Each switch resolves in this order, and the first one set wins:

1. The `./setup` flag: `--skill-routing` / `--no-skill-routing` and `--skill-contracts` / `--no-skill-contracts` (also `--skill-routing=on|off`). A flag is saved to config, so it survives upgrades.
2. The environment: `GSTACK_SKILL_ROUTING` and `GSTACK_SKILL_CONTRACTS` (`on` or `off`). Not saved.
3. Config: `gstack-config set skill_routing on|off` and `gstack-config set skill_contracts on|off`.
4. The default: off.

`on` also accepts yes, true and 1; `off` accepts no, false and 0. Setup warns about any other value, uses off for that run, and does not save it.

Setup registers a hook only when its switch is on, prints one line the first time it registers it, and removes the registration when the switch is off (or with `--no-team`). The hooks also read the switch every time they run, so this takes effect on the next prompt without re-running setup:

    gstack-config set skill_contracts off
    gstack-config set skill_routing off

The off switch is for people. The text the Stop hook shows the model never mentions it.

## Host support

| Host | Routing hook | Contract Stop hook | Notes |
|---|---|---|---|
| Claude Code | yes | yes | Registered in `~/.claude/settings.json` by `./setup` |
| Codex, OpenCode, Cursor and other hosts | no | no | No hook support. `gstack-skill-contract check` still works on a Claude Code transcript |

## Routing

The hook scores the prompt against the `triggers:` list in each installed `SKILL.md` (`~/.claude/skills/*/SKILL.md`, or `$CLAUDE_CONFIG_DIR/skills`). It makes no model call and no network request, and the same prompt always gets the same answer.

- A trigger scores 1 when its whole phrase appears in the prompt. Otherwise it scores the share of its content words (common words dropped, light stemming, so "failing" matches "fails") that the prompt contains. A trigger with one content word counts only on its whole phrase, unless that word has five or more letters and is not a question word.
- Only /investigate, /review, /qa and /verify route. In the d7 check (PR #3912), scoring every installed skill's triggers sent 17 of 32 non-fit Terminal-Bench prompts to some skill at 0.66; routing only these four sends 4. The other skills wait for their own trigger review.
- The skill with the best score routes when it reaches the threshold, 0.66: both words of a two-word trigger, or two of three.
- Prompts that start with `/` (you already picked a skill) and prompts over 8,000 characters (pasted logs) are never routed.
- The injected line names its source and its off switch, and asks the model to tell you in one sentence that gstack routed the request.

### Dry run

`gstack-skill-route --explain` shows what the hook would do, with the switch on or off. It never injects anything.

    $ gstack-skill-route --explain "this test fails, fix it"
    switch: skill_routing off (default)
    threshold: 0.66
    skills: 65 scanned in /home/you/.claude/skills
    candidates:
      1.00  /investigate  "fix this bug" (2 words)
      0.67  /ios-fix  "fix this ios bug" (2 words)
    route: /investigate
    hint: gstack skill routing (UserPromptSubmit hook; ...

Add `--json` for a machine-readable answer, or `--threshold <n>` to see another cutoff. `GSTACK_SKILL_ROUTE_HINT=name|step|contract` picks the hint wording the d6 pilot compares: the skill name only (default), plus the skill's first step, or plus its contract.

### Routing log

Every decision is one line in `$GSTACK_STATE_ROOT/hooks/skill-route.log`: the session, the event (`routed`, `no-route` with its reason, or an error) and, for errors, `failures=<n>` for that session. The log never holds prompt text. On any error the hook prints nothing and exits 0; it never blocks a prompt.

## Contracts

### Schema (version 1)

A skill declares its contract in its `SKILL.md` frontmatter:

    contract: { version: 1, items: [ { id, kind, ... } ] }

Every item has an `id` (lowercase letters, digits, `.`, `_`, `-`) and a `kind`, plus optional `fix` (the action the block text names) and `summary` (the phrase the routing hint's contract variant uses). At most 20 items.

| kind | Fields | Met when |
|---|---|---|
| `report_labels` | `heading`, `labels[]` | The last assistant message containing the heading has a `Label: value` line for every label, and no value is empty or a placeholder (`[...]`, `<...>`, TBD, TODO, `...`, or a template like `DONE \| BLOCKED`) |
| `check_after_last_edit` | optional `match` (regular expression) | No Edit, Write, MultiEdit or NotebookEdit happened, or a Bash test or repro command ran after the last one. By default a command counts when, with quoted text removed, one of its parts (split on `&&`, `\|\|`, `;`, `\|`) starts with a test runner, build tool or interpreter (bun, npm, pytest, go, cargo, make, node, python, curl, ...) or a script whose name says test, spec, repro, check, verify or lint, directly or behind a wrapper (`bundle exec rspec`, `uv run pytest`, `docker compose run app pytest`, `xvfb-run npm test`, `bash scripts/test.sh`). `git commit --no-verify`, `cat test/a.test.ts` and the shell's `test -f` do not count |
| `selected_specialists_dispatched` | optional `marker`, `empty_marker` | The selection line was printed in an assistant message or a Bash result (never a fetched page or file), its names are plain (letters, digits, spaces, `_`, `.`, `-`, at most 40 characters), and each specialist it names has an Agent dispatch that mentions it. The marker is literal text in which a whole-word N stands for a number; the default is `Dispatching N specialists:`. N = 0 (`Dispatching 0 specialists: (small diff)`) or a "specialists skipped" line means zero specialists were selected, which passes. Text in parentheses is not a name (`Dispatching 1 specialists: State Machines (small diff)` selects State Machines) |
| `agent_dispatch` | `match` (regular expression, case-insensitive), optional `marker` | The `marker` line (literal text, like /review's `Dispatching adversarial pass: native`) was printed and an Agent dispatch follows it; otherwise, as the fallback, an Agent dispatch's description or prompt matches `match` |

A run the skill ended early counts as met: a final `STATUS: BLOCKED` (for /investigate, `Status: BLOCKED` in its DEBUG REPORT) or a final message with a line that starts "Nothing to review" (/review's early exit).

The checker's default marker strings live in one table, `DEFAULT_MATCHERS` in `lib/skill-contract.ts`; a skill's own `marker`, `empty_marker` or `match` overrides them.

Items are checked against one run of the skill: from its last load to the end of the session, or to its next load when `report` re-checks an earlier run. A load is a Skill tool call, a typed `/name` command, or a Read of its `SKILL.md` under a `skills/` directory (reading the source in a gstack checkout is not a load). A run recorded `met`, `met_waived` or `met_after_block` stays that way, so a later unrelated turn in the same session is never blocked by it.

### Worked example

    contract:
      version: 1
      items:
        - id: debug-report
          kind: report_labels
          heading: DEBUG REPORT
          labels: [Symptom, Root cause, Fix, Evidence]
        - id: repro-after-fix
          kind: check_after_last_edit

A session loads /investigate, edits `src/auth.ts` and answers "Fixed: the null check was missing." with no report and no test run. The Stop hook blocks once with:

    SKILL_CONTRACT_UNMET investigate (contract v1): missing debug-report, repro-after-fix. Fix: debug-report: print the DEBUG REPORT with real values for Symptom, Root cause, Fix, Evidence; repro-after-fix: run the test or repro again after your last edit and show its result. If an item truly does not apply, run gstack-skill-contract waive <item> --reason "<why>" (this session only; counted as a miss for follow). This blocks once.

The model runs `bun test`, prints the DEBUG REPORT, and stops. The record reads `met_after_block`.

### When the Stop hook checks

The hook checks the most recently loaded skill that declares a contract, and only when the turn is a final one:

- the last assistant message has a STATUS line (`STATUS: DONE`, `Status: DONE_WITH_CONCERNS`, `**Status:** BLOCKED` and the like), or
- the session is headless or unattended (`gstack-session-kind`), or
- the turn does not end on a question to the user (a last paragraph ending in "?", an AskUserQuestion call, or `NEEDS_CONTEXT`).

So an interactive session that pauses to ask a question is never blocked. When Claude Code says a Stop hook already continued this turn (`stop_hook_active`), the hook never blocks: after its own block it records the result (`met_after_block` or `miss`). It also allows the stop while Agent dispatches are still running (no result yet, or launched in the background with no completion notice naming that agent), because their outputs may still arrive. Because Claude Code can fire Stop before the turn's last message reaches the transcript file, the hook reads the payload's `last_assistant_message` as the turn's final text.

It blocks at most once per skill run. If the model stops again with the contract still unmet, the stop is allowed and the run is recorded as a miss.

### Records

Each Claude Code session has one record, `$GSTACK_STATE_ROOT/skill-contracts/<session id>.json`, written atomically (mode 0600) before any block. Each skill run in it has an outcome: `met`, `met_waived`, `blocked`, `met_after_block` or `miss`. The hook's decisions also go to `$GSTACK_STATE_ROOT/hooks/skill-contract.log`.

## Commands

### check

    gstack-skill-contract check --transcript <path> --skill <name> [--skill-file <SKILL.md>] [--json]

A pure function of a Claude Code transcript (the JSONL a hook payload's `transcript_path` names, under `~/.claude/projects/`). The contract comes from the installed skill's frontmatter, or from `--skill-file`. It prints each item as met, missing or waived. The model never records anything itself, so evals can run the same check on their own transcripts.

### report

    gstack-skill-contract report [--json] [--session <id>]

Lists misses by skill and item, then each missed run. A miss is a run that was blocked and never fixed, stopped again unmet, or met only through a waiver. A run still marked `blocked` is re-checked against its transcript when the file is still there, so a run fixed after its block reads `fixed_after_block`, not a miss.

### waive

    gstack-skill-contract waive <item> --reason "<why>" [--skill <name>]

The escape for an item that truly does not apply (a docs-only change has nothing to test). It is stateless: it checks its arguments and prints an acknowledgement. `check` finds the waiver by reading this Bash call in the transcript, for this session only, and a waived item still counts as a miss for follow. A waive call that failed, has no reason, or names another skill does not count.

## Exit codes and errors

`gstack-skill-contract` exit codes are stable.

<a id="exit-0-met"></a>
### 0: met (SKILL_CONTRACT_MET)

`check`: every item is met or waived. `report` and `waive`: done.

<a id="exit-1-unmet"></a>
### 1: unmet (SKILL_CONTRACT_UNMET)

At least one item is missing. Text output starts with the same line the Stop hook would block with. Do what each item's Fix says, or waive an item that does not apply.

<a id="exit-2-usage"></a>
### 2: usage (SKILL_CONTRACT_USAGE)

A missing or malformed argument: `check` without `--transcript` and `--skill`, `waive` without an item id or `--reason`, or an item the named skill's contract does not have. `gstack-skill-route` uses 2 the same way (SKILL_ROUTE_USAGE).

<a id="state-error"></a>
<a id="exit-3-state-error"></a>
### 3: state error (SKILL_CONTRACT_STATE_ERROR)

A file could not be read or written: the transcript is missing or over 32 MiB, the session record is corrupt, or the state root is not writable. The Stop hook fails open on these and prints one stderr line:

    gstack-skill-contract: SKILL_CONTRACT_STATE_ERROR <path>: <cause>; stop allowed, miss not recorded (see docs/skill-routing-and-contracts.md#state-error)

The stop goes through and nothing is recorded. Fix the named path: make `$GSTACK_STATE_ROOT` writable, or delete a corrupt `skill-contracts/<session>.json` (it only holds this session's outcomes). An invalid contract block in a skill's frontmatter is reported the same way, naming that `SKILL.md`. A hook that runs past its 5 second deadline also fails open here.

<a id="exit-4-unknown-shape"></a>
### 4: unknown transcript shape (SKILL_CONTRACT_UNKNOWN_SHAPE)

The file is not a Claude Code transcript this checker understands (no user or assistant records, or message content that is neither text nor a block list), for example after a Claude Code format change. The Stop hook fails open with a state error line and adds one to `$GSTACK_STATE_ROOT/hooks/skill-contract.canary.json`. A rising canary count means the parser needs an update.

<a id="exit-5-no-contract"></a>
### 5: no contract (SKILL_CONTRACT_NO_CONTRACT)

No installed skill has that name, its `SKILL.md` declares no contract, or the contract block is invalid (the message names the problem, such as an unsupported version or an unknown kind).

<a id="exit-6-not-loaded"></a>
### 6: not loaded (SKILL_CONTRACT_NOT_LOADED)

The transcript never loads the skill, so there is nothing to check.
