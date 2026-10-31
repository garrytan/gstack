**On Windows, `gstack-review-scope summary` works again, and the JSONL merge driver no longer fails on non-English text or rewrites files with CRLF.** Before, the summary started the bash script `gstack-review-read` directly, which Windows cannot run, so it always refused with an empty "gstack-review-read failed:" message and /ship could not write its review-loop file (#3541). The `jsonl-append` merge driver wrote its result with Python's `print()`, so a line the console code page could not encode (Cyrillic text under cp1250, for example) made it exit 1 and git reported a conflict with no markers, and every merge on Windows turned LF files into CRLF (#3659).

### Fixed
- **`gstack-review-scope summary`** runs `gstack-review-read` through `lib/script-invocation.ts` (Git Bash on Windows). When the helper cannot start, the refusal names the launch error instead of an empty string.
- **`gstack-jsonl-merge`** writes UTF-8 bytes with LF line endings on every platform and code page.

### Tests
- `test/review-scope-windows-launch.test.ts` runs the summary against a seeded review log through the same launcher; it runs on windows-latest.
- `test/jsonl-merge-encoding.test.ts` merges a Cyrillic line with `PYTHONIOENCODING=cp1252` and checks the bytes are UTF-8 with no CR. It failed before the fix on Linux too.
- `test/script-invocation-tripwire.test.ts` now also catches a bin spawned through `path.join(path.dirname(...import.meta.url...), ...)` or `import.meta.dir`, the shape that hid #3541. `bin/gstack-ship-receipt`'s `gstack-session-kind` spawn is listed as a known site until its own follow-up.
