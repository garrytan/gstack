# GPN Skillz — Acknowledgements

GPN Skillz stands on the shoulders of excellent open-source work. The majority of
the engineering workflow and web quality skills in this collection are adapted —
not written from scratch — from the projects below. We are grateful to these
authors for sharing their work under permissive licences.

---

## gstack — by Garry Tan and contributors

**Repository:** [github.com/garrytan/gstack](https://github.com/garrytan/gstack)
**Licence:** MIT

gstack is a comprehensive AI coding skills framework originally built for Claude Code.
It provides battle-tested workflows for code review, shipping, QA, investigation,
planning, and retrospectives.

**Skills adapted from gstack:**
- `/autoplan` — Implementation planning
- `/careful` — High-risk change validation
- `/checkpoint` — Progress checkpointing
- `/investigate` — Root cause analysis and debugging
- `/office-hours` — Async Q&A and knowledge sharing
- `/plan-ceo-review` — Strategic plan review (substantially modified with GP-specific content)
- `/plan-eng-review` — Engineering architecture review
- `/qa` — Quality assurance and testing
- `/retro` — Post-delivery retrospectives
- `/review` — Pre-landing code review (including specialist checklists)
- `/ship` — Production deployment workflow

**Contributors:** Garry Tan, Evan Solomon, Matt Van Horn, Lucas Braud, Diego Sens,
Malik Salim, and others.

**What we changed:** Removed gstack-specific templating, telemetry, and YC/startup
branding. Converted to GitHub Copilot CLI skill format. Standardised frontmatter.
Adapted for enterprise payments context. Fixed paths and binary references.

---

## web-quality-skills — by Addy Osmani and contributors

**Repository:** [github.com/addyosmani/web-quality-skills](https://github.com/addyosmani/web-quality-skills)
**Licence:** MIT

A set of focused web quality skills covering performance, accessibility, SEO, and
best practices — originally written for GitHub Copilot.

**Skills adapted from web-quality-skills:**
- `/accessibility` — WCAG compliance and inclusive design
- `/best-practices` — General web quality best practices
- `/core-web-vitals` — LCP, INP, CLS deep dives
- `/performance` — Runtime and loading performance
- `/seo` — Search engine optimisation
- `/web-quality-audit` — Full cross-dimension web quality audit

**Contributors:** Addy Osmani, Gwenaël Magnenat.

**What we changed:** Minimal adaptation needed — these were already in Copilot-compatible
format. Standardised frontmatter to match the rest of the collection. Fixed
cross-skill path references to use absolute paths.

---

## GPN Skillz originals

The following skills were created specifically for GPN Skillz and are not derived
from open-source projects:

- `/product-manager` — GP product management framework and coaching
- `/pdlc` — Product Development Lifecycle navigation (built from GP PwoW playbook)
- `/governance` — Governance ceremony preparation (built from GP PwoW playbook)
- `/plan-design-review` — GP pre-implementation design review
- `/design-review` — GP implemented experience review
- `/plan-devex-review` — GP developer-experience review
- `/privacy` — GP privacy-office review preparation
- `/braindump` — GP idea capture and creative intake workflow
- `/memory` — GP persistent recall and knowledge memory workflow
- `/customer-research` — GP customer discovery and research synthesis workflow
- `/business-case` — GP investment-case and funding-readiness workflow
- `/roadmap-plan` — GP roadmap planning and sequencing workflow
- `/launch-readiness` — GP go-live and rollout-readiness workflow
- `/merchant-onboarding` *(WIP)* — GP merchant activation and onboarding workflow scaffold
- `/settlement-readiness` *(WIP)* — GP settlement, reconciliation, and operational-readiness workflow scaffold
- `/security-threat-model` — GP security threat-model and review-preparation workflow
- `/security-controls` — GP security control design and ownership workflow
- `/pci-review` — GP PCI DSS scoping and control-review workflow
- `/incident-response` — GP incident coordination and response workflow

---

## Licence

The adapted skills retain their original MIT licence terms. GP-original skills are
for internal use within Global Payments.

If you use or adapt any of the open-source skills in your own collection, please
retain attribution to the original authors.
