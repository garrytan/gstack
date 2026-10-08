import { FRESHNESS_BOUNDS, withinDeadline } from './model-policy-freshness-sources';
import { assessFreshness, observationIsOlder, renderFreshnessReport, sameCatalog, validLifecycle, validState, type CatalogIdentity, type FreshnessObservation, type FreshnessReport, type FreshnessState, type LifecycleFinding } from './model-policy-freshness';

export const FRESHNESS_ISSUE_MARKER = '<!-- gstack:model-policy-freshness:v1 -->';
export const FRESHNESS_REGION_BEGIN = '<!-- gstack:model-policy-freshness:begin -->';
export const FRESHNESS_REGION_END = '<!-- gstack:model-policy-freshness:end -->';
const STATE_BEGIN = '<!-- gstack:model-policy-freshness:state:begin -->';
const STATE_END = '<!-- gstack:model-policy-freshness:state:end -->';
const HISTORY_BEGIN = '<!-- gstack:model-policy-freshness:lifecycle:begin -->';
const HISTORY_END = '<!-- gstack:model-policy-freshness:lifecycle:end -->';
export const FRESHNESS_ISSUE_AUTHOR = 'github-actions[bot]';
export type TrackingIssue = { number: number; body: string; state: 'open' | 'closed'; author: string };
export type FreshnessGitHub = {
  defaultCatalog: (signal: AbortSignal) => Promise<{ defaultBranch: string; sourceSha256: string }>;
  listIssues: (signal: AbortSignal) => Promise<TrackingIssue[]>;
  readIssue: (number: number, signal: AbortSignal) => Promise<TrackingIssue>;
  createIssue: (body: string, signal: AbortSignal) => Promise<TrackingIssue>;
  updateIssue: (number: number, update: { body: string; state: 'open' | 'closed' }, signal: AbortSignal) => Promise<void>;
};
export type StoredIssue = { state: FreshnessState | null; lifecycle: LifecycleFinding[]; recoveryRequired: boolean; problem: string | null };
const KNOWN_MARKERS = [FRESHNESS_ISSUE_MARKER, FRESHNESS_REGION_BEGIN, FRESHNESS_REGION_END, STATE_BEGIN, STATE_END, HISTORY_BEGIN, HISTORY_END];

function markerLines(body: string, marker?: string): { start: number; end: number; text: string }[] {
  return [...body.matchAll(/[^\r\n]+/g)].flatMap(line => {
    const text = line[0];
    const matches = marker === undefined ? /^[\uFEFF \t]*(?:<!--|<!-)[ \t]*gstack:model-policy-freshness/i.test(text) : text === marker;
    return matches ? [{ start: line.index, end: line.index + text.length, text }] : [];
  });
}

const occurrences = (body: string, marker: string): number => markerLines(body, marker).length;
const malformedMarkers = (body: string): boolean => markerLines(body).some(line => !KNOWN_MARKERS.includes(line.text));

function block(body: string, begin: string, end: string): { start: number; end: number; text: string } | null {
  const starts = markerLines(body, begin);
  const ends = markerLines(body, end);
  if (starts.length !== 1 || ends.length !== 1 || ends[0].start <= starts[0].end) return null;
  return { start: starts[0].start, end: ends[0].end, text: body.slice(starts[0].end, ends[0].start).trim() };
}

function jsonBlock(body: string, begin: string, end: string): unknown {
  const text = block(body, begin, end)?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function readFreshnessIssue(body: string): StoredIssue {
  const owned = block(body, FRESHNESS_REGION_BEGIN, FRESHNESS_REGION_END);
  const history = jsonBlock(owned?.text ?? body, HISTORY_BEGIN, HISTORY_END);
  const state = jsonBlock(owned?.text ?? body, STATE_BEGIN, STATE_END);
  const lifecycle = validLifecycle(history) ? history : validState(state) ? state.lifecycle : [];
  if (owned && occurrences(body, FRESHNESS_ISSUE_MARKER) === 1 && !malformedMarkers(body) && validState(state) && validLifecycle(history) && JSON.stringify(state.lifecycle) === JSON.stringify(history)) return { state, lifecycle, recoveryRequired: state.recoveryRequired, problem: null };
  return { state: validState(state) ? state : null, lifecycle, recoveryRequired: true, problem: 'missing-or-corrupt-authoritative-state:retain-history-and-repair-manually' };
}

export function writeFreshnessIssue(body: string, report: FreshnessReport): string {
  const region = [FRESHNESS_REGION_BEGIN, renderFreshnessReport(report), '', STATE_BEGIN, JSON.stringify(report.state), STATE_END, '', HISTORY_BEGIN, JSON.stringify(report.state.lifecycle), HISTORY_END, FRESHNESS_REGION_END].join('\n');
  let next: string;
  const owned = block(body, FRESHNESS_REGION_BEGIN, FRESHNESS_REGION_END);
  if (malformedMarkers(body)) throw new Error('corrupt-owned-region:manual-recovery-required');
  if (owned !== null) {
    const recovery = readFreshnessIssue(body);
    const archive = recovery.problem ? `\n\n<details><summary>Corrupt authoritative region retained for manual recovery (base64 UTF-8)</summary>\n\n\`\`\`text\n${Buffer.from(owned.text, 'utf8').toString('base64')}\n\`\`\`\n</details>` : '';
    next = body.slice(0, owned.start) + region + archive + body.slice(owned.end);
  } else if (markerLines(body).some(line => line.text !== FRESHNESS_ISSUE_MARKER)) {
    throw new Error('corrupt-owned-region:manual-recovery-required');
  } else {
    next = `${body}${body ? '\n\n' : ''}${region}`;
  }
  const topMarkers = occurrences(body, FRESHNESS_ISSUE_MARKER);
  if (topMarkers > 1) throw new Error('duplicate-tracking-marker:manual-recovery-required');
  if (!topMarkers) {
    if (markerLines(body).length) throw new Error('corrupt-tracking-marker:manual-recovery-required');
    next = `${FRESHNESS_ISSUE_MARKER}\n${next}`;
  }
  if (new TextEncoder().encode(next).length > FRESHNESS_BOUNDS.issueBytes) throw new Error('tracking-issue-size-limit:manual-triage-required');
  return next;
}

export type PublicationResult = { action: 'report-only' | 'rejected-obsolete-catalog' | 'rejected-older-observation' | 'updated' | 'created'; issueNumber?: number; report?: FreshnessReport };

async function checkAuthority(github: FreshnessGitHub, catalog: CatalogIdentity, signal: AbortSignal): Promise<boolean> {
  const current = await github.defaultCatalog(signal);
  if (signal.aborted) throw new Error('publication-aborted');
  if (current.defaultBranch !== 'main') throw new Error('default-branch-is-not-main:publication-disabled');
  return catalog.sourceSha256 === current.sourceSha256;
}

function publicationReport(observation: FreshnessObservation, issue?: TrackingIssue): FreshnessReport | null {
  const stored = issue ? readFreshnessIssue(issue.body) : { state: null, lifecycle: [], recoveryRequired: false };
  if (stored.state && observationIsOlder(observation, stored.state.latest)) return null;
  if (stored.lifecycle.some(finding => Date.parse(finding.lastObservedAt) > Date.parse(observation.checkedAt))) return null;
  const report = assessFreshness(observation, stored.state, stored.lifecycle, stored.recoveryRequired);
  if (report.state.lastSuccess && !sameCatalog(observation.catalog, report.state.lastSuccess.catalog) && report.status === 'current') throw new Error('mismatched-evidence');
  return report;
}

export async function publishFreshness(observation: FreshnessObservation, github: FreshnessGitHub, ref: string): Promise<PublicationResult> {
  if (ref !== 'refs/heads/main') return { action: 'report-only', report: assessFreshness(observation) };
  const controller = new AbortController();
  const signal = controller.signal;
  const publish = async (): Promise<PublicationResult> => {
    if (!await checkAuthority(github, observation.catalog, signal)) return { action: 'rejected-obsolete-catalog' };
    const issues = (await github.listIssues(signal)).filter(issue => markerLines(issue.body).length > 0);
    if (issues.some(issue => issue.author !== FRESHNESS_ISSUE_AUTHOR)) throw new Error('untrusted-tracking-marker-owner:manual-recovery-required');
    if (issues.length > 1 || issues.some(issue => occurrences(issue.body, FRESHNESS_ISSUE_MARKER) > 1)) throw new Error('duplicate-tracking-marker:manual-recovery-required');
    if (issues.some(issue => occurrences(issue.body, FRESHNESS_ISSUE_MARKER) !== 1 || malformedMarkers(issue.body))) throw new Error('corrupt-tracking-marker:manual-recovery-required');
    let issue = issues[0];
    if (!await checkAuthority(github, observation.catalog, signal)) return { action: 'rejected-obsolete-catalog' };
    if (issue) issue = await github.readIssue(issue.number, signal);
    if (issue && (occurrences(issue.body, FRESHNESS_ISSUE_MARKER) !== 1 || malformedMarkers(issue.body) || issue.author !== FRESHNESS_ISSUE_AUTHOR)) throw new Error('tracking-marker-or-owner-changed');
    const report = publicationReport(observation, issue);
    if (!report) return { action: 'rejected-older-observation', issueNumber: issue.number };
    const body = writeFreshnessIssue(issue?.body ?? '', report);
    const state = report.status === 'current' && report.complete && !report.state.lifecycle.some(finding => !finding.resolvedByCatalog) ? 'closed' : 'open';
    if (signal.aborted) throw new Error('publication-aborted');
    if (!issue) {
      issue = await github.createIssue(body, signal);
      if (issue.author !== FRESHNESS_ISSUE_AUTHOR) throw new Error('created-issue-owner-mismatch:manual-recovery-required');
      if (state === 'closed') await github.updateIssue(issue.number, { body, state }, signal);
      return { action: 'created', issueNumber: issue.number, report };
    }
    await github.updateIssue(issue.number, { body, state }, signal);
    return { action: 'updated', issueNumber: issue.number, report };
  };
  return withinDeadline(publish(), FRESHNESS_BOUNDS.publicationMs, controller);
}
