/**
 * P4 first-run scaffold — E2E (periodic tier, ~$0.02 each, deterministic).
 *
 * Exercises bin/gstack-first-task-detect END-TO-END through the real runner +
 * hermetic env (path resolution, execution, git-in-cwd), not just the unit
 * harness. Deterministic by construction: it asserts the binary's enum token
 * from the Bash tool_result in the stream-json transcript (never the model's
 * prose), so it pins the detector's integration contract without depending on
 * non-deterministic model phrasing.
 *
 * Periodic (not gate): onboarding behavior is non-safety, and the scaffold
 * marker is model-touched (best-effort). The deterministic bucket logic itself
 * is fully covered by the unit test (test/preamble-first-task-scaffold.test.ts).
 */

import { expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'node:child_process';
import { runSkillTest } from './helpers/session-runner';
import {
  describeIfSelected, testIfSelected, createEvalCollector, finalizeEvalCollector,
  recordE2E, runId, logCost,
} from './helpers/e2e-helpers';

const ROOT = path.join(import.meta.dir, '..');
const DETECT = path.join(ROOT, 'bin', 'gstack-first-task-detect');
const evalCollector = createEvalCollector('e2e-first-task-scaffold');
const MODEL = 'claude-haiku-4-5-20251001';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
};

/** Concatenated Bash tool_result text from the stream-json transcript. */
function toolResultText(transcript: any[]): string {
  const chunks: string[] = [];
  for (const event of transcript) {
    if (event.type !== 'user') continue;
    for (const item of event.message?.content ?? []) {
      if (item.type !== 'tool_result') continue;
      if (typeof item.content === 'string') chunks.push(item.content);
      else for (const c of item.content ?? []) if (c.type === 'text') chunks.push(c.text);
    }
  }
  return chunks.join('\n');
}

async function detectVia(workDir: string, testName: string): Promise<string> {
  const result = await runSkillTest({
    prompt: `Run exactly this one bash command and then stop, printing its output verbatim: ${DETECT}`,
    workingDirectory: workDir,
    maxTurns: 3,
    allowedTools: ['Bash'],
    timeout: 120_000,
    testName,
    runId,
    model: MODEL,
  });
  logCost(testName, result);
  recordE2E(evalCollector, testName, 'e2e-first-task-scaffold', result);
  expect(result.exitReason).toBe('success');
  return toolResultText(result.transcript);
}

describeIfSelected('first-run scaffold detection (E2E)', ['first-task-scaffold'], () => {
  testIfSelected('first-task-scaffold', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('first-task-scaffold requires ANTHROPIC_API_KEY (source ~/.zshrc); refusing to skip');
    }

    // code_node bucket: package.json + a commit, on the default branch.
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-node-'));
    // greenfield bucket: git repo, zero commits.
    const greenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-green-'));
    try {
      execSync('git init -q -b main', { cwd: nodeDir, env: GIT_ENV });
      fs.writeFileSync(path.join(nodeDir, 'package.json'), '{"name":"x"}');
      execSync('git add -A && git commit -qm init', { cwd: nodeDir, env: GIT_ENV });
      execSync('git init -q -b main', { cwd: greenDir, env: GIT_ENV });

      const nodeOut = await detectVia(nodeDir, 'first-task-scaffold');
      expect(nodeOut).toContain('code_node');

      const greenOut = await detectVia(greenDir, 'first-task-scaffold-greenfield');
      expect(greenOut).toContain('greenfield');
    } finally {
      fs.rmSync(nodeDir, { recursive: true, force: true });
      fs.rmSync(greenDir, { recursive: true, force: true });
    }
  }, 300_000);
});

afterAll(() => finalizeEvalCollector(evalCollector));
