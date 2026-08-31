/**
 * scripts/sandbox-doctor.sh — static shell sanity (free).
 *
 * The script mutates a live sandbox (sudo mounts, dnf, bashrc), so its
 * behavior can't run under the suite; this pins what CAN be checked for
 * free: it parses as POSIX sh, fails fast, and every mutation is guarded so
 * a re-run is a no-op (its documented contract is "idempotent — run once per
 * sandbox boot").
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'sandbox-doctor.sh');

describe('sandbox-doctor.sh', () => {
  test('parses as POSIX sh, fails fast, and guards every mutation for idempotency', () => {
    // Syntax: `sh -n` parses without executing.
    const parse = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(parse.status, parse.stderr).toBe(0);

    const src = fs.readFileSync(SCRIPT, 'utf-8');
    expect(src.startsWith('#!/bin/sh')).toBe(true);
    expect(src).toContain('set -eu');
    // Idempotency guards: each mutation is conditioned on current state.
    expect(src).toContain('[ ! -e /dev/fd ]');                       // /dev/fd restore
    expect(src).toContain('git config --global user.name >/dev/null 2>&1 ||'); // never clobber identity
    expect(src).toContain("grep -q 'GSTACK sandbox test env'");      // bashrc seeded once
    expect(src).toContain('if ! command -v Xvfb >/dev/null 2>&1');   // install only if absent, dnf-gated
    expect(src).toContain('[ ! -e /tmp/.X11-unix/X99 ]');            // :99 socket check, not any-display pgrep
    expect(src).toContain('[ "${shm_kb:-0}" -gt 0 ]');               // missing /dev/shm: skip, not a set -eu abort
  });
});
