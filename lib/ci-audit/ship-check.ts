import { spawnSync } from 'node:child_process';
import type { Run } from './collect';
import { listRuns } from './collect';
import { AuditError, type ApiClient } from './github';
import { cohort, percentile, type HeadSample } from './measure';
import { concurrencyFlag } from './lessons';
import { priceRunner } from './prices';
import type { StaticView } from './static';

export const CI_SHAPING = /^(\.github\/workflows\/|\.gstack\/pregate\.json$|\.husky\/|lefthook\.ya?ml$)|(^|\/)(package\.json|bunfig\.toml|tsconfig[^/]*\.json|(vitest|vite|jest)\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|biome\.jsonc?|\.oxlintrc\.json)$/;
export const MIN_COHORT = 8;

export interface ShipCheckResult { state: 'ok' | 'slower' | 'pending' | 'unknown' | 'off'; lines: string[]; head?: { sha: string; seconds: number }; cohortP50?: number | null; cohortP90?: number | null; cohortN?: number; lessonsFlagged: number; calls: number }

export function changedFiles(root: string, base: string): string[] | null {
  const r = spawnSync('git', ['-C', root, 'diff', '--name-only', `origin/${base}...HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/** Static lesson checks limited to the CI-shaping files a diff touches. */
export function staticChecks(st: StaticView, touched: string[], isPrivate: boolean): string[] {
  const out: string[] = [];
  const touchedWf = st.workflows.filter(w => touched.includes(w.file));
  for (const w of touchedWf) {
    if (w.unreadable) { out.push(`${w.file}: not checked (${w.unreadable})`); continue; }
    const kinds = new Set(w.jobs.map(j => priceRunner(j.runsOn, isPrivate).kind).filter(k => k === 'github-hosted' || k === 'third-party'));
    if (kinds.size > 1) out.push(`lesson 1: ${w.file} mixes GitHub-hosted and third-party runners; tiny jobs left on GitHub's pool can wait the longest`);
    for (const j of w.jobs) for (const s of j.steps) {
      if (/actions\/checkout/.test(s.uses ?? '') && String(s.with?.['fetch-depth'] ?? '') === '0' && !s.with?.filter) out.push(`lesson 6: ${w.file} / ${j.id} checks out full history; add filter: blob:none`);
      const n = concurrencyFlag(s.run);
      const vcpu = priceRunner(j.runsOn, isPrivate).vcpu;
      if (n && vcpu && n > 2 * vcpu) out.push(`lesson 6: ${w.file} / ${j.id} runs ${n} tasks on ${vcpu} vCPU`);
    }
    if (w.prTrigger && w.prPathFilter && !st.testFilesMentioning(new RegExp(w.file.split('/').pop()!.replace(/\./g, '\\.'))).length) out.push(`lesson 8: ${w.file} skips PRs by path, and no test names this workflow, so a change the filter hides passes green`);
  }
  if (touched.some(f => /^(\.husky\/|lefthook\.ya?ml$)/.test(f)) && !st.hook) out.push('lesson 9: the pre-push hook config changed but no pre-push hook is installed');
  return out;
}

function headOf(runs: Run[], sha: string): HeadSample | null {
  const own = runs.filter(r => r.head_sha === sha);
  const c = cohort(own, '1970-01-01T00:00:00Z');
  return c.heads[0] ?? null;
}

/**
 * "Slower" means slower than 19 of 20 comparable heads (above the p95) and at least minSlowerS over their median;
 * under MIN_COHORT heads there is no verdict. A p90 cutoff flags about one head in ten by construction.
 */
export function judgeHead(seconds: number, cohortSeconds: number[], minSlowerS: number): { state: 'ok' | 'slower' | 'unknown'; p50: number | null; p90: number | null } {
  const p50 = percentile(cohortSeconds, 0.5);
  const p90 = percentile(cohortSeconds, 0.9);
  if (cohortSeconds.length < MIN_COHORT) return { state: 'unknown', p50, p90 };
  return { state: seconds > percentile(cohortSeconds, 0.95)! && seconds - p50! >= minSlowerS ? 'slower' : 'ok', p50, p90 };
}

/** Heads from the same cohort that ran the same workflow set, the comparison pool for one head. */
export function comparable(heads: HeadSample[], head: HeadSample, exclude: string[] = [head.sha]): HeadSample[] {
  return heads.filter(h => !exclude.includes(h.sha) && h.workflows.join() === head.workflows.join()).slice(0, 40);
}

/** The PR's newest settled head against comparable all-green PR heads into the same base. */
export async function timingCheck(client: ApiClient, repo: string, pr: number, minSlowerS: number): Promise<Omit<ShipCheckResult, 'lines' | 'lessonsFlagged' | 'calls'> & { line: string }> {
  const p = await client.get(`/repos/${repo}/pulls/${pr}`);
  if (p.status !== 200) throw new AuditError('ci_audit_repo_unreadable', `cannot read PR #${pr} (HTTP ${p.status})`);
  const branch = String((p.json as any)?.head?.ref ?? '');
  const base = String((p.json as any)?.base?.ref ?? '');
  const partial: string[] = [];
  const pages = [1, 2, 3, 4].map(n => listRuns(client, repo, 'event=pull_request', 1, partial, { hit: false }, { firstPage: n }));
  const mine = await listRuns(client, repo, `event=pull_request&branch=${encodeURIComponent(branch)}`, 1, partial, { hit: false });
  const shas = [...new Set(mine.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(r => r.head_sha))];
  const settled = shas.map(s => headOf(mine, s)).find(Boolean) ?? null;
  if (!settled) return { state: 'pending', line: `CI_AUDIT: pending no settled all-green push on #${pr} yet` };
  const recent = (await Promise.all(pages)).flat();
  const oldest = recent.reduce((m, r) => (r.created_at < m ? r.created_at : m), recent[0]?.created_at ?? settled.start);
  const pool = comparable(cohort(recent, oldest, base).heads, settled, shas);
  const { state, p50, p90 } = judgeHead(settled.seconds, pool.map(h => h.seconds), minSlowerS);
  const mins = (s: number | null) => (s == null ? '-' : `${(s / 60).toFixed(1)} min`);
  if (state === 'unknown') return { state: 'unknown', head: { sha: settled.sha, seconds: settled.seconds }, cohortN: pool.length, line: `CI_AUDIT: unknown thin baseline (n=${pool.length} comparable all-green PR heads); previous push ${settled.sha.slice(0, 7)} went green in ${mins(settled.seconds)}` };
  const slower = state === 'slower';
  return {
    state: slower ? 'slower' : 'ok', head: { sha: settled.sha, seconds: settled.seconds }, cohortP50: p50, cohortP90: p90, cohortN: pool.length,
    line: `CI_AUDIT: ${slower ? 'slower' : 'ok'} previous push ${settled.sha.slice(0, 7)} went green in ${mins(settled.seconds)}; comparable PR heads p50 ${mins(p50)}, p90 ${mins(p90)} (n=${pool.length})${slower ? '; run gstack-ci-audit run to see which check grew' : ''}`,
  };
}
