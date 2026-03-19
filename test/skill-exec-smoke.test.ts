import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSkillTest } from './helpers/session-runner';

const evalsEnabled = !!process.env.EVALS;
const describeExec = evalsEnabled ? describe : describe.skip;

describeExec('Codex exec smoke', () => {
  test('session runner can execute a simple Codex turn', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-exec-smoke-'));

    try {
      const result = await runSkillTest({
        prompt: 'Run one shell command that prints the current working directory, then answer with one short sentence.',
        workingDirectory: workdir,
        timeout: 90_000,
        testName: 'exec-smoke',
      });

      expect(result.exitReason).toBe('success');
      expect(result.toolCalls.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }, 120_000);
});
