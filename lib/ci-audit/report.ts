import type { AuditData } from './collect';
import type { Lesson } from './lessons';
import type { Dist, Measures } from './measure';
import { priceRunner } from './prices';
import type { StaticView } from './static';

export const SCHEMA = 'gstack-ci-audit/v1';

export interface JobRow { key: string; runner: string; vcpu: number | null; n: number; wait: Dist; setup: Dist; run: Dist; billedMinutesPerWeek: number; usdPerMonth: number; price: string }
export interface Fix { lesson: number; name: string; summary: string; fix: string; prMinutes: number | null; jobMinutesPerWeek: number | null; usdPerMonth: number | null; measured: boolean; note: string; caution?: string }
export interface AuditReport {
  schema: typeof SCHEMA; ok: true; repo: string; generatedAt: string;
  window: { since: string; until: string; days: number }; partial: string[]; notes: string[]; calls: number;
  static: { head: string; dirty: boolean } | null;
  pushToGreen: Dist & { excluded: Record<string, number>; bottlenecks: { workflow: string; share: number }[] };
  timeToFirstFailure: Dist; preJobWait: Dist; sampledRuns: number;
  jobs: JobRow[]; lessons: Lesson[]; fixes: Fix[];
  cost: { billedMinutesPerWeek: number; usdPerMonth: number; note: string };
}

const WEEKS_PER_MONTH = 4.33;
const round = (n: number, d = 2) => +n.toFixed(d);

export function rankFixes(lessons: Lesson[]): Fix[] {
  return lessons.filter(l => l.state === 'finding' && l.fix).map(l => ({
    lesson: l.id, name: l.name, summary: l.summary, fix: l.fix!, caution: l.caution,
    prMinutes: l.saving?.prMinutes ?? null, jobMinutesPerWeek: l.saving?.jobMinutesPerWeek ?? null, usdPerMonth: l.saving?.usdPerMonth ?? null,
    measured: l.saving?.measured ?? false, note: l.saving?.note ?? 'not estimated',
  })).sort((a, b) => (b.prMinutes ?? 0) - (a.prMinutes ?? 0) || (b.jobMinutesPerWeek ?? 0) - (a.jobMinutesPerWeek ?? 0) || a.lesson - b.lesson);
}

export function buildReport(data: AuditData, m: Measures, ls: Lesson[], st: StaticView | null, prices?: Record<string, { usd: number; source?: string }>, family?: 'premium' | 'standard', now = Date.now()): AuditReport {
  const counted = data.runCounts ?? null;
  const costDays = counted ? (Date.parse(data.until) - Date.parse(counted.since)) / 86400_000 : m.windowDays;
  const weeks = Math.max(costDays, 1 / 24) / 7;
  const runsPerWorkflow = new Map<string, number>(counted ? Object.entries(counted.byPath) : []);
  if (!counted) for (const r of data.runs) runsPerWorkflow.set(r.path, (runsPerWorkflow.get(r.path) ?? 0) + 1);
  const sampledPerWorkflow = new Map<string, Set<number>>();
  for (const j of m.jobs) sampledPerWorkflow.set(j.workflow, (sampledPerWorkflow.get(j.workflow) ?? new Set()).add(j.runId));
  const jobs: JobRow[] = m.groups.map(g => {
    const p = priceRunner(g.labels, data.isPrivate, prices, family);
    const scale = (runsPerWorkflow.get(g.workflow) ?? 0) / Math.max(1, sampledPerWorkflow.get(g.workflow)?.size ?? 1);
    const billed = (g.billedMinutes * scale) / weeks;
    return { key: g.key, runner: p.label, vcpu: p.vcpu, n: g.n, wait: g.wait, setup: g.setup, run: g.run, billedMinutesPerWeek: Math.round(billed), usdPerMonth: round(billed * WEEKS_PER_MONTH * p.usdPerMinute), price: `${p.usdPerMinute}/min: ${p.source}${p.assumed ? ' (assumed)' : ''}` };
  });
  const billedMinutesPerWeek = jobs.reduce((a, j) => a + j.billedMinutesPerWeek, 0);
  const familyNote = !family && jobs.some(j => /^ubicloud/.test(j.runner)) ? '; Ubicloud VM family not read from a job log, so Ubicloud jobs are priced as standard (assumed); --logs 5 reads it, --ubicloud-family sets it' : '';
  return {
    schema: SCHEMA, ok: true, repo: data.repo, generatedAt: new Date(now).toISOString(),
    window: { since: data.since, until: data.until, days: round(m.windowDays, 1) }, partial: data.partial, notes: data.notes, calls: data.calls,
    static: st ? { head: st.head, dirty: st.dirty } : null,
    pushToGreen: { ...m.cohort.total, excluded: m.cohort.excluded, bottlenecks: m.cohort.bottlenecks.slice(0, 5).map(b => ({ workflow: b.workflow, share: round(b.share) })) },
    timeToFirstFailure: m.cohort.failures, preJobWait: m.preJob, sampledRuns: m.sampledRuns,
    jobs, lessons: ls, fixes: rankFixes(ls),
    cost: { billedMinutesPerWeek, usdPerMonth: round(jobs.reduce((a, j) => a + j.usdPerMonth, 0)), note: `billed minutes scaled from the sampled runs to ${counted ? `every run of each workflow since ${counted.since}` : 'every run in the runs list'}; each job rounded up to a whole minute; workflows with no sampled PR or push run are not priced` + familyNote },
  };
}

const t = (s: number | null) => (s == null ? '-' : s >= 120 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`);
const STATE = { pass: 'pass', finding: 'FINDING', unknown: 'unknown', not_applicable: 'n/a' } as const;

export function renderMarkdown(r: AuditReport, maxJobs = 12): string {
  const out: string[] = [];
  out.push(`# CI audit: ${r.repo}`, '');
  out.push(`Window ${r.window.since} to ${r.window.until} (${r.window.days} days), ${r.sampledRuns} runs sampled for job detail, ${r.calls} GitHub calls.${r.static ? ` Config read from ${r.static.head.slice(0, 12)}${r.static.dirty ? ' (dirty tree)' : ''}.` : ' No local checkout: config lessons are unknown.'}`);
  if (r.notes.length) out.push('', r.notes.join(' '));
  if (r.partial.length) out.push('', `**Partial:** ${r.partial.join('; ')}`);
  const ex = Object.entries(r.pushToGreen.excluded).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
  out.push('', `**Push to all checks green:** p50 ${t(r.pushToGreen.p50)}, p90 ${t(r.pushToGreen.p90)} over ${r.pushToGreen.n} all-green PR heads${ex ? ` (left out: ${ex})` : ''}. Time to first failure p50 ${t(r.timeToFirstFailure.p50)} (n=${r.timeToFirstFailure.n}). Wait before the first job: p50 ${t(r.preJobWait.p50)}.`);
  if (r.pushToGreen.bottlenecks.length) out.push(`Finished last: ${r.pushToGreen.bottlenecks.map(b => `${b.workflow} ${Math.round(b.share * 100)}%`).join(', ')}.`);
  out.push('', '## Ranked fixes', '');
  if (!r.fixes.length) out.push('No lesson has a finding.');
  r.fixes.forEach((f, i) => {
    const gain = [f.prMinutes != null ? `up to ${f.prMinutes} min off each PR${f.measured ? ' (measured)' : ' (estimated)'}` : null, f.jobMinutesPerWeek != null ? `${f.jobMinutesPerWeek} runner-min/week` : null, f.usdPerMonth != null ? `${f.usdPerMonth >= 0 ? '+' : ''}$${f.usdPerMonth}/month` : null].filter(Boolean).join(', ');
    out.push(`${i + 1}. **Lesson ${f.lesson}, ${f.name}.** ${f.summary}. Fix: ${f.fix}.${gain ? ` Gain: ${gain}.` : ''} ${f.note}.${f.caution ? ` Caution: ${f.caution}.` : ''}`);
  });
  out.push('', '## The nine lessons', '', '| # | Lesson | State | What we saw |', '|---|---|---|---|');
  for (const l of r.lessons) out.push(`| ${l.id} | ${l.name} | ${STATE[l.state]} | ${l.summary}${l.evidence.length ? `<br>${l.evidence.slice(0, 3).join('<br>')}` : ''} |`);
  out.push('', '## Jobs (most runner time first)', '', '| Job | Runner | n | Wait p50/p90 | Setup p50 | Running p50 | Billed min/week | $/month |', '|---|---|---|---|---|---|---|---|');
  for (const j of r.jobs.slice(0, maxJobs)) out.push(`| ${j.key} | ${j.runner} | ${j.n} | ${t(j.wait.p50)}/${t(j.wait.p90)} | ${t(j.setup.p50)} | ${t(j.run.p50)} | ${j.billedMinutesPerWeek} | ${j.usdPerMonth} |`);
  out.push('', `**Cost:** about ${r.cost.billedMinutesPerWeek} billed runner-minutes a week, $${r.cost.usdPerMonth} a month at list prices (${r.cost.note}). Price rows and sources are in --json.`);
  return out.join('\n') + '\n';
}

export function renderCompare(before: AuditReport, after: AuditReport): string {
  const out = [`# CI audit compare: ${after.repo}`, '', `Before: ${before.window.since} to ${before.window.until}. After: ${after.window.since} to ${after.window.until}.`, '', '| Measure | Before | After |', '|---|---|---|'];
  out.push(`| Push to all green p50 | ${t(before.pushToGreen.p50)} | ${t(after.pushToGreen.p50)} |`, `| Push to all green p90 | ${t(before.pushToGreen.p90)} | ${t(after.pushToGreen.p90)} |`, `| All-green heads | ${before.pushToGreen.n} | ${after.pushToGreen.n} |`, `| Billed min/week | ${before.cost.billedMinutesPerWeek} | ${after.cost.billedMinutesPerWeek} |`, `| $/month | ${before.cost.usdPerMonth} | ${after.cost.usdPerMonth} |`);
  const keys = [...new Set([...before.jobs.map(j => j.key), ...after.jobs.map(j => j.key)])];
  for (const k of keys.slice(0, 15)) {
    const b = before.jobs.find(j => j.key === k); const a = after.jobs.find(j => j.key === k);
    out.push(`| ${k} wait/setup/run p50 | ${b ? `${t(b.wait.p50)}/${t(b.setup.p50)}/${t(b.run.p50)}` : '-'} | ${a ? `${t(a.wait.p50)}/${t(a.setup.p50)}/${t(a.run.p50)}` : '-'} |`);
  }
  for (const l of after.lessons) { const b = before.lessons.find(x => x.id === l.id); if (b && b.state !== l.state) out.push(`| Lesson ${l.id} | ${b.state} | ${l.state} |`); }
  return out.join('\n') + '\n';
}
