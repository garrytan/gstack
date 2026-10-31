/**
 * Field wave CD4: the sealed-output guard. A repo that declares `sealed` in
 * `.gstack/pregate.json` cannot push sealed or eval output to a public
 * destination by accident: the managed pre-push hook and
 * `gstack-pregate sealed` enumerate every commit the push publishes (local
 * sha minus everything the destination remote already has), apply path
 * rules to every added, renamed or copied path (binary and empty files,
 * add-then-delete) and text rules to each commit's added lines. The policy
 * is the union of the base branch's and the pushed one; waivers come only
 * from the base branch's allow file; an unknown visibility counts as public.
 * Field incident: a per-cell transcript, a quoted sealed answer, a seed and a
 * /home/user path were pushed to a public eval repo with exit 0 and no output.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVisibility } from '../lib/sealed-guard';

const ROOT = path.resolve(import.meta.dir, '..');
const PREPUSH = path.join(ROOT, 'bin', 'gstack-redact-prepush');
const PREGATE = path.join(ROOT, 'bin', 'gstack-pregate');
const ZERO = '0'.repeat(40);
const SEALED = {
  paths: ['heldout/**'],
  transcripts: ['runs/**/transcript*.jsonl'],
  answer_markers: ['SEALED ANSWER:'],
  seed_patterns: ['shuffle_seed=\\d+'],
  local_paths: true,
};

interface Scratch { root: string; work: string; origin: string; state: string; env: Record<string, string> }
const scratches: Scratch[] = [];
afterEach(() => { while (scratches.length) fs.rmSync(scratches.pop()!.root, { recursive: true, force: true }); });

function sh(cwd: string, env: Record<string, string>, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A bare origin with main carrying the given base files, and a clone on branch `results`. */
function scratch(baseFiles: Record<string, string | Buffer>, objectFormat: 'sha1' | 'sha256' = 'sha1'): Scratch {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-guard-')));
  const work = path.join(root, 'work'); const origin = path.join(root, 'origin.git'); const state = path.join(root, 'state');
  fs.mkdirSync(work); fs.mkdirSync(state);
  const env = { HOME: root, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`);
  spawnSync('git', ['init', '-q', '--bare', `--object-format=${objectFormat}`, origin], { env: { ...process.env, ...env }, timeout: 30_000 });
  sh(work, env, ['init', '-q', '-b', 'main', `--object-format=${objectFormat}`]);
  write(work, { 'README.md': '# evals\n', ...baseFiles });
  sh(work, env, ['add', '-A']); sh(work, env, ['commit', '-q', '-m', 'base']);
  sh(work, env, ['remote', 'add', 'origin', origin]);
  sh(work, env, ['push', '-q', 'origin', 'main']);
  sh(work, env, ['remote', 'set-head', 'origin', 'main']);
  sh(work, env, ['checkout', '-q', '-b', 'results']);
  const s = { root, work, origin, state, env };
  scratches.push(s);
  return s;
}
function write(work: string, files: Record<string, string | Buffer | null>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(work, rel);
    if (body === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}
function commit(s: Scratch, files: Record<string, string | Buffer | null>, msg = 'results'): string {
  write(s.work, files);
  sh(s.work, s.env, ['add', '-A']); sh(s.work, s.env, ['commit', '-q', '-m', msg]);
  return sh(s.work, s.env, ['rev-parse', 'HEAD']);
}
const policy = (sealed: unknown) => JSON.stringify({ sealed }, null, 2) + '\n';

/** Drive the hook exactly as git does for `git push origin results` (a new remote branch). */
function hook(s: Scratch, extraEnv: Record<string, string> = {}) {
  const head = sh(s.work, s.env, ['rev-parse', 'HEAD']);
  const r = spawnSync('bun', [PREPUSH, 'origin', s.origin], { cwd: s.work, input: `refs/heads/results ${head} refs/heads/results ${ZERO}\n`, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env, ...extraEnv } });
  return { code: r.status, err: r.stderr ?? '' };
}

describe('pre-push hook: public destination refuses each kind of sealed output', () => {
  test('a transcript, a sealed answer, a seed and a local home path each refuse, naming file, line and rule, never the matched text', () => {
    const cases: Array<[Record<string, string | Buffer>, string, RegExp]> = [
      [{ 'runs/cat40/cell-07/transcript.jsonl': '{"q":"x"}\n' }, 'sealed.transcript', /sealed\.transcript\s+runs\/cat40\/cell-07\/transcript\.jsonl/],
      [{ 'runs/cat40/summary.md': 'intro\nSEALED ANSWER: fund-a led the round\n' }, 'sealed.answer', /sealed\.answer\s+runs\/cat40\/summary\.md:2/],
      [{ 'runs/cat40/summary.md': 'run with shuffle_seed=42\n' }, 'sealed.seed', /sealed\.seed\s+runs\/cat40\/summary\.md:1/],
      [{ 'runs/cat40/summary.md': 'raw at /home/user/.capy/work/evals/raw.jsonl\n' }, 'sealed.local_path', /sealed\.local_path\s+runs\/cat40\/summary\.md:1/],
    ];
    for (const [files, rule, where] of cases) {
      const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
      commit(s, files);
      const r = hook(s);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(where);
      expect(r.err).toContain(rule);
      expect(r.err).toContain('(SEALED_OUTPUT_REFUSED)');
      expect(r.err).toContain('sealed.visibility');
      expect(r.err).not.toContain('fund-a led');
    }
  });

  test('local_path matches a home path after every shell parameter-expansion operator, and still skips hyphenated words', () => {
    const positives = [
      'RUNNER="${UBI_RUNNER:-/home/user/.capy/drive/runner}"',
      'RUNNER="${UBI_RUNNER-/home/user/runner}"',
      'RUNNER="${UBI_RUNNER:=/home/user/runner}"',
      'RUNNER="${UBI_RUNNER:+/Users/bob/runner}"',
      'RUNNER="${UBI_RUNNER:?/home/user/runner}"',
      'ROOT="${1:-/Users/bob/work}"',
      'ROOT="${@:-/home/user/work}"',
      'ROOT="${arr[0]:-/home/user/work}"',
      'ROOT="${!ref:-/home/user/work}"',
      'ROOT="${WIN_ROOT:-C:\\Users\\bob\\work}"',
      'const dir = process.env.UBI_WORK ?? "/home/ubi/work";',
    ];
    const negatives = [
      'see docs-/home/user/x for the old layout',
      'mount at data-/Users/bob/cache',
      'RUNNER="$UBI_RUNNER-/home/user/runner"',
      'RUNNER="${UBI_RUNNER}-/home/user/runner"',
      'RUNNER="${UBI_RUNNER:-./runner}"',
      'a well-known, self-hosted, run-to-completion job',
    ];
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(s, { 'runner/launch.sh': [...positives, ...negatives].join('\n') + '\n' });
    const r = hook(s);
    expect(r.code).toBe(1);
    const flagged = [...r.err.matchAll(/sealed\.local_path\s+runner\/launch\.sh:(\d+)/g)].map(m => Number(m[1]));
    expect(flagged).toEqual(positives.map((_, i) => i + 1));
  });

  test('path rules ignore content: a binary file, an empty transcript, an add-then-delete and a rename into a sealed path all refuse', () => {
    const binary = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(binary, { 'heldout/questions.bin': Buffer.from([0, 1, 2, 0, 255, 0]) });
    expect(hook(binary).err).toMatch(/sealed\.path\s+heldout\/questions\.bin/);
    const empty = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(empty, { 'runs/c1/transcript.jsonl': '' });
    expect(hook(empty).code).toBe(1);
    const gone = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const added = commit(gone, { 'runs/c1/transcript.jsonl': '{"q":1}\n' });
    commit(gone, { 'runs/c1/transcript.jsonl': null }, 'remove it again');
    const g = hook(gone);
    expect(g.code).toBe(1);
    expect(g.err).toContain(`sealed.transcript  runs/c1/transcript.jsonl  commit ${added.slice(0, 12)}`);
    const moved = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(moved, { 'scratch/t.jsonl': '{"q":1}\n{"q":2}\n{"q":3}\n' });
    fs.mkdirSync(path.join(moved.work, 'heldout'));
    sh(moved.work, moved.env, ['mv', 'scratch/t.jsonl', 'heldout/t.jsonl']);
    sh(moved.work, moved.env, ['commit', '-q', '-m', 'move']);
    expect(hook(moved).err).toMatch(/sealed\.path\s+heldout\/t\.jsonl/);
  });

  test('commits the destination already has are not this push: a branch from main that only adds a doc passes', () => {
    const s = scratch({ 'runs/old/transcript.jsonl': '{"q":"published before the policy"}\n', '.gstack/pregate.json': policy(SEALED) });
    commit(s, { 'docs/notes.md': 'notes\n' });
    const r = hook(s);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('sealed.');
  });
});

describe('policy union, waivers, private destinations and fail-closed parsing', () => {
  test('a push can tighten the policy but never relax it: dropping the base sealed config does not let a transcript through', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(s, { '.gstack/pregate.json': '{}\n', 'runs/c1/transcript.jsonl': '{}\n' });
    expect(hook(s).code).toBe(1);
    const tighten = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(tighten, { '.gstack/pregate.json': policy({ ...SEALED, paths: ['heldout/**', 'cells/**'] }), 'cells/c1.json': '{}\n' });
    expect(hook(tighten).err).toMatch(/sealed\.path\s+cells\/c1\.json/);
  });

  test('a waiver counts only from the base branch allow file and is listed; the same line committed in the push is ignored', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const sha = commit(s, { 'runs/c1/transcript.jsonl': '{}\n' });
    const allow = `# rule\tpath\tsha\treason\nsealed.transcript\truns/c1/transcript.jsonl\t${sha}\tsynthetic fixture, no sealed content\n`;
    commit(s, { '.gstack/sealed-allow.tsv': allow });
    expect(hook(s).code).toBe(1);
    sh(s.work, s.env, ['checkout', '-q', 'main']);
    write(s.work, { '.gstack/sealed-allow.tsv': allow });
    sh(s.work, s.env, ['add', '-A']); sh(s.work, s.env, ['commit', '-q', '-m', 'allow']); sh(s.work, s.env, ['push', '-q', 'origin', 'main']);
    sh(s.work, s.env, ['checkout', '-q', 'results']);
    const r = hook(s);
    expect(r.code).toBe(0);
    expect(r.err).toContain('waived sealed.transcript  runs/c1/transcript.jsonl');
  });

  test('a private destination (base override) warns and passes; a repo without the key sees no change; a malformed sealed policy refuses', () => {
    const priv = scratch({ '.gstack/pregate.json': policy({ ...SEALED, visibility: 'private' }) });
    commit(priv, { 'runs/c1/transcript.jsonl': '{}\n' });
    const p = hook(priv);
    expect(p.code).toBe(0);
    expect(p.err).toMatch(/warning.*sealed\.transcript\s+runs\/c1\/transcript\.jsonl/s);
    const none = scratch({});
    commit(none, { 'runs/c1/transcript.jsonl': '{}\n' });
    const n = hook(none);
    expect(n.code).toBe(0);
    expect(n.err).not.toContain('sealed');
    const bad = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(bad, { '.gstack/pregate.json': policy({ paths: 'heldout/**' }), 'docs/x.md': 'x\n' });
    const b = hook(bad);
    expect(b.code).toBe(1);
    expect(b.err).toContain('(SEALED_OUTPUT_REFUSED)');
    expect(b.err).toContain('sealed policy');
  });
});

describe('gstack-pregate sealed (the standalone preflight before any push or PR creation)', () => {
  test('--range refuses the same findings with exit 1; the default range is what origin does not have yet', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(s, { 'runs/c1/transcript.jsonl': '{}\n' });
    const run = (args: string[]) => spawnSync(PREGATE, ['sealed', ...args], { cwd: s.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
    const ranged = run(['--range', 'origin/main..HEAD', '--base', 'main']);
    expect(ranged.status).toBe(1);
    expect(ranged.stderr).toMatch(/sealed\.transcript\s+runs\/c1\/transcript\.jsonl/);
    expect(ranged.stdout).toMatch(/^SEALED: refused findings=1 commits=1 visibility=unknown \(counted public\)/m);
    const dflt = run(['--base', 'main']);
    expect(dflt.status).toBe(1);
    sh(s.work, s.env, ['push', '-q', 'origin', 'results']);
    const after = run(['--base', 'main']);
    expect(after.status).toBe(0);
    expect(after.stdout).toMatch(/^SEALED: clear findings=0 commits=0/m);
  });
});

const MANIFEST = { paths: ['**/sealed/**'], allow_paths: ['**/sealed/*/MANIFEST.json'], answer_markers: ['SEALED ANSWER:'] };
function preflight(s: Scratch, args: string[] = []) {
  const r = spawnSync(PREGATE, ['sealed', '--base', 'main', ...args], { cwd: s.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function landOnMain(s: Scratch, files: Record<string, string>): void {
  sh(s.work, s.env, ['checkout', '-q', 'main']);
  write(s.work, files);
  sh(s.work, s.env, ['add', '-A']); sh(s.work, s.env, ['commit', '-q', '-m', 'base change']); sh(s.work, s.env, ['push', '-q', 'origin', 'main']);
  sh(s.work, s.env, ['checkout', '-q', 'results']);
}

describe('sealed.allow_paths: base-branch exceptions applied after the deny globs', () => {
  test('a deny with an allowed exception refuses the sealed file, lists the manifest as exempt, and a manifest-only push passes', () => {
    const s = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(s, { 'sealed/s1/tasks.json': '{}\n', 'sealed/s1/MANIFEST.json': '{"n":1}\n', 'tasks/x/sealed/s2/MANIFEST.json': '{"n":2}\n' });
    const r = hook(s);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^  sealed\.path\s+sealed\/s1\/tasks\.json/m);
    expect(r.err).not.toMatch(/^  sealed\.path\s+\S*MANIFEST\.json/m);
    expect(r.err).toMatch(/exempt sealed\.path  sealed\/s1\/MANIFEST\.json  commit [0-9a-f]{12} \(sealed\.allow_paths \*\*\/sealed\/\*\/MANIFEST\.json\)/);
    expect(r.err).toContain('exempt sealed.path  tasks/x/sealed/s2/MANIFEST.json');
    const only = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(only, { 'sealed/s1/MANIFEST.json': '{"n":1}\n' });
    expect(hook(only).code).toBe(0);
    const pre = preflight(only);
    expect(pre.code).toBe(0);
    expect(pre.out).toMatch(/^SEALED: clear findings=0 commits=1 visibility=unknown \(counted public\) waived=0 exempt=1 policy=/m);
    const json = JSON.parse(preflight(only, ['--json']).out);
    expect(json.exempt).toHaveLength(1);
    expect(json.exempt[0]).toMatchObject({ rule: 'sealed.path', file: 'sealed/s1/MANIFEST.json', glob: '**/sealed/*/MANIFEST.json' });
  });

  test('an exception that does not match still refuses: another case and another depth', () => {
    for (const file of ['sealed/s1/manifest.json', 'sealed/s1/x/MANIFEST.json']) {
      const s = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
      commit(s, { [file]: '{}\n' });
      const r = hook(s);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`sealed.path  ${file}`);
      expect(r.err).not.toContain('exempt sealed.');
    }
  });

  test('an exception added on the pushed head is ignored, on top of a base list too; a malformed pushed allow_paths refuses', () => {
    const fresh = scratch({ '.gstack/pregate.json': policy({ paths: ['**/sealed/**'] }) });
    commit(fresh, { '.gstack/pregate.json': policy(MANIFEST), 'sealed/s1/MANIFEST.json': '{}\n' });
    const f = hook(fresh);
    expect(f.code).toBe(1);
    expect(f.err).toContain('sealed.path  sealed/s1/MANIFEST.json');
    const extra = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(extra, { '.gstack/pregate.json': policy({ ...MANIFEST, allow_paths: [...MANIFEST.allow_paths, '**/sealed/*/notes.md'] }), 'sealed/s1/notes.md': 'n\n' });
    expect(hook(extra).err).toContain('sealed.path  sealed/s1/notes.md');
    const bad = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(bad, { '.gstack/pregate.json': policy({ ...MANIFEST, allow_paths: '**/sealed/*/MANIFEST.json' }), 'docs/x.md': 'x\n' });
    const b = hook(bad);
    expect(b.code).toBe(1);
    expect(b.err).toContain('sealed.allow_paths');
  });

  test('an allowed manifest that quotes a sealed answer still refuses on the text rule', () => {
    const s = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(s, { 'sealed/s1/MANIFEST.json': '{"note":"SEALED ANSWER: b"}\n' });
    const r = hook(s);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sealed\.answer\s+sealed\/s1\/MANIFEST\.json:1/);
    expect(r.err).toContain('exempt sealed.path  sealed/s1/MANIFEST.json');
  });

  test('an exception covers sealed.transcript too and is counted before a base sha waiver, never both', () => {
    const s = scratch({ '.gstack/pregate.json': policy({ paths: ['**/sealed/**'], transcripts: ['**/transcript*.jsonl'], allow_paths: ['**/sealed/*/transcript-public.jsonl'] }) });
    const sha = commit(s, { 'sealed/s1/transcript-public.jsonl': '{}\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': `sealed.transcript\tsealed/s1/transcript-public.jsonl\t${sha}\tsynthetic fixture\n` });
    const pre = preflight(s);
    expect(pre.code).toBe(0);
    expect(pre.err).toContain('exempt sealed.transcript  sealed/s1/transcript-public.jsonl');
    expect(pre.out).toMatch(/findings=0 .* waived=0 exempt=1 /);
  });

  test('a preflight error carries the same report shape: exit 1, SEALED: error with exempt=0, no stack trace', () => {
    const s = scratch({ '.gstack/pregate.json': policy(MANIFEST) });
    commit(s, { 'docs/x.md': 'x\n' });
    const r = preflight(s, ['--range', 'nosuch..HEAD']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEALED: error findings=0 commits=0 .* waived=0 exempt=0 /m);
    expect(r.err).not.toMatch(/\n\s+at /);
    expect(JSON.parse(preflight(s, ['--range', 'nosuch..HEAD', '--json']).out).exempt).toEqual([]);
  });
});

describe('sealed.case_insensitive: deny globs fold case, exceptions never do', () => {
  test('off (the default), HELDOUT/ passes a lowercase deny glob; on, HELDOUT/, HeldOut/ and a Transcript refuse, and hold-out/ still passes', () => {
    const off = scratch({ '.gstack/pregate.json': policy({ paths: ['**/heldout/**'] }) });
    commit(off, { 'HELDOUT/q.json': '{}\n' });
    expect(hook(off).code).toBe(0);
    const on = scratch({ '.gstack/pregate.json': policy({ paths: ['**/heldout/**'], transcripts: ['runs/**/transcript*.jsonl'], case_insensitive: true }) });
    commit(on, { 'HELDOUT/q.json': '{}\n', 'HeldOut/q.json': '{}\n', 'Runs/c1/Transcript.jsonl': '{}\n', 'hold-out/q.json': '{}\n' });
    const r = hook(on);
    expect(r.code).toBe(1);
    expect(r.err).toContain('sealed.path  HELDOUT/q.json');
    expect(r.err).toContain('sealed.path  HeldOut/q.json');
    expect(r.err).toContain('sealed.transcript  Runs/c1/Transcript.jsonl');
    expect(r.err).not.toContain('hold-out/q.json');
  });

  test('on, allow_paths stay case-sensitive: MANIFEST.json is exempt and manifest.json refuses', () => {
    const s = scratch({ '.gstack/pregate.json': policy({ ...MANIFEST, case_insensitive: true }) });
    commit(s, { 'sealed/s1/MANIFEST.json': '{}\n', 'sealed/s1/manifest.json': '{}\n' });
    const r = hook(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain('exempt sealed.path  sealed/s1/MANIFEST.json');
    expect(r.err).toMatch(/^  sealed\.path\s+sealed\/s1\/manifest\.json/m);
  });

  test('set only on the pushed head, it still tightens (base OR pushed)', () => {
    const s = scratch({ '.gstack/pregate.json': policy({ paths: ['**/heldout/**'] }) });
    commit(s, { '.gstack/pregate.json': policy({ paths: ['**/heldout/**'], case_insensitive: true }), 'HELDOUT/q.json': '{}\n' });
    expect(hook(s).err).toContain('sealed.path  HELDOUT/q.json');
  });
});

describe('root-anchoring (the docs/pregate.md example)', () => {
  test('globs match from the repo root: sealed/** misses a nested sealed/ directory and **/sealed/** catches it at any depth', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'pregate.md'), 'utf8');
    expect(docs).toContain('`sealed/**` misses `tasks/x/sealed/a.json`');
    expect(docs).toContain('write `**/sealed/**`');
    const anchored = scratch({ '.gstack/pregate.json': policy({ paths: ['sealed/**'] }) });
    commit(anchored, { 'tasks/x/sealed/a.json': '{}\n' });
    expect(hook(anchored).code).toBe(0);
    const any = scratch({ '.gstack/pregate.json': policy({ paths: ['**/sealed/**'] }) });
    commit(any, { 'tasks/x/sealed/a.json': '{}\n', 'sealed/b.json': '{}\n' });
    const a = hook(any);
    expect(a.err).toContain('sealed.path  tasks/x/sealed/a.json');
    expect(a.err).toContain('sealed.path  sealed/b.json');
  });
});

describe('visibility (cache under the state root; unknown counts as public)', () => {
  test('a public answer is cached; a cached private answer older than an hour is re-queried before it can downgrade; a failed lookup is unknown', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-vis-'));
    try {
      let calls = 0;
      let answer: string | null = 'PUBLIC';
      const gh = () => { calls += 1; return answer === null ? { ok: false, out: '' } : { ok: true, out: JSON.stringify({ visibility: answer }) }; };
      const env = { GSTACK_STATE_ROOT: state };
      const t0 = Date.parse('2026-10-12T00:00:00Z');
      expect(resolveVisibility('https://github.com/acme-example/evals.git', { env, gh, now: t0 }).visibility).toBe('public');
      expect(resolveVisibility('https://github.com/acme-example/evals.git', { env, gh, now: t0 + 60_000 }).visibility).toBe('public');
      expect(calls).toBe(1);
      answer = 'PRIVATE';
      expect(resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 }).visibility).toBe('private');
      expect(resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 + 30 * 60_000 }).visibility).toBe('private');
      expect(calls).toBe(2);
      answer = null;
      const stale = resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 + 2 * 3600_000 });
      expect(calls).toBe(3);
      expect(stale.visibility).toBe('unknown');
      expect(resolveVisibility('/srv/git/evals.git', { env, gh, now: t0 }).visibility).toBe('unknown');
      expect(calls).toBe(3);
      expect(fs.existsSync(path.join(state, 'sealed-visibility.json'))).toBe(true);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });
});

describe('gstack-pregate sealed is a check, not a push (#3565)', () => {
  test('the SEALED line names the checked commit, never says pushed, and the remote ref does not move', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const head = commit(s, { 'notes.md': 'ok\n' });
    const before = sh(s.work, s.env, ['ls-remote', 'origin']);
    const r = spawnSync('bun', [PREGATE, 'sealed'], { cwd: s.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`policy=origin/main + commit ${head.slice(0, 12)}`);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\bpushed\b/);
    expect(sh(s.work, s.env, ['ls-remote', 'origin'])).toBe(before);
    expect(before).not.toContain('refs/heads/results');
  });
});

describe('waivers name the full commit sha (GST-268)', () => {
  const TRANSCRIPT = 'runs/c1/transcript.jsonl';
  const line = (sha: string) => `sealed.transcript\t${TRANSCRIPT}\t${sha}\tsynthetic fixture\n`;

  const PREFIX = 'must name the full lowercase commit sha';
  const OTHER = 'it names another commit';
  const SHORT: Array<[string, (x: string) => string, string]> = [['a 7-character prefix', x => x.slice(0, 7), PREFIX], ['a 12-character prefix', x => x.slice(0, 12), PREFIX], ['a 39-character prefix', x => x.slice(0, 39), PREFIX], ['an uppercase sha', x => x.toUpperCase(), PREFIX], ['one extra character', x => `${x}a`, OTHER]];
  test.each(SHORT)('%s does not waive and is named as ignored with the full commit', (_label, cut, why) => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const sha = commit(s, { [TRANSCRIPT]: '{}\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': line(cut(sha)) });
    const h = hook(s);
    expect(h.code).toBe(1);
    expect(h.err).toContain(`ignored waiver sealed.transcript  ${TRANSCRIPT}  sha ${cut(sha)}`);
    expect(h.err).toContain(`${why}; this finding is in commit ${sha}, review it before waiving)`);
    const pre = preflight(s);
    expect(pre.code).toBe(1);
    expect(pre.out).toMatch(/^SEALED: refused findings=1 .* waived=0 /m);
    expect(JSON.parse(preflight(s, ['--json']).out).ignoredWaivers).toEqual([{ rule: 'sealed.transcript', path: TRANSCRIPT, sha: cut(sha), commit: sha }]);
  });

  test('the full 40-character sha waives, trailing whitespace included, with no ignored note', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const sha = commit(s, { [TRANSCRIPT]: '{}\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': line(`${sha} `) });
    const r = hook(s);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`waived sealed.transcript  ${TRANSCRIPT}`);
    expect(r.err).not.toContain('ignored waiver');
    expect(JSON.parse(preflight(s, ['--json']).out).ignoredWaivers).toEqual([]);
  });

  test("the full sha of a different commit does not waive this commit's file at the same path", () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const first = commit(s, { [TRANSCRIPT]: '{}\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': line(first) });
    sh(s.work, s.env, ['reset', '-q', '--hard', 'origin/main']);
    const second = commit(s, { [TRANSCRIPT]: '{"other":1}\n' });
    const r = hook(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`ignored waiver sealed.transcript  ${TRANSCRIPT}  sha ${first}`);
    expect(r.err).toContain(`it names another commit; this finding is in commit ${second}`);
  });

  test("a short waiver for an older commit is named as another commit, never as this commit's shortened sha", () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const first = commit(s, { [TRANSCRIPT]: '{}\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': line(first.slice(0, 7)) });
    sh(s.work, s.env, ['reset', '-q', '--hard', 'origin/main']);
    const second = commit(s, { [TRANSCRIPT]: '{"other":1}\n' });
    expect(second.startsWith(first.slice(0, 7))).toBe(false);
    const r = hook(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`ignored waiver sealed.transcript  ${TRANSCRIPT}  sha ${first.slice(0, 7)} (${OTHER}; this finding is in commit ${second}, review it before waiving)`);
    expect(r.err).not.toContain(PREFIX);
  });

  test('a short waiver line on the base branch prints nothing on a push with no matching finding', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED), '.gstack/sealed-allow.tsv': line('abc1234') });
    commit(s, { 'notes.md': 'ok\n' });
    const r = hook(s);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('ignored waiver');
  });

  const SHA256: Array<[string, (x: string) => string, boolean]> = [['the full 64 characters waive', x => x, true], ['a 40-character prefix does not', x => x.slice(0, 40), false], ['a 63-character prefix does not', x => x.slice(0, 63), false], ['65 characters do not', x => `${x}a`, false]];
  test.each(SHA256)('a SHA-256 repository: %s', (_label, cut, waives) => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) }, 'sha256');
    const sha = commit(s, { [TRANSCRIPT]: '{}\n' });
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    landOnMain(s, { '.gstack/sealed-allow.tsv': line(cut(sha)) });
    const pre = preflight(s);
    expect(pre.code).toBe(waives ? 0 : 1);
    expect(pre.err.includes('ignored waiver')).toBe(!waives);
    if (!waives) expect(pre.err).toContain(`${cut(sha).length < 64 ? PREFIX : OTHER}; this finding is in commit ${sha}, review it before waiving)`);
  });

  test('a waiver that applied in one commit is not reported as ignored for a later commit at the same path', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const first = commit(s, { 'notes/a.md': 'SEALED ANSWER: b\n' });
    const second = commit(s, { 'notes/a.md': 'SEALED ANSWER: b\nSEALED ANSWER: c\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': `sealed.answer\tnotes/a.md\t${first}\tsynthetic fixture\n` });
    const j = JSON.parse(preflight(s, ['--json']).out);
    expect(j.waived.map((w: { commit: string }) => w.commit)).toEqual([first]);
    expect(j.findings.map((f: { commit: string }) => f.commit)).toEqual([second]);
    expect(j.ignoredWaivers).toEqual([]);
  });

  test('a short waiver for a text rule with several matching lines is named once', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    const sha = commit(s, { 'notes/a.md': 'SEALED ANSWER: b\nSEALED ANSWER: c\n' });
    landOnMain(s, { '.gstack/sealed-allow.tsv': `sealed.answer\tnotes/a.md\t${sha.slice(0, 7)}\tsynthetic fixture\n` });
    const j = JSON.parse(preflight(s, ['--json']).out);
    expect(j.findings).toHaveLength(2);
    expect(j.ignoredWaivers).toEqual([{ rule: 'sealed.answer', path: 'notes/a.md', sha: sha.slice(0, 7), commit: sha }]);
  });

  test('an error report carries an empty ignoredWaivers list', () => {
    const s = scratch({ '.gstack/pregate.json': policy(SEALED) });
    commit(s, { 'notes.md': 'ok\n' });
    expect(JSON.parse(preflight(s, ['--range', 'nosuch..HEAD', '--json']).out).ignoredWaivers).toEqual([]);
  });
});
