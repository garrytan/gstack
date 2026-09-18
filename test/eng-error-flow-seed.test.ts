import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-69193-count-public.json';
import currentFixture from './fixtures/eng-e366-count-public.json';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { evaluateEngSeedCoverage, isEngSeedDecisionAUQ } from './helpers/eng-seeded-coverage';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';

const original = fixture.calls.find(c=>c.questions[0]!.header === 'D5 error flow') as NativePlanQuestionCall;
const startedAt = Date.parse(fixture.windowStart), finishedAt = Date.parse(fixture.windowEnd);
const check = (call = structuredClone(original)) => evaluateEngSeedCoverage(
  { status: 'ready', calls: [call], assistantMessages: [] }, '', startedAt, finishedAt);
const classify = (call = structuredClone(original)) => isEngSeedDecisionAUQ(
  nativePlanCallFingerprint(call, 1, false), [], startedAt, finishedAt);
const regressionCalls = () => structuredClone(fixture.calls) as NativePlanQuestionCall[];
const regression = (plan = fixture.report, calls = regressionCalls()) => evaluateEngSeedCoverage(
  { status: 'ready', calls, assistantMessages: [] }, plan, startedAt, finishedAt).regression;

test('the current native-approved matrix captures legacy first and separately asserts its two approved deltas', () => {
  expect(regression()).toBe('plan');
});

function recordEdit(plan: string, id: string, edit: (text: string) => string) {
  const sections = plan.split(/(?=^#{1,6} )/m), selected = sections.filter(s => s.startsWith(`### ${id}:`));
  expect(selected).toHaveLength(1);
  const before = selected[0]!, after = edit(before); expect(after).not.toBe(before);
  return sections.map(s => s === before ? after : s).join('');
}
const scopeEdit = (id: string, edit: (text: string) => string, plan = fixture.report) => recordEdit(plan, id,
  text => text.replace(/^Accepted scope: (.+)$/m, (_line, scope: string) => 'Accepted scope: '+edit(scope)));

for (const [name, edit] of [
  ['missing baseline', (s: string) => s.replace(/\(1\) [^]*?(?=\(2\))/, '')],
  ['baseline after rewrite', (s: string) => s.replace('BEFORE any rewrite', 'AFTER the rewrite')],
  ['reversed baseline and replay', (s: string) => s.replace('(1)', '(later)').replace('(2)', '(1)').replace('(later)', '(2)')],
  ['new-path baseline', (s: string) => s.replace('against the existing `legacyAuthFlow()`', 'against `AuthBroker.validateAndDispatch()`')],
  ['missing replay', (s: string) => s.replace(/\(2\) [^]*?(?=\(3\))/, '')],
  ['different replay matrix', (s: string) => s.replace('The identical matrix run', 'A different matrix run')],
  ['foreign replay implementation', (s: string) => s.replace('`AuthBroker.validateAndDispatch()`', '`AnotherBroker.validateAndDispatch()`')],
  ['missing matrix axis', (s: string) => s.replace('wrong audience; ', '')],
  ['IDP failures not per call', (s: string) => s.replace('for each of the 5 calls', 'for one selected call')],
  ['one of five IDP calls', (s: string) => s.replace('for each of the 5 calls', 'for each of the 1 calls')],
  ['four of five IDP calls', (s: string) => s.replace('for each of the 5 calls', 'for each of the 4 calls')],
  ['missing IDP 5xx failures', (s: string) => s.replace('timeout and 5xx', 'timeout')],
  ['missing cache assertions', (s: string) => s.replace('cache read/write effect, and ', '')],
  ['wrong prior error decision', (s: string) => s.replace('(D5)', '(D19)')],
  ['wrong prior cache decision', (s: string) => s.replace('(D4)', '(D19)')],
  ['missing prior delta', (s: string) => s.replace('; stale write dropped after invalidation (D4)', '')],
  ['extra unapproved delta', (s: string) => s.replace('(D4).', '(D4); permit unknown tenants (D19).')],
  ['broader error delta', (s: string) => s.replace('explicit deny + reason code where legacy swallowed', 'deny every formerly valid request')],
  ['broader cache delta', (s: string) => s.replace('stale write dropped after invalidation', 'all cache writes dropped')],
  ['missing flag requirement', (s: string) => s.replace('Cutover behind a feature flag', 'Cutover immediately')],
  ['cutover before capture', (s: string) => s.replace('(1)', '(later)').replace('(5)', '(1)').replace('(later)', '(5)')],
  ['cutover before replay', (s: string) => s.replace('(2)', '(later)').replace('(5)', '(2)').replace('(later)', '(5)')],
  ['missing selected E2E', (s: string) => s.replace(/\(4\) [^]*?(?=\(5\))/, '')],
  ['missing selected E2E flow', (s: string) => s.replace('; IDP revocation → next request denied', '')],
  ['E2E before deltas', (s: string) => s.replace('(3)', '(later)').replace('(4)', '(3)').replace('(later)', '(4)')],
] as const) test(`matrix contract rejects ${name}`, () => {
  expect(regression(scopeEdit('R6', edit))).toBeUndefined();
});

for (const id of ['R4','R5','R6']) test(`matrix contract binds ${id} to its complete approved native selection`, () => {
  for (const edit of [
    (s: string) => s.replace('State: approved', 'State: pending'),
    (s: string) => s.replace(/^Actual answer: .+\n/m, ''),
    (s: string) => s.replace(/^Actual answer: A/m, 'Actual answer: B'),
    (s: string) => s.replace('PLAN.md:', 'OTHER.md:'),
    (s: string) => s.replace(/^Header: (.+)$/m, 'Header: $1 changed'),
    (s: string) => s.replace(/^Accepted scope: (.+)$/m, '$& This requirement is withdrawn.'),
  ]) expect(regression(recordEdit(fixture.report,id,edit))).toBeUndefined();
  const decision = id === 'R4' ? 'D4' : id === 'R5' ? 'D5' : 'D6';
  for (const edit of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description += ' New behavior.'; },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(finishedAt+1).toISOString(); },
  ]) {
    const calls = regressionCalls(), call = calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!;
    edit(call); expect(regression(fixture.report,calls)).toBeUndefined();
  }
  const calls = regressionCalls(), call = calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!;
  expect(regression(fixture.report,calls.filter(c=>c!==call))).toBeUndefined();
});

test('both supporting approvals must precede the regression selection', () => {
  for (const decision of ['D4','D5']) {
    const calls = regressionCalls(); calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!.answeredAt =
      calls.find(c=>c.questions[0]!.header.startsWith('D6 '))!.answeredAt;
    expect(regression(fixture.report,calls)).toBeUndefined();
  }
});

for (const edit of [
  (s: string) => s.replace('P1 CRITICAL', 'P1 non-CRITICAL'),
  (s: string) => s.replace('P1 CRITICAL', 'P1'),
]) test('a noncritical R6 cannot fill mandatory regression coverage', () => {
  expect(regression(recordEdit(fixture.report,'R6',edit))).toBeUndefined();
});

for (const [name, edit] of [
  ['missing task', (s: string) => s.replace(/^- \[ \] \*\*T4 [^]*?(?=^- \[ \] \*\*T5)/m, '')],
  ['baseline runs after rewrite', (s: string) => s.replace('BEFORE any rewrite', 'AFTER the rewrite')],
  ['missing replay', (s: string) => s.replace('then run the matrix against `AuthBroker`', 'stop after recording legacy')],
  ['different replay', (s: string) => s.replace('then run the matrix', 'then run another matrix')],
  ['missing green baseline', (s: string) => s.replace('suite green against legacy first', 'suite runs on the new path')],
  ['wrong outcome equality', (s: string) => s.replace('identical outcomes against `AuthBroker`', 'unverified outcomes against `AuthBroker`')],
  ['wrong delta inventory', (s: string) => s.replace('intended-delta assertions for D4/D5', 'intended-delta assertions for D4/D19')],
  ['wrong delta count', (s: string) => s.replace('except the two asserted deltas', 'except three asserted deltas')],
  ['wrong shared file', (s: string) => s.replace('tests/auth/legacyAuthFlow.characterization.test.ts', 'tests/auth/different.test.ts')],
] as const) test(`ordered task rejects ${name}`, () => {
  const parts = fixture.report.split(/(?=^#{1,6} )/m);
  const old = parts.find(s=>s.startsWith('## Implementation Tasks\n'))!, changed = edit(old);
  expect(changed).not.toBe(old);
  expect(regression(parts.map(s=>s===old?changed:s).join(''))).toBeUndefined();
});

for (const status of ['R4 is withdrawn.','D5 is "superseded".','R6 is cancelled.','T4 is optional.',
  'legacyAuthFlow() is modified before T4.']) test(`current cancellation rejects ${status}`, () => {
  expect(regression(fixture.report+'\n## Current assessment\n'+status)).toBeUndefined();
  expect(regression(fixture.report+'\n## Current assessment\nPrior note: "'+status.replaceAll('"',"'")+'"')).toBe('plan');
});

test('selector captions and scope numbering are representations of the same owned decisions', () => {
  const captioned = regressionCalls().filter(c=>/^D[456] /.test(c.questions[0]!.header)).reduce((plan,c)=>recordEdit(plan,'R'+c.questions[0]!.header.match(/^D(\d+)/)![1],
    s=>s.replace(/^Actual answer: A \((D\d+) answer, this session\)$/m,
      (_line,id)=>`Actual answer: A — "${c.questions[0]!.options[0]!.label}" (${id} answer)`)), fixture.report);
  expect(regression(captioned)).toBe('plan');
  expect(regression(scopeEdit('R6',s=>s.replace(/\(([1-5])\) /g,'Step $1: ')))).toBe('plan');
});

test('current approved deltas reject contradictions but retain historical comparison and dotted identifiers', () => {
  for (const [id, change] of [
    ['R4', (s: string) => s + ' Correction: stale writes are accepted after invalidation.'],
    ['R4', (s: string) => s.replace('captures the generation before the write', 'captures the generation after the write')],
    ['R4', (s: string) => s.replace(') if it advanced.', '). An unrelated guard checks if it advanced.')],
    ['R5', (s: string) => s + ' Correction: dispatch also runs when an error is denied.'],
    ['R5', (s: string) => s + ' Correction: this remedy is fail-open on unknown errors.'],
    ['R5', (s: string) => s.replace('unknown/unexpected error → deny', 'unknown/unexpected error → allow')],
  ] as const) expect(regression(scopeEdit(id,change))).toBeUndefined();
  for (const identifier of ['audit.trace.stale_write','metrics/auth.cache.counter']) {
    expect(regression(scopeEdit('R4',s=>s.replace('auth_cache.put_dropped_stale',identifier)))).toBe('plan');
  }
  for (const id of ['R4','R5','R6']) {
    // Text after the record's History field stays historical, not a current
    // cancellation. Current cancellation controls modify Accepted scope above.
    expect(regression(recordEdit(fixture.report,id,s=>s+'\nThis requirement is withdrawn.\n'))).toBe('plan');
  }
});

test('exact public neutral error-flow question establishes only the swallowed-error seed', () => {
  expect(classify()).toBe(true);
  expect(check().decisions).toEqual({ 'swallowed-errors': `${original.sessionId}:${original.toolUseId}` });
  expect(check().ok).toBe(false);
  expect(check().regression).toBeUndefined();
});

function editQuestion(call: NativePlanQuestionCall, edit: (text: string) => string) {
  const q = call.questions[0]!, answer = call.answers![q.question]!;
  const changed = edit(q.question);
  expect(changed).not.toBe(q.question);
  q.question = changed;
  call.answers = { [changed]: answer };
}

for (const [name, edit] of [
  ['different neutral title', (s: string) => s.replace(/^D5 — [^\n]+/, 'D42 — Which error policy should validateAndDispatch() use?')],
  ['unquoted structural description', (s: string) => s.replace('three nested "try this, and if it blows up, ignore it" blocks, each ignoring a different kind of failure', '3 nested catch blocks. Every block discards its error')],
  ['different quoted metaphor supplies no evidence', (s: string) => s.replace('"try this, and if it blows up, ignore it"', '"nested boxes"')],
  ['current evidence survives unrelated quoted history', (s: string) => s + '\nPrior note: "This finding is withdrawn."'],
  ['inline identifiers and bold headings', (s: string) => s.replaceAll('validateAndDispatch()', '`validateAndDispatch()`').replace('ELI10:', '**ELI10:**').replace('Project/branch/task:', '**Project/branch/task:**')],
] as const) test(name, () => {
  const call = structuredClone(original); editQuestion(call, edit);
  expect(classify(call)).toBe(true);
});

test('native descriptions do not need duplicate tradeoff bullets, and any offered answer still completes the decision', () => {
  for (const choice of original.questions[0]!.options) {
    const call = structuredClone(original), q = call.questions[0]!;
    q.options.reverse(); call.answers = { [q.question]: choice.label };
    expect(classify(call)).toBe(true);
  }
});

for (const [name, edit] of [
  ['foreign plan', (s: string) => s.replace('PLAN.md', 'OTHER.md')],
  ['foreign same basename', (s: string) => s.replace('PLAN.md', 'archive/PLAN.md')],
  ['missing plan ownership', (s: string) => s.replace('(PLAN.md)', '(the current proposal)')],
  ['foreign explanation', (s: string) => s.replace('The function that decides', 'Another function that decides')],
  ['unrelated title', (s: string) => s.replace(/^D5 — [^\n]+/, 'D5 — Which report format should we use?')],
  ['missing explanation', (s: string) => s.replace(/^ELI10: .+\n/m, '')],
  ['quoted explanation', (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`')],
  ['blockquoted explanation', (s: string) => s.replace(/^ELI10:/m, '> ELI10:')],
  ['historical explanation', (s: string) => s.replace(/^ELI10:/m, 'ELI10: Historical example:')],
  ['withdrawn finding', (s: string) => s + '\nThis finding is withdrawn.'],
  ['quoted current status', (s: string) => s + '\nThis finding is "not current".'],
  ['resolved finding', (s: string) => s + '\nThis finding is fixed.'],
  ['already surfaced errors', (s: string) => s + '\nCorrection: validateAndDispatch() now rethrows every error.'],
  ['no nested defect', (s: string) => s.replace('three nested "try this, and if it blows up, ignore it" blocks', 'one shallow block')],
  ['blocks rethrow instead of discarding', (s: string) => s.replace('each ignoring a different kind of failure', 'each rethrowing every failure')],
  ['discard fact exists only in quotation', (s: string) => s.replace('each ignoring a different kind of failure', '"each ignoring a different kind of failure"')],
  ['conditional current ownership', (s: string) => s + '\nThis finding applies only if approved.'],
] as const) test(name, () => {
  const call = structuredClone(original); editQuestion(call, edit);
  expect(classify(call)).toBe(false);
  expect(check(call).missing).toContain('swallowed-errors');
});

for (const [name, edit] of [
  ['no-op remedy', (s: string) => 'Keep validateAndDispatch() as written; no error-handling change.'],
  ['quoted native remedy', (s: string) => '`'+s+'`'],
  ['historical native remedy', (s: string) => 'Historical example: '+s],
  ['foreign native function', (s: string) => s.replace('validateAndDispatch()', 'anotherFunction()')],
  ['missing typed outcomes', (s: string) => s.replace('a typed `AuthError` subclass', 'an unclassified value')],
  ['missing deny mapping', (s: string) => s.replace('explicit deny', 'an unspecified response')],
  ['missing reason', (s: string) => s.replace('reason code + ', '')],
  ['missing log', (s: string) => s.replace('structured log + ', '')],
  ['partial step policy', (s: string) => s.replace('Each step throws', 'Only some steps throw')],
  ['partial handler policy', (s: string) => s.replace('maps class', 'maps only some classes')],
  ['dispatch reachable on failure', (s: string) => s.replace('Dispatch only reachable on the success path.', 'Dispatch also reachable on the failure path.')],
  ['current no-log correction', (s: string) => s + '\nCorrection: Do not log denials.'],
  ['current partial-error correction', (s: string) => s + '\nCorrection: Only some errors are surfaced.'],
  ['current fail-open correction', (s: string) => s + '\nCorrection: This remedy remains fail-open on unknown errors.'],
  ['current swallowed-error correction', (s: string) => s + '\nCorrection: Dispatch errors remain swallowed.'],
  ['dispatch contradicts deny boundary', (s: string) => s + '\nCorrection: Dispatch also runs when an error is denied.'],
  ['dispatch remains reachable after failure', (s: string) => s + '\nCorrection: Dispatch remains reachable after a validation failure.'],
  ['current withdrawn remedy', (s: string) => s + '\nThis option is withdrawn.'],
] as const) test(name, () => {
  const call = structuredClone(original), q = call.questions[0]!;
  const old = q.options[0]!.description!;
  q.options[0]!.description = edit(old); expect(q.options[0]!.description).not.toBe(old);
  // The displayed brief remains deliberately intact: it must not replace a
  // missing or contradictory contract in the actual native option fields.
  expect(classify(call)).toBe(false);
});

test('a complete remedy cannot be assembled across options', () => {
  const call = structuredClone(original), q = call.questions[0]!;
  q.options[0]!.description = q.options[0]!.description!.replace('reason code + structured log + ', '');
  q.options[1]!.description += ' Every deny includes reason code + structured log.';
  expect(classify(call)).toBe(false);
});

test('native completion and prior-call ownership still gate the recognized seed', () => {
  for (const edit of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.sessionId = ''; },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(startedAt-1).toISOString(); },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(finishedAt+1).toISOString(); },
  ]) {
    const call = structuredClone(original); edit(call); expect(classify(call)).toBe(false);
  }
  const fingerprint = nativePlanCallFingerprint(original, 1, false);
  expect(isEngSeedDecisionAUQ(fingerprint, [original], startedAt, finishedAt)).toBe(false);
  expect(isEngSeedDecisionAUQ({ ...fingerprint, signature: 'foreign' }, [], startedAt, finishedAt)).toBe(false);
});

const currentStart = Date.parse(currentFixture.windowStart), currentEnd = Date.parse(currentFixture.windowEnd);
const currentCall = (header: string) => structuredClone(currentFixture.calls.find(c=>c.questions[0]!.header === header)!) as NativePlanQuestionCall;
const currentClassify = (call: NativePlanQuestionCall) => {
  const index = currentFixture.calls.findIndex(c=>c.toolUseId === call.toolUseId);
  return isEngSeedDecisionAUQ(nativePlanCallFingerprint(call, 1, false), currentFixture.calls.slice(0,index) as NativePlanQuestionCall[], currentStart, currentEnd);
};
for (const [header, seed] of [['Complexity','complexity'],['Error handling','swallowed-errors']] as const) {
  test(`exact public ${header} decision retains its owned native seed`, () => {
    const call=currentCall(header);
    expect(currentClassify(call)).toBe(true);
    const result=evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',currentStart,currentEnd);
    expect(result.decisions).toEqual({[seed]:`${call.sessionId}:${call.toolUseId}`});
    expect(result.ok).toBe(false);
  });
  for (const [name,edit] of [
    ['foreign plan',(s:string)=>s.replaceAll('PLAN.md','OTHER.md')],
    ['foreign same-basename plan',(s:string)=>s.replaceAll('PLAN.md','archive/PLAN.md')],
    ['missing explanation',(s:string)=>s.replace(/^ELI10:.*\n/m,'')],
    ['literal explanation',(s:string)=>s.replace(/^ELI10: (.+)$/m,'ELI10: `$1`')],
    ['quoted explanation',(s:string)=>s.replace(/^ELI10: (.+)$/m,'ELI10: "$1"')],
    ['historical explanation',(s:string)=>s.replace('ELI10:','ELI10: Historical example:')],
    ['withdrawn finding',(s:string)=>s+'\nThis finding is withdrawn.'],
    ['resolved finding',(s:string)=>s+'\nThis finding is fixed.'],
  ] as const) test(`${header} rejects ${name} even with an unhyphenated action`,()=>{
    const call=currentCall(header);editQuestion(call,edit);
    call.questions[0]!.options[0]!.description=call.questions[0]!.options[0]!.description!.replace('re-throw','rethrow');
    expect(currentClassify(call)).toBe(false);
  });
}

for(const [name,edit] of [
  ['premodified catch noun',(s:string)=>s.replace('three try/catch blocks nested inside each other','3 nested catch blocks')],
  ['postmodified catch noun',(s:string)=>s.replace('three try/catch blocks nested inside each other','three catch blocks that are nested inside each other')],
  ['exhaustive discarded failures',(s:string)=>s.replace('each one quietly eats a different kind of error','every catch silently discards a different failure')],
  ['neutral policy title',(s:string)=>s.replace(/^D4 — [^\n]+/,'D4 — Which error boundary should validateAndDispatch() use?')],
] as const) test(`current error subject accepts ${name}`,()=>{
  const call=currentCall('Error handling');editQuestion(call,edit);expect(currentClassify(call)).toBe(true);
});
for(const [name,edit] of [
  ['ASCII step arrows',(s:string)=>s.replaceAll('→','->')],
  ['comma-separated steps',(s:string)=>s.replaceAll(' → ', ', ')],
  ['single handler',(s:string)=>s.replace('single catch','one error handler')],
  ['unhyphenated rethrow',(s:string)=>s.replace('re-throw','rethrow')],
  ['spaced rethrow',(s:string)=>s.replace('re-throw','re throw')],
  ['object-form unknown policy',(s:string)=>s.replace('unknown errors deny and re-throw','denies unknown errors and rethrows them')],
  ['named outcomes',(s:string)=>s.replace('each known error class to an explicit outcome','every known failure class to an explicit named outcome')],
  ['legacy success comparison',(s:string)=>s+' Legacy errors used to return success; this policy denies unknown errors and rethrows them.'],
  ['negative success claim',(s:string)=>s+' Known errors never return success.'],
  ['negative passive success claim',(s:string)=>s+' ValidationError is not treated as success.'],
  ['negative dispatch permission',(s:string)=>s+' For ValidationError, dispatch is never allowed.'],
  ['owned function preposition',(s:string)=>s.replace('Rewrite validateAndDispatch() as','For validateAndDispatch(), use')],
  ['owned method preposition',(s:string)=>s.replace('Rewrite validateAndDispatch() as','In AuthBroker.validateAndDispatch(), implement')],
  ['historical named success',(s:string)=>s+' Legacy ValidationError was treated as success.'],
  ['both current error policies deny success',(s:string)=>s+' ValidationError is not allowed and PolicyDenied is never allowed.'],
] as const) test(`current error policy accepts ${name}`,()=>{
  const call=currentCall('Error handling'),o=call.questions[0]!.options[0]!;o.description=edit(o.description!);expect(currentClassify(call)).toBe(true);
});
for(const [name,edit] of [
  ['no ordered flow',(s:string)=>s.replace('validate → decideAccess → dispatch','the old deeply nested body')],
  ['reversed flow',(s:string)=>s.replace('validate → decideAccess → dispatch','dispatch → decideAccess → validate')],
  ['no single boundary',(s:string)=>s.replace('single catch','several unrelated catches')],
  ['partial known classes',(s:string)=>s.replace('each known error class','some known error classes')],
  ['missing explicit outcome',(s:string)=>s.replace('explicit outcome','unspecified side effect')],
  ['missing structured log',(s:string)=>s.replace('and structured log','without observability')],
  ['unknowns not denied',(s:string)=>s.replace('unknown errors deny and re-throw','unknown errors re-throw')],
  ['unknowns not propagated',(s:string)=>s.replace('unknown errors deny and re-throw','unknown errors deny')],
  ['unknowns allowed',(s:string)=>s.replace('unknown errors deny and re-throw','unknown errors allow and re-throw')],
  ['known errors return allow',(s:string)=>s+' Known errors return allow.'],
  ['known errors return success',(s:string)=>s+' Known errors return success.'],
  ['known errors map to a success status',(s:string)=>s+' Known errors map to 200.'],
  ['known named error becomes success',(s:string)=>s+' ValidationError -> success.'],
  ['passive known-error success',(s:string)=>s+' ValidationError is treated as success.'],
  ['known-error dispatch permission',(s:string)=>s+' For ValidationError, dispatch is allowed.'],
  ['known-error successful outcome',(s:string)=>s+' ValidationError has a successful outcome.'],
  ['another named error successful outcome',(s:string)=>s+' IdpUnavailable has a successful outcome.'],
  ['a later current assertion overrides earlier negation',(s:string)=>s+' ValidationError is not allowed and PolicyDenied is allowed.'],
  ['a later current mapping overrides earlier negation',(s:string)=>s+' Known errors never return success and ValidationError maps to 200.'],
  ['a current assertion follows historical success',(s:string)=>s+' Previously, ValidationError was allowed and now PolicyDenied is allowed.'],
  ['current dispatch-after-error correction',(s:string)=>s+' Correction: dispatch also runs when an error is denied.'],
  ['current logging withdrawal',(s:string)=>s+' Correction: Do not log errors.'],
  ['current propagation withdrawal',(s:string)=>s+' Correction: Never re-throw errors.'],
  ['current fail-open correction',(s:string)=>s+' Correction: This remedy is fail-open on unknown errors.'],
  ['foreign function',(s:string)=>s.replace('validateAndDispatch()','anotherFunction()')],
  ['foreign function preposition',(s:string)=>s.replace('Rewrite validateAndDispatch() as','For tokenize(), use')],
  ['foreign method preposition',(s:string)=>s.replace('Rewrite validateAndDispatch() as','In TokenCodec.parse(), implement')],
  ['literal native policy',(s:string)=>'`'+s+'`'],
  ['historical native policy',(s:string)=>'Historical example: '+s],
  ['withdrawn native policy',(s:string)=>s+' This option is withdrawn.'],
  ['no-op native policy',(_:string)=>'Keep validateAndDispatch() and its current behavior.'],
] as const) test(`current error policy rejects ${name}`,()=>{
  const call=currentCall('Error handling'),o=call.questions[0]!.options[0]!;o.description=edit(o.description!);expect(currentClassify(call)).toBe(false);
});
test('current error map cannot borrow a known-outcome log from another option',()=>{
  const call=currentCall('Error handling'),q=call.questions[0]!;
  q.options[0]!.description=q.options[0]!.description!.replace('and structured log','');
  q.options[1]!.description+=' Every known error gets a structured log.';
  expect(currentClassify(call)).toBe(false);
});

for(const [name,edit] of [
  ['decision caption',(s:string)=>s.replace('Complexity gate:','Complexity decision:')],
  ['word-form declared count',(s:string)=>s.replace('5 new classes','five new classes')],
  ['numeric current count',(s:string)=>s.replace('introduces five new classes','introduces 5 new classes')],
] as const) test(`current class inventory accepts ${name}`,()=>{
  const call=currentCall('Complexity');editQuestion(call,edit);expect(currentClassify(call)).toBe(true);
});
for(const [name,edit] of [
  ['plain pure function',(s:string)=>s.replace('pure exported function','pure function')],
  ['named function before noun',(s:string)=>s.replace('pure exported function decideAccess(claims, ctx)','pure exported decideAccess(claims, ctx) function')],
  ['passive accounted fold',(s:string)=>s.replace('TokenStore folds into AuthCache','TokenStore is folded into AuthCache')],
  ['current negated policy state',(s:string)=>s+' The RequestPolicy function maintains no mutable tenant state.'],
  ['historical policy state',(s:string)=>s+' Previously, the RequestPolicy function maintained mutable tenant state.'],
  ['current negated class retention',(s:string)=>s+' Do not retain TokenStore as a separate class.'],
] as const) test(`current class remedy accepts ${name}`,()=>{
  const call=currentCall('Complexity'),o=call.questions[0]!.options[0]!;o.description=edit(o.description!);expect(currentClassify(call)).toBe(true);
});
for(const [name,edit] of [
  ['different baseline count',(s:string)=>s.replace('5 new classes','4 new classes')],
  ['different current count',(s:string)=>s.replace('introduces five new classes','introduces four new classes')],
  ['quoted current count',(s:string)=>s.replace('it introduces five new classes across twelve files','"it introduces five new classes across twelve files"')],
  ['missing current policy defect',(s:string)=>s.replace('RequestPolicy is described by the plan itself as stateless with no side effects','RequestPolicy owns changing tenant policy state')],
  ['missing current store defect',(s:string)=>s.replace('TokenStore is never described','TokenStore has a documented independent responsibility')],
  ['current policy is stateful',(s:string)=>s+'\nCorrection: RequestPolicy is now stateful.'],
  ['current policy no longer stateless',(s:string)=>s+'\nCorrection: RequestPolicy is no longer stateless.'],
  ['current store has its own responsibility',(s:string)=>s+'\nCorrection: TokenStore now has a documented independent responsibility.'],
] as const) test(`current class subject rejects ${name}`,()=>{
  const call=currentCall('Complexity');editQuestion(call,edit);expect(currentClassify(call)).toBe(false);
});
for(const [name,index,field,edit] of [
  ['missing original inventory',2,'description',(_:string)=>'Keep the original arrangement.'],
  ['wrong original member',2,'description',(s:string)=>s.replace('TokenStore','OtherStore')],
  ['duplicate original member',2,'description',(s:string)=>s.replace('TokenStore','AuthCache')],
  ['wrong original count',2,'label',(s:string)=>s.replace('5 classes','4 classes')],
  ['wrong retained count',0,'label',(s:string)=>s.replace('3 units','2 units')],
  ['wrong retained member',0,'description',(s:string)=>s.replace('AuthBroker, SessionMint, AuthCache','AuthBroker, SessionMint, OtherCache')],
  ['duplicate retained member',0,'description',(s:string)=>s.replace('AuthBroker, SessionMint, AuthCache','AuthBroker, AuthBroker, AuthCache')],
  ['missing pure-policy remedy',0,'description',(s:string)=>s.replace('pure exported function','stateful class')],
  ['missing store fold',0,'description',(s:string)=>s.replace('TokenStore folds into AuthCache','TokenStore stays independent')],
  ['missing single backing adapter',0,'description',(s:string)=>s.replace('one facade over the one backing adapter','a facade over several stores')],
  ['current policy state correction',0,'description',(s:string)=>s+' Correction: RequestPolicy remains a separate class with mutable state.'],
  ['current store retention correction',0,'description',(s:string)=>s+' Correction: TokenStore remains its own class.'],
  ['current function state correction',0,'description',(s:string)=>s+' Correction: The RequestPolicy function now maintains mutable tenant state.'],
  ['current imperative class retention',0,'description',(s:string)=>s+' Correction: Retain TokenStore as a separate class.'],
  ['current imperative policy restoration',0,'description',(s:string)=>s+' Restore RequestPolicy as a distinct class.'],
  ['literal native remedy',0,'description',(s:string)=>'`'+s+'`'],
  ['withdrawn native remedy',0,'description',(s:string)=>s+' This option is withdrawn.'],
  ['foreign original inventory',2,'description',(s:string)=>'Historical example: '+s],
] as const) test(`current class inventory rejects ${name}`,()=>{
  const call=currentCall('Complexity'),o=call.questions[0]!.options[index]!;o[field]=edit(o[field]!);expect(currentClassify(call)).toBe(false);
});
test('current class remedy cannot borrow the missing fold from another option',()=>{
  const call=currentCall('Complexity'),q=call.questions[0]!;
  q.options[0]!.description=q.options[0]!.description!.replace('TokenStore folds into AuthCache (one facade over the one backing adapter).','');
  q.options[1]!.description+=' TokenStore folds into AuthCache (one facade over the one backing adapter).';
  expect(currentClassify(call)).toBe(false);
});


test('the unchanged complete public report has all four decisions but leaves its critical regression requirement unflagged', () => {
  const calls=currentFixture.calls as NativePlanQuestionCall[];
  const result=evaluateEngSeedCoverage({status:'ready',calls,assistantMessages:[]},currentFixture.report,currentStart,currentEnd);
  expect(Object.keys(result.decisions).sort()).toEqual(['complexity','sequential-idp','shared-cache','swallowed-errors']);
  expect(result.missing).toEqual([]);
  expect(result.regression).toBeUndefined();
  expect(result.problems).toContain('mandatory legacy regression coverage absent');
  expect(result.ok).toBe(false);
});

// Counterfactual evidence is explicit: the captured report itself never flags
// this risk CRITICAL. Only that missing required flag is added for parser tests.
const criticalCurrentReport = () => recordEdit(currentFixture.report, 'R5', s=>s.replace('Finding: T1, P1,', 'Finding: T1, P1, CRITICAL,'));
const currentRegression = (report=criticalCurrentReport(), calls=currentFixture.calls as NativePlanQuestionCall[]) =>
  evaluateEngSeedCoverage({status:'ready',calls,assistantMessages:[]},report,currentStart,currentEnd).regression;
const currentScope = (edit:(s:string)=>string) => scopeEdit('R5',edit,criticalCurrentReport());
const currentTask = (edit:(s:string)=>string) => {
  const plan=criticalCurrentReport(), before=plan.match(/^- \[ \] \*\*T1 \([^]*?(?=^- \[ \] \*\*T2)/m)?.[0];
  expect(before).toBeDefined(); const after=edit(before!);expect(after).not.toBe(before);
  return plan.replace(before!,after);
};
test('adding only the mandatory CRITICAL flag exposes the complete native-approved paragraph regression contract',()=>{
  expect(currentRegression()).toBe('plan');
  expect(currentRegression(currentFixture.report)).toBeUndefined();
});
for(const [name,edit] of [
  ['missing legacy baseline',(s:string)=>s.replace('write the characterization suite against legacyAuthFlow() BEFORE the rewrite covering','write characterization tests covering')],
  ['late legacy baseline',(s:string)=>s.replace('BEFORE the rewrite','AFTER the rewrite')],
  ['foreign legacy baseline',(s:string)=>s.replace('legacyAuthFlow()','differentAuthFlow()')],
  ['missing selected case',(s:string)=>s.replace('cross-tenant token, ','')],
  ['missing selected timeout',(s:string)=>s.replace(' and IDP timeout','')],
  ['missing cache assertions',(s:string)=>s.replace(' and cache state','')],
  ['different replay suite',(s:string)=>s.replace('the same suite','a different suite')],
  ['missing new-flow replay',(s:string)=>s.replace('The new flow must pass the same suite.','')],
  ['unapproved difference',(s:string)=>s.replace("D4's explicit deny", "D3's explicit deny")],
  ['broader approved difference',(s:string)=>s.replace('explicit deny where legacy swallowed an error','allow on every IDP failure')],
  ['unasserted difference',(s:string)=>s.replace('listed and asserted','merely listed')],
  ['additional unapproved difference',(s:string)=>s+' Additional product differences are allowed for D7.'],
  ['current cache assertion withdrawal',(s:string)=>s+' Cache state is not asserted.'],
  ['current outcome assertion withdrawal',(s:string)=>s+' Outcome class is not asserted.'],
  ['current new-flow assertion withdrawal',(s:string)=>s+' The new flow is not tested.'],
  ['withdrawn requirement',(s:string)=>s+' R5 is withdrawn.'],
  ['future requirement',(s:string)=>'If approved: '+s],
  ['quoted requirement',(s:string)=>'"'+s+'"'],
] as const) test(`native paragraph regression rejects ${name}`,()=>{
  expect(currentRegression(currentScope(edit))).toBeUndefined();
});
for(const [name,edit] of [
  ['wrong native answer',(s:string)=>s.replace('Actual answer: A) Characterization suite','Actual answer: B) Characterization suite')],
  ['contradictory selected answer',(s:string)=>s.replace('user chose A','user chose B')],
  ['wrong native label',(s:string)=>s.replace('A) Characterization suite\nWrite','A) Different suite\nWrite')],
  ['wrong native description',(s:string)=>s.replace('and IDP timeout; assert outcome class','; assert outcome class')],
  ['foreign finding source',(s:string)=>s.replaceAll('PLAN.md','OTHER.md')],
  ['missing CRITICAL flag',(s:string)=>s.replace('P1, CRITICAL,','P1,')],
  ['non-CRITICAL flag',(s:string)=>s.replace('P1, CRITICAL,','P1, non-CRITICAL,')],
  ['negated CRITICAL flag',(s:string)=>s.replace('P1, CRITICAL,','P1, no CRITICAL risk,')],
  ['historical quoted severity',(s:string)=>s.replace('P1, CRITICAL,','P1, the previous report used the word "CRITICAL",')],
  ['pending approval',(s:string)=>s.replace('State: approved','State: proposed')],
] as const) test(`native paragraph regression record rejects ${name}`,()=>{
  expect(currentRegression(recordEdit(criticalCurrentReport(),'R5',edit))).toBeUndefined();
});
test('the current paragraph may explicitly forbid any other product differences',()=>{
  expect(currentRegression(currentScope(s=>s+' No other product differences are allowed.'))).toBe('plan');
});
for(const [name,edit] of [
  ['missing scheduled baseline',(s:string)=>s.replace('before any rewrite','with the new flow')],
  ['late scheduled baseline',(s:string)=>s.replace('before any rewrite','after the rewrite')],
  ['missing legacy green',(s:string)=>s.replace('suite green against legacy; later green against new flow','suite green against new flow')],
  ['failed legacy baseline',(s:string)=>s.replace('suite green against legacy','suite failing against legacy')],
  ['different replay',(s:string)=>s.replace('later green against new flow','later a different suite green against new flow')],
  ['unapproved task difference',(s:string)=>s.replace('only listed D4 differences','only listed D3 differences')],
  ['missing task owner',(s:string)=>s.replace('(D6)','(D7)')],
  ['missing deliverable',(s:string)=>s.replace(/^  - Files:.*\n/m,'')],
  ['partial task inventory',(s:string)=>s.replace('10 scenarios','9 scenarios')],
] as const) test(`native paragraph regression task rejects ${name}`,()=>{
  expect(currentRegression(currentTask(edit))).toBeUndefined();
});
for(const [name,edit] of [
  ['baseline after implementation',(s:string)=>s.replace('1. Characterization suite','5. Characterization suite')],
  ['baseline gate after replay',(s:string)=>s.replace('green on legacy before step 8','green on legacy after step 8')],
  ['new implementation starts before baseline',(s:string)=>s.replace('4. `AuthBroker.validateAndDispatch()` rewrite','0. `AuthBroker.validateAndDispatch()` rewrite')],
  ['replay before baseline',(s:string)=>s.replace('8. Run the characterization suite','1. Run the characterization suite')],
  ['deleted legacy before baseline',(s:string)=>s+'\nCorrection: legacyAuthFlow() is deleted before T1.\n'],
] as const) test(`native paragraph regression ordering rejects ${name}`,()=>{
  const before=criticalCurrentReport(),after=edit(before);expect(after).not.toBe(before);
  expect(currentRegression(after)).toBeUndefined();
});
for(const [name,edit] of [
  ['missing approved error decision',(calls:NativePlanQuestionCall[])=>calls.filter(c=>c.questions[0]!.header!=='Error handling')],
  ['unanswered approved error decision',(calls:NativePlanQuestionCall[])=>{calls.find(c=>c.questions[0]!.header==='Error handling')!.answered=false;return calls;}],
  ['changed approved error answer',(calls:NativePlanQuestionCall[])=>{const c=calls.find(c=>c.questions[0]!.header==='Error handling')!,q=c.questions[0]!;c.answers![q.question]=q.options[1]!.label;return calls;}],
  ['late approved error decision',(calls:NativePlanQuestionCall[])=>{calls.find(c=>c.questions[0]!.header==='Error handling')!.answeredAt=new Date(Date.parse(calls.find(c=>c.questions[0]!.header==='Regression')!.answeredAt!)+1).toISOString();return calls;}],
  ['foreign regression session',(calls:NativePlanQuestionCall[])=>{calls.find(c=>c.questions[0]!.header==='Regression')!.sessionId='another-session';return calls;}],
] as const) test(`native paragraph regression rejects ${name}`,()=>{
  expect(currentRegression(criticalCurrentReport(),edit(structuredClone(currentFixture.calls) as NativePlanQuestionCall[]))).toBeUndefined();
});
