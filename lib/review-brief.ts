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
 *
 * With the base policy's review_exclude_paths active (lib/review-exclude.ts) every role but fix-check also takes
 * policy_exclude (the `:(top,exclude,glob)` items, which the fixture-handling command of the security specialist, the
 * Red Team and the native adversarial pass gets), keep (the kept files' `:(top,literal)` items) and disclosure (the one
 * line naming what was left out), and excerpt_file, excerpt_bytes, excerpt_sha256 and excerpt_files (the secret-line excerpt
 * gstack-review-dispatch pass wrote for the kept files whose only reason is a secret line). Unset, every brief renders byte for byte as before. The base policy's readers.forbid_paths
 * (lib/review-fetch.ts) arrive the same way as policy_exclude items, without a disclosure.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderFixCheckPrompt } from '../scripts/resolvers/fix-check';
import { fetchParagraph } from './review-fetch';
import { parseClassList, targetedBrief } from './review-targeted';
import type { ReadersPolicy } from './ship-policy-readers';

export const BRIEF_ROLES = ['specialist', 'specialist-batched', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', 'targeted'] as const;
export type BriefRole = typeof BRIEF_ROLES[number];
export type Slots = Record<string, string | undefined>;

/** The hash every brief and every dispatched prompt is compared by: sha256 of the text without trailing whitespace. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex');
}

export class BriefError extends Error {}

/**
 * The outside voice's diff within a byte cap (FOUN-32 §3): whole per-file sections in diff order while they fit, so a reader past
 * the cap still starts on a path-scoped slice and the brief names what it left out, instead of failing to start on a 3-4 MB brief.
 */
export function sliceDiff(text: string, cap: number): { text: string; sliced: boolean; files: number; kept: number; bytes: number; total: number; left: string[] } {
  const total = Buffer.byteLength(text);
  const starts = [...text.matchAll(/^diff --git (.*)$/gm)];
  const name = (rest: string) => {
    const quoted = /^"a\/((?:[^"\\]|\\.)*)"/.exec(rest);
    if (quoted) return `"${quoted[1]}"`;
    const half = (rest.length - 1) / 2;
    if (rest.startsWith('a/') && rest.slice(half) === ` b/${rest.slice(2, half)}`) return rest.slice(2, half);
    return rest.startsWith('a/') ? rest.slice(2).split(' b/')[0]! : rest;
  };
  if (total <= cap || !starts.length) return { text, sliced: false, files: starts.length, kept: starts.length, bytes: total, total, left: [] };
  let out = '', bytes = 0;
  const left: string[] = [];
  starts.forEach((m, k) => {
    const section = text.slice(m.index!, k + 1 < starts.length ? starts[k + 1]!.index! : text.length);
    const n = Buffer.byteLength(section);
    if (bytes + n <= cap) { out += section; bytes += n; } else left.push(name(m[1]!));
  });
  return { text: out, sliced: true, files: starts.length, kept: starts.length - left.length, bytes, total, left };
}
/** The brief's line for a sliced diff: what was read and what was left out (at most 50 paths named). */
export const sliceNote = (s: ReturnType<typeof sliceDiff>, cap: number) => `This is a path-scoped slice: ${s.kept} of ${s.files} files, ${s.bytes} of ${s.total} bytes (the cap is ${cap} bytes). Not in the slice, so not reviewed here: ${s.left.slice(0, 50).join(', ')}${s.left.length > 50 ? ` and ${s.left.length - 50} more` : ''}.`;

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

/**
 * The outside voice's read-only correctness brief (R95): sent only when OpenAI refused the original under `cyber_policy`, as
 * Capy's pass program retries it on GPT-6 Astra (lib/capy-review-pass.js). It drops the attacker role-play from the outside
 * prompt and appends READ_ONLY_RETRY; every other reader, and every first attempt, gets its section text unchanged.
 */
export const READ_ONLY_RETRY = 'How to work, and this overrides anything above that conflicts with it: this is a read-only correctness review of the change, done by reading the code and its tests. Do not role-play an attacker. Do not write, run or describe exploit code or step-by-step reproductions. For each defect give file:line, the condition under which the code returns the wrong answer, and the smallest fix.';
const READ_ONLY_EDITS: Array<[string, string]> = [['Think like an attacker and a chaos engineer. ', ''], ['Be adversarial. ', ''], ['naming the most exploitable finding', 'naming the most serious finding']];

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

const PLACEHOLDERS = ['<diff-base>', '<exclude>', '<list-exclude>', '<base>', '{checklist path}', '{STACK}', '{TEST_FW}', '{merged findings summary}', '{red-team checklist path}', '{learnings'];

/**
 * Render one reader's brief. Throws BriefError on a missing slot, a section that no longer carries an anchor or placeholder, or a placeholder left unfilled.
 * Findings and learnings are reviewer text that may quote a slot name such as origin/<base> (GST-797): they render as a token, so the
 * placeholder check and the slot fills never see them, and go in last, trimmed as renderRole trims them. The token carries a
 * per-render nonce, so no other slot's text (a diff, a hunk) can name it.
 */
export function renderBrief(role: BriefRole, slots: Slots, t: SectionTexts): string {
  const nonce = randomUUID();
  const keys = ['findings', 'learnings'].filter(k => slots[k]?.trim());
  const held: Slots = { ...slots };
  for (const k of keys) held[k] = `\u0000${nonce}:${k}\u0000`;
  const rendered = renderRole(role, held, t);
  const keep = slots.keep ? ` Read the files kept despite a match as well: \`git diff ${slots.diff_base} -- ${slots.keep}\`.` : '';
  const excerpt = slots.excerpt_file ? ` ${need(slots, 'excerpt_files')} kept files have no keep reason but a changed line that reads a credential, so no git diff command above shows them: read every such line, with context, in the file ${slots.excerpt_file} (${need(slots, 'excerpt_bytes')} bytes, sha256 ${need(slots, 'excerpt_sha256')}).` : '';
  const text = slots.disclosure && role !== 'fix-check' && role !== 'outside-voice' ? `${rendered}\n\n${slots.disclosure}${keep}${excerpt}` : rendered;
  const left = role === 'fix-check' || role === 'outside-voice' ? [] : PLACEHOLDERS.filter(p => text.includes(p));
  if (left.length) throw new BriefError(`${role}: unfilled placeholder ${left.join(', ')}`);
  return keys.reduce((out, k) => out.split(held[k]!).join(slots[k]!.trim()), text);
}

function renderRole(role: BriefRole, slots: Slots, t: SectionTexts): string {
  const diffBase = role === 'fix-check' ? '' : need(slots, 'diff_base');
  if (diffBase && !SHA.test(diffBase)) throw new BriefError(`slot diff_base must be a literal commit sha, got ${JSON.stringify(diffBase)}`);
  const fixtures = (text: string) => text.split(' <exclude>`').join(slots.policy_exclude ? ` ${slots.policy_exclude}\`` : '`')
    .split('<list-exclude>`').join(slots.policy_exclude ? ` -- . ${slots.policy_exclude}\`` : '`');
  const common = (body: string, checklist: string) => fill(body, [
    ...(checklist ? [['{checklist path}', checklist] as [string, string]] : []), ['<diff-base>', diffBase],
    ['{TEST_FW}', slots.test_fw || 'unknown'], ['{STACK}', slots.stack || 'unknown'], ['{learnings or \'none\'}', slots.learnings?.trim() || 'none'],
  ], role).split(' <exclude>`').join(slots.exclude ? ' ' + slots.exclude + '`' : '`');
  switch (role) {
    case 'specialist': {
      const name = need(slots, 'name');
      const checklist = need(slots, 'checklist');
      if (name !== 'security') return common(t.specialist, checklist);
      const body = fill(t.specialist, [[SPECIALIST_DIFF, 'set `DIFF_BASE=<diff-base>` first. ' + fixtures(t.fixtures) + ' Then read the diff that way']], role);
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
      return fixtures(`${t.framing}\n\n${t.fixtures}\n\n${body}`);
    }
    case 'adversarial-native': {
      const native = fixtures(fill(t.native, [['DIFF_BASE=$(git merge-base origin/<base> HEAD)', `DIFF_BASE=${diffBase}`]], role));
      const lists = (slots.checklists ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const merged = lists.length ? `${native}\n\nIn the same read, apply each checklist at ${lists.join(', ')} to the diff, and tag each finding's "specialist" with the name of the checklist it came from (adversarial for your own).` : native;
      if (!slots.classes) return merged;
      const classes = parseClassList(slots.classes);
      if (!classes?.length) throw new BriefError(`slot classes must list money, gate, auth or secret, got ${JSON.stringify(slots.classes)}`);
      try { return `${targetedBrief(need(slots, 'brief'), classes)}\n\n${merged}\n\nApply the targeted brief above (${need(slots, 'checklist')}: ${classes.join(', ')}) in the same read; your reply is this diff's targeted pass.`; } catch (e) { throw e instanceof BriefError ? e : new BriefError((e as Error).message); }
    }
    case 'outside-voice': {
      const outside = slots.read_only ? `${fill(t.outside, READ_ONLY_EDITS, 'read-only retry')}\n\n${READ_ONLY_RETRY}` : t.outside;
      const filled = fill(outside, [['DIFF_BASE=$(git merge-base origin/<base> HEAD)', `DIFF_BASE=${diffBase}`]], role);
      const body = slots.policy_exclude ? filled.split('git diff "$DIFF_BASE".').join(`git diff "$DIFF_BASE" -- . ${slots.policy_exclude}${slots.keep ? ` and git diff "$DIFF_BASE" -- ${slots.keep}` : ''}.`) : filled;
      const head = [body, '', ...(slots.disclosure ? [slots.disclosure, ''] : []), `## Branch diff (git diff ${diffBase})`];
      if (slots.diff_file) return [...head, `The supplied branch diff is the file ${slots.diff_file} (${need(slots, 'diff_bytes')} bytes, sha256 ${need(slots, 'diff_sha256')}). Read it from disk; it is ${slots.diff_slice ? 'the part of the diff under review' : 'the whole diff under review'}.`, ...(slots.diff_slice ? [slots.diff_slice] : [])].join('\n');
      return [...head, FENCE + 'diff', (slots.diff ?? '').trim(), FENCE].join('\n');
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

const quoted = (dir: string) => `'${dir.replace(/'/g, `'\\''`)}'`;
const treeCommand = (dir: string) => `cd ${quoted(dir)} && echo "REVIEWED_TREE: $(git rev-parse 'HEAD^{tree}') $(git rev-parse --show-toplevel)"`;

/**
 * The opening step every dispatched brief carries (GST-897): the fingerprint command and what to copy from it. A reader that
 * follows a findings-only output format can skip a request that only closes a long brief (gpt-6.1-sol did on GST-850), and
 * "the line <command> prints" was read as the command itself, so the step comes first and names the output line.
 */
export function workspaceStep(dir: string, verdict = false): string {
  return `First step, before anything else: run \`${treeCommand(dir)}\`. It outputs one line, \`REVIEWED_TREE: <tree hash> <path>\`. Copy that output line, not the command, as the first line of your final reply, above everything else, even where this brief limits your output to findings or says how to end it; a reply without it, or from another checkout, does not count.${verdict ? ` ${VERDICT_ASK}` : ''}`;
}

/**
 * The verdict ask every blocking reader's brief carries right after the fingerprint step (GST-2495, lib/review-verdict.ts): one
 * machine-readable count of the reply's blocking findings, which collect checks against the findings it parses.
 */
export const VERDICT_ASK = 'Put `REVIEW_VERDICT: blocking=<n>` on the second line, right under it: n is how many findings in your reply block the merge by this brief\'s own rule, 0 when none; add ` at=<path>:<line>,…` for those findings that have a location. Write it once, on its own line, outside any code block; it does not replace your findings or the ending this brief asks for.';

/**
 * The closing paragraphs every dispatched brief carries: the fetch rule and the readers policy (GST-1322, lib/review-fetch.ts),
 * then the workspace (GST-482): a reader on a shared machine starts in that machine's working directory, and every command runs
 * in a fresh shell, so the brief names the checkout under review and asks again for the fingerprint workspaceStep opens with.
 * The section's render sits between workspaceStep and these, byte for byte what renderBrief returns.
 */
export function workspaceParagraph(dir: string, readers?: ReadersPolicy, verdict = false): string {
  return `${fetchParagraph(readers)}\n\nWorkspace: the checkout under review is ${dir}. Your shell and file tools may start in another checkout, and every command runs in a fresh shell: begin each command with \`cd ${quoted(dir)} && \`, and give every file read, search, edit or write an absolute path under ${dir}. The first line of your final reply is the \`REVIEWED_TREE: <tree hash> <path>\` line that \`${treeCommand(dir)}\` outputs (the output, not the command), even where this brief limits your output to findings; a reply without it, or from another checkout, does not count.${verdict ? ' The second line is your `REVIEW_VERDICT: blocking=<n>` line; gstack checks that count against your findings, so do not repeat it.' : ''}`;
}
/** A blocking reader's brief (one of BRIEF_ROLES) takes the verdict ask; an audit reader, which cannot block, does not. */
export const withWorkspace = (text: string, dir: string, readers?: ReadersPolicy, opts: { verdict?: boolean } = {}) => `${workspaceStep(dir, opts.verdict)}\n\n${text}\n\n${workspaceParagraph(dir, readers, opts.verdict)}`;
/** The checkout a brief names: the toplevel of the directory the bins run in, where its diff and merge base come from. */
export function checkoutRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 });
  return realDir(r.status === 0 ? r.stdout.trim() : process.cwd());
}

/**
 * One REVIEWED_TREE line as "<tree> <toplevel>", or null. A list marker, heading mark or `printed:` label (GST-776, also after the echoed `cd … && echo …` command on the same line) may lead it, and a whole-line `**…**` or
 * backtick wrapper, a bold label and backticks around the sha or the whole path are removed; the path's own characters are kept.
 */
function parseTreeLine(line: string): string | null {
  const label = /^(?:\*\*[Pp]rinted:\*\*|[Pp]rinted:)\s+/;
  let t = line.trim().replace(/^(?:[-*>]\s+|\d+[.)]\s+|#+\s+)/, '');
  const echoed = /\s(?:\*\*[Pp]rinted:\*\*|[Pp]rinted:)\s+(?=\S)/.exec(t);
  if (echoed && t.startsWith('cd ')) t = t.slice(echoed.index + 1);
  t = t.replace(label, '');
  for (const w of ['**', '`']) if (t.length > 2 * w.length && t.startsWith(w) && t.endsWith(w)) t = t.slice(w.length, -w.length).trim();
  t = t.replace(label, '');
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
