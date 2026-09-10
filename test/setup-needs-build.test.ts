/**
 * setup: the NEEDS_BUILD decision ("# 1. Build browse binary if needed").
 *
 * One `bun run build` produces every binary (browse, design, make-pdf), so a
 * missing or stale one of ANY of them must trigger the whole build. Before,
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

// From the $_EXE suffix derivation through the `fi` that closes the staleness
// chain. The statement that follows (the build itself) is the end anchor and is
// NOT included, so the harness never tries to run `bun run build`.
const BLOCK_START = '_EXE=""';
const BLOCK_END = '\nif [ "$NEEDS_BUILD" -eq 1 ]; then';

function needsBuildBlock(): string {
  const start = SETUP_SRC.indexOf(BLOCK_START);
  const end = SETUP_SRC.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) throw new Error(`Could not locate the NEEDS_BUILD block in setup (${BLOCK_START} .. ${BLOCK_END.trim()})`);
  return SETUP_SRC.slice(start, end + 1);
}

// Fixed instants, far apart, so coarse filesystem timestamps and clock skew
// can never blur "older than the binary" into "newer".
const BIN_T = new Date('2024-06-01T12:00:00Z');
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
  for (const f of SOURCE_FILES) writeAt(path.join(dir, f), OLD_T);
  return dir;
}

function touchNewer(dir: string, rel: string): void {
  writeAt(path.join(dir, rel), NEW_T);
}

function decide(dir: string, opts: { isWindows?: '0' | '1' } = {}): number {
  const script = [
    'set -e',
    `SOURCE_GSTACK_DIR="${dir}"`,
    'BROWSE_BIN="$SOURCE_GSTACK_DIR/browse/dist/browse"',
    `IS_WINDOWS=${opts.isWindows ?? '0'}`,
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

  test('all three binaries are existence-checked with -x and the $_EXE suffix', () => {
    const block = needsBuildBlock();
    expect(block).toContain('[ ! -x "$BROWSE_BIN" ]');
    expect(block).toContain('[ ! -x "$SOURCE_GSTACK_DIR/design/dist/design$_EXE" ]');
    expect(block).toContain('[ ! -x "$SOURCE_GSTACK_DIR/make-pdf/dist/pdf$_EXE" ]');
    expect(block).toContain('if [ "$IS_WINDOWS" -eq 1 ]; then _EXE=".exe"; fi');
  });

  test('the staleness find walks every embedded source root, lib/ included', () => {
    const block = needsBuildBlock();
    for (const root of ['browse/src', 'make-pdf/src', 'design/src', 'lib']) {
      expect(block).toContain(`"$SOURCE_GSTACK_DIR/${root}"`);
    }
    expect(block).toContain('-type f -newer "$BROWSE_BIN"');
    expect(block).toContain('"$SOURCE_GSTACK_DIR/package.json" -nt "$BROWSE_BIN"');
    expect(block).toContain('[ -f "$SOURCE_GSTACK_DIR/bun.lock" ] && [ "$SOURCE_GSTACK_DIR/bun.lock" -nt "$BROWSE_BIN" ]');
  });
});

describe('setup: NEEDS_BUILD decision executes', () => {
  test('every binary present and executable, nothing newer → 0', () => {
    expect(decide(makeTree())).toBe(0);
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
