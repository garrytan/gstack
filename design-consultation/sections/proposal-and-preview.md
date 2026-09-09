<!-- AUTO-GENERATED from proposal-and-preview.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
<!-- The font-selection procedure and the three-looks calibration in this section are derived from pbakaus/impeccable reference/new-work.md (Apache-2.0), rewritten and modified. See NOTICE.md. -->
## Phase 3: The Complete Proposal

Propose the complete design system as one coherent package.

**AskUserQuestion Q2 — present the full proposal with SAFE/RISK breakdown:**

```
Based on [product context] and [research findings / my design knowledge]:

AESTHETIC: [direction] — [one-line rationale]
DECORATION: [level] — [why this pairs with the aesthetic]
LAYOUT: [approach] — [why this fits the product type]
COLOR: [approach] + proposed palette (hex values) — [rationale]
TYPOGRAPHY: [3 font recommendations with roles] — [why these fonts]
SPACING: [base unit + density] — [rationale]
MOTION: [approach] — [rationale]

This system is coherent because [explain how choices reinforce each other].

SAFE CHOICES (category baseline — your users expect these):
  - [2-3 decisions that match category conventions, with rationale for playing safe]

RISKS (where your product gets its own face):
  - [2-3 deliberate departures from convention]
  - For each risk: what it is, why it works, what you gain, what it costs

The safe choices keep you literate in your category. The risks are where
your product becomes memorable. Which risks appeal to you? Want to see
different ones? Or adjust anything else?
```

Coherence alone can look generic. Propose at least 2 creative risks—type, accent, spacing, layout or motion—with rationale, benefit and cost alongside the category's safe choices.

**Options:** A) Looks great — generate the preview page. B) I want to adjust [section]. C) I want different risks — show me wilder options. D) Start over with a different direction. E) Skip the preview, just write DESIGN.md.

### Your Design Knowledge (use to inform proposals — do NOT display as tables)

**Calibration: the three looks.** Avoid defaults: (1) cream, high-contrast serif, terracotta/signal-red; (2) near-black, neon, glowing edges; (3) broadsheet hairlines, italic serif, tiny tracked mono. An explicit brief permits them. With an open brief, if the category—or its obvious opposite—predicts the look, start over. Books alone do not justify cream/serif; jackets and cloth span saturated colors.

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

**Choosing faces: a procedure, not a menu.** (1) Name the audience's world—publication, notation, identity or familiar object—in the mode's register. (2) Shortlist three faces for each display/body/label/mono role. (3) Apply that role's exclusions. (4) Verify availability this session via WebSearch/Aside on Google Fonts/Fontshare, or the self-hosted license; omit unverified faces. (5) Name each face's loading strategy.

**Overused as display** (never the display voice, on any surface; the body/UI exception below is the only one; the detector flags several as `overused-font`): Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Space Mono, Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, IBM Plex Sans, IBM Plex Serif, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans, Geist.

**Fine as body/UI on an Operate or Read surface when the proposal says so:** DM Sans, Instrument Sans, IBM Plex Sans. **Mono for data and code:** JetBrains Mono, IBM Plex Mono, Fira Code.

**Banned in any role:** Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Raleway, Clash Display, Courier New.

**Freely available faces on no default list** (verified 2026-09-08; re-verify in-session before naming one): Satoshi, General Sans, Clash Grotesk, Cabinet Grotesk (Fontshare); Instrument Serif, Source Sans 3, JetBrains Mono, Fira Code (Google Fonts). Short on purpose. A long list of "good" fonts is how the last convergence happened.

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

---

## Phase 4: Drill-downs (only if user requests adjustments)

Use one focused AskUserQuestion per requested drill-down: **Fonts:** 3-5 candidates, rationale/evocation and preview offer; **Colors:** 2-3 hex palettes and color theory; **Aesthetic:** product-fit directions and why; **Layout/Spacing/Motion:** concrete product-specific tradeoffs. Re-check coherence after each decision.

---

## Phase 5: Design System Preview (default ON)

Preview the proposed system using the available path.

### Path A: AI Mockups (if DESIGN_READY)

Generate AI mockups applying the proposed system to realistic product screens.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
_DESIGN_DIR="$HOME/.gstack/projects/$SLUG/designs/design-system-$(date +%Y%m%d)"
mkdir -p "$_DESIGN_DIR"
echo "DESIGN_DIR: $_DESIGN_DIR"
```

Brief: Phase 3 aesthetic/colors/type/spacing/layout plus Phase 1 product context:

```bash
$D variants --brief "<product name: [name]. Product type: [type]. Aesthetic: [direction]. Colors: primary [hex], secondary [hex], neutrals [range]. Typography: display [font], body [font]. Layout: [approach]. Show a realistic [page type] screen with [specific content for this product].>" --count 3 --output-dir "$_DESIGN_DIR/"
```

Run quality check on each variant:

```bash
$D check --image "$_DESIGN_DIR/variant-A.png" --brief "<the original brief>"
```

Show each variant inline (Read tool on each PNG) for instant preview.

**Before presenting, self-gate:** Would a human designer be embarrassed to sign each variant? If yes, discard and regenerate. Hard rejects: purple gradient hero, 3-column SaaS grid, centered-everything, overused display face, generic stock photo, system-ui, gradient CTA, bubble-radius everything. Any trigger requires regeneration.

Tell the user the 3 product-screen directions are in the opened comparison board; choose a favorite or remix elements.

### Comparison Board + Feedback Loop

Create the comparison board and serve it over HTTP:

```bash
$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png,$_DESIGN_DIR/variant-C.png" --output "$_DESIGN_DIR/design-board.html" --serve
```

This command generates the board HTML, starts an HTTP server on a random port,
and opens it in the user's default browser. **Run it in the background** with `&`
because the server needs to stay running while the user interacts with the board.

Parse the board URL from stderr output. Default daemon path:
`BOARD_URL: http://127.0.0.1:N/boards/<id>/` (already includes the per-board
path; use this for the AskUserQuestion URL AND as the base for the reload
endpoint). Legacy `--no-daemon` path emits `SERVE_STARTED: port=XXXXX` and
serves a single board at `/`, with reload at `/api/reload` — only relevant
when an external caller explicitly passes `--no-daemon`.

**PRIMARY WAIT: AskUserQuestion with board URL**

After the board is serving, use AskUserQuestion to wait for the user. Include the
board URL so they can click it if they lost the browser tab:

"I've opened a comparison board with the design variants:
<BOARD_URL> — Rate them, leave comments, remix
elements you like, and click Submit when you're done. Let me know when you've
submitted your feedback (or paste your preferences here). If you clicked
Regenerate or Remix on the board, tell me and I'll generate new variants."

Substitute `<BOARD_URL>` with the URL parsed from stderr (the daemon path
emits `BOARD_URL: http://127.0.0.1:N/boards/<id>/`).

**Do NOT use AskUserQuestion to ask which variant the user prefers.** The comparison
board IS the chooser. AskUserQuestion is just the blocking wait mechanism.

**After the user responds to AskUserQuestion:**

Check for feedback files next to the board HTML:
- `$_DESIGN_DIR/feedback.json` — written when user clicks Submit (final choice)
- `$_DESIGN_DIR/feedback-pending.json` — written when user clicks Regenerate/Remix/More Like This

```bash
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
```

The feedback JSON has this shape:
```json
{
  "preferred": "A",
  "ratings": { "A": 4, "B": 3, "C": 2 },
  "comments": { "A": "Love the spacing" },
  "overall": "Go with A, bigger CTA",
  "regenerated": false
}
```

**If `feedback.json` found:** The user clicked Submit on the board.
Read `preferred`, `ratings`, `comments`, `overall` from the JSON. Proceed with
the approved variant.

**If `feedback-pending.json` found:** The user clicked Regenerate/Remix on the board.
1. Read `regenerateAction` from the JSON (`"different"`, `"match"`, `"more_like_B"`,
   `"remix"`, or custom text)
2. If `regenerateAction` is `"remix"`, read `remixSpec` (e.g. `{"layout":"A","colors":"B"}`)
3. Generate new variants with `$D iterate` or `$D variants` using updated brief
4. Create new board: `$D compare --images "..." --output "$_DESIGN_DIR/design-board.html"`
5. Reload the board in the user's browser (same tab) — the URL is per-board
   under daemon mode, so use `<BOARD_URL>` (from the `BOARD_URL:` stderr
   line) as the base:
   `curl -s -X POST "${BOARD_URL}api/reload" -H 'Content-Type: application/json' -d '{"html":"$_DESIGN_DIR/design-board.html"}'`
   Under `--no-daemon` the reload endpoint is `/api/reload` at the legacy
   port; this path only matters if the caller explicitly opted out of the
   daemon.
6. The board auto-refreshes. **AskUserQuestion again** with the same board URL to
   wait for the next round of feedback. Repeat until `feedback.json` appears.

**If `NO_FEEDBACK_FILE`:** The user typed their preferences directly in the
AskUserQuestion response instead of using the board. Use their text response
as the feedback.

**POLLING FALLBACK:** Only use polling if `$D serve` fails (no port available).
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
```bash
echo '{"approved_variant":"<V>","feedback":"<FB>","date":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","screen":"<SCREEN>","branch":"'$(git branch --show-current 2>/dev/null)'"}' > "$_DESIGN_DIR/approved.json"
```

After the user picks a direction:

- `$D extract --image "$_DESIGN_DIR/variant-<CHOSEN>.png"`: Phase 6 color/type/spacing tokens come from the approved visual, not text alone.
- Further iteration: `$D iterate --feedback "<user's feedback>" --output "$_DESIGN_DIR/refined.png"`

**Plan mode vs. implementation mode:**
- **Plan mode:** Put the full approved mockup path and extracted tokens under "## Approved Design Direction" in the plan; write DESIGN.md at implementation.
- **Otherwise:** Phase 6 writes DESIGN.md with those tokens.

### Path B: HTML Preview Page (fallback if DESIGN_NOT_AVAILABLE)

Generate a beautiful HTML preview and open it in the user's browser.

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

Phase 5 `$D extract` tokens are authoritative color/type/spacing values from the approved mockup; merge them with the Phase 3 rationale and context.

**If in plan mode:** Write the DESIGN.md content into the plan file as a "## Proposed DESIGN.md" section. Do NOT write the actual file — that happens at implementation time.

**If NOT in plan mode:** Write root `DESIGN.md` in google-labs-code/design.md format. All tokens belong in the five normative YAML groups below; prose explains rationale/use without repeating values. Preserve the line-2 format marker to prevent conversion re-asks. A Phase 0 kept-legacy file instead retains its own shape.

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
Named rules: [interaction/emphasis tokens, neutral derivation, dark-mode surface redesign—not lightness inversion]

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

Use real token values, no placeholders; omit invented `components` entries. Require `bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-md.ts check DESIGN.md` to print `DESIGN_MD_FORMAT: spec`.

**Update CLAUDE.md** (or create it if it doesn't exist) — append this section:

```markdown
## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
```

**AskUserQuestion Q-final — show summary and confirm:**

List all decisions. Flag any that used agent defaults without explicit user confirmation (the user should know what they're shipping). Options:
- A) Ship it — write DESIGN.md and CLAUDE.md
- B) I want to change something (specify what)
- C) Start over

After shipping DESIGN.md, if the session produced screen-level mockups or page layouts
(not just system-level tokens), suggest:
"Want to see this design system as working Pretext-native HTML? Run /design-html."

---
