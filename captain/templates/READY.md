# READY block

Sent by the lane: first the block exactly as `gstack-ship-queue ready --pr <n> --no-screen|--screen`
prints it, then the lane's own lines. The controller validates every field before the pin
enters `train build`. A missing or wrong field goes back to the lane, never into a train.

The tool's lines (shapes as printed; `screen:` is inserted as the second line under a train policy):

```text
READY #<n> <sha40> STAMP_VERSION=unstamped
screen: <screen|no-screen> policy=<selection> nonce=<nonce> run=<run id or ->
pr: <PR url>
head: <sha40>
version: unstamped
base: origin/<BASE>@<base sha40>
ci: green at <sha12> (passed=<k> failed=0 pending=0 skipped=<s>)
PREGATE: pass tree=<tree12> head=<sha12> checks=<c>
gate: command=<"…"|none> full_e2e=<yes|no> gate-ahead=<…>
SHIP_RECEIPT: pr=<n> head=<sha12> version=- base=<BASE> tree=<tree> session_kind=unattended …
READY_RECEIPT: <path the tool wrote> (<local and notes-ref detail>)
```

Under `changelog_fragments` (docs/ship-policy.md#changelog-fragments) the PR's entry is a
fragment, `changelog.d/<slug>.md`, never an `[Unreleased]` section or a version, and the
controller merges with `train land` or `land`, so no slot call follows this block.

The lane's own lines, after the block:

```text
pin: <sha40>                      # the full head SHA, restated
screen choice: <--no-screen: cases <ids> ran focused and passed | --screen: <reason>>
flaky: <none | case, both run ids, logged in the ledger on <date>>
review passes: <n> (deferred: <items filed as issues, or none>)
Head frozen from now on; a push drops this PR from any train and I will READY again.
```

Optional lines a crew's rules file may require:

```text
gate_run: <run id> tree=<tree12>        # when lanes gate on their own machines
closes: #<issue>
image: <URL of the key before/after image>
```

Refuse (send back) when: the SHA is short or a fork head; `SHIP_RECEIPT` reads `none` or
`invalid`, or its head is not the pin; `ci:` is not `green at` the pin; `PREGATE:` is not
`pass` for the pin's tree; `--no-screen` names no cases; a flaky case is not in the ledger;
the PR page is "green" but no block was sent; the evidence offered is a cheap tier.

After the slot call the lane answers with the stamped head:

```text
READY #<n> <stamped sha40> STAMP_VERSION=<X>
```
