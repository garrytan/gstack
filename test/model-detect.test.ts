/**
 * Loadout detection (GSTA-161, PR 1b): lib/model-detect.ts resolves a loadout
 * from explicit inputs only, and gstack-skill-start prints a lite render's
 * LOADOUT lines without executing or echoing a hostile model id.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLoadout } from '../lib/model-detect';
import { ModuleError, loadLoadouts } from '../scripts/modules';

const ROOT = path.resolve(import.meta.dir, '..');
const manifest = loadLoadouts();
const resolve = (input: { loadout?: string; model?: string; env?: Record<string, string> }) => resolveLoadout({ env: {}, ...input, manifest });

describe('resolveLoadout', () => {
  test('only Claude Opus 5.5 (bare, provider-prefixed, dated snapshot or -latest) maps to lite, bound to the base id', () => {
    for (const model of ['claude-opus-5-5', 'anthropic/claude-opus-5-5', ' Claude-Opus-5-5[1m] ', 'claude-opus-5-5-20261101', 'claude-opus-5-5-latest']) {
      expect(resolve({ model })).toEqual({ loadout: 'lite', source: 'model-flag', model: 'claude-opus-5-5' });
    }
  });

  test('every other model, including near misses of the Opus 5.5 id, resolves to full and never errors', () => {
    const near = ['claude-opus-5-6', 'claude-opus-5', 'claude-opus-55x', 'claude-opus-5-50', 'claude-opus-5-5x', 'claude-opus-5-5-1', 'claude-opus-5-5-2026110'];
    const others = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6-astra', 'some-new-model', 'constructor', 'opus'];
    for (const model of [...near, ...others]) expect(resolve({ model })).toEqual({ loadout: 'full', source: 'model-flag', model: null, reason: 'unmapped' });
  });

  test('an id that is not a plain model id resolves to full with a sanitized notice', () => {
    for (const model of ['a$(touch /tmp/x)', "o'pus", 'claude\nopus', 'x'.repeat(200), 'us.anthropic.claude-opus-5-5:0', 'claude-opus-5-5@2026']) {
      const r = resolve({ model });
      expect(r).toMatchObject({ loadout: 'full', model: null, reason: 'invalid' });
      expect(r.notice).toMatch(/^LOADOUT_INVALID_MODEL: ".{0,40}" is not a plain model id; using full/);
      expect(r.notice).not.toContain('\n');
    }
  });

  test('order: an explicit loadout (bound to no model), then --model, then GSTACK_MODEL, then full', () => {
    expect(resolve({ loadout: 'lite', model: 'claude-sonnet-5-5' })).toEqual({ loadout: 'lite', source: 'loadout-flag', model: null });
    expect(resolve({ loadout: 'full', model: 'claude-opus-5-5' })).toEqual({ loadout: 'full', source: 'loadout-flag', model: null });
    expect(resolve({ model: 'claude-sonnet-5-5', env: { GSTACK_MODEL: 'claude-opus-5-5' } })).toMatchObject({ loadout: 'full', source: 'model-flag' });
    expect(resolve({ env: { GSTACK_MODEL: 'claude-opus-5-5' } })).toEqual({ loadout: 'lite', source: 'GSTACK_MODEL', model: 'claude-opus-5-5' });
    expect(resolve({ env: { GSTACK_LOADOUT: 'lite', GSTACK_MODEL: '  ' } })).toEqual({ loadout: 'full', source: 'default', model: null });
    expect(resolve({})).toEqual({ loadout: 'full', source: 'default', model: null });
  });

  test('an unknown explicit loadout is refused; a manifest without a models map serves full', () => {
    expect(() => resolve({ loadout: 'nope' })).toThrow(ModuleError);
    expect(resolveLoadout({ model: 'claude-opus-5-5', env: {}, manifest: { ...manifest, models: undefined } })).toMatchObject({ loadout: 'full', reason: 'unmapped' });
  });
});

describe('gstack-skill-start LOADOUT lines', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-start-'));
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  const start = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(ROOT, 'bin/gstack-skill-start'), '--skill', 'qa', '--model', 'claude', ...args], {
      cwd: home, encoding: 'utf-8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_HOME: path.join(home, '.gstack'), ...env },
    });
    return r.stdout.split('\n').filter(l => l.startsWith('LOADOUT'));
  };
  const bound = ['--loadout', 'lite', '--loadout-model', 'claude-opus-5-5', '--full-root', '/opt/skills'];
  const rule = 'LOADOUT_RULE: this file was rendered for claude-opus-5-5. If you are not running claude-opus-5-5, read /opt/skills/qa/SKILL.md now and follow it instead of this file.';

  test('a model-bound render names its model and full root and says when to read the full file', () => {
    expect(start(bound)).toEqual(['LOADOUT: lite model=claude-opus-5-5 full_root=/opt/skills', rule]);
    for (const running of ['claude-opus-5-5', 'Anthropic/Claude-Opus-5-5 [1m]', 'claude-opus-5-5-20261101']) expect(start(bound, { GSTACK_MODEL: running })).toEqual(['LOADOUT: lite model=claude-opus-5-5 full_root=/opt/skills', rule]);
  });

  test('a different running model gets LOADOUT_MISMATCH; a hostile GSTACK_MODEL is neither run nor echoed', () => {
    expect(start(bound, { GSTACK_MODEL: 'claude-sonnet-5-5' }).at(-1)).toBe('LOADOUT_MISMATCH: claude-opus-5-5 vs claude-sonnet-5-5: read /opt/skills/qa/SKILL.md now and follow it instead of this file.');
    expect(start(bound, { GSTACK_MODEL: 'claude-opus-5-50' }).at(-1)).toContain('LOADOUT_MISMATCH: claude-opus-5-5 vs claude-opus-5-50');
    const marker = path.join(home, 'pwned');
    const lines = start(bound, { GSTACK_MODEL: `$(touch ${marker})` });
    expect(lines.at(-1)).toBe('LOADOUT_MISMATCH: claude-opus-5-5 vs an invalid GSTACK_MODEL: read /opt/skills/qa/SKILL.md now and follow it instead of this file.');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('a malformed bound start line points at the full file; a full or explicit render prints nothing', () => {
    const malformed = 'LOADOUT: lite model=unknown: the start line is malformed; read the full SKILL.md for this skill instead of this file.';
    expect(start(['--loadout', 'lite'])).toEqual([malformed]);
    expect(start(['--loadout', 'lite', '--loadout-model', 'x;id', '--full-root', '/opt/skills'])).toEqual([malformed]);
    expect(start(['--loadout', 'lite', '--loadout-model', 'claude-opus-5-5', '--full-root', 'relative'])).toEqual([malformed]);
    expect(start([])).toEqual([]);
  });
});
