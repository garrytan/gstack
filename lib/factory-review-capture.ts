import type { ArtifactRef, FactoryRunState } from './factory-core';

export interface ReviewLogEntry {
  readonly skill?: string;
  readonly timestamp?: string;
  readonly status?: string;
  readonly issues_found?: number;
  readonly critical?: number;
  readonly informational?: number;
  readonly quality_score?: number;
  readonly specialists?: unknown;
  readonly findings?: unknown;
  readonly commit?: string;
  readonly factory_run_id?: string;
  readonly factoryRunId?: string;
  readonly [key: string]: unknown;
}

export interface PendingReviewDispatch {
  readonly runId: string;
  readonly phaseId: string;
  readonly dispatchedAt?: string;
  readonly commit?: string;
  readonly queuedSkillCommand?: string;
}

export type ReviewCaptureSelection =
  | { readonly ok: true; readonly entry: ReviewLogEntry }
  | { readonly ok: false; readonly reason: 'no-match' | 'ambiguous' };

export function parseReviewLogJsonl(content: string): ReviewLogEntry[] {
  const entries: ReviewLogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') entries.push(parsed as ReviewLogEntry);
    } catch {
      // Ignore malformed historical lines. Capture remains best-effort and fail-closed via no-match.
    }
  }
  return entries;
}

export function pendingReviewDispatchFromState(state: FactoryRunState): PendingReviewDispatch | null {
  if (state.status !== 'running' || state.currentPhaseId !== 'diff-review') return null;
  const artifact = state.artifacts.find(candidate => candidate.phaseId === 'diff-review' && candidate.metadata && (
    candidate.metadata.pendingExternalReview === true || candidate.metadata.pendingExternalWork === true
  ));
  if (!artifact) return null;

  const metadataRunId = stringOrUndefined(artifact.metadata?.factoryRunId);
  const stateRunId = stringOrUndefined(state.runId);
  if (metadataRunId && stateRunId && metadataRunId !== stateRunId) return null;

  const runId = metadataRunId ?? stateRunId;
  if (!runId) return null;

  return {
    runId,
    phaseId: 'diff-review',
    dispatchedAt: stringOrUndefined(artifact.metadata?.dispatchedAt),
    commit: stringOrUndefined(artifact.metadata?.commit),
    queuedSkillCommand: stringOrUndefined(artifact.metadata?.queuedSkillCommand),
  };
}

export function selectReviewCaptureEntry(entries: readonly ReviewLogEntry[], dispatch: PendingReviewDispatch): ReviewCaptureSelection {
  if (!dispatch.commit || !dispatch.dispatchedAt) return { ok: false, reason: 'no-match' };

  const dispatchedAtMs = Date.parse(dispatch.dispatchedAt);
  if (Number.isNaN(dispatchedAtMs)) return { ok: false, reason: 'no-match' };
  const candidates = entries.filter(entry => {
    if (!isCompleteReviewLogEntry(entry)) return false;
    const timestampMs = Date.parse(entry.timestamp);
    if (timestampMs < dispatchedAtMs) return false;
    if (entry.commit !== dispatch.commit) return false;
    if (reviewLogFactoryRunId(entry) !== dispatch.runId) return false;
    return true;
  });

  if (candidates.length === 0) return { ok: false, reason: 'no-match' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, entry: candidates[0] };
}

export function reviewLogEntryToArtifact(runId: string, entry: ReviewLogEntry): { ref: ArtifactRef; content: string } {
  const status = typeof entry.status === 'string' ? entry.status : 'unknown';
  const issues = numberOrZero(entry.issues_found);
  const critical = numberOrZero(entry.critical);
  const informational = numberOrZero(entry.informational);
  const score = typeof entry.quality_score === 'number' ? entry.quality_score : null;
  const summary = `Review ${status}: ${issues} issue(s), ${critical} critical, ${informational} informational`;

  const content = [
    '# Captured GStack Review',
    '',
    `Run: ${runId}`,
    `Timestamp: ${entry.timestamp || 'unknown'}`,
    `Status: ${status}`,
    `Issues found: ${issues}`,
    `Critical: ${critical}`,
    `Informational: ${informational}`,
    `Quality score: ${score ?? 'unknown'}`,
    `Commit: ${entry.commit || 'unknown'}`,
    '',
    '## Specialists',
    '',
    fencedJson(entry.specialists ?? {}),
    '',
    '## Findings',
    '',
    fencedJson(entry.findings ?? []),
    '',
  ].join('\n');

  return {
    ref: {
      id: 'diff-review-captured',
      kind: 'review',
      phaseId: 'diff-review',
      summary,
      metadata: {
        capturedFrom: 'gstack-review-log',
        reviewStatus: status,
        issuesFound: issues,
        critical,
        informational,
        qualityScore: score,
        commit: entry.commit,
      },
    },
    content,
  };
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function reviewLogFactoryRunId(entry: ReviewLogEntry): string | undefined {
  return stringOrUndefined(entry.factory_run_id) ?? stringOrUndefined(entry.factoryRunId);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isCompleteReviewLogEntry(entry: ReviewLogEntry): entry is ReviewLogEntry & { skill: 'review'; timestamp: string; status: 'clean' | 'issues_found' } {
  return entry.skill === 'review'
    && typeof entry.timestamp === 'string'
    && !Number.isNaN(Date.parse(entry.timestamp))
    && (entry.status === 'clean' || entry.status === 'issues_found');
}
