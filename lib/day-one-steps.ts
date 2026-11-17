/**
 * day-one-steps — the day-one pass every plan review runs first (GST-2947).
 * One source for the `{{DAY_ONE_STEPS}}` block that /plan-ceo-review,
 * /plan-design-review and /autoplan render above their preamble, and for the
 * lean /autoplan reviewer's brief (lib/autoplan-lean.ts), so the four never drift.
 */
export const DAY_ONE_HEADING = '## Day one first (before any other step)';

export const DAY_ONE_STEPS = `1. Write a \`### Day one\` table in the plan with these columns: action | frequency | source | feature | route | first build | check. One row for each of the owner's first five actions, on day one and every day after.
2. \`source\` is the owner's own words or the owner's evidence (a calendar, past use). With neither, write \`assumed\`.
3. \`route\` is the taps from the first screen to the feature. \`first build\` is the first PR whose build has it. \`check\` is how we know it works on the owner's device.
4. Flag as High any daily row with no feature, no route from the first screen, or a first build later than a less frequent row's.
5. Schedule a build on the owner's own device right after the first PR. Say what it does and what it won't do yet.
6. No dead controls: every control in any build the owner receives works end to end or is hidden.
7. Interactive run: before filling rows from guesses, ask the owner about real past days, one question at a time ("What did you do with your calendar yesterday?"). Unattended run: leave unsourced rows \`assumed\`; they go to the approval gate as owner questions.
8. A plan nobody uses directly (a library, a backend job) writes one line naming who relies on it first and how, instead of the table.`;

export const DAY_ONE_BLOCK = `${DAY_ONE_HEADING}

Prove the plan is useful to its owner on the first day. Finish these steps before the review's own first step (CEO Step 0, design Pass 1, autoplan Phase 1), reuse the table when the plan already has one, and keep it current as the review changes the plan.

${DAY_ONE_STEPS}`;
