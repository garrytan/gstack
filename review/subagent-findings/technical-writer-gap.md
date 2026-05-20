Severity: high
File: docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md:203
Issue: The gate-command example documents an unusable resume flow: it pairs `/factory-gates <run-id>` with `/factory-decide <run-id> <gate-id> <decision>`, but the shipped CLI requires `<request-sequence>` (plus the constrained decision values) to accept any gate decision.
Why it matters: Users following the roadmap cannot unblock a paused gated run, so the documented recovery path for human/fail-closed gates fails exactly where operators need it most.
Recommendation: Update the example to the exact shipped syntax, e.g. `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`, and state that `/factory-gates` is where the operator gets the current request sequence.