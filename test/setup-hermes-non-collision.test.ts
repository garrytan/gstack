import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: Hermes non-collision with existing files', () => {
  test('setup does not contain rm -rf of HERMES_GSTACK when it is a real directory', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

    // The bug was: the elif branch did `rm -rf "$HERMES_GSTACK"` on every real
    // directory that wasn't the gen dir. The fix removes that branch so only
    // symlinked roots are unlinked.
    const hermesBlock = content.indexOf('Install for Hermes Agent');
    expect(hermesBlock).toBeGreaterThan(-1);

    const nextBlock = content.indexOf('# 7.', hermesBlock);
    const block = content.slice(hermesBlock, nextBlock);

    // After the fix there must NOT be a path that deletes the whole Hermes
    // runtime root when it is a real directory.
    expect(block).not.toContain('rm -rf "$HERMES_GSTACK"');
  });

  test('behavioral: existing real files in ~/.hermes/skills/gstack survive setup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hermes-collision-'));
    try {
      // Reconstruct the runtime-root creation logic from setup, exercising the
      // fixed branch that preserves a real directory.
      const hermesGstack = path.join(tmp, 'gstack');
      const hermesGenDir = path.join(tmp, 'gen', 'skills');

      fs.mkdirSync(hermesGstack, { recursive: true });
      fs.mkdirSync(hermesGenDir, { recursive: true });

      // User-created pre-existing content
      fs.writeFileSync(path.join(hermesGstack, 'README.txt'), 'user file\n');
      fs.writeFileSync(path.join(hermesGstack, 'preserved.md'), 'keep me\n');
      fs.mkdirSync(path.join(hermesGstack, 'my-custom-skill'));
      fs.writeFileSync(
        path.join(hermesGstack, 'my-custom-skill', 'SKILL.md'),
        '# custom\n'
      );

      // Inline the fixed guard from setup
      const script = `
        HERMES_GSTACK='${hermesGstack}'
        HERMES_GEN_DIR='${hermesGenDir}'

        if [ -L "$HERMES_GSTACK" ]; then
          rm -f "$HERMES_GSTACK"
        fi
        mkdir -p "$HERMES_GSTACK" "$HERMES_GSTACK/browse" "$HERMES_GSTACK/review"
      `;

      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.status).toBe(0);

      // All pre-existing files must survive
      expect(fs.existsSync(path.join(hermesGstack, 'README.txt'))).toBe(true);
      expect(fs.existsSync(path.join(hermesGstack, 'preserved.md'))).toBe(true);
      expect(fs.existsSync(path.join(hermesGstack, 'my-custom-skill'))).toBe(true);
      expect(
        fs.readFileSync(path.join(hermesGstack, 'my-custom-skill', 'SKILL.md'), 'utf-8')
      ).toBe('# custom\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
