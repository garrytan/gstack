/** A native approval gate with no questions is missing coverage, not a timeout or pass. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isQuestionlessNativePlanExit, hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

// Exact caller-owned report from a native zero-question run; the Run header is
// intentional. Diagnostic failure must not depend on the positive coverage header.
const GATE = 'Exit plan mode?\n\nClaude wants to exit plan mode\n❯ 1. Yes, and switch to default (ask each time) for this session\n  2. No\n';
const REPORT = fs.readFileSync(path.join(import.meta.dir, 'fixtures/plan-count-design-questionless-report.md'), 'utf8');

test.skipIf(process.platform === 'win32')('real PTY fails promptly at an owned native exit with no recorded questions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-native-review-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const report = path.join(dir, 'plan.md');
  const inputs = path.join(dir, 'inputs.jsonl');
  const pidFile = path.join(dir, 'pid');
  const resultFile = path.join(dir, 'result.json');
  const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const stat = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat', 'utf8') : null;
fs.writeFileSync(process.env.PROBE_PID, JSON.stringify({pid:process.pid,
  startTicks:stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] : null}));
const sessionId = 'empty-native-review';
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const transcript = path.join(project, sessionId + '.jsonl');
let sent = false;
process.stdin.setRawMode?.(true);
process.stdin.on('data', data => {
  fs.appendFileSync(process.env.PROBE_INPUTS, JSON.stringify(data.toString()) + '\n');
  if (sent) return; sent = true;
  fs.writeFileSync(process.env.PROBE_PLAN, process.env.PROBE_REPORT);
  setTimeout(() => {
    fs.writeFileSync(transcript, JSON.stringify({cwd:process.cwd(), sessionId, isSidechain:false,
      timestamp:new Date().toISOString(), message:{role:'assistant', content:[
        {type:'tool_use', id:'empty-review-exit', name:'ExitPlanMode', input:{}}
      ]}}) + '\n');
    process.stdout.write('Exit plan mode?\n\nClaude wants to exit plan mode\n❯ 1. Yes, and switch to default (ask each time) for this session\n  2. No\n');
  }, 30);
});
process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(worker, `import { runPlanSkillCounting } from ${JSON.stringify(runner)};\n` +
    `if (process.env.BROWSE_TERMINAL_BINARY !== ${JSON.stringify(fake)}) throw new Error('fake CLI not selected');\n` +
    `const result = await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',followUpPrompt:'# Empty review fixture',expectedPlanPath:${JSON.stringify(report)},isLastStep0AUQ:()=>false,reviewCountCeiling:8,timeoutMs:33000,env:${JSON.stringify({PROBE_PLAN:report,PROBE_INPUTS:inputs,PROBE_PID:pidFile,PROBE_REPORT:REPORT})}});\n` +
    `await Bun.write(${JSON.stringify(resultFile)},JSON.stringify(result));\n`);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, EVALS_HERMETIC:'1', EVALS_RUN_ID:'', BROWSE_TERMINAL_BINARY:fake },
    stdout:'pipe', stderr:'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(result.outcome).toBe('no_review_questions');
    expect(result.reviewCount).toBe(0);
    expect(result.step0Count).toBe(0);
    expect(result.transcript.calls).toHaveLength(0);
    expect(result.transcript.planReadyRequests).toHaveLength(1);
    expect(fs.readFileSync(inputs,'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(['/plan-design-review\r']);
    expect(() => process.kill(JSON.parse(fs.readFileSync(pidFile,'utf8')).pid, 0)).toThrow();
  } finally {
    clearTimeout(timer); child.kill('SIGKILL');
    // An outer watchdog can outlive the worker's session cleanup. Only the
    // uniquely named fake executable may be reaped; a reused PID is not owned.
    if (fs.existsSync(pidFile)) try {
      const saved = JSON.parse(fs.readFileSync(pidFile,'utf8'));
      if (Number.isInteger(saved.pid) && saved.pid > 0) {
        let owned = false;
        if (process.platform === 'linux') {
          const stat = fs.readFileSync(`/proc/${saved.pid}/stat`, 'utf8');
          owned = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === saved.startTicks &&
            fs.readFileSync(`/proc/${saved.pid}/cmdline`, 'utf8').split('\0').includes(fake);
        } else {
          owned = execFileSync('ps', ['-p', String(saved.pid), '-o', 'command='], {encoding:'utf8',timeout:5000}).includes(fake);
        }
        if (owned) process.kill(saved.pid, 'SIGKILL');
      }
    } catch { /* the owned fake child already exited */ }
    fs.rmSync(dir, { recursive:true, force:true });
  }
}, 40000);


test('questionless exit is only a failure diagnostic with fresh report and coherent native identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'questionless-report-'));
  const report = path.join(dir, 'plan.md');
  const start = Date.now() - 10000;
  const written = start + 1000;
  const readyAt = start + 2000;
  fs.writeFileSync(report, REPORT);
  fs.utimesSync(report, written / 1000, written / 1000);
  const base: PlanCountTranscript = { status:'ready', calls:[],
    assistantMessages:[{sessionId:'owned',timestamp:new Date(readyAt).toISOString(),text:'Design report written.'}],
    planReadyRequests:[{sessionId:'owned',toolUseId:'ready',timestamp:new Date(readyAt).toISOString(),failed:false}] };
  try {
    expect(isQuestionlessNativePlanExit(base, report, start, GATE)).toBe(true);
    expect(hasNativePlanTerminal(base, report, start, 'plan_ready')).toBe(false);
    for (const screen of ['', '> Would you like to proceed?',
      '● Still validating the report. It will be ready to execute after checks.\n✻ Working…',
      'Example:\n' + GATE, '```text\n' + GATE + '```',
      GATE + '\nThinking...', GATE.replace('  2. No\n', ''),
      GATE.split('\n').map(line => '> ' + line).join('\n')]) {
      expect(isQuestionlessNativePlanExit(base, report, start, screen)).toBe(false);
    }
    for (const mutate of [
      (t: any) => { t.status = 'missing'; },
      (t: any) => { t.status = 'error'; },
      (t: any) => { t.calls = [{answered:false,failed:false}]; },
      (t: any) => { t.calls = [{answered:true,failed:false}]; },
      (t: any) => { t.planReadyRequests = []; },
      (t: any) => { t.planReadyRequests[0].failed = true; },
      (t: any) => { t.planReadyRequests[0].sessionId = ''; },
      (t: any) => { t.planReadyRequests[0].toolUseId = ''; },
      (t: any) => { t.planReadyRequests[0].sessionId = 'foreign'; },
      (t: any) => { t.planReadyRequests[0].timestamp = 'invalid'; },
      (t: any) => { t.planReadyRequests[0].timestamp = new Date(start - 1).toISOString(); },
      (t: any) => { t.planReadyRequests[0].timestamp = new Date(Date.now() + 10000).toISOString(); },
      (t: any) => { t.planReadyRequests.push({...t.planReadyRequests[0], timestamp:new Date(readyAt + 1).toISOString(),failed:true}); },
    ]) {
      const changed = structuredClone(base); mutate(changed);
      expect(isQuestionlessNativePlanExit(changed, report, start, GATE)).toBe(false);
    }
    for (const at of [start - 1, readyAt + 1]) {
      fs.utimesSync(report, at / 1000, at / 1000);
      expect(isQuestionlessNativePlanExit(base, report, start, GATE)).toBe(false);
    }
    for (const body of ['# Pending report', '```markdown\n' + REPORT + '\n```', REPORT + '\n## More work']) {
      fs.writeFileSync(report, body); fs.utimesSync(report, written / 1000, written / 1000);
      expect(isQuestionlessNativePlanExit(base, report, start, GATE)).toBe(false);
    }
    expect(isQuestionlessNativePlanExit(base, 'plan.md', start, GATE)).toBe(false);
    fs.rmSync(report);
    expect(isQuestionlessNativePlanExit(base, report, start, GATE)).toBe(false);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
