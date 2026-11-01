**The secrets check reads Python and Dart string context from what git diffed, and a quote inside an interpolation no longer ends a string (GST-738).** env.kv's source-syntax exemption treats a `password:` line as code only when it sits outside every string. Two inputs could make the scanner place a committed string's contents outside a string. One was a working copy that no longer matched what git diffed. The other was a quote inside an f-string or Dart `${…}` expression. A scoped review pass now applies an explicit `--diff-base` to its Red Team as well.

### Fixed
- **`lib/pregate/checks/secrets.ts`:** a changed Python or Dart file's whole text comes from a full-context `git diff`, never from the working copy.
- **`lib/redact-patterns.ts`:** a Python f-string's `{…}`, or t-string's, and a non-raw Dart string's `${…}` are skipped whole, nested strings included. A quote inside one doesn't end the outer string. An expression left open runs to the end of the file, so the exemption fails closed.
- **`bin/gstack-review-dispatch`:** `pass --diff-base` now sets the scoped Red Team's base too.
