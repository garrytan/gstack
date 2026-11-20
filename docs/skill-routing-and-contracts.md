# Skill routing and skill contracts

Three Claude Code hooks that help a model actually run gstack's skills (GST-1088, GST-3110); all three also run on Codex ([Codex](#codex)). All three are on by default. On Opus 5.5, unattended, a hook line naming a skill got it loaded in 58 of 60 bug-fix sessions, where the same skill relying on its description loaded in 0 of 60 (gstack-evals#369, and B1 before it on the same 60 tasks). With the contract hook, all 66 /review sessions ran its specialist reviewers, 42 of them after the hook's one block; in an earlier run without it, 0 of 66 did (gstack-evals board posts GEVA-271 and GEVA-105). Each has one default, `SWITCH_DEFAULT` in `lib/skill-route.ts`; `gstack-config defaults` prints it. With all three off nothing changes. The opt-in gates that hold one skill rule mid-run (the /plan-ceo-review and /autoplan gates) are in [skill-gates.md](skill-gates.md).

- **Skill routing** (`skill_routing`, a UserPromptSubmit hook). When a prompt matches an installed skill's `triggers:`, the hook adds one line of context naming that skill, for example "this request fits /verify. Run /verify with the Skill tool before you start".
- **Skill contracts** (`skill_contracts`, a Stop hook). A skill can declare the outputs that must exist before it is done. When the model tries to stop without them, the hook blocks once and names what is missing.
- **Destructive-command check** (`destructive_guard`, a PreToolUse hook on Bash and PowerShell). /careful's check, run in every session without the model loading /careful: see [below](#destructive-command-check).

## Turn them on or off

Each switch resolves in this order, and the first one set wins:

1. The `./setup` flag: `--skill-routing` / `--no-skill-routing`, `--skill-contracts` / `--no-skill-contracts` and `--destructive-guard` / `--no-destructive-guard` (also `--skill-routing=on|off`). A flag is saved to config, so it survives upgrades.
2. The environment: `GSTACK_SKILL_ROUTING`, `GSTACK_SKILL_CONTRACTS` and `GSTACK_DESTRUCTIVE_GUARD` (`on` or `off`). Not saved.
3. Config: `gstack-config set skill_routing on|off`, `gstack-config set skill_contracts on|off` and `gstack-config set destructive_guard on|off`.
4. The default: `SWITCH_DEFAULT` in `lib/skill-route.ts`, the only place it is written. Setup, the hooks, `gstack-config get|list|defaults` and `gstack-skill-route --default <switch>` all read it.

`on` also accepts yes, true and 1; `off` accepts no, false and 0. Setup warns about any other value, uses the default for that run, and does not save it; the hooks also use the default for such a value. A config file that exists but cannot be read turns all three hooks off in setup and in the hooks, whatever the default, because it may hold an `off` you set.

Setup registers a hook only when its switch is on, prints one line the first time it registers it, and removes the registration when the switch is off (or with `--no-team`). The hooks also read the switch every time they run, so this takes effect on the next prompt without re-running setup:

    gstack-config set skill_contracts off
    gstack-config set skill_routing off
    gstack-config set destructive_guard off

**Upgrading from an install where they were off.** The default used to be off, and nothing was saved unless you chose. So the first `./setup` (or `/gstack-upgrade`) after this change registers each hook you never turned off, prints one line per hook with its off switch, and once prints a short notice listing what it turned on. An off you set earlier, by flag, `gstack-config` or the environment, is read before the default and kept.

The off switch is for people. The text the Stop hook shows the model never mentions it.

## Host support

| Host | Routing hook | Contract Stop hook | Destructive-command check | Notes |
|---|---|---|---|---|
| Claude Code | yes | yes | yes | Registered in `~/.claude/settings.json` by `./setup` |
| Codex | yes | yes, without /review's specialists item | yes, with a deny where Claude Code asks | Registered in `${CODEX_HOME:-~/.codex}/hooks.json` by `./setup --host codex` (Codex 0.170 or newer). Codex runs them only after you trust them: see [Codex](#codex) |
| OpenCode, Cursor and other hosts | no | no | no | gstack registers no hooks on these hosts. `gstack-skill-contract check` still works on a Claude Code transcript or a Codex rollout |

## Routing

The hook scores the prompt against the `triggers:` list in each installed `SKILL.md` (`~/.claude/skills/*/SKILL.md`, or `$CLAUDE_CONFIG_DIR/skills`). It makes no model call and no network request, and the same prompt always gets the same answer.

- A trigger scores 1 when its whole phrase appears in the prompt. Otherwise it scores the share of its content words (common words dropped, light stemming, so "failing" matches "fails") that the prompt contains. A trigger with one content word counts only on its whole phrase, unless that word has five or more letters and is not a question word.
- A bug report is full of everyday words (find, test, run, site) and defect words, so they never add up to a request by themselves. A trigger only partly present needs one of its five-letter-or-longer words, other than the defect word, among the words it shares: "pip cannot find the package and the install fails" no longer matches "find bugs on site". A trigger made only of shorter everyday words, with no defect word, needs them within 8 words of each other: a report that mentions a "call site" and, much later, "regression tests" no longer matches "test the site" (GST-3123).
- Of gstack's own skills, only /review, /qa and /verify route (/investigate did too until it was cut, GST-1717). In the d7 check (PR #3912), scoring every gstack skill's triggers sent 17 of 32 non-fit Terminal-Bench prompts to some skill at 0.66; routing only the four routed skills of that time sent 4. The other gstack skills wait for their own trigger review.
- Any other installed skill that lists `triggers:` in its own SKILL.md routes too (GST-3123). No host but gstack reads that field, so writing it is how a skill asks gstack to route it. A skill is gstack's own when its directory holds `.gstack-owned`, its SKILL.md links into gstack's checkout, or its name is one gstack generates or installs as an alias. A skill built from a gstack-style template, with the same generated-file banner, is not gstack's own.
- An installed skill's triggers are used only when its name is letters, digits, `_`, `:` and `-`, it lists at most 12 triggers of at most 200 characters, and every trigger is letters, digits, spaces and `. , ' ? ! / -`. Otherwise the whole skill is skipped and named in `gstack-skill-route --explain` and the routing log, so trigger text cannot leave its quotes or add markup or shell characters to the hook's line. The quoted trigger is still the skill author's own words, so install only skills you trust.
- Another installed skill's trigger needs at least two content words; a defect word counts as one word however it is spelled, so "error", "the crash" and "error exception" are each one. Shorter triggers are skipped and named the same way, and the skill keeps its others (GST-3142): a lone defect word would otherwise claim most bug reports.
- The skills that reach the threshold, 0.66 (both words of a two-word trigger, or two of three), are ranked by score; at the same score gstack's own skill comes first, then the trigger with more matched words, then the name. The line names the top skill, or the top two different skills: "this request fits /verify or /notes. Run the one that fits better ...".
- A bug report goes to the installed skill that claims bug reports, named alone, whatever the other triggers score (GST-3237). A skill claims bug reports when one of its triggers names the defect and fixing it, and nothing else ("fix this bug", "reproduce the bug in a test"); a trigger that names its own target ("fix lint errors", "fix postgres bugs") claims only that kind of fix. gstack's own routed skills only check work, so they never claim one, and /verify is never named ahead of the bug-fix skill. A prompt that holds the whole phrase of one of /review's or /qa's own triggers ("review this pr for bugs", "find bugs on site") and never asks for a fix keeps that skill, since finding bugs is not fixing one. With none installed, a bug report routes on triggers as before. In B1d's in-sample run (gstack-evals #385), Opus 5.5 loaded prove-it in 29 of 33 sessions when the line named it alone and in none of the 20 where it was not named, and took /verify in 4 of the 7 where /verify came first. On B1's 60 in-sample prompts the line now names prove-it alone on all 46 bug reports; before, it named prove-it on 40 of the 60 and put /verify first on 7 of those (`test/fixtures/skill-route-b1-in-sample.json` labels each prompt).
- A prompt reads as a bug report on one strong sign: a word for what went wrong (bug, crash, hang, stuck, leak, wrong, incorrect, unexpected, regression and the like), an exception name such as `ValueError`, the verb fix, an issue template's expected or actual heading ("expected behavior", "steps to reproduce", "correct output"), a failure verb ("fails", "failed to", "doesn't work") or a "should X, not Y" correction. Feature requests use error, exception and failure as nouns ("add error handling", "a custom exception class"), so those words, a negated verb, "should" and "instead of" are weak signs, and it takes two different ones. None of the 60 plain prompts in `test/fixtures/skill-route-plain-prompts.txt` reads as a bug report; 5 of B1's 14 in-sample feature requests do.
- Words a bug report uses for the defect (error, exception, traceback, crash, fails, failure, broken, regression, incorrect, wrong, defect, and exception names such as `ValueError`) score as "bug", so "parse_one raises ValueError, please fix" matches a "fix this bug" trigger. Paths and identifiers stay whole (`site-packages`, `src/review.ts`, `max_retries`), so a traceback's paths never match a trigger's words.
- Triggers and the bug-report signs read only the prompt's prose. Markdown code, meaning inline code in backticks and fenced code blocks as CommonMark reads them, is left out, so a command quoted in backticks never routes a prompt (#4564): "Run `mycli check` now" no longer matches "run the checks", "Run `gh pr review 123`" no longer matches "review this pr", and a `--fix` flag or the word broken in a pasted log is not a bug report. The prose around the code still routes ("run the checks, then `git push`"). One sign still reads the code: an exception name as code writes it (`KeyError`, `NullPointerException`), since a quoted error or a pasted traceback reports a bug.
- When a trigger ties with another of the same skill on score and words, a whole-phrase match wins.
- A prompt longer than 5,000 characters is scored on its first 4,000 and last 1,000 characters, where the request usually sits; a log pasted between them is not scored, so its words cannot match everything. Until GST-3110 such prompts (over 8,000 characters) were never routed.
- Prompts that start with `/` (you already picked a skill) are never routed.
- The injected line names its source and its off switch, and asks the model to tell you in one sentence that gstack routed the request.

### Dry run

`gstack-skill-route --explain` shows what the hook would do, with the switch on or off. It never injects anything.

    $ gstack-skill-route --explain "run the checks and verify my change"
    switch: skill_routing on (default)
    threshold: 0.66
    skills: 63 scanned in /home/you/.claude/skills
    candidates:
      1.00  /verify  "verify my change" (2 words, gstack)
      0.50  /review  "review my changes" (1 words, gstack)
    route: /verify
    hint: gstack skill routing (UserPromptSubmit hook; ...

Add `--json` for a machine-readable answer, or `--threshold <n>` to see another cutoff; a bug-report route says so (`bug_report: true` in JSON). `GSTACK_SKILL_ROUTE_HINT=name|step|contract` picks the hint wording the d6 pilot compares: the skill name only (default), plus the skill's first step, or plus its contract. The step and contract styles quote only gstack's own skills, whose text ships in gstack's checkout; for any other skill the line is the default one, so an installed skill's body or contract text never reaches the model unchecked (GST-3142).

### Routing log

Every decision is one line in `$GSTACK_STATE_ROOT/hooks/skill-route.log`: the session, the event (`routed`, `no-route` with its reason, or an error), for a route the skill, its score and its `source` (`gstack`, or the installed SKILL.md's path) plus `also=` for a second skill and `bug_report=true` for a bug-report route, and, for errors, `failures=<n>` for that session. The log never holds prompt text. On any error the hook prints nothing and exits 0; it never blocks a prompt.

<a id="destructive-command-check"></a>
## Destructive-command check

`./setup` registers `hosts/claude/hooks/destructive-guard-hook` as a PreToolUse hook on `Bash|PowerShell`. It runs `careful/bin/check-careful.sh`, the same check /careful and /guard load, so it fires even when the model never loads /careful. Its decisions are the check's own: `ask` before the destructive families (`rm -rf`, `DROP TABLE`, `TRUNCATE`, force-push, `git reset --hard`, `kubectl delete` and the rest in /careful's table), which you can always approve, and `deny` for three catastrophic shapes in any command shape (a recursive delete of `/`, your home directory or a system or personal folder; a force-push to `main`, `master` or the default branch; a raw write or wipe of a whole disk). An ask's reason, which you read, adds `(gstack's destructive-command check, on in every session; off: gstack-config set destructive_guard off)`; a deny's reason, which the model reads, never names the off switch. In a session nobody is watching (`claude -p`, which Claude Code marks `CLAUDE_CODE_ENTRYPOINT=sdk-cli`; an Agent SDK program, marked `sdk-py` or `sdk-ts`; or a session `gstack-session-kind` reports as headless), an ask would wait for an answer that never comes, so the hook prints the same reason as a warning and lets the command run, which is what happens when the check is off; a deny stays a deny. It costs about a tenth of a second per Bash call.

In an Agent SDK program an ask with no permission callback is denied outright (checked with a real SDK run), which is why SDK sessions get the warning. An SDK host where a person does answer asks, through a permission callback, should set `GSTACK_SESSION_KIND=interactive` to keep them, which wins even when `CI=1` is set; Conductor is recognized on its own. A harness that drives Claude Code some other way with nobody to answer (a CI job, an eval runner) should set `GSTACK_SESSION_KIND=unattended`, so the hook turns its asks into warnings the same way.

The hook reads `destructive_guard` every time it runs, so `gstack-config set destructive_guard off` takes effect on the next command. With it off, /careful and /guard still load their own session hooks.

<a id="codex"></a>
## Codex

`./setup --host codex` (or `./setup --host auto` when `codex` is on your PATH) registers the routing hook, the contract Stop hook and the destructive-command check in `${CODEX_HOME:-~/.codex}/hooks.json`, each in its own matcher group: routing on `UserPromptSubmit` with a 5-second timeout, the contract hook on `Stop` with a 10-second timeout (as on Claude Code), the check on `PreToolUse` for `Bash` with a 10-second timeout. The same three switches, in the same order, turn them on and off on both hosts; Codex adds its own two, a hook's toggle in `/hooks` and `[features] hooks = false` in `config.toml` for every hook at once. On native Windows, Codex starts hooks through `cmd.exe`, which can't run these Bash scripts, so gstack's Codex hooks don't run there yet.

**You trust them once.** Codex runs a hook only after you trust it, and skips an untrusted one without saying so. Setup never writes that trust. It prints one line, "gstack added 3 Codex hook(s); trust them at Codex's startup prompt or in /hooks", and the next time you start Codex it shows "Hooks need review": pick "Trust all and continue", or review them one by one in `/hooks`. `gstack-doctor` has a `codex hooks` row saying whether `config.toml` holds a trust entry for each of gstack's hooks. It only checks that an entry exists; it never computes Codex's hash. Codex asks again when a hook's command or timeout changes, so the commands point at the stable runtime root (`${CODEX_HOME:-~/.codex}/skills/gstack/hosts/codex/hooks/`), and an upgrade that only changes the scripts behind them asks nothing. Codex also keys trust by a group's position in the file, so setup adds gstack's groups after yours and never reorders them. Evals and CI that run `codex exec` pass `--dangerously-bypass-hook-trust`.

**Your own hooks stay as they are.** Codex 0.170 skips the whole `hooks.json` when it holds a key it does not know, your hooks included. So gstack adds no marker keys (it recognizes its groups by their command path), checks the new file against Codex's schema before moving it into place, and keeps the lock, the `hooks.json.bak.<ts>` backup and `gstack-settings-hook rollback` that `settings.json` has (`GSTACK_HOOKS_FORMAT=codex gstack-settings-hook rollback`). Setup leaves the file alone, prints why and carries on when the file does not parse or already fails Codex's schema, when `config.toml` does not parse, or when `config.toml` already declares one of gstack's hooks under `[hooks]` (Codex would run it twice). It also skips the hooks, saying why, when `codex` is missing or older than 0.170. `./setup --host codex --no-team` (plain `./setup --no-team` installs for Claude Code only, so it leaves the Codex hooks alone; `--host auto` with `codex` on your PATH also reaches them) and `gstack-uninstall` remove gstack's groups and nothing else. Codex keys trust by position, so removing a group that your own groups come after would shift yours and Codex would stop trusting them (`codex exec` skips an untrusted hook without asking). So gstack leaves an empty group, `{ "hooks": [] }`, where its own was, and your hooks keep their positions; an emptied group at the end of an event is dropped. If one of your own handlers comes after gstack's inside the same group, gstack leaves the file unchanged and names the gstack handler to delete by hand; then re-trust your hooks in `/hooks`.

**Routing on Codex** scans `${CODEX_HOME:-~/.codex}/skills`, names each of gstack's skills by the `name:` in its installed `SKILL.md`, which is the name Codex lists and you mention with `$` (the `gstack-review` folder holds `name: review`, so `$review`), and takes their triggers from the same skill in gstack's checkout, because Codex's copies keep only a name and a description. A skill whose `name:` is missing or unreadable is named by its folder. The line reads "this request fits the review skill. Read and follow the review skill before you start". A prompt that starts with `$` (a Codex skill mention) or `/` is never routed.

**The destructive-command check on Codex** runs the same `check-careful.sh`, but Codex has no "ask": its hook parser rejects `permissionDecision: "ask"` and lets the command run. So in an interactive Codex session, every command the check would ask about is blocked instead, and the reason tells the model to stop and ask you. If you want it, run it yourself by typing `!` and the command in Codex (Codex runs `!` commands without hooks), or turn the check off. In `codex exec`, and any session `gstack-session-kind` reports as headless or unattended, it is a warning and the command runs, as on Claude Code. The two deny shapes stay a deny everywhere. Codex already refuses some `rm -rf` commands by itself, before any hook runs.

**Contracts on Codex** use the same Stop hook, with the same one block per skill run, records and fail-open rules; Codex sends it the same `stop_hook_active` and `last_assistant_message` keys and takes the same block answer. The transcript is Codex's rollout file (`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`), and the checker tells it from a Claude Code transcript by what the file holds (a rollout starts with a `session_meta` record), never by its path. On Codex:

- A **load** is Codex injecting a `gstack-*` skill into the conversation as a `<skill>` message (the app server's skill input does this), or the model reading one with a shell command such as `cat ~/.codex/skills/gstack-review/SKILL.md`. `codex exec '$review ...'` also injects the skill as a `<skill>` message (codex-cli 0.170); a mention of the folder name instead of the listed name is plain text, so then the skill loads only when the model reads it.
- A **dispatch** is a call to Codex's own `spawn_agent` that started an agent: its result names an `agent_id` (the `multi_agent_v1` tools) or, when Codex serves the tool in its `collaboration` namespace (as it does for gpt-6.1-sol), a `task_name`. One that failed (its result names neither), or a tool of the same name from another namespace, doesn't count.
- **The contract** comes from gstack's own copy of the skill (`<gstack>/review/SKILL.md`), because Codex's installed `SKILL.md` keeps only its name and description.
- **/review's `specialists-dispatched` item is skipped**, because Codex doesn't run /review's specialist reviewers yet. The adversarial pass and the report are checked as on Claude Code, and the block text names `spawn_agent` and `wait_agent` where Claude Code's names an Agent dispatch.
- **A subagent's own rollout is never checked**: its first record names the parent thread.

**Reasoning effort.** gstack's workflows do best at high reasoning effort. Setup leaves your `config.toml` alone and prints a reminder; start Codex with `codex -c model_reasoning_effort=high` when you run them.

## Contracts

### Schema (version 1)

A skill declares its contract in its `SKILL.md` frontmatter:

    contract: { version: 1, items: [ { id, kind, ... } ] }

Every item has an `id` (lowercase letters, digits, `.`, `_`, `-`) and a `kind`, plus optional `fix` (the action the block text names) and `summary` (the phrase the routing hint's contract variant uses). At most 20 items.

| kind | Fields | Met when |
|---|---|---|
| `report_labels` | `heading`, `labels[]` | The last assistant message containing the heading has a `Label: value` line for every label, and no value is empty or a placeholder (`[...]`, `<...>`, TBD, TODO, `...`, or a template like `DONE \| BLOCKED`) |
| `selected_specialists_dispatched` | optional `marker`, `empty_marker` | The selection line was printed in an assistant message or a Bash result (never a fetched page or file), its names are plain (letters, digits, spaces, `_`, `.`, `-`, at most 40 characters), and each specialist it names has an Agent dispatch that mentions it. The marker is literal text in which a whole-word N stands for a number; the default is `Dispatching N specialists:`. N = 0 (`Dispatching 0 specialists: (small diff)`) or a "specialists skipped" line means zero specialists were selected, which passes. Text in parentheses is not a name (`Dispatching 1 specialists: State Machines (small diff)` selects State Machines) |
| `agent_dispatch` | `match` (regular expression, case-insensitive) | An Agent dispatch's description or prompt matches `match`. A `marker` is rejected until the checker can bind it to the dispatch it names (GST-1242) |

There is no item for "run a test after your last edit". /verify asks for that in its text, and Opus 5.5 and GPT-6.1 Sol already did it in 96% and 89% of runs; a Stop-hook item for it added no measurable gain (gstack-evals#356), so it was removed. A contract that still lists `check_after_last_edit` keeps its other items. The checker skips that item and prints `SKILL_CONTRACT_SKIPPED <SKILL.md>: <item id>: ...` on stderr each time it reads the contract (the Stop hook and `check`). A contract whose only items use that kind is invalid.

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

A skill you wrote, `bugfix`, declares that contract. A session loads it, edits `src/auth.ts` and answers "Fixed: the null check was missing." with no report. The Stop hook blocks once with:

    SKILL_CONTRACT_UNMET bugfix (contract v1): missing debug-report. Fix: debug-report: print the DEBUG REPORT with real values for Symptom, Root cause, Fix, Evidence. If an item truly does not apply, run '<gstack>/bin/gstack-skill-contract' waive <item> --reason "<why>" (this session only; counted as a miss for follow). This blocks once.

The model prints the DEBUG REPORT and stops. The record reads `met_after_block`.

### When the Stop hook checks

The hook checks the most recently loaded skill that declares a contract, and only when the turn is a final one:

- the last assistant message has a STATUS line (`STATUS: DONE`, `Status: DONE_WITH_CONCERNS`, `**Status:** BLOCKED` and the like), or
- the session is headless or unattended (`gstack-session-kind`), or
- the turn does not end on a question to the user (a last paragraph ending in "?", an AskUserQuestion call, or `NEEDS_CONTEXT`).

So an interactive session that pauses to ask a question is never blocked. When Claude Code says a Stop hook already continued this turn (`stop_hook_active`), the hook never blocks: after its own block it records the result (`met_after_block` or `miss`). On a final turn it also allows the stop while Agent dispatches are still running (no result yet, or launched in the background with no completion notice naming that agent), because their outputs may still arrive, and records the run as `deferred`. Once the same agents have been running for 10 minutes since the stop that first saw them, they count as stalled and the contract is checked at the next stop. Because Claude Code can fire Stop before the turn's last lines reach the transcript file (about 200 ms late in a smoke run), the hook re-reads the file until it holds the payload's `last_assistant_message`, for at most 2 seconds (`readSettledTranscript` in `lib/skill-gates.ts`, the loop the skill gates share). If the message never shows up, it counts that message as the turn's final text. A single read could miss the final report and block a finished run, or miss the skill load and let an unfinished one through.

It blocks at most once per skill run. If the model stops again with the contract still unmet, the stop is allowed and the run is recorded as a miss.

### Records

Each session has one record, `$GSTACK_STATE_ROOT/skill-contracts/<session id>.json`, written atomically (mode 0600) before any block. Each skill run in it has an outcome: `met`, `met_waived`, `blocked`, `met_after_block`, `miss` or `deferred` (stopped while its agents were still running, not yet checked; `report` re-checks it against its transcript). The hook's decisions also go to `$GSTACK_STATE_ROOT/hooks/skill-contract.log`.

## Commands

### check

    gstack-skill-contract check --transcript <path> --skill <name> [--skill-file <SKILL.md>] [--json]

A pure function of a Claude Code transcript or a Codex rollout (the JSONL a hook payload's `transcript_path` names, under `~/.claude/projects/` or `~/.codex/sessions/`). The contract comes from the installed skill's frontmatter (on Codex, gstack's own copy of the skill), or from `--skill-file`. It prints each item as met, missing or waived. The model never records anything itself, so evals can run the same check on their own transcripts.

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

The file is not a transcript this checker understands: a Claude Code transcript with no user or assistant records, or message content that is neither text nor a block list, or a Codex rollout with no message records or a record shaped in a way the reader doesn't know. That usually means Claude Code or Codex changed its format. The Stop hook fails open with a state error line and adds one to `$GSTACK_STATE_ROOT/hooks/skill-contract.canary.json`. A rising canary count means the parser needs an update.

<a id="exit-5-no-contract"></a>
### 5: no contract (SKILL_CONTRACT_NO_CONTRACT)

No installed skill has that name, its `SKILL.md` declares no contract, or the contract block is invalid (the message names the problem, such as an unsupported version or an unknown kind).

<a id="exit-6-not-loaded"></a>
### 6: not loaded (SKILL_CONTRACT_NOT_LOADED)

The transcript never loads the skill, so there is nothing to check.
