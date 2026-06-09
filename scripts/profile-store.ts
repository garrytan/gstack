/**
 * scripts/profile-store.ts — pure helpers for the unified developer profile
 * store (~/.gstack/developer-profile.json).
 *
 * Consumed by bin/gstack-developer-profile (migrate / reconcile / append-session
 * / append-resources) and unit-tested in test/profile-store.test.ts.
 *
 * Design note: /office-hours persists session state by calling
 * `gstack-developer-profile --append-session` / `--append-resources`, which write
 * THROUGH to the same developer-profile.json the read path consumes. The old skill
 * appended raw JSONL to builder-profile.jsonl, which the read path migrated away
 * and never re-read — freezing every returning user's state at session 1. These
 * helpers keep one source of truth and recover orphaned legacy appends.
 */

export interface Session {
  date?: string;
  mode?: string;
  project_slug?: string;
  signal_count?: number;
  signals?: string[];
  design_doc?: string;
  design_title?: string;
  assignment?: string;
  resources_shown?: string[];
  topics?: string[];
  [k: string]: unknown;
}

export interface Profile {
  sessions: Session[];
  signals_accumulated: Record<string, number>;
  resources_shown: string[];
  topics: string[];
  [k: string]: unknown;
}

/** A "resources" row records which founder resources were shown; it is NOT a
 *  session and must never count toward SESSION_COUNT / TIER. */
export const isResourcesRow = (e: Session): boolean => !!e && e.mode === 'resources';

export function emptyProfile(): Profile {
  return {
    identity: {},
    declared: {},
    inferred: {
      values: {
        scope_appetite: 0.5,
        risk_tolerance: 0.5,
        detail_preference: 0.5,
        autonomy: 0.5,
        architecture_care: 0.5,
      },
      sample_size: 0,
      diversity: { skills_covered: 0, question_ids_covered: 0, days_span: 0 },
    },
    gap: {},
    overrides: {},
    sessions: [],
    signals_accumulated: {},
    resources_shown: [],
    topics: [],
    schema_version: 1,
  };
}

function uniq(arr: unknown[]): string[] {
  return Array.from(new Set(arr.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

/** Recompute derived aggregates from sessions[], preserving (never shrinking)
 *  top-level resources_shown / topics that came from --append-resources. */
export function recompute(profile: Profile): Profile {
  const signals: Record<string, number> = {};
  const resources: string[] = [...(profile.resources_shown || [])];
  const topics: string[] = [...(profile.topics || [])];
  for (const e of profile.sessions || []) {
    for (const s of e.signals || []) signals[s] = (signals[s] || 0) + 1;
    for (const r of e.resources_shown || []) resources.push(r);
    for (const t of e.topics || []) topics.push(t);
  }
  profile.signals_accumulated = signals;
  profile.resources_shown = uniq(resources);
  profile.topics = uniq(topics);
  return profile;
}

export function appendSession(profile: Profile, entry: Session): Profile {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('append-session: entry must be a JSON object');
  }
  if (!entry.date) entry.date = new Date().toISOString();
  profile.sessions = profile.sessions || [];
  profile.sessions.push(entry);
  return recompute(profile);
}

export function mergeResources(
  profile: Profile,
  entry: { resources_shown?: string[]; topics?: string[] },
): Profile {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('append-resources: entry must be a JSON object');
  }
  profile.resources_shown = uniq([...(profile.resources_shown || []), ...(entry.resources_shown || [])]);
  profile.topics = uniq([...(profile.topics || []), ...(entry.topics || [])]);
  return profile;
}

/** Stable identity for dedup when reconciling orphaned legacy lines. */
function sig(e: Session): string {
  return JSON.stringify([e.date || '', e.mode || '', e.project_slug || '', e.assignment || '', e.design_doc || '']);
}

/** Parse legacy jsonl lines into sessions + merged resources/topics.
 *  `dropped` counts unparseable lines so callers can warn instead of silently losing data. */
export function parseLegacy(lines: string[]): {
  sessions: Session[];
  resources: string[];
  topics: string[];
  dropped: number;
} {
  const sessions: Session[] = [];
  const resources: string[] = [];
  const topics: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Session;
    try {
      e = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    for (const r of e.resources_shown || []) resources.push(r);
    for (const t of e.topics || []) topics.push(t);
    if (!isResourcesRow(e)) sessions.push(e);
  }
  return { sessions, resources, topics, dropped };
}

/** Build a fresh profile from legacy jsonl lines (used by --migrate). */
export function migrateLegacy(lines: string[]): { profile: Profile; dropped: number } {
  const { sessions, resources, topics, dropped } = parseLegacy(lines);
  const profile = emptyProfile();
  profile.sessions = sessions;
  profile.resources_shown = resources;
  profile.topics = topics;
  return { profile: recompute(profile), dropped };
}

/** Fold orphaned legacy lines into an existing profile (used by reconcile),
 *  skipping sessions already present (dedup by signature). */
export function foldLegacy(
  profile: Profile,
  lines: string[],
): { profile: Profile; dropped: number; added: number } {
  const { sessions, resources, topics, dropped } = parseLegacy(lines);
  profile.sessions = profile.sessions || [];
  const seen = new Set(profile.sessions.map(sig));
  let added = 0;
  for (const e of sessions) {
    const k = sig(e);
    if (seen.has(k)) continue;
    seen.add(k);
    profile.sessions.push(e);
    added++;
  }
  profile.resources_shown = uniq([...(profile.resources_shown || []), ...resources]);
  profile.topics = uniq([...(profile.topics || []), ...topics]);
  return { profile: recompute(profile), dropped, added };
}

/** Sessions that count toward tier/journey (excludes resource-tracking rows). */
export function realSessions(profile: Profile): Session[] {
  return (profile.sessions || []).filter((e) => !isResourcesRow(e));
}

/** Human-facing design title: explicit title, else doc basename, else slug. */
export function designTitle(e: Session): string {
  if (e.design_title) return String(e.design_title);
  if (e.design_doc) return String(e.design_doc).split('/').pop() || '';
  return e.project_slug ? String(e.project_slug) : '';
}
