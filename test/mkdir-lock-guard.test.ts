/**
 * Source guard: no shell code takes a lock with mkdir's exit status.
 *
 * Rust coreutils (uutils) 0.8.0, the mkdir on Ubuntu 26.04 and GitHub's
 * ubuntu-latest from 2026-11-09, reports success when another process created
 * the directory first, so `if mkdir "$LOCK"`, `while ! mkdir`, `until mkdir`
 * and `mkdir "$LOCK" && ...` / `|| ...` let two holders in at once. Every lock
 * goes through gstack_lock_take (bin/gstack-lock.sh), which arbitrates with an
 * O_EXCL create. This guard flags any mkdir without -p whose exit status
 * decides what happens next, in shipped shell, templates, workflows, Markdown
 * bash fences and TypeScript that embeds shell. Plain `mkdir -p` and a mkdir
 * whose status is discarded (`|| :`, `|| true`) are ordinary and pass.
 * Test files (test/...test.ts) are out of scope: they plant locks and shim mkdir on purpose.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Status-consuming mkdir calls that are not locks: each creates a fresh
// directory inside a private temp dir or fixture that nothing else contends for.
const NOT_LOCKS: Array<{ file: string; line: string; why: string }> = [
  { file: 'bin/gstack-capy-install', line: 'mkdir "$TMP/pub" &&', why: 'fresh dir inside a private mktemp dir while unpacking Bun' },
  { file: 'bin/gstack-node-runtime.sh', line: 'mkdir "$tmp/pub" &&', why: 'fresh dir inside a private mktemp dir while unpacking Node' },
  { file: 'test/fixtures/session-update-heartbeat.sh', line: 'mkdir "$FIXTURE/bin" || exit 90', why: 'fixture setup in a private temp dir' },
  { file: 'test/fixtures/session-update-heartbeat.sh', line: 'mkdir "$LOCK_DIR" || exit 92', why: 'plants the single holder of a private fixture lock; no contender exists' },
];

const SHELL_EXT = /\.(sh|bash|tmpl|ya?ml)$/;
const CODE_EXT = /\.(ts|js|mjs|cjs)$/;

function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').filter(Boolean).filter(f => {
    if (f.startsWith('node_modules/') || /^CHANGELOG\.md$|^TODOS\.md$|^changelog\.d\//.test(f)) return false;
    if (/^test\/.*\.test\.ts$/.test(f)) return false;
    return fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.isFile() ?? false;
  });
}

/** The lines of a file that run as shell (or embed it), comments dropped. */
function shellLines(file: string, text: string): Array<[number, string]> {
  const lines = text.split('\n');
  const out: Array<[number, string]> = [];
  if (file.endsWith('.md')) {
    let inBash = false;
    lines.forEach((l, i) => {
      if (/^\s*```/.test(l)) { inBash = /^\s*```(bash|sh|shell)\s*$/.test(l) && !inBash; return; }
      if (inBash && !/^\s*#/.test(l)) out.push([i + 1, l]);
    });
    return out;
  }
  const shellish = SHELL_EXT.test(file) || /^#!.*\b(ba|z|da)?sh\b/.test(lines[0] ?? '');
  if (!shellish && !CODE_EXT.test(file)) return out;
  lines.forEach((l, i) => {
    if (shellish ? /^\s*#/.test(l) : /^\s*(\/\/|\*|\/\*)/.test(l)) return;
    out.push([i + 1, l]);
  });
  return out;
}

/** mkdir calls without -p whose exit status a condition or && / || consumes. */
export function statusConsumingMkdirs(line: string): string[] {
  const hits: string[] = [];
  const re = /(^|[^A-Za-z0-9_.$\/-])mkdir\b(?!Sync|Secure|\s*\(|\s*[,:}]|['"`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const start = m.index + m[1]!.length;
    const rest = line.slice(start + 'mkdir'.length);
    const end = rest.search(/;|&&|\|\||\||\)|\}|`|\s(then|do)\b|$/);
    const args = rest.slice(0, end);
    if (/(^|\s)(-[A-Za-z]*p[A-Za-z]*|--parents)\b/.test(args)) continue;
    const before = line.slice(0, start).replace(/\s+$/, '');
    const after = rest.slice(end).replace(/^\s+/, '');
    const conditioned = /(^|[\s;({])(if|elif|while|until)(\s+!)?$|(&&|\|\||!)$/.test(before);
    const chained = /^(&&|\|\|)/.test(after) && !/^\|\|\s*(:|true)\s*($|[;)}])/.test(after);
    if (conditioned || chained) hits.push(line.slice(start, start + 'mkdir'.length + end + 12).trim());
  }
  return hits;
}

describe('mkdir is never a lock', () => {
  // Value: protects=every lock keeps going through gstack_lock_take; fails_when=a new if/while/until mkdir or mkdir && / || appears outside the reasoned allowlist; why_new=Ubuntu 26.04's uutils mkdir made the pattern unsafe; seam=none; no_claim=locks written in other languages, or a mkdir whose status reaches a later `$?` test
  test('no shipped shell, template, workflow or embedded shell decides on mkdir\'s exit status', () => {
    const found: string[] = [];
    for (const file of trackedFiles()) {
      if (!SHELL_EXT.test(file) && !CODE_EXT.test(file) && !file.endsWith('.md') && path.extname(file) !== '') continue;
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      if (text.includes('\0')) continue;
      for (const [n, line] of shellLines(file, text)) {
        if (!line.includes('mkdir')) continue;
        if (NOT_LOCKS.some(a => a.file === file && line.includes(a.line))) continue;
        for (const hit of statusConsumingMkdirs(line)) found.push(`${file}:${n}: ${hit}`);
      }
    }
    expect(found).toEqual([]);
  });

  test('every allowlist entry still matches a line, so stale entries cannot hide a new lock', () => {
    const stale = NOT_LOCKS.filter(a => !fs.readFileSync(path.join(ROOT, a.file), 'utf8').includes(a.line));
    expect(stale).toEqual([]);
  });

  // Value: protects=the detector itself; fails_when=it misses a lock form FOUN-32 found or flags ordinary mkdir -p; why_new=new guard; seam=none; no_claim=forms outside these samples
  test('the detector flags each lock form and passes ordinary mkdir', () => {
    for (const lock of [
      'while ! mkdir "$LOCK" 2>/dev/null; do',
      'until mkdir "$LOCK_DIR" 2>/dev/null; do',
      '  if mkdir "$_dir" 2>/dev/null; then',
      'if ! mkdir "$GSTACK_STATE_ROOT"/.setup-gbrain.lock.d; then',
      '  mkdir "$LOCK_DIR" 2>/dev/null && return 0',
      '  mkdir "$LOCK_DIR" 2>/dev/null || refuse "busy"',
      '    && mkdir -p "$(dirname "$L")" 2>/dev/null && mkdir "$L" 2>/dev/null && echo "$$" > "$L/pid"; }; then',
      'n=1; until mkdir "$slots/$n" 2>/dev/null; do n=$((n + 1)); done',
    ]) expect({ lock, hits: statusConsumingMkdirs(lock).length }).toEqual({ lock, hits: 1 });
    for (const plain of [
      'mkdir -p "$STATE_DIR"',
      'mkdir -p "$STATE_DIR/locks" 2>/dev/null || { _err "cannot create"; return 5; }',
      'if ! mkdir -p "$GSTACK_STATE_ROOT"; then',
      'mkdir -pm 700 "$d" && cd "$d"',
      'mkdir "$_gl_dir" 2>/dev/null || :',
      'mkdir "$x" 2>/dev/null || true',
      'mkdir /work',
      'fs.mkdirSync(lock);',
      "const { mkdir } = await import('node:fs/promises');",
    ]) expect({ plain, hits: statusConsumingMkdirs(plain) }).toEqual({ plain, hits: [] });
  });
});
