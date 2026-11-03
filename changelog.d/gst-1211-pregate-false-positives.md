**Two `gstack-pregate` preflight false positives fixed (GST-1211).** Both stopped /ship on real work in gbrain-evals.

### Fixed
- **`strays`:** the scratch-name check matched three prefixes the docs never listed (`temp`, `debug-` and `probe`), so real files like `probe.py` and `temporal-graph-shipped.test.ts` failed preflight. It now matches only the documented names: `zz-*`, `tmp*`, `scratch*`, plus editor leftovers (`*.orig`, `*.rej`, `*.swp`, `*.swo`, `*.bak`, `*.tmp`, `*~`, `.DS_Store`, `Thumbs.db`), which docs/pregate.md and docs/troubleshooting.md now list too.
- **`literals`:** a named literal the branch only adds, such as `limit: 300` in a new object, was read as an existing `limit: 10` elsewhere in the file changing to 300, and every test that mentioned 10 was flagged. The check now compares every value under a name, so an added literal isn't a change. Editing an existing value still fails, and so do two cases the old last-value check could miss: changing one of two equal values under the same name, and deleting one site while editing another.

### Tests
- `test/pregate-selection.test.ts`: `probe.py` and `temporal-*.test.ts` pass `strays` while `zz-notes.md`, `tmp-x.ts`, `scratch.py` and `util.js.orig` still fail; a new object literal beside `limit: 10` passes `literals` while editing that value still fails; the pure `changedLiterals` case keeps an exported constant change.
