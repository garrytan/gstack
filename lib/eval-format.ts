/**
 * Standard eval result format — validation and normalization.
 *
 * Superset of the legacy EvalResult from test/helpers/eval-store.ts.
 * Any language can produce a JSON file matching StandardEvalResult and
 * push it through `gstack eval push`.
 */

import type { EvalResult, EvalTestEntry } from '../test/helpers/eval-store';

// --- Interfaces ---

export interface CostEntry {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Exact cost from API when available (accounts for cache discounts). */
  cost_usd?: number;
}

export interface FailureEntry {
  test_name: string;
  error: string;
  category?: string;
}

export interface ComparisonEntry {
  label: string;
  model: string;
  score: number;
  cost_usd: number;
}

export interface StandardTestEntry {
  name: string;
  suite: string;
  tier: string;
  passed: boolean;
  duration_ms: number;
  cost_usd: number;
  output?: Record<string, unknown>;

  // Optional fields from legacy format
  turns_used?: number;
  exit_reason?: string;
  detection_rate?: number;
  false_positives?: number;
  evidence_quality?: number;
  detected_bugs?: string[];
  missed_bugs?: string[];
  judge_scores?: Record<string, number>;
  judge_reasoning?: string;
  error?: string;
}

export interface StandardEvalResult {
  schema_version: number;
  version: string;
  label?: string;
  git_branch: string;
  git_sha: string;
  timestamp: string;
  hostname: string;
  tier: string;
  total: number;
  passed: number;
  failed: number;
  total_cost_usd: number;
  duration_seconds: number;
  all_results: StandardTestEntry[];
  prompt_sha?: string;
  by_category?: Record<string, { passed: number; failed: number }>;
  costs?: CostEntry[];
  comparison?: ComparisonEntry[];
  failures?: FailureEntry[];
  _partial?: boolean;
}

// --- Validation ---

const REQUIRED_FIELDS: Array<[string, string]> = [
  ['schema_version', 'number'],
  ['version', 'string'],
  ['git_branch', 'string'],
  ['git_sha', 'string'],
  ['timestamp', 'string'],
  ['tier', 'string'],
  ['total', 'number'],
  ['passed', 'number'],
  ['failed', 'number'],
  ['total_cost_usd', 'number'],
  ['duration_seconds', 'number'],
  ['all_results', 'object'], // array check below
];

/**
 * Validate that an unknown value conforms to StandardEvalResult.
 * Returns { valid: true, errors: [] } or { valid: false, errors: [...] }.
 */
export function validateEvalResult(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (data === null || typeof data !== 'object') {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }

  const obj = data as Record<string, unknown>;

  for (const [field, expectedType] of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push(`Missing required field: ${field}`);
    } else if (typeof obj[field] !== expectedType) {
      errors.push(`Field "${field}" must be ${expectedType}, got ${typeof obj[field]}`);
    }
  }

  // all_results must be an array
  if ('all_results' in obj && !Array.isArray(obj.all_results)) {
    errors.push('Field "all_results" must be an array');
  }

  // Validate each test entry minimally
  if (Array.isArray(obj.all_results)) {
    for (let i = 0; i < obj.all_results.length; i++) {
      const entry = obj.all_results[i];
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`all_results[${i}] must be an object`);
        continue;
      }
      if (typeof (entry as Record<string, unknown>).name !== 'string') {
        errors.push(`all_results[${i}].name must be a string`);
      }
      if (typeof (entry as Record<string, unknown>).passed !== 'boolean') {
        errors.push(`all_results[${i}].passed must be a boolean`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Normalization ---

/**
 * Convert legacy EvalResult → StandardEvalResult.
 */
export function normalizeFromLegacy(legacy: EvalResult): StandardEvalResult {
  return {
    schema_version: legacy.schema_version,
    version: legacy.version,
    git_branch: legacy.branch,
    git_sha: legacy.git_sha,
    timestamp: legacy.timestamp,
    hostname: legacy.hostname,
    tier: legacy.tier,
    total: legacy.total_tests,
    passed: legacy.passed,
    failed: legacy.failed,
    total_cost_usd: legacy.total_cost_usd,
    duration_seconds: Math.round(legacy.total_duration_ms / 1000),
    all_results: legacy.tests.map(legacyTestToStandard),
    _partial: legacy._partial,
  };
}

function legacyTestToStandard(t: EvalTestEntry): StandardTestEntry {
  const entry: StandardTestEntry = {
    name: t.name,
    suite: t.suite,
    tier: t.tier,
    passed: t.passed,
    duration_ms: t.duration_ms,
    cost_usd: t.cost_usd,
  };
  if (t.turns_used !== undefined) entry.turns_used = t.turns_used;
  if (t.exit_reason !== undefined) entry.exit_reason = t.exit_reason;
  if (t.detection_rate !== undefined) entry.detection_rate = t.detection_rate;
  if (t.false_positives !== undefined) entry.false_positives = t.false_positives;
  if (t.evidence_quality !== undefined) entry.evidence_quality = t.evidence_quality;
  if (t.detected_bugs) entry.detected_bugs = t.detected_bugs;
  if (t.missed_bugs) entry.missed_bugs = t.missed_bugs;
  if (t.judge_scores) entry.judge_scores = t.judge_scores;
  if (t.judge_reasoning !== undefined) entry.judge_reasoning = t.judge_reasoning;
  if (t.error !== undefined) entry.error = t.error;
  return entry;
}

/**
 * Convert StandardEvalResult → legacy EvalResult for compat with existing compare/list.
 */
export function normalizeToLegacy(standard: StandardEvalResult): EvalResult {
  return {
    schema_version: standard.schema_version,
    version: standard.version,
    branch: standard.git_branch,
    git_sha: standard.git_sha,
    timestamp: standard.timestamp,
    hostname: standard.hostname,
    tier: standard.tier as 'e2e' | 'llm-judge',
    total_tests: standard.total,
    passed: standard.passed,
    failed: standard.failed,
    total_cost_usd: standard.total_cost_usd,
    total_duration_ms: standard.duration_seconds * 1000,
    tests: standard.all_results.map(standardTestToLegacy),
    _partial: standard._partial,
  };
}

function standardTestToLegacy(t: StandardTestEntry): EvalTestEntry {
  const entry: EvalTestEntry = {
    name: t.name,
    suite: t.suite,
    tier: t.tier as 'e2e' | 'llm-judge',
    passed: t.passed,
    duration_ms: t.duration_ms,
    cost_usd: t.cost_usd,
  };
  if (t.turns_used !== undefined) entry.turns_used = t.turns_used;
  if (t.exit_reason !== undefined) entry.exit_reason = t.exit_reason;
  if (t.detection_rate !== undefined) entry.detection_rate = t.detection_rate;
  if (t.false_positives !== undefined) entry.false_positives = t.false_positives;
  if (t.evidence_quality !== undefined) entry.evidence_quality = t.evidence_quality;
  if (t.detected_bugs) entry.detected_bugs = t.detected_bugs;
  if (t.missed_bugs) entry.missed_bugs = t.missed_bugs;
  if (t.judge_scores) entry.judge_scores = t.judge_scores;
  if (t.judge_reasoning !== undefined) entry.judge_reasoning = t.judge_reasoning;
  if (t.error !== undefined) entry.error = t.error;
  return entry;
}
