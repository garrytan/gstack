/**
 * gen-ship-goldens — refresh the byte-pinned /ship renders under
 * test/fixtures/golden/ (test/host-config.test.ts compares a fresh render to
 * them). The claude golden is the tracked ship/SKILL.md; the codex, factory
 * and agy goldens come from a `--out-dir` render of each host. Registered in
 * .gstack/generated.json so `gstack-regen check` reports a stale golden
 * before any remote gate and `gstack-regen write` refreshes it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const GOLDEN_DIR = path.join(ROOT, 'test', 'fixtures', 'golden');
const HOSTS: Array<{ host: string; dir: string }> = [
  { host: 'codex', dir: '.agents' },
  { host: 'factory', dir: '.factory' },
  { host: 'agy', dir: '.agy' },
];

export function generateShipGoldens(): string[] {
  const written: string[] = [];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-goldens-'));
  try {
    const copy = (from: string, to: string) => {
      const bytes = fs.readFileSync(from);
      const dest = path.join(GOLDEN_DIR, to);
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes)) { fs.writeFileSync(dest, bytes); written.push(path.relative(ROOT, dest)); }
    };
    copy(path.join(ROOT, 'ship', 'SKILL.md'), 'claude-ship-SKILL.md');
    for (const { host, dir } of HOSTS) {
      const r = spawnSync('bun', ['run', path.join(ROOT, 'scripts', 'gen-skill-docs.ts'), '--host', host, '--out-dir', out], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
      if (r.status !== 0) throw new Error(`gen-skill-docs --host ${host} --out-dir failed (exit ${r.status}):\n${r.stderr}`);
      copy(path.join(out, dir, 'skills', 'gstack-ship', 'SKILL.md'), `${host}-ship-SKILL.md`);
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  return written;
}

if (import.meta.main) {
  const written = generateShipGoldens();
  console.log(written.length ? `GENERATED: ${written.join(' ')}` : 'ship goldens: fresh');
}
