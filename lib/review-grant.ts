/**
 * review-grant — the owner's review_loop_grant row behind `gstack-review-plan --grant <approval id>` (GST-967, GST-2244,
 * docs/review-policy.md#review-loop-grant). A grant binds when its row in this branch's approval record is approved, its ask or
 * scope says review_loop_grant, and one sha it names (short or full, `review_loop_grant <sha> on #<n>` included) resolves to a
 * stop head at or after --range-base (after it for a post-review chain link, whose last link's own grant does not carry over)
 * and at or before HEAD. A row that fails says which field to fix, one cause at a time: the Captain's a-b7f47c6bef36 named
 * review_loop_exception, and a refusal that lumped every cause into one sentence sent lanes asking for the head string.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { locate, readRecord, type ApprovalRow } from './approval-record';
import { runScriptSync } from './script-invocation';

export type GrantBinding = { ok: true; row: ApprovalRow; stopHead: string; passHead: string } | { ok: false; reason: string };

const git = (root: string, a: string[]) => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', timeout: 60_000 }); return r.status === 0 ? r.stdout.trim() : null; };

export function bindGrant(o: { root: string; env: NodeJS.ProcessEnv; grant: string; rangeBase: string; chained: boolean }): GrantBinding {
  const fail = (reason: string): GrantBinding => ({ ok: false, reason });
  const loc = locate({ cwd: o.root, env: o.env });
  if (!('file' in loc)) return fail(`the approval record is unreadable (${loc.message})`);
  const head = git(o.root, ['rev-parse', 'HEAD']) ?? 'HEAD';
  const form = `review_loop_grant ${head.slice(0, 12)} on #<n>`;
  const row = readRecord(loc).rows.find(r => r.id === o.grant);
  if (!row) return fail(`no row ${o.grant} in the approval record for branch ${loc.branch} (${loc.file}${loc.mirror ? `, mirror ${loc.mirror}` : ''}): record the owner's grant on this branch with gstack-approvals add --ask '... (${form})' (gstack-approvals list shows its rows)`);
  if (row.outcome !== 'approved') return fail(`row ${o.grant} has outcome ${row.outcome}, not approved: record the owner's grant as an approved row`);
  const text = `${row.ask} ${row.scope}`;
  if (!text.includes('review_loop_grant')) return fail(text.includes('review_loop_exception')
    ? `row ${o.grant} names review_loop_exception, the receipt's field, not review_loop_grant: record a new row whose ask or scope reads review_loop_grant <stop head sha> on #<n> (here ${form})`
    : `row ${o.grant} names no review_loop_grant: record a new row whose ask or scope reads ${form}`);
  const passHead = git(o.root, ['rev-parse', '--verify', '--quiet', `${o.rangeBase}^{commit}`]);
  if (!passHead) return fail(`--range-base ${o.rangeBase} is not a commit in this clone, so no stop head can be checked against it`);
  const words = [...new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
  if (!words.length) return fail(`row ${o.grant} names no commit sha: name the stop head, ${form}`);
  const ancestor = (a: string, d: string) => git(o.root, ['merge-base', '--is-ancestor', a, d]) !== null;
  const named = words.map(w => ({ w, c: git(o.root, ['rev-parse', '--verify', '--quiet', `${w}^{commit}`]) }));
  const stop = named.find(n => n.c && ancestor(passHead, n.c) && ancestor(n.c, 'HEAD') && !(o.chained && n.c === passHead));
  if (stop) return { ok: true, row, stopHead: stop.c!, passHead };
  const commits = named.filter(n => n.c);
  if (!commits.length) return fail(`row ${o.grant} names ${words.join(', ')}, which is not a commit in this clone: fetch the branch, or name the stop head, ${form}`);
  const window = o.chained ? `after --range-base ${passHead.slice(0, 12)}, the last fix-check's commit, whose own grant does not carry over,` : `at or after --range-base ${passHead.slice(0, 12)}`;
  return fail(`row ${o.grant} names ${commits.map(n => n.w).join(', ')}, which is not the stop head: expected ${head} (HEAD), or any commit ${window} and at or before HEAD; record a new row reading ${form}`);
}

/** When a review-fix-check row was logged after the grant was recorded: that fix-check is the one the grant bought. */
export function grantSpent(binDir: string, row: ApprovalRow): { error: string } | { at: string | null } {
  const read = runScriptSync(path.join(binDir, 'gstack-review-read'), [], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (read.status !== 0) return { error: `gstack-review-read exited ${read.status}, so whether a fix-check already spent this grant is unknown` };
  const at = (read.stdout ?? '').split('\n---CONFIG---')[0]!.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v?.skill === 'review-fix-check' && Date.parse(v.timestamp) > Date.parse(row.recorded_at) ? [String(v.timestamp)] : []; } catch { return []; } });
  return { at: at.at(-1) ?? null };
}
