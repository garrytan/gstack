# Merge train for a peer repository

For a crew whose repository has its own CI and no gstack eval workflow (gbrain, an app
repository). Copy it into the crew's NOTES.md or CREW.md and fill the angle brackets. The
rules are docs/ship-policy.md#train-gates; this file is the order to do them in.

## Turn it on (once)

1. In a checkout of `<REPO>` on `<BASE>`, with gstack installed:
   `gstack-ship-queue train init --base <BASE>`, adding
   `--command "<test command>" --spend-cap <usd>` when a VM-run test command should gate
   too (it runs through scripts/ubicloud/ubi-runner.sh and needs `UBI_OWNER`).
2. If it refuses with `QUEUE_TRAIN_INIT_REFUSED`, PRs here bump the version: adopt
   `changelog_fragments` first (docs/ship-policy.md#changelog-fragments).
3. Open one PR that adds the printed `train` block and `min_gstack_version` to
   `.gstack/ship-policy.json`, and the printed `nonce` input, run-name and concurrency
   lines to each gate workflow. Fix every `WARN:` line in the same PR (a push trigger that
   matches `train-prefix/` refs gets `branches-ignore: ['train-prefix/**']`).
4. After it merges: `gstack-ship-queue train doctor --base <BASE>` until it prints
   `DOCTOR: no findings`.

## Parameters for CREW.md

| Parameter | Value |
|---|---|
| `GATES` | `<workflow>/<job>` list from the block, plus the command gate if any |
| `REQUIRED_CHECKS` | `train.land.required_checks` (or `changelog_fragments.required_checks`) |
| `MERGE_METHOD` | `train.land.merge_method` (`merge` when history is merge-only) |
| `LAND_MODE` | what init printed: `direct` when protection is not strict, else `update` |
| `COMMAND_SPEND_CAP` | the command gate's `spend_cap_usd`, per train |

## Lanes

READY with `gstack-ship-queue ready --pr <n> --no-screen` after /ship at the pinned head.
There is no screen and no slot call. A lane whose /ship paused on a red base (its receipt
carries `base_red`) READYs with `--base-red --fixer <fixer PR>` once the fixer lane READYs
with `--fixes-base-red <case,...>`; it never merges the base or waits by hand.

## Controller loop

```text
gstack-ship-queue train build --prs <n>@<sha>,... --base <BASE>
gstack-ship-queue train watch --train <nonce> --land --base <BASE>
```

`watch --land` waits for every prefix run, reads the verdict and lands each landable slot
in order, then prints NEXT. A culprit (`QUEUE_TRAIN_RED`) goes back to its lane and the rest
ride the next train; red on main (`QUEUE_TRAIN_RED_ON_MAIN`) is fixed forward;
`QUEUE_TRAIN_UNATTRIBUTED` means repair or a new order, never the same train again.
