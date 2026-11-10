/** Copied host runtimes must carry the review commands' shared prompt module. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { runBashSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-review-runtime-'));
const ownedRoot = fs.realpathSync(temporaryRoot);
const source = path.join(temporaryRoot, 'source');
const installed = path.join(temporaryRoot, 'installed');
const env = { ...process.env, GSTACK_STATE_ROOT: path.join(temporaryRoot, 'state') };

function setupFunction(name: string): string {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Missing setup function ${name}`);
  return setup.slice(start + 1, end + 2);
}

beforeAll(() => {
  fs.mkdirSync(path.join(source, 'scripts', 'resolvers'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/resolvers/fix-check.ts'), path.join(source, 'scripts/resolvers/fix-check.ts'));
  // Current runtime helpers also import crew/lib; let setup stage it normally.
  fs.cpSync(path.join(ROOT, 'crew', 'lib'), path.join(source, 'crew', 'lib'), { recursive: true });
  // Mirror the installed script bin, including statically read shell constants and
  // imported parsers. The native binaries are never executed by load-only probes.
  fs.cpSync(path.join(ROOT, 'bin'), path.join(installed, 'bin'), {
    recursive: true, filter: file => !file.endsWith('.exe'),
  });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(installed, 'lib'), { recursive: true });
  // Exercise setup's actual copy/allowlist code without a full install or symlinks.
  // Paths are passed as environment data rather than interpolated into shell code.
  const built = runBashSync([
    'set -e', 'IS_WINDOWS=1', setupFunction('_link_or_copy'), setupFunction('_link_runtime_dists'),
    '_link_runtime_dists "$RUNTIME_FIXTURE_SOURCE" "$RUNTIME_FIXTURE_DEST"',
  ].join('\n'), {
    encoding: 'utf8', timeout: 30_000,
    env: { ...env, RUNTIME_FIXTURE_SOURCE: source.replace(/\\/g, '/'), RUNTIME_FIXTURE_DEST: installed.replace(/\\/g, '/') },
  });
  expect(built.status, built.stderr).toBe(0);
});

afterAll(() => {
  const current = fs.realpathSync(temporaryRoot);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), current);
  if (current !== ownedRoot || fs.lstatSync(temporaryRoot).isSymbolicLink()
    || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing cleanup outside owned temporary root: ${temporaryRoot}`);
  }
  // rm removes any copied symlink itself; recursive cleanup never follows it.
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function invoke(entrypoint: string, args: string[]) {
  return spawnSync(process.execPath, [...bunIsolationArgs(), path.join(installed, 'bin', entrypoint), ...args], {
    cwd: temporaryRoot, env, encoding: 'utf8', timeout: 30_000,
  });
}

describe('review commands in a copied runtime root', () => {
  test('review-plan loads and prints its native help contract', () => {
    const result = invoke('gstack-review-plan', ['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('gstack-review-plan');
    expect(result.stdout).toContain('--fix-check-prompt');
    expect(result.stderr).not.toContain('Cannot find module');
  });

  test('review-scope summary loads and rejects invalid input through its native contract', () => {
    const result = invoke('gstack-review-scope', ['summary', '--since', 'not-a-date', '--no-ledger']);
    // Input rejection proves summary loaded; it intentionally avoids review history or external metadata.
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('REVIEW_SCOPE_INPUT');
    expect(result.stderr).toContain('--since <ISO-8601 timestamp>');
    expect(result.stderr).not.toContain('Cannot find module');
  });
});
