# Bun redistribution source and version record

Official GStack runtime 2.0.0 artifacts redistribute the unmodified Bun 1.3.14
executable installed by the pinned `oven-sh/setup-bun` release workflow step.
The exact upstream license inventory is vendored beside this file as
`BUN-LICENSE-1.3.14.md`. The tagged raw file's SHA-256 is
`2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741`;
the vendored copy differs only by its final newline and has SHA-256
`2cb858b2db8fc793bca2093489c5bc8eee615d002cc4924254904044c27a0afa`.

Authoritative tagged sources, including the object/source material and relink
instructions referenced by the upstream license inventory:

- https://github.com/oven-sh/bun/tree/bun-v1.3.14
- https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md
- https://github.com/oven-sh/webkit

Reviewed-source installs may capture a different user-selected Bun executable.
Its exact version is recorded in the active runtime's `.gstack-bundle.json`; the
redistributor of such a custom bundle is responsible for retaining the matching
upstream notices and source/relink offer.
