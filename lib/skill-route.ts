/**
 * skill-route — deterministic prompt-to-skill routing (GST-1088, lane A).
 *
 * The UserPromptSubmit hook (hosts/claude/hooks/skill-route-hook.ts) and
 * `gstack-skill-route --explain` score a prompt against the `triggers:` lists
 * in the installed skills' SKILL.md frontmatter. No model call, no network:
 * the same prompt and the same installed skills always give the same route.
 *
 * Also home to what both skill hooks share: the on/off switches
 * (skill_routing, skill_contracts), the installed-skills directory, the
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
/** Longer prompts (pasted logs, files) are never routed: their words match everything. */
export const PROMPT_MAX_CHARS = 8000;
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const MAX_SKILLS = 256;
const MAX_TRIGGER_CHARS = 200;
const TRACE_MAX_BYTES = 1024 * 1024;
const FAILURE_SESSIONS_KEPT = 64;

export type SwitchName = 'skill_routing' | 'skill_contracts' | 'ceo_review_gate' | 'autoplan_gate';
export const SWITCH_ENV: Record<SwitchName, string> = {
  skill_routing: 'GSTACK_SKILL_ROUTING',
  skill_contracts: 'GSTACK_SKILL_CONTRACTS',
  ceo_review_gate: 'GSTACK_CEO_REVIEW_GATE',
  autoplan_gate: 'GSTACK_AUTOPLAN_GATE',
};

/** Each switch's one default. setup, gstack-config and gstack-skill-route read it through `gstack-skill-route --default <switch>`; the hooks read it here. */
export const SWITCH_DEFAULT: Record<SwitchName, 'on' | 'off'> = {
  skill_routing: 'off',
  skill_contracts: 'off',
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

export interface InstalledSkill { name: string; file: string; frontmatter: string; triggers: string[] }

/** Every installed skill with frontmatter, sorted by directory; `problems` names skills whose triggers the repo's reader cannot use. */
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
    let triggers: string[] = [];
    if (/^triggers:/m.test(frontmatter)) {
      triggers = frontmatterList(`---\n${frontmatter}\n---`, 'triggers');
      if (!triggers.length || triggers.some(t => !t || t.length > MAX_TRIGGER_CHARS)) {
        problems.push(`${name}: malformed triggers`);
        triggers = [];
      }
    }
    skills.push({ name, file, frontmatter, triggers });
  }
  return { skills, problems };
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

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];

export function tokens(text: string): string[] {
  return words(text).map(stem);
}

export function contentTokens(text: string): string[] {
  return [...new Set(words(text).filter(w => !STOPWORDS.has(w)).map(stem))];
}

export interface RouteCandidate { skill: string; score: number; matched: number; trigger: string; file: string }

/** A lone content word specific enough to route on by itself: five or more letters, not a question word. */
const SPECIFIC_WORD = /^(?!(?:what|which|where|whose)$)[a-z0-9]{5,}$/;

/**
 * Every skill whose best trigger shares a content word with the prompt, best first (score, matched words,
 * name). A trigger's score is 1 when its whole phrase appears in the prompt, else the share of its content
 * words (stopwords dropped, lightly stemmed) that the prompt contains. A trigger with one content word scores
 * only on its whole phrase unless that word is specific (SPECIFIC_WORD).
 */
export function scorePrompt(prompt: string, skills: InstalledSkill[]): RouteCandidate[] {
  const promptSeq = ` ${tokens(prompt).join(' ')} `;
  const promptSet = new Set(contentTokens(prompt));
  const out: RouteCandidate[] = [];
  for (const skill of skills) {
    let best: RouteCandidate | null = null;
    for (const trigger of skill.triggers) {
      const content = contentTokens(trigger);
      if (!content.length) continue;
      const matched = content.filter(w => promptSet.has(w)).length;
      const phrase = promptSeq.includes(` ${tokens(trigger).join(' ')} `);
      const weakSingle = content.length === 1 && !SPECIFIC_WORD.test(content[0]);
      const score = phrase ? 1 : weakSingle ? 0 : Math.round((matched / content.length) * 100) / 100;
      if (score > 0 && (!best || score > best.score || (score === best.score && matched > best.matched))) {
        best = { skill: skill.name, score, matched, trigger, file: skill.file };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || b.matched - a.matched || a.skill.localeCompare(b.skill));
}

/**
 * The skills the hook may route to: plan-v2 decision 4's discovery targets. Run D's prompts showed routing
 * every installed skill's triggers false-routes most non-fit prompts (docs/skill-routing-and-contracts.md).
 */
export const ROUTED_SKILLS = ['review', 'qa', 'verify'];
const isRouted = (name: string) => ROUTED_SKILLS.includes(name.toLowerCase().replace(/^gstack[-:]/, ''));

export type RouteDecision =
  | { route: RouteCandidate; candidates: RouteCandidate[] }
  | { route: null; reason: 'slash-command' | 'prompt-too-long' | 'empty' | 'below-threshold'; candidates: RouteCandidate[] };

export function routePrompt(prompt: string, skills: InstalledSkill[], threshold = ROUTE_THRESHOLD): RouteDecision {
  const trimmed = prompt.trim();
  if (!trimmed) return { route: null, reason: 'empty', candidates: [] };
  if (trimmed.startsWith('/')) return { route: null, reason: 'slash-command', candidates: [] };
  if (prompt.length > PROMPT_MAX_CHARS) return { route: null, reason: 'prompt-too-long', candidates: [] };
  const candidates = scorePrompt(prompt, skills.filter(s => isRouted(s.name)));
  const top = candidates[0];
  return top && top.score >= threshold ? { route: top, candidates } : { route: null, reason: 'below-threshold', candidates };
}

export type HintVariant = 'name' | 'step' | 'contract';
export const HINT_VARIANTS: HintVariant[] = ['name', 'step', 'contract'];
/** The default line (d6 pilot); GSTACK_SKILL_ROUTE_HINT selects another variant for the pilot. */
export const DEFAULT_HINT_VARIANT: HintVariant = 'name';

export function hintVariant(env: NodeJS.ProcessEnv = process.env): HintVariant {
  const v = (env.GSTACK_SKILL_ROUTE_HINT || '').trim().toLowerCase();
  return (HINT_VARIANTS as string[]).includes(v) ? v as HintVariant : DEFAULT_HINT_VARIANT;
}

/** The one additionalContext line: its source, its off switch, the skill, and the ask to say gstack routed it. */
export function hintLine(route: RouteCandidate, extra = ''): string {
  const s = `/${route.skill}`;
  const trigger = route.trigger.replace(/["\s]+/g, ' ').trim();
  return `gstack skill routing (UserPromptSubmit hook; matched the installed ${s} trigger "${trigger}"; off: gstack-config set skill_routing off): ` +
    `this request fits ${s}. Run ${s} with the Skill tool before you start, and tell the user in one sentence that gstack routed this to ${s}.` +
    (extra.trim() ? ` ${extra.replace(/\s+/g, ' ').trim()}` : '');
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
