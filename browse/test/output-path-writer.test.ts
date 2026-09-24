import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let root: string;
let allowed: string;
let outside: string;
let temp: string;
let nodeBundle: string;
const pathModule = pathToFileURL(resolve(import.meta.dir, '../src/path-security.ts')).href;
const readModule = pathToFileURL(resolve(import.meta.dir, '../src/read-commands.ts')).href;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(homedir(), '.gstack-output-fixture-')));
  allowed = join(root, 'allowed');
  outside = join(root, 'outside');
  temp = join(root, 'temp');
  for (const dir of [allowed, outside, temp]) mkdirSync(dir);
  mkdirSync(join(allowed, 'nested'));
  mkdirSync(join(outside, 'nested'));
  writeFileSync(join(allowed, 'internal.txt'), 'original');
  writeFileSync(join(outside, 'existing.txt'), 'unchanged');
  for (const [name, target] of [
    ['internal-link.txt', join(allowed, 'internal.txt')],
    ['outward-live.txt', join(outside, 'existing.txt')],
    ['outward-dangling.txt', join(outside, 'missing.txt')],
    ['internal-parent', allowed],
    ['outward-parent', outside],
    ['dangling-parent', join(outside, 'missing-directory')],
    ['outward-nested', join(outside, 'nested')],
    ['internal-nested', join(allowed, 'nested')],
    ['loop', join(allowed, 'loop')],
  ]) {
    expect(realpathSync(dirname(target))).toBeOneOf([root, allowed, outside]);
    symlinkSync(target, join(allowed, name));
  }
  symlinkSync('outward-nested/..', join(allowed, 'outward-chain'));
  symlinkSync('internal-nested/..', join(allowed, 'internal-chain'));
  symlinkSync(join(allowed, 'nested'), join(outside, 'return'));
  const entry = join(root, 'node-entry.ts');
  writeFileSync(entry, [
    `export { SAFE_DIRECTORIES, validateReadPath, validateTempPath } from ${JSON.stringify(resolve(import.meta.dir, '../src/path-security.ts'))};`,
    `export { writeEvalResult } from ${JSON.stringify(resolve(import.meta.dir, '../src/read-commands.ts'))};`,
    `export { isPathWithin, TEMP_DIR } from ${JSON.stringify(resolve(import.meta.dir, '../src/platform.ts'))};`,
  ].join('\n'));
  const build = await Bun.build({ entrypoints: [entry], target: 'node', outdir: root, naming: 'node-writer.mjs' });
  expect(build.success).toBe(true);
  nodeBundle = pathToFileURL(join(root, 'node-writer.mjs')).href;
});

beforeEach(() => {
  rmSync(join(outside, 'missing.txt'), { force: true });
  rmSync(join(outside, 'new.txt'), { force: true });
  rmSync(join(outside, 'missing-directory'), { recursive: true, force: true });
  rmSync(join(outside, 'escaped.txt'), { force: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function probe(operation: 'write' | 'read' | 'temp', file: string, runtime: 'bun' | 'node' = 'bun') {
  const lexicalPath = resolve(allowed, file);
  expect(lexicalPath.startsWith(`${root}/`) || lexicalPath.startsWith(`${root}\\`)).toBe(true);
  const script = `
    import { SAFE_DIRECTORIES, validateReadPath, validateTempPath } from ${JSON.stringify(runtime === 'node' ? nodeBundle : pathModule)};
    import { writeEvalResult } from ${JSON.stringify(runtime === 'node' ? nodeBundle : readModule)};
    import { isPathWithin, TEMP_DIR } from ${JSON.stringify(runtime === 'node' ? nodeBundle : pathToFileURL(resolve(import.meta.dir, '../src/platform.ts')).href)};
    import { realpathSync } from 'node:fs';
    const [operation, file, outside] = process.argv.slice(1);
    if (SAFE_DIRECTORIES.some(dir => isPathWithin(outside, dir))) throw new Error('Fixture sibling accidentally allowed');
    let error = null;
    try {
      if (operation === 'write') writeEvalResult(file, 'fixture output', { raw: true });
      else if (operation === 'read') validateReadPath(file);
      else validateTempPath(file);
    } catch (err) { error = err.message; }
    console.log(JSON.stringify({ error, safe: SAFE_DIRECTORIES, remoteTemp: realpathSync(TEMP_DIR) }));
  `;
  const executable = runtime === 'node' ? Bun.which('node') : process.execPath;
  expect(executable).not.toBeNull();
  const flags = runtime === 'node' ? ['--input-type=module'] : [];
  const result = Bun.spawnSync([executable!, ...flags, '--eval', script, operation, file, outside], {
    cwd: allowed,
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  return JSON.parse(result.stdout.toString()) as { error: string | null; safe: string[]; remoteTemp: string };
}

for (const name of ['ordinary.txt', 'new-directory/new.txt', 'internal-link.txt', 'internal-parent/through-parent.txt', 'internal-chain/through-chain.txt']) {
  test(`actual output writer preserves ${name}`, () => {
    const file = join(allowed, name);
    expect(probe('write', file).error).toBeNull();
    expect(realpathSync(file).startsWith(`${allowed}/`) || realpathSync(file).startsWith(`${allowed}\\`)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('fixture output');
  });
}

for (const name of ['outward-live.txt', 'outward-dangling.txt', 'outward-parent/new.txt', 'outward-chain/new.txt', 'dangling-parent/new.txt', 'loop', 'loop/new.txt']) {
  test(`actual output writer rejects ${name} without touching the owned sibling`, () => {
    const file = join(allowed, name);
    const result = probe('write', file);
    expect(result.error).not.toBeNull();
    expect(readFileSync(join(outside, 'existing.txt'), 'utf8')).toBe('unchanged');
    expect(existsSync(join(outside, 'missing.txt'))).toBe(false);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    expect(existsSync(join(outside, 'missing-directory'))).toBe(false);
  });
}

test('dangling parent validation fails before any writer mkdir', () => {
  const result = probe('write', join(allowed, 'dangling-parent', 'new.txt'));
  expect(result.error).toContain('Path must be within');
  expect(lstatSync(join(allowed, 'dangling-parent')).isSymbolicLink()).toBe(true);
});

for (const file of ['outward-nested/../escaped.txt', 'outward-nested/../../outside/escaped.txt']) {
  test(`actual writer rejects raw symlink traversal ${file}`, () => {
    const nativeParent = statSync(`${allowed}/${file.slice(0, file.lastIndexOf('/'))}`);
    expect(nativeParent.ino).toBe(statSync(outside).ino);
    expect(nativeParent.dev).toBe(statSync(outside).dev);
    const result = probe('write', file);
    expect(result.error).toContain('Path must be within');
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
  });
}

test('actual writer rejects an absolute unnormalized symlink-parent path', () => {
  const file = `${allowed}/outward-nested/../escaped.txt`;
  expect(statSync(`${allowed}/outward-nested/..`).ino).toBe(statSync(outside).ino);
  expect(probe('write', file).error).toContain('Path must be within');
  expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
});

test('validator also rejects the unsafe lexical destination used by normalizing callers', () => {
  const file = '../outside/return/../escaped.txt';
  expect(statSync(`${allowed}/../outside/return/..`).ino).toBe(statSync(allowed).ino);
  expect(resolve(allowed, file)).toBe(join(outside, 'escaped.txt'));
  expect(probe('write', file).error).toContain('Path must be within');
  expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
});

for (const file of ['nested/../ordinary-parent.txt', 'internal-nested/../internal-parent.txt']) {
  test(`actual writer preserves in-root parent traversal ${file}`, () => {
    expect(realpathSync.native(`${allowed}/${file.slice(0, file.lastIndexOf('/'))}`)).toBe(allowed);
    expect(probe('write', file).error).toBeNull();
    expect(readFileSync(`${allowed}/${file}`, 'utf8')).toBe('fixture output');
  });
}

test('read and remote-temp policies retain their separate boundaries', () => {
  expect(probe('read', join(allowed, 'internal-link.txt')).error).toBeNull();
  expect(probe('read', join(allowed, 'ordinary-missing.txt')).error).toBeNull();
  expect(probe('read', join(allowed, 'outward-live.txt')).error).toContain('Path must be within');
  expect(probe('temp', join(allowed, 'internal-link.txt')).error).toContain('remote file serving');
  expect(probe('temp', join(allowed, 'outward-dangling.txt')).error).not.toBeNull();
  const file = join(temp, 'local-temp.txt');
  expect(probe('write', file).error).toBeNull();
  expect(probe('read', file).error).toBeNull();
  const remote = probe('temp', file);
  expect(remote.error === null).toBe(remote.remoteTemp === realpathSync(temp));
});

test('Node writer preserves physical symlink-parent semantics and ordinary creation', () => {
  for (const file of ['outward-nested/../escaped.txt', 'outward-chain/escaped.txt']) {
    expect(statSync(`${allowed}/${file.slice(0, file.lastIndexOf('/'))}`).ino).toBe(statSync(outside).ino);
    expect(probe('write', file, 'node').error).toContain('Path must be within');
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
  }
  for (const file of ['internal-nested/../node-internal.txt', 'internal-chain/node-chain.txt', 'node-missing/parent/output.txt']) {
    expect(probe('write', file, 'node').error).toBeNull();
    expect(readFileSync(`${allowed}/${file}`, 'utf8')).toBe('fixture output');
  }
});
