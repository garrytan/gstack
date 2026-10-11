/**
 * coordinator-contract — the block every lane prompt inherits word for word
 * (plan E2). A coordinator thread that runs several lanes states its merge
 * conditions, behavior-change notices, spend caps and handoff format once;
 * the `{{COORDINATOR_CONTRACT}}` resolver renders this text into the plan
 * template, `bin/gstack-autoplan` prints it into every reviewer prompt
 * (lib/autoplan-prompts.ts writePrompts), and `gstack-autoplan contract`
 * prints it for a parent that writes its own lane prompts. One source, no
 * paraphrase: test/coordinator-contract.test.ts pins that the three outputs
 * are byte-identical.
 */
export const COORDINATOR_CONTRACT_HEADING = '## Coordinator contract (inherited by every lane)';

export const COORDINATOR_CONTRACT = `${COORDINATOR_CONTRACT_HEADING}

Merge conditions. A lane's PR merges only when: the required gate lanes are green on the stamped tree or the tree receipt says \`gate-reuse: eligible\`; \`gstack-lane-check\` reports \`clear\` for its planned files against every other open lane; the PR body opens with the \`gstack-ship-receipt\` block; and the coordinator, not the lane, says merge. A lane never merges, rebases another lane, or force-pushes.

Behavior-change notices. Every user-visible behavior change outside the plan's own items is listed in the PR body under \`## Behavior changes\` with the file, the old behavior and the new one, before the review starts. An omitted change found in review is a CRITICAL finding, whatever its size.

Spend caps. Each lane runs under the \`--spend-cap\` the coordinator names; a lane that reaches it stops with \`status=budget_exhausted\` and reports spent, reserved and unknown charges. Paid evals are never retried to change a verdict; a rerun needs a named repair. Host-subagent spend is reported as \`unknown\`, never zero.

Handoff format. A lane reports in this order, identifiers first: PR URL (or \`no PR\` with branch and SHA), \`GSTACK_RESULT\` line, gate summary (lanes passed/failed/skipped), behavior changes (or \`none\`), spend (spent/reserved/unknown), then what it could not verify. Full thread ids (\`jam_…\`), never short codes, in every cross-thread message. Prose after the identifiers may be truncated; nothing before them may be.`;
