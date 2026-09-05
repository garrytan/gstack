/**
 * gen-skill-docs prunes stale external-host renders.
 *
 * The generator only ever wrote outputs, so a skill deleted from the source
 * tree stayed rendered under every host's skills/ dir (and setup kept linking
 * it). v2.0 retired five browser skills and the stale renders kept reading
 * retired config keys. Now a render removes `gstack-*` dirs it did not write.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('gen-skill-docs stale-render prune', () => {
  test('a gstack-* dir for a skill that no longer exists is removed; the sidecar symlink and real skills stay', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prune-'));
    const skills = path.join(out, '.agents', 'skills');
    fs.mkdirSync(path.join(skills, 'gstack-retired-zzz'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'gstack-retired-zzz', 'SKILL.md'), '---\nname: gstack-retired-zzz\n---\nstale\n');
    fs.mkdirSync(path.join(skills, 'not-ours'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(skills, 'gstack'));
    try {
      const r = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', out], { cwd: ROOT, encoding: 'utf-8', timeout: 180_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pruned stale codex render: gstack-retired-zzz');
      expect(fs.existsSync(path.join(skills, 'gstack-retired-zzz'))).toBe(false);
      expect(fs.existsSync(path.join(skills, 'not-ours'))).toBe(true);
      expect(fs.lstatSync(path.join(skills, 'gstack')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(skills, 'gstack-ship', 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 200_000);
});
