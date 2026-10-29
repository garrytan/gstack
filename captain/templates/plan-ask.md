# Plan ask (shape B)

Relayed by the controller to the owner. Written for someone outside the project; no
gate codes in the body. `gstack-owner-brief render --captain --out <run dir>` prints this
shape from an autoplan run; write it by hand for any other plan.

```text
Decision needed on <thread>: <one-line title>. Reply **rec** to take every recommendation.

## ELI5
<5-10 plain sentences: what changes, for whom, and what it costs>

## Before → after
<what the user or maintainer sees today; what they will see after; a command and its
output, a screen, a cost or time number>

## Why it matters
<who is hurt today and how much, with numbers>

## What caused this work
<the trigger: an issue or PR link, a failed run, a user report, or the owner's words quoted>

## Big decisions
1. <decision>: options <a, b, c>; pick <b> because <why>; what would flip it: <condition>.
2. …

## What we need from you
<one decision>: <option 1> (<cost>) · <option 2> (<cost>) · our pick: <option>, reply **rec**.

**do it** = take every recommendation above at full scope, including <the follow-ons
named: docs, trains, cleanups>, and carry them through to done with no further ask.
```

When the answer comes back, record it before the work starts. For an autoplan gate:
`gstack-autoplan answer --out <run dir> --gate-rev <n> --reply <tokens> --rec-hash <h> --by agent:<thread> --owner-reply "<exact words>"`,
then `gstack-approvals import --autoplan <run dir> --by "<owner>"` (the tool records the relayer). For any
other plan: `gstack-approvals add --ask "<what>" --words "<exact words>" --by "<owner> (via <controller>)" --scope "<what it covers>"`.
