/**
 * ship-preflight — /ship Steps 0.9-3 and the mechanical part of Step 5 as one command
 * (gstack-ship-preflight). It chains git, gh, gstack-ship-receipt carry, gstack-diff-scope,
 * gstack-ship-policy, gstack-review-plan, gstack-pregate and gstack-evidence, prints a
 * compact result, and stops with STOP: wherever the prose assigns the decision to the
 * agent (a merge conflict, a failing or zero-run lane, the carry route, the Apple target).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';
import { audit } from './ship-audit';
import { matchesAny } from './ship-policy';
import { bin, firstLine, flagReader, gh, git, hostedOrigin, laneLine, lanes, Report, runLanes, shipPolicy, short } from './ship-bin-common';

/** Data files: code-class paths with no runtime behavior, left out of RUNTIME_LINES. */
const DATA_PATH = /\.(json|jsonl|ndjson|ya?ml|toml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf)$/i;

export const PREFLIGHT_HELP = `gstack-ship-preflight — /ship Steps 1-3 and Step 5's pregate and lanes in one call (ship/SKILL.md)

  gstack-ship-preflight --base <base> [--lane <label>=<command>]...   Steps 1-3; with lanes also Step 5
  gstack-ship-preflight --tests-only --base <base> --lane <label>=<command>...   Step 5 only (after a repair)
  gstack-ship-preflight --audit --base <base> --out <dir>   the single reads and Steps 7-8's deterministic audits
      (CONTEXT, TODOS, COVERAGE_MAP, Coverage, PLAN_*, READER: coverage=needed|none plan=needed|none)

Prints at most 30 lines: BRANCH, STATUS, DIFF, PR/CARRY, APPLE, SCOPE, MERGE, DISTRIBUTION, POLICY,
RUNTIME_LINES, PREGATE, one LANE line per lane, then NEXT: lines. STOP: names what the agent must
decide or repair; nothing after it ran. Exit codes: 0 ok · 2 usage · 3 STOP`;

const DIST = /(^|\/)(cmd\/[^/]+\/main\.go|bin\/[^/]+|Cargo\.toml|setup\.py|package\.json)$/;

function integrate(cwd: string, base: string, r: Report): boolean {
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  const remote = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000).stdout)?.[1];
  const head = remote ?? git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '');
  r.add(`BRANCH: ${branch || '(detached)'} base=${base}`);
  if (!branch || branch === base || branch === head) { r.stop(`on the base branch (${branch || 'detached HEAD'}): ship from a feature branch`); return false; }
  const status = git(cwd, ['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  r.add(`STATUS: modified=${status.filter(l => !l.startsWith('??')).length} untracked=${status.filter(l => l.startsWith('??')).length} (uncommitted changes ship with this run)`);
  const fetch = git(cwd, ['fetch', 'origin', base], 300_000);
  if (fetch.status !== 0) { r.stop(`git fetch origin ${base} failed: ${firstLine(fetch.stderr)}; restore access first`); return false; }
  const stat = git(cwd, ['diff', forkPoint(cwd, base), '--shortstat']).stdout.trim();
  const lines = [...stat.matchAll(/(\d+) (insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const commits = git(cwd, ['rev-list', '--count', `origin/${base}..HEAD`]).stdout.trim();
  r.add(`DIFF: ${stat || 'no changes'}; commits=${commits || 0}${lines > 200 ? '; over 200 lines: recommend /plan-eng-review or /autoplan' : ''}`);
  const pr = hostedOrigin(cwd) ? gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']) : null;
  const n = pr?.stdout.trim() ?? '';
  if (!pr) r.add('PR: not checked (origin is a local path, not a hosted remote gh can map; Step 0 uses git-native commands)');
  else if (pr.status !== 0) r.add(`CARRY: not checked (gh pr list failed: ${firstLine(pr.stderr)})`);
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
  const scope = bin(cwd, 'gstack-diff-scope', [`origin/${base}`], 60_000).stdout;
  const scopeError = /^SCOPE_ERROR=(?!unmatched)(\S+)/m.exec(scope)?.[1];
  if (scopeError) r.add(`SCOPE: unknown (gstack-diff-scope origin/${base}: SCOPE_ERROR=${scopeError})`);
  else r.add(`SCOPE: frontend=${/SCOPE_FRONTEND=true/.test(scope)}${/SCOPE_FRONTEND=true/.test(scope) ? ' (Step 9 runs the design lite check; mention /design-review when no design review exists)' : ''}`);
  return merge(cwd, base, r);
}

const forkPoint = (cwd: string, base: string) => git(cwd, ['merge-base', `origin/${base}`, 'HEAD']).stdout.trim() || `origin/${base}`;

function merge(cwd: string, base: string, r: Report): boolean {
  const policy = shipPolicy(cwd, base);
  if (policy?.queue_mode === 'stamp-at-merge') r.add('MERGE: skipped (queue_mode stamp-at-merge: the slot stamp merges the base; docs/ship-policy.md#ship-before-ready)');
  else {
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
  }
  const added = git(cwd, ['diff', forkPoint(cwd, base), '--diff-filter=A', '--name-only']).stdout.split('\n');
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n');
  const candidates = [...new Set([...added, ...untracked].filter(p => p && DIST.test(p)))];
  if (!candidates.length) r.add('DISTRIBUTION: no new artifact paths');
  else {
    const wf = fs.existsSync(path.join(cwd, '.github/workflows')) ? fs.readdirSync(path.join(cwd, '.github/workflows')).filter(f => /release|publish|dist/i.test(f)) : [];
    const gitlab = fs.existsSync(path.join(cwd, '.gitlab-ci.yml')) && /release|publish|deploy/.test(fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8'));
    r.add(`DISTRIBUTION: candidates=${short(candidates, 5)} release_workflow=${[...wf, ...(gitlab ? ['GITLAB_CI_RELEASE'] : [])].join(',') || 'none'}`)
      .next('Step 2: read each candidate (and manifests for new binaries or exports); a new distributable without a pipeline needs Step 2\'s question');
  }
  r.add(`POLICY: ${['bump', 'queue_mode', 'review_scope', 'history'].map(k => `${k}=${policy?.[k] ?? '?'}`).join(' ')} (binds Steps 12-16 and history)`);
  const plan = bin(cwd, 'gstack-review-plan', ['--base', base, '--json'], 180_000);
  let runtime = 'unknown';
  try {
    const j = JSON.parse(plan.stdout);
    const outputs: string[] = j.registry?.outputs ?? [];
    const counted = (j.per_path as { path: string; lines: number; binary: boolean }[]).filter(e => !e.binary && !(j.stamp_only ?? []).includes(e.path)
      && !(outputs.length && matchesAny(outputs, e.path)) && classifyPath(e.path, cwd) === 'code' && !DATA_PATH.test(e.path));
    runtime = String(counted.reduce((n, e) => n + e.lines, 0));
  } catch { /* unknown */ }
  r.add(`RUNTIME_LINES: ${runtime} (gstack-ship-budget check --runtime-lines at the Step 9 and 12 boundaries)`);
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
  if (has('--audit')) {
    const out = flag('--out');
    if (!base || !out) return { text: 'gstack-ship-preflight: --audit needs --base <base> --out <dir>\n', exit: 2 };
    return { text: audit(cwd, base, out).render(), exit: 0 };
  }
  if (!base || typeof list === 'string') return { text: `gstack-ship-preflight: ${typeof list === 'string' ? list : '--base <base> is required'}\n`, exit: 2 };
  if (has('--tests-only') && !list.length) return { text: 'gstack-ship-preflight: --tests-only needs at least one --lane <label>=<command>\n', exit: 2 };
  const r = new Report();
  if (has('--tests-only') || integrate(cwd, base, r)) {
    if (list.length) await tests(cwd, base, list, r);
    else if (r.exit === 0) r.next('Step 4: confirm the test framework, then rerun with --tests-only --lane <label>=<command> per suite (Step 5)');
  }
  return { text: r.render(), exit: r.exit };
}
