# Code-Intelligence Provider Contract

Status: design + first implementation slice
Owner: maintainer-directed internal work
Related: `runtime/context.js` (Context.dev provider pattern),
`scripts/gstack2/browser-provider-contract.ts` (the existing provider-contract idiom),
`lib/gstack-decision-semantic.ts` (degrade-to-null reliability contract)

## Problem

gstack carries ~17k LOC of home-grown code-intelligence glue: transcript
ingestion (`bin/gstack-memory-ingest.ts`, ~1.9k), a unified sync verb
(`bin/gstack-gbrain-sync.ts`, ~1.6k), context loading
(`bin/gstack-brain-context-load.ts`), a three-tier planning cache
(`bin/gstack-brain-cache`), source reconciliation, engine-status classification,
destructive-op guards, plus ~15 `bin/gstack-gbrain-*` and `bin/gstack-brain-*`
entrypoints and ~40 tests. All of it is bespoke wiring around one external tool
(GBrain) reached by direct CLI shell-out.

We do not want to keep maintaining a home-grown indexer. We want gstack to
define a **small optional contract** that external providers implement, so the
indexing/search/graph work lives in the provider, not in gstack.

Hard requirement, non-negotiable: **gstack must remain fully functional with the
provider OFF.** File-only paths (the decision store, Context Recovery, grep) stay
reliable and never depend on a provider being present. This is the existing
decision-store philosophy (`lib/gstack-decision.ts` has zero gbrain imports;
`lib/gstack-decision-semantic.ts` degrades to `null`). The contract is an
enhancement, never a dependency.

## Design decision: repo-oriented, not document-store

Settled (do not relitigate). The contract is **repo-oriented**:

```
register_source(repo)   — required
refresh(source)         — required
search(query)           — required
status(source)          — required
```

`add` / `delete` / `export` are **optional capabilities** a provider MAY
advertise. GBrain advertises them (its native primitive is document-by-slug:
put/delete/get/export); code-search and code-graph tools decline them.

A document-store contract (add / delete-by-id / export as *required* ops) was
rejected: it misrepresents code-search and code-graph tools. Sourcebot indexes a
whole repo and exposes search; it has no concept of "delete document id X".
Forcing every provider to implement a document CRUD surface would either exclude
the exact tools we most want (whole-repo indexers, graph tools) or force them to
stub required ops with lies. Repo-in / query-out is the honest common
denominator. GBrain's document axis survives as an *optional* capability, not as
the contract's shape.

## The contract

TypeScript in `lib/code-intelligence/contract.ts`. Shape (abridged):

```ts
type CodeProviderCapability =
  | "register_source" | "refresh" | "search" | "status"   // required
  | "add" | "delete" | "export";                          // optional

interface CodeProvider {
  readonly id: "gbrain" | "sourcebot" | "graphify";
  readonly label: string;
  readonly capabilities: ReadonlySet<CodeProviderCapability>;
  readonly local: boolean;   // true = no repo content leaves the machine

  registerSource(repo: RepoRef, opts?: OpOptions): Promise<SourceStatus>;
  refresh(source: SourceRef, opts?: OpOptions): Promise<SourceStatus>;
  search(query: string, opts?: SearchOptions): Promise<CodeSearchHit[]>;
  status(source?: SourceRef, opts?: OpOptions): Promise<SourceStatus>;

  add?(doc: { slug: string; body: string }, opts?: OpOptions): Promise<SourceStatus>;
  delete?(slug: string, opts?: OpOptions): Promise<SourceStatus>;
  export?(source: SourceRef, opts?: OpOptions): Promise<string>;
}
```

Every provider MUST implement the four required methods and MUST advertise
exactly the capabilities it backs (`assertRequiredCapabilities` enforces the
required four at construction; a test pins it). Optional methods are present iff
the matching capability is advertised. Calling an unadvertised optional op throws
`CAPABILITY_UNSUPPORTED` — never a silent no-op.

### Typed failures

Mirrors `runtime/context.js`'s `ContextError` discipline (a closed code set,
constructor throws on an unknown code):

| Code | Meaning |
|------|---------|
| `PROVIDER_UNAVAILABLE` | CLI/MCP transport absent — degrade to file-only |
| `PROVIDER_NOT_CONSENTED` | repo indexing not consented and content would leave the machine |
| `CAPABILITY_UNSUPPORTED` | provider declines this op |
| `SOURCE_NOT_REGISTERED` | op needs a source that isn't registered |
| `PROVIDER_TIMEOUT` | provider exceeded the op timeout |
| `PROVIDER_ERROR` | provider ran and failed |

`PROVIDER_UNAVAILABLE` is the load-bearing one: callers catch it (or use the
picker's null resolution) and fall back to grep / file-only. It is never fatal.

### Consent

Two orthogonal consent axes, both explicit, neither auto-granted:

1. **Network / content-egress consent (repo-scoped).** Before any repo content
   leaves the machine, indexing must be consented *per repo*. The contract
   enforces this in `registerSource`/`refresh`/`add`: when
   `provider.local === false` and `opts.consented !== true`, it throws
   `PROVIDER_NOT_CONSENTED`. Local providers (Graphify) skip this axis — nothing
   leaves the machine.
2. **Install consent (Graphify only).** Graphify is never auto-installed. The
   `options`/`status` display marks it available only when its CLI is present,
   and nothing in gstack runs a Graphify installer. Install is a user action
   (`pip install graphifyy && graphify install`).

This matches the Context.dev model: selection persists without granting egress
consent; egress requires a separate explicit step.

## Per-provider capability matrix

| Op | GBrain (recommend first) | Sourcebot | Graphify |
|----|--------------------------|-----------|----------|
| `register_source` | ✓ `sources add --federated` | ✓ local `git` connection in config.json | ✓ `graphify update <dir>` (local, no LLM) |
| `refresh` | ✓ `sync` + `sync --strategy code --full` | ✓ auto (config change + reindexIntervalMs) | ✓ `graphify update <dir>` |
| `search` | ✓ `gbrain search` (federated corpora) | ✓ `POST /api/search` (keyless w/ anonymous access; Bearer key optional) | ✓ `graphify query "<q>" --graph <graph.json>` |
| `status` | ✓ `sources list` + page_count | ~ partial (server liveness) | ~ partial (graph.json present + node count) |
| `add` | ✓ `put <slug>` | ✗ declines | ✗ declines |
| `delete` | ✓ `delete <slug>` | ✗ declines | ✗ declines |
| `export` | ✓ `export` | ✗ declines | ✓ read `graphify-out/graph.json` |
| `local` (no egress) | no (federated DB) | loopback → **yes**; remote host → no | **yes** (local only) |

All three are driven directly from the runtime — no MCP client:

- **GBrain** (`garrytan/gbrain`, the gstack-ecosystem tool): full contract fit,
  driven via the existing `gbrain` CLI chokepoint (`lib/gbrain-exec.ts`). Native
  primitive is document-by-slug (put/delete/get/export) PLUS a repo axis
  (`sources add`/`sync`). Advertises all seven capabilities. **Recommended
  first.**
- **Sourcebot** (`github.com/sourcebot-dev/sourcebot`, YC Fall 2025): self-hosted
  whole-repo regex search, deployed via Docker Compose (bundled server + Postgres
  + Redis; no supported non-Docker path). `register_source` adds a local `{ "type":
  "git", "url": "file:///path" }` connection to the server's `config.json` (it
  re-indexes on config change; a local repo needs a `remote.origin.url` or it is
  skipped); `search` is `POST {baseUrl}/api/search`; `status` probes that endpoint.
  Declines `add`/`delete`/`export`. It is a **local** tool — indexed code stays on
  your machine — and an **API key is optional**: a local instance with anonymous
  access (`FORCE_ENABLE_ANONYMOUS_ACCESS=true`) serves `/api/search` keyless. The
  adapter sends `Authorization: Bearer <SOURCEBOT_API_KEY>` only when a key is set.
  A loopback `baseUrl` keeps content on the machine (local=true); a remote one
  requires egress consent.
- **Graphify** (`github.com/Graphify-Labs/graphify`, YC-backed): local
  tree-sitter code graph via the `graphify` CLI. The adapter uses **`graphify
  update <dir>`** — the local, no-LLM build (writes `graphify-out/graph.json`);
  it deliberately avoids the bare `graphify <dir>` build, which runs an LLM
  extraction backend needing an API key + network. `graphify query "<q>" --graph
  <graph.json>` searches it (its `NODE ...`/`EDGE ...` output carries the file at
  `src=`/`at=`); `export` reads the graph JSON. Fully local — nothing leaves the
  machine. Optional, **install only with explicit user action** (`pip install
  graphifyy && graphify install`, needs Python >= 3.10); never auto-installed.

**No local-index option is offered** (deliberately excluded — a naive local
index degrades result quality; we route to a real provider or to file-only grep,
not to a half-baked in-house index).

### Integration surfaces (no MCP needed)

Each provider exposes a runtime-drivable surface, so gstack drives them with a
CLI shell-out or plain HTTP — it never speaks MCP:

- **GBrain / Graphify: CLI.** Shell out (`spawnSync`), same shape and the same
  ENOENT→`PROVIDER_UNAVAILABLE` degrade as the existing gbrain glue.
- **Sourcebot: HTTP + a config-file edit.** `POST /api/search` for queries and a
  JSON edit of the server's `config.json` to register a repo. `fetch` is
  injectable so tests run against a stub, no live server.

Sourcebot and Graphify also ship MCP servers for in-agent use; the contract does
not depend on them, because their CLI/HTTP surfaces are enough to index and
search from the runtime.

## Picker: recommend GBrain first

`lib/code-intelligence/picker.ts` + `selection.ts`. The user picks a provider
with `gstack-code-intelligence select <provider>`, persisted to
`$GSTACK_HOME/code-intelligence.json`. `resolveSelectedProvider()` constructs the
selected provider, or returns `null` when nothing is selected — the provider-OFF
path, where callers degrade to grep / the file-only decision store. Availability
is proven at call time: a selected provider whose CLI/server is absent throws
`PROVIDER_UNAVAILABLE`, which callers catch and degrade on.

`RECOMMENDED_ORDER` is the static **GBrain → Sourcebot → Graphify** fact — GBrain
is always recommended first. `detectAvailable()` probes each provider for the
`options`/`status` display (GBrain via the real `localEngineStatus()`; Graphify
via its CLI/graph presence; Sourcebot via an HTTP liveness probe). The picker
never silently prefers a non-recommended tool.

## How this replaces the current GBrain glue

The contract is the seam; the bespoke glue collapses onto it. Mapping:

| Today (bespoke) | Under the contract |
|-----------------|--------------------|
| `bin/gstack-gbrain-sync.ts` (`sync`/`reindex-code`/`sources`) | `provider.registerSource` / `provider.refresh` |
| `lib/gstack-decision-semantic.ts` `semanticRecall` | `provider.search` (scoped) → same degrade-to-null |
| `bin/gstack-brain-context-load.ts` (`query`/`list_pages`) | `provider.search` / `provider.status` |
| `bin/gstack-memory-ingest.ts` (`import`, put) | `provider.add` (optional cap; GBrain-only) |
| `lib/gbrain-sources.ts` (`ensureSourceRegistered`, `probeSource`) | GBrain adapter internals |
| `lib/gbrain-local-status.ts` | GBrain adapter availability probe (kept, reused) |
| `bin/gstack-gbrain-detect` / `-install` / `-source-wireup` / `-repo-policy` | provider setup + picker + consent (thinner) |

The point is not to delete 17k LOC in one commit — it is to make every consumer
call the contract, then retire the bespoke paths provider-by-provider behind it.
Consumers that only need "search my code, or degrade" stop importing gbrain
specifics entirely.

## Rollout

Phased, each phase independently revertable. Skill-template edits are deferred to
a later phase precisely so the first slices do not trigger the
`gen:gstack2` / parity re-baseline cycle.

- **Phase 1 (this slice): the contract, three real adapters, and a usable CLI.**
  `contract.ts` + fully-drivable GBrain (CLI), Graphify (CLI), and Sourcebot
  (HTTP + config) adapters + the selection store + the `gstack-code-intelligence`
  CLI (`options`/`status`/`select`/`consent`/`index`/`search`) + tests. A user
  can select a provider and index/search their repo today. No skill-template or
  generated-file changes yet, so no `gen:gstack2` / parity re-baseline.
- **Phase 2: route internal consumers through the contract.** Point
  `gstack-decision-semantic` and `gstack-brain-context-load` at
  `resolveSelectedProvider()`, preserving degrade-to-null exactly. Behavior-neutral
  for the file-only paths.
- **Phase 3: surface selection in the skills.** Offer the picker at the moments a
  skill would benefit from indexed search, mirroring the `context` command's
  just-in-time consent prompt. Regenerate skills (`bun run gen:gstack2`), re-run
  `bun run test:gstack2`, re-baseline parity intentionally.
- **Phase 4: retire bespoke glue.** Once every consumer is on the contract,
  delete the sync/ingest/cache entrypoints and their tests provider-by-provider.

## Verified against real environments

All three adapters were driven against the real tools in isolated environments
(parallel agents, one worktree each), and all three now index + search a real repo
end-to-end. Two rounds ran, because the first round's fixes included a mistake that
only real execution caught — recorded here honestly.

- **GBrain — real Postgres+pgvector (Docker), gbrain 0.42.56 — PROVEN.** The
  default pglite/WASM engine is broken on macOS (upstream garrytan/gbrain#223), so
  the working recipe points gbrain at a real Postgres via `DATABASE_URL`. Real
  end-to-end search returned the actual code definition
  (`[0.88] src-checksum-ts … export statement computeChecksum`). Real execution
  caught a **regression I had introduced**: I removed `--strategy code` from
  `refresh` based on a `--help` misread, which silently stopped code from ever
  being indexed (only docs were). Restored to the verified two-pass
  (`sync`, then `sync --strategy code --full`); `--federated` registration is
  load-bearing for global search. Also fixed earlier: engine-down now degrades to
  `PROVIDER_UNAVAILABLE` (one-line message) instead of `PROVIDER_ERROR` + a WASM
  stack dump.
- **Sourcebot — live v6.5.0 (Docker) — PROVEN keyless.** Endpoint, body, and
  response parsing were correct against the real server. Correcting an earlier
  wrong conclusion: Sourcebot does **not** require an API key for local use —
  enabling anonymous access (`FORCE_ENABLE_ANONYMOUS_ACCESS=true`) serves
  `/api/search` keyless, verified with a real hit through the CLI with no key set.
  The key stays optional; the only fix was messaging (point users to anonymous
  access first, key as fallback) plus a note that a local repo needs a
  `remote.origin.url` to be indexed. It is a local tool (code stays on the
  machine; a boot telemetry ping unless `SOURCEBOT_TELEMETRY_DISABLED=true`).
- **Graphify — real install, graphify 0.9.23 — PROVEN.** Correcting an earlier
  wrong claim of mine: for **code**, `graphify <dir>` and `graphify update <dir>`
  produce the identical AST graph with **no LLM call**; the LLM only renames
  community clusters and ingests non-code docs, adding zero nodes/edges, and our
  parser discards the field it touches. So there is deliberately no LLM mode, and
  `local=true` is correct. The adapter uses `graphify update`; real `index`+search
  returned correct `file:line` refs. Also fixed: `search` now reads the indexed
  repo's graph (persisted root), and `options` reports an installed provider as
  available.

The larger lesson, kept on the record: a `--help` reading or a single agent's
conclusion is not proof — running the real tool is. It reversed two of my
first-round calls (the gbrain flag removal and the graphify LLM claim).

## What this does NOT change

Per the GStack 2 canonical contract and CLAUDE.md boundaries: no cloud browsers,
no alternate iOS drivers, no local image models, no provider marketplaces, no
workflow engines, **no new state database**. Context.dev remains the only
newly-authorized external service for web context; this contract governs code
intelligence, a separate axis. The existing decision store and Context Recovery
stay file-only and provider-independent.

## Testing

`test/code-intelligence.test.ts` (19 tests, no live tools): capability-matrix
invariants (all providers advertise the four required; only GBrain advertises the
document ops; `local` flags, including loopback-vs-remote Sourcebot); the result
parsers; the selection store + per-repo consent + provider-OFF (`null`); consent
gating (GBrain non-local without consent throws `PROVIDER_NOT_CONSENTED`; local
Graphify is exempt); the GBrain adapter against a fake `gbrain` shim; the Graphify
adapter against a fake `graphify` shim (index builds a graph, search returns hits,
status counts nodes); the Sourcebot adapter against an injected `fetch` + a temp
`config.json` (register writes a local git connection, search maps `files[]` to
hits); and every adapter degrading to `PROVIDER_UNAVAILABLE` when its tool/server
is absent. The `gstack-code-intelligence` CLI was smoke-tested end-to-end:
select → consent gate → local Graphify index (5-node graph) → search.
