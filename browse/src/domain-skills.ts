/**
 * Domain skills — per-site notes the agent writes for itself, persisted
 * alongside /learn's per-project learnings as type:"domain" rows.
 *
 * Scope:
 *   - per-project: ~/.gstack/projects/<slug>/learnings.jsonl
 *   - global:      ~/.gstack/global-domain-skills.jsonl
 *
 * State machine (T6 — defense against persistent prompt poisoning):
 *
 *   ┌──────────────┐  N=3 successful uses     ┌────────┐  promote-to-global  ┌────────┐
 *   │ quarantined  │ ─────────────────────▶  │ active │ ──────────────────▶ │ global │
 *   │ (per-project)│  (no classifier flags)   │(project)│  (manual command)   │        │
 *   └──────────────┘                          └────────┘                     └────────┘
 *          ▲                                       │
 *          │  classifier flag during use           │  rollback (version log)
 *          └───────────────────────────────────────┘
 *
 *  - new save → quarantined (does NOT auto-fire in prompts)
 *  - active skills fire in prompts for their project (wrapped in UNTRUSTED)
 *  - global skills fire across all projects (cross-context, requires explicit promote)
 *  - rollback restores prior version by sha256
 *
 * Storage discipline (T5):
 *   - Append-only with O_APPEND (POSIX guarantees atomic appends < PIPE_BUF)
 *   - Tombstone for deletes; idle compactor rewrites file
 *   - Tolerant parser drops partial trailing line on read
 *
 * Hostname rules (T3, CEO-temporal):
 *   - Derived from active tab's top-level origin — NEVER agent-supplied
 *   - Lowercase, strip www., keep full subdomain (subdomain-exact match)
 *   - Punycode hostnames stored as-encoded
 */

import { promises as fs } from 'fs';
import { open as fsOpen, constants as fsConstants } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import type { Page } from 'playwright';

export type SkillState = 'quarantined' | 'active' | 'global';
export type SkillScope = 'project' | 'global';
export type SkillSource = 'agent' | 'human';

export interface DomainSkillRow {
  type: 'domain';
  host: string;
  scope: SkillScope;
  state: SkillState;
  body: string;
  version: number;
  classifier_score: number;
  source: SkillSource;
  sha256: string;
  use_count: number;
  flag_count: number;
  created_ts: string;
  updated_ts: string;
  tombstone?: boolean;
}

const PROMOTE_THRESHOLD = 3;

function gstackHome(): string {
  return process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
}

function globalFile(): string {
  return path.join(gstackHome(), 'global-domain-skills.jsonl');
}

function projectFile(slug: string): string {
  return path.join(gstackHome(), 'projects', slug, 'learnings.jsonl');
}

// ─── Hostname normalization (T3) ──────────────────────────────

export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  // strip protocol if present
  h = h.replace(/^https?:\/\//, '');
  // strip path/query
  h = h.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  // strip port
  h = h.split(':')[0]!;
  // strip www. prefix
  h = h.replace(/^www\./, '');
  return h;
}

/**
 * Derive hostname from the active tab's top-level origin.
 * Closes the confused-deputy bug (Codex T3): agent cannot supply a wrong
 * hostname even if it tried — host is read from the page state we control.
 */
export async function deriveHostFromActiveTab(page: Page): Promise<string> {
  const url = page.url();
  if (!url || url === 'about:blank' || url.startsWith('chrome://')) {
    throw new Error(
      'Cannot save domain-skill: no top-level URL on active tab.\n' +
        'Cause: tab is empty or on chrome:// page.\n' +
        'Action: navigate to the target site first with $B goto <url>.'
    );
  }
  return normalizeHost(url);
}

// ─── File I/O (T5: append-only + flock-free atomic appends) ────

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Append a JSONL row atomically. POSIX guarantees atomicity for writes <
 * PIPE_BUF (typically 4KB) when O_APPEND is set. Each row is single-line JSON
 * well under that bound. fsync ensures durability before return.
 */
async function appendRow(filePath: string, row: DomainSkillRow): Promise<void> {
  await ensureDir(filePath);
  const line = JSON.stringify(row) + '\n';
  return new Promise((resolve, reject) => {
    fsOpen(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o644, (err, fd) => {
      if (err) return reject(err);
      const buf = Buffer.from(line, 'utf8');
      const writeAndSync = () => {
        // Use fs.writeSync via fd to ensure single write call (atomic with O_APPEND).
        const fsSync = require('fs');
        try {
          fsSync.writeSync(fd, buf, 0, buf.length);
          fsSync.fsyncSync(fd);
          fsSync.closeSync(fd);
          resolve();
        } catch (e) {
          try {
            fsSync.closeSync(fd);
          } catch {
            // Ignore close errors after a write failure — original error wins.
          }
          reject(e);
        }
      };
      writeAndSync();
    });
  });
}

/**
 * Read all rows from a JSONL file. Tolerant of partial trailing line (drops it).
 * Returns rows in append order. Caller resolves latest-wins per (host, scope).
 */
async function readRows(filePath: string): Promise<DomainSkillRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows: DomainSkillRow[] = [];
  const lines = raw.split('\n');
  // Last line is empty (trailing newline) OR partial. Drop unconditionally if no parse.
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'domain') rows.push(parsed as DomainSkillRow);
    } catch {
      // Partial-line corruption tolerated. Compactor will clean up.
    }
  }
  return rows;
}

// ─── Latest-wins resolution ────────────────────────────────────

interface SkillKey {
  host: string;
  scope: SkillScope;
}

function keyOf(row: DomainSkillRow): string {
  return `${row.scope}::${row.host}`;
}

/**
 * Reduce a row stream to latest-version-wins per (host, scope).
 * Tombstones win (deleted skill stays deleted).
 */
function resolveLatest(rows: DomainSkillRow[]): Map<string, DomainSkillRow> {
  const m = new Map<string, DomainSkillRow>();
  for (const row of rows) {
    const k = keyOf(row);
    const prior = m.get(k);
    if (!prior || row.version >= prior.version) {
      m.set(k, row);
    }
  }
  // Drop tombstoned entries from the result map for readers; rollback uses raw history.
  for (const [k, row] of m) {
    if (row.tombstone) m.delete(k);
  }
  return m;
}

// ─── Public API ────────────────────────────────────────────────

export interface ReadSkillResult {
  row: DomainSkillRow;
  source: 'project' | 'global';
}

/**
 * Read the active or global skill for a host visible to a given project.
 * Project-scoped active skills shadow global skills for the same host.
 * Quarantined skills are NEVER returned (they don't fire).
 */
export async function readSkill(host: string, projectSlug: string): Promise<ReadSkillResult | null> {
  const normalized = normalizeHost(host);
  // Project layer first
  const projectRows = await readRows(projectFile(projectSlug));
  const projectLatest = resolveLatest(projectRows);
  const projectHit = projectLatest.get(`project::${normalized}`);
  if (projectHit && projectHit.state === 'active') {
    return { row: projectHit, source: 'project' };
  }
  // Global layer fallback
  const globalRows = await readRows(globalFile());
  const globalLatest = resolveLatest(globalRows);
  const globalHit = globalLatest.get(`global::${normalized}`);
  if (globalHit && globalHit.state === 'global') {
    return { row: globalHit, source: 'global' };
  }
  return null;
}

export interface WriteSkillInput {
  host: string;
  body: string; // markdown frontmatter + content
  projectSlug: string;
  source: SkillSource;
  classifierScore: number; // 0..1; caller invokes classifier before calling this
}

/**
 * Save a new skill (always quarantined initially per T6).
 * Caller MUST run the classifier first and pass classifierScore.
 * Score >= 0.85 should fail-fast at caller, never reach here.
 */
export async function writeSkill(input: WriteSkillInput): Promise<DomainSkillRow> {
  if (input.classifierScore >= 0.85) {
    throw new Error(
      `Save blocked: classifier flagged content as potential injection (score: ${input.classifierScore.toFixed(2)}).\n` +
        'Cause: skill body contains patterns the L4 classifier marks as risky.\n' +
        'Action: rewrite the skill content removing instruction-like prose, retry.'
    );
  }
  const normalized = normalizeHost(input.host);
  const body = input.body;
  const now = new Date().toISOString();
  const sha = createHash('sha256').update(body, 'utf8').digest('hex');
  // Determine prior version for this (host, scope=project) so version counter increments.
  const projectRows = await readRows(projectFile(input.projectSlug));
  const projectLatest = resolveLatest(projectRows);
  const prior = projectLatest.get(`project::${normalized}`);
  const version = prior ? prior.version + 1 : 1;
  const row: DomainSkillRow = {
    type: 'domain',
    host: normalized,
    scope: 'project',
    state: 'quarantined',
    body,
    version,
    classifier_score: input.classifierScore,
    source: input.source,
    sha256: sha,
    use_count: 0,
    flag_count: 0,
    created_ts: prior?.created_ts ?? now,
    updated_ts: now,
  };
  await appendRow(projectFile(input.projectSlug), row);
  return row;
}

/**
 * Promote a quarantined skill to active in its project after N=3 uses without
 * classifier flagging. Called by sidebar-agent on successful skill use.
 *
 * Auto-promote logic:
 *   - increment use_count
 *   - if use_count >= PROMOTE_THRESHOLD AND flag_count == 0 AND L4 has scored
 *     the body (classifier_score > 0) → state:active
 *   - else stay quarantined with updated counter; user must run
 *     `domain-skill promote-to-global` manually
 *
 * The classifier_score > 0 gate is load-bearing: handleSave currently writes
 * classifier_score=0 with the comment "L4 deferred to load-time / sidebar-agent
 * fills this in on first prompt-injection load," but sidebar-agent was ripped
 * (CLAUDE.md "Sidebar architecture") and nothing else updates the score, so
 * skills authored via the production path never had their body scanned by L4.
 * Without this gate, three benign uses promote any quarantined skill — including
 * one written under the influence of a poisoned page — into the prompt context
 * for every subsequent visit. The gate re-opens automatically the day L4 is
 * rewired and writeSkill / recordSkillUse start receiving non-zero scores.
 */
export async function recordSkillUse(host: string, projectSlug: string, classifierFlagged: boolean): Promise<DomainSkillRow | null> {
  const normalized = normalizeHost(host);
  const rows = await readRows(projectFile(projectSlug));
  const latest = resolveLatest(rows);
  const current = latest.get(`project::${normalized}`);
  if (!current) return null;
  const useCount = current.use_count + 1;
  const flagCount = current.flag_count + (classifierFlagged ? 1 : 0);
  let state: SkillState = current.state;
  if (
    state === 'quarantined' &&
    useCount >= PROMOTE_THRESHOLD &&
    flagCount === 0 &&
    current.classifier_score > 0
  ) {
    state = 'active';
  }
  const updated: DomainSkillRow = {
    ...current,
    state,
    use_count: useCount,
    flag_count: flagCount,
    version: current.version + 1,
    updated_ts: new Date().toISOString(),
  };
  await appendRow(projectFile(projectSlug), updated);
  return updated;
}

/**
 * Promote an active per-project skill to global. Explicit operator call only —
 * never auto-promoted across project boundaries (T4).
 */
export async function promoteToGlobal(host: string, projectSlug: string): Promise<DomainSkillRow> {
  const normalized = normalizeHost(host);
  const rows = await readRows(projectFile(projectSlug));
  const latest = resolveLatest(rows);
  const current = latest.get(`project::${normalized}`);
  if (!current) {
    throw new Error(
      `Cannot promote: no skill for ${normalized} in project ${projectSlug}.\n` +
        'Cause: skill does not exist or is tombstoned.\n' +
        'Action: $B domain-skill list to see what exists in this project.'
    );
  }
  if (current.state !== 'active') {
    throw new Error(
      `Cannot promote: skill for ${normalized} is in state "${current.state}", expected "active".\n` +
        `Cause: skill must be active in this project (used ${PROMOTE_THRESHOLD}+ times without flag) before global promotion.\n` +
        'Action: use the skill in this project until it auto-promotes to active.'
    );
  }
  const now = new Date().toISOString();
  const globalRow: DomainSkillRow = {
    ...current,
    scope: 'global',
    state: 'global',
    version: 1, // global file has its own version line
    use_count: 0,
    flag_count: 0,
    updated_ts: now,
  };
  await appendRow(globalFile(), globalRow);
  return globalRow;
}

/**
 * Rollback to a prior version (by sha256 OR previous version number).
 * Re-emits the prior row as the latest, preserving the version counter monotonicity.
 */
export async function rollbackSkill(host: string, projectSlug: string, scope: SkillScope = 'project'): Promise<DomainSkillRow> {
  const normalized = normalizeHost(host);
  const file = scope === 'project' ? projectFile(projectSlug) : globalFile();
  const rows = await readRows(file);
  const matching = rows.filter((r) => r.host === normalized && r.scope === scope && !r.tombstone);
  if (matching.length < 2) {
    throw new Error(
      `Cannot rollback: ${normalized} has fewer than 2 versions in ${scope} scope.\n` +
        'Cause: no prior version to roll back to.\n' +
        'Action: $B domain-skill rm to delete instead, or wait for a future revision to roll back from.'
    );
  }
  // Sort by version desc; take second-latest as the rollback target.
  matching.sort((a, b) => b.version - a.version);
  const target = matching[1]!;
  const newVersion = matching[0]!.version + 1;
  const restored: DomainSkillRow = {
    ...target,
    version: newVersion,
    updated_ts: new Date().toISOString(),
  };
  await appendRow(file, restored);
  return restored;
}

/**
 * List all non-tombstoned skills visible to a project (active project + active global).
 */
export async function listSkills(projectSlug: string): Promise<{ project: DomainSkillRow[]; global: DomainSkillRow[] }> {
  const projectRows = await readRows(projectFile(projectSlug));
  const globalRows = await readRows(globalFile());
  const projectLatest = Array.from(resolveLatest(projectRows).values());
  const globalLatest = Array.from(resolveLatest(globalRows).values()).filter((r) => r.state === 'global');
  return { project: projectLatest, global: globalLatest };
}

/**
 * Tombstone a skill. Append a tombstone row; compactor cleans up later.
 */
export async function deleteSkill(host: string, projectSlug: string, scope: SkillScope = 'project'): Promise<void> {
  const normalized = normalizeHost(host);
  const file = scope === 'project' ? projectFile(projectSlug) : globalFile();
  const rows = await readRows(file);
  const latest = resolveLatest(rows);
  const current = latest.get(`${scope}::${normalized}`);
  if (!current) {
    throw new Error(
      `Cannot delete: no skill for ${normalized} in ${scope} scope.\n` +
        'Cause: skill does not exist or is already tombstoned.\n' +
        'Action: $B domain-skill list to see what exists.'
    );
  }
  const tombstone: DomainSkillRow = {
    ...current,
    version: current.version + 1,
    updated_ts: new Date().toISOString(),
    tombstone: true,
  };
  await appendRow(file, tombstone);
}
