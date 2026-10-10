/**
 * gate-diff core — `scanCandidate` turns already-fetched structured hunks into
 * the three-level result (listed / read / the agent's findings) the detector
 * reports. Pure: no git, no filesystem, so test/gate-diff.test.ts drives it
 * with planted fixtures. bin/gstack-gate-diff feeds it from lib/gate-diff/git.ts
 * and prints it through lib/gate-diff/render.ts.
 *
 * Admission: a hunk is LISTED when its path is on the floor (classify.ts) or
 * any tag matches (tags.ts) or a removed line is a test declaration (content
 * backstop). ELIGIBLE = tagged or deletion-bearing. READ = eligible, tagged
 * first then deletion-bearing, capped at 50 hunks / 200 KB; anything past the
 * cap is UNREAD and the result is partial (never "none detected").
 */
import { createHash } from 'node:crypto';
import {
  classifyPath, hunkHasRemovedTestDeclaration, hunkTouchesToolSection, isSectionedConfigPath, languagesUnlisted,
  type GateProjectConfig, type PathClass,
} from './classify';
import { COVERAGE_TAGS, findCitation, tagHunk } from './tags';
import type { CommitInfo, FileDiff, Hunk, ListedHunk, ScanResult } from './types';

export type { CommitInfo, DiffLine, FileDiff, FileStatus, Hunk, ListedHunk, ScanResult, ScanSummary, Unsupported } from './types';
export { EMPTY_PROJECT_CONFIG, parseGateIntegrityBlock, specDirectoryHoldsSpecs } from './classify';

export const READ_CAP_HUNKS = 50;
export const READ_CAP_BYTES = 200 * 1024;

export interface ScanInput {
  files: FileDiff[];
  /** Commits between merge-base and HEAD (or the one `--commit`), for RH-14 and citations. */
  commits: CommitInfo[];
  project: GateProjectConfig;
  specIsTestPath: boolean;
  /** `<merge-base-short>+<wtree-short>` or `<sha-short>` in commit mode. */
  candidate: string;
  /** Absolute artifact path the CLI will write; echoed in the summary. */
  artifact: string;
  readCap?: { hunks: number; bytes: number };
}

const SKIP_CI = /\[(?:skip ci|ci skip)\]/i;

function normalisedChangedLines(h: Hunk): string {
  return h.lines
    .filter((l) => l.kind !== 'ctx')
    .map((l) => (l.kind === 'del' ? '-' : '+') + l.text.replace(/\r$/, '').replace(/\s+/g, ' ').trim())
    .join('\n');
}

function hunkId(oldPath: string, newPath: string, tags: string[], normalised: string): string {
  return createHash('sha256').update([oldPath, newPath, [...tags].sort().join(','), normalised].join('\0')).digest('hex').slice(0, 12);
}

function floorFor(file: FileDiff, h: Hunk | null, project: GateProjectConfig, specIsTestPath: boolean): PathClass | null {
  const path = file.status === 'deleted' ? file.oldPath : file.newPath;
  const ctx = { project, specIsTestPath };
  if (h && isSectionedConfigPath(path)) return hunkTouchesToolSection(path, h.lines.map((l) => l.text)) ? 'config' : null;
  return classifyPath(path, ctx);
}

function entryFor(file: FileDiff, h: Hunk, floor: PathClass | null, allPaths: ReadonlySet<string>): ListedHunk | null {
  const path = file.status === 'deleted' ? file.oldPath : file.newPath;
  const old = h.lines.filter((l) => l.kind === 'del').map((l) => l.text.replace(/\r$/, ''));
  const added = h.lines.filter((l) => l.kind === 'add').map((l) => l.text.replace(/\r$/, ''));
  const tagged = tagHunk({ header: h.header, lines: h.lines.map((l) => ({ kind: l.kind, text: l.text.replace(/\r$/, '') })) }, { floor, path, allPaths });
  const admitted = floor !== null || tagged.tags.length > 0 || hunkHasRemovedTestDeclaration(old);
  if (!admitted) return null;
  const bytes = [...old, ...added].reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  return {
    id: hunkId(file.oldPath, file.newPath, tagged.tags, normalisedChangedLines(h)),
    path, oldPath: file.oldPath, level: 'listed', tags: tagged.tags, old, new: added,
    citation: tagged.citation, notes: tagged.notes, header: h.header, floor, bytes,
  };
}

function commitEntries(commits: CommitInfo[]): ListedHunk[] {
  const out: ListedHunk[] = [];
  for (const c of commits) {
    if (!SKIP_CI.test(c.message)) continue;
    const subject = c.message.split(/\r?\n/)[0] ?? '';
    const path = `(commit ${c.sha.slice(0, 12)})`;
    out.push({
      id: hunkId(path, path, ['RH-14'], '+' + subject), path, oldPath: path, level: 'listed', tags: ['RH-14'], old: [], new: [subject],
      citation: null, notes: ['RH-14: commit message carries a CI skip marker'], header: `commit ${c.sha}`, floor: null, bytes: subject.length + 1,
    });
  }
  return out;
}

function suffixDuplicateIds(entries: ListedHunk[]): void {
  const seen = new Map<string, number>();
  for (const e of entries) {
    const n = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, n);
    if (n > 1) e.id = `${e.id}-${n}`;
  }
}

function chooseRead(entries: ListedHunk[], cap: { hunks: number; bytes: number }): number {
  const eligible = entries.filter((e) => e.tags.length > 0 || e.old.length > 0);
  const ordered = [...eligible.filter((e) => e.tags.length > 0), ...eligible.filter((e) => e.tags.length === 0)];
  let inspected = 0;
  let bytes = 0;
  for (const e of ordered) {
    if (inspected >= cap.hunks) break;
    if (inspected > 0 && bytes + e.bytes > cap.bytes) break;
    e.level = 'read';
    inspected++;
    bytes += e.bytes;
  }
  return inspected;
}

export function scanCandidate(input: ScanInput): ScanResult {
  const cap = input.readCap ?? { hunks: READ_CAP_HUNKS, bytes: READ_CAP_BYTES };
  const allPaths = new Set<string>();
  for (const f of input.files) {
    allPaths.add(f.newPath);
    allPaths.add(f.oldPath);
  }
  const entries: ListedHunk[] = [];
  const unmatchedPaths: string[] = [];
  const unsupportedPaths: ScanResult['unsupportedPaths'] = [];

  for (const file of input.files) {
    const path = file.status === 'deleted' ? file.oldPath : file.newPath;
    if (file.unsupported) {
      unsupportedPaths.push({ path, reason: file.unsupported });
      const floor = floorFor(file, null, input.project, input.specIsTestPath);
      if (floor !== null) {
        entries.push({
          id: hunkId(file.oldPath, file.newPath, [], file.unsupported), path, oldPath: file.oldPath, level: 'listed', tags: [], old: [], new: [],
          citation: null, notes: [], header: `@@ ${file.unsupported} @@`, floor, unsupported: file.unsupported, bytes: 0,
        });
      }
      continue;
    }
    if (file.hunks.length === 0 && (file.status === 'renamed' || file.status === 'copied')) {
      const floor = floorFor(file, null, input.project, input.specIsTestPath);
      if (floor !== null) {
        entries.push({
          id: hunkId(file.oldPath, file.newPath, [], file.status), path, oldPath: file.oldPath, level: 'listed', tags: [], old: [], new: [],
          citation: null, notes: [`${file.status} from ${file.oldPath}`], header: `@@ ${file.status} @@`, floor, bytes: 0,
        });
      }
      continue;
    }
    let admittedAny = false;
    for (const h of file.hunks) {
      const floor = floorFor(file, h, input.project, input.specIsTestPath);
      const entry = entryFor(file, h, floor, allPaths);
      if (!entry) continue;
      admittedAny = true;
      entries.push(entry);
    }
    if (!admittedAny && file.hunks.length > 0) unmatchedPaths.push(path);
  }
  entries.push(...commitEntries(input.commits));

  const commitCitation = findCitation(input.commits.flatMap((c) => c.message.split(/\r?\n/)));
  if (commitCitation) {
    for (const e of entries) {
      if (e.citation === null && e.tags.some((t) => t.startsWith('RH-15'))) e.citation = `commit: ${commitCitation}`;
    }
  }

  suffixDuplicateIds(entries);
  const inspected = chooseRead(entries, cap);
  const eligible = entries.filter((e) => e.tags.length > 0 || e.old.length > 0).length;
  const tagged: Record<string, number> = {};
  for (const e of entries) for (const t of e.tags) tagged[t] = (tagged[t] ?? 0) + 1;

  return {
    summary: {
      listed: entries.length, eligible, inspected, unread: eligible - inspected, tagged, unmatched: unmatchedPaths.length,
      coverage: [...COVERAGE_TAGS], languagesUnlisted: languagesUnlisted(allPaths), candidate: input.candidate, artifact: input.artifact,
    },
    hunks: entries,
    unmatchedPaths,
    unsupportedPaths,
  };
}
