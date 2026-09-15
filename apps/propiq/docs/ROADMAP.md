# Roadmap

## Done

### Milestone A — production foundation ✓

Architecture docs · domain boundaries (lint-enforced) · Zod env validation with
a production fixture guard · canonical schema with FKs, constraints and indexes
· RLS on every user-owned table · evidence and provenance model · fixture/test
data separation · strict TypeScript, lint and test baseline.

### Milestone B — buyer intelligence vertical slice ✓

The full flow works end to end:

**Homepage → Search → Property Intelligence → Compare → Save → Dashboard**

Typed repository port · fixture adapter · production adapter contract · PropIQ
Score v0.1.0 · decision engine v0.1.0 · fair value with negotiation guidance ·
evidence panel · locality intelligence · persona weighting · auth · watchlist ·
analytics.

### P1 partial delivery ✓

Everything on the P1 list that was not blocked on a credential or a provider:

- **Buyer profile editor** (`/preferences`) — persona, budget, bedrooms,
  commute tolerance, carpet-efficiency floor, preferred localities. Feeds
  persona weighting and every buyer-fit signal, so search and the property
  page now score for *this* buyer. Proven by test, not just wired.
- **Portfolio** — add, list and remove assets, with equity, unrealised gain,
  annualised return and yields. Every figure labelled with where it came from.
- **Alerts** — eight rule families with published thresholds, evaluated live
  against the watchlist on page load.
- **Rate limiting** — fixed-window behind an interface, applied to the AI
  endpoint, standard `RateLimit-*` headers.
- **Copilot** — the full pipeline: intent, retrieval, deterministic figure
  selection, grounded context, injection fencing, synthesis, output guard.
  Refuses with a 503 rather than stubbing when no provider is configured.
- **Reports** — a frozen, versioned, printable intelligence report per property.

### The buyer journey, end to end ✓

Discover → Verify → Compare → Score → Analyze → **Visit → Negotiate** → Monitor.

- **Document checks** — 22 deterministic rules across sale deeds, encumbrance
  certificates, khata, agreements, RERA certificates and cost sheets. They run
  in the browser on typed input, so they work with no OCR provider and nothing
  ever leaves the page.
- **Site visits** — a 22-item checklist of things you can only learn standing
  there. Answers on mapped items become verified first-party evidence and move
  the score, which is the loop the product was missing.
- **Negotiation** — the offer sequence, guarded status transitions, and a
  walk-away price recorded before the first offer, which is the whole point.
- **Scheduled alerts** — an endpoint any cron can call.

## Next

### The exact next task

**Wire a Supabase project and run the migrations.**

Everything downstream is blocked on this, and it is mechanical rather than
design work:

1. Create a Supabase project; set `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
2. Apply `supabase/migrations/0001_canonical_schema.sql` and `0002_rls.sql`.
3. Run `supabase/verify-rls.sql` — it must print `RLS verification passed.`
4. Set `PROPIQ_DATA_ADAPTER=supabase` and confirm search returns empty (correct:
   no real data is loaded) rather than erroring.
5. Add a CI job that runs `verify-rls.sql` against an ephemeral database.

Acceptance: sign-up, sign-in and a persisted watchlist entry all work against a
real database, and cross-user isolation is verified by the script rather than
only by the static tests.

### Then, in order

**Ingest one real source.** RERA registrations for the launch market. This is
the highest-value integration: it is authoritative, it is public, and it turns
the legal pillar from a contract into a measurement. Until one real source
exists, every other feature is building on fixtures.

**Buyer profile editor.** Persona weighting and buyer-fit signals are built and
tested, but there is no UI to set a budget, a workplace or priorities. The
scoring engine already consumes the profile, so this is presentation work with
a large payoff: it turns a generic score into a personal one.

**Rate limiting.** Before any AI endpoint is exposed.

## P1

| Feature | Blocked on |
|---|---|
| Document OCR | An extraction provider. Checks already work on typed input |
| Alert delivery | A channel (email or webhook). The cron endpoint exists |
| Distributed rate limiting | A shared store. Needed before a second instance runs |
| Durable snapshot store | Supabase. The in-process store loses its baseline on restart |
| Maps | Provider decision (abstraction exists) |
| Floor-plan intelligence | CV provider; confidence labelling is non-negotiable |
| Copilot synthesis | `AI_PROVIDER` / `AI_API_KEY`. Everything around it is built |

## P2

Advisor workspace · lead scoring · CRM · site visits · negotiation workflow ·
offers · transaction state · billing · NRI workflows · admin.

## P3 — only after product-market evidence

B2B API · enterprise analytics · deeper computer vision · proprietary
forecasting · mobile apps.

**Not on the roadmap:** fractional investing. It needs a separate approved
regulatory and business workstream, not an engineering ticket.

## Geographic strategy

Bengaluru first, densely. The architecture is national — `cities.coverage`
gates what goes live, and nothing in the domain layer is city-specific — but
the data will not be, for a while.

The reasoning is not modesty. A measurement product that claims a hundred
cities and can only source thin data for ninety of them has broken its own
premise. Better to be undeniably right about one market.

## Scoring roadmap

v0.1.0 is deliberately conservative: linear normalization, published weights,
wide bands. It will get better when there is real data to calibrate against.

Sequence: ship v0.1.0 → accumulate `valuations` and `scores` rows → populate
`valuation_backtests` from observed transactions → calibrate normalization
against measured error → publish v0.2.0 as a **new version**, never an edit to
v0.1.0.

Confidence calibration is the metric that matters: when we say 70% confidence,
outcomes should land inside the band about 70% of the time. Nothing else in the
product is worth much if that number is wrong.
