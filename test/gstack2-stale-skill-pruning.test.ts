import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ARCHITECTURE.md infrastructure row 7: "Removed/renamed generated skills are
// not pruned." The generator's mitigation is that regeneration removes each
// reference/asset tree, the compatibility tree, and the parity corpus before
// writing the fixed six dispatchers. This fixture proves that mitigation: a
// stale skill directory/file planted anywhere the generator claims to prune
// must NOT survive a regeneration. Each planted path maps to a distinct
// `fs.rmSync` in scripts/gstack2/generate-skill-tree.ts::main; drop any one of
// them and the matching assertion below fails.

const ROOT = join(import.meta.dir, '..');
const GENERATOR = join(ROOT, 'scripts', 'gstack2', 'generate-skill-tree.ts');

// Distinctive prefix: never collides with a real source and sorts last.
const STALE = 'zzzz-stale-pruning-fixture';

// Each entry is a stale artifact left over from a removed/renamed skill,
// planted inside a generated tree location the generator prunes-then-rewrites.
const STALE_DIR = join(ROOT, 'skills', 'plan', 'references', `${STALE}-dir`);
const PLANTED = [
  join(ROOT, 'skills', 'plan', 'references', 'legacy', `${STALE}.md`), // stale reference module
  join(STALE_DIR, 'nested.md'), // stale nested public directory (recursive prune)
  join(ROOT, 'skills', 'design', 'assets', `${STALE}.js`), // stale relocated asset
  join(ROOT, 'compat', `${STALE}.md`), // stale compatibility alias
  join(ROOT, 'evals', 'parity', 'contracts', `${STALE}.json`), // stale parity-corpus entry
];

afterAll(() => {
  // Belt-and-suspenders: if pruning is broken the planted files survive; remove
  // them so a failing run does not leave junk in the working tree. Only touches
  // the planted artifacts, never the real generated parent directories.
  for (const target of PLANTED) rmSync(target, { force: true });
  rmSync(STALE_DIR, { recursive: true, force: true });
});

describe('GStack 2 stale-public-directory pruning (ARCHITECTURE row 7)', () => {
  test('regeneration prunes stale skill artifacts from the generated tree', () => {
    for (const target of PLANTED) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'stale artifact from a removed or renamed skill; must not survive regeneration\n');
      expect(existsSync(target)).toBe(true);
    }

    const result = Bun.spawnSync({
      cmd: ['bun', 'run', GENERATOR],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    for (const target of PLANTED) {
      expect(existsSync(target), `stale artifact survived regeneration: ${target}`).toBe(false);
    }
  }, 30_000);
});
