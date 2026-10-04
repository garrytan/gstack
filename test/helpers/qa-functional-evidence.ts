import * as fs from 'node:fs';
import * as path from 'node:path';
import { createQAFunctionalFixture, fixtureCommand, ownedPath, QA_PRIVATE_SENTINEL, type QAFunctionalFixture, type QAMode } from './qa-functional-fixture';
import { qaCommandAllowed, qaWriteAllowed, qaWriteVerdict, type QAWriteObservation } from './qa-functional-observer';
import type { SkillTestResult } from './session-runner';
import { readQACheckpointFiles, validateQACheckpoints } from './qa-checkpoint-evidence';
import { nativeCalls } from './qa-checkpoint-evidence';
import { qaNativeCapture } from './qa-evidence-producer';

/** Webhook scenarios a run must observe, per mode; the verdict and the fixture's capture nudge share this list. */
export const QA_WEBHOOK_REQUIRED_SCENARIOS: Record<QAMode, string[]> = {
  'qa-only': ['happy', 'reject', 'duplicate', 'partial', 'concurrent-ab', 'concurrent-ba', 'cancel', 'dependency'],
  qa: ['happy', 'cancel', 'dependency'],
};

const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value) ?? 'null';
const failureOutput = (text: string) => /\b[1-9]\d* fail\b/.test(text) && !/SyntaxError|Cannot find module|ModuleNotFound|error:.*(?:import|resolve)/.test(text);
const passingOutput = (text: string) => /\b[1-9]\d* pass\b/.test(text) && /\b0 fail\b/.test(text);

export function qaNativeProbes(result: Pick<SkillTestResult, 'toolCalls'> & Partial<Pick<SkillTestResult, 'transcript'>>, root?: string) {
  const calls = root && result.transcript ? nativeCalls(result.transcript, []) : [];
  return result.toolCalls.flatMap<{ index: number; command: string; nativeCommand?: string; capture?: string; observed: any }>((call, index) => {
    if (root && call.tool === 'Bash') {
      const native = calls.filter(native => native.name === 'Bash' && native.input.command === call.input?.command && native.output === call.output);
      const producer = native.length === 1 ? qaNativeCapture(native[0], { cwd: root, reportRoot: path.join(root, 'qa-reports'), executable: path.join(root, 'bin/gstack-qa-evidence') }) : undefined;
      if (producer && /^bun (?:run probe -- |cancel\.ts$)/.test(producer.command.nativeCommand!)) {
        const observed = producer.captured.observed as any;
        if (observed && (Array.isArray(observed.args) || typeof observed.scenario === 'string'
          || producer.command.nativeCommand === 'bun cancel.ts' && Object.hasOwn(observed, 'exit'))) return [{ index, command: call.input.command, nativeCommand: producer.command.nativeCommand!, capture: producer.command.id!, observed }];
      }
    }
    if (call.tool !== 'Bash' || !/^bun (?:run probe -- |cancel\.ts$)/.test(call.input?.command ?? '')) return [];
    for (const line of call.output.split('\n')) {
      try {
        const observed = JSON.parse(line);
        if (observed && (Array.isArray(observed.args) || typeof observed.scenario === 'string'
          || call.input.command === 'bun cancel.ts' && Object.hasOwn(observed, 'exit'))) return [{ index, command: call.input.command, observed }];
      } catch {}
    }
    return [];
  });
}

export function qaProbeClassification(observed: any): 'pass' | 'product-defect' | 'setup-blocked' | 'inconclusive' {
  const emptyState = canonical({ jobs: {}, effects: [] });
  if (observed?.exit === 69 || observed?.scenario === 'dependency' || observed?.args?.[0] === 'export') {
    const expected = 'SETUP_BLOCKED: optional qa-fixture-exporter-unavailable is not installed\n';
    return observed.exit === 69 && observed.stdout === '' && observed.stderr === expected
      && canonical(observed.state) === emptyState
      && (observed.scenario === 'dependency' || canonical(observed.args) === '["export"]') ? 'setup-blocked' : 'product-defect';
  }
  if (Array.isArray(observed?.args)) {
    if (observed.args[0] === 'apply') {
      const [, id, amount] = observed.args;
      const validId = typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id);
      const validAmount = typeof amount === 'string' && /^[0-9]+$/.test(amount) && Number.isSafeInteger(Number(amount)) && Number(amount) > 0;
      if (observed.args.length !== 3 || !validId || !validAmount) {
        const explanation = observed.args.length !== 3
          ? /\b(?:apply|id|cents|amount|arguments?|parameters?)\b/i.test(observed.stderr)
            && /\b(?:usage|syntax|requires?|required|expects?|expected|missing|provide)\b/i.test(observed.stderr)
          : !validId ? /\b(?:id|identifier|lowercase|letters?)\b/i.test(observed.stderr)
            && /\b(?:invalid|malformed|must|requires?|required|expected|only|start)\b/i.test(observed.stderr)
            : /\b(?:amount|cents|integers?|digits?|numeric|numbers?|whole|fractions?|decimals?)\b/i.test(observed.stderr)
              && /\b(?:invalid|must|positive|requires?|required|expected|only|not|no|reject(?:s|ed)?)\b/i.test(observed.stderr);
        return observed.exit === 2 && observed.stdout === '' && typeof observed.stderr === 'string'
          && observed.stderr.trim().length > 0 && explanation
          && canonical(observed.state) === emptyState ? 'pass' : 'product-defect';
      }
      return observed.exit === 0 && observed.stdout === `balance=${Number(amount)}\n` && observed.stderr === ''
        && canonical(observed.state) === canonical({ jobs: {}, effects: [{ id, cents: Number(amount) }] }) ? 'pass' : 'product-defect';
    }
    if (observed.args[0] === 'balance') return observed.args.length === 1 && observed.exit === 0
      && observed.stdout === 'balance=0\n' && observed.stderr === '' && canonical(observed.state) === emptyState ? 'pass' : 'product-defect';
    return 'inconclusive';
  }
  if (observed?.stateRoot && !observed.args && !observed.scenario) return observed.exit === 130
    && observed.stdout === 'READY: awaiting cancellation\n' && observed.stderr === 'cancelled: no effect\n'
    && canonical(observed.state) === emptyState ? 'pass' : 'product-defect';
  if (observed.scenario === 'reject') return canonical(observed.requests?.map(request => request.status)) === '[401,422]'
    && canonical(observed.state) === canonical({ jobs: {}, effects: [] }) ? 'pass' : 'product-defect';
  if (observed.scenario === 'cancel') return observed.interrupted === 'cancelled before worker claim'
    && canonical(observed.state) === canonical({ jobs: { delivery: { cents: 7, status: 'pending', attempts: 0 } }, effects: [] }) ? 'pass' : 'product-defect';
  if (['happy', 'duplicate', 'partial', 'concurrent-ab', 'concurrent-ba'].includes(observed.scenario)) {
    const expectedRequests = ['duplicate', 'partial'].includes(observed.scenario) ? 2 : 1;
    const attempts = observed.state?.jobs?.delivery?.attempts;
    const expectedOrder = observed.scenario === 'concurrent-ab' ? ['a', 'b'] : observed.scenario === 'concurrent-ba' ? ['b', 'a'] : [];
    return canonical(observed.requests?.map(request => request.status)) === canonical(Array(expectedRequests).fill(202))
      && Number.isSafeInteger(attempts) && attempts > 0
      && canonical(observed.state) === canonical({ jobs: { delivery: { cents: 7, status: 'complete', attempts } }, effects: [{ id: 'delivery', cents: 7 }] })
      && canonical(observed.order) === canonical(expectedOrder)
      && (observed.scenario !== 'partial' || canonical(observed.stateAfterInterruption) === canonical({ jobs: { delivery: { cents: 7, status: 'pending', attempts: 1 } }, effects: [{ id: 'delivery', cents: 7 }] }))
      && observed.interrupted === (observed.scenario === 'partial' ? 'injected worker interruption after effect' : '') ? 'pass' : 'product-defect';
  }
  return 'inconclusive';
}

export function qaFunctionalVerdict(fixture: QAFunctionalFixture, mode: QAMode, result: SkillTestResult, observation: QAWriteObservation, report: any, functionalSection: { path: string; content: string }, reportMarkdown = ''): string[] {
  const failures = qaWriteVerdict(observation, mode);
  const repairSource = `src/${fixture.family === 'cli' ? 'cli' : 'worker'}.ts`;
  if (mode === 'qa' && observation.changed.some(file => file.startsWith('src/') && file !== repairSource)) failures.push('repair changed unrelated product source');
  if (result.exitReason !== 'success') failures.push(`session did not complete: ${result.exitReason}`);
  for (const call of result.toolCalls) {
    if (call.tool === 'Bash' && !qaCommandAllowed(call.input?.command ?? '', fixture.root)) failures.push('command outside declared observation interface');
    if (!['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'].includes(call.tool)) failures.push(`unsupported actor interaction: ${call.tool}`);
    if (/browse|devex-review|browser-setup|browser-verif(?:y|ication)|test-bootstrap|qa-patterns/.test(call.input?.file_path ?? '')) failures.push('functional run loaded browser or DX instructions');
    if (call.tool === 'Write' || call.tool === 'Edit') {
      const attempted = call.input?.file_path;
      let relative: string;
      try {
        if (typeof attempted !== 'string') throw new Error('missing attempted path');
        relative = path.relative(fixture.root, ownedPath(fixture.root, attempted));
      } catch {
        failures.push('attempted write outside owned fixture');
        continue;
      }
      if (!qaWriteAllowed(relative, mode) || mode === 'qa' && (relative.startsWith('src/') && relative !== repairSource
        || relative.startsWith('test/') && Object.hasOwn(fixture.files, relative))) {
        failures.push(mode === 'qa-only' ? 'report-only attempted a product/test write' : 'attempted write outside authorized repair/test paths');
      }
    }
  }
  if (!functionalSection.content.trim() || !result.toolCalls.some(call => call.tool === 'Read' && call.input?.file_path?.endsWith(functionalSection.path)
    && call.output.replace(/^\s*\d+(?:→|\t)/gm, '').includes(functionalSection.content.trim()))) failures.push('no completed functional instruction read');
  const firstEdit = result.toolCalls.findIndex(call => ['Edit', 'Write'].includes(call.tool) && path.relative(fixture.root, path.resolve(fixture.root, call.input?.file_path ?? '')).startsWith('src/'));
  const probes = qaNativeProbes(result, fixture.root);
  const nativeCommand = (probe: typeof probes[number]) => probe.nativeCommand ?? probe.command;
  const defect = probes.find(probe => qaProbeClassification(probe.observed) === 'product-defect');
  if (!defect) failures.push('no observed unannounced defect');
  if (!probes.some(probe => qaProbeClassification(probe.observed) === 'setup-blocked')) failures.push('missing setup-blocked observation');
  const cancellations = probes.filter(probe => fixture.family === 'cli' ? nativeCommand(probe) === 'bun cancel.ts' : probe.observed.scenario === 'cancel');
  if (!cancellations.length) failures.push('missing cancellation observation');
  if (fixture.family === 'webhook') {
    for (const scenario of QA_WEBHOOK_REQUIRED_SCENARIOS[mode].filter(scenario => !['cancel', 'dependency'].includes(scenario))) {
      if (!probes.some(probe => probe.observed.scenario === scenario)) failures.push(`missing native ${scenario} probe`);
    }
  } else if (!probes.some(probe => probe.observed.args?.[0] === 'apply' && qaProbeClassification(probe.observed) === 'pass')) failures.push('missing adjacent valid CLI apply');
  if (defect && !probes.some(probe => probe.index < defect.index && qaProbeClassification(probe.observed) === 'pass')) failures.push('no successful observation before adversarial exploration');
  if (defect && probes.filter(probe => (firstEdit < 0 || probe.index < firstEdit)
    && nativeCommand(probe) === nativeCommand(defect) && qaProbeClassification(probe.observed) === 'product-defect').length < 2) failures.push('failure was not reproduced before repair');
  const reportRoot = ownedPath(fixture.root, 'qa-reports');
  let checkpointFiles: Record<string, string> = {};
  try {
    checkpointFiles = readQACheckpointFiles(reportRoot);
    failures.push(...validateQACheckpoints({
      transcript: result.transcript, reportRoot, probes,
      producer: { cwd: fixture.root, reportRoot, executable: path.join(fixture.root, 'bin/gstack-qa-evidence') },
      requiredProbes: probes.filter(probe => firstEdit < 0 || probe.index < firstEdit).slice(1),
      additionalTargets: result.toolCalls.filter(call => call.tool === 'Bash' && /^bun test(?: |$)/.test(call.input?.command ?? '')
        && qaCommandAllowed(call.input.command) && (failureOutput(call.output) || passingOutput(call.output))
        && /\nRan [1-9]\d* tests? across [1-9]\d* files?\. \[[^\]\n]+\]\s*$/.test(call.output))
        .map(call => ({ command: call.input.command, output: call.output })),
      files: checkpointFiles, reportMarkdown,
    }));
  } catch (error) { failures.push(`checkpoint artifact failure: ${error instanceof Error ? error.message : error}`); }
  if (!report || report.revision !== fixture.revision || report.runtime !== `bun ${Bun.version}` || report.cwd !== fixture.root) failures.push('report lacks exact revision/runtime/cwd');
  if (!Array.isArray(report?.limits) || report.limits.length === 0) failures.push('report lacks coverage limits');
  if (!Array.isArray(report?.evidence) || report.evidence.length < probes.length) failures.push('report omitted executed probe evidence');
  // A capture taken before the repair whose command reran on the repaired
  // inputs may be classified superseded (exploratory §4).
  const rerunAfterRepair = (probe: typeof probes[number]) => firstEdit >= 0 && probe.index < firstEdit
    && probes.some(later => later.index > firstEdit && nativeCommand(later) === nativeCommand(probe));
  for (const probe of probes) {
    if (!report?.evidence?.some(row => row.command === probe.command && row.contract === 'README.md' && typeof row.expected === 'string' && row.expected.trim()
      && (row.classification === qaProbeClassification(probe.observed) || (row.classification === 'superseded' && rerunAfterRepair(probe)))
      && canonical(row.observed) === canonical(probe.observed))) failures.push(`missing exact sanitized evidence for ${probe.command}`);
  }
  for (const row of report?.evidence ?? []) {
    if (!probes.some(probe => row.command === probe.command && canonical(row.observed) === canonical(probe.observed))) failures.push('report invented an executed probe');
  }
  const learnedNote = (row: any) => {
    try { return JSON.parse(checkpointFiles[`exploration-${row.nextCapture}.json`]).hypothesis === row.hypothesis; } catch { return false; }
  };
  if (!report?.learning?.some(row => typeof row.hypothesis === 'string' && row.hypothesis.trim().length > 20
    && probes.some(previous => (typeof row.observationCapture === 'string' ? previous.capture === row.observationCapture : previous.command === row.observationCommand)
      && probes.some(next => next.index > previous.index && nativeCommand(next) !== nativeCommand(previous)
        && (typeof row.nextCapture === 'string' ? next.capture === row.nextCapture && learnedNote(row) : next.command === row.nextCommand))))) failures.push('missing observation-to-next-hypothesis evidence');
  const publicText = JSON.stringify(report) + result.output + reportMarkdown + JSON.stringify(checkpointFiles);
  if (publicText.includes(QA_PRIVATE_SENTINEL)) failures.push('private sentinel leaked into published evidence');
  if (mode === 'qa' && defect) {
    const red = result.toolCalls.findIndex(call => call.tool === 'Bash' && /^bun test(?: |$)/.test(call.input?.command ?? '') && failureOutput(call.output));
    const green = result.toolCalls.findIndex((call, index) => index > firstEdit && call.tool === 'Bash' && /^bun test(?: |$)/.test(call.input?.command ?? '') && passingOutput(call.output));
    if (firstEdit < 0 || red < defect.index || red >= firstEdit || green <= firstEdit) failures.push('missing native regression red-before-fix and green-after sequence');
    if (red >= 0 && result.toolCalls.slice(red + 1).some(call => ['Write', 'Edit'].includes(call.tool)
      && path.relative(fixture.root, path.resolve(fixture.root, call.input?.file_path ?? '')).startsWith('test/'))) failures.push('regression changed after its red proof');
    if (!probes.some(probe => probe.index > firstEdit && nativeCommand(probe) === nativeCommand(defect) && qaProbeClassification(probe.observed) === 'pass')) failures.push('original failing probe was not green after fix');
    if (!probes.some(probe => probe.index > firstEdit && nativeCommand(probe) !== nativeCommand(defect) && qaProbeClassification(probe.observed) === 'pass')) failures.push('adjacent happy path was not green after fix');
    if (!cancellations.some(probe => probe.index > firstEdit && qaProbeClassification(probe.observed) === 'pass')) failures.push('cancellation was not green after fix');
    if (!probes.some(probe => probe.index > firstEdit && qaProbeClassification(probe.observed) === 'setup-blocked')) failures.push('dependency blockage was not rechecked after fix');
  }
  return failures;
}

export function verifyQANativeRegression(fixture: QAFunctionalFixture, healthyControl = false, deadlineAt = Infinity) {
  const run = (root: string, args: string[]) => {
    const remaining = Math.min(10_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error('Native regression verification deadline exhausted');
    return fixtureCommand(root, args, remaining);
  };
  const tests = fs.readdirSync(ownedPath(fixture.root, 'test')).filter(name => name.endsWith('.test.ts') && !fixture.files[`test/${name}`]);
  if (!tests.length) throw new Error('No permanent native regression test was added');
  for (const [relative, content] of Object.entries(fixture.files)) {
    if (relative.startsWith('test/') && fs.readFileSync(ownedPath(fixture.root, relative), 'utf8') !== content) throw new Error('Existing test was changed');
  }
  const copies: QAFunctionalFixture[] = [];
  try {
    for (const healthy of [healthyControl, healthyControl, true]) copies.push(createQAFunctionalFixture(fixture.family, { healthy, deadlineAt }));
    const [before, after, knownGood] = copies as [QAFunctionalFixture, QAFunctionalFixture, QAFunctionalFixture];
    for (const target of [before, after, knownGood]) {
      for (const name of tests) fs.copyFileSync(ownedPath(fixture.root, `test/${name}`), ownedPath(target.root, `test/${name}`));
    }
    for (const name of fs.readdirSync(ownedPath(fixture.root, 'src'))) fs.copyFileSync(ownedPath(fixture.root, `src/${name}`), ownedPath(after.root, `src/${name}`));
    const args = ['test', ...tests.map(name => `test/${name}`)];
    const red = run(before.root, args);
    const green = run(after.root, ['test']);
    const contract = run(knownGood.root, args);
    if (healthyControl ? red.exit !== 0 || !passingOutput(red.stderr) : red.exit === 0 || !failureOutput(red.stderr)) throw new Error('Regression does not distinguish the original defect');
    if (green.exit !== 0 || !passingOutput(green.stderr)) throw new Error('Regression or adjacent existing test fails with candidate repair');
    if (contract.exit !== 0 || !passingOutput(contract.stderr)) throw new Error('Invalid regression rejects the declared healthy contract');
    const commands = fixture.family === 'cli' ? [['probe.ts', 'apply', 'replay', '7junk'], ['probe.ts', 'apply', 'adjacent', '7'], ['probe.ts', 'export'], ['cancel.ts']]
      : ['happy', 'reject', 'duplicate', 'partial', 'concurrent-ab', 'concurrent-ba', 'cancel', 'dependency'].map(scenario => ['probe.ts', scenario]);
    const rechecks = commands.map(args => JSON.parse(run(after.root, args).stdout));
    if (rechecks.some(probe => qaProbeClassification(probe) !== (probe.exit === 69 ? 'setup-blocked' : 'pass'))) throw new Error('Candidate repair fails original or adjacent contract');
    return { tests, red, green, contract, rechecks };
  } finally { for (const copy of copies) copy.cleanup(); }
}

export function preserveQAArtifact(directory: string, name: string, value: unknown): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Artifact directory must not be linked');
  fs.chmodSync(directory, 0o700);
  const target = ownedPath(directory, name);
  const text = JSON.stringify(value, null, 2).replaceAll(QA_PRIVATE_SENTINEL, '<redacted synthetic private payload>');
  fs.writeFileSync(target, text + '\n', { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

export function qaCaptureArtifacts(reportRoot: string) {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    const file = ownedPath(reportRoot, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(relative, name));
      return;
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Capture artifact changed while retaining it');
      files[relative] = fs.readFileSync(fd).toString('base64');
    } finally { fs.closeSync(fd); }
  };
  visit('.qa-evidence');
  return { encoding: 'base64', files };
}
