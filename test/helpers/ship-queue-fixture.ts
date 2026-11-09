/**
 * Fixtures for gstack-ship-queue and the gbrain stamp-pair acceptance: a
 * hermetic repo (bare origin plus working clone under os.tmpdir(), its own git
 * identity) seeded from test/fixtures/ship-queue/gbrain-stamp-pair.json, the
 * stamp files of a real gbrain stamp commit at its parent plus that commit's
 * diff and gbrain's committed .gstack/ship-policy.json, byte for byte.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitArgvIn } from './scratch-repo';
import type { FixtureRepo } from './restamp-fixture';

export const ROOT = path.resolve(import.meta.dir, '..', '..');

export interface GbrainPair {
  source: { repo: string; gated_commit: string; stamp_commit: string; stamp_subject: string; policy_commit: string; note: string };
  policy: string;
  gated: Record<string, string>;
  stamp_diff: string;
}

export function loadGbrainPair(): GbrainPair {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ship-queue', 'gbrain-stamp-pair.json'), 'utf8'));
}

/** A bare origin plus working clone with its own git identity; nothing committed yet. */
export function emptyRepo(prefix: string): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const env = { GSTACK_HOME: home, GSTACK_STATE_DIR: home, HOME: home, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]): string => {
    const r = gitArgvIn(work, args, 30_000, { ...process.env, ...env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString()}`);
    return r.stdout?.toString().trim() ?? '';
  };
  spawnSync('git', ['init', '-q', '--bare', origin], { timeout: 30_000, env: { ...process.env, ...env } });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  return { root, work, origin, home, git, env };
}

/**
 * main holds gbrain's policy and the stamp files at the gated commit; HEAD
 * is that commit (the gated head). Returns the repo and a function that
 * commits the real stamp diff on top (the stamped head).
 */
export function gbrainPairRepo(): { repo: FixtureRepo; pair: GbrainPair; gated: string; stamp: () => string } {
  const pair = loadGbrainPair();
  const repo = emptyRepo('gstack-gbrain-pair-');
  for (const [rel, text] of Object.entries(pair.gated)) {
    fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.work, rel), text);
  }
  fs.mkdirSync(path.join(repo.work, '.gstack'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), pair.policy);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `gated ${pair.source.gated_commit.slice(0, 10)}`);
  repo.git('push', '-q', 'origin', 'main');
  repo.git('remote', 'set-head', 'origin', 'main');
  const gated = repo.git('rev-parse', 'HEAD');
  const stamp = () => {
    const diff = path.join(repo.root, 'stamp.diff');
    fs.writeFileSync(diff, pair.stamp_diff);
    repo.git('apply', '--index', diff);
    repo.git('commit', '-q', '-m', pair.source.stamp_subject);
    return repo.git('rev-parse', 'HEAD');
  };
  return { repo, pair, gated, stamp };
}

/** A `gh` on PATH answering `gh pr view <n> --json …` and `gh api …/commits/<sha>/check-runs…` from fixed data, so ready runs offline. */
/**
 * gh for the queue: pr view, and paged check-runs and combined commit status
 * per SHA. A checks or statuses entry is one page (total_count defaults to its
 * length; later pages are empty) or { pages: [...] }. A SHA with no statuses
 * entry has no commit-status contexts, as on GitHub. A check run marked
 * earlier_attempt belongs to a superseded workflow-run attempt: like GitHub's
 * default filter=latest, the shim hides it unless the call asks for filter=all.
 * workflowRuns answers actions/runs?head_sha=<sha> the same way (none by default).
 */
export function ghQueueShim(repo: FixtureRepo, data: { prs: Record<string, unknown>; checks: Record<string, unknown>; statuses?: Record<string, unknown>; workflowRuns?: Record<string, unknown> }): { PATH: string } {
  const dir = path.join(repo.root, 'gh-queue-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
  const js = [
    "const d = require(process.argv[2]); const a = process.argv.slice(3);",
    "if (a[0] === 'pr' && a[1] === 'view') { const p = d.prs[a[2]]; if (!p) { console.error('no pull request found'); process.exit(1); } console.log(JSON.stringify(p)); process.exit(0); }",
    "const paged = (c, key, page) => { if (c.pages) return c.pages[page - 1] || { total_count: c.pages.reduce((n, p) => n + p[key].length, 0), [key]: [] }; const total = c.total_count ?? c[key].length; return page === 1 ? { total_count: total, ...c } : { total_count: total, [key]: [] }; };",
    "const latestOnly = (c, url) => /[?&]filter=all(&|$)/.test(url) || !c || !Array.isArray(c.check_runs) || !c.check_runs.some(r => r.earlier_attempt) ? c : { check_runs: c.check_runs.filter(r => !r.earlier_attempt) };",
    "if (a[0] === 'api') { const w = /actions\\/runs\\?head_sha=([0-9a-f]+).*page=(\\d+)/.exec(a[1] || ''); if (w) { console.log(JSON.stringify(paged((d.workflowRuns || {})[w[1]] || { workflow_runs: [] }, 'workflow_runs', Number(w[2])))); process.exit(0); } }",
    "if (a[0] === 'api') { const m = /commits\\/([0-9a-f]+)\\/(check-runs|status)\\?.*page=(\\d+)/.exec(a[1] || ''); if (!m) { console.error('gh shim: unsupported ' + a.join(' ')); process.exit(1); } const runs = m[2] === 'check-runs'; const c = runs ? latestOnly(d.checks[m[1]], a[1]) : ((d.statuses || {})[m[1]] || { state: 'pending', statuses: [] }); if (!c) { console.error('HTTP 404'); process.exit(1); } console.log(JSON.stringify(paged(c, runs ? 'check_runs' : 'statuses', Number(m[3])))); process.exit(0); }",
    "console.error('gh shim: unsupported ' + a.join(' ')); process.exit(1);",
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'shim.js'), js);
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${path.join(dir, 'shim.js')}" "${path.join(dir, 'data.json')}" "$@"\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/**
 * A coordinator's separate clone of the fixture origin, fetched through git's
 * transport (--no-local) like a real clone of GitHub. A local clone copies
 * origin.git/objects entry by entry, and every push into the fixture origin
 * leaves a detached `git maintenance run --auto` there that creates and
 * deletes objects/maintenance.lock after the push returns: local transport
 * drops the shard's GIT_CONFIG_COUNT maintenance-off backstop, so it never
 * reaches that receive-pack.
 */
export function coordinatorClone(repo: FixtureRepo): string {
  const dir = path.join(repo.root, 'coordinator');
  const r = spawnSync('git', ['clone', '-q', '--no-local', repo.origin, dir], { timeout: 60_000, env: { ...process.env, ...repo.env } });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr?.toString()}`);
  return dir;
}

