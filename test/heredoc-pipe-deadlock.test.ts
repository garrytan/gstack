import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';

/**
 * bash 5.2+ delivers a heredoc body of 64KiB or less through a pipe: the
 * forked child writes the whole body before exec, and nothing reads the other
 * end until the command starts. On macOS under pipe-KVA pressure the kernel
 * hands a fresh pipe a 512-byte buffer, so any body of 512 bytes or more
 * blocks write() forever — the script hangs at startup, silently, with no
 * output and no error. The runtime capacity check bash would need
 * (F_GETPIPE_SZ) is Linux-only.
 *
 * Compat level 50 restores the pre-5.2 tempfile path. Every script that ships
 * an in-window heredoc must set it, and this scanner fails the suite when a
 * new one appears without the guard.
 *
 * The guard is deliberately not a `#!/bin/bash` shebang swap: that pins the
 * script to whatever bash lives at /bin (3.2 on macOS, absent on some Linux
 * distributions) and is bypassed entirely by `bash script.sh` call sites.
 */

const ROOT = path.resolve(import.meta.dir, '..');

// Inclusive byte window where the pipe path is taken AND a starved pipe can
// block. Bodies over 64KiB fall back to a tempfile on their own.
const MIN_BODY = 512;
const MAX_BODY = 64 * 1024;

const GUARD_RE = /^\s*(?::\s*"\$\{)?BASH_COMPAT(?:[:=]|\}")/m;

function trackedShellScripts(): string[] {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      if (f.endsWith('.sh')) return true;
      const head = fs.readFileSync(abs).subarray(0, 64).toString('utf-8');
      return /^#!.*\b(bash|sh)\b/.test(head);
    });
}

/** Heredocs in `content` whose body lands inside the deadlock window. */
function inWindowHeredocs(content: string): { line: number; tag: string; bytes: number }[] {
  const lines = content.split('\n');
  const hits: { line: number; tag: string; bytes: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(lines[i]);
    if (!m) continue;
    const tag = m[1];
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && lines[j].trim() !== tag) body.push(lines[j++]);
    const bytes = Buffer.byteLength(body.join('\n')) + 1;
    if (bytes >= MIN_BODY && bytes <= MAX_BODY) hits.push({ line: i + 1, tag, bytes });
    i = j;
  }
  return hits;
}

describe('heredoc pipe-deadlock guard', () => {
  test('every script with an in-window heredoc sets BASH_COMPAT', () => {
    const violations: string[] = [];
    for (const rel of trackedShellScripts()) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const hits = inWindowHeredocs(content);
      if (hits.length === 0) continue;
      if (GUARD_RE.test(content)) continue;
      for (const h of hits) violations.push(`${rel}:${h.line} <<${h.tag} body=${h.bytes}B`);
    }
    if (violations.length > 0) {
      throw new Error(
        `Heredoc bodies in the ${MIN_BODY}-${MAX_BODY}B pipe window without a BASH_COMPAT guard:\n  ` +
          violations.join('\n  ') +
          `\n\nFix: add \`BASH_COMPAT=50\` near the top of the script (below any ` +
          `\`--help\` sed range that reads $0), or shrink the body under ${MIN_BODY}B, ` +
          `or pipe it in with printf so a live reader exists.`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('the guard actually moves the body off the pipe', () => {
    const bash = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const version = (bash.stdout ?? '').trim();
    const [maj, min] = version.split('.').map((n) => parseInt(n, 10));
    // Only 5.2+ takes the pipe path at all; older bash is already on tempfiles.
    if (!(maj > 5 || (maj === 5 && min >= 2))) {
      expect(version).toBeTruthy();
      return;
    }

    // Some sandboxes/containers ship a minimal /dev without /dev/stdin — the
    // probe medium itself is absent there, so -p/-f both report false and the
    // probe would answer OTHER for an unobservable fd. Skip rather than fail.
    const devStdin = spawnSync('bash', ['-c', '[ -e /dev/stdin ] && echo yes || echo no'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if ((devStdin.stdout ?? '').trim() !== 'yes') return;

    const probe = (guard: string) => `#!/usr/bin/env bash
${guard}
body=$(printf 'x%.0s' $(seq 1 1000))
probe() { if [ -p /dev/stdin ]; then echo PIPE; elif [ -f /dev/stdin ]; then echo TEMPFILE; else echo OTHER; fi; }
probe <<EOF
$body
EOF
`;
    const run = (guard: string) =>
      (spawnSync('bash', ['-c', probe(guard)], { encoding: 'utf-8', timeout: 30_000 }).stdout ?? '').trim();

    expect(run('')).toBe('PIPE');
    expect(run('BASH_COMPAT=50')).toBe('TEMPFILE');
  });
});
