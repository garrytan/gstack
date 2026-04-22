# Modernization Lenses

Use this reference to keep migration plans reversible and honest.

## Modernization is choreography

A good plan answers:

- what exists now?
- what changes first?
- what coexists temporarily?
- when can the old path be removed?

If the plan jumps from "today" to "target state" with no transition state, it is not ready.

## Incremental over big bang

Default bias:

- modularize before extracting
- route a slice of traffic before all traffic
- add adapters before deleting legacy entry points
- prove behavior under coexistence before final cutover

Big-bang rewrites usually hide unknowns instead of reducing them.

## Strangler fig, compressed

The strangler pattern is about controlled interception:

- keep the old system serving
- carve out one boundary
- redirect one path at a time
- observe
- repeat

Useful outputs:

- which request or workflow is redirected first
- what remains in the old path
- how fallback works

## Modular monolith before microservice

Do not spend a network hop to solve an ownership problem you have not even named.

Favor a modular monolith first when:

- the team is small
- deploy independence is not yet the bottleneck
- data is deeply shared
- you mostly need cleaner boundaries, not independent runtime scaling

## Extraction boundaries

Choose boundaries where:

- ownership is already semi-coherent
- data coupling is lowest
- rollback can be local
- cross-boundary coordination is tolerable

Bad first extraction candidates:

- one shared junk drawer module
- flows with many synchronous dependencies
- areas where the team still disagrees on business ownership

## Migration hazards

Always check:

- mixed old/new behavior
- deploy order requirements
- dual writes or duplicate side effects
- schema drift
- stale caches during cutover
- missing observability during coexistence

If the plan does not say how the team will detect cutover failure, it is incomplete.

## Rollback points and cutover criteria

Every phase should answer:

- what success looks like
- how we know it is safe to proceed
- what condition triggers rollback
- what rollback actually does

Rollback must be operationally believable, not just emotionally comforting.

## Rewrite-in-disguise smell

Red flags:

- "we'll replace everything at once"
- no coexistence plan
- no adapter layer
- no rollback path
- test strategy deferred until after migration
- old system described only as "bad"

When you see this, say so plainly.

## Deferred legacy debt

A good modernization plan names what it is not fixing yet.

Examples:

- old admin screens left on the legacy path
- deprecated endpoints kept behind an adapter for one release
- database cleanup postponed until after traffic cutover

This keeps the migration honest and scope under control.
