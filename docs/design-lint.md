# design-lint: the free, deterministic design check

`bin/gstack-design-lint` reads a page (or a directory of pages, stylesheets
and components) and prints every machine-checkable design tell it finds, with
a file and line, in under a second. With `--render` it also measures the page
in gstack's own browser: the fold, the word budget per screen, contrast
against the painted pixels, focus rings by tabbing, crowded headings, text
painted under other elements, the share of the page that is photographs.
Nothing is installed and nothing is paid for: the static tier is TypeScript
over the files, and the render tier drives the same engine `gstack-render`
picks (Aside when it is running, otherwise the browse daemon `./setup` built).

The rules are ported from [Nutlope/hallmark](https://github.com/Nutlope/hallmark)'s
`sloplint` (MIT; see NOTICE.md and licenses/MIT-hallmark.txt), rewritten in
gstack's voice and mapped onto gstack's severity words. The copy tier is
the content-realism and ship-floor check adapted from Elaya's design skills
(MIT; see NOTICE.md), each tell at its line. /design-html runs the lint on
every finalized page and /design-review on each audited page.

## Usage

```
gstack-design-lint <file-or-dir ...> [--render] [--url <http://…>] [--scope page|component] [--job <job>] [--json] [--rules]
gstack-design-lint --scope app (--url <http://…> ... | --state-file <states.json>) --within <selector> [--viewport WxH ...] [--wait-for <selector>] [--waivers <file>] [--json] [--verbose]
```

The second form is the render-only app profile; see
[App profile](#app-profile---scope-app).

- Reads `.html`, `.css`, `.jsx`, `.tsx`, `.vue`, `.svelte` and `.astro`.
  Tailwind class strings in components are read too, including `cn()`,
  `clsx()`, `cva()` and their kin. `node_modules`, dot folders and build
  output below the top level are skipped; a symlink is followed once and lint
  roots and the working directory are read through their real paths; a file
  over 2 MB is a bundle, not a page, and is skipped with a warning on stderr.
  A page or stylesheet the lint skipped (over the cap, unreadable,
  unparseable; a linked sheet or an inline `<style>` block included) is also
  one `internal-error` finding at ask, so a page whose CSS the lint could not
  read is not a pass; only a linked stylesheet that does not exist is warned
  about and otherwise ignored (its tokens are simply absent). A
  relative stylesheet href may not climb out of the project (the nearest
  directory holding a `package.json` or `.git`), by its path and by its real
  path, so a symlink inside the project that points outside it is not read
  either; outside any project it is bounded by the working directory the
  lint runs in, and only `.css`
  files are read.
- Markup inside an HTML comment is dead for every rule, a commented-out
  `<style>` or `<script>` included; a comment that never closes runs to the
  end of the file, as it does in the browser. A tag start with no `>` (a stray
  `<img `) and any `<` that starts no tag (`<1`, `a < b`) are read as text
  and dropped from the markup, so a page whose tail is ten thousand of them
  costs its length; a `<!doctype>` or `<?xml?>` declaration stays. A tree nests at most 512 elements deep
  (the browser's own cap); a start tag deeper than that is read as empty. An
  open heading is closed by the next heading start tag, an open `<p>` by the
  next block start, and a repeated `<li>`, `<button>`, `<a>`, `<label>`,
  `<select>`, `<form>` or table cell by its next start tag, as the browser
  does, so a page of unclosed elements costs its length to lint. A nested
  CSS selector is expanded against its parent (`&` replaced, a bare selector
  descendant-joined) up to 8192 characters, and a sheet may store at most
  four times its length plus 64 KB of expanded selectors; past either bound
  the nested selector stands as written, so a sheet costs its length too.
  Nesting is read 64 levels deep; a rule nested below that is dropped, not
  parsed.
- A page is linted with the stylesheets it links (`<link rel=stylesheet>`,
  `@import`, and anything they reach); a directory of components shares the
  project's tokens and global state styles, so a focus ring declared once in
  `globals.css` is not reported missing on every component.
- `--render` measures every HTML page found; `--url` measures a running dev
  server (and implies `--render`). When no browser is available the render
  tier is skipped and the summary says why. With `--url`, under any scope,
  a skipped render also prints `gstack-design-lint: RENDER_UNAVAILABLE:
  nothing was measured at <url> (<reason>) | fix: gstack-browser-ensure, then
  rerun` on stderr and exits **4**: a URL nobody measured is never a pass.
  `--render` over files without a browser keeps the skip and its exit code.
- `--scope component` skips the page-only rules (the nav, the footer, the
  eyebrow, section gaps, the wireframe count) when linting a component alone.
- `--job <job>` names what the visitor came to do (`book`, `buy`,
  `subscribe`, `attend`, `visit`, `hire`, `listen`, `join`, `try`,
  `sign up`): an email sign-up as the page's close is only a finding when the
  job is not one where a mailing list is native.
- `--json` prints `{ summary, files, findings }`; `--rules` prints the table below.

## Output

One line per finding, then one summary line:

```
LINT: <blocks|ask|polish|waived> <rule-id> <file>:<line> <evidence> | fix: <fix>
LINT_SUMMARY: blocks=N ask=N waived=N polish=N render=<ran|skipped: reason>
```

Page-supplied text in a finding never holds the line's own ` | fix: `
separator (it is printed as ` / fix: `), so splitting a line on its first
` | fix: ` always reads the fix; a program reading many fields should take
`--json`.

Exit **2** when anything blocks, **1** when an ask is unanswered, **0**
otherwise (**3** on a usage error, **4** when `--url` was given and no browser
measured it). Findings sort blocks, ask, waived, polish, then by rule, file
and line. `--scope app` has its own verdict and exit codes: see
[App profile](#app-profile---scope-app).

## Tiers

The lint uses gstack's severity words, not a fourth scale:

| Tier | Meaning | hallmark's word |
|---|---|---|
| **blocks** | Never waivable. Correctness, access, honesty and the bans: a card in a card, a purple-blue gradient, a missing focus ring, contrast under threshold, a reveal that hides content until JavaScript runs. | Floor |
| **ask** | A default a model falls into. Fix it, or waive it on the record with a reason about this page. | Reflex |
| **polish** | Craft detail invisible at arm's length. Printed, never blocks. | Finish |

`waived` marks an ask or polish finding a waiver answered. **Blocking and
waived are never summed**: `blocks=0` is always a true sentence about the
Floor. Three house rules hallmark holds at Floor stay at ask here on purpose:
the eyebrow (`kicker-above-heading`; a figure caption or a plan name above a
heading is often right), the 80-word screen (`screen-word-budget`; a Read-mode
page legitimately exceeds it) and the dash (`em-dash-overuse`; gstack's rule is
overuse, not a ban). A blocking rule the lint can only *suspect* (an invented
metric it cannot prove invented) reports at ask so a person confirms it.

## Waivers

A finding is answered in a comment that names the rule and gives a reason
about this page:

```html
<!-- gstack-lint-disable kicker-above-heading: the chapter number is the reader's bookmark through a forty-page spec -->
```
```css
/* gstack-lint-disable section-gap: the ledger separates its rows with rules, not air */
```
```tsx
// gstack-lint-disable template-nav: the three links are the product's three modes
```

`impeccable-disable <rule>: <reason>` is accepted as an alias, so a comment
that already silences the impeccable engine answers the same tell here. The
lint refuses, each as its own `waiver` finding at ask: a rule it does not
know; the lint's own rules (`render`, `waiver`, `house-style`,
`internal-error`: a fallback face or a failed measurement is never signed off);
a **blocking** rule (the Floor is never waivable; the one exception is a
blocking rule the lint could only *suspect* on this page, which it reports at
ask and which a waiver answers like any ask); a reason under 24 characters,
boilerplate ("by design", "intentional", "looks better"), reused word for
word on another waiver, or sharing no word of four letters or more with the
page's own text; a second waiver of one rule. More than three waivers
on one page is a house style and belongs in DESIGN.md: reported once at polish
as `house-style`.

A claim written in a stylesheet answers for that stylesheet on every page
that links it, and only for findings located in it: the shared-word check does
not apply (a stylesheet has no prose), so the claim cannot reach a finding in
the page's own markup. A claim written in the page answers for that page,
including a finding in a stylesheet it links; a second page linking the same
sheet without answering still reports it, so the sheet's finding may print
once waived and once at ask, each from its own page. Which of these a context
gets follows its shape, not the `--scope` flag: one html page keeps page
semantics under either scope. In a directory of components, or a lone
component file beside a stylesheet (under either scope), each file's claim answers for that file alone,
weighed against that file's own text and its own suspected rules, so a sibling
component is never covered and a sibling that measures a blocking rule does
not turn this file's suspected finding into the Floor; a stylesheet beside the
components answers for itself as on a page. Two claims on one line are both read. A blocking copy
tell (`generic-hero-copy`) is the Floor inside the hero, the section or header
that holds the h1; the same line, or a "Meet <Name>" or three-word triad
heading, in body copy further down is suspected and reported at ask, so a
waiver can answer it.

## Rules

| Rule | Tier | Source gate | The tell | The fix |
|---|---|---|---|---|
| `purple-blue-gradient` | blocks | 2a | purple-to-blue, purple-to-pink or cyan-on-dark gradient | one anchor hue and solid ink |
| `gradient-text` | ask | 2b | gradient text | solid ink; carry emphasis with weight or a display face |
| `pure-black-white` | blocks | 7a | #000 or #fff as a colour outside the token block | tint toward the anchor hue: chroma 0.005 or more |
| `absolute-surface-token` | ask | 7b | a surface token that resolves to pure black or white | tint the paper |
| `zero-chroma-neutrals` | ask | 22 | zero-chroma oklch() neutrals | give the neutrals chroma 0.005 or more |
| `accent-footprint` | ask | 23 | accent colour past about 5% of a viewport | retreat the accent to actions and one signal |
| `glow-wash` | ask | 29 | glow and wash: blurred orbs, a radial halo or a zero-offset coloured glow | a solid or grained surface; elevation by lightness, shadows with offset and blur |
| `cream-palette` | ask | 65 | the cream paper, serif display and terracotta accent look | move one axis: the accent first, the paper second, the display last |
| `framework-palette` | ask | 74 | a framework default palette (Tailwind indigo-500, slate-900 and kin) as a token or utility | a colour mixed for the page in OKLCH |
| `overused-font` | ask | 1 | a training-data display face (Inter, Roboto, Fraunces, Playfair Display, Space Grotesk and the rest of gstack's catalog) or a system stack as the display | a display face chosen for the page |
| `banned-font` | ask | catalog | a face gstack bans in any role (Papyrus, Comic Sans, Impact, Lobster, Raleway, Courier New and the rest of lib/design-catalog.ts BANNED_FONTS) | a face chosen for the page; the body face for body and labels |
| `line-length` | ask | 25 | running prose outside 45 to 75 characters a line | max-width: 65ch |
| `font-family-count` | ask | 37 | more than three font families | display, body and one outlier |
| `italic-word-in-heading` | blocks | 38i | one italic word inside an otherwise roman heading | a line break, or the whole head set one way |
| `italic-serif-display` | ask | 38ii | an italic display system | roman display, or declare it on --font-display with font-synthesis: none |
| `accented-word` | ask | 38iii | one word in a heading set apart by colour, weight, a highlight or an underline | the whole head one way; a line break; a second line at a second size |
| `caps-leading` | blocks | 55a | an uppercase display head that can wrap with line-height under 1.0 | line-height 1.0 at least (1.02 to 1.08 recommended) |
| `caps-lockup-leading` | ask | 55b | a single-line caps lockup under 1.02 | line-height 1.02, or make sure it cannot wrap at 320px |
| `monospace-costume` | ask | 64 | monospace on labels, captions or small type when the content is not code | labels in the body face, a step smaller, normal case |
| `tiny-text` | ask | 75 | running text under 12px, functional text under 11px, or prose leaded under 1.3 (render) | body 16px at 1.5 to 1.65; labels one step smaller |
| `wide-tracking` | blocks | 67 | the tracked-caps label: small text set uppercase or letter-spaced past 0.03em | the body face, a step smaller, sentence case, untracked |
| `template-cards` | ask | 3 | three equal icon-above-heading tiles, an icon in a rounded tile, or a thick coloured side stripe | vary widths and heights, inline icons, hairline or no border |
| `nested-cards` | blocks | 4 | a card inside a card | one containment layer |
| `vh-height` | blocks | 6a | a hero sized in vh | dvh or svh |
| `raw-spacing` | blocks | 24a | a raw padding, margin or gap length where a --space-* token exists | the token |
| `off-scale-spacing` | ask | 24b | spacing off the page's scale | the scale; three optical nudges at most |
| `overflow-x-unclipped` | ask | 34 | overflow-x missing on html and body, or a 100vw width | overflow-x: clip on both; width: 100% |
| `horizontal-scroll` | blocks | 34 | horizontal scroll at a width between 320 and 1920 (render) | find the element wider than its viewport and cap it |
| `hero-balance` | ask | 44a/44c | the hero's content sits off centre for its screen, or its visual stands apart from the text (render) | centre the content in its screen; put the visual beside the text |
| `hero-fold` | blocks | 44b | the headline's bottom or the hero's first action below the 800px fold at 1280 wide; the lede and the visual are not measured (render) | pull the display clamp down, tighten leading, a two-line lede, trim padding |
| `wide-container` | blocks | 44d | at 1920x1080 the container has no max-width, gutters under 120px, or a grid gains columns | cap 1360 to 1520px and centre; hold column counts; cap vw visuals |
| `bare-fr-track` | blocks | 50 | an image-bearing grid track on bare 1fr | minmax(0, 1fr) |
| `display-head-unwrapped` | blocks | 50 | a display head without overflow-wrap: break-word and min-width: 0 | overflow-wrap: break-word; min-width: 0 (never anywhere) |
| `radio-tab-jump` | blocks | 53 | CSS-only radio tabs at position: absolute; top: 0 with no JS guard | radios in flow at zero size, or a handler with preventScroll |
| `double-sticky` | blocks | 56 | two position: sticky; top: 0 elements | top: var(--banner-height) on the second |
| `screen-word-budget` | ask | 58 | more than about 80 words in one 900px window, or a hero with more than two text blocks before its actions | headline, one sentence, actions; a section is a head block, then its composition |
| `section-gap` | ask | 59 | a gap under 120px between sections at 1440, every gap the same, or more than nine sections (render) | 120px at least, varied; six to nine sections a page |
| `heading-rhythm` | ask | 71 | a heading nearer what precedes it than what it heads (render) | at least twice the space above a head as below it |
| `cramped-padding` | ask | 72 | text closer than 8px (or half an em) to the side of its filled box (render) | pad the box; a 16px gutter |
| `thin-section` | ask | 77 | a section below the hero with no mass: a narrow body on a wide canvas (render) | widen the body, add a visual, set a statement, or merge the section |
| `small-section-heads` | ask | 78 | the median h2 below the hero renders under 40px at 1440 (render) | h2 at the section size, item titles at the title size |
| `dead-band` | ask | 79 | more than 160px of nothing between the hero's lowest content and the fold (render) | centre the content and grow the visual or the head; never fill with copy |
| `hand-drawn-svg` | ask | 80 | an inline SVG of 120px or more with three curves or fills and no text: a drawn illustration (render) | a photograph, the product built, or type at scale |
| `empty-picture` | ask | 81 | a slot or gradient block of 300x200px or more showing nothing but its wash (render) | the user's image, a credited photograph, or the product at full fidelity |
| `counting-marks` | ask | 82 | 24 or more identical marks standing for a quantity (render) | set the number in type |
| `photo-wall` | ask | 83 | photographs cover more than a third of the page below the hero (render) | keep the strongest pictures, set big; carry the rest in type, figures, the product, a table |
| `email-band-close` | ask | 85 | the page ends on an email sign-up form (one or two fields, one of them the email; never a form with a password or a sign-in button) on a page whose job is not subscribe, join, attend, listen or visit | end on what the visitor came to do, or on the last strong section |
| `aphoristic-cadence` | blocks | 19 | the rebuttal cadence three or more times ("Not a feature. A platform.") | say what the product does, in its own nouns |
| `generic-hero-copy` | blocks | 19 | a filler opener ("Built for the modern team", "In today's landscape"), "quietly trusted by", or the catalog's "Welcome to" and "all-in-one solution" | say what the product does, in its own nouns |
| `generic-cta-copy` | ask | 19/42 | a stock second action beside the primary (Learn more, Get started, Book a demo) | one action, or a second that names where it goes |
| `em-dash-overuse` | ask | 19 | em or en dashes carrying the prose | a comma, a colon, a full stop or a line break |
| `template-footer-line` | ask | 19 | a stock footer line (All rights reserved) | the page's own line, or nothing |
| `template-nav` | ask | 42 | the reflex nav: wordmark left, inline links, a button right, hairline under | decide the nav and build another shape, or keep it on the record |
| `template-footer` | ask | 42 | the reflex footer: four link columns, a social row, a copyright | decide the footer and build another shape, or keep it on the record |
| `invented-proof` | blocks | 46a | an invented metric, testimonial, logo wall or case-study count | the user's number, a text slot, or nothing |
| `drawn-browser-chrome` | blocks | 47a | a hand-drawn browser bar (traffic lights, URL pill) or OS window title bar | a real screenshot in a <figure>, or no chrome |
| `device-frame` | ask | 47b | a phone, laptop, terminal or editor frame | one frame with real content inside, or none |
| `imitation-material` | ask | 47c | styled divs standing in for a product, a photo edge or a physical object | the product built inside a slot, a real asset, or nothing |
| `kicker-above-heading` | ask | 54 | the eyebrow: short inert type before a heading that only announces it | open the section another way; where the heading is figurative, the label becomes the heading |
| `template-punctuation` | blocks | 63 | template punctuation: middle-dot meta strings, an arrow glued to link text, decorative status dots | line breaks, columns, hairlines; a verb as the label |
| `wireframe-slots` | ask | 68 | more than five empty slots on one page, or four or more in one row | set the set in type; a slot that stays holds a real photo or the product |
| `repeated-fact` | ask | 69 | one fact (a price, a time, a count) printed in four or more sections | say each fact once, where it does work |
| `fake-send` | blocks | 70 | a form that prints success with no request behind it | validate, post nowhere and say so plainly until the endpoint exists |
| `layout-transition` | blocks | 10a | transition: all, or animating width, height, top or left | list the properties; transform and opacity |
| `spacing-transition` | ask | 10b | transitioning margin or padding | transform |
| `hover-tells` | ask | 11 | the same lift on every card, two effects on one element, an image scaling on hover, or a hover on something inert | one signal per element, on the container, not the image |
| `bounce-easing` | ask | 12 | bounce or overshoot easing on UI state | an exponential ease-out |
| `focus-ring-fade` | blocks | 15 | a focus ring that fades in | instant: exclude outline and box-shadow from the transition |
| `tooltip-focus-delay` | blocks | 17 | a tooltip whose focus delay equals its hover delay | hover 800 to 1000ms, focus 0 |
| `autorotate-no-pause` | blocks | 18 | auto-rotating content with no pause on hover and focus | pause on hover and focus; a visible pause control past 5 seconds |
| `missing-focus-visible` | blocks | 26a | an interactive element with no :focus-visible ring, or an outline removed with nothing in its place | a ring at 3:1 or better, instant |
| `missing-states` | ask | 26b | no :active or :disabled state | all the states a control can be in |
| `missing-reduced-motion` | blocks | 27 | a keyframe or transform transition without a prefers-reduced-motion fallback | add @media (prefers-reduced-motion: reduce) |
| `autoplay-unmuted` | blocks | 28a | a video autoplaying without muted | autoplay muted loop playsinline |
| `lazy-lcp` | blocks | 28a | loading="lazy" on the first image or the hero video | fetchpriority="high" on the LCP image |
| `video-without-poster` | ask | 28b | a video without poster or a priority hint | add them |
| `input-state-shift` | blocks | 39a | input states that break: a border that changes width, a focus ring built from border, disabled by opacity alone | constant border, outline, shared height, three disabled channels |
| `control-height` | ask | 39b | control height outside 44 to 52px on a marketing page | the number |
| `content-hidden-at-rest` | blocks | 62 | a reveal class hiding content until JavaScript runs | visible by default; hide only under a .js class, or animate from visible with @starting-style |
| `emoji-decoration` | blocks | 30a | an emoji standing in for an icon | one icon library, custom SVG, or typography |
| `two-icon-libraries` | ask | 30b | two icon libraries on one page | one library |
| `unlabeled-decoration` | blocks | 33 | a decorative <svg>, <canvas> or CSS-art element with neither aria-hidden="true" nor a label | hide it or name it |
| `broken-image` | blocks | 76 | an <img> with no source or one that does not load | the real file |
| `stock-photo-hotlink` | blocks | 76 | a stock-site photo hotlink | the user's image, or a library photograph credited on the page |
| `text-occlusion` | blocks | 73 | text painted under another element (render) | give the text its own space, or its own surface above the cover |
| `low-contrast` | blocks | 40 | text, an icon, a focus ring or a field edge under its contrast threshold | fix the pair; body 4.5:1, large text and edges 3:1 |
| `gray-on-color` | blocks | 41 | button text within a step of its fill, or grey text on a coloured surface | the paired ink token |
| `literal-outside-tokens` | blocks | 48 | a colour or font-family literal outside the token block | lift it into the tokens |
| `button-label-wraps` | blocks | 49a | a button label or primary nav link that wraps | shorten it; white-space: nowrap |
| `link-wraps` | ask | 49b | a footer link, tab or breadcrumb that wraps | shorten it |
| `straight-quotes` | polish | F1 | straight quotes in prose | curly quotes |
| `three-dot-ellipsis` | polish | F2 | three dots for an ellipsis | the ellipsis character |
| `balanced-display-head` | polish | F3 | a display head without text-wrap: balance | text-wrap: balance |
| `two-primary-buttons` | polish | F4 | two filled primary buttons on one page, or side by side | one filled primary; the second as a text or outline action |
| `icon-coin` | polish | F5 | an icon in a coloured coin | the icon inline, bare |
| `display-figures-tabular` | polish | F6 | display-size figures without tabular numerals | font-variant-numeric: tabular-nums |
| `stamped-recipe` | polish | F7 | one container recipe stamped on six or more selectors, or the pill radius on five or more non-controls | vary the recipe; pills on controls, tags and badges only |
| `scroll-choreography-mix` | polish | F8 | more than one scroll-choreography pattern | one pattern a page |
| `fake-avatar` | blocks | F9 | a fake-human avatar hotlink | the user's people, initials, or no portrait |
| `stock-person-photo` | polish | F9 | a person-keyword stock photo URL | the user's photograph |
| `page-invariants` | polish | F15 | page invariants broken: primary button style, container width, column gap or radius drifting | one recipe for each |
| `unthemed-browser-surfaces` | polish | F16 | no ::selection, caret-color or scrollbar-color on a page with a committed palette | theme the browser surfaces |
| `text-sliver` | polish | F17 | a text block squeezed into a sliver at 1440 (render) | give the block room or merge the columns |
| `tiny-slot` | polish | F18 | a slot rendering under 40px in either dimension (render) | size the slot for what it will hold |
| `font-weight-count` | polish | F19 | more than three font weights in running use (render) | three weights |
| `lonely-grid-item` | polish | F20 | a grid or wrapping row leaving one item alone on its last row (render) | change the count or the columns |
| `skipped-heading` | polish | F21 | a heading level skipped | step the levels one at a time |
| `justified-text` | polish | F22 | justified text without hyphens: auto | hyphens: auto, or left-aligned |
| `missing-lang` | polish | F23 | a document without lang | lang on <html> |
| `hairline-under-shadow` | polish | F24 | a hairline border under a wide soft shadow on one surface | the shadow or the border, not both |
| `placeholder-name` | ask | craft | a placeholder name (John Doe) | use a supplied name, or one that fits the product in sample data |
| `placeholder-brand` | ask | craft | a placeholder brand (Acme, Nexus) | use a supplied customer, or a fitting name in sample data |
| `lorem` | ask | craft | lorem ipsum placeholder text | write real copy |
| `marketing-buzzword` | ask | craft | a marketing buzzword | say the specific thing |
| `round-number` | ask | craft | a round invented number | use the supplied figure, or drop the claim |
| `needs-proof` | ask | craft | a [Needs proof] marker left in the page | supply the proof or remove the claim before publishing |
| `oops` | ask | craft | "oops" as an error message | say what happened and what to do |
| `scroll-listener` | ask | craft | a scroll event listener | use IntersectionObserver; read scroll inside requestAnimationFrame for a scroll-linked effect |
| `dead-link` | ask | craft | a dead link (href="#") | link it, or render the control disabled |
| `alert` | ask | craft | alert() for a message | show the message inline |
| `img-no-alt` | blocks | craft | an <img> without alt | add alt text (alt="" when decorative) |
| `missing-title` | blocks | craft | a document without a <title> | add a <title> |
| `missing-meta-description` | ask | craft | no meta description | add <meta name="description"> |
| `missing-favicon` | polish | craft | a document without a favicon | add a favicon <link rel="icon"> |
| `missing-skip-link` | ask | craft | no skip link reaching <main> | add a "Skip to content" link first in <body> whose #id exists on <main> |
| `missing-aria-current` | ask | craft | route navigation without aria-current | mark the current nav link aria-current="page" |
| `empty-mount-node` | ask | craft | an empty mount node: the body has no text and a script renders it, so the lint read none of its content | lint the rendered page: save document.documentElement.outerHTML to a file and lint that |

Source gates are Nutlope/hallmark `references/gates.md` at 7ec8682; `craft`
marks the copy tier (Elaya-derived). Its content-realism ids (placeholder
people and brands, lorem, round numbers, `[Needs proof:` markers) sit at
ask, so a real customer named Nexus or a supplied 50% figure is answered by a
waiver that names the page; `empty-mount-node` says a client-rendered shell
was not read, instead of passing it. Four
ids are the lint's own: `waiver` (a refused waiver, ask), `house-style` (more
than three waivers, polish), `render` (a page that did not render, blocks:
an unrendered page is never a pass) and `internal-error` (a page or stylesheet the lint could not read, or a rule family that
threw on a page, ask: the page is not a pass until the lint has read it).

## App profile (--scope app)

```
gstack-design-lint --scope app (--url <url> ... | --state-file <states.json>) --within <selector>
                   [--viewport WxH ...] [--wait-for <selector>] [--waivers <file>] [--json] [--verbose]
```

The page and component profiles grade a whole page against hallmark's gates.
The app profile measures one section of an app screen while it is being
built, for the spacing defects qm#3186 shipped (two-line rows crowding the next
row, help copy flush under a list, a status note at full weight inside a row)
and small hit areas. It is render-only (no static tier, and paths are a usage
error), reports only its five rules, and the page and component profiles never
report them. Its scheduler (`lib/design-lint/render-app.ts`) and probes
(`lib/design-lint/render-probe-app.ts`, installed on
`window.__gstackLintApp`) are separate from the page tier's, which is
unchanged.

- **States.** Each `--url` is one state, named by its path and query
  (redacted); a later URL whose name is taken gets `~2`, `~3` after it, and
  the same URL given twice exits 3 (`DUPLICATE_STATE`).
  `--state-file` names them instead:
  `{"version":1,"states":[{"name":"owner","url":"http://127.0.0.1:5300/p?as=owner","expect":"<selector>","within":"<selector>"}]}`.
  `name`, `expect` and `within` are optional; an unknown key, a missing or
  non-http `url`, a bad selector or a repeated name exits 3. A URL off
  loopback is allowed and noted (`LINT_APP_NOTE:`). `expect` proves the state
  rendered: it must match in the composed tree after readiness, or the state
  is incomplete with `STATE_MISMATCH`.
- **`--within`** (required) is matched through the light DOM and every open
  shadow root, slotted content included; a state's own `within` overrides it.
  A malformed selector exits 3 before any page opens. A selector that matches
  nothing is `WITHIN_NO_MATCH`, naming the trees searched.
- **Readiness.** The page is opened and the engine waits up to 15 s for the
  `--wait-for` selector, else the `--within` selector, through open shadow
  roots. Then the probe polls up to 5 s until the section holds a list of two
  or more rows; an explicit `--wait-for` skips that list wait (use it for a
  section with no list). A section that never gets its list is `NOT_READY`; an
  explicit `--wait-for` that never matches is `NOT_READY` too.
- **Viewports.** 1440x900 and 375x812 by default; `--viewport WxH` (repeatable)
  replaces them. Width 320 to 3840, height 480 to 2400, `^\d{3,4}x\d{3,4}$`;
  anything else exits 3. One page load per state, one measurement per
  viewport.
- `--within`, `--viewport`, `--wait-for`, `--waivers` and `--state-file`
  without `--scope app` exit 3 (`APP_ONLY: <flag> only with --scope app`).
  `--verbose` is accepted under every scope; under `--scope app` it prints a
  failed probe's stack.

### What it measures

The thresholds are fixed in this release; DESIGN.md does not override them.
Every rule is at `ask`, but the tier does not decide the verdict: any app
finding a waiver did not answer makes the section open.

| Rule | Tier | The tell (measured px, threshold) | The fix |
|---|---|---|---|
| `row-crowding` | ask | in a list of rows, a row whose text spans two or more lines sits under 8px from a drawn row edge (its own border or surface, the neighbouring row's separator, or the list's edge), or under 16px from the next row's text | 8px or more inside the row, 16px or more between rows' text |
| `copy-flush-under-list` | ask | the first text block after a list (later siblings of the list container inside the section, before the next heading) starts under 12px below it | 12px or more under the list |
| `note-in-row-weight` | ask | in a list of rows, a note with no icon and no surface of its own, OKLCH lightness within 0.15 of the name's and size 0.9 or more of it; or, at 1200px and wider, a note of three lines or more | mute the note, or give it an icon or a callout |
| `small-hit-area` | ask | at 480px and narrower, a control inside a list row under 32px in either dimension (an input's label counts toward its box; a link inside a run of text is exempt) | a 32px target that keeps the glyph its size |
| `section-overflow` | ask | an element inside the section whose right edge passes the viewport (outside any scroller), or a non-scrolling element whose content is wider than its box | wrap or shrink it, or give it a scroller |

How it reads the page, with no test hooks (no `data-testid`, no attribute at
all): a **list** is two or more adjacent siblings of one tag and class list,
widths within 10%, stacked (each top at or below the previous bottom less
1px), each holding visible text; tables, anything inside `nav` or a
navigation, grid, table, menu, listbox, tablist or tree role, headings,
paragraphs, sections and forms are never rows, and siblings side by side are a
grid, not a list. A list is a **list of rows** when it or a row draws a
border, background or shadow, or when every row is a flex or grid box that sets
two or more boxes side by side (an avatar, the text, a control);
`row-crowding` and `note-in-row-weight` read lists of rows only (an unboxed
bullet list is prose). With no drawn edge, `row-crowding` measures only the
gap to the next row's text. Measurements within 0.05px of a threshold count as
meeting it, so layout's subpixel rounding never fires a rule. A row's **text runs** are its
visible text nodes in rendered order through the composed tree, leaving out
text inside controls; positions are line boxes, so a gap is the padding and
margins the CSS set. The **name** is the run on the row's first line (the
leftmost when two share it). A **note** is a text block whose first line starts
below the name's line; a role label beside the name is never a note.
**Controls** are `button`, `a[href]`, `input`, `select` and the button,
menuitem, switch and tab roles.

### Verdict, output and exit

Each finding is a `LINT:` line whose evidence reads
`[<state> <W>px] <measured sentence> at <locator>`; the locator pierces
shadow roots (`qm-sharing >>> section.panel > div.rows:nth-of-type(1) > div.row:nth-of-type(2) "Registry token Pushes…"`).
Then one `LINT_APP_STATE:` line per state and viewport, `LINT_SUMMARY`, and
the verdict:

```
LINT_APP: verdict=<clean|open|incomplete> code=<OK|OPEN|CODE> states=<measured>/<planned> viewports=<list> within=<sel> matched=<n> open=<n> waived=<n>
```

`states` counts states measured at every viewport; `matched` is the fewest
elements `--within` matched at any state and viewport. Exit **0** clean (every
planned state and viewport measured, nothing open), **1** open (complete
coverage, open findings), **4** incomplete (any state or viewport not
measured: incomplete wins over open, and partial coverage never prints clean),
**3** usage only. `--json` prints `{ summary, files, findings, app }`, where
`app` is `{ verdict, code, codes, within, matched, viewports, states: [{ name,
url, viewport, status, code, matched, detail?, trace? }], open, waived, notes }`
and each app finding carries `app: { state, viewport, locator, measured,
threshold }`, never truncated. Findings that differ only in their row or
viewport stay separate.

When several codes apply, `code` is the first in this order and `codes` lists
them all:

| Code | Means | Fix |
|---|---|---|
| <a id="app-code-no_browser"></a>`NO_BROWSER` | no browser could open the page (also `RENDER_UNAVAILABLE` on stderr) | gstack-browser-ensure, then rerun |
| <a id="app-code-unreachable"></a>`UNREACHABLE` | the URL did not answer 2xx, or the page did not render | start the server or fix the URL, then rerun |
| <a id="app-code-timeout"></a>`TIMEOUT` | the render ran past its 120 s budget | make the page load faster or measure fewer viewports, then rerun |
| <a id="app-code-not_ready"></a>`NOT_READY` | the section never held a list, or `--wait-for` never matched | pass `--wait-for` with a selector that appears once the data is in, or make the data load |
| <a id="app-code-state_mismatch"></a>`STATE_MISMATCH` | the state's `expect` selector matched nothing | make the URL load the state it names, or fix `expect` |
| <a id="app-code-within_no_match"></a>`WITHIN_NO_MATCH` | `--within` matched nothing in the document or any open shadow root | pass the custom element's tag or a selector inside the light DOM |
| <a id="app-code-closed_shadow"></a>`CLOSED_SHADOW` | a custom element in the section (or, when nothing matched, on the page) renders a closed shadow root: no shadow root, no light DOM, 40px or taller | attach the shadow root with mode "open" in development, or pass a `--within` outside it |
| <a id="app-code-probe_error"></a>`PROBE_ERROR` | a probe threw or answered in a shape the lint does not know | read the trace file; a page script that redefines DOM APIs breaks the probes |
| <a id="app-code-asset_missing"></a>`ASSET_MISSING` | a linked stylesheet did not load (a font that did not load is only a `LINT_APP_NOTE`) | fix the stylesheet path or wait for the server, then rerun |

Each `LINT_APP_STATE` line for an incomplete state names its code, the
detail, the fix and its anchor here. Nothing is retried: fix the named cause
and rerun. A probe that throws writes `{probe, state, viewport, stack, url}`
to a private file (mode 0600, in a 0700 `gstack-design-lint-traces`
directory under the system temp directory) and names it on stdout and
stderr; `--verbose` also prints the stack. When the trace cannot be
written, the state is still `PROBE_ERROR` and stderr says why.

### Waivers and redaction

URL targets have no source comment to carry a waiver, so `--waivers <file>`
does: `{"version":1,"waivers":[{"rule":"small-hit-area","locator":"<part of
the finding's locator>","reason":"<why, about this page>"}]}`. The rule must
be an app rule and the reason 8 characters or more; an unknown rule or key
exits 3. A finding whose rule matches and whose locator contains the waiver's
`locator` prints at `waived` with its reason; a waiver that matched nothing
prints as a `waiver` finding (unused), which does not change the verdict.

Every URL a person sees (text, JSON, stderr, traces, state names) has its
userinfo dropped and the value of any query or `#fragment` parameter whose
name contains token, key, secret, auth, session, sig, signature, password,
pass, code, jwt or bearer replaced with `REDACTED`; the page is opened at the
real URL.

## Token names the rules read

Several rules key on hallmark's token names, which are also the names
`/design-html` writes: `--color-paper` (the ground; `cream-palette`,
`cyan-on-dark` and the dark-paper checks read it), `--color-accent`
(`accent-footprint`, `cream-palette`), `--font-display` / `--font-heading` /
`--font-title` / `--font-hero` (`overused-font`), `--space-*` (`raw-spacing`,
`off-scale-spacing`) and any `--color-*` or `--font-*` token
(`literal-outside-tokens` fires only on a page that declares one, since a
literal on a page with no tokens bypasses nothing; its Tailwind half, an
arbitrary value like `bg-[#0b0b12]` or `font-['Inter']`, fires on any page,
since Tailwind's theme is the token block it bypasses). A project that names its
tokens `--bg` or `--brand` gets none of those checks and no signal that they
did not run; reading the roles from DESIGN.md is left to a later phase.

The token block is `:root`, `html`, a `[data-theme|mode|scheme]` scope, `@theme`,
`@font-face` and anything in a `tokens.css`. Its values are read in one mode:
the base block's last declaration wins, and a mode override (a token rule under
`@media (prefers-color-scheme: …)` or a `[data-theme=…]` scope) only supplies
tokens the base block never declares, so a page that carries both a light and
a dark palette is measured in the mode it declares first, never a mix of the
two. A custom property declared in any other scope (`.dark { --color-paper: … }`,
a component-local `--accent`) is a token definition, not a literal, so
`literal-outside-tokens` does not report it; the dark values of a class-scoped
theme are not read either.

## What the lint does not cover

A clean `LINT_SUMMARY` is not the whole design checklist. These checklist and
catalog items stay with the LLM pass in `/design-review` and are not rules
here: `!important` in new CSS (the parser drops the flag), an h1 past 6rem
(`oversized-h1`), tracking below -0.04em (`extreme-negative-tracking`), body
text under 16px in a static stylesheet (`tiny-text` here is hallmark's 12px
running-text floor, measured by the render tier), the `theater-slop-phrase`
list beyond "built for the modern", the pulsing dot, a text container with
no `max-width` (`line-length` reads a declared `ch` value), an uppercase
paragraph at body size (`wide-tracking` reads caps at label size or tracked;
a 16px untracked uppercase `<p>` passes), and a fixed px `width` on a
container with no responsive handling (`wide-container` reads the opposite
case). The copy tier reads the visible text (comments, scripts, styles and
`<template>` removed, entities decoded), script bodies and inline handlers
for `alert()` and scroll listeners, and the parsed tags for links, images and
the head, so a hydration payload or commented-out markup is not counted; it
does not fetch external scripts, and its head rules run only on a document
with a `<head>`. A body with no text (a `<noscript>` notice aside) that loads
a script is an `empty-mount-node`: lint the rendered DOM instead; `--url`
measures layout, it does not read the copy.
`tooltip-focus-delay` reads the delay slot of a tooltip's `transition`
(the second time in each comma part) or its `transition-delay`, 100ms and
over; a `0.2s` or `200ms` fade is a duration, not a delay. Where a rule id is shared with
`lib/design-catalog.ts`, the tier here follows hallmark's gate (several
catalog `ask` rows are `blocks` here); a later phase reconciles the two before a
catalog row is marked `detect: lint`. Also outside the lint: `system-ui` or
`-apple-system` as the body's first face (`system-font-primary`; the
`overused-font` rule reads display tokens and heading selectors, as hallmark's
gate does), a gradient fill on the primary button (`gradient-cta`;
`purple-blue-gradient` reports the banned hue pairs only, and an
indigo-to-violet ramp needs stops 12° or more apart), `text-align: center`
density, one large radius on everything, and backdrop blur on more than one
container (`glow-wash` reports a blur over a translucent near-white or
near-black fill; the zero-offset coloured glow is read from 8px in a Tailwind
class and past 20px in a stylesheet, hallmark's two thresholds). The render
tier's probes run in the page's own JavaScript, so a page that redefines them
is caught only when it hands back a rule, grade or shape the lint does not
know (each such answer is one `render` finding naming the probe and width,
and every well-formed finding beside it is kept); a page that answers every
probe with nothing passes the render tier, which is why the static tier stands
on its own and a URL target is measured, never trusted. A stylesheet shared by
many pages is parsed once but its stylesheet-only rules run per page and are
deduplicated at the end, so forty pages on one bundle cost forty passes over
it. `overused-font` and `banned-font` match a catalog stem to the whole
family name or its first words (`Cormorant Garamond`, `DM Serif Display`,
`Comic Sans MS`), never to a longer word (`Interstate` is not `Inter`).
Four checklist items are read more narrowly here than the LLM pass reads
them: `zero-chroma-neutrals` reports every opaque `oklch(L 0 H)` literal
whether or not the page has an anchor hue (hallmark's stamp carried the hue;
a deliberately monochrome page waives it on the record); `missing-focus-visible` reports a removed outline only when no
`:focus` rule anywhere on the page draws a ring (the per-element check is the
render tier's focus walk); `off-scale-spacing` holds every px length to the
4px scale whether or not DESIGN.md declares one (`raw-spacing` is the rule
gated on `--space-*` tokens); and `double-sticky` pairs any two `top: 0`
sticky selectors without reading their scroll containers, so a sticky table
header inside an `overflow: auto` wrapper under a sticky nav reports and
wants a waiver on the record. As in hallmark, a selector the heading pattern
matches (`__title`, `__headline`, `display`) is read as display type unless
its name is also a label's or a control's, so a 12px uppercase tracked
`.card__title` is caught by the markup half only when its text is typed in
capitals. `em-dash-overuse` does not count an en dash between two digits (a
range).

## What is deliberately not ported

hallmark's theme stamp (the CSS comment that declares a theme, a posture and a
hero shape) and every guard that reads it; the genre flag; the judged gates
(the AI template shape, section rhythm, hover by judgement, toasts, the
reviews); the `--before` / `--kept` redesign record (left to a later phase); the photo index.
