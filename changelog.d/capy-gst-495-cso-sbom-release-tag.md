**The CSO runtime image workflow passes again after Docker moved its `scout-sbom-indexer:1` tag.** All 10 `validate-native` jobs in Stage CSO Runtime Images were failing with `SOURCE_TAG_MOVED: docker.io/docker/scout-sbom-indexer:1` on every PR that touched CSO paths. Docker pushed release 1.29.0 to the floating `:1` tag on 2026-10-29. The reviewed index `sha256:4b67f29e…` is Docker's 1.24.0 release, and the `1.24.0` tag still points at it. So the SBOM generator source now names `:1.24.0`. The pinned digests and the build-inputs revision are byte-identical, no requalification trigger changes, and the 10 qualified runtimes stay current.

### Changed
- **`lib/cso/images/build-inputs.json`**: `sbomGenerator.source` is `docker.io/docker/scout-sbom-indexer:1.24.0` instead of `:1`.
- **`scripts/cso-image-matrix.ts`**: every pinned family (SBOM generator, base images, uv) must name a release-version source tag (`<major>.<minor>…`). A bare major such as `:1`, `latest` or another alias fails with `FLOATING_<FAMILY>_SOURCE` before any build, so a moving tag can't be reviewed in again. Moving the generator to 1.29.0 is a separate change that needs a new build-inputs revision and a requalified catalog.

### Tests
- `test/cso-distribution.test.ts`: `:1`, `:latest` and `:stable` are refused for the SBOM generator and for a base image, and the committed inputs build all 10 rows with the `1.24.0` source.
