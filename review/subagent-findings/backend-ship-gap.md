Severity: high
File: lib/factory-ship-workflow.ts:27
Issue: ship-readiness and later ship phases model version bump, PR readiness, and release approval as gates only, but the workflow never includes a write-capable publication/deploy phase or git/filesystem capability, so a "completed" ship run can still mean nothing was actually shipped.
Why it matters: This gives the highest-risk lifecycle a false terminal state while bypassing the policy/risk checks that should guard destructive release actions.
Recommendation: Separate readiness from execution by adding an explicit write-capable publication/deploy phase with git/filesystem/release capabilities, or rename the workflow to ship-readiness-only until real release execution is modeled.
