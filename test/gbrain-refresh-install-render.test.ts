import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';

// Static tripwires for the GStack 2 `gstack-config gbrain-refresh` boundary.
// Host placement and skill updates belong to the standard Agent Skills
// installer. This command may refresh managed detection state, but must never
// mutate a host-specific skill directory or regenerate skill content in place.
const ROOT = path.resolve(import.meta.dir, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-config'), 'utf-8');

function refreshFunction(): string {
  const start = SRC.indexOf('async function refreshGbrainDetection()');
  const end = SRC.indexOf('\nasync function mutateConfigHome', start);
  if (start < 0 || end < 0) {
    throw new Error('Could not locate refreshGbrainDetection');
  }
  return SRC.slice(start, end);
}

describe('gstack-config gbrain-refresh: managed-state-only boundary', () => {
  const body = refreshFunction();

  test('runs the canonical detector', () => {
    expect(body).toContain('gstack-gbrain-detect');
  });

  test('writes only managed detection state with an atomic rename', () => {
    expect(body).toContain('gbrain-detection.json');
    expect(body).toContain('.tmp-${process.pid}');
    expect(body).toContain('fs.rename(temporary, target)');
    expect(body).toContain('mutateConfigHome');
  });

  test('does not own host placement or in-place generation', () => {
    expect(body).not.toMatch(/\.claude\/skills|\.agents\/skills/);
    expect(body).not.toContain('gen:skill-docs');
    expect(body).not.toContain('gstack-relink');
  });

  test('directs content updates back through the standard installer', () => {
    expect(body).toContain('standard Agent Skills installer');
  });
});

describe('CLAUDE.md: deploy section preserves the installer boundary', () => {
  test('names the standard installer as the host-placement owner', () => {
    const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8');
    const idx = claudeMd.indexOf('## Deploying to the active skill');
    expect(idx).toBeGreaterThan(-1);
    const section = claudeMd.slice(idx, idx + 1200);
    expect(section).toContain('standard Agent Skills installer');
    expect(section).not.toContain('renders into the install');
  });
});
