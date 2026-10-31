/**
 * review-brief — every /ship reviewer brief rendered from its section's own bytes (GSTA-167
 * no-loss gate). The text comes from ship/sections/review-army.md and ship/sections/adversarial.md
 * at render time, cut out between fixed anchors; only the declared slots below are filled. The
 * dispatch program passes the rendered file verbatim as the reader's prompt, and
 * lib/review-ledger.ts proves it did by hash. Nothing here is composed by the model.
 *
 * Slots by role:
 *   specialist          name, checklist, diff_base, exclude, stack, test_fw, learnings (security adds the defensive framing)
 *   specialist-batched  checklists (comma list), diff_base, exclude, stack, test_fw, learnings
 *   red-team            checklist, diff_base, findings (the merged specialist lines), specialists (their count)
 *   adversarial-native  diff_base
 *   outside-voice       diff_base, diff (the branch diff, which the bin reads from git)
 *   fix-check           fix_list, hunks, tests, callers (scripts/resolvers/fix-check.ts)
 *   targeted            classes, brief (review/specialists/targeted.md's text), checklist (its path), diff_base, stack, test_fw, learnings
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderFixCheckPrompt } from '../scripts/resolvers/fix-check';
import { parseClassList, targetedBrief } from './review-targeted';

export const BRIEF_ROLES = ['specialist', 'specialist-batched', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', 'targeted'] as const;
export type BriefRole = typeof BRIEF_ROLES[number];
export type Slots = Record<string, string | undefined>;

/** The hash every brief and every dispatched prompt is compared by: sha256 of the text without trailing whitespace. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex');
}

export class BriefError extends Error {}

/** The text strictly between start and end, end searched after start; both anchors are required. */
function between(text: string, start: string, end: string, what: string): string {
  const i = text.indexOf(start);
  if (i < 0) throw new BriefError(`${what}: start anchor not found in the section (${JSON.stringify(start.slice(0, 40))})`);
  const j = text.indexOf(end, i + start.length);
  if (j < 0) throw new BriefError(`${what}: end anchor not found in the section (${JSON.stringify(end.slice(0, 40))})`);
  return text.slice(i + start.length, j);
}
/** A quoted prompt body as the reader receives it: the section escapes its inner quotes and line breaks. */
const unquote = (s: string) => s.replace(/\\"/g, '"').replace(/\\n/g, '\n');

export interface SectionTexts { specialist: string; framing: string; fixtures: string; redTeam: string; native: string; outside: string }

/** Cut every brief body out of the installed sections under root (the directory holding ship/). */
export function sectionTexts(root: string): SectionTexts {
  const read = (rel: string) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { throw new BriefError(`cannot read ${rel} under ${root}`); }
  };
  const army = read('ship/sections/review-army.md');
  const adv = read('ship/sections/adversarial.md');
  const specialist = unquote(between(army, '\n"You are a specialist code reviewer.', 'Past learnings: {learnings or \'none\'}"', 'specialist brief'));
  return {
    specialist: `You are a specialist code reviewer.${specialist}Past learnings: {learnings or 'none'}`
      .replace(/ \(`<diff-base>`: write the sha in before dispatch[\s\S]*?on `DIFF_EXCLUDE: none`\)/, ''),
    framing: unquote(between(army, 'Begin the prompt with:\n"', '"\nand replace its full-diff command', 'defensive framing')),
    fixtures: unquote(between(army, 'and replace its full-diff command with: "', '"\nEvery other specialist', 'fixture handling')),
    redTeam: unquote(between(army, 'fixture handling from item 4 of the specialist dispatch: "', 'don\'t cover."', 'red-team brief')) + 'don\'t cover.',
    native: unquote(between(adv, 'Subagent prompt:\n"', '"\n\nPresent findings', 'adversarial-native brief')),
    outside: unquote(between(adv, 'Outside prompt (supply repository context from the parent):\n\n"', '"\n\nWrite the **complete prompt and context**', 'outside-voice brief')),
  };
}

const SHA = /^[0-9a-f]{7,40}$/;
const FENCE = '`'.repeat(3);
function need(slots: Slots, key: string): string {
  const v = slots[key];
  if (v === undefined || v === '') throw new BriefError(`missing slot ${key}`);
  return v;
}
function fill(text: string, pairs: Array<[string, string]>, what: string): string {
  let out = text;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new BriefError(`${what}: placeholder ${from} is not in the section text (the section changed; update lib/review-brief.ts)`);
    out = out.split(from).join(to);
  }
  return out;
}
const SPECIALIST_DIFF = 'run\n`DIFF_BASE=<diff-base> && git diff "$DIFF_BASE" <exclude>` to get the diff';

const PLACEHOLDERS = ['<diff-base>', '<exclude>', '<base>', '{checklist path}', '{STACK}', '{TEST_FW}', '{merged findings summary}', '{red-team checklist path}', '{learnings'];

/** Render one reader's brief. Throws BriefError on a missing slot, a section that no longer carries an anchor or placeholder, or a placeholder left unfilled. */
export function renderBrief(role: BriefRole, slots: Slots, t: SectionTexts): string {
  const text = renderRole(role, slots, t);
  const left = role === 'fix-check' || role === 'outside-voice' ? [] : PLACEHOLDERS.filter(p => text.includes(p));
  if (left.length) throw new BriefError(`${role}: unfilled placeholder ${left.join(', ')}`);
  return text;
}

function renderRole(role: BriefRole, slots: Slots, t: SectionTexts): string {
  const diffBase = role === 'fix-check' ? '' : need(slots, 'diff_base');
  if (diffBase && !SHA.test(diffBase)) throw new BriefError(`slot diff_base must be a literal commit sha, got ${JSON.stringify(diffBase)}`);
  const common = (body: string, checklist: string) => fill(body, [
    ...(checklist ? [['{checklist path}', checklist] as [string, string]] : []), ['<diff-base>', diffBase],
    ['{TEST_FW}', slots.test_fw || 'unknown'], ['{STACK}', slots.stack || 'unknown'], ['{learnings or \'none\'}', slots.learnings?.trim() || 'none'],
  ], role).split(' <exclude>`').join(slots.exclude ? ' ' + slots.exclude + '`' : '`');
  switch (role) {
    case 'specialist': {
      const name = need(slots, 'name');
      const checklist = need(slots, 'checklist');
      if (name !== 'security') return common(t.specialist, checklist);
      const body = fill(t.specialist, [[SPECIALIST_DIFF, 'set `DIFF_BASE=<diff-base>` first. ' + t.fixtures + ' Then read the diff that way']], role);
      return `${t.framing}\n\n${common(body, checklist)}`;
    }
    case 'specialist-batched': {
      const lists = need(slots, 'checklists').split(',').map(s => s.trim()).filter(Boolean);
      const body = fill(t.specialist, [['Read the checklist at {checklist path}', `Read each checklist at ${lists.join(', ')} (tag each finding's "specialist" with the name of the checklist it came from)`]], role);
      return common(body, '');
    }
    case 'red-team': {
      const body = fill(t.redTeam, [['{merged findings summary}', (slots.findings ?? '').trim() || '(none)'], ['by N specialists', `by ${need(slots, 'specialists')} specialists`],
        ['{red-team checklist path}', need(slots, 'checklist')], ['<diff-base>', diffBase]], role);
      return `${t.framing}\n\n${t.fixtures}\n\n${body}`;
    }
    case 'adversarial-native':
      return fill(t.native, [['DIFF_BASE=$(git merge-base origin/<base> HEAD)', `DIFF_BASE=${diffBase}`]], role);
    case 'outside-voice': {
      const body = fill(t.outside, [['DIFF_BASE=$(git merge-base origin/<base> HEAD)', `DIFF_BASE=${diffBase}`]], role);
      return [body, '', `## Branch diff (git diff ${diffBase})`, FENCE + 'diff', (slots.diff ?? '').trim(), FENCE].join('\n');
    }
    case 'targeted': {
      const classes = parseClassList(need(slots, 'classes'));
      if (!classes?.length) throw new BriefError(`slot classes must list money, gate, auth or secret, got ${JSON.stringify(slots.classes)}`);
      let brief: string;
      try { brief = targetedBrief(need(slots, 'brief'), classes); } catch (e) { throw new BriefError((e as Error).message); }
      const body = fill(t.specialist, [['Read the checklist at {checklist path}', `Read the targeted brief above (${need(slots, 'checklist')}: ${classes.join(', ')})`]], role);
      return `${brief}\n\n${common(body, '')}`;
    }
    case 'fix-check':
      return renderFixCheckPrompt({ fixList: need(slots, 'fix_list'), touchedHunks: need(slots, 'hunks'), testResults: need(slots, 'tests'), callers: slots.callers ?? '' });
  }
}

/**
 * The closing paragraph every dispatched brief carries (GST-482): a reader on a shared machine starts in that machine's working
 * directory, and every command runs in a fresh shell, so the brief names the checkout under review and asks for a fingerprint
 * measured there. It is appended after the section's render, so the brief before it stays byte for byte what renderBrief returns.
 */
export function workspaceParagraph(dir: string): string {
  const q = `'${dir.replace(/'/g, `'\\''`)}'`;
  return `Workspace: the checkout under review is ${dir}. Your shell and file tools may start in another checkout, and every command runs in a fresh shell: begin each command with \`cd ${q} && \`, and give every file read, search, edit or write an absolute path under ${dir}. Make the first line of your final reply the line \`cd ${q} && echo "REVIEWED_TREE: $(git rev-parse 'HEAD^{tree}') $(git rev-parse --show-toplevel)"\` prints, even where this brief limits your output to findings; a reply without it, or from another checkout, does not count.`;
}
export const withWorkspace = (text: string, dir: string) => `${text}\n\n${workspaceParagraph(dir)}`;
/** The checkout a brief names: the toplevel of the directory the bins run in, where its diff and merge base come from. */
export function checkoutRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 });
  return realDir(r.status === 0 ? r.stdout.trim() : process.cwd());
}

/**
 * One REVIEWED_TREE line as "<tree> <toplevel>", or null. A list marker or heading mark may lead it, and a whole-line `**…**` or
 * backtick wrapper, a bold label and backticks around the sha or the whole path are removed; the path's own characters are kept.
 */
function parseTreeLine(line: string): string | null {
  let t = line.trim().replace(/^(?:[-*>]\s+|\d+[.)]\s+|#+\s+)/, '');
  for (const w of ['**', '`']) if (t.length > 2 * w.length && t.startsWith(w) && t.endsWith(w)) t = t.slice(w.length, -w.length).trim();
  const m = /^(?:\*\*REVIEWED_TREE:\*\*|REVIEWED_TREE:)\s+`?([0-9a-f]{40,64})`?\s+(.+)$/.exec(t);
  if (!m) return null;
  const p = m[2]!.length > 2 && m[2]!.startsWith('`') && m[2]!.endsWith('`') ? m[2]!.slice(1, -1) : m[2]!;
  return `${m[1]} ${realDir(p)}`;
}
export const isReviewedTreeLine = (line: string) => parseTreeLine(line) !== null;
const realDir = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** The checkout a reply says it reviewed: its first REVIEWED_TREE line (a later one may be quoted inside a finding); null with none. */
const reportedTree = (output: string): string | null => output.replace(/\r\n/g, '\n').split('\n').map(parseTreeLine).find(t => t !== null) ?? null;
/** The fingerprint a reply must report, read from the checkout itself when its brief is rendered: "<HEAD^{tree}> <toplevel>". */
export function checkoutTree(dir: string): string | null {
  const git = (a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 30_000 });
  const tree = git(['rev-parse', 'HEAD^{tree}']), top = git(['rev-parse', '--show-toplevel']);
  return tree.status === 0 && top.status === 0 ? `${tree.stdout.trim()} ${realDir(top.stdout.trim())}` : null;
}
/** moved: the reply reviewed the named checkout, but at another tree than the one its brief was rendered on. */
export type TreeCheck = { ok: boolean; moved: boolean; expected: string; reported: string };
/** Whether a reply's REVIEWED_TREE line is the fingerprint recorded when its brief was rendered (GST-482). */
export function checkReviewedTree(output: string, expected: string | null): TreeCheck {
  const reported = reportedTree(output);
  const ok = expected !== null && reported === expected;
  const top = (t: string) => t.slice(t.indexOf(' ') + 1);
  return { ok, moved: !ok && !!reported && expected !== null && top(reported) === top(expected),
    expected: expected ?? 'none (the checkout was unreadable at render)', reported: reported ?? 'none' };
}

/** The file a rendered brief is written to under the run's briefs directory. */
export function briefFile(role: BriefRole, name?: string): string {
  return `${role}${name ? `-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}` : ''}.prompt.md`;
}
