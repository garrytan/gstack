/**
 * #2329: Bun on Windows throws EEXIST from mkdirSync(dir, { recursive: true })
 * when dir already exists, so a second `gen:skill-docs` (or llms.txt write)
 * crashed. Both generators now use lib/fs-utils' mkdirpSync. Emulated on every
 * platform with the same --preload fixture as test/fs-utils.test.ts (#2635).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PRELOAD = path.join(import.meta.dir, 'helpers', 'emulate-bun-windows-eexist.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gen-eexist-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bun = (...args: string[]) => spawnSync(process.execPath, ['--preload', PRELOAD, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

describe('#2329: generators tolerate existing output directories under Windows EEXIST semantics', () => {
  test('gen-skill-docs renders twice into the same out-dir', () => {
    const out = path.join(tmp, 'render');
    for (let run = 1; run <= 2; run++) {
      const r = bun('scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', out);
      expect(`run ${run}: exit ${r.status}`, r.stderr).toBe(`run ${run}: exit 0`);
      expect(r.stderr).not.toContain('EEXIST');
    }
    expect(fs.existsSync(path.join(out, '.agents', 'skills', 'gstack-review', 'SKILL.md'))).toBe(true);
  });

  test('writeLlmsTxt writes into an existing directory', () => {
    const target = path.join(tmp, 'llms', 'llms.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = bun('-e', `const { writeLlmsTxt } = await import(${JSON.stringify(path.join(ROOT, 'scripts/gen-llms-txt.ts'))}); await writeLlmsTxt({ outputPath: ${JSON.stringify(target)} });`);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('gstack');
  });
});
