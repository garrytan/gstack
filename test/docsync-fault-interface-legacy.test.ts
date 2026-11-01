// Split from test/docsync-fault-interface.test.ts (GSTA-151): the legacy-control callback replays.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { docsFaultCallbackScript } from './helpers/docsync-fault-callbacks';

const CALLBACK_SPLITS = [
  ['legacy controls', '^ship-docsync-failure rejects ', 12],
] as const;

for (const [split, pattern, count] of CALLBACK_SPLITS) test(`registered fault callbacks execute actual transport and hook commands, consume results, and reject controls without model calls (${split})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fault-callback-'));
  const root = path.resolve(import.meta.dir, '..');
  try {
    const script = path.join(dir, 'callbacks.test.ts');
    fs.writeFileSync(script, docsFaultCallbackScript(root));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const result = Bun.spawnSync([process.execPath, 'test', script, '--test-name-pattern', pattern], {
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '', EVALS_RUN_ID: 'free-docsync-faults',
        HOME: home, USERPROFILE: home,
        GSTACK_EVAL_DIR: path.join(dir, 'evidence'), GSTACK_HOME: path.join(dir, 'state') },
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain(`${count} pass`);
    expect(output).toContain(`${36 - count} filtered out`);
    expect(output).toContain('0 fail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
