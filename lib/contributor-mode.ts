/**
 * contributor-mode — is this PR's author a maintainer, and what does /review
 * do when not (plan E3, decision D10). Detection order, source recorded in
 * the output: `--contributor` (flag) › the explicit `maintainers` list in
 * .gstack/ship-policy.json (policy) › repository push permission through the
 * collaborators API (collaborators) › off. CODEOWNERS is file ownership, not
 * maintenance authority, and is never read. When the mode is on, the bin
 * prints the evidence-first review instructions so the review skeleton pays
 * two lines, not a section: the table (evidence value, risk surfaces,
 * accept / supersede / decline) and the credit-line rule.
 */
import { spawnSync } from 'node:child_process';
import { sha256Hex, writeReceipt } from './egress-receipt';
import type { ResultCodeName } from './result-codes';

export type ContributorSource = 'flag' | 'policy' | 'collaborators' | 'off';
export interface ContributorDetection {
  mode: 'on' | 'off'; author: string | null; source: ContributorSource;
  detail: string; permission?: string | null; error?: { code: ResultCodeName; message: string };
}

/** `gh pr view` for the author login; null when gh cannot answer. */
export function prAuthor(cwd: string, pr?: number): { author: string } | { error: string } {
  const args = ['pr', 'view', ...(pr !== undefined ? [String(pr)] : []), '--json', 'author'];
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { error: (r.stderr ?? '').trim() || 'gh pr view failed' };
  try {
    const parsed = JSON.parse(r.stdout) as { author?: { login?: string } };
    return parsed.author?.login ? { author: parsed.author.login } : { error: 'PR has no author login' };
  } catch (e: any) { return { error: e.message }; }
}

/** `GET /repos/{owner}/{repo}/collaborators/{user}/permission` through gh; receipted before the call (fail-open). */
export function pushPermission(cwd: string, author: string, env: NodeJS.ProcessEnv = process.env): { permission: string } | { error: string } {
  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (repo.status !== 0) return { error: (repo.stderr ?? '').trim() || 'gh repo view failed (not logged in?)' };
  const nameWithOwner = repo.stdout.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner) || !/^[A-Za-z0-9-]{1,39}$/.test(author)) return { error: `unexpected repo ${nameWithOwner} or login ${author}` };
  const endpoint = `repos/${nameWithOwner}/collaborators/${author}/permission`;
  try {
    writeReceipt({ sink: 'contributor-mode', host: 'api.github.com', payloadClass: 'collaborator-permission-query', bytes: 0, sha256: sha256Hex(endpoint), consent: 'user ran /review (or gstack-contributor-mode detect) on a pull request; the query carries the repo name and the author login only', env });
  } catch (err) {
    process.stderr.write(`[contributor-mode] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);
  }
  const r = spawnSync('gh', ['api', endpoint, '--jq', '.permission'], { cwd, encoding: 'utf8', timeout: 60_000, env });
  if (r.status !== 0) return { error: (r.stderr ?? '').trim() || 'gh api failed' };
  return { permission: r.stdout.trim() || 'none' };
}

export interface DetectOptions {
  cwd: string; author?: string; pr?: number; force?: boolean; maintainers: string[]; policySource: string;
  resolveAuthor?: () => { author: string } | { error: string };
  resolvePermission?: (author: string) => { permission: string } | { error: string };
}

export function detectContributorMode(o: DetectOptions): ContributorDetection {
  const author = o.author ?? (() => { const r = (o.resolveAuthor ?? (() => prAuthor(o.cwd, o.pr)))(); return 'author' in r ? r.author : null; })();
  if (o.force) return { mode: 'on', author, source: 'flag', detail: '--contributor given' };
  if (!author) return { mode: 'off', author: null, source: 'off', detail: 'no PR author resolvable (no open PR for this branch, or gh unavailable)', error: { code: 'CONTRIBUTOR_SOURCE_UNAVAILABLE', message: 'author unknown' } };
  if (o.maintainers.length) {
    const inside = o.maintainers.some(m => m.toLowerCase() === author.toLowerCase());
    return { mode: inside ? 'off' : 'on', author, source: 'policy', detail: `${author} is ${inside ? 'in' : 'outside'} maintainers (${o.policySource})` };
  }
  const perm = (o.resolvePermission ?? (a => pushPermission(o.cwd, a)))(author);
  if ('error' in perm) return { mode: 'off', author, source: 'off', detail: `no maintainers list and the collaborators API did not answer: ${perm.error}`, permission: null, error: { code: 'CONTRIBUTOR_SOURCE_UNAVAILABLE', message: perm.error } };
  const canPush = ['admin', 'maintain', 'write'].includes(perm.permission);
  return { mode: canPush ? 'off' : 'on', author, source: 'collaborators', detail: `${author} has ${perm.permission} permission (push ${canPush ? 'yes' : 'no'})`, permission: perm.permission };
}

export function renderDetection(d: ContributorDetection): string {
  return `CONTRIBUTOR_MODE: ${d.mode} author=${d.author ?? 'unknown'} source=${d.source}${d.permission !== undefined && d.permission !== null ? ` permission=${d.permission}` : ''} — ${d.detail}`;
}

/** The instructions /review follows when the mode is on; printed by the bin so the skeleton stays small. */
export const CONTRIBUTOR_INSTRUCTIONS = `CONTRIBUTOR-PR MODE (outside author; evidence first)
Judge the PR as evidence before judging it as code. Produce this table in the report, one row per distinct change (a diagnosis, a test, a fix, a refactor):

| Change | Evidence value | Risk surfaces | Decision |
|---|---|---|---|
| <file or behavior> | <what it proves: a reproduced bug, a failing test, a measured regression; or "claim only"> | <trust boundary, data loss, spend, public API, generated files> | accept \\| supersede \\| decline |

Decisions:
- accept: the implementation is correct by the same bar as a maintainer change (Step 4 findings, tests, gate integrity); it lands as-is after fixes. Never a lower bar, never a higher one.
- supersede: the diagnosis or test is right but the implementation is not the one this repo would write; rewrite it from our own plan AFTER a plain-language approval from the user ("supersede #<n>: <one sentence why>"), never silently.
- decline: no evidence carried over; say what evidence would change the decision.
Credit lines are emitted only when a diagnosis or a test carried over into what lands: \`Contributed by @<handle>\` in the PR body, \`Co-Authored-By: <name> <email>\` on the commit when their code is kept, \`Supersedes #<n>\` in the PR body when ours replaces theirs. No carried-over evidence, no credit line; never invent one.
Record in the review log: contributor_mode=on, source (flag, policy, collaborators), author, and each row's decision.`;
