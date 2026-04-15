import type { TemplateContext } from './types';
import { AI_SLOP_BLACKLIST, OPENAI_HARD_REJECTIONS, OPENAI_LITMUS_CHECKS } from './constants';

export function generateDesignReviewLite(ctx: TemplateContext): string {
  const litmusList = OPENAI_LITMUS_CHECKS.map((item, i) => `${i + 1}. ${item}`).join(' ');
  const rejectionList = OPENAI_HARD_REJECTIONS.map((item, i) => `${i + 1}. ${item}`).join(' ');
  // Codex block only for Claude host
  const codexBlock = ctx.host === 'codex' ? '' : `

7. **Codex design voice** (optional, automatic if available):

\`\`\`bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
\`\`\`

If Codex is available, run a lightweight design check on the diff:

\`\`\`bash
TMPERR_DRL=$(mktemp /tmp/codex-drl-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
codex exec "Review the git diff on this branch. Run 7 litmus checks (YES/NO each): ${litmusList} Flag any hard rejections: ${rejectionList} 5 most important design findings only. Reference file:line." -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached 2>"$TMPERR_DRL"
\`\`\`

Use a 5-minute timeout (\`timeout: 300000\`). After the command completes, read stderr:
\`\`\`bash
cat "$TMPERR_DRL" && rm -f "$TMPERR_DRL"
\`\`\`

**Error handling:** All errors are non-blocking. On auth failure, timeout, or empty response — skip with a brief note and continue.

Present Codex output under a \`CODEX (design):\` header, merged with the checklist findings above.`;

  return `## Design Review (conditional, diff-scoped)

Check if the diff touches frontend files using \`gstack-diff-scope\`:

\`\`\`bash
source <(${ctx.paths.binDir}/gstack-diff-scope <base> 2>/dev/null)
\`\`\`

**If \`SCOPE_FRONTEND=false\`:** Skip design review silently. No output.

**If \`SCOPE_FRONTEND=true\`:**

1. **Check for DESIGN.md.** If \`DESIGN.md\` or \`design-system.md\` exists in the repo root, read it. All design findings are calibrated against it — patterns blessed in DESIGN.md are not flagged. If not found, use universal design principles.

2. **Read \`.claude/skills/review/design-checklist.md\`.** If the file cannot be read, skip design review with a note: "Design checklist not found — skipping design review."

3. **Read each changed frontend file** (full file, not just diff hunks). Frontend files are identified by the patterns listed in the checklist.

4. **Apply the design checklist** against the changed files. For each item:
   - **[HIGH] mechanical CSS fix** (\`outline: none\`, \`!important\`, \`font-size < 16px\`): classify as AUTO-FIX
   - **[HIGH/MEDIUM] design judgment needed**: classify as ASK
   - **[LOW] intent-based detection**: present as "Possible — verify visually or run /design-review"

5. **Include findings** in the review output under a "Design Review" header, following the output format in the checklist. Design findings merge with code review findings into the same Fix-First flow.

6. **Log the result** for the Review Readiness Dashboard:

\`\`\`bash
${ctx.paths.binDir}/gstack-review-log '{"skill":"design-review-lite","timestamp":"TIMESTAMP","status":"STATUS","findings":N,"auto_fixed":M,"commit":"COMMIT"}'
\`\`\`

Substitute: TIMESTAMP = ISO 8601 datetime, STATUS = "clean" if 0 findings or "issues_found", N = total findings, M = auto-fixed count, COMMIT = output of \`git rev-parse --short HEAD\`.${codexBlock}`;
}

// NOTE: design-checklist.md is a subset of this methodology for code-level detection.
// When adding items here, also update review/design-checklist.md, and vice versa.
export function generateDesignMethodology(_ctx: TemplateContext): string {
  return `## Modes

### Full (default)
Systematic review of all pages reachable from homepage. Visit 5-8 pages. Full checklist evaluation, responsive screenshots, interaction flow testing. Produces complete design audit report with letter grades.

### Quick (\`--quick\`)
Homepage + 2 key pages only. First Impression + Design System Extraction + abbreviated checklist. Fastest path to a design score.

### Deep (\`--deep\`)
Comprehensive review: 10-15 pages, every interaction flow, exhaustive checklist. For pre-launch audits or major redesigns.

### Diff-aware (automatic when on a feature branch with no URL)
When on a feature branch, scope to pages affected by the branch changes:
1. Analyze the branch diff: \`git diff main...HEAD --name-only\`
2. Map changed files to affected pages/routes
3. Detect running app on common local ports (3000, 4000, 8080)
4. Audit only affected pages, compare design quality before/after

### Regression (\`--regression\` or previous \`design-baseline.json\` found)
Run full audit, then load previous \`design-baseline.json\`. Compare: per-category grade deltas, new findings, resolved findings. Output regression table in report.

---

## Phase 1: First Impression

The most uniquely designer-like output. Form a gut reaction before analyzing anything.

1. Navigate to the target URL
2. Take a full-page desktop screenshot: \`$B screenshot "$REPORT_DIR/screenshots/first-impression.png"\`
3. Write the **First Impression** using this structured critique format:
   - "The site communicates **[what]**." (what it says at a glance — competence? playfulness? confusion?)
   - "I notice **[observation]**." (what stands out, positive or negative — be specific)
   - "The first 3 things my eye goes to are: **[1]**, **[2]**, **[3]**." (hierarchy check — are these the 3 things the designer intended? If not, the visual hierarchy is lying.)
   - "If I had to describe this in one word: **[word]**." (gut verdict)

**Narration mode:** Write this section in first person, as if you are a user scanning the page for the first time. "I'm looking at this page... my eye goes to the logo, then a wall of text I skip entirely, then... wait, is that a button?" Name the specific element, its position, its visual weight. If you can't name it specifically, you're not actually scanning, you're generating platitudes.

**Page Area Test:** Point at each clearly defined area of the page. Can you instantly name its purpose? ("Things I can buy," "Today's deals," "How to search.") Areas you can't name in 2 seconds are poorly defined. List them.

This is the section users read first. Be opinionated. A designer doesn't hedge — they react.

---

## Phase 2: Design System Extraction

Extract the actual design system the site uses (not what a DESIGN.md says, but what's rendered):

\`\`\`bash
# Fonts in use (capped at 500 elements to avoid timeout)
$B js "JSON.stringify([...new Set([...document.querySelectorAll('*')].slice(0,500).map(e => getComputedStyle(e).fontFamily))])"

# Color palette in use
$B js "JSON.stringify([...new Set([...document.querySelectorAll('*')].slice(0,500).flatMap(e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]).filter(c => c !== 'rgba(0, 0, 0, 0)'))])"

# Heading hierarchy
$B js "JSON.stringify([...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({tag:h.tagName, text:h.textContent.trim().slice(0,50), size:getComputedStyle(h).fontSize, weight:getComputedStyle(h).fontWeight})))"

# Touch target audit (find undersized interactive elements)
$B js "JSON.stringify([...document.querySelectorAll('a,button,input,[role=button]')].filter(e => {const r=e.getBoundingClientRect(); return r.width>0 && (r.width<44||r.height<44)}).map(e => ({tag:e.tagName, text:(e.textContent||'').trim().slice(0,30), w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height)})).slice(0,20))"

# Performance baseline
$B perf
\`\`\`

Structure findings as an **Inferred Design System**:
- **Fonts:** list with usage counts. Flag if >3 distinct font families.
- **Colors:** palette extracted. Flag if >12 unique non-gray colors. Note warm/cool/mixed.
- **Heading Scale:** h1-h6 sizes. Flag skipped levels, non-systematic size jumps.
- **Spacing Patterns:** sample padding/margin values. Flag non-scale values.

After extraction, offer: *"Want me to save this as your DESIGN.md? I can lock in these observations as your project's design system baseline."*

---

## Phase 3: Page-by-Page Visual Audit

For each page in scope:

\`\`\`bash
$B goto <url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/{page}-annotated.png"
$B responsive "$REPORT_DIR/screenshots/{page}"
$B console --errors
$B perf
\`\`\`

### Auth Detection

After the first navigation, check if the URL changed to a login-like path:
\`\`\`bash
$B url
\`\`\`
If URL contains \`/login\`, \`/signin\`, \`/auth\`, or \`/sso\`: the site requires authentication. AskUserQuestion: "This site requires authentication. Want to import cookies from your browser? Run \`/setup-browser-cookies\` first if needed."

### Trunk Test (run on every page)

Imagine being dropped on this page with no context. Can you immediately answer:
1. What site is this? (Site ID visible and identifiable)
2. What page am I on? (Page name prominent, matches what I clicked)
3. What are the major sections? (Primary nav visible and clear)
4. What are my options at this level? (Local nav or content choices obvious)
5. Where am I in the scheme of things? ("You are here" indicator, breadcrumbs)
6. How can I search? (Search box findable without hunting)

Score: PASS (all 6 clear) / PARTIAL (4-5 clear) / FAIL (3 or fewer clear).
A FAIL on the trunk test is a HIGH-impact finding regardless of how polished the visual design is.

### Design Audit Checklist (10 categories, ~80 items)

Apply these at each page. Each finding gets an impact rating (high/medium/polish) and category.

**1. Visual Hierarchy & Composition** (8 items)
- Clear focal point? One primary CTA per view?
- Eye flows naturally top-left to bottom-right?
- Visual noise — competing elements fighting for attention?
- Information density appropriate for content type?
- Z-index clarity — nothing unexpectedly overlapping?
- Above-the-fold content communicates purpose in 3 seconds?
- Squint test: hierarchy still visible when blurred?
- White space is intentional, not leftover?

**2. Typography** (15 items)
- Font count <=3 (flag if more)
- Scale follows ratio (1.25 major third or 1.333 perfect fourth)
- Line-height: 1.5x body, 1.15-1.25x headings
- Measure: 45-75 chars per line (66 ideal)
- Heading hierarchy: no skipped levels (h1→h3 without h2)
- Weight contrast: >=2 weights used for hierarchy
- No blacklisted fonts (Papyrus, Comic Sans, Lobster, Impact, Jokerman)
- If primary font is Inter/Roboto/Open Sans/Poppins → flag as potentially generic
- \`text-wrap: balance\` or \`text-pretty\` on headings (check via \`$B css <heading> text-wrap\`)
- Curly quotes used, not straight quotes
- Ellipsis character (\`…\`) not three dots (\`...\`)
- \`font-variant-numeric: tabular-nums\` on number columns
- Body text >= 16px
- Caption/label >= 12px
- No letterspacing on lowercase text

**3. Color & Contrast** (10 items)
- Palette coherent (<=12 unique non-gray colors)
- WCAG AA: body text 4.5:1, large text (18px+) 3:1, UI components 3:1
- Semantic colors consistent (success=green, error=red, warning=yellow/amber)
- No color-only encoding (always add labels, icons, or patterns)
- Dark mode: surfaces use elevation, not just lightness inversion
- Dark mode: text off-white (~#E0E0E0), not pure white
- Primary accent desaturated 10-20% in dark mode
- \`color-scheme: dark\` on html element (if dark mode present)
- No red/green only combinations (8% of men have red-green deficiency)
- Neutral palette is warm or cool consistently — not mixed

**4. Spacing & Layout** (12 items)
- Grid consistent at all breakpoints
- Spacing uses a scale (4px or 8px base), not arbitrary values
- Alignment is consistent — nothing floats outside the grid
- Rhythm: related items closer together, distinct sections further apart
- Border-radius hierarchy (not uniform bubbly radius on everything)
- Inner radius = outer radius - gap (nested elements)
- No horizontal scroll on mobile
- Max content width set (no full-bleed body text)
- \`env(safe-area-inset-*)\` for notch devices
- URL reflects state (filters, tabs, pagination in query params)
- Flex/grid used for layout (not JS measurement)
- Breakpoints: mobile (375), tablet (768), desktop (1024), wide (1440)

**5. Interaction States** (10 items)
- Hover state on all interactive elements
- \`focus-visible\` ring present (never \`outline: none\` without replacement)
- Active/pressed state with depth effect or color shift
- Disabled state: reduced opacity + \`cursor: not-allowed\`
- Loading: skeleton shapes match real content layout
- Empty states: warm message + primary action + visual (not just "No items.")
- Error messages: specific + include fix/next step
- Success: confirmation animation or color, auto-dismiss
- Touch targets >= 44px on all interactive elements
- \`cursor: pointer\` on all clickable elements
- Mindless choice audit: every decision point (button, link, dropdown, modal choice) is a mindless click (obvious what happens). If a click requires thought about whether it's the right choice, flag as HIGH.

**6. Responsive Design** (8 items)
- Mobile layout makes *design* sense (not just stacked desktop columns)
- Touch targets sufficient on mobile (>= 44px)
- No horizontal scroll on any viewport
- Images handle responsive (srcset, sizes, or CSS containment)
- Text readable without zooming on mobile (>= 16px body)
- Navigation collapses appropriately (hamburger, bottom nav, etc.)
- Forms usable on mobile (correct input types, no autoFocus on mobile)
- No \`user-scalable=no\` or \`maximum-scale=1\` in viewport meta

**7. Motion & Animation** (6 items)
- Easing: ease-out for entering, ease-in for exiting, ease-in-out for moving
- Duration: 50-700ms range (nothing slower unless page transition)
- Purpose: every animation communicates something (state change, attention, spatial relationship)
- \`prefers-reduced-motion\` respected (check: \`$B js "matchMedia('(prefers-reduced-motion: reduce)').matches"\`)
- No \`transition: all\` — properties listed explicitly
- Only \`transform\` and \`opacity\` animated (not layout properties like width, height, top, left)

**8. Content & Microcopy** (8 items)
- Empty states designed with warmth (message + action + illustration/icon)
- Error messages specific: what happened + why + what to do next
- Button labels specific ("Save API Key" not "Continue" or "Submit")
- No placeholder/lorem ipsum text visible in production
- Truncation handled (\`text-overflow: ellipsis\`, \`line-clamp\`, or \`break-words\`)
- Active voice ("Install the CLI" not "The CLI will be installed")
- Loading states end with \`…\` ("Saving…" not "Saving...")
- Destructive actions have confirmation modal or undo window
- Happy talk detection: scan for introductory paragraphs that start with "Welcome to..." or tell users how great the site is. If you can hear "blah blah blah", it's happy talk. Flag for removal.
- Instructions detection: any visible instructions longer than one sentence. If users need to read instructions, the design has failed. Flag the instructions AND the interaction they're compensating for.
- Happy talk word count: count total visible words on the page. Classify each text block as "useful content" vs "happy talk" (welcome paragraphs, self-congratulatory text, instructions nobody reads). Report: "This page has X words. Y (Z%) are happy talk."

**9. AI Slop Detection** (10 anti-patterns — the blacklist)

The test: would a human designer at a respected studio ever ship this?

${AI_SLOP_BLACKLIST.map(item => `- ${item}`).join('\n')}

**10. Performance as Design** (6 items)
- LCP < 2.0s (web apps), < 1.5s (informational sites)
- CLS < 0.1 (no visible layout shifts during load)
- Skeleton quality: shapes match real content layout, shimmer animation
- Images: \`loading="lazy"\`, width/height dimensions set, WebP/AVIF format
- Fonts: \`font-display: swap\`, preconnect to CDN origins
- No visible font swap flash (FOUT) — critical fonts preloaded

---

## Phase 4: Interaction Flow Review

Walk 2-3 key user flows and evaluate the *feel*, not just the function:

\`\`\`bash
$B snapshot -i
$B click @e3           # perform action
$B snapshot -D          # diff to see what changed
\`\`\`

Evaluate:
- **Response feel:** Does clicking feel responsive? Any delays or missing loading states?
- **Transition quality:** Are transitions intentional or generic/absent?
- **Feedback clarity:** Did the action clearly succeed or fail? Is the feedback immediate?
- **Form polish:** Focus states visible? Validation timing correct? Errors near the source?

**Narration mode:** Narrate the flow in first person. "I click 'Sign Up'... spinner appears... 3 seconds pass... still spinning... I'm getting nervous. Finally the dashboard loads, but where am I? The nav doesn't highlight anything." Name the specific element, its position, its visual weight. If you can't name it specifically, you're not actually experiencing the flow, you're generating platitudes.

### Goodwill Reservoir (track across the flow)

As you walk the user flow, maintain a mental goodwill meter (starts at 70/100).
These scores are heuristic, not measured. The value is in identifying specific
drains and fills, not in the final number.

Subtract points for:
- Hidden information the user would want (pricing, contact, shipping): subtract 15
- Format punishment (rejecting valid input like dashes in phone numbers): subtract 10
- Unnecessary information requests: subtract 10
- Interstitials, splash screens, forced tours blocking the task: subtract 15
- Sloppy or unprofessional appearance: subtract 10
- Ambiguous choices that require thinking: subtract 5 each

Add points for:
- Top user tasks are obvious and prominent: add 10
- Upfront about costs and limitations: add 5
- Saves steps (direct links, smart defaults, autofill): add 5 each
- Graceful error recovery with specific fix instructions: add 10
- Apologizes when things go wrong: add 5

Report the final goodwill score with a visual dashboard:

\`\`\`
Goodwill: 70 ████████████████████░░░░░░░░░░
  Step 1: Login page        70 → 75  (+5 obvious primary action)
  Step 2: Dashboard          75 → 60  (-15 interstitial tour popup)
  Step 3: Settings           60 → 50  (-10 format punishment on phone)
  Step 4: Billing            50 → 35  (-15 hidden pricing info)
  FINAL: 35/100 ⚠️ CRITICAL UX DEBT
\`\`\`

Below 30 = critical UX debt. 30-60 = needs work. Above 60 = healthy.
Include the biggest drains and fills as specific findings.

---

## Phase 5: Cross-Page Consistency

Compare screenshots and observations across pages for:
- Navigation bar consistent across all pages?
- Footer consistent?
- Component reuse vs one-off designs (same button styled differently on different pages?)
- Tone consistency (one page playful while another is corporate?)
- Spacing rhythm carries across pages?

---

## Phase 6: Compile Report

### Output Locations

**Local:** \`.gstack/design-reports/design-audit-{domain}-{YYYY-MM-DD}.md\`

**Project-scoped:**
\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
\`\`\`
Write to: \`~/.gstack/projects/{slug}/{user}-{branch}-design-audit-{datetime}.md\`

**Baseline:** Write \`design-baseline.json\` for regression mode:
\`\`\`json
{
  "date": "YYYY-MM-DD",
  "url": "<target>",
  "designScore": "B",
  "aiSlopScore": "C",
  "categoryGrades": { "hierarchy": "A", "typography": "B", ... },
  "findings": [{ "id": "FINDING-001", "title": "...", "impact": "high", "category": "typography" }]
}
\`\`\`

### Scoring System

**Dual headline scores:**
- **Design Score: {A-F}** — weighted average of all 10 categories
- **AI Slop Score: {A-F}** — standalone grade with pithy verdict

**Per-category grades:**
- **A:** Intentional, polished, delightful. Shows design thinking.
- **B:** Solid fundamentals, minor inconsistencies. Looks professional.
- **C:** Functional but generic. No major problems, no design point of view.
- **D:** Noticeable problems. Feels unfinished or careless.
- **F:** Actively hurting user experience. Needs significant rework.

**Grade computation:** Each category starts at A. Each High-impact finding drops one letter grade. Each Medium-impact finding drops half a letter grade. Polish findings are noted but do not affect grade. Minimum is F.

**Category weights for Design Score:**
| Category | Weight |
|----------|--------|
| Visual Hierarchy | 15% |
| Typography | 15% |
| Spacing & Layout | 15% |
| Color & Contrast | 10% |
| Interaction States | 10% |
| Responsive | 10% |
| Content Quality | 10% |
| AI Slop | 5% |
| Motion | 5% |
| Performance Feel | 5% |

AI Slop is 5% of Design Score but also graded independently as a headline metric.

### Regression Output

When previous \`design-baseline.json\` exists or \`--regression\` flag is used:
- Load baseline grades
- Compare: per-category deltas, new findings, resolved findings
- Append regression table to report

---

## Design Critique Format

Use structured feedback, not opinions:
- "I notice..." — observation (e.g., "I notice the primary CTA competes with the secondary action")
- "I wonder..." — question (e.g., "I wonder if users will understand what 'Process' means here")
- "What if..." — suggestion (e.g., "What if we moved search to a more prominent position?")
- "I think... because..." — reasoned opinion (e.g., "I think the spacing between sections is too uniform because it doesn't create hierarchy")

Tie everything to user goals and product objectives. Always suggest specific improvements alongside problems.

---

## Important Rules

1. **Think like a designer, not a QA engineer.** You care whether things feel right, look intentional, and respect the user. You do NOT just care whether things "work."
2. **Screenshots are evidence.** Every finding needs at least one screenshot. Use annotated screenshots (\`snapshot -a\`) to highlight elements.
3. **Be specific and actionable.** "Change X to Y because Z" — not "the spacing feels off."
4. **Never read source code.** Evaluate the rendered site, not the implementation. (Exception: offer to write DESIGN.md from extracted observations.)
5. **AI Slop detection is your superpower.** Most developers can't evaluate whether their site looks AI-generated. You can. Be direct about it.
6. **Quick wins matter.** Always include a "Quick Wins" section — the 3-5 highest-impact fixes that take <30 minutes each.
7. **Use \`snapshot -C\` for tricky UIs.** Finds clickable divs that the accessibility tree misses.
8. **Responsive is design, not just "not broken."** A stacked desktop layout on mobile is not responsive design — it's lazy. Evaluate whether the mobile layout makes *design* sense.
9. **Document incrementally.** Write each finding to the report as you find it. Don't batch.
10. **Depth over breadth.** 5-10 well-documented findings with screenshots and specific suggestions > 20 vague observations.
11. **Show screenshots to the user.** After every \`$B screenshot\`, \`$B snapshot -a -o\`, or \`$B responsive\` command, use the Read tool on the output file(s) so the user can see them inline. For \`responsive\` (3 files), Read all three. This is critical — without it, screenshots are invisible to the user.`;
}

export function generateDesignSketch(_ctx: TemplateContext): string {
  return `## Visual Sketch (UI ideas only)

If the chosen approach involves user-facing UI (screens, pages, forms, dashboards,
or interactive elements), generate a rough wireframe to help the user visualize it.
If the idea is backend-only, infrastructure, or has no UI component — skip this
section silently.

**Step 1: Gather design context**

1. Check if \`DESIGN.md\` exists in the repo root. If it does, read it for design
   system constraints (colors, typography, spacing, component patterns). Use these
   constraints in the wireframe.
2. Apply core design principles:
   - **Information hierarchy** — what does the user see first, second, third?
   - **Interaction states** — loading, empty, error, success, partial
   - **Edge case paranoia** — what if the name is 47 chars? Zero results? Network fails?
   - **Subtraction default** — "as little design as possible" (Rams). Every element earns its pixels.
   - **Design for trust** — every interface element builds or erodes user trust.

**Step 2: Generate wireframe HTML**

Generate a single-page HTML file with these constraints:
- **Intentionally rough aesthetic** — use system fonts, thin gray borders, no color,
  hand-drawn-style elements. This is a sketch, not a polished mockup.
- Self-contained — no external dependencies, no CDN links, inline CSS only
- Show the core interaction flow (1-3 screens/states max)
- Include realistic placeholder content (not "Lorem ipsum" — use content that
  matches the actual use case)
- Add HTML comments explaining design decisions

Write to a temp file:
\`\`\`bash
SKETCH_FILE="/tmp/gstack-sketch-$(date +%s).html"
\`\`\`

**Step 3: Render and capture**

\`\`\`bash
$B goto "file://$SKETCH_FILE"
$B screenshot /tmp/gstack-sketch.png
\`\`\`

If \`$B\` is not available (browse binary not set up), skip the render step. Tell the
user: "Visual sketch requires the browse binary. Run the setup script to enable it."

**Step 4: Present and iterate**

Show the screenshot to the user. Ask: "Does this feel right? Want to iterate on the layout?"

If they want changes, regenerate the HTML with their feedback and re-render.
If they approve or say "good enough," proceed.

**Step 5: Include in design doc**

Reference the wireframe screenshot in the design doc's "Recommended Approach" section.
The screenshot file at \`/tmp/gstack-sketch.png\` can be referenced by downstream skills
(\`/plan-design-review\`, \`/design-review\`) to see what was originally envisioned.

**Step 6: Outside design voices** (optional)

After the wireframe is approved, offer outside design perspectives:

\`\`\`bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
\`\`\`

If Codex is available, use AskUserQuestion:
> "Want outside design perspectives on the chosen approach? Codex proposes a visual thesis, content plan, and interaction ideas. A Claude subagent proposes an alternative aesthetic direction."
>
> A) Yes — get outside design voices
> B) No — proceed without

If user chooses A, launch both voices simultaneously:

1. **Codex** (via Bash, \`model_reasoning_effort="medium"\`):
\`\`\`bash
TMPERR_SKETCH=$(mktemp /tmp/codex-sketch-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
codex exec "For this product approach, provide: a visual thesis (one sentence — mood, material, energy), a content plan (hero → support → detail → CTA), and 2 interaction ideas that change page feel. Apply beautiful defaults: composition-first, brand-first, cardless, poster not document. Be opinionated." -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="medium"' --enable web_search_cached 2>"$TMPERR_SKETCH"
\`\`\`
Use a 5-minute timeout (\`timeout: 300000\`). After completion: \`cat "$TMPERR_SKETCH" && rm -f "$TMPERR_SKETCH"\`

2. **Claude subagent** (via Agent tool):
"For this product approach, what design direction would you recommend? What aesthetic, typography, and interaction patterns fit? What would make this approach feel inevitable to the user? Be specific — font names, hex colors, spacing values."

Present Codex output under \`CODEX SAYS (design sketch):\` and subagent output under \`CLAUDE SUBAGENT (design direction):\`.
Error handling: all non-blocking. On failure, skip and continue.`;
}

export function generateDesignOutsideVoices(ctx: TemplateContext): string {
  // Codex host: strip entirely — Codex should never invoke itself
  if (ctx.host === 'codex') return '';

  const rejectionList = OPENAI_HARD_REJECTIONS.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const litmusList = OPENAI_LITMUS_CHECKS.map((item, i) => `${i + 1}. ${item}`).join('\n');

  // Skill-specific configuration
  const isPlanDesignReview = ctx.skillName === 'plan-design-review';
  const isDesignReview = ctx.skillName === 'design-review';
  const isDesignConsultation = ctx.skillName === 'design-consultation';

  // Determine opt-in behavior and reasoning effort
  const isAutomatic = isDesignReview; // design-review runs automatically
  const reasoningEffort = isDesignConsultation ? 'medium' : 'high'; // creative vs analytical

  // Build skill-specific Codex prompt
  let codexPrompt: string;
  let subagentPrompt: string;

  if (isPlanDesignReview) {
    codexPrompt = `Read the plan file at [plan-file-path]. Evaluate this plan's UI/UX design against these criteria.

HARD REJECTION — flag if ANY apply:
${rejectionList}

LITMUS CHECKS — answer YES or NO for each:
${litmusList}

HARD RULES — first classify as MARKETING/LANDING PAGE vs APP UI vs HYBRID, then flag violations of the matching rule set:
- MARKETING: First viewport as one composition, brand-first hierarchy, full-bleed hero, 2-3 intentional motions, composition-first layout
- APP UI: Calm surface hierarchy, dense but readable, utility language, minimal chrome
- UNIVERSAL: CSS variables for colors, no default font stacks, one job per section, cards earn existence

For each finding: what's wrong, what will happen if it ships unresolved, and the specific fix. Be opinionated. No hedging.`;

    subagentPrompt = `Read the plan file at [plan-file-path]. You are an independent senior product designer reviewing this plan. You have NOT seen any prior review. Evaluate:

1. Information hierarchy: what does the user see first, second, third? Is it right?
2. Missing states: loading, empty, error, success, partial — which are unspecified?
3. User journey: what's the emotional arc? Where does it break?
4. Specificity: does the plan describe SPECIFIC UI ("48px Söhne Bold header, #1a1a1a on white") or generic patterns ("clean modern card-based layout")?
5. What design decisions will haunt the implementer if left ambiguous?

For each finding: what's wrong, severity (critical/high/medium), and the fix.`;
  } else if (isDesignReview) {
    codexPrompt = `Review the frontend source code in this repo. Evaluate against these design hard rules:
- Spacing: systematic (design tokens / CSS variables) or magic numbers?
- Typography: expressive purposeful fonts or default stacks?
- Color: CSS variables with defined system, or hardcoded hex scattered?
- Responsive: breakpoints defined? calc(100svh - header) for heroes? Mobile tested?
- A11y: ARIA landmarks, alt text, contrast ratios, 44px touch targets?
- Motion: 2-3 intentional animations, or zero / ornamental only?
- Cards: used only when card IS the interaction? No decorative card grids?

First classify as MARKETING/LANDING PAGE vs APP UI vs HYBRID, then apply matching rules.

LITMUS CHECKS — answer YES/NO:
${litmusList}

HARD REJECTION — flag if ANY apply:
${rejectionList}

Be specific. Reference file:line for every finding.`;

    subagentPrompt = `Review the frontend source code in this repo. You are an independent senior product designer doing a source-code design audit. Focus on CONSISTENCY PATTERNS across files rather than individual violations:
- Are spacing values systematic across the codebase?
- Is there ONE color system or scattered approaches?
- Do responsive breakpoints follow a consistent set?
- Is the accessibility approach consistent or spotty?

For each finding: what's wrong, severity (critical/high/medium), and the file:line.`;
  } else if (isDesignConsultation) {
    codexPrompt = `Given this product context, propose a complete design direction:
- Visual thesis: one sentence describing mood, material, and energy
- Typography: specific font names (not defaults — no Inter/Roboto/Arial/system) + hex colors
- Color system: CSS variables for background, surface, primary text, muted text, accent
- Layout: composition-first, not component-first. First viewport as poster, not document
- Differentiation: 2 deliberate departures from category norms
- Anti-slop: no purple gradients, no 3-column icon grids, no centered everything, no decorative blobs

Be opinionated. Be specific. Do not hedge. This is YOUR design direction — own it.`;

    subagentPrompt = `Given this product context, propose a design direction that would SURPRISE. What would the cool indie studio do that the enterprise UI team wouldn't?
- Propose an aesthetic direction, typography stack (specific font names), color palette (hex values)
- 2 deliberate departures from category norms
- What emotional reaction should the user have in the first 3 seconds?

Be bold. Be specific. No hedging.`;
  } else {
    // Unknown skill — return empty
    return '';
  }

  // Build the opt-in section
  const optInSection = isAutomatic ? `
**Automatic:** Outside voices run automatically when Codex is available. No opt-in needed.` : `
Use AskUserQuestion:
> "Want outside design voices${isPlanDesignReview ? ' before the detailed review' : ''}? Codex evaluates against OpenAI's design hard rules + litmus checks; Claude subagent does an independent ${isDesignConsultation ? 'design direction proposal' : 'completeness review'}."
>
> A) Yes — run outside design voices
> B) No — proceed without

If user chooses B, skip this step and continue.`;

  // Build the synthesis section
  const synthesisSection = isPlanDesignReview ? `
**Synthesis — Litmus scorecard:**

\`\`\`
DESIGN OUTSIDE VOICES — LITMUS SCORECARD:
═══════════════════════════════════════════════════════════════
  Check                                    Claude  Codex  Consensus
  ─────────────────────────────────────── ─────── ─────── ─────────
  1. Brand unmistakable in first screen?   —       —      —
  2. One strong visual anchor?             —       —      —
  3. Scannable by headlines only?          —       —      —
  4. Each section has one job?             —       —      —
  5. Cards actually necessary?             —       —      —
  6. Motion improves hierarchy?            —       —      —
  7. Premium without decorative shadows?   —       —      —
  ─────────────────────────────────────── ─────── ─────── ─────────
  Hard rejections triggered:               —       —      —
═══════════════════════════════════════════════════════════════
\`\`\`

Fill in each cell from the Codex and subagent outputs. CONFIRMED = both agree. DISAGREE = models differ. NOT SPEC'D = not enough info to evaluate.

**Pass integration (respects existing 7-pass contract):**
- Hard rejections → raised as the FIRST items in Pass 1, tagged \`[HARD REJECTION]\`
- Litmus DISAGREE items → raised in the relevant pass with both perspectives
- Litmus CONFIRMED failures → pre-loaded as known issues in the relevant pass
- Passes can skip discovery and go straight to fixing for pre-identified issues` :
    isDesignConsultation ? `
**Synthesis:** Claude main references both Codex and subagent proposals in the Phase 3 proposal. Present:
- Areas of agreement between all three voices (Claude main + Codex + subagent)
- Genuine divergences as creative alternatives for the user to choose from
- "Codex and I agree on X. Codex suggested Y where I'm proposing Z — here's why..."` : `
**Synthesis — Litmus scorecard:**

Use the same scorecard format as /plan-design-review (shown above). Fill in from both outputs.
Merge findings into the triage with \`[codex]\` / \`[subagent]\` / \`[cross-model]\` tags.`;

  const escapedCodexPrompt = codexPrompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');

  return `## Design Outside Voices (parallel)
${optInSection}

**Check Codex availability:**
\`\`\`bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
\`\`\`

**If Codex is available**, launch both voices simultaneously:

1. **Codex design voice** (via Bash):
\`\`\`bash
TMPERR_DESIGN=$(mktemp /tmp/codex-design-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
codex exec "${escapedCodexPrompt}" -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="${reasoningEffort}"' --enable web_search_cached 2>"$TMPERR_DESIGN"
\`\`\`
Use a 5-minute timeout (\`timeout: 300000\`). After the command completes, read stderr:
\`\`\`bash
cat "$TMPERR_DESIGN" && rm -f "$TMPERR_DESIGN"
\`\`\`

2. **Claude design subagent** (via Agent tool):
Dispatch a subagent with this prompt:
"${subagentPrompt}"

**Error handling (all non-blocking):**
- **Auth failure:** If stderr contains "auth", "login", "unauthorized", or "API key": "Codex authentication failed. Run \`codex login\` to authenticate."
- **Timeout:** "Codex timed out after 5 minutes."
- **Empty response:** "Codex returned no response."
- On any Codex error: proceed with Claude subagent output only, tagged \`[single-model]\`.
- If Claude subagent also fails: "Outside voices unavailable — continuing with primary review."

Present Codex output under a \`CODEX SAYS (design ${isPlanDesignReview ? 'critique' : isDesignReview ? 'source audit' : 'direction'}):\` header.
Present subagent output under a \`CLAUDE SUBAGENT (design ${isPlanDesignReview ? 'completeness' : isDesignReview ? 'consistency' : 'direction'}):\` header.
${synthesisSection}

**Log the result:**
\`\`\`bash
${ctx.paths.binDir}/gstack-review-log '{"skill":"design-outside-voices","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","source":"SOURCE","commit":"'"$(git rev-parse --short HEAD)"'"}'
\`\`\`
Replace STATUS with "clean" or "issues_found", SOURCE with "codex+subagent", "codex-only", "subagent-only", or "unavailable".`;
}

// ─── Design Hard Rules (OpenAI framework + gstack slop blacklist) ───
export function generateDesignHardRules(_ctx: TemplateContext): string {
  const slopItems = AI_SLOP_BLACKLIST.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const rejectionItems = OPENAI_HARD_REJECTIONS.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const litmusItems = OPENAI_LITMUS_CHECKS.map((item, i) => `${i + 1}. ${item}`).join('\n');

  return `### Design Hard Rules

**Classifier — determine rule set before evaluating:**
- **MARKETING/LANDING PAGE** (hero-driven, brand-forward, conversion-focused) → apply Landing Page Rules
- **APP UI** (workspace-driven, data-dense, task-focused: dashboards, admin, settings) → apply App UI Rules
- **HYBRID** (marketing shell with app-like sections) → apply Landing Page Rules to hero/marketing sections, App UI Rules to functional sections

**Hard rejection criteria** (instant-fail patterns — flag if ANY apply):
${rejectionItems}

**Litmus checks** (answer YES/NO for each — used for cross-model consensus scoring):
${litmusItems}

**Landing page rules** (apply when classifier = MARKETING/LANDING):
- First viewport reads as one composition, not a dashboard
- Brand-first hierarchy: brand > headline > body > CTA
- Typography: expressive, purposeful — no default stacks (Inter, Roboto, Arial, system)
- No flat single-color backgrounds — use gradients, images, subtle patterns
- Hero: full-bleed, edge-to-edge, no inset/tiled/rounded variants
- Hero budget: brand, one headline, one supporting sentence, one CTA group, one image
- No cards in hero. Cards only when card IS the interaction
- One job per section: one purpose, one headline, one short supporting sentence
- Motion: 2-3 intentional motions minimum (entrance, scroll-linked, hover/reveal)
- Color: define CSS variables, avoid purple-on-white defaults, one accent color default
- Copy: product language not design commentary. "If deleting 30% improves it, keep deleting"
- Beautiful defaults: composition-first, brand as loudest text, two typefaces max, cardless by default, first viewport as poster not document

**App UI rules** (apply when classifier = APP UI):
- Calm surface hierarchy, strong typography, few colors
- Dense but readable, minimal chrome
- Organize: primary workspace, navigation, secondary context, one accent
- Avoid: dashboard-card mosaics, thick borders, decorative gradients, ornamental icons
- Copy: utility language — orientation, status, action. Not mood/brand/aspiration
- Cards only when card IS the interaction
- Section headings state what area is or what user can do ("Selected KPIs", "Plan status")

**Universal rules** (apply to ALL types):
- Define CSS variables for color system
- No default font stacks (Inter, Roboto, Arial, system)
- One job per section
- "If deleting 30% of the copy improves it, keep deleting"
- Cards earn their existence — no decorative card grids
- NEVER use small, low-contrast type (body text < 16px or contrast ratio < 4.5:1 on body text)
- NEVER put labels inside form fields as the only label (placeholder-as-label pattern — labels must be visible when the field has content)
- ALWAYS preserve visited vs unvisited link distinction (visited links must have a different color)
- NEVER float headings between paragraphs (heading must be visually closer to the section it introduces than to the preceding section)

**AI Slop blacklist** (the 10 patterns that scream "AI-generated"):
${slopItems}

Source: [OpenAI "Designing Delightful Frontends with GPT-5.4"](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4) (Mar 2026) + gstack design methodology.`;
}

export function generateDesignSetup(ctx: TemplateContext): string {
  return `## DESIGN SETUP (run this check BEFORE any design mockup command)

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/design/dist/design" ] && D="$_ROOT/${ctx.paths.localSkillRoot}/design/dist/design"
[ -z "$D" ] && D=${ctx.paths.designDir}/design
if [ -x "$D" ]; then
  echo "DESIGN_READY: $D"
else
  echo "DESIGN_NOT_AVAILABLE"
fi
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse" ] && B="$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse"
[ -z "$B" ] && B=${ctx.paths.browseDir}/browse
if [ -x "$B" ]; then
  echo "BROWSE_READY: $B"
else
  echo "BROWSE_NOT_AVAILABLE (will use 'open' to view comparison boards)"
fi
\`\`\`

If \`DESIGN_NOT_AVAILABLE\`: skip visual mockup generation and fall back to the
existing HTML wireframe approach (\`DESIGN_SKETCH\`). Design mockups are a
progressive enhancement, not a hard requirement.

If \`BROWSE_NOT_AVAILABLE\`: use \`open file://...\` instead of \`$B goto\` to open
comparison boards. The user just needs to see the HTML file in any browser.

If \`DESIGN_READY\`: the design binary is available for visual mockup generation.
Commands:
- \`$D generate --brief "..." --output /path.png\` — generate a single mockup
- \`$D variants --brief "..." --count 3 --output-dir /path/\` — generate N style variants
- \`$D compare --images "a.png,b.png,c.png" --output /path/board.html --serve\` — comparison board + HTTP server
- \`$D serve --html /path/board.html\` — serve comparison board and collect feedback via HTTP
- \`$D check --image /path.png --brief "..."\` — vision quality gate
- \`$D iterate --session /path/session.json --feedback "..." --output /path.png\` — iterate

**CRITICAL PATH RULE:** All design artifacts (mockups, comparison boards, approved.json)
MUST be saved to \`~/.gstack/projects/$SLUG/designs/\`, NEVER to \`.context/\`,
\`docs/designs/\`, \`/tmp/\`, or any project-local directory. Design artifacts are USER
data, not project files. They persist across branches, conversations, and workspaces.`;
}

export function generateDesignMockup(ctx: TemplateContext): string {
  return `## Visual Design Exploration

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/design/dist/design" ] && D="$_ROOT/${ctx.paths.localSkillRoot}/design/dist/design"
[ -z "$D" ] && D=${ctx.paths.designDir}/design
[ -x "$D" ] && echo "DESIGN_READY" || echo "DESIGN_NOT_AVAILABLE"
\`\`\`

**If \`DESIGN_NOT_AVAILABLE\`:** Fall back to the HTML wireframe approach below
(the existing DESIGN_SKETCH section). Visual mockups require the design binary.

**If \`DESIGN_READY\`:** Generate visual mockup explorations for the user.

Generating visual mockups of the proposed design... (say "skip" if you don't need visuals)

**Step 1: Set up the design directory**

\`\`\`bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
_DESIGN_DIR=~/.gstack/projects/$SLUG/designs/mockup-$(date +%Y%m%d)
mkdir -p "$_DESIGN_DIR"
echo "DESIGN_DIR: $_DESIGN_DIR"
\`\`\`

**Step 2: Construct the design brief**

Read DESIGN.md if it exists — use it to constrain the visual style. If no DESIGN.md,
explore wide across diverse directions.

**Step 3: Generate 3 variants**

\`\`\`bash
$D variants --brief "<assembled brief>" --count 3 --output-dir "$_DESIGN_DIR/"
\`\`\`

This generates 3 style variations of the same brief (~40 seconds total).

**Step 4: Show variants inline, then open comparison board**

Show each variant to the user inline first (read the PNGs with Read tool), then
create and serve the comparison board:

\`\`\`bash
$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png,$_DESIGN_DIR/variant-C.png" --output "$_DESIGN_DIR/design-board.html" --serve
\`\`\`

This opens the board in the user's default browser and blocks until feedback is
received. Read stdout for the structured JSON result. No polling needed.

If \`$D serve\` is not available or fails, fall back to AskUserQuestion:
"I've opened the design board. Which variant do you prefer? Any feedback?"

**Step 5: Handle feedback**

If the JSON contains \`"regenerated": true\`:
1. Read \`regenerateAction\` (or \`remixSpec\` for remix requests)
2. Generate new variants with \`$D iterate\` or \`$D variants\` using updated brief
3. Create new board with \`$D compare\`
4. POST the new HTML to the running server via \`curl -X POST http://localhost:PORT/api/reload -H 'Content-Type: application/json' -d '{"html":"$_DESIGN_DIR/design-board.html"}'\`
   (parse the port from stderr: look for \`SERVE_STARTED: port=XXXXX\`)
5. Board auto-refreshes in the same tab

If \`"regenerated": false\`: proceed with the approved variant.

**Step 6: Save approved choice**

\`\`\`bash
echo '{"approved_variant":"<VARIANT>","feedback":"<FEEDBACK>","date":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","screen":"mockup","branch":"'$(git branch --show-current 2>/dev/null)'"}' > "$_DESIGN_DIR/approved.json"
\`\`\`

Reference the saved mockup in the design doc or plan.`;
}

export function generateDesignShotgunLoop(_ctx: TemplateContext): string {
  return `### Comparison Board + Feedback Loop

Create the comparison board and serve it over HTTP:

\`\`\`bash
$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png,$_DESIGN_DIR/variant-C.png" --output "$_DESIGN_DIR/design-board.html" --serve
\`\`\`

This command generates the board HTML, starts an HTTP server on a random port,
and opens it in the user's default browser. **Run it in the background** with \`&\`
because the server needs to stay running while the user interacts with the board.

Parse the port from stderr output: \`SERVE_STARTED: port=XXXXX\`. You need this
for the board URL and for reloading during regeneration cycles.

**PRIMARY WAIT: AskUserQuestion with board URL**

After the board is serving, use AskUserQuestion to wait for the user. Include the
board URL so they can click it if they lost the browser tab:

"I've opened a comparison board with the design variants:
http://127.0.0.1:<PORT>/ — Rate them, leave comments, remix
elements you like, and click Submit when you're done. Let me know when you've
submitted your feedback (or paste your preferences here). If you clicked
Regenerate or Remix on the board, tell me and I'll generate new variants."

**Do NOT use AskUserQuestion to ask which variant the user prefers.** The comparison
board IS the chooser. AskUserQuestion is just the blocking wait mechanism.

**After the user responds to AskUserQuestion:**

Check for feedback files next to the board HTML:
- \`$_DESIGN_DIR/feedback.json\` — written when user clicks Submit (final choice)
- \`$_DESIGN_DIR/feedback-pending.json\` — written when user clicks Regenerate/Remix/More Like This

\`\`\`bash
if [ -f "$_DESIGN_DIR/feedback.json" ]; then
  echo "SUBMIT_RECEIVED"
  cat "$_DESIGN_DIR/feedback.json"
elif [ -f "$_DESIGN_DIR/feedback-pending.json" ]; then
  echo "REGENERATE_RECEIVED"
  cat "$_DESIGN_DIR/feedback-pending.json"
  rm "$_DESIGN_DIR/feedback-pending.json"
else
  echo "NO_FEEDBACK_FILE"
fi
\`\`\`

The feedback JSON has this shape:
\`\`\`json
{
  "preferred": "A",
  "ratings": { "A": 4, "B": 3, "C": 2 },
  "comments": { "A": "Love the spacing" },
  "overall": "Go with A, bigger CTA",
  "regenerated": false
}
\`\`\`

**If \`feedback.json\` found:** The user clicked Submit on the board.
Read \`preferred\`, \`ratings\`, \`comments\`, \`overall\` from the JSON. Proceed with
the approved variant.

**If \`feedback-pending.json\` found:** The user clicked Regenerate/Remix on the board.
1. Read \`regenerateAction\` from the JSON (\`"different"\`, \`"match"\`, \`"more_like_B"\`,
   \`"remix"\`, or custom text)
2. If \`regenerateAction\` is \`"remix"\`, read \`remixSpec\` (e.g. \`{"layout":"A","colors":"B"}\`)
3. Generate new variants with \`$D iterate\` or \`$D variants\` using updated brief
4. Create new board: \`$D compare --images "..." --output "$_DESIGN_DIR/design-board.html"\`
5. Reload the board in the user's browser (same tab):
   \`curl -s -X POST http://127.0.0.1:PORT/api/reload -H 'Content-Type: application/json' -d '{"html":"$_DESIGN_DIR/design-board.html"}'\`
6. The board auto-refreshes. **AskUserQuestion again** with the same board URL to
   wait for the next round of feedback. Repeat until \`feedback.json\` appears.

**If \`NO_FEEDBACK_FILE\`:** The user typed their preferences directly in the
AskUserQuestion response instead of using the board. Use their text response
as the feedback.

**POLLING FALLBACK:** Only use polling if \`$D serve\` fails (no port available).
In that case, show each variant inline using the Read tool (so the user can see them),
then use AskUserQuestion:
"The comparison board server failed to start. I've shown the variants above.
Which do you prefer? Any feedback?"

**After receiving feedback (any path):** Output a clear summary confirming
what was understood:

"Here's what I understood from your feedback:
PREFERRED: Variant [X]
RATINGS: [list]
YOUR NOTES: [comments]
DIRECTION: [overall]

Is this right?"

Use AskUserQuestion to verify before proceeding.

**Save the approved choice:**
\`\`\`bash
echo '{"approved_variant":"<V>","feedback":"<FB>","date":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","screen":"<SCREEN>","branch":"'$(git branch --show-current 2>/dev/null)'"}' > "$_DESIGN_DIR/approved.json"
\`\`\``;
}

// ─── UX Behavioral Foundations (Krug + HCI research) ───
export function generateUXPrinciples(_ctx: TemplateContext): string {
  return `## UX Principles: How Users Actually Behave

These principles govern how real humans interact with interfaces. They are observed
behavior, not preferences. Apply them before, during, and after every design decision.

### The Three Laws of Usability

1. **Don't make me think.** Every page should be self-evident. If a user stops
   to think "What do I click?" or "What does this mean?", the design has failed.
   Self-evident > self-explanatory > requires explanation.

2. **Clicks don't matter, thinking does.** Three mindless, unambiguous clicks
   beat one click that requires thought. Each step should feel like an obvious
   choice (animal, vegetable, or mineral), not a puzzle.

3. **Omit, then omit again.** Get rid of half the words on each page, then get
   rid of half of what's left. Happy talk (self-congratulatory text) must die.
   Instructions must die. If they need reading, the design has failed.

### How Users Actually Behave

- **Users scan, they don't read.** Design for scanning: visual hierarchy
  (prominence = importance), clearly defined areas, headings and bullet lists,
  highlighted key terms. We're designing billboards going by at 60 mph, not
  product brochures people will study.
- **Users satisfice.** They pick the first reasonable option, not the best.
  Make the right choice the most visible choice.
- **Users muddle through.** They don't figure out how things work. They wing
  it. If they accomplish their goal by accident, they won't seek the "right" way.
  Once they find something that works, no matter how badly, they stick to it.
- **Users don't read instructions.** They dive in. Guidance must be brief,
  timely, and unavoidable, or it won't be seen.

### Billboard Design for Interfaces

- **Use conventions.** Logo top-left, nav top/left, search = magnifying glass.
  Don't innovate on navigation to be clever. Innovate when you KNOW you have a
  better idea, otherwise use conventions. Even across languages and cultures,
  web conventions let people identify the logo, nav, search, and main content.
- **Visual hierarchy is everything.** Related things are visually grouped. Nested
  things are visually contained. More important = more prominent. If everything
  shouts, nothing is heard. Start with the assumption everything is visual noise,
  guilty until proven innocent.
- **Make clickable things obviously clickable.** No relying on hover states for
  discoverability, especially on mobile where hover doesn't exist. Shape, location,
  and formatting (color, underlining) must signal clickability without interaction.
- **Eliminate noise.** Three sources: too many things shouting for attention
  (shouting), things not organized logically (disorganization), and too much stuff
  (clutter). Fix noise by removal, not addition.
- **Clarity trumps consistency.** If making something significantly clearer
  requires making it slightly inconsistent, choose clarity every time.

### Navigation as Wayfinding

Users on the web have no sense of scale, direction, or location. Navigation
must always answer: What site is this? What page am I on? What are the major
sections? What are my options at this level? Where am I? How can I search?

Persistent navigation on every page. Breadcrumbs for deep hierarchies.
Current section visually indicated. The "trunk test": cover everything except
the navigation. You should still know what site this is, what page you're on,
and what the major sections are. If not, the navigation has failed.

### The Goodwill Reservoir

Users start with a reservoir of goodwill. Every friction point depletes it.

**Deplete faster:** Hiding info users want (pricing, contact, shipping). Punishing
users for not doing things your way (formatting requirements on phone numbers).
Asking for unnecessary information. Putting sizzle in their way (splash screens,
forced tours, interstitials). Unprofessional or sloppy appearance.

**Replenish:** Know what users want to do and make it obvious. Tell them what they
want to know upfront. Save them steps wherever possible. Make it easy to recover
from errors. When in doubt, apologize.

### Mobile: Same Rules, Higher Stakes

All the above applies on mobile, just more so. Real estate is scarce, but never
sacrifice usability for space savings. Affordances must be VISIBLE: no cursor
means no hover-to-discover. Touch targets must be big enough (44px minimum).
Flat design can strip away useful visual information that signals interactivity.
Prioritize ruthlessly: things needed in a hurry go close at hand, everything
else a few taps away with an obvious path to get there.`;
}

