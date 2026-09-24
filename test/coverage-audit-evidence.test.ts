import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import fixture from './fixtures/coverage-audit-ae.json';
import ciDiagrams from './fixtures/coverage-audit-ci-diagrams.json';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { recordE2E } from './helpers/e2e-helpers';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { selectTests } from './helpers/test-selection';

const clone = <T>(v:T):T => structuredClone(v);
const diagram = '```text\nsrc/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]\n```';
function synthetic() {
  const cwd = '/tmp/coverage-audit-evidence-owned';
  const files = {cwd, source:{path:path.join(cwd,'src/billing.ts'),content:fixture.files.source},
    tests:{path:path.join(cwd,'test/billing.test.ts'),content:fixture.files.tests}};
  const transcript:any[] = [{type:'system',subtype:'init',session_id:'parent',cwd}];
  for (const [id,file] of Object.entries({source:files.source,tests:files.tests})) {
    transcript.push({type:'assistant',session_id:'parent',parent_tool_use_id:null,message:{role:'assistant',content:[
      {type:'tool_use',id,name:'Read',input:{file_path:file.path}},
    ]}});
    transcript.push({type:'user',session_id:'parent',parent_tool_use_id:null,message:{role:'user',content:[
      {type:'tool_result',tool_use_id:id,content:file.content},
    ]}});
  }
  return {files,result:{exitReason:'success',browseErrors:[],output:diagram,transcript} as any};
}
const verdict = (s:ReturnType<typeof synthetic>) => coverageAuditVerdict(s.result,s.files);
const block = (s:ReturnType<typeof synthetic>,i:number) => s.result.transcript[i].message.content[0];

describe('coverage audit native evidence',()=>{
  test('literal cat operands preserve quoted whitespace for single and multiple owned paths', () => {
    for (const quote of ["'", '"']) for (const flags of ['', '-n ', '-n -- ']) {
      const s = synthetic();
      s.files.cwd = '/repo with space';
      s.files.source.path = s.files.cwd + '/src/billing source.ts';
      s.files.tests.path = s.files.cwd + '/test/billing test.ts';
      s.result.transcript[0].cwd = s.files.cwd;
      for (const [i, file] of [[1, s.files.source], [3, s.files.tests]] as const) {
        Object.assign(block(s, i), { name: 'Bash', input: { command: `cat ${flags}${quote}${file.path}${quote}` } });
      }
      expect(verdict(s)).toMatchObject({ sourceRead: true, testsRead: true });
      block(s, 1).input.command = `cat ${flags}${quote}${s.files.source.path}${quote} ${quote}${s.files.tests.path}${quote}`;
      block(s, 2).content = s.files.source.content + '\n' + s.files.tests.content;
      s.result.transcript.splice(3);
      expect(verdict(s)).toMatchObject({ sourceRead: true, testsRead: true });
      for (const operands of [
        `${quote}${s.files.source.path}${quote}suffix`,
        `${quote}${s.files.source.path}${quote}${quote}${s.files.tests.path}${quote}`,
        `${quote}${s.files.source.path}`, '"$SOURCE_FILE"', '`cat path`',
      ]) {
        block(s, 1).input.command = `cat ${flags}${operands}`;
        expect(verdict(s), operands).toMatchObject({ sourceRead: false, testsRead: false });
      }
    }
  });

  test('single word legend entries consume complete unqualified coverage and quality clauses', () => {
    const s = synthetic();
    const output = (legend: string) => '```text\nprocessPayment()\n└─ happy path [OK]\nrefundPayment()\n└─ happy path [GAP]\n' + legend + '\n```';
    for (const legend of [
      'Legend: [OK] covered\nLegend: [GAP] no test',
      'Legend: ★★★ edges + errors  ★★ happy path only  ★ smoke  [OK] tested\nLegend: [GAP] no test  [→E2E] recommend integration test',
    ]) {
      s.result.output = output(legend);
      expect(verdict(s).diagram, legend).toBe(true);
      for (const qualified of [
        legend.replace('[OK] covered', '[OK] covered only if approved').replace('[OK] tested', '[OK] tested only if approved'),
        legend.replace('[GAP] no test', '[GAP] no test except refunds'),
        legend.replace('[GAP] no test', '[GAP] no test unless approved'),
        legend.replace('[GAP] no test', 'hypothetical [GAP] no test'),
        legend.replace('[OK]', 'not [OK]'),
        legend + ' unknown qualifier',
      ]) {
        s.result.output = output(qualified);
        expect(verdict(s).diagram, qualified).toBe(false);
      }
    }
  });

  test('all four exact completed public attempts delivered both files and the seeded diagram',()=>{
    expect(fixture.provenance.actualPassedCases).toBe(0);
    for(const row of fixture.rows){
      const files={cwd:row.cwd,source:{path:path.join(row.cwd,'src/billing.ts'),content:fixture.files.source},
        tests:{path:path.join(row.cwd,'test/billing.test.ts'),content:fixture.files.tests}};
      expect(coverageAuditVerdict(row.result as any,files)).toEqual({sourceRead:true,testsRead:true,diagram:true,passed:true,failures:[]});
    }
  });
  test('both exact CI diagrams retain covered payment and missing refund paths', () => {
    expect(ciDiagrams.provenance.recordedAttemptOutcomes).toEqual(['failed', 'failed']);
    expect(ciDiagrams.provenance.paidOutcomesReclassified).toBe(false);
    for (const row of ciDiagrams.diagrams) {
      const s = synthetic(); s.result.output = row.text;
      expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
    }
  });
  const displayLegend = (legend: string, covered = '#', gap = ' ') => '```text\n' + legend + '\n'
    + 'processPayment(amount, currency)\n└─ valid return success [' + covered + ']\n'
    + 'refundPayment(paymentId, reason)\n└─ valid return refunded [' + gap + '] GAP\n```';
  test('paid coverage diagrams accept a branch line without an arrowhead and a declared hash checkbox', () => {
    for (const output of [
      displayLegend('Legend:  [✓] tested    [✗] GAP (no test)    ── branch', '✓', '✗'),
      displayLegend('src/billing.ts — coverage map           [#] tested   [ ] GAP'),
      displayLegend('Legend: [#] tested [ ] no test'),
      displayLegend('src/billing.ts — coverage map [x] tested [ ] GAP', 'x'),
    ]) {
      const s = synthetic(); s.result.output = output;
      expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
    }
  });
  // Exact public diagram from the completed, failed September 21 /review run.
  // Its footer declares both symbol meanings without punctuation after Legend.
  const symbolFooterDiagram = `\`\`\`
src/billing.ts                                        test/billing.test.ts
======================================================================================

processPayment(amount, currency)                      describe('processPayment')
│
├── [✓] amount > 0 && currency in {USD, EUR}          processes valid payment  (L6-9)
│       → return { status: 'success', ... }  (L5)      processPayment(100, 'USD')
│
├── [✗] amount <= 0                                   ── NO TEST ──
│       → throw 'Invalid amount'  (L3)                  gap: 0, negative values untested
│
└── [✗] currency not USD/EUR                          ── NO TEST ──
        → throw 'Unsupported currency'  (L4)            gap: 'GBP', '', lowercase 'usd'


refundPayment(paymentId, reason)                      (no describe block; not imported)
│
├── [✗] paymentId && reason truthy                    ── NO TEST ──
│       → return { status: 'refunded', ... }  (L11)     gap: happy path never exercised
│
├── [✗] !paymentId                                    ── NO TEST ──
│       → throw 'Payment ID required'  (L9)             gap: '' / undefined untested
│
└── [✗] !reason                                       ── NO TEST ──
        → throw 'Reason required'  (L10)                gap: '' / undefined untested

======================================================================================
Legend  [✓] covered   [✗] gap

Branches:   1 / 6 covered   (17%)
Functions:  1 / 2 covered   (50%)
Guard clauses tested: 0 / 4
\`\`\``;
  test('the exact paid symbol footer may omit its colon', () => {
    const s = synthetic(); s.result.output = symbolFooterDiagram;
    expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
  });
  test('a colonless symbol footer still requires a current, affirmative, owned key', () => {
    const key = 'Legend  [✓] covered   [✗] gap';
    for (const replacement of ['', '> ' + key, '"' + key + '"', 'Example: ' + key,
      'If approved: ' + key, key.replace('covered   [✗] gap', 'gap   [✗] covered'),
      key.replace('[✗] gap', '[✗] covered'), key.replace('[✗]', '[✓]'),
      key + ' except refunds', key + '\nLegend [✓] gap [✗] covered',
      key + '\nThis legend is withdrawn.', key + '\nThis legend applies only if approved.',
    ]) {
      const s = synthetic(); s.result.output = symbolFooterDiagram.replace(key, replacement);
      expect(verdict(s).diagram, replacement).toBe(false);
    }
    for (const output of [
      '\`\`\`text\n' + key + '\n\`\`\`\n' + symbolFooterDiagram.replace(key, ''),
      symbolFooterDiagram.replaceAll('refundPayment', 'otherRefund'),
      symbolFooterDiagram.replace('├── [✓] amount', '├── [✗] amount'),
      'Example:\n' + symbolFooterDiagram, '\`\`\`\`markdown\n' + symbolFooterDiagram + '\n\`\`\`\`',
    ]) {
      const s = synthetic(); s.result.output = output; expect(verdict(s).diagram).toBe(false);
    }
  });
  test('hash checkbox and branch-line legends retain explicit local meanings and ownership', () => {
    const caption = 'src/billing.ts — coverage map [#] tested [ ] GAP';
    for (const legend of ['', '> ' + caption, '"' + caption + '"', 'Example: ' + caption,
      'If approved: ' + caption, caption.replace('[#] tested [ ] GAP', '[#] GAP [ ] tested'),
      caption.replace('[ ] GAP', '[ ] tested'), caption.replace('[ ] GAP', '[#] GAP'),
      caption + ' except refunds', caption + '\nLegend: [#] untested [ ] covered',
      caption + '\nLegend:[#] untested [ ] covered',
      caption + '\nsrc/billing.ts — coverage map[#] untested [ ] covered',
      caption + '\nThis legend is withdrawn.', caption + '\nThis legend applies only if approved.',
    ]) {
      const s = synthetic(); s.result.output = displayLegend(legend); expect(verdict(s).diagram).toBe(false);
    }
    const valid = displayLegend(caption);
    for (const output of [
      '```text\n' + caption + '\n```\n' + displayLegend(''),
      valid.replace('processPayment', 'otherPayment'), valid.replace('refundPayment', 'otherRefund'),
      valid.replace('return success [#]', 'return success not [#]'),
      valid.replace('return success [#]', 'return success [#] -> [ ]'),
      valid.replace('return refunded [ ]', 'return refunded [ ] -> [#]'),
      valid.replace('return refunded [ ]', 'return refunded [ ] [#]'),
      valid.replace('return success [#]', 'return success    ├─ [#]'),
      '````markdown\n' + valid + '\n````', 'Example:\n' + valid,
      displayLegend('Legend: [✓] tested [✗] GAP ── covered', '✓', '✗'),
      displayLegend('Legend: [✓] tested [✗] GAP ── branch except refunds', '✓', '✗'),
    ]) {
      const s = synthetic(); s.result.output = output; expect(verdict(s).diagram).toBe(false);
    }
    const s = synthetic(); s.result.output = valid; s.result.transcript = [];
    expect(verdict(s).diagram).toBe(true); expect(verdict(s).passed).toBe(false);
  });
  test('CI symbol legends remain current, unambiguous and owned by their diagram', () => {
    for (const row of ciDiagrams.diagrams) {
      const text = row.text, key = text.split('\n').find(line => line.startsWith('Legend:'))!;
      for (const replacement of ['', '> ' + key, 'Source: ' + key, key + ' except refunds',
        key.replace(/covered(?: by a test)?/, 'untested'),
        key + '\nLegend: [✓] GAP [✗] covered', key + '\n  [✓] GAP [✗] covered',
        ...['Sample:', 'Example legend:', 'Illustration:'].map(label => label + '\n' + key)]) {
        const s = synthetic(); s.result.output = text.replace(key, replacement);
        expect(verdict(s).diagram, replacement).toBe(false);
      }
      for (const status of ['This legend is withdrawn.', 'Assessment complete; This legend is `no longer current`.',
        '**This legend** is “rejected”.', 'This legend applies only if approved.']) {
        const s = synthetic(); s.result.output = text.replace(/\n```$/, '\n' + status + '\n```');
        expect(verdict(s).diagram, status).toBe(false);
      }
      for (const output of ['Example:\n' + text, '````markdown\n' + text + '\n````',
        text.replace(/^```[^\n]*/, '```json'), '```\n' + key + '\n```\n' + text.replace(key, '')]) {
        const s = synthetic(); s.result.output = output; expect(verdict(s).diagram, output).toBe(false);
      }
      const s = synthetic(); s.result.output = text.replace(/\n```$/, '\nEarlier reviewer said "This legend is withdrawn."\n```');
      expect(verdict(s).diagram).toBe(true);
    }
  });
  test('six-column annotations cannot borrow sibling, prose or parallel-column markers', () => {
    const text = '```\nLegend: [✓] covered by a test [✗] GAP — no test exercises this path\n'
      + 'processPayment(amount, currency)\n└── happy return success\n      [✓] covered\n'
      + 'refundPayment(paymentId, reason)\n└── return refunded\n      [✗] GAP\n```';
    for (const output of [text.replace('      [✓]', 'unrelatedPayment()\n      [✓]'),
      text.replace('      [✓]', '      Earlier example:\n      [✓]'),
      text.replace('      [✓]', '                                                              [✓]'),
      text.replace('      [✓]', '      [✗]'), text.replace('      [✗]', '      [✓]'),
      text.replace('└── happy return success\n      [✓]', '└── happy return success     ├── [✓]')]) {
      const s = synthetic(); s.result.output = output; expect(verdict(s).diagram).toBe(false);
    }
    const s = synthetic(); s.result.output = text; expect(verdict(s).passed).toBe(true);
  });
  test.each([
    '```text\nsrc/billing.ts\n├── refundPayment [UNTESTED]\n└── processPayment: happy path [TESTED]\n```',
    'src/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]',
  ])('function order and optional fencing do not change valid coverage evidence: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(true);
  });
  test('direct Read, literal cat/sed and delivered native line gutters are valid',()=>{
    for(const command of ['cat -n src/billing.ts',"sed -n '1,200p' 'src/billing.ts'",'cat -- "src/billing.ts"']){
      const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});
      block(s,2).content=fixture.files.source.split('\n').map((line,i)=>`${i+1}\t${line}`).join('\n');
      expect(verdict(s).passed).toBe(true);
    }
    const s=synthetic();block(s,2).content=[{type:'text',text:fixture.files.source.split('\n').map((line,i)=>`${i+1}→${line}`).join('\n')}];
    expect(verdict(s).passed).toBe(true);
  });
  function mixedDisplay(context: boolean) {
    const s = synthetic();
    const command = context
      ? 'cat review/specialists/testing.md && echo ==== SRC ==== && cat -n src/billing.ts && echo ==== TEST ==== && cat -n test/billing.test.ts && echo ==== GIT ==== && git log --oneline main..HEAD; git diff main --stat'
      : 'cat -n test/billing.test.ts && git log --oneline main..feature/billing 2>/dev/null; git diff main...feature/billing --stat 2>/dev/null';
    const numbered = (body: string) => body.replace(/\n$/, '').split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    if (context) s.result.transcript.splice(1, 2);
    const use = s.result.transcript.at(-2).message.content[0];
    const result = s.result.transcript.at(-1).message.content[0];
    Object.assign(use, {name: 'Bash', input: {command}});
    result.content = context
      ? '# Testing Specialist Review Checklist\n\nCoverage Gaps\n==== SRC ====\n' + numbered(s.files.source.content)
        + '\n==== TEST ====\n' + numbered(s.files.tests.content) + '\n==== GIT ===='
      : numbered(s.files.tests.content);
    return {s, use, result};
  }
  test('mixed Git display tails retain separately delivered files and numbered reads after context', () => {
    // Shell forms from the two failed 2026-09-20 paid /review captures.
    for (const context of [false, true]) expect(verdict(mixedDisplay(context).s).passed).toBe(true);
  });
  test('mixed display reads retain ordered bodies and successful parent ownership', () => {
    for (const context of [false, true]) for (const mutate of [
      (x: ReturnType<typeof mixedDisplay>) => { x.result.is_error = true; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.content = 'test/billing.test.ts was read'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.content = x.result.content.replace(/.*import \{ describe.*\n/, ''); },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.at(-1).session_id = 'foreign'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.at(-1).parent_tool_use_id = 'child'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.tool_use_id = 'unpaired'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.push(clone(x.s.result.transcript.at(-1))); },
    ]) {
      const x = mixedDisplay(context); mutate(x); expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const context of [false, true]) for (const suffix of [
      'git diff main --output=src/billing.ts --stat', 'git diff main --ext-diff --stat',
      'git diff main --stat > output.txt', 'git diff main --stat || echo ok',
    ]) {
      const x = mixedDisplay(context); x.use.input.command = x.use.input.command.replace(/git diff[^;]+$/, suffix);
      expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const prefix of ['cat ../foreign.md', 'cat --help.md', 'cat /foreign.md', 'cat "$CONTEXT"', 'cat review/specialists/testing.md | head -2',
      'false', 'python3 -c "pass"', 'echo -e "replacement"', 'cat review/specialists/testing.md; false']) {
      const x = mixedDisplay(true); x.use.input.command = x.use.input.command.replace('cat review/specialists/testing.md', prefix);
      expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    }
    const x = mixedDisplay(true); x.result.content = x.result.content.replace('==== SRC ====', '==== OTHER ====');
    expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    const repeated = mixedDisplay(true); repeated.result.content += '\n==== SRC ====';
    expect(verdict(repeated.s).sourceRead).toBe(false); expect(verdict(repeated.s).testsRead).toBe(false);
    const missing = mixedDisplay(true); missing.result.content = missing.result.content.slice(missing.result.content.indexOf('==== SRC ===='));
    expect(verdict(missing.s).sourceRead).toBe(false); expect(verdict(missing.s).testsRead).toBe(false);
  });
  function boundDisplay(kind: 'and-log' | 'quoted-grep') {
    const s = synthetic();
    const numbered = (body: string) => body.replace(/\n$/, '').split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    // Exact commands from the two completed, failed 2026-09-20 bound reruns.
    const command = kind === 'and-log'
      ? 'cat -n src/billing.ts && echo ==== && cat -n test/billing.test.ts && echo ==== && git log --oneline main..HEAD && git diff main --stat'
      : "grep -n -i 'diagram\\|coverage\\|tested\\|gap' review/SKILL.md | head -60; echo ======SRC; cat -n src/billing.ts; echo ======TEST; cat -n test/billing.test.ts; echo ======DIFF; git diff main...HEAD --stat";
    s.result.transcript.splice(3, 2);
    const use = block(s, 1), result = block(s, 2);
    Object.assign(use, {name: 'Bash', input: {command}});
    result.content = kind === 'and-log'
      ? numbered(s.files.source.content) + '\n====\n' + numbered(s.files.tests.content) + '\n===='
      : '119: Test coverage gaps for stated requirements\n======SRC\n' + numbered(s.files.source.content)
        + '\n======TEST\n' + numbered(s.files.tests.content) + '\n======DIFF';
    return {s, use, result};
  }
  test.each(['and-log', 'quoted-grep'] as const)('complete parent reads survive closed neighboring displays: %s', kind => {
    expect(verdict(boundDisplay(kind).s)).toEqual({sourceRead:true, testsRead:true, diagram:true, passed:true, failures:[]});
  });
  test('neighboring log and quoted grep displays cannot replace complete owned delivery', () => {
    for (const kind of ['and-log', 'quoted-grep'] as const) for (const mutate of [
      (x: ReturnType<typeof boundDisplay>) => { x.result.is_error = true; },
      (x: ReturnType<typeof boundDisplay>) => { x.result.content = 'src/billing.ts and test/billing.test.ts were read'; },
      (x: ReturnType<typeof boundDisplay>) => { x.s.result.transcript[2].session_id = 'foreign'; },
      (x: ReturnType<typeof boundDisplay>) => { x.s.result.transcript[2].parent_tool_use_id = 'child'; },
      (x: ReturnType<typeof boundDisplay>) => { x.s.result.transcript[1].parent_tool_use_id = 'child'; },
      (x: ReturnType<typeof boundDisplay>) => { x.result.tool_use_id = 'unpaired'; },
      (x: ReturnType<typeof boundDisplay>) => { x.s.result.transcript.push(clone(x.s.result.transcript[2])); },
    ]) {
      const x = boundDisplay(kind); mutate(x);
      expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const kind of ['and-log', 'quoted-grep'] as const) for (const [key, line] of [
      ['sourceRead', /.*export function processPayment.*\n/], ['testsRead', /.*import \{ describe.*\n/],
    ] as const) {
      const x = boundDisplay(kind); x.result.content = x.result.content.replace(line, '');
      expect(verdict(x.s)[key]).toBe(false); expect(verdict(x.s).passed).toBe(false);
    }
  });
  test('closed neighboring log and grep grammars reject unsafe lookalikes', () => {
    for (const display of [
      'git log --oneline main..HEAD --output=src/billing.ts', 'git log --oneline main..HEAD --format=%B',
      'git log --oneline main..HEAD --ext-diff', 'git log --oneline main..HEAD > output.txt',
      'git log --oneline "main..HEAD"', 'git log --oneline main..HEAD || echo ok',
    ]) {
      const x = boundDisplay('and-log'); x.use.input.command = x.use.input.command.replace('git log --oneline main..HEAD', display);
      expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const display of [
      'grep -n -i "$(touch sentinel)" review/SKILL.md | head -60',
      'grep -n -i "`touch sentinel`" review/SKILL.md | head -60',
      "grep -n -i 'diagram\\|coverage' --help | head -60",
      "grep -n -i 'diagram\\|coverage' review/SKILL.md > output.txt",
      "grep -n -i 'diagram\\|coverage' review/SKILL.md | python3 -c 'pass'",
      "grep -n -i 'diagram\\ncoverage' review/SKILL.md | head -60",
    ]) {
      const x = boundDisplay('quoted-grep'); x.use.input.command = x.use.input.command.replace(/^[^;]+/, display);
      expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    }
  });
  test('each exact source and test file must be successfully delivered',()=>{
    for(const mutate of [
      (s:any)=>{block(s,2).content='src/billing.ts was read';},
      (s:any)=>{block(s,2).content=fixture.files.source.split('\n').slice(0,3).join('\n');},
      (s:any)=>{block(s,2).is_error=true;},
      (s:any)=>{block(s,3).input.file_path=s.files.source.path;},
      (s:any)=>{block(s,4).content=fixture.files.source;},
      (s:any)=>{block(s,1).input.file_path=path.join(s.files.cwd,'other/billing.ts');},
      (s:any)=>{s.files.tests.path=s.files.source.path;},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('unpaired, repeated, child and foreign events cannot supply parent file evidence',()=>{
    for(const mutate of [
      (s:any)=>{s.result.transcript.splice(1,1);},
      (s:any)=>{[s.result.transcript[1],s.result.transcript[2]]=[s.result.transcript[2],s.result.transcript[1]];},
      (s:any)=>{s.result.transcript[2].session_id='foreign';},
      (s:any)=>{s.result.transcript[2].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[1].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[2].message.role='assistant';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[2]));},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[1]));},
      (s:any)=>{s.result.transcript[0].cwd+='/sibling';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[0]));},
      (s:any)=>{s.result.transcript[0].session_id='foreign';},
      (s:any)=>{s.result.transcript[0].type='user';},
      (s:any)=>{s.result.transcript.shift();},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('quoted metadata, counters and undeclared shell reads do not substitute for actual delivery',()=>{
    for(const command of [
      "echo 'cat src/billing.ts'",'false && cat src/billing.ts','cat src/billing.ts | head -2',
      'cd ../sibling; cat src/billing.ts',"if true; then cat src/billing.ts; fi",'cat "$SOURCE"',
      "cat <<'EOF'\ncat src/billing.ts\nEOF",'f() {\ncat src/billing.ts\n}',
      '(\ncat src/billing.ts\n)',
    ]){const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.toolCalls=[{tool:'Read',input:{file_path:s.files.source.path}},{tool:'Read',input:{file_path:s.files.tests.path}}];
    s.result.transcript=[s.result.transcript[0],{type:'assistant',session_id:'parent',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(s.result.transcript.slice(1))}]}}];
    expect(verdict(s).sourceRead).toBe(false);expect(verdict(s).testsRead).toBe(false);
  });
  test('a commented read cannot borrow printed bytes; quoted hash paths remain literal',()=>{
    const s=synthetic();
    const command=`printf '${Buffer.from(fixture.files.source).toString('base64')}' | base64 -d; # only printed bytes; cat src/billing.ts`;
    Object.assign(block(s,1),{name:'Bash',input:{command}});
    expect(verdict(s).sourceRead).toBe(false);
    const quoted=synthetic();quoted.files.source.path=path.join(quoted.files.cwd,'src/billing#branch.ts');
    Object.assign(block(quoted,1),{name:'Bash',input:{command:"cat 'src/billing#branch.ts'"}});
    expect(verdict(quoted).sourceRead).toBe(true);
  });
  test('completion and tool errors remain final gate failures despite genuine delivery',()=>{
    for(const exitReason of ['timeout','exit_code_1']){const s=synthetic();s.result.exitReason=exitReason;expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.browseErrors=['read failed'];expect(verdict(s).passed).toBe(false);
  });
  test('coverage markers must belong to the seeded payment and refund functions',()=>{
    for(const output of [
      diagram.replace('[TESTED]','[UNTESTED]'),diagram.replace('[UNTESTED]','[TESTED]'),
      diagram.replace('processPayment','processPaymentExample'),diagram.replace('refundPayment','refundPaymentExample'),
      '```\n├── processPayment: happy path [TESTED]\n└── refundPayment [TESTED]\n└── unrelatedPayment [UNTESTED]\n```',
      '```\n├── processPayment: happy path [TESTED]\n```\n```\n└── refundPayment [UNTESTED]\n```',
    ]){const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);}
  });
  test('quoted and nested source examples are not the generated coverage diagram',()=>{
    for(const output of [diagram.split('\n').map(line=>'> '+line).join('\n'), '````markdown\n'+diagram+'\n````']){
      const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
    }
  });
  test.each([
    diagram.replace('[UNTESTED]','[NOT UNTESTED]'),
    diagram.replace('[UNTESTED]','[UNTESTED] is false; this function is fully covered.'),
    'Example only; this diagram is not the audit result.\n'+diagram,
  ])('negated gaps and explicitly labeled examples are not audit findings: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
  });
  test('collector receives exactly the asserted verdict even when process exit succeeded',()=>{
    for(const valid of [true,false]){
      const s=synthetic();if(!valid)s.result.output='No diagram produced.';
      Object.assign(s.result,{toolCalls:[],duration:1,costEstimate:{estimatedCost:0,turnsUsed:1,estimatedTokens:1}});
      const v=verdict(s),entries:any[]=[];
      recordE2E({addTest:(entry:any)=>entries.push(entry)} as any,'coverage','fixture',s.result,{passed:v.passed,error:v.failures.length?v.failures.join('; '):undefined});
      expect(entries).toHaveLength(1);expect(entries[0].passed).toBe(valid);expect(entries[0].error).toBe(valid?undefined:v.failures.join('; '));
    }
  });
  test('coverage evidence files select their exact registered consumers',()=>{
    for(const file of ['test/helpers/coverage-audit-evidence.ts','test/coverage-audit-evidence.test.ts','test/fixtures/coverage-audit-ae.json','test/fixtures/coverage-audit-ci-diagrams.json']){
      expect(selectTests([file],E2E_TOUCHFILES,GLOBAL_TOUCHFILES).selected.sort()).toEqual(file === 'test/helpers/coverage-audit-evidence.ts' ? ['plan-eng-coverage-audit','review-coverage-audit','ship-coverage-audit'] : ['plan-eng-coverage-audit','review-coverage-audit']);
      expect(selectTests([file],LLM_JUDGE_TOUCHFILES,GLOBAL_TOUCHFILES).selected).toEqual([]);
    }
  });
});
