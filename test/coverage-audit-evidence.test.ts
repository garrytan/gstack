import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import fixture from './fixtures/coverage-audit-ae.json';
import ciDiagrams from './fixtures/coverage-audit-ci-diagrams.json';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { recordE2E } from './helpers/e2e-helpers';
import fixture_coverage_audit_af from './fixtures/coverage-audit-af.json';
import { posix } from 'node:path';
import { win32 } from 'node:path';
import { coverageAuditReadEvidence } from './helpers/coverage-audit-evidence';
import fixture_coverage_audit_aw from './fixtures/coverage-audit-aw.json';
import captured_coverage_audit_shell_legend_at from './fixtures/coverage-audit-shell-legend-at.json';
import fixture_coverage_checkbox_tail_av from './fixtures/coverage-checkbox-tail-av.json';
import captured_coverage_diagram_legend_as from './fixtures/coverage-diagram-legend-as.json';
import fixture_coverage_shell_display_aq from './fixtures/coverage-shell-display-aq.json';
import billing_coverage_shell_display_aq from './fixtures/coverage-audit-ae.json';
import captured_parallel_column from './fixtures/coverage-audit-parallel-column.json';
import captured_sed_context from './fixtures/coverage-audit-sed-context.json';
import captured_cd_chain from './fixtures/coverage-audit-cd-chain.json';
import captured_wc_anchor from './fixtures/coverage-audit-wc-anchor.json';
import captured_separator from './fixtures/coverage-audit-separator-collision.json';
import captured_two_file_grep from './fixtures/coverage-audit-two-file-grep.json';
import captured_plan_eng_wc_bytes from './fixtures/coverage-audit-plan-eng-wc-bytes.json';
import captured_plan_eng_grep_head from './fixtures/coverage-audit-plan-eng-grep-head-before-reads.json';

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
      // cat prints both newline-terminated files back to back.
      block(s, 2).content = s.files.source.content + s.files.tests.content;
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
  test('a fenced plain-word caption in a successful && read chain is display only', () => {
    // Exact command from the failed census 36776104571 /plan-eng-review capture.
    const command = 'echo "=== src/billing.ts ===" && cat -n src/billing.ts && echo && echo "=== test/billing.test.ts ===" && cat -n test/billing.test.ts && echo && echo "=== git diff main --stat ===" && git diff main --stat && echo "=== package.json ===" && cat package.json';
    const numbered = (body: string) => body.replace(/\n$/, '').split('\n').map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n');
    const read = (edit: (command: string) => string = c => c, content?: string) => {
      const s = synthetic(); s.result.transcript.splice(3, 2);
      Object.assign(block(s, 1), {name: 'Bash', input: {command: edit(command)}});
      block(s, 2).content = content ?? `=== src/billing.ts ===\n${numbered(s.files.source.content)}\n\n=== test/billing.test.ts ===\n${numbered(s.files.tests.content)}\n\n=== git diff main --stat ===\n src/billing.ts | 2 ++\n=== package.json ===\n{}`;
      return verdict(s);
    };
    expect(read()).toEqual({sourceRead: true, testsRead: true, diagram: true, passed: true, failures: []});
    for (const caption of ['echo "git diff main --stat"', 'echo "cat -n src/billing.ts"', 'echo "=== $(git diff) ==="',
      'echo "=== git diff ===" > src/billing.ts', 'echo -e "=== git diff ==="', 'echo "=== git diff ===" || true', 'echo "=== git diff ==="; false']) {
      expect(read(c => c.replace('echo "=== git diff main --stat ==="', caption)), caption).toMatchObject({sourceRead: false, testsRead: false});
    }
    expect(read(c => c, 'src/billing.ts and test/billing.test.ts were read')).toMatchObject({sourceRead: false, testsRead: false});
  });
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
});

describe('coverage audit closing summary', () => {
  const stored = require('./fixtures/coverage-audit-summary.json') as { known_good: Record<string, string>; known_bad: Record<string, string> };
  test.each(Object.entries(stored.known_good))('summary passes %s', (_name, output) => {
    const s = synthetic(); s.result.output = output;
    expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
  });
  test.each(Object.entries(stored.known_bad))('summary fails %s', (_name, output) => {
    const s = synthetic(); s.result.output = output;
    expect(verdict(s).passed).toBe(false);
  });
  test('a correct summary cannot replace native file delivery or a completed capture', () => {
    const output = stored.known_good['unfamiliar-diagram-with-summary']!;
    const unread = synthetic(); unread.result.output = output; block(unread, 2).content = 'not the file';
    expect(verdict(unread)).toMatchObject({ sourceRead: false, passed: false });
    const timedOut = synthetic(); timedOut.result.output = output; timedOut.result.exitReason = 'timeout';
    expect(verdict(timedOut).passed).toBe(false);
  });
});

describe('coverage-audit-af', () => {
const fixture = fixture_coverage_audit_af;
const actual = (index: number) => structuredClone(fixture.rows[index]!);
const files = (row: typeof fixture.rows[number]) => ({cwd:row.cwd,
  source:{path:`${row.cwd}/src/billing.ts`,content:fixture.files.source},
  tests:{path:`${row.cwd}/test/billing.test.ts`,content:fixture.files.tests}});
for (let i=0;i<fixture.rows.length;i++) test(`AF exact public coverage audit ${i+1} binds delivered files and seeded diagram`, () => {
  const row=actual(i); expect(coverageAuditVerdict(row.result, files(row))).toEqual({sourceRead:true,testsRead:true,diagram:true,passed:true,failures:[]});
});

// The output an `echo ----` pair chain prints; reads without the separator print the files back to back.
function delivered(command: string, mutate?: (events: any[]) => void, content = fixture.files.source+'----\n'+fixture.files.tests) {
  const row=actual(2), session=row.sessionId;
  const transcript:any[]=[
    {type:'system',subtype:'init',session_id:session,cwd:row.cwd},
    {type:'assistant',session_id:session,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'read-pair',name:'Bash',input:{command}}]}},
    {type:'user',session_id:session,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'read-pair',is_error:false,content}]}},
  ];
  mutate?.(transcript);
  return coverageAuditVerdict({...row.result,transcript},files(row));
}
const both = 'cat -n src/billing.ts && cat -n test/billing.test.ts';

test('recorded POSIX and Windows paths bind reads independently of the replay host', () => {
  for (const [cwd, paths] of [['/owned/repo', posix], ['C:\\owned\\repo', win32]] as const) {
    const owned = {cwd, source:{path:paths.join(cwd,'src/billing.ts'),content:fixture.files.source},
      tests:{path:paths.join(cwd,'test/billing.test.ts'),content:fixture.files.tests}};
    const transcript = [
      {type:'system',subtype:'init',session_id:'owned',cwd},
      {type:'assistant',session_id:'owned',message:{role:'assistant',content:[{type:'tool_use',id:'pair',name:'Bash',input:{command:both}}]}},
      {type:'user',session_id:'owned',message:{role:'user',content:[{type:'tool_result',tool_use_id:'pair',is_error:false,content:fixture.files.source+fixture.files.tests}]}},
    ];
    expect(coverageAuditReadEvidence(transcript,owned)).toEqual({sourceRead:true,testsRead:true});
    expect(coverageAuditReadEvidence(transcript,{...owned,source:{...owned.source,path:paths.join(cwd,'../foreign.ts')}}))
      .toEqual({sourceRead:false,testsRead:false});
    expect(coverageAuditReadEvidence(transcript,{...owned,source:{...owned.source,path:cwd+paths.sep+'src'+paths.sep+'..'+paths.sep+'src'+paths.sep+'billing.ts'}}))
      .toEqual({sourceRead:false,testsRead:false});
  }
});

test('AF complete literal reads permit a successful chain and one leading owned cwd assertion', () => {
  const cwd=actual(2).cwd;
  for (const command of [both, `cd ${cwd}; cat -n src/billing.ts; cat -n test/billing.test.ts`, `cd '${cwd}' && ${both}`, 'cat -n src/billing.ts; echo ----; cat -n test/billing.test.ts']) {
    const v=delivered(command,undefined,command.includes('----')?undefined:fixture.files.source+fixture.files.tests);
    expect(v.sourceRead).toBe(true); expect(v.testsRead).toBe(true); expect(v.passed).toBe(true);
  }
});

test('AF only an owned `cd CWD;` may precede a uniform && chain; other separator mixes stay rejected', () => {
  const cwd=actual(2).cwd, accepted=delivered(`cd ${cwd}; ${both}`,undefined,fixture.files.source+fixture.files.tests);
  expect(accepted.sourceRead).toBe(true); expect(accepted.testsRead).toBe(true);
  for (const command of [`cd ${cwd} && cat -n src/billing.ts; cat -n test/billing.test.ts`, `cd ${cwd}; ${both}; pwd`,
    `cd ${cwd}; cat -n src/billing.ts; cat -n test/billing.test.ts && pwd`, `cd ${cwd} || ${both}`, `cd /foreign; ${both}`]) {
    const v=delivered(command,undefined,fixture.files.source+fixture.files.tests); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
  }
});

test('AF read recognition rejects foreign or midstream cwd changes and nonliteral targets', () => {
  const cwd=actual(2).cwd;
  for (const command of [`cd /foreign; ${both}`, `cat -n src/billing.ts; cd /foreign; cat -n test/billing.test.ts`,
    `cat -n src/billing.ts; cd ${cwd}; cat -n test/billing.test.ts`, `cd "$PWD"; ${both}`, `cd ${cwd}/..; ${both}`]) {
    const v=delivered(command); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
  }
});

test('AF a printed, conditional or skipped read cannot borrow delivered-looking file contents', () => {
  for (const command of [`false && ${both}`, `if false; then ${both}; fi`, `echo '${both}'`, `exit; ${both}`,
    `# ${both}`, `cat <<'EOF'\n${both}\nEOF`, `(${both})`, `f() { ${both}; }`, `printf '%s' '${both}'`,
    `printf expected; false && ${both}; true`, `${both} > result.txt`]) {
    const v=delivered(command); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
  }
});

test('AF an owned cwd does not authorize mutations or interpreters around a read', () => {
  for (const neighbor of ['rm -f src/billing.ts', 'python3 -c "pass"', 'echo fake > src/billing.ts',
    'grep data backup.txt | tee src/billing.ts', 'git diff --output=src/billing.ts',
    "git diff '--output=src/billing.ts'", "git diff --output'='src/billing.ts",
    'git diff --out=src/billing.ts', 'git diff --ext-diff']) {
    const result = delivered(`cd ${actual(2).cwd}; ${neighbor}; cat src/billing.ts; cat test/billing.test.ts`);
    expect(result.sourceRead).toBe(false); expect(result.testsRead).toBe(false);
  }
});

test('AF added command forms retain exact parent request/result success and delivered-content binding', () => {
  const mutations:Array<(events:any[])=>void>=[
    e=>{e[0].cwd='/foreign';}, e=>{e[2].session_id='foreign';},
    e=>{e[1].parent_tool_use_id='child';}, e=>{e[2].message.content[0].is_error=true;},
    e=>{e[2].message.content[0].tool_use_id='unpaired';},
    e=>{e[2].message.content[0].content='The two filenames were read.';},
  ];
  for (const mutate of mutations) { const v=delivered(both,mutate); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false); }
  // An && chain that printed only the source is not this command's output:
  // the position-bound detector credits neither file from it.
  const onlySource=delivered(both,e=>{e[2].message.content[0].content=fixture.files.source;});
  expect(onlySource.sourceRead).toBe(false); expect(onlySource.testsRead).toBe(false);
  const complete=delivered(both,undefined,fixture.files.source+fixture.files.tests);
  expect(complete.sourceRead).toBe(true); expect(complete.testsRead).toBe(true);
});

const flat = (legend = 'Legend: [✓] tested   [✗] GAP') => `\`\`\`text\n${legend}\nprocessPayment(amount, currency)\n├── [✓] happy path USD\nrefundPayment(paymentId, reason)\n└── [✗] happy path refund\n\`\`\``;
function diagram(output:string) { const row=actual(0);return coverageAuditVerdict({...row.result,output},files(row)).diagram; }

test('AF flat function roots and same-block legend symbols preserve seeded coverage ownership', () => {
  expect(diagram(flat())).toBe(true);
  expect(diagram(flat().replaceAll('✓','✔').replaceAll('✗','✘'))).toBe(true);
  expect(diagram(flat().replace('processPayment(amount, currency)\n├── [✓] happy path USD\nrefundPayment(paymentId, reason)\n└── [✗] happy path refund',
    'refundPayment(paymentId, reason)\n├── [✗] happy path refund\nprocessPayment(amount, currency)\n└── [✓] happy path USD'))).toBe(true);
});

test('AF symbol-only markers need an unambiguous legend in their own diagram block', () => {
  for (const output of [flat(''),flat('Legend: [✓] GAP   [✗] tested'),flat('Legend: [✓] tested   [✗] tested'),
    flat('Legend: [✓] tested   [✗] GAP   [✗] tested'),
    `\`\`\`text\nLegend: [✓] tested   [✗] GAP\n\`\`\`\n${flat('')}`]) expect(diagram(output)).toBe(false);
});

test('AF flat roots cannot borrow another function subtree or a quoted/example diagram', () => {
  for (const output of [
    flat().replace('├── [✓] happy path USD','├── untested amount guard\nunrelatedHelper()\n└── [✓] happy path USD'),
    flat().replace('refundPayment(paymentId, reason)','unrelatedRefund(paymentId, reason)'),
    flat().replace('processPayment(amount, currency)','processPaymentOther(amount, currency)'),
    flat().split('\n').map(line=>'> '+line).join('\n'),
    '````markdown\n'+flat()+'\n````',
    flat().replace('Legend:','Example diagram:\nLegend:'),
  ]) expect(diagram(output)).toBe(false);
});

test('AF a legend cannot override an explicitly negated marker on its own branch', () => {
  for (const output of [
    flat().replace('[✗] happy path refund','not [✗] happy path refund'),
    flat().replace('[✗] happy path refund','[✗] is false; this branch is tested'),
    flat().replace('[✓] happy path USD','not [✓] happy path USD'),
  ]) expect(diagram(output)).toBe(false);
});
test('AF symbol gaps retain affirmative legend ownership and reject same-branch contradictions', () => {
  for (const output of [
    flat().replace('[✗] happy path refund', '[✗] happy path refund (marker is incorrect; this branch is fully tested)'),
    flat().replace('[✗] happy path refund', '[✗] happy path refund — no coverage gap exists'),
    flat('An unproven hypothesis: [✓] tested   [✗] GAP'),
    flat("The source says '[✓] tested   [✗] GAP'"),
  ]) expect(diagram(output)).toBe(false);
  expect(diagram(flat())).toBe(true);
  expect(diagram(flat('[✓] tested   [✗] GAP'))).toBe(true);
  expect(diagram(flat('src/billing.ts — test coverage map          [✓] tested   [✗] GAP'))).toBe(true);
});
});

describe('coverage-audit-aw', () => {
const fixture = fixture_coverage_audit_aw;
const fresh=(n=0)=>{
 const r=structuredClone(fixture.reads[n]!),files={cwd:r.cwd,source:{path:r.cwd+'/src/billing.ts',content:fixture.source},tests:{path:r.cwd+'/test/billing.test.ts',content:fixture.tests}};
 const transcript:any[]=[{type:'system',subtype:'init',session_id:r.sessionId,cwd:r.cwd},{type:'assistant',session_id:r.sessionId,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:r.toolUseId,name:'Bash',input:{command:r.command}}]}},{type:'user',session_id:r.sessionId,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:r.toolUseId,is_error:false,content:r.outputExcerpt}]}}];
 return {files,transcript};
};
const reads=(x:ReturnType<typeof fresh>)=>coverageAuditReadEvidence(x.transcript,x.files);
const diagram=(text:string)=>{const x=fresh();return coverageAuditVerdict({exitReason:'success',browseErrors:[],output:text,transcript:x.transcript} as any,x.files).diagram;};
describe('Coverage audit owned display composition and marker continuations',()=>{
 test('credits exact complete public file delivery 2',()=>{
  expect(fixture.provenance.actualCollectorFailuresRetained).toBe(true);expect(reads(fresh(2))).toEqual({sourceRead:true,testsRead:true});
 });
 // These excerpts omit printed lines (excerptLines): row 0 drops the context
 // cat before its first label; rows 1 and 3 stop before later echoed labels.
 // An excerpt is not the command's output, so it cannot pin a read position.
 test.each([0,1,3])('a partial public excerpt %i cannot prove read position',n=>{
  expect(fixture.reads[n]!.excerptLines.end).toBeGreaterThan(fixture.reads[n]!.excerptLines.start);
  expect(reads(fresh(n))).toEqual({sourceRead:false,testsRead:false});
 });
 test.each(['failed result','foreign session','foreign cwd','foreign tool id','sidechain','missing result','repeated result','partial body','forged body'])('rejects %s',form=>{
  for(let n=0;n<4;n++){const x=fresh(n),e=x.transcript[2],b=e.message.content[0];if(form==='failed result')b.is_error=true;else if(form==='foreign session')e.session_id='foreign';else if(form==='foreign cwd')x.transcript[0].cwd+='/other';else if(form==='foreign tool id')b.tool_use_id='foreign';else if(form==='sidechain')e.parent_tool_use_id='parent';else if(form==='missing result')x.transcript.pop();else if(form==='repeated result')x.transcript.push(structuredClone(e));else if(form==='partial body')b.content=b.content.replace(/.*(?:export function processPayment|import \{ describe).*\n/g,'');else b.content='src/billing.ts and test/billing.test.ts were read';expect(reads(x)).toEqual({sourceRead:false,testsRead:false});}
 });
 test.each(['foreign paths','printf forgery','echo escape forgery','expansion','double quoted expansion','awk execution','changed ordered prefix'])('rejects unsupported or unowned command: %s',form=>{
  const n=form==='awk execution'?2:form==='changed ordered prefix'?3:0,x=fresh(n),u=x.transcript[1].message.content[0];u.input.command=form==='foreign paths'?u.input.command.replaceAll('src/billing.ts','other/billing.ts').replaceAll('test/billing.test.ts','other/billing.test.ts'):form==='printf forgery'?"printf 'fixture body'":form==='echo escape forgery'?"echo -e 'fake\\nbody'":form==='expansion'?u.input.command+'; echo $(cat source)':form==='double quoted expansion'?u.input.command+'; echo "$HOME"':form==='awk execution'?u.input.command.replace('{f=1}','{system("cat forged") }'):u.input.command.replace('=== src/billing.ts ===','=== other.ts ===');expect(reads(x)).toEqual({sourceRead:false,testsRead:false});
 });
 test.each([0,1])('accepts the exact public current diagram %i',n=>expect(diagram(fixture.diagrams[n]!.text)).toBe(true));
 test.each(['missing key','inverted checkbox key','withdrawn key','foreign function','quoted source','not covered','not missing'])('rejects contradictory or unowned checkbox coverage: %s',form=>{
  const text=fixture.diagrams[0]!.text;const changed=form==='missing key'?text.replace(/^Legend:.*\n/m,''):form==='inverted checkbox key'?text.replace('[x] tested   [ ] GAP','[x] untested   [ ] tested'):form==='withdrawn key'?text.replace('src/billing.ts\n│','This legend is withdrawn.\nsrc/billing.ts\n│'):form==='foreign function'?text.replaceAll('refundPayment','otherPayment'):form==='quoted source'?'Example only:\n'+text:form==='not covered'?text.replace("[x] 'processes valid payment'","[ ] GAP"):text.replaceAll('[ ] GAP','[x] tested');expect(diagram(changed)).toBe(false);
 });
 test('continuations keep their own row and cannot borrow from prose or a distant column',()=>{
  const text=fixture.diagrams[1]!.text;
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '│           Earlier example:\n│           [✓] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '                                                              [✓] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '│           [✗] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replaceAll('[✗] GAP','[✓] tested').replace('[✗] untested (GAP)','[✗] untested (GAP)'))).toBe(false);
 });
});
});

describe('coverage-audit-shell-legend-at', () => {
const captured = captured_coverage_audit_shell_legend_at;
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
  // The caption text is display only; the result shows whatever the echo printed
  // (a bare echo's blank first line is trimmed from the native result).
  for (const [replace, printed] of [['echo \'=== another-file.md ===\'', '=== another-file.md ===\n'], ['echo "--- src/billing.ts ---"', '--- src/billing.ts ---\n'], ['echo', '']]) {
    expect(reads(1, s => {
      s.use.input.command = s.use.input.command.replace('echo "=== testing.md ==="', replace!);
      s.delivered.content = s.delivered.content.replace('=== testing.md ===\n', printed!);
    })).toEqual(both);
    // A caption the result never printed makes the result inconsistent with the command.
    if (printed) expect(reads(1, s => { s.use.input.command = s.use.input.command.replace('echo "=== testing.md ==="', replace!); })).toEqual(neither);
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
  // A bare file body is not where this labeled chain prints either read.
  expect(reads(1, s => { s.delivered.content = s.row.files.source.content; })).toEqual(neither);
  expect(reads(1, s => { s.delivered.content = s.row.files.tests.content; })).toEqual(neither);
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
});

describe('coverage-checkbox-tail-av', () => {
const fixture = fixture_coverage_checkbox_tail_av;
const both={sourceRead:true,testsRead:true}, neither={sourceRead:false,testsRead:false};
const fresh=(i=0)=>{const row=structuredClone(fixture.attempts[i]!) as any;return{row,use:row.result.transcript[1].message.content[0],ack:row.result.transcript[2].message.content[0]};};
const reads=(mutate:(s:ReturnType<typeof fresh>)=>void=()=>{})=>{const s=fresh();mutate(s);return coverageAuditReadEvidence(s.row.result.transcript,s.row.files);};
const base='```text\nprocessPayment(amount, currency)\n├── happy return success [x]\nrefundPayment(paymentId, reason)\n└── happy return refunded [ ]\nLegend: [x] tested [ ] no test\n```';
const diagram=(output:string)=>{const {row}=fresh();return coverageAuditVerdict({...row.result,output},row.files).diagram;};

test('both exact public attempts now provide their delivered files and owned checkbox diagram',()=>{
 expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
 for(const row of fixture.attempts){expect(row.provenance.recordedPassed).toBe(false);expect(coverageAuditVerdict(row.result as any,row.files)).toEqual({...both,diagram:true,passed:true,failures:[]});}
});

test('mixed display tail accepts only the two ordered owned reads and literal separators',()=>{
 expect(reads()).toEqual(both);
 for(const revision of ['HEAD','HEAD~1','main..HEAD'])expect(reads(s=>{s.use.input.command=s.use.input.command.replace('main..HEAD',revision).replace('diff main','diff '+revision);})).toEqual(both);
 expect(reads(s=>{s.use.input.command=s.use.input.command.replaceAll('echo ====','echo ----');s.ack.content=s.ack.content.replaceAll('====','----');})).toEqual(both);
 expect(reads(s=>{s.use.input.command=s.use.input.command.replace('src/billing.ts',"'src/billing.ts'").replace('test/billing.test.ts','"test/billing.test.ts"');})).toEqual(both);
 expect(reads(s=>{s.ack.content=[{type:'text',text:s.ack.content}];})).toEqual(both);
 expect(reads(s=>{s.ack.content+='\nabc1234 harmless commit subject\n src/billing.ts | 2 ++\n 1 file changed, 2 insertions(+)';})).toEqual(both);
});

test.each([
 'false && cat -n src/billing.ts && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && false && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n fake.ts && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && cat -n src/billing.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && cat -n test/billing.test.ts; git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts; cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
])('a failed, skipped, duplicate or unrelated read cannot borrow display-tail success: %s',command=>{
 expect(reads(s=>{s.use.input.command=command;})).toEqual(neither);
});

test.each([
 ['git log --oneline main..HEAD','git log --format=%B main..HEAD'],
 ['git log --oneline main..HEAD','git log --oneline --output=src/billing.ts main..HEAD'],
 ['git log --oneline main..HEAD','git -c core.pager=evil log --oneline main..HEAD'],
 ['git diff main --stat','git diff --ext-diff main --stat'],
 ['git diff main --stat','git diff --no-index main --stat'],
 ['git diff main --stat','git diff main --stat; echo extra'],
 ['git diff main --stat','git diff main --stat > src/billing.ts'],
 ['echo ====','echo replacement'],['echo ====','printf ===='],['echo ====','echo -e "\\nreplacement"'],
 ['cat -n src/billing.ts','cat -n src/billing.ts > test/billing.test.ts'],
 ['cat -n src/billing.ts','cat -n $(echo src/billing.ts)'],
 ['cat -n src/billing.ts','rm src/billing.ts'],
])('replacement output or mutation stays outside the closed display-tail form', (old,next)=>{
 expect(reads(s=>{s.use.input.command=s.use.input.command.replace(old,next);})).toEqual(neither);
});

test('the native result must deliver exact ordered complete reads, even when Git hides a prefix failure',()=>{
 for(const mutate of [
  (s:ReturnType<typeof fresh>)=>{s.ack.is_error=true;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content='cat: src/billing.ts: No such file\n'+s.ack.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.ack.content.replace('====\n','====\ncat: test/billing.test.ts: Permission denied\n');},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.row.files.source.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.row.files.tests.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.ack.content.replace("return { status: 'success', amount, currency };","return undefined;");},
  (s:ReturnType<typeof fresh>)=>{const parts=s.ack.content.split('====');s.ack.content=parts[1]+'===='+parts[0]+'====';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript[2].session_id='foreign';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript[2].parent_tool_use_id='child';},
  (s:ReturnType<typeof fresh>)=>{s.ack.tool_use_id='foreign';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript.push(structuredClone(s.row.result.transcript[2]));},
 ])expect(reads(mutate)).toEqual(neither);
});

test('checkbox legends permit current synonyms, pair order, above/below placement and case',()=>{
 for(const legend of ['Legend: [x] tested [ ] no test','Legend [x] covered by an existing test; [ ] no test reaches this path','Legend: [ ] untested | [X] covered'])expect(diagram(base.replace('Legend: [x] tested [ ] no test',legend))).toBe(true);
 expect(diagram(base.replaceAll('[x]','[X]'))).toBe(true);
 expect(diagram(base.replace('Legend: [x] tested [ ] no test\n','').replace('processPayment','Legend: [x] tested [ ] no test\nprocessPayment'))).toBe(true);
});

test.each(['','> Legend: [x] tested [ ] no test','"Legend: [x] tested [ ] no test"','Source: Legend: [x] tested [ ] no test','If approved, Legend: [x] tested [ ] no test','Legend: [x] untested [ ] covered','Legend: [x] tested [ ] covered','Legend: [x] tested [x] no test','Legend: [x] tested [ ] no test except refunds','Legend: [x] tested [ ] no test\nLegend: [x] untested [ ] covered'])('missing or contradictory checkbox key gives no diagram coverage: %s',legend=>{
 expect(diagram(base.replace('Legend: [x] tested [ ] no test',legend))).toBe(false);
});

test('checkbox meanings cannot come from another block, stale key, or source declaration',()=>{
 expect(diagram('```\nLegend: [x] tested [ ] no test\n```\n'+base.replace('Legend: [x] tested [ ] no test\n',''))).toBe(false);
 for(const status of ['withdrawn','`no longer current`',"'superseded'",'“rejected”'])for(const boundary of ['\n','\nAssessment complete; '])expect(diagram(base.replace('\n```',boundary+'This legend is '+status+'.\n```'))).toBe(false);
 for(const statement of ['  This legend is withdrawn.','**This legend** is `no longer current`.','This legend applies only if approved.'])expect(diagram(base.replace('\n```','\n'+statement+'\n```'))).toBe(false);
 expect(diagram(base.replace('\n```','\nEarlier reviewer said "This legend is withdrawn."\n```'))).toBe(true);
 expect(diagram(base.replace('\n```','\n> Earlier note; This legend is withdrawn.\n```'))).toBe(true);
 for(const prefix of ['Source:','Historical note:','Hypothetical:'])expect(diagram(base.replace('Legend:',prefix+'\nLegend:'))).toBe(false);
});

test('checkbox states retain final correction, function subtree and column ownership',()=>{
 expect(diagram(base.replace('success [x]','success [ ] -> [x]'))).toBe(true);
 expect(diagram(base.replace('refunded [ ]','refunded [x] → [ ]'))).toBe(true);
 for(const [old,next]of [['success [x]','success [x] [ ]'],['refunded [ ]','refunded [ ] [x]'],['success [x]','success not [x]'],['refunded [ ]','refunded [ ] is incorrect'],['success [x]','success never covered [x]'],['refunded [ ]','refunded no coverage gaps [ ]'],['success [x]','success [x] -> [ ]'],['refunded [ ]','refunded [ ] → [x]'],['success [x]','success    ├── [x]'],['refunded [ ]','refunded    └── [ ]']])expect(diagram(base.replace(old!,next!))).toBe(false);
 for(const name of ['processPayment','refundPayment'])expect(diagram(base.replace(name,'unrelated'))).toBe(false);
 expect(diagram(base.replace('└── happy','otherFunction()\n└── happy'))).toBe(false);
 expect(diagram(base.split('\n').map(l=>'> '+l).join('\n'))).toBe(false);
 expect(diagram('````markdown\n'+base+'\n````')).toBe(false);
 expect(diagram('Example:\n'+base)).toBe(false);
});
});

describe('coverage-diagram-legend-as', () => {
const captured = captured_coverage_diagram_legend_as;
const billing = fixture;

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
});

describe('coverage-shell-display-aq', () => {
const path = posix;
const fixture = fixture_coverage_shell_display_aq;
const billing = billing_coverage_shell_display_aq;
function replay(row: typeof fixture.rows[number], command?: string) {
  const transcript = structuredClone(row.transcript) as any[];
  if (command !== undefined) transcript[1].message.content[0].input.command = command;
  const cwd = transcript[0].cwd;
  return coverageAuditReadEvidence(transcript, {
    cwd, source: { path: path.join(cwd, 'src/billing.ts'), content: billing.files.source },
    tests: { path: path.join(cwd, 'test/billing.test.ts'), content: billing.files.tests },
  });
}
const command = (row: typeof fixture.rows[number]) => (row.transcript[1] as any).message.content[0].input.command as string;

describe('coverage reads with neighboring display commands', () => {
  test('both exact failed AQ attempts delivered source and tests in their acknowledged Bash result', () => {
    expect(fixture.provenance.actualPassedCases).toBe(0);
    for (const row of fixture.rows) expect(replay(row)).toEqual({ sourceRead: true, testsRead: true });
  });

  test('a literal grep range and numeric Git log count do not own the delivered file bytes', () => {
    const first = fixture.rows[0]!, second = fixture.rows[1]!;
    expect(replay(first, command(first).replace('head -40', 'head -25'))).toEqual({ sourceRead: true, testsRead: true });
    expect(replay(second, command(second).replace('log --oneline -3', 'log --oneline -12'))).toEqual({ sourceRead: true, testsRead: true });
  });

  test.each([
    ['awk action', (s: string) => s.replace("awk '/^### 3\\. Test review/,/^### 4\\./'", "awk 'BEGIN { system(\"cat fake\") }'")],
    ['awk output redirection', (s: string) => s.replace("awk '/^### 3\\. Test review/,/^### 4\\./'", "awk '/x/ { print > \"src/billing.ts\" }'")],
    ['shell substitution', (s: string) => s.replace('grep -n', 'grep -n "$(cat fake)"')],
    ['backtick execution', (s: string) => s.replace('grep -n', 'grep -n `cat fake`')],
    ['quoted injected command', (s: string) => s.replace('grep -n', 'grep -n "x"; printf fake; grep -n')],
    ['read hidden in a conditional', (s: string) => s.replace('cat -n src/billing.ts', 'false && cat -n src/billing.ts')],
    ['source-only filename', (s: string) => s.replace('cat -n src/billing.ts', "echo 'cat -n src/billing.ts'")],
  ] as const)('%s cannot borrow source read evidence', (_, mutate) => {
    const row = fixture.rows[0]!;
    expect(mutate(command(row))).not.toBe(command(row));
    expect(replay(row, mutate(command(row))).sourceRead).toBe(false);
  });

  test.each([
    'git log --output=src/billing.ts -3',
    'git log --ext-diff -3',
    'git log --format=%x00 -3',
    'git log -3; printf fake',
  ])('unsupported Git command %s cannot borrow delivery', git => {
    const row = fixture.rows[1]!;
    expect(replay(row, command(row).replace('git log --oneline -3', git)).sourceRead).toBe(false);
  });

  test.each(['-f/tmp/other.awk', "'-f/tmp/other.awk'", "'--source=BEGIN {print \"fake\"}'"])(
    'awk input %s cannot introduce another program', operand => {
      const row = fixture.rows[0]!;
      const changed = command(row).replace("Test review/,/^### 4\\./' plan-eng-review/sections/review-sections.md", "Test review/,/^### 4\\./' " + operand);
      expect(changed).not.toBe(command(row));
      expect(replay(row, changed).sourceRead).toBe(false);
    });

  test('successful command identity still requires the complete file and paired parent result', () => {
    for (const row of fixture.rows) {
      const missing = structuredClone(row) as any;
      missing.transcript[2].message.content[0].content = 'src/billing.ts and test/billing.test.ts were read';
      expect(replay(missing)).toEqual({ sourceRead: false, testsRead: false });
      const failed = structuredClone(row) as any;
      failed.transcript[2].message.content[0].is_error = true;
      expect(replay(failed)).toEqual({ sourceRead: false, testsRead: false });
    }
  });
});
});

describe('coverage-audit-parallel-column', () => {
  const text = captured_parallel_column.output;
  const diagram = (output: string) => { const s = synthetic(); s.result.output = output; return verdict(s).diagram; };
  const covered = '[★★  TESTED] Happy path USD — billing.test.ts:6           │          (no test chains the two functions)';

  test('a wrapped USER FLOWS rail beside a covered code path stays in its own column', () => {
    expect(captured_parallel_column.provenance.recordedPassed).toBe(false);
    expect(text).toContain(covered);
    expect(diagram(text)).toBe(true);
  });

  test('the parallel column still cannot supply or cancel code-path coverage', () => {
    expect(diagram(text.replace(covered, '[GAP]        Happy path USD — billing.test.ts:6           │          [★★ TESTED] happy USD flow'))).toBe(false);
    expect(diagram(text.replace(covered, '[GAP]        Happy path USD — billing.test.ts:6           [+] [★★ TESTED] happy USD flow'))).toBe(false);
    expect(diagram(text.replace(/(refundPayment[\s\S]*?)\n\n/, m => m.replaceAll('[GAP]        ', '[★★ TESTED]  ')))).toBe(false);
  });
});

describe('coverage-audit-sed-context', () => {
  const capture = captured_sed_context;
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const transcript = (command = capture.command, output = capture.output, isError = capture.isError) => [
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: capture.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: capture.toolUseId, is_error: isError, content: output }] } },
  ];
  const reads = (command?: string, output?: string, isError?: boolean) => coverageAuditReadEvidence(transcript(command, output, isError), files);
  const nonce = (body: string) => body.match(/\/\/ coverage-read-evidence: [0-9a-f-]{36}/)![0];

  test('the slice-12 sed-context chain delivered both owned files at their printed positions', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(reads()).toEqual(both);
    expect(coverageAuditVerdict({ exitReason: 'success', browseErrors: [], output: capture.finalOutput, transcript: transcript() } as any, files))
      .toEqual({ ...both, diagram: true, passed: true, failures: [] });
  });

  test('Git displays may name the revision before or after the display flag', () => {
    expect(reads(capture.command.replace('git diff --stat main', 'git diff main --stat'))).toEqual(both);
    expect(reads(capture.command.replace('git diff --stat main', 'git log --oneline main'))).toEqual(both);
    expect(reads(capture.command.replace('git diff --stat main', 'git diff main -- src/billing.ts test/billing.test.ts'))).toEqual(both);
  });

  test.each([
    ['an echoed fixture line', (c: string) => c + ` && echo '${nonce(capture.files.source)}'`],
    ['an echoed fixture code line', (c: string) => c.replace('echo ===== SRC', "echo '===== SRC export function processPayment(amount: number, currency: string) {'")],
    ['an escaped echo', (c: string) => c.replace('echo ===== SRC', 'echo -e ===== SRC')],
    ['a redirected read', (c: string) => c.replace('cat -n src/billing.ts', 'cat -n src/billing.ts > /tmp/copy.ts')],
    ['a command substitution', (c: string) => c.replace('cat -n src/billing.ts', 'echo "$(cat -n src/billing.ts)"')],
    ['a backtick substitution', (c: string) => c.replace('cat -n src/billing.ts', 'echo `cat -n src/billing.ts`')],
    ['an unknown printer', (c: string) => c.replace('echo ... &&', 'printf x &&')],
    ['an interpreter', (c: string) => 'python3 -c pass && ' + c],
    ['a here-string input', (c: string) => c.replace('cat -n src/billing.ts', 'cat -n <<< src/billing.ts')],
    ['a context file outside the fixture', (c: string) => c.replace('sed -n 542,560p plan-eng-review', 'sed -n 542,560p ../plan-eng-review')],
    ['a writing Git option', (c: string) => c.replace('git diff --stat main', 'git diff --stat --output=src/billing.ts main')],
    ['a Git magic pathspec', (c: string) => c.replace('git diff --stat main', "git diff main -- ':(top)src'")],
    ['a context range narrower than its printed lines', (c: string) => c.replace('sed -n 1118,1127p', 'sed -n 1118,1119p')],
    ['a background job', (c: string) => c.replace(' && echo ===== SRC', ' & echo ===== SRC')],
  ] as const)('%s cannot supply or relocate owned output', (_, mutate) => {
    expect(mutate(capture.command)).not.toBe(capture.command);
    expect(reads(mutate(capture.command))).toEqual(neither);
  });

  test.each([
    ['a context copy of the source label', (o: string) => o.replace('===== SRC\n', '===== SRC\n===== SRC\n')],
    ['a repeated anchor after the reads', (o: string) => o + '\n===== SRC'],
    ['a missing source label', (o: string) => o.replace('===== SRC\n', '')],
    ['a source body moved into the context', (o: string) => { const body = o.slice(o.indexOf('===== SRC\n') + 10, o.indexOf('===== TEST')); return body + o.replace(body, ''); }],
    ['a forged source line', (o: string) => o.replace("throw new Error('Invalid amount')", "throw new Error('Forged')")],
    ['a stale nonce', (o: string) => o.replace(nonce(capture.files.source).slice(-12), '000000000000')],
    ['an unprinted trailing label', (o: string) => o.replace('===== DIFF\n', '')],
    ['a bare file body', () => capture.files.source + capture.files.tests],
  ] as const)('%s leaves the read position unproved', (_, mutate) => {
    expect(mutate(capture.output)).not.toBe(capture.output);
    expect(reads(undefined, mutate(capture.output))).toEqual(neither);
  });

  test('a failed result or a discarded-stderr read gets no credit; a labeled neighbor keeps its own', () => {
    expect(reads(undefined, undefined, true)).toEqual(neither);
    expect(reads(capture.command.replace('cat -n src/billing.ts', 'cat -n src/billing.ts 2>/dev/null'))).toEqual({ sourceRead: false, testsRead: true });
  });
});

describe('coverage audit native evidence: pathspec git displays', () => {
  const run = (command: string) => {
    const s = synthetic();
    const numberedLines = (text: string) => text.replace(/\n$/, '').split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
    Object.assign(block(s, 1), { name: 'Bash', input: { command } });
    block(s, 2).content = `${numberedLines(s.files.source.content)}\n======\n${numberedLines(s.files.tests.content)}\n======\n src/billing.ts | 2 ++\n`;
    s.result.transcript.splice(3);
    return verdict(s);
  };
  test('a ;-list of cat -n reads followed by git diff with a -- pathspec credits both reads (CI 37094035231 shape)', () => {
    expect(run('cat -n src/billing.ts; echo ======; cat -n test/billing.test.ts; echo ======; git diff main --stat; echo; git diff main -- src/billing.ts test/billing.test.ts'))
      .toMatchObject({ sourceRead: true, testsRead: true });
  });
  test('the pathspec form still cannot write or run helpers', () => {
    for (const tail of ['git diff main -- src/billing.ts > out.txt', 'git diff main --output=x -- src/billing.ts', 'git diff main --ext-diff -- src/billing.ts']) {
      expect(run(`cat -n src/billing.ts; echo ======; cat -n test/billing.test.ts; ${tail}`), tail).toMatchObject({ sourceRead: false, testsRead: false });
    }
  });
});

describe('coverage audit native evidence: captured owned-cd chains (CI 39161502626 slice 3)', () => {
  const capture = captured_cd_chain;
  const [wcChain, andChain] = capture.calls;
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const transcript = (call: typeof wcChain, command = call!.command, output = call!.output) => [
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: call!.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.toolUseId, is_error: call!.isError, content: output }] } },
  ];
  const reads = (call: typeof wcChain, command?: string, output?: string) => coverageAuditReadEvidence(transcript(call, command, output), files);

  test('both recorded reads deliver the owned files and the run passes', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(reads(wcChain)).toEqual(both);
    expect(reads(andChain)).toEqual(both);
    expect(coverageAuditVerdict({ exitReason: 'success', browseErrors: [], output: capture.finalOutput, transcript: transcript(wcChain) } as any, files))
      .toEqual({ ...both, diagram: true, passed: true, failures: [] });
  });

  test('a chain that never reads an owned marker file gets no credit for it', () => {
    expect(reads(wcChain, wcChain!.command.replace('cat src/billing.ts', 'cat src/billing.ts.orig'))).toEqual({ sourceRead: false, testsRead: true });
    expect(reads(andChain, andChain!.command.replace('cat -n test/billing.test.ts', 'grep -c GAP test/billing.test.ts'))).toEqual({ sourceRead: true, testsRead: false });
    expect(reads(wcChain, wcChain!.command, capture.files.source + capture.files.tests)).toEqual(neither);
  });

  test('wc -l counts only literal in-cwd files and stays inside its line bounds', () => {
    for (const operand of ['../review/SKILL.md', '/etc/passwd', '"$HOME"/x', '-c']) {
      expect(reads(wcChain, wcChain!.command.replace('wc -l review/SKILL.md', `wc -l ${operand}`)), operand).toEqual(neither);
    }
    const counts = '  856 review/SKILL.md\n  263 review/sections/review-army.md\n 1119 total\n';
    const command = `cd ${capture.cwd}; wc -l review/SKILL.md review/sections/review-army.md; echo ----; cat src/billing.ts`;
    expect(reads(wcChain, command, counts + '----\n' + capture.files.source)).toMatchObject({ sourceRead: true });
    expect(reads(wcChain, command, counts + 'injected\n----\n' + capture.files.source)).toEqual(neither);
  });
});


describe('coverage audit native evidence: exact-count output anchors the next read (CI 39207508651 slice 3)', () => {
  const capture = captured_wc_anchor;
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const reads = (command = capture.call.command, output = capture.call.output) => coverageAuditReadEvidence([
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: capture.call.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: capture.call.toolUseId, is_error: capture.call.isError, content: output }] } },
  ], files);

  test('cat directly after wc -l over literal in-cwd files is credited at the counted line', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(capture.call.command).toContain('; wc -l plan-eng-review/SKILL.md plan-eng-review/sections/review-sections.md; cat src/billing.ts; echo ----; cat test/billing.test.ts');
    expect(reads()).toEqual(both);
  });

  test('unbounded output, a wrong count, an outside file or a missing file still gets no credit', () => {
    const [counts, rest] = [capture.call.output.split('\n').slice(0, 3).join('\n') + '\n', capture.call.output.split('\n').slice(3).join('\n')];
    expect(reads(capture.call.command.replace('wc -l plan-eng-review/SKILL.md plan-eng-review/sections/review-sections.md', 'ls plan-eng-review'))).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command, counts + 'injected\n' + rest)).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command, counts.split('\n').slice(1).join('\n') + rest)).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command.replace('wc -l plan-eng-review/SKILL.md', 'wc -l ../plan-eng-review/SKILL.md'))).toEqual(neither);
    expect(reads(capture.call.command.replace('cat src/billing.ts', 'cat src/billing.ts.orig'))).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command, counts + capture.files.tests + '----\n' + capture.files.source)).toEqual(neither);
  });
});

describe('coverage audit native evidence: a separator that also appears in neighboring output (CI 39199692993 slice 3)', () => {
  const capture = captured_separator;
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const reads = (command: string, output: string) => coverageAuditReadEvidence([
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: capture.call.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: capture.call.toolUseId, is_error: capture.call.isError, content: output }] } },
  ], files);
  // The same command with Opus's most common separator, "echo ---", which testing.md also prints as a line.
  const dashed = { command: capture.call.command.replaceAll('echo ----', 'echo ---'), output: capture.call.output.replaceAll('\n----\n', '\n---\n') };

  test('the captured echo ---- read and its echo --- form both credit the owned files', () => {
    expect(capture.call.output.split('\n----\n')[0]).toMatch(/^---$/m);
    expect(reads(capture.call.command, capture.call.output)).toEqual(both);
    expect(reads(dashed.command, dashed.output)).toEqual(both);
  });

  test('a forged complete copy, a tampered slot or a later label still gets no credit', () => {
    const [testing, source, tests, counts] = capture.call.output.split('\n----\n');
    const join = (...parts: string[]) => parts.join('\n---\n');
    expect(reads(dashed.command, join(testing + '\n---\n' + source + '\n---\n' + tests, source, tests, counts))).toEqual(neither);
    expect(reads(dashed.command, join(testing + '\n---\n' + source + '\n---\n' + tests, source.replace('processPayment', 'processPaymnet'), tests, counts))).toMatchObject({ sourceRead: false });
    expect(reads(dashed.command, join(testing, source.replace('processPayment', 'processPaymnet'), tests, counts))).toMatchObject({ sourceRead: false });
    expect(reads(dashed.command + '; cat review/SKILL.md', dashed.output + '\n---\n' + capture.files.source)).toEqual(neither);
    expect(reads(dashed.command.replace('cat src/billing.ts', 'cat src/other.ts'), dashed.output)).toMatchObject({ sourceRead: false });
  });
});

describe('coverage audit native evidence: an escaped grep over two literal files after the reads (CI 41149166998 slice 5)', () => {
  const capture = captured_two_file_grep;
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const transcript = (command: string, output: string) => [
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: capture.call.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: capture.call.toolUseId, is_error: capture.call.isError, content: output }] } },
  ];
  const reads = (command = capture.call.command, output = capture.call.output) => coverageAuditReadEvidence(transcript(command, output), files);
  const grep = 'grep -n -i -A3 "coverage diagram\\|ASCII" review/SKILL.md review/sections/review-army.md';

  test('both complete reads before a two-file escaped grep display are credited and the recorded run passes', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(capture.call.command).toContain('; cat -n src/billing.ts; echo ----; cat -n test/billing.test.ts; echo ----; ' + grep + ' | head -80');
    expect(reads()).toEqual(both);
    expect(coverageAuditVerdict({ exitReason: 'success', browseErrors: [], output: capture.finalOutput,
      transcript: transcript(capture.call.command, capture.call.output) } as any, files)).toEqual({ ...both, diagram: true, passed: true, failures: [] });
  });

  test('an option, substitution or redirect among the grep operands, or a tampered read, still gets no credit', () => {
    for (const operands of ['review/SKILL.md -f/tmp/foreign', 'review/SKILL.md --include=*', '-r review/SKILL.md', 'review/SKILL.md "$(touch x)"', 'review/SKILL.md > out.txt']) {
      expect(reads(capture.call.command.replace('review/SKILL.md review/sections/review-army.md', operands)), operands).toEqual(neither);
    }
    const nonce = capture.files.source.match(/coverage-read-evidence: (\S+)/)![1]!;
    expect(reads(capture.call.command, capture.call.output.replace(nonce, nonce.slice(1) + '0'))).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command.replace('cat -n test/billing.test.ts', 'cat -n test/other.test.ts'))).toMatchObject({ testsRead: false });
  });

  test('a quoted grep operand with a space stays one literal file operand', () => {
    expect(reads(capture.call.command.replace('review/SKILL.md review/sections/review-army.md', 'review/SKILL.md "docs/design notes.md"'))).toEqual(both);
    expect(reads(capture.call.command.replace('review/SKILL.md review/sections/review-army.md', '"docs/design notes.md" -f/tmp/foreign'))).toEqual(neither);
  });
});


const capturedCall = (capture: typeof captured_plan_eng_wc_bytes) => {
  const both = { sourceRead: true, testsRead: true }, neither = { sourceRead: false, testsRead: false };
  const files = { cwd: capture.cwd, source: { path: capture.cwd + '/src/billing.ts', content: capture.files.source },
    tests: { path: capture.cwd + '/test/billing.test.ts', content: capture.files.tests } };
  const transcript = (command: string, output: string) => [
    { type: 'system', subtype: 'init', session_id: capture.sessionId, cwd: capture.cwd },
    { type: 'assistant', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: capture.call.toolUseId, name: 'Bash', input: { command } }] } },
    { type: 'user', session_id: capture.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: capture.call.toolUseId, is_error: capture.call.isError, content: output }] } },
  ];
  const reads = (command = capture.call.command, output = capture.call.output) => coverageAuditReadEvidence(transcript(command, output), files);
  const passes = () => coverageAuditVerdict({ exitReason: 'success', browseErrors: [], output: capture.finalOutput,
    transcript: transcript(capture.call.command, capture.call.output) } as any, files);
  const nonce = capture.files.source.match(/coverage-read-evidence: (\S+)/)![1]!;
  return { both, neither, reads, passes, nonce };
};

describe('coverage audit native evidence: a wc -c byte count after both reads (CI 41209768188 slice 5, plan-eng)', () => {
  const capture = captured_plan_eng_wc_bytes, { both, neither, reads, passes, nonce } = capturedCall(capture);
  const count = 'wc -c plan-eng-review/sections/review-sections.md';

  test('both complete reads before a literal wc -c count are credited and the recorded run passes', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(capture.call.command).toContain('; cat -n src/billing.ts; echo ----; cat -n test/billing.test.ts; echo ---; ' + count + '; grep -n');
    expect(reads()).toEqual(both);
    expect(passes()).toEqual({ ...both, diagram: true, passed: true, failures: [] });
  });

  test('a wc -c operand that is not a literal in-cwd file, or a tampered read, still gets no credit', () => {
    for (const operands of ['../outside.md', '/etc/passwd', '"$(touch x)"', '-', 'plan-eng-review/SKILL.md > out.txt', '--files0-from=list']) {
      expect(reads(capture.call.command.replace(count, 'wc -c ' + operands)), operands).toEqual(neither);
    }
    expect(reads(capture.call.command.replace(count, 'wc -w plan-eng-review/sections/review-sections.md'))).toEqual(neither);
    expect(reads(capture.call.command, capture.call.output.replace(nonce, nonce.slice(1) + '0'))).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command.replace('cat -n test/billing.test.ts', 'cat -n test/other.test.ts'))).toMatchObject({ testsRead: false });
  });
});

describe('coverage audit native evidence: owned reads after a bounded grep | head display (CI 41238366045 slice 5, plan-eng)', () => {
  const capture = captured_plan_eng_grep_head, { both, neither, reads, passes, nonce } = capturedCall(capture);
  const display = 'grep -n -i "test review\\|coverage diagram" plan-eng-review/SKILL.md | head;';
  const run = capture.call.output.slice(capture.call.output.indexOf('\n') + 1);

  test('both complete reads after a bounded display and an exact count are credited and the recorded run passes', () => {
    expect(capture.provenance.recordedPassed).toBe(false);
    expect(capture.call.command).toContain('; ' + display + ' wc -l plan-eng-review/sections/review-sections.md; cat -n src/billing.ts; echo ----; cat -n test/billing.test.ts');
    expect(reads()).toEqual(both);
    expect(passes()).toEqual({ ...both, diagram: true, passed: true, failures: [] });
    const lines = (n: number) => Array.from({ length: n }, (_, i) => 'SKILL.md:' + (i + 1) + ': test review').join('\n') + '\n';
    expect(reads(capture.call.command, lines(10) + capture.call.output)).toEqual(both);
  });

  test('display output beyond its bound, a second copy of the reads, an unbounded display or a tampered read gets no credit', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => 'SKILL.md:' + (i + 1) + ': test review').join('\n') + '\n';
    expect(reads(capture.call.command, lines(11) + capture.call.output)).toEqual(neither);
    expect(reads(capture.call.command.replace('| head;', '| head -60;'), run + '\n' + capture.call.output)).toEqual(neither);
    expect(reads(capture.call.command, capture.call.output + '\n' + run)).toEqual(neither);
    for (const tail of ['| head -c 400;', ';', '| cat;']) {
      expect(reads(capture.call.command.replace('| head;', tail)), tail).toEqual(neither);
    }
    expect(reads(capture.call.command, capture.call.output.replace(nonce, nonce.slice(1) + '0'))).toMatchObject({ sourceRead: false });
    expect(reads(capture.call.command.replace('cat -n test/billing.test.ts', 'cat -n test/other.test.ts'))).toMatchObject({ testsRead: false });
  });
});
