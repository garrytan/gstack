/**
 * `train init` and `train doctor` (docs/ship-policy.md#run-a-merge-train; plan GSTA-157 PR 2, item 12). Both only
 * read: branch protection (the strict flag and the required checks), the base branch's .github/workflows/* and the
 * open PRs. `init` prints a `train` block with gates for the base policy, the `nonce` input, run-name and
 * concurrency snippet each gate workflow needs, and the land mode slots will use; it recommends changelog_fragments
 * when open PRs bump the version, and refuses (QUEUE_TRAIN_INIT_REFUSED) only when they do and the policy neither
 * declares fragments nor stamps at merge. `doctor` re-checks a live block: a gate workflow missing, without the
 * nonce input or run-name, a required job it does not define, a concurrency group not keyed by ref, a push trigger
 * that matches train-prefix/ refs, a workflow never green on the base, and a merge method GitHub or history refuses.
 * Neither writes anything.
 */
import { loadPolicyFromBase, isUnavailable, TRAIN_GATES_KEY_VERSION, globToRegExp, type ShipPolicy } from './ship-policy';
import type { QueueContext } from './ship-queue';
import { git } from './ship-queue-gate';
import { versionAtRef } from './restamp';
import { commandReservation, concurrencyKeyed } from './ship-queue-train-gate';
import { repoSlug } from './ship-queue-train-github';
import { UNPROTECTED } from './ship-queue-train-land';
import { fetchBase, outFailed, outOk, outRefused, type TrainOut } from './ship-queue-train';

const Q = 'gstack-ship-queue';
const MAX_SIZE = 5;
const unquote = (s: string) => s.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');

export interface WorkflowFacts {
  file: string; name: string; jobs: Array<{ id: string; name: string; matrix: boolean }>; nonce: boolean; runName: boolean; keyed: boolean; pushMatchesPrefix: boolean;
}

/** The top-level block of a workflow under `key:` (its indented lines), or null when absent. */
function block(yaml: string, key: string, indent = ''): string[] | null {
  const lines = yaml.split('\n');
  const at = lines.findIndex(l => new RegExp(`^${indent}${key}:\\s*(#.*)?$`).test(l));
  if (at < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !l.startsWith(indent + ' ') && !l.trim().startsWith('#')) break;
    out.push(l);
  }
  return out;
}

/** Whether GitHub's branch filter (`*` inside a segment, `**` across) matches a train-prefix ref. */
function filterMatches(patterns: string[]): boolean {
  const ref = 'train-prefix/gate.train-0123456789ab-0123456789ab-abcdef/t1';
  return patterns.some(p => { try { return globToRegExp(p).test(ref); } catch { return true; } });
}

/** Whether a push trigger runs on train-prefix/ refs: a bare push, or a branches filter that matches them and no branches-ignore that excludes them. */
export function pushMatchesPrefix(yaml: string): boolean {
  const on = /^(?:on|"on"|'on'):[ \t]*(.*)$/m.exec(yaml);
  if (!on) return false;
  const inline = unquote(on[1]!);
  if (inline) return /\bpush\b/.test(inline);
  const push = block(yaml.slice(on.index!), 'push', '  ');
  if (push === null) return false;
  const list = (key: string): string[] | null => {
    const at = push.findIndex(l => new RegExp(`^\\s+${key}:`).test(l));
    if (at < 0) return null;
    const flow = /\[(.*)\]/.exec(push[at]!);
    if (flow) return flow[1]!.split(',').map(unquote).filter(Boolean);
    const out: string[] = [];
    for (const l of push.slice(at + 1)) { const m = /^\s+-\s*(.+)$/.exec(l); if (!m) break; out.push(unquote(m[1]!)); }
    return out;
  };
  const branches = list('branches');
  const ignore = list('branches-ignore');
  if (branches) return filterMatches(branches);
  if (ignore) return !filterMatches(ignore);
  return !list('tags');
}

/** What train doctor reads from one workflow file (line-based; the snippets init prints are the supported shape). */
export function workflowFacts(file: string, yaml: string): WorkflowFacts {
  const jobsBlock = block(yaml, 'jobs') ?? [];
  const jobs: WorkflowFacts['jobs'] = [];
  for (const [i, l] of jobsBlock.entries()) {
    const m = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(l);
    if (!m) continue;
    const body: string[] = [];
    for (const b of jobsBlock.slice(i + 1)) { if (/^  \S/.test(b)) break; body.push(b); }
    const name = body.map(b => /^    name:\s*(.+)$/.exec(b)?.[1]).find(Boolean);
    jobs.push({ id: m[1]!, name: name ? unquote(name) : m[1]!, matrix: body.some(b => /^\s+matrix:/.test(b)) });
  }
  const runName = /^run-name:\s*(.+)$/m.exec(yaml)?.[1] ?? '';
  return {
    file, name: unquote(/^name:\s*(.+)$/m.exec(yaml)?.[1] ?? file), jobs,
    nonce: /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?^\s+nonce:/m.test(yaml), runName: /inputs\.nonce/.test(runName) && /eval-bg/.test(runName),
    keyed: concurrencyKeyed(yaml), pushMatchesPrefix: pushMatchesPrefix(yaml),
  };
}

/** Whether a required job name is defined: a job's name, or a matrix job's name followed by its matrix values. */
const defines = (w: WorkflowFacts, job: string) => w.jobs.some(j => j.name === job || (j.matrix && job.startsWith(`${j.name} (`)));

export const NONCE_SNIPPET = [
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  "      nonce: { description: 'gstack merge-train nonce', required: false, type: string }",
  "run-name: ${{ inputs.nonce && format('{0} [eval-bg {1}]', github.workflow, inputs.nonce) || github.workflow }}",
  'concurrency:',
  "  group: ${{ github.workflow }}-${{ github.ref }}",
].join('\n');

interface Repo { ctx: QueueContext; policy: ShipPolicy; base: string; slug: string | null; workflows: WorkflowFacts[]; strict: boolean | null; required: string[] }

function readRepo(ctx: QueueContext): Repo | TrainOut {
  const fetchErr = fetchBase(ctx);
  if (fetchErr) return outRefused({ code: 'POLICY_SOURCE_UNAVAILABLE', message: fetchErr }, [], 'none', 'none');
  const loaded = loadPolicyFromBase(ctx.repoRoot, ctx.base);
  if (isUnavailable(loaded)) return outRefused({ code: 'POLICY_SOURCE_UNAVAILABLE', message: loaded.detail }, [], 'none', 'none');
  const ref = `${ctx.remote ?? 'origin'}/${ctx.base}`;
  const files = git(ctx.repoRoot, ['ls-tree', '--name-only', `${ref}:.github/workflows/`]).out.split('\n').filter(f => /\.ya?ml$/.test(f));
  const workflows = files.map(f => workflowFacts(f, git(ctx.repoRoot, ['show', `${ref}:.github/workflows/${f}`]).out));
  const prot = ctx.gh(['api', `repos/{owner}/{repo}/branches/${ctx.base}/protection/required_status_checks`]);
  let strict: boolean | null = null; let required: string[] = [];
  if (prot.ok) {
    try {
      const p = JSON.parse(prot.out) as { strict?: boolean; contexts?: string[]; checks?: Array<{ context?: string }> };
      strict = p.strict === true;
      required = [...new Set([...(p.contexts ?? []), ...(p.checks ?? []).map(c => c.context ?? '')].filter(Boolean))];
    } catch { strict = null; }
  } else if (UNPROTECTED.test(`${prot.err ?? ''} ${prot.out}`)) strict = false;
  return { ctx, policy: loaded.policy, base: ctx.base, slug: repoSlug(ctx), workflows, strict, required };
}

/** Open PRs whose head bumps the version against their merge base (VERSION or the manifest's version), by number. */
function versionBumpingPrs(r: Repo): number[] | string {
  const list = r.ctx.gh(['pr', 'list', '--state', 'open', '--base', r.base, '--limit', '100', '--json', 'number,headRefOid']);
  let prs: Array<{ number: number; headRefOid: string }>;
  try { prs = list.ok ? JSON.parse(list.out) : null; } catch { prs = null as never; }
  if (!Array.isArray(prs)) return `gh pr list could not be read (${(list.err ?? list.out).trim().slice(0, 120)})`;
  if (!prs.length) return [];
  const remote = r.ctx.remote ?? 'origin';
  const f = git(r.ctx.repoRoot, ['fetch', '--no-tags', '-q', remote, ...prs.map(p => `+refs/pull/${p.number}/head:refs/gstack/init/pr-${p.number}`)]);
  if (!f.ok) return `git fetch of the open PR heads failed: ${f.err.slice(0, 120)}`;
  const version = (rev: string) => { const v = versionAtRef(r.ctx.repoRoot, rev); return 'version' in v ? v.version : null; };
  return prs.filter(p => {
    const head = `refs/gstack/init/pr-${p.number}`;
    const fork = git(r.ctx.repoRoot, ['merge-base', head, `${remote}/${r.base}`]).out;
    return !!fork && version(head) !== version(fork);
  }).map(p => p.number);
}

/** The version-file rule both commands apply: recommend fragments when PRs bump the version; refuse only without fragments and without stamp-at-merge. */
function versionRule(r: Repo, lines: string[]): TrainOut | null {
  const bumping = versionBumpingPrs(r);
  if (typeof bumping === 'string') return outRefused({ code: 'QUEUE_PROOF_MISSING', message: bumping }, lines, `${Q} train init (once gh answers)`, 'none');
  const fragments = !!r.policy.changelog_fragments;
  const stamps = r.policy.queue_mode === 'stamp-at-merge';
  lines.push(`VERSION_PRS: ${bumping.length ? bumping.map(n => '#' + n).join(', ') + ' bump the version in the PR' : 'no open PR bumps the version'}; changelog_fragments ${fragments ? 'declared' : 'absent'}; queue_mode ${r.policy.queue_mode}`);
  if (bumping.length && !fragments) lines.push('RECOMMEND: changelog_fragments (docs/ship-policy.md#changelog-fragments): each slot is then stamped at merge, so PRs stop editing version files');
  if (bumping.length && !fragments && !stamps) return outRefused({ code: 'QUEUE_TRAIN_INIT_REFUSED', message: `${bumping.length} open PR(s) bump the version and the policy neither declares changelog_fragments nor stamps at merge` }, lines, 'add changelog_fragments to the base policy (recommended) or set queue_mode stamp-at-merge, then train init again', 'none');
  return null;
}

/** Warnings about one gate workflow, shared by init (for the workflows it proposes) and doctor. */
function workflowFindings(w: WorkflowFacts): string[] {
  return [
    ...(w.nonce ? [] : [`${w.file}: no workflow_dispatch input named nonce (add the snippet)`]),
    ...(w.runName ? [] : [`${w.file}: run-name does not name [eval-bg <inputs.nonce>], so a dispatch cannot be adopted by its nonce`]),
    ...(w.keyed ? [] : [`${w.file}: a concurrency group not keyed by ref; the train dispatches its prefixes one at a time`]),
    ...(w.pushMatchesPrefix ? [`${w.file}: a push trigger matches train-prefix/ refs, so every prefix push starts an extra run (add branches-ignore: ['train-prefix/**'])`] : []),
  ];
}

/** `train init`: print the block, the snippets and the land mode; refuse version-bumping PRs without fragments or stamp-at-merge. */
export function trainInit(ctx: QueueContext, o: { command?: string; timeoutSec?: number; spendCap?: number }): TrainOut {
  const r = readRepo(ctx);
  if ('exit' in r) return r;
  const lines: string[] = [`INIT: ${r.slug ?? 'repository'} base ${r.base}; ${r.workflows.length} workflow file(s); protection ${r.strict === null ? 'unreadable' : r.strict ? 'strict (up to date required)' : 'not strict'}; required checks ${r.required.join(', ') || '(none)'}`];
  const refused = versionRule(r, lines);
  if (refused) return refused;
  const mapped = r.required.map(check => ({ check, w: r.workflows.find(w => defines(w, check)) }));
  for (const m of mapped.filter(x => !x.w)) lines.push(`UNMAPPED: required check "${m.check}" is no job of a workflow on ${r.base} (a status context or an app check); land still requires it green`);
  const byWorkflow = new Map<string, string[]>();
  for (const m of mapped.filter(x => x.w)) byWorkflow.set(m.w!.file, [...(byWorkflow.get(m.w!.file) ?? []), `${m.w!.file}/${m.check}`]);
  const gates: unknown[] = [];
  if (byWorkflow.size) gates.push({ kind: 'workflows', workflows: [...byWorkflow.keys()], required_jobs: [...byWorkflow.values()].flat() });
  const command = { kind: 'command' as const, command: o.command ?? '', timeout_sec: o.timeoutSec ?? 1800, spend_cap_usd: 0 };
  command.spend_cap_usd = o.spendCap ?? Math.min(100, Math.ceil((MAX_SIZE + 2) * commandReservation(command)));
  if (o.command) gates.push(command);
  if (!gates.length) lines.push(`GATES: no required check maps to a workflow job; name the gate yourself (--command "<test command>", or a workflows gate listing <workflow>/<job>)`);
  const method = r.policy.history === 'merge-only' ? 'merge' : 'squash';
  const land = { merge_method: method, ...(!r.policy.changelog_fragments && r.required.length ? { required_checks: r.required } : {}) };
  const block = { train: { gates, land, max_size: MAX_SIZE, fill_hours: 3 }, min_gstack_version: TRAIN_GATES_KEY_VERSION };
  if (o.command && o.spendCap !== undefined && o.spendCap < (MAX_SIZE + 2) * commandReservation(command)) lines.push(`WARN: --spend-cap $${o.spendCap} is below $${((MAX_SIZE + 2) * commandReservation(command)).toFixed(2)}, what ${MAX_SIZE + 1} prefixes and one rerun reserve; a full train would stop at QUEUE_TRAIN_SPEND_CAP`);
  lines.push('POLICY: add to .gstack/ship-policy.json on the base branch (merge with the keys it has):', ...JSON.stringify(block, null, 2).split('\n'));
  for (const file of byWorkflow.keys()) {
    lines.push(`WORKFLOW: ${file} needs, beside its own triggers:`, ...NONCE_SNIPPET.split('\n').map(l => '  ' + l));
    lines.push(...workflowFindings(r.workflows.find(w => w.file === file)!).map(f => `WARN: ${f}`));
  }
  lines.push(r.strict === false
    ? 'LAND_MODE: direct (gh pr merge --match-head-commit <pin>) when the pin is green and merges onto main as its gated prefix; update (a tool-made commit of the gated prefix on [pin, main], checked, then merged) for a stamped train, a conditional PR, a merge that resolves release files, or a pin whose own checks are red'
    : `LAND_MODE: update for every slot (${r.strict ? 'branch protection requires branches to be up to date' : 'branch protection could not be read'}): a tool-made commit of the gated prefix on [pin, main], checked, then merged`);
  lines.push('WRITES: nothing; commit the block on the base branch through a PR, then run train doctor');
  return outOk(lines, `${Q} train doctor (after the block lands on ${r.base})`, 'none');
}

/** `train doctor`: re-check the base policy's live block against the repository. */
export function trainDoctor(ctx: QueueContext): TrainOut {
  const r = readRepo(ctx);
  if ('exit' in r) return r;
  const train = r.policy.train;
  if (!train?.gates) return outRefused({ code: 'QUEUE_TRAIN_OFF', message: `the base policy on ${r.base} declares no train block with gates` }, [], `${Q} train init`, 'none');
  const lines = [`DOCTOR: ${r.slug ?? 'repository'} base ${r.base}; ${train.gates.length} gate(s); land ${train.land?.merge_method ?? 'squash'}`];
  const refused = versionRule(r, lines);
  if (refused) return refused;
  const findings: string[] = [];
  for (const g of train.gates) {
    if (g.kind !== 'workflows') {
      lines.push(`GATE: command ${JSON.stringify(g.command)} timeout ${g.timeout_sec}s cap $${g.spend_cap_usd}`);
      const full = (train.max_size + 1) * commandReservation(g);
      if (g.spend_cap_usd < full) findings.push(`command gate cap $${g.spend_cap_usd} is below $${full.toFixed(2)}, what ${train.max_size + 1} prefixes reserve at timeout ${g.timeout_sec}s; a full train stops at QUEUE_TRAIN_SPEND_CAP`);
      continue;
    }
    for (const file of g.workflows) {
      const w = r.workflows.find(x => x.file === file);
      if (!w) { findings.push(`${file}: not in .github/workflows on ${r.base}`); continue; }
      findings.push(...workflowFindings(w));
      for (const job of g.required_jobs.filter(j => j.startsWith(`${file}/`)).map(j => j.slice(file.length + 1))) if (!defines(w, job)) findings.push(`${file}: required job "${job}" is no job name GitHub would report`);
      const green = r.slug ? r.ctx.gh(['run', 'list', '--repo', r.slug, '--workflow', file, '--branch', r.base, '--status', 'success', '--limit', '1', '--json', 'databaseId']) : null;
      if (!green?.ok || green.out.trim() === '[]') findings.push(`${file}: ${green?.ok ? `never green on ${r.base}` : 'its runs on the base could not be read'}`);
    }
  }
  const repo = r.slug ? r.ctx.gh(['api', `repos/${r.slug}`]) : null;
  const allowed = (() => { try { const j = JSON.parse(repo?.out ?? '') as Record<string, unknown>; return { squash: j.allow_squash_merge, merge: j.allow_merge_commit, rebase: j.allow_rebase_merge }; } catch { return null; } })();
  const method = train.land?.merge_method ?? 'squash';
  if (allowed && allowed[method] === false) findings.push(`train.land.merge_method is ${method}, which GitHub has turned off for this repository`);
  if (method === 'rebase') findings.push('train.land.merge_method rebase: slots that must land through an update commit (strict protection, stamped or conditional) refuse with QUEUE_TRAIN_LAND_METHOD');
  lines.push(`LAND_MODE: ${r.strict === false ? 'direct when the pin is green and merges onto main as its prefix, else update' : `update for every slot (${r.strict ? 'strict protection' : 'protection unreadable'})`}`);
  lines.push(...findings.map(f => `FINDING: ${f}`));
  if (findings.length) return outFailed({ code: 'QUEUE_TRAIN_DOCTOR_FINDINGS', message: `${findings.length} finding(s) in the live train block` }, lines, 'fix each FINDING on the base branch, then train doctor again', 'none');
  return outOk([...lines, 'DOCTOR: no findings'], `${Q} train build --prs <n>@<sha>,...`, 'none');
}
