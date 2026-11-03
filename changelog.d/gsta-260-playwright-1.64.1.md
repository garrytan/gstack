**gstack's browser now runs Chromium 156, which fixes CVE-2026-106378, a macOS sandbox escape ([#3907](https://github.com/garrytan/gstack/issues/3907)).** Playwright 1.62.1 bundled Chromium 151, which predates the fix. Your next `./setup` or `/gstack-upgrade` downloads the new browser.

### Fixed
- **Playwright 1.64.1** (Chromium 156.0.8078.4, revision 1248). Chromium's fix is commit `0c2f3e54b265` ("Disclaim TCC responsibility for GPU process", crbug.com/507596239). Its code is in the tagged source for 156.0.8078.4 and missing from 151.0.7922.34. We checked the source; nobody ran the exploit. A new test fails if the bundled Chromium ever drops below 155.0.8059.12, the first tag with the fix.
- **`browse handoff` opens the browser `GSTACK_CHROMIUM_PATH` names**, as the headless and headed launches already did. Before, handoff always fell back to Playwright's bundled Chromium. It never probes or self-heals a custom browser, and it doesn't load the sidebar extension into a build that already bakes it in.

### For contributors
- `patches/playwright-core@1.64.1.patch` keeps the launch `windowsHide` hunk and the `TcpPortRandomizationWin` backport. Playwright 1.64 passes `windowsHide` on its `taskkill` call itself, so that hunk is gone; the installed-tree test still checks it.
- `.gstack/pregate.json` maps `patches/**` to `browse/test/playwright-core-patch.test.ts`, so the next Playwright bump gets a test lane without renaming anything.
- Linux arm64 now downloads the Chrome for Testing build (`chrome-linux-arm64.zip`).
