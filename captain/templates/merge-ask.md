# Merge ask (shape C)

What every PR body carries when it is READY, and what the controller's merge report to
the owner shows. /ship writes the PR body in this shape on Capy; the controller checks
it before training the PR.

```text
## What changed
![<caption: what changed and why>](<before/after image URL from the host's PR asset tool>)
<one to three images, highest-signal first; a collapsed text version under each>

## Why
<the problem in the person's words first, then the cause and the user-visible effect, two or three sentences>

## Blast radius
<what else the change touches and the one fact that makes that safe, with the evidence-ladder rung reached>

## Approvals
<the table from gstack-approvals render>

## Evidence
checks: <REQUIRED_CHECKS> green at <sha40> · gate/train: <GREEN with FLAKY N | screen result> ·
flaky: <cases, both runs, ledger date | none> · pregate: pass tree=<tree12>
```

The controller's merge report: the PR link, the key image inline, the version it will
take, the slot, and, if a decision is attached, its lettered line in the ask format
(gstack docs/captain.md): "A: … Recommendation: x because why. A1 to take recommendation."
If the merge needs the owner to act (approve a deployment, grant access), the line carries
the exact link to that page and numbered steps in the simplest words, ending with the one
word to reply when done (a Capy app page: its exact path and field instead of a link).
