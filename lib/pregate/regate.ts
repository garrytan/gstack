/**
 * regate — does a gated head's evidence still cover HEAD (field wave CD3),
 * behind `gstack-pregate regate --against <head>`. Reuse is derived only from
 * a tree receipt evaluated now (lib/tree-receipt.ts) with a valid evidence
 * bundle produced on the gated tree, the current predecessor head and the
 * current execution identity; a stored receipt is never read. Migration
 * numbers the branch adds are compared with the base branch and every open
 * PR; any lookup that cannot finish is `unknown`, which blocks `not-needed`.
 */
import { spawnSync } from '../spawn-sync';
import * as path from 'node:path';
import type { ResultCodeName } from '../result-codes';
import type { ShipPolicy } from '../ship-policy';
import { buildReceipt, type GateVerdict, type ReceiptOptions, type TreeReceipt } from '../tree-receipt';

export type Gh = (args: string[]) => { ok: boolean; out: string; err?: string };
export interface MigrationCollision { id: string; file: string; other: string; where: string }
export interface MigrationReport { status: 'none' | 'collision' | 'unknown'; collisions: MigrationCollision[]; detail: string }
export interface RegateReport {
  against: string; receipt: TreeReceipt | null; error: { code: ResultCodeName; message: string } | null;
  lanes: GateVerdict[]; migration: MigrationReport; verdict: 'needed' | 'not-needed'; reasons: string[];
}

const PR_LIST_LIMIT = 1000;
const GRAPHQL_FILES_CAP = 100;
const REST_FILES_CAP = 3000;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '').replace(/\n$/, '') : null;
}
const lines = (s: string | null): string[] => (s ?? '').split('\n').filter(Boolean);
export const defaultGh = (cwd: string): Gh => (args) => {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? r.error?.message ?? '').trim() };
};

/** Migration numbers HEAD adds under `migrations.dir`, checked against the base tree and every other open PR. */
export function migrationReport(o: { repoRoot: string; head: string; baseRef: string; migrations: ShipPolicy['migrations']; gh: Gh; self?: string | null }): MigrationReport {
  if (!o.migrations) return { status: 'none', collisions: [], detail: 'no migrations key in the ship policy' };
  const dir = o.migrations.dir.replace(/\/+$/, '');
  const re = new RegExp(o.migrations.id);
  const idOf = (file: string): string | null => {
    if (!file.startsWith(dir + '/')) return null;
    const m = re.exec(path.posix.basename(file));
    return m?.[1] ? String(Number.isNaN(Number(m[1])) ? m[1] : Number(m[1])) : null;
  };
  const mergeBase = git(o.repoRoot, ['merge-base', o.baseRef, o.head]);
  if (!mergeBase) return { status: 'unknown', collisions: [], detail: `no merge base between ${o.baseRef} and ${o.head}` };
  const ours = new Map<string, string>();
  for (const f of lines(git(o.repoRoot, ['diff', '--name-only', '--no-renames', '--diff-filter=A', mergeBase, o.head, '--', dir]))) {
    const id = idOf(f);
    if (id) ours.set(id, f);
  }
  if (ours.size === 0) return { status: 'none', collisions: [], detail: `this branch adds no migration under ${dir}/` };
  const collisions: MigrationCollision[] = [];
  const check = (file: string, where: string) => {
    const id = idOf(file);
    const mine = id ? ours.get(id) : undefined;
    if (id && mine && mine !== file && !collisions.some(c => c.where === where && c.other === file)) collisions.push({ id, file: mine, other: file, where });
  };
  const baseFiles = git(o.repoRoot, ['ls-tree', '-r', '--name-only', o.baseRef, '--', dir + '/']);
  if (baseFiles === null) return { status: 'unknown', collisions, detail: `cannot list ${dir}/ on ${o.baseRef}` };
  for (const f of lines(baseFiles)) check(f, o.baseRef);

  const listed = o.gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,headRefOid,files']);
  if (!listed.ok) return { status: 'unknown', collisions, detail: `gh pr list failed${listed.err ? `: ${listed.err.split('\n')[0]}` : ''}` };
  let prs: Array<{ number: number; headRefOid?: string; files?: Array<{ path: string }> | null }>;
  try { prs = JSON.parse(listed.out); if (!Array.isArray(prs)) throw new Error('not a list'); }
  catch (e: any) { return { status: 'unknown', collisions, detail: `gh pr list output unreadable: ${e.message}` }; }
  if (prs.length >= PR_LIST_LIMIT) return { status: 'unknown', collisions, detail: `${prs.length} open PRs listed, the list may be truncated at ${PR_LIST_LIMIT}` };
  const headSha = git(o.repoRoot, ['rev-parse', o.head]);
  let checked = 0;
  for (const pr of prs) {
    if (pr.headRefOid === headSha || (o.self && String(pr.number) === String(o.self))) continue;
    let files = (pr.files ?? []).map(f => f.path);
    if (files.length >= GRAPHQL_FILES_CAP) {
      const all = o.gh(['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`, '--jq', '.[].filename']);
      if (!all.ok) return { status: 'unknown', collisions, detail: `PR #${pr.number} lists ${files.length} files (truncated) and its full file list could not be fetched` };
      files = lines(all.out);
      if (files.length >= REST_FILES_CAP) return { status: 'unknown', collisions, detail: `PR #${pr.number} changes ${files.length}+ files, past what GitHub lists` };
    }
    for (const f of files) check(f, `PR #${pr.number}`);
    checked += 1;
  }
  return collisions.length
    ? { status: 'collision', collisions, detail: `${collisions.length} collision(s)` }
    : { status: 'none', collisions, detail: `${[...ours.keys()].join(',')} checked against ${o.baseRef} and ${checked} open PR(s)` };
}

/** The regate verdict: `not-needed` only when every required lane's evidence is reusable as is and no migration lookup is open. */
export function evaluateRegate(o: ReceiptOptions & { baseRef: string; require: string[]; self?: string | null; gh: Gh }): RegateReport {
  const built = buildReceipt(o);
  const receipt = 'error' in built ? null : built;
  const error = 'error' in built ? { code: built.code, message: built.error } : null;
  const migration = migrationReport({ repoRoot: o.repoRoot, head: o.current ?? 'HEAD', baseRef: o.baseRef, migrations: o.policy.migrations, gh: o.gh, self: o.self });
  const reasons: string[] = [];
  let lanes: GateVerdict[] = [];
  if (error) reasons.push(error.message);
  if (receipt) {
    if (receipt.tree === 'changed') reasons.push(`not stamp-only: ${receipt.residual.join(', ')}`);
    const p = receipt.predecessor;
    if (p?.moved) reasons.push(`PREDECESSOR MOVED ${p.recorded_head!.slice(0, 12)} -> ${p.current_head!.slice(0, 12)}`);
    else if (p?.recorded_head && !p.current_head) reasons.push(`predecessor ${p.pr ? `#${p.pr}` : 'head'} current head unknown`);
    if (!receipt.identity.gated) reasons.push(`no gate evidence for ${receipt.gated_head.slice(0, 12)} (${receipt.identity.source})`);
    else {
      const global = reasons.join('; ');
      lanes = receipt.gates.map(g => g.verdict === 'reusable' && global ? { ...g, verdict: 'not-reusable' as const, reason: global } : g);
      for (const label of o.require) if (!lanes.some(g => g.label === label)) lanes.push({ label, verdict: 'not-reusable', reason: 'required lane has no record in the bundle' });
      if (lanes.length === 0) reasons.push('the bundle lists no lanes');
      for (const g of lanes) if (g.verdict !== 'reusable' && g.reason !== global) reasons.push(`${g.label} ${g.verdict === 'rerun' ? 'reruns' : 'not reusable'} (${g.reason})`);
    }
  }
  if (migration.status === 'collision') reasons.push(`migration collision: ${migration.collisions.map(c => c.id).join(', ')}`);
  if (migration.status === 'unknown') reasons.push(`migration lookup unknown (${migration.detail})`);
  return { against: o.gated, receipt, error, lanes, migration, verdict: reasons.length ? 'needed' : 'not-needed', reasons };
}

export function renderRegate(r: RegateReport): string {
  const out: string[] = [];
  const rc = r.receipt;
  if (rc) {
    out.push(`against: ${rc.gated_head} (tree ${rc.gated_tree.slice(0, 12)})`, `head:    ${rc.current_head} (tree ${rc.current_tree.slice(0, 12)})`, `version: ${rc.old_version ?? '-'} -> ${rc.new_version ?? '-'}`, `policy:  ${rc.policy}`, `evidence: ${rc.identity.source}`);
    for (const f of rc.files) out.push(f.verdict === 'stamp' ? `  stamp   ${f.path} (${f.rule})` : `  changed ${f.path}${f.line ? `:${f.line}` : ''} (${f.rule}: ${f.residual})`);
    out.push(`STAMP_ONLY: ${rc.tree === 'changed' ? 'no' : 'yes'} files=${rc.files.length}${rc.residual.length ? ` changed=${rc.residual.length}` : ''}`);
  }
  for (const g of r.lanes) out.push(`LANE: ${g.label} ${g.verdict} (${g.reason})`);
  const m = r.migration;
  out.push(m.status === 'collision'
    ? m.collisions.map(c => `MIGRATION_COLLISION: ${c.id} ${c.file} vs ${c.where} ${c.other}`).join('\n')
    : `MIGRATION_COLLISION: ${m.status} (${m.detail})`);
  out.push(r.verdict === 'not-needed' ? 'REGATE: not-needed' : `REGATE: needed (${r.reasons.join('; ')})`);
  return out.join('\n') + '\n';
}
