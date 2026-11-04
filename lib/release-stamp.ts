/**
 * release-stamp — versions at release under merge: direct (docs/ship-policy.md#release-stamp). PRs land unstamped,
 * carrying only a changelog.d fragment; a release PR on a `release/<version>` branch then moves VERSION, the
 * package.json version, the CHANGELOG (every fragment folded under the new heading), the release outputs and the
 * tentative stamp_paths mentions in one commit on the base (`gstack-restamp --release`). openRelease makes that PR
 * (bin/gstack-release-stamp); classifyRelease is the one test of "this head is the release stamp of its merge base"
 * that land --pin and the Version Gate both apply.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { effectiveBump, readFragments } from './changelog-fragments';
import { restamp, versionAtRef, type RestampResult } from './restamp';
import { matchesAny, type ShipPolicy } from './ship-policy';
import { buildReceipt } from './tree-receipt';
import { regeneratedAtBase } from './version-gate-train';
import { bumpVersion, cmpVersion, fmtVersion, parseVersion, versionWidth } from './version-source';

export const RELEASE_BRANCH = /^release\/(\d+(?:\.\d+){2,3})$/;

export type ReleaseVerdict = { ok: true; version: string; fragments: string[] } | { ok: false; reason: string };

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() };
}

/**
 * head is the release stamp of mergeBase: it deletes every fragment the merge base holds and adds none, its version
 * is the merge base's plus the effective bump of those fragments (what gstack-restamp --release allocates), and every
 * other change is a stamp by the tree receipt's rules (the CHANGELOG exactly the fragments folded under the new heading,
 * stamp_paths only version rewrites). A changed release output passes only when release_tool regenerates the same bytes
 * at the new version (GST-1176's rule, the Version Gate's regeneratedAtBase).
 */
export function classifyRelease(o: { repoRoot: string; policy: ShipPolicy; mergeBase: string; head: string }): ReleaseVerdict {
  const no = (reason: string): ReleaseVerdict => ({ ok: false, reason });
  const dir = o.policy.changelog_fragments?.dir.replace(/\/+$/, '');
  if (!dir) return no('the base policy has no changelog_fragments, so there is no release stamp to check');
  const [was, now] = [versionAtRef(o.repoRoot, o.mergeBase), versionAtRef(o.repoRoot, o.head)];
  if ('error' in was || 'error' in now) return no('error' in was ? was.error : (now as { error: string }).error);
  const status = git(o.repoRoot, ['diff', '--name-status', '--no-renames', o.mergeBase, o.head, '--', dir + '/']);
  if (!status.ok) return no(`cannot list the fragments ${o.head.slice(0, 12)} changes: ${status.err.split('\n')[0]}`);
  const rows = status.out.split('\n').filter(Boolean).map(l => l.split('\t') as [string, string]);
  const touched = rows.filter(([s]) => s !== 'D').map(([, p]) => p);
  if (touched.length) return no(`a release adds or edits no fragment, but this head changes ${touched.join(', ')}`);
  const atBase = readFragments(o.repoRoot, o.mergeBase, dir, null, o.policy.changelog);
  if (atBase.errors.length) return no(`${atBase.errors[0]!.path}: ${atBase.errors[0]!.message}`);
  if (!atBase.fragments.length) return no('the merge base holds no fragment, so there is nothing to release');
  const deleted = new Set(rows.map(([, p]) => p));
  const kept = atBase.fragments.filter(f => !deleted.has(f.path)).map(f => f.path);
  if (kept.length) return no(`a release folds every fragment on its merge base, but ${kept.join(', ')} stay`);
  const base = parseVersion(was.version)!;
  const w = versionWidth(was.version);
  const expected = fmtVersion(bumpVersion(base, effectiveBump(o.policy.bump === 'patch' ? 'patch' : 'micro', atBase.fragments), w), w);
  if (now.version !== expected || cmpVersion(parseVersion(now.version)!, base) <= 0) return no(`the head carries ${now.version}; the release of ${was.version} with these fragments is ${expected}`);
  const receipt = buildReceipt({ repoRoot: o.repoRoot, gated: o.mergeBase, current: o.head, policy: o.policy, policyLabel: 'base' });
  if ('error' in receipt) return no(receipt.error);
  const residual = receipt.files.filter(f => f.verdict === 'changed');
  const outside = residual.filter(f => !matchesAny(o.policy.release_outputs, f.path));
  if (outside.length) return no(`more than the stamp changed: ${outside.map(f => `${f.path} (${f.residual ?? f.rule})`).join(', ')}`);
  const outputs = residual.map(f => f.path);
  if (outputs.length) {
    if (!o.policy.release_tool) return no(`${outputs.join(', ')} changed and the policy names no release_tool to regenerate them`);
    const regen = regeneratedAtBase({ repoRoot: o.repoRoot, head: o.head, baseVersion: now.version, tool: o.policy.release_tool, outputs });
    if (regen.kind === 'error') return no(regen.reason);
    if (regen.kind === 'differs') return no(`${regen.files.join(', ')} is not what release_tool generates at ${now.version}`);
  }
  return { ok: true, version: now.version, fragments: atBase.fragments.map(f => f.path) };
}

export interface OpenOptions {
  repoRoot: string; base: string; dryRun?: boolean; now?: Date;
  gh?: (args: string[], cwd: string) => { ok: boolean; out: string; err: string };
}
export type OpenResult =
  | { ok: true; version: string; branch: string; head?: string; pr?: string; url?: string; lines: string[] }
  | { ok: false; code: NonNullable<RestampResult['code']>; message: string; lines: string[] };

const defaultGh = (args: string[], cwd: string) => {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
};

/**
 * Stamp a fresh worktree of origin/<base> with gstack-restamp --release, commit only the stamped files (detached, so no
 * local branch is left behind), force-push the commit to release/<version> (a reopen after RELEASE_STAMP_INVALID
 * replaces the old release branch) and open the release PR. The Captain lands it with gstack-ship-queue land --pr <n> --pin <head> once its
 * checks are green; the stable cut then tags the new version. --dry-run stamps and prints the diff, and creates nothing.
 */
export function openRelease(o: OpenOptions): OpenResult {
  const gh = o.gh ?? defaultGh;
  const lines: string[] = [];
  const fail = (code: NonNullable<RestampResult['code']>, message: string): OpenResult => ({ ok: false, code, message, lines });
  const fetch = git(o.repoRoot, ['fetch', '-q', 'origin', o.base]);
  if (!fetch.ok) return fail('RELEASE_STAMP_INVALID', `git fetch origin ${o.base} failed: ${fetch.err.split('\n')[0]}`);
  const baseSha = git(o.repoRoot, ['rev-parse', `origin/${o.base}`]).out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-release-stamp-'));
  fs.rmSync(dir, { recursive: true, force: true });
  const add = git(o.repoRoot, ['worktree', 'add', '--detach', '-q', dir, baseSha]);
  if (!add.ok) return fail('RELEASE_STAMP_INVALID', `cannot create the release worktree: ${add.err}`);
  try {
    const nm = path.join(o.repoRoot, 'node_modules');
    if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
    const stamp = restamp({ repoRoot: dir, base: o.base, release: true, policyFrom: 'base', allowRepoCommands: true, dryRun: !!o.dryRun, now: o.now });
    for (const s of stamp.stages) lines.push(`STAGE: ${s.name} ${s.status}${s.detail ? ` (${s.detail})` : ''}`);
    if (stamp.status === 'refused' || stamp.status === 'failed') return fail(stamp.code ?? 'RESTAMP_CONFLICT', stamp.message ?? 'the release stamp did not complete');
    const version = stamp.newVersion!;
    const branch = `release/${version}`;
    lines.push(`RELEASE: ${stamp.oldVersion} -> ${version} at origin/${o.base} ${baseSha.slice(0, 12)}`);
    if (o.dryRun) return { ok: true, version, branch, lines: [...lines, stamp.diff ?? ''] };
    const folded = /folded (.+?)(;|$)/.exec(stamp.stages.find(s => s.name === 'changelog')?.detail ?? '')?.[1] ?? 'see the CHANGELOG diff';
    for (const step of [['add', '-A', '--', ...(stamp.files ?? [])], ['commit', '-q', '-m', `v${version} release: fold the changelog fragments`]]) {
      const r = git(dir, step);
      if (!r.ok) return fail('RELEASE_STAMP_INVALID', `git ${step[0]} failed in the release worktree: ${r.err.split('\n')[0]}`);
    }
    const head = git(dir, ['rev-parse', 'HEAD']).out;
    const push = git(dir, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    if (!push.ok) return fail('RELEASE_STAMP_INVALID', `git push origin ${branch} failed: ${push.err.split('\n')[0]}`);
    lines.push(`PUSHED: ${branch} ${head}`);
    const body = [
      `Release stamp for v${version}, made by \`gstack-release-stamp open\` (\`gstack-restamp --release\`) on origin/${o.base} ${baseSha.slice(0, 12)}: VERSION, the package.json version, the CHANGELOG and the release outputs.`,
      '', `Folds: ${folded}`, '',
      `Land it with \`gstack-ship-queue land --pr <this PR> --pin ${head}\` once its checks are green. land checks that this head is exactly the release stamp of its merge base (RELEASE_STAMP_INVALID otherwise), so a release PR needs no /ship receipt.`,
    ].join('\n');
    const pr = gh(['pr', 'create', '--base', o.base, '--head', branch, '--title', `v${version} release`, '--body', body], dir);
    if (!pr.ok) return fail('RELEASE_STAMP_INVALID', `gh pr create failed (${pr.err.trim().split('\n')[0]}); ${branch} is pushed, so open its PR by hand`);
    const url = pr.out.trim().split('\n').pop() ?? '';
    const n = /\/pull\/(\d+)/.exec(url)?.[1];
    lines.push(`RELEASE_PR: ${n ? `#${n} ` : ''}${url}`, `NEXT: gstack-ship-queue land --pr ${n ?? '<n>'} --pin ${head} once its checks are green`);
    return { ok: true, version, branch, head, pr: n, url, lines };
  } finally {
    git(o.repoRoot, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
    git(o.repoRoot, ['worktree', 'prune']);
  }
}
