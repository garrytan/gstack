<!-- AUTO-GENERATED from polluter.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Polluter recipe

A polluter is an earlier test that leaks state the victim depends on: the victim
passes alone and fails in the suite or in one shard.

1. **File order from the CI log.** The shard runner prints its file list in
   execution order. Take the files that ran before the victim in the failing
   shard (`gh run view <run-id> --log`, or the local shard listing
   `bun run scripts/ship-measure.ts free --shard <I>` which reproduces the exact
   packing `bun run test` used).
2. **Confirm the dependency.** The victim alone passes; the victim after the
   earlier files fails:
   ```bash
   bun run scripts/ship-measure.ts free --files <victim> --reruns 3
   bun run scripts/ship-measure.ts free --files <earlier-1>,<earlier-2>,…,<victim> --reruns 3
   ```
3. **Bisect the earlier files.** Halve the earlier list, keep the half that
   still fails the victim, repeat until one file remains. Each step is one
   `--files` run; log the list at every step.
4. **Name what leaked.** Read the polluter for state that outlives it: an env
   var, `process.cwd()`, `process.exitCode`, a module-level cache or singleton,
   a mock or spy left installed, a server or watcher left listening, a temp
   file under a shared path, a learnings or state file under the home
   directory (the free lane's home guard reports these), a global timer.
5. **Fix the polluter, not the victim.** Restore or isolate the state where it
   is created (`afterEach`, `mkdtemp`, a private env); an order-dependent
   `beforeEach` added to the victim hides the leak for the next victim.
6. **Report:** `POLLUTER: <file> leaked <what> into <victim>; fixed by <change>`,
   with the bisect log. If the polluter is on main, the victim's failure is
   outside the PR (route it with the flake recipe's evidence section).
