/**
 * Live behavioral coverage for the generated root gstack router.
 *
 * These tests invoke the real registered root through Claude's Skill tool.
 * They verify routing behavior from the tool transcript instead of asking a
 * judge to restate an excerpt of the prompt. Periodic tier: each case is a
 * paid live-agent session.
 */

import { afterAll, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runSkillTest, type SkillTestResult } from './helpers/session-runner';
import { hermeticSkillsConfigDir } from './helpers/hermetic-env';
import {
  createEvalCollector,
  describeIfSelected,
  finalizeEvalCollector,
  logCost,
  recordE2E,
  runId,
  testIfSelected,
} from './helpers/e2e-helpers';

const TESTS = [
  'root-guided-headless',
  'root-guided-interactive-history-failure',
  'root-guided-delegated-choice',
  'root-guided-named-subskill',
];
const evalCollector = createEvalCollector('e2e-root-guided-entry');

function setupWorkdir(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gstack-root-e2e-${suffix}-`));
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 5_000 });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'fixture']);
  return dir;
}

function skillCalls(result: SkillTestResult): string[] {
  return result.toolCalls
    .filter((call) => call.tool === 'Skill')
    .map((call) => String(call.input?.skill ?? ''))
    .filter(Boolean);
}

function bashInputs(result: SkillTestResult): string[] {
  return result.toolCalls
    .filter((call) => call.tool === 'Bash')
    .map((call) => String(call.input?.command ?? ''));
}

function surface(result: SkillTestResult): string {
  return [
    result.output,
    ...result.toolCalls.flatMap((call) => [JSON.stringify(call.input ?? {}), call.output ?? '']),
    ...result.transcript.map((entry) => JSON.stringify(entry)),
  ].join('\n');
}

function isRoot(skill: string): boolean {
  return skill === '_gstack-command' || skill === 'gstack';
}

function isLeaf(skill: string): boolean {
  return !!skill && !isRoot(skill);
}

async function runCase(
  testName: string,
  prompt: string,
  opts: { headless?: boolean; home?: string } = {},
): Promise<{ result: SkillTestResult; workDir: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(`${testName} requires ANTHROPIC_API_KEY; refusing to replace a live behavior test with a prompt judge`);
  }
  const workDir = setupWorkdir(testName);
  const result = await runSkillTest({
    prompt,
    workingDirectory: workDir,
    env: {
      CLAUDE_CONFIG_DIR: hermeticSkillsConfigDir(),
      GSTACK_HEADLESS: opts.headless === false ? '' : '1',
      ...(opts.home ? { HOME: opts.home } : {}),
    },
    maxTurns: 10,
    allowedTools: ['Skill', 'Bash'],
    timeout: 180_000,
    testName,
    runId,
  });
  logCost(testName, result);
  return { result, workDir };
}

describeIfSelected('root guided entry (live Skill behavior)', TESTS, () => {
  afterAll(() => { finalizeEvalCollector(evalCollector); });

  testIfSelected('root-guided-headless', async () => {
    const { result, workDir } = await runCase(
      'root-guided-headless',
      'First invoke the `_gstack-command` root through the Skill tool for this request: "How can we improve onboarding?" Do not choose a workflow for me.',
    );
    try {
      const calls = skillCalls(result);
      const output = surface(result);
      const searchedHistory = bashInputs(result).some((command) => command.includes('gstack-decision-search'));
      const passed = calls.some(isRoot)
        && !calls.some(isLeaf)
        && !searchedHistory
        && /recommend|choose|which|confirm/i.test(output)
        && /\/(office-hours|plan-ceo-review|design-consultation|review|investigate|qa)\b/.test(output);
      recordE2E(evalCollector, 'root-guided-headless', 'e2e-root-guided-entry', result, { passed });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 240_000);

  testIfSelected('root-guided-interactive-history-failure', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-failed-memory-'));
    const binDir = path.join(fakeHome, '.claude', 'skills', 'gstack', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const search = path.join(binDir, 'gstack-decision-search');
    fs.writeFileSync(search, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const { result, workDir } = await runCase(
      'root-guided-interactive-history-failure',
      'First invoke the `_gstack-command` root through the Skill tool for this request: "How can we improve onboarding?" Memory lookup may fail; still help me choose and do not select for me.',
      { headless: false, home: fakeHome },
    );
    try {
      const calls = skillCalls(result);
      const output = surface(result);
      const historyCommand = bashInputs(result).find((command) => command.includes('gstack-decision-search')) ?? '';
      const passed = calls.some(isRoot)
        && !calls.some(isLeaf)
        && historyCommand.includes('--tokens')
        && historyCommand.includes('--recent 3')
        && historyCommand.includes('--no-rebuild')
        && historyCommand.includes('--semantic')
        && /recommend|choose|which|confirm/i.test(output);
      recordE2E(evalCollector, 'root-guided-interactive-history-failure', 'e2e-root-guided-entry', result, { passed });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 240_000);

  testIfSelected('root-guided-delegated-choice', async () => {
    const { result, workDir } = await runCase(
      'root-guided-delegated-choice',
      'First invoke the `_gstack-command` root through the Skill tool. Request: "Review my code changes before launch; choose the best gstack workflow for me and skip the menu."',
    );
    try {
      const calls = skillCalls(result);
      const passed = calls.some(isRoot) && calls.some(isLeaf);
      recordE2E(evalCollector, 'root-guided-delegated-choice', 'e2e-root-guided-entry', result, { passed });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 240_000);

  testIfSelected('root-guided-named-subskill', async () => {
    const { result, workDir } = await runCase(
      'root-guided-named-subskill',
      'First invoke the `_gstack-command` root through the Skill tool. The user explicitly requested gstack-ship. Follow the named-subskill bypass.',
    );
    try {
      const calls = skillCalls(result);
      const namedLeaf = calls.some((skill) => skill === 'ship' || skill === 'gstack-ship');
      const passed = calls.some(isRoot) && namedLeaf;
      recordE2E(evalCollector, 'root-guided-named-subskill', 'e2e-root-guided-entry', result, { passed });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 240_000);
});
