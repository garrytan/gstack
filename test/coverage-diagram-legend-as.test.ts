import { expect, test } from 'bun:test';
import captured from './fixtures/coverage-diagram-legend-as.json';
import billing from './fixtures/coverage-audit-ae.json';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

function verdict(output: string, index = 0) {
  const row = captured.rows[index]!;
  return coverageAuditVerdict({ ...row.result, output } as any, {
    cwd: row.cwd,
    source: { path: row.cwd + '/src/billing.ts', content: billing.files.source },
    tests: { path: row.cwd + '/test/billing.test.ts', content: billing.files.tests },
  });
}
const diagram = (output: string) => verdict(output).diagram;
const flat = (legend = 'Legend: [✔] tested   [✘] GAP (no test)') => '```text\n' + legend + '\nprocessPayment(amount, currency)\n├──► return success [✔]\nrefundPayment(paymentId, reason)\n└──► return refunded [✘]\n```';

test('both exact public outputs contain the seeded diagram and retain actual native file delivery', () => {
  for (let i = 0; i < captured.rows.length; i++) {
    expect(verdict(captured.rows[i]!.result.output, i)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
  }
  expect(captured.provenance.originalAttemptOutcomes).toEqual(['failed', 'failed']);
  expect(captured.provenance.paidOutcomesReclassified).toBe(false);
});

test('closed legend annotations preserve the same two meanings and arrow branch ownership', () => {
  for (const legend of ['Legend: [✔] tested   [✘] GAP', 'Legend: [✔] tested   [✘] GAP (no test)', 'Legend: [✔] tested   [✘] GAP   ──► branch', 'Legend: [✔] tested   [✘] GAP (no test) ──► branch']) {
    expect(diagram(flat(legend))).toBe(true);
    expect(diagram(flat(legend).replace(/^([├└]─+)►/gm, '$1'))).toBe(true);
    expect(diagram(flat(legend).replaceAll('✔', '✓').replaceAll('✘', '✗'))).toBe(true);
  }
});

test('extra legend explanations cannot invert, qualify or fabricate coverage meanings', () => {
  for (const legend of ['', 'Legend: [✔] GAP   [✘] tested', 'Legend: [✔] tested   [✘] tested', 'Legend: [✔] tested   [✘] GAP (not a gap)', 'Legend: [✔] tested   [✘] GAP except refunds', 'Legend: [✔] tested   [✘] GAP   [✘] covered', 'Example: [✔] tested   [✘] GAP', 'Legend: not [✔] tested   [✘] GAP', 'Legend: [✔] tested   [✘] GAP   ──► covered']) {
    expect(diagram(flat(legend))).toBe(false);
  }
});

test('a branch status correction supplies its final state and ambiguous markers supply neither', () => {
  expect(diagram(flat().replace('return refunded [✘]', 'return refunded [✔]→[✘]'))).toBe(true);
  expect(diagram(flat().replace('return success [✔]', 'return success [✘]->[✔]'))).toBe(true);
  expect(diagram(flat().replace('return success [✔]', 'return success [✔]→[✘]'))).toBe(false);
  expect(diagram(flat().replace('return refunded [✘]', 'return refunded [✘]→[✔]'))).toBe(false);
  expect(diagram(flat().replace('return success [✔]', 'return success [✔] [✘]'))).toBe(false);
  expect(diagram(flat().replace('return refunded [✘]', 'return refunded [✘] [✔]'))).toBe(false);
});

test('literal labels cannot override a final or ambiguous bracketed symbol state', () => {
  for (const [old, replacement] of [
    ['return success [✔]', 'return success TESTED [✔]→[✘]'],
    ['return refunded [✘]', 'return refunded UNTESTED [✘]→[✔]'],
    ['return success [✔]', 'return success TESTED [✔] [✘]'],
    ['return refunded [✘]', 'return refunded [GAP] [✘] [✔]'],
  ]) expect(diagram(flat().replace(old!, replacement!))).toBe(false);
});

test('each seeded function must own its own branch and legend in the same current diagram', () => {
  for (const output of [
    flat().replace('refundPayment', 'otherRefund'), flat().replace('processPayment', 'otherPayment'),
    flat().replace('├──► return success [✔]', 'unrelatedHelper()\n├──► return success [✔]'),
    flat().replace('└──► return refunded [✘]', 'unrelatedHelper()\n└──► return refunded [✘]'),
    flat().split('\n').map(line => '> ' + line).join('\n'), '````markdown\n' + flat() + '\n````',
    'Example:\n' + flat(), flat().replace('[✔] tested   [✘] GAP (no test)', '[✔] tested (not covered)   [✘] GAP'),
    '```text\nLegend: [✔] tested   [✘] GAP\n```\n' + flat(''),
  ]) expect(diagram(output)).toBe(false);
});

test('successful diagram parsing cannot replace successful capture or native file delivery', () => {
  const row = captured.rows[0]!;
  const files = { cwd: row.cwd, source: { path: row.cwd + '/src/billing.ts', content: billing.files.source }, tests: { path: row.cwd + '/test/billing.test.ts', content: billing.files.tests } };
  for (const mutate of [
    (r: any) => { r.exitReason = 'timeout'; }, (r: any) => { r.browseErrors = ['read failed']; },
    (r: any) => { r.transcript = []; }, (r: any) => { r.transcript[2].message.content[0].is_error = true; },
    (r: any) => { r.transcript[2].message.content[0].content = 'Both filenames were read'; },
  ]) {
    const result = structuredClone(row.result); mutate(result);
    const checked = coverageAuditVerdict(result as any, files);
    expect(checked.diagram).toBe(true); expect(checked.passed).toBe(false);
  }
});

test('new parser regression artifacts select both coverage audit owners', () => {
  for (const file of ['test/coverage-diagram-legend-as.test.ts', 'test/fixtures/coverage-diagram-legend-as.json']) expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-coverage-audit', 'review-coverage-audit']);
});
