/**
 * A git shim that fails the land lock's network calls the way GitHub did during the 2026-11-04 HTTP 502s
 * (GST-1344): a lock push that updates origin's ref and then exits non-zero, and lock fetches or ls-remotes that
 * fail outright. Only commands naming refs/notes/gstack-land are touched; everything else runs the real git.
 * Arm it with the returned setters; put `dir` first on PATH (or pass `env` to a child).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FlakyGit {
  dir: string;
  env: { PATH: string; FLAKY_GIT: string };
  /** The lock pushes (1-based, counted from now) that reach origin and then report an HTTP 502. */
  pushLandsThenFails(...ordinals: number[]): void;
  /** The next n lock pushes fail before reaching origin. */
  pushFails(n: number): void;
  /** Lock fetches fail while on. */
  fetchFails(on: boolean): void;
  /** The next n lock ls-remotes fail. */
  lsRemoteFails(n: number): void;
  reset(): void;
}

export function flakyGit(root: string): FlakyGit {
  const dir = path.join(root, 'flaky-git');
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).trim();
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/bash',
    `REAL='${real}'`,
    `D=':${dir}:'`,
    'P=":$PATH:"; P="${P//"$D"/:}"; P="${P#:}"; export PATH="${P%:}"',
    'S="$FLAKY_GIT"',
    'case " $* " in *refs/notes/gstack-land*) ;; *) exec "$REAL" "$@" ;; esac',
    'bad() { echo "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502" >&2; exit 128; }',
    'take() { local n; n=$(cat "$S/$1" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || return 1; echo $((n-1)) > "$S/$1"; }',
    'case "$1" in',
    '  push)',
    '    n=$(( $(cat "$S/pushes" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/pushes"',
    '    take push-fails && bad',
    '    if grep -qx "$n" "$S/lands-then-fails" 2>/dev/null; then "$REAL" "$@" || exit $?; bad; fi ;;',
    '  fetch) [ -f "$S/fetch-fails" ] && bad ;;',
    '  ls-remote) take ls-remote-fails && bad ;;',
    'esac',
    'exec "$REAL" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  const put = (name: string, value: string | null) => { const f = path.join(state, name); if (value === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, value); };
  return {
    dir,
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FLAKY_GIT: state },
    pushLandsThenFails: (...ordinals) => { put('pushes', '0'); put('lands-then-fails', ordinals.join('\n') + '\n'); },
    pushFails: n => put('push-fails', String(n)),
    fetchFails: on => put('fetch-fails', on ? '1' : null),
    lsRemoteFails: n => put('ls-remote-fails', String(n)),
    reset: () => { for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f), { force: true }); },
  };
}
