/**
 * GST-620: `sealed.label_join`, the sealed guard's rule for a published
 * record that puts a label field (`sealed.label_keys`) next to an identifier
 * the model under test can compute from its own copy of the work. The repro
 * and the byte-for-byte "off" golden live in test/sealed-guard.test.ts; this
 * file covers formats, the per-record content diff against every parent,
 * fail-closed unchecked files, waivers, allow_paths and the monotonic policy.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sealedErrors } from '../lib/sealed-guard';
import { DEFAULT_IDENTIFIER_KEYS, joinFindings } from '../lib/sealed-join';

const ROOT = path.resolve(import.meta.dir, '..');
const PREGATE = path.join(ROOT, 'bin', 'gstack-pregate');
const HEAD_A = '5b7db3aa' + '1'.repeat(32);
const HEAD_B = '9c1e0bbb' + '2'.repeat(32);
const LABELED = { label_keys: ['stratum', 'tags', 'decoy_set'] };
const P = { label_keys: ['stratum', 'tags'], identifier_keys: DEFAULT_IDENTIFIER_KEYS };

interface Scratch { root: string; work: string; env: Record<string, string> }
const scratches: Scratch[] = [];
afterEach(() => { while (scratches.length) fs.rmSync(scratches.pop()!.root, { recursive: true, force: true }); });

function git(s: Scratch, args: string[], ok = true): string {
  const r = spawnSync('git', args, { cwd: s.work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...s.env } });
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function write(s: Scratch, files: Record<string, string | null>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(s.work, rel);
    if (body === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}
function commit(s: Scratch, files: Record<string, string | null>, msg = 'results'): string {
  write(s, files);
  git(s, ['add', '-A']); git(s, ['commit', '-q', '-m', msg]);
  return git(s, ['rev-parse', 'HEAD']);
}
/** A bare origin whose main carries the base files, and a clone on branch `results`. */
function scratch(baseFiles: Record<string, string>): Scratch {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-join-')));
  const work = path.join(root, 'work'); const origin = path.join(root, 'origin.git'); const state = path.join(root, 'state');
  fs.mkdirSync(work); fs.mkdirSync(state);
  const env = { HOME: root, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const s = { root, work, env };
  scratches.push(s);
  spawnSync('git', ['init', '-q', '--bare', origin], { env: { ...process.env, ...env }, timeout: 30_000 });
  git(s, ['init', '-q', '-b', 'main']);
  commit(s, { 'README.md': '# evals\n', ...baseFiles }, 'base');
  git(s, ['remote', 'add', 'origin', origin]); git(s, ['push', '-q', 'origin', 'main']);
  git(s, ['checkout', '-q', '-b', 'results']);
  return s;
}
function landOnMain(s: Scratch, files: Record<string, string>): void {
  git(s, ['checkout', '-q', 'main']); commit(s, files, 'base change'); git(s, ['push', '-q', 'origin', 'main']); git(s, ['checkout', '-q', 'results']);
}
const policy = (sealed: unknown) => JSON.stringify({ sealed }, null, 2) + '\n';
const panel = (units: object[]) => JSON.stringify({ units }, null, 2) + '\n';
const unit = (name: string, head: string, extra: object = {}) => ({ name, stratum: name === 'u1' ? 'decoy' : 'seeded', tags: ['W:T1'], head, plan_bytes: 3760, ...extra });
const found = (s: Scratch) => joinFindings(s.work, git(s, ['rev-list', 'origin/main..HEAD']).split('\n').filter(Boolean), P);
function preflight(s: Scratch, args: string[] = []) {
  const r = spawnSync(PREGATE, ['sealed', '--base', 'main', ...args], { cwd: s.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('formats and matching', () => {
  test('a JSONL line, a nested meta.head, CSV, TSV, a markdown table with human headers and a hex value under an unlisted key each join; decimal-only strings, labels alone and identifiers alone do not', () => {
    const s = scratch({});
    const sha = commit(s, {
      'a.jsonl': '{"x":1}\n{"stratum":"decoy","meta":{"head":"5b7db3a"}}\n',
      'b.csv': 'unit,Stratum,Plan Bytes\nu1,decoy,"3,760"\n',
      'c.tsv': 'stratum\ttree_sha256\ndecoy\tabc\n',
      'd.md': '# board\n\n| Unit | Stratum | `head` | Tree SHA-256 |\n|---|:---:|---|---|\n| u1 | decoy | x | y |\n',
      'e.json': '[{"tags":["B:T2"],"id":"5b7db3a"}]\n',
      'f.json': '[{"stratum":"decoy","ts":"202610311200","name":"unit-1","count":12}]\n',
      'g.json': '[{"stratum":"decoy"},{"head":"5b7db3aa"}]\n',
      'h.md': '| head | size |\n|---|---|\n| 5b7db3a | 3 |\n',
      'i.txt': '{"stratum":"decoy","head":"5b7db3a"}\n',
      'j.json': `{"units":{"${HEAD_A}":{"stratum":"decoy","tags":["t"]}}}\n`,
      'k.jsonl': `{"${HEAD_B}":{"stratum":"seeded"}}\n`,
      'l.json': '{"units":{"unit-one":{"stratum":"decoy"}}}\n',
    });
    expect(found(s).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { rule: 'sealed.label_join', file: 'a.jsonl', commit: sha, keys: ['stratum', 'meta.head'] },
      { rule: 'sealed.label_join', file: 'b.csv', commit: sha, keys: ['stratum', 'plan_bytes'] },
      { rule: 'sealed.label_join', file: 'c.tsv', commit: sha, keys: ['stratum', 'tree_sha256'] },
      { rule: 'sealed.label_join', file: 'd.md', commit: sha, keys: ['stratum', 'head', 'tree_sha_256'] },
      { rule: 'sealed.label_join', file: 'e.json', commit: sha, keys: ['tags', 'id'] },
      { rule: 'sealed.label_join', file: 'j.json', commit: sha, keys: ['stratum', 'tags', '(key)'] },
      { rule: 'sealed.label_join', file: 'k.jsonl', commit: sha, keys: ['stratum', '(key)'] },
    ]);
  });

  test('without label_keys the rule reads nothing: no git call, even outside a repository', () => {
    expect(joinFindings(os.tmpdir(), ['0'.repeat(40)], { label_keys: [], identifier_keys: DEFAULT_IDENTIFIER_KEYS })).toEqual([]);
  });

  test('label_keys must be bare field names and identifier_keys allow only *; neither takes a dotted path; both must be string arrays', () => {
    expect(sealedErrors({ label_keys: ['stratum'], identifier_keys: ['*_sha', 'head'] })).toEqual([]);
    expect(sealedErrors({ label_keys: ['strat*'] }).map(e => e.path)).toEqual(['sealed.label_keys[0]']);
    expect(sealedErrors({ identifier_keys: ['he?d', ''] }).map(e => e.path)).toEqual(['sealed.identifier_keys[0]', 'sealed.identifier_keys[1]']);
    expect(sealedErrors({ label_keys: 'stratum' })).toEqual([{ path: 'sealed.label_keys', message: 'must be an array of strings' }]);
    expect(sealedErrors({ label_keys: ['meta.stratum'], identifier_keys: ['meta.head'] }).map(e => e.path)).toEqual(['sealed.label_keys[0]', 'sealed.identifier_keys[0]']);
  });
});

describe('content diff against every parent', () => {
  test('an unchanged record and a formatting-only edit stay clear; a replacement at the same count, a delete plus add and an added identifier field refuse', () => {
    const s = scratch({ 'wiki/panel.json': panel([unit('u1', HEAD_A), unit('u2', HEAD_B)]) });
    const reformat = commit(s, { 'wiki/panel.json': JSON.stringify({ units: [unit('u1', HEAD_A), unit('u2', HEAD_B), { note: 'no labels here' }] }) + '\n' });
    const replaced = commit(s, { 'wiki/panel.json': panel([unit('u1', HEAD_A), unit('u2', 'c'.repeat(39) + '3')]) });
    const swapped = commit(s, { 'wiki/panel.json': panel([unit('u2', 'c'.repeat(39) + '3'), unit('u3', 'd'.repeat(39) + '4')]) });
    const widened = commit(s, { 'wiki/panel.json': panel([unit('u2', 'c'.repeat(39) + '3'), unit('u3', 'd'.repeat(39) + '4', { tree_sha256: 'e'.repeat(63) + '5' })]) });
    const commits = found(s).map(f => f.commit);
    expect(commits).not.toContain(reformat);
    expect(commits.sort()).toEqual([replaced, swapped, widened].sort());
  });

  test('labels in one commit and identifiers added to the same records in the next: the second commit refuses', () => {
    const s = scratch({});
    const labels = commit(s, { 'units.jsonl': '{"name":"u1","stratum":"decoy"}\n' });
    const ids = commit(s, { 'units.jsonl': '{"name":"u1","stratum":"decoy","head":"5b7db3a"}\n' });
    expect(found(s).map(f => f.commit)).toEqual([ids]);
    expect(found(s).map(f => f.commit)).not.toContain(labels);
  });

  test('a pure rename is clear and a rename that adds a unit refuses; a clean merge of two published sides is clear and a resolution that adds a joined row refuses', () => {
    const units = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((n, i) => unit(n, String(i + 1).repeat(4) + 'ab' + 'f'.repeat(34)));
    const s = scratch({ 'wiki/panel.json': panel(units) });
    git(s, ['mv', 'wiki/panel.json', 'wiki/board.json']); git(s, ['commit', '-q', '-m', 'rename']);
    write(s, { 'wiki/board.json': panel([...units, unit('u7', HEAD_A)]) });
    git(s, ['mv', 'wiki/board.json', 'wiki/board2.json']); git(s, ['add', '-A']); git(s, ['commit', '-q', '-m', 'rename and add']);
    const renamedAndAdded = git(s, ['rev-parse', 'HEAD']);
    expect(found(s).map(f => f.commit)).toEqual([renamedAndAdded]);

    const m = scratch({ 'wiki/panel.json': panel([unit('u1', HEAD_A)]) });
    git(m, ['checkout', '-q', '-b', 'side']);
    const side = commit(m, { 'wiki/panel.json': panel([unit('u1', HEAD_A), unit('u2', HEAD_B)]) });
    git(m, ['checkout', '-q', 'results']);
    const ours = commit(m, { 'wiki/panel.json': panel([unit('u3', 'c'.repeat(39) + '3'), unit('u1', HEAD_A)]) });
    const merge = (resolution: object[]) => {
      git(m, ['merge', '-q', '--no-ff', '--no-commit', 'side'], false);
      write(m, { 'wiki/panel.json': panel(resolution) });
      git(m, ['add', '-A']); git(m, ['commit', '-q', '--no-edit', '-m', 'merge']);
      return git(m, ['rev-parse', 'HEAD']);
    };
    const clean = merge([unit('u3', 'c'.repeat(39) + '3'), unit('u1', HEAD_A), unit('u2', HEAD_B)]);
    expect(found(m).map(f => f.commit).sort()).toEqual([side, ours].sort());
    expect(found(m).map(f => f.commit)).not.toContain(clean);
    git(m, ['reset', '-q', '--hard', ours]);
    const added = merge([unit('u3', 'c'.repeat(39) + '3'), unit('u1', HEAD_A), unit('u2', HEAD_B), unit('u4', 'd'.repeat(39) + '4')]);
    const atMerge = found(m).filter(f => f.commit === added);
    expect(atMerge).toEqual([{ rule: 'sealed.label_join', file: 'wiki/panel.json', commit: added, keys: ['stratum', 'tags', 'head', 'plan_bytes'] }]);
  });
});

describe('fail closed, waivers, allow_paths and the policy union (gstack-pregate sealed)', () => {
  test('an oversized valid JSON, malformed JSON, a malformed JSONL line, nesting deeper than 64 and an unreadable blob are each sealed.label_join_unchecked; an empty file is clear', () => {
    const s = scratch({ '.gstack/pregate.json': policy(LABELED) });
    let deep: unknown = { stratum: 'decoy' };
    for (let i = 0; i < 70; i++) deep = { next: deep };
    const sha = commit(s, {
      'big.json': JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024 + 10), units: [] }),
      'bad.json': '{"stratum": "decoy",',
      'bad.jsonl': '{"stratum":"decoy"}\nnot json\n',
      'deep.json': JSON.stringify(deep),
      'gone.json': '{"note":"this blob is removed after the commit"}\n',
      'empty.json': '',
    });
    const blob = git(s, ['rev-parse', 'HEAD:gone.json']);
    fs.rmSync(path.join(s.work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const r = preflight(s);
    expect(r.code).toBe(1);
    for (const f of ['big.json', 'bad.json', 'bad.jsonl', 'deep.json', 'gone.json']) expect(r.err).toContain(`sealed.label_join_unchecked  ${f}  commit ${sha.slice(0, 12)}`);
    expect(r.err).not.toContain('empty.json');
    expect(r.out).toMatch(/^SEALED: refused findings=5 commits=1 .* exempt=0 unchecked=5 policy=/m);
    const json = JSON.parse(preflight(s, ['--json']).out);
    expect(json.findings.map((f: { rule: string; file: string }) => `${f.rule} ${f.file}`).sort()).toEqual(['bad.json', 'bad.jsonl', 'big.json', 'deep.json', 'gone.json'].map(f => `sealed.label_join_unchecked ${f}`));
  });

  test('allow_paths never exempt the rule; a short-sha waiver is ignored and the full sha waives', () => {
    const s = scratch({ '.gstack/pregate.json': policy({ ...LABELED, paths: ['heldout/**'], allow_paths: ['wiki/board/panel.json'] }) });
    const sha = commit(s, { 'wiki/board/panel.json': panel([unit('u1', HEAD_A)]) });
    const r = preflight(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/findings=1 .* exempt=0 policy=/);
    landOnMain(s, { '.gstack/sealed-allow.tsv': `sealed.label_join\twiki/board/panel.json\t${sha.slice(0, 12)}\tsynthetic fixture\n` });
    const short = preflight(s);
    expect(short.code).toBe(1);
    expect(short.err).toContain('ignored waiver sealed.label_join  wiki/board/panel.json');
    landOnMain(s, { '.gstack/sealed-allow.tsv': `sealed.label_join\twiki/board/panel.json\t${sha}\tsynthetic fixture\n` });
    const full = preflight(s);
    expect(full.code).toBe(0);
    expect(full.err).toContain('waived sealed.label_join  wiki/board/panel.json');
  });

  test('a push can enable or widen the rule but never disable or narrow it', () => {
    const leak = { 'wiki/panel.json': panel([unit('u1', HEAD_A)]) };
    for (const pushed of [{ paths: ['heldout/**'] }, { ...LABELED, identifier_keys: ['zzz'] }, { label_keys: [] as string[], identifier_keys: [] as string[] }]) {
      const s = scratch({ '.gstack/pregate.json': policy(LABELED) });
      commit(s, { '.gstack/pregate.json': policy(pushed), ...leak });
      const r = preflight(s);
      expect(r.code).toBe(1);
      expect(r.err).toContain('sealed.label_join  wiki/panel.json');
      expect(r.err).toContain('head,plan_bytes');
    }
    const enable = scratch({ '.gstack/pregate.json': policy({ paths: ['heldout/**'] }) });
    commit(enable, { '.gstack/pregate.json': policy(LABELED), ...leak });
    expect(preflight(enable).err).toContain('sealed.label_join  wiki/panel.json');
  });

  test('label_keys: [] reports exactly what an absent label_keys reports', () => {
    const run = (sealed: object) => {
      const s = scratch({ '.gstack/pregate.json': policy(sealed) });
      commit(s, { 'wiki/panel.json': panel([unit('u1', HEAD_A)]), 'runs/c1/transcript.jsonl': '{}\n' });
      const norm = (t: string) => t.split(s.root).join('<root>').replace(/[0-9a-f]{12,64}/g, '<sha>');
      const text = preflight(s); const json = preflight(s, ['--json']);
      return [text.code, norm(text.out), norm(text.err), json.code, norm(json.out)];
    };
    const base = { transcripts: ['runs/**/transcript*.jsonl'] };
    expect(run({ ...base, label_keys: [] })).toEqual(run(base));
  });
});
