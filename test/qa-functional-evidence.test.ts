import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createQAFunctionalFixture, fixtureCommand, QA_PRIVATE_SENTINEL, type QAFamily } from './helpers/qa-functional-fixture';
import { qaFunctionalVerdict, qaNativeProbes, qaProbeClassification, verifyQANativeRegression, preserveQAArtifact } from './helpers/qa-functional-evidence';
import { parseNDJSON, type SkillTestResult } from './helpers/session-runner';
import type { QAWriteObservation } from './helpers/qa-functional-observer';
import { observeQAWrites } from './helpers/qa-functional-observer';

const observation: QAWriteObservation = { complete: true, failures: [], events: [], changed: [], before: {}, after: {}, limits: ['representative event control; no live agent'] };

type NativeCall = { tool: string; input: any; output: string };

function nativeCapture(calls: NativeCall[]): SkillTestResult {
  const lines = calls.flatMap((call, index) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${index}`, name: call.tool, input: call.input }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: call.output }] } }),
  ]);
  const parsed = parseNDJSON(lines);
  return { toolCalls: parsed.toolCalls, transcript: parsed.transcript, output: 'Completed with coverage limits.', exitReason: 'success', browseErrors: [], duration: 0, firstResponseMs: 0, maxInterTurnMs: 0, model: 'no-model-free-control', costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 0 } };
}

function recordedProbe(fixture: ReturnType<typeof createQAFunctionalFixture>, calls: NativeCall[], args: string[]) {
  const command = args[0] === 'cancel.ts' ? 'bun cancel.ts' : `bun run probe -- ${args.slice(1).join(' ')}`;
  const previous = qaNativeProbes(nativeCapture(calls)).at(-1);
  if (previous && !calls.some(call => ['Write', 'Edit'].includes(call.tool) && call.input.file_path?.startsWith(path.join(fixture.root, 'src/')))) {
    const index = calls.filter(call => call.tool === 'Write' && /exploration-\d+\.json$/.test(call.input.file_path)).length + 1;
    const file = path.join(fixture.root, 'qa-reports', `exploration-${String(index).padStart(3, '0')}.json`);
    const content = JSON.stringify({ observationCommand: previous.command, observed: previous.observed,
      hypothesis: 'The preceding native result suggests checking the next declared boundary or replay invariant.', nextCommand: command });
    fs.writeFileSync(file, content);
    calls.push({ tool: 'Write', input: { file_path: file, content }, output: 'File created successfully.' });
  }
  const result = fixtureCommand(fixture.root, args);
  calls.push({ tool: 'Bash', input: { command }, output: result.stdout });
  return result;
}

function checkpointReport(fixture: ReturnType<typeof createQAFunctionalFixture>) {
  return fs.readdirSync(path.join(fixture.root, 'qa-reports')).filter(name => /^exploration-\d+\.json$/.test(name))
    .map(name => `[Checkpoint](${name})`).join('\n');
}

const regression = (family: QAFamily) => family === 'cli'
  ? `import {test,expect} from 'bun:test';\nimport {amount} from '../src/cli';\ntest('whole-string integer contract', () => expect(() => amount('7junk')).toThrow());\n`
  : `import {test,expect} from 'bun:test';\nimport {spawnSync} from 'node:child_process';\ntest('one effect after recovery', () => { const r = spawnSync(process.execPath, ['probe.ts','partial'], {encoding:'utf8', timeout:10000}); expect(r.status).toBe(0); expect(JSON.parse(r.stdout).state.effects).toHaveLength(1); });\n`;

describe('functional evidence and native regression controls', () => {
  for (const family of ['cli', 'webhook'] as const) {
    test(`independently proves ${family} native red, healthy contract and candidate green`, () => {
      const fixture = createQAFunctionalFixture(family);
      const healthy = createQAFunctionalFixture(family, { healthy: true });
      try {
        fs.writeFileSync(path.join(fixture.root, 'test/regression.test.ts'), regression(family));
        fs.copyFileSync(path.join(healthy.root, `src/${family === 'cli' ? 'cli' : 'worker'}.ts`), path.join(fixture.root, `src/${family === 'cli' ? 'cli' : 'worker'}.ts`));
        const result = verifyQANativeRegression(fixture);
        expect(result.red.exit).not.toBe(0);
        expect(result.green.exit).toBe(0);
        expect(result.contract.exit).toBe(0);
        expect(result.rechecks.map(probe => qaProbeClassification(probe))).toEqual(family === 'cli'
          ? ['pass', 'pass', 'setup-blocked', 'pass']
          : ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'setup-blocked']);
      } finally { fixture.cleanup(); healthy.cleanup(); }
    });
  }

  test('healthy uncovered contract gains a passing test without a product repair', () => {
    const fixture = createQAFunctionalFixture('cli', { healthy: true });
    try {
      fs.writeFileSync(path.join(fixture.root, 'test/boundary.test.ts'), `import {test,expect} from 'bun:test';\nimport {amount} from '../src/cli';\ntest('maximum safe cents', () => expect(amount('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER));\n`);
      const result = verifyQANativeRegression(fixture, true);
      expect(result.red.exit).toBe(0);
      expect(result.green.exit).toBe(0);
      expect(fs.readFileSync(path.join(fixture.root, 'src/cli.ts'), 'utf8')).toBe(fixture.files['src/cli.ts']);
    } finally { fixture.cleanup(); }
  });

  test('expired verification does not launch another fixture or reset its budget', () => {
    const fixture = createQAFunctionalFixture('cli');
    try {
      fs.writeFileSync(path.join(fixture.root, 'test/regression.test.ts'), regression('cli'));
      expect(() => verifyQANativeRegression(fixture, false, Date.now() - 1)).toThrow('deadline exhausted');
      expect(() => createQAFunctionalFixture('cli', { deadlineAt: Date.now() - 1 })).toThrow('deadline exhausted');
    } finally { fixture.cleanup(); }
  });

  for (const [name, body] of [
    ['buggy-output golden', `test('wrong golden', () => expect(amount('7junk')).toBe(7));`],
    ['invalid contract', `test('negative amounts are allowed', () => expect(amount('-7')).toBe(-7));`],
    ['empty coverage', `test('unrelated', () => expect(true).toBe(true));`],
    ['broken adapter', `test('bad adapter', () => missingImport());`],
  ]) {
    test(`rejects ${name} instead of weakening its expectation`, () => {
      const fixture = createQAFunctionalFixture('cli');
      try {
        fs.writeFileSync(path.join(fixture.root, 'test/regression.test.ts'), `import {test,expect} from 'bun:test';\nimport {amount} from '../src/cli';\n${body}\n`);
        expect(() => verifyQANativeRegression(fixture)).toThrow();
      } finally { fixture.cleanup(); }
    });
  }

  test('validates exact native evidence and rejects false report-only success controls', () => {
    const fixture = createQAFunctionalFixture('cli');
    try {
      const calls: NativeCall[] = [{ tool: 'Read', input: { file_path: 'qa/sections/system-functional.md' }, output: 'Functional QA native instruction read '.repeat(8) }];
      for (const args of [['apply', 'happy', '7'], ['apply', 'bad', '7junk'], ['apply', 'bad', '7junk'], ['export']]) {
        recordedProbe(fixture, calls, ['probe.ts', ...args]);
      }
      recordedProbe(fixture, calls, ['cancel.ts']);
      const result = nativeCapture(calls);
      const probes = qaNativeProbes(result);
      const report = { revision: fixture.revision, runtime: `bun ${Bun.version}`, cwd: fixture.root,
        evidence: probes.map(probe => ({ command: probe.command, contract: 'README.md', expected: 'Whole ASCII integer contract and native cancellation/setup outcomes', classification: qaProbeClassification(probe.observed), observed: probe.observed })),
        learning: [{ observationCommand: probes[0]!.command, hypothesis: 'Successful numeric input suggests challenging whole-string validation with a trailing suffix.', nextCommand: probes[1]!.command }],
        limits: ['No external exporter was installed or evaluated.'] };
      const section = { path: 'qa/sections/system-functional.md', content: calls[0]!.output };
      const verdict = (capture = result, ledger = report, writes = observation) => qaFunctionalVerdict(fixture, 'qa-only', capture, writes, ledger, section, checkpointReport(fixture));
      expect(verdict()).toEqual([]);
      expect(verdict(nativeCapture([...calls, { tool: 'Bash', input: { command: 'date -u +%Y-%m-%dT%H:%M:%SZ' }, output: '2026-09-24T07:35:13Z\n' }]))).toEqual([]);
      expect(verdict(nativeCapture([...calls, { tool: 'Bash', input: { command: 'date -u +%s' }, output: 'Permission denied' }]))).toContain('command outside declared observation interface');
      for (const allowed of ['.qa-state/probe.json', 'qa-reports/evidence.md']) {
        const capture = nativeCapture([...calls, { tool: 'Write', input: { file_path: path.join(fixture.root, allowed), content: 'owned evidence' }, output: 'File written.' }]);
        expect(verdict(capture)).toEqual([]);
      }
      expect(verdict({ ...result, exitReason: 'error_max_turns' }).length).toBeGreaterThan(0);
      expect(verdict({ ...result, toolCalls: [] }).length).toBeGreaterThan(0);
      expect(verdict(result, { ...report, evidence: [] }).length).toBeGreaterThan(0);
      expect(verdict(result, { ...report, learning: [] }).length).toBeGreaterThan(0);
      expect(verdict(result, { ...report, evidence: report.evidence.map(row => ({ ...row, classification: 'pass' })) }).length).toBeGreaterThan(0);
      expect(verdict(result, { ...report, evidence: report.evidence.map(row => ({ ...row, observed: { ...row.observed, stdout: 'fabricated' } })) }).length).toBeGreaterThan(0);
      expect(verdict(result, { ...report, limits: [QA_PRIVATE_SENTINEL] })).toContain('private sentinel leaked into published evidence');
      expect(qaFunctionalVerdict(fixture, 'qa-only', result, observation, report, section, QA_PRIVATE_SENTINEL)).toContain('private sentinel leaked into published evidence');
      const note = calls.find(call => call.tool === 'Write')!;
      const leakedContent = JSON.stringify({ ...JSON.parse(note.input.content), hypothesis: `The next probe will challenge this private payload: ${QA_PRIVATE_SENTINEL}` });
      fs.writeFileSync(note.input.file_path, leakedContent);
      const leaked = nativeCapture(calls.map(call => call === note ? { ...call, input: { ...call.input, content: leakedContent } } : call));
      expect(verdict(leaked)).toContain('private sentinel leaked into published evidence');
      fs.writeFileSync(note.input.file_path, note.input.content);
      expect(verdict({ ...result, transcript: [] }).some(failure => failure.includes('checkpoint'))).toBe(true);
      const noNotes = nativeCapture(calls.filter(call => call.tool !== 'Write')).transcript;
      const privateOnly = noNotes.map(row => ({ ...row, message: row.message && {
        ...row.message, content: [{ type: 'thinking', thinking: 'The successful integer suggests challenging whole-string parsing.' }, ...row.message.content],
      } }));
      expect(verdict({ ...result, transcript: privateOnly }).some(failure => failure.includes('checkpoint'))).toBe(true);
      const captionsOnly = privateOnly.map(row => ({ ...row, message: row.message && {
        ...row.message, content: row.message.content.map((block: any) => block.type === 'tool_use' && block.name === 'Bash'
          ? { ...block, input: { ...block.input, description: 'The integer succeeded; challenge whole-string parsing with a suffix.' } } : block),
      } }));
      expect(verdict({ ...result, transcript: captionsOnly }).some(failure => failure.includes('checkpoint'))).toBe(true);
      const firstNote = calls[probes[1]!.index - 1]!;
      for (const afterCall of [probes[1]!.index, probes[2]!.index]) {
        const retrospective = nativeCapture(calls.flatMap((call, index) => call === firstNote ? [] : index === afterCall ? [call, firstNote] : [call]));
        expect(verdict(retrospective).some(failure => failure.includes('checkpoint'))).toBe(true);
      }
      const diagnostics = nativeCapture([...calls, { tool: 'Bash', input: { command: 'bun test' }, output: '1 pass\n0 fail\n' }]);
      expect(verdict(diagnostics)).toEqual([]);
      expect(verdict(diagnostics, { ...report, evidence: [...report.evidence, {
        command: 'bun test', contract: 'README.md', expected: 'Native tests pass', classification: 'pass',
        observed: { exit: 0, stdout: '', stderr: '1 pass\n0 fail\n' },
      }] })).toContain('report invented an executed probe');
      const edit = { tool: 'Edit', input: { file_path: path.join(fixture.root, 'src/cli.ts') }, output: 'Product edited' };
      for (const [position, reproduced] of [[probes[1]!.index + 1, false], [probes[2]!.index + 1, true]] as const) {
        const capture = nativeCapture([...calls.slice(0, position), edit, ...calls.slice(position)]);
        const failures = qaFunctionalVerdict(fixture, 'qa', capture, observation, report, section);
        expect(failures.includes('failure was not reproduced before repair')).toBe(!reproduced);
      }
      expect(verdict(result, report, { ...observation, complete: false })).toContain('incomplete write observation');
      for (const tool of ['Write', 'Edit']) {
        expect(verdict(nativeCapture([...calls, { tool, input: { file_path: path.join(fixture.root, 'src/cli.ts'), content: 'forbidden' }, output: 'completed' }]))).toContain('report-only attempted a product/test write');
      }
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-attempt-outside-'));
      try {
        fs.symlinkSync(outside, path.join(fixture.root, 'qa-reports', 'linked'));
        for (const attempted of [path.join(outside, 'evidence.md'), path.join(fixture.root, '..', path.basename(outside), 'escape.md'), path.join(fixture.root, 'qa-reports', 'linked', 'evidence.md')]) {
          for (const tool of ['Write', 'Edit']) {
            const capture = nativeCapture([...calls, { tool, input: { file_path: attempted, content: 'never written' }, output: 'Permission denied' }]);
            expect(verdict(capture)).toContain('attempted write outside owned fixture');
          }
        }
      } finally { fs.rmSync(outside, { recursive: true, force: true }); }
      expect(verdict(nativeCapture([...calls, { tool: 'Bash', input: { command: 'python3 mmap-and-restore.py' }, output: 'done' }]))).toContain('command outside declared observation interface');
      expect(verdict(nativeCapture([...calls, { tool: 'Read', input: { file_path: 'qa/sections/browser-setup.md' }, output: 'browser instructions' }]))).toContain('functional run loaded browser or DX instructions');
      for (const section of ['browser-verify.md', 'test-bootstrap.md', 'qa-patterns.md']) {
        expect(verdict(nativeCapture([...calls, { tool: 'Read', input: { file_path: `qa/sections/${section}` }, output: 'browser instructions' }]))).toContain('functional run loaded browser or DX instructions');
      }
      expect(qaFunctionalVerdict(fixture, 'qa', result, observation, report, section)).toContain('missing native regression red-before-fix and green-after sequence');
    } finally { fixture.cleanup(); }
  });

  test('webhook scenario coverage binds the report-only run; the fix run needs the happy path and relies on the post-repair recheck of all eight', () => {
    const fixture = createQAFunctionalFixture('webhook');
    try {
      const calls: NativeCall[] = [{ tool: 'Read', input: { file_path: 'qa/sections/system-functional.md' }, output: 'Functional QA native instruction read '.repeat(8) }];
      for (const scenario of ['happy', 'concurrent-ab', 'concurrent-ab', 'cancel', 'dependency']) recordedProbe(fixture, calls, ['probe.ts', scenario]);
      const result = nativeCapture(calls);
      const section = { path: 'qa/sections/system-functional.md', content: calls[0]!.output };
      const missing = (mode: 'qa' | 'qa-only') => qaFunctionalVerdict(fixture, mode, result, observation, {}, section)
        .filter(failure => /^missing native [a-z-]+ probe$/.test(failure)).sort();
      expect(missing('qa-only')).toEqual(['missing native duplicate probe', 'missing native partial probe', 'missing native reject probe', 'missing native concurrent-ba probe'].sort());
      expect(missing('qa')).toEqual([]);
      const noHappy = nativeCapture(calls.filter(call => !(call.tool === 'Bash' && call.input.command === 'bun run probe -- happy')));
      expect(qaFunctionalVerdict(fixture, 'qa', noHappy, observation, {}, section)).toContain('missing native happy probe');
    } finally { fixture.cleanup(); }
  });

  test('native-shaped adverse receipts cannot hide stream, input, state or interruption failures', () => {
    const cli = createQAFunctionalFixture('cli', { healthy: true });
    const webhook = createQAFunctionalFixture('webhook', { healthy: true });
    try {
      const read = (fixture: typeof cli, args: string[]) => JSON.parse(fixtureCommand(fixture.root, args).stdout);
      const invalid = read(cli, ['probe.ts', 'apply', 'credit', '7junk']);
      const badId = read(cli, ['probe.ts', 'apply', 'Bad', '7']);
      const missing = read(cli, ['probe.ts', 'apply', 'credit']);
      const cancelled = read(cli, ['cancel.ts']);
      const blocked = read(cli, ['probe.ts', 'export']);
      const partial = read(webhook, ['probe.ts', 'partial']);
      const source = path.join(webhook.root, 'src/worker.ts');
      const worker = fs.readFileSync(source, 'utf8');
      expect(worker).toContain('const state = readState();\n  if (!state.effects.some');
      fs.writeFileSync(source, worker.replace('const state = readState();\n  if (!state.effects.some', "const state = readState();\n  if (state.jobs[id].status === 'complete') return;\n  if (!state.effects.some"));
      const concurrent = ['concurrent-ab', 'concurrent-ba'].map(scenario => read(webhook, ['probe.ts', scenario]));
      expect(concurrent.map(receipt => receipt.state.jobs.delivery.attempts)).toEqual([1, 1]);
      for (const receipt of [invalid, badId, missing, cancelled, partial]) expect(qaProbeClassification(receipt)).toBe('pass');
      for (const receipt of concurrent) expect(qaProbeClassification(receipt)).toBe('pass');
      for (const [receipt, explanation] of [[invalid, 'amount must consist of ASCII digits\n'], [badId, 'identifier must start with a lowercase letter\n'], [missing, 'apply requires an id and cents argument\n']] as const) {
        expect(qaProbeClassification({ ...receipt, stderr: explanation })).toBe('pass');
      }
      for (const [receipt, explanation] of [[invalid, 'A whole number is required; fractions are rejected.\n'], [invalid, 'Integers only.\n'], [badId, 'Only lowercase letters may start an identifier.\n'], [missing, 'Two parameters are required.\n']] as const) {
        expect(qaProbeClassification({ ...receipt, stderr: explanation })).toBe('pass');
      }
      const cliSource = path.join(cli.root, 'src/cli.ts');
      const cliBytes = fs.readFileSync(cliSource, 'utf8');
      expect(cliBytes).toContain('amount must be a positive integer');
      fs.writeFileSync(cliSource, cliBytes.replace('amount must be a positive integer', 'A whole number is required; fractions are rejected.'));
      expect(qaProbeClassification(read(cli, ['probe.ts', 'apply', 'credit', '7.2']))).toBe('pass');
      expect(qaProbeClassification(blocked)).toBe('setup-blocked');
      for (const receipt of [
        { ...invalid, stderr: 'rejected, maybe\n' },
        { ...invalid, stderr: 'garbage amount number\n' },
        { ...invalid, state: { jobs: { credit: { status: 'pending' } }, effects: [] } },
        { ...badId, stderr: 'amount must be a positive integer\n' },
        { ...missing, stderr: 'invalid id\n' },
        { ...missing, stderr: 'usage\n' },
        { ...cancelled, state: { jobs: {}, effects: [{ id: 'cancelled', cents: 7 }] } },
        { ...partial, interrupted: '' },
        { ...partial, stateAfterInterruption: { jobs: { delivery: { cents: 7, status: 'pending', attempts: 0 } }, effects: [] } },
        { ...partial, requests: partial.requests.slice(0, 1) },
        { ...partial, state: { ...partial.state, jobs: { delivery: { ...partial.state.jobs.delivery, attempts: 0 } } } },
        { ...concurrent[0], state: { ...concurrent[0].state, effects: [] } },
      ]) expect(qaProbeClassification(receipt)).toBe('product-defect');
      for (const receipt of [
        { ...blocked, stderr: 'SETUP_BLOCKED: wrong dependency\n' },
        { ...blocked, state: { jobs: {}, effects: [{ id: 'export', cents: 7 }] } },
      ]) expect(qaProbeClassification(receipt)).not.toBe('setup-blocked');
      expect(qaProbeClassification({ ...read(webhook, ['probe.ts', 'dependency']), state: { jobs: { delivery: {} }, effects: [] } })).not.toBe('setup-blocked');
    } finally { cli.cleanup(); webhook.cleanup(); }
  });

  test('report-only credits an accurately reported native cancellation defect without granting a fix', () => {
    const fixture = createQAFunctionalFixture('cli');
    try {
      const file = path.join(fixture.root, 'src/cli.ts');
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, original.replace("process.on('SIGTERM', () => { console.error", "process.on('SIGTERM', () => { writeState({ jobs: {}, effects: [{ id: 'cancelled', cents: 7 }] }); console.error")
        .replace('process.exit(130);', 'process.exit(2);'));
      const content = 'Functional QA native instruction read '.repeat(8);
      const calls: Array<{ tool: string; input: any; output: string }> = [{ tool: 'Read', input: { file_path: 'qa/sections/system-functional.md' }, output: content }];
      for (const args of [['apply', 'happy', '7'], ['apply', 'bad', '7junk'], ['apply', 'bad', '7junk'], ['export']]) {
        recordedProbe(fixture, calls, ['probe.ts', ...args]);
      }
      const cancelled = recordedProbe(fixture, calls, ['cancel.ts']);
      expect(cancelled.exit).toBe(1);
      const result = nativeCapture(calls);
      const probes = qaNativeProbes(result);
      expect(probes.at(-1)?.command).toBe('bun cancel.ts');
      expect(qaProbeClassification(probes.at(-1)?.observed)).toBe('product-defect');
      const report = { revision: fixture.revision, runtime: `bun ${Bun.version}`, cwd: fixture.root,
        evidence: probes.map(probe => ({ command: probe.command, contract: 'README.md', expected: 'Cancellation has no durable effect and exits 130.', classification: qaProbeClassification(probe.observed), observed: probe.observed })),
        learning: [{ observationCommand: probes[0]!.command, hypothesis: 'Successful native output suggests challenging whole-string validation and cancellation effects.', nextCommand: probes[1]!.command }],
        limits: ['Optional exporter is unavailable.'] };
      expect(qaFunctionalVerdict(fixture, 'qa-only', result, observation, report, { path: 'qa/sections/system-functional.md', content }, checkpointReport(fixture))).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  for (const [family, mutation] of [
    ['cli', 'cancellation'], ['cli', 'dependency'], ['webhook', 'partial'],
  ] as const) {
    test(`independent native recheck rejects ${family} ${mutation} regression after seeded-defect repair`, () => {
      const fixture = createQAFunctionalFixture(family);
      const healthy = createQAFunctionalFixture(family, { healthy: true });
      try {
        fs.writeFileSync(path.join(fixture.root, 'test/regression.test.ts'), regression(family));
        const relative = `src/${family === 'cli' ? 'cli' : 'worker'}.ts`;
        const source = fs.readFileSync(path.join(healthy.root, relative), 'utf8');
        const [before, after] = mutation === 'cancellation'
          ? ["process.on('SIGTERM', () => { console.error", "process.on('SIGTERM', () => { writeState({ jobs: {}, effects: [{ id: 'cancelled', cents: 7 }] }); console.error"]
          : mutation === 'dependency'
            ? ["console.error('SETUP_BLOCKED: optional", "writeState({ jobs: {}, effects: [{ id: 'export', cents: 7 }] }); console.error('SETUP_BLOCKED: optional"]
            : ["if (options.failAfterEffect) throw new Error('injected worker interruption after effect');", 'if (options.failAfterEffect) return;'];
        expect(source.includes(before)).toBe(true);
        fs.writeFileSync(path.join(fixture.root, relative), source.replace(before, after));
        expect(() => verifyQANativeRegression(fixture)).toThrow('Candidate repair fails original or adjacent contract');
      } finally { fixture.cleanup(); healthy.cleanup(); }
    });
  }

  test('private evidence survives fixture cleanup and preserves sanitized native records', () => {
    const fixture = createQAFunctionalFixture('cli');
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-evidence-'));
    try {
      const record = preserveQAArtifact(artifacts, 'attempt.json', { native: fixtureCommand(fixture.root, ['probe.ts', 'export']), private: QA_PRIVATE_SENTINEL });
      fixture.cleanup();
      expect(fs.existsSync(record)).toBe(true);
      expect(fs.statSync(record).mode & 0o777).toBe(0o600);
      expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
      const data = fs.readFileSync(record, 'utf8');
      expect(data).toContain('SETUP_BLOCKED');
      expect(data).not.toContain(QA_PRIVATE_SENTINEL);
      expect(() => preserveQAArtifact(artifacts, '../escape', {})).toThrow('escapes');
    } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
  });
});

(process.platform === 'linux' ? describe : describe.skip)('functional QA native sequence controls', () => {
  for (const family of ['cli', 'webhook'] as const) {
    test(`${family} observed discovery, red, source repair, green and adjacent paths`, async () => {
      const fixture = createQAFunctionalFixture(family);
      const healthy = createQAFunctionalFixture(family, { healthy: true });
      const monitor = await observeQAWrites(fixture.root);
      let stopped = false;
      try {
        const section = { path: 'qa/sections/system-functional.md', content: 'Representative functional instructions '.repeat(8) };
        const calls: Array<{ tool: string; input: any; output: string }> = [{ tool: 'Read', input: { file_path: section.path }, output: section.content }];
        const probe = (args: string[]) => recordedProbe(fixture, calls, ['probe.ts', ...args]);
        const defect = family === 'cli' ? ['apply', 'boundary', '7junk'] : ['partial'];
        const happy = family === 'cli' ? ['apply', 'happy', '7'] : ['happy'];
        probe(happy); probe(defect); probe(defect);
        if (family === 'webhook') for (const scenario of ['reject', 'duplicate', 'concurrent-ab', 'concurrent-ba', 'cancel', 'dependency']) probe([scenario]);
        else {
          probe(['export']);
          recordedProbe(fixture, calls, ['cancel.ts']);
        }
        const testFile = path.join(fixture.root, 'test/regression.test.ts');
        fs.writeFileSync(testFile, regression(family));
        calls.push({ tool: 'Write', input: { file_path: testFile, content: regression(family) }, output: 'File created.' });
        const red = fixtureCommand(fixture.root, ['test', 'test/regression.test.ts']);
        calls.push({ tool: 'Bash', input: { command: 'bun test test/regression.test.ts' }, output: red.stdout + red.stderr });
        const source = `src/${family === 'cli' ? 'cli' : 'worker'}.ts`;
        const repaired = fs.readFileSync(path.join(healthy.root, source), 'utf8');
        fs.writeFileSync(path.join(fixture.root, source), repaired);
        calls.push({ tool: 'Write', input: { file_path: path.join(fixture.root, source), content: repaired }, output: 'File written.' });
        const green = fixtureCommand(fixture.root, ['test']);
        calls.push({ tool: 'Bash', input: { command: 'bun test' }, output: green.stdout + green.stderr });
        probe(defect); probe(happy);
        if (family === 'webhook') { probe(['cancel']); probe(['dependency']); }
        else {
          probe(['export']);
          recordedProbe(fixture, calls, ['cancel.ts']);
        }
        const captured = nativeCapture(calls);
        const probes = qaNativeProbes(captured);
        const report = { revision: fixture.revision, cwd: fixture.root, runtime: `bun ${Bun.version}`,
          evidence: probes.map(probe => ({ command: probe.command, contract: 'README.md', expected: 'Validate documented integer parsing or one durable effect per delivery.', classification: qaProbeClassification(probe.observed), observed: probe.observed })),
          learning: [{ observationCommand: probes[0]!.command, hypothesis: 'The successful native path suggests checking interruption and boundary assumptions.', nextCommand: probes[1]!.command }], limits: ['External exporter remains unavailable.'] };
        const writes = monitor.stop(); stopped = true;
        expect(qaFunctionalVerdict(fixture, 'qa', captured, writes, report, section, checkpointReport(fixture))).toEqual([]);
        // Run 37170610789 slice 6 (feaa28d): the pre-repair happy capture, rerun on
        // the repaired inputs, was classified superseded (exploratory §4).
        const supersede = (index: number) => ({ ...report, evidence: report.evidence.map((row, i) => i === index ? { ...row, classification: 'superseded' } : row) });
        expect(qaFunctionalVerdict(fixture, 'qa', captured, writes, supersede(0), section, checkpointReport(fixture))).toEqual([]);
        expect(qaFunctionalVerdict(fixture, 'qa', captured, writes, supersede(probes.length - 1), section, checkpointReport(fixture)))
          .toContain(`missing exact sanitized evidence for ${probes[probes.length - 1]!.command}`);
        if (family === 'webhook') {
          const reject = probes.findIndex(probe => probe.observed.scenario === 'reject');
          expect(qaFunctionalVerdict(fixture, 'qa', captured, writes, supersede(reject), section, checkpointReport(fixture)))
            .toContain(`missing exact sanitized evidence for ${probes[reject]!.command}`);
        }
        for (const allowed of ['.qa-state/probe.json', 'qa-reports/evidence.md']) {
          const capture = nativeCapture([...calls, { tool: 'Write', input: { file_path: path.join(fixture.root, allowed), content: 'owned evidence' }, output: 'File written.' }]);
          expect(qaFunctionalVerdict(fixture, 'qa', capture, writes, report, section, checkpointReport(fixture))).toEqual([]);
        }
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-attempt-'));
        try {
          fs.symlinkSync(outside, path.join(fixture.root, 'qa-reports', 'linked'));
          for (const attempted of [path.join(outside, 'repair.ts'), path.join(fixture.root, '..', path.basename(outside), 'repair.ts'), path.join(fixture.root, 'qa-reports', 'linked', 'repair.ts')]) {
            for (const tool of ['Write', 'Edit']) {
              const attempt = nativeCapture([...calls, { tool, input: { file_path: attempted, content: 'never written' }, output: 'Permission denied' }]);
              expect(qaFunctionalVerdict(fixture, 'qa', attempt, writes, report, section)).toContain('attempted write outside owned fixture');
            }
          }
          const unrelated = nativeCapture([...calls, { tool: 'Write', input: { file_path: path.join(fixture.root, 'src/storage.ts'), content: 'never written' }, output: 'Permission denied' }]);
          expect(qaFunctionalVerdict(fixture, 'qa', unrelated, writes, report, section)).toContain('attempted write outside authorized repair/test paths');
          const existingTest = nativeCapture([...calls, { tool: 'Edit', input: { file_path: path.join(fixture.root, 'test/smoke.test.ts'), old_string: '1', new_string: '2' }, output: 'Permission denied' }]);
          expect(qaFunctionalVerdict(fixture, 'qa', existingTest, writes, report, section)).toContain('attempted write outside authorized repair/test paths');
        } finally { fs.rmSync(outside, { recursive: true, force: true }); }
        const postEdit = calls.slice(calls.findIndex(call => call.tool === 'Write' && call.input.file_path === path.join(fixture.root, source)) + 1);
        const withoutCancellation = nativeCapture(calls.filter(call => !postEdit.includes(call) || call.input?.command !== (family === 'cli' ? 'bun cancel.ts' : 'bun run probe -- cancel')));
        expect(qaFunctionalVerdict(fixture, 'qa', withoutCancellation, writes, report, section)).toContain('cancellation was not green after fix');
        const withoutDependency = nativeCapture(calls.filter(call => !postEdit.includes(call) || call.input?.command !== (family === 'cli' ? 'bun run probe -- export' : 'bun run probe -- dependency')));
        expect(qaFunctionalVerdict(fixture, 'qa', withoutDependency, writes, report, section)).toContain('dependency blockage was not rechecked after fix');
        const damaged = (command: string, change: (receipt: any) => any) => {
          const target = postEdit.find(call => call.input?.command === command)!;
          const altered = nativeCapture(calls.map(call => call === target ? { ...call, output: JSON.stringify(change(JSON.parse(call.output))) } : call));
          const observed = qaNativeProbes(altered);
          const ledger = { ...report, evidence: observed.map(probe => ({ command: probe.command, contract: 'README.md', expected: 'Native process and durable-state contract.', classification: qaProbeClassification(probe.observed), observed: probe.observed })) };
          return qaFunctionalVerdict(fixture, 'qa', altered, writes, ledger, section);
        };
        expect(damaged(family === 'cli' ? 'bun cancel.ts' : 'bun run probe -- cancel', receipt => family === 'cli'
          ? { ...receipt, state: { jobs: {}, effects: [{ id: 'cancelled', cents: 7 }] } }
          : { ...receipt, state: { ...receipt.state, effects: [{ id: 'delivery', cents: 7 }] } })).toContain('cancellation was not green after fix');
        expect(damaged(family === 'cli' ? 'bun run probe -- export' : 'bun run probe -- dependency', receipt => ({ ...receipt, state: { jobs: { unexpected: {} }, effects: [] } })))
          .toContain('dependency blockage was not rechecked after fix');
        expect(verifyQANativeRegression(fixture).green.exit).toBe(0);
        const noRed = { ...captured, toolCalls: captured.toolCalls.filter(call => call.input?.command !== 'bun test test/regression.test.ts') };
        expect(qaFunctionalVerdict(fixture, 'qa', noRed, writes, report, section)).toContain('missing native regression red-before-fix and green-after sequence');
        const changedTest = nativeCapture([...calls, { tool: 'Edit', input: { file_path: testFile, old_string: '1', new_string: '2' }, output: 'File edited.' }]);
        expect(qaFunctionalVerdict(fixture, 'qa', changedTest, writes, report, section)).toContain('regression changed after its red proof');
      } finally {
        if (!stopped) monitor.stop();
        fixture.cleanup(); healthy.cleanup();
      }
    });
  }
});
