import { expect, test } from 'bun:test';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import fixture from './fixtures/eng-golden-parity-an.json';
import heldPackets from './fixtures/eng-native-packets-b955.json';
const heldLegacy=heldPackets.held6bd;
const heldLegacyCheck=(plan=heldLegacy.plan)=>evaluateEngSeedCoverage(heldLegacy.transcript as any,plan,heldLegacy.startedAt,heldLegacy.finishedAt).regression;
test('held6bd legacy: approved required oracle links current legacy body, before-change task and green baseline',()=>expect(heldLegacyCheck()).toBe('plan'));
test('held6bd legacy: current required characterization heading and equivalent baseline fields',()=>expect(heldLegacyCheck(heldLegacy.plan.replace('R5: Regression coverage for legacyAuthFlow() current behavior','R5: Characterization tests for legacyAuthFlow()').replace('pins current\noutcomes for:','records existing\noutcomes for:').replace('suite green on unmodified legacy body','tests pass on untouched legacy implementation'))).toBe('plan'));
for(const [name,edit] of Object.entries({
 'reopened current row':(s:string)=>s+'\n## Current amendment\nR5 is reopened.\n',
 'pending current verification':(s:string)=>s+'\n## Current amendment\nT1 is pending approval.\n',
 'negated current selected answer':(s:string)=>s.replace('Actual answer: A — characterization + differential harness','Actual answer: A — no characterization + differential harness'),
 'unrelated current answer':(s:string)=>s.replace('Actual answer: A — characterization + differential harness','Actual answer: A — implement a cache'),
}))test('held6bd legacy current approval rejects '+name,()=>expect(heldLegacyCheck(edit(heldLegacy.plan))).toBeUndefined());
for(const [name,edit] of Object.entries({
 'duplicate owned ledger':(s:string)=>s.replace('### R6:','### R5: Regression coverage for legacyAuthFlow() current behavior\nState: pending\n\n### R6:'),
 'duplicate required scope':(s:string)=>s.replace('Accepted scope: (1) `legacyAuthFlow.characterization.test`','Accepted scope: withdrawn\nAccepted scope: (1) `legacyAuthFlow.characterization.test`'),
 'quoted foreign current citation':(s:string)=>s.replace('Finding: T1, P1 (CRITICAL)','Finding: T1, P1 (CRITICAL), source "OTHER.md:1"'),
 'optional current baseline':(s:string)=>s+'\n## Current amendment\nT1 is optional.\n',
 'baseline after rewrite':(s:string)=>s.replace('against the current body, before any other change','against the changed body, after the rewrite'),
 'changed current scope order':(s:string)=>s.replace('legacy body BEFORE any delegation is\nadded','legacy body AFTER delegation is\nadded'),
 'mismatched case count':(s:string)=>s.replace('tests for the 8 input classes','tests for the 7 input classes'),
 'duplicate corpus outcome':(s:string)=>s.replace(/(Accepted scope: \(1\)[\s\S]*?outcomes for: valid token, expired), revoked/,'$1, expired'),
}))test('held6bd legacy current class rejects '+name,()=>{const changed=edit(heldLegacy.plan);expect(changed).not.toBe(heldLegacy.plan);expect(heldLegacyCheck(changed)).toBeUndefined();});
test('held6bd legacy: consistently renumbered current row and task retain ownership',()=>expect(heldLegacyCheck(heldLegacy.plan.replaceAll('R5','R15').replaceAll('D11','D21').replaceAll('T1 (','T11 ('))).toBe('plan'));
test('held6bd legacy: unrelated and historical withdrawals are inert',()=>expect(heldLegacyCheck(heldLegacy.plan+'\n## Notes\nEarlier note: "T1 is withdrawn."\n## Payment regression suite\nThe suite is withdrawn.\n')).toBe('plan'));
for(const [name,edit] of Object.entries({
 'historical owner':(s:string)=>s.replace('### R5: Regression coverage','### Historical R5: Regression coverage'),
 'foreign source':(s:string)=>s.replaceAll('PLAN.md:','OTHER.md:'),
 'foreign same basename':(s:string)=>s.replaceAll('PLAN.md:','archive/PLAN.md:'),
 'missing required finding':(s:string)=>s.replace('Finding: T1, P1 (CRITICAL)','Finding: T1, P2'),
 'unapproved row':(s:string)=>s.replace(/(### R5:[\s\S]*?)State: approved/,'$1State: pending'),
 'wrong answer owner':(s:string)=>s.replace('(D11 answer)','(D10 answer)'),
 'unknown selected option':(s:string)=>s.replace('Actual answer: A — characterization','Actual answer: C — characterization'),
 'missing selected option':(s:string)=>s.replace('Options: A) Characterization tests plus a','Options: C) Characterization tests plus a'),
 'missing baseline file':(s:string)=>s.replace('  - Files: auth/legacyAuthFlow.characterization.test','  - Files: auth/otherFlow.characterization.test'),
 'foreign task directory':(s:string)=>s.replace('  - Files: auth/legacyAuthFlow.characterization.test','  - Files: other/legacyAuthFlow.characterization.test'),
 'missing same-row task link':(s:string)=>s.replace('  - Surfaced by: Tests — finding 1 (R5/D11)','  - Surfaced by: Tests — finding 1 (R9/D11)'),
 'modified verification':(s:string)=>s.replace('suite green on unmodified legacy body','suite green on modified legacy body'),
 'missing green verification':(s:string)=>s.replace('suite green on unmodified legacy body','suite red on unmodified legacy body'),
 'current task withdrawal':(s:string)=>s+'\n## Current amendment\nT1 is withdrawn.\n',
 'current row withdrawal':(s:string)=>s+'\n## Current amendment\nR5 is not required.\n',
 'quoted current withdrawal':(s:string)=>s+'\n## Current amendment\nThis baseline verification is "cancelled".\n',
 'reversed current order':(s:string)=>s+'\n## Current amendment\nlegacyAuthFlow() is changed before T1.\n',
 'changed baseline expectations':(s:string)=>s+'\n## Current amendment\nChange T1 assertions.\n',
 'same-task duplicate':(s:string)=>s.replace('- [ ] **T2 (','- [ ] **T1 ('),
 'quoted current plan':(s:string)=>'```md\n'+s+'\n```',
}))test('held6bd legacy rejects '+name,()=>{const changed=edit(heldLegacy.plan);expect(changed).not.toBe(heldLegacy.plan);expect(heldLegacyCheck(changed)).toBeUndefined();});
const times = fixture.calls.map(call => Date.parse(call.answeredAt));
const check = (plan = fixture.compact) => evaluateEngSeedCoverage(
  { status: 'ready', calls: fixture.calls, assistantMessages: [] }, plan, Math.min(...times) - 1, Math.max(...times) + 1);

const ledgerParity=fixture.ledgerParityCab3;
test('current approved parity ledger binds the required table, same task and legacy-first lane',()=>{
  expect(check(ledgerParity.plan).regression).toBe('plan');
});
const swapParityCells=(text:string)=>text.replace(/^\| (?:R5 test shape|Acceptance assertions) \|.*$/gm,line=>{
 const cells=line.split('|');[cells[3],cells[4]]=[cells[4]!,cells[3]!];return cells.join('|');
});
test('the selected parity option cannot borrow another comparison column',()=>{
 expect(check(swapParityCells(ledgerParity.plan)).regression).toBeUndefined();
});
test('a coherent option and comparison reorder preserves the selected parity oracle',()=>{
 const reordered=swapParityCells(ledgerParity.plan).replace('Question D11: Shared parity suite (recommended) / Characterization suite /','Question D11: Characterization suite / Shared parity suite (recommended) /');
 expect(check(reordered).regression).toBe('plan');
});
const ledgerNegative: Array<[string,(text:string)=>string]> = [
 ['missing mandatory test declaration',s=>s.replace(/^\| D11 CRITICAL.*\n/m,'')],
 ['optional declaration',s=>s.replace('| D11 CRITICAL |','| D11 optional |')],
 ['historical test section',s=>s.replace('## Tests (revised)','## Historical Tests (revised)')],
 ['code-only test declaration',s=>s.replace(/^(\| D11 CRITICAL.*)$/m,'```\n$1\n```')],
 ['missing outcome from test declaration',s=>s.replace('valid, expired, revoked, tenant suspended, IDP unreachable, missing tenant;','valid, expired, tenant suspended, IDP unreachable, missing tenant;')],
 ['missing outcome from accepted scope',s=>s.replace('valid, expired, revoked, tenant suspended, IDP unreachable, missing tenant ID)','valid, expired, tenant suspended, IDP unreachable, missing tenant ID)')],
 ['duplicate owned outcome',s=>s.replace('valid, expired, revoked, tenant suspended','valid, expired, expired, tenant suspended')],
 ['missing observed output',s=>s.replace('asserts outcome + cache key written;','asserts cache key written;')],
 ['missing observed side effect',s=>s.replace('asserts outcome + cache key written;','asserts outcome;')],
 ['different declared implementation',s=>s.replace('parameterized over `legacyAuthFlow()` and `AuthBroker`;','parameterized over `legacyAuthFlow()` and `OtherBroker`;')],
 ['different declared test file',s=>s.replace('| `auth/authBehavior.contract.test.ts` |','| `auth/other.contract.test.ts` |')],
 ['missing rollout gate',s=>s.replace('both green before any tenant is allowlisted','both green eventually')],
 ['missing current ledger',s=>s.slice(0,s.indexOf('### R5:'))],
 ['foreign ledger source',s=>s.replaceAll('PLAN.md:','foreign/PLAN.md:')],
 ['different source document',s=>s.replaceAll('PLAN.md:','OTHER.md:')],
 ['unapproved ledger',s=>s.replace('State: approved','State: pending')],
 ['duplicate actual answer',s=>s.replace(/^(Actual answer:.*)$/m,'$1\n$1')],
 ['wrong decision answer',s=>s.replace('legacy AND AuthBroker (D11)','legacy AND AuthBroker (D10)')],
 ['selected characterization instead of parity',s=>s.replace('Actual answer: Shared parity suite run','Actual answer: Characterization suite run')],
 ['missing same-implementation parity assertion',s=>s.replace('identical outcome + identical cache key written for each scenario, both impls','outcome and key may differ between implementations')],
 ['assertions borrowed from another option',s=>s.replace('identical outcome + identical cache key written for each scenario, both impls | identical outcome + cache key for legacy','outcome only | identical outcome + identical cache key written for each scenario, both impls')],
 ['intentional differences allowed',s=>s.replace('Intentional differences: none in this PR.','Intentional differences: permitted in this PR.')],
 ['changed legacy baseline',s=>s.replace('it is unchanged code called through a new router','it is rewritten code called through a new router')],
 ['missing task',s=>s.replace(/^- \[ \] \*\*T6 .*\n(?:  .*(?:\n|$))*/m,'')],
 ['wrong task file',s=>s.replace('  - Files: `auth/authBehavior.contract.test.ts`','  - Files: `auth/other.contract.test.ts`')],
 ['missing task decision ownership',s=>s.replace('Test review T1 CRITICAL (D11)','Test review T1 CRITICAL (D10)')],
 ['wrong verification count',s=>s.replace('Verify: six scenarios','Verify: five scenarios')],
 ['only new implementation verified',s=>s.replace('green for both implementations','green for the new implementation')],
 ['verification after rollout',s=>s.replace('before any tenant is allowlisted','after a tenant is allowlisted')],
 ['no legacy-first lane',s=>s.replace(/^- Lane B:.*\n/m,'')],
 ['new implementation supplies baseline',s=>s.replace('T6 parity suite written against `legacyAuthFlow()`','T6 parity suite written against `AuthBroker`')],
 ['foreign task in lane',s=>s.replace('Lane B: T6 parity','Lane B: T7 parity')],
 ['wrong implementation added to lane',s=>s.replace('then parameterized over `AuthBroker`','then parameterized over `OtherBroker`')],
 ['foreign implementation dependency',s=>s.replace("after Lane A's T3 merges","after Lane A's T7 merges")],
 ['self-dependent oracle task',s=>s.replace("after Lane A's T3 merges","after Lane A's T6 merges")],
 ['duplicate current record',s=>s+'\n'+ledgerParity.parts[3]],
 ['ambiguous comparison columns',s=>s.replace('| Choice | Current | A | B | C |','| Choice | Current | A | A | C |')],
 ['conditional lane',s=>s.replace('- Lane B:','- If approved, Lane B:')],
 ['historical schedule',s=>s.replace('## Worktree parallelization strategy','## Historical worktree parallelization strategy')],
 ['task withdrawal',s=>s+'\n## Current assessment\nT6 is withdrawn.\n'],
 ['quoted current withdrawal',s=>s+'\n## Current assessment\nT6 is "withdrawn".\n'],
 ['decision superseded',s=>s+'\n## Current assessment\nD11 is superseded.\n'],
 ['legacy suite cancelled',s=>s+'\n## Current assessment\nThe legacy parity suite is cancelled.\n'],
 ['baseline modified first',s=>s+'\n## Current assessment\nlegacyAuthFlow() is modified before T6.\n'],
 ['source-only entire declaration',s=>'# Source excerpt\n'+s.replace(/^#/gm,'##')],
];
test.each(ledgerNegative)('approved parity contract rejects %s',(_,mutate)=>{const altered=mutate(ledgerParity.plan);expect(altered).not.toBe(ledgerParity.plan);expect(check(altered).regression).toBeUndefined();});
test('same owned task, decision, implementation and file can be renamed coherently',()=>{
 for(const plan of [ledgerParity.plan.replaceAll('T6','T16').replaceAll('D11','D21').replaceAll('R5','R15'),
   ledgerParity.plan.replaceAll('AuthBroker','NextAuthenticator').replaceAll('authBehavior.contract.test.ts','compatibility.test.js'),
   ledgerParity.plan+'\n## History\nOld note: "T6 is withdrawn."\n',
   ledgerParity.plan+'\n## Payment parity suite\nThe parity suite is withdrawn.\n'])expect(check(plan).regression).toBe('plan');
});

test('exact golden requirement binds current outputs, the same task and untouched baseline to flag-off parity', () => {
  expect(check().ok).toBe(true);
  expect(check().regression).toBe('plan');
});

const negative: Array<[string, (plan: string) => string]> = [
  ['source ancestor', s => '# Source excerpt\n' + s],
  ['historical owner', s => s.replace('### Test requirements', '### Historical test requirements')],
  ['source declaration prefix', s => s.replace(fixture.declaration, 'Source:\n' + fixture.declaration)],
  ['earlier declaration prefix', s => s.replace(fixture.declaration, 'Earlier review assessment:\n' + fixture.declaration)],
  ['conditional declaration', s => s.replace(fixture.declaration, 'If approved:\n' + fixture.declaration)],
  ['quoted declaration', s => s.replace(fixture.declaration, fixture.declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['literal declaration', s => s.replace(fixture.declaration, '~~~\n' + fixture.declaration + '~~~\n')],
  ['optional regression requirement', s => s.replace('REGRESSION RULE, no approval needed', 'optional regression suggestion')],
  ['different characterization target', s => s.replaceAll('legacyAuthFlow', 'anotherFlow')],
  ['unlinked declared task', s => s.replace('(T3, REGRESSION RULE', '(T8, REGRESSION RULE')],
  ['unlinked ordering task', s => s.replace('(T3)** — pin', '(T8)** — pin')],
  ['unlinked task file', s => s.replace('  - Files: auth/legacyAuthFlow.regression.test.ts', '  - Files: auth/anotherFlow.regression.test.ts')],
  ['missing golden oracle', s => s.replace('These tests are the parity oracle', 'These tests are not the parity oracle')],
  ['conditional parity', s => s.replace('These tests are the parity oracle', 'If approved, these tests are the parity oracle')],
  ['modified baseline', s => s.replace('against unmodified legacy code', 'against modified legacy code')],
  ['reversed baseline ordering', s => s.replace('before any refactor commit', 'after the refactor commit')],
  ['future outputs', s => s.replace('pin current outputs', 'pin proposed outputs')],
  ['reversed capture ordering', s => s.replace('before any other code moves', 'after the other code moves')],
  ['source ordering prefix', s => s.replace(fixture.ordering, 'Source excerpt:\n' + fixture.ordering)],
  ['conditional task prefix', s => s.replace(fixture.task, 'If approved:\n' + fixture.task)],
  ['source task prefix', s => s.replace(fixture.task, 'Source:\n' + fixture.task)],
  ['source baseline verification', s => s.replace('  - Verify: six', '  Source:\n  - Verify: six')],
  ['conditional baseline verification', s => s.replace('  - Verify: six', '  If approved:\n  - Verify: six')],
  ['withdrawn same task', s => s + '\n## Final assessment\nT3 is withdrawn.\n'],
  ['withdrawn same verification', s => s + '\n## Final assessment\nT3 verification is withdrawn.\n'],
  ['directly quoted verification withdrawal', s => s + '\n## Final assessment\nT3 verification is "withdrawn".\n'],
  ['current golden suite cancelled', s => s + '\n## Final assessment\nThe legacy golden tests are cancelled.\n'],
  ['legacy modified before baseline', s => s + '\n## Final assessment\nlegacyAuthFlow() is modified before T3.\n'],
  ['owned test requirement withdrawn', s => s.replace(fixture.declaration, fixture.declaration + 'These tests are withdrawn.\n')],
  ['owned baseline withdrawn', s => s.replace(fixture.task, fixture.task + '  Correction: this baseline verification is withdrawn.\n')],
  ['quoted owned baseline withdrawal', s => s.replace(fixture.task, fixture.task + '  Correction: this baseline verification is "withdrawn".\n')],
  ['quoted legacy golden cancellation', s => s + '\n## Final assessment\nThe legacy golden tests are "cancelled".\n'],
  ['owned requirement not current', s => s.replace(fixture.declaration, fixture.declaration + 'This requirement is not current.\n')],
];
test.each(negative)('%s cannot supply a current unchanged oracle', (_, change) => {
  const plan = change(fixture.compact);
  expect(plan).not.toBe(fixture.compact);
  expect(check(plan).regression).toBeUndefined();
});

test('same-task renumbering, harmless quoted history and unrelated suite preserve the oracle', () => {
  expect(check(fixture.compact.replaceAll('T3', 'T8')).ok).toBe(true);
  expect(check(fixture.compact + '\n## Notes\nOld note: "T3 verification is withdrawn."\n').ok).toBe(true);
  expect(check(fixture.compact + '\n## Payment regression suite\nThe regression suite is withdrawn.\n').ok).toBe(true);
  expect(check(fixture.compact.replace(fixture.declaration, 'Old note: "Source:"\n' + fixture.declaration)).ok).toBe(true);
});

test('new regression artifacts select only the existing Eng owner and its dependency list stays dense', () => {
  for (const path of ['test/eng-golden-parity-an.test.ts', 'test/fixtures/eng-golden-parity-an.json'])
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  const row = E2E_TOUCHFILES['plan-eng-finding-count'];
  for (let index = 0; index < row.length; index++) {
    expect(Object.hasOwn(row, index)).toBe(true);
    expect(typeof row[index]).toBe('string');
  }
});
