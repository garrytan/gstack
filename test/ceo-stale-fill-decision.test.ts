import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasApprovedStaleFillDecision } from './helpers/ceo-stale-fill-decision';
import { CEO_SECTION_CACHE_PLAN, hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';

const dir = path.join(import.meta.dir, 'fixtures', 'ceo-stale-fill-decision');
const capture = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
// census-37193478719: the skill names ledger rows freely (CEO-F1), not only R<n>.
const MISSED = ['census-37182865432-missed.md', 'census-37178734784-missed.md', 'census-37193478719-missed.md'];
const PASSED = 'census-37179171083-passed.md';

describe('CEO stale-fill decision from the skill-defined ledger and currentDecision records', () => {
  test('both census reports the phrase detector missed, and the one it passed, record the approved race decision', () => {
    for (const name of MISSED) {
      expect(hasStaleFillRaceFinding(capture(name)), name).toBe(false);
      expect(hasApprovedStaleFillDecision(capture(name)), name).toBe(true);
    }
    expect(hasStaleFillRaceFinding(capture(PASSED))).toBe(true);
    expect(hasApprovedStaleFillDecision(capture(PASSED))).toBe(true);
  });

  test('the unreviewed plan has no decision', () => {
    expect(hasApprovedStaleFillDecision(CEO_SECTION_CACHE_PLAN)).toBe(false);
  });

  const report = capture(MISSED[0]!);
  const row = report.split('\n').find(line => line.startsWith('| R1 '))!;
  const cells = row.trim().slice(1, -1).split('|');
  const withStatus = (status: string) => report.replace(row, `|${cells.slice(0, 4).join('|')}| ${status} |${cells[5]}|`);
  const question = report.split('\n').find(line => line.startsWith('Question: D1'))!;

  test.each(['unresolved', 'reopened', 'deferred', 'declined'])('rejects a %s ledger row', status => {
    expect(hasApprovedStaleFillDecision(withStatus(status))).toBe(false);
  });

  test.each([
    ['an unrelated question', report.replace(question, 'Question: D1 — R1: Should cache adapter failures bypass the cache until reinitialized?')],
    ['a later row that reopens it', report.replace(row, `${row}\n${withStatus('reopened').split('\n').find(line => line.startsWith('| R1 '))}`)],
    ['no ledger header', report.replace(/^\| ID and owner \|.*$/m, '| ID | Evidence | Current | Proposed | Status | Approval |')],
    ['a quoted decision block', report.replace(/^## currentDecision \(R1\)$/m, '> ## currentDecision (R1)')],
    ['a ledger row for another ID', report.replace(row, row.replace(/^\| R1\b/, '| R7'))],
  ])('rejects %s', (_name, text) => {
    expect(hasApprovedStaleFillDecision(text)).toBe(false);
  });

  test('accepts the other recorded shapes: a named row ID and an approval that does not cite the decision ID', () => {
    expect(hasApprovedStaleFillDecision(report.replaceAll('(R1)', '(R1-STALE-FILL)').replace(row, row.replace(/^\| R1\b/, '| R1-STALE-FILL'))
      .replace(question, question.replace('— R1:', '— R1-STALE-FILL:')))).toBe(true);
    expect(hasApprovedStaleFillDecision(report.replace(row, `|${cells.slice(0, 5).join('|')}| Selected **A** under the author policy. |`))).toBe(true);
    expect(hasApprovedStaleFillDecision(withStatus('**approved**'))).toBe(true);
  });

  test('a fenced copy of the records is not a decision', () => {
    expect(hasApprovedStaleFillDecision('```text\n' + report.replaceAll('```', '') + '\n```')).toBe(false);
  });
});

describe('structured reader alone on the plan-ceo-section-loading corpus', () => {
  const corpus = path.join(import.meta.dir, 'fixtures', 'detector-corpora', 'plan-ceo-section-loading');
  const entry = (name: string): string => JSON.parse(fs.readFileSync(path.join(corpus, name), 'utf8')).input.report;
  const camelWrite = entry('37186854666-t1-pass.json');
  const camelQuestion = camelWrite.split('\n').find(line => line.startsWith('Question: D1'))!;

  test('reads an approved decision whose question names the write as writeProfile (37186854666)', () => {
    expect(camelQuestion).toContain('writeProfile');
    expect(hasApprovedStaleFillDecision(camelWrite)).toBe(true);
  });

  test('reads an approved decision under the slash-joined row ID D1 / STALE-FILL (37195203538)', () => {
    expect(hasApprovedStaleFillDecision(entry('37195203538-t1-pass.json'))).toBe(true);
  });

  test('still refuses an unrelated decision, the copied plan and an unresolved ledger row', () => {
    expect(hasApprovedStaleFillDecision(entry('37182865432-t1-fail-derived-unrelated-decision.json'))).toBe(false);
    expect(hasApprovedStaleFillDecision(CEO_SECTION_CACHE_PLAN)).toBe(false);
    expect(hasApprovedStaleFillDecision(entry('37174266054-t1-pass.json'))).toBe(false);
  });

  test.each(['rewriteProfile', 'isWriteable', 'writeable'])('a question whose only write term is %s is not the race', identifier => {
    expect(hasApprovedStaleFillDecision(camelWrite.replace(camelQuestion, camelQuestion.replace('writeProfile', identifier)))).toBe(false);
  });

  test('a slash-joined ID still needs its own approved ledger row', () => {
    const report = entry('37195203538-t1-pass.json');
    expect(hasApprovedStaleFillDecision(report.replaceAll('| D1 / STALE-FILL ', '| D1 / OTHER-ROW '))).toBe(false);
  });
});
