# Pi Factory Artifact Content Strategy

Status: proposed G1 artifact contract for browser evidence, screenshots, traces, and external URLs.

## Goal

Define how factory artifacts should represent text, binary evidence, and external links without weakening the pure `lib/factory-core.ts` contracts or overloading the current text-only facade.

This is a strategy document only. It does not add a web app, dependency, binary store, or runtime implementation.

## Current state

Core data contract: `lib/factory-core.ts`.

```ts
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  summary: string;
  phaseId?: string;
  uri?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}
```

Facade contract: `lib/factory.ts`.

```ts
export interface FactoryArtifactSummaryDto {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly phaseId?: string;
  readonly summary: string;
  readonly path?: string;
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FactoryArtifactDto {
  readonly runId: string;
  readonly artifact: FactoryArtifactSummaryDto;
  readonly createdAt: string;
  readonly content: string;
}
```

Artifact persistence: `lib/factory-artifact-store.ts` currently stores text as `<artifact-id>.md` plus metadata JSON.

Important current behavior:

- `readFactoryArtifact()` is text/markdown-oriented.
- `ArtifactRef.path` and `ArtifactRef.uri` can appear in low-level event payloads.
- Pi status output intentionally suppresses untrusted event-provided paths/URIs unless they come through the artifact store.
- Artifact kinds already anticipate browser evidence: `screenshot`, `browser-trace`, `qa-report`, `test-result`, etc.

## Problem

Future QA/web cockpit work will produce evidence that is not always markdown text:

- PNG/JPEG/WebP screenshots;
- browser traces or HAR files;
- test reports with attachments;
- videos or DOM snapshots;
- external CI/PR URLs;
- generated design previews;
- multiple related evidence files for a single phase.

If those are forced into `FactoryArtifactDto.content: string`, we risk one of three bad outcomes:

1. binary blobs get base64-embedded into status/API responses;
2. local paths/URLs leak from untrusted events into UI;
3. text artifact reads become an implicit mixed-content API with unclear safety/provenance rules.

## Design principles

1. **Keep core pure.**
   - `lib/factory-core.ts` should continue to contain data/calculation contracts only.
   - No filesystem, browser, network, or MIME-sniffing logic belongs in core.

2. **Do not break text artifacts.**
   - Current `readFactoryArtifact()` should stay optimized for text/markdown artifacts.
   - Existing consumers should not need to handle binary payloads accidentally.

3. **Separate summary from content.**
   - Status/list views should show artifact summaries, kind, provenance, and safe viewer hints.
   - Content retrieval should be explicit and type-aware.

4. **Provenance over raw location.**
   - UI should prefer stored artifact ids and content descriptors over raw event-provided paths/URIs.
   - Event-provided `path`/`uri` is metadata until attested by a trusted store/runtime.

5. **Additive contracts first.**
   - Add new DTOs/methods instead of changing existing DTO meanings.
   - Web/project wrappers can add richer display models without mutating run-scoped core DTOs.

## Recommended contract

### Keep `readFactoryArtifact()` text-only

Preserve the current meaning:

```ts
readFactoryArtifact(runId, artifactId): Promise<FactoryArtifactDto>
```

Use it for markdown/text artifacts only:

- review reports;
- QA summaries;
- release notes;
- test result summaries;
- planning docs.

If a caller requests non-text content through this method, future behavior should fail clearly, e.g.:

```text
Factory artifact '<id>' is not a text artifact; use readFactoryArtifactContent().
```

### Add a content descriptor DTO before storing binary content

Proposed additive DTO:

```ts
export type FactoryArtifactContentKind = 'text' | 'binary' | 'external-uri' | 'bundle';

export interface FactoryArtifactContentDescriptorDto {
  readonly runId: string;
  readonly artifactId: string;
  readonly kind: FactoryArtifactContentKind;
  readonly artifactKind: ArtifactKind;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly digest?: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly safeUri?: string;
  readonly hasInlineText: boolean;
  readonly createdAt?: string;
  readonly provenance: {
    readonly source: 'artifact-store' | 'external-system' | 'event-metadata';
    readonly trusted: boolean;
    readonly note?: string;
  };
}
```

Recommended facade additions when implementation is approved:

```ts
listFactoryArtifactContent(runId, artifactId): Promise<readonly FactoryArtifactContentDescriptorDto[]>;
readFactoryArtifactText(runId, artifactId): Promise<FactoryArtifactDto>;
readFactoryArtifactBinary(runId, artifactId, contentId?: string): Promise<FactoryBinaryArtifactDto>;
```

`readFactoryArtifactText()` can initially be an alias for existing `readFactoryArtifact()` if a rename is desired later. Do not remove the current method until consumers have migrated.

### Treat URI artifacts as descriptors, not content

For external URLs:

- store the URL as `safeUri` only after validation/attestation;
- include `provenance.source = 'external-system'` when the runtime produced it;
- include `provenance.source = 'event-metadata'` and `trusted = false` for raw event refs;
- do not render raw untrusted URIs in Pi status or web links.

Allowed initial URI schemes:

- `https:` for external systems;
- optional `file:` only for local trusted artifact-store paths converted by the runtime, not raw event input.

Blocked schemes:

- `javascript:`;
- `data:` unless a narrow inline-image policy is explicitly approved;
- shell-like pseudo schemes;
- relative paths from event payloads.

### Represent bundles explicitly

Some browser evidence is a set:

```text
qa-run evidence bundle
  - summary.md
  - screenshot-home.png
  - trace.zip
  - console.jsonl
```

Do not overload one `ArtifactRef.path` to mean “directory of arbitrary files.” Use a bundle descriptor whose children each have media type, digest, and safe retrieval id.

Proposed shape:

```ts
export interface FactoryArtifactBundleDto {
  readonly runId: string;
  readonly artifactId: string;
  readonly items: readonly FactoryArtifactContentDescriptorDto[];
}
```

## Store strategy

### G1 storage layout

Current text layout:

```text
.gstack/factory/runs/<run-id>/artifacts/<artifact-id>.md
.gstack/factory/runs/<run-id>/artifacts/<artifact-id>.json
```

Recommended additive layout:

```text
.gstack/factory/runs/<run-id>/artifacts/<artifact-id>/metadata.json
.gstack/factory/runs/<run-id>/artifacts/<artifact-id>/content.md
.gstack/factory/runs/<run-id>/artifacts/<artifact-id>/files/<content-id>
```

Migration approach:

- keep reading legacy `<artifact-id>.md` / `<artifact-id>.json` text artifacts;
- write new binary/bundle artifacts only to directory layout;
- expose both through descriptors.

### Digest and media type

For binary artifacts, the runtime/store should record:

- `mediaType`, preferably supplied by the runtime/action that created the artifact;
- `byteLength`;
- `sha256` digest;
- original extension/display filename if useful.

Do not make core responsible for detecting MIME type or hashing files. That belongs in the action-backed artifact store.

## UI/web cockpit implications

Artifact cards should not parse raw file paths. They should render from descriptors:

- `text` → “Open report”;
- `binary` with `image/*` → thumbnail/preview if allowed;
- `binary` with trace/HAR/zip → download/open externally;
- `external-uri` → link only if `trusted = true` and scheme is allowed;
- `bundle` → grouped evidence list.

Recommended web wrapper DTO:

```ts
export interface ProjectArtifactViewDto {
  readonly runId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: ArtifactKind;
  readonly content: readonly FactoryArtifactContentDescriptorDto[];
  readonly primaryAction: 'open-text' | 'open-preview' | 'download' | 'open-external' | 'inspect-metadata';
  readonly safetyLabel: 'trusted-local' | 'trusted-external' | 'metadata-only' | 'blocked';
}
```

## Security rules

1. Raw event `path`/`uri` is untrusted.
2. Only artifact-store-produced content gets `provenance.trusted = true` by default.
3. External links need allowlisted schemes and clear provenance.
4. Binary reads should require exact run id + artifact id + content id.
5. No directory traversal through artifact ids or file names.
6. No automatic browser opening from status/list commands.
7. No inline display of unbounded binary data in status responses.
8. Do not leak absolute local paths to user-facing status unless intentionally scoped to trusted local dev output.

## Test plan before implementation

Add tests before or with implementation:

### Artifact store

- legacy text artifacts still read through `readFactoryArtifact()`;
- unsafe artifact ids rejected;
- binary artifact ids/content ids reject traversal;
- descriptor includes media type, byte length, digest, createdAt;
- tampered metadata path/uri is normalized or marked untrusted.

### Facade

- text reads remain stable;
- binary artifact requested through text read fails clearly;
- `listFactoryArtifactContent()` returns descriptors without reading full binary content;
- raw event URI appears as untrusted metadata, not a safe link;
- artifact-store URI/path appears only through trusted provenance.

### Pi extension

- `/factory-status` never renders untrusted raw URI/path;
- artifact summary hints use descriptor kind, not filesystem path parsing;
- no command auto-opens browser or local files.

### Web wrapper later

- project artifact cards render safety label;
- blocked/untrusted external URI is inspectable as metadata but not clickable;
- screenshots use trusted descriptor media type and content id.

## Recommended implementation sequence

1. Keep current text-only artifact facade stable.
2. Add descriptor types and pure helper calculations if needed.
3. Extend `FileFactoryArtifactStore` with directory-layout writes/reads for binary descriptors.
4. Add facade method for descriptor listing.
5. Add explicit binary read/download method only when a consumer needs it.
6. Update Pi/web status views to use descriptors, not raw event paths.
7. Add browser QA evidence once descriptor and safe retrieval contracts are tested.

## Decision

Recommended G1 decision:

- `readFactoryArtifact()` remains text-only.
- Binary/URI evidence is represented through additive content descriptors.
- Raw event `path`/`uri` remains untrusted metadata.
- Trusted display/retrieval requires artifact-store/runtime provenance.
- Web/project wrappers should render artifact views from descriptors, not by parsing paths.
