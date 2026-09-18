import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requireCoverageFileReads, validateCoverageAudit, type CoverageFile } from './helpers/coverage-audit';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';

const ROOT = path.resolve(import.meta.dir, '..');
const cwd = '/owned/coverage';
const files: CoverageFile[] = [
  { path: `${cwd}/src/billing.ts`, content: 'export function processPayment() {}\nexport function refundPayment() {}\n// nonce-source\n' },
  { path: `${cwd}/test/billing.test.ts`, content: 'test("processes valid payment", () => {});\n// nonce-tests\n' },
];
const owner = { session_id: 'owned-session', parent_tool_use_id: null };
function captured(tool = 'Bash', decorate = (text: string) => text): any[] {
  return [{ type: 'system', subtype: 'init', cwd, ...owner }, ...files.flatMap((file, i) => [
    { type: 'assistant', ...owner, message: { content: [{ type: 'tool_use', id: `read-${i}`, name: tool,
      input: tool === 'Read' ? { file_path: file.path } : { command: `cat -n ${file.path}` } }] } },
    { type: 'user', ...owner, message: { content: [{ type: 'tool_result', tool_use_id: `read-${i}`,
      content: decorate(file.content), is_error: false }] } },
  ])];
}
const numbered = (separator: string) => (text: string) => text.split('\n').map((line, i) => `${String(i + 1).padStart(6)}${separator}${line}`).join('\n');
function capturedNativeEvidence(): any[] {
  return [{ type: 'system', subtype: 'init', session_id: owner.session_id, cwd }, ...files.flatMap((file, i) => [
    { type: 'assistant', ...owner, message: { role: 'assistant', content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read',
      input: { file_path: file.path } }] } },
    { type: 'user', ...owner, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${i}`,
      content: file.content, is_error: false }] } },
  ])];
}

for (const [name, tool, decorate] of [
  ['plain shell', 'Bash', (s: string) => s],
  ['cat line numbers', 'Bash', numbered('\t')],
  ['native Read line numbers', 'Read', numbered('→')],
  ['successful text blocks', 'Bash', (s: string) => [{ type: 'text', text: s }]],
] as const) test(`${name} proves both full files`, () => {
  expect(() => requireCoverageFileReads(captured(tool, decorate as any), cwd, files)).not.toThrow();
});

test('one shell result can contain both complete files without parsing command syntax', () => {
  const rows = captured();
  rows[1].message.content[0].input.command = 'sed -n 1,999p src/billing.ts; cat test/billing.test.ts';
  rows[2].message.content[0].content = files.map(file => file.content).join('\n=====\n');
  expect(() => requireCoverageFileReads(rows.slice(0, 3), cwd, files)).not.toThrow();
});

test('one cat -n command with multiple literal operands proves both full files', () => {
  const rows = captured();
  rows[1].message.content[0].input.command = 'cat -n src/billing.ts test/billing.test.ts';
  rows[2].message.content[0].content = files
    .flatMap(file => file.content.split('\n'))
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n');
  expect(() => requireCoverageFileReads(rows.slice(0, 3), cwd, files)).not.toThrow();
});

test('quoted literal echo separators in an && display chain still prove both reads', () => {
  const rows = captured();
  rows[1].message.content[0].input.command =
    'cat -n src/billing.ts && echo "=====TESTS=====" && cat -n test/billing.test.ts && echo "=====DIFF=====" && git diff main --stat && git diff main';
  rows[2].message.content[0].content = [
    numbered('\t')(files[0]!.content),
    '=====TESTS=====',
    numbered('\t')(files[1]!.content),
    '=====DIFF=====',
    ' src/billing.ts | 2 ++',
  ].join('\n');
  expect(() => requireCoverageFileReads(rows.slice(0, 3), cwd, files)).not.toThrow();
});

const negatives: Array<[string, (rows: any[]) => void]> = [
  ['missing source', rows => rows.splice(1, 2)],
  ['missing tests', rows => rows.splice(3, 2)],
  ['pending commands only', rows => { rows.splice(4, 1); rows.splice(2, 1); }],
  ['failed read with full output', rows => { rows[2].message.content[0].is_error = true; }],
  ['malformed error flag', rows => { rows[2].message.content[0].is_error = 'false'; }],
  ['unmatched native ID', rows => { rows[2].message.content[0].tool_use_id = 'other'; }],
  ['wrong result session', rows => { rows[2].session_id = 'other'; }],
  ['unowned subagent output', rows => { rows[1].parent_tool_use_id = rows[2].parent_tool_use_id = 'child'; }],
  ['assistant quotation', rows => { rows[2].type = 'assistant'; }],
  ['tool input contains files but output does not', rows => { rows[1].message.content[0].input.command = files[0].content; rows[2].message.content[0].content = ''; }],
  ['old attempt nonce', rows => { rows[2].message.content[0].content = files[0].content.replace('nonce-source', 'old-source'); }],
  ['partial source', rows => { rows[2].message.content[0].content = 'export function processPayment() {}\n// nonce-source'; }],
  ['non-read output', rows => { rows[1].message.content[0].name = 'Write'; }],
  ['wrong native Read path', rows => { rows[1].message.content[0].name = 'Read'; rows[1].message.content[0].input = { file_path: 'other.ts' }; }],
  ['wrong init cwd', rows => { rows[0].cwd = '/other'; }],
  ['missing init', rows => { rows.shift(); }],
  ['conflicting native owner', rows => { rows.push({ ...rows[0], session_id: 'other' }); }],
  ['conflicting native tool input', rows => { rows.push({ ...rows[1], message: { content: [{ ...rows[1].message.content[0], input: { command: 'other' } }] } }); }],
  ['conflicting native tool result', rows => { rows.push({ ...rows[2], message: { content: [{ ...rows[2].message.content[0], is_error: true }] } }); }],
];
for (const [name, mutate] of negatives) test(`rejects ${name}`, () => {
  const rows = captured(); mutate(rows);
  expect(() => requireCoverageFileReads(rows, cwd, files)).toThrow();
});

for (const output of ['coverage GAP processPayment refundPayment', 'coverage tested processPayment refundPayment',
  'GAP tested processPayment refundPayment', 'coverage GAP tested processPayment']) {
  test(`diagram rejects missing required content: ${output}`, () => {
    expect(() => validateCoverageAudit({ exitReason: 'success', browseErrors: [], output, transcript: captured() } as any, cwd, files)).toThrow();
  });
}

test('diagram rejects bare checkbox markers unless the same block defines them', () => {
  const ambiguous = [
    'CODE PATHS                                            USER FLOWS',
    '├── processPayment()                                  [ ] Payment checkout',
    '│   └── [★★ TESTED] happy path USD',
    '└── refundPayment()',
    '    └── [GAP] happy path missing',
  ].join('\n');
  expect(coverageAuditVerdict({
    exitReason: 'success', browseErrors: [], output: ambiguous, transcript: capturedNativeEvidence(),
  } as any, { cwd, source: files[0]!, tests: files[1]! })).toMatchObject({
    sourceRead: true, testsRead: true, diagram: false, passed: false,
  });
  expect(coverageAuditVerdict({
    exitReason: 'success',
    browseErrors: [],
    output: ambiguous.replace('[ ] Payment checkout', '[GAP] Payment checkout'),
    transcript: capturedNativeEvidence(),
  } as any, { cwd, source: files[0]!, tests: files[1]! })).toMatchObject({
    sourceRead: true, testsRead: true, diagram: true, passed: true,
  });
  expect(coverageAuditVerdict({
    exitReason: 'success',
    browseErrors: [],
    output: `${ambiguous}\nLegend: [x] tested | [ ] no test`,
    transcript: capturedNativeEvidence(),
  } as any, { cwd, source: files[0]!, tests: files[1]! })).toMatchObject({
    sourceRead: true, testsRead: true, diagram: true, passed: true,
  });
});

test('diagram accepts an explicit single GAP legend mixed with quality keys', () => {
  const output = [
    'CODE PATHS                                                  USER FLOWS',
    '[+] src/billing.ts                                          [+] Payment checkout',
    '  ├── processPayment(amount, currency)                        ├── [★★  TESTED] Successful USD charge — billing.test.ts:6',
    '  │   ├── [★★  TESTED] happy path USD — billing.test.ts:6     ├── [GAP]        Customer submits zero / negative amount',
    '  │   └── [GAP]         unsupported currency → throw (:4)     └── [GAP] [→E2E] Double-click submit',
    '  └── refundPayment(paymentId, reason)                      [+] Error states',
    "      ├── [GAP]         happy path → 'refunded' (:11)         ├── [GAP]        'Invalid amount' surfaced",
    "      └── [GAP]         !reason → 'Reason required' (:10)     └── [GAP]        'Reason required' surfaced",
    '',
    'Legend: ★★★ edges + errors  ★★ happy path only  ★ smoke  [GAP] no test  [→E2E] recommend integration test',
  ].join('\n');
  expect(coverageAuditVerdict({
    exitReason: 'success', browseErrors: [], output, transcript: capturedNativeEvidence(),
  } as any, { cwd, source: files[0]!, tests: files[1]! })).toMatchObject({
    sourceRead: true, testsRead: true, diagram: true, passed: true,
  });
});

test('review testing checklist documents a coverage diagram shape accepted by the native oracle', () => {
  const checklist = fs.readFileSync(path.join(ROOT, 'review/specialists/testing.md'), 'utf8');
  expect(checklist).toContain('If the caller explicitly asks for an ASCII coverage diagram');
  expect(checklist).toContain('dedicated tool call');
  expect(checklist).toMatch(/Read\s+diffs, package files, configs, or other context in separate tool calls\./);
  expect(checklist).toContain('valid USD happy path returns success [OK]');
  expect(checklist).toContain('refund success and guard branches not imported or untested [GAP]');
  expect(checklist).toContain('Legend: [OK] tested [GAP] no test');
  const output = checklist.match(/```text\n(src\/billing\.ts[\s\S]*?)\n```/)?.[1];
  expect(output).toBeTruthy();
  expect(coverageAuditVerdict({
    exitReason: 'success', browseErrors: [], output: output!, transcript: capturedNativeEvidence(),
  } as any, { cwd, source: files[0]!, tests: files[1]! })).toEqual({
    sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [],
  });
});

test('both distinct nonempty expected files are mandatory', () => {
  for (const incomplete of [[], files.slice(0, 1), [files[0], files[0]], [{ ...files[0], content: '' }, files[1]]]) {
    expect(() => requireCoverageFileReads(captured(), cwd, incomplete)).toThrow();
  }
});

test('all three paid callers record their actual assertions once and preserve budgets, routes and fresh read evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-recording-free-'));
  try {
    const script = path.join(dir, 'caller.test.ts');
    const facts = path.join(dir, 'facts.json');
    fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)};
const { recordE2E } = await import(path.join(root, 'test/helpers/e2e-helpers.ts'));
const { extractSkillBody } = await import(path.join(root, 'test/helpers/skill-fixture.ts'));
const bodies = new Map(), records = [], observations = [], collectorTiers = [], registrations = [];
const suites = {
  'review-coverage-audit': 'Review Coverage Audit E2E',
  'plan-eng-coverage-audit': 'Plan Eng Review Coverage Audit E2E',
  'ship-coverage-audit': 'Test Coverage Audit E2E',
};
let mode = 'pass', calls = 0, latest, latestCwd, lateResolve;
const collector = { addTest(entry) { records.push(entry); } };
const clock = Date.now, timeout = globalThis.setTimeout;
let virtual = null;
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  ROOT: root, browseBin: path.join(root, 'browse/dist/browse'), runId: 'coverage-free', evalsEnabled: true, recordE2E,
  createEvalCollector: tier => { collectorTiers.push(tier); return collector; }, finalizeEvalCollector: async () => {}, logCost: () => {},
  describeIfSelected: (name, ids, body) => {
    // Import the real workflow file without registering its unrelated setup,
    // browser, upgrade or Codex cases in this isolated proof.
    if (ids.some(id => Object.hasOwn(suites, id))) { expect(ids).toHaveLength(1); expect(name).toBe(suites[ids[0]]); body(); }
  },
  testIfSelected: (id, body, cap) => { registrations.push({ id, cap, concurrent: false }); bodies.set(id, body); },
  testConcurrentIfSelected: (id, body, cap) => { registrations.push({ id, cap, concurrent: true }); bodies.set(id, body); },
  setupBrowseShims: () => { throw new Error('Unrelated workflow setup must not run'); },
  copyDirSync: (from, to) => { if (mode === 'setup') throw new Error('setup failure'); fs.cpSync(from, to, { recursive: true }); },
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({ runSkillTest: async opts => {
  calls++; latestCwd = opts.workingDirectory;
  expect(opts.timeout).toBe(120000); expect(opts.maxTurns).toBe(15); expect(opts.model).toBeUndefined();
  expect(opts.allowedTools).toEqual(['Bash','Read','Write','Edit','Glob','Grep']);
  expect(opts.signal).toBeInstanceOf(AbortSignal);
  expect(opts.prompt).not.toContain('Step 4.75'); expect(opts.prompt).not.toContain('Step 3.4'); expect(opts.prompt).not.toContain('coverage-read-evidence:');
  if (opts.testName === 'review-coverage-audit') expect(opts.prompt).toContain('review/specialists/testing.md');
  else if (opts.testName === 'plan-eng-coverage-audit') { expect(opts.prompt).toContain('plan-eng-review/sections/review-sections.md'); expect(opts.prompt).toContain('3. Test review'); }
  else { expect(opts.testName).toBe('ship-coverage-audit'); expect(opts.prompt).toContain('Step 7'); expect(opts.prompt).toContain('ship/sections/test-coverage.md'); }
  const skill = opts.testName === 'review-coverage-audit' ? 'review' : opts.testName === 'plan-eng-coverage-audit' ? 'plan-eng-review' : 'ship';
  expect(fs.readFileSync(path.join(opts.workingDirectory, skill, 'SKILL.md'), 'utf8')).toBe(extractSkillBody(path.join(root, skill)));
  if (mode === 'runner') throw new Error('runner failure');
  const paths = ['src/billing.ts', 'test/billing.test.ts'].map(file => path.join(opts.workingDirectory, file));
  const contents = paths.map(file => fs.readFileSync(file, 'utf8'));
  for (const text of contents) expect(text).toMatch(/coverage-read-evidence: [a-f0-9-]{36}/);
  const native = { session_id: 'native', parent_tool_use_id: null };
  latest = { exitReason: mode === 'exit' ? 'timeout' : 'success', browseErrors: [], duration: 25,
    output: mode === 'diagram' ? 'No diagram.' : 'Coverage\\nsrc/billing.ts\\n├── processPayment: happy path [TESTED]\\n└── refundPayment [UNTESTED] [GAP]',
    model: 'recorded-model', firstResponseMs: 1, maxInterTurnMs: 1,
    costEstimate: { estimatedCost: 0.37, turnsUsed: 2, estimatedTokens: 100 },
    toolCalls: paths.map(file => ({ tool: 'Bash', input: { command: 'cat -n '+file }, output: '' })),
    transcript: [{ type: 'system', subtype: 'init', cwd: opts.workingDirectory, ...native },
      ...contents.flatMap((content, i) => [{ type: 'assistant', ...native, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-'+i,
        name: 'Bash', input: { command: 'cat -n '+paths[i] } }] } },
      { type: 'user', ...native, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-'+i,
        content: mode === 'missing' && i === 1 ? '' : content.split('\\n').map((line,n) => String(n+1).padStart(6)+'\\t'+line).join('\\n'), is_error: false }] } }])],
  };
  if (mode === 'deadline') return new Promise(resolve => { lateResolve = resolve; });
  return latest;
} }));
await import(path.join(root, 'test/skill-e2e-coverage-audit.test.ts'));
await import(path.join(root, 'test/skill-e2e-workflow.test.ts'));
test('canonical collectors and original case registrations', () => {
  expect(collectorTiers).toEqual(['e2e', 'e2e']);
  expect(registrations).toEqual([
    { id: 'review-coverage-audit', cap: 300000, concurrent: false },
    { id: 'plan-eng-coverage-audit', cap: 300000, concurrent: false },
    { id: 'ship-coverage-audit', cap: 300000, concurrent: true },
  ]);
});
test('actual caller boundaries', async () => {
  expect([...bodies.keys()]).toEqual(['review-coverage-audit','plan-eng-coverage-audit','ship-coverage-audit']);
  const nonces = new Set();
  for (const [id, body] of bodies) for (const kind of ['pass','diagram','missing','exit','runner','setup','deadline']) {
    mode = kind; calls = 0; records.length = 0; latest = undefined; latestCwd = undefined;
    if (kind === 'deadline') {
      virtual = clock(); Date.now = () => virtual;
      globalThis.setTimeout = (fn, ms, ...args) => timeout(() => { virtual += ms; fn(...args); }, ms >= 5000 ? 1 : ms);
    }
    let failure;
    try { await body(); } catch (error) { failure = error; }
    finally { Date.now = clock; globalThis.setTimeout = timeout; }
    expect(records).toHaveLength(1); expect(records[0].passed).toBe(kind === 'pass');
    expect(Boolean(failure)).toBe(kind !== 'pass');
    expect(records[0].name).toBe(id); expect(records[0].suite).toBe(suites[id]); expect(records[0].tier).toBe('e2e');
    if (kind === 'setup' || kind === 'runner' || kind === 'deadline') {
      expect(records[0].cost_usd).toBe(0); expect(records[0].error).toContain('cost and usage unavailable');
      expect(records[0].exit_reason).toBe(kind === 'deadline' ? 'timeout' : 'harness_error');
    } else {
      expect(records[0].cost_usd).toBe(0.37); expect(records[0].transcript).toEqual(latest.transcript);
      expect(records[0].exit_reason).toBe(latest.exitReason);
      for (const row of latest.transcript) if (row.type === 'user') {
        const nonce = row.message.content[0].content.match(/coverage-read-evidence: ([a-f0-9-]{36})/)?.[1];
        if (nonce) { expect(nonces.has(nonce)).toBe(false); nonces.add(nonce); }
      }
    }
    if (latestCwd) expect(fs.existsSync(latestCwd)).toBe(false);
    if (kind === 'deadline') { const saved = JSON.stringify(records); lateResolve(latest); await new Promise(resolve => timeout(resolve, 5)); expect(JSON.stringify(records)).toBe(saved); }
    observations.push({ id, kind, passed: records[0].passed, calls, records: records.length });
  }
  fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(observations));
});
`);
    const proc = Bun.spawn([process.execPath, 'test', script], { cwd: ROOT,
      env: { ...process.env, EVALS: '', GSTACK_EVAL_DIR: path.join(dir, 'evals') }, stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
    expect(JSON.parse(fs.readFileSync(facts, 'utf8'))).toHaveLength(21);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
