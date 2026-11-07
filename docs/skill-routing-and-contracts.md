# Skill routing and skill contracts

Two Claude Code hooks that help a model actually run gstack's skills (GST-1088). Each has one default, `SWITCH_DEFAULT` in `lib/skill-route.ts`; `gstack-config defaults` prints it. With both off nothing changes. The opt-in gates that hold one skill rule mid-run (the /plan-ceo-review and /autoplan gates) are in [skill-gates.md](skill-gates.md).

- **Skill routing** (`skill_routing`, a UserPromptSubmit hook). When a prompt matches an installed skill's `triggers:`, the hook adds one line of context naming that skill, for example "this request fits /verify. Run /verify with the Skill tool before you start".
- **Skill contracts** (`skill_contracts`, a Stop hook). A skill can declare the outputs that must exist before it is done. When the model tries to stop without them, the hook blocks once and names what is missing.

## Turn them on or off

Each switch resolves in this order, and the first one set wins:

1. The `./setup` flag: `--skill-routing` / `--no-skill-routing` and `--skill-contracts` / `--no-skill-contracts` (also `--skill-routing=on|off`). A flag is saved to config, so it survives upgrades.
2. The environment: `GSTACK_SKILL_ROUTING` and `GSTACK_SKILL_CONTRACTS` (`on` or `off`). Not saved.
3. Config: `gstack-config set skill_routing on|off` and `gstack-config set skill_contracts on|off`.
4. The default: `SWITCH_DEFAULT` in `lib/skill-route.ts`, the only place it is written. Setup, the hooks, `gstack-config get|list|defaults` and `gstack-skill-route --default <switch>` all read it.

`on` also accepts yes, true and 1; `off` accepts no, false and 0. Setup warns about any other value, uses the default for that run, and does not save it; the hooks also use the default for such a value. A config file that exists but cannot be read turns both hooks off in setup and in the hooks, whatever the default, because it may hold an `off` you set.

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
- Only /review, /qa and /verify route (/investigate did too until it was cut, GST-1717). In the d7 check (PR #3912), scoring every installed skill's triggers sent 17 of 32 non-fit Terminal-Bench prompts to some skill at 0.66; routing only the four routed skills of that time sent 4. The other skills wait for their own trigger review.
- The skill with the best score routes when it reaches the threshold, 0.66: both words of a two-word trigger, or two of three.
- Prompts that start with `/` (you already picked a skill) and prompts over 8,000 characters (pasted logs) are never routed.
- The injected line names its source and its off switch, and asks the model to tell you in one sentence that gstack routed the request.

### Dry run

`gstack-skill-route --explain` shows what the hook would do, with the switch on or off. It never injects anything.

    $ gstack-skill-route --explain "run the checks and verify my change"
    switch: skill_routing off (default)
    threshold: 0.66
    skills: 63 scanned in /home/you/.claude/skills
    candidates:
      1.00  /verify  "verify my change" (2 words)
      0.50  /review  "check my diff" (1 words)
    route: /verify
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
| `check_after_last_edit` | optional `match` (regular expression) | No edit happened, or a Bash test or repro command ran after the last one. An edit is an Edit, Write, MultiEdit or NotebookEdit call, or a Bash command that writes a file inside the session directory (the transcript's first `cwd`): a `>`, `>>` or `&>` redirect, `tee`, `sed -i` or `perl -i`, `patch` or `git apply`, or an inline or heredoc python, node, ruby, bun or deno script that opens a literal path for writing (directly or through a variable assigned one, as in `python3 - <<'EOF'`), including a script the same command wrote first. A check later in the same Bash command counts (`sed -i ... && bun test`), and so does the command whose output the write captures (`bun test > out.log`, `bun test \| tee test.log`). Reads, output to stdout, fd duplications (`2>&1`), `/dev` paths, targets outside the session directory (`/tmp`, `~`, `../`) and targets named by a variable (`"$f"`) are not edits; `lib/shell-writes.ts` holds the parser (GST-1633). By default a command counts when, with quoted text removed, one of its parts (split on `&&`, `\|\|`, `;`, `\|`) runs a test runner (pytest, jest, vitest, rspec, tsc, ...), a test or check verb (`npm test`, `go test`, `cargo run`, `make check`, `bun run lint`), code through an interpreter (`node repro.js`, `python -c ...`, `bun scripts/repro.ts`), `curl` against a URL, or a script whose name says test, spec, repro, check, verify or lint, directly or behind a wrapper (`bundle exec rspec`, `uv run pytest`, `docker compose run app pytest`, `xvfb-run npm test`, `bash scripts/test.sh`). Installs, builds, cleans and version probes (`bun install`, `npm install`, `go build`, `make clean`, `node --version`), `git commit --no-verify`, `cat test/a.test.ts` and the shell's `test -f` do not count |
| `selected_specialists_dispatched` | optional `marker`, `empty_marker` | The selection line was printed in an assistant message or a Bash result (never a fetched page or file), its names are plain (letters, digits, spaces, `_`, `.`, `-`, at most 40 characters), and each specialist it names has an Agent dispatch that mentions it. The marker is literal text in which a whole-word N stands for a number; the default is `Dispatching N specialists:`. N = 0 (`Dispatching 0 specialists: (small diff)`) or a "specialists skipped" line means zero specialists were selected, which passes. Text in parentheses is not a name (`Dispatching 1 specialists: State Machines (small diff)` selects State Machines) |
| `agent_dispatch` | `match` (regular expression, case-insensitive) | An Agent dispatch's description or prompt matches `match`. A `marker` is rejected until the checker can bind it to the dispatch it names (GST-1242) |

A run the skill ended early counts as met: a final `STATUS: BLOCKED` (or `Status: BLOCKED` in the skill's report) or a final message with a line that starts "Nothing to review" (/review's early exit).

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

A skill you wrote, `bugfix`, declares that contract. A session loads it, edits `src/auth.ts` and answers "Fixed: the null check was missing." with no report and no test run. The Stop hook blocks once with:

    SKILL_CONTRACT_UNMET bugfix (contract v1): missing debug-report, repro-after-fix. Fix: debug-report: print the DEBUG REPORT with real values for Symptom, Root cause, Fix, Evidence; repro-after-fix: run the test or repro again after your last edit and show its result. If an item truly does not apply, run '<gstack>/bin/gstack-skill-contract' waive <item> --reason "<why>" (this session only; counted as a miss for follow). This blocks once.

The model runs `bun test`, prints the DEBUG REPORT, and stops. The record reads `met_after_block`.

### When the Stop hook checks

The hook checks the most recently loaded skill that declares a contract, and only when the turn is a final one:

- the last assistant message has a STATUS line (`STATUS: DONE`, `Status: DONE_WITH_CONCERNS`, `**Status:** BLOCKED` and the like), or
- the session is headless or unattended (`gstack-session-kind`), or
- the turn does not end on a question to the user (a last paragraph ending in "?", an AskUserQuestion call, or `NEEDS_CONTEXT`).

So an interactive session that pauses to ask a question is never blocked. When Claude Code says a Stop hook already continued this turn (`stop_hook_active`), the hook never blocks: after its own block it records the result (`met_after_block` or `miss`). On a final turn it also allows the stop while Agent dispatches are still running (no result yet, or launched in the background with no completion notice naming that agent), because their outputs may still arrive, and records the run as `deferred`. Once the same agents have been running for 10 minutes since the stop that first saw them, they count as stalled and the contract is checked at the next stop. Because Claude Code can fire Stop before the turn's last lines reach the transcript file (about 200 ms late in a smoke run), the hook re-reads the file until it holds the payload's `last_assistant_message`, for at most 2 seconds (`readSettledTranscript` in `lib/skill-gates.ts`, the loop the skill gates share). If the message never shows up, it counts that message as the turn's final text. A single read could miss the test rerun after the last edit and block a finished run, or miss the skill load and let an unfinished one through.

It blocks at most once per skill run. If the model stops again with the contract still unmet, the stop is allowed and the run is recorded as a miss.

### Records

Each Claude Code session has one record, `$GSTACK_STATE_ROOT/skill-contracts/<session id>.json`, written atomically (mode 0600) before any block. Each skill run in it has an outcome: `met`, `met_waived`, `blocked`, `met_after_block`, `miss` or `deferred` (stopped while its agents were still running, not yet checked; `report` re-checks it against its transcript). The hook's decisions also go to `$GSTACK_STATE_ROOT/hooks/skill-contract.log`.

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
