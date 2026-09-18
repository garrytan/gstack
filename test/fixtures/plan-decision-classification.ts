/** Source-shaped briefs from the canonical AUQ format, CEO TODO/handoff rules,
 * and docs/askuserquestion-split.md. These are synthetic calibrations, not live captures. */
import type { AskUserQuestionFingerprint } from '../helpers/claude-pty-runner';
import type { NativeQuestion } from '../helpers/plan-skill-questions';
import { ENG_BATCHING_FINDINGS } from '../helpers/plan-review-cases';
import type { PlanReviewDecisionInput, PlanReviewDecision } from '../helpers/plan-review-decisions';

type Option = { label: string; description: string };
type Expected = Pick<PlanReviewDecision, 'kind' | 'targetIds' | 'independentDecisions'>;
export interface DecisionCalibration {
  name: string;
  input: Omit<PlanReviewDecisionInput, 'deadlineAt'>;
  expected: Record<string, Expected>;
  rejection?: string;
  count?: number;
}

function brief(title: string, context: string, recommendation: string, options: Option[]): NativeQuestion {
  return { header: title, multiSelect: false, options, question: [
    title, 'Project/branch/task: Payment plan on calibration-fixture; one explicit review choice.',
    `ELI10: ${context}`, 'Stakes if we pick wrong: We may record a choice the user never authorized or leave its stated obligation unresolved.',
    `Recommendation: ${recommendation}`, 'Note: options differ in kind, not coverage — no completeness score.',
    'Pros / cons:', ...options.flatMap((option, index) => [
      `${String.fromCharCode(65 + index)}) ${option.label}`, `  ✅ ${option.description}`,
      '  ❌ This choice leaves the alternatives unselected; revisit only when new evidence changes its stated tradeoff.',
    ]), 'Net: Decide only the obligation described here; all other accepted choices remain unchanged.',
  ].join('\n') };
}
function call(id: string, question: NativeQuestion, selected = 1): AskUserQuestionFingerprint {
  return { toolUseId: id, signature: id, questions: [question], selectedOptions: [selected],
    promptSnippet: question.question.slice(0, 240), options: question.options.map((o, i) => ({ index: i + 1, label: o.label })),
    observedAtMs: 0, preReview: true };
}
const finding = (id: string): Expected => ({ kind: 'finding', targetIds: [id], independentDecisions: 1 });
const workflow: Expected = { kind: 'workflow', targetIds: [], independentDecisions: 0 };
const backlog: Expected = { kind: 'backlog', targetIds: [], independentDecisions: 0 };
const plan = `# Payment handler review
The proposed new handler interpolates request.params.userId directly into its lookup SQL.
It also sends confirmation email inline after commit without handling a mail failure.
Fix both obligations in this review. The existing prepared-query adapter accepts bound values.
The existing mail retry queue can enqueue the already committed account/event identity.
Platform signature verification, account/customer checks, atomic event receipts, retry queue durability,
and production failure metrics are unchanged and already fully covered by platform tests.
A daily payment analytics report is optional future product work, unrelated to these two obligations.`;
const targets = [
  { id: 'query', description: 'Decide how to eliminate SQL injection from the interpolated untrusted userId lookup.' },
  { id: 'email', description: 'Decide how email failure is isolated from the committed payment and retried without another payment mutation.' },
];
const mode = call('setup-mode', brief('D1 — Review mode',
  'Select how this review should proceed. This only sets review posture and does not choose either payment remedy.',
  'HOLD SCOPE because the current payment obligations are already defined.', [
    { label: 'HOLD SCOPE (recommended)', description: 'Review the supplied obligations rigorously without proposing a larger product.' },
    { label: 'SELECTIVE EXPANSION', description: 'Offer optional product additions while preserving the original obligations.' },
  ]));
const query = call('setup-query', brief('D2 — Safe lookup at the architecture checkpoint',
  'The proposed SQL embeds a request value as code, so malicious input can change the query. Choose whether to bind that value through the existing prepared-query adapter before any new handler ships.',
  'Bind userId because input must remain data in the lookup.', [
    { label: 'Bind userId (recommended)', description: 'Replace the interpolated lookup with a parameterized query using the existing adapter.' },
    { label: 'Keep the raw interpolation', description: 'Explicitly retain the injection risk in the new handler instead of implementing the remedy.' },
  ]));
const email = call('setup-email', brief('D3 — TODO: isolate confirmation delivery failure',
  'The payment is already committed when email fails. Despite this TODO heading, the unresolved current-plan obligation needs a choice: queue email retry independently so mail failure cannot trigger another payment mutation.',
  'Isolate and queue because the payment commit must not be repeated for a delivery failure.', [
    { label: 'Isolate and queue (recommended)', description: 'Catch delivery failure and enqueue the existing account/event identity for mail-only retry; preserve the committed payment.' },
    { label: 'Defer this remedy', description: 'Explicitly leave the present email failure behavior unresolved until a later change.' },
  ]));
const todo = call('future-todo', brief('D4 — Optional daily analytics report',
  'A daily payment analytics report could inform a future product review. This is optional P3 work, outside both current obligations; it does not affect query safety, mail retries, or existing operational metrics.',
  'Add to TODOS.md because the idea can be revisited independently.', [
    { label: 'Add to TODOS.md (recommended)', description: 'Record this optional future analytics idea without adding it to the current implementation scope.' },
    { label: 'Skip — not valuable enough', description: 'Drop the optional analytics idea without changing any accepted payment remedy.' },
    { label: 'Build it now in this PR instead of deferring', description: 'Expand this PR to add the unrelated daily analytics product report.' },
  ]));
const handoff = call('next-review', brief("D5 — What's next?",
  'The recorded decisions belong to this review. Choose whether to invoke the engineering review now or manage review sequencing manually; neither option changes the payment plan.',
  'Run /plan-eng-review because architecture review is the next workflow step.', [
    { label: 'Run /plan-eng-review (recommended)', description: 'Start a separate engineering review of the already recorded plan decisions.' },
    { label: "Skip — I'll handle reviews manually", description: 'Finish this session without starting another skill; preserve every recorded choice.' },
  ]), 2);
const bundle = call('bundled-remedies', brief('D2 — Approve both independent fixes as a package',
  'Two independently variable remedies remain: bind the SQL lookup value and isolate failed email delivery through mail-only retry. This menu bundles both changes into one all-or-nothing answer; there is no separate answer for either remedy.',
  'Approve both because both risks should be addressed, even though they can be decided independently.', [
    { label: 'Approve both (recommended)', description: 'Authorize BOTH parameterized lookup AND independent email failure handling/retry together.' },
    { label: 'Retain both current behaviors', description: 'Keep BOTH raw SQL interpolation AND unhandled inline mail failure together.' },
  ]));


// Additional current-plan choices exercise verification coupling in the existing
// negative request; the paid caller still checks every row before its rejection.
const verificationPlan = `The new parallel policy adapter must start all five checks, map provider failures
at their original indices, and preserve the already accepted ordered-denial precedence.
A provider can throw synchronously before returning a Promise; the proposed map currently
lets that throw escape and prevents later checks from starting.
A new receipt JSON formatter must expose the stored integer amountCents unchanged;
its test coverage depth remains undecided. This does not change atomic receipt storage.
A new notification worker must not dispatch queued work after caller cancellation,
but the current implementation lacks that guard. Its separate retry limit is two attempts;
a proposal to raise the retry limit has not been decided.`;
const directRegression = call('direct-contract-regression', brief('D3 — Contain synchronous policy failures',
  'The parallel adapter already promises all-five dispatch and ordered failure mapping. Calling a provider inside an async wrapper converts its synchronous throw into an indexed rejection, preserving that behavior. The proposed R12 cases check an earlier denial plus a later synchronous throw, an initial synchronous throw with its original cause, and all five recorded calls.',
  'Wrap each provider call and add R12 to establish the promised behavior.', [
    { label: 'Wrap calls and add R12 (recommended)', description: 'Invoke each provider inside an async wrapper and test exactly the indexed rejection, denial precedence and all-five dispatch behavior described above.' },
    { label: 'Wrap calls without R12', description: 'Use the same wrapper and behavior, but omit its direct regression coverage.' },
    { label: 'Keep the current map', description: 'Retain the synchronous escape and incomplete dispatch, leaving the accepted behavior broken.' },
  ]));
const verificationDepth = call('same-behavior-test-depth', brief('D4 — Receipt formatter verification depth',
  'The formatter must expose stored amountCents unchanged. Unit cases, an HTTP integration case and a real-store smoke case all verify that same mapping at different layers. Choose the coverage depth; none of these options changes rounding, storage, payment retries or the accepted JSON field.',
  'Use all three layers to check the same mapping through the production path.', [
    { label: 'Unit, integration and smoke (recommended)', description: 'Verify the unchanged stored amountCents mapping in focused unit cases, through the HTTP response and against the real store.' },
    { label: 'Unit cases only', description: 'Verify the identical mapping in isolated formatter cases, without the integration or smoke layers.' },
    { label: 'Smoke case only', description: 'Verify the identical mapping only through the real-store smoke path.' },
  ]));
const independentPolicy = call('independent-code-and-test-policy', brief('D5 — Cancellation guard and retry limit',
  'Queued work currently starts after caller cancellation. A dispatch guard can enforce the accepted cancellation behavior while retaining the existing two-attempt retry limit. This package also raises that separate limit to three attempts and changes the retry tests to require three, adding another possible provider attempt whether or not cancellation occurs.',
  'Add the cancellation guard and raise the retry limit together.', [
    { label: 'Guard cancellation and allow three attempts (recommended)', description: 'Stop queued dispatch after cancellation; also raise the retry limit from two to three attempts and update its tests to require three.' },
    { label: 'Keep both current behaviors', description: 'Retain post-cancellation dispatch and the existing two-attempt retry limit together.' },
  ]));

// Keep the original graph-reuse target distinct from payload-fetch policy.
// The payload-only choice comes first and retains refresh; graph reuse is then
// accepted without reversing that earlier choice. Both are one-decision menus.
const graphTarget = ENG_BATCHING_FINDINGS.find(target => target.id === 'dependency-cache')!;
const graphPlan = `A background job currently fetches its payload on each retry and rebuilds the
pure dependency graph. Reusing the graph from a previous attempt remains undecided.
The graph can be keyed by the fetched payload version; a changed payload must rebuild it.
Whether to replace payload refresh with the job library's queued snapshot is a separate
proposal. Neither graph caching nor payload reuse has been approved before these choices.`;
const payloadCacheOnly = call('payload-cache-with-graph-rebuild', brief('D6 — Payload source for each retry',
  'Choose whether to reuse the queued payload snapshot or retain the database refresh. Both alternatives still rebuild the dependency graph on every retry; graph reuse remains pending for its own decision.',
  'Keep the database refresh while deciding graph reuse separately.', [
    { label: 'Reuse the queued payload', description: 'Remove the payload database fetch, but still recompute the dependency graph on every attempt.' },
    { label: 'Keep the payload refresh (recommended)', description: 'Fetch the payload on every retry and still recompute the graph on every attempt.' },
  ]), 2);
const graphCacheWithRefresh = call('graph-cache-with-payload-refresh', brief('D7 — Reuse the dependency graph',
  'Payload refresh was retained in the preceding choice and stays fixed in every option. Decide whether to reuse the graph when the freshly fetched payload version is unchanged, rebuilding when it changes, or continue rebuilding it on every attempt.',
  'Reuse the graph for an unchanged payload version without changing payload refresh.', [
    { label: 'Cache graph by payload version (recommended)', description: 'Keep every database payload fetch. Reuse the prior graph when the fetched version matches, and rebuild/cache the graph when the version changes.' },
    { label: 'Rebuild graph on every attempt', description: 'Keep every database payload fetch and recompute the graph even when its payload version has not changed.' },
  ]));

export function planDecisionCalibrations(): DecisionCalibration[] {
  const positiveExpected = { 'setup-mode': workflow, 'setup-query': finding('query'), 'setup-email': finding('email'), 'future-todo': backlog, 'next-review': workflow };
  const candidates = ['Slack', 'Teams', 'Email', 'SMS', 'Push'];
  const scopeTargets = candidates.map((name, i) => ({ id: `E${i + 1}`, description: `Decide whether the complete ${name} integration is included, deferred, or cut.` }));
  const scopeCalls = candidates.map((name, i) => call(`scope-${i + 1}`, brief(`D3.${i + 1} — ${name} integration`,
    `The complete ${name} integration is one independent candidate, including its adapter, delivery path, setup documentation, and tests. Its scope can be accepted, deferred, or cut independently of the other four integrations.`,
    `Include because ${name} serves its own requested audience; the actual choice is still the user's.`, [
      { label: 'Include in this scope (recommended)', description: `Implement the complete ${name} integration in this release, with documentation and tests.` },
      { label: 'Defer to follow-up', description: `Move the complete ${name} integration to the next version; do not include any of it now.` },
      { label: 'Cut entirely', description: `Remove the complete ${name} integration from the roadmap, without implementing a partial adapter.` },
      { label: 'Hold — discuss before deciding', description: `Stop this chain and discuss ${name}; do not count this as an accepted, deferred, or cut candidate.` },
    ]), [1, 2, 3, 1, 2][i]));
  return [
    { name: 'early-findings-and-mandatory-workflow', input: { plan, targets, fingerprints: [mode, query, email, todo, handoff], floor: 2, ceiling: 2, kind: 'findings' }, expected: positiveExpected, count: 2 },
    { name: 'dropped-current-obligation', input: { plan, targets, fingerprints: [mode, email, todo, handoff], floor: 2, ceiling: 2, kind: 'findings' },
      expected: { 'setup-mode': workflow, 'setup-email': finding('email'), 'future-todo': backlog, 'next-review': workflow }, rejection: 'missing target decisions' },
    { name: 'bundled-independent-remedies', input: { plan: plan + '\n\n' + verificationPlan + '\n\n' + graphPlan, targets: [...targets, graphTarget], fingerprints: [mode, bundle, directRegression, verificationDepth, independentPolicy, payloadCacheOnly, graphCacheWithRefresh], floor: 2, ceiling: 2, kind: 'findings' },
      expected: { 'setup-mode': workflow, 'bundled-remedies': { kind: 'finding', targetIds: ['query', 'email'], independentDecisions: 2 },
        'direct-contract-regression': { kind: 'finding', targetIds: [], independentDecisions: 1 },
        'same-behavior-test-depth': { kind: 'finding', targetIds: [], independentDecisions: 1 },
        'independent-code-and-test-policy': { kind: 'finding', targetIds: [], independentDecisions: 2 },
        'payload-cache-with-graph-rebuild': { kind: 'finding', targetIds: [], independentDecisions: 1 },
        'graph-cache-with-payload-refresh': finding(graphTarget.id) }, rejection: 'bundled independent decisions' },
    { name: 'source-split-include-defer-cut', input: { plan: '# Notification integrations\nFive independent candidates: Slack, Teams, Email, SMS, Push. Decide each complete integration using the split-per-option protocol; no candidate is already accepted.',
      targets: scopeTargets, fingerprints: scopeCalls, floor: 5, ceiling: 5, kind: 'scope' },
      expected: Object.fromEntries(scopeTargets.map((target, i) => [`scope-${i + 1}`, { kind: 'scope', targetIds: [target.id], independentDecisions: 1 }])), count: 5 },
  ];
}
