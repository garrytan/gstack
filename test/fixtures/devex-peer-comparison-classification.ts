/** Synthetic semantic calibrations. Reference facts are supplied, not live web claims. */
import type { AskUserQuestionFingerprint } from '../helpers/claude-pty-runner';
import type { NativeQuestion } from '../helpers/plan-skill-questions';
import { DEVEX_FINDINGS } from '../helpers/plan-review-cases';
import type { PlanReviewDecisionInput, PlanReviewDecision, DevexPeerComparisonJudgment } from '../helpers/plan-review-decisions';

type Expected = Pick<PlanReviewDecision, 'kind' | 'targetIds' | 'independentDecisions'>;
export interface DevexPeerCalibration {
  name: string;
  input: Omit<PlanReviewDecisionInput, 'deadlineAt'>;
  expected: Record<string, Expected>;
  rejection?: string;
  count: number;
}

const plan = `# Public SDK beta review
Four launch decisions remain open: target developer persona, first-run duration
measurement, the mandatory five-minute conformance block, and the first-run aha.
The SDK already accepts a Python callable and caller-owned cases/metric; readable
results and offline examples exist. No hosted service or new evaluator is planned.
The selected persona and all four actual answers are in the supplied native calls.

## Frozen synthetic reference excerpts
These are fictional peers for calibration, not claims about real products. The
references below completely describe the available benchmark evidence. None
contains measured onboarding times or measured current-product timing.
- refs/pythonpeer.md: PythonPeer targets Python application developers. Install a
  package, paste a callable and cases, run evaluate, then print a result.
- refs/clipeer.md: CliPeer targets terminal users. Install its CLI, run init to
  write a sample, then run the sample. Its sample is not the user's application.
- refs/hostedpeer.md: HostedPeer requires an account and API key before uploading
  cases and running an evaluation. Its quickstart provides no elapsed duration.
Our SDK: install, supply an existing Python callable/cases/metric, then wait for
the mandatory five-minute prerequisite before the first evaluation can run.
The review must compare these onboarding paths and explain their significance
for this plan. Research and reporting do not themselves need another approval.`;

export const groundedPeerEvidence: DevexPeerComparisonJudgment = {
  status: 'complete',
  peers: [
    { name: 'PythonPeer', quote: 'PythonPeer: install, paste callable/cases, evaluate and print; estimated 3-5 minutes from these steps. Source: refs/pythonpeer.md.' },
    { name: 'CliPeer', quote: 'CliPeer: install, init a sample, then run it; estimated 2-3 minutes, but the result is on a scaffold rather than the application. Source: refs/clipeer.md.' },
    { name: 'HostedPeer', quote: 'HostedPeer: account and key, upload cases, then evaluate; elapsed duration unknown. Source: refs/hostedpeer.md.' },
  ],
  productQuote: 'Our SDK shares PythonPeer\'s callable-and-cases path, but its required five-minute precheck blocks the first result; current total duration remains unmeasured.',
  groundingQuote: 'All peer durations above are reviewer estimates from the cited frozen quickstart steps, not measurements. HostedPeer and our total duration have no timing evidence.',
  implicationQuote: 'For the chosen Python app developer, PythonPeer is the closest comparison. Remove the unrelated block as approved and measure that real-callable path; do not copy CliPeer\'s scaffold or HostedPeer\'s account requirement merely to match their onboarding.',
  reason: 'The comparison distinguishes three relevant journeys, their sources and uncertainty, and the implication for the selected persona and existing SDK.',
};

function brief(id: string, title: string, context: string, labels: [string, string], descriptions: [string, string]): AskUserQuestionFingerprint {
  const options = labels.map((label, i) => ({ label, description: descriptions[i]! }));
  const question: NativeQuestion = { header: title, multiSelect: false, options, question: [
    title, 'Project/branch/task: SDK beta on calibration-fixture; one pending launch decision.',
    `ELI10: ${context}`, 'Stakes if we pick wrong: The chosen developer journey may remain slow or fail to demonstrate useful evaluation.',
    `Recommendation: ${labels[0]} because ${descriptions[0]}`, 'Note: options differ in kind, not coverage — no completeness score.',
    'Pros / cons:', ...options.flatMap((option, index) => [`${String.fromCharCode(65 + index)}) ${option.label}`,
      `  ✅ ${option.description}`, '  ❌ This choice leaves the other approach unselected; revisit it only on new evidence.']),
    'Net: Decide this obligation; all other approved or pending dispositions remain unchanged.',
  ].join('\n') };
  return { toolUseId: id, signature: id, questions: [question], selectedOptions: [1],
    promptSnippet: question.question.slice(0, 240), options: options.map((option, i) => ({ index: i + 1, label: option.label })),
    observedAtMs: 0, preReview: true };
}

export function devexPeerAnalysisCalibrations(): DevexPeerCalibration[] {
  const fingerprints = [
    brief('persona', 'D1 — Target developer', 'The SDK beta currently targets everyone. Choose the primary audience.',
      ['Python application developer (recommended)', 'Platform engineer'],
      ['Optimize for developers evaluating an LLM-backed callable already in their application.', 'Optimize for platform teams integrating evaluation into shared infrastructure.']),
    brief('first-run-benchmark', 'D2 — Measure first-run duration', 'The first-run duration is unknown. Choose a measurement method, keeping the target and product capabilities unchanged.',
      ['Maintainer fresh-install measurement (recommended)', 'Observed developer trial'],
      ['Time a fresh installation and documented first evaluation; record machine and human time separately.', 'Observe a developer following the documented first-run journey and record its elapsed duration.']),
    brief('mandatory-ci', 'D3 — Mandatory precheck', 'A five-minute conformance check blocks evaluation, although evaluation does not consume its report.',
      ['Make conformance explicit (recommended)', 'Retain the mandatory block'],
      ['Run evaluation immediately and keep conformance available as an explicit command.', 'Keep the required first-run wait and document why it remains necessary.']),
    brief('aha', 'D4 — First-run demonstration', 'The guide has no designed moment that demonstrates useful failure detection. Choose a demonstration using existing outputs.',
      ['Pass then break the callable (recommended)', 'Display the final score table'],
      ['Show a passing callable, change one line, and show the same cases detecting the regression.', 'Present the readable score table as the proof that evaluation works.']),
  ];
  const expected = Object.fromEntries(fingerprints.map(fp => [fp.toolUseId!, {
    kind: 'finding' as const, targetIds: [fp.toolUseId!], independentDecisions: 1,
  }]));
  const good = ['# Reviewed SDK beta', ...groundedPeerEvidence.peers.map(peer => peer.quote),
    groundedPeerEvidence.productQuote, groundedPeerEvidence.groundingQuote, groundedPeerEvidence.implicationQuote].join('\n');
  const inadequate = `# Reviewed SDK beta
Peer directory: PythonPeer (refs/pythonpeer.md), CliPeer (refs/clipeer.md), HostedPeer (refs/hostedpeer.md).
All have attractive logos. Our SDK should use a larger logo as well.
No comparison of onboarding steps, first-result effort or relevance to the Python app developer is provided.`;
  const unsupported = `# Reviewed SDK beta
PythonPeer measured TTHW: 3 seconds. Source: refs/pythonpeer.md.
CliPeer measured TTHW: 2 seconds. Source: refs/clipeer.md.
HostedPeer measured TTHW: 1 second. Source: refs/hostedpeer.md.
Our SDK measured TTHW: 0.5 seconds including its mandatory five-minute precheck.
These are actual measured durations, not estimates; no timing run or measurement record exists beyond the cited quickstarts.
The Python app developer should prefer our SDK because its measured first run is the fastest.`;
  return [
    { name: 'grounded-analysis-with-four-decisions', finalPlan: good },
    { name: 'names-and-unrelated-comparison', finalPlan: inadequate, rejection: 'peer comparison analysis' },
    { name: 'unsupported-measurements', finalPlan: unsupported, rejection: 'peer comparison analysis' },
  ].map(({ name, finalPlan, rejection }) => ({ name, input: {
    plan, targets: structuredClone(DEVEX_FINDINGS), fingerprints: structuredClone(fingerprints),
    floor: 4, ceiling: 7, kind: 'findings' as const, devexPeerComparison: { finalPlan },
  }, expected: structuredClone(expected), count: 4, ...(rejection ? { rejection } : {}) }));
}
