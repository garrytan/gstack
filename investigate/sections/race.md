<!-- AUTO-GENERATED from race.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Race recipe

A race is two actors touching shared state with an ordering nobody enforces.
Make it deterministic before fixing it.

1. **Timing probes.** Log a monotonic timestamp (`performance.now()`) and the
   actor id at every read and write of the shared state (file, row, map, lock).
   A race shows as interleaved writes or a read between another actor's
   check and its write. Keep the probe output as evidence.
2. **Forced interleaving.** Inject an `await` or sleep at the suspected point
   in one actor (behind a test-only hook or env var) so the other actor runs in
   the window. The bug must now appear every time; if it does not, the window is
   elsewhere.
3. **Concurrent-writer template.** Drive N writers at once and assert the
   invariant, not the absence of an error:
   ```ts
   const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => writer(i)));
   // exactly one winner | all N applied | file or row intact | lock released and owner recorded
   ```
   Run with N ≥ 8 under the forced interleaving; the template becomes the
   regression test with the interleaving still injected.
4. **Fix shape.** An atomic primitive: create with `wx`, compare-and-swap,
   `UPDATE … WHERE old_value = ?`, a lock with an owner token and a stale-owner
   rule. A check-then-act with a smaller window is not a fix. Rerun step 3
   after the change and paste both outputs.
