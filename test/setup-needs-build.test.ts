/**
 * setup: the NEEDS_BUILD decision ("# 1. Build browse binary if needed").
 *
 * Direct `bun run build` produces every binary. Setup includes CSO when its
 * host capability probe succeeds, and otherwise builds the general binaries
 * while removing CSO artifacts so /cso fails closed. Before,
 * only the browse binary's existence was checked and lib/ was not in the
 * staleness set: a missing design/dist/design or make-pdf/dist/pdf, or an edit
 * to lib/ (the canonical claude-bin / error-handling / aside-render sources the
 * binaries embed), left setup reporting "up to date" with binaries that could
 * not run or that embedded stale code.
 *
 * Behavior fixture, following test/setup-browser-hint.test.ts: slice the
 * decision block out of setup between two stable anchors, prepend a prelude
 * that defines the variables it reads, run it against a temp tree whose mtimes
 * are set explicitly, and read NEEDS_BUILD back.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBashScript } from './helpers/bash-script';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const BUILD_SRC = fs.readFileSync(path.join(ROOT, 'scripts/build.sh'), 'utf-8');
const CSO_BUILD_SRC = fs.readFileSync(path.join(ROOT, 'scripts/build-cso.sh'), 'utf-8');

// From the $_EXE suffix derivation through the `fi` that closes the staleness
// chain. The statement that follows (the build itself) is the end anchor and is
// NOT included, so the harness never tries to run `bun run build`.
const BLOCK_START = '_EXE=""';
const BLOCK_END = '\nif [ "$NEEDS_BUILD" -eq 1 ]; then';
const CSO_SWITCH_START = 'if [ "${GSTACK_SETUP_RUNNING:-0}" = "1" ] && [ "${GSTACK_SETUP_SKIP_CSO_BUILD:-0}" = "1" ]; then';
const CSO_SWITCH_END = '\nbash browse/scripts/build-node-server.sh';

function needsBuildBlock(): string {
  const start = SETUP_SRC.indexOf(BLOCK_START);
  const end = SETUP_SRC.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) throw new Error(`Could not locate the NEEDS_BUILD block in setup (${BLOCK_START} .. ${BLOCK_END.trim()})`);
  return SETUP_SRC.slice(start, end + 1);
}

function csoBuildSwitchBlock(): string {
  const start = BUILD_SRC.indexOf(CSO_SWITCH_START);
  const end = BUILD_SRC.indexOf(CSO_SWITCH_END, start);
  if (start < 0 || end < 0) throw new Error('Could not locate the setup-private CSO build switch');
  return BUILD_SRC.slice(start, end);
}

// Fixed instants, far apart, so coarse filesystem timestamps and clock skew
// can never blur "older than the binary" into "newer".
const BIN_T = new Date('2024-06-01T12:00:00Z');
const STAMP_T = new Date('2024-07-01T12:00:00Z');
const OLD_T = new Date('2024-01-01T12:00:00Z');
const NEW_T = new Date('2024-12-01T12:00:00Z');

// One file per source root the staleness `find` walks, plus the two manifests.
const SOURCE_FILES = [
  'browse/src/index.ts',
  'make-pdf/src/x.ts',
  'design/src/index.ts',
  'lib/claude-bin.ts',
  'package.json',
  'bun.lock',
  'scripts/build.sh',
  'scripts/build-cso.sh',
  'scripts/build-cso-windows.ps1',
  'lib/cso/launcher.c',
];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeAt(file: string, t: Date, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, mode);
  fs.utimesSync(file, t, t);
}

/** A tree where every binary is present and executable at BIN_T and every
 *  source/manifest is OLDER than it: the "nothing to do" baseline. `exe` is
 *  the suffix for the design and pdf binaries (".exe" on Windows). The browse
 *  binary keeps its bare name in every case: the prelude's BROWSE_BIN names it
 *  directly (setup derives the .exe form outside this block). */
function makeTree(opts: { exe?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-needs-build-'));
  tmpDirs.push(dir);
  const exe = opts.exe ?? '';
  writeAt(path.join(dir, 'browse/dist/browse'), BIN_T, 0o755);
  writeAt(path.join(dir, `design/dist/design${exe}`), BIN_T, 0o755);
  writeAt(path.join(dir, `make-pdf/dist/pdf${exe}`), BIN_T, 0o755);
  writeAt(path.join(dir, `bin/gstack-cso-core${exe}`), BIN_T, 0o755);
  writeAt(path.join(dir, `bin/gstack-cso-launcher${exe}`), BIN_T, 0o755);
  const generation = path.join(dir, 'bin/.gstack-cso-generation');
  fs.writeFileSync(generation, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.utimesSync(generation, BIN_T, BIN_T);
  if (exe) {
    const generationLock = path.join(dir, 'bin/.gstack-cso-generation.lock');
    fs.writeFileSync(generationLock, '', { mode: 0o600 });
    fs.utimesSync(generationLock, BIN_T, BIN_T);
  }
  if (!exe) writeAt(path.join(dir, 'bin/gstack-cso-watchdog'), BIN_T, 0o755);
  for (const f of SOURCE_FILES) writeAt(path.join(dir, f), OLD_T);
  writeAt(path.join(dir, 'browse/dist/.build-complete'), STAMP_T);
  return dir;
}

function touchNewer(dir: string, rel: string): void {
  writeAt(path.join(dir, rel), NEW_T);
}

function decide(dir: string, opts: { isWindows?: '0' | '1'; csoAvailable?: '0' | '1' } = {}): number {
  const script = [
    'set -e',
    `SOURCE_GSTACK_DIR="${dir}"`,
    'BROWSE_BIN="$SOURCE_GSTACK_DIR/browse/dist/browse"',
    `IS_WINDOWS=${opts.isWindows ?? '0'}`,
    `CSO_BUILD_AVAILABLE=${opts.csoAvailable ?? '1'}`,
    needsBuildBlock(),
    'echo "NEEDS_BUILD=$NEEDS_BUILD"',
  ].join('\n');
  const r = runBashScript(script, { timeout: 10_000 });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  const m = r.stdout.match(/^NEEDS_BUILD=([01])$/m);
  if (!m) throw new Error(`no NEEDS_BUILD line in block output:\n${r.stdout}`);
  return Number(m[1]);
}

describe('setup: NEEDS_BUILD static invariants', () => {
  test('both anchors exist exactly once, so the slice is the decision block and nothing else', () => {
    expect(SETUP_SRC.indexOf(BLOCK_START)).toBeGreaterThan(-1);
    expect(SETUP_SRC.indexOf(BLOCK_START)).toBe(SETUP_SRC.lastIndexOf(BLOCK_START));
    expect(SETUP_SRC.indexOf(BLOCK_END)).toBeGreaterThan(SETUP_SRC.indexOf(BLOCK_START));
    expect(SETUP_SRC.indexOf(BLOCK_END)).toBe(SETUP_SRC.lastIndexOf(BLOCK_END));
    const block = needsBuildBlock();
    expect(block).toContain('NEEDS_BUILD=0');
    expect(block).toContain('NEEDS_BUILD=1');
    expect(block).not.toContain('bun_cmd run build');
  });

  test('all required binaries are existence-checked with -x and the $_EXE suffix', () => {
    const block = needsBuildBlock();
    expect(block).toContain('[ ! -x "$BROWSE_BIN" ]');
    expect(block).toContain('[ ! -x "$SOURCE_GSTACK_DIR/design/dist/design$_EXE" ]');
    expect(block).toContain('[ ! -x "$SOURCE_GSTACK_DIR/make-pdf/dist/pdf$_EXE" ]');
    expect(block).toContain('if [ "$IS_WINDOWS" -eq 1 ]; then _EXE=".exe"; fi');
    expect(block).toContain('if [ "$CSO_BUILD_AVAILABLE" -eq 1 ]; then');
  });

  test('setup owns the only CSO build escape hatch and probes Bun hardening flags', () => {
    for (const flag of ['dotenv', 'bunfig', 'tsconfig', 'package-json']) {
      expect(SETUP_SRC).toContain(`--no-compile-autoload-${flag}`);
    }
    expect(SETUP_SRC).toContain('probe_cso_build_prerequisites');
    expect(BUILD_SRC).toContain('[ "${GSTACK_SETUP_RUNNING:-0}" = "1" ]');
    expect(BUILD_SRC).toContain('[ "${GSTACK_SETUP_SKIP_CSO_BUILD:-0}" = "1" ]');
    expect(BUILD_SRC).toContain('BUN_CMD="$BUN_CMD" bash scripts/build-cso.sh');
  });

  test('the skip flag alone cannot weaken a direct build; setup can omit and purge CSO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cso-build-switch-'));
    tmpDirs.push(dir);
    for (const sub of ['bin', 'scripts']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const name of ['gstack-cso-launcher', 'gstack-cso-launcher.exe', 'gstack-cso-core', 'gstack-cso-core.exe', 'gstack-cso-watchdog']) {
      writeAt(path.join(dir, 'bin', name), BIN_T, 0o755);
    }
    const strict = path.join(dir, 'scripts/build-cso.sh');
    fs.writeFileSync(strict, '#!/bin/sh\nprintf called > cso-called\n');
    fs.chmodSync(strict, 0o755);

    let result = runBashScript(`set -e\n${csoBuildSwitchBlock()}`, {
      cwd: dir, env: { ...process.env, GSTACK_SETUP_SKIP_CSO_BUILD: '1' },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'cso-called'))).toBe(true);

    fs.unlinkSync(path.join(dir, 'cso-called'));
    result = runBashScript(`set -e\n${csoBuildSwitchBlock()}`, {
      cwd: dir, env: { ...process.env, GSTACK_SETUP_RUNNING: '1', GSTACK_SETUP_SKIP_CSO_BUILD: '1' },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'cso-called'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'bin')).filter(name => name.startsWith('gstack-cso-'))).toEqual([]);
  });

  test('the whole-build stamp is invalidated before compilation and published only after every output succeeds', () => {
    const invalidate = BUILD_SRC.indexOf('rm -f "$BUILD_STAMP" "$BUILD_STAMP_TMP"');
    const firstBuild = BUILD_SRC.indexOf('"$BUN_CMD" run vendor:xterm');
    const csoBuild = BUILD_SRC.indexOf('BUN_CMD="$BUN_CMD" bash scripts/build-cso.sh');
    const publish = BUILD_SRC.indexOf('mv -f "$BUILD_STAMP_TMP" "$BUILD_STAMP"');
    expect(invalidate).toBeGreaterThan(-1);
    expect(firstBuild).toBeGreaterThan(invalidate);
    expect(csoBuild).toBeGreaterThan(firstBuild);
    expect(publish).toBeGreaterThan(csoBuild);
    expect(BUILD_SRC.slice(publish + 1)).not.toContain('"$BUN_CMD" build');
    expect(CSO_BUILD_SRC).toContain('rm -f "$CSO_BUILD_ROOT/browse/dist/.build-complete"');
  });

  test('the staleness find walks every embedded source root, lib/ included', () => {
    const block = needsBuildBlock();
    for (const root of ['browse/src', 'make-pdf/src', 'design/src', 'lib']) {
      expect(block).toContain(`"$SOURCE_GSTACK_DIR/${root}"`);
    }
    expect(block).toContain('-type f -newer "$BUILD_STAMP"');
    expect(block).toContain('"$SOURCE_GSTACK_DIR/package.json" -nt "$BUILD_STAMP"');
    expect(block).toContain('[ -f "$SOURCE_GSTACK_DIR/bun.lock" ] && [ "$SOURCE_GSTACK_DIR/bun.lock" -nt "$BUILD_STAMP" ]');
  });
});

describe('setup: NEEDS_BUILD decision executes', () => {
  test('every binary present and executable, nothing newer → 0', () => {
    expect(decide(makeTree())).toBe(0);
  });

  test('an interrupted partial build cannot let a refreshed browse binary hide stale CSO outputs', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'browse/dist/.build-complete'));
    writeAt(path.join(dir, 'browse/dist/browse'), NEW_T, 0o755);
    expect(fs.statSync(path.join(dir, 'bin/gstack-cso-core')).mtimeMs).toBeLessThan(
      fs.statSync(path.join(dir, 'browse/dist/browse')).mtimeMs,
    );
    expect(decide(dir)).toBe(1);
  });

  test('make-pdf/dist/pdf missing → 1 (was: not checked at all)', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'make-pdf/dist/pdf'));
    expect(decide(dir)).toBe(1);
  });

  test('design/dist/design missing → 1 (was: not checked at all)', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'design/dist/design'));
    expect(decide(dir)).toBe(1);
  });

  test('browse binary missing → 1', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'browse/dist/browse'));
    expect(decide(dir)).toBe(1);
  });

  test.each(['bin/gstack-cso-launcher','bin/gstack-cso-core', 'bin/gstack-cso-watchdog'])('%s missing → 1', binary => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, binary));
    expect(decide(dir)).toBe(1);
  });

  test('CSO generation manifest missing → 1', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'bin/.gstack-cso-generation'));
    expect(decide(dir)).toBe(1);
  });

  test('Windows CSO generation lock missing → 1', () => {
    const dir = makeTree({ exe: '.exe' });
    fs.unlinkSync(path.join(dir, 'bin/.gstack-cso-generation.lock'));
    expect(decide(dir, { isWindows: '1' })).toBe(1);
  });

  test('unavailable CSO removes stale helpers and does not force a repeat build', () => {
    const dir = makeTree();
    expect(decide(dir, { csoAvailable: '0' })).toBe(0);
    for (const binary of ['bin/gstack-cso-launcher', 'bin/gstack-cso-core', 'bin/gstack-cso-watchdog', 'bin/.gstack-cso-generation']) {
      expect(fs.existsSync(path.join(dir, binary))).toBe(false);
    }
  });

  test('unavailable CSO ignores its build-script freshness but still rebuilds missing general binaries', () => {
    const dir = makeTree();
    touchNewer(dir, 'scripts/build-cso.sh');
    expect(decide(dir, { csoAvailable: '0' })).toBe(0);
    fs.unlinkSync(path.join(dir, 'design/dist/design'));
    expect(decide(dir, { csoAvailable: '0' })).toBe(1);
  });

  test.each(['scripts/build.sh', 'scripts/build-cso.sh', 'scripts/build-cso-windows.ps1', 'lib/cso/launcher.c'])('%s changed → 1', source => {
    const dir = makeTree();
    touchNewer(dir, source);
    expect(decide(dir)).toBe(1);
  });

  // MSYS bash has no execute bit: `[ -x file ]` is true for any regular file, so
  // this case is POSIX-only.
  test.skipIf(process.platform === 'win32')('a binary that exists but is not executable counts as missing → 1', () => {
    const dir = makeTree();
    fs.chmodSync(path.join(dir, 'design/dist/design'), 0o644);
    expect(decide(dir)).toBe(1);
  });

  test('a file under lib/ newer than the browse binary → 1 (was: lib/ not in the staleness set)', () => {
    const dir = makeTree();
    touchNewer(dir, 'lib/claude-bin.ts');
    expect(decide(dir)).toBe(1);
  });

  test('a brand-new file under lib/ (not just a touched one) → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'lib/aside-render.ts');
    expect(decide(dir)).toBe(1);
  });

  test('a newer make-pdf/src/x.ts → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'make-pdf/src/x.ts');
    expect(decide(dir)).toBe(1);
  });

  test('a newer design/src file → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'design/src/index.ts');
    expect(decide(dir)).toBe(1);
  });

  test('a newer browse/src file → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'browse/src/index.ts');
    expect(decide(dir)).toBe(1);
  });

  test('a newer package.json → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'package.json');
    expect(decide(dir)).toBe(1);
  });

  test('a newer bun.lock → 1', () => {
    const dir = makeTree();
    touchNewer(dir, 'bun.lock');
    expect(decide(dir)).toBe(1);
  });

  test('no bun.lock at all → 0 (the -f guard keeps a missing lockfile from erroring or forcing a build)', () => {
    const dir = makeTree();
    fs.unlinkSync(path.join(dir, 'bun.lock'));
    expect(decide(dir)).toBe(0);
  });

  test('IS_WINDOWS=1: design.exe and pdf.exe present, bare names absent → 0 (the $_EXE suffix is applied)', () => {
    const dir = makeTree({ exe: '.exe' });
    expect(fs.existsSync(path.join(dir, 'design/dist/design'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'make-pdf/dist/pdf'))).toBe(false);
    expect(decide(dir, { isWindows: '1' })).toBe(0);
  });

  test('IS_WINDOWS=1: only the bare names present → 1 (the suffix is required, not merely tolerated)', () => {
    const dir = makeTree();
    expect(decide(dir, { isWindows: '1' })).toBe(1);
  });

  // MSYS bash resolves `[ -x design ]` to design.exe on its own, so the "no
  // suffix on Unix" contrast can only be asserted on a POSIX host.
  test.skipIf(process.platform === 'win32')('IS_WINDOWS=0: only the .exe names present → 1 (no suffix on Unix)', () => {
    const dir = makeTree({ exe: '.exe' });
    expect(decide(dir, { isWindows: '0' })).toBe(1);
  });
});
