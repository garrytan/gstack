/**
 * Fixtures and per-arm prompts for the GSTA-228 planning-wave evals
 * (docs/TESTING_INTERNALS.md#no-gstack-arm). GSTACK_WAVE_ARM picks the arm:
 * `branch` reads this checkout's skill text, `main` reads the checkout at
 * GSTACK_WAVE_MAIN_ROOT (the merge base, prepared by the runner), `none` is
 * the same model and input with a plain prompt and no gstack text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type WaveArm = 'branch' | 'main' | 'none';
export const WAVE_ROOT = path.resolve(import.meta.dir, '..', '..');

export function waveArm(env: NodeJS.ProcessEnv = process.env): WaveArm {
  const arm = env.GSTACK_WAVE_ARM ?? 'branch';
  if (arm !== 'branch' && arm !== 'main' && arm !== 'none') throw new Error(`GSTACK_WAVE_ARM must be branch, main or none, got ${arm}`);
  return arm;
}

/** The gstack checkout whose skill text the arm reads; undefined for none. */
export function armRoot(arm: WaveArm, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (arm === 'none') return undefined;
  if (arm === 'branch') return WAVE_ROOT;
  const root = env.GSTACK_WAVE_MAIN_ROOT;
  if (!root || !fs.existsSync(path.join(root, 'office-hours', 'SKILL.md'))) throw new Error('GSTACK_WAVE_ARM=main needs GSTACK_WAVE_MAIN_ROOT, a checkout of the merge base');
  return root;
}

/** The text from `start` up to (not including) `end`; throws when either anchor is missing. */
export function excerpt(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = a < 0 ? -1 : text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`excerpt anchors not found: ${JSON.stringify(start)} .. ${JSON.stringify(end)}`);
  return text.slice(a, b).trimEnd();
}

// G1 planted facts: four errors and one correct claim, each scored separately.
export const BILLING_TS = `// Card charging for the Acme invoicing service.
import { gateway } from './gateway';

export async function chargeCard(customerId: string, cents: number) {
  return gateway.charge({ customerId, cents, idempotencyKey: \`\${customerId}-\${cents}\` });
}

export const BILLING_CONFIG = {
  currency: 'usd',
  timeoutMs: 8000,
  // Retries for transient gateway errors.
  retries: 3,
};
`;

export const PLANTED_DOC = `# Design: nightly invoice retries

## Problem
Failed card charges are never retried, so roughly 2% of invoices stay unpaid until a person notices.

## Recommended Approach
1. Reuse the existing charge path: \`src/billing.ts:4\` exports \`chargeCard(customerId, cents)\`, which the retry job calls unchanged.
2. Refund reversals stay in \`src/ledger.ts\`, which already handles refunds, so the retry job never touches refunds.
3. The job keeps the gateway retry budget as is: \`src/billing.ts:12\` sets \`retries: 5\`.
4. The job lists the commits that touched billing with \`git log --since-commit <sha> -- src/billing.ts\` and posts them to the run log.
5. Capacity: 3 workers each retry 40 invoices per minute, so the job clears 160 invoices per minute, enough for the nightly backlog of 9,000 in under an hour.

## Success criteria
Unpaid invoices from transient failures drop below 0.2% within a month.
`;

export const PLANTED_ERRORS = {
  missing_file: 'src/ledger.ts does not exist in the repository (the doc says it already handles refunds)',
  bad_flag: 'git log has no --since-commit option',
  bad_math: '3 workers x 40 per minute is 120 per minute, not 160',
  wrong_content: 'src/billing.ts:12 sets retries: 3, not 5',
} as const;
export const PLANTED_CONTROL = 'src/billing.ts:4 exports chargeCard(customerId, cents) (this claim is correct)';

export const PLAIN_REVIEW_PROMPT = (doc: string, verdict: string) =>
  `Review the design document at ${doc} before it is built. The repository it describes is the current directory. Write your findings to ${verdict} as JSON: {"findings": [{"text": "...", "severity": "blocking|minor"}]}.`;

// G3 schema: one plan, a queried JSON column and a JSON document read and written whole.
export const SCHEMA_PLAN = `# Plan: subscription tiers

We are adding three tiers (free, team, enterprise) to the Acme notes app (Postgres, Rails).

## Data
- Store everything about an account's tier in one new JSONB column, \`accounts.tier_config\`, for example
  \`{"tier": "team", "seat_limit": 25, "sso": false, "price_cents": 1200}\`. One column keeps the diff to a single migration.
- Store each user's editor preferences in a new JSONB column, \`users.ui_prefs\`, for example
  \`{"kind": "editor", "theme": "dark", "font_size": 14, "keymap": "vim"}\`. The settings page loads the whole object and saves the whole object; nothing queries or filters on its fields.

## Queries the product needs
- Admin dashboard: list every account whose tier includes SSO.
- Seat enforcement: refuse an invite when the account's member count would pass its seat limit.
- Pricing change: update the price of the team tier for every team account at once.

## Out of scope
Billing provider integration.
`;

export const PLAIN_SCHEMA_PROMPT = 'Review the plan in PLAN.md as an engineering reviewer. Give your architecture and data-model findings, each with a concrete recommendation.';

// G2 rerun: the earlier eng-review list holds one open task and one shipped task.
export const PRIOR_RUN = '20261030T100000Z-4242';
export const RERUN_FINDINGS = `Findings from this review:
1. Architecture: the webhook sender still has no retry; a single 5xx drops the event. (Same gap as the last review.)
2. Code quality: the rate limiter reads RATE_LIMIT_PER_MIN without validating it; a typo turns limiting off.
Last review's metrics task shipped in the commit "Add metrics counters for the webhook sender (T2)".`;

export const PLAIN_RERUN_PROMPT = (dir: string) => `You are finishing an engineering review of this repository's plan. ${RERUN_FINDINGS}

An earlier review on this branch left its task list in ${dir}. Write this review's task list as a JSONL file in ${dir}, reconciling the earlier list so only one current list remains there.`;

// G4 closing: a fixed session with three founder signals (a named user, revenue, a reasoned pushback).
export const SESSION_TRANSCRIPT = `[Phase 1] Founder: I'm building intake software for small physical-therapy clinics. Dr. Anita Patel at Riverside PT spends 40 minutes a day retyping intake forms.
[Phase 2] Founder: Riverside is already paying me $400 a month for the pilot, and two more clinics asked for it last week.
[Phase 3] Me: Premise 2 says clinics will switch EHRs for this. I think they won't.
[Phase 3] Founder: I disagree. I don't need them to switch: the intake form exports to their existing EHR through its fax import, which every clinic I've visited still uses.
[Phase 4] Founder: I'll ship the fax export first and keep the form editor rough.
[Phase 4.5] Founder signals counted: 3 (named a specific user, demand evidence with revenue, pushed back with reasoning).`;

export const SESSION_SIGNALS = ['Dr. Anita Patel at Riverside PT (named user)', '$400 a month pilot (revenue)', 'fax import pushback (reasoned disagreement)'] as const;

export const PLAIN_CLOSING_PROMPT = `Here is the transcript of a product office-hours session with a founder:

${SESSION_TRANSCRIPT}

Write the short closing note you would give this founder about whether they should consider applying to Y Combinator. Write the note only; do not ask questions or run tools.`;
