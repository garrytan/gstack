// lib/design-catalog.ts — gstack's design anti-pattern vocabulary, typed.
// Derived in part from pbakaus/impeccable (Apache-2.0), modified. See NOTICE.md.
//
// Pure module: no I/O, no imports from scripts/. bin/ and lib/ travel together
// on every host, scripts/ is never linked, so anything runtime may import this
// and nothing here may import scripts/.
//
//   lib/design-catalog.ts
//     ├─ scripts/resolvers/constants.ts          AI_SLOP_BLACKLIST: the 11 legacy lines, verbatim, in order
//     ├─ scripts/resolvers/design.ts             DESIGN_METHODOLOGY cat 9, DESIGN_HARD_RULES, DESIGN_DETECTOR
//     │                                          (handoffs), OVERUSED_FONTS, DESIGN_SLOP_BULLETS, and the
//     │                                          design-html anti-slop line (catalogEntries)
//     ├─ scripts/resolvers/design-checklist.ts   review/design-checklist.md (generated)
//     ├─ bin/gstack-design-detect.ts             normalizes engine findings by impeccableId
//     └─ design/src/brief.ts                     MOCKUP_NEVER_NAMES in the image-generation prompt
//
// Rule ids. An entry's `impeccableId` is set only when that id exists in
// test/fixtures/impeccable-antipatterns.json (test-enforced), and rendered
// prose brackets an id only in that case, so a reader never meets a bracketed
// id the detector cannot emit. Everything else is a gstack-only tell that the
// LLM pass judges. The four lists this file replaced (constants.ts, the
// consultation proposal section, design-html's blacklist, and the review
// checklist) had drifted apart; they now render from here.

export type SlopCategory =
  | 'scaffold' | 'surface' | 'type' | 'color' | 'layout'
  | 'motion' | 'copy' | 'states' | 'imagery' | 'browser-surface';
export type DetectMethod = 'engine' | 'grep' | 'render' | 'llm';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ReviewTier = 'auto-fix' | 'ask' | 'possible';
export type Impact = 'high' | 'medium' | 'polish';
export type FontRole = 'display' | 'body' | 'ui' | 'mono';
/** The `/impeccable <cmd>` commands a deferred finding may hand off to (one source for the type and the prose). */
export const HANDOFF_COMMANDS = ['typeset', 'layout', 'colorize', 'harden', 'clarify', 'polish', 'animate', 'quieter'] as const;
export type Handoff = (typeof HANDOFF_COMMANDS)[number];

export interface DesignSlopEntry {
  /** kebab-case; equals impeccableId when the detector knows the rule */
  id: string;
  /** set only when the id is in test/fixtures/impeccable-antipatterns.json */
  impeccableId?: string;
  /** short label (compact renders, mockup "Never:" line) */
  name: string;
  /** the doctrine line, gstack voice (cat 9, checklist, consultation bullets) */
  prose: string;
  category: SlopCategory;
  kind: 'slop' | 'quality';
  detect: DetectMethod[];
  /** design-checklist tier */
  confidence: Confidence;
  /** review-lite bucket */
  tier: ReviewTier;
  /** design-review triage */
  impact: Impact;
  /** grep hint rendered in design-checklist.md category 1 */
  heuristic?: string;
  /** overused-font names */
  values?: string[];
  /** roles the values are banned for; present iff values is */
  roles?: FontRole[];
  handoff?: Handoff;
  source: 'gstack' | 'impeccable' | 'both';
  /** the 11 originals; AI_SLOP_BLACKLIST derives from these verbatim */
  legacyBlacklist?: true;
  /** feeds the design binary's "Never:" prompt line */
  mockupNever?: true;
}

/** Training-data defaults: never the display voice on any surface (body/UI on Operate/Read is the one exception, FONTS_BODY_UI_OK). */
const OVERUSED_DISPLAY = [
  'Inter', 'Roboto', 'Arial', 'Helvetica', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
  'Space Grotesk', 'Space Mono', 'Fraunces', 'Playfair Display', 'Cormorant', 'Lora', 'Crimson',
  'Newsreader', 'Syne', 'IBM Plex Sans', 'IBM Plex Serif', 'DM Sans', 'DM Serif', 'Outfit',
  'Plus Jakarta Sans', 'Instrument Sans', 'Geist',
];

export const DESIGN_SLOP_CATALOG: DesignSlopEntry[] = [
  // ── The 11 legacy lines. Order and prose are load-bearing: AI_SLOP_BLACKLIST is this list. ──
  {
    id: 'ai-color-palette', impeccableId: 'ai-color-palette', name: 'Purple gradient palette',
    prose: 'Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes',
    category: 'color', kind: 'slop', detect: ['engine', 'grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Look for `linear-gradient` with values in the `#6366f1` to `#8b5cf6` range, or CSS custom properties resolving to purple/violet.',
    handoff: 'colorize', source: 'both', legacyBlacklist: true,
    mockupNever: true,
  },
  {
    id: 'feature-grid-3col', name: 'The 3-column feature grid',
    prose: '**The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.',
    category: 'scaffold', kind: 'slop', detect: ['grep', 'llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    heuristic: 'Look for a grid/flex container with exactly 3 children that each contain a circular element + heading + paragraph.',
    handoff: 'layout', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'icon-circle-decoration', name: 'Icons in colored circles',
    prose: 'Icons in colored circles as section decoration (SaaS starter template look)',
    category: 'scaffold', kind: 'slop', detect: ['grep', 'llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    heuristic: 'Look for elements with `border-radius: 50%` + a background color used as decorative containers for icons.',
    handoff: 'quieter', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'centered-everything', name: 'Centered everything',
    prose: 'Centered everything (`text-align: center` on all headings, descriptions, cards)',
    category: 'layout', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep for `text-align: center` density: if more than 60% of text containers center, flag it.',
    handoff: 'layout', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'uniform-radius', name: 'Uniform bubbly border-radius',
    prose: 'Uniform bubbly border-radius on every element (same large radius on everything)',
    category: 'surface', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Aggregate `border-radius` values: if more than 80% share one value of 16px or more, flag it. Pill radius on everything is the extreme case.',
    handoff: 'polish', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'decorative-blobs', name: 'Decorative blobs and dividers',
    prose: 'Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)',
    category: 'imagery', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'emoji-decoration', name: 'Emoji as design elements',
    prose: 'Emoji as design elements (rockets in headings, emoji as bullet points)',
    category: 'imagery', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep headings, list items, and buttons for emoji code points used as icons or bullets.',
    handoff: 'polish', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'side-tab', impeccableId: 'side-tab', name: 'Colored left-border on cards',
    prose: 'Colored left-border on cards (`border-left: 3px solid <accent>`)',
    category: 'surface', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep for `border-left: <n>px solid` on card, callout, or list-item selectors.',
    handoff: 'polish', source: 'both', legacyBlacklist: true,
  },
  {
    id: 'generic-hero-copy', name: 'Generic hero copy',
    prose: 'Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")',
    category: 'copy', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep HTML/JSX content for "Welcome to", "Unlock the power of", "Your all-in-one solution", "Revolutionize your", "Streamline your workflow".',
    handoff: 'clarify', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'cookie-cutter-rhythm', name: 'Cookie-cutter section rhythm',
    prose: 'Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'gstack', legacyBlacklist: true,
  },
  {
    id: 'system-font-primary', name: 'system-ui as the primary face',
    prose: 'system-ui or `-apple-system` as the PRIMARY display/body font — the "I gave up on typography" signal. Pick a real typeface.',
    category: 'type', kind: 'slop', detect: ['grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep `font-family` on body, headings, and base styles for `system-ui` or `-apple-system` as the first face in the stack.',
    handoff: 'typeset', source: 'gstack', legacyBlacklist: true,
  },

  // ── Slop the detector knows (ids from the registry fixture). ──
  {
    id: 'border-accent-on-rounded', impeccableId: 'border-accent-on-rounded', name: 'Border accent on a rounded card',
    prose: 'A colored edge on a rounded card: the side-tab in a costume. Signal state with a background tint, an icon, or a label.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'polish', source: 'impeccable',
  },
  {
    id: 'overused-font', impeccableId: 'overused-font', name: 'Overused display font',
    prose: 'A training-data default as the display voice means you stopped looking. As body or UI on an Operate or Read surface, several of these are fine. Say which and why.',
    category: 'type', kind: 'slop', detect: ['engine', 'grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep `font-family` for a listed face as the first face on display selectors (h1, h2, .hero, .display).',
    values: OVERUSED_DISPLAY, roles: ['display'],
    handoff: 'typeset', source: 'both',
  },
  {
    id: 'flat-type-hierarchy', impeccableId: 'flat-type-hierarchy', name: 'Flat type hierarchy',
    prose: 'Headings within a step of body size. Pick a scale and let the levels differ by more than a weight.',
    category: 'type', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'gradient-text', impeccableId: 'gradient-text', name: 'Gradient text',
    prose: 'Emphasis is weight or size. Gradient text is emphasis in a costume.',
    category: 'color', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep for `background-clip: text` next to a gradient background.',
    handoff: 'colorize', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'cream-palette', impeccableId: 'cream-palette', name: 'Cream default palette',
    prose: 'Cream ground, serif display, terracotta accent: look number one. Fine when the brief asked for it; a default when it did not.',
    category: 'color', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'colorize', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'nested-cards', impeccableId: 'nested-cards', name: 'Nested cards',
    prose: 'A card inside a card is always wrong. Cards are the lazy container; nesting them is the lazy container squared.',
    category: 'scaffold', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'monotonous-spacing', impeccableId: 'monotonous-spacing', name: 'Monotonous spacing',
    prose: 'One gap value between everything. Rhythm needs a large step and a small step, not a single beat.',
    category: 'layout', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'bounce-easing', impeccableId: 'bounce-easing', name: 'Bounce easing',
    prose: 'Overshoot and bounce curves on UI motion. Exponential ease-out from an already-visible default.',
    category: 'motion', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'polish',
    heuristic: 'Grep transitions and keyframes for cubic-bezier curves with a control point past 1, or `bounce` in animation names.',
    handoff: 'animate', source: 'impeccable',
  },
  {
    id: 'pulsing-dot', impeccableId: 'pulsing-dot', name: 'Pulsing status dot',
    prose: 'A small circle pulsing forever next to "Live" or "Online". Motion that says nothing new after the first loop.',
    category: 'motion', kind: 'slop', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    heuristic: 'Grep for infinite keyframe animations on small round elements.',
    handoff: 'animate', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'blinking-cursor', impeccableId: 'blinking-cursor', name: 'Blinking cursor effect',
    prose: 'A fake terminal cursor blinking in marketing copy. Theater, not interface.',
    category: 'motion', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'animate', source: 'impeccable',
  },
  {
    id: 'shape-assembled-illustration', impeccableId: 'shape-assembled-illustration', name: 'Shape-assembled illustration',
    prose: 'An illustration built from CSS shapes standing in for an asset. Produce the asset or ship nothing.',
    category: 'imagery', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'dark-glow', impeccableId: 'dark-glow', name: 'Dark-mode glow',
    prose: 'Glowing edges on dark surfaces: look number two. Depth has an offset; a zero-offset colored halo is decoration.',
    category: 'surface', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep `box-shadow` for a zero x/y offset with a large blur and a saturated color.',
    handoff: 'colorize', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'radial-halo', impeccableId: 'radial-halo', name: 'Radial halo',
    prose: 'A radial gradient halo behind the hero content. Look number two again.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'radial-spotlight-glow', impeccableId: 'radial-spotlight-glow', name: 'Radial spotlight glow',
    prose: 'A spotlight glow washing the top of the page. Same family as the halo.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'marquee', impeccableId: 'marquee', name: 'Logo marquee',
    prose: 'An infinitely scrolling logo strip. If the logos matter, show them still; if they do not, cut them.',
    category: 'motion', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'animate', source: 'impeccable',
  },
  {
    id: 'icon-tile-stack', impeccableId: 'icon-tile-stack', name: 'Icon tile above every heading',
    prose: 'The rounded-square icon above every heading. Try side by side, or drop the container.',
    category: 'scaffold', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'italic-serif-display', impeccableId: 'italic-serif-display', name: 'Italic serif display',
    prose: 'Look three: the italic display serif reaching for editorial credibility. Earn it with the content or set the display upright.',
    category: 'type', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'hero-eyebrow-chip', impeccableId: 'hero-eyebrow-chip', name: 'Hero eyebrow chip',
    prose: 'A pill-shaped label floating above the hero headline. The headline carries its own weight; cut the chip.',
    category: 'scaffold', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'kicker-above-heading', impeccableId: 'kicker-above-heading', name: 'Kicker above heading',
    prose: 'A kicker above a heading is the strongest default there is: the heading carries its own weight, so delete the label. If the user wants it anyway, comply and say the tradeoff once.',
    category: 'scaffold', kind: 'slop', detect: ['engine', 'grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Look for a short uppercase, tracked element immediately before an h1 or h2.',
    handoff: 'layout', source: 'impeccable',
    mockupNever: true,
  },
  {
    id: 'numbered-section-labels', impeccableId: 'numbered-section-labels', name: 'Numbered section labels',
    prose: '01 / 02 / 03 over sections, unless the sequence is information the reader needs.',
    category: 'scaffold', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'em-dash-overuse', impeccableId: 'em-dash-overuse', name: 'Em-dash overuse',
    prose: 'Em dashes in every other sentence. Advisory: a tell of generated copy, never a blocker on its own.',
    category: 'copy', kind: 'slop', detect: ['engine'], confidence: 'LOW', tier: 'possible', impact: 'polish',
    handoff: 'clarify', source: 'impeccable',
  },
  {
    id: 'marketing-buzzword', impeccableId: 'marketing-buzzword', name: 'Marketing buzzwords',
    prose: '"Seamless", "effortless", "supercharge", "streamline": words that describe nothing. Say what the product does.',
    category: 'copy', kind: 'slop', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep visible copy for seamless, effortless, supercharge, streamline, revolutionize, unlock, empower, elevate.',
    handoff: 'clarify', source: 'impeccable',
  },
  {
    id: 'aphoristic-cadence', impeccableId: 'aphoristic-cadence', name: 'Aphoristic cadence',
    prose: 'Short. Punchy. Fragments. Every sentence a slogan. Write like a person explaining something.',
    category: 'copy', kind: 'slop', detect: ['engine', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'clarify', source: 'impeccable',
  },
  {
    id: 'oversized-h1', impeccableId: 'oversized-h1', name: 'Oversized h1',
    prose: 'Display type past 6rem on a page that is not a poster. Size is not hierarchy.',
    category: 'type', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep h1 and display selectors for font-size above 6rem or 96px.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'extreme-negative-tracking', impeccableId: 'extreme-negative-tracking', name: 'Extreme negative tracking',
    prose: 'Letter-spacing below -0.04em on display type. Tight tracking is a taste; crushed tracking is a tell.',
    category: 'type', kind: 'slop', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'polish',
    heuristic: 'Grep `letter-spacing` for values below -0.04em.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'gpt-thin-border-wide-shadow', impeccableId: 'gpt-thin-border-wide-shadow', name: 'Thin border plus wide shadow',
    prose: 'A hairline border and a wide soft shadow on the same card. Pick one way to lift the surface.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'polish', source: 'impeccable',
  },
  {
    id: 'repeating-stripes-gradient', impeccableId: 'repeating-stripes-gradient', name: 'Repeating stripes gradient',
    prose: 'Diagonal stripe gradients as background texture. Texture from the brand or none.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'codex-grid-background', impeccableId: 'codex-grid-background', name: 'Grid-paper background',
    prose: 'A faint grid behind the hero. The blueprint look every generated dev tool ships.',
    category: 'surface', kind: 'slop', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'theater-slop-phrase', impeccableId: 'theater-slop-phrase', name: 'Theater phrases',
    prose: '"Built for the way you work", "Designed for teams like yours", "Meet your new...": phrases that perform a launch instead of describing one.',
    category: 'copy', kind: 'slop', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep copy for "built for", "designed for", "meet your new", "ship faster", "the future of".',
    handoff: 'clarify', source: 'impeccable',
  },
  {
    id: 'image-hover-transform', impeccableId: 'image-hover-transform', name: 'Image hover zoom',
    prose: 'Scaling an image on hover. Motion with no information in it.',
    category: 'motion', kind: 'slop', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    heuristic: 'Grep `:hover` rules on images for `transform: scale`.',
    handoff: 'animate', source: 'impeccable',
  },

  // ── gstack-only slop tells: the LLM pass judges these; no detector id, so no brackets. ──
  {
    id: 'gradient-cta', name: 'Gradient CTA button',
    prose: 'Gradient buttons as the primary call to action. One solid color the palette owns.',
    category: 'color', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep button and CTA selectors for gradient backgrounds.',
    handoff: 'colorize', source: 'gstack',
  },
  {
    id: 'stock-photo-hero', name: 'Stock-photo hero',
    prose: 'A generic stock-photo hero, or a gray placeholder div standing in for one. Show the product or show nothing.',
    category: 'imagery', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'gstack',
  },
  {
    id: 'card-default-component', name: 'Cards as the default component',
    prose: 'Rounded cards with drop shadows as the container for everything. App UI made of stacked cards is not layout.',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'gstack',
  },
  {
    id: 'generic-testimonials', name: 'Generic testimonial section',
    prose: 'A testimonial row with avatars, five stars, and quotes nobody said. Real names with real claims, or cut it.',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'clarify', source: 'gstack',
  },
  {
    id: 'split-hero-template', name: 'Left-text right-image hero',
    prose: 'The cookie-cutter hero: headline left, screenshot right, two buttons. The first template every generator reaches for.',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'gstack',
  },
  {
    id: 'generic-cta-copy', name: 'Generic CTA labels',
    prose: '"Get Started" and "Learn More" as the only calls to action. Name the outcome the click buys.',
    category: 'copy', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep buttons and links for "Get Started" and "Learn More" with no more specific CTA on the page.',
    handoff: 'clarify', source: 'gstack',
  },
  {
    id: 'hero-metrics', name: 'Hero metric template',
    prose: 'Three big numbers with tiny labels under the hero ("10k+ users", "99.9%"). The template counts, not the product.',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'clarify', source: 'gstack',
    mockupNever: true,
  },
  {
    id: 'identical-cards', name: 'Identical card grids',
    prose: 'A grid of cards with the same shape, the same icon slot, the same two lines. Content of unequal weight given equal boxes.',
    category: 'scaffold', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'gstack',
    mockupNever: true,
  },
  {
    id: 'glassmorphism', name: 'Glassmorphism',
    prose: 'Frosted-glass panels with blurred backdrops as the default surface. One translucent layer where it explains depth, not everywhere.',
    category: 'surface', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Grep for `backdrop-filter: blur` on more than one container.',
    handoff: 'quieter', source: 'gstack',
  },
  {
    id: 'hand-drawn-svg', name: 'Hand-drawn SVG illustration',
    prose: 'Generated SVG doodles and mascots in place of art direction. Commission or license an asset, or ship none.',
    category: 'imagery', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'gstack',
  },
  {
    id: 'modal-by-default', name: 'Modal by default',
    prose: 'Every secondary action in a modal. Inline, a side panel, or a new page usually costs the user less.',
    category: 'states', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'harden', source: 'gstack',
  },
  {
    id: 'monospace-costume', name: 'Monospace as costume',
    prose: 'Monospace on labels and body copy to look technical. Mono is for code and data columns.',
    category: 'type', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    heuristic: 'Grep `font-family` for a monospace stack on non-code, non-tabular selectors.',
    handoff: 'typeset', source: 'gstack',
  },
  {
    id: 'content-stand-ins', name: 'Content stand-ins',
    prose: 'Sparklines, progress rings, and fake avatars filling space where content should be. Real data or an honest empty state.',
    category: 'imagery', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'harden', source: 'gstack',
  },
  {
    id: 'mode-by-category', name: 'Mode picked by category',
    prose: 'Dark because it is a dev tool, light because it is health. Light or dark comes from the use scene: who, where, under what light.',
    category: 'color', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'medium',
    handoff: 'colorize', source: 'gstack',
  },
  {
    id: 'unthemed-browser-surfaces', name: 'Unthemed browser surfaces',
    prose: 'Selection color, caret, scrollbars, focus rings, underline offset, tabular numerals left at browser defaults. Theme them from the palette.',
    category: 'browser-surface', kind: 'slop', detect: ['grep', 'llm'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    heuristic: 'Grep for `::selection`, `caret-color`, `accent-color`, `scrollbar-color`, `text-underline-offset`, `font-variant-numeric`: none present means none themed.',
    handoff: 'polish', source: 'gstack',
  },
  {
    id: 'missing-states', name: 'Missing states',
    prose: 'Only the happy path is designed. Empty, loading, error, and long-content states are part of the component.',
    category: 'states', kind: 'slop', detect: ['llm'], confidence: 'LOW', tier: 'ask', impact: 'high',
    handoff: 'harden', source: 'gstack',
  },

  // ── Quality rules the detector knows. ──
  {
    id: 'organic-clip-path', impeccableId: 'organic-clip-path', name: 'Organic clip-path',
    prose: 'A polygon clip-path approximating a photo edge or a blob. An asset with its own edge, or a rectangle.',
    category: 'imagery', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'buried-raster', impeccableId: 'buried-raster', name: 'Buried raster',
    prose: 'A photo under a near-opaque wash. If the image cannot be seen, it is not doing anything.',
    category: 'imagery', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'quieter', source: 'impeccable',
  },
  {
    id: 'broken-image', impeccableId: 'broken-image', name: 'Broken image',
    prose: 'An image that fails to load. Nothing on the page is more visible.',
    category: 'imagery', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'harden', source: 'impeccable',
  },
  {
    id: 'script-error', impeccableId: 'script-error', name: 'Script error',
    prose: 'A JavaScript error in the console on load. The page is not finished.',
    category: 'states', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'harden', source: 'impeccable',
  },
  {
    id: 'content-hidden-at-rest', impeccableId: 'content-hidden-at-rest', name: 'Content hidden at rest',
    prose: 'Content at opacity 0 waiting for a scroll animation that may never fire. Content is visible by default.',
    category: 'motion', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'animate', source: 'impeccable',
  },
  {
    id: 'edge-flush-cards', impeccableId: 'edge-flush-cards', name: 'Edge-flush cards',
    prose: 'Cards touching the viewport edge. Give the layout a gutter.',
    category: 'layout', kind: 'quality', detect: ['engine', 'render'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'text-occlusion', impeccableId: 'text-occlusion', name: 'Text occlusion',
    prose: 'Text covered by another element. Overlap is a bug until it is a choice.',
    category: 'layout', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'harden', source: 'impeccable',
  },
  {
    id: 'first-viewport-column-overflow', impeccableId: 'first-viewport-column-overflow', name: 'First-viewport overflow',
    prose: 'A column wider than the first viewport. Horizontal scroll on arrival.',
    category: 'layout', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'gray-on-color', impeccableId: 'gray-on-color', name: 'Gray text on a colored surface',
    prose: 'Secondary text on a colored surface is tinted from that hue. Never gray.',
    category: 'color', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'colorize', source: 'impeccable',
  },
  {
    id: 'low-contrast', impeccableId: 'low-contrast', name: 'Low contrast text',
    prose: 'Text below WCAG AA contrast (4.5:1 body, 3:1 large). Fix the pair, not the opacity.',
    category: 'color', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'colorize', source: 'impeccable',
  },
  {
    id: 'layout-transition', impeccableId: 'layout-transition', name: 'Layout-property transition',
    prose: '`transition: all`, or transitions on width, height, top, left. Animate transform and opacity.',
    category: 'motion', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'auto-fix', impact: 'polish',
    heuristic: 'Grep `transition` for `all` or layout properties.',
    handoff: 'animate', source: 'impeccable',
  },
  {
    id: 'line-length', impeccableId: 'line-length', name: 'Line length',
    prose: 'Body measure outside 45 to 75 characters. Set a max-width on the text column.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    heuristic: 'Check for `max-width` on body text wrappers.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'cramped-padding', impeccableId: 'cramped-padding', name: 'Cramped padding',
    prose: 'Padding under 8px on text containers. Text needs room to breathe.',
    category: 'layout', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'body-text-viewport-edge', impeccableId: 'body-text-viewport-edge', name: 'Body text at the viewport edge',
    prose: 'Body text within a few pixels of the viewport edge on small screens.',
    category: 'layout', kind: 'quality', detect: ['engine', 'render'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'layout', source: 'impeccable',
  },
  {
    id: 'tight-leading', impeccableId: 'tight-leading', name: 'Tight leading',
    prose: 'Body line-height under 1.4. Display type can run tight; paragraphs cannot.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Grep body and paragraph `line-height` for values below 1.4.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'skipped-heading', impeccableId: 'skipped-heading', name: 'Skipped heading level',
    prose: 'h1 followed by h3 with no h2. Screen readers walk the hierarchy.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    heuristic: 'Check HTML/JSX for heading tags that skip a level within a file or component.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'heading-rhythm', impeccableId: 'heading-rhythm', name: 'Heading rhythm',
    prose: 'More space above a heading than below it. Read the computed values.',
    category: 'type', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'justified-text', impeccableId: 'justified-text', name: 'Justified text',
    prose: 'Justified body text on the web leaves rivers. Left-align.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'auto-fix', impact: 'polish',
    heuristic: 'Grep for `text-align: justify`.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'tiny-text', impeccableId: 'tiny-text', name: 'Tiny text',
    prose: 'Body text under 16px. Bump to 16px.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'auto-fix', impact: 'medium',
    heuristic: 'Grep `font-size` on body, p, and base styles for values under 16px (1rem at a 16px base).',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'undersized-ui-text', impeccableId: 'undersized-ui-text', name: 'Undersized UI text',
    prose: 'Labels and controls under 12px. Nobody reads 10px.',
    category: 'type', kind: 'quality', detect: ['engine'], confidence: 'HIGH', tier: 'ask', impact: 'medium',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'all-caps-body', impeccableId: 'all-caps-body', name: 'All-caps body text',
    prose: 'Uppercase paragraphs. Caps are for short labels.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'HIGH', tier: 'auto-fix', impact: 'medium',
    heuristic: 'Grep `text-transform: uppercase` on body and paragraph selectors.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'wide-tracking', impeccableId: 'wide-tracking', name: 'Wide tracking on body',
    prose: 'Letter-spacing above 0.05em on body text. Tracked type is for small-caps labels.',
    category: 'type', kind: 'quality', detect: ['engine', 'grep'], confidence: 'MEDIUM', tier: 'ask', impact: 'polish',
    heuristic: 'Grep body `letter-spacing` for values above 0.05em.',
    handoff: 'typeset', source: 'impeccable',
  },
  {
    id: 'text-overflow', impeccableId: 'text-overflow', name: 'Text overflow',
    prose: 'Text spilling out of its container. Long content is the normal case.',
    category: 'states', kind: 'quality', detect: ['engine', 'render'], confidence: 'HIGH', tier: 'ask', impact: 'high',
    handoff: 'harden', source: 'impeccable',
  },
  {
    id: 'repeated-container-text', impeccableId: 'repeated-container-text', name: 'Repeated container text',
    prose: 'The same text repeated across sibling containers. Placeholder content that shipped.',
    category: 'copy', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'clarify', source: 'impeccable',
  },
  {
    id: 'clipped-overflow-container', impeccableId: 'clipped-overflow-container', name: 'Clipped overflow',
    prose: 'A container clipping its own content with overflow hidden. Something is cut off.',
    category: 'states', kind: 'quality', detect: ['engine', 'render'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'harden', source: 'impeccable',
  },
  {
    id: 'design-system-font', impeccableId: 'design-system-font', name: 'Off-system font',
    prose: 'A face DESIGN.md tokens do not name. Add the token or use one that exists.',
    category: 'type', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'polish', source: 'impeccable',
  },
  {
    id: 'design-system-color', impeccableId: 'design-system-color', name: 'Off-system color',
    prose: 'A color DESIGN.md tokens do not name. Add the token or use one that exists.',
    category: 'color', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'polish', source: 'impeccable',
  },
  {
    id: 'design-system-radius', impeccableId: 'design-system-radius', name: 'Off-system radius',
    prose: 'A radius DESIGN.md tokens do not name. Add the token or use one that exists.',
    category: 'surface', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'polish', source: 'impeccable',
  },
  {
    id: 'design-system-font-size', impeccableId: 'design-system-font-size', name: 'Off-system font size',
    prose: 'A font size DESIGN.md tokens do not name. Add the token or use one on the scale.',
    category: 'type', kind: 'quality', detect: ['engine'], confidence: 'MEDIUM', tier: 'ask', impact: 'medium',
    handoff: 'polish', source: 'impeccable',
  },
];

// ── Mockup prompt ──

/**
 * Plain-English names of the entries flagged `mockupNever`, deduped: the design
 * binary appends "Never: <names>." to every image-generation prompt
 * (design/src/brief.ts) so mockups stop reaching for these before the
 * comparison board opens. Exactly ten ids carry the flag (test-enforced).
 */
export const MOCKUP_NEVER_NAMES: readonly string[] = [
  ...new Set(DESIGN_SLOP_CATALOG.filter(e => e.mockupNever).map(e => e.name)),
];

// ── Fonts ──

/** Never the display voice; the detector flags several as `overused-font`. */
export const OVERUSED_FONTS_DISPLAY: readonly string[] = OVERUSED_DISPLAY;

/** Never, in any role. */
export const BANNED_FONTS: readonly string[] = [
  'Papyrus', 'Comic Sans', 'Lobster', 'Impact', 'Jokerman', 'Bleeding Cowboys', 'Permanent Marker',
  'Bradley Hand', 'Brush Script', 'Hobo', 'Trajan', 'Raleway', 'Clash Display', 'Courier New',
];

/** On the overused list, yet fine as body or UI on an Operate or Read surface when the proposal says so. */
export const FONTS_BODY_UI_OK: readonly string[] = ['DM Sans', 'Instrument Sans', 'IBM Plex Sans'];

/** Mono for data and code. */
export const FONTS_MONO_OK: readonly string[] = ['JetBrains Mono', 'IBM Plex Mono', 'Fira Code'];

/**
 * Freely available faces on no default list. Availability was verified at the
 * last edit of this constant; a proposal re-verifies in-session before naming one.
 */
export const FONTS_VERIFIED_FREE = {
  verified: '2026-09-08',
  fontshare: ['Satoshi', 'General Sans', 'Clash Grotesk', 'Cabinet Grotesk'],
  googleFonts: ['Instrument Serif', 'Source Sans 3', 'JetBrains Mono', 'Fira Code'],
} as const;

// ── Lookups ──

const BY_ID = new Map(DESIGN_SLOP_CATALOG.map(e => [e.id, e]));
const BY_IMPECCABLE_ID = new Map(
  DESIGN_SLOP_CATALOG.filter(e => e.impeccableId).map(e => [e.impeccableId as string, e]),
);

export function catalogEntry(id: string): DesignSlopEntry | undefined {
  return BY_ID.get(id);
}

/** The catalog entry for a detector rule id, or undefined when the id is unmapped. */
export function entryForImpeccableId(impeccableId: string): DesignSlopEntry | undefined {
  return BY_IMPECCABLE_ID.get(impeccableId);
}

// ── Rendering ──

export interface RenderCatalogOptions {
  kind?: 'slop' | 'quality';
  /** drop entries whose impact is in this list (e.g. ['polish'] for a shorter list) */
  omitImpact?: Impact[];
}

export function selectCatalog(o: RenderCatalogOptions): DesignSlopEntry[] {
  return DESIGN_SLOP_CATALOG.filter(e =>
    (!o.kind || e.kind === o.kind)
    && !(o.omitImpact && o.omitImpact.includes(e.impact)),
  );
}

/** `- prose` bullets, no ids: the register the proposal skills render (design-consultation, design-shotgun). */
export function renderCatalog(o: RenderCatalogOptions): string {
  return selectCatalog(o).map(e => `- ${e.prose}`).join('\n');
}

/** Slop the detector knows, minus the 11 legacy lines: what design doctrine renders as bracketed ids. */
export function detectorSlopEntries(o: { omitPolish?: boolean } = {}): DesignSlopEntry[] {
  return DESIGN_SLOP_CATALOG.filter(e => e.kind === 'slop' && e.impeccableId && !e.legacyBlacklist && !(o.omitPolish && e.impact === 'polish'));
}

/** gstack-only slop tells (no detector rule), minus the legacy lines: the LLM pass is the detector. */
export function judgmentTellEntries(o: { omitPolish?: boolean } = {}): DesignSlopEntry[] {
  return DESIGN_SLOP_CATALOG.filter(e => e.kind === 'slop' && !e.impeccableId && !e.legacyBlacklist && !(o.omitPolish && e.impact === 'polish'));
}

/** Catalog entries by id, throwing with the id when one is missing (a rename must fail loudly at gen time). */
export function catalogEntries(ids: string[]): DesignSlopEntry[] {
  return ids.map(id => {
    const e = BY_ID.get(id);
    if (!e) throw new Error(`lib/design-catalog.ts: no entry with id "${id}"`);
    return e;
  });
}
