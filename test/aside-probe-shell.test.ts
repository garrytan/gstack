import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateAsideSetup, generateAsideResearch } from '../scripts/resolvers/aside';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ctx = { skillName: 'browse', tmplPath: '', host: 'claude' as const, paths: HOST_PATHS.claude };
const probe = generateAsideSetup(ctx).match(/```bash\n([\s\S]*?)```/)![1];
const shells = ['bash', 'sh', ...(process.platform === 'win32' ? [] : ['zsh'])];
const launchers = {
  gtimeout: Bun.which('gtimeout') ?? Bun.which('timeout'),
  timeout: Bun.which('timeout') ?? Bun.which('gtimeout'),
  perl: Bun.which('perl'),
};

function run(shell: string, arm: keyof typeof launchers | 'none', mode = 'ready', skip = false) {
  const root = mkdtempSync(join(tmpdir(), 'aside-probe-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  try {
    const executable = Bun.which(shell);
    if (!executable) throw new Error(`Required shell unavailable: ${shell}`);
    symlinkSync(Bun.which('grep')!, join(bin, 'grep'));
    if (arm !== 'none') symlinkSync(launchers[arm]!, join(bin, arm));
    if (mode !== 'absent') writeFileSync(join(bin, 'aside'), `#!/bin/sh
printf '%s\\n' "$@" >> "$CALLS"
case "$MODE" in
  ready) echo 'ASIDE_READY /private/session' ;;
  version-error) case "\${1}" in --version) echo 'VERSION_DIAGNOSTIC_MARKER'; exit 7;; *) echo 'ASIDE_READY /private/session';; esac ;;
  stopped) echo '[error] Aside app is not running' ;;
  timeout) exit 124 ;;
  hang) exec /bin/sleep 5 ;;
  marker-error) echo 'ASIDE_READY /private/session'; exit 7 ;;
  prefix) echo 'ASIDE_READY_INVALID' ;;
  error) echo 'Cannot find module /private/person/token=SYNTHETIC_PRIVATE_VALUE' >&2; exit 7 ;;
esac
`, { mode: 0o755 });
    const script = mode === 'hang' ? probe.replaceAll('30 "$@"', '1 "$@"') : probe;
    const result = spawnSync(executable, ['-c', script], {
      encoding: 'utf8', timeout: 5000,
      env: { HOME: root, PATH: bin, MODE: mode, CALLS: join(root, 'calls'), GSTACK_SKIP_ASIDE: skip ? '1' : '' },
    });
    let calls = '';
    try { calls = readFileSync(join(root, 'calls'), 'utf8'); } catch {}
    expect(result.status).toBe(0);
    return { output: result.stdout + result.stderr, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('emitted Aside readiness probe', () => {
  test('research shares the complete setup probe', () => {
    expect(generateAsideResearch(ctx)).toContain(probe);
  });
  for (const shell of shells) {
    const shellTest = Bun.which(shell) ? test : test.skip;
    shellTest(`${shell}: without a deadline launcher even a hanging CLI is never invoked`, () => {
      for (const mode of ['ready', 'hang']) {
        const result = run(shell, 'none', mode);
        expect(result.output).toBe('ASIDE_UNAVAILABLE: bounded probe unavailable\n');
        expect(result.calls).toBe('');
      }
      for (const result of [run(shell, 'none', 'absent'), run(shell, 'none', 'ready', true)]) {
        expect(result.output).toBe('NEEDS_ASIDE\n');
        expect(result.calls).toBe('');
      }
    });
    for (const arm of ['gtimeout', 'timeout', 'perl'] as const) {
      const armTest = Bun.which(shell) && launchers[arm] ? test : test.skip;
      armTest(`${shell}/${arm}: forwards the complete script as one argument`, () => {
        const result = run(shell, arm);
        expect(result.output).toBe('READY: aside\n');
        expect(result.calls).toBe('repl\nconsole.log("ASIDE_READY " + pwd)\n');
      });
      armTest(`${shell}/${arm}: READY never calls the optional version diagnostic channel`, () => {
        const result = run(shell, arm, 'version-error');
        expect(result.output).toBe('READY: aside\n');
        expect(result.output).not.toContain('VERSION_DIAGNOSTIC_MARKER');
        expect(result.calls).not.toContain('--version');
      });
      armTest(`${shell}/${arm}: absent and skipped never invoke Aside`, () => {
        for (const result of [run(shell, arm, 'absent'), run(shell, arm, 'ready', true)]) {
          expect(result.output).toBe('NEEDS_ASIDE\n');
          expect(result.calls).toBe('');
        }
      });
      armTest(`${shell}/${arm}: CLI failures are distinct and do not leak raw output`, () => {
        const result = run(shell, arm, 'error');
        expect(result.output).toBe('ASIDE_CLI_ERROR: exit 7; inspect aside --help locally\n');
        expect(result.output).not.toContain('SYNTHETIC_PRIVATE_VALUE');
        expect(result.output).not.toContain('/private/person');
      });
      armTest(`${shell}/${arm}: deadline and stopped-app responses have distinct outcomes`, () => {
        expect(run(shell, arm, 'timeout').output).toBe('ASIDE_TIMEOUT: probe deadline exceeded\n');
        expect(run(shell, arm, 'stopped').output).toBe('ASIDE_NOT_RUNNING: no readiness marker\n');
      });
      armTest(`${shell}/${arm}: readiness requires a successful exit and an exact marker`, () => {
        expect(run(shell, arm, 'marker-error').output).toBe('ASIDE_CLI_ERROR: exit 7; inspect aside --help locally\n');
        expect(run(shell, arm, 'prefix').output).toBe('ASIDE_NOT_RUNNING: no readiness marker\n');
      });
      armTest(`${shell}/${arm}: the native deadline stops a hung CLI`, () => {
        expect(run(shell, arm, 'hang').output).toBe('ASIDE_TIMEOUT: probe deadline exceeded\n');
      });
    }
  }
});
