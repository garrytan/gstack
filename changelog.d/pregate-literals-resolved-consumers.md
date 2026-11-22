---
important: blocker
---
**The stale-test-value check no longer flags tests of a different file with the same name.** When two files share a name (two `config.ts`), a test now counts as using the changed file only if one of its imports or paths resolves to it, tsconfig path aliases included. JSON goldens count only where a value sits under the changed constant's name, and a one-item list that only gained items (`"investigate"` → `"investigate verify"`) no longer flags tests that still use the kept item, while an assertion on the whole old value still fails.
