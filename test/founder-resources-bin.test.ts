/**
 * The office-hours founder-resource pool moved out of the prompt into
 * lib/founder-resources.ts, printed by bin/gstack-founder-resources. These
 * pins prove the command prints exactly what the prompt carried, minus what
 * the user was already shown, and stops once everything has been shown.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FOUNDER_RESOURCES, renderIndex, renderPool, resourceUrl } from '../lib/founder-resources';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'founder-resources-pool.txt'), 'utf-8');
const SECTION = fs.readFileSync(path.join(ROOT, 'office-hours', 'sections', 'design-and-handoff.md'), 'utf-8');
const BIN = path.join(ROOT, 'bin', 'gstack-founder-resources');

describe('founder-resource pool', () => {
  test('renders byte-for-byte the pool the prompt carried inline', () => {
    expect(renderPool()).toBe(FIXTURE);
  });

  test('ids run 1..34 and every URL is distinct', () => {
    expect(FOUNDER_RESOURCES.map(r => r.id)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    expect(new Set(FOUNDER_RESOURCES.map(resourceUrl)).size).toBe(34);
  });

  test('nothing shown prints the whole pool after the counts', () => {
    expect(renderIndex([])).toBe(['RESOURCES_TOTAL: 34', 'RESOURCES_SHOWN_COUNT: 0', 'RESOURCES: 34 not yet shown', '', FIXTURE].join('\n'));
  });

  test('shown URLs are left out and only pool hits count', () => {
    const out = renderIndex([resourceUrl(FOUNDER_RESOURCES[0]!), 'https://not-in-pool.example']);
    expect(out).toContain('RESOURCES_SHOWN_COUNT: 1');
    expect(out).toContain('RESOURCES: 33 not yet shown');
    expect(out).not.toContain(resourceUrl(FOUNDER_RESOURCES[0]!));
    expect(out).toContain(`2. ${FOUNDER_RESOURCES[1]!.text}`);
  });

  test('exhausted once every resource has been shown', () => {
    const out = renderIndex(FOUNDER_RESOURCES.map(resourceUrl));
    expect(out).toContain('RESOURCES_SHOWN_COUNT: 34');
    expect(out.trim().endsWith('RESOURCES: exhausted')).toBe(true);
  });
});

describe('gstack-founder-resources command', () => {
  const run = (args: string[]) => runScriptSync(BIN, args, { encoding: 'utf8', timeout: 30_000 });

  test('--shown filters the printed pool', () => {
    const r = run(['--shown', `${resourceUrl(FOUNDER_RESOURCES[24]!)},${resourceUrl(FOUNDER_RESOURCES[33]!)}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(renderIndex([resourceUrl(FOUNDER_RESOURCES[24]!), resourceUrl(FOUNDER_RESOURCES[33]!)]));
  });

  test('with no arguments it leaves out what the builder profile logged as shown', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-resources-'));
    try {
      const env = { ...process.env, GSTACK_STATE_ROOT: home, GSTACK_HOME: home };
      const shown = [resourceUrl(FOUNDER_RESOURCES[0]!), resourceUrl(FOUNDER_RESOURCES[9]!)];
      const session = JSON.stringify({ date: '2026-11-17', mode: 'startup', resources_shown: shown });
      expect(runScriptSync(path.join(ROOT, 'bin', 'gstack-developer-profile'), ['--log-session', session], { encoding: 'utf8', timeout: 30_000, env }).status).toBe(0);
      const r = runScriptSync(BIN, [], { encoding: 'utf8', timeout: 30_000, env });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(renderIndex(shown));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('an unreadable builder profile prints PROFILE_READ: failed and the whole pool', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-resources-'));
    try {
      fs.writeFileSync(path.join(home, 'developer-profile.json'), 'not json');
      const r = runScriptSync(BIN, [], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: home, GSTACK_HOME: home } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('PROFILE_READ: failed\n' + renderIndex([]));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('unknown arguments are a usage error', () => {
    const r = run(['show', '2']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: gstack-founder-resources');
  });
});

describe('office-hours closing uses the command', () => {
  test('the pool is no longer inlined in the generated section', () => {
    for (const r of FOUNDER_RESOURCES) expect(SECTION).not.toContain(resourceUrl(r));
  });

  test('the opt-out check runs before the command', () => {
    const gate = SECTION.indexOf('gstack-config get founder_resources');
    const pool = SECTION.indexOf('bin/gstack-founder-resources');
    expect(gate).toBeGreaterThan(-1);
    expect(pool).toBeGreaterThan(gate);
    expect(SECTION).toContain('RESOURCES: exhausted');
  });
});
