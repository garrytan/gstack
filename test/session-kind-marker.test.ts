/**
 * GSTA-135 test-run marker: harness eval adapters export
 * GSTACK_SESSION_KIND=spawned (never GSTACK_CAPY) so trials skip onboarding.
 * No classifier change rides with it, so two things are pinned here: both
 * install-admission twins treat a marker-only environment the same way (soft:
 * they apply, warn on a bad runtime, never refuse), and every gstack file that
 * reads the variable is one of the known readers below, so a new reader cannot
 * quietly change what the marker means.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkInstallAdmission } from '../lib/install-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
const BUN = fs.realpathSync(process.execPath);

/** Every file under bin/, lib/, hosts/ and scripts/ whose code reads or sets GSTACK_SESSION_KIND, with the line it does it on. */
const SESSION_KIND_INVENTORY: Record<string, string> = {
  'bin/gstack-session-kind': 'step 0: the explicit marker outranks every ambient signal (:41-43)',
  'bin/gstack-skill-start': 'unknown-kind note (:99-101) and SPAWNED_OVERRIDE (:205-206); _NO_HUMAN keys on the resolved kind (:107-108)',
  'bin/gstack-install-verdict.sh': 'admission: spawned refuses only with GSTACK_CAPY=1 (:117)',
  'lib/install-verdict.ts': 'the TypeScript twin of the same admission rule (:183-188)',
  'bin/gstack-plan-reality': 'records the kind (:58)',
  'bin/gstack-ship-receipt': 'records the kind (:143, :322)',
  'lib/autoplan-run.ts': 'records the kind (:110)',
  'lib/ship-release.ts': 'an unattended push defers the pre-push guard offer (:203)',
  'bin/gstack-brain-enqueue': 'an unattended session never spools for sync (:38)',
  'hosts/claude/hooks/spawned-directive.ts': 'Claude Code only (:57)',
  'hosts/claude/hooks/question-preference-hook.ts': 'Claude Code only (:506)',
  'bin/gstack-capy-install': 'writer: the Capy launcher exports unattended (:658, :677)',
  'scripts/cso-eval-producer.ts': 'writer: sets spawned for its own producer run and restores it (:616-631)',
  'scripts/lib/shard-engine.ts': 'writer: drops the Capy launch markers from shard environments (:595)',
};

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|sh|bash)$/;

/** Files under root/dirs whose code (not comments) names GSTACK_SESSION_KIND, as root-relative paths. */
function sessionKindReaders(root: string, dirs = ['bin', 'lib', 'hosts', 'scripts']): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });
  return dirs.filter(d => fs.existsSync(path.join(root, d))).flatMap(d => walk(path.join(root, d))).filter(file => {
    const text = fs.readFileSync(file, 'utf8');
    if (!CODE_FILE.test(file) && !text.startsWith('#!')) return false;
    const code = (/\.(sh|bash)$/.test(file) || /^#!.*\b(ba)?sh\b/.test(text) ? text : text.replace(/\/\*[\s\S]*?\*\//g, ''))
      .split('\n').filter(l => !/^\s*(#|\/\/|\*)/.test(l));
    return code.some(l => l.includes('GSTACK_SESSION_KIND'));
  }).map(f => path.relative(root, f)).sort();
}

describe('marker-only test runs (GSTACK_SESSION_KIND=spawned, no GSTACK_CAPY)', () => {
  const marker = { GSTACK_SESSION_KIND: 'spawned' };

  test('gstack-session-kind resolves the marker to spawned without any harness signal', () => {
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-session-kind')], { env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), ...marker }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('spawned');
  });

  test('both install-admission twins give the same soft outcome: they apply, warn on a runtime below the minimum, never refuse', () => {
    const sr = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-only-'));
    try {
      const fakeBin = path.join(sr, 'old-bun');
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, 'bun'), '#!/bin/sh\necho 1.3.14\n', { mode: 0o755 });
      const bash = (bunDir: string) => {
        const r = spawnSync('bash', ['-c', '. "$R/bin/gstack-bun-version.sh" && . "$R/bin/gstack-doctor-components.sh" && . "$R/bin/gstack-install-verdict.sh" && gstack_install_admission "$R/bin" review spawned; printf "%s|%s|%s|%s" "$_ia_applies" "$_ia_refuse" "$_ia_warn" "$_ia_status"'],
          { cwd: sr, env: { PATH: bunDir + ':/usr/bin:/bin', HOME: sr, R: ROOT, _GH: sr, GSTACK_STATE_ROOT: sr, ...marker }, encoding: 'utf8', timeout: 30_000 });
        const [applies, refuse, warn, status] = r.stdout.trim().split('|');
        return { applies: applies === '1', refuse: refuse === '1', warn: warn === '1', status };
      };
      const ts = (bunVersion: string) => {
        const a = checkInstallAdmission({ skill: 'review', gstackRoot: ROOT, cwd: sr, bunVersion, bunPath: BUN, env: { GSTACK_STATE_ROOT: sr, ...marker } });
        return { applies: a.applies, refuse: a.refuse, warn: a.warn, status: a.status };
      };
      const working = { applies: true, refuse: false, warn: false, status: 'ok' as const };
      expect(bash(path.dirname(BUN))).toEqual(working);
      expect(ts('1.4.2')).toEqual(working);
      const old = { applies: true, refuse: false, warn: true, status: 'runtime' as const };
      expect(bash(fakeBin)).toEqual(old);
      expect(ts('1.3.14')).toEqual(old);
    } finally { fs.rmSync(sr, { recursive: true, force: true }); }
  });
});

describe('GSTACK_SESSION_KIND readers ratchet (bin/, lib/, hosts/, scripts/)', () => {
  test('every file whose code reads or sets the marker is in the inventory, and every inventory entry still does', () => {
    expect(sessionKindReaders(ROOT)).toEqual(Object.keys(SESSION_KIND_INVENTORY).sort());
  });

  test('the scan counts code, not comments, and catches a planted reader', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-ratchet-'));
    try {
      fs.mkdirSync(path.join(root, 'lib'));
      fs.mkdirSync(path.join(root, 'bin'));
      fs.writeFileSync(path.join(root, 'lib', 'commented.ts'), '// GSTACK_SESSION_KIND only in a comment\n/*\n * GSTACK_SESSION_KIND\n */\nexport const x = 1;\n');
      fs.writeFileSync(path.join(root, 'bin', 'commented'), '#!/usr/bin/env bash\n# GSTACK_SESSION_KIND in a comment\necho ok\n');
      fs.writeFileSync(path.join(root, 'lib', 'notes.json'), '{"note": "GSTACK_SESSION_KIND"}\n');
      expect(sessionKindReaders(root)).toEqual([]);
      fs.writeFileSync(path.join(root, 'lib', 'reader.ts'), 'export const kind = process.env.GSTACK_SESSION_KIND;\n');
      fs.writeFileSync(path.join(root, 'bin', 'reader'), '#!/usr/bin/env bash\n[ "${GSTACK_SESSION_KIND:-}" = spawned ] && exit 0\n');
      expect(sessionKindReaders(root)).toEqual(['bin/reader', 'lib/reader.ts']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
