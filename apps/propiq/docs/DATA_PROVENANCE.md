# Data provenance

The rule: **PropIQ never presents a figure it cannot source.**

This document is the contract. It is enforced in code by `src/domain/evidence`,
the adapter layer, the RLS policies, and `test/security.test.ts`.

## Classification

Every material fact carries exactly one `dataStatus`.

| Status | Meaning | Who may emit it |
|---|---|---|
| `verified` | Observed directly from a trusted source, re-checked within its freshness window | Production adapters |
| `derived` | Computed from verified inputs by a documented method | Domain engines |
| `estimated` | Modelled, with a confidence band. Never stated as fact | Domain engines |
| `demo` | Development fixture. Synthetic | **Fixture adapter only** |

## The evidence record

```ts
interface Evidence<T> {
  field: string;              // dotted path, e.g. "phase.rera.status"
  value: T;
  source: PropertySource;     // id, name, type, reference, trust 0..1
  observedAt: Instant;        // when the fact was observed
  effectiveAt?: Instant;      // when it takes effect
  lastVerifiedAt?: Instant;   // last re-check — drives staleness
  dataStatus: DataStatus;
  confidence: Unit01;
  methodologyVersion?: string;
  reviewState: ReviewState;   // unreviewed | machine_checked | human_verified | disputed
  disputed?: boolean;
}
```

## Confidence decay

A fact is only as good as its age, and facts age at wildly different rates. A
RERA registration stays informative for years; an asking price is stale in
weeks. Effective confidence is:

```
confidence × source.trust × 0.5^(age / halfLife) × (disputed ? 0.5 : 1)
```

| Source type | Half-life | Stale after |
|---|---|---|
| `registry` | 720 d | 545 d |
| `rera` | 540 d | 365 d |
| `government` | 365 d | 270 d |
| `user` | 365 d | 270 d |
| `transaction` | 240 d | 180 d |
| `survey` | 180 d | 120 d |
| `developer` | 120 d | 90 d |
| `partner` | 90 d | 60 d |
| `model` | 60 d | 45 d |
| `listing` | 45 d | 30 d |

Canonical values live in `src/domain/evidence/freshness.ts` and are rendered on
`/methodology` from that module, so the published table cannot drift.

## Missing data

**A missing fact is `undefined`. It is never a default.**

The scoring engine treats an absent signal as absent: the signal is dropped and
the remaining weights within its pillar are rescaled. A pillar with no data at
all returns `score: undefined` and is excluded from the composite, with its
weight redistributed.

This distinction is the whole point. "We measured it and it is bad" and "we did
not measure it" are different claims, and a product that conflates them is
lying in both directions.

Below 45% coverage or 35% confidence, PropIQ publishes **no score** and the
verdict becomes `INSUFFICIENT_EVIDENCE`.

## Demo data containment

Three independent layers, because one is not enough:

1. **Configuration.** `getServerEnv()` throws if `PROPIQ_DATA_ADAPTER=fixture`
   under `NODE_ENV=production`.
2. **Application.** The production adapter filters `data_status <> 'demo'` in
   the query, not after the fact, and declares `servesDemoData: false`.
3. **Database.** Every public RLS read policy excludes demo rows, so even a
   query that forgot the filter cannot serve one.

Plus a presentation rule: any surface rendering demo data shows
`DemoDataBanner`, which names the fixture explicitly. And an indexing rule: the
sitemap omits demo-backed pages entirely, so synthetic figures never reach
search results or AI answers.

`test/security.test.ts` fails CI if any of these regress.

## Commercial disclosure

Every property carries `CommercialRelationship`: developer relationship, paid
placement, commission possible. It renders next to the evidence, because it
belongs to the same question — what influenced what you are reading.

**No commercial field may modify the organic score.** This is enforced, not
merely stated: a test asserts that `scoring/engine.ts`, `scoring/signals.ts`
and `decision/engine.ts` contain no reference to any commercial field. There is
no code path by which a paid placement can move a score.

## Fixture policy

- Fixtures live only in `src/data/fixtures/`.
- Every record carries `dataStatus: 'demo'` and `FIXTURE_SOURCE.trust = 0.8`,
  so demo records never score as confidently as verified ones would.
- Developer, project, unit and transaction records are **invented**.
- Locality *names* are real Bengaluru localities, so the demo is navigable, but
  **every figure attached to them is synthetic**. This is stated in the fixture
  source, in the banner, and on `/data-sources`.
- Unit-test factories (`test/support/factories.ts`) are kept separate from the
  demo dataset. Tests need small hand-tuned inputs; the demo needs realistic
  records. Blurring them makes both worse.

## Integration status

No live Indian property feed is connected. The repository port, evidence model,
provenance rules and production adapter contract are built and typed, so
connecting a real source is an adapter implementation rather than a rewrite.
Per-source status is published at `/data-sources`.
