/** Ground truth for the existing plan fixtures, independent of review phase. */
import type { NativeQuestion } from './plan-skill-questions';

export const CEO_FINDINGS = [
  { id: 'dispatcher', description: 'Decide whether PaymentService should reuse the existing WebhookDispatcher instead of bypassing it for namespace separation.' },
  { id: 'sql', description: 'Decide a safe parameterized user lookup instead of interpolating untrusted request.params.userId into raw SQL.' },
  { id: 'email', description: 'Decide the failure/recovery contract for notification email after the payment transaction commits; the proposed inline email leg has no catch, outbox, or retry.' },
  { id: 'tests', description: 'Decide regression coverage for the new PaymentService path; existing platform tests do not cover this new handler and no new tests are planned.' },
  { id: 'queries', description: 'Decide how to eliminate or justify the per-order lookup loop instead of batching the webhook order reads.' },
];

export const CEO_PAIRED_FINDINGS = [
  { id: 'receipt-test', description: 'Independently decide happy-path processPayment test coverage asserting the correct receipt after a successful Stripe charge.' },
  { id: 'failure-test', description: 'Independently decide Stripe 502/timeout coverage asserting one retry with backoff and then clean failure.' },
];

export const CEO_SCOPE_CANDIDATES = [
  { id: 'E1', description: 'The whole Slack DM bot for incident alerts integration: include, defer, or cut it.' },
  { id: 'E2', description: 'The whole Discord guild bot for community channels integration: include, defer, or cut it.' },
  { id: 'E3', description: 'The whole Microsoft Teams webhook and bot framework integration: include, defer, or cut it.' },
  { id: 'E4', description: 'The whole Telegram bot API integration: include, defer, or cut it.' },
  { id: 'E5', description: 'The whole Mattermost REST plugin integration: include, defer, or cut it.' },
];

export const DESIGN_FINDINGS = [
  { id: 'primary-action', description: 'Decide how Save becomes the primary action instead of sharing equal visual weight with Reset, Cancel, and Export.' },
  { id: 'spacing', description: 'Decide a consistent vertical section rhythm instead of mixed 16px, 24px, and 32px gaps.' },
  { id: 'contrast', description: 'Decide accessible error-message contrast instead of the proposed approximately 3:1 red-on-pink treatment.' },
  { id: 'typography', description: 'Decide a coherent form-label type hierarchy instead of inconsistent 14px, 16px, and 18px labels.' },
  { id: 'save-feedback', description: 'Decide progress feedback for the 2–5 second Save action instead of leaving the interface apparently frozen.' },
];

export const DEVEX_FINDINGS = [
  { id: 'persona', description: 'Decide a specific target developer persona instead of shipping for everyone.' },
  { id: 'first-run-benchmark', description: 'Decide measurement/benchmarking of time to hello world instead of leaving first-run duration unknown.' },
  { id: 'mandatory-ci', description: 'Decide how to remove or justify the mandatory five-minute CI step before the first eval.' },
  { id: 'aha', description: 'Decide a concrete interactive demo or aha moment in the getting-started flow instead of documentation alone.' },
  { id: 'peer-comparison', description: 'Produce grounded comparative analysis of peer SDK developer experiences and its implications for this plan instead of ignoring existing solutions.' },
];

export const ENG_FINDINGS = [
  { id: 'shared-cache', description: 'Decide ownership/isolation of AuthCache instead of two services mutating one module-level global cache.' },
  { id: 'swallowed-errors', description: 'Decide explicit handling of the swallowed error classes in validateAndDispatch rather than keeping three nested catch blocks that hide failures.' },
  { id: 'legacy-regression', description: 'Decide regression tests for the rewritten legacyAuthFlow behavior.' },
  { id: 'parallel-idp', description: 'Decide parallelizing the five independent IDP validation calls instead of running them sequentially.' },
  { id: 'complexity', description: 'Decide whether to reduce or justify the 12-file/four-new-class scope and complexity.' },
];

export const ENG_BATCHING_FINDINGS = [
  { id: 'retry-library', description: 'Decide reuse of existing job-library retry hooks instead of a custom inline backoff scheduler per worker.' },
  { id: 'retry-duplication', description: 'Decide consolidation of the copied retry envelope across five workers.' },
  { id: 'at-most-once', description: 'Decide regression coverage for processWebhookJob at-most-once delivery when rewriting it.' },
  { id: 'dependency-cache', description: 'Decide caching and reusing the dependency graph across retries instead of rebuilding it on every attempt. Payload fetching or freshness is a separate policy and is not required for graph-cache coverage.' },
];

const planReviewQuestionLead = (question: NativeQuestion) =>
  question.question.split(/\r?\n/, 1)[0]!.replace(/^D\d+(?:\.\d+)?\s*[—–:-]\s*/, '');
const planReviewOptionLabel = (label: string) => label.trim()
  .replace(/^(?:[A-E][).:]?|\([A-E]\)|\[[A-E]\])\s+/i, '')
  .replace(/\s*\(recommended\)\s*$/i, '').trim();

/** This fixture's actor retains optional roadmap work for later planning.
 * It does not classify findings: a seeded obligation offered as a TODO still
 * has to satisfy the unchanged semantic judge after native completion. */
export function pickDevexCheckpointQuestion(question: NativeQuestion): number {
  const labels = question.options.map(option => planReviewOptionLabel(option.label).toLowerCase());
  const todo = /^TODO(?:\s|:|$)/i;
  const actionContext = labels.some(label => /^(?:add to todos\.md|build it now)\b/.test(label));
  if (!todo.test(question.header.trim()) && !todo.test(planReviewQuestionLead(question).trim()) && !actionContext) {
    return pickPlanReviewQuestion(question);
  }
  const actions = ['add to todos.md', 'skip', 'build it now'];
  if (question.multiSelect || labels.length !== actions.length
    || actions.some(action => labels.filter(label => label === action).length !== 1)) {
    throw new Error('DX checkpoint TODO menu must offer exactly Add to TODOS.md, Skip and Build it now');
  }
  return labels.indexOf('add to todos.md') + 1;
}

/** Answer only the finite next-step menus offered by the review sources. These
 * are future handoffs; the driver still requires native completion and never
 * approves ExitPlanMode or treats this selection as completion. */
export function pickPlanReviewQuestion(question: NativeQuestion): number {
  const lead = planReviewQuestionLead(question);
  const nextReview = /^(?:next review|next steps?|what['’]s next)\b/i.test(question.header.trim())
    || /^(?:next reviews?|next steps?|what['’]s next)\b/i.test(lead.trim());
  const recommended = () => {
    const choices = question.options.flatMap((option, index) =>
      /\s\(recommended\)\s*$/i.test(option.label) ? [index + 1] : []);
    if (choices.length > 1) throw new Error('Review question has multiple recommended options');
    return choices[0] ?? 1;
  };
  if (!nextReview) return recommended();
  const labels = question.options.map(option => planReviewOptionLabel(option.label));
  const run = (label: string) => /^(?:Run )?\/plan-(?:ceo|eng|design|devex)-review(?: (?:next|first))?(?:\s*\((?:required gate|only if UI scope detected(?: and no design review exists)?|only if fundamental product gaps found|only if significant product change and no CEO review exists)\))?$/i.test(label)
    || /^(?:Run )?\/design-shotgun(?: to explore visual variants| for visual variants| after adding an OpenAI key|\s*[—–-]\s*explore visual design variants for issues found)?$/i.test(label)
    || /^(?:Run )?\/design-html(?:\s*[—–-]\s*generate Pretext-native HTML from approved mockups)?$/i.test(label);
  // A bare Skip declines only an offered, recognized follow-up in this handoff.
  const offersFollowUp = labels.some(run);
  const manual = (label: string) => /^Skip\s*[,:;.—–-]\s*(?:I(?:['’]ll| will)\s+)?handle (?:reviews|next steps) manually$/i.test(label)
    || (offersFollowUp && (/^(?:Skip|Handle manually)$/i.test(label) || /^Skip\s*[,:;.—–-]\s*handle manually$/i.test(label) || /^Skip, manual next steps$/i.test(label)));
  const future = (label: string) => /^Ready to implement(?:\s*[—–-]\s*run \/ship when done)?$/i.test(label)
    || /^Ready to implement[,;] (?:run )?\/devex-review after shipping$/i.test(label)
    || (offersFollowUp && (/^Implement, then \/devex-review$/i.test(label)
      || /^Implement now, \/devex-review after$/i.test(label)));
  if (!labels.some(label => run(label) || manual(label) || future(label))) return recommended();
  const manualChoices = labels.flatMap((label, index) => manual(label) ? [index + 1] : []);
  const futureChoices = labels.flatMap((label, index) => future(label) ? [index + 1] : []);
  const choices = manualChoices.length ? manualChoices : futureChoices;
  if (choices.length !== 1 || labels.some(label => !run(label) && !manual(label) && !future(label))) {
    throw new Error('Review handoff has no unambiguous offered manual or future-follow-up choice\n' + JSON.stringify({
      header: question.header.slice(0, 80), lead: lead.slice(0, 240), optionCount: labels.length,
      options: question.options.slice(0, 8).map((option, index) => ({
        index: index + 1, label: option.label.slice(0, 256),
        run: run(labels[index]!), manual: manual(labels[index]!), future: future(labels[index]!),
      })),
      omittedOptions: Math.max(0, labels.length - 8),
    }));
  }
  return choices[0]!;
}
