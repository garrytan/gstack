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
    expect(r.stdout.trim().split('\n')).toEqual(['GATE_ERROR=no_base ref=nosuchbranch fix=git fetch origin +nosuchbranch:refs/remotes/origin/nosuchbranch']);
    const remote = run(repo({ fixture: 'rh1-skip' }), ['upstream/release']);
    expect(remote.stdout.trim()).toBe('GATE_ERROR=no_base ref=upstream/release fix=git fetch origin +upstream/release:refs/remotes/origin/upstream/release');
    // A relative, symbolic or full ref is not a refspec: it gets a plain fetch, never `+HEAD~9:refs/remotes/origin/HEAD~9`.
    for (const ref of ['HEAD~9', 'FETCH_HEAD', 'refs/heads/nosuch']) {
      expect([ref, run(repo({ fixture: 'rh1-skip' }), [ref]).stdout.trim()]).toEqual([ref, `GATE_ERROR=no_base ref=${ref} fix=git fetch origin`]);
    }
    // Nor does a relative ref get a remote-tracking twin: `feature~1` with no local `feature` stays no_base
    // even though `origin/feature~1` would resolve (to a commit other than the one named).
    const rooted = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-root-'));
    repos.push(rooted);
    gitIn(rooted, ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${repo({ fixture: 'rh1-skip', commit: true })}`, '.']);
    gitIn(rooted, ['checkout', '-q', '--orphan', 'solo']);
    gitIn(rooted, ['commit', '-q', '--allow-empty', '-m', 'root']);
    gitIn(rooted, ['branch', '-q', '-D', 'feature']);
    expect(gitIn(rooted, ['rev-parse', '--verify', '-q', 'origin/feature~1^{commit}']).trim()).not.toBe('');
    const rel = run(rooted, ['feature~1']);
    expect(rel.status).toBe(2);
    expect(rel.stdout.trim()).toBe('GATE_ERROR=no_base ref=feature~1 fix=git fetch origin');
  });

  test('a clone with no local main resolves the base to origin/main; the fix line it prints when that is missing too actually works', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-clone-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);
    expect(gitIn(dir, ['branch', '--list', 'main']).trim()).toBe('');
    expect(gitIn(dir, ['branch', '-r']).trim()).not.toContain('origin/main');

    const missing = run(dir, ['main']);
    expect(missing.status).toBe(2);
    expect(missing.stdout.trim()).toBe('GATE_ERROR=no_base ref=main fix=git fetch origin +main:refs/remotes/origin/main');
    // Value: protects=the fix line for a `<remote>/<branch>` base names the branch, not the tracking ref, in its refspec;
    // fails_when=noBaseFix builds the refspec from the raw ref (`origin/main:refs/remotes/origin/origin/main`) or resolveBase
    // reports a direct hit as a fallback; why_new=the only remote-form control uses a remote that does not exist, so it never
    // reaches the known-remote branch; seam=none; no_claim=nothing about remotes other than origin.
    expect(run(dir, ['origin/main']).stdout.trim()).toBe('GATE_ERROR=no_base ref=origin/main fix=git fetch origin +main:refs/remotes/origin/main');

    gitIn(dir, missing.stdout.trim().replace(/^.* fix=git /, '').split(' '));
    expect(gitIn(dir, ['branch', '--list', 'main']).trim()).toBe('');
    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: no local branch main; base is origin/main');
    const direct = run(dir, ['origin/main']);
    expect(direct.status).toBe(0);
    expect(summary(direct.stdout).tagged).toBe('RH-1:1');
    expect(direct.stderr).not.toContain('no local branch');
  });

  // Value: protects=a local base branch that shares no history with HEAD yields to its remote-tracking twin, and when
  // the twin is missing too the printed fix repairs the next run instead of looping on the stale local branch;
  // fails_when=resolveBase returns the first ref that resolves without checking it is related to HEAD, so the fix line's
  // fetch into origin/main never changes what the next run picks; why_new=the other clone tests have no local main at
  // all; seam=none; no_claim=nothing about a local branch that is related but behind.
  test('a stale local main unrelated to HEAD yields to origin/main; without the twin the fix line repairs the next run', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-stale-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);
    gitIn(dir, ['checkout', '-q', '--orphan', 'main']);
    gitIn(dir, ['rm', '-rfq', '.']);
    fs.writeFileSync(path.join(dir, 'README'), 'unrelated history\n');
    gitIn(dir, ['add', 'README']);
    gitIn(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'unrelated main']);
    gitIn(dir, ['checkout', '-q', 'feature']);
    expect(spawnSync('git', ['merge-base', 'main', 'HEAD'], { cwd: dir, timeout: 30_000 }).status).not.toBe(0);

    const stale = run(dir, ['main']);
    expect(stale.status).toBe(2);
    expect(stale.stdout.trim()).toBe('GATE_ERROR=no_base ref=main fix=git fetch origin +main:refs/remotes/origin/main');
    gitIn(dir, stale.stdout.trim().replace(/^.* fix=git /, '').split(' '));
    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: local main shares no history with HEAD; base is origin/main');
    expect(r.stderr).not.toContain('no local branch');
    // A ref name with shell metacharacters is quoted in the printed fix line (it is meant to be run verbatim).
    const odd = run(dir, ['rel;echo pwned']);
    expect(odd.status).toBe(2);
    expect(odd.stdout.trim()).toBe("GATE_ERROR=no_base ref=rel;echo pwned fix=git fetch origin '+rel;echo pwned:refs/remotes/origin/rel;echo pwned'");
  });

  // Value: protects=a local base branch that is related to HEAD but behind its remote-tracking twin yields to the twin, so
  //   commits the base already has (merged into the branch from origin) do not count as the branch's change (GST-462,
  //   GBRA-218); fails_when=resolveBase returns the local ref whenever it resolves and shares history with HEAD; seam=a
  //   tracking ref moved with update-ref, as a fetch would; no_claim=nothing about remotes other than origin.
  test('a local main behind origin/main yields to it and says so; ahead, diverged or beside an unrelated origin/main it stays the base', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-behind-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', `file://${src}`, '.']);
    gitIn(dir, ['checkout', '-q', 'main']);
    gitIn(dir, ['update-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/feature']);
    gitIn(dir, ['checkout', '-q', '-b', 'topic', 'origin/main']);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'topic note\n');
    gitIn(dir, ['add', 'NOTES.md']);
    gitIn(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'topic']);
    expect(spawnSync('git', ['merge-base', '--is-ancestor', 'main', 'origin/main'], { cwd: dir, timeout: 30_000 }).status).toBe(0);

    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('');
    expect(r.stderr).toContain('gstack-gate-diff: local main is behind origin/main; base is origin/main');
    gitIn(dir, ['update-ref', 'refs/heads/main', 'refs/remotes/origin/main']);
    const current = run(dir, ['main']);
    expect(summary(current.stdout).tagged).toBe('');
    expect(current.stderr).not.toContain('base is origin/main');
    const commitOn = (ref: string, name: string) => {
      const tree = gitIn(dir, ['rev-parse', `${ref}^{tree}`]).trim();
      const sha = gitIn(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', ref, '-m', name]).trim();
      gitIn(dir, ['update-ref', ref, sha]);
    };
    commitOn('refs/heads/main', 'unpushed');
    expect(run(dir, ['main']).stderr).not.toContain('base is origin/main');
    commitOn('refs/remotes/origin/main', 'upstream moved');
    expect(run(dir, ['main']).stderr).not.toContain('base is origin/main');
    const orphan = gitIn(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', gitIn(dir, ['rev-parse', 'HEAD^{tree}']).trim(), '-m', 'unrelated']).trim();
    gitIn(dir, ['update-ref', 'refs/remotes/origin/main', orphan]);
    expect(run(dir, ['main']).stderr).not.toContain('base is origin/main');
  });

  // Value: protects=the base cannot be redirected to the candidate by a ref the contributor controls: a tag named
  //   origin/main, or a fetched branch named origin/main (refs/remotes/origin/origin/main), never replaces origin's tracking
  //   branch, and an explicit origin/main is never re-qualified; fails_when=resolveBase resolves the twin by its short name or
  //   tries a twin for a remote-qualified ref (outside voice, pass 2: both emptied the gate scan of a test.skip); seam=refs a
  //   fetch would create; no_claim=a tag shadowing a local branch name, which predates this change
  test('a tag or a fetched branch named origin/main cannot empty the gate scan', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-shadow-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', `file://${src}`, '.']);
    gitIn(dir, ['checkout', '-q', '-b', 'topic', 'origin/feature']);
    expect(gitIn(dir, ['branch', '--list', 'main']).trim()).toBe('');
    gitIn(dir, ['tag', 'origin/main', 'HEAD']);
    expect(summary(run(dir, ['main']).stdout).tagged).toBe('RH-1:1');
    gitIn(dir, ['tag', '-d', 'origin/main']);
    gitIn(dir, ['update-ref', 'refs/remotes/origin/origin/main', 'HEAD']);
    expect(summary(run(dir, ['origin/main']).stdout).tagged).toBe('RH-1:1');
  });

  // Value: protects=a clone whose only remote is not called origin resolves the base through that remote and the fix line
  // fetches from it; fails_when=remoteNames or resolveBase hard-code origin, or noBaseFix falls back to the literal 'origin'
  // while a real remote exists; why_new=every existing fixture has either an origin remote or none; seam=none;
  // no_claim=nothing about the order when origin and another remote both carry the branch.
  test('a clone whose only remote is upstream resolves the base to upstream/main, and the fix line fetches from upstream', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-upstream-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '-o', 'upstream', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);
    expect(gitIn(dir, ['remote']).trim()).toBe('upstream');

    const missing = run(dir, ['main']);
    expect(missing.status).toBe(2);
    expect(missing.stdout.trim()).toBe('GATE_ERROR=no_base ref=main fix=git fetch upstream +main:refs/remotes/upstream/main');

    gitIn(dir, missing.stdout.trim().replace(/^.* fix=git /, '').split(' '));
    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: no local branch main; base is upstream/main');
  });

  // Value: protects=resolveBase walks past origin to the other remotes (origin exists but lacks the branch, upstream has it);
  // fails_when=the loop stops after origin or only consults origin when origin exists; why_new=the upstream-only test has one
  // remote and the origin tests have only origin, so the second iteration was never reached; seam=none; no_claim=nothing about
  // which remote wins when both carry the branch.
  test('origin without main and upstream with it: the base is upstream/main', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-two-remotes-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);
    gitIn(dir, ['remote', 'add', 'upstream', `file://${src}`]);
    gitIn(dir, ['fetch', '-q', 'upstream', 'main:refs/remotes/upstream/main']);
    expect(gitIn(dir, ['branch', '-r']).trim()).not.toContain('origin/main');
    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: no local branch main; base is upstream/main');
  });

  // Value: protects=the default base (no argument) is found through the same remote list as resolveBase and the fix line, so an
  // upstream-only clone of a master-default repository defaults to upstream/master instead of a `main` that exists nowhere;
  // fails_when=defaultBase probes only `origin/<name>`; why_new=no test ran without a base in a clone whose remote is not
  // origin; seam=the remote HEAD symref is removed first because single-branch clones set it on some git versions and not
  // others; no_claim=nothing about a remote HEAD that points at the feature branch.
  test('no explicit base in an upstream-only clone of a master-default repository: the base is upstream/master', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    gitIn(src, ['branch', '-m', 'main', 'master']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-default-upstream-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '-o', 'upstream', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);
    gitIn(dir, ['fetch', '-q', 'upstream', 'master:refs/remotes/upstream/master']);
    gitIn(dir, ['remote', 'set-head', 'upstream', '-d']);
    const r = run(dir, []);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: no local branch master; base is upstream/master');
  });

  // Value: protects=a shallow clone gets a fix line that unshallows into the tracking ref, both when the base is absent and
  // when it is present but shares no reachable history (merge-base fails), and that line repairs the clone;
  // fails_when=the shallow branch of noBaseFix keeps the bare `--unshallow origin main` (FETCH_HEAD only), or a resolved base
  // with no merge-base stops being no_base; why_new=the existing shallow test covers only the `<sha>^` --deepen form, and no
  // test reaches the merge-base-null branch; seam=none; no_claim=nothing about --deepen.
  test('a shallow single-branch clone: the fix line unshallows into origin/main, including when origin/main exists but has no merge-base', () => {
    const src = repo({ fixture: 'rh1-skip', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-shallow-base-'));
    repos.push(dir);
    gitIn(dir, ['clone', '-q', '--depth', '1', '--single-branch', '--branch', 'feature', `file://${src}`, '.']);

    const absent = run(dir, ['main']);
    expect(absent.status).toBe(2);
    expect(absent.stdout.trim()).toBe('GATE_ERROR=no_base ref=main fix=git fetch --unshallow origin +main:refs/remotes/origin/main');

    gitIn(dir, ['fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main']);
    expect(gitIn(dir, ['rev-parse', '--verify', '-q', 'origin/main^{commit}']).trim()).not.toBe('');
    const disjoint = run(dir, ['main']);
    expect(disjoint.status).toBe(2);
    expect(disjoint.stdout.trim()).toBe('GATE_ERROR=no_base ref=main fix=git fetch --unshallow origin +main:refs/remotes/origin/main');

    gitIn(dir, disjoint.stdout.trim().replace(/^.* fix=git /, '').split(' '));
    expect(gitIn(dir, ['rev-parse', '--is-shallow-repository']).trim()).toBe('false');
    const r = run(dir, ['main']);
    expect(r.status).toBe(0);
    expect(summary(r.stdout).tagged).toBe('RH-1:1');
    expect(r.stderr).toContain('gstack-gate-diff: no local branch main; base is origin/main');
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

  test('--commit on a shallow boundary is GATE_ERROR=no_base, never the whole tree as added', () => {
    const src = repo({ fixture: 'rh15-timeout', commit: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-shallow-'));
    gitIn(dir, ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${src}`, '.']);
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const r = run(dir, ['--commit', 'HEAD']);
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toBe(`GATE_ERROR=no_base ref=${head.slice(0, 12)}^ fix=git fetch --deepen=50 origin`);
    const root = run(src, ['--commit', gitIn(src, ['rev-list', '--max-parents=0', 'HEAD']).trim(), '--format', 'jsonl']);
    expect(root.status).toBe(0);
    expect(summary(root.stdout).listed).toBeGreaterThan(0);
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
