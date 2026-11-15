/**
 * Release notes for a cut (crew/scripts/release-cut.ts, docs/releases.md#release-notes): every change in the
 * CHANGELOG versions a release ships, one line each, grouped under What's new, Fixes and Changes for
 * maintainers, with a link to the pull request that made it.
 *
 * A change is a top-level bullet of a version's section, or a paragraph when it is not a bullet. Its line is
 * the bullet's bold lead when that lead is a sentence, else its first sentence, with internal issue codes in
 * parentheses dropped. Its pull request is read from git (changeSources): the commit that added the
 * changelog.d fragment holding the change (wherever that commit sits, since a release can fold fragments that
 * landed before the previous one), or, for a version written straight into the CHANGELOG, the commit
 * that added the version's heading; a release commit (a "v<version> release" subject) links nothing.
 * Its group comes from the heading it sits under ("### Fixed", "### Added", "### Tests" and the like, read
 * inside its fragment when it has one), else from the files its pull request touched (only tests, CI and
 * gstack's own release tooling: maintainers), else from its words (internal shipping machinery: maintainers;
 * "no longer", "again", "fix": a fix; anything else is new). A span with no version, or a version with no
 * change, refuses the notes instead of publishing a stub.
 */
import { parseFragment } from '../../lib/changelog-fragments';
import type { Exception, Git } from './release-cut';

export const NOTES_CAP = 60_000;

export interface Change { text: string; heading: string }
export interface ChangelogEntry { version: string; date: string; changes: Change[] }
/** Where a change came from: its pull request (null when no commit names one) and the files that commit touched. */
export interface ChangeSource { pr: number | null; files: string[]; text: string }
export interface NotesSources { fragments: ChangeSource[]; versions: Record<string, ChangeSource> }
export interface NotesInput { repo: string; version: string; date: string; prevVersion: string | null; prevTag: string | null; entries: ChangelogEntry[]; hotfix: boolean; first?: boolean; exception?: Exception | null; sources?: NotesSources }
export type Notes = { ok: true; body: string; versions: number } | { ok: false; why: string };
type Group = 'new' | 'fix' | 'maintainers';

const GROUPS: Array<[Group, string]> = [['new', "What's new"], ['fix', 'Fixes'], ['maintainers', 'Changes for maintainers']];
export const KIND_LABEL = { security: 'Security', regression: 'Regression' } as const;
const HEADING_GROUP: Array<[RegExp, Group]> = [
  [/^(tests?|testing|ci|for contributors|contributors|internal|maintainers?|chores?|infrastructure)\b/i, 'maintainers'],
  [/^(fixed|fixes|bug ?fixes|security)\b/i, 'fix'],
  [/^(added|new|features?)\b/i, 'new'],
];
const NEUTRAL_PATH = /^(changelog\.d\/|CHANGELOG\.md$|VERSION$|package\.json$|bun\.lock$)/;
const MAINTAINER_PATH = /^(test\/|crew\/|\.github\/|evals?\/|CONTRIBUTING\.md$|TODOS\.md$|docs\/TESTING)/;
const MAINTAINER_WORDS = /\b(test suite|flaky|CI|evals?|receipts?|pregate|ship-queue|merge trains?|carry|lander|release gate|backstop|fix-checks?|stamps?|review plan|review log)\b/i;
const FIX_WORDS = /\b(no longer|again|fix(es|ed)?|broken|regression|crash(es|ed)?|bug)\b|instead of (failing|refusing|crashing|stopping)/i;
const STAMP_SUBJECT = /^v\d+(\.\d+)+ release\b/;

/** Four-part versions compare numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The changes in a run of CHANGELOG lines: top-level bullets with their continuation lines, and plain paragraphs. */
export function changesIn(lines: string[]): Change[] {
  const changes: Change[] = [];
  let heading = '', open: Change | null = null, blank = false, fence = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#{3,}\s/.test(l)) { heading = l.replace(/^#+\s*/, '').trim(); open = null; continue; }
    if (!l.trim()) { blank = true; continue; }
    const wasBlank = blank;
    blank = false;
    if (/^[-*] /.test(l)) { open = { text: l.slice(2).trim(), heading }; changes.push(open); continue; }
    if (/^\s*\|/.test(l) || /^\s*<\/?(details|summary)/i.test(l)) { open = null; continue; }
    if (open && (/^\s/.test(l) || !wasBlank)) { open.text += ' ' + l.trim(); continue; }
    open = { text: l.trim(), heading };
    changes.push(open);
  }
  return changes;
}

/** Every "## [X.Y.Z.W] - date" section of a CHANGELOG with its changes. */
export function changelogEntries(text: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^## \[(\d+(?:\.\d+)+)\](?: - (\S+))?/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.startsWith('## ')) j++;
    out.push({ version: m[1]!, date: m[2] ?? '', changes: changesIn(lines.slice(i + 1, j)) });
    i = j - 1;
  }
  return out;
}

function firstSentence(text: string): string {
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '`') code = !code;
    if (code || !'.!?'.includes(c)) continue;
    const rest = text.slice(i + 1);
    if (/^["')*]*$/.test(rest) || /^["')*]*\s+["'(\[*`]*[A-Z0-9/@`]/.test(rest)) return text.slice(0, i + 1) + (/^["')*]+/.exec(rest)?.[0] ?? '');
  }
  return text;
}

/** One line for a change: its bold lead when that is a sentence, else its first sentence, markdown bold and internal codes removed. */
export function changeLine(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  const lead = bold && /[.!?]["')`]*$/.test(bold[1]!.trim()) ? bold[1]! : firstSentence(text);
  return lead.replace(/\*\*/g, '')
    .replace(/\s*\((?:[A-Z][A-Z0-9]*-\d+)[^()]*\)/g, '')
    .replace(/\b([Oo])utside voice/g, (_, o: string) => (o === 'O' ? 'S' : 's') + 'econd-model review')
    .replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

const norm = (s: string) => s.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function prOf(subject: string): number | null {
  const squash = [...subject.matchAll(/\(#(\d+)\)/g)].at(-1);
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  return squash ? Number(squash[1]) : merge ? Number(merge[1]) : null;
}

/**
 * The pull requests behind the changes released in from..to, read along main's first-parent history. Fragments: every
 * changelog.d file a commit in the range added or deleted (a release folds and deletes fragments that may have landed
 * before the previous release), each with the pull request and files of the commit that added it. Versions: the commit
 * in the range that added each "## [version]" heading of the CHANGELOG. No from (a first release) reads nothing.
 */
export function changeSources(git: Git, from: string | null, to: string): NotesSources {
  const out: NotesSources = { fragments: [], versions: {} };
  if (!from) return out;
  const range = ['--first-parent', '--diff-merges=first-parent', '--no-renames', from + '..' + to];
  const log = git(['log', '--format=%x00%H%x09%s', '--name-status', ...range]);
  if (!log.ok) return out;
  const commits = new Map<string, { pr: number | null; stamp: boolean; files: string[] }>();
  const fragments = new Set<string>();
  for (const block of log.out.split('\0').filter(b => b.trim())) {
    const [head, ...rest] = block.split('\n');
    const [sha, subject = ''] = head!.split('\t');
    const status = rest.filter(l => l.trim()).map(l => l.split('\t'));
    commits.set(sha!, { pr: prOf(subject), stamp: STAMP_SUBJECT.test(subject), files: status.map(s => s.at(-1)!) });
    for (const [kind, file] of status) if ((kind === 'A' || kind === 'D') && /^changelog\.d\/[^/]+\.md$/.test(file!) && file !== 'changelog.d/README.md') fragments.add(file!);
  }
  for (const file of fragments) {
    const added = git(['log', '-1', '--diff-merges=first-parent', '--diff-filter=A', '--format=%H%x09%s', to, '--', file]);
    const [sha, subject = ''] = added.ok ? added.out.split('\t') : [];
    if (!sha) continue;
    const files = git(['show', '--diff-merges=first-parent', '--no-renames', '--format=', '--name-only', sha]);
    const shown = git(['show', sha + ':' + file]);
    const parsed = shown.ok ? parseFragment(file, shown.out) : null;
    if (parsed && 'body' in parsed) out.fragments.push({ pr: prOf(subject), files: files.ok ? files.out.split('\n').filter(Boolean) : [], text: parsed.body });
  }
  const headings = git(['log', '--format=%x00%H', '-p', '--unified=0', ...range, '--', 'CHANGELOG.md']);
  if (headings.ok) for (const block of headings.out.split('\0').filter(b => b.trim())) {
    const c = commits.get(block.slice(0, 40));
    if (!c || c.stamp) continue;
    for (const m of block.matchAll(/^\+## \[(\d+(?:\.\d+)+)\]/gm)) out.versions[m[1]!] = { pr: c.pr, files: c.files, text: '' };
  }
  return out;
}

function groupOf(line: string, heading: string, files: string[]): Group {
  const byHeading = HEADING_GROUP.find(([re]) => re.test(heading));
  if (byHeading) return byHeading[1];
  const own = files.filter(f => !NEUTRAL_PATH.test(f));
  if (own.length && own.every(f => MAINTAINER_PATH.test(f))) return 'maintainers';
  if (MAINTAINER_WORDS.test(line)) return 'maintainers';
  return FIX_WORDS.test(line) ? 'fix' : 'new';
}

export function releaseKind(hotfix: boolean, exception: Exception | null | undefined): 'security' | 'regression' | 'hotfix' | 'regular' {
  return exception ? exception.kind : hotfix ? 'hotfix' : 'regular';
}

/** The release notes for versions in (prevVersion, version], or why there are none to publish. */
export function releaseNotes(n: NotesInput): Notes {
  const span = n.entries.filter(e => compareVersions(e.version, n.version) <= 0 && (!n.prevVersion || compareVersions(e.version, n.prevVersion) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!span.length) return { ok: false, why: 'CHANGELOG.md at the release has no entry for v' + n.version + (n.prevVersion ? ' or any version since v' + n.prevVersion : '') };
  const sources = n.sources ?? { fragments: [], versions: {} };
  const grouped: Record<Group, string[]> = { new: [], fix: [], maintainers: [] };
  const empty: string[] = [];
  for (const e of span) {
    let lines = 0;
    for (const c of e.changes) {
      const line = changeLine(c.text);
      if (!line) continue;
      const key = norm(c.text).slice(0, 160);
      const fragment = sources.fragments.find(f => norm(f.text).includes(key));
      const own = fragment ? changesIn(fragment.text.split('\n')).find(fc => norm(fc.text).startsWith(key)) : undefined;
      const from = fragment ?? sources.versions[e.version];
      const pr = from?.pr ? ' ([#' + from.pr + '](https://github.com/' + n.repo + '/pull/' + from.pr + '))' : '';
      grouped[groupOf(line, fragment ? own?.heading ?? '' : c.heading, from?.files ?? [])].push('- ' + line + pr);
      lines++;
    }
    if (!lines) empty.push('v' + e.version);
  }
  if (empty.length) return { ok: false, why: 'no change to list in the CHANGELOG entry of ' + empty.join(', ') + '; write the entry before cutting the release' };
  const kind = releaseKind(n.hotfix, n.exception);
  const changelogUrl = 'https://github.com/' + n.repo + '/blob/v' + n.version + '/CHANGELOG.md';
  const plural = span.length === 1 ? '' : 's';
  const body = [
    '## gstack v' + n.version + (kind === 'regular' ? '' : ' (' + kind + ' release)'),
    '',
    ...(n.exception ? ['**' + KIND_LABEL[n.exception.kind] + ' release:** `' + n.exception.reason + '` (verified: ' + n.exception.evidence + '). Every version since the previous release ships with it.', ''] : []),
    ...(n.first || !n.prevVersion ? ['First tagged release: the ' + span.length + ' version' + plural + (n.prevVersion ? ' since v' + n.prevVersion : '') + '; the [full changelog](' + changelogUrl + ') has every earlier one.', ''] : []),
    ...GROUPS.filter(([g]) => grouped[g].length).flatMap(([g, title]) => ['### ' + title, '', ...grouped[g], '']),
    (n.prevTag ? '[Compare ' + n.prevTag + '...v' + n.version + '](https://github.com/' + n.repo + '/compare/' + n.prevTag + '...v' + n.version + ') · ' : '') + '[Full changelog](' + changelogUrl + ')',
    '',
  ].join('\n');
  if (body.length > NOTES_CAP) return { ok: false, why: 'the notes for ' + span.length + ' version' + plural + ' run to ' + body.length + ' characters, over the ' + NOTES_CAP + ' cap; cut a release more often or split the span with --ref' };
  return { ok: true, body, versions: span.length };
}
