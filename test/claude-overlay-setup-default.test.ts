/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): the default install.
 * Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, setup, config, defaultRender, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, runSetup } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('./setup --claude-model (default install)', () => {
  test('no claude_overlay_model: committed render, no render dir, no record', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = setup(f, src);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(existsSync(`${defaultRender(f)}.overlay`)).toBe(false);
    expect(config(f, src, 'has', 'claude_overlay_model').status).not.toBe(0);
    expect(served(join(f.home, '.claude/skills'))).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
    expect(r.out).not.toContain('Claude skill overlay:');
    const status = setup(f, src, ['--status']);
    expect(status.stdout).toContain('~/.claude/skills: claude (default, committed render)');
  }, 120_000);

  test('pinned overlay renders and persists; the banner shows only on change; claude returns to committed files', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.claude/skills');

    const pinned = setup(f, src, ['--claude-model', 'claude-opus-4-7']);
    expect(pinned.status, pinned.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-4-7');
    expect(pinned.out).toContain('Claude skill overlay: opus-4-7 (was claude).');
    expect(pinned.out).toContain('./setup --claude-model claude');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-7', source: 'explicit', model: 'claude-opus-4-7', gbrain: 'absent', render: 'user' });
    expect(served(skills)).toContain(MARKER);
    expect(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8')).not.toContain(MARKER);

    const again = setup(f, src);
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toContain('Claude skill overlay:');
    expect(served(skills)).toContain(MARKER);

    const back = setup(f, src, ['--claude-model', 'claude']);
    expect(back.status, back.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude');
    expect(back.out).toContain('Claude skill overlay: claude (was opus-4-7).');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'explicit', render: 'committed' });
    expect(served(skills)).not.toContain(MARKER);
  }, 180_000);

  test('an ID without its own overlay is accepted as the generic overlay', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = setup(f, src, ['--claude-model=claude-opus-5-5']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('claude-opus-5-5 has no overlay of its own, so it uses the generic claude overlay');
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-5-5');
    expect(existsSync(defaultRender(f))).toBe(false);
  }, 120_000);

  test('invalid IDs, a missing value and a non-Claude host error before anything is persisted', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    for (const [args, expected] of [
      [['--claude-model', 'opus'], 'is a Claude Code alias'],
      [['--claude-model', 'gpt-5.4'], 'selects Claude overlays only'],
      [['--claude-model=banana'], 'does not match any model family'],
      [['--host', 'codex', '--claude-model', 'claude-opus-4-7'], '--claude-model is supported only when Claude is selected'],
    ] as const) {
      const r = setup(f, src, [...args]);
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain(expected);
      expect(r.stderr).toContain('Nothing was installed or changed.');
    }
    expect(config(f, src, 'has', 'claude_overlay_model').status).not.toBe(0);
    for (const args of [['--claude-model'], ['--claude-model=']]) {
      const missing = spawnSync('bash', [join(src, 'setup'), ...args], { env: f.env, encoding: 'utf8', timeout: 30_000 });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('Missing value for --claude-model');
    }
    const typo = runSetup(f, join(src, 'setup'), ['--claude-modle', 'claude-opus-4-8']);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('Did you mean: ./setup --claude-model claude-opus-4-8');
    const codexOnly = setup(f, src, ['--model', 'gpt-5.4']);
    expect(codexOnly.stderr).toContain('For the Claude overlay, use --claude-model <id>.');
  }, 240_000);

  test('a persisted ID that no longer resolves falls back to claude and says why', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(config(f, src, 'set', 'claude_overlay_model', 'opus').status).toBe(0);
    const r = setup(f, src);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("claude_overlay_model 'opus' no longer resolves to a Claude overlay");
    expect(r.out).toContain('using the generic claude overlay');
    expect(existsSync(defaultRender(f))).toBe(false);
  }, 120_000);
});
