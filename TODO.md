# TODO — gstack roadmap

## Phase 1: Foundations (v0.2.0)
  - [x] Rename to gstack
  - [x] Restructure to monorepo layout
  - [x] Setup script for skill symlinks
  - [x] Snapshot command with ref-based element selection
  - [x] Snapshot tests

## Phase 2: Enhanced Browser (v0.2.0) ✅
  - [x] Annotated screenshots (--annotate flag, ref labels overlaid on screenshot)
  - [x] Snapshot diffing (--diff flag, unified diff against previous snapshot)
  - [x] Dialog handling (auto-accept/dismiss, dialog buffer, prevents browser lockup)
  - [x] File upload (upload <sel> <files>)
  - [x] Cursor-interactive elements (-C flag, cursor:pointer/onclick/tabindex scan)
  - [x] Element state checks (is visible/hidden/enabled/disabled/checked/editable/focused)
  - [x] CircularBuffer — O(1) ring buffer for console/network/dialog (was O(n) array+shift)
  - [x] Async buffer flush with Bun.write() (was appendFileSync)
  - [x] Health check with page.evaluate('1') + 2s timeout
  - [x] Playwright error wrapping — actionable messages for AI agents
  - [x] Fix useragent — context recreation preserves cookies/storage/URLs
  - [x] DRY: getCleanText exported, command sets in chain updated
  - [x] 148 integration tests (was ~63)

## Phase 3: QA Testing Agent (v0.3.0)
  - [x] `/qa` SKILL.md — 6-phase workflow: Initialize → Authenticate → Orient → Explore → Document → Wrap up
  - [x] Issue taxonomy reference (7 categories: visual, functional, UX, content, performance, console, accessibility)
  - [x] Severity classification (critical/high/medium/low)
  - [x] Exploration checklist per page
  - [x] Report template (structured markdown with per-issue evidence)
  - [x] Repro-first philosophy: every issue gets evidence before moving on
  - [x] Two evidence tiers: interactive bugs (multi-step screenshots), static bugs (single annotated screenshot)
  - [x] Key guidance: 5-10 well-documented issues per session, depth over breadth, write incrementally
  - [x] Three modes: full (systematic), quick (30-second smoke test), regression (compare against baseline)
  - [x] Framework detection guidance (Next.js, Rails, WordPress, SPA)
  - [x] Health score rubric (7 categories, weighted average)
  - [x] `wait --networkidle` / `wait --load` / `wait --domcontentloaded`
  - [x] `console --errors` (filter to error/warning only)
  - [x] `cookie-import <json-file>` (bulk cookie import with auto-fill domain)
  - [x] `browse/bin/find-browse` (DRY binary discovery across skills)
  - [ ] Video recording (deferred to Phase 5 — recreateContext destroys page state)

## Phase 3.5: Browser Cookie Import (v0.3.x)
  - [x] `cookie-import-browser` command (Chromium cookie DB decryption)
  - [x] Cookie picker web UI (served from browse server)
  - [x] `/setup-browser-cookies` skill
  - [x] Unit tests with encrypted cookie fixtures (18 tests)
  - [x] Browser registry (Comet, Chrome, Arc, Brave, Edge)

## Phase 3.6: Visual PR Annotations + S3 Upload
  - [ ] `/setup-gstack-upload` skill (configure S3 bucket for image hosting)
  - [ ] `browse/bin/gstack-upload` helper (upload file to S3, return public URL)
  - [ ] `/ship` Step 7.5: visual verification with screenshots in PR body
  - [ ] `/review` Step 4.5: visual review with annotated screenshots in PR
  - [ ] WebM → GIF conversion (ffmpeg) for video evidence in PRs
  - [ ] README documentation for visual PR annotations

## Phase 4: Skill + Browser Integration
  - [ ] ship + browse: post-deploy verification
    - Browse staging/preview URL after push
    - Screenshot key pages
    - Check console for JS errors
    - Compare staging vs prod via snapshot diff
    - Include verification screenshots in PR body
    - STOP if critical errors found
  - [ ] review + browse: visual diff review
    - Browse PR's preview deploy
    - Annotated screenshots of changed pages
    - Compare against production visually
    - Check responsive layouts (mobile/tablet/desktop)
    - Verify accessibility tree hasn't regressed
  - [ ] deploy-verify skill: lightweight post-deploy smoke test
    - Hit key URLs, verify 200s
    - Screenshot critical pages
    - Console error check
    - Compare against baseline snapshots
    - Pass/fail with evidence

## Phase 5: State & Sessions
  - [ ] v20 encryption format support (AES-256-GCM) — future Chromium versions may change from v10
  - [ ] Sessions (isolated browser instances with separate cookies/storage/history)
  - [ ] State persistence (save/load cookies + localStorage to JSON files)
  - [ ] Auth vault (encrypted credential storage, referenced by name, LLM never sees passwords)
  - [ ] Video recording (record start/stop — needs sessions for clean context lifecycle)
  - [ ] retro + browse: deployment health tracking
    - Screenshot production state
    - Check perf metrics (page load times)
    - Count console errors across key pages
    - Track trends over retro window

## Phase 6: Advanced Browser
  - [ ] Iframe support (frame <sel>, frame main)
  - [ ] Semantic locators (find role/label/text/placeholder/testid with actions)
  - [ ] Device emulation presets (set device "iPhone 16 Pro")
  - [ ] Network mocking/routing (intercept, block, mock requests)
  - [ ] Download handling (click-to-download with path control)
  - [ ] Content safety (--max-output truncation, --allowed-domains)
  - [ ] Streaming (WebSocket live preview for pair browsing)
  - [ ] CDP mode (connect to already-running Chrome/Electron apps)

## Future Ideas
  - [ ] Linux/Windows cookie decryption (GNOME Keyring / kwallet / DPAPI)
  - [ ] Trend tracking across QA runs — compare baseline.json over time, detect regressions (P2, S)
  - [ ] CI/CD integration — `/qa` as GitHub Action step, fail PR if health score drops (P2, M)
  - [ ] Accessibility audit mode — `--a11y` flag for focused accessibility testing (P3, S)

## Ideas & Notes
  - Browser is the nervous system — every skill should be able to see, interact with, and verify the web
  - Skills are the product; the browser enables them
  - One repo, one install, entire AI engineering workflow
  - Bun compiled binary matches Rust CLI performance for this use case (bottleneck is Chromium, not CLI parsing)
  - Accessibility tree snapshots use ~200-400 tokens vs ~3000-5000 for full DOM — critical for AI context efficiency
  - Locator map approach for refs: store Map<string, Locator> on BrowserManager, no DOM mutation, no CSP issues
  - Snapshot scoping (-i, -c, -d, -s flags) is critical for performance on large pages
  - All new commands follow existing pattern: add to command set, add switch case, return string
