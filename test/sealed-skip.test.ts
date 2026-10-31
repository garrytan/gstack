/**
 * GSTA-156 P1: the sealed guard rescans only what the destination does not
 * already hold. gstack-evals#22 was retargeted onto main after its parent #6
 * squash-landed; its range still listed #6's seven commits (one added and
 * later deleted a held-out file), so the guard refused a push whose every
 * byte the destination already had as refs/pull/6/head. A commit is skipped
 * only when it is an ancestor of the destination's own refs/pull/<n>/head for
 * a squash (#n) on the base since the merge-base, or when its own
 * --verbatim patch-id and diff equal a base commit's. No combined-diff
 * matching; any lookup failure scans everything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const PREPUSH = path.join(ROOT, 'bin', 'gstack-redact-prepush');
const PREGATE = path.join(ROOT, 'bin', 'gstack-pregate');
const ZERO = '0'.repeat(40);
const POLICY = JSON.stringify({ sealed: { paths: ['heldout/**'], answer_markers: ['SEALED ANSWER:'], local_paths: true } }, null, 2) + '\n';

interface Scratch { root: string; work: string; origin: string; state: string; env: Record<string, string> }
const scratches: Scratch[] = [];
afterEach(() => { while (scratches.length) fs.rmSync(scratches.pop()!.root, { recursive: true, force: true }); });

function sh(s: Scratch, args: string[]): string {
  const r = spawnSync('git', args, { cwd: s.work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...s.env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function scratch(): Scratch {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-skip-')));
  const work = path.join(root, 'work'); const origin = path.join(root, 'origin.git'); const state = path.join(root, 'state');
  fs.mkdirSync(work); fs.mkdirSync(state);
  const env = { HOME: root, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const s = { root, work, origin, state, env };
  scratches.push(s);
  spawnSync('git', ['init', '-q', '--bare', origin], { env: { ...process.env, ...env }, timeout: 30_000 });
  sh(s, ['init', '-q', '-b', 'main']);
  commit(s, { 'README.md': '# evals\n', '.gstack/pregate.json': POLICY }, 'base');
  sh(s, ['remote', 'add', 'origin', origin]);
  sh(s, ['push', '-q', 'origin', 'main']);
  sh(s, ['remote', 'set-head', 'origin', 'main']);
  return s;
}
function commit(s: Scratch, files: Record<string, string | null>, msg: string): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(s.work, rel);
    if (body === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  sh(s, ['add', '-A']); sh(s, ['commit', '-q', '--allow-empty', '-m', msg]);
  return sh(s, ['rev-parse', 'HEAD']);
}

/** The #22 shape: parent #6 has seven commits (the second adds heldout/answers.json, the fifth deletes it); main lands it as one squash "(#6)"; results stacks one commit on the parent. */
function retargeted(s: Scratch, opts: { publishPull: boolean }): void {
  sh(s, ['checkout', '-q', '-b', 'parent']);
  commit(s, { 'cells/a.md': 'a\n' }, 'cell a');
  commit(s, { 'heldout/answers.json': '{"q1":"b"}\n' }, 'stage answers');
  commit(s, { 'cells/b.md': 'b\n' }, 'cell b');
  commit(s, { 'cells/c.md': 'c\n' }, 'cell c');
  commit(s, { 'heldout/answers.json': null }, 'drop answers');
  commit(s, { 'cells/d.md': 'd\n' }, 'cell d');
  commit(s, { 'cells/e.md': 'e\n' }, 'cell e');
  if (opts.publishPull) sh(s, ['push', '-q', 'origin', 'parent:refs/pull/6/head']);
  sh(s, ['checkout', '-q', 'main']);
  sh(s, ['merge', '-q', '--squash', 'parent']);
  sh(s, ['commit', '-q', '-m', 'feat: cells a-e (#6)']);
  sh(s, ['push', '-q', 'origin', 'main']);
  sh(s, ['checkout', '-q', '-b', 'results', 'parent']);
  commit(s, { 'cells/f.md': 'f\n' }, 'cell f');
}
function hook(s: Scratch, url = s.origin) {
  const head = sh(s, ['rev-parse', 'HEAD']);
  const r = spawnSync('bun', [PREPUSH, 'origin', url], { cwd: s.work, input: `refs/heads/results ${head} refs/heads/results ${ZERO}\n`, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
  return { code: r.status, err: r.stderr ?? '' };
}
function preflight(s: Scratch, args: string[] = []) {
  const r = spawnSync('bun', [PREGATE, 'sealed', '--base', 'main', ...args], { cwd: s.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('sealed skips what the destination already holds', () => {
  test('the #22 squash-retarget: seven commits published as refs/pull/6/head are skipped, the push is clear, the hook and the preflight agree, and --no-skip still refuses', () => {
    const s = scratch();
    retargeted(s, { publishPull: true });
    const h = hook(s);
    expect(h.err).toContain('skipped 7 commit(s) the destination already has as refs/pull/6/head');
    expect(h.code).toBe(0);
    const p = preflight(s);
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/^SEALED: clear findings=0 commits=1 skipped=7 /m);
    const full = preflight(s, ['--no-skip']);
    expect(full.code).toBe(1);
    expect(full.out).toMatch(/^SEALED: refused findings=1 commits=8 skipped=0 /m);
    expect(full.err).toMatch(/sealed\.path\s+heldout\/answers\.json/);
    expect(sh(s, ['for-each-ref', 'refs/gstack/'])).toBe('');
    const ledger = fs.readFileSync(path.join(s.state, 'security', 'egress.jsonl'), 'utf8');
    expect(ledger).toContain('"sink":"sealed-guard"');
  });

  test('an add-then-delete parent whose combined diff equals the squash but was never published still refuses', () => {
    const s = scratch();
    retargeted(s, { publishPull: false });
    const h = hook(s);
    expect(h.code).toBe(1);
    expect(h.err).toMatch(/sealed\.path\s+heldout\/answers\.json/);
    const p = preflight(s);
    expect(p.code).toBe(1);
    expect(p.out).toMatch(/^SEALED: refused findings=1 commits=8 skipped=0 /m);
  });

  test('a ref lookup failure scans everything and says so', () => {
    const s = scratch();
    retargeted(s, { publishPull: true });
    sh(s, ['remote', 'set-url', 'origin', path.join(s.root, 'gone.git')]);
    const h = hook(s, path.join(s.root, 'gone.git'));
    expect(h.code).toBe(1);
    expect(h.err).toContain('could not list refs/pull/<n>/head on origin');
    expect(h.err).toMatch(/sealed\.path\s+heldout\/answers\.json/);
  });

  test('a cherry-picked commit whose patch landed on the base is skipped, naming the base commit', () => {
    const s = scratch();
    sh(s, ['checkout', '-q', '-b', 'results']);
    const mine = commit(s, { 'notes.md': 'intro\nraw at /home/alice/evals/raw.jsonl\n' }, 'notes');
    sh(s, ['checkout', '-q', 'main']);
    commit(s, { 'other.md': 'x\n' }, 'unrelated');
    sh(s, ['cherry-pick', mine]);
    sh(s, ['push', '-q', 'origin', 'main']);
    const landed = sh(s, ['rev-parse', 'HEAD']);
    expect(landed).not.toBe(mine);
    sh(s, ['checkout', '-q', 'results']);
    const h = hook(s);
    expect(h.code).toBe(0);
    expect(h.err).toContain(`skipped commit ${mine.slice(0, 12)} (its patch landed on the base as ${landed.slice(0, 12)})`);
    expect(preflight(s).out).toMatch(/^SEALED: clear findings=0 commits=0 skipped=1 /m);
  });

  test('a whitespace near-miss of a landed commit is scanned and refuses', () => {
    const s = scratch();
    sh(s, ['checkout', '-q', '-b', 'results']);
    commit(s, { 'notes.md': 'intro\nraw at /home/alice/evals/raw.jsonl\n' }, 'notes');
    sh(s, ['checkout', '-q', 'main']);
    commit(s, { 'notes.md': 'intro\nraw at /home/ alice/evals/raw.jsonl\n' }, 'notes');
    sh(s, ['push', '-q', 'origin', 'main']);
    sh(s, ['checkout', '-q', 'results']);
    const h = hook(s);
    expect(h.code).toBe(1);
    expect(h.err).toMatch(/sealed\.local_path\s+notes\.md:2/);
    expect(preflight(s).out).toMatch(/^SEALED: refused findings=1 commits=1 skipped=0 /m);
  });
});
