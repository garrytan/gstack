# Universe AI Software Factory — Cockpit P0 Prototype

Status: static prototype. No production runtime. No dependencies. No external assets.

## What this is

A single-page static walk-through of the common-user cockpit. It renders every
canonical screen from the Beta 1 contract with placeholder data shaped like the
view models in `lib/factory-cockpit-view.ts`. Open `index.html` directly in any
browser — no build step, no router, no JavaScript.

## What this is not

- Not a production web app.
- Not a deployment.
- Not a runtime. There is no fetcher, router, or framework.
- Not approved to add dependencies or a production web scaffold.

## Files

- `index.html` — every screen, in one HTML document, scrollable top-to-bottom.
- `styles.css` — design tokens, primitives, and screen-specific layout.
- `README.md` — this file.

## Coverage

One section per Beta 1 journey, plus mobile artboards and a legend:

| Section | Journey | Mobile case |
| --- | --- | --- |
| Dashboard | J1 entry · J2 entry · J3 banner | M1 |
| Idea wizard + mode picker | J1 | — |
| Easy Mode project home | J2 | M2 |
| Hands-on 3-bay map | J2 hands-on | M3 |
| Detailed cockpit (3 cols) | J2 hands-on deeper | — |
| Gate decision modal | J3 | M4 |
| QA audit evidence + guard denial | J4 · J5 | — |
| Ship readiness + handoff | J6 | — |
| Artifact detail | — | M5 |
| Mobile artboards | — | M1 – M5 |
| Legend & provenance | cross-screen | — |

## Boundary labels rendered in the prototype

- Sticky banner: "Static prototype · No production runtime · No deployment · Local-only boundary · `/factory-qa-fix` hidden until host guard".
- QA audit banner: "Browser QA audit — no code changes".
- QA fix placeholder: shown as hidden until host guard attestation.
- Ship surface: "Ready for handoff" + "Ship readiness is not deployment" disclaimer.
- Untrusted event metadata: `metadata-only` chip.

## How to view

Open `docs/prototypes/factory-cockpit-p0/index.html` in any browser. To exercise
mobile reflow, resize the window below 760px (or open DevTools and toggle device
mode). Every section also includes a fixed-width phone artboard for the mobile
acceptance cases M1 – M5.

## Source-of-truth references

- `docs/designs/PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md`
- `lib/factory-cockpit-view.ts` (view-model contracts the placeholder data mimics)
- `docs/designs/external/universe-ai-wireframes-round-1/software-factory/` (visual language)
