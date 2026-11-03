**gstack's browser moves to Chromium 156, which has the fix for CVE-2026-106378, a macOS Chrome sandbox escape.** Playwright 1.62.1 pinned Chromium 151, which predates the fix. Your next `./setup` or `/gstack-upgrade` downloads the new browser. `browse handoff` now also opens the browser you set in `GSTACK_CHROMIUM_PATH`, so a pinned browser stays in use when you take over a session.

### Fixed
- **Playwright 1.64.1** (Chromium 156.0.8078.4, revision 1248). The tagged Chromium source for this build contains the upstream fix (commit `0c2f3e54b265`, `kMacDisclaimGpuTccResponsibility`). We checked the source and did not run the exploit.
- **`browse handoff`** honors `GSTACK_CHROMIUM_PATH`, as the headless and headed launches already do. It never probes or heals a custom bundle, and it never loads the sidebar extension twice into a build that bakes it in.
- **A SIGKILL of a `GSTACK_CHROMIUM_PATH` browser** keeps its original error. It no longer suggests reinstalling Playwright's bundled Chromium, which could not repair that browser.

### For contributors
- `patches/playwright-core@1.64.1.patch` carries two hunks. Playwright 1.64 already sets `windowsHide` on its `taskkill` call, so that hunk is gone.
- Linux arm64 now downloads the Chrome for Testing build, `chrome-linux-arm64.zip`.
- The emSign ECC Root CA - G3 root is still trusted on 156.0.8078.4, so the `BROWSER.md` warning stays.
