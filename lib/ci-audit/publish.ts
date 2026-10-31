import { AuditError, requireGh, type ApiClient, type Budget } from './github';
import type { AuditReport } from './report';
import { renderMarkdown } from './report';

export const ISSUE_TITLE = 'Weekly CI audit';
export const ISSUE_MARKER = '<!-- gstack-ci-audit:weekly -->';
const MAX_BODY = 60_000;

export interface Outcome { exit: number; report: AuditReport | null; error?: string; runUrl?: string }
export interface Existing { number: number; body: string }
export type IssueAction =
  | { action: 'create'; body: string }
  | { action: 'update'; body: string }
  | { action: 'keep'; comment: string }
  | { action: 'close'; comment: string }
  | { action: 'none'; reason: string };

/**
 * What the Saturday audit does to the one "Weekly CI audit" issue. Only a complete audit
 * replaces or closes it; a partial or failed run leaves the tracked findings in place and says why.
 */
export function planIssue(o: Outcome, existing: Existing | null): IssueAction {
  const r = o.report;
  const date = (r?.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const link = o.runUrl ? ` ([run](${o.runUrl}))` : '';
  const complete = o.exit === 0 && r?.ok === true;
  const partial = o.exit === 4 && r?.ok === true;
  if (!complete && !partial) {
    const why = `the ${date} audit could not finish: ${(o.error ?? 'no report').split('\n')[0]!.slice(0, 300)}${link}`;
    return existing ? { action: 'keep', comment: `Kept open: ${why}. The findings above are from the last complete audit.` } : { action: 'none', reason: why };
  }
  const findings = r!.fixes.length;
  if (partial && existing) return { action: 'keep', comment: `Kept open: the ${date} audit was partial (${r!.partial.join('; ')})${link}, so the findings above stay until a complete audit replaces them.` };
  if (!findings) {
    if (partial) return { action: 'none', reason: `partial audit on ${date} with no findings` };
    return existing ? { action: 'close', comment: `Closing: the complete ${date} audit${link} found nothing to fix.` } : { action: 'none', reason: `complete audit on ${date} found nothing to fix` };
  }
  const body = issueBody(r!, o.runUrl);
  return existing ? { action: 'update', body } : { action: 'create', body };
}

export function issueBody(r: AuditReport, runUrl?: string): string {
  const head = [ISSUE_MARKER, `Updated by the Saturday CI audit${runUrl ? ` ([run](${runUrl}))` : ''}. Report only: nothing was changed. Run \`/ci-audit\` to apply a fix with approval.`, ''].join('\n');
  const md = renderMarkdown(r);
  return head + (md.length > MAX_BODY ? md.slice(0, MAX_BODY) + '\n\n(truncated; the full report is the run artifact)' : md);
}

/** The open issue this audit owns: its title and marker, so a person's issue with the same title is left alone. */
export async function findIssue(client: ApiClient, repo: string): Promise<Existing | null> {
  const res = await client.get(`/repos/${repo}/issues?state=open&per_page=100&sort=created&direction=asc`);
  if (res.status !== 200) throw new AuditError('ci_audit_api_failed', `issues list returned HTTP ${res.status}`, 'now');
  const hit = ((res.json as any[]) ?? []).find(i => !i.pull_request && i.title === ISSUE_TITLE && String(i.body ?? '').includes(ISSUE_MARKER));
  return hit ? { number: Number(hit.number), body: String(hit.body) } : null;
}

export type GhWrite = (method: 'POST' | 'PATCH', apiPath: string, body: Record<string, unknown>) => Promise<number>;

export async function applyIssue(write: GhWrite, repo: string, a: IssueAction, existing: Existing | null): Promise<string> {
  const base = `/repos/${repo}/issues`;
  const ok = async (method: 'POST' | 'PATCH', p: string, body: Record<string, unknown>) => {
    const status = await write(method, p, body);
    if (status >= 300) throw new AuditError('ci_audit_api_failed', `${method} ${p} returned HTTP ${status}`, 'now');
  };
  if (a.action === 'create' || a.action === 'update') {
    if (a.action === 'create') await ok('POST', base, { title: ISSUE_TITLE, body: a.body });
    else await ok('PATCH', `${base}/${existing!.number}`, { body: a.body });
    return a.action === 'create' ? 'CI_AUDIT_ISSUE: created' : `CI_AUDIT_ISSUE: updated #${existing!.number}`;
  }
  if (a.action === 'keep') { await ok('POST', `${base}/${existing!.number}/comments`, { body: a.comment }); return `CI_AUDIT_ISSUE: kept #${existing!.number} open`; }
  if (a.action === 'close') {
    await ok('POST', `${base}/${existing!.number}/comments`, { body: a.comment });
    await ok('PATCH', `${base}/${existing!.number}`, { state: 'closed', state_reason: 'completed' });
    return `CI_AUDIT_ISSUE: closed #${existing!.number}`;
  }
  return `CI_AUDIT_ISSUE: none (${a.reason})`;
}

/** Issue writes through `gh api`, sharing the run's call budget and deadline. */
export function ghWrite(budget: Budget, gh = 'gh'): GhWrite {
  return async (method, apiPath, body) => {
    requireGh(gh);
    budget.reserve();
    const proc = Bun.spawn([gh, 'api', '-X', method, '-i', apiPath.replace(/^\//, ''), '--input', '-'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    const timer = setTimeout(() => proc.kill(), budget.remainingMs());
    try {
      proc.stdin.write(JSON.stringify(body));
      proc.stdin.end();
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return Number(/^HTTP\/[\d.]+ (\d{3})/.exec(out)?.[1] ?? 599);
    } finally { clearTimeout(timer); }
  };
}
