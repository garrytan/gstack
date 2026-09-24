import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCookieWorkflowJudgeInput, COOKIE_WORKFLOW_JUDGE } from './cookie-workflow-judge-input';
import type { JudgeRefusalEvidence } from './llm-judge';
import { DEFAULT_JUDGE_MAX_TOKENS, resolveEvalModel } from '../../lib/eval-model';

export const COOKIE_MANUAL_REVIEW_FILE = '.github/cookie-workflow-manual-review.json';
const CASE = 'setup-browser-cookies/SKILL.md workflow';
type Thresholds = { clarity: number; completeness: number; actionability: number };

export interface CookieManualApproval {
  schema_version: 1;
  test_name: typeof CASE;
  prompt_sha256: string;
  prompt_bytes: number;
  model: string;
  max_tokens: number;
  thresholds: Thresholds;
  approved_by: string;
  approved_at: string;
  approval_url: string;
  reason: string;
}

export interface ManualJudgeReview {
  approval: CookieManualApproval;
  refusal: JudgeRefusalEvidence;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const dimensions = ['clarity', 'completeness', 'actionability'] as const;
const sameThresholds = (a: Thresholds, b: Thresholds) => dimensions.every(key => a[key] === b[key]);

function validApproval(value: unknown): value is CookieManualApproval {
  return object(value) && value.schema_version === 1 && value.test_name === CASE
    && typeof value.prompt_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.prompt_sha256)
    && Number.isSafeInteger(value.prompt_bytes) && value.prompt_bytes > 0
    && nonempty(value.model) && Number.isSafeInteger(value.max_tokens) && value.max_tokens > 0
    && object(value.thresholds) && dimensions.every(key => Number.isInteger(value.thresholds[key]) && value.thresholds[key] >= 1 && value.thresholds[key] <= 5)
    && nonempty(value.approved_by) && typeof value.approved_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.approved_at)
    && typeof value.approval_url === 'string' && /^https:\/\/github\.com\/garrytan\/gstack\/pull\/2964#issuecomment-\d+$/.test(value.approval_url)
    && nonempty(value.reason);
}

function validRefusal(value: unknown, model: string): value is JudgeRefusalEvidence {
  return object(value) && value.stop_reason === 'refusal' && value.model === model
    && nonempty(value.response_id) && nonempty(value.request_id)
    && Number.isSafeInteger(value.input_tokens) && value.input_tokens >= 0
    && value.output_tokens === 0 && value.text_blocks === 0;
}

export function isManualReviewEntry(entry: unknown): boolean {
  if (!object(entry) || entry.name !== CASE || entry.suite !== 'Cookie setup workflow quality'
    || entry.tier !== 'llm-judge' || entry.passed !== false
    || entry.attempt !== 1
    || entry.execution !== 'executed' || entry.exit_reason !== 'provider_refusal'
    || entry.judge_scores !== undefined || entry.judge_reasoning !== undefined || entry.reused_from !== undefined
    || typeof entry.prompt !== 'string' || !object(entry.manual_review)) return false;
  const { approval, refusal } = entry.manual_review;
  return validApproval(approval) && entry.model === approval.model && validRefusal(refusal, approval.model)
    && Buffer.byteLength(entry.prompt) === approval.prompt_bytes
    && createHash('sha256').update(entry.prompt).digest('hex') === approval.prompt_sha256;
}

export function getCookieWorkflowManualReview(root: string, request: {
  testName: string; prompt: string; model: string; maxTokens: number; thresholds: Thresholds; attempt: number;
}, refusal: JudgeRefusalEvidence): ManualJudgeReview | null {
  if (request.testName !== CASE || request.attempt !== 1 || !validRefusal(refusal, request.model)) return null;
  let approval: unknown;
  try { approval = JSON.parse(readFileSync(join(root, COOKIE_MANUAL_REVIEW_FILE), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!validApproval(approval)) throw new Error('Invalid cookie workflow manual-review approval');
  const current = buildCookieWorkflowJudgeInput(root);
  if (request.prompt !== current.prompt || current.sha256 !== approval.prompt_sha256
    || Buffer.byteLength(request.prompt) !== approval.prompt_bytes || request.model !== approval.model
    || request.maxTokens !== approval.max_tokens || request.maxTokens !== DEFAULT_JUDGE_MAX_TOKENS
    || !sameThresholds(request.thresholds, approval.thresholds)
    || !sameThresholds(request.thresholds, COOKIE_WORKFLOW_JUDGE.thresholds)) return null;
  return { approval, refusal };
}

export function manualReviewProblem(entry: unknown, root: string): string | null {
  if (!object(entry) || !Object.hasOwn(entry, 'manual_review')) return null;
  if (!isManualReviewEntry(entry)) return 'Malformed manual-review claim';
  if (entry.model !== resolveEvalModel('judge')) return 'Manual review model is not the current judge model';
  try {
    const claimed = entry.manual_review as ManualJudgeReview;
    const verified = getCookieWorkflowManualReview(root, { testName: entry.name, prompt: entry.prompt,
      model: entry.model, maxTokens: claimed.approval.max_tokens, thresholds: claimed.approval.thresholds,
      attempt: entry.attempt }, claimed.refusal);
    if (!verified || Object.entries(verified.approval).some(([key, value]) => key === 'thresholds'
      ? !sameThresholds(value as Thresholds, claimed.approval.thresholds)
      : value !== claimed.approval[key as keyof CookieManualApproval])) return 'Manual review does not match current source and approval';
    return null;
  } catch { return 'Manual review approval or current input is unavailable or invalid'; }
}
