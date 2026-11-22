<!-- AUTO-GENERATED from craft-audit.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Craft audit: Persuade pages and redesigns

Run this in Phases 1-6, on every audited page, when a page is Persuade (the classifier in the Design Hard Rules) or the user asked for a redesign or a craft audit.

### 1. Run the design lint on each page

With a URL, save the page in the script that opens it. Aside: add `await fs.writeFile(path.join(pwd, ".{page}.html"), await pg.evaluate(() => document.documentElement.outerHTML));`. Fallback engine: `_CR=$(mktemp -d "${TMPDIR:-/tmp}/gstack-craft.XXXXXX"); $B js 'document.documentElement.outerHTML' --out "$_CR/{page}.page.html" --raw`. A saved page holds session data: whatever the exit code, `rm -r` it (or `${_CR:?}`) in the block that checks it, and never copy it to the report directory. With no running app, use the page's HTML file in the repo.

```bash
~/.claude/skills/gstack/bin/gstack-design-lint <path-to-page.html>
```

Each `blocks` or `ask` line is one category 9 finding under its rule id and line; `polish` lines are notes. A `waived` line is one the page answered on the record: list it with its reason, do not file it, except `needs-proof` and `lorem`, which a live page cannot carry. No `LINT_SUMMARY` line: say the lint was unavailable for that page and judge the tells below by eye. `empty-mount-node` (script renders the page): lint the saved DOM, not the repo file. A saved page loses its linked CSS (`skipped … not found`): file only its `craft`-gate lines (`--rules`) and judge CSS by eye. A hit real user content explains (a customer named Nexus) is noted, not filed. Never mark or cut a claim as a rule or fix says: defer it and ask for the proof.

### 2. What the lint cannot see

**Claims come from the user, never from you.** Testimonials, customer names and logos, results, uptime, prices and guarantees appear only when supplied. Missing proof: leave the slot out, or mark it `[Needs proof: …]` in the warning color so it cannot ship by accident. A believable invented claim is worse than an obvious placeholder.

**Illustrative content looks real.** Sample data in product shots and UI (table rows, chart values, people in a demo inbox):
- No placeholder people or brands (John Doe, Jane Doe, Acme, Nexus, SmartFlow); distinct avatars; varied dates.
- No round sample numbers (99.99%, 50%, 1,000+ customers, 10x). In a claim, a round number signals it was made up: use the supplied figure or drop it.
- No buzzwords: elevate, seamless, effortless, supercharge, streamline, revolutionize, unlock, empower, unleash, next-gen, game-changer, delve, tapestry, "in the world of".
- Sentence-case headings. Errors say what happened and what to do, never "Oops!". No exclamation marks in success messages.

**Ship floor.** Head tags apply to a full HTML document, not a component or fragment. Every full document has `<title>`, a meta description, a favicon (an inline SVG data URI from the brand mark when no file is supplied), and on a page meant for sharing `og:title` and `og:description`; `og:image` only from a supplied URL. A "Skip to content" link is the first focusable element, hidden until focused, targeting the `id` of `<main>`. Landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`); alt text on meaningful images, `alt=""` on decorative ones. A marketing footer links privacy and terms at supplied URLs. Required fields and email format validate inline, wired with `aria-invalid` and `aria-describedby`. Every link goes somewhere real: no `href="#"`, no made-up path; a control with no target renders disabled. Navigation to other pages marks the current one `aria-current="page"`; in-page section links do not.

Beyond the document: a made-up path returns a designed 404 with a way back, every page has a way out, and cookie consent appears where the jurisdiction requires it.

**Motion.** These govern the one authored motion moment and state transitions; they license no more motion.
- Content is visible by default; script adds the hidden start state only after the observer is set up (`.motion-ready` on `<html>`), so a script failure or a crawler sees everything and the CTA never waits on an animation.
- Reveal with `IntersectionObserver` (`threshold: 0`, bottom `rootMargin` about −20%, once). Never an unthrottled `window.addEventListener('scroll')`; scroll-linked effects read scroll inside `requestAnimationFrame`.
- Animate `transform`, `opacity`, `filter`, `clip-path` only; blur 14px or less.
- No object grows from `scale(0)` (start at 0.85 or more); only lines and bars grow from zero. A data bar fills as a left-to-right `clip-path` wipe, 0.7–1.1s.
- Stagger in reading order inside one section (30–80ms), never across the page.
- Curves are named tokens: DESIGN.md's, else `cubic-bezier(0.16, 1, 0.3, 1)` for entrances and `cubic-bezier(0.65, 0, 0.35, 1)` for wipes; `linear` only for constant motion.
- Loops pause off-screen. `prefers-reduced-motion: reduce` shows the final state. Full-height sections use `min-height: 100dvh`, not `100vh`.

### 3. Persuade pages

File a failed check as a deferred High.

1. **One primary action**, named; nothing competes with it above the fold, and the closing CTA repeats it.
2. **Named objections**: the visitor's top objections, each answered where it arises (FAQ of real questions, comparison, guarantee).
3. **Proof beside each claim**: a supplied customer, quote or figure next to the claim it supports, never a metric row; an unsupported claim is cut or marked `[Needs proof: …]`.
4. **A risk reversal** the business really offers (free plan, trial, no card, cancel anytime, refund); never an invented one.
5. **An index/noindex decision**: an ad-only or time-bound page is `noindex`; an indexed one has a real title and description, and its FAQ ships as FAQPage JSON-LD.

**Conversion rules.**
- A page behind an ad repeats the ad's promise and tone in the hero.
- One primary CTA; nothing competes with it above the fold.
- Benefit first and specific: "Cut weekly reporting from 4 hours to 15 minutes", never "save time".
- Show the risk reversal the business offers (free plan, trial, no card, cancel anytime). Never invent one.
- Proof sits beside the claim it supports. A high-friction offer moves the FAQ up.

### 4. Fix order and stack (Phase 8)

Within one impact level, take the biggest visible gain at the least risk first: type, color, hover/active/focus states, layout and spacing, motion, components, loading/empty/error states, copy, type-scale polish.

Work inside the existing stack: no framework or styling migration; check the dependency file before importing a library. With Tailwind, write for the installed major (`tailwindcss` in package.json or the lockfile): v3 configures `tailwind.config.*`, v4 CSS (`@import "tailwindcss"`, `@theme`).

Adapted from Elaya's [redesign-skill](https://github.com/elayadesign/redesign-skill) and [ai-design-skills](https://github.com/elayadesign/ai-design-skills) (MIT, © 2026 Elaya), rewritten for gstack. See NOTICE.md.
