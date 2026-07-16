import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
  setupPlanEngReviewFixture, matchesUnnegated, planEngReviewDataModelPrompt,
} from './helpers/e2e-helpers';
import { judgePosture } from './helpers/llm-judge';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-plan');

// --- Plan CEO Review E2E ---

describeIfSelected('Plan CEO Review E2E', ['plan-ceo-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    // Init git repo (CEO review SKILL.md has a "System Audit" step that runs git)
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a simple plan document for the agent to review
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add User Dashboard

## Context
We're building a new user dashboard that shows recent activity, notifications, and quick actions.

## Changes
1. New React component \`UserDashboard\` in \`src/components/\`
2. REST API endpoint \`GET /api/dashboard\` returning user stats
3. PostgreSQL query for activity aggregation
4. Redis cache layer for dashboard data (5min TTL)

## Architecture
- Frontend: React + TailwindCSS
- Backend: Express.js REST API
- Database: PostgreSQL with existing user/activity tables
- Cache: Redis for dashboard aggregates

## Open questions
- Should we use WebSocket for real-time updates?
- How do we handle users with 100k+ activity records?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-ceo-review skill
    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose HOLD SCOPE mode. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-ceo-review',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review', result);
    recordE2E(evalCollector, '/plan-ceo-review', 'Plan CEO Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // Accept error_max_turns — the CEO review is very thorough and may exceed turns
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Plan CEO Review (SELECTIVE EXPANSION) E2E ---

describeIfSelected('Plan CEO Review SELECTIVE EXPANSION E2E', ['plan-ceo-review-selective'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-sel-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add User Dashboard

## Context
We're building a new user dashboard that shows recent activity, notifications, and quick actions.

## Changes
1. New React component \`UserDashboard\` in \`src/components/\`
2. REST API endpoint \`GET /api/dashboard\` returning user stats
3. PostgreSQL query for activity aggregation
4. Redis cache layer for dashboard data (5min TTL)

## Architecture
- Frontend: React + TailwindCSS
- Backend: Express.js REST API
- Database: PostgreSQL with existing user/activity tables
- Cache: Redis for dashboard aggregates

## Open questions
- Should we use WebSocket for real-time updates?
- How do we handle users with 100k+ activity records?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-selective', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose SELECTIVE EXPANSION mode. Skip any AskUserQuestion calls — this is non-interactive.
For the cherry-pick ceremony, accept all expansion proposals automatically.
Write your complete review directly to ${planDir}/review-output-selective.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-ceo-review-selective',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review (SELECTIVE)', result);
    recordE2E(evalCollector, '/plan-ceo-review-selective', 'Plan CEO Review SELECTIVE EXPANSION E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const reviewPath = path.join(planDir, 'review-output-selective.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Plan CEO Review SCOPE EXPANSION energy (V1.1 mode-posture regression gate) ---

describeIfSelected('Plan CEO Review Expansion Energy E2E', ['plan-ceo-review-expansion-energy'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-exp-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Use the shared fixture so expansion-energy regressions are reproducible.
    const fixture = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'mode-posture', 'expansion-plan.md'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planDir, 'plan.md'), fixture);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-expansion-energy', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose SCOPE EXPANSION mode. Skip any AskUserQuestion calls — this is non-interactive. Auto-approve the ideal-architecture approach in 0C-bis. For 0D, run all three analyses (10x check, platonic ideal, delight opportunities), then emit exactly 2 concrete expansion proposals in the opt-in ceremony.

Write your expansion proposals to ${planDir}/proposals.md with ONLY the proposal text — no conversational wrapper, no review summary, no mode analysis. Each proposal separated by "---".`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-ceo-review-expansion-energy',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-ceo-review (EXPANSION ENERGY)', result);
    recordE2E(evalCollector, '/plan-ceo-review-expansion-energy', 'Plan CEO Review Expansion Energy E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // Transient API failure escape hatch — see /plan-review-report for the
    // full rationale. Same shape: error_api with 0 turns means the API call
    // never reached the model, so nothing the test verifies could have run.
    if (result.exitReason === 'error_api' && result.costEstimate?.turnsUsed === 0) {
      console.warn('[transient] /plan-ceo-review-expansion-energy: error_api with 0 turns — treating as inconclusive');
      return;
    }
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const proposalsPath = path.join(planDir, 'proposals.md');
    if (!fs.existsSync(proposalsPath)) {
      throw new Error('Agent did not emit proposals.md — expansion energy eval requires proposal output');
    }
    const proposalText = fs.readFileSync(proposalsPath, 'utf-8');
    expect(proposalText.length).toBeGreaterThan(200);

    const scores = await judgePosture('expansion', proposalText);
    console.log('Expansion energy scores:', JSON.stringify(scores, null, 2));
    // Pass threshold: 4/5 on both axes (good — matches posture with minor weakness).
    expect(scores.axis_a).toBeGreaterThanOrEqual(4);  // surface_framing
    expect(scores.axis_b).toBeGreaterThanOrEqual(4);  // decision_preservation
  }, 600_000);
});

// --- Plan Eng Review E2E ---

describeIfSelected('Plan Eng Review E2E', ['plan-eng-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-eng-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a plan with more engineering detail
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Migrate Auth to JWT

## Context
Replace session-cookie auth with JWT tokens. Currently using express-session + Redis store.

## Changes
1. Add \`jsonwebtoken\` package
2. New middleware \`auth/jwt-verify.ts\` replacing \`auth/session-check.ts\`
3. Login endpoint returns { accessToken, refreshToken }
4. Refresh endpoint rotates tokens
5. Migration script to invalidate existing sessions

## Files Modified
| File | Change |
|------|--------|
| auth/jwt-verify.ts | NEW: JWT verification middleware |
| auth/session-check.ts | DELETED |
| routes/login.ts | Return JWT instead of setting cookie |
| routes/refresh.ts | NEW: Token refresh endpoint |
| middleware/index.ts | Swap session-check for jwt-verify |

## Error handling
- Expired token: 401 with \`token_expired\` code
- Invalid token: 401 with \`invalid_token\` code
- Refresh with revoked token: 403

## Not in scope
- OAuth/OIDC integration
- Rate limiting on refresh endpoint
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-eng-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-eng-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on architecture, code quality, tests, and performance sections.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review', result);
    recordE2E(evalCollector, '/plan-eng-review', 'Plan Eng Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Plan Eng Review Data-Model Bias Regression E2E ---
//
// Regression test for the data-model bias fix: verifies that /plan-eng-review
// recommends a separate model instead of inlining columns + JSONField when
// a plan tries to merge polymorphic variant data into an existing model "to
// keep the diff right-sized." Before the fix, the skill's "right-sized diff"
// preference pushed the AI toward accepting the inline approach; after the
// fix, the data-model exception bullet + Data model review checklist should
// make the AI push back and recommend normalization citing SRP/3NF.

describeIfSelected('Plan Eng Review Data-Model Bias E2E', ['plan-eng-review-data-model-bias'], () => {
  let planDir: string;

  beforeAll(() => {
    // Synthetic plan designed to trip the old bias: four clearly-polymorphic
    // tier variants + feature-flag bag that the user proposes to inline onto
    // User rather than create a new model. After the fix, the skill should
    // recommend a separate SubscriptionTier model and push back on the
    // JSONField for tier_features.
    planDir = setupPlanEngReviewFixture('skill-e2e-plan-eng-dmb-', `# Plan: Add Subscription Tiers to User Model

## Context
I want to add a 'subscription tier' feature to my Django app. Each user can
be on a free, basic, premium, or enterprise tier. Each tier has:
- a monthly price
- a feature set (list of feature flags)
- a max-users limit
- an SLA tier (none / standard / premium)

## Current state
The User model has ~15 fields (email, name, created_at, etc).

## Proposed changes
I'm thinking of just adding these columns directly to the User model so I
don't have to deal with another table:

- tier_name: CharField with choices=['free', 'basic', 'premium', 'enterprise']
- tier_price: DecimalField
- tier_features: JSONField (list of feature flag strings, varies per tier)
- tier_max_users: IntegerField
- tier_sla: CharField with choices=['none', 'standard', 'premium']

This keeps the diff minimal — no new model, no new migration beyond the one
column-add, no new FK navigation in the codebase.

## Open questions
- Should feature flags be a separate table or stay as JSONField?
- Any concerns with this approach?
`);
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-data-model-bias', async () => {
    const result = await runSkillTest({
      prompt: planEngReviewDataModelPrompt(
        planDir,
        'Focus specifically on the data model design in the plan. Apply the data model review checklist from the skill.',
      ),
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review-data-model-bias',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review data-model-bias', result);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    const review = fs.existsSync(reviewPath)
      ? fs.readFileSync(reviewPath, 'utf-8')
      : '';

    // Behavioral assertions: the review should recommend a separate tier model
    // and push back on JSONField for the feature set. Matching is deliberately
    // loose (case-insensitive substrings) to tolerate wording variance while
    // still catching the bias regression. Strip markdown formatting chars
    // (backticks, asterisks) first — LLMs commonly wrap identifiers like
    // `SubscriptionTier` in backticks, which would otherwise break the \s*
    // assumptions below.
    const lower = review.toLowerCase();
    const unformatted = review.replace(/[`*_]/g, '');
    // matchesUnnegated so a (would-be-regression) "I would NOT recommend a
    // separate tier model here" answer doesn't get counted as a pass just
    // for containing the words — consistent with the sibling counterexample
    // tests below.
    const recommendsSeparateModel =
      matchesUnnegated(unformatted, /separate\s+(subscription\s*)?tier\s*model/i) ||
      matchesUnnegated(unformatted, /new\s+(subscription\s*)?tier\s*model/i) ||
      matchesUnnegated(unformatted, /subscriptiontier\s*model/i) ||
      matchesUnnegated(unformatted, /extract[\s\S]*tier[\s\S]*model/i) ||
      matchesUnnegated(unformatted, /tier\s*(?:table|model)\s*(?:with|per)/i);
    const pushesBackOnJsonField =
      lower.includes('jsonfield') &&
      (lower.includes('feature') || lower.includes('polymorph') || lower.includes('explicit'));
    const citesNormalization =
      /normali[sz]/i.test(review) ||
      /\bsrp\b/i.test(review) ||
      /single\s+responsibility/i.test(review) ||
      /\b3nf\b/i.test(review) ||
      /normal\s+form/i.test(review);

    recordE2E(evalCollector, '/plan-eng-review-data-model-bias', 'Plan Eng Review Data-Model Bias E2E', result, {
      passed:
        ['success', 'error_max_turns'].includes(result.exitReason) &&
        review.length > 200 &&
        recommendsSeparateModel &&
        pushesBackOnJsonField &&
        citesNormalization,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(review.length).toBeGreaterThan(200);
    expect(recommendsSeparateModel).toBe(true);
    expect(pushesBackOnJsonField).toBe(true);
    expect(citesNormalization).toBe(true);
  }, 420_000);
});

// --- Plan Eng Review Data-Model Legitimate-JSON Counterexample E2E ---
//
// Positive-case regression: the data-model bias fix narrowed "JSONField is not
// an escape hatch for polymorphism" to explicitly exempt genuinely legitimate
// uses (third-party payload caches, opaque preference bags, schemas still
// being discovered). This verifies the narrowing actually works — that
// /plan-eng-review does NOT push back on a JSONField that squarely matches
// one of its own listed legitimate cases (caching a third-party webhook
// payload verbatim, schema controlled entirely by the external producer).

describeIfSelected('Plan Eng Review Data-Model Legitimate JSON E2E', ['plan-eng-review-data-model-legitimate-json'], () => {
  let planDir: string;

  beforeAll(() => {
    // Synthetic plan designed to NOT trip the JSONField guidance: the payload
    // is a verbatim third-party webhook body, schema owned by Stripe (not us),
    // never queried into by key — the textbook legitimate JSONField case.
    planDir = setupPlanEngReviewFixture('skill-e2e-plan-eng-json-', `# Plan: Add Stripe Webhook Event Log

## Context
We need to store incoming Stripe webhook events for audit and replay. Stripe
sends many event types (payment_intent.succeeded, charge.refunded,
customer.subscription.updated, etc.), each with a different JSON body shape
that Stripe controls and can change without notice.

## Proposed changes
Add a WebhookEvent model:
- id: primary key
- event_type: CharField (e.g. "payment_intent.succeeded")
- stripe_event_id: CharField, unique
- received_at: DateTimeField
- payload: JSONField — the verbatim JSON body Stripe sent, unmodified

We will never query into specific payload keys from application code; the
only consumer is a manual replay tool that re-POSTs the raw payload to our
webhook handler for reprocessing. The field exists purely to cache Stripe's
response verbatim for audit/replay, not to model our own domain state.

## Open questions
- Is storing the whole event as JSONField the right call here, or should we
  break out the commonly-used fields into columns?
`);
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-data-model-legitimate-json', async () => {
    const result = await runSkillTest({
      prompt: planEngReviewDataModelPrompt(
        planDir,
        'Focus specifically on the data model design in the plan. Apply the data model review checklist from the skill.',
      ),
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review-data-model-legitimate-json',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review data-model-legitimate-json', result);

    const reviewPath = path.join(planDir, 'review-output.md');
    const review = fs.existsSync(reviewPath)
      ? fs.readFileSync(reviewPath, 'utf-8')
      : '';
    const lower = review.toLowerCase();

    // Deliberately loose, case-insensitive matching (same tolerance as the
    // bias-regression test above) to survive wording variance while still
    // catching an over-eager JSONField warning. matchesUnnegated() ignores
    // matches preceded by a negation word — otherwise a CORRECT "I would NOT
    // extract the payload into columns" answer would trip this check, since
    // it contains "extract...payload...column" just like an incorrect one.
    // Includes normali[sz]e alongside promote/split/convert/extract/move since
    // that's the exact vocabulary the companion template edits use.
    const discussesThePayloadField = lower.includes('payload') || lower.includes('jsonfield');
    const pushesToSplitTheField =
      matchesUnnegated(review, /(promote|split|convert|extract|move|normali[sz]e)[^.]{0,80}payload[^.]{0,80}(column|field)/i) ||
      matchesUnnegated(review, /payload[^.]{0,80}(promote|split|convert to (explicit )?column|explicit column|normali[sz]e)/i);
    const acknowledgesLegitimateUse =
      /legitimate|appropriate|reasonable|correct (choice|call|approach)|fine as[- ](is|it)|acceptable|(third[- ]party|external).{0,40}(payload|blob|response)|verbatim|schemaless/i.test(review);

    recordE2E(evalCollector, '/plan-eng-review-data-model-legitimate-json', 'Plan Eng Review Data-Model Legitimate JSON E2E', result, {
      passed:
        ['success', 'error_max_turns'].includes(result.exitReason) &&
        review.length > 200 &&
        discussesThePayloadField &&
        !pushesToSplitTheField &&
        acknowledgesLegitimateUse,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(review.length).toBeGreaterThan(200);
    expect(discussesThePayloadField).toBe(true);
    expect(pushesToSplitTheField).toBe(false);
    expect(acknowledgesLegitimateUse).toBe(true);
  }, 420_000);
});

// --- Plan Eng Review Data-Model Measured-Denormalization Counterexample E2E ---
//
// Positive-case regression: the data-model bias fix narrowed "normalize
// first" to explicitly exempt denormalization backed by a stated
// measurement (profiled hot path, load test, documented query cost). This
// verifies /plan-eng-review accepts a denormalized snapshot field when the
// plan cites a concrete measurement, instead of reflexively recommending a
// return to a fully-normalized live-join design.

describeIfSelected('Plan Eng Review Data-Model Measured Denormalization E2E', ['plan-eng-review-data-model-measured-denorm'], () => {
  let planDir: string;

  beforeAll(() => {
    // Synthetic plan designed to NOT trip the normalize-first guidance: the
    // denormalization is scoped to one read path and backed by a stated
    // measurement (APM p95 + load test), matching the fix's own counterexample.
    planDir = setupPlanEngReviewFixture('skill-e2e-plan-eng-denorm-', `# Plan: Add OrderSummary Read Snapshot for Checkout Confirmation

## Context
The checkout confirmation page currently joins Order -> Customer ->
ShippingAddress (3 tables) to render the confirmation. APM (New Relic) shows
this read path at p95 180ms under current traffic; a load test at 2x
projected peak traffic showed p95 climbing to 340ms, driven almost entirely
by this join according to the query plan.

## Proposed changes
Add an OrderSummary model that snapshots customer_name and
shipping_address_line onto the Order row at order-creation time, used ONLY
by the checkout confirmation read path. Order, Customer, and
ShippingAddress remain fully normalized everywhere else in the codebase —
this is a single, measured, scoped denormalization for one hot read path,
not a general schema change.

## Open questions
- Is this the right call, or should we keep reading live via the FK chain
  and instead add caching/indexing to fix the latency?
`);
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-data-model-measured-denorm', async () => {
    const result = await runSkillTest({
      prompt: planEngReviewDataModelPrompt(
        planDir,
        'Focus specifically on the data model design in the plan. Apply the data model review checklist from the skill.',
      ),
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review-data-model-measured-denorm',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review data-model-measured-denorm', result);

    const reviewPath = path.join(planDir, 'review-output.md');
    const review = fs.existsSync(reviewPath)
      ? fs.readFileSync(reviewPath, 'utf-8')
      : '';
    const lower = review.toLowerCase();

    const discussesTheDenormalization = lower.includes('denormal') || lower.includes('ordersummary');
    // Broadened per review feedback: the original pattern missed common
    // rejection phrasings ("instead of denormalizing", "cache/index instead")
    // and its "normali[sz]e...instead|back|it" clause was loose enough to
    // false-positive on approving language ("stays normalized elsewhere;
    // keep it that way") — tightened to require an explicit join/read/query
    // + instead framing.
    const rejectsAsUnjustified =
      /(premature|not[- ]yet justified|lacks?[- ]a measurement|no measurement|remove[^.]{0,40}(denormali[sz]ation|snapshot)|normali[sz]e[^.]{0,20}(this|the)?[^.]{0,20}(join|read|query)[^.]{0,20}instead|instead of denormali[sz]ing|rather than (denormali[sz]ing|snapshot(ting)?)|(cache|index)[^.]{0,30}instead|should (read|query|join)[^.]{0,40}live)/i.test(review);
    const acceptsMeasuredJustification =
      /measur|profil|load test|p95|latency|query plan|justified|reasonable|legitimate|appropriate|scoped/i.test(review);

    recordE2E(evalCollector, '/plan-eng-review-data-model-measured-denorm', 'Plan Eng Review Data-Model Measured Denormalization E2E', result, {
      passed:
        ['success', 'error_max_turns'].includes(result.exitReason) &&
        review.length > 200 &&
        discussesTheDenormalization &&
        !rejectsAsUnjustified &&
        acceptsMeasuredJustification,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(review.length).toBeGreaterThan(200);
    expect(discussesTheDenormalization).toBe(true);
    expect(rejectsAsUnjustified).toBe(false);
    expect(acceptsMeasuredJustification).toBe(true);
  }, 420_000);
});

// --- Plan Eng Review Data-Model Minimal-Change Counterexample E2E ---
//
// Positive-case regression: the data-model bias fix narrowed the SRP-for-models
// checklist item and cognitive pattern #12 to exempt a single trivial field
// with no independent query pattern, write path, or consumer — that case is
// a genuine judgment call to keep inline, not an automatic split. This
// verifies /plan-eng-review does NOT reflexively recommend extracting a new
// model for a plan that adds exactly one such field to an existing model.

describeIfSelected('Plan Eng Review Data-Model Minimal Change E2E', ['plan-eng-review-data-model-minimal-change'], () => {
  let planDir: string;

  beforeAll(() => {
    // Synthetic plan designed to NOT trip the SRP/normalize guidance: one
    // trivial timestamp field, no polymorphism, no JSONField, no independent
    // query pattern or consumer — the textbook "keep it inline" case.
    planDir = setupPlanEngReviewFixture('skill-e2e-plan-eng-minimal-', `# Plan: Add Email Verification Timestamp to User Model

## Context
We want to show "Verified on {date}" in a single admin-dashboard column for
each user. Nothing else in the codebase reads this value — there's no
separate verification workflow, no independent lifecycle, and no other
consumer planned.

## Proposed changes
Add one field to the existing User model:
- email_verified_at: DateTimeField, nullable (null = not yet verified)

No new model, no JSONField, no polymorphism — one column on User, set once
when the verification email link is clicked.

## Open questions
- Is a single column the right call here, or should this become a separate
  EmailVerification model?
`);
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-data-model-minimal-change', async () => {
    const result = await runSkillTest({
      prompt: planEngReviewDataModelPrompt(
        planDir,
        'Focus specifically on the data model design in the plan. Apply the data model review checklist from the skill.',
      ),
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review-data-model-minimal-change',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/plan-eng-review data-model-minimal-change', result);

    const reviewPath = path.join(planDir, 'review-output.md');
    const review = fs.existsSync(reviewPath)
      ? fs.readFileSync(reviewPath, 'utf-8')
      : '';
    const lower = review.toLowerCase();

    const discussesTheField = lower.includes('email_verified_at') || lower.includes('verification');
    // matchesUnnegated so a CORRECT "I would NOT extract a separate model
    // here" answer doesn't trip this check just for containing the words.
    // Verb list deliberately excludes "add" — "add this new field to the
    // existing model" is exactly how a CORRECT (inline) recommendation gets
    // phrased, so including it would false-positive on the desired answer.
    const recommendsSeparateModel = matchesUnnegated(
      review,
      /(extract|split|promote|create|introduce|build|spin[- ]?out|break[- ]?out)[^.]{0,60}(separate|new|dedicated)[^.]{0,40}(model|table)/i,
    ) || matchesUnnegated(review, /separate\s+email\s*verification\s*model/i);
    const acceptsInlineAddition =
      matchesUnnegated(review, /(keep|stay|remain|fine|appropriate|correct|reasonable|no need)[^.]{0,60}(inline|as[- ]is|single column|one column|single field)/i) ||
      matchesUnnegated(review, /(single|one)\s+(trivial\s+)?field[^.]{0,60}(no|without)[^.]{0,40}(independent|separate)/i) ||
      /doesn'?t (need|require|warrant)[^.]{0,40}(a\s+)?(separate|new|dedicated)[^.]{0,40}(model|table)/i.test(review);

    recordE2E(evalCollector, '/plan-eng-review-data-model-minimal-change', 'Plan Eng Review Data-Model Minimal Change E2E', result, {
      passed:
        ['success', 'error_max_turns'].includes(result.exitReason) &&
        review.length > 200 &&
        discussesTheField &&
        !recommendsSeparateModel &&
        acceptsInlineAddition,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(review.length).toBeGreaterThan(200);
    expect(discussesTheField).toBe(true);
    expect(recommendsSeparateModel).toBe(false);
    expect(acceptsInlineAddition).toBe(true);
  }, 420_000);
});

// --- Plan-Eng-Review Test-Plan Artifact E2E ---

describeIfSelected('Plan-Eng-Review Test-Plan Artifact E2E', ['plan-eng-review-artifact'], () => {
  let planDir: string;
  let projectDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-artifact-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create base commit on main
    fs.writeFileSync(path.join(planDir, 'app.ts'), 'export function greet() { return "hello"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create feature branch with changes
    run('git', ['checkout', '-b', 'feature/add-dashboard']);
    fs.writeFileSync(path.join(planDir, 'dashboard.ts'), `export function Dashboard() {
  const data = fetchStats();
  return { users: data.users, revenue: data.revenue };
}
function fetchStats() {
  return fetch('/api/stats').then(r => r.json());
}
`);
    fs.writeFileSync(path.join(planDir, 'app.ts'), `import { Dashboard } from "./dashboard";
export function greet() { return "hello"; }
export function main() { return Dashboard(); }
`);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add dashboard']);

    // Plan document
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add Dashboard

## Changes
1. New \`dashboard.ts\` with Dashboard component and fetchStats API call
2. Updated \`app.ts\` to import and use Dashboard

## Architecture
- Dashboard fetches from \`/api/stats\` endpoint
- Returns user count and revenue metrics
`);
    run('git', ['add', 'plan.md']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-eng-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-eng-review', 'sections'), { recursive: true }); }

    // Set up remote-slug shim and browse shims (plan-eng-review uses remote-slug for artifact path)
    setupBrowseShims(planDir);

    // Create project directory for artifacts
    projectDir = path.join(os.homedir(), '.gstack', 'projects', 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Clean up stale test-plan files from previous runs
    try {
      const staleFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));
      for (const f of staleFiles) {
        fs.unlinkSync(path.join(projectDir, f));
      }
    } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
    // Clean up test-plan artifacts (but not the project dir itself)
    try {
      const files = fs.readdirSync(projectDir);
      for (const f of files) {
        if (f.includes('test-plan')) {
          fs.unlinkSync(path.join(projectDir, f));
        }
      }
    } catch {}
  });

  testConcurrentIfSelected('plan-eng-review-artifact', async () => {
    // Count existing test-plan files before
    const beforeFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));

    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the review.

Read plan.md — that's the plan to review. This is a standalone plan with source code in app.ts and dashboard.ts.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.

IMPORTANT: After your review, you MUST write the test-plan artifact as described in the "Test Plan Artifact" section of SKILL.md. The remote-slug shim is at ${planDir}/browse/bin/remote-slug.

Write your review to ${planDir}/review-output.md`,
      workingDirectory: planDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
      timeout: 360_000,
      testName: 'plan-eng-review-artifact',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review artifact', result);
    recordE2E(evalCollector, '/plan-eng-review test-plan artifact', 'Plan-Eng-Review Test-Plan Artifact E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify test-plan artifact was written
    const afterFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));
    console.log(`Test-plan artifacts: ${beforeFiles.length} before, ${afterFiles.length} after, ${newFiles.length} new`);

    if (newFiles.length > 0) {
      const content = fs.readFileSync(path.join(projectDir, newFiles[0]), 'utf-8');
      console.log(`Test-plan artifact (${newFiles[0]}): ${content.length} chars`);
      expect(content.length).toBeGreaterThan(50);
    } else {
      console.warn('No test-plan artifact found — agent may not have followed artifact instructions');
    }

    // Soft assertion: we expect an artifact but agent compliance is not guaranteed.
    // Log rather than fail — the test-plan artifact is a bonus output, not the core test.
    if (newFiles.length === 0) {
      console.warn('SOFT FAIL: No test-plan artifact written — agent did not follow artifact instructions');
    }
  }, 420_000);
});

// --- Office Hours Spec Review E2E ---

describeIfSelected('Office Hours Spec Review E2E', ['office-hours-spec-review'], () => {
  let ohDir: string;

  beforeAll(() => {
    ohDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oh-spec-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: ohDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(ohDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy office-hours skill
    fs.mkdirSync(path.join(ohDir, 'office-hours'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'office-hours', 'SKILL.md'),
      path.join(ohDir, 'office-hours', 'SKILL.md'),
    );
    { const _sec = path.join(ROOT, 'office-hours', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(ohDir, 'office-hours', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(ohDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('office-hours-spec-review', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md. I want to understand the spec review loop.

Summarize what the "Spec Review Loop" section does — specifically:
1. How many dimensions does the reviewer check?
2. What tool is used to dispatch the reviewer?
3. What's the maximum number of iterations?
4. What metrics are tracked?

Write your summary to ${ohDir}/spec-review-summary.md`,
      workingDirectory: ohDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'office-hours-spec-review',
      runId,
    });

    logCost('/office-hours spec review', result);
    recordE2E(evalCollector, '/office-hours-spec-review', 'Office Hours Spec Review E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(ohDir, 'spec-review-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      expect(summary).toMatch(/5.*dimension|dimension.*5|completeness|consistency|clarity|scope|feasibility/);
      expect(summary).toMatch(/agent|subagent/);
      expect(summary).toMatch(/3.*iteration|iteration.*3|maximum.*3/);
    }
  }, 180_000);
});

// --- Plan CEO Review Benefits-From E2E ---

describeIfSelected('Plan CEO Review Benefits-From E2E', ['plan-ceo-review-benefits'], () => {
  let benefitsDir: string;

  beforeAll(() => {
    benefitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-benefits-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: benefitsDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(benefitsDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    fs.mkdirSync(path.join(benefitsDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(benefitsDir, 'plan-ceo-review', 'SKILL.md'),
    );
    { const _sec = path.join(ROOT, 'plan-ceo-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(benefitsDir, 'plan-ceo-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(benefitsDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('plan-ceo-review-benefits', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md. Search for sections about "Prerequisite" or "office-hours" or "design doc found".

Summarize what happens when no design doc is found — specifically:
1. Is /office-hours offered as a prerequisite?
2. What options does the user get?
3. Is there a mid-session detection for when the user seems lost?

Write your summary to ${benefitsDir}/benefits-summary.md`,
      workingDirectory: benefitsDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'plan-ceo-review-benefits',
      runId,
    });

    logCost('/plan-ceo-review benefits-from', result);
    recordE2E(evalCollector, '/plan-ceo-review-benefits', 'Plan CEO Review Benefits-From E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(benefitsDir, 'benefits-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      expect(summary).toMatch(/office.hours/);
      expect(summary).toMatch(/design doc|no design/i);
    }
  }, 180_000);
});

// --- Plan Review Report E2E ---
// Verifies that plan-eng-review writes a "## GSTACK REVIEW REPORT" section
// to the bottom of the plan file (the living review status footer).

describeIfSelected('Plan Review Report E2E', ['plan-review-report'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-report-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add Notifications System

## Context
We're building a real-time notification system for our SaaS app.

## Changes
1. WebSocket server for push notifications
2. Notification preferences API
3. Email digest fallback for offline users
4. PostgreSQL table for notification storage

## Architecture
- WebSocket: Socket.io on Express
- Queue: Bull + Redis for email digests
- Storage: PostgreSQL notifications table
- Frontend: React toast component

## Open questions
- Retry policy for failed WebSocket delivery?
- Max notifications stored per user?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );
    // Carved skills (v2 plan T9): copy sections/ so the review workflow + report template are present.
    { const _sec = path.join(ROOT, 'plan-eng-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(planDir, 'plan-eng-review', 'sections'), { recursive: true }); }
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-eng-review writes GSTACK REVIEW REPORT to plan file', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections.

CRITICAL REQUIREMENT: plan.md IS the plan file for this review session. After completing your review, you MUST write a "## GSTACK REVIEW REPORT" section to the END of plan.md, exactly as described in the "Plan File Review Report" section of SKILL.md. If gstack-review-read is not available or returns NO_REVIEWS, write the placeholder table with all five review rows (CEO, Codex, Eng, Design, DX). The report MUST end with the mandatory unresolved-decisions status as its final line — the exact unbolded line NO UNRESOLVED DECISIONS when nothing is open, or a "**UNRESOLVED DECISIONS:**" block of bullets when items remain. Nothing may follow it. Use the Edit tool to append to plan.md — do NOT overwrite the existing plan content.

This review report at the bottom of the plan is the MOST IMPORTANT deliverable of this test.`,
      workingDirectory: planDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'plan-review-report',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/plan-eng-review report', result);
    recordE2E(evalCollector, '/plan-review-report', 'Plan Review Report E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    // Transient API failure escape hatch: when the SDK returns error_api with
    // zero turns / zero tokens, the API call died before the model ever ran —
    // no skill code executed, no file was written. Bun retries the test up to
    // 3x; if every attempt hits the same API hiccup, surface a warning and
    // treat as inconclusive rather than gating the build on Anthropic
    // availability. Logic regressions still surface as success/error_max_turns
    // with a missing artifact, which the downstream assertions catch.
    if (result.exitReason === 'error_api' && result.costEstimate?.turnsUsed === 0) {
      console.warn('[transient] /plan-review-report: error_api with 0 turns — treating as inconclusive (likely Anthropic API hiccup, see CLAUDE.md eval-blame protocol)');
      return;
    }
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review report was written to the plan file
    const planContent = fs.readFileSync(path.join(planDir, 'plan.md'), 'utf-8');

    // Original plan content should still be present
    expect(planContent).toContain('# Plan: Add Notifications System');
    expect(planContent).toContain('WebSocket');

    // Review report section must exist
    expect(planContent).toContain('## GSTACK REVIEW REPORT');

    // Report should be at the bottom of the file
    const reportIndex = planContent.lastIndexOf('## GSTACK REVIEW REPORT');
    const afterReport = planContent.slice(reportIndex);

    // Should contain the review table with standard rows
    expect(afterReport).toMatch(/\|\s*Review\s*\|/);
    expect(afterReport).toContain('CEO Review');
    expect(afterReport).toContain('Eng Review');
    expect(afterReport).toContain('Design Review');

    // Mandatory unresolved-decisions status (plan-flag-unresolved-issues): the report's
    // final non-whitespace line must be the unresolved status — the exact sentinel or a
    // bullet of an UNRESOLVED DECISIONS block, with nothing (CODEX/CROSS-MODEL/VERDICT/
    // prose) after it.
    expect(afterReport).toContain('UNRESOLVED DECISIONS');
    // Compute from afterReport (the report section to EOF), not the whole file, so a
    // mid-file report surfaces the real trailing content in the failure message.
    const nonEmpty = afterReport.split('\n').map(l => l.trim()).filter(l => l !== '');
    const lastLine = nonEmpty[nonEmpty.length - 1];
    const isSentinel = lastLine === 'NO UNRESOLVED DECISIONS';
    const isUnresolvedBullet =
      /^[-*]\s+/.test(lastLine) && !/VERDICT/i.test(lastLine) && afterReport.includes('UNRESOLVED DECISIONS:');
    expect(
      isSentinel || isUnresolvedBullet,
      `report must end with the unresolved-decisions status; last line was: ${lastLine}`,
    ).toBe(true);

    console.log('Plan review report found at bottom of plan.md (ends with unresolved status)');
  }, 420_000);
});

// --- Codex Offering E2E ---
// Verifies that Codex is properly offered (with availability check, user prompt,
// and fallback) in office-hours, plan-ceo-review, plan-design-review, plan-eng-review.

describeIfSelected('Codex Offering E2E', [
  'codex-offered-office-hours', 'codex-offered-ceo-review',
  'codex-offered-design-review', 'codex-offered-eng-review',
], () => {
  let testDir: string;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codex-offer-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: testDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy all 4 SKILL.md files
    for (const skill of ['office-hours', 'plan-ceo-review', 'plan-design-review', 'plan-eng-review']) {
      fs.mkdirSync(path.join(testDir, skill), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, skill, 'SKILL.md'),
        path.join(testDir, skill, 'SKILL.md'),
      );
      // Carved skills (v2 plan T9): copy sections/ so codex/outside-voice content
      // (carved into review-sections.md) is present for the search.
      const _sec = path.join(ROOT, skill, 'sections');
      if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(testDir, skill, 'sections'), { recursive: true });
    }
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  async function checkCodexOffering(skill: string, testName: string, featureName: string) {
    const result = await runSkillTest({
      prompt: `Read ${skill}/SKILL.md. Search for ALL sections related to "codex", "outside voice", or "second opinion".

Summarize the Codex/${featureName} integration — answer these specific questions:
1. How is Codex availability checked? (what exact bash command?)
2. How is the user prompted? (via AskUserQuestion? what are the options?)
3. What happens when Codex is NOT available? (fallback to subagent? skip entirely?)
4. Is this step blocking (gates the workflow) or optional (can be skipped)?
5. What prompt/context is sent to Codex?

Write your summary to ${testDir}/${testName}-summary.md`,
      workingDirectory: testDir,
      maxTurns: 8,
      timeout: 120_000,
      testName,
      runId,
    });

    logCost(`/${skill} codex offering`, result);
    recordE2E(evalCollector, `/${testName}`, 'Codex Offering E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(testDir, `${testName}-summary.md`);
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
    // All skills should have codex availability check (command -v per #1197)
    expect(summary).toMatch(/command -v codex/);
    // All skills should have fallback behavior
    expect(summary).toMatch(/fallback|subagent|unavailable|not available|skip/);
    // All skills should show it's optional/non-blocking
    expect(summary).toMatch(/optional|non.?blocking|skip|not.*required/);

    console.log(`${skill}: Codex offering verified`);
  }

  testConcurrentIfSelected('codex-offered-office-hours', async () => {
    await checkCodexOffering('office-hours', 'codex-offered-office-hours', 'second opinion');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-ceo-review', async () => {
    await checkCodexOffering('plan-ceo-review', 'codex-offered-ceo-review', 'outside voice');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-design-review', async () => {
    await checkCodexOffering('plan-design-review', 'codex-offered-design-review', 'design outside voices');
  }, 180_000);

  testConcurrentIfSelected('codex-offered-eng-review', async () => {
    await checkCodexOffering('plan-eng-review', 'codex-offered-eng-review', 'outside voice');
  }, 180_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
