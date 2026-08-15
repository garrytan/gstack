# Skillz UI — Future Concept

> **Status:** Concept / Prototype  
> **Owner:** Product Organisation  
> **Last updated:** 11 April 2026

---

## Summary

Skillz UI is a web-based delivery layer for GPN-Skillz — making the 54-skill library accessible to **non-technical users** across legal, risk, sales, product, and operations. It sits on top of the existing skills repo and can be deployed via Fast Track Studio.

The skills library works well for technical users via GitHub Copilot CLI. But most of the company — legal reviewers, risk analysts, sales teams, finance — can't use a terminal. Skillz UI solves this by wrapping skills in purpose-built web interfaces with guided forms, file upload, and formatted output.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Skillz UI                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │Legal Hub │ │Risk      │ │Sales     │  ...        │
│  │          │ │Console   │ │Toolkit   │             │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘            │
│       │             │            │                   │
│  ┌────▼─────────────▼────────────▼──────┐           │
│  │         Skill Router                  │           │
│  │  Loads SKILL.md as System Prompt      │           │
│  └────────────────┬─────────────────────┘           │
│                   │                                  │
│  ┌────────────────▼─────────────────────┐           │
│  │         LLM API Layer                 │           │
│  │  Claude / GPT / Gemini (swappable)    │           │
│  └──────────────────────────────────────┘           │
└─────────────────────────────────────────────────────┘
         ▲                          │
         │                          ▼
  ┌──────┴──────┐          ┌───────────────┐
  │ GPN-Skillz  │          │ Formatted     │
  │ Repository  │          │ Output        │
  │ (SKILL.md)  │          │ (tables, PDF) │
  └─────────────┘          └───────────────┘
```

**Key insight:** The SKILL.md files are model-agnostic prompt orchestration — they are the IP. The UI is just a delivery channel. Swap the model without rewriting a single skill.

---

## Proposed Modules

Each module maps to a **pack** from the pack system:

| Module | Pack | Primary Users | Flagship Skill | Priority |
|--------|------|---------------|----------------|----------|
| **Legal Hub** | `legal` | Legal, Procurement | contract-review | P0 — Prototype built |
| **Risk Console** | `risk`, `fraud-ops`, `credit-risk` | Risk, Fraud, Collections | risk-ops | P1 |
| **Sales Toolkit** | `sales`, `sales-operations` | Sales, Solution Consulting | go-to-market | P1 |
| **Product Studio** | `product` | PMs, Designers | product-manager, roadmap-plan | P2 |
| **Ops Centre** | `customer-operations` | Support, Onboarding | launch-readiness, support-ops | P2 |
| **Engineering Lab** | `engineering` | Engineers | deliver, plan | P3 (CLI-first) |

---

## What the UI Solves

| CLI Limitation | Skillz UI Solution |
|---|---|
| Requires terminal proficiency | Guided web forms — no CLI needed |
| Free-text input only | File upload (PDF, CSV), structured forms, dropdowns |
| Plain text output | Formatted tables, severity badges, exportable reports |
| No onboarding | Zero setup — open browser, pick a module |
| Skills discoverable only via docs | Visual module selector with skill descriptions |

---

## Prototype: Legal Hub

A working prototype exists demonstrating the contract-review skill as a web UI:

**Flow:**
1. User uploads a PDF contract
2. Selects review mode (summary, full review, risk flags, clause extraction, compare)
3. Selects their party role (customer, provider, buyer, etc.)
4. Clicks "Analyse Contract"
5. Gets formatted output:
   - Key facts panel (dates, term, value, risk score)
   - Plain-language summary
   - Obligations split by party
   - Findings with severity badges (red High / amber Medium / green Low)
   - "Question for Counsel" per finding
   - Notable absences checklist
   - Numbered next steps

**Tech stack:** Next.js 14 + Tailwind CSS + TypeScript  
**Integration:** skill-loader.ts reads SKILL.md files from the skills directory as system prompts  
**LLM layer:** Abstracted in llm.ts — provider-agnostic, supports model routing per skill type

**Validation:** The contract-review skill was tested end-to-end against a real Builder.io SaaS agreement. It correctly identified 8 findings across 3 severity levels, flagged an expired offer date, and generated counsel-preparation questions — all in under 2 minutes.

---

## Professional-Domain Guardrails

Regulated-domain modules (Legal Hub, Risk Console) inherit the **professional-domain convention** from GPN-Skillz:

- Every page displays a disclaimer: _"This tool augments — it does not replace — qualified professionals"_
- Skills include hard gates that require acknowledgement before proceeding
- Severity frameworks (High/Medium/Low) replace binary pass/fail
- Output always includes "Questions for [Professional]" sections directing users to experts
- No skill claims to provide legal advice, credit decisions, or fraud determinations

---

## Deployment Path

Skillz UI modules would be deployed via **Fast Track Studio** — the existing internal platform for tools and models. This means:

- No new infrastructure to provision
- Authentication and access control via existing GP SSO
- Pack-level access control: users only see modules for their team's pack
- Model access governed by existing Fast Track Studio model catalogue

---

## What's Needed to Move Forward

| Item | Detail |
|------|--------|
| **Front-end** | 1 engineer + 1 designer for Legal Hub pilot |
| **LLM API** | Claude or GPT-4 API access via Fast Track Studio |
| **Pilot group** | Legal/Procurement team (5-10 users) |
| **Success metrics** | Time-to-first-review under 5 min, counsel satisfaction score, repeat usage rate |
| **Decision** | Approve Legal Hub pilot, measure, prioritise next module |

---

## Iteration Notes

_Use this section to track decisions and iterations._

- **2026-04-11:** Initial concept and prototype created. Legal Hub demonstrates contract-review skill via web UI. Briefing document prepared.

---

> **Source code:** Prototype lives locally. Skills live in [GPN-Skillz](https://github.com/conor-redmond_glpay/GPN-Skillz).
