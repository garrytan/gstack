/**
 * squash-message — the commit a PR lands as (R76 as amended 2026-11-15, docs/writing-prs.md#the-commit-on-main). The
 * subject is the PR title with GitHub's ` (#n)` suffix; the body is the PR body's visible opening (at most three lines
 * and 600 characters, the part above the first fold) followed by every distinct `Key: value` trailer the branch's
 * commits carry (Co-authored-by, Removed-test and the rest) plus a Co-authored-by for every commit author other than
 * the first, so main's one-line log reads as a list of changes and credit survives the squash. A MEDIUM redaction
 * finding drops the opening and keeps the trailers; a HIGH one refuses the land. Commits of a stacked parent that already landed are left out (landedStackParent), and the
 * whole message passes the shared redaction scan before gh sees it. Every gstack merge (land --pin, the stamping
 * land --pr, train land) builds its message here and picks its method with landMethod.
 */
import { spawnSync } from 'node:child_process';
import type { ShipPolicy } from './ship-policy';
import { AGENT_NOTES_MARKER } from './agent-notes';
import { foldSections, unfoldSections, visibleOpening, VISIBLE_CHARS, VISIBLE_LINES } from './pr-body-shape';
import { scan, type RepoVisibility } from './redact-engine';
import { landedStackParent } from './ship-receipt';

export interface LandMessage { subject: string; body: string; method: 'merge' | 'squash'; why: string; skippedParent: string | null }

const git = (root: string, args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

/** Text wrapped at 72 columns between words, the width git log and GitHub's commit view expect. */
const wrap = (text: string) => text.split(' ').reduce<string[]>((lines, w) => { const last = lines.at(-1); if (last !== undefined && [...last].length + 1 + [...w].length <= 72) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w); return lines; }, []).join('\n');

/** The body's visible opening, at most VISIBLE_LINES lines and VISIBLE_CHARS characters, cut between lines (a first line that alone is too long is cut short), links reduced to their text and each line wrapped at 72. */
export function openingLines(body: string): string {
  const out: string[] = [];
  for (const line of visibleOpening(foldSections(body), true).slice(0, VISIBLE_LINES).map(l => l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if ([...[...out, line].join('\n\n')].length <= VISIBLE_CHARS) { out.push(line); continue; }
    if (!out.length) out.push([...line].slice(0, VISIBLE_CHARS - 1).join('') + '…');
    break;
  }
  return out.map(wrap).join('\n\n');
}

/** Every distinct trailer git's own parser finds on the non-merge commits in from..to, oldest first (the first spelling wins); null when git cannot read the range. */
export function branchTrailers(root: string, from: string, to: string): string[] | null {
  const r = git(root, ['log', '--reverse', '--no-merges', '--format=%(trailers:only,unfold)', `${from}..${to}`]);
  if (r.status !== 0) return null;
  const authors = git(root, ['log', '--reverse', '--no-merges', '--format=%an <%ae>', `${from}..${to}`]);
  if (authors.status !== 0) return null;
  const others = authors.stdout.split('\n').filter(Boolean).filter((a, _, all) => a !== all[0]).map(a => `Co-authored-by: ${a}`);
  const seen = new Map<string, string>();
  for (const line of [...r.stdout.split('\n').map(l => l.trim()), ...others]) if (/^[A-Za-z][A-Za-z0-9-]*: \S/.test(line) && !seen.has(line.toLowerCase())) seen.set(line.toLowerCase(), line);
  return [...seen.values()];
}

/** merge under history: merge-only or when the PR changes a land.merge_commit_paths pathspec (a commit a receipt points to must stay on the base); squash otherwise. */
export function landMethod(root: string, policy: Pick<ShipPolicy, 'history' | 'land'>, mergeBase: string, pin: string): { method: 'merge' | 'squash'; why: string } {
  if (policy.history === 'merge-only') return { method: 'merge', why: 'history: merge-only' };
  const paths = policy.land?.merge_commit_paths ?? [];
  if (!paths.length) return { method: 'squash', why: `history: ${policy.history}` };
  const r = git(root, ['diff', '--name-only', mergeBase, pin, '--', ...paths.map(p => `:(glob)${p}`)]);
  if (r.status !== 0) return { method: 'merge', why: 'git could not read the changed paths, so land.merge_commit_paths may match' };
  const hit = r.stdout.split('\n').find(Boolean);
  return hit ? { method: 'merge', why: `land.merge_commit_paths matches ${hit}` } : { method: 'squash', why: 'no land.merge_commit_paths match' };
}

/**
 * The subject and body `gh pr merge` gets. `override` (land --body-file) replaces the opening, never the trailers.
 * Refuses (error) when git cannot read the branch's commits or the message holds a HIGH redaction finding.
 */
export function landMessage(root: string, o: { pr: string; title: string; prBody: string; mergeBase: string; pin: string; tip: string; policy: Pick<ShipPolicy, 'history' | 'land'>; override?: string; visibility?: RepoVisibility }): LandMessage | { error: string } {
  const parent = landedStackParent(root, { rangeBase: o.mergeBase, reviewed: o.pin, currentBase: o.tip }, ['.']);
  const trailers = branchTrailers(root, parent ?? o.mergeBase, o.pin);
  if (!o.title.trim()) return { error: `#${o.pr} has no title to use as the commit subject` };
  if (!trailers) return { error: `git cannot read #${o.pr}'s commits ${(parent ?? o.mergeBase).slice(0, 12)}..${o.pin.slice(0, 12)}` };
  const subject = `${o.title.trim()} (#${o.pr})`;
  const opening = o.override?.trim() ?? openingLines(o.prBody);
  const findings = (text: string) => scan(text, { repoVisibility: o.visibility ?? 'unknown' }).findings;
  const high = findings([subject, opening, ...trailers].join('\n\n')).filter(f => f.severity === 'HIGH');
  if (high.length) return { error: `the merge commit message holds ${high.map(f => f.id).join(', ')}; nothing merged` };
  const kept = opening && findings(opening).some(f => f.severity === 'MEDIUM') ? '' : opening;
  return { subject, body: [kept, trailers.join('\n')].filter(Boolean).join('\n\n'), ...landMethod(root, o.policy, o.mergeBase, o.pin), skippedParent: parent };
}

/** The text of a body's `## <title>` section, or of its fold with that summary; '' when it has none. A release PR's squash body is its Release notes section. */
export function sectionText(body: string, title: string): string {
  const lines = unfoldSections(body).split('\n');
  const start = lines.findIndex(l => l.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && (/^## /.test(l) || l.trim() === AGENT_NOTES_MARKER));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** What land prints before it merges: the method (and why), the subject, each body line, and a skipped stacked parent. */
export const messageLines = (m: LandMessage): string[] => [`METHOD: ${m.method} (${m.why})`, `SUBJECT: ${m.subject}`, ...m.body.split('\n').map(l => `BODY: ${l}`), ...(m.skippedParent ? [`STACK_PARENT: ${m.skippedParent.slice(0, 12)} already landed; its commits' trailers are left out`] : [])];

/** The gh pr merge argv for a message: the method, the exact head, and for a merge or squash the subject and body. */
export const mergeArgs = (pr: string, head: string, m: LandMessage): string[] => ['pr', 'merge', pr, `--${m.method}`, '--match-head-commit', head, '--subject', m.subject, '--body', m.body];
