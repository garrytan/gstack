Severity: high
File: lib/factory-core.ts:405
Issue: Browser-disabled policy is only recorded as a warning, so runs with browser-capable phases still start and can execute if the runtime advertises `browser`.
Why it matters: This breaks capability gating and explicit-approval expectations, allowing unintended browser automation in QA/review flows instead of failing closed.
Recommendation: Make `browser-disabled` a blocking risk or hard-stop browser phases in the orchestrator/runner whenever `policy.allowBrowser` is false.
