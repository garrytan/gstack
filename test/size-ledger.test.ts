/**
 * Size ledger (GSTA-132): ship's union cap composes across a merge train.
 *
 * The train-26 shape: two branches off one main both grow a carved skill. Under
 * one-tree ratio pins, branch A re-pins on its own tree and branch B fits under
 * main's rounding slack without a pin; each passes alone and the train's own
 * merge of both (buildChain, the code train build runs) fails the parity
 * check. Under the ledger each branch records its own delta and the same train
 * passes, while a branch that grows beyond what it recorded still fails.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { buildChain } from '../crew/lib/ship-queue-train';
import { DEFAULT_POLICY } from '../lib/ship-policy';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { PARITY_INVARIANTS, checkSkillParity, readSkillForParity } from './helpers/parity-harness';
import type { SkillBaselineEntry } from './helpers/capture-parity-baseline';
import { entryFile, foldLedger, ledgerExpected, ledgerFailure, readSizeLedger, recordEntry } from './helpers/size-ledger';

const BASELINE = { skillMdBytes: 187_706 } as SkillBaselineEntry;
const MAIN_UNION = 328_937;
const LEDGER = 'test/size-ledger/demo';
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const write = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const append = (root: string, rel: string, bytes: number) => fs.appendFileSync(path.join(root, rel), 'y'.repeat(bytes - 1) + '\n');
const union = (root: string) => readSkillForParity(root, 'demo', true).unionBytes;
const pinFor = (root: string) => Math.ceil((union(root) / BASELINE.skillMdBytes) * 1e4) / 1e4;
const ratioCheck = (root: string) => checkSkillParity({ skill: 'demo', sectioned: true, maxSizeRatio: JSON.parse(fs.readFileSync(path.join(root, 'cap.json'), 'utf-8')).ratio }, BASELINE, BASELINE, root);
const ledgerCheck = (root: string) => checkSkillParity({ skill: 'demo', sectioned: true, sizeLedger: LEDGER }, BASELINE, BASELINE, root);
const ledger = (root: string) => { const l = readSizeLedger(root, LEDGER); if ('error' in l) throw new Error(l.error); return l; };

/** main: a carved skill at 328,937 union bytes, a ratio pin one in the last place above, and an empty ledger. */
function mainRepo(): { root: string; main: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-ledger-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, 'demo/sections/a.md', '# A\n');
  write(root, 'demo/sections/b.md', '# B\n');
  write(root, 'demo/SKILL.md', '## Preamble\n' + 'x'.repeat(MAIN_UNION - 8 - 13) + '\n');
  expect(union(root)).toBe(MAIN_UNION);
  write(root, 'cap.json', JSON.stringify({ ratio: pinFor(root) }) + '\n');
  write(root, `${LEDGER}/base.json`, JSON.stringify({ union_bytes: MAIN_UNION, measured_at: 'fixture main' }) + '\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main');
  return { root, main: git(root, 'rev-parse', 'HEAD') };
}

/** A branch off main that grows section `file` by `bytes`, then lets `mark` record the change its way. */
function branch(root: string, main: string, name: string, file: string, bytes: number, mark: (root: string) => void): string {
  git(root, 'checkout', '-q', '-b', name, main);
  append(root, `demo/sections/${file}`, bytes);
  mark(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', name);
  return git(root, 'rev-parse', 'HEAD');
}

function train(root: string, main: string, heads: string[]): string {
  const chain = buildChain(root, main, heads.map((head, i) => ({ pr: String(i + 1), head, ready_at: '', screen: 'none' as never })), DEFAULT_POLICY);
  if (!('prefixes' in chain)) throw new Error(`train stopped at #${chain.stoppedAt}: ${chain.conflicts.join(', ')}`);
  const tip = chain.prefixes.at(-1)!.commit;
  git(root, 'checkout', '-q', '--detach', tip);
  return tip;
}

function atHead(root: string, head: string) { git(root, 'checkout', '-q', '--detach', head); }

describe('train-26 shape under one-tree ratio pins (before)', () => {
  test('each branch passes alone and the train merge of both fails the ratio cap', () => {
    const { root, main } = mainRepo();
    const a = branch(root, main, 'a', 'a.md', 55, r => write(r, 'cap.json', JSON.stringify({ ratio: pinFor(r) }) + '\n'));
    const b = branch(root, main, 'b', 'b.md', 12, () => {});
    atHead(root, a); expect(ratioCheck(root).passed).toBe(true);
    atHead(root, b); expect(ratioCheck(root).passed).toBe(true);
    train(root, main, [a, b]);
    const res = ratioCheck(root);
    expect(res.passed).toBe(false);
    expect(res.failures.join('\n')).toMatch(/size ratio 1\.753 > maxSizeRatio 1\.7527/);
  });
});

describe('the same train under the size ledger (after)', () => {
  const recorded = (name: string, why: string) => (r: string) => { recordEntry(r, ledger(r), union(r), name, why); };

  test('each branch records its own delta; both orders of the train pass', () => {
    const { root, main } = mainRepo();
    const a = branch(root, main, 'a', 'a.md', 55, recorded('a', 'grew a'));
    const b = branch(root, main, 'b', 'b.md', 12, recorded('b', 'grew b'));
    for (const head of [a, b]) { atHead(root, head); expect(ledgerCheck(root).failures).toEqual([]); }
    for (const order of [[a, b], [b, a]]) {
      train(root, main, order);
      expect(ledgerCheck(root).failures).toEqual([]);
      expect(ledger(root).entries.map(e => [e.file, e.bytes])).toEqual([['a.json', 55], ['b.json', 12]]);
    }
  });

  test('a branch that grows without recording fails on its own tree and in the train', () => {
    const { root, main } = mainRepo();
    const a = branch(root, main, 'a', 'a.md', 55, recorded('a', 'grew a'));
    const b = branch(root, main, 'b', 'b.md', 12, () => {});
    atHead(root, b);
    expect(ledgerCheck(root).failures.join('\n')).toContain('this tree is +12 bytes off: bun --no-env-file --config=/dev/null scripts/size-ledger.ts record demo');
    train(root, main, [a, b]);
    expect(ledgerCheck(root).failures.join('\n')).toContain('this tree is +12 bytes off');
  });

  test('a branch that records less than it grew fails the train by the difference', () => {
    const { root, main } = mainRepo();
    const a = branch(root, main, 'a', 'a.md', 55, recorded('a', 'grew a'));
    const b = branch(root, main, 'b', 'b.md', 12, r => write(r, `${LEDGER}/b.json`, JSON.stringify({ bytes: 11, why: 'under-declared' }) + '\n'));
    train(root, main, [a, b]);
    expect(ledgerCheck(root).failures.join('\n')).toContain('this tree is +1 bytes off');
  });

  test('an undeclared shrink fails: it would leave headroom a later branch spends silently', () => {
    const { root, main } = mainRepo();
    atHead(root, main);
    write(root, 'demo/sections/a.md', '#\n');
    expect(ledgerCheck(root).failures.join('\n')).toContain('this tree is -2 bytes off');
    recordEntry(root, ledger(root), union(root), 'trim', 'trimmed a');
    expect(ledgerCheck(root).failures).toEqual([]);
  });

  test('two branches making the identical edit fail closed (git keeps one copy, both entries count)', () => {
    const { root, main } = mainRepo();
    const a = branch(root, main, 'a', 'a.md', 20, recorded('a', 'same line'));
    const b = branch(root, main, 'b', 'a.md', 20, recorded('b', 'same line'));
    train(root, main, [a, b]);
    expect(ledgerCheck(root).failures.join('\n')).toContain('this tree is -20 bytes off');
  });
});

describe('ledger records', () => {
  test('record is idempotent, deletes a zero entry, and fold keeps the total', () => {
    const { root, main } = mainRepo();
    atHead(root, main);
    append(root, 'demo/sections/a.md', 30);
    expect(recordEntry(root, ledger(root), union(root), 'feat/x', 'grew')).toEqual({ file: 'feat-x.json', bytes: 30 });
    expect(recordEntry(root, ledger(root), union(root), 'feat/x', 'grew')).toEqual({ file: 'feat-x.json', bytes: 30 });
    write(root, `${LEDGER}/other.json`, JSON.stringify({ bytes: 5, why: 'other branch' }) + '\n');
    append(root, 'demo/sections/b.md', 5);
    expect(ledgerCheck(root).failures).toEqual([]);
    const total = foldLedger(root, ledger(root), 'fixture fold');
    expect(total).toBe(MAIN_UNION + 35);
    expect(ledger(root)).toMatchObject({ base: { union_bytes: MAIN_UNION + 35 }, entries: [] });
    expect(ledgerCheck(root).failures).toEqual([]);
    write(root, 'demo/sections/a.md', '# A\n');
    expect(recordEntry(root, ledger(root), union(root), 'feat/x', 'undo')).toEqual({ file: 'feat-x.json', bytes: -30 });
    expect(recordEntry(root, ledger(root), union(root) + 30, 'feat/x', 'undo')).toEqual({ file: 'feat-x.json', bytes: 0 });
    expect(fs.existsSync(path.join(root, LEDGER, 'feat-x.json'))).toBe(false);
  });

  test('malformed ledgers fail instead of skipping', () => {
    const { root, main } = mainRepo();
    atHead(root, main);
    const bad = (rel: string, text: string, msg: RegExp) => {
      write(root, rel, text);
      expect(ledgerFailure('demo', union(root), readSizeLedger(root, LEDGER))).toMatch(msg);
      fs.rmSync(path.join(root, rel));
    };
    bad(`${LEDGER}/x.json`, '{"bytes":1.5,"why":"a"}', /non-zero integer bytes and a why/);
    bad(`${LEDGER}/x.json`, '{"bytes":3,"why":" "}', /non-zero integer bytes and a why/);
    bad(`${LEDGER}/x.json`, '{"bytes":0,"why":"a"}', /non-zero integer bytes and a why/);
    bad(`${LEDGER}/x.json`, 'not json', /unreadable/);
    bad(`${LEDGER}/Upper.json`, '{"bytes":1,"why":"a"}', /entry names/);
    fs.rmSync(path.join(root, LEDGER, 'base.json'));
    expect(ledgerFailure('demo', union(root), readSizeLedger(root, LEDGER))).toMatch(/base\.json unreadable/);
  });

  test('entry names come from the branch', () => {
    expect(entryFile('GSTA-132/Size Ledger')).toBe('gsta-132-size-ledger.json');
    expect(() => entryFile('///')).toThrow(/no usable ledger entry name/);
    expect(() => entryFile('base')).toThrow(/no usable ledger entry name/);
  });
});

describe('ship is on the ledger', () => {
  const repo = path.resolve(import.meta.dir, '..');
  test('a guard carries sizeLedger or maxSizeRatio, never both', () => {
    expect(Object.values(CARVE_GUARDS).filter(g => g.sizeLedger && g.maxSizeRatio !== undefined).map(g => g.skill)).toEqual([]);
    expect(CARVE_GUARDS.ship!.sizeLedger).toBe('test/size-ledger/ship');
  });
  test('the parity invariant takes the ledger, not the 1.05 default', () => {
    const inv = PARITY_INVARIANTS.find(i => i.skill === 'ship')!;
    expect(inv.sizeLedger).toBe('test/size-ledger/ship');
    expect(inv.maxSizeRatio).toBeUndefined();
    expect(PARITY_INVARIANTS.find(i => i.skill === 'plan-eng-review')!.maxSizeRatio).toBe(CARVE_GUARDS['plan-eng-review']!.maxSizeRatio!);
  });
  test('the ship ledger accounts for this tree', () => {
    const l = readSizeLedger(repo, 'test/size-ledger/ship');
    expect(ledgerFailure('ship', readSkillForParity(repo, 'ship', true).unionBytes, l)).toBeNull();
    expect('error' in l ? 0 : ledgerExpected(l)).toBeGreaterThan(0);
  });
  // Value: protects=the scripts/size-ledger.ts CLI contract lanes run (check exits 0 with SIZE_LEDGER: ok on a tree the ledger accounts for; record refuses on main or without --why, fold without --measured-at, a skill with no ledger; none of them writes); fails_when=a refusal is dropped, an exit code changes or a refused call writes an entry; why_new=the tests above call the helpers, never the script; seam=none; no_claim=the exit-1 mismatch path (needs a ship tree off the ledger)
  test('scripts/size-ledger.ts checks this tree and refuses unsafe calls without writing', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), path.join(repo, 'scripts/size-ledger.ts'), ...args], { cwd: repo, encoding: 'utf-8', timeout: 60_000 });
    const dir = path.join(repo, 'test/size-ledger/ship');
    const before = fs.readdirSync(dir).sort();
    const check = run('check', 'ship');
    expect([check.status, check.stdout.trim().split('\n').at(-1)]).toEqual([0, 'SIZE_LEDGER: ok']);
    const refusals: Array<[string[], string]> = [
      [['record', 'ship', '--why', 'probe', '--branch', 'main'], 'refusing to record on main'],
      [['record', 'ship'], 'record needs --why'],
      [['fold', 'ship'], 'fold needs --measured-at'],
      [['check', 'plan-eng-review'], 'plan-eng-review has no sizeLedger'],
    ];
    for (const [args, message] of refusals) {
      const r = run(...args);
      expect([r.status, r.stderr.includes(message)]).toEqual([2, true]);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});
