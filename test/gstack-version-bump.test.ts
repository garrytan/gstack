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
  test('accepts 3-digit semver too (#2501)', () => {
    // A repo whose pinned version source is a package.json holds plain
    // 3-digit semver. Rejecting it meant /ship could not write a version in
    // such a repo at all.
    expect(VERSION_RE.test('1.2.3')).toBe(true);
    expect(VERSION_RE.test('0.99.2')).toBe(true);
  });
  test('rejects garbage', () => {
    expect(VERSION_RE.test('1.2')).toBe(false);
    expect(VERSION_RE.test('v1.2.3.4')).toBe(false);
    expect(VERSION_RE.test('1.2.3.4-rc')).toBe(false);
    expect(VERSION_RE.test('1.2.3.4.5')).toBe(false);
  });
});

describe('write (FRESH bump)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-write-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('writes VERSION + package.json.version, preserving other pkg fields', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0', scripts: { t: 'y' } }, null, 2) + '\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({
      wrote: '1.1.0.0', packageJson: true, packageJsonPath: 'package.json',
      packageJsonVersion: '1.1.0', packageLock: false, agentsDigest: null,
    });
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    // Decision 11: the manifest carries the npm-valid 3-digit translation;
    // VERSION keeps the 4-digit form and stays the source of truth.
    expect(pkg.version).toBe('1.1.0');
    expect(pkg.scripts).toEqual({ t: 'y' }); // untouched
  });

  test('rejects a malformed version with exit 2', () => {
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.2.3.4.5'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });

  test('VERSION-only repo (no package.json) writes just VERSION', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-noPkg-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '0.1.0.0\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '0.2.0.0'], { cwd: d2 }).toString();
    expect(JSON.parse(out)).toEqual({
      wrote: '0.2.0.0', packageJson: false, packageJsonPath: null,
      packageJsonVersion: null, packageLock: false, agentsDigest: null,
    });
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
    expect(JSON.parse(out)).toEqual({
      repaired: '2.0.0.0', packageJsonPath: 'package.json', packageJsonVersion: '2.0.0',
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('2.0.0');
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

describe('write/repair sync npm lockfiles (both version fields, #2567)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-lock-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const lock = (v: string) => JSON.stringify({
    name: 'x', version: v, lockfileVersion: 3,
    packages: { '': { name: 'x', version: v }, 'node_modules/a': { version: '9.9.9' } },
  }, null, 2) + '\n';

  test('write updates top-level version and packages[""].version, leaves deps alone', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock('1.0.0'));
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({
      wrote: '1.1.0.0', packageJson: true, packageJsonPath: 'package.json',
      packageJsonVersion: '1.1.0', packageLock: true, agentsDigest: null,
    });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('1.1.0');
    expect(l.packages[''].version).toBe('1.1.0');
    expect(l.packages['node_modules/a'].version).toBe('9.9.9'); // untouched
  });

  test('repair heals a stale lockfile alongside package.json', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock('1.9.0'));
    execFileSync('bun', [BIN, 'repair'], { cwd: dir });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('2.0.0');
    expect(l.packages[''].version).toBe('2.0.0');
  });

  test('lockfileVersion 1 (no packages map) syncs top-level only, no crash', () => {
    fs.writeFileSync(path.join(dir, 'VERSION'), '3.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.9.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '2.9.0', lockfileVersion: 1 }, null, 2) + '\n');
    execFileSync('bun', [BIN, 'repair'], { cwd: dir });
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8'));
    expect(l.version).toBe('3.0.0');
    expect(l.packages).toBeUndefined();
  });

  test('npm-shrinkwrap.json is synced too when present (never created)', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-shrink-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d2, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d2, 'npm-shrinkwrap.json'), lock('1.0.0').replace('package-lock', 'npm-shrinkwrap'));
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d2 }).toString();
    expect(JSON.parse(out).packageLock).toBe(true);
    const l = JSON.parse(fs.readFileSync(path.join(d2, 'npm-shrinkwrap.json'), 'utf-8'));
    expect(l.version).toBe('1.1.0');
    expect(l.packages[''].version).toBe('1.1.0');
    // No package-lock.json invented alongside it.
    expect(fs.existsSync(path.join(d2, 'package-lock.json'))).toBe(false);
    fs.rmSync(d2, { recursive: true, force: true });
  });

  test('malformed lockfile fails the write with exit 3 (half-write is loud, not silent)', () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-badlock-'));
    fs.writeFileSync(path.join(d3, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d3, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d3, 'package-lock.json'), '{ not json');
    let code = 0;
    try { execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: d3, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(3);
    // VERSION was written before the failure — exactly the half-write the
    // exit-3 contract exists to surface.
    expect(fs.readFileSync(path.join(d3, 'VERSION'), 'utf-8').trim()).toBe('1.1.0.0');
    fs.rmSync(d3, { recursive: true, force: true });
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

/**
 * A repo whose single source of truth is a package.json at a non-root path,
 * holding plain 3-digit semver — the shape gstack's native VERSION-file
 * assumption failed closed on (#2501). Before this, classify reported
 * {state: FRESH, baseVersion: "0.0.0.0", pkgExists: false} no matter what the
 * repo's real version was: it looked for a root VERSION file and a root
 * package.json, found neither, and reported a pristine repo at version zero.
 *
 * These cases pass --version-path explicitly; the .gstack/version-path pin
 * flows through the same reader once classify/write/repair resolve the pin's
 * repo-relative form (#2462, covered in its own suite below the pin fix).
 */
describe('package.json as the version source (monorepo, 3-digit, #2501)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-pkgsrc-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const pkgRel = 'frontend/package.json';
  const pkgAbs = path.join(dir, pkgRel);
  fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  fs.writeFileSync(pkgAbs, JSON.stringify({ name: 'frontend', version: '0.99.2', private: true, scripts: { dev: 'next dev' } }, null, 2) + '\n');

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'v0.99.2 base'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');

  test('classify reads the real version from the package.json version-path', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main', '--version-path', pkgRel], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('FRESH');
    expect(parsed.baseVersion).toBe('0.99.2');    // was "0.0.0.0"
    expect(parsed.currentVersion).toBe('0.99.2'); // was "0.0.0.0"
    expect(parsed.pkgExists).toBe(true);          // was false
  });

  test('write updates the package.json in place and creates no VERSION file', () => {
    const out = execFileSync('bun', [BIN, 'write', '--version', '0.99.3', '--version-path', pkgRel], { cwd: dir }).toString();
    expect(JSON.parse(out)).toEqual({ wrote: '0.99.3', versionPath: pkgRel, packageJson: true, packageLock: false, agentsDigest: null });
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf-8'));
    expect(pkg.version).toBe('0.99.3');
    expect(pkg.scripts).toEqual({ dev: 'next dev' }); // rest of the file untouched
    expect(pkg.name).toBe('frontend');
    expect(fs.existsSync(path.join(dir, 'VERSION'))).toBe(false);
  });

  test('classify reports ALREADY_BUMPED after that write, not a drift state', () => {
    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main', '--version-path', pkgRel], { cwd: dir }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe('ALREADY_BUMPED');
    expect(parsed.baseVersion).toBe('0.99.2');
    expect(parsed.currentVersion).toBe('0.99.3');
  });

  test('repair is a no-op: there is no second file to drift from', () => {
    const out = execFileSync('bun', [BIN, 'repair', '--version-path', pkgRel], { cwd: dir }).toString();
    expect(JSON.parse(out).repaired).toBeNull();
  });

  test('write refuses a version-path that does not exist', () => {
    let code = 0;
    try {
      execFileSync('bun', [BIN, 'write', '--version', '1.0.0', '--version-path', 'nope/package.json'], { cwd: dir, stdio: 'pipe' });
    } catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });
});

/**
 * #2462: cmdClassify's current-version read resolved the .gstack/version-path
 * pin, but versionRel — the repo-relative path fed to `git show
 * origin/<base>:<path>` — came from the CLI flag alone. In a pinned repo with
 * no --version-path flag, base and current therefore read DIFFERENT files:
 * current from the pin, base from the root VERSION (which may not exist, so
 * base always read 0.0.0.0 and every branch looked FRESH). The pin's
 * repo-relative form now drives all three subcommands.
 */
describe('.gstack/version-path pin, no --version-path flag (#2462)', () => {
  const mkPinned = (pinRel: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-pin-'));
    fs.mkdirSync(path.dirname(path.join(d, pinRel)), { recursive: true });
    fs.mkdirSync(path.join(d, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(d, '.gstack', 'version-path'), pinRel + '\n');
    return d;
  };

  const commitBase = (d: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: d });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
    fs.mkdirSync(path.join(d, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');
  };

  test('classify reads base AND current from the SAME pinned plain-text file', () => {
    const pinRel = 'sub/VERSION';
    const d = mkPinned(pinRel);
    fs.writeFileSync(path.join(d, pinRel), '1.4.0.0\n');
    commitBase(d);
    // Move the pinned file past base — NO root VERSION file exists at all.
    fs.writeFileSync(path.join(d, pinRel), '1.5.0.0\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: d }).toString());
    // Before the fix: baseVersion read root VERSION → "0.0.0.0" and the
    // branch misclassified as... current 1.5.0.0 vs base 0.0.0.0. The REAL
    // base is the pinned file's committed value.
    expect(out.baseVersion).toBe('1.4.0.0');
    expect(out.currentVersion).toBe('1.5.0.0');
    expect(out.state).toBe('ALREADY_BUMPED');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('classify engages the pinned package.json JSON handling without a flag', () => {
    const pinRel = 'frontend/package.json';
    const d = mkPinned(pinRel);
    fs.writeFileSync(path.join(d, pinRel), JSON.stringify({ name: 'f', version: '0.99.2' }, null, 2) + '\n');
    commitBase(d);
    const out = JSON.parse(execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: d }).toString());
    // Before the fix: versionRel="VERSION" → the pinned JSON was read as raw
    // text → currentVersion "0.0.0.0", pkgExists false, base from a
    // nonexistent root VERSION.
    expect(out.state).toBe('FRESH');
    expect(out.baseVersion).toBe('0.99.2');
    expect(out.currentVersion).toBe('0.99.2');
    expect(out.pkgExists).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('write honors the pin: updates the pinned package.json in place, no root VERSION invented', () => {
    const pinRel = 'frontend/package.json';
    const d = mkPinned(pinRel);
    fs.writeFileSync(path.join(d, pinRel), JSON.stringify({ name: 'f', version: '0.99.2' }, null, 2) + '\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'write', '--version', '0.99.3'], { cwd: d }).toString());
    expect(out).toEqual({ wrote: '0.99.3', versionPath: pinRel, packageJson: true, packageLock: false, agentsDigest: null });
    expect(JSON.parse(fs.readFileSync(path.join(d, pinRel), 'utf-8')).version).toBe('0.99.3');
    // Before the fix, write treated versionRel as "VERSION" and overwrote the
    // pinned JSON file with a bare "0.99.3\n", destroying the manifest.
    expect(fs.existsSync(path.join(d, 'VERSION'))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('repair honors the pin: pinned package.json is a no-op single source', () => {
    const pinRel = 'frontend/package.json';
    const d = mkPinned(pinRel);
    fs.writeFileSync(path.join(d, pinRel), JSON.stringify({ name: 'f', version: '0.99.2' }, null, 2) + '\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'repair'], { cwd: d }).toString());
    expect(out.repaired).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('--version-path flag still overrides the pin', () => {
    const d = mkPinned('sub/VERSION');
    fs.writeFileSync(path.join(d, 'sub', 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(d, 'OTHER_VERSION'), '2.0.0.0\n');
    commitBase(d);
    const out = JSON.parse(
      execFileSync('bun', [BIN, 'classify', '--base', 'main', '--version-path', 'OTHER_VERSION'], { cwd: d }).toString(),
    );
    expect(out.currentVersion).toBe('2.0.0.0');
    expect(out.baseVersion).toBe('2.0.0.0');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('subdirectory manifest (no root package.json, #2531)', () => {
  /**
   * The layout this tool used to silently no-op on: the only Node package
   * lives in web/, so join(cwd, "package.json") missed it, classify said
   * pkgExists:false, and write touched VERSION alone — leaving the manifest
   * to be bumped by hand every release.
   */
  const mk = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-subdir-'));
    fs.mkdirSync(path.join(d, 'web'));
    fs.mkdirSync(path.join(d, '.gstack'));
    fs.writeFileSync(path.join(d, '.gstack', 'package-json-path'), 'web/package.json\n');
    fs.writeFileSync(path.join(d, 'VERSION'), '0.1.0.0\n');
    return d;
  };

  test('write finds a pinned manifest and bumps it (npm-valid form)', () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'web', 'package.json'),
      JSON.stringify({ name: 'w', version: '0.1.0' }, null, 2) + '\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'write', '--version', '0.2.0.0'], { cwd: d }).toString());
    expect(out.packageJson).toBe(true);
    expect(out.packageJsonPath).toBe('web/package.json');
    expect(out.packageJsonVersion).toBe('0.2.0');
    expect(JSON.parse(fs.readFileSync(path.join(d, 'web', 'package.json'), 'utf-8')).version).toBe('0.2.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('--package-json-path overrides the pin', () => {
    const d = mk();
    fs.mkdirSync(path.join(d, 'app'));
    fs.writeFileSync(path.join(d, 'web', 'package.json'), JSON.stringify({ version: '0.1.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(d, 'app', 'package.json'), JSON.stringify({ version: '0.1.0' }, null, 2) + '\n');
    const out = JSON.parse(execFileSync('bun',
      [BIN, 'write', '--version', '0.3.0.0', '--package-json-path', 'app/package.json'], { cwd: d }).toString());
    expect(out.packageJsonPath).toBe('app/package.json');
    expect(JSON.parse(fs.readFileSync(path.join(d, 'app', 'package.json'), 'utf-8')).version).toBe('0.3.0');
    // the pinned one is untouched
    expect(JSON.parse(fs.readFileSync(path.join(d, 'web', 'package.json'), 'utf-8')).version).toBe('0.1.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('classify reads the pinned manifest and judges drift on the translated form', () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'web', 'package.json'),
      JSON.stringify({ name: 'w', version: '0.1.0' }, null, 2) + '\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: d });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
    fs.mkdirSync(path.join(d, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');

    const out = JSON.parse(execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: d }).toString());
    // 0.1.0 IS the npm-valid translation of 0.1.0.0 — in sync, no drift.
    expect(out.state).toBe('FRESH');
    expect(out.pkgExists).toBe(true);
    expect(out.pkgPath).toBe('web/package.json');
    expect(out.expectedPkgVersion).toBe('0.1.0');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('repair syncs the pinned manifest to the npm-valid form', () => {
    const d = mk();
    fs.writeFileSync(path.join(d, 'web', 'package.json'),
      JSON.stringify({ name: 'w', version: '0.0.9' }, null, 2) + '\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'repair'], { cwd: d }).toString());
    expect(out).toEqual({ repaired: '0.1.0.0', packageJsonPath: 'web/package.json', packageJsonVersion: '0.1.0' });
    expect(JSON.parse(fs.readFileSync(path.join(d, 'web', 'package.json'), 'utf-8')).version).toBe('0.1.0');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('npm-valid drift contract (decision 11)', () => {
  test('a correctly-synced 3-component manifest is NOT read as drift', () => {
    // Without the translation-aware comparison, 0.1.25 vs 0.1.25.0 reads as
    // DRIFT forever and every classify returns a false positive.
    expect(classifyState('0.1.25.0', '0.1.24.0', true, '0.1.25', '0.1.25')).toBe('ALREADY_BUMPED');
    expect(classifyState('0.1.25.0', '0.1.25.0', true, '0.1.25', '0.1.25')).toBe('FRESH');
  });

  test('the pre-v1.67 1:1 four-digit mirror is grandfathered as in-sync', () => {
    // Existing installs still carry package.json 1.66.0.0 next to VERSION
    // 1.66.0.0. Flagging that as DRIFT_UNEXPECTED would hard-stop /ship on
    // every repo on upgrade day; the next write migrates the manifest to the
    // translated form instead.
    expect(classifyState('1.66.0.0', '1.65.0.0', true, '1.66.0.0', '1.66.0')).toBe('ALREADY_BUMPED');
    expect(classifyState('1.66.0.0', '1.66.0.0', true, '1.66.0.0', '1.66.0')).toBe('FRESH');
  });

  test('a genuinely diverged manifest still reads as drift', () => {
    expect(classifyState('1.67.0.0', '1.66.0.0', true, '1.66.0', '1.67.0')).toBe('DRIFT_STALE_PKG');
    expect(classifyState('1.66.0.0', '1.66.0.0', true, '9.9.9', '1.66.0')).toBe('DRIFT_UNEXPECTED');
  });
});

describe('path containment: pins and flags cannot escape the repo', () => {
  // .gstack/version-path and .gstack/package-json-path are repo-controlled
  // content. A cloned repo pinning '../../victim.json' — or an in-repo
  // symlink pointing outside — must never turn a bump into an arbitrary
  // file overwrite outside the repository.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-contain-'));
  const dir = path.join(outer, 'repo');
  const victim = path.join(outer, 'victim.json');
  afterAll(() => { try { fs.rmSync(outer, { recursive: true, force: true }); } catch { /* noop */ } });

  function runFail(args: string[]): { code: number; stderr: string } {
    try {
      execFileSync('bun', [BIN, ...args], { cwd: dir, stdio: 'pipe' });
      return { code: 0, stderr: '' };
    } catch (e: any) {
      return { code: e.status, stderr: (e.stderr || '').toString() };
    }
  }

  function resetRepo() {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(victim, JSON.stringify({ version: '9.9.9' }, null, 2) + '\n');
  }

  test('a ../ escape in .gstack/version-path fails exit 2 and writes nothing', () => {
    resetRepo();
    fs.writeFileSync(path.join(dir, '.gstack', 'version-path'), '../victim.json\n');
    const r = runFail(['write', '--version', '1.1.0.0']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('outside the repository');
    expect(JSON.parse(fs.readFileSync(victim, 'utf-8')).version).toBe('9.9.9');
  });

  test('an absolute path in .gstack/package-json-path fails exit 2', () => {
    resetRepo();
    fs.writeFileSync(path.join(dir, '.gstack', 'package-json-path'), victim + '\n');
    const r = runFail(['write', '--version', '1.1.0.0']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('outside the repository');
    expect(JSON.parse(fs.readFileSync(victim, 'utf-8')).version).toBe('9.9.9');
  });

  test('an in-repo symlink pointing outside fails exit 2 and never follows', () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges there
    resetRepo();
    fs.symlinkSync(victim, path.join(dir, 'link.json'));
    fs.writeFileSync(path.join(dir, '.gstack', 'version-path'), 'link.json\n');
    const r = runFail(['write', '--version', '1.1.0.0']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('outside the repository');
    expect(JSON.parse(fs.readFileSync(victim, 'utf-8')).version).toBe('9.9.9');
  });

  test('classify refuses the same escapes (no read outside the repo)', () => {
    resetRepo();
    fs.writeFileSync(path.join(dir, '.gstack', 'version-path'), '../victim.json\n');
    const r = runFail(['classify', '--base', 'main']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('outside the repository');
  });

  test('a lockfile symlinked outside the repo is skipped with a warning, not written', () => {
    if (process.platform === 'win32') return;
    resetRepo();
    const outerLock = path.join(outer, 'outer-lock.json');
    fs.writeFileSync(outerLock, JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    fs.symlinkSync(outerLock, path.join(dir, 'package-lock.json'));
    const res = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir, stdio: 'pipe' });
    expect(JSON.parse(res.toString()).packageLock).toBe(false);
    expect(JSON.parse(fs.readFileSync(outerLock, 'utf-8')).version).toBe('1.0.0');
  });

  test('legitimate subdirectory pins still work (containment is not over-broad)', () => {
    resetRepo();
    fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'frontend', 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, '.gstack', 'version-path'), 'frontend/package.json\n');
    const out = execFileSync('bun', [BIN, 'write', '--version', '1.1.0'], { cwd: dir }).toString();
    expect(JSON.parse(out).wrote).toBe('1.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'frontend', 'package.json'), 'utf-8')).version).toBe('1.1.0');
  });
});

describe('#2600: repair must not write fabricated 0.0.0.0 when VERSION is missing', () => {
  // Per-test dirs: the tests assert both "VERSION absent" and "VERSION
  // present" states, so a shared dir made them order-dependent (test 1's
  // absence assertion only held because test 2 hadn't run yet).
  const dirs: string[] = [];
  const makeDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-2600-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  });

  test('repair fails with exit 2 when VERSION file does not exist', () => {
    const dir = makeDir();
    // Set up: package.json exists with version 0.1.0.0, but no VERSION file
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0.0' }, null, 2) + '\n');
    // VERSION file deliberately absent
    expect(fs.existsSync(path.join(dir, 'VERSION'))).toBe(false);

    let code = 0;
    let stderr = '';
    try {
      execFileSync('bun', [BIN, 'repair'], { cwd: dir, stdio: 'pipe' });
    } catch (e: any) {
      code = e.status;
      stderr = (e.stderr || '').toString();
    }

    // Should fail, not succeed
    expect(code).toBe(2);
    expect(stderr).toContain('VERSION file not found');
    // package.json must NOT be modified
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('0.1.0.0');
  });

  test('repair works normally when VERSION file exists', () => {
    const dir = makeDir();
    // Set up: both VERSION and package.json exist, with drift
    fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.9.0' }, null, 2) + '\n');

    const out = execFileSync('bun', [BIN, 'repair'], { cwd: dir }).toString();
    const result = JSON.parse(out);

    expect(result.repaired).toBe('2.0.0.0');
    expect(result.packageJsonVersion).toBe('2.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('2.0.0');
  });

  test('repair refuses to propagate a fabricated version when VERSION file is empty (#2600)', () => {
    const dir = makeDir();
    // VERSION exists but is empty — readVersionFile folds this into DEFAULT ("0.0.0.0").
    // Without the `current === DEFAULT` guard, this would write 0.0.0 into package.json.
    fs.writeFileSync(path.join(dir, 'VERSION'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }, null, 2) + '\n');

    let code = 0;
    let stderr = '';
    try {
      execFileSync('bun', [BIN, 'repair'], { cwd: dir, stdio: 'pipe' });
    } catch (e: any) {
      code = e.status;
      stderr = (e.stderr || '').toString();
    }

    expect(code).toBe(2);
    expect(stderr).toContain('empty or contains no parsable version');
    // package.json must NOT be modified
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('0.5.0');
  });

  test('repair proceeds when VERSION genuinely reads 0.0.0.0 (a real file, not the sentinel)', () => {
    // current === DEFAULT is ambiguous: it is BOTH the missing/unparseable
    // sentinel AND a legitimate literal "0.0.0.0" in a brand-new repo. The
    // guard now disambiguates on the raw bytes — a real 0.0.0.0 repairs
    // package.json to the npm-valid 0.0.0.
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }, null, 2) + '\n');

    const out = execFileSync('bun', [BIN, 'repair'], { cwd: dir }).toString();
    const result = JSON.parse(out);
    expect(result.repaired).toBe('0.0.0.0');
    expect(result.packageJsonVersion).toBe('0.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('0.0.0');
  });

  test('repair still rejects whitespace-only VERSION content (sentinel path, not a real version)', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'VERSION'), '   \n\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }, null, 2) + '\n');

    let code = 0;
    try { execFileSync('bun', [BIN, 'repair'], { cwd: dir, stdio: 'pipe' }); }
    catch (e: any) { code = e.status; }
    expect(code).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version).toBe('0.5.0');
  });

  test('repair reproduces the exact issue scenario: VERSION in root, package.json in app/ (#2600)', () => {
    // The exact layout from the issue: VERSION at repo root, package.json in app/
    // Running repair from app/ cwd with no VERSION there used to write 0.0.0.0 into app/package.json.
    const rootDir = makeDir();

    fs.mkdirSync(path.join(rootDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'VERSION'), '0.2.0.0\n');
    fs.writeFileSync(path.join(rootDir, 'app', 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0.0' }, null, 2) + '\n');

    // Run from app/ — no VERSION in cwd, readVersionFile would fold to 0.0.0.0
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bun', [BIN, 'repair'], { cwd: path.join(rootDir, 'app'), stdio: 'pipe' });
    } catch (e: any) {
      code = e.status;
      stderr = (e.stderr || '').toString();
    }

    expect(code).toBe(2);
    expect(stderr).toContain('VERSION file not found');
    // app/package.json must NOT be modified
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, 'app', 'package.json'), 'utf-8')).version).toBe('0.1.0.0');
  });
});

describe('#2600: classify must surface versionFileExists=false when VERSION is missing', () => {
  // Per-test dirs: one test asserts VERSION absent, the other creates it — a
  // shared dir made them order-dependent. Each test builds its own repo.
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  });

  /** Minimal git repo (no VERSION committed) so classify can resolve base. */
  function makeRepoDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-2600-classify-'));
    dirs.push(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    // Commit with no VERSION file
    fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), head + '\n');
    return dir;
  }

  test('classify reports versionFileExists=false when VERSION is absent', () => {
    const dir = makeRepoDir();
    // No package.json: pkgExists=false, pkgAgrees=true, current===base → FRESH.
    // (A package.json with a non-zero version would cause DRIFT_UNEXPECTED.)

    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    const result = JSON.parse(out);

    expect(result.versionFileExists).toBe(false);
    expect(result.currentVersion).toBe('0.0.0.0'); // fabricated default
    expect(result.state).toBe('FRESH'); // base also reads 0.0.0.0, no pkg drift
  });

  test('classify reports versionFileExists=true when VERSION is present', () => {
    const dir = makeRepoDir();
    // Create VERSION AND sync package.json so pkgAgrees=true → ALREADY_BUMPED.
    fs.writeFileSync(path.join(dir, 'VERSION'), '0.2.0.0\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0.0' }, null, 2) + '\n');

    const out = execFileSync('bun', [BIN, 'classify', '--base', 'main'], { cwd: dir }).toString();
    const result = JSON.parse(out);

    expect(result.versionFileExists).toBe(true);
    expect(result.currentVersion).toBe('0.2.0.0');
    expect(result.state).toBe('ALREADY_BUMPED'); // base is 0.0.0.0, current is 0.2.0.0, pkg in sync
  });
});

describe('write --regen-digest regenerates the gstack agents digest (explicit opt-in)', () => {
  // The committed agents-digest/gstack-AGENTS.md embeds VERSION in its first
  // line and is byte-freshness-gated (test/agents-digest.test.ts + the Skill
  // Docs Freshness CI check). The write that changes VERSION must regenerate
  // it in the same mutation or every release commit of THIS repo goes red.
  // The regen runs the TARGET repo's generator, which is code execution —
  // hence the explicit flag: a plain `write` in a hostile clone must never
  // execute repo files it merely finds on disk.
  const stubGenerator = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents-digest'), { recursive: true });
    // Stub with the same shape as scripts/gen-agents-digest.ts: read VERSION,
    // write the version-stamped digest.
    fs.writeFileSync(path.join(dir, 'scripts', 'gen-agents-digest.ts'), [
      "import * as fs from 'fs';",
      "import * as path from 'path';",
      "const root = path.resolve(import.meta.dir, '..');",
      "const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf-8').trim();",
      "fs.writeFileSync(path.join(root, 'agents-digest', 'gstack-AGENTS.md'), `# gstack digest v${v}\\n`);",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'agents-digest', 'gstack-AGENTS.md'), '# gstack digest v1.0.0.0\n');
  };

  test('with the flag: a repo with the generator + committed digest gets a fresh digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-digest-'));
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    stubGenerator(dir);
    const out = JSON.parse(execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0', '--regen-digest'], { cwd: dir }).toString());
    expect(out.agentsDigest).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'agents-digest', 'gstack-AGENTS.md'), 'utf-8'))
      .toBe('# gstack digest v1.1.0.0\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('WITHOUT the flag: the generator is never executed, even when present (no presence-sniffed code exec)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-digest-noflag-'));
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
    stubGenerator(dir);
    const out = JSON.parse(execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0'], { cwd: dir }).toString());
    expect(out.agentsDigest).toBe(null);
    // Digest untouched — the stub would have stamped v1.1.0.0 had it run.
    expect(fs.readFileSync(path.join(dir, 'agents-digest', 'gstack-AGENTS.md'), 'utf-8'))
      .toBe('# gstack digest v1.0.0.0\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a generator failure warns and reports agentsDigest:false without failing the bump', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-digest-fail-'));
    fs.writeFileSync(path.join(d2, 'VERSION'), '1.0.0.0\n');
    fs.mkdirSync(path.join(d2, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(d2, 'agents-digest'), { recursive: true });
    fs.writeFileSync(path.join(d2, 'scripts', 'gen-agents-digest.ts'), 'process.exit(1);\n');
    fs.writeFileSync(path.join(d2, 'agents-digest', 'gstack-AGENTS.md'), '# gstack digest v1.0.0.0\n');

    const res = execFileSync('bun', [BIN, 'write', '--version', '1.1.0.0', '--regen-digest'], { cwd: d2, stdio: 'pipe' });
    const out = JSON.parse(res.toString());
    expect(out.wrote).toBe('1.1.0.0'); // the bump itself still lands
    expect(out.agentsDigest).toBe(false);
    fs.rmSync(d2, { recursive: true, force: true });
  });

  test('the REAL generator round-trips a bump: write --regen-digest restamps the digest first line', () => {
    // Not a stub: copy the actual generator + digest into a temp repo, bump
    // it, and confirm the regenerated first line tracks the new VERSION.
    const root = path.join(import.meta.dir, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-digest-real-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents-digest'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'scripts', 'gen-agents-digest.ts'),
      path.join(dir, 'scripts', 'gen-agents-digest.ts'),
    );
    fs.copyFileSync(
      path.join(root, 'agents-digest', 'gstack-AGENTS.md'),
      path.join(dir, 'agents-digest', 'gstack-AGENTS.md'),
    );
    fs.writeFileSync(path.join(dir, 'VERSION'), '9.9.9.9\n');
    const out = JSON.parse(execFileSync('bun', [BIN, 'write', '--version', '9.9.10.0', '--regen-digest'], { cwd: dir }).toString());
    expect(out.agentsDigest).toBe(true);
    const first = fs.readFileSync(path.join(dir, 'agents-digest', 'gstack-AGENTS.md'), 'utf-8').split('\n')[0];
    expect(first).toContain('v9.9.10.0');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
