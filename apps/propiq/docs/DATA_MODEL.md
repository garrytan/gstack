# Data model

## Canonical hierarchy

```
City
└── MicroMarket
    └── Locality
        └── Project ──── Developer
            └── Phase   (RERA registration lives HERE, not on the project)
                └── Tower
                    └── UnitType
                        └── Unit
```

A `Property` is the aggregate root a buyer actually evaluates: a specific unit,
or a unit type within a project when no unit has been chosen. It is what the
Property Intelligence Page renders.

## India-specific decisions

These are not incidental; getting them wrong makes the product wrong.

**Area is quoted three ways.** Carpet, built-up and super built-up. The gap
between them *is* the negotiation. Every area carries an `areaBasis`, and
comparables are always adjusted onto a carpet basis before being compared.
`carpetPricePerSqFt()` is the only cross-project comparable price figure.

**RERA registration is per phase.** A project can have one registered phase and
one unregistered one. `project_phases` carries the registration, its validity
window and the portal URL. A registration that expires before the committed
possession date is a standing red flag and is scored as one.

**Possession dates slip.** We keep both `promised_possession` and
`current_possession`. The gap between them is a direct input to construction
risk — a project that has already slipped once usually slips again.

**Money is whole rupees.** `numeric(14,2)` in Postgres, integers in TypeScript.
Never floats for currency, never paise.

## Tables

### Reference data (world-readable, service-role writable)

| Table | Notes |
|---|---|
| `cities` | `coverage` gates whether a market is live, preview or planned |
| `micro_markets` | |
| `localities` | Market indicators, transit, social, environment; `employment` and `rent_history` as JSONB (variable-length, never joined on) |
| `locality_price_points` | One row per locality per month — queried as a series, so relational |
| `locality_pipeline` | Infrastructure items with a `pipeline_status` |
| `developers` | Delivery volume, delay record, litigation, complaints |
| `projects` | |
| `project_phases` | RERA + possession dates |
| `project_towers`, `unit_types` | |
| `properties` | The aggregate root; generated `search_vector` for full-text |
| `evidence` | Provenance for every material fact |
| `comparables` | Valuation inputs |
| `valuations`, `scores` | Stored runs, versioned, replayable |
| `valuation_backtests` | Estimate vs. what actually transacted |

### User-owned (RLS, owner-only)

`buyer_profiles`, `watchlist`, `portfolio_assets`, `alerts`,
`analysis_documents`, `document_findings`, `admin_audit_log`.

## Why relational, not a document dump

The instinct with heterogeneous property data is one `properties` table with a
big JSONB blob. We did not, because:

- **Foreign keys catch integrity bugs at write time.** A property pointing at a
  non-existent project fails the insert rather than producing an empty
  developer panel six screens later.
- **The filters are relational.** Price, bedrooms, locality and construction
  status are the actual search axes, and they want real indexes.
- **Evidence has to join.** `evidence.field` maps onto dotted paths in the
  domain model. That mapping only stays honest if the underlying columns exist.

JSONB is used where the data genuinely is document-shaped and is never filtered
on: `employment`, `rent_history`, `floor_plan`, and the full stored `payload`
on `valuations` and `scores`.

## Indexes

| Index | Serves |
|---|---|
| `properties_search_idx` (GIN) | full-text search |
| `properties_city_price_idx` | the default search: city + price band |
| `properties_locality_idx`, `properties_bedrooms_idx` | filter facets |
| `properties_status_idx` | the demo-exclusion predicate |
| `properties_listed_idx` | newest-first ordering |
| `evidence_property_idx`, `evidence_field_idx` | the evidence drawer |
| `comparables_subject_idx` | valuation input fetch |
| `locality_price_points_locality_idx` | the price series chart |

## Constraints worth naming

- `evidence_single_subject` — evidence attaches to exactly one of a property, a
  locality or a project. Ambiguous provenance is not provenance.
- `flood_risk`, `water_stress`, `confidence`, `source_trust` are all
  `between 0 and 1` at the database level, so a normalization bug cannot
  persist an out-of-range value.
- `completion_percent between 0 and 100`.
- `watchlist` is unique on `(user_id, property_id)` — saving twice is idempotent.

## Stored runs

`valuations` and `scores` each keep the methodology/scoring version plus the
full payload. That makes two things possible that matter for a measurement
product: any historical result can be re-explained under the rules that
produced it, and `valuation_backtests` can measure estimate accuracy against
what actually transacted.
