**On Linux and Windows the renderer goes straight to gstack's own browser instead of asking for Aside (#2864).** `probeAside()` in `lib/aside-render.ts`, used by /make-pdf, /diagram and `gstack-render`, used to run `aside --version` on any platform. When that failed it told the user to install a browser that only ships for macOS. Off macOS it now answers `NEEDS_ASIDE` with "Aside is macOS-only (this is linux)", without starting a process, and the renderer moves on to gstack's own browser. macOS behavior and `GSTACK_SKIP_ASIDE=1` are unchanged.

### Changed
- **`probeAside(timeoutMs, platform)`** takes the platform, which defaults to `process.platform`. The fake-CLI probe tests pass `darwin`, so they still run on Linux CI.

Thanks to @furkankoykiran for the report. The bash readiness block inside browsing skills already prints `NEEDS_ASIDE: Linux` and is unchanged.
