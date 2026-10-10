/**
 * Gate integrity in /ship and the shared scan block
 * (docs/designs/HONEST_WORK_GATE_INTEGRITY.md W1 block, W3).
 *
 * What these protect: the one scan block is shared by /review and /ship and
 * branches on the helper's exit instead of swallowing it; /ship runs it before
 * the checklist read, again after the test-generation child returns and again
 * after its own fixes; gate findings take the four gate options and the record
 * fields the logger expects; zero-run lanes are a failed lane, not a pass; the
 * PR body discloses gate edits and per-lane counts; an open finding keeps a new
 * PR a draft. Tokens, order and meaning-level rules only (docs/test-value-bar.md).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateGateScanBlock } from '../scripts/resolvers/gate-scan';
import { RESOLVERS } from '../scripts/resolvers/index';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between, compact, expectAbsent, expectMentions, expectOrdered, expectTokens } from './helpers/prompt-structure';

const root = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const ctx = (host: TemplateContext['host'], skillName: string): TemplateContext =>
  ({ skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host, paths: HOST_PATHS[host] });

const GATE_OPTIONS = ['A) Restore the gate', 'B) Keep — justified', 'C) Keep — other reason', 'D) Leave open for a later human'];
const RECORD_FIELDS = ['`gate`', '`gate_id`', '`reason`', '"kept"', '"restored"', '"open"', '`actor`'];

test('GATE_SCAN_BLOCK is registered and renders the same errexit-safe block for review and ship from the host bin dir', () => {
  expect(RESOLVERS.GATE_SCAN_BLOCK).toBe(generateGateScanBlock);
  for (const host of ['claude', 'codex'] as const) {
    const review = generateGateScanBlock(ctx(host, 'review'));
    expect(generateGateScanBlock(ctx(host, 'ship'))).toBe(review);
    expect(review).toContain(`if GATE_OUT=$(${HOST_PATHS[host].binDir}/gstack-gate-diff <base> 2>&1); then`);
  }
  const block = generateGateScanBlock(ctx('claude', 'review'));
  const bash = between(block, '```bash', '\n```');
  expectOrdered(bash, ['if GATE_OUT=$(', 'then', 'else', 'GATE_EXIT=$?', 'case "$GATE_EXIT" in', '2) echo "Gate integrity: UNAVAILABLE', "grep -m1 '^GATE_ERROR='", '*) echo "Gate integrity: UNAVAILABLE', 'esac', 'fi'], 'gate scan bash');
  expectAbsent(bash, ['2>/dev/null', '|| true'], 'gate scan bash');
  expectTokens(block, ['GATE_SUMMARY: listed=N eligible=N inspected=N unread=N tagged={RH-1:N,...} unmatched=N coverage=<patterns> languages_unlisted=<idioms> candidate=<fingerprint> artifact=<path>',
    '[<id>] <tag> <path> @<hunk>', 'GATE_ERROR=no_base ref=<ref>', '`gate_id`', '`gate`', 'Gate edits: partial ('], 'gate scan prose');
  expectMentions(compact(block), [
    ['unavailable', 'never', 'none detected'],
    ['unread', 'partial'],
    ['data', 'never', 'instructions'],
  ], 'gate scan prose');
});

test('/ship runs the gate scan before the checklist read, again after the coverage child, and again after its own fixes', () => {
  const army = read('ship/sections/review-army.md.tmpl');
  expectOrdered(army, ['### Core checklist', 'gstack-review-log --start review', '2.5. **Gate scan.**', '{{GATE_SCAN_BLOCK}}',
    '3. Apply the review checklist', 'Gate Integrity', '## Step 9.4:'], 'ship review-army');
  expect(army.match(/\{\{GATE_SCAN_BLOCK\}\}/g)).toHaveLength(1);
  const fix = compact(between(army, '## Step 9.4:', '### Decide whether to repeat Step 9'));
  expectMentions(fix, [['after', 'fix', 'gate scan', 'again'], ['never', 'paths', 'child', 'reported']], 'Step 9.4 rescan');

  const coverage = read('ship/sections/test-coverage.md.tmpl');
  const parent = between(coverage, '**Parent processing:**', '**Audit failure:**');
  expectOrdered(parent, ['6. Print a one-line summary', '7. **Rescan gate edits after the child returns.**', '{{GATE_SCAN_BLOCK}}', 'Gate Integrity'], 'Step 7 parent rescan');
  expectMentions(compact(parent), [['never', 'paths', 'child', 'reported'], ['child', 'green', 'claim']], 'Step 7 parent rescan');
  const child = between(coverage, '````text', '````');
  expectAbsent(child, ['GATE_SCAN_BLOCK', 'gate_id'], 'Step 7 child prompt');
  expect(child).toContain('{"coverage_pct":N,"gaps":N,"diagram":');
});

test('/ship gate findings take the four gate options in order and persist the record fields', () => {
  const army = read('ship/sections/review-army.md.tmpl');
  const ask = compact(between(army, '3. **If ASK items remain,**', '4. **Finish and log this pass'));
  expectOrdered(ask, ['A) Fix B) Skip', 'review-gate-disposition', '<gstack-qid:review-gate-disposition>', ...GATE_OPTIONS], 'Step 9.4 gate question');
  expectMentions(ask, [['spawned', 'headless', 'd', 'recommended'], ['auto-chosen', 'never', 'disposition']], 'Step 9.4 gate question');
  const persist = compact(between(army, '6. Persist the review result', '### Decide whether to repeat Step 9'));
  expectTokens(persist, RECORD_FIELDS, 'Step 9.4 record');
  expectMentions(persist, [['never', 'hunk text'], ['`open`', 'count', '`issues_found`'], ['logger', 'stamps', '`actor`']], 'Step 9.4 record');
  const summary = compact(between(army, '5. Output summary:', '6. Persist the review result'));
  expectOrdered(summary, ['`Gate edits: none detected (', '`Gate edits: N listed, M read, K findings —', '`Gate edits: partial (', '`Gate edits: UNAVAILABLE —'], 'Step 9.4 summary');
});

test('/ship passes a lane on its runner summary with three never-merged tests_ran states', () => {
  const step5 = between(read('ship/sections/tests.md.tmpl'), '## Step 5: Run tests', '## Step 6:');
  expectOrdered(step5, ['`tests_ran: N`', '`tests_ran: 0`', 'ZERO-RUN', '`tests_ran: unknown`', '`count unavailable`', '{{TEST_FAILURE_TRIAGE}}'], 'Step 5 count states');
  expectMentions(compact(step5), [['runner summary', 'not', 'exit 0 alone'], ['zero-run', 'failed lane'], ['never', 'merge']], 'Step 5 count states');
  const stage4 = compact(between(read('ship/SKILL.md.tmpl'), '### 4. Verify the frozen candidate', '### 5. Report, then push'));
  expect(stage4).toMatch(/\| ZERO-RUN[^|]*\|[^|]*STALE-equivalent[^|]*never FRESH/);
  expect(stage4).toMatch(/\| `tests_ran: unknown` \|[^|]*`count unavailable`/);
});

test('/ship Step 16 stage 5 reports each gate finding with disposition, reason and actor in the auditor posture', () => {
  const stage5 = compact(between(read('ship/SKILL.md.tmpl'), '### 5. Report, then push', '## Step 17: Push'));
  expectTokens(stage5, ['`gate`', '`kept`', '`restored`', '`open`', '`reason`', '`actor`', '`tests_ran`', 'none detected (', 'partial (', 'UNAVAILABLE'], 'Step 16 stage 5');
  expectMentions(stage5, [['evidence', 'examine', 'not', 'defend']], 'Step 16 stage 5');
});

test('/ship PR body carries the Gate edits line and per-lane counts, and an open finding keeps a new PR a draft', () => {
  const body = read('ship/sections/pr-body.md.tmpl');
  const skeleton = between(body, '## Summary', '#### Compose the body');
  const coverage = between(skeleton, '## Test Coverage', '## Pre-Landing Review');
  expectTokens(coverage, ['Tests ran: <lane> N', 'Tests ran: <lane> count unavailable', '`tests_ran`'], 'PR body Test Coverage');
  const review = between(skeleton, '## Pre-Landing Review', '## Exploratory QA');
  expectOrdered(review, ['<findings from Step 9 code review', '<Gate edits:', 'none detected (', 'kept', 'open', 'UNAVAILABLE', '<Outside review:'], 'PR body Pre-Landing Review');
  expectMentions(compact(review), [['never', 'none detected', 'partial', 'unavailable'], ['no hunk text']], 'PR body Pre-Landing Review');

  const publish = between(body, '**Existing open PR/MR**', 'Branch on the exit code');
  const existing = compact(between(publish, '**Existing open PR/MR**', '**No open PR/MR:**'));
  expectOrdered(existing, ['gstack-post pr-body <pr-number>', 'gstack-post pr-title <pr-number>', 'no gate finding is `open`', 'gh pr ready <pr-number>', 'Draft kept: Gate edits: N open', 'Step 17'], 'existing PR draft state');
  const create = compact(between(publish, '**No open PR/MR:**'));
  expect(create).toContain('gstack-post pr-create --base <base> --title-file "$TITLE_FILE" --body-file');
  expectMentions(create, [['`--draft`', 'gate finding', '`open`'], ['never', 'infers approval', 'pr existing']], 'new PR draft state');
  const failure = compact(between(body, '- **3** `gh`/`glab` failed', '- Any other exit'));
  expectMentions(failure, [['open gate findings', 'not disclosed'], ['never', 'disclosure', 'done']], 'disclosure failure');
});

test('/ship Step 17 stops a spawned or headless session before pushing open gate findings to a ready PR and asks an interactive one once', () => {
  const step17 = compact(between(read('ship/SKILL.md.tmpl'), '## Step 17: Push', '**Idempotency check:**'));
  expectOrdered(step17, ['**Open gate findings against an existing ready PR/MR:**', 'gh pr list --head <branch-name> --state open --json number,isDraft',
    '`SESSION_KIND: spawned` or `headless`', '**STOP before pushing.**', 'A) Resolve the open items now', 'B) Publish ready with the `Gate edits: N open` banner'], 'Step 17 ready-PR gate');
  expectMentions(step17, [['record', 'b', 'human-authorised'], ['never', 'convert', 'ready', 'draft'], ['new pr', 'draft', 'no question']], 'Step 17 ready-PR gate');
});

test('the catalog carries every id gstack uses with the source attribution', () => {
  const catalog = read('review/gate-integrity.md');
  expect(catalog).toContain('Adapted from the just-say-no-to-process-porn-and-ceremony skill');
  expectMentions(compact(catalog), [['pattern names preserved', 'names are the deterrent']], 'catalog attribution');
  for (const id of ['RH-1', 'RH-2', 'RH-3', 'RH-4', 'RH-5', 'RH-10', 'RH-12', 'RH-13', 'RH-14', 'RH-15', 'RH-16', 'PL-1', 'PL-2']) {
    expect(catalog, `catalog lacks a heading for ${id}`).toMatch(new RegExp(`^### ${id} — `, 'm'));
  }
});
