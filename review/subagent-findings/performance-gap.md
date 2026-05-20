Severity: high
File: lib/factory-event-store.ts:49
Issue: appendValidated() acquires the per-run lock before rereading/parsing the full event log and running the caller-supplied validate callback, so every same-run append serializes O(n) snapshot work under the lock.
Why it matters: As a run accumulates events, append latency and lock hold time grow together, increasing contention and making concurrent writers hit the 5s lock timeout on busy runs.
Recommendation: Move expensive snapshot/validation work out of the critical section and keep the lock only around a final recheck plus append/manifest write, or add a cheap indexed state so append-time validation stays O(1).