import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runGeneration } from '../scripts/gen-skill-docs';

// Static tripwires for the B2 render-isolation wiring. These fail CI if a
// refactor drops a load-bearing line, re-introducing the "dev-setup dirties
// tracked SKILL.md" drift (or worse, leaks the skip-guard into real installs).
const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('dev-setup: worktree stays canonical', () => {
  const devSetup = read('bin/dev-setup');

  test('passes GSTACK_SKIP_GBRAIN_REGEN inline on the nested setup call', () => {
    expect(devSetup).toContain('GSTACK_SKIP_GBRAIN_REGEN=1 "$GSTACK_LINK/setup"');
  });

  test('never exports GSTACK_SKIP_GBRAIN_REGEN (would leak into other setup paths)', () => {
    expect(devSetup).not.toMatch(/export\s+GSTACK_SKIP_GBRAIN_REGEN/);
  });

  test('renders the :user variant into an out-dir, not in place', () => {
    expect(devSetup).toContain('--out-dir');
    expect(devSetup).toContain('.claude/gstack-rendered');
  });

  test('gates the render on gstack-gbrain-detect --is-ok', () => {
    expect(devSetup).toContain('--is-ok');
  });
});

describe('setup: honors GSTACK_SKIP_GBRAIN_REGEN', () => {
  const setup = read('setup');

  test('skips the in-place :user regen when the guard is set', () => {
    expect(setup).toContain('${GSTACK_SKIP_GBRAIN_REGEN:-}');
    // The guard must wrap the in-place render, not the detection persist.
    const idx = setup.indexOf('GSTACK_SKIP_GBRAIN_REGEN');
    const after = setup.slice(idx, idx + 600);
    expect(after).toContain('leaving tracked SKILL.md canonical');
  });

  test('uses a PID-unique detection tmp (no concurrent clobber)', () => {
    expect(setup).toContain('$DETECTION_FILE.$$.tmp');
  });

  test('gates detection on the shared --is-ok check', () => {
    expect(setup).toContain('"$DETECT_BIN" --is-ok');
  });
});

describe('gen-skill-docs: canonical section links', () => {
  test('canonical render keeps global section and runtime paths', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-canonical-links-'));
    try {
      const result = await runGeneration({ host: 'claude', outputRoot, contentLinkRoot: null });
      expect(result.exitCode).toBe(0);
      const content = fs.readFileSync(path.join(outputRoot, 'ship/SKILL.md'), 'utf-8');
      expect(content).toContain('~/.claude/skills/gstack/ship/sections/');
      expect(content).toContain('~/.claude/skills/gstack/bin/');
      expect(content).not.toContain(outputRoot);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

describe('dev-teardown: removes the untracked render', () => {
  const teardown = read('bin/dev-teardown');

  test('rm -rf the gstack-rendered dir', () => {
    expect(teardown).toContain('gstack-rendered');
    expect(teardown).toMatch(/rm -rf .*RENDER_DIR/);
  });
});

describe('.gitignore: render dir is declared untracked', () => {
  test('.claude/gstack-rendered/ is ignored', () => {
    expect(read('.gitignore')).toContain('.claude/gstack-rendered/');
  });
});

describe('dev-skill: refreshes the render on template change', () => {
  const devSkill = read('scripts/dev-skill.ts');

  test('re-renders the :user variant into the workspace render dir', () => {
    expect(devSkill).toContain('gstack-rendered');
    expect(devSkill).toContain('--out-dir');
    expect(devSkill).toContain('--respect-detection');
  });

  test('only refreshes when the render dir already exists (never creates it during plain dev)', () => {
    expect(devSkill).toContain('fs.existsSync(RENDER_DIR)');
  });
});
