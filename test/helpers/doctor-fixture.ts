/**
 * Shared fixture for the gstack-doctor tests (test/gstack-doctor.test.ts,
 * test/gstack-doctor-check.test.ts, test/gstack-doctor-launch.test.ts): a
 * fixture install root, state root, stub bun/codex/claude on PATH, and the
 * doctor() and rowOf() readers. Each test file calls useDoctorCleanup().
 */
import { afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// setup builds browse/dist/browse.exe on Windows (Git Bash), browse/dist/browse elsewhere.
export const BROWSE_BIN = process.platform === 'win32' ? 'browse/dist/browse.exe' : 'browse/dist/browse';
export const EXE = process.platform === 'win32' ? '.exe' : '';
export const OTHER_BINS = ['browse/dist/find-browse', 'design/dist/design', 'make-pdf/dist/pdf', 'bin/gstack-global-discover'].map(rel => rel + EXE);

export const REPO = path.resolve(import.meta.dir, '../..');
const COPIED = [
  'setup', 'VERSION',
  'bin/gstack-doctor', 'bin/gstack-codex-status.sh', 'bin/gstack-state-root.sh', 'bin/gstack-install-registry.sh',
  'bin/gstack-render-claude.sh', 'bin/gstack-bun-version.sh', 'bin/gstack-hook-check', 'bin/gstack-config',
  'autoplan/SKILL.md', // its frontmatter registers the autoplan hook the hooks-row test breaks
  'bin/gstack-launch-probe.sh',
  'bin/gstack-doctor-check.sh', 'bin/gstack-doctor-components.sh', 'bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts',
  'bin/gstack-windows-bash.ts', 'lib/script-invocation.ts', 'lib/bun-isolation.ts', 'lib/result-codes.ts', 'lib/result-codes-release.ts', 'lib/result-codes-capy.ts', 'lib/result-codes-budget.ts', 'lib/result-codes-eval.ts', 'lib/result-codes-plan.ts', // the windows bash row
];
const bases: string[] = [];
/** Registers the per-test fixture cleanup; each test file calls it at top level (a hook in this module would bind to the first importing file only). */
export function useDoctorCleanup() {
  afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });
}

export const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
export const script = (file: string, lines: string[]) => write(file, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n', 0o755);

/** The fixture's PATH entries minus every directory holding a real bun, codex or claude. */
function hostPath(base: string): string {
  const names = ['bun', 'codex', 'claude'];
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.ps1'] : [''];
  return (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!names.some(n => exts.some(e => fs.existsSync(path.join(dir, n + e))))) return dir;
    const shim = path.join(base, `host-${i}`);
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (names.some(n => exts.some(e => name === n + e))) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(shim, name)); } catch { /* unreadable entry */ }
    }
    return shim;
  }).join(path.delimiter);
}

export interface Fixture { base: string; root: string; state: string; home: string; work: string; stub: string; probeLog: string; env: Record<string, string> }

export function makeFixture(): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-doctor-')));
  bases.push(base);
  const root = path.join(base, 'gstack');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  const stub = path.join(base, 'stub');
  const probeLog = path.join(base, 'probe-calls');
  for (const dir of [state, home, work, stub]) fs.mkdirSync(dir, { recursive: true });
  for (const rel of COPIED) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    fs.chmodSync(path.join(root, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  script(path.join(root, 'bin/gstack-codex-probe'), [
    'echo "$*" >> "$DOCTOR_PROBE_LOG"',
    'case "$1" in',
    '  select-model) [ "${STUB_SELECT_FAIL:-}" = 1 ] && { echo "gstack-codex-probe: cannot find its scripts dir" >&2; exit 1; }',
    '    echo "CODEX_SEL: gpt-stub-5"; echo "CODEX_SEL_KIND: $2"; echo "CODEX_MODEL: gpt-stub-5 ($2; source: codex config.toml)" >&2 ;;',
    '  check-auth) [ "${STUB_AUTH_FAIL:-}" = 1 ] && { echo AUTH_FAILED; exit 1; }; echo AUTH_OK ;;',
    '  show-sandbox) echo "CODEX_SANDBOX: read-only" ;;',
    '  check-sandbox|check-version) ;;',
    '  probe-model) echo "CODEX_PROBE_STATE: ${STUB_PROBE_STATE:-ok}"; exit "${STUB_PROBE_EXIT:-0}" ;;',
    '  *) exit 64 ;;',
    'esac',
  ]);
  const listed = spawnSync('bash', [path.join(root, 'bin/gstack-hook-check'), '--list', root], { encoding: 'utf8', timeout: 20_000 });
  const hooks = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (!hooks.includes('autoplan/bin/phase-publication-hook')) throw new Error(`gstack-hook-check --list missed the autoplan hook: ${listed.stdout}${listed.stderr}`);
  for (const hook of hooks) write(path.join(root, hook), '#!/bin/sh\nexit 0\n', 0o755);
  // The doctor launches each compiled binary's --version (#2595), so the
  // stand-ins answer it like the real binaries do.
  for (const rel of [BROWSE_BIN, ...OTHER_BINS]) write(path.join(root, rel), '#!/bin/sh\necho built\n', 0o755);
  for (const rel of ['browse/dist/server-node.mjs', 'browse/dist/.build-complete']) write(path.join(root, rel), 'built\n', 0o755);
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  write(path.join(state, 'installs.tsv'),
    ['claude', 'global', '-', path.join(home, '.claude/skills'), root, root, version, 'false', 'committed', '2026-10-07T00:00:00Z'].join('\t') + '\n');
  // The stub answers --version; anything else (the pins row runs bin/gstack-runtime-pins.ts) goes to the real bun.
  script(path.join(stub, 'bun'), ['[ "$1" = --version ] && { echo "${STUB_BUN_VERSION:-1.4.2}"; exit 0; }', `exec "${process.execPath}" "$@"`]);
  script(path.join(stub, 'codex'), ['[ "$1" = --version ] && { echo "codex-cli 0.130.0"; exit 0; }', 'echo "unexpected codex call: $*" >> "$DOCTOR_PROBE_LOG"', 'exit 9']);
  script(path.join(stub, 'claude'), ['[ "$1" = --version ] && { echo "2.1.292 (Claude Code)"; exit 0; }', 'exit 9']);
  const env: Record<string, string> = {
    PATH: [stub, hostPath(base)].join(path.delimiter),
    HOME: home, GSTACK_STATE_ROOT: state, TMPDIR: base, DOCTOR_PROBE_LOG: probeLog,
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return { base, root, state, home, work, stub, probeLog, env };
}

export function doctor(f: Fixture, args: string[] = [], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(f.root, 'bin/gstack-doctor'), ...args], { cwd: f.work, encoding: 'utf8', env: { ...f.env, ...extra }, timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, row: (name: string) => rowOf(r.stdout, name) };
}

/** The named row and its fix line: { state, detail, fix }. */
export function rowOf(stdout: string, name: string) {
  const lines = stdout.split('\n');
  const i = lines.findIndex(l => l.slice(16, 32).trim() === name);
  if (i < 0) throw new Error(`no row "${name}" in:\n${stdout}`);
  const fix = lines[i + 1]?.startsWith(' '.repeat(32) + 'fix: ') ? lines[i + 1].slice(37) : '';
  return { state: lines[i].slice(0, 16).trim(), detail: lines[i].slice(32), fix };
}

/** How bash spells a directory (Git Bash on Windows prints /c/...). */
export const bashPath = (dir: string) => spawnSync('bash', ['-c', 'cd "$1" && pwd', '_', dir], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
export const probeCalls = (f: Fixture) => fs.existsSync(f.probeLog) ? fs.readFileSync(f.probeLog, 'utf8') : '';
export const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
export const syncOn = (f: Fixture, status: Record<string, unknown>) => {
  fs.mkdirSync(path.join(f.state, '.git'), { recursive: true });
  write(path.join(f.state, 'config.yaml'), 'artifacts_sync_mode: artifacts-only\n');
  write(path.join(f.state, '.brain-sync-status.json'), JSON.stringify(status).replace(/":/g, '": ').replace(/,"/g, ', "') + '\n');
};
