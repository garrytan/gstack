<!-- AUTO-GENERATED from qa-patterns.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Browser QA methodology

Run only for selected browser surfaces. Map diffs with source before probes; discovery stays black-box, diagnosis caller-owned.

The shared exploratory loop owns execution order, not these technique phases. Its
checkpoint rule covers every probe after the baseline, including orientation, links,
exact replay and additional evidence. Never batch across checkpoints.

## Modes

For /qa and /qa-only, choose Full, Quick or Regression. Resolve conflicting depth flags
by asking before probes. /review and /ship keep their caller's smoke and plan bounds.
Diff-aware selects scope, not another pass. Time caps include checkpoints and evidence.
At exhaustion, stop probing and report unfinished coverage, never skip checkpoints.

### Diff-aware (automatic when on a feature branch with no URL)

Substitute the detected base for `main`:

```bash
git diff main...HEAD --name-only
git log main..HEAD --oneline
```

Map changed controllers/routes/views/components/models/services/styles to pages. Check commits/PR intent; add related TODO bugs to the test plan. Open static pages directly. For browser-surface API probes:

```bash
aside repl '
const pg = await openTab("<base-url>");
const r = await fetch("<base-url>/api/...", { method: "GET" });
console.log("API_STATUS=" + r.status);
console.log("API_BODY_START"); console.log((await r.text()).slice(0, 4000)); console.log("API_BODY_END");
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
```

After selecting and isolating a browser surface, find a local app if its URL is missing:

```bash
for p in 3000 4000 8080; do curl -sI --max-time 3 "http://localhost:$p" >/dev/null 2>&1 && echo "Found app on :$p"; done
```

Use the supplied URL or first responder/staging/preview; ask if none. Test changed/adjacent pages and flows. Flag new bugs absent from TODOS.md in the Phase 6 report.

**No identifiable pages:** use Quick plus discovered interactions, even for backend/config/infrastructure changes.

### Full (default with a URL)
Visit every reachable page (5-15 minutes). Score health; document 5-10 evidenced issues, never invent any.

### Quick (`--quick`)
3 minutes: homepage + top 5 navigation targets. Check loads/console/broken links; score per Health Score Rubric; skip detailed issues/checklist, never the shared loop's gates.

### Regression (`--regression <baseline>`)
Run Full; append fixed/new issues and score delta. Preserve the supplied prior baseline.
A missing or unreadable baseline is a missing prerequisite: it blocks the comparison, not the Full run.

## Workflow

### Phase 1: Initialize

Reuse the caller's BROWSER SETUP and owned artifact paths: Aside READY, otherwise `$B`
(`NEEDS_ASIDE`/`ASIDE_NOT_RUNNING`). Complete only missing setup within caller
authority. Clamp the shared loop's deadline guard to the caller's running deadline.

### Phase 2: Authenticate (if needed)

Follow BROWSER SETUP's **Browser access decision** for /setup-browser-cookies or `$B handoff`/`$B resume`. Rerun after user sign-in/2FA/OTP/CAPTCHA. Never handle credentials or expose cookies/tokens/localStorage.

### Phase 3: Orient

Establish the successful baseline before challenges. Observe the page or interaction's
expected result/state, not merely a successful load.

**Read/flow:** set `flow = true` and replace action/wait for interactions. Keep ONE script; tabs close at its end.

```bash
aside repl '
const flow = false;
const HOOK = `(() => { window.__gstackErrs = window.__gstackErrs || []; const oe = console.error; console.error = (...a) => { window.__gstackErrs.push(a.map(String).join(" ")); oe.apply(console, a); }; window.addEventListener("error", e => window.__gstackErrs.push("uncaught: " + e.message)); window.addEventListener("unhandledrejection", e => window.__gstackErrs.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason))); })()`;
const pg = await openTab("about:blank");
await pg._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
await pg.goto("<target-url>");
console.log((await snapshot(pg, { interactive: true })).tree);
await pg.screenshot({ path: flow ? "issue-001-step-1.jpg" : "initial.jpg", type: "jpeg", quality: 60, fullPage: !flow });
if (flow) {
  await pg.locator("e12").click();
  await sleep(500);
  console.log("DIFF_START"); console.log((await snapshot(pg)).diff); console.log("DIFF_END");
  await pg.screenshot({ path: "issue-001-result.jpg", type: "jpeg", quality: 60 });
}
console.log("URL=" + pg.url());
console.log("CONSOLE_ERRORS=" + JSON.stringify(await pg.evaluate(() => window.__gstackErrs)));
console.log("TEXT_START"); console.log((await pg.evaluate(() => document.body.innerText)).slice(0, 20000)); console.log("TEXT_END");
console.log("ASIDE_DIR=" + pwd);
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
```

EVERY screenshot: `cp "<ASIDE_DIR>/initial.jpg" "$REPORT_DIR/screenshots/initial.jpg"` (substitute names), then Read it. Never delete reports/screenshots.

**Links:** same-origin safe paths; HEAD only locally (requests carry cookies).

```bash
aside repl '
const pg = await openTab("<target-url>");
const links = await pg.evaluate(() => [...new Set([...document.querySelectorAll("a[href]")].map(a => a.href))].filter(h => new URL(h).origin === location.origin && !/logout|signout|delete|remove|cancel|unsubscribe/i.test(h)));
const local = await pg.evaluate(() => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$|\.(localhost|test)$/.test(location.hostname));
for (const l of links) { if (!local) { console.log("LINK ?", l); continue; } const r = await fetch(l, { method: "HEAD" }).catch(e => ({ status: "ERR " + e.message })); console.log("LINK", r.status, l); }
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
```

`LINK` 4xx/5xx or `ERR` is broken; `LINK ?` is unverified. Snapshot SPA buttons/menus missing from links.

Framework: `__next`/`_next/data` = Next.js; `csrf-token` = Rails; `wp-content` = WordPress; no-reload navigation = SPA.

### Phase 4: Explore

Select the next candidate from the preceding result. For each page, use the read script with `page-<name>.jpg`. Check layout, controls, empty/invalid/edge-case forms, navigation and empty/loading/error/overflow states per `qa/references/issue-taxonomy.md`. Prioritize core flows over secondary pages; Quick skips this checklist. For mobile:

```bash
aside repl '
const pg = await openTab("<page-url>");
await pg._sendToTarget("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await sleep(300);
await pg.screenshot({ path: "page-mobile.jpg", type: "jpeg", quality: 60, fullPage: true });
await pg._sendToTarget("Emulation.clearDeviceMetricsOverride", {});
console.log("ASIDE_DIR=" + pwd); await closeTab(pg); console.log("GSTACK_STEP_OK");
'
```

### Phase 5: Document

Confirm each issue by retrying once under the shared loop's exact-replay rule, then
minimize and report screenshot evidence immediately. A timeout before replay finishes leaves
confirmation incomplete. Later timeouts leave confirmed defects intact but evidence
or minimization unfinished.

**Interactive:** Phase 3, `flow = true`. Alternatives: `pg.fill("#email", "qa@example.com")`, `pg.getByRole("button", { name: "Save" }).click()`, `pg.waitForSelector("#done")`, `pg.waitForURL(/dashboard/)`. Link before/after screenshots in repro steps.

**Static** (copy/layout/images): one annotated screenshot and description.

```bash
aside repl '
const pg = await openTab("<page-url>");
const a = await annotatedScreenshot(pg);
await fs.writeFile(path.join(pwd, "issue-002.png"), Buffer.from(a.base64Image, "base64"));
console.log("ASIDE_DIR=" + pwd); await closeTab(pg); console.log("GSTACK_STEP_OK");
'
```

### Phase 6: Wrap Up

Format retained evidence without new probes, using `templates/qa-report-template.md`
from this host's installed QA directory and the caller's artifact/mixed-report rules.

Report score, Top 3 Things to Fix by severity, console health, severity counts, date, duration, page/screenshot counts and framework. Save `baseline.json`: `date` (YYYY-MM-DD), `url`, `healthScore`, `issues` (`id`, `title`, `severity`, `category`), `categoryScores`. Regression: fixed = prior only, new = current only.

## Health Score Rubric

Compute each category score (0-100), then take the weighted average.

### Counting
- Deduplicate the same root cause across pages. Use one primary category, first applicable: Links (navigation), Accessibility (access barriers), Functional (behavior), Performance (speed), Visual (layout), Content (copy), UX (friction), Console (remaining errors). No double deductions.
- Exclude **untested** categories; label partial scores **provisional** with coverage. None tested: "not scored". Compare only identical coverage.

### Console (weight: 15%)
Deduplicate reproducible errors/exceptions by message+source across pages. Exclude warnings, info, and defects scored elsewhere.
- 0 errors → 100
- 1-3 errors → 70
- 4-10 errors → 40
- 11+ errors → 10

### Links (weight: 10%)
Count unique broken destinations, including client-side routes: repeatable 4xx/5xx, missing routes/anchors, or timeouts. Exclude expected auth redirects and resource/API requests.
- 0 broken → 100
- Each broken link → -15 (minimum 0)

### Per-Category Scoring (Visual, Functional, UX, Content, Performance, Accessibility)
Start at 100; deduct per finding:
- Critical issue → -25
- High issue → -15
- Medium issue → -8
- Low issue → -3
Floor: 0.

Use the highest applicable severity; record impact/workaround:
- **Critical:** data loss, security/privacy exposure, or core app unusable for all users.
- **High:** core/major task blocked without a workaround.
- **Medium:** task impaired but a workaround exists.
- **Low:** cosmetic/copy/friction issue without lost task completion.
Console/Links use counts instead.

### Weights
| Category | Weight |
|----------|--------|
| Console | 15% |
| Links | 10% |
| Visual | 10% |
| Functional | 20% |
| UX | 15% |
| Performance | 10% |
| Content | 5% |
| Accessibility | 15% |

### Final Score
Use decimal weights (15% = 0.15): `score = Σ (category_score × weight) / Σ tested weights`. Round only the final score to the nearest integer (0.5 rounds up).

---

## Framework-Specific Guidance

- **Next.js:** hydration errors (`Hydration failed`, `Text content did not match`), `_next/data` 404s, link-click routing (not just `goto`), dynamic-content CLS.
- **Rails:** dev N+1 warnings, form CSRF, Turbo/Stimulus transitions, flash appearance/dismissal.
- **WordPress:** plugin JS conflicts, signed-in admin bar, `/wp-json/`, mixed content.
- **SPA:** snapshot navigation, stale state on return, back/forward history, console signs of leaks after extended use.

## Important Rules

**Never read source code during browser discovery.** Use realistic end-to-end flows; check console after every interaction. For missing click targets, use annotated labels, then ref/CSS clicks.

Use `[REDACTED]` for credentials. Follow BROWSER SETUP safety/sentinel rules: one AskUserQuestion listing non-LOCAL mutations per run, BEFORE acting. LOOK is not ACT.

**Never refuse to use the browser for a selected browser surface**, even backend-only app changes. Tests/curl cannot replace it. API/CLI/job/worker/webhook targets do not select it.
