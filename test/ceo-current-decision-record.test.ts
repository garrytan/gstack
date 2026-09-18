/** Free count replay only. The original paid failures and checkpoint violations remain failures. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-current-decision-cdd-public.json';
import exactFields from './fixtures/ceo-native-fields-f359.json';
import retryRecord from './fixtures/ceo-current-record-6aef.json';

type Capture = typeof captured.captures[number];
const clone = <T>(value: T): T => structuredClone(value);

// The original retry changed its question, B label and every description after
// a complete Read. The separate anchor regression uses explicitly synchronized
// counterfactual fields; neither route promotes the original failed attempt.
const retryProjection = retryRecord.segments.map(segment => segment.text).join('\n');
const retryQuestion = retryRecord.call.questions[0]!;
const retryRecordStart = retryProjection.indexOf('## currentDecision (R4)');
const retryFieldsStart = retryProjection.indexOf('Question:', retryRecordStart);
const retryExactFields = `Question: ${retryQuestion.question}\nHeader: ${retryQuestion.header}\n` +
  retryQuestion.options.map((option, index) =>
    `${/^[A-D][).:]\s/.test(option.label) ? '' : `${'ABCD'[index]}) `}${option.label}\n${option.description}`).join('\n') + '\n';
const retrySynchronized = retryProjection.slice(0, retryFieldsStart) + retryExactFields;
function countRetryRecord(plan: string, call = clone(retryRecord.call)) {
  const counter = createCeoPaymentFindingCounter(retryRecord.seed, () => plan, () => false);
  const counted = counter.isReviewAUQ(nativePlanCallFingerprint(call, 1, false));
  return { counted, trace: counter.trace };
}
test('6aef retry literal source projection preserves actual native drift rejection', () => {
  for (const segment of retryRecord.segments)
    expect(createHash('sha256').update(segment.text).digest('hex')).toBe(segment.sha256);
  expect(retryRecordStart).toBeGreaterThan(0); expect(retryFieldsStart).toBeGreaterThan(retryRecordStart);
  expect(retryRecord.call.answered).toBe(true);
  expect(() => countRetryRecord(retryProjection)).toThrow(/Unsupported/);
  expect(countRetryRecord(retrySynchronized)).toMatchObject({ counted: true });
  expect(countRetryRecord(retrySynchronized).trace.at(-1)).toMatchObject({ kind: 'recorded-decision', ledgerId: 'R4' });
});
for (const heading of [
  '### Per-item coverage (pending R4)', '### Test coverage for R4', '### TODO follow-up (R4)',
  '### R4 section notes', '### R4 implementation tasks',
]) test(`an incidental current row heading does not own a second record: ${heading}`, () => {
  expect(countRetryRecord(retrySynchronized.replace('### Per-item coverage (pending R4)', heading)).counted).toBe(true);
});
test('a contextual parent row heading does not borrow the nested record fields', () => {
  const plan = retrySynchronized.replace('## currentDecision (R4)', '## R4 coverage context\n\n### currentDecision (R4)');
  expect(countRetryRecord(plan).counted).toBe(true);
});
for (const heading of ['## R4 decision', '## Pending R4 options', '## R4 comparison'])
  test(`a generic owned heading can introduce complete native fields: ${heading}`, () => {
    expect(countRetryRecord(retrySynchronized.replace('## currentDecision (R4)', heading)).counted).toBe(true);
  });
// A declaration owns a record regardless of row/name order or whether its
// fields have been filled yet; incompleteness cannot remove an ambiguity.
for (const kind of ['decision', 'review', 'options', 'approaches', 'comparison'])
  for (const heading of [`## ${kind} R4`, `## R4 ${kind}`, `## Pending R4 ${kind}`, `## Current ${kind} for R4`])
    for (const body of ['', '\n\nStatus: pending'])
      test(`an explicit record declaration competes before its fields exist: ${heading} ${body}`, () => {
        expect(() => countRetryRecord(retrySynchronized + '\n\n' + heading + body)).toThrow(/Unsupported/);
      });

for (const [name, record] of Object.entries({
  'empty named heading': '## currentDecision (R4)',
  'explicit decision status': '## Decision R4\n\nStatus: pending',
  'explicit review state': '## Review R4\n\nState: current',
  'empty decision declaration': '## Decision R4',
  'empty review declaration': '## Review R4',
  'incomplete named heading': '## currentDecision (R4)\n\nQuestion: incomplete',
  'empty named paragraph': '**currentDecision: R4**',
  'explicit options declaration': 'Options for R4:',
  'question fields': '## R4 other record\n\nQuestion: another question',
  'header fields': '## R4 other record\n\nHeader: another question',
  'option paragraph': '## R4 other record\n\nA) Another option\nB) Another choice',
  'option list': '## R4 other record\n\n- A) Another option\n- B) Another choice',
  'option comparison table': '## R4 other record\n\n| Option | Effort |\n| --- | --- |\n| A | S |\n| B | M |',
  'column comparison table': '## R4 other record\n\n| Commitment | A | B |\n| --- | --- | --- |\n| Work | fixed | changed |',
  'literal comparison grid': '## R4 other record\n\n```text\nCommitment | A | B\nWork | fixed | changed\n```',
  'complete duplicate': '## currentDecision (R4)\n\n' + retryExactFields,
})) test(`a competing current record remains ambiguous: ${name}`, () => {
  const plan = retrySynchronized + '\n\n' + record + '\n';
  expect(() => countRetryRecord(plan)).toThrow(/Unsupported/);
});
for (const example of [
  '> Question: example only', '```text\nQuestion: example only\nHeader: example\n```',
  '"Question: example only"', '`Question: example only`',
]) test(`quoted field examples do not own another current record: ${JSON.stringify(example)}`, () => {
  expect(countRetryRecord(retrySynchronized + '\n\n## R4 explanatory notes\n\n' + example).counted).toBe(true);
});
for (const [name, change] of Object.entries({
  question: (s: string) => s.replace(retryQuestion.question, retryQuestion.question + ' Changed.'),
  label: (s: string) => s.replace(retryQuestion.options[1]!.label, 'B) Changed choice'),
  description: (s: string) => s.replace(retryQuestion.options[0]!.description!, 'Shortened description.'),
  source: (s: string) => s.replaceAll('PLAN.md', 'other/PLAN.md'),
  row: (s: string) => s.replace('## currentDecision (R4)', '## currentDecision (R99)'),
})) test(`incidental headings cannot bypass native or source identity: ${name}`, () => {
  const plan = change(retrySynchronized); expect(plan).not.toBe(retrySynchronized);
  expect(() => countRetryRecord(plan)).toThrow(/Unsupported/);
});
test('a complete saved record still needs an actual answer', () => {
  const call = clone(retryRecord.call); call.answered = false;
  expect(() => countRetryRecord(retrySynchronized, call)).toThrow(/Unsupported|Invalid/);
});

const paired = captured.captures[0]!, distinct = captured.captures[1]!, retry = captured.captures[2]!;
function replay(row: Capture, plan = row.savedPlan, calls = clone(row.calls)) {
  const counter = createCeoPaymentFindingCounter(row.source, () => plan, ceoFirstReviewAUQ);
  const counted = calls.map((call, index) => counter.isReviewAUQ(nativePlanCallFingerprint(call, 1, false), calls.slice(0, index)));
  return { counted, trace: counter.trace };
}
function reject(row: Capture, plan: string, calls = clone(row.calls)) {
  expect(() => replay(row, plan, calls)).toThrow(/Unsupported|Invalid/);
}
for (const row of captured.captures) test(`${row.name}: exact public calls and saved record receive count credit, never paid PASS credit`, () => {
  expect(createHash('sha256').update(row.source).digest('hex')).toBe(row.sourceSha256);
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedSha256);
  expect(row.originalOutcome).toBe('FAIL'); expect(row.paidPassCredit).toBe(0);
  const result = replay(row);
  expect(result.counted).toEqual(row.calls.map((_, i) => i === row.calls.length - 1));
  expect(result.trace.at(-1)).toMatchObject({ kind: 'recorded-decision', ledgerId: row === paired ? 'D1' : 'R1' });
});

const pairedMarker = paired.savedPlan.match(/^\*\*(currentDecision: D1[^\n]+)\*\*$/m)![1]!;
for (const marker of [pairedMarker, `**${pairedMarker}**`, `### ${pairedMarker}`, `#### ${pairedMarker}`])
  test(`current comparison marker retains Markdown presentation ${marker.slice(0, 20)}`, () => {
    expect(replay(paired, paired.savedPlan.replace(`**${pairedMarker}**`, marker)).counted.at(-1)).toBe(true);
  });
const rowMarker = distinct.savedPlan.match(/^\*\*(Row R1[^\n]+)\*\*$/m)![1]!;
for (const marker of [rowMarker, `**${rowMarker}**`, `### ${rowMarker}`])
  test(`row marker under currentDecision retains Markdown presentation ${marker.slice(0, 14)}`, () => {
    expect(replay(distinct, distinct.savedPlan.replace(`**${rowMarker}**`, marker)).counted.at(-1)).toBe(true);
  });
for (const row of [paired, distinct]) {
  const marker = row === paired ? pairedMarker : rowMarker;
  const id = row === paired ? 'D1' : 'R1';
  for (const [name, change] of Object.entries({
    'quoted marker': (s: string) => s.replace(`**${marker}**`, `> **${marker}**`),
    'fenced marker': (s: string) => s.replace(`**${marker}**`, '```text\n'+marker+'\n```'),
    'different row marker': (s: string) => s.replace(`**${marker}**`, `**${marker.replace(id, 'R999')}**`),
    'duplicated current marker': (s: string) => s.replace(`**${marker}**`, `**${marker}**\n\n**${marker}**`),
    'withdrawn current marker': (s: string) => s.replace(`**${marker}**`, `**${marker}**\nThis decision is withdrawn.`),
    'historical comparison': (s: string) => s.replace(`**${marker}**`, `## Historical comparison\n\n**${marker}**`),
    'foreign source': (s: string) => s.replaceAll('PLAN.md', 'other/PLAN.md'),
    'missing source': (s: string) => s.replaceAll('PLAN.md', 'input'),
    'missing current row': (s: string) => s.replace(new RegExp('^\\| '+id+'(?:\\s|\\|)[^\\n]+\\n','m'), ''),
    'missing option risk': (s: string) => s.replace('Risk low.', ''),
    'invalid option risk': (s: string) => s.replace('Risk low.', 'Risk unknown.'),
    'invalid option effort': (s: string) => s.replace('Effort S ', 'Effort XS '),
    'withdrawn option': (s: string) => s.replace('Pros:', 'Pros: This option is withdrawn.'),
  })) test(`${row.name}: current paragraph rejects ${name}`, () => {
    const changed = change(row.savedPlan); expect(changed !== row.savedPlan).toBe(true); reject(row, changed);
  });
}
test('bare Row marker cannot borrow a non-currentDecision heading', () => {
  reject(distinct, distinct.savedPlan.replace('## currentDecision', '## Unrelated notes'));
});

for (const verb of ['Keep', 'Retain', 'Preserve']) for (const form of ['suffix', 'prefix', 'description']) test(`saved and offered ${verb} baseline resolve symmetrically (${form})`, () => {
  const calls = clone(retry.calls), q = calls.at(-1)!.questions[0]!;
  q.options[2]!.label = q.options[2]!.label.replace('Keep', verb);
  const caption = form === 'suffix' ? `C) ${verb} truthy only (as planned).`
    : form === 'prefix' ? `**C) As planned: ${verb} truthy only.**` : `**C) ${verb} truthy only** (as planned) —`;
  const plan = retry.savedPlan.replace('C) Keep truthy only (as planned).', caption);
  expect(replay(retry, plan, calls).counted.at(-1)).toBe(true);
});
for (const [name, caption] of Object.entries({
  'added action': 'Keep truthy only and delete records',
  'changed negation': 'Do not keep truthy only',
  'narrowed scope': 'Keep truthy only for admins',
  'different baseline': 'Keep rejection only',
})) test(`same-letter saved baseline rejects ${name}`, () => {
  reject(retry, retry.savedPlan.replace('C) Keep truthy only (as planned).', `C) ${caption} (as planned).`));
});

// Exercise the existing strict exact-native-fields path with the new marker
// presentations. This is distinct from the older complete-prose count path.
const q = exactFields.call.questions[0]!;
const begin = exactFields.savedPlan.indexOf('### currentDecision (D1)');
const end = exactFields.savedPlan.indexOf('## NOT in scope', begin);
const fields = ['Question: '+q.question, 'Header: '+q.header,
  ...q.options.map(o => o.label+'\n'+o.description)].join('\n\n');
function exactPlan(marker: string, body = fields) {
  return exactFields.savedPlan.slice(0, begin)+marker+'\n\n'+body+'\n\n'+exactFields.savedPlan.slice(end);
}
function exactCount(plan: string, call = clone(exactFields.call)) {
  return createCeoPaymentFindingCounter(exactFields.seed, () => plan, ceoFirstReviewAUQ)
    .isReviewAUQ(nativePlanCallFingerprint(call, 1, false));
}
for (const marker of ['**Row D1 — current question**', '**currentDecision (D1)**']) {
  const heading = '### currentDecision (D1)';
  test(`one exact record retains its heading plus immediate paragraph marker ${marker}`, () => {
    expect(exactCount(exactPlan(heading+'\n\n'+marker))).toBe(true);
  });
  test(`same-row heading continuation cannot hide a second full record ${marker}`, () => {
    expect(() => exactCount(exactPlan(heading+'\n\n'+marker, fields+'\n\n'+heading+'\n\n'+marker+'\n\n'+fields))).toThrow(/Unsupported/);
  });
  test(`same-row heading continuation cannot hide a later paragraph record ${marker}`, () => {
    expect(() => exactCount(exactPlan(heading+'\n\n'+marker, fields+'\n\n'+marker+'\n\n'+fields))).toThrow(/Unsupported/);
  });
}
for (const marker of ['### currentDecision (D1)', '**currentDecision (D1)**', 'currentDecision (D1)']) {
  test(`full native fields count with ${marker}`, () => expect(exactCount(exactPlan(marker))).toBe(true));
  for (const [name, change] of Object.entries({
    'missing Question': (s: string) => s.replace('Question: '+q.question, ''),
    'mismatched Header': (s: string) => s.replace('Header: '+q.header, 'Header: Another decision'),
    'missing option description': (s: string) => s.replace(q.options[0]!.description!, ''),
    'invalid effort domain': (s: string) => s.replace('Effort S', 'Effort XS'),
    'invalid risk domain': (s: string) => s.replace(/Risk (?:low|medium|high)/i, 'Risk unknown'),
  })) test(`${marker}: strict native fields reject ${name}`, () => {
    expect(() => exactCount(exactPlan(marker, change(fields)))).toThrow(/Unsupported/);
  });
}
for (const row of captured.captures) for (const defect of ['missing ACK', 'failed ACK', 'unoffered answer', 'foreign identity'])
  test(`${row.name}: paragraph normalization retains ${defect} rejection`, () => {
    const calls = clone(row.calls), call = calls.at(-1)!;
    if (defect === 'missing ACK') call.answered = false;
    if (defect === 'failed ACK') call.failed = true;
    if (defect === 'unoffered answer') call.answers = { [call.questions[0]!.question]: 'Not offered' };
    if (defect === 'foreign identity') call.sessionId = '';
    reject(row, row.savedPlan, calls);
  });

test('distinct retry retains its actual preceding D2 count and rejects D3 without an owned ledger row', () => {
  const row = captured.rejectedMissingRow;
  expect(row.originalOutcome).toBe('FAIL'); expect(row.paidPassCredit).toBe(0);
  expect(createHash('sha256').update(row.source).digest('hex')).toBe(row.sourceSha256);
  row.plans.forEach((plan, i) => {
    expect(createHash('sha256').update(plan).digest('hex')).toBe(row.planSha256[i]);
    expect(Date.parse(row.snapshotTimes[i]!)).toBeLessThan(Date.parse(row.questionTimes[i]!));
  });
  let plan = row.plans[0]!;
  const counter = createCeoPaymentFindingCounter(row.source, () => plan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[0]!), 1, false))).toBe(false);
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[1]!), 1, false), row.calls.slice(0, 1))).toBe(true);
  plan = row.plans[1]!;
  expect(plan).toContain('### currentDecision (D3, owner Section 2)');
  expect(/^\| D3\b/m.test(plan)).toBe(false);
  expect(() => counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[2]!), 1, false), row.calls.slice(0, 2))).toThrow(/Unsupported/);
  expect(counter.trace).toHaveLength(2);
});

test('the actual CEO save layout preserves the full native payload and separates prior records', () => {
  const template = readFileSync(`${import.meta.dir}/../plan-ceo-review/SKILL.md.tmpl`, 'utf8');
  const layout = template.match(/```text\n(  ## currentDecision \(ROW-ID\)[\s\S]+?)\n  ```/);
  expect(layout).not.toBeNull();
  const grid = exactFields.savedPlan.slice(begin, end).match(/```text\n[\s\S]+?\n```/);
  expect(grid).not.toBeNull();
  // Fill the actual source example with the existing captured native fields;
  // do not reconstruct a more permissive format or promote its original FAIL.
  const record = layout![1]!.replace(/^  /gm, '')
    .replace('ROW-ID', 'D1').replace('<complete grid>', '\n\n'+grid![0])
    .replace('<complete currentDecision.question>', q.question)
    .replace('<exact currentDecision.header>', q.header)
    .replace('A) <exact first option label>', q.options[0]!.label)
    .replace('<full first option description>', q.options[0]!.description!)
    .replace('B) <exact second option label>', q.options[1]!.label)
    .replace('<full second option description; repeat for all offered options>',
      q.options[1]!.description!+'\n'+q.options[2]!.label+'\n'+q.options[2]!.description!);
  const saved = (section: string) => exactFields.savedPlan.slice(0, begin)+section+'\n\n'+exactFields.savedPlan.slice(end);
  expect(exactCount(saved(record))).toBe(true);
  const prior = '## Answered decision D0\nExact approval: prior answer A, scope unchanged.\n'+fields.replaceAll('D1', 'D0');
  expect(exactCount(saved(prior+'\n\n'+record))).toBe(true);
  for (const changed of [
    record.replace(q.question, q.question.split('\n')[0]!),
    record.replace(q.question.split('\n')[0]!, q.question.split('\n')[0]!+' (changed title)'),
    record.replace('Header: '+q.header, 'Header: Another decision'),
    record.replace(q.options[0]!.label, 'A) Delete every test'),
    record+'\n\n'+fields.replaceAll('D1', 'D0'),
    record+'\n\n'+record,
    '```text\n'+record+'\n```',
    record.replace('Question: ', 'Question:\n'),
    record.replace('Header: '+q.header, 'Header: '+q.header+'\nOptions:'),
  ]) {
    expect(changed).not.toBe(record);
    expect(() => exactCount(saved(changed))).toThrow(/Unsupported/);
  }
});

test('a reopened row has one current comparison alongside its answered decision history', () => {
  const oldFields = fields.replace(q.question, q.question.replace(/^D1 — /, 'D0 — D1: '));
  const currentRecord = '### currentDecision (D1)\n'+fields;
  const prior = (heading: string) => heading+'\n\nAnswer: A; prior choice retained in history.\n\n'+oldFields;
  const replaceRecord = (record: string) => exactFields.savedPlan.slice(0, begin)+record+'\n\n'+exactFields.savedPlan.slice(end);
  for (const heading of ['### Answered decision (D1) — D0', '### Answered decisions for D1']) {
    expect(exactCount(replaceRecord(prior(heading)+'\n\n'+currentRecord))).toBe(true);
    // An answered record cannot supply the missing current comparison.
    expect(() => exactCount(replaceRecord(prior(heading)))).toThrow(/Unsupported/);
    // A second current record still conflicts; history does not hide it.
    expect(() => exactCount(replaceRecord(prior(heading)+'\n\n'+currentRecord+'\n\n'+currentRecord))).toThrow(/Unsupported/);
  }
  for (const heading of ['### Unanswered decision (D1)', '### Not answered decision (D1)', '### currentDecision (D1)']) {
    expect(() => exactCount(replaceRecord(prior(heading)+'\n\n'+currentRecord))).toThrow(/Unsupported/);
  }
});

test('prepared native identity distinguishes the question number from its ledger row before saving', () => {
  const template = readFileSync(`${import.meta.dir}/../plan-ceo-review/SKILL.md.tmpl`, 'utf8');
  const titleLayout = template.match(/`(D<N> — <ROW-ID>: <one-line question>)`/)?.[1];
  expect(titleLayout).toBeDefined();
  const withoutId = q.question.replace(/^D1 — /, 'D7 — ');
  const title = titleLayout!.replace('<N>', '7').replace('<ROW-ID>', 'D1')
    .replace('<one-line question>', q.question.split('\n')[0]!.replace(/^D1 — /, ''));
  const prepared = withoutId.replace(withoutId.split('\n')[0]!, title);
  const callWithQuestion = (question: string) => {
    const call = clone(exactFields.call);
    call.questions[0]!.question = question;
    // Counterfactual native questions need their matching answer key too.
    // This does not alter or approve an original captured question.
    call.answers = { [question]: Object.values(call.answers)[0]! } as typeof call.answers;
    return call;
  };
  const payload = (call: typeof exactFields.call) => {
    const current = call.questions[0]!;
    return ['Question: '+current.question, 'Header: '+current.header,
      ...current.options.map(option => option.label+'\n'+option.description)].join('\n');
  };
  const saved = (call: typeof exactFields.call) => exactPlan('### currentDecision (D1)', payload(call));
  const missing = callWithQuestion(withoutId), ready = callWithQuestion(prepared);
  // 749df paired retry copied every field and read them all, but omitted its
  // row ID. The distinct attempt added the ID only after the saved Read.
  expect(() => exactCount(saved(missing), missing)).toThrow(/Unsupported/);
  expect(() => exactCount(saved(missing), ready)).toThrow(/Unsupported/);
  expect(() => exactCount(saved(ready), missing)).toThrow(/Unsupported/);
  expect(exactCount(saved(ready), ready)).toBe(true);
  const foreign = callWithQuestion(prepared.replace('D7 — D1:', 'D7 — R999:'));
  expect(() => exactCount(saved(foreign), foreign)).toThrow(/Unsupported/);
  expect(() => exactCount(saved(ready)+'\n\n### currentDecision (D1)\n'+payload(ready), ready)).toThrow(/Unsupported/);

  // A late recommended suffix or a brief-only tradeoff list cannot stand in
  // for the final saved native labels and complete option descriptions.
  expect(() => exactCount(saved(ready).replace(q.options[0]!.label,
    q.options[0]!.label.replace(' (recommended)', '')), ready)).toThrow(/Unsupported/);
  const briefOnly = callWithQuestion(prepared+'\nPros / cons:\n'+q.options.map(option =>
    option.label+'\n'+option.description!.split('\n').slice(1).join('\n')).join('\n'));
  for (const option of briefOnly.questions[0]!.options)
    option.description = option.description!.replaceAll('✅', 'Pros:').replaceAll('❌', 'Cons:');
  expect(() => exactCount(saved(briefOnly), briefOnly)).toThrow(/Unsupported/);
  expect(exactCount(saved(ready), ready)).toBe(true);
});

// The 749df R2 evidence used "punctuation/Unicode" as ordinary prose. This
// must not become a foreign source, while actual cited paths remain closed.
const withEvidence = (text: string) => exactPlan('### currentDecision (D1)')
  .replace('Evidence: PLAN.md lines 18-23 state the exact contracts;',
    `Evidence: PLAN.md lines 18-23 state the exact contracts; ${text};`);
for (const compound of ['punctuation/Unicode', 'read/write', 'success/failure', 'input/output', 'request/response'])
  test(`current native record permits ordinary slash prose ${compound}`, () => {
    expect(exactCount(withEvidence(`The contract preserves ${compound} behavior`))).toBe(true);
  });
for (const reference of [
  'other/PLAN.md', 'other/handler.ts', '/PLAN', '/elsewhere/PLAN', './PLAN', '../PLAN', '~/PLAN',
  'C:\\other\\PLAN', 'C:/other/PLAN', '\\\\host\\share\\PLAN',
  '`other/PLAN`', '"other/PLAN"', '[source](other/PLAN)', '<other/PLAN>',
  'Source: other/PLAN', 'file: other/PLAN', 'see other/PLAN', 'according to other/PLAN',
  'other/PLAN:21', 'other/PLAN#L21',
  '"read other/PLAN for the current external source contract"',
]) test(`slash prose cannot conceal an explicit foreign reference ${reference}`, () => {
  expect(() => exactCount(withEvidence(`The contract preserves read/write behavior; ${reference}`))).toThrow(/Unsupported/);
});
