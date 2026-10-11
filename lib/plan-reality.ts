/**
 * plan-reality — the reality rows every plan review must carry (multi-agent
 * wave D1, release promise P5). One table owns the rows: the resolver
 * scripts/resolvers/plan-reality.ts renders them into the plan-review
 * templates, bin/gstack-plan-reality prints them at run time and checks a
 * review for them, and the tests pin the row ids and the line grammar.
 *
 * A review emits one grep-able line per row:
 *
 *   REALITY: <row-id> <pass|finding|n/a> <summary carrying a receipt>
 *
 * A receipt is `path:line`, `path:line-line` or a commit sha; a row without one
 * is not a row. Tier 1 rows are required in every review. Tier 2 rows are
 * required only when the review's detected scope (the manifest `scope` field
 * from plan B4, passed to the checker as `--scope`) names theirs; otherwise
 * they may be omitted or marked `n/a`. A tier 1 row marked `n/a` is missing.
 *
 * `checkRealityRows` is deterministic and returns the missing rows; the
 * session kind decides what a miss means (unattended: the phase is
 * `incomplete`; interactive: repair twice, then warn at the gate). The row
 * table carries each row's incident, so the deep section can say why the row
 * exists without a second table drifting.
 */

export const REALITY_SCOPES = ['always', 'db', 'perf', 'search', 'incident', 'dependency'] as const;
export type RealityScope = typeof REALITY_SCOPES[number];
export const REALITY_STATUSES = ['pass', 'finding', 'n/a'] as const;
export type RealityStatus = typeof REALITY_STATUSES[number];

export interface RealityRow {
  id: string;
  title: string;
  tier: 1 | 2;
  /** `always` for tier 1; the scope signal a tier 2 row needs. */
  scope: RealityScope;
  /** The operative check, one line, imperative. */
  check: string;
  /** The incident in the gbrain feedback that earned the row, one line. */
  incident: string;
  /** Optional `key=value` the line must carry (scored in the Completion Summary). */
  metric?: string;
}

export const REALITY_ROWS: readonly RealityRow[] = [
  {
    id: 'premise-table', title: 'Premise table', tier: 1, scope: 'always',
    check: '`premise | claim | file:line receipt | verdict` for every factual claim; no receipt means `unverified`, and `unverified=<n>` is scored in the Completion Summary.',
    incident: 'A wave rested on "13 of 28 threads ran nothing" with no per-thread evidence; the first table found 1 FALSE and 3 UNVERIFIED claims in 27.',
    metric: 'unverified',
  },
  {
    id: 'already-done', title: 'Already done', tier: 1, scope: 'always',
    check: '`git fetch origin <base>`, then `git log origin/<base> --since=<ask date> -- <named files>` and `--grep <symbols>`; report a hit before any task is written.',
    incident: 'A fix was re-planned and rebuilt the day after main merged it; nobody read the base log.',
  },
  {
    id: 'surface-check', title: 'Surface check', tier: 1, scope: 'always',
    check: 'Every named CLI command, flag or HTTP route verified against the registry or `--help`; a miss is a finding.',
    incident: 'The installer relied on `bun upgrade --version`; `bun upgrade --help` on the target listed only `--canary`.',
  },
  {
    id: 'binding-decisions', title: 'Binding decisions', tier: 1, scope: 'always',
    check: 'Read `gstack-decision-search --scope branch --recent 50` and the plan\'s `## Binding decisions`; they outrank project defaults and CLAUDE.md, and a reintroduced overruled default is a finding.',
    incident: 'An owner decision taken mid-review was undone two phases later by the project default it had replaced.',
  },
  {
    id: 'numbers', title: 'Numbers', tier: 1, scope: 'always',
    check: 'Every number re-derived from raw data and tagged `[measured: <source>]` or `[estimated]`; a cited baseline is `[re-measure before gate]`.',
    incident: 'An effort table with no basis was credited until a reviewer re-counted it; quoted parity ratios were off by two decimals.',
  },
  {
    id: 'deferred-asks', title: 'Deferred asks', tier: 1, scope: 'always',
    check: 'The linked issue\'s requests the plan leaves out, each with its reason, listed in the gate template.',
    incident: 'An issue asked for six things; the plan shipped four and the owner found the other two after merge.',
  },
  {
    id: 'pr-count', title: 'PR count', tier: 1, scope: 'always',
    check: '`pr_count` from `.gstack/ship-policy.json` (default one PR per wave); a split shows the queue cost per extra PR and checks user-facing references across it.',
    incident: 'A five-PR wave became seven in the Eng phase; the cost of each extra gate had never been stated.',
  },
  {
    id: 'prior-art', title: 'Prior art', tier: 2, scope: 'dependency',
    check: 'For a vendored or patched dependency or a known library behavior: search the upstream tracker and open PRs; record `adopt <link>` or `diverge because <reason>`.',
    incident: 'A patched vendored hunk was dropped on upgrade because nobody had recorded why the fork diverged.',
  },
  {
    id: 'transaction-semantics', title: 'Transaction semantics', tier: 2, scope: 'db',
    check: 'For a driver, pool or protocol change: the surrounding transaction on idle, pooled and reserved connections; crash robot rerun after the change.',
    incident: 'A pool change ended transactions on idle connections; the crash robot was not rerun.',
  },
  {
    id: 'contract-assumptions', title: 'Contract assumptions', tier: 2, scope: 'dependency',
    check: 'One row per default or flag assumed from another repo, rechecked against merged code before the next stage.',
    incident: 'A sibling repo\'s default changed between planning and build; the plan still assumed the old flag.',
  },
  {
    id: 'falsification-box', title: 'Falsification box', tier: 2, scope: 'incident',
    check: 'Top hypothesis, the evidence that kills it, a time box, and the action in each branch.',
    incident: 'An outage plan chased its first hypothesis for a day with nothing stated that would have killed it.',
  },
  {
    id: 'stop-reasons', title: 'Stop reasons', tier: 2, scope: 'incident',
    check: 'Every new stop reason, hold code and progress line names the test that triggers it.',
    incident: 'A hold code shipped with no test that could produce it; it first fired in production.',
  },
  {
    id: 'reporter-environment', title: 'Reporter environment', tier: 2, scope: 'incident',
    check: 'A repro that does not match the reporter\'s environment is `class not confirmed`, never `ruled out`.',
    incident: 'A bug was "ruled out" on a different runtime than the reporter\'s; the reporter still had it.',
  },
  {
    id: 'units', title: 'Units', tier: 2, scope: 'perf',
    check: 'A change to an input\'s units or accuracy lists every threshold that consumes it and shows the re-tune.',
    incident: 'A timing input moved from ms to s; three downstream thresholds kept their numbers.',
  },
  {
    id: 'perf-table', title: 'Perf table', tier: 2, scope: 'perf',
    check: 'Machine, engine, data size, N, p50/p95, statistics state, base and branch interleaved, pathological and steady-state cases, `reproduced on main?`.',
    incident: 'A speedup came from one warm-cache run with no base comparison; main was as fast.',
  },
  {
    id: 'recall', title: 'Recall', tier: 2, scope: 'search',
    check: 'A search or query-plan change reports recall against exact search across scope buckets.',
    incident: 'A query-plan change sped up the hot path and dropped recall on the smallest bucket.',
  },
  {
    id: 'dependency-fallback', title: 'Dependency fallback', tier: 2, scope: 'dependency',
    check: 'What ships without each predecessor, and by when.',
    incident: 'A stacked PR waited on a predecessor that never merged; nothing said what it could ship alone.',
  },
  {
    id: 'obligation-tiers', title: 'Obligation tiers', tier: 2, scope: 'dependency',
    check: 'Must-ship, next PR, deferred, under a stated size budget; the ledger status column carries the tier.',
    incident: 'A PR outgrew review because every accepted finding was treated as must-ship.',
  },
];

export const TIER1_ROW_IDS: readonly string[] = REALITY_ROWS.filter(r => r.tier === 1).map(r => r.id);

export function rowById(id: string): RealityRow | undefined {
  return REALITY_ROWS.find(r => r.id === id);
}

/** Rows a review must carry for the given scopes: tier 1 always, tier 2 when its scope is detected. */
export function requiredRows(scopes: readonly string[]): RealityRow[] {
  return REALITY_ROWS.filter(r => r.tier === 1 || scopes.includes(r.scope));
}

export function parseScopes(csv: string | undefined): { scopes: RealityScope[]; unknown: string[] } {
  const scopes: RealityScope[] = [];
  const unknown: string[] = [];
  for (const raw of (csv ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    if ((REALITY_SCOPES as readonly string[]).includes(raw)) scopes.push(raw as RealityScope);
    else unknown.push(raw);
  }
  return { scopes, unknown };
}

/** `path:line`, `path:line-line` (the path has a letter and no spaces) or a 7–40 hex sha. */
export const RECEIPT_RE = /(?:(?<![\w./-])[A-Za-z~$][\w./~$@-]*:\d+(?:-\d+)?)|(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/;
export const REALITY_LINE_RE = /^\s*(?:[-*>|]\s*)?`?REALITY:\s+(?<id>[a-z][a-z0-9-]*)\s+(?<status>pass|finding|n\/a)\b(?<rest>.*)$/;

export interface RealityLine { id: string; status: RealityStatus; rest: string; receipt: string | null; line: number; metrics: Record<string, string> }

export function parseRealityLines(text: string): RealityLine[] {
  const out: RealityLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = REALITY_LINE_RE.exec(raw);
    if (!m?.groups) return;
    const rest = m.groups.rest!.replace(/`\s*$/, '').trim();
    const receipt = RECEIPT_RE.exec(rest)?.[0] ?? null;
    const metrics: Record<string, string> = {};
    for (const kv of rest.matchAll(/\b([a-z_]+)=([^\s,;|]+)/g)) metrics[kv[1]!] = kv[2]!;
    out.push({ id: m.groups.id!, status: m.groups.status as RealityStatus, rest, receipt, line: i + 1, metrics });
  });
  return out;
}

export type RealityVerdict = 'complete' | 'incomplete' | 'repair';
export interface RealityCheck {
  phase: string;
  required: string[];
  present: string[];
  /** Required rows with no line, or a tier 1 row marked n/a. */
  missing: string[];
  /** Required rows whose line carries no receipt. */
  unreceipted: string[];
  /** Lines naming a row id the table does not define. */
  unknownRows: string[];
  metrics: Record<string, string>;
  verdict: RealityVerdict;
  line: string;
}

export interface CheckOptions { phase: string; scopes?: readonly string[]; sessionKind?: string }

/** Deterministic: which required rows the review carries. The verdict word depends on the session kind only. */
export function checkRealityRows(reviewText: string, o: CheckOptions): RealityCheck {
  const required = requiredRows(o.scopes ?? []).map(r => r.id);
  const lines = parseRealityLines(reviewText);
  const byId = new Map<string, RealityLine>();
  const unknownRows: string[] = [];
  for (const l of lines) {
    if (!rowById(l.id)) { if (!unknownRows.includes(l.id)) unknownRows.push(l.id); continue; }
    if (!byId.has(l.id) || (byId.get(l.id)!.status === 'n/a' && l.status !== 'n/a')) byId.set(l.id, l);
  }
  const present: string[] = [], missing: string[] = [], unreceipted: string[] = [];
  const metrics: Record<string, string> = {};
  for (const id of required) {
    const l = byId.get(id);
    if (!l || l.status === 'n/a') { missing.push(id); continue; }
    if (!l.receipt) { unreceipted.push(id); continue; }
    present.push(id);
    const metric = rowById(id)!.metric;
    if (metric && l.metrics[metric] !== undefined) metrics[metric] = l.metrics[metric]!;
  }
  const ok = missing.length === 0 && unreceipted.length === 0;
  const verdict: RealityVerdict = ok ? 'complete' : o.sessionKind === 'unattended' ? 'incomplete' : 'repair';
  const parts = [`PLAN_REALITY: phase=${o.phase}`, `rows=${present.length}/${required.length}`,
    `missing=${missing.length ? missing.join(',') : 'none'}`];
  if (unreceipted.length) parts.push(`unreceipted=${unreceipted.join(',')}`);
  for (const [k, v] of Object.entries(metrics)) parts.push(`${k}=${v}`);
  parts.push(`verdict=${verdict}`);
  return { phase: o.phase, required, present, missing, unreceipted, unknownRows, metrics, verdict, line: parts.join(' ') };
}

/** The example line every template quotes; one grammar, stated once. */
export const REALITY_LINE_SHAPE = 'REALITY: <row> pass|finding|n/a <summary> <file:line>';

/** The operative rows as the bin prints them (`deep` adds each row's incident). */
export function renderRows(rows: readonly RealityRow[], o: { deep: boolean }): string {
  return rows.map(r => `- ${r.id} (tier ${r.tier}${r.scope === 'always' ? '' : `, scope ${r.scope}`}): ${r.check}${o.deep ? `\n  Incident: ${r.incident}` : ''}`).join('\n');
}

/** The deep-section table: why each row exists. The check itself is what `rows` prints. */
export function renderIncidentTable(rows: readonly RealityRow[]): string {
  const head = '| Row | Tier | Scope | Incident that earned it |\n|---|---|---|---|';
  return [head, ...rows.map(r => `| \`${r.id}\` | ${r.tier} | ${r.scope} | ${r.incident.replace(/\|/g, '\\|')} |`)].join('\n');
}
