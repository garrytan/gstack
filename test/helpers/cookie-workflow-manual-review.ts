/** Recognizes historical cookie-workflow manual-review records; the judge and its approval are retired. */
import { createHash } from 'node:crypto';
import type { JudgeRefusalEvidence } from './llm-judge';

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
