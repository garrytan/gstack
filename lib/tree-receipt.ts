/**
 * tree-receipt — the tree-equality receipt (plan C3), behind
 * bin/gstack-tree-receipt. Compares two committed heads (never a working
 * tree: its fingerprint can name objects unreachable once the gate VM is
 * gone), classifies the diff hunk by hunk with per-file-type rules, decides
 * per gate whether its evidence is reusable, and refuses `eligible` when the
 * recorded predecessor head moved. Tree identity alone is not gate evidence:
 * the receipt also compares the execution identity the gate ran under (from
 * a `gstack-evidence bundle`) with the current one.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeChangelog } from './changelog-check';
import { compareIdentity, executionIdentity, normalizeLockfile, readBundle, type EvidenceBundle, type ExecutionIdentity } from './evidence-bundle';
import { parseUnifiedDiff, rewriteStamps, versionAtRef, type FileDiff, type GateAheadRecord } from './restamp';
import type { ResultCodeName } from './result-codes';
import { matchesAny, type ShipPolicy } from './ship-policy';

export type HunkClass = 'stamp' | 'changed';
export interface FileVerdict { path: string; rule: string; verdict: HunkClass; residual?: string }
export interface GateVerdict { label: string; verdict: 'reusable' | 'rerun' | 'not-reusable'; reason: string; cmd_sha256?: string; command?: string }
export interface TreeReceipt {
  schema_version: 1;
  gated_head: string; current_head: string; gated_tree: string; current_tree: string;
  gated_wtree: string; current_wtree: string;
  old_version: string | null; new_version: string | null;
  predecessor: { pr: string | null; recorded_head: string | null; current_head: string | null; moved: boolean } | null;
  files: FileVerdict[]; residual: string[];
  tree: 'same-modulo-stamps' | 'changed';
  identity: { gated: ExecutionIdentity | null; current: ExecutionIdentity; diffs: string[]; source: string };
  gates: GateVerdict[];
  gate_reuse: 'eligible' | 'not-eligible';
  gate_reuse_reason: string;
  rerun_command: string;
  policy: string;
  stamp_diff: string;
  code?: ResultCodeName;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '').replace(/\n$/, '') : null;
}
function blob(cwd: string, treeish: string, rel: string): string | null {
  const r = spawnSync('git', ['show', `${treeish}:${rel}`], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Every removed/added pair differs only by the exact stamp rewrites (old -> new). */
function stampOnlyHunks(hunks: FileDiff['hunks'], oldV: string, newV: string): string | null {
  for (const h of hunks) {
    if (h.removed.length !== h.added.length) return `${h.removed.length} line(s) removed, ${h.added.length} added`;
    for (let i = 0; i < h.removed.length; i++) {
      const r = h.removed[i]!;
      const a = h.added[i]!;
      const rewritten = rewriteStamps(r, oldV, newV);
      if (rewritten.count === 0 || rewritten.text !== a) return `${JSON.stringify(r.trim().slice(0, 60))} -> ${JSON.stringify(a.trim().slice(0, 60))}`;
    }
  }
  return null;
}

function jsonEqualModuloVersion(a: string | null, b: string | null, name: string): boolean {
  if (a === null || b === null) return false;
  return normalizeLockfile(name, a) === normalizeLockfile(name, b);
}

function classifyFile(repoRoot: string, f: FileDiff, gated: string, current: string, policy: ShipPolicy, versionRel: string, oldV: string | null, newV: string | null): FileVerdict {
  const changed = (rule: string, residual: string): FileVerdict => ({ path: f.path, rule, verdict: 'changed', residual });
  const stamp = (rule: string): FileVerdict => ({ path: f.path, rule, verdict: 'stamp' });
  if (f.binary) return changed('binary', 'binary content differs');
  if (f.status !== 'M') return changed('path', `${f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'renamed'}`);
  const before = blob(repoRoot, gated, f.path);
  const after = blob(repoRoot, current, f.path);
  const base = path.basename(f.path);
  if (f.path === versionRel) {
    if (before !== null && after !== null && before.trim() === oldV && after.trim() === newV) return stamp('version-file');
    if (versionRel.endsWith('.json') && jsonEqualModuloVersion(before, after, 'package-lock.json')) return stamp('version-manifest');
    return changed('version-file', 'content beyond the version changed');
  }
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    return jsonEqualModuloVersion(before, after, base) ? stamp('lockfile-root-version') : changed('lockfile', 'a dependency entry changed (only the root version keys are stamps)');
  }
  if (base === 'bun.lock') return jsonEqualModuloVersion(before, after, base) ? stamp('lockfile-root-version') : changed('lockfile', 'a dependency entry changed');
  if (base === 'package.json') {
    try {
      const a = JSON.parse(before ?? 'null'); const b = JSON.parse(after ?? 'null');
      if (a && b) { delete a.version; delete b.version; if (JSON.stringify(a) === JSON.stringify(b)) return stamp('manifest-version'); }
    } catch {}
    return changed('manifest', 'a field other than version changed');
  }
  if (policy.changelog && f.path === policy.changelog) {
    return before !== null && after !== null && normalizeChangelog(before) === normalizeChangelog(after) ? stamp('changelog-heading') : changed('changelog', 'entry text changed (only a heading move or re-heading is a stamp)');
  }
  if (oldV && newV && oldV !== newV && (matchesAny(policy.stamp_paths, f.path) || matchesAny(policy.release_outputs, f.path))) {
    const rule = matchesAny(policy.stamp_paths, f.path) ? 'stamp_paths' : 'release_outputs';
    const why = stampOnlyHunks(f.hunks, oldV, newV);
    return why ? changed(rule, why) : stamp(rule);
  }
  return changed('other', `${f.hunks.length} hunk(s) outside every stamp rule`);
}

export interface ReceiptOptions {
  repoRoot: string; gated: string; current?: string; policy: ShipPolicy; policyLabel: string; versionRel?: string;
  predecessor?: { pr: string | null; recordedHead: string | null; ref?: string | null; currentHead?: string | null };
  bundlePath?: string; gh?: (args: string[]) => { ok: boolean; out: string }; env?: NodeJS.ProcessEnv; rerunCommand?: string;
}

export function fromGateAhead(file: string): GateAheadRecord {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GateAheadRecord;
}

function resolvePredecessor(o: ReceiptOptions): TreeReceipt['predecessor'] {
  const p = o.predecessor;
  if (!p) return null;
  let currentHead: string | null = p.currentHead ?? null;
  if (!currentHead && p.ref) currentHead = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${p.ref}^{commit}`]);
  if (!currentHead && p.pr) {
    const gh = o.gh ?? ((args: string[]) => { const r = spawnSync('gh', args, { cwd: o.repoRoot, encoding: 'utf8', timeout: 60_000 }); return { ok: r.status === 0, out: r.stdout ?? '' }; });
    const r = gh(['pr', 'view', p.pr, '--json', 'headRefOid']);
    try { currentHead = r.ok ? (JSON.parse(r.out).headRefOid ?? null) : null; } catch { currentHead = null; }
  }
  const moved = !!(p.recordedHead && currentHead && p.recordedHead !== currentHead);
  return { pr: p.pr, recorded_head: p.recordedHead, current_head: currentHead, moved };
}

export function buildReceipt(o: ReceiptOptions): TreeReceipt | { error: string; code: ResultCodeName } {
  const gatedHead = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.gated}^{commit}`]);
  const currentHead = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.current ?? 'HEAD'}^{commit}`]);
  if (!gatedHead) return { error: `gated head ${o.gated} is not a committed head here (fetch it, or copy the gate-ahead worktree's object store)`, code: 'EVIDENCE_IDENTITY_UNKNOWN' };
  if (!currentHead) return { error: `current head ${o.current ?? 'HEAD'} is not a commit`, code: 'EVIDENCE_IDENTITY_UNKNOWN' };
  const gatedTree = git(o.repoRoot, ['rev-parse', `${gatedHead}^{tree}`])!;
  const currentTree = git(o.repoRoot, ['rev-parse', `${currentHead}^{tree}`])!;
  const gv = versionAtRef(o.repoRoot, gatedHead);
  const cv = versionAtRef(o.repoRoot, currentHead);
  const versionRel = o.versionRel ?? ('rel' in cv ? cv.rel : 'rel' in gv ? gv.rel : 'VERSION');
  const oldV = 'version' in gv ? gv.version : null;
  const newV = 'version' in cv ? cv.version : null;
  const diffText = git(o.repoRoot, ['diff', '--unified=0', '--no-color', '--no-ext-diff', gatedHead, currentHead]) ?? '';
  const files = parseUnifiedDiff(diffText).map(f => classifyFile(o.repoRoot, f, gatedHead, currentHead, o.policy, versionRel, oldV, newV));
  const residual = files.filter(f => f.verdict === 'changed').map(f => f.path);
  const stampFiles = files.filter(f => f.verdict === 'stamp').map(f => f.path);
  const stampDiff = stampFiles.length ? (git(o.repoRoot, ['diff', '--no-color', '--no-ext-diff', gatedHead, currentHead, '--', ...stampFiles]) ?? '') : '';
  const predecessor = resolvePredecessor(o);

  const current = executionIdentity(o.repoRoot, currentHead, o.env);
  let gated: ExecutionIdentity | null = null;
  let bundle: EvidenceBundle | null = null;
  let source = 'none (no evidence bundle; execution identity unknown)';
  if (o.bundlePath) {
    const read = readBundle(o.bundlePath);
    if (!read.bundle) source = `invalid bundle: ${read.error?.message}`;
    else if (read.bundle.repo.tree !== gatedTree) source = `bundle ${o.bundlePath} was produced on tree ${read.bundle.repo.tree.slice(0, 12)}, not the gated tree ${gatedTree.slice(0, 12)}`;
    else { bundle = read.bundle; gated = bundle.identity; source = `bundle ${o.bundlePath} (producer ${bundle.producer.host}, ${bundle.produced_at})`; }
  }
  const diffs = gated ? compareIdentity(gated, current) : [];
  const rerun = o.rerunCommand ?? 'gstack-evidence run --label <lane> -- <lane command>';

  const gates: GateVerdict[] = [];
  const sensitive = new Set(o.policy.stamp_sensitive_gates);
  if (bundle) {
    for (const lane of bundle.lanes) {
      if (sensitive.has(lane.label)) gates.push({ label: lane.label, verdict: 'rerun', reason: 'stamp-sensitive (reads VERSION or generated bytes); always reruns on the stamped tree', cmd_sha256: lane.cmd_sha256, command: lane.command });
      else if (!lane.verified) gates.push({ label: lane.label, verdict: 'not-reusable', reason: lane.reason ?? 'not verified', cmd_sha256: lane.cmd_sha256, command: lane.command });
      else if (lane.exit !== 0) gates.push({ label: lane.label, verdict: 'not-reusable', reason: `recorded run exited ${lane.exit}`, cmd_sha256: lane.cmd_sha256, command: lane.command });
      else if (diffs.length) gates.push({ label: lane.label, verdict: 'not-reusable', reason: `identity changed: ${diffs.join('; ')}`, cmd_sha256: lane.cmd_sha256, command: lane.command });
      else gates.push({ label: lane.label, verdict: 'reusable', reason: 'identity matches; tree same modulo stamps', cmd_sha256: lane.cmd_sha256, command: lane.command });
    }
    for (const label of bundle.required_lanes) if (!bundle.lanes.some(l => l.label === label)) gates.push({ label, verdict: 'not-reusable', reason: 'required lane has no verified record in the bundle' });
    for (const lane of bundle.imported) gates.push({ label: lane.label, verdict: 'not-reusable', reason: lane.reason ?? 'imported assertion, not verified' });
  }

  const treeVerdict: TreeReceipt['tree'] = residual.length ? 'changed' : 'same-modulo-stamps';
  let reason = '';
  if (treeVerdict === 'changed') reason = `tree changed: ${residual.join(', ')}`;
  else if (predecessor?.moved) reason = `PREDECESSOR MOVED ${predecessor.recorded_head!.slice(0, 12)} -> ${predecessor.current_head!.slice(0, 12)}`;
  else if (!bundle) reason = source;
  else if (diffs.length) reason = diffs.join('; ');
  else if (gates.some(g => g.verdict === 'not-reusable')) reason = gates.filter(g => g.verdict === 'not-reusable').map(g => `${g.label}: ${g.reason}`).join('; ');
  else if (gates.length === 0 || gates.every(g => g.verdict === 'rerun')) reason = gates.length ? 'every lane is stamp-sensitive; nothing to reuse' : 'bundle lists no lanes';
  const eligible = reason === '';
  return {
    schema_version: 1, gated_head: gatedHead, current_head: currentHead, gated_tree: gatedTree, current_tree: currentTree,
    gated_wtree: gatedTree, current_wtree: currentTree, old_version: oldV, new_version: newV, predecessor,
    files, residual, tree: treeVerdict, identity: { gated, current, diffs, source }, gates,
    gate_reuse: eligible ? 'eligible' : 'not-eligible', gate_reuse_reason: eligible ? `reusable: ${gates.filter(g => g.verdict === 'reusable').map(g => g.label).join(',') || '-'}; rerun: ${gates.filter(g => g.verdict === 'rerun').map(g => g.label).join(',') || '-'}` : reason,
    rerun_command: rerun, policy: o.policyLabel, stamp_diff: stampDiff,
    code: eligible ? undefined : predecessor?.moved && treeVerdict !== 'changed' ? 'RESTAMP_PREDECESSOR_MOVED' : 'GATE_REUSE_NOT_ELIGIBLE',
  };
}

/** The human rendering: identifiers first, one verdict line each for the tree and the gate reuse. */
export function renderReceipt(r: TreeReceipt): string {
  const lines = [
    `gated head:    ${r.gated_head}`,
    `current head:  ${r.current_head}`,
    `gated tree:    ${r.gated_tree}`,
    `current tree:  ${r.current_tree}`,
    `version:       ${r.old_version ?? '-'} -> ${r.new_version ?? '-'}`,
    `predecessor:   ${r.predecessor ? `#${r.predecessor.pr ?? '?'} recorded=${r.predecessor.recorded_head?.slice(0, 12) ?? '-'} current=${r.predecessor.current_head?.slice(0, 12) ?? 'unknown'}${r.predecessor.moved ? ' MOVED' : ''}` : 'none'}`,
    `policy:        ${r.policy}`,
    `identity:      ${r.identity.source}${r.identity.diffs.length ? ` — changed: ${r.identity.diffs.join('; ')}` : ''}`,
  ];
  for (const f of r.files) lines.push(`  ${f.verdict === 'stamp' ? 'stamp  ' : 'changed'} ${f.path} (${f.rule}${f.residual ? `: ${f.residual}` : ''})`);
  for (const g of r.gates) lines.push(`  gate ${g.label}: ${g.verdict} (${g.reason})`);
  if (r.stamp_diff) lines.push(r.stamp_diff.replace(/\n$/, ''));
  lines.push(`TREE: ${r.tree === 'changed' ? `changed (${r.residual.join(', ')})` : 'same-modulo-stamps'}`);
  if (r.predecessor?.moved) lines.push(`PREDECESSOR MOVED ${r.predecessor.recorded_head} -> ${r.predecessor.current_head} — fix: gstack-restamp --after ${r.predecessor.pr ?? '<pr>'} again (RESTAMP_PREDECESSOR_MOVED)`);
  lines.push(r.gate_reuse === 'eligible'
    ? `gate-reuse: eligible (${r.gate_reuse_reason})`
    : `gate-reuse: not-eligible (${r.gate_reuse_reason}) — fix: ${r.rerun_command} (GATE_REUSE_NOT_ELIGIBLE)`);
  return lines.join('\n') + '\n';
}
