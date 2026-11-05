/**
 * R56 (ETHOS.md: 9. Earn Its Place): every part of gstack has a row in
 * docs/inventory/evidence.json, validated by its status's own fields, and
 * bin/gstack-inventory ranks the parts by load per run into docs/inventory.md.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverTemplates } from '../scripts/discover-skills';
import { DISPATCHES, LEDGER_PATH, ROOT_KEY, SHARED_KEYS, SHARED_PARTS, evidenceRef, installReason, inventoryKeys, keyOf, validateEntry, validateLedger } from '../lib/inventory';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-inventory');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-inventory-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const codes = (key: string, entry: unknown) => validateEntry(key, entry).map(p => p.code);
const run = (args: string[]) => spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

const VERDICT = { sources: ['gstack-evals run r9 results.json'], models: ['claude-opus-5-5', 'gpt-6.1-sol'], prompt: 'preset', scope: 'the full procedure, told', masked: true };
const NEW_UNTESTED = { status: 'untested', reason: 'catches missed migrations', plan: 'test/fixtures/skill-evals/demo/tasks.json', owner: 'GSTA-168', measure_by: '2026-12-01' };

describe('the key list', () => {
  test('keys are the skill directories discoverTemplates finds, the root skill as gstack, then the fixed shared keys', () => {
    const keys = inventoryKeys(ROOT);
    const skills = discoverTemplates(ROOT).map(t => path.dirname(t.tmpl)).map(d => (d === '.' ? ROOT_KEY : d));
    expect(keys).toEqual([...skills.sort(), ...SHARED_KEYS]);
    expect(keys).toContain('gstack');
    expect(keys).toContain('gstack-upgrade');
    expect(keys).not.toContain('connect-chrome');
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('installed names map to keys: gstack-<name> to <name>, gstack-upgrade stays literal', () => {
    expect(keyOf('gstack-ship')).toBe('ship');
    expect(keyOf('ship')).toBe('ship');
    expect(keyOf('gstack-upgrade')).toBe('gstack-upgrade');
    expect(keyOf('gstack')).toBe('gstack');
  });
});

describe('the ledger covers every key and validates', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, LEDGER_PATH), 'utf8'));

  test('no missing and no extra keys, and every row passes its status schema', () => {
    const keys = inventoryKeys(ROOT);
    expect(Object.keys(ledger.parts).filter(k => !keys.includes(k))).toEqual([]);
    expect(keys.filter(k => !(k in ledger.parts))).toEqual([]);
    expect(validateLedger(ledger, keys)).toEqual([]);
  });

  test('the initial backlog is grandfathered, nothing else is, and the guards are safety rows', () => {
    const backlog: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'inventory-grandfathered.json'), 'utf8')).keys;
    for (const key of backlog) expect([key, ledger.parts[key]?.grandfathered]).toEqual([key, true]);
    for (const [key, row] of Object.entries<any>(ledger.parts)) if (row.grandfathered) expect(backlog).toContain(key);
    for (const key of ['careful', 'freeze', 'guard', 'unfreeze', 'cso']) expect(ledger.parts[key].status).toBe('safety');
    for (const key of ['capy-skill', 'capy-factory']) expect(ledger.parts[key]).toMatchObject({ status: 'untested', plan: 'none' });
  });

  test('a missing and an extra key are each named', () => {
    const keys = inventoryKeys(ROOT);
    const { ship, ...rest } = ledger.parts;
    const problems = validateLedger({ ...ledger, parts: { ...rest, 'no-such-part': ship } }, keys);
    expect(problems.map(p => `${p.key} ${p.code}`)).toEqual(['ship LEDGER_KEY_MISSING', 'no-such-part LEDGER_KEY_EXTRA']);
  });
});

describe('the per-status schema', () => {
  test('passing rows: a grandfathered untested part with plan none, a new part with a dated plan, a fair verdict, a safety guard', () => {
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none' })).toEqual([]);
    expect(codes('a', NEW_UNTESTED)).toEqual([]);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'docs/evals/demo/PREREG.md' })).toEqual([]);
    expect(codes('a', { status: 'helps', ...VERDICT })).toEqual([]);
    expect(codes('a', { status: 'helps', ...VERDICT, models: ['claude-opus-5-5', 'particle-1'] })).toEqual([]);
    expect(codes('a', { status: 'no-effect', ...VERDICT, r48: { verdict: 'CUT-CANDIDATE', ref: 'why-null.md' } })).toEqual([]);
    expect(codes('a', { status: 'safety', reason: 'blocks rm -rf' })).toEqual([]);
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none', prior: [{ ref: 'run 7', why: ['stub', 'unmasked'] }] })).toEqual([]);
  });

  test('a new untested part needs reason, a concrete plan, owner and measure_by; plan none is refused', () => {
    const { measure_by, ...noDate } = NEW_UNTESTED;
    expect(codes('a', noDate)).toEqual(['LEDGER_MEASURE_BY_MISSING']);
    expect(codes('a', { ...NEW_UNTESTED, measure_by: 'soon' })).toEqual(['LEDGER_MEASURE_BY_MISSING']);
    const { owner, ...noOwner } = NEW_UNTESTED;
    expect(codes('a', noOwner)).toEqual(['LEDGER_OWNER_MISSING']);
    const { reason, ...noReason } = NEW_UNTESTED;
    expect(codes('a', noReason)).toEqual(['LEDGER_REASON_MISSING']);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'none' })).toEqual(['LEDGER_PLAN_NONE_NEW']);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'we will test it later' })).toEqual(['LEDGER_PLAN_NOT_CONCRETE']);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'GEVA-2 registry row R56-11 (proposed, not yet preregistered)' })).toEqual(['LEDGER_PLAN_NOT_CONCRETE']);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'prereg later' })).toEqual(['LEDGER_PLAN_NOT_CONCRETE']);
    expect(codes('a', { ...NEW_UNTESTED, plan: 'wiki/plans/2026-11-01-demo-prereg.md' })).toEqual([]);
    expect(codes('a', { status: 'untested', grandfathered: true })).toEqual(['LEDGER_PLAN_MISSING']);
  });

  test('helps, no-effect and hurts need sources, frontier models, the preset prompt, a scope and a masked no-gstack arm', () => {
    const { sources, ...noSources } = VERDICT;
    expect(codes('a', { status: 'helps', ...noSources })).toEqual(['LEDGER_SOURCES_MISSING']);
    expect(codes('a', { status: 'helps', ...VERDICT, sources: [] })).toEqual(['LEDGER_SOURCES_MISSING']);
    expect(codes('a', { status: 'helps', ...VERDICT, models: ['claude-haiku-5-5'] })).toEqual(['LEDGER_MODELS_NOT_FRONTIER']);
    expect(codes('a', { status: 'helps', ...VERDICT, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })).toEqual(['LEDGER_MODELS_NOT_FRONTIER']);
    expect(codes('a', { status: 'helps', ...VERDICT, models: ['claude-opus-5-5', 'particle-1', 'deepseek-v4.1-flash'] })).toEqual(['LEDGER_MODELS_NOT_FRONTIER']);
    expect(codes('a', { status: 'helps', ...VERDICT, prompt: 'sdk-stub' })).toEqual(['LEDGER_PROMPT_NOT_PRESET']);
    expect(codes('a', { status: 'hurts', ...VERDICT, scope: '', r48: { verdict: 'KEEP', ref: 'x' } })).toEqual(['LEDGER_SCOPE_MISSING']);
    expect(codes('a', { status: 'helps', ...VERDICT, masked: false })).toEqual(['LEDGER_UNMASKED']);
  });

  test('no-effect and hurts without an R48 verdict and its reference are refused', () => {
    expect(codes('a', { status: 'no-effect', ...VERDICT })).toEqual(['LEDGER_R48_MISSING']);
    expect(codes('a', { status: 'hurts', ...VERDICT, r48: { verdict: 'DROP', ref: 'x' } })).toEqual(['LEDGER_R48_MISSING']);
    expect(codes('a', { status: 'hurts', ...VERDICT, r48: { verdict: 'KEEP' } })).toEqual(['LEDGER_R48_MISSING']);
  });

  test('safety needs a reason; unknown statuses, unknown fields and bad prior entries are refused', () => {
    expect(codes('a', { status: 'safety' })).toEqual(['LEDGER_REASON_MISSING']);
    expect(codes('a', { status: 'exempt', reason: 'x' })).toEqual(['LEDGER_STATUS_INVALID']);
    expect(codes('a', { status: 'safety', reason: 'x', source: 'typo' })).toEqual(['LEDGER_FIELD_UNKNOWN']);
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none', prior: [{ ref: 'run 7', why: ['vibes'] }] })).toEqual(['LEDGER_PRIOR_INVALID']);
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none', prior: [{ why: ['stub'] }] })).toEqual(['LEDGER_PRIOR_INVALID']);
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none', prior: [{ ref: 'run 7', why: ['toString'] }] })).toEqual(['LEDGER_PRIOR_INVALID']);
  });

  test('a present r48 is checked on every status, and aliases is a list of names', () => {
    expect(codes('a', { status: 'helps', ...VERDICT, r48: { verdict: 'DROP', ref: 'x' } })).toEqual(['LEDGER_R48_MISSING']);
    expect(codes('a', { status: 'helps', ...VERDICT, r48: {} })).toEqual(['LEDGER_R48_MISSING']);
    expect(codes('a', { status: 'safety', reason: 'x', aliases: 'other-name' })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(codes('a', { status: 'safety', reason: 'x', aliases: [] })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(codes('a', { status: 'safety', reason: 'x', aliases: ['other-name'] })).toEqual([]);
  });

  test('caveats is a list of limits on a verdict row, shown beside its sources', () => {
    const caveats = ['measured with the hook', 'suite seeded from its own reviews'];
    expect(codes('a', { status: 'helps', ...VERDICT, caveats })).toEqual([]);
    expect(codes('a', { status: 'helps', ...VERDICT, caveats: [] })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(codes('a', { status: 'helps', ...VERDICT, caveats: 'one string' })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(codes('a', { status: 'helps', ...VERDICT, caveats: [''] })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(codes('a', { status: 'untested', grandfathered: true, plan: 'none', caveats })).toEqual(['LEDGER_FIELD_INVALID']);
    expect(evidenceRef({ status: 'helps', ...VERDICT, caveats } as any)).toBe('sources: gstack-evals run r9 results.json; caveats: measured with the hook; suite seeded from its own reviews');
  });
});

/** A small gstack-shaped tree: a root skill, two skills, the shared-part files and the cited dispatch sources. */
function fixtureTree(dir: string, parts: (keys: string[]) => Record<string, unknown>): string {
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const skill = (rel: string, name: string, tier: number, body: string) => {
    const fm = `---\nname: ${name}\npreamble-tier: ${tier}\ndescription: |\n  Does ${name} things.\n---\n`;
    write(path.join(rel, 'SKILL.md.tmpl'), fm + body);
    write(path.join(rel, 'SKILL.md'), fm + '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n' + body);
  };
  skill('', 'gstack', 1, 'router\n');
  skill('alpha', 'alpha', 2, 'a'.repeat(4000) + '\n');
  skill('beta', 'beta', 2, 'b'.repeat(1000) + '\n');
  write('alpha/sections/preamble.md', 'p'.repeat(800));
  write('beta/sections/preamble.md', 'p'.repeat(800));
  for (const part of SHARED_PARTS) for (const f of part.files) write(f, 'x'.repeat(500) + '\n');
  for (const d of DISPATCHES) if (!fs.existsSync(path.join(dir, d.file))) write(d.file, 'filler\n');
  for (const d of DISPATCHES) fs.appendFileSync(path.join(dir, d.file), `${d.quote}\n`);
  const keys = inventoryKeys(dir);
  write(LEDGER_PATH, JSON.stringify({ schema_version: 1, parts: parts(keys), unmapped: [{ row: 'gstack as a whole', why: 'not a single text part' }] }, null, 2));
  return dir;
}

const grandfathered = (keys: string[]) => Object.fromEntries(keys.map(k => [k, k === 'beta' ? { status: 'safety', grandfathered: true, reason: 'a guard' } : { status: 'untested', grandfathered: true, plan: 'none' }]));

describe('bin/gstack-inventory', () => {
  test('determinism: two runs on a fixed tree write the same docs/inventory.md and the same --json', () => {
    const dir = fixtureTree(path.join(tmp, 'fixed'), grandfathered);
    const first = run(['--root', dir]);
    expect(first.status, first.stderr).toBe(0);
    const a = fs.readFileSync(path.join(dir, 'docs/inventory.md'), 'utf8');
    const second = run(['--root', dir]);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'docs/inventory.md'), 'utf8')).toBe(a);
    expect(run(['--root', dir, '--json']).stdout).toBe(run(['--root', dir, '--json']).stdout);
    expect(a).toContain('Measured at commit none');
    expect(a.indexOf('| alpha |')).toBeLessThan(a.indexOf('| beta |'));
    const start = a.indexOf('## Measure next');
    const next = a.slice(start, a.indexOf('\n## ', start + 1));
    expect(next).toContain('alpha');
    expect(next).not.toContain('| beta |');
    expect(a).toContain('gstack as a whole');
    expect(a).toContain('gstack-<name>');
    for (const d of DISPATCHES) expect(a).toContain(`${d.file}:`);
  });

  test('--check: ok on a complete ledger; a missing key exits 1 with its code', () => {
    const dir = fixtureTree(path.join(tmp, 'check'), grandfathered);
    const ok = run(['--root', dir, '--check']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^INVENTORY: ok keys=\d+/m);
    const bad = fixtureTree(path.join(tmp, 'check-bad'), keys => { const p = grandfathered(keys); delete p.alpha; return p; });
    const r = run(['--root', bad, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('alpha: no row in docs/inventory/evidence.json (LEDGER_KEY_MISSING)');
    expect(run(['--root', bad]).status).toBe(1);
  });

  test('--check: a cited dispatch source that lost its quote is named', () => {
    const dir = fixtureTree(path.join(tmp, 'drift'), grandfathered);
    fs.writeFileSync(path.join(dir, DISPATCHES[0]!.file), 'rewritten\n');
    const r = run(['--root', dir, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('(INVENTORY_SOURCE_MISSING)');
  });

  test('a bad --root, a root outside a gstack checkout and a gstack install are refused, and nothing is written', () => {
    const dir = fixtureTree(path.join(tmp, 'args'), grandfathered);
    for (const args of [['--root', '--json'], ['--root', '--check'], ['--root']]) expect(run(args).status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'docs/inventory.md'))).toBe(false);
    const outside = spawnSync(BIN, [], { cwd: tmp, encoding: 'utf8', timeout: 120_000 });
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('is not a gstack checkout');
    const installed = fixtureTree(path.join(tmp, 'home', '.claude', 'skills', 'gstack'), grandfathered);
    const w = run(['--root', installed]);
    expect(w.status).toBe(2);
    expect(w.stderr).toContain('refusing to write docs/inventory.md');
    expect(fs.existsSync(path.join(installed, 'docs/inventory.md'))).toBe(false);
    expect(run(['--root', installed, '--check']).status).toBe(0);
    expect(installReason(dir, { GSTACK_CAPY_ROOT: dir })).toContain('the Capy install');
    expect(installReason(dir, {}, path.join(tmp, 'home'))).toBeNull();
    expect(installReason(path.join(tmp, 'capy-root'), {}, path.join(tmp, 'h'))).toBeNull();
  });

  test('the real ledger passes --check', () => {
    const r = run(['--check']);
    expect(r.status, r.stderr).toBe(0);
  });
});
