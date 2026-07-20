# ADR 0001: public infrastructure tools

- Status: accepted for the GStack 2 candidate
- Date: 2026-07-20
- Scope: installation, first-use UX, browser binaries, release integrity, and
  updater ownership

## Decision

Use public tools only where they have a narrow, replaceable responsibility:

| Responsibility | Decision | Boundary |
|---|---|---|
| Skill discovery, host placement, project/global scope, selection, update, and removal | [Vercel Agent Skills CLI](https://github.com/vercel-labs/skills), pinned to 1.5.19 in verification | Canonical and exclusive skill lifecycle. GStack never silently enrolls a host. |
| Interactive terminal prompts | [Clack](https://github.com/bombshell-dev/clack), if adopted after the current zero-dependency prompt surface needs richer TTY UX | Presentation only; consent state, policy, transactions, and non-TTY flags stay in GStack. No dependency is added merely for styling. |
| Local browser binaries | [Playwright](https://playwright.dev/docs/browsers) | Existing local Chromium manager only. No cloud-browser provider. |
| Cross-platform launchers | [Bun compile](https://bun.sh/docs/bundler/executables) | Build-time native launcher production; the runtime remains host-neutral. |
| Release signing and verification metadata | [Sigstore Cosign](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/) in release CI | CI signs immutable archives keylessly. Every client verifies byte count and SHA-256; Cosign verification is additional when already installed, never a mandatory end-user install. |
| Release attestations | [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/use-artifact-attestations) | Provenance for release artifacts, with actions pinned to immutable commits and `id-token: write` limited to the signing job. |

GStack owns the product-specific remainder: the signed runtime manifest,
capability consent, atomic install journal, rollback, doctor output, and the
first-use prompt that appears only when a chosen skill needs an unavailable
capability.

## Rejected as mandatory dependencies

- `oclif`: a second CLI framework would not solve skill placement, consent, or
  transactional updates and would expand the runtime dependency surface.
- `eget`: convenient binary download UX, but it does not encode GStack's fixed
  artifact host, manifest, capability, rollback, or privacy policies.
- `mise` and `aqua`: useful optional environment/package managers, but requiring
  either would add a package manager in front of the standard Agent Skills
  installer.
- hosted browsers, device farms, alternate iOS drivers, ComfyUI, model weights,
  and GPU runtimes: outside the accepted architecture.

## Consequences

The standard installer can evolve independently without GStack maintaining six
host adapters. The optional runtime has one auditable release format and no
automatic setup. Public-tool telemetry and network behavior must be disclosed
at the point of use; upstream Agent Skills telemetry can be disabled with
`DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1`.

The repository keeps tests for the pinned installer behavior and release
contract. A future tool swap must preserve those contracts instead of leaking
the tool's own nouns into the six-skill public surface.
