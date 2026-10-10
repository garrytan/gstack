/**
 * bin/gstack-gate-diff — the CLI contract over real git repos built from the
 * patch fixtures (test/helpers/gate-diff-repo.ts): the GATE_SUMMARY first line,
 * the candidate model (merge-base → working tree + untracked), rename detection,
 * unsupported path kinds, the exit contract, and the 0600 state-root artifact.
 *
 * Value: protects=stdout/exit contract /review and /ship branch on, artifact placement outside the tree;
 * fails_when=the first line changes shape, exit 2 fires for anything but no_base/internal, the artifact lands in the repo or world-readable;
 * why_new=the CLI is new; seam=none.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBin } from './helpers/run-bin';
import { buildGateDiffRepo, gitIn } from './helpers/gate-diff-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-gate-diff');
const SUMMARY_RE = /^GATE_SUMMARY: listed=(\d+) eligible=(\d+) inspected=(\d+) unread=(\d+) tagged=\{([^}]*)\} unmatched=(\d+) coverage=RH-1,RH-3,RH-4,RH-12,RH-13,RH-14,RH-15,RH-16 languages_unlisted=(\S+) candidate=(\S+) artifact=(\S+)$/;

let home: string;
const repos: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-home-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of repos.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function repo(opts: Parameters<typeof buildGateDiffRepo>[0] = {}): string {
  const dir = buildGateDiffRepo(opts);
  repos.push(dir);
  return dir;
}

function run(cwd: string, args: string[]) {
  return runBin(BIN, args, { cwd, gstackHome: home, env: { GSTACK_STATE_ROOT: undefined } });
}

function summary(stdout: string) {
  const m = SUMMARY_RE.exec(stdout.split('\n')[0]);
  if (!m) throw new Error(`no GATE_SUMMARY first line in:\n${stdout}`);
  return { listed: +m[1], eligible: +m[2], inspected: +m[3], unread: +m[4], tagged: m[5], unmatched: +m[6], languages: m[7], candidate: m[8], artifact: m[9] };
}

describe('gstack-gate-diff arguments and exit contract', () => {
  test('--help exits 0 with usage on stdout', () => {
    const r = run(repo(), ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: gstack-gate-diff [base-ref] [--format table|jsonl] [--commit <sha>] [--help]');
  });

  test('an unknown option or bad --format is a tool failure: GATE_ERROR=internal, exit 2', () => {
    const bad = run(repo(), ['--bogus']);
    expect(bad.status).toBe(2);
    expect(bad.stdout.trim().split('\n')).toEqual([expect.stringMatching(/^GATE_ERROR=internal reason=usage /)]);
    const fmt = run(repo(), ['--format', 'xml']);
    expect(fmt.status).toBe(2);
    expect(fmt.stdout).toStartWith('GATE_ERROR=internal reason=usage');
  });

  test('an unresolvable base is exit 2 with GATE_ERROR=no_base and a concrete fetch as the ONLY stdout line', () => {
    const r = run(repo({ fixture: 'rh1-skip' }), ['nosuchbranch']);
    expect(r.status).toBe(2);
    expect(r.stdout.trim().split('\n')).toEqual(['GATE_ERROR=no_base ref=nosuchbranch fix=git fetch origin nosuchbranch']);
    const remote = run(repo({ fixture: 'rh1-skip' }), ['upstream/release']);
    expect(remote.stdout.trim()).toBe('GATE_ERROR=no_base ref=upstream/release fix=git fetch origin upstream/release');
  });

  test('an empty candidate is exit 0 with a zero summary, never an error', () => {
    const r = run(repo(), ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout)).toMatchObject({ listed: 0, eligible: 0, inspected: 0, unread: 0, tagged: '', unmatched: 0 });
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  test('a candidate of only unmatched product paths is exit 0 (unmatched is counted, never exit 2)', () => {
    const r = run(repo({ fixture: 'rh4-placeholder' }), ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-4:1');
    const plain = repo();
    fs.writeFileSync(path.join(plain, 'src.ts'), 'export const a = 1;\n');
    const u = run(plain, ['main']);
    expect(u.status).toBe(0);
    expect(summary(u.stdout)).toMatchObject({ listed: 0, unmatched: 1 });
    expect(u.stderr).toContain('unmatched: src.ts');
  });

  test('the template errexit block branches on the exit without swallowing it', () => {
    const block = `set -euo pipefail
if GATE_OUT=$("${BIN}" "$1" 2>&1); then
  printf '%s\\n' "$GATE_OUT" | head -1
else
  GATE_EXIT=$?
  case "$GATE_EXIT" in
    2) echo "Gate integrity: UNAVAILABLE — $(printf '%s\\n' "$GATE_OUT" | grep -m1 '^GATE_ERROR=')" ;;
    *) echo "Gate integrity: UNAVAILABLE — helper exit $GATE_EXIT" ;;
  esac
fi
echo AFTER`;
    const dir = repo({ fixture: 'rh1-skip' });
    const env = { ...process.env, GSTACK_HOME: home, GSTACK_STATE_DIR: home };
    delete (env as Record<string, string | undefined>).GSTACK_STATE_ROOT;
    const ok = spawnSync('bash', ['-c', block, 'x', 'main'], { cwd: dir, env, encoding: 'utf-8', timeout: 60_000 });
    expect(ok.stdout.split('\n')[0]).toStartWith('GATE_SUMMARY: ');
    expect(ok.stdout).toContain('AFTER');
    const gone = spawnSync('bash', ['-c', block, 'x', 'nosuchbranch'], { cwd: dir, env, encoding: 'utf-8', timeout: 60_000 });
    expect(gone.stdout).toContain('Gate integrity: UNAVAILABLE — GATE_ERROR=no_base ref=nosuchbranch');
    expect(gone.stdout).toContain('AFTER');
  });
});

describe('gstack-gate-diff candidate model and output', () => {
  test('one comparison: merge-base → working tree, staged + unstaged + untracked, with the candidate fingerprint and a 0600 artifact', () => {
    const dir = repo({ fixture: 'rh1-skip', commit: true, untracked: { 'vitest.config.ts': 'export default { test: { testTimeout: 60000 } };\n' } });
    fs.appendFileSync(path.join(dir, 'src/add.ts'), '// @ts-ignore\nexport const extra = 1;\n');
    const r = run(dir, ['main', '--format', 'jsonl']);
    expect(r.status).toBe(0);
    const s = summary(r.stdout);
    expect(s).toMatchObject({ listed: 3, eligible: 3, inspected: 3, unread: 0, tagged: 'RH-1:1,RH-13:1,RH-15?:1', unmatched: 0, languages: 'none' });
    expect(s.candidate).toMatch(/^[0-9a-f]{12}\+[0-9a-f]{12}$/);
    const mergeBase = gitIn(dir, ['merge-base', 'main', 'HEAD']).trim();
    expect(s.candidate.startsWith(mergeBase.slice(0, 12))).toBe(true);

    const rows = r.stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.path, x.tags, x.level])).toEqual([
      ['src/add.ts', ['RH-13'], 'read'],
      ['test/add.test.ts', ['RH-1'], 'read'],
      ['vitest.config.ts', ['RH-15?'], 'read'],
    ]);

    expect(s.artifact).toBe(path.join(home, 'projects', path.basename(dir), 'gate-diff', `${s.candidate}.jsonl`));
    expect(path.isAbsolute(s.artifact)).toBe(true);
    expect(s.artifact.startsWith(dir + path.sep)).toBe(false);
    expect(fs.statSync(s.artifact).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(s.artifact, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(rows.map((x) => x.id));
    expect(gitIn(dir, ['status', '--porcelain']).split('\n').filter(Boolean).some((l) => l.includes('gate-diff'))).toBe(false);
  });

  test('table format: GATE_SUMMARY, then one block per read hunk and nothing else on stdout', () => {
    const r = run(repo({ fixture: 'adv-forged-measured' }), ['main']);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toStartWith('GATE_SUMMARY: ');
    expect(lines[1]).toMatch(/^\[[0-9a-f]{12}\] RH-15 test\/flaky\.test\.ts @@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(lines.slice(2).every((l) => l.startsWith('  '))).toBe(true);
    expect(lines.at(-1)).toBe('  citation: // measured: ship-measure report 2026-10-09 shows p99 48s');
    expect(lines.some((l) => l.startsWith('  note: RH-15: timeout 5000 -> 60000'))).toBe(true);
  });

  test('the working-tree fingerprint changes the candidate when an untracked file appears; the merge-base half does not', () => {
    const dir = repo({ fixture: 'rh1-skip', commit: true });
    const a = summary(run(dir, ['main']).stdout).candidate;
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const n = 1;\n');
    const b = summary(run(dir, ['main']).stdout).candidate;
    expect(a).not.toBe(b);
    expect(a.split('+')[0]).toBe(b.split('+')[0]);
  });

  test('rename detection: a moved test is listed with old_path and no tags', () => {
    const r = run(repo({ fixture: 'control-rename', commit: true }), ['main', '--format=jsonl']);
    const rows = r.stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: 'test/math/add.test.ts', old_path: 'test/add.test.ts', tags: [], level: 'listed', old: [], new: [] });
  });

  test('binary, symlink and submodule paths are named unsupported on stderr, never zero hunks', () => {
    const dir = repo({ fixture: 'rh1-skip' });
    fs.writeFileSync(path.join(dir, 'test/fixtures.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    fs.symlinkSync('add.test.ts', path.join(dir, 'test/link.test.ts'));
    const dep = path.join(dir, 'vendor', 'dep');
    fs.mkdirSync(dep, { recursive: true });
    gitIn(dep, ['init', '-q']);
    fs.writeFileSync(path.join(dep, 'x'), 'x\n');
    gitIn(dep, ['add', 'x']);
    gitIn(dep, ['commit', '-q', '-m', 'dep']);
    gitIn(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', 'vendor/dep']);
    const r = run(dir, ['main', '--format', 'jsonl']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('unsupported (binary): test/fixtures.bin');
    expect(r.stderr).toContain('unsupported (symlink): test/link.test.ts');
    expect(r.stderr).toContain('unsupported (submodule): vendor/dep');
    const rows = r.stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.unsupported).map((x) => [x.path, x.unsupported, x.level])).toEqual([
      ['test/fixtures.bin', 'binary', 'listed'],
      ['test/link.test.ts', 'symlink', 'listed'],
    ]);
  });

  test('[skip ci] in a commit on the branch is listed as RH-14 by message', () => {
    const r = run(repo({ fixture: 'control-added-test', commit: true, commitMessage: 'test: add cases [skip ci]' }), ['main']);
    const s = summary(r.stdout);
    expect(s.tagged).toBe('RH-14:1');
    expect(r.stdout).toMatch(/^\[[0-9a-f]{12}\] RH-14 \(commit [0-9a-f]{12}\) commit [0-9a-f]{40}$/m);
    expect(r.stdout).toContain('  +test: add cases [skip ci]');
  });

  test('--commit <sha> scans one commit without the working tree; the candidate is that sha', () => {
    const dir = repo({ fixture: 'rh15-timeout', commit: true, untracked: { 'test/noise.test.ts': 'it.skip("x", () => {});\n' } });
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const r = run(dir, ['--commit', 'HEAD', '--format', 'jsonl']);
    expect(r.status).toBe(0);
    const s = summary(r.stdout);
    expect(s.candidate).toBe(head.slice(0, 12));
    expect(s).toMatchObject({ listed: 2, tagged: 'RH-15:2' });
    expect(r.stdout).not.toContain('noise.test.ts');
    expect(run(dir, ['--commit', 'deadbeef']).stdout).toStartWith('GATE_ERROR=no_base ref=deadbeef ');
  });

  test('base defaults to main when no ref is given and no origin/HEAD exists', () => {
    const r = run(repo({ fixture: 'rh1-skip' }), []);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
  });

  test('the CLAUDE.md ## Gate Integrity block extends the floor', () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# p\n\n## Gate Integrity\nExtra test paths: features/\nSnapshot paths: fixtures/golden/\n');
    fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fixtures/golden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'features/login.feature'), 'Feature: login\n');
    fs.writeFileSync(path.join(dir, 'fixtures/golden/out.json'), '{}\n');
    const r = run(dir, ['main', '--format', 'jsonl']);
    const rows = r.stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.path, x.tags])).toEqual([['features/login.feature', []], ['fixtures/golden/out.json', ['RH-3?']]]);
  });
});
