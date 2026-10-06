/**
 * Design model smoke (E5, periodic): runs design/scripts/live-model-check.ts,
 * which sends the design binary's real request bodies with the DEFAULT
 * models (overrides are ignored), so a retired or unentitled default fails
 * here before users hit it. Without OPENAI_API_KEY the case is a Bun skip:
 * the report lists it as SKIPPED with zero coverage credit, never a pass.
 * With a key, exit 0 passes; exit 2 (the script saw no key) and every other
 * exit fail with the script's output attached.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { e2eTierEnabled } from './helpers/e2e-gate';

const ROOT = path.resolve(import.meta.dir, '..');
const CASE = 'design-model-smoke';
const KEY_PRESENT = !!process.env.OPENAI_API_KEY?.trim();
const CHECK_MS = 400_000;
if (e2eTierEnabled('periodic') && !KEY_PRESENT) {
  process.stderr.write(`\n${CASE}: SKIPPED: OPENAI_API_KEY is not set; the design model defaults were not checked (no coverage)\n`);
}

describe.skipIf(!e2eTierEnabled('periodic') || !KEY_PRESENT)('design live model defaults (E5)', () => {
  test(CASE, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'design-model-smoke-'));
    try {
      const run = spawnSync(process.execPath, ['run', 'design/scripts/live-model-check.ts'], {
        cwd: ROOT, encoding: 'utf8', timeout: CHECK_MS,
        env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
      });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
      console.log(output);
      if (run.status === 2) throw new Error(`live-model-check saw no OPENAI_API_KEY although the test had one; nothing was checked:\n${output}`);
      expect(run.status, output).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, CHECK_MS + 10_000);
});
