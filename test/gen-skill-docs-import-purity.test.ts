/**
 * Importing scripts/gen-skill-docs.ts must not touch the tree.
 *
 * Before the main() guard, the generator's whole body executed at module
 * load: any `import`/`require` of it (test/gen-skill-docs.test.ts pulls
 * assertSinglePreamble; test/catalog-trim.test.ts imports helpers)
 * regenerated all 71 SKILL.md in place — the root cause of half the
 * TREE_MUTATING serial-shard entries (hazard class #2532). A regression
 * here silently re-poisons parallel shards with mid-window tree rewrites.
 *
 * The probe runs in a subprocess so a regression can't contaminate THIS
 * process, and asserts on mtimes rather than git status — the working tree
 * may legitimately carry uncommitted SKILL.md edits while this runs; what
 * must not happen is the import WRITING files.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

describe('gen-skill-docs import purity', () => {
  test('importing the module neither writes SKILL.md nor runs main()', () => {
    const probe = `
      const fs = require('node:fs');
      const path = require('node:path');
      const ROOT = ${JSON.stringify(ROOT)};
      const targets = [
        path.join(ROOT, 'ship', 'SKILL.md'),
        path.join(ROOT, 'review', 'SKILL.md'),
        path.join(ROOT, 'gstack', 'llms.txt'),
      ].filter((p) => fs.existsSync(p));
      if (targets.length === 0) throw new Error('probe rot: no generated targets found');
      const before = targets.map((p) => fs.statSync(p).mtimeMs);
      const mod = require(path.join(ROOT, 'scripts', 'gen-skill-docs.ts'));
      if (typeof mod.main !== 'function') throw new Error('main() export missing');
      const after = targets.map((p) => fs.statSync(p).mtimeMs);
      for (let i = 0; i < targets.length; i++) {
        if (before[i] !== after[i]) throw new Error('import mutated ' + targets[i]);
      }
      console.log('IMPORT_PURE');
    `;
    const out = Bun.spawnSync(['bun', '-e', probe], { cwd: ROOT, timeout: 120_000 });
    const stdout = out.stdout.toString();
    const stderr = out.stderr.toString();
    expect(stderr, stderr).not.toContain('import mutated');
    expect(stdout).toContain('IMPORT_PURE');
    // The import must also not have run generation output (the "GENERATED:"
    // lines main() prints) — load-time execution is the exact regression.
    expect(stdout).not.toContain('GENERATED:');
    expect(out.exitCode).toBe(0);
  });
});
