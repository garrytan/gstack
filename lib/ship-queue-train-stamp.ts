/**
 * Stamped train prefixes (docs/ship-policy.md#run-a-merge-train, GSTA-154 PR B): under
 * changelog_fragments a train is built twice. T_i is the plain chain buildChain makes (each pin merged
 * onto the previous prefix, unversioned); S_i = stamp(merge(S_(i-1), pin_i)) is what slot i publishes,
 * with S_0 = T_0 = the base. Each S_i is stamped by gstack-restamp with S_(i-1) as its base, so slot i
 * folds only its own fragments (a stacked pin's parent fragments are already folded in S_(i-1)) and the
 * versions run base+bump_1, +bump_2, ... in ORDER, every earlier release entry kept. Two checks run
 * before anything is pushed: S_i is merge(S_(i-1), pin_i) modulo stamps (the tree receipt, which knows
 * the fragment fold), and S_i equals T_i byte for byte outside release paths. Either failing is
 * QUEUE_TRAIN_STAMP_MISMATCH.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseChangelog } from './changelog-check';
import { restamp, versionAtRef, versionFiles } from './restamp';
import { matchesAny, type ShipPolicy } from './ship-policy';
import { git, type QueueFailure } from './ship-queue-gate';
import { linkedReleaseFile } from './ship-queue-land';
import { mergeCommit } from './ship-queue-train';
import type { StampedPrefix, TrainPrefix, TrainSlot } from './ship-queue-train-record';
import { buildReceipt } from './tree-receipt';

export type { StampedPrefix };
export interface StampChainOptions {
  repoRoot: string; base: string; policy: ShipPolicy; policyLabel: string; baseSha: string;
  slots: TrainSlot[]; plain: TrainPrefix[]; allowRepoCommands: boolean; now: Date;
}

const IDENTITY = { GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue',
  GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

/** A path a stamp may write: version files, the CHANGELOG, fragments, release outputs, stamp paths and stamp files. */
export function isReleasePath(root: string, policy: ShipPolicy, versionRel: string, rel: string): boolean {
  const dir = policy.changelog_fragments?.dir.replace(/\/+$/, '');
  return versionFiles(root, versionRel).includes(rel) || rel === policy.changelog || (!!dir && rel.startsWith(dir + '/'))
    || matchesAny(policy.release_outputs, rel) || matchesAny(policy.stamp_paths, rel) || matchesAny(policy.stamp_files, rel);
}

/**
 * S_i is merge(S_(i-1), pin_i) modulo stamps, keeps every release entry of S_(i-1) (merged's first parent)
 * byte for byte, and equals T_i outside release paths. Null when all hold, else why not.
 */
export function stampMismatch(o: StampChainOptions, merged: string, stamped: string, plainTree: string): string | null {
  const r = buildReceipt({ repoRoot: o.repoRoot, gated: merged, current: stamped, policy: o.policy, policyLabel: o.policyLabel });
  if ('error' in r) return r.error;
  if (r.tree !== 'same-modulo-stamps') return `the stamp changed more than stamps: ${r.residual.slice(0, 8).join(', ')}`;
  const cl = o.policy.changelog;
  if (cl) {
    const read = (rev: string) => git(o.repoRoot, ['show', `${rev}:${cl}`]);
    const before = read(`${merged}^1`);
    const after = read(stamped);
    if (before.ok && !after.ok) return `the stamp removed ${cl}`;
    const kept = new Map(parseChangelog(after.out).sections.filter(s => s.version).map(s => [s.version!, s.lines.join('\n').trimEnd()]));
    const lost = parseChangelog(before.ok ? before.out : '').sections.filter(s => s.version && kept.get(s.version) !== s.lines.join('\n').trimEnd());
    if (lost.length) return `the stamp rewrote or dropped the earlier release entr${lost.length > 1 ? 'ies' : 'y'} ${lost.map(s => `[${s.version}]`).join(', ')} in ${cl}`;
  }
  const at = versionAtRef(o.repoRoot, stamped);
  const versionRel = 'rel' in at ? at.rel : 'VERSION';
  const diff = git(o.repoRoot, ['diff', '--name-only', '--no-renames', plainTree, `${stamped}^{tree}`]);
  if (!diff.ok) return `cannot compare with the plain prefix: ${diff.err.split('\n')[0]}`;
  const beyond = diff.out.split('\n').filter(f => f && !isReleasePath(o.repoRoot, o.policy, versionRel, f));
  return beyond.length ? `differs from the plain prefix outside release paths: ${beyond.slice(0, 8).join(', ')}` : null;
}

/** Build S_1..S_k. A conflict, a refused stamp or a failed check stops at that slot with nothing pushed. */
export function stampChain(o: StampChainOptions): { stamped: StampedPrefix[]; lines: string[] } | QueueFailure {
  const stamped: StampedPrefix[] = [];
  const lines: string[] = [];
  const date = o.now.toISOString().slice(0, 10);
  for (const [i, slot] of o.slots.entries()) {
    const pred = i === 0 ? o.baseSha : stamped[i - 1]!.commit;
    const m = mergeCommit(o.repoRoot, pred, slot.head, o.policy, `train S${i + 1} (unstamped): merge #${slot.pr} at ${slot.head.slice(0, 12)}`);
    if ('conflicts' in m) return { code: 'QUEUE_TRAIN_CONFLICT', message: `#${slot.pr} conflicts with S${i}: ${m.conflicts.join(', ')}` };
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-train-stamp-'));
    fs.rmSync(wt, { recursive: true, force: true });
    if (!git(o.repoRoot, ['worktree', 'add', '--detach', '-q', wt, m.commit]).ok) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `cannot check out the merge for S${i + 1}` };
    let tree = '';
    let version = '';
    try {
      const at = versionAtRef(o.repoRoot, m.commit);
      const linked = linkedReleaseFile(wt, o.policy, 'rel' in at ? at.rel : 'VERSION');
      if (linked) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `S${i + 1} (#${slot.pr}): ${linked} is a symlink in the merged tree; the stamp writes release files only inside the repository` };
      const r = restamp({ repoRoot: wt, base: o.base, baseRef: pred, next: true, policyFrom: 'base', allowRepoCommands: o.allowRepoCommands, dryRun: false, now: new Date(`${date}T12:00:00Z`), env: process.env });
      if (r.status !== 'stamped') return { code: r.code ?? 'QUEUE_TRAIN_STAMP_MISMATCH', message: `S${i + 1} (#${slot.pr}): restamp ${r.status}: ${r.message ?? ''}`, fix: r.fix };
      if (!git(wt, ['add', '-A']).ok) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `cannot stage the stamp for S${i + 1}` };
      tree = git(wt, ['write-tree']).out;
      if (!/^[0-9a-f]{40,64}$/.test(tree)) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `cannot write the stamped tree for S${i + 1}` };
      version = r.newVersion!;
    } finally {
      git(o.repoRoot, ['worktree', 'remove', '--force', wt]);
      fs.rmSync(wt, { recursive: true, force: true });
    }
    const c = git(o.repoRoot, ['commit-tree', '--no-gpg-sign', tree, '-p', pred, '-p', slot.head, '-m', `train S${i + 1}: merge #${slot.pr} at ${slot.head.slice(0, 12)} v${version}`], { ...process.env, ...IDENTITY });
    if (!c.ok) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `commit-tree failed for S${i + 1}: ${c.err.slice(0, 120)}` };
    const plain = o.plain[i + 1];
    const why = plain ? stampMismatch(o, m.commit, c.out, plain.tree) : `no plain prefix T${i + 1}`;
    if (why) return { code: 'QUEUE_TRAIN_STAMP_MISMATCH', message: `S${i + 1} (#${slot.pr}): ${why}` };
    stamped.push({ index: i + 1, commit: c.out, tree, pr: slot.pr, version, date });
    lines.push(`S${i + 1}: #${slot.pr} v${version} ${c.out.slice(0, 12)} tree=${tree.slice(0, 12)} (merge of S${i} and the pin, modulo stamps; T${i + 1} outside release paths)`);
  }
  return { stamped, lines };
}
