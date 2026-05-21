import type { ArtifactRef, FactoryRunState } from './factory-core';

export interface QaLogEntry {
  readonly skill?: string;
  readonly timestamp?: string;
  readonly status?: string;
  readonly mode?: string;
  readonly summary?: string;
  readonly target_url?: string;
  readonly target_environment?: string;
  readonly authenticated_as?: string;
  readonly scenarios?: unknown;
  readonly screenshots?: unknown;
  readonly trace?: unknown;
  readonly trace_steps?: unknown;
  readonly passed?: number;
  readonly failed?: number;
  readonly must_fix?: number;
  readonly issues_found?: number;
  readonly factory_run_id?: string;
  readonly factoryRunId?: string;
  readonly [key: string]: unknown;
}

export interface PendingQaDispatch {
  readonly runId: string;
  readonly phaseId: 'qa-execution';
  readonly dispatchedAt?: string;
  readonly queuedSkillCommand?: string;
}

export type QaCaptureSelection =
  | { readonly ok: true; readonly entry: QaLogEntry }
  | { readonly ok: false; readonly reason: 'no-match' | 'ambiguous' };

interface QaScenario {
  readonly name: string;
  readonly result: 'pass' | 'fail' | 'other';
  readonly severity?: string;
  readonly evidence: readonly string[];
}

interface QaEvidenceRef {
  readonly uri: string;
  readonly caption?: string;
}

interface QaTraceStep {
  readonly timestamp?: string;
  readonly detail: string;
}

export function parseQaLogJsonl(content: string): QaLogEntry[] {
  const entries: QaLogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') entries.push(parsed as QaLogEntry);
    } catch {
      // Ignore malformed historical lines. Capture remains best-effort and fail-closed via no-match.
    }
  }
  return entries;
}

export function pendingQaDispatchFromState(state: FactoryRunState): PendingQaDispatch | null {
  if (state.status !== 'running' || state.currentPhaseId !== 'qa-execution') return null;
  const artifact = state.artifacts.find(candidate => candidate.phaseId === 'qa-execution' && candidate.metadata && (
    candidate.metadata.pendingExternalQa === true || candidate.metadata.pendingExternalWork === true
  ));
  if (!artifact) return null;

  const metadataRunId = stringOrUndefined(artifact.metadata?.factoryRunId);
  const stateRunId = stringOrUndefined(state.runId);
  if (metadataRunId && stateRunId && metadataRunId !== stateRunId) return null;

  const runId = metadataRunId ?? stateRunId;
  if (!runId) return null;

  return {
    runId,
    phaseId: 'qa-execution',
    dispatchedAt: stringOrUndefined(artifact.metadata?.dispatchedAt),
    queuedSkillCommand: stringOrUndefined(artifact.metadata?.queuedSkillCommand),
  };
}

export function selectQaCaptureEntry(entries: readonly QaLogEntry[], dispatch: PendingQaDispatch): QaCaptureSelection {
  if (!dispatch.dispatchedAt) return { ok: false, reason: 'no-match' };

  const dispatchedAtMs = Date.parse(dispatch.dispatchedAt);
  if (Number.isNaN(dispatchedAtMs)) return { ok: false, reason: 'no-match' };
  const expectedSkill = expectedQaSkill(dispatch.queuedSkillCommand);

  const candidates = entries.filter(entry => {
    if (!isCompleteQaLogEntry(entry)) return false;
    const timestampMs = Date.parse(entry.timestamp);
    if (timestampMs < dispatchedAtMs) return false;
    if (qaLogFactoryRunId(entry) !== dispatch.runId) return false;
    if (expectedSkill && entry.skill !== expectedSkill) return false;
    return true;
  });

  if (candidates.length === 0) return { ok: false, reason: 'no-match' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, entry: candidates[0] };
}

export function qaLogEntryToArtifact(runId: string, entry: QaLogEntry): { ref: ArtifactRef; content: string } {
  const mode = entry.mode === 'fix' ? 'fix' : 'audit';
  const status = typeof entry.status === 'string' ? entry.status : 'unknown';
  const scenarios = extractScenarios(entry.scenarios);
  const screenshots = extractEvidenceRefs(entry.screenshots);
  const traceSteps = extractTraceSteps(entry.trace_steps ?? entry.trace);

  const passed = numberOrUndefined(entry.passed) ?? scenarios.filter(scenario => scenario.result === 'pass').length;
  const failed = numberOrUndefined(entry.failed) ?? scenarios.filter(scenario => scenario.result === 'fail').length;
  const mustFix = numberOrUndefined(entry.must_fix) ?? scenarios.filter(scenario => scenario.severity === 'must-fix').length;
  const issuesFound = numberOrUndefined(entry.issues_found) ?? failed;

  const summary = `QA ${mode} ${status}: ${passed} passed, ${failed} failed, ${mustFix} must-fix`;

  const content = [
    '# Captured GStack QA',
    '',
    `Run: ${runId}`,
    `Timestamp: ${entry.timestamp || 'unknown'}`,
    `Mode: ${mode}`,
    mode === 'audit'
      ? 'Safety: Browser QA audit — no code changes.'
      : 'Safety: QA fix — safe local writes approved.',
    `Status: ${status}`,
    `Target URL: ${entry.target_url || 'unknown'}`,
    `Target environment: ${entry.target_environment || 'unknown'}`,
    `Authenticated as: ${entry.authenticated_as || 'unknown'}`,
    `Issues found: ${issuesFound}`,
    `Scenarios passed: ${passed}`,
    `Scenarios failed: ${failed}`,
    `Must-fix scenarios: ${mustFix}`,
    '',
    '## Scenario matrix',
    '',
    scenarioMatrixMarkdown(scenarios),
    '',
    '## Screenshot evidence',
    '',
    evidenceListMarkdown(screenshots),
    '',
    '## Trace summary',
    '',
    traceListMarkdown(traceSteps),
    '',
    '## Raw payload',
    '',
    fencedJson(entry),
    '',
  ].join('\n');

  return {
    ref: {
      id: 'qa-execution-captured',
      kind: 'qa-report',
      phaseId: 'qa-execution',
      summary,
      metadata: {
        capturedFrom: 'gstack-qa-log',
        qaMode: mode,
        qaStatus: status,
        issuesFound,
        scenariosPassed: passed,
        scenariosFailed: failed,
        mustFix,
        screenshotCount: screenshots.length,
        traceStepCount: traceSteps.length,
        targetUrl: entry.target_url,
        targetEnvironment: entry.target_environment,
      },
    },
    content,
  };
}

function expectedQaSkill(queuedSkillCommand: string | undefined): 'qa-only' | 'qa' | undefined {
  if (!queuedSkillCommand) return undefined;
  if (queuedSkillCommand.includes('/skill:gstack-qa-only')) return 'qa-only';
  if (queuedSkillCommand.includes('/skill:gstack-qa')) return 'qa';
  return undefined;
}

function scenarioMatrixMarkdown(scenarios: readonly QaScenario[]): string {
  if (scenarios.length === 0) return '_No scenario matrix was provided in the QA log._';
  return [
    '| Scenario | Result | Severity | Evidence |',
    '|---|---|---|---|',
    ...scenarios.map(scenario => {
      const severity = scenario.severity || '—';
      const evidence = scenario.evidence.length > 0 ? scenario.evidence.join('<br/>') : '—';
      return `| ${escapeCell(scenario.name)} | ${scenario.result.toUpperCase()} | ${escapeCell(severity)} | ${escapeCell(evidence)} |`;
    }),
  ].join('\n');
}

function evidenceListMarkdown(evidence: readonly QaEvidenceRef[]): string {
  if (evidence.length === 0) return '_No screenshots were listed in the QA log._';
  return evidence
    .map(item => item.caption ? `- ${item.caption}: ${item.uri}` : `- ${item.uri}`)
    .join('\n');
}

function traceListMarkdown(traceSteps: readonly QaTraceStep[]): string {
  if (traceSteps.length === 0) return '_No trace steps were listed in the QA log._';
  return traceSteps
    .map((step, index) => step.timestamp ? `${index + 1}. [${step.timestamp}] ${step.detail}` : `${index + 1}. ${step.detail}`)
    .join('\n');
}

function extractScenarios(value: unknown): QaScenario[] {
  if (!Array.isArray(value)) return [];
  const scenarios: QaScenario[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = stringOrUndefined((entry as Record<string, unknown>).name);
    if (!name) continue;

    const rawResult = stringOrUndefined((entry as Record<string, unknown>).result)?.toLowerCase();
    const result: QaScenario['result'] = rawResult === 'pass' || rawResult === 'fail' ? rawResult : 'other';
    scenarios.push({
      name,
      result,
      severity: stringOrUndefined((entry as Record<string, unknown>).severity),
      evidence: extractScenarioEvidence((entry as Record<string, unknown>).evidence),
    });
  }
  return scenarios;
}

function extractScenarioEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(candidate => stringOrUndefined(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function extractEvidenceRefs(value: unknown): QaEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: QaEvidenceRef[] = [];
  for (const candidate of value) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      refs.push({ uri: candidate });
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;

    const record = candidate as Record<string, unknown>;
    const uri = stringOrUndefined(record.uri) ?? stringOrUndefined(record.path) ?? stringOrUndefined(record.url);
    if (!uri) continue;
    refs.push({
      uri,
      caption: stringOrUndefined(record.caption) ?? stringOrUndefined(record.label),
    });
  }
  return refs;
}

function extractTraceSteps(value: unknown): QaTraceStep[] {
  if (!Array.isArray(value)) return [];
  const steps: QaTraceStep[] = [];
  for (const candidate of value) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      steps.push({ detail: candidate });
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const detail = stringOrUndefined(record.detail) ?? stringOrUndefined(record.message) ?? stringOrUndefined(record.step);
    if (!detail) continue;
    steps.push({
      timestamp: stringOrUndefined(record.timestamp) ?? stringOrUndefined(record.ts),
      detail,
    });
  }
  return steps;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function qaLogFactoryRunId(entry: QaLogEntry): string | undefined {
  return stringOrUndefined(entry.factory_run_id) ?? stringOrUndefined(entry.factoryRunId);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isCompleteQaLogEntry(entry: QaLogEntry): entry is QaLogEntry & { skill: 'qa' | 'qa-only'; timestamp: string; status: string } {
  return (entry.skill === 'qa' || entry.skill === 'qa-only')
    && typeof entry.timestamp === 'string'
    && !Number.isNaN(Date.parse(entry.timestamp))
    && typeof entry.status === 'string'
    && entry.status.length > 0;
}
