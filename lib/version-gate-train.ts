/**
 * Version Gate under merge trains (docs/ship-policy.md#run-a-merge-train).
 * When the base branch's .gstack/ship-policy.json declares a `train` block, a
 * READY head is unstamped: the train merges it onto main and the lane stamps
 * at its slot with `gstack-restamp --next`. This classifies the PR head
 * against its merge base with the base branch, so
 * scripts/compare-pr-version.ts can accept an unstamped head and hold a
 * stamped one to the version the restamp allocates (base + the policy bump).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseChangelog } from './changelog-check';
import { effectiveBump, readFragments } from './changelog-fragments';
import { matchesAny } from './ship-policy';

export type TrainHead =
  | { kind: 'off' }
  | { kind: 'unstamped'; fragments?: number; entry?: 'fragment' | 'unreleased' | 'none-bot' }
  | { kind: 'stamped'; expected: string; fragments?: boolean }
  | { kind: 'invalid'; reason: string };

function git(repoRoot: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function bumpVersion(version: string, level: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  const v = m.slice(1).map(Number);
  const at = { major: 0, minor: 1, patch: 2, micro: 3 }[level] ?? 2;
  return v.map((n, i) => (i < at ? n : i === at ? n + 1 : 0)).join('.');
}

/**
 * An unstamped head may regenerate a release output (a generator change, for
 * example) as long as what it committed is exactly what the policy's
 * release_tool produces at its merge base's VERSION (the head's own, since
 * VERSION is unchanged on this path; the base tip may have stamped since):
 * the slot's restamp regenerates it anyway. Runs the head's tool in a
 * throwaway worktree with that VERSION and compares each changed output byte
 * for byte, reading the tool's output from a file (first 4 KB) so a lingering
 * child cannot hold the gate open, and killing a tool that outlives the limit
 * with SIGKILL so one that ignores TERM cannot either. A stamp (new
 * VERSION inside the output) differs, so it still classifies as stamped, and
 * so does an output the tool never writes (it is removed before the run).
 * The tool is head code: it runs with a bare environment (no tokens), no
 * node_modules link, and a short timeout, and its outputs are read only from
 * the staging worktree.
 */
const TOOL_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'BUN_INSTALL', 'SystemRoot', 'TEMP', 'TMP'];
export function regeneratedAtBase(o: { repoRoot: string; head: string; baseVersion: string; tool: string; outputs: string[]; timeoutMs?: number }): { kind: 'same' } | { kind: 'differs'; files: string[] } | { kind: 'error'; reason: string } {
  const timeoutMs = o.timeoutMs ?? 120_000;
  if (!o.baseVersion.trim()) return { kind: 'error', reason: 'the merge base has no VERSION to regenerate the release outputs at' };
  let staging: string;
  try { staging = fs.mkdtempSync(path.join(os.tmpdir(), 'version-gate-regen-')); } catch (e) { return { kind: 'error', reason: `cannot create a staging directory to regenerate the release outputs: ${e instanceof Error ? e.message : String(e)}` }; }
  try {
    const add = spawnSync('git', ['worktree', 'add', '--detach', '-q', staging, o.head], { cwd: o.repoRoot, encoding: 'utf8', timeout: 30_000 });
    if (add.status !== 0) return { kind: 'error', reason: `cannot stage ${o.head.slice(0, 12)} to regenerate its release outputs: ${(add.stderr || '').trim().slice(0, 200)}` };
    fs.rmSync(path.join(staging, 'VERSION'), { force: true });
    fs.writeFileSync(path.join(staging, 'VERSION'), o.baseVersion);
    for (const f of o.outputs) fs.rmSync(path.join(staging, f), { force: true });
    const env: NodeJS.ProcessEnv = { GSTACK_RESTAMP_VERSION: o.baseVersion.trim(), GSTACK_RESTAMP_STAGING: '1' };
    for (const key of TOOL_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    const logPath = path.join(os.tmpdir(), path.basename(staging) + '.log');
    const log = fs.openSync(logPath, 'w');
    let run: ReturnType<typeof spawnSync>;
    try { run = spawnSync('sh', ['-c', o.tool], { cwd: staging, stdio: ['ignore', log, log], timeout: timeoutMs, killSignal: 'SIGKILL', env }); } finally { fs.closeSync(log); }
    const output = (() => {
      try { const fd = fs.openSync(logPath, 'r'); try { const buf = Buffer.alloc(4096); return buf.subarray(0, fs.readSync(fd, buf)).toString('utf8'); } finally { fs.closeSync(fd); } } catch { return ''; } finally { fs.rmSync(logPath, { force: true }); }
    })();
    if (run.status !== 0) {
      const timedOut = run.signal !== null || (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const how = run.status !== null ? `exited ${run.status}` : timedOut ? `was killed at the ${Math.round(timeoutMs / 1000)}s limit` : (run.error?.message ?? 'did not exit');
      return { kind: 'error', reason: `release_tool \`${o.tool}\` ${how} at ${o.head.slice(0, 12)} with its merge base's VERSION, so its release outputs cannot be told from a stamp: ${output.trim().slice(0, 200)}` };
    }
    const files = o.outputs.filter(f => {
      const committed = spawnSync('git', ['show', `${o.head}:${f}`], { cwd: o.repoRoot, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      let generated: Buffer | null = null;
      try { generated = fs.readFileSync(path.join(staging, f)); } catch { generated = null; }
      return committed.status !== 0 || generated === null || !committed.stdout.equals(generated);
    });
    return files.length ? { kind: 'differs', files } : { kind: 'same' };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', staging], { cwd: o.repoRoot, timeout: 30_000 });
    fs.rmSync(staging, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: o.repoRoot, timeout: 30_000 });
  }
}

export function classifyTrainHead(o: { repoRoot: string; baseRef: string; head: string; author?: string }): TrainHead {
  const base = `origin/${o.baseRef.replace(/^origin\//, '')}`;
  const show = (rev: string, file: string) => git(o.repoRoot, ['show', `${rev}:${file}`]);
  let policy: any = null;
  try { policy = JSON.parse(show(base, '.gstack/ship-policy.json') ?? 'null'); } catch { policy = null; }
  const fragDir: string | null = typeof policy?.changelog_fragments?.dir === 'string' ? policy.changelog_fragments.dir : null;
  if (!policy || ((typeof policy.train !== 'object' || policy.train === null) && !fragDir)) return { kind: 'off' };
  const mergeBase = git(o.repoRoot, ['merge-base', base, o.head])?.trim();
  if (!mergeBase) return { kind: 'invalid', reason: `no merge base between ${base} and ${o.head}` };

  const npmVersion = (rev: string) => { try { return JSON.parse(show(rev, 'package.json') ?? '{}').version ?? null; } catch { return null; } };
  const changed = (git(o.repoRoot, ['diff', '--name-only', mergeBase, o.head]) ?? '').split('\n').filter(Boolean);
  const releaseOutputs: string[] = Array.isArray(policy.release_outputs) ? policy.release_outputs : [];
  // touched: what marks the head as stamped (the labels only feed the length check below)
  const touched: string[] = changed.filter(f => f === 'VERSION');
  if (npmVersion(mergeBase) !== npmVersion(o.head)) touched.push('package.json version');
  const outputs = changed.filter(f => matchesAny(releaseOutputs, f));
  const baseVersion = show(base, 'VERSION') ?? '';
  if (!touched.length && outputs.length && typeof policy.release_tool === 'string') {
    // the head's VERSION is its merge base's (unchanged on this path); the base tip may have stamped since
    const regen = regeneratedAtBase({ repoRoot: o.repoRoot, head: o.head, baseVersion: show(mergeBase, 'VERSION') ?? '', tool: policy.release_tool, outputs });
    if (regen.kind === 'error') return { kind: 'invalid', reason: regen.reason };
    if (regen.kind === 'differs') touched.push(...regen.files);
  } else touched.push(...outputs);
  if (touched.length) {
    // A merge-step stamp commit has parents [pin, base]: the fragments it folded are the pin's own.
    const second = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.head}^2`])?.trim();
    const pin = second ? `${o.head}^1` : mergeBase;
    if (fragDir && (!second || git(o.repoRoot, ['merge-base', '--is-ancestor', second, base]) === null)) return { kind: 'invalid', reason: `under changelog_fragments only the merge step stamps (a commit with parents [pin, ${base}]); leave VERSION, package.json and the release outputs at the merge base's values and add a fragment` };
    const folded = fragDir ? readFragments(o.repoRoot, pin, fragDir, base, typeof policy.changelog === 'string' ? policy.changelog : 'CHANGELOG.md', 'skip') : null;
    if (folded?.errors.length) return { kind: 'invalid', reason: `${folded.errors[0]!.path}: ${folded.errors[0]!.message}` };
    const level = policy.bump === 'patch' ? 'patch' : 'micro';
    const expected = bumpVersion(baseVersion, folded ? effectiveBump(level, folded.fragments) : (policy.bump ?? 'patch'));
    return expected ? { kind: 'stamped', expected, fragments: !!fragDir } : { kind: 'invalid', reason: `${base}:VERSION is not a 4-part version` };
  }

  const file = typeof policy.changelog === 'string' ? policy.changelog : 'CHANGELOG.md';
  const exists = (rev: string) => git(o.repoRoot, ['cat-file', '-e', `${rev}:${file}`]) !== null;
  const read = (rev: string) => (exists(rev) ? show(rev, file) : '');
  const [beforeText, afterText] = [read(mergeBase), read(o.head)];
  if (beforeText === null || afterText === null) return { kind: 'invalid', reason: `cannot read ${file} at ${beforeText === null ? `the merge base ${mergeBase.slice(0, 12)}` : o.head}` };
  const before = parseChangelog(beforeText);
  const after = parseChangelog(afterText);
  const unreleased = after.sections.filter(s => s.unreleased);
  if (unreleased.length > 1) return { kind: 'invalid', reason: `${file} has ${unreleased.length} [Unreleased] sections` };
  if (unreleased.length === 1 && after.sections[0] !== unreleased[0]) return { kind: 'invalid', reason: `${file}: [Unreleased] must be the top section` };
  const kept = new Set(after.sections.filter(s => !s.unreleased).map(s => s.version));
  const dropped = before.sections.filter(s => !s.unreleased && !kept.has(s.version)).map(s => s.version);
  if (dropped.length) return { kind: 'invalid', reason: `${file} drops released heading ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? ` (+${dropped.length - 3})` : ''}; an unstamped head may only add its [Unreleased] section above the latest release` };
  const released = (c: typeof after) => [c.header.join('\n'), ...c.sections.filter(s => !s.unreleased).map(s => s.lines.join('\n'))];
  const was = released(before);
  const now = released(after);
  if (was.length !== now.length || was.some((text, i) => text !== now[i])) {
    return { kind: 'invalid', reason: `${file} changes text outside [Unreleased]; an unstamped head may only add or edit its [Unreleased] section` };
  }
  if (!fragDir) return { kind: 'unstamped' };
  const frags = readFragments(o.repoRoot, o.head, fragDir, mergeBase);
  if (frags.errors.length) return { kind: 'invalid', reason: `${frags.errors[0]!.path}: ${frags.errors[0]!.message}` };
  if (frags.fragments.length) return { kind: 'unstamped', fragments: frags.fragments.length, entry: 'fragment' };
  if (unreleased.length) return { kind: 'unstamped', fragments: 0, entry: 'unreleased' };
  if (/\[bot\]$/.test(o.author ?? '')) return { kind: 'unstamped', fragments: 0, entry: 'none-bot' };
  return { kind: 'invalid', reason: `add a CHANGELOG fragment: ${fragDir.replace(/\/+$/, '')}/<slug>.md with the entry text (the merge step folds it under the version it allocates)` };
}
