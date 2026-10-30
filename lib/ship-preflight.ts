/**
 * ship-preflight — /ship Steps 0.9-3 and the mechanical part of Step 5 as one command
 * (gstack-ship-preflight). It chains git, gh, gstack-ship-receipt carry, gstack-diff-scope,
 * gstack-ship-policy, gstack-review-plan, gstack-pregate and gstack-evidence, prints a
 * compact result, and stops with STOP: wherever the prose assigns the decision to the
 * agent (a merge conflict, a failing or zero-run lane, the carry route, the Apple target).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bin, firstLine, flagReader, git, laneLine, lanes, Report, runLanes, short, sh } from './ship-bin-common';

export const PREFLIGHT_HELP = `gstack-ship-preflight — /ship Steps 1-3 and Step 5's pregate and lanes in one call (ship/SKILL.md)

  gstack-ship-preflight --base <base> [--lane <label>=<command>]...   Steps 1-3; with lanes also Step 5
  gstack-ship-preflight --tests-only --base <base> --lane <label>=<command>...   Step 5 only (after a repair)

Prints at most 30 lines: BRANCH, STATUS, DIFF, PR/CARRY, APPLE, SCOPE, MERGE, DISTRIBUTION, POLICY,
RUNTIME_LINES, PREGATE, one LANE line per lane, then NEXT: lines. STOP: names what the agent must
decide or repair; nothing after it ran. Exit codes: 0 ok · 2 usage · 3 STOP`;

const DIST = /(^|\/)(cmd\/[^/]+\/main\.go|bin\/[^/]+|Cargo\.toml|setup\.py|package\.json)$/;

function integrate(cwd: string, base: string, r: Report): boolean {
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  const head = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '');
  r.add(`BRANCH: ${branch || '(detached)'} base=${base}`);
  if (!branch || branch === base || branch === head) { r.stop(`on the base branch (${branch || 'detached HEAD'}): ship from a feature branch`); return false; }
  const status = git(cwd, ['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  r.add(`STATUS: modified=${status.filter(l => !l.startsWith('??')).length} untracked=${status.filter(l => l.startsWith('??')).length} (uncommitted changes ship with this run)`);
  const fetch = git(cwd, ['fetch', 'origin', base], 300_000);
  if (fetch.status !== 0) { r.stop(`git fetch origin ${base} failed: ${firstLine(fetch.stderr)}; restore access first`); return false; }
  const stat = git(cwd, ['diff', `origin/${base}`, '--shortstat']).stdout.trim();
  const lines = [...stat.matchAll(/(\d+) (insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const commits = git(cwd, ['rev-list', '--count', `origin/${base}..HEAD`]).stdout.trim();
  r.add(`DIFF: ${stat || 'no changes'}; commits=${commits || 0}${lines > 200 ? '; over 200 lines: recommend /plan-eng-review or /autoplan' : ''}`);
  const pr = sh(cwd, `gh pr list --head ${JSON.stringify(branch)} --state open --json number --jq '.[0].number // empty'`, 60_000);
  const n = pr.stdout.trim();
  if (pr.status !== 0) r.add(`CARRY: not checked (gh pr list failed: ${firstLine(pr.stderr)})`);
  else if (/^\d+$/.test(n)) {
    const carry = bin(cwd, 'gstack-ship-receipt', ['carry', '--pr', n, '--base', base, '--dry-run'], 120_000);
    const line = (carry.stdout.match(/^CARRY: .*$/m) ?? [`CARRY: check failed (${firstLine(carry.stderr)})`])[0];
    r.add(`PR: #${n}`).add(line);
    if (line.startsWith('CARRY: would carry')) {
      r.next(`carry route (Step 1.4): fix what the base merge broke (CHANGELOG, size caps), gstack-pregate --allow-repo-commands, then gstack-ship-receipt carry --pr ${n} --base ${base} --pregate .gstack/tmp/pregate.json`);
      return false;
    }
  } else r.add('PR: none open');
  const apple = git(cwd, ['ls-files', '--', '*.xcodeproj/*', '*.xcworkspace/*', 'Package.swift']).stdout.split('\n').filter(Boolean).map(p => p.replace(/(\.xcodeproj|\.xcworkspace)\/.*$/, '$1'));
  if (apple.length) r.add(`APPLE: ${short([...new Set(apple)], 3)}`).next('Step 0.9: for an App Store/TestFlight ask, confirm the app target and follow apple-release.md; otherwise ignore');
  const scope = bin(cwd, 'gstack-diff-scope', [base], 60_000).stdout;
  r.add(`SCOPE: frontend=${/SCOPE_FRONTEND=true/.test(scope)}${/SCOPE_FRONTEND=true/.test(scope) ? ' (Step 9 runs the design lite check; mention /design-review when no design review exists)' : ''}`);
  return merge(cwd, base, r);
}

function merge(cwd: string, base: string, r: Report): boolean {
  const before = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const m = git(cwd, ['merge', `origin/${base}`, '--no-edit'], 300_000);
  if (m.status !== 0) {
    const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    r.stop(conflicts.length
      ? `merge conflicts in ${short(conflicts, 8)}: resolve simple ones (VERSION, schema.rb, CHANGELOG ordering) yourself; for complex or ambiguous ones ask (Step 3), then commit the merge and rerun`
      : `git merge origin/${base} failed: ${firstLine(m.stderr || m.stdout)}`);
    return false;
  }
  const after = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  r.add(after === before ? 'MERGE: up to date' : `MERGE: merged origin/${base} at ${after.slice(0, 12)}`);
  const added = git(cwd, ['diff', `origin/${base}`, '--diff-filter=A', '--name-only']).stdout.split('\n');
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n');
  const candidates = [...new Set([...added, ...untracked].filter(p => p && DIST.test(p)))];
  if (!candidates.length) r.add('DISTRIBUTION: no new artifact paths');
  else {
    const wf = fs.existsSync(path.join(cwd, '.github/workflows')) ? fs.readdirSync(path.join(cwd, '.github/workflows')).filter(f => /release|publish|dist/i.test(f)) : [];
    const gitlab = fs.existsSync(path.join(cwd, '.gitlab-ci.yml')) && /release|publish|deploy/.test(fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8'));
    r.add(`DISTRIBUTION: candidates=${short(candidates, 5)} release_workflow=${[...wf, ...(gitlab ? ['GITLAB_CI_RELEASE'] : [])].join(',') || 'none'}`)
      .next('Step 2: read each candidate (and manifests for new binaries or exports); a new distributable without a pipeline needs Step 2\'s question');
  }
  const policy = bin(cwd, 'gstack-ship-policy', ['show-effective', '--base', base], 60_000).stdout;
  const pick = (k: string) => (new RegExp(`^${k}=(\\S+)`, 'm').exec(policy)?.[1] ?? '?').replace(/^"|"$/g, '');
  r.add(`POLICY: ${['bump', 'queue_mode', 'review_scope', 'history'].map(k => `${k}=${pick(k)}`).join(' ')} (binds Steps 12, 16 and history)`);
  const plan = bin(cwd, 'gstack-review-plan', ['--base', base, '--json'], 180_000);
  let runtime = 'unknown';
  try { runtime = String(JSON.parse(plan.stdout).runtime_lines ?? 'unknown'); } catch { /* unknown */ }
  r.add(`RUNTIME_LINES: ${runtime} (gstack-ship-budget check --runtime-lines at the Step 7 and 12 boundaries)`);
  return true;
}

async function tests(cwd: string, base: string, list: { label: string; command: string }[], r: Report): Promise<void> {
  const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base], 3_600_000);
  const verdict = /^PREGATE: (.+?) tree=/m.exec(pg.stdout + pg.stderr)?.[1] ?? `unreadable (exit ${pg.status})`;
  r.add(`PREGATE: ${verdict}`);
  if (/^(fail|incomplete|unreadable)/.test(verdict)) { r.stop(`pregate ${verdict}: fix the failing checks it lists (gstack-pregate --allow-repo-commands), then rerun --tests-only`); return; }
  if (/uncleared/.test(verdict)) r.next('pregate requires-remote: gstack-pregate clear, or --remote --spend-cap <usd> under a user cap, before Step 18');
  const results = (await runLanes(cwd, list)).map(laneLine);
  for (const l of results) r.add(l.line);
  const bad = results.filter(l => !l.ok);
  if (bad.length) { r.stop(`${bad.length} lane(s) failed or ran zero tests: Step 5 triage (read each log; a free-suite shard failure reruns its file list per measure.md); in-branch failures stop the ship`); return; }
  r.next('Step 6: select eval suites for prompt-related changes with the project\'s selector, then Step 7');
}

export async function preflight(argv: readonly string[], cwd: string): Promise<{ text: string; exit: number }> {
  const { flag, has } = flagReader(argv);
  const base = flag('--base');
  const list = lanes(argv);
  if (has('--help') || has('-h')) return { text: PREFLIGHT_HELP + '\n', exit: 0 };
  if (!base || typeof list === 'string') return { text: `gstack-ship-preflight: ${typeof list === 'string' ? list : '--base <base> is required'}\n`, exit: 2 };
  if (has('--tests-only') && !list.length) return { text: 'gstack-ship-preflight: --tests-only needs at least one --lane <label>=<command>\n', exit: 2 };
  const r = new Report();
  if (has('--tests-only') || integrate(cwd, base, r)) {
    if (list.length) await tests(cwd, base, list, r);
    else if (r.exit === 0) r.next('Step 4: confirm the test framework, then rerun with --tests-only --lane <label>=<command> per suite (Step 5)');
  }
  return { text: r.render(), exit: r.exit };
}
