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
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderFixCheckPrompt } from '../scripts/resolvers/fix-check';

export const BRIEF_ROLES = ['specialist', 'specialist-batched', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check'] as const;
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
      return [body, '', 'Give each finding a severity: Critical, High, Medium or Low.', '', `## Branch diff (git diff ${diffBase})`, FENCE + 'diff', (slots.diff ?? '').trim(), FENCE].join('\n');
    }
    case 'fix-check':
      return renderFixCheckPrompt({ fixList: need(slots, 'fix_list'), touchedHunks: need(slots, 'hunks'), testResults: need(slots, 'tests'), callers: slots.callers ?? '' });
  }
}

/** The file a rendered brief is written to under the run's briefs directory. */
export function briefFile(role: BriefRole, name?: string): string {
  return `${role}${name ? `-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}` : ''}.prompt.md`;
}
