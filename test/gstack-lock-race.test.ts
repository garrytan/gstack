/**
 * bin/gstack-lock.sh: a lock that stays exclusive when mkdir lies.
 *
 * Ubuntu 26.04 (GitHub's ubuntu-latest from 2026-11-09) ships Rust coreutils
 * (uutils) 0.8.0 as mkdir. It checks that the path is missing, creates it, and
 * exits 0 even when another process created the directory first, so the
 * `mkdir "$LOCK" && ...` pattern let two racing holders both win (GBEV-3 saw
 * 60 double wins in 300 races; GNU mkdir never did). The PATH shim below
 * reproduces that behaviour on any runner image, so this file runs in the free
 * suite without depending on which coreutils the machine has.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-lock.sh');
const REAL_MKDIR = Bun.which('mkdir') ?? '/bin/mkdir';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lock-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// uutils 0.8.0 mkdir, as observed on ubuntu-26.04 image 20261101.186.1: an
// existing path fails, a missing one is created after a window and reported as
// created even when another process won the create. -p passes through.
const SHIM = path.join(tmp, 'lying-bin');
fs.mkdirSync(SHIM);
fs.writeFileSync(path.join(SHIM, 'mkdir'), [
  '#!/bin/bash',
  'for a in "$@"; do case "$a" in -p|-*p*|--parents) exec "$REAL_MKDIR" "$@" ;; esac; done',
  'for a in "$@"; do case "$a" in -*) ;; *) t="$a" ;; esac; done',
  'if [ -e "$t" ]; then echo "mkdir: cannot create directory \'$t\': File exists" >&2; exit 1; fi',
  'sleep "${LYING_MKDIR_WINDOW:-0.05}"',
  '"$REAL_MKDIR" "$t" 2>/dev/null',
  'exit 0',
  '',
].join('\n'), { mode: 0o755 });
const LYING = { PATH: `${SHIM}:${process.env.PATH ?? ''}`, REAL_MKDIR };

let seq = 0;
function bash(script: string, env: Record<string, string> = {}, timeout = 60_000) {
  const r = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd: tmp,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const fresh = () => { const d = path.join(tmp, `case-${++seq}`); fs.mkdirSync(d); return d; };

// One trial: RACERS shells wait on a start file, then all try the lock once and
// keep whatever they got. Prints the winner count of each trial, one per line.
function raceTrials(take: string, trials: number, racers: number): number[] {
  const dir = fresh();
  const r = bash(`
    . '${HELPER}'
    for t in $(seq 1 ${trials}); do
      L="${dir}/lock.$t"; S="${dir}/start.$t"; W="${dir}/winners.$t"; : > "$W"
      for i in $(seq 1 ${racers}); do
        ( while [ ! -e "$S" ]; do sleep 0.005; done; if ${take}; then echo "$BASHPID" >> "$W"; fi ) &
      done
      sleep 0.05; : > "$S"; wait
      wc -l < "$W" | tr -d ' '
    done`, LYING, 120_000);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return r.out.trim().split('\n').map(Number);
}

describe('a mkdir that lies (uutils 0.8.0 shim)', () => {
  // Value: protects=the repro: the old mkdir lock admits two holders under uutils-style mkdir; fails_when=the shim stops lying (then nothing below proves the fix); why_new=no test ran a lock against a lying mkdir; seam=PATH shim; no_claim=that real uutils races at this rate (GBEV-3 measured 60/300 on the image)
  test('the old `mkdir "$LOCK"` pattern lets two racing holders both win', () => {
    const wins = raceTrials('mkdir "$L" 2>/dev/null', 10, 4);
    expect(wins.length).toBe(10);
    expect(wins.filter(n => n > 1).length).toBeGreaterThan(0);
  }, 120_000);

  // Value: protects=exactly one holder per race whatever mkdir reports; fails_when=gstack_lock_take trusts mkdir's status or drops the O_EXCL create; why_new=first lock test with a lying mkdir; seam=PATH shim; no_claim=behaviour on filesystems without O_EXCL (old NFS)
  test('gstack_lock_take never lets two win across many races', () => {
    const wins = raceTrials('gstack_lock_take "$L" pid "$BASHPID"', 60, 4);
    expect(wins.length).toBe(60);
    expect(wins.filter(n => n !== 1)).toEqual([]);
  }, 120_000);

  // Value: protects=mutual exclusion through take, hold and release cycles; fails_when=a release (rm -rf) races a taker into a second holder; why_new=the races above never release; seam=PATH shim; no_claim=fairness or wait bounds, which stay each caller's
  test('take, hold and release loops never overlap inside the lock', () => {
    const dir = fresh();
    const r = bash(`
      . '${HELPER}'
      L="${dir}/lock"; IN="${dir}/inside"; OV="${dir}/overlaps"; DONE="${dir}/done"
      for i in 1 2 3 4; do
        ( for k in 1 2 3 4 5 6 7 8; do
            until gstack_lock_take "$L"; do sleep 0.005; done
            ( set -o noclobber; : > "$IN" ) 2>/dev/null || echo overlap >> "$OV"
            sleep 0.01; rm -f "$IN"; rm -rf "$L"; echo x >> "$DONE"
          done ) &
      done
      wait; wc -l < "$DONE" | tr -d ' '; [ -e "$OV" ] && cat "$OV"; true`, LYING, 120_000);
    expect(r.err).toBe('');
    expect(r.out.trim()).toBe('32');
  }, 120_000);

  // Value: protects=gstack-config's concurrent writers keep every key under a lying mkdir; fails_when=gstack-config's lock goes back to mkdir's status; why_new=the existing parallel-writer test runs only on GNU mkdir; seam=PATH shim; no_claim=the other converted callers, covered by the source guard below
  test('parallel gstack-config writers lose no key', () => {
    const state = fresh();
    const r = bash(`
      for i in $(seq 1 8); do bash '${path.join(ROOT, 'bin', 'gstack-config')}' set "race_key_$i" "v$i" >/dev/null & done
      wait`, { ...LYING, GSTACK_STATE_ROOT: state }, 120_000);
    expect(r.code).toBe(0);
    const yaml = fs.readFileSync(path.join(state, 'config.yaml'), 'utf8');
    const missing = Array.from({ length: 8 }, (_, i) => `race_key_${i + 1}: v${i + 1}`).filter(l => !yaml.includes(l));
    expect(missing).toEqual([]);
  }, 120_000);
});

describe('gstack_lock_take contract (real mkdir)', () => {
  // Value: protects=the return codes and owner file callers rely on; fails_when=take steals an existing or ownerless lock, follows a symlink, reports an unwritable parent as contention, or leaks noclobber; why_new=new helper; seam=none; no_claim=each caller's stale-lock recovery, tested in its own file
  test('takes a free lock once, writes the owner file, and refuses a held one', () => {
    const d = fresh();
    const r = bash(`. '${HELPER}'
      gstack_lock_take "${d}/a"; echo "first=$?"
      gstack_lock_take "${d}/a" pid other; echo "second=$?"
      gstack_lock_take "${d}/b" owner "tok 1"; echo "custom=$?"`);
    expect(r.out).toBe('first=0\nsecond=1\ncustom=0\n');
    expect(fs.readFileSync(path.join(d, 'a', 'pid'), 'utf8')).toMatch(/^\d+\n$/);
    expect(fs.readFileSync(path.join(d, 'b', 'owner'), 'utf8')).toBe('tok 1\n');
  });

  test('an existing directory, even with no owner file, stays held', () => {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'lock'));
    const r = bash(`. '${HELPER}'; gstack_lock_take "${d}/lock"; echo "rc=$?"`);
    expect(r.out).toBe('rc=1\n');
    expect(fs.readdirSync(path.join(d, 'lock'))).toEqual([]);
  });

  test('a symlink at the lock path is held, never followed', () => {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'elsewhere'));
    fs.symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'lock'));
    const r = bash(`. '${HELPER}'; gstack_lock_take "${d}/lock"; echo "rc=$?"`);
    expect(r.out).toBe('rc=1\n');
    expect(fs.readdirSync(path.join(d, 'elsewhere'))).toEqual([]);
  });

  test('an owner file that cannot be written is 3 and leaves no directory behind', () => {
    const d = fresh();
    const r = bash(`. '${HELPER}'; umask 0777; gstack_lock_take "${d}/lock"; echo "rc=$?"`);
    expect(r.out).toMatch(/^rc=(3|0)\n$/);
    if (r.out === 'rc=3\n') expect(fs.existsSync(path.join(d, 'lock'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('an owner file whose write fails is 3, leaves no lock behind, and the next take succeeds', () => {
    const d = fresh();
    const r = bash(`. '${HELPER}'
      ( ulimit -f 0; gstack_lock_take "${d}/lock"; echo "full=$?" )
      gstack_lock_take "${d}/lock"; echo "next=$?"`);
    expect(r.out).toBe('full=3\nnext=0\n');
    expect(fs.readFileSync(path.join(d, 'lock', 'pid'), 'utf8')).toMatch(/^\d+\n$/);
  });

  test('a missing or unwritable parent is 2, not contention', () => {
    const d = fresh();
    const ro = path.join(d, 'ro');
    fs.mkdirSync(ro, { mode: 0o555 });
    const r = bash(`. '${HELPER}'
      gstack_lock_take "${d}/missing/lock"; echo "missing=$?"
      [ -w '${ro}' ] && echo "ro=skip" || { gstack_lock_take '${ro}/lock'; echo "ro=$?"; }`);
    expect(r.out).toMatch(/^missing=2\nro=(2|skip)\n$/);
    expect(fs.existsSync(path.join(d, 'missing'))).toBe(false);
    fs.chmodSync(ro, 0o755);
  });

  test('runs under set -euo pipefail and leaves noclobber off in the caller', () => {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'existing'), 'old\n');
    const r = bash(`set -euo pipefail; . '${HELPER}'
      gstack_lock_take "${d}/lock"
      rc=0; gstack_lock_take "${d}/lock" || rc=$?; echo "held=$rc"
      echo new > "${d}/existing"; echo "clobber=$(cat "${d}/existing")"`);
    expect(r.err).toBe('');
    expect(r.out).toBe('held=1\nclobber=new\n');
  });
});
