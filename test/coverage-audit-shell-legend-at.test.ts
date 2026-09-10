import { expect, test } from 'bun:test';
import captured from './fixtures/coverage-audit-shell-legend-at.json';
import { coverageAuditReadEvidence, coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const both = { sourceRead: true, testsRead: true };
const neither = { sourceRead: false, testsRead: false };
function owned(index: number) {
  const row = structuredClone(captured[index]!) as any;
  const useEvent = row.result.transcript.find((event: any) => event.message?.content.some((block: any) =>
    block.type === 'tool_use' && block.name === 'Bash' && block.input.command.includes('cat -n src/billing.ts')));
  const use = useEvent.message.content.find((block: any) => block.type === 'tool_use' && block.name === 'Bash' && block.input.command.includes('cat -n src/billing.ts'));
  const resultEvent = row.result.transcript.find((event: any) => event.message?.content.some((block: any) => block.type === 'tool_result' && block.tool_use_id === use.id));
  row.result.transcript = [row.result.transcript.find((event: any) => event.type === 'system' && event.subtype === 'init'), useEvent, resultEvent];
  return { row, use, resultEvent, delivered: resultEvent.message.content.find((block: any) => block.tool_use_id === use.id) };
}
function reads(index: number, mutate?: (s: ReturnType<typeof owned>) => void) {
  const s = owned(index); mutate?.(s);
  return coverageAuditReadEvidence(s.row.result.transcript, s.row.files);
}
const flat = (legend = 'Legend  [ OK ]  covered   [ GAP ]  no test') =>
  '```text\nprocessPayment(amount, currency)\n├── happy path return success [ OK ]\nrefundPayment(paymentId, reason)\n└── happy path return refunded [ GAP ]\n' + legend + '\n```';
const diagram = (output: string) => coverageAuditVerdict({ ...captured[1]!.result, output } as any, captured[1]!.files).diagram;

test('exact public AT first, retry and engineering outputs retain all required native evidence', () => {
  expect(captured.map(row => row.recordedPassed)).toEqual([false, false, true]);
  for (const row of captured) expect(coverageAuditVerdict(row.result as any, row.files)).toEqual({ ...both, diagram: true, passed: true, failures: [] });
  expect(reads(0)).toEqual(both); expect(reads(1)).toEqual(both);
});

test('literal grep display options and filename captions do not own source bytes', () => {
  for (const flags of ['-n', '-n -i', '-n -B1 -A200', '-n -i -B3 -A40']) {
    expect(reads(0, s => { s.use.input.command = s.use.input.command.replace('-n -i -B3 -A40', flags); })).toEqual(both);
  }
  for (const replace of ['echo \'=== another-file.md ===\'', 'echo "--- src/billing.ts ---"', 'echo']) {
    expect(reads(1, s => { s.use.input.command = s.use.input.command.replace('echo "=== testing.md ==="', replace); })).toEqual(both);
  }
  expect(reads(1, s => { s.use.input.command = s.use.input.command.replace('git diff main --stat', 'git diff HEAD~1 --stat'); })).toEqual(both);
});

test('escaped grep patterns keep a closed flag and literal operand grammar', () => {
  for (const replacement of ['-n -i -B3 -A40 -f other', '-n -i --include=*', '-n -B-1', '-n -A100000', '-n -i -B3 -A40; false']) {
    expect(reads(0, s => { s.use.input.command = s.use.input.command.replace('-n -i -B3 -A40', replacement); })).toEqual(neither);
  }
  for (const operand of ['-f/tmp/foreign', '"-f/tmp/foreign"', 'review/SKILL.md --include=*']) {
    expect(reads(0, s => { s.use.input.command = s.use.input.command.replace('review/SKILL.md |', operand + ' |'); })).toEqual(neither);
  }
});

test('successful conditional display paths reject execution, substitutions and hidden failure', () => {
  for (const replacement of [
    'echo -e "=== testing.md ==="', 'printf "=== testing.md ==="', 'echo "$(cat fake)"', 'echo `cat fake`',
    'echo "=== testing.md ==="; false', 'false || echo "=== testing.md ==="', 'unknown',
    'echo "cat -n src/billing.ts"', 'echo "=== testing.md ===\\nreplacement"',
    'cd ../sibling', 'env PATH=/tmp cat fake', 'echo "=== testing.md ===" > src/billing.ts',
  ]) expect(reads(1, s => { s.use.input.command = s.use.input.command.replace('echo "=== testing.md ==="', replacement); })).toEqual(neither);
  for (const command of ['git diff --ext-diff --stat', 'git diff main --output=src/billing.ts --stat', 'git -c core.pager=evil diff main --stat', 'git diff --no-index main --stat', 'git diff main --stat || echo ok']) {
    expect(reads(1, s => { s.use.input.command = s.use.input.command.replace('git diff main --stat', command); })).toEqual(neither);
  }
});

test('a valid display path still requires one complete successful owned delivery', () => {
  for (const index of [0, 1]) for (const mutate of [
    (s: ReturnType<typeof owned>) => { s.delivered.is_error = true; },
    (s: ReturnType<typeof owned>) => { s.delivered.content = 'src/billing.ts and test/billing.test.ts were read'; },
    (s: ReturnType<typeof owned>) => { s.delivered.content = s.row.files.source.content.slice(0, 80); },
    (s: ReturnType<typeof owned>) => { s.resultEvent.session_id = 'foreign'; },
    (s: ReturnType<typeof owned>) => { s.resultEvent.parent_tool_use_id = 'child'; },
    (s: ReturnType<typeof owned>) => { s.delivered.tool_use_id = 'foreign'; },
    (s: ReturnType<typeof owned>) => { s.row.result.transcript.push(structuredClone(s.resultEvent)); },
    (s: ReturnType<typeof owned>) => { s.use.input.command = s.use.input.command.replace('cat -n src/billing.ts', 'echo src/billing.ts').replace('cat -n test/billing.test.ts', 'echo test/billing.test.ts'); },
  ]) expect(reads(index, mutate)).toEqual(neither);
  expect(reads(1, s => { s.delivered.content = s.row.files.source.content; })).toEqual({ sourceRead: true, testsRead: false });
  expect(reads(1, s => { s.delivered.content = s.row.files.tests.content; })).toEqual({ sourceRead: false, testsRead: true });
});

test('text statuses use the declared local meanings with whitespace and either pair order', () => {
  for (const legend of ['Legend [ OK ] covered [ GAP ] no test', 'Legend: [OK] tested | [GAP] untested', 'Legend: [ GAP ] no test; [ OK ] covered']) expect(diagram(flat(legend))).toBe(true);
  expect(diagram(flat().replaceAll('[ OK ]', '[OK]').replaceAll('[ GAP ]', '[GAP]'))).toBe(true);
  expect(diagram(flat().replace('Legend  [ OK ]  covered   [ GAP ]  no test\n', '').replace('processPayment', 'Legend [ OK ] covered [ GAP ] no test\nprocessPayment'))).toBe(true);
});

test('missing, malformed, contradictory or foreign text legends cannot grant coverage', () => {
  for (const legend of ['', '> Legend [ OK ] covered [ GAP ] no test', '"Legend [ OK ] covered [ GAP ] no test"',
    'Example: Legend [ OK ] covered [ GAP ] no test', 'If enabled, Legend [ OK ] covered [ GAP ] no test',
    'Legend [ OK ] no test [ GAP ] covered', 'Legend [ OK ] covered [ GAP ] covered',
    'Legend [ OK ] covered [ OK ] no test', 'Legend [ OK ] covered [ GAP ] no test except refunds',
    'Legend [ OK ] covered [ GAP ] no test\nLegend [ OK ] no test [ GAP ] covered',
  ]) expect(diagram(flat(legend))).toBe(false);
  expect(diagram('```text\nLegend [ OK ] covered [ GAP ] no test\n```\n' + flat(''))).toBe(false);
  for (const status of ['cancelled', 'canceled', 'rejected', 'retracted', 'withdrawn', "'withdrawn'", '‘superseded’', '`no longer current`', '"not current"']) {
    expect(diagram(flat('Legend [ OK ] covered [ GAP ] no test\nThis legend is ' + status + '.'))).toBe(false);
  }
  expect(diagram(flat('Legend [ OK ] covered [ GAP ] no test\n> An old note said: "This legend is withdrawn."'))).toBe(true);
});

test('text marker corrections grant only the final unambiguous owned row state', () => {
  expect(diagram(flat().replace('success [ OK ]', 'success [ GAP ] -> [ OK ]'))).toBe(true);
  expect(diagram(flat().replace('refunded [ GAP ]', 'refunded [ OK ] → [ GAP ]'))).toBe(true);
  for (const [old, replacement] of [
    ['success [ OK ]', 'success COVERED [ OK ] → [ GAP ]'],
    ['refunded [ GAP ]', 'refunded UNTESTED [ GAP ] -> [ OK ]'],
    ['success [ OK ]', 'success COVERED [ OK ] [ GAP ]'],
    ['refunded [ GAP ]', 'refunded [GAP] [ GAP ] [ OK ]'],
    ['success [ OK ]', 'success not [ OK ]'], ['refunded [ GAP ]', 'refunded [ GAP ] is incorrect'],
    ['success [ OK ]', 'success not covered [ OK ]'], ['refunded [ GAP ]', 'refunded no coverage gaps [ GAP ]'],
  ]) expect(diagram(flat().replace(old!, replacement!))).toBe(false);
});

test('text coverage markers retain function, subtree, column and source ownership', () => {
  for (const output of [
    flat().replace('processPayment', 'otherPayment'), flat().replace('refundPayment', 'otherRefund'),
    flat().replace('├── happy', 'otherFunction()\n├── happy'), flat().replace('└── happy', 'otherFunction()\n└── happy'),
    flat().replace('success [ OK ]', 'success     ├── [ OK ]'), flat().replace('refunded [ GAP ]', 'refunded     └── [ GAP ]'),
    flat().split('\n').map(line => '> ' + line).join('\n'), '````markdown\n' + flat() + '\n````', 'Example:\n' + flat(),
  ]) expect(diagram(output)).toBe(false);
});

test('the regression fixture and controls select both paid coverage owners', () => {
  for (const file of ['test/coverage-audit-shell-legend-at.test.ts', 'test/fixtures/coverage-audit-shell-legend-at.json']) expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-coverage-audit', 'review-coverage-audit']);
});
