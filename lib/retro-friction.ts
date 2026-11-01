/**
 * retro-friction — the "Friction by skill" numbers /retro shows, computed from
 * two per-project logs so the retro prompt reads finished lines instead of
 * aggregating JSONL itself.
 *
 *   projects/<slug>/timeline.jsonl      gstack-skill-start / gstack-skill-end,
 *                                       written on every run: runs (started)
 *                                       and explicit error / abort outcomes
 *   projects/<slug>/question-log.jsonl  gstack-question-log (question tuning
 *                                       on): questions a person answered
 *
 * Only explicit outcomes count: the stop hook's `unknown` completions and
 * unmatched starts are not aborts. Machine answers (auto-decided, spawned-env
 * denies, Codex imports) are not questions. The Claude Code question hook logs
 * skill `unknown` (it cannot tell which skill asked), so those rows are not
 * counted; the agent's own rows carry the skill. Per skill and session,
 * hook-captured rows that do name a skill win over the agent's rows for the
 * same questions, so one question counts once. Skill names outside ^[a-z0-9-]{1,64}$ are dropped so log text
 * never reaches the prompt. Idea credit: @thesohamdatta (#3417).
 *
 * CLI (bin/gstack-retro-metrics):
 *   --timeline <file> --questions <file> --since-epoch <s> [--until-epoch <s>]
 * prints FRICTION_SOURCES: and FRICTION: lines.
 */
import * as fs from 'node:fs';

export interface SkillFriction {
  skill: string;
  runs: number;
  questions: number;
  typed: number;
  errors: number;
  aborts: number;
  score: number;
}

export interface FrictionInput {
  timelineLines: string[];
  questionLines: string[];
  sinceMs: number;
  untilMs?: number;
}

const SKILL_RE = /^[a-z0-9-]{1,64}$/;
const HUMAN_SOURCES = new Set(['agent', 'hook', 'auq-other']);
export const FRICTION_TOP = 3;

function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const j = JSON.parse(line);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function skillOf(j: Record<string, unknown>): string | null {
  if (typeof j.skill !== 'string') return null;
  const s = j.skill.replace(/^\//, '').toLowerCase();
  return SKILL_RE.test(s) ? s : null;
}

function inWindow(j: Record<string, unknown>, sinceMs: number, untilMs?: number): boolean {
  if (typeof j.ts !== 'string') return false;
  const t = Date.parse(j.ts);
  if (Number.isNaN(t) || t < sinceMs) return false;
  return untilMs === undefined || t <= untilMs;
}

export function frictionBySkill(input: FrictionInput): SkillFriction[] {
  const bySkill = new Map<string, SkillFriction>();
  const entry = (skill: string): SkillFriction => {
    let e = bySkill.get(skill);
    if (!e) {
      e = { skill, runs: 0, questions: 0, typed: 0, errors: 0, aborts: 0, score: 0 };
      bySkill.set(skill, e);
    }
    return e;
  };

  for (const line of input.timelineLines) {
    const j = parse(line);
    if (!j || !inWindow(j, input.sinceMs, input.untilMs)) continue;
    const skill = skillOf(j);
    if (!skill) continue;
    if (j.event === 'started') entry(skill).runs++;
    else if (j.event === 'completed' && j.outcome === 'error') entry(skill).errors++;
    else if (j.event === 'completed' && j.outcome === 'abort') entry(skill).aborts++;
  }

  const groups = new Map<string, { skill: string; hook: Record<string, unknown>[]; agent: Record<string, unknown>[] }>();
  const seenToolUse = new Set<string>();
  for (const line of input.questionLines) {
    const j = parse(line);
    if (!j || !inWindow(j, input.sinceMs, input.untilMs)) continue;
    const skill = skillOf(j);
    const source = typeof j.source === 'string' ? j.source : 'agent';
    if (!skill || skill === 'unknown' || !HUMAN_SOURCES.has(source)) continue;
    const toolUse = typeof j.tool_use_id === 'string' && j.tool_use_id ? j.tool_use_id : '';
    if (toolUse) {
      const key = `${source}:${toolUse}`;
      if (seenToolUse.has(key)) continue;
      seenToolUse.add(key);
    }
    const session = typeof j.session_id === 'string' ? j.session_id : '';
    const gkey = `${skill}\u0000${session}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { skill, hook: [], agent: [] };
      groups.set(gkey, g);
    }
    const hookCaptured = source === 'hook' || (source === 'auq-other' && toolUse !== '');
    (hookCaptured ? g.hook : g.agent).push(j);
  }
  for (const g of groups.values()) {
    const rows = g.hook.length > 0 ? g.hook : g.agent;
    const e = entry(g.skill);
    e.questions += rows.length;
    e.typed += rows.filter((r) => r.source === 'auq-other').length;
  }

  for (const e of bySkill.values()) e.score = e.questions + e.errors + e.aborts;
  return [...bySkill.values()]
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
}

export function formatFriction(
  rows: SkillFriction[],
  sources: { timeline: boolean; questions: boolean },
): string[] {
  const out = [
    `FRICTION_SOURCES: timeline=${sources.timeline ? 'present' : 'absent'} questions=${sources.questions ? 'present' : 'absent'}`,
  ];
  if (rows.length === 0) return [...out, 'FRICTION: none'];
  for (const e of rows.slice(0, FRICTION_TOP)) {
    out.push(
      `FRICTION: /${e.skill} score=${e.score} runs=${e.runs} questions=${e.questions} typed=${e.typed} errors=${e.errors} aborts=${e.aborts}`,
    );
  }
  return out;
}

function readLines(file: string | undefined): string[] | null {
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8').split('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const since = Number(arg('--since-epoch'));
  const untilRaw = arg('--until-epoch');
  const until = untilRaw === undefined || untilRaw === '' ? undefined : Number(untilRaw);
  if (!Number.isFinite(since) || (until !== undefined && !Number.isFinite(until))) {
    console.log('FRICTION: unavailable (window bounds did not resolve)');
    process.exit(0);
  }
  const timeline = readLines(arg('--timeline'));
  const questions = readLines(arg('--questions'));
  const rows = frictionBySkill({
    timelineLines: timeline ?? [],
    questionLines: questions ?? [],
    sinceMs: since * 1000,
    untilMs: until === undefined ? undefined : until * 1000,
  });
  for (const line of formatFriction(rows, { timeline: timeline !== null, questions: questions !== null })) console.log(line);
}
