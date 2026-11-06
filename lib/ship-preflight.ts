/**
 * ship-preflight — /ship Steps 0.9-3 and the mechanical part of Step 5 as one command
 * (gstack-ship-preflight). It chains git, gh, gstack-ship-receipt carry, gstack-diff-scope,
 * gstack-ship-policy, gstack-review-plan, gstack-pregate and gstack-evidence, prints a
 * compact result, and stops with STOP: wherever the prose assigns the decision to the
 * agent (a merge conflict, a failing or zero-run lane, the carry route, the Apple target).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCarry, laneMapping, mappingCoverage } from './ci-carry';
import { defaultBaseBranch } from './default-base';
import { isConfigUnavailable, loadConfigFromHead } from './pregate/config';
import { buildRunCheck } from './pregate/run-check';
import { classifyDiff } from './review-depth';
import { wtreeFingerprint } from './script-invocation';
import { audit } from './ship-audit';
import { bin, carryNoneLines, firstLine, flagReader, gh, git, hostedOrigin, laneConcurrency, laneLine, lanes, Report, runLanes, shipPolicy, shipRunMarker, short } from './ship-bin-common';

export const PREFLIGHT_HELP = `gstack-ship-preflight — /ship Steps 1-3 and Step 5's pregate and lanes in one call (ship/SKILL.md)

  gstack-ship-preflight --base <base> [--lane <label>=<command>]...   Steps 1-3; with lanes also Step 5
      --run <id>           the /ship run (SESSION_ID, or the driver's run dir name): once Steps 1-3 pass it is recorded in
                           this checkout's git dir and opened on its lease, and a later full preflight stops until finish
                           clears it or 120 minutes pass, because its merge would move the tree the run's readers diff (GST-1204)
  gstack-ship-preflight --tests-only --base <base> --lane <label>=<command>...   Step 5 only (after a repair)
      --lanes serial|parallel   how Step 5 runs its lanes; unset, one at a time on 4 or fewer cores, all at once above
      --policy-from head   Step 5's pregate reads the branch's .gstack/pregate.json, which may only add test lanes
                           (a branch that adds the lane for a file it touches); anything else is PREGATE_HEAD_POLICY_LOOSENS
      --timeout <s>        Step 5's pregate --timeout for each runner process, 1 to 3600; unset, the base .gstack/pregate.json
                           timeout_s applies, else 600 s, and a longer lane is PREGATE_INCOMPLETE
  gstack-ship-preflight --tests-only --base <base> --policy-from head --simulate [--allow-repo-commands] --lane <label>=<command>...
      a dry run that proves a new ship_lanes_from mapping: which lanes the branch's own map would carry from a verified
      CI run at this tree. Every line starts SIMULATION:; no lane runs, no evidence or ledger row is written and no
      obligation clears (a real carry reads origin/<base>'s map only). An inventory-mapped lane runs the branch's
      inventory command, so it needs --allow-repo-commands. Exit 0 when every mapped lane would carry, else 1
  gstack-ship-preflight --audit --base <base> --out <dir>   the single reads and Steps 7-8's deterministic audits
      (CONTEXT, TODOS, COVERAGE_MAP, Coverage, PLAN_*, READER: coverage=needed|none plan=needed|none)

Prints at most 30 lines: BRANCH, STATUS, DIFF, PR/CARRY, APPLE, SCOPE, MERGE, DISTRIBUTION, POLICY,
RUNTIME_LINES, PREGATE (with up to three PREGATE_DETAIL lines when it does not pass), LANES, one LANE line per lane
(a lane the base maps in .gstack/pregate.json ship_lanes_from is carried from a verified CI run at this exact clean tree:
LANE: <label> carried run=<id>/<attempt> tests_ran=<n>, else CI_CARRY: none (<reason>) and it runs; any other lane that
passed at this tree, command and runtime is reused: reused=<original time>), then NEXT: lines. STOP: names what the agent must
decide or repair; nothing after it ran. Exit codes: 0 ok · 2 usage · 3 STOP`;

const DIST = /(^|\/)(cmd\/[^/]+\/main\.go|bin\/[^/]+|Cargo\.toml|setup\.py|package\.json)$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * GST-1204: a full preflight merges the base, so it stops while the /ship run that already passed Steps 1-3 on this checkout
 * is open: its marker is in the git dir (finish removes it) and its run is open on the checkout's own lease (gstack-lease
 * open: GST-1205's released, 120-minute and dead-holder rules). The run's readers diff this tree. A different --run whose
 * caller is the open run's holder (the harness behind preflight: the Claude Code session, or Capy's one capy-server) is a
 * new /ship after one that stopped before finish, so it goes on; the same id, no --run, or another live holder's run stops.
 * A --run is opened on the lease here, before the fetch, and one that cannot be is a STOP, never an unprotected run.
 */
function shipRunClear(cwd: string, base: string, run: string | undefined, r: Report): boolean {
  const marker = shipRunMarker(cwd);
  const open = marker && fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  const lease = (verb: string, id: string, from = false) => bin(cwd, 'gstack-lease', [verb, '--root', cwd, '--run', id, ...(from ? ['--from', String(process.ppid)] : [])], 60_000);
  if (RUN_ID.test(open) && lease('open', open).status === 0 && !(run && run !== open && lease('open', open, true).status === 0)) {
    r.stop(`/ship run ${open} is open on this checkout and past its preflight (${marker}; open until its finish or for 120 minutes): a full preflight would merge origin/${base} into the tree its review readers diff; rerun Step 5 with --tests-only, or let that /ship finish; if it is no longer running, rm ${marker}, then rerun`);
    return false;
  }
  const touch = run ? lease('touch', run, true) : undefined;
  if (!touch || touch.status === 0) return true;
  r.stop(`cannot record /ship run ${run} on this checkout's lease (${firstLine(touch.stderr) || `gstack-lease touch exit ${touch.status}`}): unrecorded, a later full preflight could merge origin/${base} under this run's reviews; fix that, then rerun`);
  return false;
}

function integrate(cwd: string, base: string, run: string | undefined, r: Report): boolean {
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  r.add(`BRANCH: ${branch || '(detached)'} base=${base}`);
  if (!branch || branch === base) { r.stop(`on the base branch (${branch || 'detached HEAD'}): ship from a feature branch`); return false; }
  if (!shipRunClear(cwd, base, run, r)) return false;
  const status = git(cwd, ['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  r.add(`STATUS: modified=${status.filter(l => !l.startsWith('??')).length} untracked=${status.filter(l => l.startsWith('??')).length} (uncommitted changes ship with this run)`);
  const fetch = git(cwd, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], 300_000);
  if (fetch.status !== 0) { r.stop(`git fetch origin ${base} failed: ${firstLine(fetch.stderr)}; restore access first`); return false; }
  const remoteHead = git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000);
  if (remoteHead.status !== 0) { r.stop(`git ls-remote origin HEAD failed: ${firstLine(remoteHead.stderr)}; restore access first`); return false; }
  const head = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remoteHead.stdout)?.[1] ?? defaultBaseBranch(cwd).branch;
  if (branch === head) { r.stop(`on the base branch (${branch}): ship from a feature branch`); return false; }
  const stat = git(cwd, ['diff', forkPoint(cwd, base), '--shortstat']).stdout.trim();
  const lines = [...stat.matchAll(/(\d+) (insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const commits = git(cwd, ['rev-list', '--count', `origin/${base}..HEAD`]).stdout.trim();
  r.add(`DIFF: ${stat || 'no changes'}; commits=${commits || 0}${lines > 200 ? '; over 200 lines: recommend /plan-eng-review or /autoplan' : ''}`);
  const pr = hostedOrigin(cwd) ? gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']) : null;
  const n = pr?.stdout.trim() ?? '';
  if (!pr) r.add('PR: not checked (origin is a local path, not a hosted remote gh can map; Step 0 uses git-native commands)');
  else if (pr.status !== 0) r.add(`CARRY: not checked (gh pr list failed: ${firstLine(pr.stderr)})`);
  else if (/^\d+$/.test(n)) {
    if (!prSized(cwd, base, n, r)) return false;
    const carry = bin(cwd, 'gstack-ship-receipt', ['carry', '--pr', n, '--base', base, '--dry-run'], 120_000);
    const line = (carry.stdout.match(/^CARRY: .*$/m) ?? [`CARRY: check failed (${firstLine(carry.stderr)})`])[0];
    r.add(`PR: #${n}`).add(line);
    if (line.startsWith('CARRY: would carry')) {
      r.next(`carry route (Step 1.4): fix what the base merge broke (CHANGELOG, size caps), commit, gstack-ship-release push --branch ${branch} --early, gstack-ci-carry wait --base ${base} (CI_CARRY: none is not a stop), gstack-pregate --allow-repo-commands, then gstack-ship-receipt carry --pr ${n} --base ${base} --pregate .gstack/tmp/pregate.json`);
      return false;
    }
    if (line === 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)' && /^RECHECK: eligible /m.test(carry.stderr ?? '')) {
      r.next(`carry route (Step 1.4, J1): the product changed since the receipt within the scoped re-check cap: gstack-ship-receipt carry --pr ${n} --base ${base} writes the re-check packet; one reader reads it; gstack-pregate --allow-repo-commands, then carry again with --recheck <record.json> --pregate .gstack/tmp/pregate.json; a blocking finding runs Steps 2-16`);
      return false;
    }
    if (line === 'CARRY: refused (RECEIPT_CARRY_SCOPED_REVIEW)') {
      r.next(`carry route (Step 1.4): the base edited context next to reviewed hunks: fix what the base merge broke (CHANGELOG, size caps), commit and push; then gstack-ship-receipt carry --pr ${n} --base ${base} writes the packet for that head; one fix-check reviewer reads it; gstack-pregate --allow-repo-commands, then carry again with --scoped-review <record.json> --pregate .gstack/tmp/pregate.json; a blocking finding runs Steps 2-16`);
      return false;
    }
  } else r.add('PR: none open');
  const apple = git(cwd, ['ls-files', '--', '*.xcodeproj/*', '*.xcworkspace/*', 'Package.swift']).stdout.split('\n').filter(Boolean).map(p => p.replace(/(\.xcodeproj|\.xcworkspace)\/.*$/, '$1'));
  if (apple.length) r.add(`APPLE: ${short([...new Set(apple)], 3)}`).next('Step 0.9: for an App Store/TestFlight ask, confirm the app target and follow apple-release.md; otherwise ignore');
  const scope = bin(cwd, 'gstack-diff-scope', [`origin/${base}`], 60_000).stdout;
  const scopeError = /^SCOPE_ERROR=(?!unmatched)(\S+)/m.exec(scope)?.[1];
  if (scopeError) r.add(`SCOPE: unknown (gstack-diff-scope origin/${base}: SCOPE_ERROR=${scopeError})`);
  else r.add(`SCOPE: frontend=${/SCOPE_FRONTEND=true/.test(scope)}${/SCOPE_FRONTEND=true/.test(scope) ? ' (Step 9 runs the design lite check; mention /design-review when no design review exists)' : ''}`);
  if (!merge(cwd, base, r)) return false;
  const marker = run && shipRunMarker(cwd);
  try { if (marker) fs.writeFileSync(marker, `${run}\n`); } catch (e) { r.stop(`cannot record /ship run ${run} in ${marker} (${firstLine((e as Error).message)}): the base is merged, but a later full preflight could merge again under this run's reviews; fix that, then rerun`); return false; }
  return true;
}

/** The diff against origin/<base> must be about the PR's size: far more files (a stale or wrong base, HARN-15's 17,000-file review of main's history) or fewer (a fork's origin ahead of the PR's base, which would leave commits out of the gate scan) stops before any reader runs. Checked only when HEAD is the PR's pushed head. */
function prSized(cwd: string, base: string, n: string, r: Report): boolean {
  const view = gh(cwd, ['pr', 'view', n, '--json', 'changedFiles,headRefOid,baseRefName', '--jq', '"\\(.changedFiles) \\(.headRefOid) \\(.baseRefName)"']);
  const [pr, prHead, prBase] = view.status === 0 ? view.stdout.trim().split(' ') : [];
  if (!pr || !/^[1-9]\d*$/.test(pr) || prHead !== git(cwd, ['rev-parse', 'HEAD']).stdout.trim()) return true;
  const local = git(cwd, ['diff', '--name-only', forkPoint(cwd, base), 'HEAD']).stdout.split('\n').filter(Boolean).length;
  if (local >= Number(pr) && local <= 2 * Number(pr) + 50) return true;
  const word = /^[A-Za-z0-9._\/-]+$/.test(prBase ?? '') ? prBase! : `'${(prBase ?? '').replace(/'/g, "'\\''")}'`;
  r.stop(`the diff against origin/${base} lists ${local} files but PR #${n} changes ${pr} (its base is ${word}): ${prBase === base
    ? `origin is not the PR's base repository (a fork) or its ${base} has moved; fetch the PR's base repository's ${base} into origin/${base}, then rerun`
    : `origin/${base} is not the PR's base; rerun with --base ${word} after git fetch origin +refs/heads/${word}:refs/remotes/origin/${word}`}`);
  return false;
}

const forkPoint = (cwd: string, base: string) => git(cwd, ['merge-base', `origin/${base}`, 'HEAD']).stdout.trim() || `origin/${base}`;

function merge(cwd: string, base: string, r: Report): boolean {
  const policy = shipPolicy(cwd, base);
  const stampAtMerge = policy?.queue_mode === 'stamp-at-merge';
  const pending = stampAtMerge ? undefined : ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].find(ref => {
    const p = git(cwd, ['rev-parse', '--git-path', ref]);
    return p.status === 0 && !!p.stdout.trim() && fs.existsSync(path.resolve(cwd, p.stdout.trim()));
  });
  const unmerged = stampAtMerge ? [] : git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  if (pending) {
    r.stop(`an unfinished ${pending.replace(/_HEAD$/, '').toLowerCase().replace('_', '-')} is in progress (${pending}${unmerged.length ? `, conflicts in ${short(unmerged, 8)}` : ''}): resolve and commit it, or abort it, then rerun (Step 3)`);
    return false;
  }
  if (unmerged.length) {
    r.stop(`unresolved conflicts in ${short(unmerged, 8)} with no merge, cherry-pick or revert in progress: resolve them (git add) or restore the files, then rerun (Step 3)`);
    return false;
  }
  if (stampAtMerge) r.add('MERGE: skipped (queue_mode stamp-at-merge: the slot stamp merges the base; docs/ship-policy.md#ship-before-ready)');
  else if (git(cwd, ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD']).status === 0) r.add('MERGE: up to date');
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
    const c = classifyDiff({ paths: j.paths, perPath: j.per_path, stampOnly: j.stamp_only, registry: j.registry, consumed: j.consumed, drawings: j.drawings, executables: j.executables, root: cwd, gateTagged: 0 });
    runtime = String(c.runtimeLines ?? 'unknown');
  } catch { /* unknown */ }
  r.add(`RUNTIME_LINES: ${runtime} (gstack-ship-budget check --runtime-lines at the Step 9 and 12 boundaries)`);
  return true;
}

async function tests(cwd: string, base: string, list: { label: string; command: string }[], policyFrom: string, timeout: string | undefined, run: { concurrency: number; line: string }, r: Report): Promise<void> {
  const pg = bin(cwd, 'gstack-pregate', ['--allow-repo-commands', '--base', base, '--policy-from', policyFrom, ...(timeout ? ['--timeout', timeout] : [])], 3_600_000);
  const refusal = pg.status === 3 ? /\((PREGATE_[A-Z_]+|POLICY_[A-Z_]+)[;)]/.exec(pg.stderr)?.[1] : undefined;
  const verdict = refusal ? `refused (${refusal})` : /^PREGATE: (.+?) tree=/m.exec(pg.stdout + pg.stderr)?.[1] ?? `unreadable (exit ${pg.status})`;
  r.add(`PREGATE: ${verdict}`);
  if (/^(fail|incomplete|unreadable|refused)/.test(verdict)) {
    for (const line of pg.stderr.split('\n').filter(l => l.startsWith('gstack-pregate: ')).slice(0, 3)) r.add(`PREGATE_DETAIL: ${line.length > 300 ? `${line.slice(0, 220)} … ${line.slice(-80)}` : line}`);
    r.stop(`pregate ${verdict}: fix what PREGATE_DETAIL names (gstack-pregate --allow-repo-commands${policyFrom === 'head' ? ' --policy-from head' : ''}), then rerun --tests-only`);
    return;
  }
  if (/uncleared/.test(verdict)) r.next('pregate requires-remote: gstack-pregate clear, or --remote --spend-cap <usd> under a user cap, before Step 18');
  r.add(run.line);
  const ran = await runLanes(cwd, list, run.concurrency, { base });
  const results = ran.map(laneLine);
  for (const [i, l] of results.entries()) { for (const none of carryNoneLines(ran[i]!)) r.add(none); r.add(l.line); }
  const bad = results.filter(l => !l.ok);
  if (bad.length) { r.stop(`${bad.length} lane(s) failed or ran zero tests: Step 5 triage (read each log; a free-suite shard failure reruns its file list per measure.md); in-branch failures stop the ship`); return; }
  r.next('Step 6: select eval suites for prompt-related changes with the project\'s selector, then Step 7');
}

/**
 * --simulate (GST-1190): HEAD's ship_lanes_from and run_profiles, findCarry against this tree, nothing else. It never calls
 * gstack-evidence or gstack-pregate, so it writes no row and clears no obligation: a PR controls both its own map and the
 * CI that would satisfy it, so head policy never carries. The branch's inventory commands run only with `allow`
 * (--allow-repo-commands), as gstack-ci-carry find --simulate requires.
 */
function simulate(cwd: string, base: string, list: { label: string; command: string }[], allow: boolean): { text: string; exit: number } {
  const lines: string[] = [];
  const say = (s: string) => lines.push(`SIMULATION: ${s}`);
  const done = (exit: number) => ({ text: lines.join('\n') + '\n', exit });
  const loaded = loadConfigFromHead(cwd);
  say(`policy ${isConfigUnavailable(loaded) ? 'unavailable' : loaded.label}; a dry run: only the branch's inventory commands run, and only with --allow-repo-commands; no evidence or ledger row is written, nothing clears (a carry reads origin/${base}'s map only)`);
  if (isConfigUnavailable(loaded) || loaded.errors.length) { say(`refused: ${isConfigUnavailable(loaded) ? loaded.detail : loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`); return done(1); }
  const check = buildRunCheck(cwd, null, allow, base, 'head');
  if ('error' in check) { say(`refused: ${check.error}`); return done(1); }
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const wtree = () => { const fp = wtreeFingerprint({ cwd }); return 'tree' in fp ? fp.tree : null; };
  let mapped = 0;
  let carried = 0;
  for (const l of list) {
    const m = laneMapping(loaded.config.ship_lanes_from, l.command);
    if (!m) { say(`LANE: ${l.label} not mapped by the branch's ship_lanes_from; /ship would run it`); continue; }
    mapped++;
    if (m.inventory && !allow) { say(`CI_CARRY: none label=${l.label} (inventory_not_allowed: the branch's inventory command is a pin-file command; pass --allow-repo-commands)`); continue; }
    const v = findCarry(check, { profiles: m.profiles, head, tree, wtree, ...mappingCoverage(m, cwd) });
    if (!v.ok) { say(`CI_CARRY: none label=${l.label} (${v.reason}: ${v.detail})`); continue; }
    carried++;
    say(`LANE: ${l.label} would carry run=${v.runs.map(e => `${e.run_id}/${e.run_attempt}`).join(',')} tests_ran=${v.tests}${v.unit ? ` unit=${v.unit}` : ''}${v.remainder ? ` and would run ${v.remainder.length} skipped file(s) here with per_file` : ''}`);
  }
  say(`${carried} of ${mapped} mapped lane(s) would carry once origin/${base} holds this map`);
  return done(mapped > 0 && carried === mapped ? 0 : 1);
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
  const policyFrom = flag('--policy-from') ?? 'base';
  if (!['base', 'head'].includes(policyFrom)) return { text: 'gstack-ship-preflight: --policy-from needs base|head\n', exit: 2 };
  const timeout = flag('--timeout');
  if (has('--timeout') && !(timeout && /^[1-9]\d*$/.test(timeout) && Number(timeout) <= 3600)) return { text: 'gstack-ship-preflight: --timeout needs whole seconds from 1 to 3600\n', exit: 2 };
  if (!base || typeof list === 'string') return { text: `gstack-ship-preflight: ${typeof list === 'string' ? list : '--base <base> is required'}\n`, exit: 2 };
  const run = flag('--run');
  if (has('--run') && !(run && RUN_ID.test(run))) return { text: 'gstack-ship-preflight: --run needs a run id: letters, digits, dot, underscore or dash, at most 128\n', exit: 2 };
  if (has('--tests-only') && !list.length) return { text: 'gstack-ship-preflight: --tests-only needs at least one --lane <label>=<command>\n', exit: 2 };
  if (has('--simulate')) return has('--tests-only') && policyFrom === 'head' && list.length ? simulate(cwd, base, list, has('--allow-repo-commands')) : { text: 'gstack-ship-preflight: --simulate needs --tests-only --policy-from head and at least one --lane <label>=<command>\n', exit: 2 };
  const mode = flag('--lanes');
  const concurrency = has('--lanes') && mode === undefined ? '--lanes needs serial or parallel' : laneConcurrency(mode);
  if (typeof concurrency === 'string') return { text: `gstack-ship-preflight: ${concurrency}\n`, exit: 2 };
  const r = new Report();
  if (has('--tests-only') || integrate(cwd, base, run, r)) {
    if (list.length) await tests(cwd, base, list, policyFrom, timeout, { concurrency, line: `LANES: ${concurrency === 1 ? 'serial' : 'parallel'} (${mode ? '--lanes' : `${os.availableParallelism()} cores`})` }, r);
    else if (r.exit === 0) r.next('Step 4: confirm the test framework, then rerun with --tests-only --lane <label>=<command> per suite (Step 5)');
  }
  return { text: r.render(), exit: r.exit };
}
