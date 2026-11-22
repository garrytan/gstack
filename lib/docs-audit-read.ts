/**
 * The scoped read of a Step 14.5 docs-audit edit to a doc the reviewers read (GST-3532, gbrain#10059). Write's docs-audit
 * exception (lib/ship-receipt-depth.ts writeExcludeBinds) binds docs the exclusion hides or keeps because code names them; a doc
 * the review keeps for its own content (a gate path, gate tags, agent prose or a secret line) was read by the reviewers, so its
 * edit after the review needs a reader too. Instead of another review round, which the round cap forbids, one scoped reader reads
 * a packet of that audit change, the way carry's scoped review reads spliced hunks; it is not a review round under R51. Its clean
 * record, bound to the head and the packet, binds into the receipt as `docs_audit_read`. A finding, another head or packet, or an
 * edit over BOUNDED_LINES lines still refuses.
 */
import { spawnSync } from './spawn-sync';
import { createHash } from 'node:crypto';
import { BOUNDED_LINES, packetBrief, readScopedReview } from './ship-patch';

/** Kept reasons that mean the reviewers read the doc for its own content; any other kept reason keeps refusing. */
export const READ_REASONS: readonly string[] = ['gate-path', 'gate-tagged', 'agent-prose', 'secret-line'];

export interface DocsAuditRead { paths: string[]; reviewer: string; packet_sha256: string }
export type DocsAuditPacket = { ok: true; text: string; sha256: string } | { ok: false; why: string };

/** The packet for the audit's change to `files`, each from its content before the audit (a blob id, or null when the audit added it) to HEAD's. */
export function docsAuditPacket(root: string, head: string, files: ReadonlyArray<{ path: string; before: string | null }>): DocsAuditPacket {
  const git = (args: string[], input?: string) => { const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const sections: string[] = [];
  for (const { path: p, before } of files) {
    const after = git(['rev-parse', '--verify', '--quiet', `${head}:${p}`])?.trim();
    const from = before ?? git(['hash-object', '-w', '--stdin'], '')?.trim();
    const diff = after && from ? git(['diff', '--no-color', '--no-ext-diff', '-U3', from, after]) : null;
    if (diff === null) return { ok: false, why: `git could not diff ${p} from before the audit to HEAD` };
    const lines = diff.split('\n');
    const at = lines.findIndex(l => l.startsWith('@@'));
    if (at < 0 && diff.trim()) return { ok: false, why: `git shows the audit's change to ${p} with no text hunk (a binary or very large file), so one scoped reader cannot read it` };
    const hunks = at < 0 ? [] : lines.slice(at);
    const changed = hunks.filter(l => /^[+-]/.test(l)).length;
    if (changed > BOUNDED_LINES) return { ok: false, why: `the audit changed ${changed} lines of ${p}, a doc the reviewers read: too large for one scoped reader (at most ${BOUNDED_LINES})` };
    sections.push(`## ${p}\n\n\`\`\`diff\n${hunks.join('\n').trimEnd()}\n\`\`\`\n`);
  }
  const text = [`# Scoped review: the docs audit edited docs the reviewers read\n\nHEAD ${head.slice(0, 12)}. After the review, /ship's Step 14.5 docs audit changed these docs, which the review read for their own content (a gate path, gate tags, agent prose or a secret line). Read each change as gate text: does it still say what the code does, and does it change what a gate, cap, reviewer, approval, secret or money rule says? This one read replaces another review round (docs/review-policy.md#docs-audit-edits-to-reviewed-docs). Report clean, or findings at the blocking floor.\n`,
    ...sections, `## Targeted brief\n\n${packetBrief()}\n`].join('\n');
  return { ok: true, text, sha256: createHash('sha256').update(text).digest('hex') };
}

/** The reader's record for this packet at `head`: clean, covering every file, bound to the packet; else why it does not stand. */
export function readDocsAuditRead(file: string, head: string, paths: readonly string[], sha256: string): { ok: true; read: DocsAuditRead } | { ok: false; why: string } {
  const r = readScopedReview(file, { head }, paths);
  if (!r.ok) return { ok: false, why: `--docs-audit-read: ${r.message}` };
  if (r.review.packet_sha256 !== sha256) return { ok: false, why: `--docs-audit-read: the record's packet_sha256 is ${r.review.packet_sha256?.slice(0, 12) ?? 'missing'}, not ${sha256.slice(0, 12)}: rerun the reader on the packet write names` };
  return { ok: true, read: { paths: [...paths], reviewer: r.review.reviewer, packet_sha256: sha256 } };
}
