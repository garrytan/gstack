# Verdict-line replay: results (GST-2495)

We learned that Claude Opus 5.5 and GPT-6.1 Sol write the requested `REVIEW_VERDICT: blocking=<n>` line every time
they are asked (160 of 160 replies), and that the count matches gstack's own parse 96.9% of the time. You should
treat the line as a cross-check on the parser, not a replacement: checking it lost no blocker in 80 paired trials,
and where it disagreed, the parser had split or invented a row.

Preregistration: [verdict-line-replay-prereg.md](verdict-line-replay-prereg.md), frozen at commit b5d0abe before any
panel dispatch. All 240 dispatches ran once on 2026-11-14, with no errors, no `cyber_policy` refusals and no reruns.
API cost: $15.61.

## What worked

- **No blocker was lost.** G1 (the same reply under main's parse and the verdict parse): 0 of 160 treatment replies
  stopped blocking. G2 (each treatment trial against the same cell's control on the four blocker branches): 0 lost
  blockers in 80 trials, so the 95% upper bound on the loss rate is 3.8%. Both arms flagged a blocker in 80 of 80
  blocker trials (95% interval 95.4% to 100%). The planted file was named in a blocking row slightly more often
  with the ask (paired difference +3.7 points, interval -5.1 to +12.6, so no real difference).
- **The line is written reliably.** Compliance was 80/80 for each model (95.4% to 100%) and 16/16 in every model and
  family cell. No reply left the line out or wrote it malformed.
- **Agreement was high.** 155 of 160 valid lines matched the parsed blocking count (96.9%, interval 92.9% to 98.7%):
  Opus 78/80, Sol 77/80.

## What didn't, or wasn't shown

- **The five disagreements were parser errors, not reader errors.** Read by hand:
  - Three Sol native replies (b3-migration, b4-admin-route, c2-paginate) declared 1 blocker while the parser counted 2:
    a `### FIXABLE — …` heading and its trailing `| Severity: … | Blocks: yes` line collected as two rows. Both
    rows stay blocking, which is the safe direction.
  - One Opus red-team reply on b1-log-headers declared 1; the parser also counted a bold list item that explains the
    count ("**Blocking count:** this counts CRITICAL findings, so only the credential-logging issue blocks"). That
    phantom stays blocking too, because a bold-led list item is anchored.
  - One Opus red-team reply on clean c2-paginate declared 0 while its closing sentence ("I count only CRITICAL
    findings as blocking") collected as CRITICAL. This is the one contradiction, and the CAPY-1 shape: with the
    line, that row is a summary candidate the lead may lower with a reason, instead of an unexplained blocker.
- **The native FIXABLE lowering never fired in live replies, and it was removed after this run.** Today's native
  brief already asks for `Severity` and `Blocks` on every finding, and no reply wrote the FOUN-298 sentence shape.
  /ship's review of this PR then found a reply shape where that automatic lowering loses a real blocker, so the
  shipped code lowers nothing by itself: such rows become summary candidates the lead lowers with a written reason.
  Because the lowering fired 0 times in 160 replies, every figure above is the same under the shipped code.
- **No clean-diff improvement was shown.** Blocking rows per clean-branch reply: treatment 0.063, control 0.100;
  paired difference -0.037 (interval -0.111 to +0.036, 40 cells). The clean-branch blockers were almost all Sol
  judging that a `NaN` page size in c2-paginate blocks, in both arms; the line does not change a reader's judgment.

## Mechanics

- Panel: eight synthetic branches (four planted blockers, four clean), five brief families, two models, two treatment
  trials and one control trial per cell. Briefs were rendered by `gstack-review-dispatch render`, treatment from this
  branch and control from main 4bee369, and the 40 pairs are byte-identical apart from the two verdict sentences.
- Each dispatch was a direct API tool loop with one read-only bash tool in the branch's checkout (no keys in its
  environment, no network commands). This is not a Capy-hosted reader; the Codex CLI route was not measured.
- Secondary: on the relaxed review class, G1 was also 0 of 160.
- Harness, inputs, per-reply outputs and the full per-reply table are kept with the crew's handoff for GSTA-526.
