# Preregistration: the reviewer verdict line, no-loss and compliance replay (GST-2495)

Frozen before any panel dispatch, on 2026-11-13. This is the no-loss replay that docs/review-policy.md requires for a
change to reviewer prompts, and the evidence that the change helps on frontier models. The change under test is
[the verdict line](../review-policy.md#verdict-line): every blocking reader's brief asks for one
`REVIEW_VERDICT: blocking=<n>` line, and collect checks that count against the findings it parses.

## Question

Does asking blocking readers for the line lose any blocker, and do Claude Opus 5.5 and GPT-6.1 Sol write the line
correctly when asked?

## Panel

A small synthetic TypeScript service, built by `fixture.sh` (public-safe, no real project data), with eight branches
off `main`. Four plant a real blocker, one per failure family the old prose parser lost or invented:

| Branch | Planted defect | Tree |
|---|---|---|
| b1-log-headers | Logs every request header, including `Authorization` (secret leak) | da7d95ef |
| b2-cache-key | The review cache key drops the tree, so one tree's review is served for another | d0053de2 |
| b3-migration | Deletes the old rows before the copy, outside the transaction (data loss) | c7828803 |
| b4-admin-route | A new delete-user admin route skips `requireAdmin` | 2cff15ff |
| c1-rename | Clean: renames `plural` to `pluralize` with its test | d5716f57 |
| c2-paginate | Clean: paginates the notes list with a clamped page size | 35fd32e3 |
| c3-format | Clean: `formatBytes` learns gigabytes, with a test | 983a820e |
| c4-forbidden-text | Clean: a clearer 403 body and a doc comment | a4e91e29 |

Every branch's own tests pass.

## Readers, models and arms

- Five brief families: adversarial-native, outside-voice, specialist (rendered as specialist-batched with the
  security, data-migration, testing and performance checklists; specialist and targeted share its section body),
  red-team (the specialists' findings slot says they found nothing) and fix-check (the fix list names an earlier
  finding that the branch's one commit fixes; on a blocker branch that fix introduces the planted defect).
- Briefs are rendered by `gstack-review-dispatch render`: treatment with this branch's binary, control with main's
  (4bee369). `compare-briefs.ts` proves the 40 pairs are byte-identical apart from the two verdict sentences.
- Models under test: `claude-opus-5-5` (Anthropic Messages API, adaptive thinking, effort high) and `gpt-6.1-sol`
  (OpenAI Responses API, reasoning effort high, stateless). Each dispatch is a tool loop with one bash tool run in that
  branch's checkout with an environment holding no keys and no network commands, at most 40 tool calls, 16,000
  output tokens per turn.
- Per cell (family x branch x model): 2 treatment trials and 1 control trial. 5 x 8 x 2 x 3 = 240 dispatches, in an
  order shuffled with seed 2495, 8 at a time.
- A model under test is never swapped. A `cyber_policy` refusal is recorded as a result and is not retried on another
  model. Transport errors (HTTP 429, 5xx, network) retry up to three times inside one dispatch; that is not a rerun.
- The run happens once. If the process dies, a restart completes only the dispatches with no recorded result. The
  AGENTS.md single rerun applies only to a red rule case, and none of these metrics is a model judge.

## Scoring (mechanical, `analyze.ts`; no model judge, so the R78 judge check does not apply)

Every reply is parsed by this branch's `parseReply` on the gate class (FIXABLE raises), the strictest setting for
the native lowering. "Main's parse" is `parseReply` with no ask, which the corpus identity test pins to main's output.
A blocking row is a row at CRITICAL with no `Blocks: no` of its own; summary candidates still count, because they block
until lead judgment lowers them with a written reason.

Pass rule, both required:

1. **G1, mechanism no-loss:** no treatment reply that blocks under main's parse has zero blocking rows under the verdict
   parse. Replies whose only blocking rows became summary candidates are listed and read by hand.
2. **G2, arm no-loss (the Captain's rule):** on the four blocker branches, no treatment trial has zero blocking rows
   when the same cell's control trial has at least one. Each loss is labelled mechanism (G1 fails on it too) or reader
   miss, and any loss fails the rule.

With zero losses over N = 80 blocker treatment trials, the 95% upper bound on the loss rate is 3/80, about 3.8%. That
is the smallest loss rate this panel can rule out.

Reported, not gating, each with a 95% interval (Wilson for proportions, a paired normal interval for differences):

3. Compliance: valid lines over treatment replies, per model and family (16 replies per cell, about +/-20 points) and
   per model (80 replies, about +/-9 points). Under 80% on a model is a FIX-METHOD finding for the wording.
4. Agreement: lines whose count matches the parsed blocking rows, over valid lines.
5. Contradictions: valid `blocking=0` lines on replies that block under main's parse, each read by hand.
6. Clean branches: blocking rows per reply, treatment mean minus control, paired by cell (40 cells), and the share
   of replies with any blocking row.
7. Secondary: G1 on the relaxed class.

Not measured: the Codex CLI outside-voice route, the targeted reader's class-specific brief, and readers on a Capy
machine (this harness calls the APIs directly with the same rendered brief bytes and a read-only shell).

R44: there is no no-gstack arm, because the line exists only inside gstack's dispatch; this compares two gstack briefs.

## Budget

Up to $260 of API spend, granted by the Captain. The runner stops starting dispatches at $245. Two smoke dispatches
on panel cells, written to a separate directory and excluded from the results, cost $0.10.

## Frozen inputs (sha256)

| File | sha256 |
|---|---|
| fixture.sh | b18009fa0b9542ca04a94407472ec616ffa68d33626e8c25ef314a7f8fa0db3a |
| inputs.sh | 52c391f3855e9e7fe5556ec2d3e171430aa63b0e0448a40661491781591393d8 |
| render.sh | 445dbd7441a3e31dc20977017aa2c4fb712c753971c42cf3168f7a135ee0c174 |
| compare-briefs.ts | 129c22082d9e16042687a50798eef7582c02b6eb9e8910097472db6b3b3c6e83 |
| run.ts | 7a5cf31b3731a14afc3a508173b9baac11abc782f84df51f70b1b69f2c95bdfe |
| analyze.ts | 536349ef42f57b75589d9ca94ed8f1ee8d8a0aa4a015e341a5752fd1300486ef |

The harness files are kept with the results.
