import { expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillSections, RETRO_E2E_SECTIONS } from './helpers/skill-fixture';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-retro');

// --- Retro base branch detection smoke test ---

describeIfSelected('Base branch detection', ['retro-base-branch'], () => {
  let baseBranchDir: string;
  const run = (cmd: string, args: string[], cwd: string) =>
    spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    baseBranchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-basebranch-'));
  });

  afterAll(() => {
    try { fs.rmSync(baseBranchDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('retro-base-branch', async () => {
    const dir = path.join(baseBranchDir, 'retro-base');
    fs.mkdirSync(dir, { recursive: true });

    // Create git repo with commit history
    run('git', ['init'], dir);
    run('git', ['config', 'user.email', 'dev@example.com'], dir);
    run('git', ['config', 'user.name', 'Dev'], dir);

    fs.writeFileSync(path.join(dir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', 'app.ts'], dir);
    run('git', ['commit', '-m', 'feat: initial app', '--date', '2026-03-14T09:00:00'], dir);

    fs.writeFileSync(path.join(dir, 'auth.ts'), 'export function login() {}\n');
    run('git', ['add', 'auth.ts'], dir);
    run('git', ['commit', '-m', 'feat: add auth', '--date', '2026-03-15T10:00:00'], dir);

    fs.writeFileSync(path.join(dir, 'test.ts'), 'test("it works", () => {});\n');
    run('git', ['add', 'test.ts'], dir);
    run('git', ['commit', '-m', 'test: add tests', '--date', '2026-03-16T11:00:00'], dir);

    // Retro skill — extract the repo-scoped retro flow only (drops the shared
    // preamble + global/compare modes; CLAUDE.md: "extract, don't copy").
    fs.mkdirSync(path.join(dir, 'retro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'retro', 'SKILL.md'),
      extractSkillSections(path.join(ROOT, 'retro'), RETRO_E2E_SECTIONS),
    );

    const result = await runSkillTest({
      prompt: `Read retro/SKILL.md for instructions on how to run a retrospective.

IMPORTANT: Follow the "Detect default branch" step first. Since there is no remote, gh will fail — fall back to main.
Then use the detected branch name for all git queries.

Run /retro for the last 7 days of this git repo. Skip any AskUserQuestion calls — this is non-interactive.
This is a local-only repo so use the local branch (main) instead of origin/main for all git log commands.

Write your retrospective to ${dir}/retro-output.md`,
      workingDirectory: dir,
      maxTurns: 25,
      // 360s, not 240s: same runner-contention class as review-dashboard-via.
      // /retro is a long multi-step flow — a clean pass measured 225s and the
      // next CI run timed out at the 240s line (exitReason "timeout", 3/3
      // attempts). Outer bun timeout below rises to 480s for headroom.
      timeout: 360_000,
      testName: 'retro-base-branch',
      runId,
    });

    logCost('/retro base-branch', result);
    // The report is the work product: a run that exits max-turns without
    // writing it is a FAIL, not a pass — otherwise this test cannot detect
    // the most basic regression (the skill stops producing its report).
    const retroPath = path.join(dir, 'retro-output.md');
    const wroteReport = fs.existsSync(retroPath);
    recordE2E(evalCollector, '/retro default branch detection', 'Base branch detection', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason) && wroteReport,
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(wroteReport).toBe(true);
    const content = fs.readFileSync(retroPath, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
  }, 480_000);
});

// --- Retro E2E ---

describeIfSelected('Retro E2E', ['retro'], () => {
  let retroDir: string;

  beforeAll(() => {
    retroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-retro-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: retroDir, stdio: 'pipe', timeout: 5000 });

    // Create a git repo with varied commit history
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'dev@example.com']);
    run('git', ['config', 'user.name', 'Dev']);

    // Day 1 commits
    fs.writeFileSync(path.join(retroDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'feat: initial app setup', '--date', '2026-03-10T09:00:00']);

    fs.writeFileSync(path.join(retroDir, 'auth.ts'), 'export function login() {}\n');
    run('git', ['add', 'auth.ts']);
    run('git', ['commit', '-m', 'feat: add auth module', '--date', '2026-03-10T11:00:00']);

    // Day 2 commits
    fs.writeFileSync(path.join(retroDir, 'app.ts'), 'import { login } from "./auth";\nconsole.log("hello");\nlogin();\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'fix: wire up auth to app', '--date', '2026-03-11T10:00:00']);

    fs.writeFileSync(path.join(retroDir, 'test.ts'), 'import { test } from "bun:test";\ntest("login", () => {});\n');
    run('git', ['add', 'test.ts']);
    run('git', ['commit', '-m', 'test: add login test', '--date', '2026-03-11T14:00:00']);

    // Day 3 commits
    fs.writeFileSync(path.join(retroDir, 'api.ts'), 'export function getUsers() { return []; }\n');
    run('git', ['add', 'api.ts']);
    run('git', ['commit', '-m', 'feat: add users API endpoint', '--date', '2026-03-12T09:30:00']);

    fs.writeFileSync(path.join(retroDir, 'README.md'), '# My App\nA test application.\n');
    run('git', ['add', 'README.md']);
    run('git', ['commit', '-m', 'docs: add README', '--date', '2026-03-12T16:00:00']);

    // Retro skill — extracted repo-scoped flow, not the full 1820-line file.
    fs.mkdirSync(path.join(retroDir, 'retro'), { recursive: true });
    fs.writeFileSync(
      path.join(retroDir, 'retro', 'SKILL.md'),
      extractSkillSections(path.join(ROOT, 'retro'), RETRO_E2E_SECTIONS),
    );
  });

  afterAll(() => {
    try { fs.rmSync(retroDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('retro', async () => {
    const result = await runSkillTest({
      prompt: `Read retro/SKILL.md for instructions on how to run a retrospective.

Run /retro for the last 7 days of this git repo. Skip any AskUserQuestion calls — this is non-interactive.
Write your retrospective report to ${retroDir}/retro-output.md

Analyze the git history and produce the narrative report as described in the SKILL.md.`,
      workingDirectory: retroDir,
      maxTurns: 30,
      timeout: 300_000,
      testName: 'retro',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/retro', result);
    // Accept error_max_turns (retro does many git commands to analyze
    // history) — but only WITH the report on disk. The report is the work
    // product; max-turns with nothing written is a fail.
    const retroPath = path.join(retroDir, 'retro-output.md');
    const wroteReport = fs.existsSync(retroPath);
    recordE2E(evalCollector, '/retro', 'Retro E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason) && wroteReport,
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(wroteReport).toBe(true);
    const retro = fs.readFileSync(retroPath, 'utf-8');
    expect(retro.length).toBeGreaterThan(100);
  }, 420_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
