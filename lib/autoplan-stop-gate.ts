/**
 * autoplan-stop-gate — the run check behind the opt-in /autoplan stop gate
 * (GST-1666). Docs: docs/skill-gates.md.
 *
 * One /autoplan run is the transcript from its load to the next /autoplan load.
 * A full run is met when Phase 0 ran scope (a snapshot init or scope result),
 * every phase that scope makes applicable (CEO and Eng always, Design when
 * uiRequired, DX when dxRequired) published its report, and the Phase 4 Final
 * Approval Gate is written. A phase publishes as phase-close.md step 6 says:
 * assistant text with its "Phase N complete" line, then a successful Bash no-op
 * "true autoplan-published <phase>". A no-op counts only when that report came
 * after the previous no-op and every earlier applicable phase already counted
 * (GST-1814); publishCheck refuses the others before they run. The gate is a successful gstack-gate render
 * or a Write of a gate.json. A --ceo-only run is met when Phase 1 published and
 * its text holds the "GSTACK_RESULT: skill=autoplan status=reviewed" end line.
 * A run that drives the gstack-autoplan runner is mode runner: the runner keeps
 * its own record, so the gate leaves it alone.
 */
import type { SkillLoad, Transcript, TranscriptEvent } from './skill-contract';
import { sameSkill, skillLoads } from './skill-contract';

export const SKILL = 'autoplan';
export type Phase = 'ceo' | 'design' | 'dx' | 'eng';
export const PHASE_ORDER: readonly Phase[] = ['ceo', 'design', 'dx', 'eng'];
export const PHASE_NUMBER: Record<Phase, string> = { ceo: '1', design: '2', dx: '2.5', eng: '3' };
export const PHASE_NAME: Record<Phase, string> = { ceo: 'CEO', design: 'Design', dx: 'DX', eng: 'Eng' };
/** The next step a run is missing: Phase 0 scope, a phase, the Final Approval Gate, or the --ceo-only end line. */
export type Missing = 'scope' | Phase | 'gate' | 'end';

const SNAPSHOT = /gstack-autoplan-snapshot(?:\.ts)?["']?\s+(init|scope)(?:\s|$)/;
export const PUBLISHED = /^\s*true\s+autoplan-published\s+(ceo|design|dx|eng)\s*$/;
const PHASE_READ = /(?:^|[\\/])autoplan[\\/]sections[\\/](ceo|design|dx|eng)-phase\.md$/;
const GATE_RENDER = /gstack-gate["']?\s+render(?:\s|$)/;
const GATE_FILE = /(?:^|[\\/])gate\.json$/;
const RUNNER = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:bun\s+(?:-\S+\s+)*)?["']?(?:[^\s"';&|]*[\\/])?gstack-autoplan(?:\.ts)?["']?\s+(?:next|submit|answer|export)(?:\s|$)/;
const CEO_ONLY_END = /GSTACK_RESULT:\s*skill=autoplan\s+status=reviewed\b/;
const AGENT_TOOLS = /^(?:Agent|Task)$/;

export interface RunCheck {
  mode: 'full' | 'ceo-only' | 'runner';
  /** the applicable phases in order, or null when Phase 0 has not run scope */
  phases: Phase[] | null;
  /** phases whose driver section was Read */
  entered: Phase[];
  /** phases that published, in phase order, each after its own report */
  published: Phase[];
  /** publish no-ops that did not count: no report since the previous no-op, or not the phase due */
  uncounted: Array<{ phase: Phase; why: 'no-report' | 'out-of-order'; due?: Phase }>;
  /** phases with a report line anywhere in the run */
  reported: Phase[];
  /** phases with a report line since the last successful publish no-op */
  reportedSinceLast: Phase[];
  gate: boolean;
  missing: Missing | null;
  /** Agent or Task calls launched in the background that have not reported back */
  pendingAgents: string[];
}

type ToolUse = Extract<TranscriptEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<TranscriptEvent, { kind: 'tool_result' }>;

function jsonObject(text: string): Record<string, any> | null {
  for (const candidate of [text.trim(), ...text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).reverse()]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not this one */ }
  }
  return null;
}

function scopePhases(scope: unknown): Phase[] | null {
  if (!scope || typeof scope !== 'object') return null;
  const { uiRequired, dxRequired } = scope as Record<string, unknown>;
  if (typeof uiRequired !== 'boolean' || typeof dxRequired !== 'boolean') return null;
  return PHASE_ORDER.filter(p => p === 'ceo' || p === 'eng' || (p === 'design' && uiRequired) || (p === 'dx' && dxRequired));
}

function isCeoOnly(load: SkillLoad, events: TranscriptEvent[]): boolean {
  const e = events[load.at];
  if (e?.kind === 'prompt') return /<command-args>[^<]*--ceo-only\b/.test(e.text);
  if (e?.kind === 'tool_use' && [e.input.args, e.input.command, e.input.skill].some(v => /--ceo-only\b/.test(String(v ?? '')))) return true;
  const asked = events.slice(0, load.at).findLast(p => p.kind === 'prompt');
  return asked?.kind === 'prompt' && /--ceo-only\b/.test(asked.text);
}

/** Check one /autoplan run: what it did, and the first step it is missing. */
export function checkRun(t: Transcript, load: SkillLoad): RunCheck {
  const next = skillLoads(t).find(l => l.at > load.at && sameSkill(l.skill, SKILL));
  const run = t.events.slice(load.at + 1, next?.at);
  const results = new Map<string, ToolResult>();
  for (const e of run) if (e.kind === 'tool_result') results.set(e.id, e);
  const ok = (u: ToolUse) => { const r = results.get(u.id); return !!r && !r.isError && !r.text.includes('<tool_use_error>'); };
  const uses = run.filter((e): e is ToolUse => e.kind === 'tool_use');
  const bash = uses.filter(u => u.name === 'Bash' && typeof u.input.command === 'string' && ok(u));

  const mode: RunCheck['mode'] = bash.some(u => RUNNER.test(u.input.command)) ? 'runner' : isCeoOnly(load, t.events) ? 'ceo-only' : 'full';

  let phases: Phase[] | null = null;
  for (const u of bash) {
    const m = SNAPSHOT.exec(u.input.command);
    if (!m) continue;
    const out = jsonObject(results.get(u.id)!.text);
    phases = scopePhases(m[1] === 'init' ? out?.scope : out) ?? phases;
  }
  if (mode === 'ceo-only') phases = ['ceo'];

  const entered = [...new Set(uses.flatMap(u => (u.name === 'Read' && ok(u) ? [PHASE_READ.exec(String(u.input.file_path ?? ''))?.[1] as Phase | undefined] : []).filter((p): p is Phase => !!p)))];

  const reportsIn = (events: TranscriptEvent[]) => PHASE_ORDER.filter(p => {
    const said = new RegExp(`Phase\\s+${PHASE_NUMBER[p].replace('.', '\\.')}(?![\\d.])[^\\n]*?\\bcomplete\\b`, 'i');
    return events.some(e => e.kind === 'text' && said.test(e.text));
  });
  const published: Phase[] = [];
  const uncounted: RunCheck['uncounted'] = [];
  let from = 0;
  for (const u of bash) {
    const m = PUBLISHED.exec(u.input.command);
    if (!m) continue;
    const p = m[1] as Phase;
    const at = run.indexOf(u);
    if (!published.includes(p)) {
      if (!reportsIn(run.slice(from, at)).includes(p)) uncounted.push({ phase: p, why: 'no-report' });
      else if (p !== dueNext(phases, published, p)) uncounted.push({ phase: p, why: 'out-of-order', due: dueNext(phases, published, p) });
      else published.push(p);
    }
    from = at + 1;
  }

  const gate = uses.some(u => ok(u) && ((u.name === 'Bash' && typeof u.input.command === 'string' && GATE_RENDER.test(u.input.command)) ||
    ((u.name === 'Write' || u.name === 'Edit') && GATE_FILE.test(String(u.input.file_path ?? '')))));

  const pendingAgents = uses.flatMap(u => {
    if (!AGENT_TOOLS.test(u.name)) return [];
    const r = results.get(u.id);
    if (!r) return [u.id];
    if (!ok(u)) return [];
    if (u.input.run_in_background !== true && !/async_launched|"?isAsync"?\s*:\s*true|async agent launched/i.test(r.text)) return [];
    const ids = [u.id, ...[...r.text.matchAll(/\b(?:agent|task)[_ -]?id["']?\s*[:=]\s*["']?([\w-]+)/gi)].map(m => m[1])];
    const notified = run.slice(run.indexOf(r) + 1).some(e => e.kind === 'meta' && ids.some(id => e.text.includes(id)));
    return notified ? [] : [u.id];
  });

  let missing: Missing | null = null;
  if (mode !== 'runner') {
    if (!phases) missing = 'scope';
    else missing = phases.find(p => !published.includes(p)) ?? null;
    if (!missing && mode === 'full' && !gate) missing = 'gate';
    if (!missing && mode === 'ceo-only' && !run.some(e => e.kind === 'text' && CEO_ONLY_END.test(e.text))) missing = 'end';
  }
  return { mode, phases, entered, published, uncounted, reported: reportsIn(run), reportedSinceLast: reportsIn(run.slice(from)), gate, missing, pendingAgents };
}

/**
 * The phase that may publish next: the first applicable phase not yet published.
 * Before scope is known, CEO (which always applies) comes first; after it any
 * phase later in PHASE_ORDER than every published one may (returned as `p`
 * itself), so an unread scope never refuses a later phase.
 */
function dueNext(phases: Phase[] | null, published: Phase[], p: Phase): Phase | undefined {
  if (phases) return phases.find(q => !published.includes(q));
  if (!published.includes('ceo')) return 'ceo';
  return published.every(q => PHASE_ORDER.indexOf(q) < PHASE_ORDER.indexOf(p)) ? p : published.at(-1);
}

const label = (p: Phase) => `Phase ${PHASE_NUMBER[p]} (${PHASE_NAME[p]})`;
const dueLine = (p: Phase) => `Next due: the ${label(p)} report.`;
const howToPublish = (p: Phase) => `its report as text starting "**Phase ${PHASE_NUMBER[p]} complete.**" (autoplan/sections/phase-close.md step 6) in a message whose only tool call is: true autoplan-published ${p}`;

/**
 * The refusal for a publish no-op of `p` about to run, or null to let it run:
 * a phase publishes only when it is the phase due and its report was sent since
 * the previous publish no-op (the same message counts). Republishing a phase
 * that already counted, runner mode, and a phase scope makes inapplicable pass.
 */
export function publishCheck(c: RunCheck, p: Phase): { why: 'no-report' | 'out-of-order'; due: Phase; reason: string } | null {
  if (c.mode === 'runner' || c.published.includes(p) || (c.phases && !c.phases.includes(p))) return null;
  const due = dueNext(c.phases, c.published, p) ?? p;
  if (due !== p) {
    const before = (c.phases ? c.phases.slice(0, c.phases.indexOf(p)).filter(q => !c.published.includes(q)) : [due]).map(label);
    return { why: 'out-of-order', due, reason: [dueLine(due),
      `/autoplan publishes phases in order (${(c.phases ?? PHASE_ORDER).join(', ')}): ${label(p)} cannot publish before ${before.join(' and ')}.`,
      `When ${label(due)}'s review is finished, send ${howToPublish(due)}`].join('\n') };
  }
  if (c.reportedSinceLast.includes(p)) return null;
  return { why: 'no-report', due, reason: [dueLine(p),
    `${label(p)} cannot publish without its report. Send ${howToPublish(p)}`].join('\n') };
}

/** The block text for a run's missing step: what is not done and the next thing to do. */
export function missingStep(c: RunCheck): string {
  const m = c.missing;
  if (m === 'scope') return '/autoplan is not done: Phase 0 has not run scope, so no review phase has started. Run Phase 0 now (bun "<SNAPSHOT_TOOL>" init ...), then run every applicable phase in order in this turn.';
  if (m === 'gate') return '/autoplan is not done: every applicable phase published, but the Phase 4 Final Approval Gate is not written. Read autoplan/sections/tasks-aggregator.md, write $_AP/gate.json and run gstack-gate render on it, then present the gate.';
  if (m === 'end') return '/autoplan --ceo-only is not done: Phase 1 published, but the run has not finished. Write $_AP/ceo-review.md as the --ceo-only section says and end with: GSTACK_RESULT: skill=autoplan status=reviewed run=<absolute $_AP>';
  if (!m) return '';
  const uncounted = c.uncounted.length
    ? [`Not counted: ${c.uncounted.map(u => `true autoplan-published ${u.phase} (${u.why === 'no-report' ? 'no report before it' : `out of order: ${u.due ? label(u.due) : 'another phase'} was due`})`).join(', ')}.`]
    : [];
  const step = c.entered.includes(m) || c.reported.includes(m) || c.uncounted.some(u => u.phase === m)
    ? `/autoplan is not done: ${label(m)} has not published its report. Finish its close procedure (autoplan/sections/phase-close.md), then send its report starting "**Phase ${PHASE_NUMBER[m]} complete.**" in a message whose only tool call is the Bash no-op: true autoplan-published ${m}`
    : `/autoplan is not done: ${label(m)} has not run. Continue the pipeline at its driver Read (autoplan/sections/${m}-phase.md) and run it through its close in this turn, then send its report starting "**Phase ${PHASE_NUMBER[m]} complete.**" in a message whose only tool call is: true autoplan-published ${m}`;
  return [dueLine(m), step, ...uncounted].join('\n');
}
