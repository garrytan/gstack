/**
 * The design lint's rule table: every rule id the lint can print, its tier,
 * the sloplint gate it was ported from, and its default fix. Rule modules
 * report by id; the reporter refuses an id that is not here, so the table is
 * the contract (docs/design-lint.md lists it; test/design-lint.test.ts holds
 * the two in step).
 *
 * Tiers reuse gstack's severity words, not hallmark's: Floor -> blocks (never
 * waivable), Reflex -> ask (waivable on the record), Finish -> polish (printed,
 * never blocks). Three house rules hallmark holds at Floor stay at ask here on
 * purpose: the eyebrow (a figure caption or plan name above a heading is often
 * right), the 80-word screen (a Read-mode page legitimately exceeds it) and
 * the dash (gstack's rule is overuse, not a ban). Ids that match a
 * lib/design-catalog.ts entry carry the catalog's id so Phase 2 can mark those
 * rows detect: 'lint'.
 *
 * Gate numbers refer to Nutlope/hallmark references/gates.md at 7ec8682 (MIT).
 */

export type Tier = 'blocks' | 'ask' | 'polish';

export interface RuleMeta {
  tier: Tier;
  /** The sloplint gate this rule was ported from, or `craft` for the copy tier (rules/copy.ts). */
  gate: string;
  /** One line naming the tell. */
  title: string;
  /** The default fix printed after `| fix:` when the rule gives none. */
  fix: string;
  /** Rules that only make sense on a whole page are skipped under --scope component. */
  pageOnly?: boolean;
  /** The render tier reports this rule; the static tier never does. */
  render?: boolean;
  /** An app-profile rule: only `--scope app` reports it, and `--scope app` reports nothing else (render-app.ts). */
  app?: boolean;
}

export const RULES: Record<string, RuleMeta> = {
  // ── Colour and surface ──
  'purple-blue-gradient': { tier: 'blocks', gate: '2a', title: 'purple-to-blue, purple-to-pink or cyan-on-dark gradient', fix: 'one anchor hue and solid ink' },
  'gradient-text': { tier: 'ask', gate: '2b', title: 'gradient text', fix: 'solid ink; carry emphasis with weight or a display face' },
  'pure-black-white': { tier: 'blocks', gate: '7a', title: '#000 or #fff as a colour outside the token block', fix: 'tint toward the anchor hue: chroma 0.005 or more' },
  'absolute-surface-token': { tier: 'ask', gate: '7b', title: 'a surface token that resolves to pure black or white', fix: 'tint the paper' },
  'zero-chroma-neutrals': { tier: 'ask', gate: '22', title: 'zero-chroma oklch() neutrals', fix: 'give the neutrals chroma 0.005 or more' },
  'accent-footprint': { tier: 'ask', gate: '23', title: 'accent colour past about 5% of a viewport', fix: 'retreat the accent to actions and one signal' },
  'glow-wash': { tier: 'ask', gate: '29', title: 'glow and wash: blurred orbs, a radial halo or a zero-offset coloured glow', fix: 'a solid or grained surface; elevation by lightness, shadows with offset and blur' },
  'cream-palette': { tier: 'ask', gate: '65', title: 'the cream paper, serif display and terracotta accent look', fix: 'move one axis: the accent first, the paper second, the display last', pageOnly: true },
  'framework-palette': { tier: 'ask', gate: '74', title: 'a framework default palette (Tailwind indigo-500, slate-900 and kin) as a token or utility', fix: 'a colour mixed for the page in OKLCH' },
  // ── Type ──
  'overused-font': { tier: 'ask', gate: '1', title: 'a training-data display face (Inter, Roboto, Fraunces, Playfair Display, Space Grotesk and the rest of gstack\'s catalog) or a system stack as the display', fix: 'a display face chosen for the page' },
  'banned-font': { tier: 'ask', gate: 'catalog', title: 'a face gstack bans in any role (Papyrus, Comic Sans, Impact, Lobster, Raleway, Courier New and the rest of lib/design-catalog.ts BANNED_FONTS)', fix: 'a face chosen for the page; the body face for body and labels' },
  'line-length': { tier: 'ask', gate: '25', title: 'running prose outside 45 to 75 characters a line', fix: 'max-width: 65ch', pageOnly: true },
  'font-family-count': { tier: 'ask', gate: '37', title: 'more than three font families', fix: 'display, body and one outlier' },
  'italic-word-in-heading': { tier: 'blocks', gate: '38i', title: 'one italic word inside an otherwise roman heading', fix: 'a line break, or the whole head set one way' },
  'italic-serif-display': { tier: 'ask', gate: '38ii', title: 'an italic display system', fix: 'roman display, or declare it on --font-display with font-synthesis: none' },
  'accented-word': { tier: 'ask', gate: '38iii', title: 'one word in a heading set apart by colour, weight, a highlight or an underline', fix: 'the whole head one way; a line break; a second line at a second size' },
  'caps-leading': { tier: 'blocks', gate: '55a', title: 'an uppercase display head that can wrap with line-height under 1.0', fix: 'line-height 1.0 at least (1.02 to 1.08 recommended)', pageOnly: true },
  'caps-lockup-leading': { tier: 'ask', gate: '55b', title: 'a single-line caps lockup under 1.02', fix: 'line-height 1.02, or make sure it cannot wrap at 320px', pageOnly: true },
  'monospace-costume': { tier: 'ask', gate: '64', title: 'monospace on labels, captions or small type when the content is not code', fix: 'labels in the body face, a step smaller, normal case' },
  'tiny-text': { tier: 'ask', gate: '75', title: 'running text under 12px, functional text under 11px, or prose leaded under 1.3', fix: 'body 16px at 1.5 to 1.65; labels one step smaller', render: true },
  'wide-tracking': { tier: 'blocks', gate: '67', title: 'the tracked-caps label: small text set uppercase or letter-spaced past 0.03em', fix: 'the body face, a step smaller, sentence case, untracked' },
  // ── Structure and layout ──
  'template-cards': { tier: 'ask', gate: '3', title: 'three equal icon-above-heading tiles, an icon in a rounded tile, or a thick coloured side stripe', fix: 'vary widths and heights, inline icons, hairline or no border', pageOnly: true },
  'nested-cards': { tier: 'blocks', gate: '4', title: 'a card inside a card', fix: 'one containment layer' },
  'vh-height': { tier: 'blocks', gate: '6a', title: 'a hero sized in vh', fix: 'dvh or svh' },
  'raw-spacing': { tier: 'blocks', gate: '24a', title: 'a raw padding, margin or gap length where a --space-* token exists', fix: 'the token' },
  'off-scale-spacing': { tier: 'ask', gate: '24b', title: 'spacing off the page\'s scale', fix: 'the scale; three optical nudges at most' },
  'overflow-x-unclipped': { tier: 'ask', gate: '34', title: 'overflow-x missing on html and body, or a 100vw width', fix: 'overflow-x: clip on both; width: 100%', pageOnly: true },
  'horizontal-scroll': { tier: 'blocks', gate: '34', title: 'horizontal scroll at a width between 320 and 1920', fix: 'find the element wider than its viewport and cap it', render: true, pageOnly: true },
  'hero-balance': { tier: 'ask', gate: '44a/44c', title: 'the hero\'s content sits off centre for its screen, or its visual stands apart from the text', fix: 'centre the content in its screen; put the visual beside the text', render: true, pageOnly: true },
  'hero-fold': { tier: 'blocks', gate: '44b', title: "the headline's bottom or the hero's first action below the 800px fold at 1280 wide; the lede and the visual are not measured", fix: 'pull the display clamp down, tighten leading, a two-line lede, trim padding', render: true, pageOnly: true },
  'wide-container': { tier: 'blocks', gate: '44d', title: 'at 1920x1080 the container has no max-width, gutters under 120px, or a grid gains columns', fix: 'cap 1360 to 1520px and centre; hold column counts; cap vw visuals', pageOnly: true },
  'bare-fr-track': { tier: 'blocks', gate: '50', title: 'an image-bearing grid track on bare 1fr', fix: 'minmax(0, 1fr)', pageOnly: true },
  'display-head-unwrapped': { tier: 'blocks', gate: '50', title: 'a display head without overflow-wrap: break-word and min-width: 0', fix: 'overflow-wrap: break-word; min-width: 0 (never anywhere)', pageOnly: true },
  'radio-tab-jump': { tier: 'blocks', gate: '53', title: 'CSS-only radio tabs at position: absolute; top: 0 with no JS guard', fix: 'radios in flow at zero size, or a handler with preventScroll' },
  'double-sticky': { tier: 'blocks', gate: '56', title: 'two position: sticky; top: 0 elements', fix: 'top: var(--banner-height) on the second', pageOnly: true },
  'screen-word-budget': { tier: 'ask', gate: '58', title: 'more than about 80 words in one 900px window, or a hero with more than two text blocks before its actions', fix: 'headline, one sentence, actions; a section is a head block, then its composition', pageOnly: true },
  'section-gap': { tier: 'ask', gate: '59', title: 'a gap under 120px between sections at 1440, every gap the same, or more than nine sections', fix: '120px at least, varied; six to nine sections a page', pageOnly: true, render: true },
  'heading-rhythm': { tier: 'ask', gate: '71', title: 'a heading nearer what precedes it than what it heads', fix: 'at least twice the space above a head as below it', render: true, pageOnly: true },
  'cramped-padding': { tier: 'ask', gate: '72', title: 'text closer than 8px (or half an em) to the side of its filled box', fix: 'pad the box; a 16px gutter', render: true },
  'thin-section': { tier: 'ask', gate: '77', title: 'a section below the hero with no mass: a narrow body on a wide canvas', fix: 'widen the body, add a visual, set a statement, or merge the section', render: true, pageOnly: true },
  'small-section-heads': { tier: 'ask', gate: '78', title: 'the median h2 below the hero renders under 40px at 1440', fix: 'h2 at the section size, item titles at the title size', render: true, pageOnly: true },
  'dead-band': { tier: 'ask', gate: '79', title: 'more than 160px of nothing between the hero\'s lowest content and the fold', fix: 'centre the content and grow the visual or the head; never fill with copy', render: true, pageOnly: true },
  'hand-drawn-svg': { tier: 'ask', gate: '80', title: 'an inline SVG of 120px or more with three curves or fills and no text: a drawn illustration', fix: 'a photograph, the product built, or type at scale', render: true, pageOnly: true },
  'empty-picture': { tier: 'ask', gate: '81', title: 'a slot or gradient block of 300x200px or more showing nothing but its wash', fix: 'the user\'s image, a credited photograph, or the product at full fidelity', render: true, pageOnly: true },
  'counting-marks': { tier: 'ask', gate: '82', title: '24 or more identical marks standing for a quantity', fix: 'set the number in type', render: true, pageOnly: true },
  'photo-wall': { tier: 'ask', gate: '83', title: 'photographs cover more than a third of the page below the hero', fix: 'keep the strongest pictures, set big; carry the rest in type, figures, the product, a table', render: true, pageOnly: true },
  'email-band-close': { tier: 'ask', gate: '85', title: 'the page ends on an email sign-up form on a page whose job is not subscribe, join, attend, listen or visit', fix: 'end on what the visitor came to do, or on the last strong section', pageOnly: true },
  // ── Chrome and copy ──
  'aphoristic-cadence': { tier: 'blocks', gate: '19', title: 'the rebuttal cadence three or more times ("Not a feature. A platform.")', fix: 'say what the product does, in its own nouns' },
  'generic-hero-copy': { tier: 'blocks', gate: '19', title: 'a filler opener ("Built for the modern team", "In today\'s landscape") or "quietly trusted by"', fix: 'say what the product does, in its own nouns' },
  'generic-cta-copy': { tier: 'ask', gate: '19/42', title: 'a stock second action beside the primary (Learn more, Get started, Book a demo)', fix: 'one action, or a second that names where it goes', pageOnly: true },
  'em-dash-overuse': { tier: 'ask', gate: '19', title: 'em or en dashes carrying the prose', fix: 'a comma, a colon, a full stop or a line break' },
  'template-footer-line': { tier: 'ask', gate: '19', title: 'a stock footer line (All rights reserved)', fix: 'the page\'s own line, or nothing' },
  'template-nav': { tier: 'ask', gate: '42', title: 'the reflex nav: wordmark left, inline links, a button right, hairline under', fix: 'decide the nav and build another shape, or keep it on the record', pageOnly: true },
  'template-footer': { tier: 'ask', gate: '42', title: 'the reflex footer: four link columns, a social row, a copyright', fix: 'decide the footer and build another shape, or keep it on the record', pageOnly: true },
  'invented-proof': { tier: 'blocks', gate: '46a', title: 'an invented metric, testimonial, logo wall or case-study count', fix: 'the user\'s number, a text slot, or nothing' },
  'drawn-browser-chrome': { tier: 'blocks', gate: '47a', title: 'a hand-drawn browser bar (traffic lights, URL pill) or OS window title bar', fix: 'a real screenshot in a <figure>, or no chrome' },
  'device-frame': { tier: 'ask', gate: '47b', title: 'a phone, laptop, terminal or editor frame', fix: 'one frame with real content inside, or none', pageOnly: true },
  'imitation-material': { tier: 'ask', gate: '47c', title: 'styled divs standing in for a product, a photo edge or a physical object', fix: 'the product built inside a slot, a real asset, or nothing', pageOnly: true },
  'kicker-above-heading': { tier: 'ask', gate: '54', title: 'the eyebrow: short inert type before a heading that only announces it', fix: 'open the section another way; where the heading is figurative, the label becomes the heading', pageOnly: true },
  'template-punctuation': { tier: 'blocks', gate: '63', title: 'template punctuation: middle-dot meta strings, an arrow glued to link text, decorative status dots', fix: 'line breaks, columns, hairlines; a verb as the label' },
  'wireframe-slots': { tier: 'ask', gate: '68', title: 'more than five empty slots on one page, or four or more in one row', fix: 'set the set in type; a slot that stays holds a real photo or the product', pageOnly: true },
  'repeated-fact': { tier: 'ask', gate: '69', title: 'one fact (a price, a time, a count) printed in four or more sections', fix: 'say each fact once, where it does work', pageOnly: true },
  'fake-send': { tier: 'blocks', gate: '70', title: 'a form that prints success with no request behind it', fix: 'validate, post nowhere and say so plainly until the endpoint exists' },
  // ── Motion and interaction ──
  'layout-transition': { tier: 'blocks', gate: '10a', title: 'transition: all, or animating width, height, top or left', fix: 'list the properties; transform and opacity' },
  'spacing-transition': { tier: 'ask', gate: '10b', title: 'transitioning margin or padding', fix: 'transform' },
  'hover-tells': { tier: 'ask', gate: '11', title: 'the same lift on every card, two effects on one element, an image scaling on hover, or a hover on something inert', fix: 'one signal per element, on the container, not the image' },
  'bounce-easing': { tier: 'ask', gate: '12', title: 'bounce or overshoot easing on UI state', fix: 'an exponential ease-out' },
  'focus-ring-fade': { tier: 'blocks', gate: '15', title: 'a focus ring that fades in', fix: 'instant: exclude outline and box-shadow from the transition' },
  'tooltip-focus-delay': { tier: 'blocks', gate: '17', title: 'a tooltip whose focus delay equals its hover delay', fix: 'hover 800 to 1000ms, focus 0' },
  'autorotate-no-pause': { tier: 'blocks', gate: '18', title: 'auto-rotating content with no pause on hover and focus', fix: 'pause on hover and focus; a visible pause control past 5 seconds' },
  'missing-focus-visible': { tier: 'blocks', gate: '26a', title: 'an interactive element with no :focus-visible ring, or an outline removed with nothing in its place', fix: 'a ring at 3:1 or better, instant' },
  'missing-states': { tier: 'ask', gate: '26b', title: 'no :active or :disabled state', fix: 'all the states a control can be in' },
  'missing-reduced-motion': { tier: 'blocks', gate: '27', title: 'a keyframe or transform transition without a prefers-reduced-motion fallback', fix: 'add @media (prefers-reduced-motion: reduce)' },
  'autoplay-unmuted': { tier: 'blocks', gate: '28a', title: 'a video autoplaying without muted', fix: 'autoplay muted loop playsinline', pageOnly: true },
  'lazy-lcp': { tier: 'blocks', gate: '28a', title: 'loading="lazy" on the first image or the hero video', fix: 'fetchpriority="high" on the LCP image', pageOnly: true },
  'video-without-poster': { tier: 'ask', gate: '28b', title: 'a video without poster or a priority hint', fix: 'add them', pageOnly: true },
  'input-state-shift': { tier: 'blocks', gate: '39a', title: 'input states that break: a border that changes width, a focus ring built from border, disabled by opacity alone', fix: 'constant border, outline, shared height, three disabled channels' },
  'control-height': { tier: 'ask', gate: '39b', title: 'control height outside 44 to 52px on a marketing page', fix: 'the number', pageOnly: true },
  'content-hidden-at-rest': { tier: 'blocks', gate: '62', title: 'a reveal class hiding content until JavaScript runs', fix: 'visible by default; hide only under a .js class, or animate from visible with @starting-style' },
  // ── Assets and access ──
  'emoji-decoration': { tier: 'blocks', gate: '30a', title: 'an emoji standing in for an icon', fix: 'one icon library, custom SVG, or typography' },
  'two-icon-libraries': { tier: 'ask', gate: '30b', title: 'two icon libraries on one page', fix: 'one library' },
  'unlabeled-decoration': { tier: 'blocks', gate: '33', title: 'a decorative <svg>, <canvas> or CSS-art element with neither aria-hidden="true" nor a label', fix: 'hide it or name it' },
  'broken-image': { tier: 'blocks', gate: '76', title: 'an <img> with no source or one that does not load', fix: 'the real file' },
  'stock-photo-hotlink': { tier: 'blocks', gate: '76', title: 'a stock-site photo hotlink', fix: 'the user\'s image, or a library photograph credited on the page' },
  'text-occlusion': { tier: 'blocks', gate: '73', title: 'text painted under another element', fix: 'give the text its own space, or its own surface above the cover', render: true },
  'low-contrast': { tier: 'blocks', gate: '40', title: 'text, an icon, a focus ring or a field edge under its contrast threshold', fix: 'fix the pair; body 4.5:1, large text and edges 3:1' },
  'gray-on-color': { tier: 'blocks', gate: '41', title: 'button text within a step of its fill, or grey text on a coloured surface', fix: 'the paired ink token' },
  'literal-outside-tokens': { tier: 'blocks', gate: '48', title: 'a colour or font-family literal outside the token block', fix: 'lift it into the tokens' },
  'button-label-wraps': { tier: 'blocks', gate: '49a', title: 'a button label or primary nav link that wraps', fix: 'shorten it; white-space: nowrap', pageOnly: true },
  'link-wraps': { tier: 'ask', gate: '49b', title: 'a footer link, tab or breadcrumb that wraps', fix: 'shorten it', pageOnly: true },
  // ── Finish (polish) ──
  'straight-quotes': { tier: 'polish', gate: 'F1', title: 'straight quotes in prose', fix: 'curly quotes' },
  'three-dot-ellipsis': { tier: 'polish', gate: 'F2', title: 'three dots for an ellipsis', fix: 'the ellipsis character' },
  'balanced-display-head': { tier: 'polish', gate: 'F3', title: 'a display head without text-wrap: balance', fix: 'text-wrap: balance' },
  'two-primary-buttons': { tier: 'polish', gate: 'F4', title: 'two filled primary buttons on one page, or side by side', fix: 'one filled primary; the second as a text or outline action' },
  'icon-coin': { tier: 'polish', gate: 'F5', title: 'an icon in a coloured coin', fix: 'the icon inline, bare' },
  'display-figures-tabular': { tier: 'polish', gate: 'F6', title: 'display-size figures without tabular numerals', fix: 'font-variant-numeric: tabular-nums' },
  'stamped-recipe': { tier: 'polish', gate: 'F7', title: 'one container recipe stamped on six or more selectors, or the pill radius on five or more non-controls', fix: 'vary the recipe; pills on controls, tags and badges only', pageOnly: true },
  'scroll-choreography-mix': { tier: 'polish', gate: 'F8', title: 'more than one scroll-choreography pattern', fix: 'one pattern a page', pageOnly: true },
  'fake-avatar': { tier: 'blocks', gate: 'F9', title: 'a fake-human avatar hotlink', fix: 'the user\'s people, initials, or no portrait' },
  'stock-person-photo': { tier: 'polish', gate: 'F9', title: 'a person-keyword stock photo URL', fix: 'the user\'s photograph' },
  'page-invariants': { tier: 'polish', gate: 'F15', title: 'page invariants broken: primary button style, container width, column gap or radius drifting', fix: 'one recipe for each', pageOnly: true },
  'unthemed-browser-surfaces': { tier: 'polish', gate: 'F16', title: 'no ::selection, caret-color or scrollbar-color on a page with a committed palette', fix: 'theme the browser surfaces', pageOnly: true },
  'text-sliver': { tier: 'polish', gate: 'F17', title: 'a text block squeezed into a sliver at 1440', fix: 'give the block room or merge the columns', render: true },
  'tiny-slot': { tier: 'polish', gate: 'F18', title: 'a slot rendering under 40px in either dimension', fix: 'size the slot for what it will hold', render: true },
  'font-weight-count': { tier: 'polish', gate: 'F19', title: 'more than three font weights in running use', fix: 'three weights', render: true },
  'lonely-grid-item': { tier: 'polish', gate: 'F20', title: 'a grid or wrapping row leaving one item alone on its last row', fix: 'change the count or the columns', render: true, pageOnly: true },
  'skipped-heading': { tier: 'polish', gate: 'F21', title: 'a heading level skipped', fix: 'step the levels one at a time' },
  'justified-text': { tier: 'polish', gate: 'F22', title: 'justified text without hyphens: auto', fix: 'hyphens: auto, or left-aligned' },
  'missing-lang': { tier: 'polish', gate: 'F23', title: 'a document without lang', fix: 'lang on <html>' },
  'hairline-under-shadow': { tier: 'polish', gate: 'F24', title: 'a hairline border under a wide soft shadow on one surface', fix: 'the shadow or the border, not both' },
  // ── Copy tier (rules/copy.ts, Elaya-derived). The content-realism ids sit at ask: a real customer named
  // Nexus or a supplied 50% figure is answered by a waiver that names the page (Garry, 2026-10-26, option a). ──
  'placeholder-name': { tier: 'ask', gate: 'craft', title: 'a placeholder name (John Doe)', fix: 'use a supplied name, or one that fits the product in sample data' },
  'placeholder-brand': { tier: 'ask', gate: 'craft', title: 'a placeholder brand (Acme, Nexus)', fix: 'use a supplied customer, or a fitting name in sample data' },
  'lorem': { tier: 'ask', gate: 'craft', title: 'lorem ipsum placeholder text', fix: 'write real copy' },
  'marketing-buzzword': { tier: 'ask', gate: 'craft', title: 'a marketing buzzword', fix: 'say the specific thing' },
  'round-number': { tier: 'ask', gate: 'craft', title: 'a round invented number', fix: 'use the supplied figure, or drop the claim' },
  'needs-proof': { tier: 'ask', gate: 'craft', title: 'a [Needs proof] marker left in the page', fix: 'supply the proof or remove the claim before publishing' },
  'oops': { tier: 'ask', gate: 'craft', title: '"oops" as an error message', fix: 'say what happened and what to do' },
  'scroll-listener': { tier: 'ask', gate: 'craft', title: 'a scroll event listener', fix: 'use IntersectionObserver; read scroll inside requestAnimationFrame for a scroll-linked effect' },
  'dead-link': { tier: 'ask', gate: 'craft', title: 'a dead link (href="#")', fix: 'link it, or render the control disabled' },
  'alert': { tier: 'ask', gate: 'craft', title: 'alert() for a message', fix: 'show the message inline' },
  'img-no-alt': { tier: 'blocks', gate: 'craft', title: 'an <img> without alt', fix: 'add alt text (alt="" when decorative)' },
  'missing-title': { tier: 'blocks', gate: 'craft', title: 'a document without a <title>', fix: 'add a <title>', pageOnly: true },
  'missing-meta-description': { tier: 'ask', gate: 'craft', title: 'no meta description', fix: 'add <meta name="description">', pageOnly: true },
  'missing-favicon': { tier: 'polish', gate: 'craft', title: 'a document without a favicon', fix: 'add a favicon <link rel="icon">', pageOnly: true },
  'missing-skip-link': { tier: 'ask', gate: 'craft', title: 'no skip link reaching <main>', fix: 'add a "Skip to content" link first in <body> whose #id exists on <main>', pageOnly: true },
  'missing-aria-current': { tier: 'ask', gate: 'craft', title: 'route navigation without aria-current', fix: 'mark the current nav link aria-current="page"', pageOnly: true },
  'empty-mount-node': { tier: 'ask', gate: 'craft', title: 'an empty mount node: the body has no text and a script renders it, so the lint read none of its content', fix: 'lint the rendered page: save document.documentElement.outerHTML to a file and lint that', pageOnly: true },
  // ── App profile (--scope app only; render-app.ts and render-probe-app.ts, GST-1741) ──
  'row-crowding': { tier: 'ask', gate: 'app', title: 'a list row whose text spans two or more lines sits under 8px from its row edge, or under 16px from the next row\'s text', fix: 'pad the row 8px or more top and bottom and leave 16px or more between one row\'s text and the next', render: true, app: true },
  'copy-flush-under-list': { tier: 'ask', gate: 'app', title: 'the first text block after a list starts under 12px below the list', fix: 'leave 12px or more between the list and the copy under it', render: true, app: true },
  'note-in-row-weight': { tier: 'ask', gate: 'app', title: 'a note inside a row at the name\'s weight (no icon, no surface of its own, lightness within 0.15 and size 0.9 or more of the name\'s), or a note of three lines or more at 1200px and wider', fix: 'mute the note (a lighter ink and a smaller size than the name), or give it an icon or a callout of its own', render: true, app: true },
  'small-hit-area': { tier: 'ask', gate: 'app', title: 'a control inside a list row under 32px in either dimension at a phone width (480px or less)', fix: 'make the target 32px or more (padding with a negative margin, or an inset ::before) and keep the visible glyph its size', render: true, app: true },
  'section-overflow': { tier: 'ask', gate: 'app', title: 'an element inside the measured section runs past the viewport, or a non-scrolling element overflows its own box', fix: 'let it wrap or shrink (min-width: 0, overflow-wrap: anywhere), or give it a scrolling container', render: true, app: true },
  // ── The lint's own bookkeeping ──
  'waiver': { tier: 'ask', gate: 'waiver', title: 'a waiver the lint refused', fix: 'fix the finding, or waive it with the rule id and a reason about this page' },
  'house-style': { tier: 'polish', gate: 'waiver', title: 'more than three rules waived on one page', fix: 'lock the choices into DESIGN.md so later pages inherit them instead of re-arguing them' },
  'render': { tier: 'blocks', gate: 'render', title: 'the page did not render, so its render rules did not run', fix: 'fix the page or the URL and rerun; an unrendered page is never a pass' },
  'internal-error': { tier: 'ask', gate: 'lint', title: 'a rule family threw, or a page or stylesheet could not be read, so the lint did not run on it', fix: 'report the error with the page that caused it; a page the lint could not read is not a pass' },
};


export function ruleMeta(id: string): RuleMeta | null {
  return Object.prototype.hasOwnProperty.call(RULES, id) ? RULES[id] : null;
}
