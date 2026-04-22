# Architecture Lenses

This file is the distilled architecture pack for `plan-arch-review`.

Use it to sharpen judgment, not to dump theory into the output.

## 1. ADR-lite

Every meaningful architecture review should answer:

- What decision was made?
- What serious alternatives existed?
- Why did this option win now?
- What signal tells us to roll it back?

If the plan cannot answer those four questions, it is under-specified.

## 2. C4-lite

Use the smallest diagram that makes the plan legible.

- **Context** when outside actors or external systems matter
- **Container** when the system spans app, worker, queue, DB, or third-party APIs
- **Component** only when a single container is internally non-trivial

Do not force all three. Use the lightest diagram that surfaces the risk.

## 3. Boundaries, Ownership, Coupling

Look for:

- one subsystem owning data that another subsystem mutates directly
- responsibilities split across multiple modules without a clear owner
- plans that introduce a new service to avoid a local refactor
- workflow logic leaking into controllers, routes, or views

Good architecture is often a boundary clarification, not a new abstraction.

## 4. Domain Modeling

On workflow-heavy plans, identify:

- bounded contexts
- domain events
- state transitions
- ownership seams

Questions to ask:

- What are the core states?
- What event moves the system from one state to another?
- Which subsystem is the source of truth?
- What should happen if an event is duplicated, late, or missing?

If the plan cannot answer those, it will likely produce muddy ownership and brittle behavior.

## 5. Async And Distributed Consistency

Only go deep when the plan actually includes async or cross-system work.

Look for:

- retries without idempotency
- at-least-once delivery without deduplication
- state changes and event publication without an outbox story
- multi-step workflows with no compensation path
- eventual consistency with no user-facing explanation

Do not cargo-cult:

- outbox is not required for a local-only synchronous feature
- saga is not required for a single database transaction
- queues are not automatically safer than synchronous work

## 6. Backpressure And Overload

Success can break a system just as effectively as bugs.

Check:

- what happens if producers outrun consumers
- whether retries multiply load during an outage
- whether a slow dependency causes a queue backlog
- whether there is any rate limiting, throttling, or load shedding
- whether expensive work happens on the request path by default

If the only overload strategy is "scale it later," call that out.

## 7. Operational Readiness

Ask:

- How will we know this is broken?
- What metric, trace, or log line will tell us first?
- Can we disable or roll back the risky path?
- Is there a staged rollout or feature-flag story?
- If an engineer is paged at 3am, is the plan still understandable?

Operational readiness is part of architecture, not post-launch cleanup.

## 8. Not Worth Adding

This skill should actively remove fake sophistication.

Common examples:

- splitting a service before ownership pressure exists
- adding saga/outbox for a small local CRUD change
- requiring distributed tracing before basic logs and metrics exist
- adding a queue because a request is "kind of long" without proving the sync path is the problem
- inventing a generic platform layer when one feature needs one clear module

Call these out plainly. Good architecture is often subtraction.

