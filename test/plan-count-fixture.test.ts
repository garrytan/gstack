/** Free behavioral coverage for the isolated, preloaded plan-count workspace. */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanCountFixture } from './helpers/plan-count-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const PROMPT = '# Seeded settings plan\n\nReview each issue separately.\n' +
  'Literal text: "quotes" \'single quotes\' `touch never` $(touch never)\n';

function gitRoot(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return fs.realpathSync(result.stdout.trim());
}

describe('plan-count fixtures', () => {
  test('preloads the literal plan and initial context in a separate git repository', () => {
    const fixture = createPlanCountFixture(PROMPT);
    try {
      expect(fs.realpathSync(fixture.cwd)).not.toBe(fs.realpathSync(ROOT));
      expect(gitRoot(fixture.cwd)).toBe(fs.realpathSync(fixture.cwd));
      expect(fs.readFileSync(path.join(fixture.cwd, 'PLAN.md'), 'utf8')).toBe(PROMPT);
      const context = fs.readFileSync(path.join(fixture.cwd, 'CLAUDE.md'), 'utf8');
      expect(context).toContain('PLAN.md');
      expect(context).toContain(PROMPT);
      expect(fs.existsSync(path.join(fixture.cwd, 'DESIGN.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'TODOS.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'never'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.cwd)).toBe(false);
  });

  test('concurrent fixtures have independent content and cleanup owns only its directory', () => {
    const first = createPlanCountFixture('first plan');
    const second = createPlanCountFixture('second plan');
    try {
      expect(first.cwd).not.toBe(second.cwd);
      first.cleanup();
      first.cleanup();
      expect(fs.existsSync(first.cwd)).toBe(false);
      expect(fs.readFileSync(path.join(second.cwd, 'PLAN.md'), 'utf8')).toBe('second plan');
      expect(gitRoot(second.cwd)).toBe(fs.realpathSync(second.cwd));
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(second.cwd)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('cleans the fixture when the PTY executable cannot launch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-launch-failure-'));
    const fixtureTmp = path.join(dir, 'fixtures');
    const workerPath = path.join(dir, 'worker.ts');
    const brokenCli = path.join(dir, 'not-executable');
    fs.mkdirSync(fixtureTmp);
    fs.writeFileSync(brokenCli, 'This file deliberately has no executable permission.', { mode: 0o644 });
    const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(workerPath, `
import { runPlanSkillCounting } from ${JSON.stringify(runnerUrl)};
try {
  await runPlanSkillCounting({
    skillName: 'plan-design-review', slashCommand: '/plan-design-review',
    followUpPrompt: 'Review this launch-failure fixture.',
    isLastStep0AUQ: () => false, reviewCountCeiling: 8,
  });
  process.exitCode = 1;
} catch (error) {
  process.stdout.write('launch failed as expected');
}
`);
    try {
      const result = spawnSync(process.execPath, [workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: brokenCli, EVALS_HERMETIC: '1', TMPDIR: fixtureTmp },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('launch failed as expected');
      expect(fs.readdirSync(fixtureTmp)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  // Bun's real PTY spawn and executable shebangs are POSIX-only. The direct
  // fixture tests above still exercise repository setup/cleanup on Windows.
  test.skipIf(process.platform === 'win32')(
    'real PTY children see preloaded isolated plans, shipped skills, and only the bare slash command',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-subprocess-'));
      const fakePath = path.join(dir, 'fake-claude');
      const workerPath = path.join(dir, 'worker.ts');
      const resultPath = path.join(dir, 'result.json');
      const cases = [
        { name: 'design', skillName: 'plan-design-review', prompt: PROMPT, mode: 'complete' },
        { name: 'ceo', skillName: 'plan-ceo-review', prompt: '# Independent CEO plan\nUnique product context.', mode: 'complete' },
        { name: 'exited', skillName: 'plan-eng-review', prompt: '# Early-exit plan\nStill clean up.', mode: 'exit' },
      ].map((item) => ({ ...item, record: path.join(dir, `${item.name}.jsonl`) }));

      // The fake snapshots its environment BEFORE installing the first stdin
      // handler. It never dispatches a model or invokes the real Claude CLI.
      fs.writeFileSync(fakePath, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const record = (event) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(event) + '\n');
const skillDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', process.env.FIXTURE_SKILL);
const planPath = path.join(process.cwd(), 'PLAN.md');
const contextPath = path.join(process.cwd(), 'CLAUDE.md');
record({
  type: 'startup', pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2),
  gitRoot: spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim(),
  plan: fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : null,
  context: fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : null,
  inheritedDesign: fs.existsSync('DESIGN.md'), inheritedTodos: fs.existsSync('TODOS.md'),
  skill: fs.existsSync(path.join(skillDir, 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') : null,
  sections: fs.existsSync(path.join(skillDir, 'sections', 'review-sections.md'))
    ? fs.readFileSync(path.join(skillDir, 'sections', 'review-sections.md'), 'utf8') : null,
});
if (process.env.FIXTURE_MODE === 'exit') process.stdout.write('\x1b[?25lSTARTUP_DIAGNOSTIC fixture CLI booted\x1b[?25h\n');
process.stdin.setRawMode?.(true);
let firstInput = true;
let completion;
process.stdin.on('data', (data) => {
  record({ type: 'input', data: data.toString('utf8') });
  if (!firstInput) return;
  firstInput = false;
  if (process.env.FIXTURE_MODE === 'exit') process.exit(7);
  // Longer than the old 3 s delayed fixture send: record that regression
  // even if the helper would otherwise return on our completion marker.
  completion = setTimeout(() => process.stdout.write('\nGSTACK REVIEW REPORT\n'), 4100);
});
process.on('SIGINT', () => {
  clearTimeout(completion);
  record({ type: 'closed', at: Date.now() });
  process.exit(0);
});
process.stdin.resume();
`);
      fs.chmodSync(fakePath, 0o755);
      const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
      fs.writeFileSync(workerPath, `
import { runPlanSkillCounting } from ${JSON.stringify(runnerUrl)};
const cases = ${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async (item) => ({
  name: item.name,
  observation: await runPlanSkillCounting({
    skillName: item.skillName,
    slashCommand: '/' + item.skillName,
    followUpPrompt: item.prompt,
    isLastStep0AUQ: () => false,
    reviewCountCeiling: 8,
    timeoutMs: 15000,
    env: { FIXTURE_RECORD: item.record, FIXTURE_SKILL: item.skillName, FIXTURE_MODE: item.mode },
  }),
})));
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(results));
`);

      const startedAt = Date.now();
      const child = Bun.spawn([process.execPath, workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: fakePath, EVALS_HERMETIC: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 35_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stdout + stderr).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(35_000);
        const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const cwds = new Set<string>();
        for (const item of cases) {
          const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          const startup = events[0];
          expect(startup.type).toBe('startup');
          expect(startup.cwd).not.toBe(ROOT);
          expect(startup.gitRoot).toBe(startup.cwd);
          expect(startup.plan).toBe(item.prompt);
          expect(startup.context).toContain('PLAN.md');
          expect(startup.context).toContain(item.prompt);
          expect(startup.argv[startup.argv.indexOf('--permission-mode') + 1]).toBe('plan');
          expect(startup.inheritedDesign).toBe(false);
          expect(startup.inheritedTodos).toBe(false);
          expect(startup.skill).toContain(`name: ${item.skillName}`);
          expect(startup.sections).toBe(fs.readFileSync(path.join(ROOT, item.skillName, 'sections/review-sections.md'), 'utf8'));
          expect(events.filter((event) => event.type === 'input').map((event) => event.data).join(''))
            .toBe(`/${item.skillName}\r`);
          expect(fs.existsSync(startup.cwd)).toBe(false);
          expect(() => process.kill(startup.pid, 0)).toThrow();
          const result = results.find((result) => result.name === item.name);
          expect(result.observation.outcome).toBe(item.mode === 'exit' ? 'exited' : 'completion_summary');
          if (item.mode === 'exit') {
            expect(result.observation.evidence).toContain('exitCode=7');
            expect(result.observation.evidence).toContain('STARTUP_DIAGNOSTIC fixture CLI booted');
            expect(result.observation.evidence).not.toContain('\x1b');
          }
          if (item.mode === 'complete') expect(events.at(-1).type).toBe('closed');
          cwds.add(startup.cwd);
        }
        expect(cwds.size).toBe(cases.length);
      } finally {
        clearTimeout(killer);
        child.kill('SIGKILL');
        // A failed worker assertion must not leave its PTY fakes running.
        for (const item of cases) {
          if (!fs.existsSync(item.record)) continue;
          const startup = JSON.parse(fs.readFileSync(item.record, 'utf8').split('\n')[0]);
          try { process.kill(startup.pid, 'SIGKILL'); } catch { /* already reaped */ }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
