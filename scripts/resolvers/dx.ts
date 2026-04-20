/**
 * DX Framework resolver
 *
 * Shared principles, characteristics, cognitive patterns, and scoring rubric
 * for /plan-devex-review and /devex-review. Compact (~150 lines).
 *
 * Hall of Fame examples are NOT included here. They live in
 * plan-devex-review/dx-hall-of-fame.md and are loaded on-demand per pass
 * to avoid prompt bloat.
 */
import type { TemplateContext } from './types';

export function generateDxFramework(ctx: TemplateContext): string {
  const hallOfFamePath = `${ctx.paths.skillRoot}/plan-devex-review/dx-hall-of-fame.md`;

  return `## DX First Principles

These are the laws. Every recommendation traces back to one of these.

1. **Zero friction at T0.** First five minutes decide everything. One click to start. Hello world without reading docs. No credit card. No demo call.
2. **Incremental steps.** Never force developers to understand the whole system before getting value from one part. Gentle ramp, not cliff.
3. **Learn by doing.** Playgrounds, sandboxes, copy-paste code that works in context. Reference docs are necessary but never sufficient.
4. **Decide for me, let me override.** Opinionated defaults are features. Escape hatches are requirements. Strong opinions, loosely held.
5. **Fight uncertainty.** Developers need: what to do next, whether it worked, how to fix it when it didn't. Every error = problem + cause + fix.
6. **Show code in context.** Hello world is a lie. Show real auth, real error handling, real deployment. Solve 100% of the problem.
7. **Speed is a feature.** Iteration speed is everything. Response times, build times, lines of code to accomplish a task, concepts to learn.
8. **Create magical moments.** What would feel like magic? Stripe's instant API response. Vercel's push-to-deploy. Find yours and make it the first thing developers experience.

## The Seven DX Characteristics

| # | Characteristic | What It Means | Gold Standard |
|---|---------------|---------------|---------------|
| 1 | **Usable** | Simple to install, set up, use. Intuitive APIs. Fast feedback. | Stripe: one key, one curl, money moves |
| 2 | **Credible** | Reliable, predictable, consistent. Clear deprecation. Secure. | TypeScript: gradual adoption, never breaks JS |
| 3 | **Findable** | Easy to discover AND find help within. Strong community. Good search. | React: every question answered on SO |
| 4 | **Useful** | Solves real problems. Features match actual use cases. Scales. | Tailwind: covers 95% of CSS needs |
| 5 | **Valuable** | Reduces friction measurably. Saves time. Worth the dependency. | Next.js: SSR, routing, bundling, deploy in one |
| 6 | **Accessible** | Works across roles, environments, preferences. CLI + GUI. | VS Code: works for junior to principal |
| 7 | **Desirable** | Best-in-class tech. Reasonable pricing. Community momentum. | Vercel: devs WANT to use it, not tolerate it |

## Cognitive Patterns — How Great DX Leaders Think

Internalize these; don't enumerate them.

1. **Chef-for-chefs** — Your users build products for a living. The bar is higher because they notice everything.
2. **First five minutes obsession** — New dev arrives. Clock starts. Can they hello-world without docs, sales, or credit card?
3. **Error message empathy** — Every error is pain. Does it identify the problem, explain the cause, show the fix, link to docs?
4. **Escape hatch awareness** — Every default needs an override. No escape hatch = no trust = no adoption at scale.
5. **Journey wholeness** — DX is discover → evaluate → install → hello world → integrate → debug → upgrade → scale → migrate. Every gap = a lost dev.
6. **Context switching cost** — Every time a dev leaves your tool (docs, dashboard, error lookup), you lose them for 10-20 minutes.
7. **Upgrade fear** — Will this break my production app? Clear changelogs, migration guides, codemods, deprecation warnings. Upgrades should be boring.
8. **SDK completeness** — If devs write their own HTTP wrapper, you failed. If the SDK works in 4 of 5 languages, the fifth community hates you.
9. **Pit of Success** — "We want customers to simply fall into winning practices" (Rico Mariani). Make the right thing easy, the wrong thing hard.
10. **Progressive disclosure** — Simple case is production-ready, not a toy. Complex case uses the same API. SwiftUI: \\\`Button("Save") { save() }\\\` → full customization, same API.

## DX Scoring Rubric (0-10 calibration)

| Score | Meaning |
|-------|---------|
| 9-10 | Best-in-class. Stripe/Vercel tier. Developers rave about it. |
| 7-8 | Good. Developers can use it without frustration. Minor gaps. |
| 5-6 | Acceptable. Works but with friction. Developers tolerate it. |
| 3-4 | Poor. Developers complain. Adoption suffers. |
| 1-2 | Broken. Developers abandon after first attempt. |
| 0 | Not addressed. No thought given to this dimension. |

**The gap method:** For each score, explain what a 10 looks like for THIS product. Then fix toward 10.

## TTHW Benchmarks (Time to Hello World)

| Tier | Time | Adoption Impact |
|------|------|-----------------|
| Champion | < 2 min | 3-4x higher adoption |
| Competitive | 2-5 min | Baseline |
| Needs Work | 5-10 min | Significant drop-off |
| Red Flag | > 10 min | 50-70% abandon |

## Hall of Fame Reference

During each review pass, load the relevant section from:
\\\`${hallOfFamePath}\\\`

Read ONLY the section for the current pass (e.g., "## Pass 1" for Getting Started).
Do NOT read the entire file at once. This keeps context focused.`;
}
