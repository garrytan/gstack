import { FRESHNESS_SOURCES, type SourceResult, type SourceReceipt } from './model-policy-freshness-sources';
import { MODEL_CATALOG, MODEL_CATALOG_VERSION, modelCatalogSha256 } from './model-catalog';
import { sha256 } from './model-policy-freshness-sources';

export const FRESHNESS_SCHEMA_VERSION = 1;
export const FRESHNESS_PARSER_VERSION = 1;
export type FreshnessModel = { provider: 'anthropic' | 'openai'; tier: 'frontier' | 'smart'; modelId: string };
export type CatalogIdentity = { sha256: string; sourceSha256: string; version: number; models: FreshnessModel[] };
export type FreshnessRun = { id: string; attempt: number; startedAt: string; headSha: string };
export type FreshnessObservation = { catalog: CatalogIdentity; checkedAt: string; run: FreshnessRun; sources: SourceResult[] };
export type FreshnessStatus = 'current' | 'update-candidate' | 'stale' | 'unknown/source-unavailable';
export type LifecycleFinding = { key: string; provider: FreshnessModel['provider']; modelId: string; state: 'legacy' | 'deprecated' | 'removed'; deadline: string | null; firstObservedAt: string; lastObservedAt: string; sourceUrl: string; resolvedByCatalog?: string };
export type FreshnessEvidence = {
  schemaVersion: 1; parserVersion: number; catalog: CatalogIdentity; checkedAt: string; nextCheckDueBy: string; run: FreshnessRun;
  sources: Omit<SourceReceipt, 'parsed'>[];
};
export type FreshnessState = {
  schemaVersion: 1; latest: { checkedAt: string; run: FreshnessRun }; lastSuccess: FreshnessEvidence | null;
  lifecycle: LifecycleFinding[]; recoveryRequired: boolean;
};
export type FreshnessReport = {
  schemaVersion: 1; status: FreshnessStatus; evidenceStatus: FreshnessStatus; complete: boolean;
  errors: string[]; candidates: { provider: string; tier: string; current: string; proposed: string; reason: string }[];
  state: FreshnessState;
};
const DAY = 86_400_000;
const iso = (value: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
export const isFreshnessDate = (value: unknown): value is string => string(value) && iso(value);

export function freshnessCatalogIdentity(sourceText: string): CatalogIdentity {
  return { sha256: modelCatalogSha256(), sourceSha256: sha256(sourceText), version: MODEL_CATALOG_VERSION, models: MODEL_CATALOG.map(entry => ({ provider: entry.provider, tier: entry.tier, modelId: entry.model })) };
}

export function validCatalog(value: unknown): value is CatalogIdentity {
  if (!object(value) || !hash(value.sha256) || !hash(value.sourceSha256) || !Number.isInteger(value.version) || Number(value.version) < 1 || !Array.isArray(value.models) || value.models.length !== 4) return false;
  const keys = new Set<string>();
  for (const entry of value.models) {
    if (!object(entry) || !['anthropic', 'openai'].includes(String(entry.provider)) || !['frontier', 'smart'].includes(String(entry.tier)) || !string(entry.modelId) || !/^[a-z][a-z0-9.-]{0,119}$/.test(entry.modelId)) return false;
    keys.add(`${entry.provider}/${entry.tier}`);
  }
  return keys.size === 4;
}

export function validRun(value: unknown): value is FreshnessRun {
  return object(value) && string(value.id) && /^\d{1,24}$/.test(value.id) && Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0 && isFreshnessDate(value.startedAt) && string(value.headSha) && /^[a-f0-9]{40,64}$/.test(value.headSha);
}

function validReceipt(value: unknown, source: typeof FRESHNESS_SOURCES[number]): boolean {
  return object(value) && value.id === source.id && value.url === source.url && hash(value.sha256)
    && (FRESHNESS_SOURCES.some(item => item.url === value.finalUrl) || value.finalUrl === 'https://developers.openai.com/api/docs/deprecations')
    && Number.isInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= 2 * 1024 * 1024;
}

export function sameCatalog(a: CatalogIdentity, b: CatalogIdentity): boolean {
  const keys = (catalog: CatalogIdentity) => catalog.models.map(model => `${model.provider}/${model.tier}/${model.modelId}`).sort().join('|');
  return a.sha256 === b.sha256 && a.sourceSha256 === b.sourceSha256 && a.version === b.version && keys(a) === keys(b);
}

export function validLifecycle(value: unknown): value is LifecycleFinding[] {
  return Array.isArray(value) && value.length <= 128 && new Set(value.map(item => object(item) ? item.key : undefined)).size === value.length && value.every(item => object(item)
    && ['anthropic', 'openai'].includes(String(item.provider)) && string(item.modelId) && /^[a-z][a-z0-9.-]{0,119}$/.test(item.modelId)
    && item.key === `${item.provider}/${item.modelId}` && ['legacy', 'deprecated', 'removed'].includes(String(item.state))
    && (item.deadline === null || (string(item.deadline) && /^\d{4}-\d\d-\d\d$/.test(item.deadline) && isFreshnessDate(`${item.deadline}T00:00:00.000Z`)))
    && isFreshnessDate(item.firstObservedAt) && isFreshnessDate(item.lastObservedAt)
    && FRESHNESS_SOURCES.some(source => source.id === `${item.provider}-lifecycle` && source.url === item.sourceUrl)
    && (item.resolvedByCatalog === undefined || hash(item.resolvedByCatalog)));
}

export function validEvidence(value: unknown): value is FreshnessEvidence {
  if (!object(value) || value.schemaVersion !== 1 || value.parserVersion !== FRESHNESS_PARSER_VERSION || !validCatalog(value.catalog) || !isFreshnessDate(value.checkedAt) || !isFreshnessDate(value.nextCheckDueBy) || !validRun(value.run) || !Array.isArray(value.sources) || value.sources.length !== 4) return false;
  if (Date.parse(value.nextCheckDueBy) !== Date.parse(value.checkedAt) + 7 * DAY) return false;
  const sources = value.sources;
  return Date.parse(value.run.startedAt) <= Date.parse(value.checkedAt)
    && FRESHNESS_SOURCES.every(source => sources.filter(receipt => validReceipt(receipt, source)).length === 1);
}

export function validState(value: unknown): value is FreshnessState {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.latest) || !isFreshnessDate(value.latest.checkedAt) || !validRun(value.latest.run)
    || (value.lastSuccess !== null && !validEvidence(value.lastSuccess)) || !validLifecycle(value.lifecycle) || typeof value.recoveryRequired !== 'boolean') return false;
  if (Date.parse(value.latest.run.startedAt) > Date.parse(value.latest.checkedAt)) return false;
  if (value.lastSuccess && (Date.parse(value.lastSuccess.checkedAt) > Date.parse(value.latest.checkedAt) || BigInt(value.lastSuccess.run.id) > BigInt(value.latest.run.id))) return false;
  const checkedAt = value.latest.checkedAt;
  return value.lifecycle.every(finding => Date.parse(finding.firstObservedAt) <= Date.parse(finding.lastObservedAt) && Date.parse(finding.lastObservedAt) <= Date.parse(checkedAt));
}

export function storedEvidenceStatus(catalog: CatalogIdentity, evidence: FreshnessEvidence | null, now: string): FreshnessStatus {
  if (!evidence || !validEvidence(evidence) || !sameCatalog(catalog, evidence.catalog) || !isFreshnessDate(now) || Date.parse(evidence.checkedAt) > Date.parse(now)) return 'unknown/source-unavailable';
  return Date.parse(now) - Date.parse(evidence.checkedAt) > 30 * DAY ? 'stale' : 'current';
}

export function observationIsOlder(observation: FreshnessObservation, latest: FreshnessState['latest']): boolean {
  const a = observation.run;
  const b = latest.run;
  return BigInt(a.id) < BigInt(b.id) || (a.id === b.id && a.attempt <= b.attempt)
    || Date.parse(observation.checkedAt) < Date.parse(latest.checkedAt)
    || Date.parse(a.startedAt) < Date.parse(b.startedAt);
}

function sourceErrors(observation: FreshnessObservation): string[] {
  return FRESHNESS_SOURCES.flatMap(source => {
    const results = observation.sources.filter(result => result.id === source.id);
    if (results.length !== 1) return [`${source.id}:missing-or-duplicate-source`];
    const result = results[0];
    if (result.error !== undefined) return [`${source.id}:${result.error}`];
    const receipt = result.receipt;
    if (!validReceipt(receipt, source)) return [`${source.id}:invalid-receipt`];
    if (source.id.endsWith('-models') && (!receipt.parsed.recommendations || !receipt.parsed.lineup?.length)) return [`${source.id}:missing-recommendations`];
    if (source.id.endsWith('-lifecycle') && !receipt.parsed.lifecycle?.length) return [`${source.id}:missing-lifecycle`];
    return [];
  });
}

function family(id: string): string {
  if (id.startsWith('claude-')) return id.split('-')[1];
  return /^gpt-\d+(?:\.\d+)?-([a-z]+)/.exec(id)?.[1] ?? id;
}

export function assessFreshness(observation: FreshnessObservation, previous: FreshnessState | null = null, recoveredLifecycle: LifecycleFinding[] = [], recoveryRequired = false): FreshnessReport {
  if (!validCatalog(observation.catalog) || !validRun(observation.run) || !isFreshnessDate(observation.checkedAt) || Date.parse(observation.checkedAt) < Date.parse(observation.run.startedAt)) throw new Error('invalid-observation-identity');
  const lifecycle = new Map((previous?.lifecycle ?? recoveredLifecycle).map(finding => [finding.key, { ...finding }]));
  for (const finding of lifecycle.values()) {
    if (observation.catalog.models.some(model => model.provider === finding.provider && model.modelId === finding.modelId)) delete finding.resolvedByCatalog;
  }
  const errors = sourceErrors(observation);
  const candidates: FreshnessReport['candidates'] = [];
  for (const model of observation.catalog.models) {
    const models = observation.sources.find(source => source.id === `${model.provider}-models`)?.receipt?.parsed;
    const rows = observation.sources.find(source => source.id === `${model.provider}-lifecycle`)?.receipt?.parsed.lifecycle;
    if (model.provider === 'anthropic' && rows && !rows.some(row => row.modelId === model.modelId)) errors.push(`anthropic-lifecycle:missing-default:${model.modelId}`);
    const row = rows?.find(row => row.modelId === model.modelId);
    if (row && row.state !== 'active') {
      const key = `${model.provider}/${model.modelId}`;
      const previousFinding = lifecycle.get(key);
      const rank = { legacy: 1, deprecated: 2, removed: 3 };
      const observedState = row.state === 'deprecated' && row.deadline && row.deadline <= observation.checkedAt.slice(0, 10) ? 'removed' : row.state;
      const state = previousFinding && rank[previousFinding.state] > rank[observedState] ? previousFinding.state : observedState;
      const deadline = previousFinding?.deadline && (!row.deadline || previousFinding.deadline < row.deadline) ? previousFinding.deadline : row.deadline;
      lifecycle.set(key, { key, provider: model.provider, modelId: model.modelId, state, deadline, sourceUrl: FRESHNESS_SOURCES.find(source => source.id === `${model.provider}-lifecycle`)!.url, firstObservedAt: previousFinding?.firstObservedAt ?? observation.checkedAt, lastObservedAt: observation.checkedAt });
    }
    const proposed = models?.recommendations?.[model.tier];
    if (proposed && proposed !== model.modelId) candidates.push({ provider: model.provider, tier: model.tier, current: model.modelId, proposed, reason: family(proposed) === family(model.modelId) ? 'changed-monitored-family-recommendation' : 'unknown-replacement-family-needs-triage' });
    if (models?.lineup && !models.lineup.includes(model.modelId) && proposed === model.modelId) errors.push(`${model.provider}-models:inconsistent-default:${model.modelId}`);
  }
  const complete = errors.length === 0;
  if (complete) for (const finding of lifecycle.values()) {
    if (!observation.catalog.models.some(model => model.provider === finding.provider && model.modelId === finding.modelId)) finding.resolvedByCatalog = observation.catalog.sha256;
  }
  const recovery = recoveryRequired || previous?.recoveryRequired === true;
  if (recovery) errors.push('authoritative-state-recovery-required:manual-triage');
  const lastSuccess: FreshnessEvidence | null = complete && !recovery ? {
    schemaVersion: 1, parserVersion: FRESHNESS_PARSER_VERSION, catalog: observation.catalog, checkedAt: observation.checkedAt,
    nextCheckDueBy: new Date(Date.parse(observation.checkedAt) + 7 * DAY).toISOString(), run: observation.run,
    sources: observation.sources.map(source => { const { parsed, ...receipt } = source.receipt!; return receipt; }),
  } : previous?.lastSuccess ?? null;
  const evidenceStatus = storedEvidenceStatus(observation.catalog, lastSuccess, observation.checkedAt);
  const unresolved = [...lifecycle.values()].some(finding => !finding.resolvedByCatalog);
  const status: FreshnessStatus = errors.length ? 'unknown/source-unavailable' : unresolved || candidates.length ? 'update-candidate' : evidenceStatus;
  return { schemaVersion: 1, status, evidenceStatus, complete: complete && !recovery, errors, candidates, state: { schemaVersion: 1, latest: { checkedAt: observation.checkedAt, run: observation.run }, lastSuccess, lifecycle: [...lifecycle.values()].sort((a, b) => a.key.localeCompare(b.key)), recoveryRequired: recovery } };
}

export function renderFreshnessReport(report: FreshnessReport): string {
  const evidence = report.state.lastSuccess;
  const lines = [
    `## Model-policy freshness: ${report.status}`, '',
    `Checked observation: ${report.state.latest.checkedAt}; run ${report.state.latest.run.id}/${report.state.latest.run.attempt}.`,
    `Last complete trustworthy check: ${evidence?.checkedAt ?? 'unavailable'}. Next scheduled check due by: ${evidence?.nextCheckDueBy ?? 'unavailable'}.`,
    `Stored evidence status: ${report.evidenceStatus}; trustworthy evidence older than thirty days is stale, independently of the seven-day scheduled due date.`,
    'The seven-day due date is a manual-check mitigation, not automatic liveness monitoring. If GitHub never runs this job, it cannot alert on its own absence.',
    'Public API recommendations only; this does not certify account entitlement, quality superiority, CLI compatibility, or Bedrock/Vertex/custom endpoint availability.', '',
  ];
  for (const error of report.errors) lines.push(`- Source/recovery finding: ${error}. Triage within seven days; manually check the named official source and the last successful workflow date.`);
  for (const candidate of report.candidates) lines.push(`- Candidate (${candidate.provider}/${candidate.tier}): ${candidate.current} → ${candidate.proposed}; ${candidate.reason}. Review within thirty days; qualify a reviewed catalog PR or record a retain decision.`);
  for (const finding of report.state.lifecycle.filter(finding => !finding.resolvedByCatalog)) lines.push(`- ${finding.state === 'legacy' ? 'Lifecycle triage' : 'URGENT'}: ${finding.modelId} is ${finding.state}; removal deadline ${finding.deadline ?? 'not announced'}. Source: ${finding.sourceUrl}. ${finding.state === 'legacy' ? 'Review within thirty days; legacy does not announce retirement.' : 'Triage within one working day and qualify or explicitly mitigate before removal; already-removed defaults remain unresolved.'}`);
  lines.push('', 'No catalog updates, pin rewrites, model switches, or paid evaluations are performed. Candidate qualification requires separate budget approval and pinned baseline/candidate inputs.', 'Manual recovery: docs/troubleshooting.md#model-policy-freshness. Preserve lifecycle history and dispositions when repairing the owned state; unresolved lifecycle findings cannot be cleared by a failed fetch.', '', '### Official source receipts');
  for (const receipt of evidence?.sources ?? []) lines.push(`- ${receipt.id}: ${receipt.url}; SHA-256 ${receipt.sha256}; ${receipt.bytes} bytes.`);
  return lines.join('\n');
}
