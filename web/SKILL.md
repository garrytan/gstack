---
name: web
description: |
  Web quality and design review — performance, accessibility, SEO, design.
  Covers: design-review (post-build UI/UX quality review), accessibility
  (WCAG 2.2, screen readers, keyboard nav), performance (load times, bundle
  size, render blocking), core-web-vitals (LCP, INP, CLS), seo (meta tags,
  structured data, crawlability). Use for front-end quality assurance before
  or after launch.
  Trigger: "web quality", "accessibility review", "performance audit", "core web vitals", "SEO check", "design review".
allowed-tools:
  - Bash
---

# Web Quality Suite

You are a routing layer for the web quality skill tier. Read context to route
to the right sub-skill, or ask the user if unclear.

## Sub-skills

| Trigger | Sub-skill | When |
|---|---|---|
| "design review", "review this UI", "UX quality", "does this feel right", "post-build" | `design-review` | Review implemented UI/UX after build |
| "accessibility", "a11y", "WCAG", "screen reader", "keyboard navigation" | `accessibility` | WCAG 2.2 compliance audit |
| "performance", "slow", "load time", "bundle size", "speed up" | `performance` | Web performance optimisation |
| "core web vitals", "LCP", "INP", "CLS", "page experience" | `core-web-vitals` | LCP, INP, CLS deep dives |
| "SEO", "search ranking", "meta tags", "structured data", "crawl" | `seo` | Search engine optimisation |

## Routing

1. Infer the sub-skill from context above.
2. If unclear, ask via AskUserQuestion:
   - Design Review — post-build UI/UX quality
   - Accessibility — WCAG 2.2 audit
   - Performance — load time, bundle size
   - Core Web Vitals — LCP, INP, CLS
   - SEO — search ranking and crawlability
3. Read and follow the sub-skill's instructions exactly:

```bash
cat ~/.copilot/skills/web/{sub-skill-name}/SKILL.md
```

Then execute those instructions as if invoked directly.
