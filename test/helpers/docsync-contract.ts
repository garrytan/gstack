import * as path from 'node:path';

export interface DocsCompletion {
  schema_version: 1;
  audit_id: string;
  status: 'updated' | 'current' | 'blocked';
  files_updated: string[];
  files_reviewed: string[];
  documentation_section: string;
  blockers: string[];
  decisions: string[];
}

const keys = ['schema_version', 'audit_id', 'status', 'files_updated', 'files_reviewed', 'documentation_section', 'blockers', 'decisions'];

export function parseDocsCompletion(output: string, auditId: string): DocsCompletion {
  const result = JSON.parse(output.trimEnd().split('\n').at(-1)!);
  if (!result || Array.isArray(result) || typeof result !== 'object' ||
      Object.keys(result).sort().join() !== [...keys].sort().join()) throw new Error('completion fields');
  if (result.schema_version !== 1 || result.audit_id !== auditId) throw new Error('completion identity');
  if (!['updated', 'current', 'blocked'].includes(result.status)) throw new Error('completion status');
  for (const field of ['files_updated', 'files_reviewed', 'blockers', 'decisions']) {
    if (!Array.isArray(result[field]) || result[field].some((v: unknown) => typeof v !== 'string' || !v.trim())) {
      throw new Error(`completion ${field}`);
    }
  }
  if (typeof result.documentation_section !== 'string' || !result.documentation_section.trim()) throw new Error('completion markdown');
  for (const field of ['files_updated', 'files_reviewed']) {
    const paths: string[] = result[field];
    if (new Set(paths).size !== paths.length || paths.some(p => path.posix.isAbsolute(p) || p.includes('\\') ||
      p.split('/').some(part => !part || part === '.' || part === '..') || /[*?\[\]]/.test(p))) throw new Error('completion paths');
  }
  if (result.status === 'blocked' ? result.blockers.length === 0 : result.blockers.length !== 0) throw new Error('completion blockers');
  if (result.status === 'current' && result.files_updated.length !== 0 ||
      result.status === 'updated' && result.files_updated.length === 0) throw new Error('completion edits');
  return result;
}

export function vetDocsCompletion(result: DocsCompletion, evidence: {
  settled: boolean;
  markerSeen: boolean;
  headUnchanged: boolean;
  indexUnchanged: boolean;
  candidateUnchanged: boolean;
  readOnly: boolean;
  changedPaths: string[];
  allowedDocs: string[];
}): void {
  if (!evidence.settled || !evidence.markerSeen) throw new Error('unsettled or unmarked child');
  if (!evidence.headUnchanged || !evidence.indexUnchanged) throw new Error('Git ownership violation');
  if (!evidence.candidateUnchanged) throw new Error('stale candidate');
  if (evidence.readOnly && evidence.changedPaths.length) throw new Error('read-only mutation');
  if ([...evidence.changedPaths].sort().join('\0') !== [...result.files_updated].sort().join('\0')) throw new Error('unreported edits');
  const forbidden = /(?:^|\/)(?:VERSION|CHANGELOG(?:\.[^/]*)?|TODOS(?:\.[^/]*)?|package(?:-lock)?\.json|[^/]*lock[^/]*|manifest\.json)$/i;
  if (evidence.changedPaths.some(p => forbidden.test(p) || !evidence.allowedDocs.includes(p))) throw new Error('non-doc mutation');
}

/**
 * The changed paths the accepted (last) attempt answers for. A rejected earlier attempt's reported edit stays in the tree
 * (Blocked recovery preserves partial content), so it is not the accepted attempt's unreported edit; the accepted attempt
 * answers for it again only when its own `files_updated` claims it (an honest re-audit that re-edited the same document).
 */
export function acceptedChangedPaths(changed: string[], contracts: Array<Pick<DocsCompletion, 'files_updated'>>): string[] {
  const accepted = contracts.at(-1)!;
  const retained = contracts.slice(0, -1).flatMap(earlier => earlier.files_updated);
  return changed.filter(p => !retained.includes(p) || accepted.files_updated.includes(p));
}

/**
 * Each dispatch's completion in order. The accepted (last) attempt must meet the whole contract. An earlier attempt is one
 * the parent rejected, so only what it reported is read: its audit id, status and files_updated (gate 40805543956: attempt
 * 1 omitted documentation_section, the parent rejected it and re-audited over its retained edit).
 */
export function docsAttemptContracts(outputs: string[]): { accepted: DocsCompletion; attempts: Array<Pick<DocsCompletion, 'audit_id' | 'status' | 'files_updated'>> } {
  const reports = outputs.map(output => JSON.parse(output.trimEnd().split('\n').at(-1)!));
  const accepted = parseDocsCompletion(outputs.at(-1)!, reports.at(-1)?.audit_id);
  const earlier = reports.slice(0, -1).map(report => {
    if (!report || typeof report.audit_id !== 'string' || !['updated', 'current', 'blocked'].includes(report.status) || !Array.isArray(report.files_updated)
      || report.files_updated.some((file: unknown) => typeof file !== 'string' || !file.trim())) throw new Error('rejected attempt report');
    return { audit_id: report.audit_id, status: report.status, files_updated: report.files_updated };
  });
  return { accepted, attempts: [...earlier, accepted] };
}

export function extractDocsDispatch(section: string): string {
  const begin = section.indexOf('**Subagent prompt:**');
  const end = section.indexOf('**Parent processing:**');
  if (begin < 0 || end <= begin) throw new Error('documentation dispatch markers moved');
  return section.slice(begin + '**Subagent prompt:**'.length, end)
    .split('\n').map(line => line.replace(/^> ?/, '')).join('\n').trim();
}

export function docsDispatchIndex(calls: Array<{ tool: string; input: unknown }>): number {
  return docsDispatchIndices(calls)[0] ?? -1;
}

/**
 * Every /document-release dispatch, in order. The audit gate's attempt budget is an initial audit plus one repair/re-audit, so a
 * run has one or two; the parent's accepted contract is the last (gate 40465691803: the parent rejected attempt 1 for a false
 * claim in its section, re-audited over its retained edit, and reported attempt 2's section).
 */
export function docsDispatchIndices(calls: Array<{ tool: string; input: unknown }>): number[] {
  return calls.flatMap((call, index) => ['Agent', 'Task'].includes(call.tool) &&
    /document-release\/SKILL\.md|executing the \/document-release workflow/i.test(JSON.stringify(call.input)) &&
    !/Parent processing:|## Step 19: Create PR\/MR/.test(JSON.stringify(call.input)) ? [index] : []);
}
