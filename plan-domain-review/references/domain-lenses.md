# Domain Modeling Lenses

Use this reference to sharpen the plan, not to inflate it.

## What good domain review catches

- vague business terms that mean different things in different parts of the plan
- entities with no clear owner
- workflows whose states are implied but never named
- background processes that mutate state without an agreed source of truth
- accidental coupling between concepts that should only communicate via interfaces or events

## Event storming, compressed

Start with verbs, not nouns.

Ask:

- what happened?
- what caused it?
- what changed because of it?
- who cares downstream?

Useful event examples:

- `InvoiceIssued`
- `PaymentCaptured`
- `TrialExpired`
- `SeatProvisioningFailed`

Red flags:

- naming everything as CRUD instead of business events
- no distinction between command, state change, and notification
- downstream systems depending on database details instead of declared events or APIs

## Bounded contexts

Bounded contexts are ownership seams, not just folders.

Look for:

- different meanings of the same term
- different teams or modules making conflicting changes
- one model trying to serve two incompatible workflows

Good context clues:

- pricing rules vs billing ledger
- customer support actions vs fulfillment pipeline
- catalog data vs search projection

The smallest useful output is often:

- context name
- what it owns
- what it publishes
- what it is allowed to read from elsewhere

## Aggregates and source of truth

Do not chase textbook aggregate design. Keep it practical.

Ask:

- what must stay consistent in one write?
- what can be eventually consistent?
- which system decides the canonical state?
- if two systems disagree, which one wins?

If those answers are missing, implementation will drift.

## State transitions

Every workflow-heavy plan should make state visible.

Minimal output:

- the important states
- how an item moves between them
- who or what can trigger the move
- what happens on failure or retry

If the workflow matters to users, the states should be named in the plan.

## CQRS sanity check

Most plans do not need CQRS.

Prefer a single write/read model unless one or more are true:

- read shape and write shape are genuinely divergent
- reporting/search projections are large enough to justify denormalized reads
- the write path has strict invariants but reads need different scaling
- audit/history requirements are central to the product

Do not recommend event sourcing just because events exist.

## Modular monolith pressure

When the repo is a monolith, favor module boundaries before service splits.

Good questions:

- can the boundary be enforced inside the monolith first?
- can cross-context communication be explicit without introducing network hops?
- does the team need service decomposition now, or only cleaner seams?

## Not worth modeling yet

Use this section to keep scope healthy.

Common examples:

- no CQRS for a simple CRUD admin flow
- no event sourcing when history can be captured in normal tables
- no separate domain service for trivial validation rules
- no new service when a module boundary inside the monolith is enough
