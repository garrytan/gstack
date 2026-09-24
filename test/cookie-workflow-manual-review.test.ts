import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCookieWorkflowJudgeInput, COOKIE_WORKFLOW_JUDGE } from './helpers/cookie-workflow-judge-input';
import { COOKIE_MANUAL_REVIEW_FILE, getCookieWorkflowManualReview, isManualReviewEntry, manualReviewProblem } from './helpers/cookie-workflow-manual-review';
import { manualReviewFixture } from './helpers/manual-judge-review-fixture';
import { validWorkflowJudgeScore } from './helpers/workflow-judge-cache';

const ROOT = resolve(import.meta.dir, '..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cookie-policy-')); roots.push(root);
  for (const file of [COOKIE_MANUAL_REVIEW_FILE, 'setup-browser-cookies/SKILL.md', 'BROWSER.md']) {
    const target = join(root, file); mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(join(ROOT, file)));
  }
  const entry = manualReviewFixture(root);
  const approval = entry.manual_review!.approval;
  const request = { testName: entry.name, prompt: entry.prompt!, model: entry.model!,
    maxTokens: approval.max_tokens, thresholds: { ...approval.thresholds }, attempt: 1 };
  return { root, entry, approval, request, refusal: entry.manual_review!.refusal };
}

test('the committed approval names precisely the complete reviewed request, not a numerical score', () => {
  const f = fixture();
  expect(buildCookieWorkflowJudgeInput(ROOT).sha256).toBe(f.approval.prompt_sha256);
  expect(f.approval.thresholds).toEqual(COOKIE_WORKFLOW_JUDGE.thresholds);
  expect(isManualReviewEntry(f.entry)).toBe(true);
  expect(manualReviewProblem(f.entry, ROOT)).toBeNull();
  expect(getCookieWorkflowManualReview(f.root, f.request, f.refusal)).toEqual(f.entry.manual_review);
  expect(validWorkflowJudgeScore(f.entry as any, f.request.thresholds)).toBe(false);
  expect(validWorkflowJudgeScore(f.entry.manual_review as any, f.request.thresholds)).toBe(false);
});

test.each(['case', 'prompt', 'model', 'budget', 'thresholds', 'source', 'approval', 'retry'])(
  'admission rejects mismatched %s without changing the approval', mismatch => {
    const f = fixture(); const original = readFileSync(join(f.root, COOKIE_MANUAL_REVIEW_FILE), 'utf8');
    if (mismatch === 'case') f.request.testName = 'ship/SKILL.md workflow';
    if (mismatch === 'prompt') f.request.prompt += '\n';
    if (mismatch === 'model') f.request.model += '-other';
    if (mismatch === 'budget') f.request.maxTokens++;
    if (mismatch === 'thresholds') f.request.thresholds.clarity++;
    if (mismatch === 'retry') f.request.attempt++;
    if (mismatch === 'source') writeFileSync(join(f.root, 'BROWSER.md'), readFileSync(join(f.root, 'BROWSER.md'), 'utf8').replace('Storage stays intact', 'Changed storage stays intact'));
    if (mismatch === 'approval') writeFileSync(join(f.root, COOKIE_MANUAL_REVIEW_FILE), JSON.stringify({ ...f.approval, prompt_sha256: 'a'.repeat(64) }));
    expect(getCookieWorkflowManualReview(f.root, f.request, f.refusal)).toBeNull();
    if (mismatch !== 'approval') expect(readFileSync(join(f.root, COOKIE_MANUAL_REVIEW_FILE), 'utf8')).toBe(original);
  });

test.each(['passed', 'scores', 'reused', 'timeout', 'case', 'suite', 'prompt', 'model', 'refusal', 'missing-id', 'missing-response-id', 'output', 'text', 'tokens', 'schema', 'retry'])(
  'malformed manual receipt %s cannot count as acceptance', invalid => {
    const f = fixture(); const entry: any = f.entry;
    if (invalid === 'passed') entry.passed = true;
    if (invalid === 'retry') entry.attempt++;
    if (invalid === 'scores') entry.judge_scores = { clarity: 1 };
    if (invalid === 'reused') entry.execution = 'reused';
    if (invalid === 'timeout') entry.exit_reason = 'timeout';
    if (invalid === 'case') entry.name = 'ship/SKILL.md workflow';
    if (invalid === 'suite') entry.suite = 'Unrelated suite';
    if (invalid === 'prompt') entry.prompt += '\n';
    if (invalid === 'model') entry.model = 'another-model';
    if (invalid === 'refusal') entry.manual_review.refusal.stop_reason = 'end_turn';
    if (invalid === 'missing-id') entry.manual_review.refusal.request_id = null;
    if (invalid === 'missing-response-id') entry.manual_review.refusal.response_id = null;
    if (invalid === 'output') entry.manual_review.refusal.output_tokens = 1;
    if (invalid === 'text') entry.manual_review.refusal.text_blocks = 1;
    if (invalid === 'tokens') entry.manual_review.refusal.input_tokens = -1;
    if (invalid === 'schema') entry.manual_review.approval.schema_version = 2;
    expect(isManualReviewEntry(entry)).toBe(false);
    expect(manualReviewProblem(entry, f.root)).not.toBeNull();
  });

test('reconciliation rejects changed source, approval provenance, missing approval and corrupt JSON', () => {
  const f = fixture();
  const modified = structuredClone(f.entry);
  modified.manual_review!.approval.approved_by = 'unapproved-reviewer';
  expect(manualReviewProblem(modified, f.root)).not.toBeNull();
  const file = join(f.root, COOKIE_MANUAL_REVIEW_FILE);
  writeFileSync(file, '{');
  expect(manualReviewProblem(f.entry, f.root)).not.toBeNull();
  rmSync(file);
  expect(manualReviewProblem(f.entry, f.root)).not.toBeNull();
  writeFileSync(file, JSON.stringify(f.approval));
  writeFileSync(join(f.root, 'BROWSER.md'), readFileSync(join(f.root, 'BROWSER.md'), 'utf8').replace('Storage stays intact', 'Changed storage stays intact'));
  expect(manualReviewProblem(f.entry, f.root)).not.toBeNull();
  expect(isManualReviewEntry(f.entry)).toBe(true);
});

test('a current judge-model override cannot reuse the different approved model', () => {
  const f = fixture();
  const original = process.env.GSTACK_EVAL_MODEL_JUDGE;
  try {
    process.env.GSTACK_EVAL_MODEL_JUDGE = 'synthetic-unapproved-model';
    expect(manualReviewProblem(f.entry, f.root)).toBe('Manual review model is not the current judge model');
    expect(isManualReviewEntry(f.entry)).toBe(true);
  } finally {
    if (original === undefined) delete process.env.GSTACK_EVAL_MODEL_JUDGE;
    else process.env.GSTACK_EVAL_MODEL_JUDGE = original;
  }
});
