import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-learnings');

// --- Learnings E2E: seed learnings, run /learn, verify output ---

describeIfSelected('Learnings E2E', ['learnings-show'], () => {
  let workDir: string;
  let nstackHome: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-learnings-'));
    nstackHome = path.join(workDir, '.nstack-home');

    // Init git repo
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Copy the /learn skill
    copyDirSync(path.join(ROOT, 'learn'), path.join(workDir, 'learn'));

    // Copy bin scripts needed by /learn
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const script of ['nstack-learnings-search', 'nstack-learnings-log', 'nstack-slug']) {
      fs.copyFileSync(path.join(ROOT, 'bin', script), path.join(binDir, script));
      fs.chmodSync(path.join(binDir, script), 0o755);
    }

    // Seed learnings JSONL — slug must match what nstack-slug computes.
    // With no git remote, nstack-slug falls back to basename(workDir).
    const slug = path.basename(workDir).replace(/[^a-zA-Z0-9._-]/g, '');
    const projectDir = path.join(nstackHome, 'projects', slug);
    fs.mkdirSync(projectDir, { recursive: true });

    const learnings = [
      {
        skill: 'review', type: 'pattern', key: 'n-plus-one-queries',
        insight: 'ActiveRecord associations in loops cause N+1 queries. Always use includes/preload.',
        confidence: 9, source: 'observed', ts: new Date().toISOString(),
        files: ['app/models/user.rb'],
      },
      {
        skill: 'investigate', type: 'pitfall', key: 'stale-cache-after-deploy',
        insight: 'Redis cache not invalidated on deploy causes stale data for 5 minutes.',
        confidence: 7, source: 'observed', ts: new Date().toISOString(),
        files: ['config/redis.yml'],
      },
      {
        skill: 'ship', type: 'preference', key: 'always-run-rubocop',
        insight: 'User wants rubocop to run before every commit, no exceptions.',
        confidence: 10, source: 'user-stated', ts: new Date().toISOString(),
      },
      {
        skill: 'qa', type: 'operational', key: 'test-timeout-flag',
        insight: 'bun test requires --timeout 30000 for E2E tests in this project.',
        confidence: 9, source: 'observed', ts: new Date().toISOString(),
      },
    ];

    fs.writeFileSync(
      path.join(projectDir, 'learnings.jsonl'),
      learnings.map(l => JSON.stringify(l)).join('\n') + '\n',
    );
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    finalizeEvalCollector(evalCollector);
  });

  testConcurrentIfSelected('learnings-show', async () => {
    const result = await runSkillTest({
      prompt: `Read the file learn/SKILL.md for the /learn skill instructions.

Run the /learn command (no arguments — show recent learnings).

IMPORTANT:
- Use NSTACK_HOME="${nstackHome}" as an environment variable when running bin scripts.
- The bin scripts are at ./bin/ (relative to this directory), not at ~/.claude/skills/nstack/bin/.
  Replace any references to ~/.claude/skills/nstack/bin/ with ./bin/ when running commands.
- Replace any references to ~/.claude/skills/nstack/bin/nstack-slug with ./bin/nstack-slug.
- Do NOT use AskUserQuestion.
- Do NOT implement code changes.
- Just show the learnings and summarize what you found.`,
      workingDirectory: workDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'learnings-show',
      runId,
    });

    logCost('/learn show', result);

    const output = result.output.toLowerCase();

    // The agent should have found and displayed the seeded learnings
    const mentionsNPlusOne = output.includes('n-plus-one') || output.includes('n+1');
    const mentionsCache = output.includes('stale') || output.includes('cache');
    const mentionsRubocop = output.includes('rubocop');

    // At least 2 of 3 learnings should appear in the output
    const foundCount = [mentionsNPlusOne, mentionsCache, mentionsRubocop].filter(Boolean).length;

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, '/learn', 'Learnings show E2E', result, {
      passed: exitOk && foundCount >= 2,
    });

    expect(exitOk).toBe(true);
    expect(foundCount).toBeGreaterThanOrEqual(2);

    if (foundCount === 3) {
      console.log('All 3 seeded learnings found in output');
    } else {
      console.warn(`Only ${foundCount}/3 learnings found (N+1: ${mentionsNPlusOne}, cache: ${mentionsCache}, rubocop: ${mentionsRubocop})`);
    }
  }, 180_000);
});
