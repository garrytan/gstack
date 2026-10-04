import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertQaBrowserDeadline, assertQaBrowserPreparation, assertQaBrowserCheckpoints, qaDeadlineShellPolicy } from './helpers/qa-browser-deadline-evidence';
import capturedPreparation from './fixtures/qa-only-charter-public.json';
import capturedObservation from './fixtures/qa-only-observation-public.json';

const ROOT = path.resolve(import.meta.dir, '..');
const guard = path.join(ROOT, 'bin/gstack-qa-deadline');
const browse = process.execPath;
const directories: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(expectedBudgetMs = 30000) {
  const started = Date.now();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-gate-'));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, 'qa/sections'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'qa/sections/browser-setup.md'), path.join(directory, 'qa/sections/browser-setup.md'));
  fs.mkdirSync(path.join(directory, 'qa-reports/screenshots'), { recursive: true });
  const policy = qaDeadlineShellPolicy(directory, guard, browse);
  const calls: Array<{ tool: string; input: any; output: string }> = [];
  const invoke = (args: string[], expected = 0, timeout = 5000) => {
    const command = ['bun', guard, ...args].map(quote).join(' ');
    const result = spawnSync('bash', ['-c', command], { cwd: directory, encoding: 'utf8', timeout });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(expected);
    calls.push({ tool: 'Bash', input: { command }, output: result.stdout + result.stderr });
  };
  invoke(['start', policy.file, String(expectedBudgetMs / 1000)]);
  const run = () => invoke(['run', policy.file, '--', browse, '--version']);
  const check = (ended = Date.now()) => assertQaBrowserDeadline(calls, { directory, guard, browse, started, ended, expectedBudgetMs });
  return { directory, policy, calls, invoke, run, check, started };
}

test.each(['captured-rewrite', 'verbatim-text', 'decoded-json', 'wrapped-json', 'missing-ack', 'late-write', 'disk-mismatch', 'wrong-command', 'receipt-in-observed'])
  ('browser checkpoints bind actual public results and acknowledgments: %s', scenario => {
    const f = fixture();
    const events = JSON.parse(JSON.stringify(capturedObservation.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard).replaceAll('__QA_BROWSE__', browse));
    const baseline = events[1].message.content[0];
    const write = events[2].message.content[0];
    const note = JSON.parse(write.input.content);
    const lines = baseline.content.split('\n');
    const first = lines.findIndex((line: string) => line.startsWith('QA_DEADLINE '));
    const last = lines.findLastIndex((line: string) => line.startsWith('QA_DEADLINE '));
    if (scenario !== 'captured-rewrite') note.observed = lines.slice(first + 1, last).join('\n');
    if (scenario === 'decoded-json' || scenario === 'wrapped-json') {
      baseline.content = lines[first] + '\n{"nested":{"value":7}}\n\n' + lines[last];
      note.observed = scenario === 'decoded-json' ? { nested: { value: 7 } } : { result: { nested: { value: 7 } } };
    }
    if (scenario === 'receipt-in-observed') note.observed += lines[last];
    if (scenario === 'wrong-command') note.observationCommand = 'another command';
    write.input.content = JSON.stringify(note);
    fs.writeFileSync(write.input.file_path, scenario === 'disk-mismatch' ? '{}' : write.input.content);
    if (scenario === 'missing-ack') events.splice(3, 1);
    if (scenario === 'late-write') events.push(...events.splice(2, 2));
    const check = () => assertQaBrowserCheckpoints(events, { directory: f.directory, guard });
    if (scenario === 'verbatim-text' || scenario === 'decoded-json') expect(check).not.toThrow();
    else expect(check).toThrow();
  });

test('R70 retained public ordering has no completed report Write before its clock/baseline', () => {
  const f = fixture();
  const events = JSON.parse(JSON.stringify(capturedPreparation.events)
    .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard));
  expect(capturedPreparation.sourceEventIndices).toEqual([461, 465, 546, 550, 1041, 1045, 1965, 1969]);
  expect(events[5].message.content[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
  expect(() => assertQaBrowserPreparation(events, { directory: f.directory, guard })).toThrow('report Write must complete before guard start/baseline');
});

test.each(['early', 'failed', 'unacknowledged', 'wrong-path', 'after-start', 'delayed-ack', 'subagent',
  'crossed-parent', 'duplicate-use', 'duplicate-result', 'wrong-result-id', 'empty', 'malformed-content', 'malformed-result'])
  ('preparation credit requires an owned acknowledged nonempty Write: %s', scenario => {
    const f = fixture();
    const captured = JSON.parse(JSON.stringify(capturedPreparation.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard));
    const write = captured.at(-2), receipt = captured.at(-1);
    write.message.content[0].input.content = 'Dashboard load: observe the rendered controls and record any incomplete checks.';
    let events = [write, receipt, ...captured.slice(0, -2)];
    if (scenario === 'failed') receipt.message.content[0].is_error = true;
    if (scenario === 'unacknowledged') events.splice(1, 1);
    if (scenario === 'wrong-path') write.message.content[0].input.file_path = path.join(f.directory, 'qa-reports/other.md');
    if (scenario === 'after-start') events = [...events.slice(2, 4), write, receipt, ...events.slice(4)];
    if (scenario === 'delayed-ack') events = [write, ...events.slice(2, 4), receipt, ...events.slice(4)];
    if (scenario === 'subagent') write.parent_tool_use_id = receipt.parent_tool_use_id = 'child';
    if (scenario === 'crossed-parent') receipt.parent_tool_use_id = 'child';
    if (scenario === 'duplicate-use') events.unshift(structuredClone(write));
    if (scenario === 'duplicate-result') events.splice(2, 0, structuredClone(receipt));
    if (scenario === 'wrong-result-id') receipt.message.content[0].tool_use_id = 'unrelated';
    if (scenario === 'empty') write.message.content[0].input.content = ' \n\t';
    if (scenario === 'malformed-content') write.message.content[0].input.content = { text: 'not a Write string' };
    if (scenario === 'malformed-result') receipt.message.content[0].content = [{ type: 'image', source: { type: 'base64', data: 'not a Write receipt' } }];
    const check = () => assertQaBrowserPreparation(events, { directory: f.directory, guard });
    if (scenario === 'early') expect(check).not.toThrow();
    else expect(check).toThrow('QA preparation:');
  });

test('native literal argv, status, scripts, readiness and artifact bookkeeping are accepted', () => {
  const f = fixture();
  const start = f.calls.shift()!;
  for (const command of f.policy.allowed) f.calls.push({ tool: 'Bash', input: { command }, output: 'readiness/bookkeeping' });
  f.calls.push(start);
  f.run();
  f.invoke(['status', f.policy.file]);
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `${quote(browse)} --version | cat; printf '%s\n' 'done'`]);
  f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'qa-reports/report.md') }, output: '' });
  expect(f.check()).toEqual({ launchedRuns: 2, completedRuns: 2, refusedRuns: 0, timedOutRuns: 0 });
});

test.each(['extra-option', 'suffix-option', 'operator', 'newline', 'foreign-cwd', 'missing-cwd'])
  ('metadata exception stays exact, fixture-bound and unbatched: %s', scenario => {
    const f = fixture();
    f.run();
    const metadata = `git -C ${quote(f.directory)} rev-parse HEAD`;
    const commands = {
      'extra-option': `git -C ${quote(f.directory)} -c color.ui=false rev-parse HEAD`,
      'suffix-option': metadata + ' --git-dir',
      operator: metadata + '; ' + metadata,
      newline: metadata + '\n' + metadata,
      'foreign-cwd': `git -C ${quote(path.dirname(f.directory))} rev-parse HEAD`,
      'missing-cwd': 'git rev-parse HEAD',
    };
    f.calls.push({ tool: 'Bash', input: { command: commands[scenario as keyof typeof commands] }, output: 'metadata' });
    expect(() => f.check()).toThrow('QA deadline:');
  });

test('quoted question marks stay literal but bare glob expansion is rejected', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.directory, 'x'), 'glob target');
  f.run();
  f.invoke(['run', f.policy.file, '--', '/usr/bin/printf', '%s', '?']);
  const call = f.calls.at(-1)!;
  expect(call.output.startsWith('?')).toBe(true);
  expect(f.check().completedRuns).toBe(2);
  call.input.command = call.input.command.replace("'?'", '?');
  const expanded = spawnSync('bash', ['-c', call.input.command], { cwd: f.directory, encoding: 'utf8', timeout: 5000 });
  expect(expanded.error).toBeUndefined();
  expect(expanded.status, expanded.stderr).toBe(0);
  expect(expanded.stdout).toBe('x');
  call.output = expanded.stdout + expanded.stderr;
  expect(() => f.check()).toThrow('unsupported outer shell composition');
});

test.each(['missing', 'bare', 'wrong-guard', 'direct-shebang', 'wrong-runtime', 'outer-tail', 'outer-newline', 'substitution', 'prefix', 'redirect', 'status-only', 'no-browser'])
  ('fails closed for absent/unsupported guard coverage: %s', scenario => {
    const f = fixture();
    f.run();
    const call = f.calls[1];
    if (scenario === 'missing') f.calls.length = 0;
    if (scenario === 'bare') call.input.command = `${quote(browse)} --version`;
    if (scenario === 'wrong-guard') call.input.command = call.input.command.replace(guard, '/tmp/gstack-qa-deadline');
    if (scenario === 'direct-shebang') call.input.command = call.input.command.slice("'bun' ".length);
    if (scenario === 'wrong-runtime') call.input.command = call.input.command.replace("'bun'", "'/tmp/bun'");
    if (scenario === 'outer-tail') call.input.command += `; ${quote(browse)} --version`;
    if (scenario === 'outer-newline') call.input.command += `\n${quote(browse)} --version`;
    if (scenario === 'substitution') call.input.command += ' "$(echo unguarded)"';
    if (scenario === 'prefix') call.input.command = 'true; ' + call.input.command;
    if (scenario === 'redirect') call.input.command += ' 2>/dev/null';
    if (scenario === 'status-only') { f.calls.pop(); f.invoke(['status', f.policy.file]); }
    if (scenario === 'no-browser') { f.calls.pop(); f.invoke(['run', f.policy.file, '--', '/bin/true']); }
    expect(() => f.check()).toThrow('QA deadline:');
  });

test.each(['missing-finish', 'forged-start', 'forged-finish', 'duplicate', 'late-launch', 'early-refusal', 'state-reset', 'state-rewrite', 'wrong-budget', 'state-write', 'state-link', 'artifact-link', 'source-write'])
  ('rejects unauthenticated or inconsistent evidence: %s', scenario => {
    const f = fixture();
    f.run();
    const receipts = f.calls[1].output.split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(line => JSON.parse(line.slice(12)));
    const state = JSON.parse(fs.readFileSync(f.policy.file, 'utf8'));
    let ended = Date.now();
    if (scenario === 'missing-finish') receipts.pop();
    if (scenario === 'forged-start') receipts[0].budgetMs = 90000;
    if (scenario === 'forged-finish') receipts[1].deadlineAt = new Date(Date.parse(state.deadlineAt) + 30000).toISOString();
    if (scenario === 'duplicate') receipts.push(receipts[1]);
    if (scenario === 'late-launch') {
      receipts[0].observedAt = state.deadlineAt; receipts[0].remainingMs = 0; receipts[0].expired = true;
      ended = Date.parse(state.deadlineAt) + 1000;
    }
    if (scenario === 'early-refusal') { receipts[0].event = 'expired'; receipts.pop(); }
    f.calls[1].output = receipts.map(receipt => 'QA_DEADLINE ' + JSON.stringify(receipt)).join('\n');
    if (scenario === 'state-reset') {
      fs.unlinkSync(f.policy.file);
      f.invoke(['start', f.policy.file, '30']);
    }
    if (scenario === 'state-rewrite') {
      fs.chmodSync(f.policy.file, 0o600);
      fs.writeFileSync(f.policy.file, JSON.stringify(state) + '\n');
      fs.chmodSync(f.policy.file, 0o400);
    }
    if (scenario === 'wrong-budget') {
      fs.unlinkSync(f.policy.file);
      f.calls.length = 0;
      f.invoke(['start', f.policy.file, '90']);
      f.run();
    }
    if (scenario === 'state-write') f.calls.push({ tool: 'Write', input: { file_path: f.policy.file }, output: '' });
    if (scenario === 'state-link') { fs.renameSync(f.policy.file, f.policy.file + '.real'); fs.symlinkSync(f.policy.file + '.real', f.policy.file); }
    if (scenario === 'artifact-link') {
      fs.symlinkSync(path.join(f.directory, 'qa'), path.join(f.directory, 'qa-reports/linked'));
      f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'qa-reports/linked/source.md') }, output: '' });
    }
    if (scenario === 'source-write') f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'source.ts') }, output: '' });
    expect(() => f.check(ended)).toThrow();
  });

test('child-emitted receipt forgery and direct state reset scripts are rejected', () => {
  const f = fixture();
  f.run();
  const output = f.calls[1].output;
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `printf '%s\n' ${quote(output)}; ${quote(browse)} --version`]);
  expect(() => f.check()).toThrow('reserved deadline evidence');
  f.calls.pop();
  f.calls.push({ tool: 'Bash', input: { command: ['bun', guard, 'run', f.policy.file, '--', 'bash', '-c', `rm ${quote(f.policy.file)}`].map(quote).join(' ') }, output });
  expect(() => f.check()).toThrow('reserved deadline evidence');
});

test('short fixture deadlines require an explicit contract; the native default remains exactly 30s', () => {
  const native = fixture();
  native.run();
  expect(assertQaBrowserDeadline(native.calls, { directory: native.directory, guard, browse,
    started: native.started, ended: Date.now() })).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
  const f = fixture(500);
  f.run();
  expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
  expect(() => assertQaBrowserDeadline(f.calls, { directory: f.directory, guard, browse,
    started: f.started, ended: Date.now() })).toThrow('expected 30000ms deadline');
  for (const expectedBudgetMs of [0, -1, 0.5, 2_147_483_648, NaN, Infinity]) {
    expect(() => assertQaBrowserDeadline(f.calls, { directory: f.directory, guard, browse,
      started: f.started, ended: Date.now(), expectedBudgetMs })).toThrow('invalid expected deadline budget');
  }
  f.calls[0].input.command = f.calls[0].input.command.replace("'0.5'", "'30'");
  expect(() => f.check()).toThrow('missing or repeated native start');
});

test('native timeout and subsequent refusal get no completed-run credit; bare late work still fails', async () => {
  const f = fixture(500);
  const pidFile = path.join(f.directory, 'child.pid');
  const lateMarker = path.join(f.directory, 'late-work');
  const refusalMarker = path.join(f.directory, 'refused-work');
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `printf '%s' "$$" > ${quote(pidFile)}; sleep 2; ${quote(browse)} --version > ${quote(lateMarker)}`], 124);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  const reapedBy = performance.now() + 500;
  let reaped = false;
  while (performance.now() < reapedBy) {
    try { process.kill(pid, 0); }
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      reaped = true;
      break;
    }
    await Bun.sleep(10);
  }
  expect(reaped).toBe(true);
  expect(fs.existsSync(lateMarker)).toBe(false);
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `touch ${quote(refusalMarker)}; ${quote(browse)} --version`], 124);
  expect(fs.existsSync(refusalMarker)).toBe(false);
  expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 0, refusedRuns: 1, timedOutRuns: 1 });
  f.calls.push({ tool: 'Bash', input: { command: `${quote(browse)} --version` }, output: 'late bare work' });
  expect(() => f.check()).toThrow('unguarded');
});

test.each([
  `B="/workspace/gstack/browse/dist/browse"\n$B js "(async () => { const links = [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href))].filter(h => new URL(h).origin === location.origin && !/logout|signout|delete|remove|cancel|unsubscribe/i.test(h)); const out = []; for (const l of links) { const r = await fetch(l, { method: 'HEAD' }).catch(e => ({ status: 'ERR ' + e.message })); out.push('LINK ' + r.status + ' ' + l); } return out.join('\\n'); })()" 2>&1\necho "=== ALL HREFS ==="; $B links 2>&1`,
  `echo "CLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)"\nB="/workspace/gstack/browse/dist/browse"\ntimeout 20 $B js "(async()=>{const links=[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href))].filter(h=>new URL(h).origin===location.origin&&!/logout|signout|delete|remove|cancel|unsubscribe/i.test(h));const out=[];for(const l of links){const r=await fetch(l,{method:'HEAD'}).catch(e=>({status:'ERR '+e.message}));out.push('LINK '+r.status+' '+l);}const imgs=[...document.images].map(i=>'IMG '+(i.complete&&i.naturalWidth>0?'ok':'broken')+' '+i.src);return out.concat(imgs).join('\\\\n');})()" 2>&1\necho "CLOCK_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
])('R65/R66 public late-link commands fail even after genuine guarded work: %#', command => {
  const f = fixture();
  f.run();
  f.calls.push({ tool: 'Bash', input: { command }, output: 'CLOCK=2026-09-27T14:33:12Z' });
  expect(() => f.check()).toThrow('QA deadline:');
});
