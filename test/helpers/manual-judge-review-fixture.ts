import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvalTestEntry } from './eval-store';
import { buildCookieWorkflowJudgeInput } from './cookie-workflow-judge-input';
import { COOKIE_MANUAL_REVIEW_FILE } from './cookie-workflow-manual-review';

export function approvedCookieWorkflowSource(source: string): string {
  return source
    .replace('sha256sum < "$tmpfile" | awk \'{print $(1)}\'', 'sha256sum "$tmpfile" | awk \'{print $1}\'')
    .replace('shasum -a 256 < "$tmpfile" | awk \'{print $(1)}\'', 'shasum -a 256 "$tmpfile" | awk \'{print $1}\'');
}

export function manualReviewFixture(root = resolve(import.meta.dir, '../..')): EvalTestEntry {
  const approval = JSON.parse(readFileSync(resolve(root, COOKIE_MANUAL_REVIEW_FILE), 'utf8'));
  const prompt = approvedCookieWorkflowSource(buildCookieWorkflowJudgeInput(root).prompt);
  if (createHash('sha256').update(prompt).digest('hex') !== approval.prompt_sha256
    || Buffer.byteLength(prompt) !== approval.prompt_bytes) {
    throw new Error('Historical cookie approval fixture no longer reconstructs the exact approved prompt');
  }
  return {
    name: 'setup-browser-cookies/SKILL.md workflow', suite: 'Cookie setup workflow quality', tier: 'llm-judge',
    passed: false, execution: 'executed', exit_reason: 'provider_refusal', attempt: 1, duration_ms: 1, cost_usd: 0,
    model: approval.model, prompt,
    error: 'Synthetic provider refusal fixture, not live model evidence',
    manual_review: { approval, refusal: { stop_reason: 'refusal', response_id: 'msg_synthetic_fixture',
      request_id: 'req_synthetic_fixture', model: approval.model, input_tokens: 1, output_tokens: 0, text_blocks: 0 } },
  };
}
