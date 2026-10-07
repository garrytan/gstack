/**
 * INV-1 lint: a check that could not run must never look like "nothing found".
 *   1. The learnings/timeline query scripts may not end in `2>/dev/null || exit 0`
 *      (a missing bun read as "no learnings recorded").
 *   2. No template or resolver may wrap a gate binary in `|| true`, which turns
 *      "could not run" into success.
 *   3. Any other `2>/dev/null || exit 0` tail in bin/ is a deliberate best-effort
 *      exit and says why on the same line (`# best-effort: <reason>`).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const QUERY_SCRIPTS = ['bin/gstack-learnings-search', 'bin/gstack-timeline-read'];
const GATE_CALLS = ['outside-review-result.ts', 'gstack-learnings-search', 'gstack-timeline-read',
  '_gstack_codex_auth_probe', '_gstack_codex_model_probe', '_gstack_codex_sandbox_preflight',
  'gstack-codex-probe check-auth', 'gstack-codex-probe probe-model', 'gstack-codex-probe check-sandbox',
  '"$_CODEX_PROBE" check-auth', '"$_CODEX_PROBE" probe-model', '"$_CODEX_PROBE" check-sandbox'];
const SILENT_EXIT = /2>\/dev\/null \|\| exit 0\b/;

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

function sources(): string[] {
  const templates = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'test'].includes(d.name))
    .flatMap(d => walk(d.name, f => f.endsWith('.tmpl')));
  return [...templates, ...walk('scripts/resolvers', f => f.endsWith('.ts')), ...walk('bin', () => true)];
}

describe('gate tails never hide a check that did not run', () => {
  test('query scripts do not swallow a failed run as an empty result', () => {
    const offenders = QUERY_SCRIPTS.filter(f => SILENT_EXIT.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('no gate binary call is wrapped in || true', () => {
    const offenders: string[] = [];
    for (const rel of sources()) {
      fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(?:#|\/\/|\*)/.test(line)) return;
        if (GATE_CALLS.some(g => line.includes(g)) && /\|\|\s*true\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('other best-effort exits in bin/ carry a same-line reason', () => {
    const offenders: string[] = [];
    for (const rel of walk('bin', () => true)) {
      if (QUERY_SCRIPTS.includes(rel)) continue;
      fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
        if (SILENT_EXIT.test(line) && !/#\s*best-effort:\s*\S/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('negative controls: each rule flags a planted offender', () => {
    expect(SILENT_EXIT.test('" 2>/dev/null || exit 0')).toBe(true);
    expect(/#\s*best-effort:\s*\S/.test('mkdir -p "$X" 2>/dev/null || exit 0  # best-effort: spool is optional')).toBe(true);
    const line = '$GSTACK_BIN/gstack-learnings-search --limit 10 2>/dev/null || true';
    expect(GATE_CALLS.some(g => line.includes(g)) && /\|\|\s*true\b/.test(line)).toBe(true);
  });
});
