<!-- AUTO-GENERATED from proposal-and-preview.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
<!-- The font-selection procedure and the three-looks calibration in this section are derived from pbakaus/impeccable reference/new-work.md (Apache-2.0), rewritten and modified. See NOTICE.md. -->
## Phase 3: The Complete Proposal

Read this section in full, then apply its design/font rules → draft independently → offer outside voices → synthesize for Q2. Preview and writes require their later approvals.

### Your Design Knowledge (use to inform proposals — do NOT display as tables)

**Calibration: the three looks.** Avoid predictable compositions: cream/serif/terracotta; near-black/neon/glowing edges; or broadsheet hairlines/italic serif/tiny tracked mono. Use one only when the brief specifically calls for it. Otherwise choose a direction grounded in these users, rather than the category stereotype or its obvious opposite. For example, a book product can draw color from jackets and cloth instead of defaulting to cream and serif.

**Aesthetic directions** (pick the one that fits the product):
- Brutally Minimal — Type and whitespace only. No decoration. Modernist.
- Maximalist Chaos — Dense, layered, pattern-heavy. Y2K meets contemporary.
- Retro-Futuristic — Vintage tech nostalgia. Phosphor palette, bitmap type, warm monospace for data (no glow halos, no grid-paper backgrounds).
- Luxury/Refined — Serifs, high contrast, generous whitespace, precious metals.
- Playful/Toy-like — Rounded, springy (no overshoot), bold primaries. Approachable and fun.
- Editorial/Magazine — Strong typographic hierarchy, asymmetric grids, pull quotes.
- Brutalist/Raw — Exposed structure, one utilitarian grotesk, visible grid, no polish (a system stack only when the user asks for it by name).
- Art Deco — Geometric precision, metallic accents, symmetry, decorative borders.
- Organic/Natural — Earth tones, rounded forms, hand-drawn texture, grain.
- Industrial/Utilitarian — Function-first, data-dense, monospace accents, muted palette.

**Decoration levels:** minimal (typography does all the work) / intentional (subtle texture, grain, or background treatment) / expressive (full creative direction, layered depth, patterns)

**Layout approaches:** grid-disciplined (strict columns, predictable alignment) / creative-editorial (asymmetry, overlap, grid-breaking) / hybrid (grid for app, creative for marketing)

**Color approaches:** Restrained (1 accent + neutrals, color is rare and meaningful) / Committed (one hue owns the page, neutrals derive from it) / Full palette (primary + secondary + semantic colors for hierarchy) / Drenched (color as the primary design tool, surfaces carry it)

**Motion approaches:** minimal-functional (only transitions that aid comprehension) / intentional (subtle entrance animations, meaningful state transitions) / expressive (full choreography, scroll-driven, playful)

**Choosing faces: a procedure, not a menu.** (1) Name the audience's world (publication, notation, identity or object they read) and mode: Persuade (marketing), Operate (tasks), Read (long content), Experience (immersive). Match its tone. (2) Shortlist three faces per display/body/label/mono role. (3) Apply role exclusions. (4) Verify via WebSearch/Aside on Google Fonts/Fontshare, or local files/licenses; omit unverified faces. (5) Specify loading strategy.

**Font-verification fallback:** Skipping competitive research does not waive font verification. Offline, check local files/licenses. Otherwise describe roles/weights/proportions; mark font selection as pending verification in DESIGN.md. Continue palette/layout; defer the preview until fonts can be verified, or honor a user skip. Invent no face or URL.

**Overused as display** (never the display voice, on any surface; the body/UI exception below is the only one; the detector flags several as `overused-font`): Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Space Mono, Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, IBM Plex Sans, IBM Plex Serif, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans, Geist.

**Fine as body/UI on an Operate or Read surface when the proposal says so:** DM Sans, Instrument Sans, IBM Plex Sans. **Mono for data and code:** JetBrains Mono, IBM Plex Mono, Fira Code.

**Banned in any role:** Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Raleway, Clash Display, Courier New.

**Freely available faces on no default list** (verified 2026-09-08; re-verify in-session; see font-verification fallback if offline): Satoshi, General Sans, Clash Grotesk, Cabinet Grotesk (Fontshare); Instrument Serif, Source Sans 3, JetBrains Mono, Fira Code (Google Fonts). Short on purpose. A long list of "good" fonts is how the last convergence happened.

User asks for a listed face by name: comply, state the tradeoff once.

**Anti-convergence directive:** VARY aesthetic, faces and palette across project generations; justify repetition. Light vs dark is not one of the dials: fix it to the use scene (who, where, lighting) until that scene changes. Unjustified convergence is slop.

**AI slop anti-patterns** (never include in your recommendations):
- Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes
- **The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.
- Icons in colored circles as section decoration (SaaS starter template look)
- Centered everything (`text-align: center` on all headings, descriptions, cards)
- Uniform bubbly border-radius on every element (same large radius on everything)
- Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)
- Emoji as design elements (rockets in headings, emoji as bullet points)
- Colored left-border on cards (`border-left: 3px solid <accent>`)
- Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")
- Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)
- system-ui or `-apple-system` as the PRIMARY display/body font — the "I gave up on typography" signal. Pick a real typeface.
- A colored edge on a rounded card: the side-tab in a costume. Signal state with a background tint, an icon, or a label.
- A training-data default as the display voice means you stopped looking. As body or UI on an Operate or Read surface, several of these are fine. Say which and why.
- Headings within a step of body size. Pick a scale and let the levels differ by more than a weight.
- Emphasis is weight or size. Gradient text is emphasis in a costume.
- Cream ground, serif display, terracotta accent: look number one. Fine when the brief asked for it; a default when it did not.
- A card inside a card is always wrong. Cards are the lazy container; nesting them is the lazy container squared.
- An illustration built from CSS shapes standing in for an asset. Produce the asset or ship nothing.
- Glowing edges on dark surfaces: look number two. Depth has an offset; a zero-offset colored halo is decoration.
- A radial gradient halo behind the hero content. Look number two again.
- A spotlight glow washing the top of the page. Same family as the halo.
- An infinitely scrolling logo strip. If the logos matter, show them still; if they do not, cut them.
- The rounded-square icon above every heading. Try side by side, or drop the container.
- Look three: the italic display serif reaching for editorial credibility. Earn it with the content or set the display upright.
- A pill-shaped label floating above the hero headline. The headline carries its own weight; cut the chip.
- A kicker above a heading is the strongest default there is: the heading carries its own weight, so delete the label. If the user wants it anyway, comply and say the tradeoff once.
- "Seamless", "effortless", "supercharge", "streamline": words that describe nothing. Say what the product does.
- Short. Punchy. Fragments. Every sentence a slogan. Write like a person explaining something.
- Display type past 6rem on a page that is not a poster. Size is not hierarchy.
- "Built for the way you work", "Designed for teams like yours", "Meet your new...": phrases that perform a launch instead of describing one.
- Gradient buttons as the primary call to action. One solid color the palette owns.
- A generic stock-photo hero, or a gray placeholder div standing in for one. Show the product or show nothing.
- Rounded cards with drop shadows as the container for everything. App UI made of stacked cards is not layout.
- A testimonial row with avatars, five stars, and quotes nobody said. Real names with real claims, or cut it.
- The cookie-cutter hero: headline left, screenshot right, two buttons. The first template every generator reaches for.
- "Get Started" and "Learn More" as the only calls to action. Name the outcome the click buys.
- Three big numbers with tiny labels under the hero ("10k+ users", "99.9%"). The template counts, not the product.
- A grid of cards with the same shape, the same icon slot, the same two lines. Content of unequal weight given equal boxes.
- Frosted-glass panels with blurred backdrops as the default surface. One translucent layer where it explains depth, not everywhere.
- Generated SVG doodles and mascots in place of art direction. Commission or license an asset, or ship none.
- Every secondary action in a modal. Inline, a side panel, or a new page usually costs the user less.
- Sparklines, progress rings, and fake avatars filling space where content should be. Real data or an honest empty state.
- Dark because it is a dev tool, light because it is health. Light or dark comes from the use scene: who, where, under what light.
- Only the happy path is designed. Empty, loading, error, and long-content states are part of the component.

### Coherence Validation

After any override, gently flag mismatches and offer alternatives: Brutalist/Minimal + expressive motion → quieter motion or keep intentionally; Drenched + minimal decoration → supporting decoration; editorial + dense data → hybrid layout. Never block; accept the user's final choice and proceed.

### Independent proposals, then synthesis

Draft your own direction from the product brief using the rules above. Keep that draft out of both reviewers' prompts; send the product context, not your answer.

## Design Outside Voices (independent)

Use AskUserQuestion:
> "Want outside design voices? Codex proposes an independent design direction; Claude subagent does an independent design direction proposal."
>
> A) Yes — run outside design voices
> B) No — proceed without

If user chooses B, record one declined result as described below, skip both voices, and continue to Q2 with your draft.

**If accepted:** Create a private file for the Phase 1 product brief, including Phase 2 research status:
```bash
_DESIGN_BRIEF=$(mktemp /tmp/gstack-design-brief-XXXXXXXX) || exit 1
printf 'DESIGN_BRIEF=%s\n' "$_DESIGN_BRIEF"
```
Write the product brief to that path; remember the absolute path across fresh Bash calls. Neither voice inherits context: give both the same brief. Include its complete contents in the outside prompt file; give the native Agent its absolute path. Keep your draft direction out of both prompts. Never paste brief text into shell source.

**Check Codex availability:**
```bash

_OUTSIDE_CFG=enabled # This caller has its own opt-in/skip control.
if [ "$_OUTSIDE_CFG" = disabled ]; then
  echo 'CODEX_MODE: disabled'
elif ( # GSTACK_ACTIVE_HOST names the harness, never the model.
if { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  echo 'Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage.' >&2
  if { [ -n "${CLAUDECODE:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = claude ]; } && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
    echo 'Inherited harness markers conflict. Run setup --host <actual-harness> (claude or codex); do not guess a replacement provider.' >&2
  else
    echo 'Repair installed skills: run setup --host codex from your gstack checkout.' >&2
  fi
  exit 78
fi
); then
  if command -v codex >/dev/null 2>&1; then echo 'CODEX_MODE: ready'; else echo 'CODEX_MODE: not_installed'; fi
else
  echo 'CODEX_MODE: under_current_harness'
fi
```

The historical `CODEX_MODE` variable describes **Codex** availability here. Authentication and configured model validity are checked by the actual invocation, without overriding either. Missing/broken CLI: install or repair Codex; authentication failure: run `codex login`. Honor this caller’s existing opt-in/skip choice. Any non-ready outcome is missing outside coverage; follow the caller’s existing fallback. Never substitute another external provider.

Non-ready CLI: retain its repair notice and use only the native voice. The invocation deliberately rechecks the harness before spawning; native success never replaces external coverage.

**When ready**, run both voices and await both before synthesis. Overlap calls
if supported; keep the native call blocking.

1. **Codex design voice** (via Bash):
Prompt (include the actual plan/product/frontend source context, not only file paths):

"Given this product context, propose a complete design direction:
- Visual thesis: one sentence describing mood, material, and energy
- Typography: specific font names with display/body/UI roles (no Inter/Roboto/Arial/system defaults); the parent verifies font availability before adoption
- Color system: hex values and CSS variables for background, surface, primary text, muted text, accent
- Layout: composition-first, not component-first. First viewport as poster, not document
- Differentiation: 2 deliberate departures from category norms
- Anti-slop: none of purple gradient palette, the 3-column feature grid, centered everything, decorative blobs and dividers, nested cards, kicker above heading, icon tile above every heading, dark-mode glow

Be opinionated. Be specific. Do not hedge. This is YOUR design direction — own it.

End with Recommendation: <direction> because <product-specific reason>."

Write the **complete prompt and context**, including actual plan/spec/source, to a private file. Substitute its shell-quoted path for `<prepared-prompt-file>`; never interpolate user text into shell source. Request a complete design proposal ending with Recommendation: <direction> because <product-specific reason>.

```bash
# GSTACK_ACTIVE_HOST names the harness, never the model.
if { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  echo 'Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage.' >&2
  if { [ -n "${CLAUDECODE:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = claude ]; } && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
    echo 'Inherited harness markers conflict. Run setup --host <actual-harness> (claude or codex); do not guess a replacement provider.' >&2
  else
    echo 'Repair installed skills: run setup --host codex from your gstack checkout.' >&2
  fi
  exit 78
fi

_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo 'ERROR: not in a git repo' >&2; exit 1; }
_OUTSIDE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/gstack-outside.XXXXXXXX") || exit 1
trap 'rm -rf "$_OUTSIDE_TMP"' EXIT
_OUTSIDE_INPUT="$_OUTSIDE_TMP/prompt"
cat -- '<prepared-prompt-file>' >"$_OUTSIDE_INPUT" || exit 1

source "$HOME/.claude/skills/gstack/bin/gstack-codex-probe" || exit 1
_OUTSIDE_PROMPT=$(cat "$_OUTSIDE_INPUT") || exit 1
_OUTSIDE_EXIT=0
_gstack_codex_timeout_wrapper 300 codex exec "$_OUTSIDE_PROMPT" -C "$_REPO_ROOT" -s read-only -c "model=\"${GSTACK_CODEX_MODEL:-gpt-6-astra}\"" -c 'model_reasoning_effort="medium"' -c 'web_search="cached"' < /dev/null >"$_OUTSIDE_TMP/text" 2>"$_OUTSIDE_TMP/stderr" || _OUTSIDE_EXIT=$?
# Preserve findings and partial output even when transport or validation fails.
cat "$_OUTSIDE_TMP/text" || { [ "$_OUTSIDE_EXIT" -ne 0 ] || _OUTSIDE_EXIT=1; }

cat "$_OUTSIDE_TMP/stderr" >&2 || { [ "$_OUTSIDE_EXIT" -ne 0 ] || _OUTSIDE_EXIT=1; }
if [ "$_OUTSIDE_EXIT" -ne 0 ]; then
  echo 'Codex outside review unavailable: execution failed; missing coverage. Check the provider diagnosis above.' >&2
  exit "$_OUTSIDE_EXIT"
fi
bun "$HOME/.claude/skills/gstack/lib/outside-review-result.ts" review "$_OUTSIDE_TMP/text" || exit 1

echo 'OUTSIDE_STATUS: completed provider=codex host=claude'
```

Show the full response in a `tool-output` fence. Require successful execution and valid markers. Refusal, empty/malformed output, missing Recommendation markers, timeout or CLI failure means `outside_status: unavailable`. Continue completed proposals; native completion does not count as outside coverage. After either outcome, delete only your private prompt; scratch cleanup is automatic.

2. **Claude design subagent** (Agent tool, `run_in_background: false`; await its result):
"Read the complete product brief at [the absolute DESIGN_BRIEF path printed above].

Propose a surprising indie-studio direction beyond conventional enterprise UI.
- Propose an aesthetic direction, typography stack (specific font names), color palette (hex values)
- 2 deliberate departures from category norms
- What emotional reaction should the user have in the first 3 seconds?

Be bold and specific."

**Error handling (all non-blocking):**
- **Auth failure:** If stderr contains "auth", "login", "unauthorized", or "API key": "Codex authentication failed. Run `codex login` to authenticate."
- **Timeout:** "Codex timed out after 5 minutes."
- **Empty response:** "Codex returned no response."
- On any Codex error: proceed with Claude subagent output only; identify it as the only completed independent proposal.
- If Claude subagent also fails: "Outside voices unavailable — continuing to Q2 with my draft direction."

Present only completed, available voice outputs with their actual source and status.
Output headers: `CODEX SAYS (design direction):` and `CLAUDE SUBAGENT (design direction):`.

**Handoff:** Retain every completed proposal (two, one, or none) with its source/status. Do not choose a direction here. Q2 compares these proposals with your earlier draft.
After both voices finish (including failure), delete only the private brief you created, using its remembered absolute path.

**Log the result:** If the user accepted, run the command twice: one record for each voice, including any unavailable voice. If the user declined, run it once with STATUS=skipped, SOURCE=none, OUTSIDE_STATUS=skipped.
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"design-outside-voices","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","source":"SOURCE","host":"claude","outside_provider":"codex","outside_status":"OUTSIDE_STATUS","phase":"design","commit":"'"$(git rev-parse --short HEAD)"'"}'
```
For each accepted-run record, STATUS=clean for a usable proposal, issues_found for unresolved product constraints, unavailable for no valid completion. Taste differences are alternatives, not issues.

| Record | SOURCE |
|---|---|
| External CLI | codex when completed, otherwise "none" |
| Native subagent | in-host when completed, otherwise "none" |

Both records carry the actual CLI outcome: OUTSIDE_STATUS=completed only for successful execution with valid markers, otherwise unavailable. `outside_provider`/`outside_status` describe external coverage, not each record's source. A native-only success has STATUS=clean, SOURCE=in-host, outside_status="unavailable".

Keep the historical skill identifier. Historical source:"claude" still means a native Claude subagent. Preserve reported modelUsage, including multiple models; unknown model identity stays unknown.

Compare completed outside proposals: explain agreements, differences, and ideas adopted with attribution. Verify any newly suggested fonts before adopting them using the same procedure above. Tie the recommendation to the memorable-thing answer. Do not count agreement as a vote or invent a missing proposal. Q2 names completed, unavailable, or declined voices and presents the recommendation.

**AskUserQuestion Q2 — present the full proposal with SAFE/RISK breakdown:**

```
Based on [product context] and [research findings / my design knowledge]:

AESTHETIC: [direction] — [one-line rationale]
DECORATION: [level] — [why this pairs with the aesthetic]
LAYOUT: [approach] — [why this fits the product type]
COLOR: [approach] + proposed palette (hex values) — [rationale]
TYPOGRAPHY: [display, body, label, mono assignments; a face may serve multiple roles] — [why these fonts]
SPACING: [base unit + density] — [rationale]
MOTION: [approach] — [rationale]

This system is coherent because [explain how choices reinforce each other].

INDEPENDENT INPUT: [completed/unavailable/skipped voices; agreements, differences, ideas adopted and product-specific reasons — omit comparisons if none completed]

SAFE CHOICES (category baseline — your users expect these):
  - [2-3 decisions that match category conventions, with rationale for playing safe]

RISKS (where your product gets its own face):
  - [2-3 deliberate departures from convention]
  - For each risk: what it is, why it works, what you gain, what it costs

Safe choices meet category expectations; risks make the product memorable.
Which risks appeal to you? Try others or adjust anything else?
```

Coherence alone can look generic. Propose at least 2 creative risks—type, accent, spacing, layout or motion—with rationale, benefit and cost alongside the category's safe choices.

**Options:** A) Looks great — proceed to Phase 5 if fonts are verified. B) Adjust [section] — Phase 4, then Q2 again. C) Different risks — revise the proposal, then Q2 again. D) Start over — draft another direction using the same confirmed brief. E) Skip the preview — proceed to Phase 6's Q-final, not straight to writing.

Revisions recheck fonts and coherence. If the product brief changes, label old proposals stale and offer fresh independent voices; do not claim they reviewed new context.

---

## Phase 4: Drill-downs (only if user requests adjustments)

Use one focused AskUserQuestion per requested drill-down: **Fonts:** 3-5 candidates, rationale/evocation and preview offer; **Colors:** 2-3 hex palettes and color theory; **Aesthetic:** product-fit directions and why; **Layout/Spacing/Motion:** concrete product-specific tradeoffs. Re-check coherence after each decision.

---

## Phase 5: Design System Preview (default ON)

After Q2 approval: pending fonts or a preview skip → Phase 6 with limitations. Generation unavailable/failed → offer Path B or skip, not unbounded retries.

### Path A: AI Mockups (if DESIGN_READY)

Apply the proposed system to realistic product screens:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
eval "$(~/.claude/skills/gstack/bin/gstack-paths)"
_DESIGN_DIR="$GSTACK_STATE_ROOT/projects/$SLUG/designs/design-system-$(date +%Y%m%d)"
mkdir -p "$_DESIGN_DIR"
echo "DESIGN_DIR: $_DESIGN_DIR"
```

Brief: Phase 3 aesthetic/colors/type/spacing/layout plus Phase 1 product context:

```bash
$D variants --brief "<product name: [name]. Product type: [type]. Aesthetic: [direction]. Colors: primary [hex], secondary [hex], neutrals [range]. Typography: display [font], body [font]. Layout: [approach]. Show a realistic [page type] screen with [specific content for this product].>" --count 3 --output-dir "$_DESIGN_DIR/"
```

Run quality check on each successful path returned by `variants`; never include failed variants:

```bash
$D check --image "$_DESIGN_DIR/variant-A.png" --brief "<the original brief>"
```

Read JSON, not exit code: `pass: false` means regenerate addressing `issues`, then recheck. `pass: true` with an unavailable/skipped warning is missing automated coverage; disclose it and inspect visually.

**Before presenting, self-gate:** Would a human designer be embarrassed to sign each variant? If yes, discard and regenerate. Hard rejects: purple gradient hero, 3-column SaaS grid, centered-everything, overused display face, generic stock photo, system-ui, gradient CTA, bubble-radius everything. Any trigger requires regeneration.

Read each accepted PNG inline, then open the board with those paths before inviting choices/remix.

### Comparison Board + Feedback Loop

Use the successful, quality-checked paths in this example:

```bash
$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png,$_DESIGN_DIR/variant-C.png" --output "$_DESIGN_DIR/design-board.html" --serve
```

This publishes to a persistent daemon, opens the board and exits. Read captured stderr for the startup marker; a PID is not readiness. Exit 0 with `BOARD_URL` means the daemon is serving. Save its full `http://127.0.0.1:N/boards/<id>/` URL. Only legacy `--no-daemon` needs a host background task; `SERVE_STARTED: port=N` gives root URL `http://127.0.0.1:N/`.

**Wait with AskUserQuestion:** "Review <BOARD_URL>, Submit or request new variants, then tell me; or paste preferences here." The board chooses; the question waits. Do not poll.

After the response, read current feedback next to the board HTML:
- `feedback.json`: Submit (preferred/overall may be null):
```json
{"preferred":"A","ratings":{"A":4},"comments":{"A":"Good spacing"},"overall":"Go with A","regenerated":false}
```
- `feedback-pending.json`: Regenerate:
```json
{"preferred":"B","ratings":{"B":4},"comments":{},"overall":"Keep layout","regenerated":true,"regenerateAction":"more_like_B"}
```

`regenerateAction`: `different`, `match`, `more_like_<letter>` or custom text (including remix). The board uses text; it does not emit a required `remixSpec`. Honor a pasted map (`{"layout":"A","colors":"B"}`) if present; clarify missing detail.

**Board or chat:** revisions regenerate; a final choice needs summary confirmation; skip goes to Phase 6 without a mockup. Ask if no choice/detail; never infer approval from a missing file. Submit with revision notes is a revision.

**Regenerate:**
1. Revise the brief, preserving unrelated constraints. Archive this round's feedback files so old Submit cannot approve new images.
2. Run `$D variants` with the new brief (no session). Re-run the quality check and visual self-gate on every new image.
3. Rebuild: `$D compare --images "<new successful paths>" --output "$_DESIGN_DIR/design-board.html"`, without `--serve`.
4. Reload at the saved URL (keep its per-board path; legacy uses root):
   `jq -nc --arg html "$_DESIGN_DIR/design-board.html" '{html: $html}' | curl -sS -X POST "${BOARD_URL}api/reload" -H 'Content-Type: application/json' --data-binary @-`
5. Check reload succeeded, then AskUserQuestion at the same URL until a final choice, skip or stop. Failed generation/reload uses the fallback, not another wait.

**SERVER FALLBACK:** Nonzero exit or no readiness marker: show each variant inline with Read, then AskUserQuestion: "The comparison board server failed to start. Which variant? Any changes?" Route chat feedback as above.

**After receiving feedback (any path):** summarize PREFERRED, RATINGS, YOUR NOTES, DIRECTION; AskUserQuestion "Is this right?" A confirmed final choice permits Write of `$_DESIGN_DIR/approved.json` with `approved_variant`, `feedback`, `date` (UTC), `screen`, `branch`. Use valid JSON, never shell interpolation. This approves the image only; Q-final gates project writes.

After final image confirmation, `$D extract` would write DESIGN.md in a Git repo: run it only in a fresh non-repository scratch directory. Bind `$D` and `APPROVED_IMAGE` to absolute paths:

```bash
_EXTRACT_DIR=$(mktemp -d /tmp/gstack-design-extract-XXXXXXXX) || exit 1
(
  cd "$_EXTRACT_DIR" || exit 1
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "Extraction refused: scratch directory resolves to a Git repository" >&2
    exit 1
  fi
  "$D" extract --image "$APPROVED_IMAGE"
)
```

Compare extracted tokens with the approved image and verified fonts; show discrepancies at Q-final. Empty arrays, an "Unable to extract" mood or command failure → disclose fallback to Phase 3 values, never invent measured tokens.

Late visual changes return to the feedback loop: regenerate, recheck, reconfirm, then extract again. Only `generate` supplies `sessionFile` for `$D iterate --session "<returned sessionFile>" --feedback "<feedback>" --output "$_DESIGN_DIR/refined.png"`; variants must regenerate.

**Plan mode:** Carry the approved mockup paths/tokens into Phase 6's "## Proposed DESIGN.md" plan section. Its Q-final approval governs saving that content; defer the actual DESIGN.md to implementation.

### Path B: HTML Preview Page (fallback if DESIGN_NOT_AVAILABLE)

Create and open the HTML preview:

```bash
PREVIEW_FILE="/tmp/design-consultation-preview-$(date +%s).html"
```

Write the preview HTML to `$PREVIEW_FILE`, then open it:

```bash
open "$PREVIEW_FILE"
```

### Preview Page Requirements (Path B only)

Write a **single, self-contained HTML file**, no frameworks:

1. **Loads proposed fonts** via `<link>` from their step (4) verified Google Fonts/Fontshare/self-hosted source.
2. **Uses the proposed palette** throughout.
3. **Shows the product name**, not Lorem Ipsum, in the hero.
4. **Font specimen section:**
   - Each candidate in its hero/body/button/table role; compare same-role alternatives side by side using real domain content (e.g. civic tech: government data).
5. **Color palette section:**
   - Named hex swatches; primary/secondary/ghost buttons, cards, inputs, success/warning/error/info alerts; background/text contrast pairs.
6. **Realistic product mockups:** Render 2-3 Phase 1 product-type layouts with the full system, product name, domain content and proposed spacing/layout/radii:
   - **Dashboard/web app:** metrics table, sidebar nav, avatar header, stat cards.
   - **Marketing:** real-copy hero, features, testimonials, CTA.
   - **Settings/admin:** labeled inputs, toggles, dropdowns, save.
   - **Auth/onboarding:** branded login, social buttons, validation states.
7. **Light/dark toggle:** CSS custom properties plus a JS button.
8. **Clean, professional layout.**
9. **Responsive** at every width.

Show how their product feels, beyond a font/color inventory.

If `open` fails (headless environment), tell the user: *"I wrote the preview to [path] — open it in your browser to see the fonts and colors rendered."*

If the user says skip the preview, go directly to Phase 6.

---

## Phase 6: Write DESIGN.md & Confirm

Only Path A invokes `$D extract`, isolated as above. For Path B, use the approved HTML preview's CSS values. No preview: approved Phase 3 values; mark only unverified fonts pending. Retain rationale and unchanged existing decisions.

**Confirm before writing.** Prepare the contents below; show decisions and agent-selected defaults. AskUserQuestion Q-final:
- A) Approve — write DESIGN.md and CLAUDE.md; in plan mode, save Proposed DESIGN.md in the plan only
- B) Revise — return to Phase 3, then confirm again
- C) Start over — return to Phase 1

Wait. Only A permits the writes below; B/C leave project files untouched. Honor prior explicit approval of these exact writes without re-asking. Any subsequent token, font or direction change invalidates that approval: update the proposal, reverify affected fonts/preview, and ask Q-final again. A changed product brief also invalidates prior independent proposals.

**If in plan mode:** Write the DESIGN.md content into the plan file as a "## Proposed DESIGN.md" section. Do NOT write the actual file — that happens at implementation time.

**If NOT in plan mode:** apply the approved Phase 0 format choice, then write root `DESIGN.md`. New, fresh and converted files use google-labs-code/design.md format below: all tokens belong in the five normative YAML groups; prose explains rationale/use without repeating values. Preserve the line-2 format marker. A kept-legacy or unknown-format Update instead retains its own shape; persist `legacy-keep` only for the chosen legacy path. Preserve the prior file in a backup before a fresh replacement.

```markdown
---
# gstack: design-md-format=spec
name: [Project Name]
description: [one sentence: mood, material, energy]
colors:
  primary: "#..."          # descriptive slugs; hex, or the project's canonical color space
  on-primary: "#..."
  surface: "#..."
  text: "#..."
  text-muted: "#..."
  accent: "#..."
  success: "#..."
  warning: "#..."
  error: "#..."
typography:
  display:
    fontFamily: [face]
    fontWeight: [weight]
    fontSize: [clamp() or rem]
    letterSpacing: [em]
  body:
    fontFamily: [face]
    fontSize: 1rem
    lineHeight: 1.5
  label:
    fontFamily: [face]
    fontSize: 0.75rem
    letterSpacing: 0.04em
  mono:
    fontFamily: [face]
    fontFeature: tnum
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "#..."
  input:
    borderColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  nav-link:
    textColor: "{colors.text}"
---

# [Project Name]

## Overview

**Creative North Star:** [one sentence: aesthetic + why it fits these users]
**Product context:** [product, users, category/peers, project type]
**Mode per surface:** [one line each: Persuade / Operate / Read / Experience]
**Reference sites:** [URLs, if research was done]
**Key characteristics:** [3-5 bullets: first-five-second impressions]

## Colors

**Strategy:** [Restrained / Committed / Full palette / Drenched] — [why]
**Light or dark:** [decided by the use scene: who, where, under what light]
[Explain which tokens signal interaction or emphasis, how neutrals derive from the palette, and how dark-mode surfaces preserve hierarchy rather than merely inverting lightness.]

## Typography

[Faces' source world, mode/register, roles and display boundaries; loading, scale rationale, justified overused-list exceptions]

## Layout

[Breakpoint grids, max width, density, large/small spacing rhythm, intentional grid breaks]

## Elevation & Depth

[Depth: offset + soft-blur shadows, tints, borders; no zero-offset glow]

## Shapes

[Radius hierarchy/uses; nested inner radius = outer radius − gap]

## Components

[Per component: hover/focus-visible/active/disabled states, invariants and adaptations]

## Do's and Don'ts

- Do: [3-5 specific, checkable rules]
- Don't: [3-5 system-specific anti-patterns, including this category's tempting catalog entries]

## Motion

- **Approach:** [minimal-functional / intentional / expressive]
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)
- **The one authored moment:** [what it is]

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| [today] | Initial design system created | Created by /design-consultation based on [product context / research] |
```

Use real token values, no placeholders; omit invented `components` entries and unverified fontFamily values. Describe pending font roles in prose instead. Outside plan mode, after writing DESIGN.md, run `bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts check DESIGN.md`: require `DESIGN_MD_FORMAT: spec` for new/fresh/converted/spec files, `legacy` with `legacy-keep` for a kept legacy file, or the disclosed `unknown` format for a preserved unknown file. Never convert a kept file just to make validation say spec.

**Outside plan mode, update CLAUDE.md** (or create it if it doesn't exist) — append this section:

```markdown
## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
```

After shipping DESIGN.md, if the session produced screen-level mockups or page layouts
(not just system-level tokens), suggest:
"Want to see this design system as working Pretext-native HTML? Run /design-html."

---
