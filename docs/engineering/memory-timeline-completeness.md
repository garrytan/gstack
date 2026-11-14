# Complete timeline ingestion

## Failure and repair

At upstream `3c15b7210b0dec54d0d447246d47afd278932d55`, artifact rendering
kept `raw.slice(0, 200000)` while the state fingerprint described the full file.
A synthetic 2,703-record timeline reproduces missing recent events and a cut
JSONL record. Appending beyond the prefix changed the source fingerprint but
not the stored body. This was silent loss, not evidence of a clean timeline.

Timeline pages now retain the entire source body, leaving native gbrain to chunk
and index it. Other artifact and transcript policies are unchanged. No event is
selected by date, dropped to fit a window, or deleted from the source or brain.
Existing date-based page naming remains unchanged; historical pages are not
removed by this repair.

The rendered UTF-8 page, including frontmatter, must fit 24 MiB. This is the
conservative inline ceiling in gbrain's [memory boundaries](https://github.com/garrytan/gbrain/blob/c01a3d609d91003a39d2a9d0f94d264619a3272a/docs/guides/memory-boundaries.md).
Segmented configurations may admit more, but this client does not discover their
effective limits. Larger timelines are explicitly refused before staging/import;
the source is not stamped. The existing CLI reports per-file failures in its
summary, not necessarily a nonzero process exit. Do not treat exit zero alone as
complete ingestion. Full-history support above this ceiling remains open.

A renderer-version stamp forces existing prefix-era timeline entries to be
reprocessed even when source mtime/hash have not changed. Normal import failure,
source-snapshot and readback safeguards remain in force. JSON readback has a
bounded buffer for worst-case escaping of an admitted page plus metadata. A reported import is
still `imported_unverified` until the existing exact content readback succeeds;
a staged remote-HTTP page is not ingestion. Secret scanning remains opt-in with
`--scan-secrets` and checks the entire rendered timeline, including its tail.

## Bounded operational use

Use the existing authorized source/brain configuration and writer. For one
project, start with a no-write inspection:

```sh
gstack-memory-ingest --incremental --sources timeline --project PROJECT_SLUG --scan-secrets --no-write
```

The optional project flag selects only that regular project timeline; path
traversal, symlink aliases, shared resume stages and reconciliation are refused.
It does not purge staged transcripts, run pending global reconciliation, verify
another project's unverified entries or advance the global full-walk timestamp.
Existing schema-1 state must be migrated separately before project-scoped use.
Custom state roots derive project slugs relative to that actual root, avoiding
same-day collisions under `_unattributed`.
Without the flag, the previous all-project selection remains the default.
This selects a local source, not a destination: it does not create or choose a
new tenant. Confirm the existing destination/source mapping before removing
`--no-write`. Keep transcripts disabled unless separately authorized.

## Verification and ownership

`test/memory-ingest-timeline.test.ts` exercises the real CLI with isolated fake
brain/scanner executables: full records, renderer migration/dedup, project scope,
UTF-8 ceiling, import failure, source mutation and tail-secret refusal. These are
no-provider source tests, not a live brain receipt. Native ingestion, readback,
recall and timeline extraction require separate acceptance on the selected host.
No host install, source data, live brain or schedule is changed by this patch.

Keep this narrow repair with its existing upstream source owner; do not start a
second host writer or substitute a tail-only import as full-history coverage.

### Source acceptance receipt (2026-11-14)

Bun 1.4.4: 146 passed, 3 skipped, 0 failed across timeline, existing ingest,
landing, gbrain-exec invariant, subprocess timeout and module-size tests.
The three skips require the real gitleaks binary; synthetic scanner-tail coverage
passes. Product typecheck exits 0; test typecheck reports 812 known diagnostics,
none new. Independent review found and corrected custom-root slug collision,
large JSON response buffer and unrelated schema-migration concerns. The final
large-response fixture returns the stored body and asserts response size above
1 MiB, rather than proving only metadata readback.

These focused checks do not establish the complete free-suite, native import or
host acceptance. This contribution remains a draft until required gates finish.
