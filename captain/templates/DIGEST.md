# Digest (<CREW_NAME>) — <date time, timezone>

Rewritten at every controller turn. One line per row, newest first within a section,
every row with its thread and an age. Codes are the thread codes the host assigns.

## Needs you

<empty when the owner has nothing to do>

<CREW_NAME>
- A: <thread> hit problem <p>, which happens when <h>. We could fix it in these ways: 1) <x>; 2) <y>; 3) <z>. Recommendation: <x> because <why> (cost: <amount or none>; asked <age> ago). A1 to take recommendation.
- B: …

"do it" takes every recommendation above; a named option ("A2") takes that option instead. The
ask format is gstack docs/captain.md, The ask format.

## New

- <thread> · <age> · merged #<n> as v<X> (train <nonce>, slot <i>)
- <thread> · <age> · READY #<n> <sha12> (<--screen|--no-screen>), waiting for a train
- <thread> · <age> · train <nonce> built: <order>; gate dispatched
- <thread> · <age> · <incident: freeze, red base, backstop dispatched; what is being done>

## In progress

| Thread | Owns | State | Last report |
|---|---|---|---|
| <code> | <files or area> | <building / READY / train slot i / blocked on …> | <age> |

Stalls to act on: a lane with no report for longer than <N hours>, a READY older than
`FILL_HOURS` with no train, a slot call unanswered for longer than <N minutes>.
