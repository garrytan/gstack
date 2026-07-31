import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { PATTERNS } from '../../lib/redact-patterns';

export const LENS_EVENT_TYPES = [
  'lens_run',
  'finding',
  'disposition',
  'validation',
  'routing_feedback',
  'outcome',
  'insufficient_evidence',
  'malformed_output',
  'synthesis',
] as const;
export type LensEventType = (typeof LENS_EVENT_TYPES)[number];

export interface LensEvent {
  event: LensEventType;
  ts?: string;
  [key: string]: unknown;
}

export interface AppendEventOptions {
  gstackHome?: string;
  slug?: string;
  retentionDays?: number;
  now?: Date;
}

function sanitizeSlug(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '') || 'unknown';
}

export function projectSlug(repoRoot: string): string {
  if (process.env.GSTACK_PROJECT_SLUG) return sanitizeSlug(process.env.GSTACK_PROJECT_SLUG);
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' });
  if (remote.status === 0 && remote.stdout.trim()) {
    const raw = remote.stdout.trim().replace(/\.git$/, '');
    const match = raw.match(/[:/]([^/:]+\/[^/]+)$/);
    if (match) return sanitizeSlug(match[1].replace('/', '-'));
  }
  return sanitizeSlug(path.basename(repoRoot));
}

function configuredRetentionDays(gstackHome: string): number {
  const configPath = path.join(gstackHome, 'config.yaml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/^lens_events_retention_days:\s*(\d+)\s*$/m);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return 365;
}

function replacePattern(input: string, pattern: RegExp): string {
  const flags = [...new Set(`${pattern.flags}gm`.split(''))].join('');
  const regex = new RegExp(pattern.source, flags);
  return input.replace(regex, (...args: any[]) => {
    const full = String(args[0]);
    const groups = args.slice(1, -2).filter((value) => typeof value === 'string' && value.length > 0) as string[];
    const span = groups[0] ?? full;
    return full.replace(span, '[REDACTED_SECRET]');
  });
}

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of PATTERNS.filter((entry) => entry.category === 'secret')) {
    output = replacePattern(output, pattern.regex);
  }
  return output;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitizeValue(child);
    }
    return output;
  }
  return value;
}

export function sanitizeLensEvent(event: LensEvent): LensEvent {
  return sanitizeValue(event) as LensEvent;
}

export function lensEventPath(repoRoot: string, options: AppendEventOptions = {}): string {
  const gstackHome = options.gstackHome ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack');
  const slug = options.slug ?? projectSlug(repoRoot);
  return path.join(gstackHome, 'projects', sanitizeSlug(slug), 'lens-events.jsonl');
}

function ensureSecureFile(filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (!fs.existsSync(filePath)) {
    const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

function eventTimestamp(event: Record<string, unknown>): number | null {
  if (typeof event.ts !== 'string') return null;
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : null;
}

export function applyRetention(filePath: string, retentionDays: number, now = new Date()): number {
  if (!fs.existsSync(filePath)) return 0;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const retained: string[] = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const timestamp = eventTimestamp(event);
      if (timestamp !== null && timestamp < cutoff) {
        removed += 1;
        continue;
      }
    } catch {
      // Keep malformed historical lines. Retention must not destroy evidence it
      // cannot classify; stats will surface them as parse errors.
    }
    retained.push(line);
  }
  if (removed > 0) {
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, retained.length ? `${retained.join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  }
  return removed;
}

export function validateLensEvent(event: LensEvent): LensEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Lens event must be a JSON object');
  if (!LENS_EVENT_TYPES.includes(event.event)) {
    throw new Error(`Unknown lens event type '${String(event.event)}'`);
  }
  if (event.ts !== undefined && (typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)))) {
    throw new Error('Lens event ts must be an ISO-compatible datetime string');
  }
  if (event.event === 'finding' && typeof event.finding_id !== 'string') throw new Error('finding event requires finding_id');
  if (['disposition', 'validation', 'outcome'].includes(event.event) && typeof event.finding_id !== 'string') {
    throw new Error(`${event.event} event requires finding_id`);
  }
  if (event.event === 'lens_run' && typeof event.run_id !== 'string') throw new Error('lens_run event requires run_id');
  if (event.event === 'synthesis' && typeof event.run_id !== 'string') throw new Error('synthesis event requires run_id');
  return sanitizeLensEvent(event);
}

export function appendLensEvent(repoRoot: string, input: LensEvent, options: AppendEventOptions = {}): { path: string; event: LensEvent; retention_removed: number } {
  const now = options.now ?? new Date();
  const event = validateLensEvent({ ...input, ts: input.ts ?? now.toISOString() });
  const filePath = lensEventPath(repoRoot, options);
  ensureSecureFile(filePath);
  const retentionDays = options.retentionDays ?? configuredRetentionDays(options.gstackHome ?? process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack'));
  const removed = applyRetention(filePath, retentionDays, now);
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return { path: filePath, event, retention_removed: removed };
}

export interface LensStats {
  parse_errors: number;
  runs: Record<string, { invocations: number; total_wall_clock_ms: number; total_cost_usd: number; cost_samples: number; insufficient_evidence: number }>;
  findings: Record<string, { total: number; blocking: number; material: number; advisory: number; novel_vs_tech: number; confirmed_validity: number }>;
  dispositions: Record<string, number>;
  outcomes: Record<string, number>;
}

export function readLensEvents(filePath: string): { events: LensEvent[]; parse_errors: number } {
  if (!fs.existsSync(filePath)) return { events: [], parse_errors: 0 };
  const events: LensEvent[] = [];
  let parseErrors = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return { events, parse_errors: parseErrors };
}

export function computeLensStats(events: LensEvent[], parseErrors = 0): LensStats {
  const stats: LensStats = { parse_errors: parseErrors, runs: {}, findings: {}, dispositions: {}, outcomes: {} };
  const findingLens = new Map<string, string>();
  for (const event of events) {
    if (event.event === 'lens_run') {
      const lenses = Array.isArray(event.lenses_dispatched) ? event.lenses_dispatched.filter((x): x is string => typeof x === 'string') : [];
      for (const lens of lenses) {
        const row = stats.runs[lens] ?? { invocations: 0, total_wall_clock_ms: 0, total_cost_usd: 0, cost_samples: 0, insufficient_evidence: 0 };
        row.invocations += 1;
        if (event.wall_clock_ms && typeof event.wall_clock_ms === 'object' && !Array.isArray(event.wall_clock_ms)) {
          const value = (event.wall_clock_ms as Record<string, unknown>)[lens];
          if (typeof value === 'number') row.total_wall_clock_ms += value;
        }
        if (typeof event.cost_estimate_usd === 'number') {
          row.total_cost_usd += event.cost_estimate_usd / Math.max(lenses.length, 1);
          row.cost_samples += 1;
        }
        stats.runs[lens] = row;
      }
    } else if (event.event === 'finding') {
      const lens = typeof event.lens === 'string' ? event.lens : 'unknown';
      if (typeof event.finding_id === 'string') findingLens.set(event.finding_id, lens);
      const row = stats.findings[lens] ?? { total: 0, blocking: 0, material: 0, advisory: 0, novel_vs_tech: 0, confirmed_validity: 0 };
      row.total += 1;
      if (event.decision_impact === 'BLOCKING') row.blocking += 1;
      if (event.decision_impact === 'MATERIAL') row.material += 1;
      if (event.decision_impact === 'ADVISORY') row.advisory += 1;
      if (event.novelty_vs_tech_review === 'NOVEL') row.novel_vs_tech += 1;
      stats.findings[lens] = row;
    } else if (event.event === 'insufficient_evidence') {
      const lens = typeof event.lens === 'string' ? event.lens : 'unknown';
      const row = stats.runs[lens] ?? { invocations: 0, total_wall_clock_ms: 0, total_cost_usd: 0, cost_samples: 0, insufficient_evidence: 0 };
      row.insufficient_evidence += 1;
      stats.runs[lens] = row;
    } else if (event.event === 'disposition') {
      const decision = typeof event.decision === 'string' ? event.decision : 'unknown';
      stats.dispositions[decision] = (stats.dispositions[decision] ?? 0) + 1;
    } else if (event.event === 'validation') {
      if (event.validity === 'confirmed' && typeof event.finding_id === 'string') {
        const lens = findingLens.get(event.finding_id) ?? 'unknown';
        const row = stats.findings[lens] ?? { total: 0, blocking: 0, material: 0, advisory: 0, novel_vs_tech: 0, confirmed_validity: 0 };
        row.confirmed_validity += 1;
        stats.findings[lens] = row;
      }
    } else if (event.event === 'outcome') {
      const outcome = typeof event.outcome === 'string' ? event.outcome : 'unknown';
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
    }
  }
  return stats;
}
