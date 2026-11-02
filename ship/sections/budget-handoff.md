<!-- AUTO-GENERATED from budget-handoff.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Budget and context handoff (read when a cap is set or `verdict=delegate` prints)

The cap is an **admission cap**: `gstack-ship-budget check` admits the next step or
dispatch only when used + open reservations + unknown + its projection + the tail
and stop reserve fit. Work already admitted can still overrun its projection.
Field-by-field reference: docs/ship-budget.md. Exit 0 continue or delegate, 3 stop,
2 usage; any non-zero exit means the next step does not start. A `ship/DRIVER.md` run starts
`--mode observe` instead: no check, reservation or handoff; each program ends with `note`, and only a
note past the cap stops.

**Meter.** Read one per command:
- Capy: read `(await tools.thread.get({ thread_id: "<your own jam id>" })).cost` (your own jam, its
  subagents included; a root thread's is `"this"`) in the same program as the
  `gstack-ship-budget` command, never its own call: `--reading <cost.tokens> --credits <cost.credits>`.
  `--prior-reading <n>` (per-call charge; three of them price steps at the run's own median) is a reading
  your previous call already took; never spend a call only to read the meter. One older than the run's last reading is ignored.
- Claude Code: `start --session <id>`, or echo the nonce the refusal prints once and
  rerun `start --nonce <value>`; the helper reads the journals itself (never `--reading`).
- Elsewhere: `--meter estimate` (printed `meter=estimate`), only when the owner accepts it.

**Every boundary.** `gstack-ship-budget check --run <id> --step <done> --next <step> --reading <n>`.
Before each dispatch batch, reserve the batch as one sum, one role per `DISPATCH:` line, then pass the printed id once
(`READING` is the current counter reading; `RESERVATION_ID` is the check's `RESERVATION_ID:` line, copied whole):

```bash
~/.claude/skills/gstack/bin/gstack-ship-budget check --run <id> --step 9 --next dispatch:specialist,red-team --reading "$READING"
~/.claude/skills/gstack/bin/gstack-review-log --start review --reservation "$RESERVATION_ID"
```

On `ADMIT: k of n (remaining=<roles>)`, dispatch only those k and re-check the remaining roles
after they settle; `close` flags roles never re-checked. `--finish` settles the reservation and the pass's other dispatch reservations.

**One program per review pass.** On Capy one execute program runs a whole pass, in order (elsewhere
the same order): `gstack-review-plan` (its `DISPATCH:` lines), `check --step <n> --next dispatch:<roles>`,
`gstack-review-log --start <skill> --reservation <id>` once per
row the step logs, the reading `BEFORE`, the readers exactly as the step dispatches them (their
prompts unchanged), the wait until the last settles (`done`, `failed` or a final summary; a fresh `idle`
has not run), the reading `AFTER`, `gstack-ship-budget settle`;
a later batch of the same pass (the Red Team or an ADMIT remainder) takes no start and repeats the
rest (`--finish` settles it); last the collect, returning only the readers' final outputs. Step 11's
voices and Step 14.5's audit (`dispatch:docs`, no start) are one program each.
Settle each batch in the program that dispatched it: read the counter right before the readers
start and right after the last one settles, then `gstack-ship-budget settle --run <id> --reservation <id>
--dispatched-at <before> --reading <after> --readers <n>` (`--unknown` when the meter cannot see it);
`release` one that never ran. Only that pair is measured: `check --returned`, a settle from a later
program (no `--dispatched-at`), `--finish` or a step change settles without measuring.

**verdict=stop.** Print the STOP, RECOVER and GSTACK_RESULT lines as your last output and
end status=incomplete. Raising the cap is the owner's call: `/ship --resume <record>
--token-cap <n>` runs `gstack-ship-budget resume --record <record> --token-cap <n>
--approved-by <who> --words "<their words>" --reading <n>`. After a machine change,
`resume --run <id>` restores the ledger and record from the Drive checkpoint; a
corrupt ledger takes `--rebuild-from-record`.

**verdict=delegate.** The next segment (Steps 9–11.5, 12–22, or 1–22 at start) runs in a
fresh child; you wait and advance only after reconciling it. Steps 7–8 stay with the parent: the
Steps 9–11.5 child reads review-army.md and adversarial.md and takes their results from the record.
1. `gstack-ship-budget handoff --run <id> --from 9 --to 11.5 --base origin/<base> --reading <n>`
   (add `--reviewed-tree <t>`, `--trail <file> --trail-run <id>`). It prints `HANDOFF:` and `RETURN_FILE:`;
   the brief lists the child's `READ:` line ranges and names `--to` as its last step.
2. Launch: on Capy a subagent on the shared machine whose brief is "Load gstack, source
   GSTACK_LAUNCH_FILE, run /ship --continue <HANDOFF file>"; on Claude Code
   `gstack-ship-budget launch --in <HANDOFF file>` (background, explicit permissions).
3. The child runs `verify-handoff --in <file>` first, with no `--reading` on Capy (a subagent cannot read
   its own jam id; `METER: parent`: the parent's handoff and reconcile readings measure it); a
   `HANDOFF_PIN_MOVED` refusal returns status=refused. It admits against its sub-cap and
   never stops on the context rule: after a completed step, `verdict=delegate` hands its
   remaining steps to a grandchild through these four steps (depth 3 at most); a
   `CONTEXT_HIGH:` note means continue. It reconciles any grandchild, then ends with
   `gstack-ship-budget return --run <child> --to <the brief's last step> --changed <sections>` (at most 40 lines).
4. `gstack-ship-budget reconcile --run <id> --return <RETURN_FILE> --reading <n>` charges the return's own-counter `used=`. Read the
   record, never the child's transcript. Exit 3 (refused, incomplete or interrupted):
   regenerate the handoff or stop; every check refuses until a regenerated child reconciles
   complete or the owner resumes.

**--resume <record>** and **--continue <handoff>** (you are the child) attach to the existing
record and ledger instead of a fresh Step 1: keep the attempt counts and start tokens; under
`--continue`, run verify-handoff before any trail write.
