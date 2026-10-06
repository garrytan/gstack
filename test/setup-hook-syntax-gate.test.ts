/**
 * #3032: Claude Code runs gstack's hook shims through /bin/sh. A shim that
 * does not parse exits 2, which for a PreToolUse hook blocks the tool call in
 * every session. setup's gate parses every registered hook (bash -n on the
 * shim, a Bun parse of its TypeScript entry) and stops with the file and line
 * before any registration is written or healed.
 *
 * Runs the real gate block extracted from setup against a fixture install;
 * driving all of ./setup here is disproportionate.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const START = SETUP.indexOf('# Hook syntax gate (#3032)');
const END = SETUP.indexOf('# Heal-first: prune dead gstack hook entries');
const GATE = SETUP.slice(START, END);
const HOOKS = ['bin/gstack-session-update', 'hosts/claude/hooks/question-log-hook', 'hosts/claude/hooks/question-preference-hook',
  'hosts/claude/hooks/auq-error-fallback-hook', 'hosts/claude/hooks/timeline-stop-hook', 'autoplan/bin/phase-publication-hook'];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-syntax-gate-'));
  for (const hook of HOOKS) {
    fs.mkdirSync(path.dirname(path.join(root, hook)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, hook), path.join(root, hook));
    if (fs.existsSync(path.join(ROOT, `${hook}.ts`))) fs.writeFileSync(path.join(root, `${hook}.ts`), 'export const ok = 1;\n');
  }
  return root;
}

function runGate(root: string) {
  const script = `bun_cmd() { bun "$@"; }\nCANONICAL_GSTACK_ROOT='${root}'\nSOURCE_GSTACK_DIR='${root}'\n${GATE}\necho GATE_PASSED`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('#3032: setup refuses to register a hook that does not parse', () => {
  test('the gate runs before any hook registration is healed or written', () => {
    expect(START).toBeGreaterThan(-1);
    expect(END).toBeGreaterThan(START);
    const writes = [...SETUP.matchAll(/"\$SETTINGS_HOOK" (?:ensure-event|add-event|prune-stale|remove-source)/g)].map(m => m.index!);
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThan(END);
  });

  test('healthy hooks pass', () => {
    const root = fixture();
    try { expect(runGate(root)).toEqual({ code: 0, out: 'GATE_PASSED\n' }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a half-merged shell shim stops setup with its file and line', () => {
    const root = fixture();
    try {
      const shim = path.join(root, 'hosts/claude/hooks/question-preference-hook');
      fs.appendFileSync(shim, '<<<<<<< HEAD\nif [ -n "$x" ]; then\n');
      const r = runGate(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('refusing to register hooks');
      expect(r.out).toContain(shim);
      expect(r.out).not.toContain('GATE_PASSED');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a TypeScript entry with a syntax error stops setup with its file', () => {
    const root = fixture();
    try {
      const ts = path.join(root, 'hosts/claude/hooks/timeline-stop-hook.ts');
      fs.writeFileSync(ts, 'export const x = {;\n');
      const r = runGate(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`${ts}:`);
      expect(r.out).toContain('Expected identifier');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("every shipped hook in this checkout parses", () => {
    const r = runGate(ROOT);
    expect(r.out).toContain('GATE_PASSED');
  });
});
