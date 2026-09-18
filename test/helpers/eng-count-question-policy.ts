import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import type { NativeQuestion } from './plan-skill-questions';

type Commitment = Readonly<{ id: string; label: string; description: string }>;

/** Author-owned offered choices. Exact native label AND description establish
 * authority; arbitrary question prose and recommendations never enlarge it.
 * This is an explicit fixture interface, not a natural-language classifier. */
export const ENG_COUNT_COMMITMENTS: readonly Commitment[] = Object.freeze([
  { id: 'keep-seeded-scope', label: 'Keep seeded scope',
    description: 'Keep only the implementation scope already proposed in PLAN.md. The review must still address every seeded issue. ✅ Retains the requested refactor. ❌ Does not remove its existing defects. No additional feature or product behavior is authorized; explain and record this scope choice.' },
  { id: 'keep-classes', label: 'Keep five classes',
    description: 'Keep AuthBroker, TokenStore, SessionMint, AuthCache and RequestPolicy in the proposed refactor. Explain their responsibilities and tradeoff in the review. ✅ Retains the proposed class scope. ❌ Does not reduce its complexity. No new feature, service or product behavior is authorized.' },
  { id: 'reduce-classes', label: 'Simplify class layout',
    description: 'Consolidate responsibilities only among the five proposed classes and the existing cache adapter. Explain the resulting arrangement in the review. ✅ Reduces structural overhead. ❌ Requires changing the proposed boundaries. Preserve existing product behavior; no new responsibility or feature is authorized.' },
  { id: 'cache-ownership', label: 'Own existing cache',
    description: 'Authorize explicit dependency ownership and isolated mutation responsibility for the existing AuthCache. Explain the proposed ownership and its tests in the review. ✅ Addresses module-level mutable sharing. ❌ Requires wiring changes. Retain the existing adapter, key, validity and invalidation contracts; no new storage or cross-request coordination is authorized.' },
  { id: 'error-handling', label: 'Handle existing errors',
    description: 'Authorize explicit handling or propagation of the existing failure classes in validateAndDispatch. Explain the mapping and its tests in the review. ✅ Makes hidden failures explicit. ❌ Requires caller and test review. Preserve the existing observable outcome contract; no new product policy, network behavior, retry or timeout is authorized.' },
  { id: 'parallel-idp', label: 'Parallelize five calls',
    description: 'Authorize concurrent execution of only the five existing independent IDP calls within each request. Explain independence and error behavior in the review. ✅ Removes their sequential wait. ❌ Requires concurrency tests. Preserve the existing success and failure policy; no extra calls, cross-request deduplication, new timeout or retry is authorized.' },
  { id: 'tests-only', label: 'Tests only',
    description: 'Authorize adding or updating tests only for this plan and already-authorized changes. The review must identify and explain the concrete test obligations. ✅ Adds evidence. ❌ Authorizes no production implementation or behavior change. Record this exact answer without treating any unperformed test as passed.' },
  { id: 'document-only', label: 'Document only',
    description: 'Authorize documenting the existing component contract, evidence gap or risk described in this review. ✅ Makes the current constraint explicit. ❌ Does not implement a remedy. No new product behavior or implementation permission is granted; retain any unresolved work honestly.' },
  { id: 'retain-behavior', label: 'Keep current behavior',
    description: 'Decline the proposed additional behavior and keep the existing behavior for this decision. ✅ Keeps this refactor within its stated scope. ❌ Leaves the additional risk or opportunity unchanged. The review may report that finding; no new state, network call, product policy or implementation is authorized.' },
  { id: 'defer', label: 'Defer implementation',
    description: 'Defer the proposed implementation to separate future work. ✅ Records the issue without expanding this refactor. ❌ Leaves its implementation unresolved. Explain the deferred work in the review; this grants no permission to start it and no completed-work credit.' },
  { id: 'finish', label: 'Finish; follow up later',
    description: 'Finish this engineering review after its required report and completion steps. I will handle later reviews and implementation manually. ✅ Keeps this invocation bounded. ❌ Provides no follow-up review coverage. No implementation or additional skill invocation is authorized.' },
  { id: 'continue', label: 'Continue this review',
    description: 'Continue only the remaining required work of this engineering review. ✅ Allows its current obligations to finish. ❌ Does not authorize another review or implementation. Existing scope, permissions and unresolved conditions remain unchanged.' },
].map(row => Object.freeze(row)));

const ACTOR_INSTRUCTIONS = [
  '## Declared review actor interface',
  'The plan above remains the review target, including every seeded issue. Do not change its findings, prescribe a question count/order, or treat this interface as test evidence.',
  'For each native question, offer exactly one applicable author-owned choice from the catalog below, alongside your own alternatives. Copy that choice’s label and description exactly, with no recommendation tag, preview or additional option fields. Other offered choices remain unapproved and may be freely worded.',
  'The actor selects only that complete copied commitment. Put the question-specific explanation, recommendation, pros/cons and comparisons in the question text; none can add authority to the copied commitment. A recommendation for a different option remains visible and is not approved.',
  'Zero or multiple catalog matches, modified or spoofed commitments, and duplicate labels for the selected choice stop this fixture without an answer. Reordering intact options does not change which commitment is authorized.',
  'The catalog does not require an item to be offered or supply any missing review analysis. The review must discover and justify its own test obligations. Actual answers and the complete report remain required.',
  '```json',
  JSON.stringify(ENG_COUNT_COMMITMENTS.map(({ label, description }) => ({ label, description })), null, 2),
  '```',
].join('\n');

export function engCountActorRequest(seed: string): string {
  if (!seed.trim() || seed.includes('## Declared review actor interface')) throw new Error('Eng actor requires one original seed');
  return `${seed}\n\n${ACTOR_INSTRUCTIONS}`;
}

/** No normalization: whitespace, punctuation, labels and descriptions belong to
 * this explicit interface. Reordering intact choices preserves their intent. */
export function pickEngCountQuestion(question: NativeQuestion): number {
  if (!question.header?.trim() || !question.question?.trim() || question.multiSelect ||
      question.options.length < 2 || question.options.length > 4)
    throw new Error('Eng actor requires one complete single-choice question');
  const matches = question.options.flatMap((option, index) =>
    ENG_COUNT_COMMITMENTS.some(row => row.label === option.label && row.description === option.description) ? [index] : []);
  if (matches.length !== 1) throw new Error('Eng actor requires exactly one complete author-owned offered commitment');
  const index = matches[0]!, selected = question.options[index]!;
  if (Object.keys(selected).some(key => key !== 'label' && key !== 'description') ||
      question.options.filter(option => option.label === selected.label).length !== 1)
    throw new Error('Eng actor received a modified or ambiguous selected commitment');
  return index + 1;
}

/** Bind the declared request to the actual isolated seed and the existing
 * runner's complete current native active-tab capture. No UI-only fallback. */
export function createEngCountActor(request: string) {
  if (!request.endsWith(`\n\n${ACTOR_INSTRUCTIONS}`)) throw new Error('Eng actor request lacks its declared catalog');
  let session: string | undefined;
  return (_routing: AskUserQuestionFingerprint, active: AskUserQuestionFingerprint,
    context: Readonly<{ cwd: string; deadlineAt: number }>): number => {
    const file = path.join(context.cwd, 'PLAN.md'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== request ||
        !Number.isFinite(context.deadlineAt) || context.deadlineAt <= Date.now())
      throw new Error('Eng actor requires the current owned request and original deadline');
    const call = active.nativeCall, index = active.nativeQuestionIndex;
    const question = index === undefined ? undefined : call?.questions[index];
    const signature = call && `${call.sessionId}:${call.toolUseId}`;
    if (!call || !call.sessionId || !call.toolUseId || call.answered || call.failed || !question ||
        (session !== undefined && session !== call.sessionId) || call.answers?.[question.question] !== undefined ||
        active.signature !== (call.questions.length === 1 ? signature : `${signature}:question:${index}`) ||
        active.promptSnippet !== `${question.header} ${question.question}` ||
        active.options.length !== question.options.length || !active.options.every((option, i) =>
          option.index === i + 1 && option.label === question.options[i]!.label))
      throw new Error('Eng actor requires the complete matched pending native tab');
    const chosen = pickEngCountQuestion(question);
    session ??= call.sessionId;
    return chosen;
  };
}
