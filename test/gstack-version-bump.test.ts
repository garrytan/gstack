/**
 * Tests for the gstack-version-bump CLI (v2 plan T9 hybrid extraction). Covers
 * the idempotency classifier (pure) + the write/repair mutations (temp fs).
 * The classifier is the one that prevents re-bumping an already-shipped branch —
 * the worst /ship footgun — so it gets exhaustive state coverage.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { classifyState, VERSION_RE } from '../bin/gstack-version-bump';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-version-bump');

describe('classifyState (idempotency)', () => {
  test('FRESH when VERSION matches base and pkg agrees', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', true, '1.1.0.0')).toBe('FRESH');
  });
  test('FRESH when VERSION matches base and no package.json', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', false, '')).toBe('FRESH');
  });
  test('ALREADY_BUMPED when VERSION moved past base and pkg agrees (re-run)', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', true, '1.2.0.0')).toBe('ALREADY_BUMPED');
  });
  test('ALREADY_BUMPED when VERSION moved past base, no package.json', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', false, '')).toBe('ALREADY_BUMPED');
  });
  test('DRIFT_STALE_PKG when VERSION bumped but pkg lagging', () => {
    expect(classifyState('1.2.0.0', '1.1.0.0', true, '1.1.0.0')).toBe('DRIFT_STALE_PKG');
  });
  test('DRIFT_UNEXPECTED when VERSION matches base but pkg diverges (manual edit)', () => {
    expect(classifyState('1.1.0.0', '1.1.0.0', true, '1.2.0.0')).toBe('DRIFT_UNEXPECTED');
  });
});

describe('VERSION_RE', () => {
  test('accepts 4-digit semver', () => {
    expect(VERSION_RE.test('1.2.3.4')).toBe(true);
  });
  test('rejects 3-digit and garbage', () => {
    expect(VERSION_RE.test('1.2.3')).toBe(false);
    expect(VERSION_RE.test('v1.2.3.4')).toBe(false);
    expect(VERSION_RE.test('1.2.3.4-rc')).toBe(false);
  });
});

describe('write (FRESH bump)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-write-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('writes VERSION + package.json.version, preserving other pkg fields', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0', scripts: { t: 'y' } }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: false });
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('1.1.0.0');
    expect(pkg.scripts).toEqual({ t: 'y' }); // untouched
  });

  test('rejects a malformed version with exit 2', () => {
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.2.3'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });

  test('VERSION-only repo (no package.json) writes just VERSION', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-noPkg-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '0.1.0.0\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '0.2.0.0'], { cwd: d2 }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '0.2.0.0', packageJson: false, packageLock: false });
    expect(fs.readFileSync(path.join(d2, 'VERSION'), 'utf-8').trim()).toBe('0.2.0.0');
    fs.rmSync(d2, { recursive: true, force: true });
  });
});

describe('repair (DRIFT_STALE_PKG)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-repair-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('syncs package.json.version up to VERSION, no re-bump', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'repair'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ repaired: '2.0.0.0', packageLock: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('2.0.0.0');
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim()).toBe('2.0.0.0'); // unchanged
  });

  test('refuses to propagate an invalid VERSION (exit 2)', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), 'not-a-version\n');
    let code = 0;
    try { execFileSync('bun', [BIN, 'repair'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });
});

describe('package-lock.json sync', () => {
  // lockfileVersion 3 stores the version in two places: top-level `version`
  // and packages[""].version. Both must move together or `npm ci` warns.
  const mkLock = (dir: string, version: string) =>
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'x', version, lockfileVersion: 3, packages: { '': { name: 'x', version } } }, null, 2) + '\n',
    );

  test('write syncs lockfile root + packages[""] version, reports packageLock: true', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-write-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    mkLock(d, '1.0.0.0');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: true });
    const lock = JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8'));
    expect(lock.version).toBe('1.1.0.0');
    expect(lock.packages[''].version).toBe('1.1.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('repair syncs lockfile up to VERSION, reports packageLock: true', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-repair-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    mkLock(d, '1.9.0.0');
    const out = execFileSync('bun', [BIN, 'repair'], { cwd: d }).toString();
    expect(JSON.parse(out)).toEqual({ repaired: '2.0.0.0', packageLock: true });
    const lock = JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8'));
    expect(lock.version).toBe('2.0.0.0');
    expect(lock.packages[''].version).toBe('2.0.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('malformed package-lock.json fails write with exit 2', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-bad-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{ not valid json');
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
    fs.rmSync(d, { recursive: true, force: true });
  });

  // The lockfile is parsed in a preflight, before VERSION or package.json are
  // touched. Without it, a malformed lockfile exits 2 having already bumped both —
  // the caller is left with three files disagreeing and no state that classify()
  // can name. These two lock the "nothing written" half of that guarantee.
  test('malformed package-lock.json leaves VERSION + package.json untouched on write', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-atomic-write-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{ not valid json');
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
    expect(fs.readFileSync(path.join(d, 'VERSION'), 'utf-8').trim()).toBe('1.0.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf-8')).version).toBe('1.0.0.0');
    expect(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8')).toBe('{ not valid json');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('malformed package-lock.json leaves package.json untouched on repair', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-atomic-repair-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{ not valid json');
    let code = 0;
    try { execFileSync('bun', [BIN, 'repair'], { cwd: d, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf-8')).version).toBe('1.9.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('non-object package-lock.json fails write with exit 2, nothing written', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-nonobj-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    // Valid JSON, but not an object — assigning .version to it would throw.
    fs.writeFileSync(path.join(d, 'package-lock.json'), '[]');
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
    expect(fs.readFileSync(path.join(d, 'VERSION'), 'utf-8').trim()).toBe('1.0.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  // A corrupt lockfile can put anything at packages[""]. A truthy primitive there
  // throws on property assignment under strict mode; the sync must degrade to
  // "update what I can" rather than crash out with a stack trace.
  test('unusable packages[""] degrades to a top-level-only sync, no crash', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-badpkgs-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(
      path.join(d, 'package-lock.json'),
      JSON.stringify({ name: 'x', version: '1.0.0.0', lockfileVersion: 3, packages: { '': 5 } }, null, 2) + '\n',
    );
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: true });
    const lock = JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8'));
    expect(lock.version).toBe('1.1.0.0');
    expect(lock.packages['']).toBe(5); // left alone, not crashed on
    fs.rmSync(d, { recursive: true, force: true });
  });

  // The yarn/pnpm/bun (and no-JS) path: absence is a silent skip, never an error
  // and never a created file. We only sync a lockfile that already exists; we never
  // bring one into being.
  test('write silently skips when no package-lock.json exists', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-absent-write-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '1.1.0.0', packageJson: true, packageLock: false });
    expect(fs.existsSync(path.join(d, 'package-lock.json'))).toBe(false);
    expect(fs.readFileSync(path.join(d, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('repair silently skips when no package-lock.json exists', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-absent-repair-'));
    fs.writeFileSync(path.join(d, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'repair'], { cwd: d }).toString();
    expect(JSON.parse(out)).toEqual({ repaired: '2.0.0.0', packageLock: false });
    expect(fs.existsSync(path.join(d, 'package-lock.json'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('classify (idempotency over a real git base)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-classify-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  // Build a tiny repo with an "origin/main" carrying VERSION=1.0.0.0.
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  // Fake an "origin/main" remote-tracking ref pointing at this commit.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');

  test('reports FRESH before any bump', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    expect(JSON.parse(out).state).toBe('FRESH');
  });

  test('reports ALREADY_BUMPED after VERSION+pkg move together', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.1.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0.0' }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('ALREADY_BUMPED');
    expect(parsed.baseVersion).toBe('1.0.0.0');
    expect(parsed.currentVersion).toBe('1.1.0.0');
  });
});
