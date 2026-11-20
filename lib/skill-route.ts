/**
 * skill-route — deterministic prompt-to-skill routing (GST-1088, lane A).
 *
 * The UserPromptSubmit hook (hosts/claude/hooks/skill-route-hook.ts) and
 * `gstack-skill-route --explain` score a prompt against the `triggers:` lists
 * in the installed skills' SKILL.md frontmatter. No model call, no network:
 * the same prompt and the same installed skills always give the same route.
 *
 * Also home to what the skill hooks share: the on/off switches
 * (skill_routing, skill_contracts, destructive_guard and the gates), the installed-skills directory, the
 * bounded stdin reader and the trace log under $GSTACK_STATE_ROOT/hooks/.
 * Docs: docs/skill-routing-and-contracts.md.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteSync } from './fs-atomic';
import { frontmatterList } from './skill-triggers';
import { readConfigKey, resolveStateRoot } from './state-root';

/** A route needs at least this share of a trigger's content words (2 of 3, 3 of 4; both of 2). */
export const ROUTE_THRESHOLD = 0.66;
/**
 * A prompt longer than the two windows is scored on its first PROMPT_HEAD_CHARS and last PROMPT_TAIL_CHARS
 * characters, where the request usually sits; a log or file pasted between them is not scored, so its words
 * cannot match everything.
 */
export const PROMPT_HEAD_CHARS = 4000;
export const PROMPT_TAIL_CHARS = 1000;
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const MAX_SKILLS = 256;
const MAX_TRIGGER_CHARS = 200;
const TRACE_MAX_BYTES = 1024 * 1024;
const FAILURE_SESSIONS_KEPT = 64;

export type SwitchName = 'skill_routing' | 'skill_contracts' | 'destructive_guard' | 'ceo_review_gate' | 'autoplan_gate';
export const SWITCH_ENV: Record<SwitchName, string> = {
  skill_routing: 'GSTACK_SKILL_ROUTING',
  skill_contracts: 'GSTACK_SKILL_CONTRACTS',
  destructive_guard: 'GSTACK_DESTRUCTIVE_GUARD',
  ceo_review_gate: 'GSTACK_CEO_REVIEW_GATE',
  autoplan_gate: 'GSTACK_AUTOPLAN_GATE',
};

/** Each switch's one default. setup, gstack-config and gstack-skill-route read it through `gstack-skill-route --default <switch>`; the hooks read it here. */
export const SWITCH_DEFAULT: Record<SwitchName, 'on' | 'off'> = {
  skill_routing: 'on',
  skill_contracts: 'on',
  destructive_guard: 'on',
  ceo_review_gate: 'off',
  autoplan_gate: 'off',
};

export function normalizeSwitch(raw: string | null | undefined): 'on' | 'off' | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['on', 'yes', 'y', 'true', '1'].includes(v)) return 'on';
  if (['off', 'no', 'n', 'false', '0', 'skip'].includes(v)) return 'off';
  return null;
}

export interface SwitchReading { on: boolean; source: string; invalid?: string }

/** A config.yaml that exists but cannot be read as a file: the person's choice is unknown. */
function configUnreadable(env: NodeJS.ProcessEnv): boolean {
  const file = path.join(resolveStateRoot(env), 'config.yaml');
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return !fs.statSync(file).isFile();
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

/**
 * env GSTACK_SKILL_ROUTING / GSTACK_SKILL_CONTRACTS > config key > SWITCH_DEFAULT. An unrecognized value takes the
 * default, as setup does. An unreadable config is off whatever the default: it may hold an off the person set.
 */
export function readSkillSwitch(name: SwitchName, env: NodeJS.ProcessEnv = process.env): SwitchReading {
  const fallback = SWITCH_DEFAULT[name] === 'on';
  const envName = SWITCH_ENV[name];
  const raw = env[envName];
  if (raw !== undefined && raw !== '') {
    const v = normalizeSwitch(raw);
    return v ? { on: v === 'on', source: `env ${envName}` } : { on: fallback, source: `env ${envName}`, invalid: raw };
  }
  const cfg = readConfigKey(name, env);
  if (cfg === null) return configUnreadable(env) ? { on: false, source: 'config unreadable' } : { on: fallback, source: 'default' };
  const v = normalizeSwitch(cfg);
  return v ? { on: v === 'on', source: `config ${name}` } : { on: fallback, source: `config ${name}`, invalid: cfg };
}

/** The host a skill hook runs under: codex when its Codex wrapper (hosts/codex/hooks) set GSTACK_HOOK_HOST, else Claude Code. */
export type HookHost = 'claude' | 'codex';
export const hookHost = (env: NodeJS.ProcessEnv = process.env): HookHost => (env.GSTACK_HOOK_HOST === 'codex' ? 'codex' : 'claude');

/** Where Codex reads skills: GSTACK_INSTALLED_SKILLS_DIR, else ${CODEX_HOME:-~/.codex}/skills. */
export function codexSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GSTACK_INSTALLED_SKILLS_DIR) return env.GSTACK_INSTALLED_SKILLS_DIR;
  return path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'skills');
}

/** Where Claude Code reads skills: GSTACK_INSTALLED_SKILLS_DIR, else ${CLAUDE_CONFIG_DIR:-~/.claude}/skills. */
export function installedSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GSTACK_INSTALLED_SKILLS_DIR) return env.GSTACK_INSTALLED_SKILLS_DIR;
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'skills');
}

/** The frontmatter between the leading `---` lines, read from at most the first 16 KiB; null without one. */
export function readFrontmatter(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const text = buf.subarray(0, fs.readSync(fd, buf, 0, FRONTMATTER_MAX_BYTES, 0)).toString('utf8').replace(/\r\n/g, '\n');
    if (!text.startsWith('---\n')) return null;
    const end = text.indexOf('\n---', 4);
    return end < 0 ? null : text.slice(4, end);
  } finally {
    fs.closeSync(fd);
  }
}

export function frontmatterName(frontmatter: string, fallback: string): string {
  const m = /^name:\s*(.+)$/m.exec(frontmatter);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
}

const MAX_TRIGGERS = 12;
/** Trigger text the hook may quote in its line: letters, digits, spaces and . , ' ? ! / - only, so it cannot leave its quotes or add markup or shell characters. */
const TRIGGER_TEXT = /^[A-Za-z0-9 ,.'?!\/-]+$/;
const SKILL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_:-]{0,63}$/;
/** At most this many skills are named in one hook line. */
export const MAX_ROUTES = 2;
const GSTACK_ROOT = path.resolve(import.meta.dir, '..');

/** gstack is true when the skill's directory holds .gstack-owned or its SKILL.md resolves into gstack's checkout. */
export interface InstalledSkill { name: string; file: string; frontmatter: string; triggers: string[]; gstack?: boolean }

/**
 * The alias skills ./setup installs beside the generated ones (_install_alias_skill_md, the connect-chrome link). A
 * skill built from a gstack-style template carries the same generated-file banner, so names, not the banner, decide.
 */
const GSTACK_ALIASES = ['_gstack-command', 'connect-chrome'];
let templateNames: Set<string> | null = null;
/** The skills gstack's checkout generates (a directory with SKILL.md.tmpl, and the root gstack skill) and its aliases. */
function gstackSkillNames(): Set<string> {
  if (templateNames) return templateNames;
  templateNames = new Set(GSTACK_ALIASES);
  try {
    for (const d of fs.readdirSync(GSTACK_ROOT)) if (fs.existsSync(path.join(GSTACK_ROOT, d, 'SKILL.md.tmpl'))) templateNames.add(d);
    if (fs.existsSync(path.join(GSTACK_ROOT, 'SKILL.md.tmpl'))) templateNames.add('gstack');
  } catch { /* no checkout beside this file */ }
  return templateNames;
}
const baseName = (name: string) => name.toLowerCase().replace(/^gstack[-:]/, '');
/** One of gstack's own skills: marked at install, or named like a skill gstack's checkout generates. */
export const isGstackSkill = (s: InstalledSkill) => s.gstack === true || gstackSkillNames().has(baseName(s.name));

function ownedByGstack(dir: string, file: string): boolean {
  if (fs.existsSync(path.join(dir, '.gstack-owned'))) return true;
  try {
    const rel = path.relative(fs.realpathSync(GSTACK_ROOT), fs.realpathSync(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Every installed skill with frontmatter, sorted by directory; `problems` names skills whose triggers the hook will not use. */
export function scanInstalledSkills(dir: string): { skills: InstalledSkill[]; problems: string[] } {
  const skills: InstalledSkill[] = [];
  const problems: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort().slice(0, MAX_SKILLS);
  } catch {
    return { skills, problems: [`skills directory unreadable: ${dir}`] };
  }
  for (const entry of entries) {
    const file = path.join(dir, entry, 'SKILL.md');
    let frontmatter: string | null;
    try {
      frontmatter = readFrontmatter(file);
    } catch {
      continue;
    }
    if (frontmatter === null) continue;
    const name = frontmatterName(frontmatter, entry);
    const gstack = ownedByGstack(path.join(dir, entry), file);
    let triggers: string[] = [];
    if (/^triggers:/m.test(frontmatter)) {
      triggers = frontmatterList(`---\n${frontmatter}\n---`, 'triggers');
      const problem = !SKILL_NAME.test(name) ? 'a name outside letters, digits, _ : and -'
        : !triggers.length || triggers.some(t => !t || t.length > MAX_TRIGGER_CHARS) ? 'malformed triggers'
        : triggers.length > MAX_TRIGGERS ? `more than ${MAX_TRIGGERS} triggers`
        : triggers.some(t => !TRIGGER_TEXT.test(t)) ? "trigger text outside letters, digits, spaces and . , ' ? ! / -" : '';
      if (problem) {
        problems.push(`${SKILL_NAME.test(name) ? name : entry.slice(0, 64)}: ${problem}`);
        triggers = [];
      }
      const short = isGstackSkill({ name, file, frontmatter, triggers, gstack }) ? [] : triggers.filter(t => contentTokens(t).length < 2);
      if (short.length) {
        problems.push(`${name}: skipped ${short.map(t => `"${t}"`).join(', ')}: another installed skill's trigger needs two content words, so one word cannot claim a prompt`);
        triggers = triggers.filter(t => !short.includes(t));
      }
    }
    skills.push({ name, file, frontmatter, triggers, gstack });
  }
  return { skills, problems };
}

/**
 * Codex's skills, as scanInstalledSkills reads them. Each gstack skill (a gstack-<name> directory) keeps the name its
 * installed SKILL.md gives, the one Codex lists and mentions it by (gstack-review/ holds name: review, so $review), or
 * its directory when that name is missing or unusable. Codex renders keep only name and description, so a gstack
 * skill without triggers takes them from the same skill's Claude render in this checkout.
 */
export function scanCodexSkills(dir: string): { skills: InstalledSkill[]; problems: string[] } {
  const { skills, problems } = scanInstalledSkills(dir);
  return {
    problems,
    skills: skills.map(s => {
      const entry = path.basename(path.dirname(s.file));
      if (!entry.startsWith('gstack-') || !isGstackSkill({ ...s, name: entry })) return s;
      let triggers = s.triggers;
      if (!triggers.length) {
        try {
          const fm = readFrontmatter(path.join(GSTACK_ROOT, entry.slice('gstack-'.length), 'SKILL.md'));
          if (fm && /^triggers:/m.test(fm)) triggers = frontmatterList(`---\n${fm}\n---`, 'triggers');
        } catch { /* no Claude render beside this file: the skill routes on nothing */ }
      }
      return { ...s, name: SKILL_NAME.test(s.name) ? s.name : entry, triggers, gstack: true };
    }),
  };
}

const STOPWORDS = new Set(('a an the this that these those it its i me my we our us you your he she they them their ' +
  'is are was were be been being am do does did done to of in on at by for from with as into onto about and or but ' +
  'so if then than just please can could would should will shall may might must some any all here there now ' +
  'up out over get got let lets want need make sure ok okay hey hi').split(' '));

/** Lowercase, light stemming: plural s/es, -ing and -ed, with a doubled final consonant undone. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, '');
  if (w.length > 4 && /(?:xes|sses|shes|ches|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz|ff)$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Words, with paths and identifiers (site-packages, src/review.ts, max_retries) kept whole so their parts never match a trigger. */
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+(?:[-_./\\][a-z0-9]+)*(?:'[a-z]+)?/g) ?? [];

/**
 * Words a bug report uses for the defect itself, scored as "bug": a report says "raises TypeError" or "fails"
 * far more often than "bug". Exception names (ValueError, RuntimeException) count too.
 */
const DEFECT_WORDS = new Set(['bug', 'error', 'exception', 'traceback', 'crash', 'fail', 'failure', 'broken', 'regression',
  'incorrect', 'incorrectly', 'wrong', 'defect']);
const concept = (stemmed: string) => DEFECT_WORDS.has(stemmed) || /^[a-z]{3,}(?:error|exception)$/.test(stemmed) ? 'bug' : stemmed;

export function tokens(text: string): string[] {
  return words(text).map(w => concept(stem(w)));
}

export function contentTokens(text: string): string[] {
  return [...new Set(words(text).filter(w => !STOPWORDS.has(w)).map(w => concept(stem(w))))];
}

/** A fence line (CommonMark): up to three spaces, then three or more backticks or tildes, then its info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A blank line: an inline code span never crosses one. */
const PARAGRAPH_BREAK = /(\n[ \t]*\n)/;

/**
 * A prompt split into its prose and its Markdown code, as CommonMark reads them: fenced code blocks (an unclosed fence
 * runs to the end) and inline code spans (a backtick run closed by the next run of the same length in its paragraph; an
 * unmatched run is prose). A command quoted in backticks names the command; it does not ask for anything, so triggers
 * match the prose only (#4564). Each run looks up its closer once, so a long prompt full of unmatched runs stays linear.
 */
export function splitCode(prompt: string): { prose: string; code: string } {
  const prose: string[] = [];
  const code: string[] = [];
  let fence = '';
  for (const line of prompt.split('\n')) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = '';
      else code.push(line);
      prose.push('');
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = m[1];
      prose.push('');
    } else prose.push(line);
  }
  const text = prose.join('\n').split(PARAGRAPH_BREAK).map(part => {
    const runs = [...part.matchAll(/`+/g)];
    const closer: (number | undefined)[] = [];
    const nextOfLength = new Map<number, number>();
    for (let i = runs.length - 1; i >= 0; i--) {
      closer[i] = nextOfLength.get(runs[i][0].length);
      nextOfLength.set(runs[i][0].length, i);
    }
    let out = '';
    let at = 0;
    for (let i = 0; i < runs.length; i++) {
      const close = closer[i];
      if (close === undefined) continue;
      const open = runs[i];
      code.push(part.slice(open.index + open[0].length, runs[close].index));
      out += `${part.slice(at, open.index)} `;
      at = runs[close].index + runs[close][0].length;
      i = close;
    }
    return out + part.slice(at);
  }).join('');
  return { prose: text, code: code.join('\n') };
}

/** The text a prompt is scored on: all of it, or its head and tail windows when it is longer than both. */
export function promptWindow(prompt: string): string {
  if (prompt.length <= PROMPT_HEAD_CHARS + PROMPT_TAIL_CHARS) return prompt;
  return `${prompt.slice(0, PROMPT_HEAD_CHARS)}\n${prompt.slice(-PROMPT_TAIL_CHARS)}`;
}

export interface RouteCandidate { skill: string; score: number; matched: number; trigger: string; file: string; gstack: boolean }

/** A lone content word specific enough to route on by itself: five or more letters, not a question word. */
const SPECIFIC_WORD = /^(?!(?:what|which|where|whose)$)[a-z0-9]{5,}$/;
/** How close, in words, a trigger made only of everyday words must sit when it matches out of order. */
export const EVERYDAY_SPAN = 8;

/** True when every word in want appears within some run of span consecutive words of seq. */
function within(seq: string[], want: string[], span: number): boolean {
  const need = new Set(want);
  for (let i = 0; i < seq.length; i++) {
    if (!need.has(seq[i])) continue;
    if (new Set(seq.slice(i, i + span).filter(w => need.has(w))).size === need.size) return true;
  }
  return false;
}

/**
 * Every skill whose best trigger shares a content word with the window (promptWindow) of the prompt's prose (splitCode), best first
 * (score, matched words, name). A trigger's score is 1 when its whole phrase appears in the prompt, else the
 * share of its content words (stopwords dropped, lightly stemmed, defect words read as "bug") that the prompt
 * contains. A trigger with one content word scores only on its whole phrase unless that word is specific
 * (SPECIFIC_WORD). A bug report is full of everyday words (find, test, run, site) and defect words, so two
 * rules keep them from adding up to a request: a trigger only partly present needs a specific word other than
 * "bug" among the words it shares, and a trigger of everyday words only, with no "bug", needs its words within
 * EVERYDAY_SPAN words of each other.
 */
export function scorePrompt(prompt: string, skills: InstalledSkill[]): RouteCandidate[] {
  const scored = promptWindow(splitCode(prompt).prose);
  const seq = tokens(scored);
  const promptSeq = ` ${seq.join(' ')} `;
  const promptSet = new Set(contentTokens(scored));
  const out: RouteCandidate[] = [];
  for (const skill of skills) {
    let best: RouteCandidate | null = null;
    let bestPhrase = false;
    for (const trigger of skill.triggers) {
      const content = contentTokens(trigger);
      if (!content.length) continue;
      const shared = content.filter(w => promptSet.has(w));
      const matched = shared.length;
      const phrase = promptSeq.includes(` ${tokens(trigger).join(' ')} `);
      const weakSingle = content.length === 1 && !SPECIFIC_WORD.test(content[0]);
      const thinPartial = matched < content.length && !shared.some(w => w !== 'bug' && SPECIFIC_WORD.test(w));
      const everyday = !content.some(w => w === 'bug' || SPECIFIC_WORD.test(w));
      const scattered = matched === content.length && everyday && !within(seq, content, EVERYDAY_SPAN);
      const score = phrase ? 1 : weakSingle || thinPartial || scattered ? 0 : Math.round((matched / content.length) * 100) / 100;
      const tie = !!best && score === best.score && (matched > best.matched || (matched === best.matched && phrase && !bestPhrase));
      if (score > 0 && (!best || score > best.score || tie)) {
        best = { skill: skill.name, score, matched, trigger, file: skill.file, gstack: isGstackSkill(skill) };
        bestPhrase = phrase;
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || Number(b.gstack) - Number(a.gstack) || b.matched - a.matched || a.skill.localeCompare(b.skill));
}

/**
 * gstack's own skills the hook may route to: plan-v2 decision 4's discovery targets. Run D's prompts showed routing
 * every gstack skill's triggers false-routes most non-fit prompts (docs/skill-routing-and-contracts.md). Any other
 * installed skill that lists triggers routes too (GST-3123): no host but gstack reads `triggers:`, so a skill
 * that writes them is asking gstack to route it.
 */
export const ROUTED_SKILLS = ['review', 'qa', 'verify'];
const isRouted = (s: InstalledSkill) => !isGstackSkill(s) || ROUTED_SKILLS.includes(baseName(s.name));

/**
 * Signs that a prompt reports a defect (bugReport). One strong sign is enough: a word for what went wrong, an exception
 * name (ValueError), the verb fix, an issue template's expected or actual heading, a failure verb (fails, failed to,
 * doesn't work) or a "should X, not Y" correction. Feature requests use error, exception and failure as nouns ("add
 * error handling", "a custom exception class"), so those words, a negated verb, "should" and "instead of" are weak
 * signs, and a bug report needs two different ones.
 */
const SYMPTOM_STEMS = new Set(['bug', 'crash', 'traceback', 'regression', 'broken', 'wrong', 'incorrect', 'incorrectly', 'defect',
  'hang', 'stuck', 'freeze', 'freezes', 'leak', 'corrupt', 'imprecise', 'inaccurate', 'unexpected', 'unexpectedly', 'weird', 'strange',
  'glitch', 'mismatch', 'typo'].map(stem));
const STRONG_SIGN = new RegExp(String.raw`\b(?:expected (?:behaviou?r|result|output|value)|actual (?:behaviou?r|result|output)|what did you expect`
  + String.raw`|what happened|steps to reproduce|to reproduce|reproducible|correct (?:output|result|value|answer|behaviou?r)|fails|failing`
  + String.raw`|fail(?:ed)? to|(?:does|do|did)(?: not|n't) work|not working|no longer works?)\b|\bshould\b[^.!?]*(?:, not\b|\binstead of\b)`);
const WEAK_SIGNS = [/\b(?:errors?|exceptions?|failures?|failed)\b/, /\b(?:(?:does|do|did|is|are|was|were|can|could|will|would)(?: not|n't)|cannot|can't|won't)\b/,
  /\bshould\b/, /\binstead of\b/];

/** The verb fix, as a prompt asks for one. */
const FIX_WORD = /^(?:re-)?fix(?:es|ing)?$/;

/** An exception name as code writes it (ValueError, KeyError, NullPointerException); a helper such as handleError is not one. */
const EXCEPTION_NAME = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b/;

/**
 * True when the window (promptWindow) of the prompt's prose (splitCode) reads as a bug report: one strong sign, or two
 * different weak ones. Its code counts only for an exception name, since a pasted traceback or a quoted `KeyError` reports
 * one; a flag such as `--fix` or the word broken in a log does not.
 */
export function bugReport(prompt: string): boolean {
  const { prose, code } = splitCode(prompt);
  if (EXCEPTION_NAME.test(promptWindow(code))) return true;
  const text = promptWindow(prose).toLowerCase().replace(/[\u2019`]/g, "'").replace(/\s+/g, ' ');
  if (words(text).some(w => SYMPTOM_STEMS.has(stem(w)) || FIX_WORD.test(w) || /^[a-z]{3,}(?:error|exception)$/.test(w))) return true;
  return STRONG_SIGN.test(text) || WEAK_SIGNS.filter(re => re.test(text)).length >= 2;
}

/**
 * A trigger that claims bug reports: the defect and fixing it, and nothing else, as "fix this bug" and "reproduce the bug
 * in a test" do. A trigger that names its own target ("fix lint errors", "fix postgres bugs") claims only that kind of fix.
 */
const FIX_VERBS = ['fix', 'debug', 'repair', 'reproduce'];
const GENERIC_CLAIM_WORDS = new Set(['bug', 'test', ...FIX_VERBS]);
const claimsBugReports = (trigger: string) => {
  const content = contentTokens(trigger);
  return content.includes('bug') && content.some(w => FIX_VERBS.includes(w)) && content.every(w => GENERIC_CLAIM_WORDS.has(w));
};

/**
 * On a bug report, the installed skill that claims bug reports, named alone: one with a claiming trigger that is not
 * gstack's own (gstack's routed skills only check work), the best-scoring first, then by name. Null when none is installed.
 */
function bugFixRoute(skills: InstalledSkill[], candidates: RouteCandidate[]): RouteCandidate | null {
  const score = (s: InstalledSkill) => candidates.find(c => c.skill === s.name)?.score ?? 0;
  const fixer = skills.filter(s => !isGstackSkill(s) && s.triggers.some(claimsBugReports))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
  if (!fixer) return null;
  const trigger = fixer.triggers.find(claimsBugReports)!;
  return { skill: fixer.name, score: 1, matched: contentTokens(trigger).length, trigger, file: fixer.file, gstack: false };
}

export type RouteDecision =
  | { route: RouteCandidate; routes: RouteCandidate[]; candidates: RouteCandidate[]; bugReport: boolean }
  | { route: null; reason: 'slash-command' | 'skill-mention' | 'empty' | 'below-threshold'; candidates: RouteCandidate[] };

/**
 * A prompt that already names a command is never routed: `/` on both hosts, and Codex's `$skill` mention there. A bug
 * report goes to the installed skill that claims bug reports, alone, whatever the triggers score (bugFixRoute), unless
 * it holds the whole phrase of one of /review's or /qa's own triggers ("review this pr for bugs") and never asks for a
 * fix: finding bugs is not fixing one. Any other prompt goes to the skills whose triggers reach the threshold. All of
 * this reads the prompt's prose, never its Markdown code (splitCode), except that an exception name in code reports a bug.
 */
export function routePrompt(prompt: string, skills: InstalledSkill[], threshold = ROUTE_THRESHOLD, host: HookHost = 'claude'): RouteDecision {
  const trimmed = prompt.trim();
  if (!trimmed) return { route: null, reason: 'empty', candidates: [] };
  if (trimmed.startsWith('/')) return { route: null, reason: 'slash-command', candidates: [] };
  if (host === 'codex' && trimmed.startsWith('$')) return { route: null, reason: 'skill-mention', candidates: [] };
  const routed = skills.filter(isRouted);
  const candidates = scorePrompt(prompt, routed);
  const window = promptWindow(splitCode(prompt).prose);
  const seq = ` ${tokens(window).join(' ')} `;
  const findsBugs = !words(window).some(w => FIX_WORD.test(w)) && routed.some(s => isGstackSkill(s)
    && ['review', 'qa'].includes(baseName(s.name)) && s.triggers.some(t => seq.includes(` ${tokens(t).join(' ')} `)));
  const fixer = !findsBugs && bugReport(prompt) ? bugFixRoute(routed, candidates) : null;
  if (fixer) return { route: fixer, routes: [fixer], candidates, bugReport: true };
  const routes = candidates.filter((c, i) => c.score >= threshold && candidates.findIndex(o => o.skill === c.skill) === i).slice(0, MAX_ROUTES);
  return routes.length ? { route: routes[0], routes, candidates, bugReport: false } : { route: null, reason: 'below-threshold', candidates };
}

export type HintVariant = 'name' | 'step' | 'contract';
export const HINT_VARIANTS: HintVariant[] = ['name', 'step', 'contract'];
/** The default line (d6 pilot); GSTACK_SKILL_ROUTE_HINT selects another variant for the pilot. */
export const DEFAULT_HINT_VARIANT: HintVariant = 'name';

export function hintVariant(env: NodeJS.ProcessEnv = process.env): HintVariant {
  const v = (env.GSTACK_SKILL_ROUTE_HINT || '').trim().toLowerCase();
  return (HINT_VARIANTS as string[]).includes(v) ? v as HintVariant : DEFAULT_HINT_VARIANT;
}

/** The one additionalContext line: its source, its off switch, the skill (or two), and the ask to say gstack routed it. */
export function hintLine(route: RouteCandidate, extra = '', also?: RouteCandidate, host: HookHost = 'claude'): string {
  if (host === 'codex') return codexHintLine(route, extra, also);
  const s = `/${route.skill}`;
  const matched = (r: RouteCandidate) => `the installed /${r.skill} trigger "${r.trigger.replace(/["\s]+/g, ' ').trim()}"`;
  const head = `gstack skill routing (UserPromptSubmit hook; matched ${matched(route)}${also ? ` and ${matched(also)}` : ''}; off: gstack-config set skill_routing off): `;
  const ask = also
    ? `this request fits ${s} or /${also.skill}. Run the one that fits better with the Skill tool before you start (${s} if both fit), and tell the user in one sentence which skill gstack routed this to.`
    : `this request fits ${s}. Run ${s} with the Skill tool before you start, and tell the user in one sentence that gstack routed this to ${s}.`;
  return head + ask + (extra.trim() ? ` ${extra.replace(/\s+/g, ' ').trim()}` : '');
}

/** hintLine's Codex wording: skills by their Codex names (gstack-review), read and followed rather than run with the Skill tool. */
function codexHintLine(route: RouteCandidate, extra: string, also?: RouteCandidate): string {
  const matched = (r: RouteCandidate) => `the installed ${r.skill} trigger "${r.trigger.replace(/["\s]+/g, ' ').trim()}"`;
  const head = `gstack skill routing (UserPromptSubmit hook; matched ${matched(route)}${also ? ` and ${matched(also)}` : ''}; off: gstack-config set skill_routing off): `;
  const ask = also
    ? `this request fits the ${route.skill} or ${also.skill} skill. Read and follow the one that fits better before you start (${route.skill} if both fit), and tell the user in one sentence which skill gstack routed this to.`
    : `this request fits the ${route.skill} skill. Read and follow the ${route.skill} skill before you start, and tell the user in one sentence that gstack routed this to ${route.skill}.`;
  return head + ask + (extra.trim() ? ` ${extra.replace(/\s+/g, ' ').trim()}` : '');
}

/** First sentence under a skill body's first "Step 1", "Phase 1" or "How to work" heading, plain text, at most 200 chars; '' without one. */
export function firstStep(skillMd: string): string {
  const m = /^#{2,3}\s+(?:Step\s*0*1\b|Phase\s*0*1\b|How to work\b).*$/im.exec(skillMd);
  if (!m) return '';
  const para = skillMd.slice(m.index + m[0].length).split(/\n\s*\n/).map(p => p.trim())
    .find(p => p && !p.startsWith('```') && !p.startsWith('#'));
  if (!para) return '';
  const plain = para.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  const sentence = (/^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 197).replace(/\s+\S*$/, '')}...` : sentence;
}

export interface BoundedStdin { text: string; overCap: boolean }

/** A hook payload: returns at EOF, at the first complete JSON value, at the deadline, or as soon as it passes capBytes. */
export function readStdinBounded(capBytes: number, ms: number, stream: NodeJS.ReadStream = process.stdin): Promise<BoundedStdin> {
  return new Promise((resolve) => {
    let buf = '';
    let bytes = 0;
    let settled = false;
    const done = (overCap: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners('data');
      try { stream.destroy(); } catch { /* already closed */ }
      resolve({ text: overCap ? '' : buf, overCap });
    };
    const timer = setTimeout(() => done(false), ms);
    stream.on('data', (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += b.length;
      if (bytes > capBytes) { done(true); return; }
      buf += b.toString('utf8');
      try { JSON.parse(buf); done(false); } catch { /* keep reading */ }
    });
    stream.on('end', () => done(false));
    stream.on('error', () => done(false));
  });
}

export type TraceHook = 'skill-route' | 'skill-contract' | 'ceo-review-gate' | 'autoplan-gate';

export function traceLogPath(hook: TraceHook, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'hooks', `${hook}.log`);
}

const traceValue = (v: string | number | boolean) => {
  const s = String(v).replace(/[\r\n\t]+/g, ' ');
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

/**
 * Append one trace line to $GSTACK_STATE_ROOT/hooks/<hook>.log (rotated to .log.1 past 1 MiB). A failure also
 * bumps the session's count in <hook>.failures.json and the line carries `failures=<n>`. Never throws, never
 * writes stderr, never logs prompt text.
 */
export function appendHookTrace(hook: TraceHook, sessionId: string, fields: Record<string, string | number | boolean>,
  failed = false, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const log = traceLogPath(hook, env);
    const dir = path.dirname(log);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
    const parts = [`session=${sid}`, ...Object.entries(fields).map(([k, v]) => `${k}=${traceValue(v)}`)];
    if (failed) {
      const counter = path.join(dir, `${hook}.failures.json`);
      let sessions: Record<string, number> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(counter, 'utf8'));
        if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) sessions = parsed.sessions;
      } catch { /* first failure, or a corrupt counter that starts over */ }
      const n = (Number(sessions[sid]) || 0) + 1;
      delete sessions[sid];
      sessions[sid] = n;
      const kept = Object.fromEntries(Object.entries(sessions).slice(-FAILURE_SESSIONS_KEPT));
      atomicWriteSync(counter, `${JSON.stringify({ sessions: kept })}\n`, { mode: 0o600 });
      parts.push(`failures=${n}`);
    }
    try {
      if (fs.statSync(log).size > TRACE_MAX_BYTES) fs.renameSync(log, `${log}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(log, `${new Date().toISOString()} ${parts.join(' ')}\n`, { mode: 0o600 });
  } catch {
    // tracing is best-effort; a hook never fails because its log did
  }
}
