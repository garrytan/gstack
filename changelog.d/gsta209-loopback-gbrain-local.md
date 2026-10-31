**A `gbrain serve --http` on this machine's loopback address now counts as a local brain, so transcripts get imported again.** gbrain recommends this setup for local agents on a Postgres brain (`gbrain bootstrap harness`). gstack treated every http MCP entry as a brain on another machine (Path 4). So `/sync-gbrain` staged transcripts for a brain admin who doesn't exist and never ran `gbrain import` (#3539). Ported from Willy Morin's #3552.

### Fixed
- **One locality rule** (`lib/gbrain-mcp-locality.ts`). An http, url or sse entry is local when its URL is http(s) on `localhost`, `127.0.0.0/8` or `::1`, and this machine's gbrain config names an engine with no `remote_mcp` marker. A URL with userinfo or `${` is never local. Every other entry is classified as before.
- **`gstack-memory-ingest`** imports through gbrain in that case. Pages an earlier run left `staged` / `remote-http` count as new and are imported on the next local run. Pages older than the 90-day window need one `gstack-memory-ingest --bulk --all-history` run.
- **`gstack-gbrain-detect`** reports `local-stdio` for it in all three tiers, and `gbrain-local-status` and the `gstack-skill-start` banner use the same rule. A remote `(SSE)` line in `claude mcp list` no longer reads as local. With several gbrain servers, the exact `gbrain:` entry wins, as in the other tiers.

### Docs
- `USING_GBRAIN_WITH_GSTACK.md`: a loopback serve over this machine's engine is not Path 4. A loopback tunnel to a remote brain on a machine that also has a local engine counts as local too.

### Tests
- `test/gbrain-mcp-locality.test.ts` covers the rule, the list-line parser, and a check that the shipped jq copy never says local where the TypeScript rule says remote. The detect, local-status and memory-ingest tests add loopback and stuck-page cases. On main's code (the tests-first commit f3712618), 13 of the new cases fail and `test/gbrain-mcp-locality.test.ts` cannot load, because the module it tests is new.
