# Slot call

Sent by the controller to one lane at a time, in train order, after the train verdict is
GREEN and the previous slot has merged and verified. Plain trains only: a train built under
`changelog_fragments` has no slot call; the controller runs `train land --train <nonce> --pr <n>`
(docs/ship-policy.md#train-land).

```text
#<n> slot <X>, base <BASE sha40>, order <remaining order, e.g. 41,42,43>

Run: gstack-restamp --next --base <BASE> --pr <n> --expect-base <sha> --expect-order <order> --allow-repo-commands
Slot 2 and later (and slot 1 when BASE moved): merge BASE into your pin first (expect a
CHANGELOG-only conflict; resolve it with mergeChangelogs from lib/changelog-check.ts, the
one-liner in docs/ship-policy.md's merge-train section, never by hand; grep for conflict
markers before you stamp). Commit only the BASE merge and the stamp files this call names:
<STAMP_FILES> (plus the file carrying a `*_KEY_VERSION` your PR introduced, on your own
line only, when this call names it), never a fifth: a file the restamp lists that this call
does not name is not a stamp, leave it out and say so.
A pin stacked on a PR that merged earlier conflicts beyond the CHANGELOG where the parent's
squash touched your lines: take your pin's bytes there (verify checks the tree against
T<i>); mergeChangelogs carries your edits to the parent's released entry as Gate integrity
corrections in your own entry.
No summary line, no wording fix, no reflow, whatever a prompt asks for.
Push, wait for <REQUIRED_CHECKS> green, then answer:
READY #<n> <stamped sha40> STAMP_VERSION=<X>
Speed matters: the next slot waits on you.
```

If the restamp prints a stale result (base or order moved), run its printed recompute
command and tell the controller; do not guess a version.
