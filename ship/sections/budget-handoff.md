<!-- AUTO-GENERATED from budget-handoff.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Budget and context handoff (read when a cap is set or `verdict=delegate` prints)

The cap is an **admission cap**: `gstack-ship-budget check` admits the next step or
dispatch only when used + open reservations + unknown + its projection + the tail
and stop reserve fit. Work already admitted can still overrun its projection.
Field-by-field reference: docs/ship-budget.md. Exit 0 continue or delegate, 3 stop,
2 usage; any non-zero exit means the next step does not start.

**Meter.** Read one per command:
- Capy: read `(await tools.thread.get({ thread_id: "this" })).cost.tokens` in the same program as the
  `gstack-ship-budget` command, never its own call: `--reading <n>`. `--prior-reading <n>` (per-call
  charge) is your previous call's reading; one older than the run's last reading is ignored.
- Claude Code: `start --session <id>`, or echo the nonce the refusal prints once and
  rerun `start --nonce <value>`; the helper reads the journals itself (never `--reading`).
- Elsewhere: `--meter estimate` (printed `meter=estimate`), only when the owner accepts it.

**Every boundary.** `gstack-ship-budget check --run <id> --step <done> --next <step> --reading <n>`.
Before each dispatch batch, reserve the batch as one sum, one role per `DISPATCH:` line, then pass the printed id once
(`READING` is the current counter reading; `RESERVATION_ID` is the id the check prints):

```bash
~/.claude/skills/gstack/bin/gstack-ship-budget check --run <id> --step 9 --next dispatch:specialist,red-team --reading "$READING"
~/.claude/skills/gstack/bin/gstack-review-log --start review --reservation "$RESERVATION_ID"
```

On `ADMIT: k of n (remaining=<roles>)`, dispatch only those k and re-check the remaining roles
after they settle; `close` flags roles never re-checked. `--finish` settles the reservation and the pass's other dispatch reservations.
Settle each reader when it returns: the next check's `--returned <id>`, or
`gstack-ship-budget settle --run <id> --reservation <id> --reading <n>` (`--unknown` when the meter
cannot see it); `release` one that never ran. Only these are measured: `--finish` or a step change settles without a reading.

**verdict=stop.** Print the STOP, RECOVER and GSTACK_RESULT lines as your last output and
end status=incomplete. Raising the cap is the owner's call: `/ship --resume <record>
--token-cap <n>` runs `gstack-ship-budget resume --record <record> --token-cap <n>
--approved-by <who> --words "<their words>" --reading <n>`. After a machine change,
`resume --run <id>` restores the ledger and record from the Drive checkpoint; a
corrupt ledger takes `--rebuild-from-record`.

**verdict=delegate.** The next segment (Steps 7–11.5, 12–22, or 1–22 at start) runs in a
fresh child; you wait and advance only after reconciling it:
1. `gstack-ship-budget handoff --run <id> --from 7 --to 11.5 --base origin/<base> --reading <n>`
   (add `--reviewed-tree <t>`, `--trail <file> --trail-run <id>`). It prints `HANDOFF:` and `RETURN_FILE:`.
2. Launch: on Capy a subagent on the shared machine whose brief is "Load gstack, source
   GSTACK_LAUNCH_FILE, run /ship --continue <HANDOFF file>"; on Claude Code
   `gstack-ship-budget launch --in <HANDOFF file>` (background, explicit permissions).
3. The child runs `verify-handoff --in <file>` first (`--reading <n>` on Capy); a
   `HANDOFF_PIN_MOVED` refusal returns status=refused. It admits against its sub-cap and
   never stops on the context rule: after a completed step, `verdict=delegate` hands its
   remaining steps to a grandchild through these four steps (depth 3 at most); a
   `CONTEXT_HIGH:` note means continue. It reconciles any grandchild, then ends with
   `gstack-ship-budget return --run <child> --to <step> --changed <sections>` (at most 40 lines).
4. `gstack-ship-budget reconcile --run <id> --return <RETURN_FILE> --reading <n>`. Read the
   record, never the child's transcript. Exit 3 (refused, incomplete or interrupted):
   regenerate the handoff or stop.

**--resume <record>** and **--continue <handoff>** (you are the child) attach to the existing
record and ledger instead of a fresh Step 1: keep the attempt counts and start tokens; under
`--continue`, run verify-handoff before any trail write.
