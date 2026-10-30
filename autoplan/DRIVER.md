<!-- AUTO-GENERATED from autoplan/DRIVER.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# /autoplan driver: run the review loop from a parent agent

Read this file instead of `autoplan/SKILL.md` when you (a parent agent on any host) drive an
unattended /autoplan run through `gstack-autoplan`: the reviewers are subagents you dispatch,
and the runner keeps the state. The commands live in `<root>/bin/`, where `<root>` is the
folder that holds this `autoplan/` directory; `gstack-autoplan --help` and the first `next`
print `DRIVER: <root>/autoplan/DRIVER.md`. Run every command with the `GSTACK_LAUNCH` assignments your installer printed: `. <the GSTACK_LAUNCH_FILE it printed>` in the shell that runs the command,
never `export $(...)`, `env`, `printenv` or a bare `set` in a tool fence (a bare `export` prints every variable, credentials included). Read printed lines and files, never prose: every workflow
command ends with `GSTACK_RESULT: skill=autoplan status=<s> run=<dir>`, and every error line
ends with `(<CODE>)`.

## Phases and scope

Order: ceo → design → dx → eng. Design runs only with UI scope, DX only with DX scope, Eng always and last.
Scope flags on the first `next`: `--ui`, `--no-ui`, `--no-dx`, `--developer-tool`, `--agent-primary`, `--docs-only`. `--developer-tool` and `--agent-primary` only enable DX.
The first `next` prints `SCOPE: ui=… (terms; visual; files) dx=… (detected) docs_only=yes|no (<s>) source=ui:<s>,dx:<s>`
(each is `flag`, `marker` or `detected`). Docs-only (`--docs-only`, or every Implementation-plan path is README*, CHANGELOG*,
TODOS*, docs/** but not docs/*-policy.md, or other markdown outside a skill dir) runs CEO on the native voice only, then Eng. UI needs a rendered file path or a UI term next
to a visual noun in the Implementation plan. To keep flags for later runs on the same plan, add
the `SCOPE_PIN:` marker it prints (`<!-- gstack-autoplan-scope: … -->`) as the plan's first
line yourself; gstack never writes the plan.

## The loop

1. `next` prints one `ATTEMPT: <id> phase=<p> voice=native|outside prompt=<file> result=<file>`
   per voice. Dispatch the native prompt to a subagent on your model and the outside prompt to
   a subagent on another model family (or `gstack-outside-voice run`). Each writes `result=`. The first `next` also prints `REVIEW_ESTIMATE:` (most attempts and reservations the review can take).
2. Submit each voice exactly once (`BOUND:`). Both voices in closes the phase (`PHASE_CLOSED:`).
3. Repeat `next` until `status=gate_pending` (`GATE: gate_rev=<n>`); render it with `gstack-gate render <dir>/gate.json --all` and relay every page with the two cost lines printed under `GATE:`: `GATE_SPEND:` (spent, worst case, cap, headroom, attempts; host-subagent attempts are priced unknown and counted at their reservation, so quote their real figure from the host's cost view) and `GATE_REC_COST:` (the phases `rec` can reopen and the estimate for them, an upper bound; `gate_cost` in `--json`).
   You never approve the gate for the owner. Offer `rec` (every recommendation, plan changes included) as the default.
4. `answer` with the owner's reply and `--by human` (the owner typed the tokens) or `--by agent:<id> --owner-reply "<their words>"` (you relayed them); without `--by` an
   unattended run refuses (`ANSWER_BY_REQUIRED`). `APPLY: <id> <title> -> <change>` lines are
   accepted plan changes (status `amend_pending`): edit the plan, then `revise` (the printed
   `NEXT:` names it), or `revise --settle <id>` when the line says no plan edit is needed. Until
   then `next` refuses with `PLAN_AMEND_PENDING` and `export` will not mark the run complete.
5. `REOPENED: <phases>` means loop `next` again (Eng last). `APPROVED:` means `export` (`DISPATCHES: <n> est_input_tokens=<k>`, relative).
6. Rounds: one by default; a second only for High or Critical findings; cap 2 (`--max-rounds`). A `revise` whose decisions all resolve below
   High prints `APPLIED: <ids> without re-review (below High)`. At the cap with High open, `ESCALATE: evidence sufficient, decision needed`: relay it, never ask for another round.
7. Carry-forward ([docs/unattended.md#carry-forward](../docs/unattended.md#carry-forward); `--no-carry-forward` on the first `next` opts out): a later gate that asks nothing new takes the owner's words from the gate before it (`CARRIED:`, then `APPROVED:`); `CARRY: no (<why>)` leaves it for the owner; `CARRY_CHECK:` means one reviewer from another model family reads the printed delta prompt, then `check --out <dir> --attempt <id> --result <file> --model <id>` (or `--unavailable "<reason>"`).

### On Capy

- Always drive `gstack-autoplan`; never hand-adapt `autoplan/SKILL.md`. A plan you reviewed by
  hand is not an autoplan run: do not present it as one.
- Every prompt ends with a `GSTACK TRAILER` block: the reviewer runs the `--for review-voice`
  install on its own machine (no ./setup, no skills; seconds when warm) and starts its reply
  with the `gstack:` line. Never tell a reviewer that no install is needed; relay each
  reviewer's line with its result, and treat a missing line as `gstack: fail not-installed`.
- Set `GSTACK_AUTOPLAN_CHECKPOINT_DIR` to the private project-user Drive folder (or opt every run in
  with `gstack-config set autoplan_checkpoint drive`) so a run survives machine replacement: a
  generation is published at rest, after each bound voice and after each phase transition; restore
  with `resume --out <new dir> --from <dir>/<run>`, which never redispatches a bound voice.
- Plans carry `## ELI5` (5-10 plain sentences), `## Before → after`, `## Why it matters`, `## What caused this work`, `## Big decisions`;
  relay the printed `RELAY: gstack-owner-brief render --captain` output to your Captain (or the person), then `gstack-approvals import --autoplan <dir>` after `answer` (`--stack <b1,b2,...>` for a stack; `capy/skill/gstack/captain.md`).

### Commands

- `gstack-autoplan next --out <dir> --plan <plan.md> [scope flags] [--light] [--spend-cap <usd>] [--max-rounds <n>] [--scaffold]`
  first call: init the run, print PHASE:, SCOPE:, DRIVER: and one ATTEMPT: per voice; --max-rounds caps review rounds per phase (default 2 unattended), and an unattended Capy run reserves 5.00 per host attempt unless --estimate-usd <n> says otherwise, so --spend-cap binds.
- `gstack-autoplan next --out <dir> [--redispatch <attempt>]`
  later calls: open the next phase or reprint open attempts; never redispatches on its own.
- `gstack-autoplan submit --out <dir> --phase <p> --voice native|outside --record <file.md> --model <id> [--attempt <id>]`
  bind a free-form review record (canonical fence, one findings table or list, or `No findings.`).
- `gstack-autoplan submit ... --record <file.md> --attest "<reason>" --attempt <id>`
  bind a record with no INPUT: line as receipt: attested (a wrong INPUT: always refuses).
- `gstack-autoplan submit --out <dir> --phase <p> --voice native|outside --result <file> --model <id> --attempt <id>`
  bind a canonical result (the RESULT FORMAT below).
- `gstack-autoplan submit --out <dir> --phase <p> --voice outside --unavailable|--failed "<reason>"`
  close the phase native-only when no outside voice can run.
- `gstack-autoplan answer --out <dir> --gate-rev <n> --reply "<reply>" --by human|agent:<id> [--owner-reply <text>|-] [--rec-hash <h>]`
  answer the gate with the reply grammar below; an agent answer stores the owner's words verbatim.
- `gstack-autoplan recommend --out <dir> --gate-rev <n> --item <id> --option <k> --basis "<why>"`
  change one recommendation before relay; then render and relay again (a `rec` needs the new `--rec-hash`).
- `gstack-autoplan revise --out <dir> --plan <plan v2> --incorporates <decision ids>`
  bind the amended plan; reopens every phase whose reviewed plan changed, Eng last.
- `gstack-autoplan revise --out <dir> --settle <decision id|d4>`
  discharge a packaging or ordering change with no plan edit; reopens nothing.
- `gstack-autoplan revise --out <dir> --withdraw <decision id>`
  drop a pending amendment instead of applying it.
- `gstack-autoplan close --out <dir> --phase <p> --deferred "<reason>" --by human|agent:<id>`
  close a phase accepted-with-findings: its open findings go to tasks.jsonl, and Critical, urgent or user-challenge findings become gate items; also the recovery from `STOP: reason=budget_exhausted`.
- `gstack-autoplan budget --out <dir> [--spend-cap <usd>] [--max-rounds <n>] --by human|agent:<id>`
  the owner's journaled cap raise; after a budget stop, `resume` continues the run.
- `gstack-autoplan export --out <dir>`
  write the artifact set; then `gstack-artifact validate <dir>/run.json`.
- `gstack-autoplan export --out <dir> --public <pub>`
  a machine-path-free copy to commit or share (recorded roots rewritten, plan.md code kept, provenance digests); the private run is not touched; then `gstack-artifact validate --public <pub> --private <dir>/run.json` on this machine.
- `gstack-autoplan status|resume --out <dir>`
  read the manifest (PENDING: lines name open attempts); take ownership after a crash (EXECUTION_UNKNOWN lists unfinished attempts).
- `gstack-autoplan resume --out <new dir> --from <checkpoint>`
  restore the newest valid checkpoint generation (GSTACK_AUTOPLAN_CHECKPOINT_DIR) into an empty directory and take ownership; `checkpoints --from <dir>` lists them.

## Reviewer result format

Every prompt ends with this contract; `submit --result` enforces it, `submit --record` accepts the looser shapes above.

RESULT FORMAT (required by gstack-autoplan; the parent binds your file by this contract):
1. The first line of your result is exactly: INPUT: <phase> <snapshot sha256>
2. Write the complete review as prose, then END with one fenced block of canonical findings, one JSON object per line:
```gstack-findings
{"id":"F1","severity":"High","title":"<one line>","file":"<path or omit>","line":12,"fix":"<the fix>"}
```
   severity is Critical | High | Medium | Low | Informational. Add "user_challenge": true only when you recommend changing the plan's stated direction AND the change alters its scope, cost or direction (then also add "changes": "scope" | "cost" | "direction") or only its delivery packaging or ordering, with no Implementation-plan edit (then "changes": "packaging" | "ordering"). Naming and other reversible choices are ordinary findings, not user challenges. Add "urgent": true and "suggested_owner": "<who>" for a security or data-loss finding this plan does not own. An empty fence means no findings; a missing fence is refused.
3. Write the whole result to this file: <result file>

## Gate replies

A reply binds to the `gate_rev` you read (`--gate-rev`). Bare `yes`/`no` is unparsed, never guessed.

- `rec`: every item takes its recommendation, plan changes included (each prints APPLY:); `all` and `do it` are aliases.
- `as-is`: keep every direction; no plan change.
- `d3b uc1a`: one <id><option> token per item you set; unanswered auto items take their default.
- `rec except d3b`: recommendations, with the listed overrides.

## Run directory

Runner state: `run.json`, `attempts.jsonl`, `run.lock`, `spend.json`, `plan-active.md`, `restore.md`, `plan-source.md`. Reviewer files: `<phase>-native-prompt.md`,
`<phase>-outside-prompt.md`, `<phase>-<voice>.<attempt>.md` (the reviewer writes it), its sealed
`<phase>-<voice>.<attempt>.bound.md` (what submit bound), `<phase>-consensus.{json,md}`,
`gate.json`, `decisions.jsonl`. `export` writes `plan.md`, `review-record.md`, `findings.jsonl`,
`tasks.jsonl`, `timing.json` and rehashes `run.json`; `gstack-artifact validate <dir>/run.json`
is the completion check. Copy the whole directory, never single files.

## Result codes

- `RUN_NOT_INITIALIZED`: start with `gstack-autoplan next --plan <file> --out <dir>` (the first call initializes the run)
- `PLAN_SECTIONS_INVALID`: add the missing heading, or rerun the first `gstack-autoplan next` with --scaffold to review a scaffolded copy (your plan file is never edited); duplicate, reversed or empty sections are fixed by hand
- `RUN_LOCKED`: wait for it to exit, or if its pid is gone run `gstack-autoplan resume --out <dir>` to take ownership
- `EXECUTION_UNKNOWN`: submit the result file if the reviewer finished (`gstack-autoplan submit ... --attempt <id>`), or redispatch explicitly with `gstack-autoplan next --redispatch <id>`; nothing is redispatched automatically
- `SPEND_CAP_EXCEEDED`: raise `--spend-cap`, settle or release unsettled attempts, or stop; unknown charges count as their reservation
- `PHASE_NOT_AWAITING`: run `gstack-autoplan status --out <dir>` and submit for the attempt `next` printed
- `ATTEMPT_MISMATCH`: pass the attempt id `next` printed for this voice; a result is bound exactly once
- `RESULT_RECEIPT_MISSING`: the reviewer must read the prompt file through EOF and begin its result with the INPUT line the prompt names; a result for another snapshot is refused
- `RESULT_FINDINGS_MISSING`: end the review with one ```gstack-findings fence, one JSON object per line with at least severity and title; `[]` rows are not findings, an empty fence means no findings
- `MODEL_FAMILY_CONFLICT`: pass `--model <id>` of a different family (anthropic, openai, google, xai, deepseek, qwen, zai, moonshot, meta, mistral); a same-family result is not an outside voice
- `CONSENSUS_MISSING`: resume the run so the phase closes through reconciliation; the Eng prompt is never sent without every prior phase summary
- `GATE_REV_STALE`: render the current gate list, read it, and reply with its gate_rev
- `GATE_REPLY_UNPARSED`: reply with `rec`, `as-is`, `<id><option>` tokens (for example `d3b uc1a`), or `rec except <tokens>`; bare yes/no is ambiguous
- `GATE_REC_STALE`: render the gate again (`gstack-gate render <dir>/gate.json --all`), relay it, and answer with the printed `--rec-hash`
- `OWNER_REPLY_REQUIRED`: pass the owner's words exactly with `--owner-reply "<text>"`, `--owner-reply -` (stdin) or `--owner-reply-file <path>`
- `GATE_OWNER_REPLY_MISMATCH`: relay exactly what the owner chose (or their reply itself, e.g. `--reply rec`); ask the owner when their words and the tokens disagree
- `PLAN_AMEND_PENDING`: edit the plan, then `gstack-autoplan revise --out <dir> --plan <file> --incorporates <decision id,...>`; settle a packaging or ordering change with `gstack-autoplan revise --out <dir> --settle <id>`; or drop one with `gstack-autoplan revise --out <dir> --withdraw <decision id>`
- `AMENDMENT_NOT_SETTLEABLE`: edit the plan, then `gstack-autoplan revise --out <dir> --plan <file> --incorporates <decision id>` (add `--settle <id>` to settle packaging/ordering changes in the same call); settle alone only on the plan the run already reviews
- `CHECKPOINT_INVALID`: run `gstack-autoplan checkpoints --from <dir>` to see each generation's hash status and restore an intact one; nothing was written to --out
- `GSTACK_VERSION_CHANGED`: nothing to do for an older run (journaled forward migrations ran); a run written by a newer gstack needs that gstack: upgrade with bin/gstack-upgrade

## Coordinator contract (inherited by every lane)

Merge conditions. A lane's PR merges only when: the required gate lanes are green on the stamped tree or the tree receipt says `gate-reuse: eligible`; `gstack-lane-check` reports `clear` for its planned files against every other open lane; the PR body opens with the `gstack-ship-receipt` block; and the coordinator, not the lane, says merge. A lane never merges, rebases another lane, or force-pushes.

Behavior-change notices. Every user-visible behavior change outside the plan's own items is listed in the PR body under `## Behavior changes` with the file, the old behavior and the new one, before the review starts. An omitted change found in review is a CRITICAL finding, whatever its size.

Spend caps. Each lane runs under the `--spend-cap` the coordinator names; a lane that reaches it stops `incomplete` (`STOP: reason=budget_exhausted`) and reports spent, reserved and unknown charges. Paid evals are never retried to change a verdict; a rerun needs a named repair. Host-subagent spend is reported as `unknown`, never zero.

Before done. A lane pushes a WIP commit to its branch after each step and gates a pushed SHA. It is done only when `gstack-pregate run --allow-repo-commands` passes; `requires-remote` needs `--stage tests --remote --spend-cap <cap>`. Where `.gstack/pregate.json` has a `sealed` key, it runs `gstack-pregate sealed` before any push or PR creation; a refusal stops the push.

Handoff format. A lane reports in this order, identifiers first: PR URL (or `no PR` with branch and SHA), `GSTACK_RESULT` line, the `gstack: ok|fail <rev>` line, the `PREGATE:` line, gate summary (lanes passed/failed/skipped), behavior changes (or `none`), spend (spent/reserved/unknown), then what it could not verify. Full thread ids (`jam_…`), never short codes, in every cross-thread message. Prose after the identifiers may be truncated; nothing before them may be.

Decision trail. A lane keeps `<run dir>/decisions.tsv` through `gstack-decision-trail <file> <phase> <decision> <why> <evidence> <result>` (one row per fork, unit, revert or blocker; evidence a pointer that resolves) and opens it with `gstack-decision-trail start <file> <run id>` when another run wrote it first. Before done it audits the trail against the transcript, superseding a wrong row with a new one rather than editing it, has a reviewer on another model family read the trail, and ends its report with an `Attention` section (`reviewed by <model>`, then the flags, or `No flags`). The full rule is [docs/unattended.md](../docs/unattended.md#the-decision-trail).
