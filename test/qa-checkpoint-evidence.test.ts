import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readQACheckpointFiles, validateQACheckpoints } from './helpers/qa-checkpoint-evidence';
import { qaFunctionalVerdict } from './helpers/qa-functional-evidence';
import { parseNDJSON } from './helpers/session-runner';
import { expectMentions } from './helpers/prompt-structure';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporaryRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-checkpoint-')));
  roots.push(root);
  return root;
}
function use(id: string, name: string, input: unknown, parent: string | null = null): any {
  return { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function result(id: string, content: unknown, parent: string | null = null, failed = false): any {
  return { type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }] } };
}
function fixture() {
  const reportRoot = temporaryRoot();
  const probes = [1, 2, 3].map(id => ({ command: id === 1 ? 'bun run probe -- happy' : 'bun run probe -- duplicate',
    observed: { id, stateRoot: `/fixture/state-${id}`, scenario: id === 1 ? 'happy' : 'duplicate', requests: [{ status: 202 }], state: { jobs: {}, effects: [] } } }));
  const transcript: any[] = [];
  let reportMarkdown = '# QA report\n';
  for (const [index, probe] of probes.entries()) {
    if (index) {
      const name = `exploration-00${index}.json`;
      const content = JSON.stringify({ observationCommand: probes[index - 1].command, observed: probes[index - 1].observed,
        hypothesis: 'Replaying this request should not apply the effect twice.', nextCommand: probe.command }, null, 2);
      fs.writeFileSync(path.join(reportRoot, name), content);
      transcript.push(use(`write-${index}`, 'Write', { file_path: path.join(reportRoot, name), content }), result(`write-${index}`, `File created successfully at: ${path.join(reportRoot, name)}`));
      reportMarkdown += `[Checkpoint ${index}](exploration-00${index}.json)\n`;
    }
    transcript.push(use(`probe-${index}`, 'Bash', { command: probe.command }), result(`probe-${index}`, JSON.stringify(probe.observed)));
  }
  return { reportRoot, probes, requiredProbes: probes.slice(1), transcript, reportMarkdown, files: readQACheckpointFiles(reportRoot) };
}
function updateNote(input: ReturnType<typeof fixture>, edit: (value: any) => void) {
  const write = input.transcript[2].message.content[0];
  const value = JSON.parse(write.input.content);
  edit(value);
  write.input.content = JSON.stringify(value);
  fs.writeFileSync(write.input.file_path, write.input.content);
  input.files = readQACheckpointFiles(input.reportRoot);
}
function rejected(input: ReturnType<typeof fixture>, message: string) {
  expect(validateQACheckpoints(input).some(failure => failure.includes(message))).toBe(true);
}

describe('functional report checkpoint-link contract', () => {
  const template = fs.readFileSync(path.join(import.meta.dir, '../qa/templates/functional-report-template.md'), 'utf8');

  test('the shared report template gives concrete Markdown syntax without discarding superseded evidence', () => {
    expect(template).toContain('[checkpoint 001](exploration-001.json)');
    expectMentions(template, [['not', 'backticked', 'filenames']], 'template');
    expectMentions(template, [['not', 'checkpoints', 'superseded']], 'template');
    expect(template).toContain('saved before its next probe');
    expect(template).toContain('path relative to this report');
  });

  test('links built from the actual report-template example satisfy the native checkpoint validator', () => {
    const input = fixture();
    const example = template.match(/\[checkpoint 001\]\(exploration-001\.json\)/)?.[0];
    expect(example).toBeDefined();
    input.reportMarkdown = Object.keys(input.files).map(name => example!.replaceAll('001', name.slice(12, 15))).join('\n');
    expect(validateQACheckpoints(input)).toEqual([]);
  });

  test.each(['plain', 'backticked', 'superseded'])('a %s checkpoint reference is not a Markdown link', style => {
    const input = fixture();
    input.reportMarkdown = `${style === 'backticked' ? '`exploration-001.json`' : `${style}: exploration-001.json`}\n`
      + '[Current checkpoint](exploration-002.json)';
    expect(validateQACheckpoints(input)).toEqual(['QA checkpoint: Report does not link checkpoint: exploration-001.json']);
  });
});

describe('program observations and terminal checkpoint boundaries', () => {
  test('keeps nonzero tool wrapper metadata outside the unchanged program JSON', () => {
    const input = fixture();
    const reply = input.transcript[1].message.content[0];
    reply.content = `Exit code 1\n${reply.content}`;
    reply.is_error = true;
    expect(validateQACheckpoints(input)).toEqual([]);
    updateNote(input, value => { value.observed.toolExit = 1; });
    rejected(input, 'Missing unique completed checkpoint');
  });

  test('rejects a terminal summary even when it preserves the last actual observation', () => {
    const input = fixture();
    expect(validateQACheckpoints(input)).toEqual([]);
    const name = 'exploration-003.json';
    const previous = input.probes.at(-1)!;
    const file_path = path.join(input.reportRoot, name);
    const content = JSON.stringify({ observationCommand: previous.command, observed: previous.observed,
      hypothesis: 'The required probes are complete and no further diagnostic will be run.', nextCommand: 'none' });
    fs.writeFileSync(file_path, content);
    input.transcript.push(use('terminal', 'Write', { file_path, content }), result('terminal', 'File created successfully'));
    input.files = readQACheckpointFiles(input.reportRoot);
    input.reportMarkdown += `[Terminal](${name})\n`;
    rejected(input, `Unrelated, reused or retrospective checkpoint: ${name}`);
  });
});

describe('R20 caller receipt bytes in explicitly synthetic event sequences', () => {
  function capturedReceipts() {
    const observed = [
      '{"id":"probe-842dfffa-3e91-4ecf-a62a-9657a2f62d0f","charter":"happy","input":"4","snapshot":"c0ad40e8bc8c7fc014ee2f9b9e9bde99f842add3ddcd1b9f7bf494747a4ae785","status":"pass","stdout":"8\\n","stderr":"","exit":0}',
      '{"id":"probe-3adf3c33-b883-4570-baf3-d1cfba4c70a7","charter":"plan:nine","input":"9","snapshot":"c0ad40e8bc8c7fc014ee2f9b9e9bde99f842add3ddcd1b9f7bf494747a4ae785","status":"pass","stdout":"18\\n","stderr":"","exit":0}',
    ];
    const reportRoot = temporaryRoot();
    const probes = observed.map(text => ({ command: `bun scripts/probe.ts ${JSON.parse(text).input}`, observed: JSON.parse(text) }));
    const file_path = path.join(reportRoot, 'exploration-001.json');
    const content = JSON.stringify({ observationCommand: probes[0].command, observed: probes[0].observed,
      hypothesis: 'The inclusive upper boundary should preserve the documented successful output.', nextCommand: probes[1].command });
    fs.writeFileSync(file_path, content, { mode: 0o600 });
    return { reportRoot, probes, requiredProbes: probes.slice(1), files: readQACheckpointFiles(reportRoot), reportMarkdown: '[Checkpoint](exploration-001.json)',
      transcript: [use('prior', 'Bash', { command: probes[0].command }), result('prior', observed[0]),
        use('note', 'Write', { file_path, content }), result('note', 'File created successfully'),
        use('next', 'Bash', { command: probes[1].command }), result('next', observed[1])] };
  }

  test.each(['omitted snapshot', 'snapshot summary', 'shortened snapshot', 'renamed identity'])('rejects %s while accepting the complete original native JSON', kind => {
    const input = capturedReceipts();
    expect(validateQACheckpoints(input)).toEqual([]);
    const write = input.transcript[2].message.content[0].input;
    const note = JSON.parse(write.content);
    if (kind === 'snapshot summary') note.observed.snapshotChanged = note.observed.snapshot;
    if (kind === 'renamed identity') note.observed.sourceIdentity = note.observed.snapshot;
    if (kind === 'shortened snapshot') note.observed.snapshot = note.observed.snapshot.slice(0, 8);
    else delete note.observed.snapshot;
    write.content = JSON.stringify(note);
    fs.writeFileSync(write.file_path, write.content, { mode: 0o600 });
    input.files = readQACheckpointFiles(input.reportRoot);
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Missing unique completed checkpoint before probe: bun scripts/probe.ts 9');
  });

  test('a terminal note cannot become a causal checkpoint by naming an already completed command', () => {
    const input = capturedReceipts();
    input.transcript.push(...input.transcript.splice(2, 2));
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Missing unique completed checkpoint before probe: bun scripts/probe.ts 9');
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Unrelated, reused or retrospective checkpoint: exploration-001.json');
  });
});

function regressionCheckpoint(family: 'cli' | 'webhook' = 'cli') {
  const reportRoot = path.join(temporaryRoot(), 'qa-reports');
  fs.mkdirSync(reportRoot);
  const command = family === 'cli' ? 'bun run probe -- export' : 'bun run probe -- dependency';
  const observed = { ...(family === 'cli' ? { args: ['export'] } : { scenario: 'dependency' }), exit: 69,
    stdout: '', stderr: 'SETUP_BLOCKED: optional qa-fixture-exporter-unavailable is not installed\n',
    state: { jobs: {}, effects: [] }, stateRoot: '/fixture/.qa-state/dependency' };
  const nextCommand = `bun test test/${family === 'cli' ? 'amount.regression-1' : 'worker.regression-001'}.test.ts`;
  const output = 'Exit code 1\nbun test v1.4.0 (34cbb9a40)\n\n' + (family === 'cli'
    ? ' 1 pass\n 3 fail\n 4 expect() calls\nRan 4 tests across 1 file. [22.00ms]'
    : ' 0 pass\n 3 fail\n 6 expect() calls\nRan 3 tests across 1 file. [124.00ms]');
  const name = family === 'cli' ? 'exploration-007.json' : 'exploration-010.json';
  const content = JSON.stringify({ observationCommand: command, observed,
    hypothesis: 'Dependency path is an expected setup blocker. Codify the observed defect in a native regression before repair.', nextCommand });
  const file_path = path.join(reportRoot, name);
  fs.writeFileSync(file_path, content);
  return { reportRoot, probes: [{ command, observed }], requiredProbes: [] as Array<{ command: string; observed: unknown }>,
    additionalTargets: [{ command: nextCommand, output }], files: readQACheckpointFiles(reportRoot), reportMarkdown: `[Checkpoint](${name})`,
    transcript: [use('observation', 'Bash', { command }), result('observation', `Exit code 69\n${JSON.stringify(observed)}`, null, true),
      use('checkpoint', 'Write', { file_path, content }), result('checkpoint', `File created successfully at: ${file_path}`),
      use('regression', 'Bash', { command: nextCommand }), result('regression', output, null, true)] };
}

function functionalCheckpointVerdict(input: ReturnType<typeof regressionCheckpoint>) {
  const captured = parseNDJSON(input.transcript.map(event => JSON.stringify(event)));
  return qaFunctionalVerdict({ root: path.dirname(input.reportRoot), family: 'cli', revision: 'fixture', files: {} } as any, 'qa',
    { ...captured, exitReason: 'success', output: '' } as any,
    { complete: true, failures: [], events: [], changed: [], before: {}, after: {}, limits: [] }, {},
    { path: 'qa/sections/system-functional.md', content: 'fixture' }, input.reportMarkdown);
}

function updateRegressionNote(input: ReturnType<typeof regressionCheckpoint>, edit: (value: any) => void) {
  const write = input.transcript[2].message.content[0].input;
  const value = JSON.parse(write.content);
  edit(value);
  write.content = JSON.stringify(value);
  fs.writeFileSync(write.file_path, write.content);
  input.files = readQACheckpointFiles(input.reportRoot);
}

describe('QA optional native regression checkpoints', () => {
  test.each(['cli', 'webhook'] as const)('accepts the captured %s dependency-to-red-regression sequence', family => {
    const input = regressionCheckpoint(family);
    expect(validateQACheckpoints(input)).toEqual([]);
    expect(functionalCheckpointVerdict(input).filter(failure => failure.includes('checkpoint'))).toEqual([]);
  });
  test('keeps regression targets optional and caller-authorized', () => {
    const input = regressionCheckpoint();
    expect(validateQACheckpoints({ ...input, additionalTargets: [] })).toContain('QA checkpoint: Unrelated, reused or retrospective checkpoint: exploration-007.json');
    input.transcript.splice(2, 2);
    fs.unlinkSync(path.join(input.reportRoot, 'exploration-007.json'));
    input.files = {};
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test.each(['absent Write', 'late Write', 'failed Write', 'missing Write result', 'late Write result', 'missing target',
    'missing target result', 'wrong result parent', 'wrong Write parent', 'wrong target parent', 'missing observation result',
    'late observation result', 'forged observation', 'partial observation', 'missing disk', 'missing link', 'changed target output',
    'duplicate target', 'duplicate note'])('rejects optional target with %s', kind => {
    const input = regressionCheckpoint();
    if (kind === 'absent Write') input.transcript.splice(2, 2);
    if (kind === 'late Write') input.transcript.push(...input.transcript.splice(2, 2));
    if (kind === 'failed Write') input.transcript[3].message.content[0].is_error = true;
    if (kind === 'missing Write result') input.transcript.splice(3, 1);
    if (kind === 'late Write result') input.transcript.push(...input.transcript.splice(3, 1));
    if (kind === 'missing target') input.transcript.splice(4, 2);
    if (kind === 'missing target result') input.transcript.pop();
    if (kind === 'wrong result parent') input.transcript[5].parent_tool_use_id = 'other';
    if (kind === 'wrong Write parent') for (const index of [2, 3]) input.transcript[index].parent_tool_use_id = 'other';
    if (kind === 'wrong target parent') for (const index of [4, 5]) input.transcript[index].parent_tool_use_id = 'other';
    if (kind === 'missing observation result') input.transcript.splice(1, 1);
    if (kind === 'late observation result') input.transcript.push(...input.transcript.splice(1, 1));
    if (kind === 'forged observation') updateRegressionNote(input, value => { value.observed.stateRoot = '/forged'; });
    if (kind === 'partial observation') updateRegressionNote(input, value => { delete value.observed.state; });
    if (kind === 'missing disk') fs.unlinkSync(path.join(input.reportRoot, 'exploration-007.json'));
    if (kind === 'missing link') input.reportMarkdown = '';
    if (kind === 'changed target output') input.additionalTargets[0].output += 'fabricated';
    if (kind === 'duplicate target') input.transcript.push(use('repeat', 'Bash', { command: input.additionalTargets[0].command }), result('repeat', input.additionalTargets[0].output, null, true));
    if (kind === 'duplicate note') {
      const file_path = path.join(input.reportRoot, 'exploration-008.json');
      const content = input.transcript[2].message.content[0].input.content;
      fs.writeFileSync(file_path, content);
      input.files = readQACheckpointFiles(input.reportRoot);
      input.reportMarkdown += '\n[duplicate](exploration-008.json)';
      input.transcript.splice(4, 0, use('duplicate-note', 'Write', { file_path, content }), result('duplicate-note', 'File created successfully'));
    }
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test.each(['pwd', 'bun test; echo forged', 'bun test test/../outside.test.ts', 'bun run probe -- dependency'])('functional caller rejects unrelated regression command %s', command => {
    const input = regressionCheckpoint();
    updateRegressionNote(input, value => { value.nextCommand = command; });
    input.transcript[4].message.content[0].input.command = command;
    expect(functionalCheckpointVerdict(input).some(failure => failure.includes('Unrelated, reused or retrospective checkpoint'))).toBe(true);
  });
  test.each(['Exit code 1\nCommand failed before launch', '3 fail', 'bun test v1.4.0\n0 pass\n3 fail\n',
    'SyntaxError\n 0 pass\n 3 fail\nRan 3 tests across 1 file. [1ms]'])('functional caller rejects incomplete or unsupported native result %s', output => {
    const input = regressionCheckpoint();
    input.transcript[5].message.content[0].content = output;
    expect(functionalCheckpointVerdict(input).some(failure => failure.includes('Unrelated, reused or retrospective checkpoint'))).toBe(true);
  });
  test('associates a note only with the next execution, not a later repeat', () => {
    const input = regressionCheckpoint();
    const next = { command: input.additionalTargets[0].command, output: 'bun test v1.4.0\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [1ms]' };
    input.additionalTargets.push(next);
    input.transcript.push(use('repeat', 'Bash', { command: next.command }), result('repeat', next.output));
    expect(validateQACheckpoints(input)).toEqual([]);
    input.additionalTargets.shift();
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Unrelated, reused or retrospective checkpoint: exploration-007.json');
  });
  test.each(['late Write completion', 'same-event dispatch'])('cannot rescue %s by borrowing a later test repeat', kind => {
    const input = regressionCheckpoint();
    const next = { command: input.additionalTargets[0].command, output: 'bun test v1.4.0\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [1ms]' };
    if (kind === 'late Write completion') [input.transcript[3], input.transcript[4]] = [input.transcript[4], input.transcript[3]];
    else {
      input.transcript[2].message.content.push(input.transcript[4].message.content[0]);
      input.transcript.splice(4, 1);
    }
    input.additionalTargets = [next];
    input.transcript.push(use('repeat', 'Bash', { command: next.command }), result('repeat', next.output));
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Unrelated, reused or retrospective checkpoint: exploration-007.json');
  });
  test('accepts separately written notes for repeated completed test commands', () => {
    const input = regressionCheckpoint();
    const next = { command: input.additionalTargets[0].command, output: 'bun test v1.4.0\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [1ms]' };
    const file_path = path.join(input.reportRoot, 'exploration-008.json');
    const content = input.transcript[2].message.content[0].input.content;
    fs.writeFileSync(file_path, content);
    input.files = readQACheckpointFiles(input.reportRoot);
    input.reportMarkdown += '\n[repeat](exploration-008.json)';
    input.additionalTargets.push(next);
    input.transcript.push(use('repeat-note', 'Write', { file_path, content }), result('repeat-note', 'File created successfully'),
      use('repeat', 'Bash', { command: next.command }), result('repeat', next.output));
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('accepts completed child-local regression evidence with native text arrays', () => {
    const input = regressionCheckpoint();
    for (const event of input.transcript) event.parent_tool_use_id = 'qa-child';
    for (const index of [1, 3, 5]) {
      const block = input.transcript[index].message.content[0];
      block.content = [{ type: 'text', text: block.content }];
    }
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('additional targets cannot replace required native discovery notes', () => {
    const input = regressionCheckpoint();
    const next = { command: 'bun run probe -- balance', observed: { args: ['balance'], exit: 0, stdout: 'balance=0\n', stderr: '', state: { jobs: {}, effects: [] }, stateRoot: '/fixture/.qa-state/next' } };
    input.probes.push(next);
    input.requiredProbes.push(next);
    input.transcript.push(use('next-probe', 'Bash', { command: next.command }), result('next-probe', JSON.stringify(next.observed)));
    expect(validateQACheckpoints(input)).toEqual(['QA checkpoint: Missing unique completed checkpoint before probe: bun run probe -- balance']);
    input.requiredProbes = [{ command: input.additionalTargets[0].command, observed: {} }];
    expect(validateQACheckpoints(input)).toContain(`QA checkpoint: Unbound or reused checkpoint target: ${input.additionalTargets[0].command}`);
  });
  test('requires the latest native observation rather than a forged or stale predecessor', () => {
    const input = regressionCheckpoint();
    const newer = { command: 'bun run probe -- export', observed: { ...input.probes[0].observed, stateRoot: '/fixture/.qa-state/newer' } };
    input.probes.push(newer);
    input.transcript.splice(2, 0, use('newer', 'Bash', { command: newer.command }), result('newer', JSON.stringify(newer.observed)));
    expect(validateQACheckpoints(input)).toContain('QA checkpoint: Unrelated, reused or retrospective checkpoint: exploration-007.json');
  });
});

describe('QA checkpoint file reader', () => {
  test('reads only exact checkpoint basenames and preserves bytes', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'exploration-001.json'), ' complete bytes\n');
    for (const name of ['exploration-1.json', 'exploration-0001.json', 'report.md']) fs.writeFileSync(path.join(root, name), 'ignored');
    expect(readQACheckpointFiles(root)).toEqual({ 'exploration-001.json': ' complete bytes\n' });
  });
  test('rejects relative, missing, root, traversal, and linked report roots', () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, 'reports'));
    fs.symlinkSync(path.join(root, 'reports'), path.join(root, 'linked'));
    for (const unsafe of ['.', '/', `${root}/missing`, `${root}/reports/..`, `${root}/linked`]) {
      expect(() => readQACheckpointFiles(unsafe)).toThrow();
    }
    fs.mkdirSync(path.join(root, 'reports', 'nested'));
    expect(() => readQACheckpointFiles(path.join(root, 'linked', 'nested'))).toThrow();
  });
  test.each(['symlink', 'hardlink', 'directory'])('rejects %s checkpoint artifacts', kind => {
    const root = temporaryRoot();
    const target = path.join(root, 'exploration-001.json');
    const outside = path.join(temporaryRoot(), 'outside');
    fs.writeFileSync(outside, 'original');
    if (kind === 'symlink') fs.symlinkSync(outside, target);
    if (kind === 'hardlink') fs.linkSync(outside, target);
    if (kind === 'directory') fs.mkdirSync(target);
    expect(() => readQACheckpointFiles(root)).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('original');
  });
});

describe('QA native checkpoint evidence', () => {
  test('accepts successful Writes between real results and repeated command dispatches', () => {
    expect(validateQACheckpoints(fixture())).toEqual([]);
  });
  test('accepts native text arrays, multiline JSON, and object key reordering', () => {
    const input = fixture();
    input.transcript[1].message.content[0].content = [{ type: 'text', text: JSON.stringify(input.probes[0].observed, null, 2) }];
    input.transcript[3].message.content[0].content = [{ type: 'text', text: 'File created successfully' }];
    updateNote(input, value => { value.observed = Object.fromEntries(Object.entries(value.observed).reverse()); });
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('pairs interleaved parent and child IDs without borrowing results', () => {
    const input = fixture();
    input.transcript.splice(1, 0, use('probe-0', 'Bash', { command: 'unrelated' }, 'child'));
    input.transcript.splice(3, 0, result('probe-0', 'unrelated child output', 'child'));
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript[2].parent_tool_use_id = 'other-child';
    rejected(input, 'Orphaned');
  });
  test('accepts complete child-local probe and checkpoint streams', () => {
    const input = fixture();
    for (const event of input.transcript) event.parent_tool_use_id = 'qa-child';
    input.transcript.unshift(use('probe-0', 'Agent', { prompt: 'qa' }));
    input.transcript.push(result('probe-0', 'QA complete'));
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('only requires selected discovery checkpoints, while permitting valid optional notes', () => {
    const input = fixture();
    input.requiredProbes = [input.probes[1]];
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript.splice(6, 2);
    fs.unlinkSync(path.join(input.reportRoot, 'exploration-002.json'));
    input.files = readQACheckpointFiles(input.reportRoot);
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('rejects multiple JSON results instead of selecting a convenient observation', () => {
    const input = fixture();
    input.transcript[1].message.content[0].content += '\n' + JSON.stringify({ fabricated: true });
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test('rejects unsupported rewrites even when bytes remain unchanged', () => {
    const input = fixture();
    input.transcript.push(use('shell-write', 'Bash', { command: 'printf unchanged > exploration-001.json' }), result('shell-write', ''));
    rejected(input, 'Unsupported checkpoint Bash');
  });
  test('does not count one observation or one note twice', () => {
    const input = fixture();
    input.probes.push(input.probes[1]);
    rejected(input, 'Unbound or ambiguous native probe');
    input.probes.pop();
    const original = input.transcript[2].message.content[0].input;
    const name = 'exploration-099.json';
    const file_path = path.join(input.reportRoot, name);
    fs.writeFileSync(file_path, original.content);
    input.files = readQACheckpointFiles(input.reportRoot);
    input.reportMarkdown += `[extra](${name})`;
    input.transcript.splice(4, 0, use('extra-note', 'Write', { file_path, content: original.content }), result('extra-note', 'ok'));
    rejected(input, 'Missing unique');
  });
  test('all failure diagnostics carry the stable checkpoint marker', () => {
    const input = fixture();
    input.transcript = [result('orphan', 'ok')];
    const failures = validateQACheckpoints(input);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every(failure => failure.includes('checkpoint'))).toBe(true);
  });
  test('binds completed exit-69 dependency results as both target and prior observation', () => {
    const input = fixture();
    const dependency = { command: 'bun run probe -- dependency', observed: { scenario: 'dependency', stateRoot: '/fixture/dependency',
      exit: 69, stdout: '', stderr: 'SETUP_BLOCKED: optional qa-fixture-exporter-unavailable is not installed\n', state: { jobs: {}, effects: [] } } };
    input.probes[1] = dependency as any;
    input.requiredProbes = input.probes.slice(1);
    input.transcript[4].message.content[0].input.command = dependency.command;
    input.transcript[5].message.content[0].is_error = true;
    input.transcript[5].message.content[0].content = `Exit code 69\n$ bun probe.ts dependency\n${JSON.stringify(dependency.observed)}`;
    updateNote(input, value => { value.nextCommand = dependency.command; });
    const write = input.transcript[6].message.content[0].input;
    const note = JSON.parse(write.content);
    note.observationCommand = dependency.command;
    note.observed = dependency.observed;
    write.content = JSON.stringify(note);
    fs.writeFileSync(write.file_path, write.content);
    input.files = readQACheckpointFiles(input.reportRoot);
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript[5].message.content[0].content = 'Exit code 69\n$ bun probe.ts dependency\nProcess failed without native JSON';
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test.each(['missing result', 'orphan result', 'duplicate result', 'duplicate use', 'failed Write', 'failed probe without JSON'])('rejects %s', kind => {
    const input = fixture();
    if (kind === 'missing result') input.transcript.splice(3, 1);
    if (kind === 'orphan result') input.transcript.push(result('orphan', 'ok'));
    if (kind === 'duplicate result') input.transcript.push(input.transcript[3]);
    if (kind === 'duplicate use') input.transcript.push(input.transcript[2]);
    if (kind === 'failed Write') input.transcript[3].message.content[0].is_error = true;
    if (kind === 'failed probe without JSON') {
      input.transcript[1].message.content[0].is_error = true;
      input.transcript[1].message.content[0].content = 'Command failed before producing native JSON';
    }
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test.each(['target before Write completion', 'note before observation completion', 'retrospective Write', 'same-event dispatch'])('rejects %s chronology', kind => {
    const input = fixture();
    if (kind === 'target before Write completion') [input.transcript[3], input.transcript[4]] = [input.transcript[4], input.transcript[3]];
    if (kind === 'note before observation completion') [input.transcript[1], input.transcript[2]] = [input.transcript[2], input.transcript[1]];
    if (kind === 'retrospective Write') input.transcript.push(...input.transcript.splice(2, 2));
    if (kind === 'same-event dispatch') {
      input.transcript[2].message.content.push(input.transcript[4].message.content[0]);
      input.transcript.splice(4, 1);
    }
    rejected(input, 'Missing unique');
  });
  test.each(['partial observation', 'invented observation', 'stale observation', 'wrong prior command', 'wrong next command', 'short hypothesis', 'extra schema key'])('rejects %s', kind => {
    const input = fixture();
    updateNote(input, value => {
      if (kind === 'partial observation') delete value.observed.state;
      if (kind === 'invented observation') value.observed.stateRoot = '/fabricated';
      if (kind === 'stale observation') value.observed = input.probes[1].observed;
      if (kind === 'wrong prior command') value.observationCommand += ' fabricated';
      if (kind === 'wrong next command') value.nextCommand += ' fabricated';
      if (kind === 'short hypothesis') value.hypothesis = 'Try another thing';
      if (kind === 'extra schema key') value.fabricated = true;
    });
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test('rejects a fabricated probe even when its checkpoint copies it exactly', () => {
    const input = fixture();
    input.probes[0].observed.stateRoot = '/invented';
    updateNote(input, value => { value.observed = input.probes[0].observed; });
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test('does not confuse repeated commands with different native observations', () => {
    const input = fixture();
    input.requiredProbes = [input.probes[1], input.probes[1]];
    rejected(input, 'reused checkpoint target');
    input.requiredProbes = input.probes.slice(1);
    input.transcript[5].message.content[0].content = JSON.stringify(input.probes[2].observed);
    rejected(input, 'ambiguous native probe');
  });
  test.each(['missing disk', 'changed disk', 'forged files', 'stale artifact', 'overwritten Write', 'missing link', 'plain filename'])('rejects %s', kind => {
    const input = fixture();
    const name = 'exploration-001.json';
    if (kind === 'missing disk') fs.unlinkSync(path.join(input.reportRoot, name));
    if (kind === 'changed disk') fs.writeFileSync(path.join(input.reportRoot, name), 'replaced');
    if (kind === 'forged files') input.files[name] = 'forged';
    if (kind === 'stale artifact') {
      fs.writeFileSync(path.join(input.reportRoot, 'exploration-099.json'), input.files[name]);
      input.files = readQACheckpointFiles(input.reportRoot);
    }
    if (kind === 'overwritten Write') input.transcript.push(use('overwrite', 'Write', input.transcript[2].message.content[0].input), result('overwrite', 'ok'));
    if (kind === 'missing link') input.reportMarkdown = '';
    if (kind === 'plain filename') input.reportMarkdown = Object.keys(input.files).join('\n');
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test.each(['escape', 'relative', 'nested', 'Edit', 'Bash', 'thinking', 'text'])('does not credit %s notes', kind => {
    const input = fixture();
    const block = input.transcript[2].message.content[0];
    if (kind === 'escape') block.input.file_path = path.join(temporaryRoot(), 'exploration-001.json');
    if (kind === 'relative') block.input.file_path = 'exploration-001.json';
    if (kind === 'nested') block.input.file_path = path.join(input.reportRoot, 'nested', 'exploration-001.json');
    if (kind === 'Edit') block.name = 'Edit';
    if (kind === 'Bash') { block.name = 'Bash'; block.input = { command: 'printf checkpoint > exploration-001.json', description: block.input.content }; }
    if (kind === 'thinking' || kind === 'text') {
      input.transcript[2].message.content = [{ type: kind, [kind]: block.input.content }];
      input.transcript.splice(3, 1);
    }
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test('cannot borrow a note from another parent scope', () => {
    const input = fixture();
    input.transcript[2].parent_tool_use_id = 'other';
    input.transcript[3].parent_tool_use_id = 'other';
    rejected(input, 'Missing unique');
  });
});
