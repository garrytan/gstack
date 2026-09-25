import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalTestEntry } from './eval-store';
import { buildCookieWorkflowJudgeInput } from './cookie-workflow-judge-input';
import { COOKIE_MANUAL_REVIEW_FILE } from './cookie-workflow-manual-review';

export function manualReviewFixture(root = resolve(import.meta.dir, '../..')): EvalTestEntry {
  const approval = JSON.parse(readFileSync(resolve(root, COOKIE_MANUAL_REVIEW_FILE), 'utf8'));
  return {
    name: 'setup-browser-cookies/SKILL.md workflow', suite: 'Cookie setup workflow quality', tier: 'llm-judge',
    passed: false, execution: 'executed', exit_reason: 'provider_refusal', attempt: 1, duration_ms: 1, cost_usd: 0,
    model: approval.model, prompt: buildCookieWorkflowJudgeInput(root).prompt,
    error: 'Synthetic provider refusal fixture, not live model evidence',
    manual_review: { approval, refusal: { stop_reason: 'refusal', response_id: 'msg_synthetic_fixture',
      request_id: 'req_synthetic_fixture', model: approval.model, input_tokens: 1, output_tokens: 0, text_blocks: 0 } },
  };
}
