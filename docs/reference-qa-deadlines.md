# QA deadlines

Bounded exploratory QA uses `bin/gstack-qa-deadline` from the installed gstack
runtime. Browser Quick keeps its 30-second limit; browser Full/Regression uses the
15-minute maximum of its 5–15-minute exploration window. Review/ship smoke keeps its
5-minute or 12-probe limit, whichever comes first. The workflow enforces the probe
count; the helper enforces elapsed time. Required plan checks are outside the smoke
guard: run them after smoke with the same checkpoint sequence and finite command
timeouts capped by the caller's remaining deadline. An expired caller deadline
leaves checks not-run; never restart the smoke clock to run them.
Functional Full/Quick/Regression has no default total exploration deadline; Quick
limits scope to success plus the highest-risk changed edge. A caller's stricter
duration or absolute deadline still bounds the run. Standalone mixed runs use
owned `REPORT_DIR/browser` and `REPORT_DIR/functional` directories for their clocks
and checkpoints, with one final report at `REPORT_DIR`. Create those directories
before starting their clocks. Single-surface runs and review/ship smoke keep their
clock and checkpoints at `REPORT_DIR`; fixed caller paths take precedence.

## Command interface

Run the helper with Bun. `FILE` is `deadline.json` inside the invocation-owned,
canonical probe directory; its parent must already exist. Use quoted absolute
paths in place of `GUARD` and `FILE` below.

```text
bun GUARD start FILE SECONDS [EARLIER_UTC]
bun GUARD status FILE
bun GUARD run FILE -- COMMAND ARGS...
```

`start` runs once, immediately before the baseline. It exclusively creates a
versioned, read-only receipt and clamps the selected duration to an earlier caller
deadline when supplied. It does not replace an existing file. `status` reads the
actual clock. `run` checks the same receipt again before launching, then supervises
the command for the remaining time. Replays and minimization use that same deadline;
never replace the receipt or restart the timer to finish more work.

Arguments are passed directly, without shell evaluation. For a permitted script,
the child command is `bash -c 'script'`; keep every probe inside that child rather
than appending an unguarded command after the helper. Missing or malformed state,
symlinked paths and unavailable process containment block dispatch.

The child's stdout/stderr remain its evidence. Guard-owned lines begin with
`QA_DEADLINE ` and contain separate JSON bookkeeping; do not copy them into the
checkpoint's observed program JSON. Mark a refused next probe not-run in the report;
preserve its original checkpoint rather than rewriting it as an observation.
For JSON-emitting probes, `observed` is the decoded child JSON itself, not a `child`
envelope or a mixture of results and guard metadata. For other output, retain the
full child text. Command fields retain the complete outer command, including the
guard invocation; guard diagnostics and interpretations belong in the report.

## Reporting measurements

The configured probe budget is not the total session duration. Child launch/finish
receipts measure guarded command spans; gaps between calls do not measure individual
tool costs or establish how many probes can fit in another run.

`/qa-only` loads its reporting section after probing stops and checks every repeated
finding against the retained evidence before writing. Its in-progress report marks
total session elapsed as unmeasured: the final Write and cleanup have not finished.
Initial charters and final findings use the caller's same report file. Learning notes
and automatic memory obey the same caller-authorized write destinations.
An optional measured interval names its actual start/end receipts and excluded work,
including later report Writes and cleanup; it is not a completed-session measurement.

## Exit and cleanup behavior

- Guard expiry or timeout returns 124. A child can independently return 124 too;
  use the guard receipt's event and `timedOut` field to distinguish those cases.
- Guard errors return 2; a missing executable returns 127. Otherwise the child's
  status is preserved.
- On Linux/macOS, cleanup covers the command's inherited process group. Detached
  or new-session descendants are outside that guarantee, so detached probes are
  unsupported. Force-killing the guard itself with SIGKILL also prevents its POSIX
  cleanup handler from running.
- A cleanup kill that fails with anything other than "no such process" is a guard
  error (2), with one macOS exception: an EPERM while the group is being torn
  down counts as clean only when every remaining member is a zombie or exiting
  (ps state Z or flag E). A live member, or a failed check, still returns 2.
- On Windows, dedicated nested Jobs contain the probe worker and its descendants,
  including children whose immediate parent exits. Failure to initialize this
  containment prevents the command from starting.
- Receipt flushing happens after probe cleanup and can take up to five seconds;
  blocked or broken output returns 2. This allowance does not extend probe work.

Terminating a probe client does not undo a request already accepted by a service
or stop an already-running browser. Preserve any known partial effects and report
uncertain completion instead of assuming cancellation meant no effect. Report
writing may finish after the exploration deadline, but new probes may not start.
