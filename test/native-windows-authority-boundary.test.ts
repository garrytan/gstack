import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
const preload = path.join(import.meta.dir, 'helpers', 'emulate-bun-native-windows.ts');
const jsonlUrl = pathToFileURL(path.join(import.meta.dir, '..', 'lib', 'jsonl-store.ts')).href;
const ownerLockUrl = pathToFileURL(path.join(import.meta.dir, '..', 'lib', 'durable-owner-lock.ts')).href;
const stateRootUrl = pathToFileURL(path.join(import.meta.dir, '..', 'lib', 'canonical-state-root.ts')).href;
const decisionLog = path.join(import.meta.dir, '..', 'bin', 'gstack-decision-log');
const evidence = path.join(import.meta.dir, '..', 'bin', 'gstack-evidence');
const effectScope = path.join(import.meta.dir, '..', 'scripts', 'authority', 'effect-scope.ts');
const prHeadGuard = path.join(import.meta.dir, '..', 'scripts', 'authority', 'pr-head-guard.ts');

afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function run(source: string, ...args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, '--preload', preload, '-e', source, ...args], { timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('native Windows authority boundary', () => {
  test('native Windows fallback stays limited to audited non-authority callers', () => {
    const repositoryRoot = path.join(import.meta.dir, '..');
    const ignoredDirectories = new Set([
      '.git',
      'node_modules',
      'dist',
      '.agents',
      '.claude',
      '.factory',
      '.openclaw',
      '.hermes',
      '.gbrain',
      'test',
      'tests',
    ]);
    const callers: string[] = [];
    const visit = (candidate: string): void => {
      const info = fs.statSync(candidate);
      if (info.isDirectory()) {
        for (const entry of fs.readdirSync(candidate)) {
          if (!ignoredDirectories.has(entry)) visit(path.join(candidate, entry));
        }
        return;
      }
      if (candidate.endsWith(path.join('lib', 'jsonl-store.ts'))) return;
      const relative = path.relative(repositoryRoot, candidate).replaceAll(path.sep, '/');
      if (path.extname(candidate) && !/\.(?:ts|tsx|js|mjs|cjs|sh|py)$/.test(candidate)) return;
      const content = fs.readFileSync(candidate);
      if (content.includes(0)) return;
      if (/\bappendNonAuthorityJsonl\s*\(/.test(content.toString('utf8'))) {
        callers.push(relative);
      }
    };
    visit(repositoryRoot);

    expect(callers.sort()).toEqual([
      'lib/gstack-decision.ts',
      'lib/gstack-memory-helpers.ts',
      'lib/redact-audit-log.ts',
    ]);
  });

  test('non-authority JSONL keeps the legacy single-write append path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-jsonl-')); roots.push(root);
    const target = path.join(root, 'legacy.jsonl');
    const source = `import { appendNonAuthorityJsonl } from ${JSON.stringify(jsonlUrl)}; appendNonAuthorityJsonl(process.argv[1], { kind: 'decision' });`;
    const child = run(source, target);

    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe('');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"kind":"decision"}\n');
  });

  test('decision-log remains writable across repeated native Windows calls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-decision-log-')); roots.push(root);
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const payload = '{"decision":"native Windows probe","rationale":"r","scope":"repo","source":"user"}';
    const env = { ...process.env, GSTACK_HOME: path.join(root, '.gstack') };
    const invoke = () => Bun.spawnSync([process.execPath, '--preload', preload, decisionLog, payload], { timeout: 30_000,
      cwd: work,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const first = invoke();
    const second = invoke();
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    expect(first.stderr.toString() + second.stderr.toString()).toBe('');
    const ledger = path.join(root, '.gstack', 'projects', 'work', 'decisions.jsonl');
    expect(fs.readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('authority JSONL fails closed before creating its ledger', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-jsonl-')); roots.push(root);
    const target = path.join(root, 'authority.jsonl');
    const source = `import { appendJsonl } from ${JSON.stringify(jsonlUrl)}; appendJsonl(process.argv[1], { kind: 'receipt' }, { mode: 384 });`;
    const child = run(source, target);

    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('ecpe_native_windows_unsupported');
    expect(fs.existsSync(target)).toBe(false);
  });

  test('durable owner lock rejects native Windows before creating state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-owner-lock-')); roots.push(root);
    const directory = path.join(root, 'missing');
    const target = path.join(directory, 'owner');
    const source = `import { acquireDurableOwnerLock } from ${JSON.stringify(ownerLockUrl)}; acquireDurableOwnerLock(process.argv[1], 'busy');`;
    const child = run(source, target);

    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('ecpe_native_windows_unsupported');
    expect(fs.existsSync(directory)).toBe(false);
  });

  test('runtime state-root resolution cannot bypass the native Windows boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-state-root-')); roots.push(root);
    const source = `import { resolveRuntimeStateRoot } from ${JSON.stringify(stateRootUrl)}; resolveRuntimeStateRoot();`;
    const child = Bun.spawnSync([process.execPath, '--preload', preload, '-e', source], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('ecpe_native_windows_unsupported');
  });

  test('provider-effect entrypoints reject native Windows before dispatch', () => {
    const cases: Array<[string, string[]]> = [
      [evidence, ['check', '--capability', 'delivery.pr_open']],
      [evidence, ['run', '--validator', 'fixture']],
      [evidence, ['check', '--validator', 'fixture']],
      [evidence, ['ensure', '--validator', 'fixture']],
      [evidence, ['safety-sources']],
      [effectScope, []],
      [prHeadGuard, []],
    ];
    for (const [entrypoint, args] of cases) {
      const child = Bun.spawnSync([process.execPath, '--preload', preload, entrypoint, ...args], { timeout: 30_000,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain('ecpe_native_windows_unsupported');
    }
  });

  test('legacy evidence checks remain available on native Windows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-evidence-')); roots.push(root);
    const child = Bun.spawnSync([process.execPath, '--preload', preload, evidence, 'check', '--all'], { timeout: 30_000,
      cwd: root,
      env: { ...process.env, GSTACK_HOME: path.join(root, '.gstack') },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.stderr.toString()).not.toContain('ecpe_native_windows_unsupported');
  });

  test('a legacy evidence child argument named --validator is not misclassified as ECPE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-evidence-run-')); roots.push(root);
    const child = Bun.spawnSync([
      process.execPath,
      '--preload',
      preload,
      evidence,
      'run',
      '--label',
      'probe',
      '--',
      process.execPath,
      '-e',
      "console.log('legacy-child-ran')",
      '--validator',
    ], { timeout: 30_000,
      cwd: root,
      env: { ...process.env, GSTACK_HOME: path.join(root, '.gstack') },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain('legacy-child-ran');
    expect(child.stderr.toString()).not.toContain('ecpe_native_windows_unsupported');
  });
});
