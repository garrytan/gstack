/**
 * #3024: skill blocks `source` gstack helpers into whatever shell the host
 * runs. On macOS that is zsh (Claude Code's Bash tool included), where
 * BASH_SOURCE is empty and bash-only expansions such as ${!name} are errors.
 * Since v1.91.16.0 every Codex outside pass from zsh reported
 * `CODEX_MODEL: invalid` because the probe resolved its resolver at
 * "/../scripts/...".
 *
 * Class guard: the helper list is derived from the generated skills and
 * resolvers (not a hand list), and each helper is sourced under bash and zsh
 * from an unrelated cwd. CI installs zsh (free-tests.yml), so a missing zsh
 * there fails instead of skipping.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const HAS_ZSH = Boolean(Bun.which('zsh'));
const ZSH_REQUIRED = Boolean(process.env.CI) && process.platform !== 'win32';

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

/** Every bin/ helper a generated skill or resolver loads with `source` or `.`. */
function sourcedHelpers(): string[] {
  const files = [
    ...walk(path.join(ROOT, 'scripts', 'resolvers'), f => f.endsWith('.ts')),
    ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'test')
      .flatMap(e => walk(path.join(ROOT, e.name), f => /(?:SKILL\.md|\.md\.tmpl)$/.test(f))),
  ];
  const names = new Set<string>();
  const direct = /(?:^|[\s;&|({]|then\s)(?:source|\.)\s+"?[^"\s;)<]*\bbin\/([A-Za-z0-9._-]+)/g;
  const viaVar = /\/(gstack-[A-Za-z0-9._-]+\.sh)"; \[ -r "\$[A-Z_]+" \] && \. "\$[A-Z_]+"/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of [direct, viaVar]) {
      for (const m of text.matchAll(re)) {
        if (fs.existsSync(path.join(BIN, m[1]!))) names.add(m[1]!);
      }
    }
  }
  return [...names].sort();
}

function run(shell: 'bash' | 'zsh', script: string, env: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-cwd-'));
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
  const r = spawnSync(shell, args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const SHELLS = ['bash', 'zsh'] as const;
const skipShell = (shell: string) => shell === 'zsh' && !HAS_ZSH && !ZSH_REQUIRED;

describe('#3024: sourced helpers work under bash and zsh', () => {
  const helpers = sourcedHelpers();

  test('zsh is present wherever CI runs this suite', () => {
    if (ZSH_REQUIRED) expect(HAS_ZSH).toBe(true);
  });

  test('the derived helper list covers the known sourced helpers', () => {
    for (const known of ['gstack-codex-probe', 'gstack-egress-lib.sh', 'gstack-gbrain-lib.sh']) {
      expect(helpers).toContain(known);
    }
  });

  test('no sourced helper uses bash-only self-location or indirection without a zsh branch', () => {
    for (const name of helpers) {
      const text = fs.readFileSync(path.join(BIN, name), 'utf8')
        .split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
      if (text.includes('BASH_SOURCE')) {
        expect({ name, zshBranch: text.includes('ZSH_VERSION') }).toEqual({ name, zshBranch: true });
        expect({ name, rawUse: /\$\{BASH_SOURCE\[0\]%/.test(text) }).toEqual({ name, rawUse: false });
      }
      expect({ name, indirect: /\$\{![A-Za-z_]/.test(text) }).toEqual({ name, indirect: false });
    }
  });

  for (const shell of SHELLS) {
    test.skipIf(skipShell(shell))(`every sourced helper parses and sources cleanly (${shell})`, () => {
      for (const name of helpers) {
        const file = path.join(BIN, name);
        const r = run(shell, `${shell} -n '${file}' && . '${file}' && echo SOURCED`);
        expect({ name, out: r.out.trim().split('\n').pop() }).toEqual({ name, out: 'SOURCED' });
      }
    });

    test.skipIf(skipShell(shell))(`codex probe resolves its own directory and selects the model (${shell})`, () => {
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-codex-'));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test-model"\n');
      const r = run(
        shell,
        `. '${path.join(BIN, 'gstack-codex-probe')}' && echo "BIN=$_GSTACK_CODEX_BIN" && _gstack_codex_select_model exec`,
        { CODEX_HOME: codexHome },
      );
      fs.rmSync(codexHome, { recursive: true, force: true });
      expect(r.out).toContain(`BIN=${BIN}\n`);
      expect(r.out).toContain('CODEX_MODEL: gpt-test-model (exec;');
      expect(r.out).not.toContain('Module not found');
      expect(r.code).toBe(0);
    });

    test.skipIf(skipShell(shell))(`codex auth probe reads a custom provider's env_key (${shell})`, () => {
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-auth-'));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), '[model_providers.local]\nenv_key = "LOCAL_PROVIDER_KEY"\n');
      const r = run(shell, `. '${path.join(BIN, 'gstack-codex-probe')}' && _gstack_codex_auth_probe`, {
        CODEX_HOME: codexHome,
        LOCAL_PROVIDER_KEY: 'present',
      });
      fs.rmSync(codexHome, { recursive: true, force: true });
      expect(r.out.trim()).toBe('AUTH_OK');
      expect(r.code).toBe(0);
    });

    test.skipIf(skipShell(shell))(`egress lib resolves its own directory, not the caller's cwd (${shell})`, () => {
      const r = run(shell, `. '${path.join(BIN, 'gstack-egress-lib.sh')}' && echo "DIR=$_gstack_egress_lib_dir"`);
      expect(r.out).toContain(`DIR=${BIN}\n`);
    });
  }
});
