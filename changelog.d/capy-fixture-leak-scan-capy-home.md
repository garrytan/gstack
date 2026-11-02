**On a Capy machine, the git fixture tests no longer fail locally because of Capy's git shim log.** Capy's `/usr/bin/git` shim appends to `$HOME/.capy/git-shim.log`, so each fixture home that ran git during its template build ended up with a log naming the template. The leak scan in `test/helpers/git-fixture-template.ts` flagged it, and 34 tests in `test/train-backstop.test.ts`, `test/restamp-mentions.test.ts` and `test/pregate-user-policy.test.ts` failed on every Capy lane, though they passed on the remote gate.

### Tests
- `templateReferences` skips `.capy/git-shim.log`. Nothing reads that file back, and every other file is still scanned.
- `test/git-fixture-template.test.ts` plants the shim log in a template's `home/.capy/` (the copy succeeds), and plants `home/.capy/state.json` as a control (the copy still throws).
