#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * autoplan-stop-gate — opt-in enforcement for /autoplan (GST-1666). Off unless
 * autoplan_gate is on (env GSTACK_AUTOPLAN_GATE, then config, then
 * SWITCH_DEFAULT). Registered through two shims: autoplan-stop-gate-stop (Stop)
 * and autoplan-stop-gate-publish (PreToolUse on Bash).
 *
 *   PreToolUse: a Bash `true autoplan-published <phase>` in the session that
 *     loaded /autoplan, once the transcript holds that call (else it runs)
 *     -> a released or exhausted run? it runs
 *     -> lib/autoplan-stop-gate.ts publishCheck: the phase is the one due and
 *        its report was sent since the previous publish no-op? it runs
 *     -> otherwise denied: blocked via=publish why=<no-report|out-of-order>,
 *        the reason names the report due next (GST-1814)
 *
 *   Stop: payload transcript_path (+ last_assistant_message), re-read until it
 *     holds that final message (lib/skill-gates.ts settledTranscript)
 *     -> the last /autoplan load (none: nothing)
 *     -> a final turn? (lib/skill-contract.ts isFinalTurn; a question to a
 *        human in an interactive session is never blocked)
 *     -> a native reviewer launched in the background has not reported: nothing
 *     -> released, exhausted or skipped for this run? nothing
 *     -> a run that drives the gstack-autoplan runner: skipped reason=runner
 *     -> first final stop of the run: marker fired
 *     -> every applicable phase published in order and the gate written: released
 *     -> budget spent: exhausted, the stop goes through. Blocks count against
 *        the step they name (3 per step, reset when the step advances) only
 *        once the run has sent a phase report; 12 blocks end any run
 *     -> otherwise blocked via=stop missing=<step>, the reason names the next step
 *
 * Markers are counted in the session record (with the run's phases and
 * publications) and traced in $GSTACK_STATE_ROOT/hooks/autoplan-gate.log; a
 * block or denial carries its marker as the reason's first line, the others
 * ride systemMessage. Errors fail open (lib/skill-gates.ts runGateHook). Docs:
 * docs/skill-gates.md.
 */
import { sessionKind } from './spawn-bin';
import { PUBLISHED, SKILL, checkRun, missingStep, publishCheck, type Phase } from '../../../lib/autoplan-stop-gate';
import { isFinalTurn, sameSkill, skillLoads, turnEnd, type SkillLoad } from '../../../lib/skill-contract';
import { readSkillSwitch } from '../../../lib/skill-route';
import {
  blockWith, denyTool, hookRecord, note, pruneSessionDirs, readGateRecord, recordPath, remainingMs, runGateHook, sessionDir, settledTranscript, systemMessage,
  transcriptWithToolUse, withSessionLock, writeGateRecord, type GatePayload, type GateRun, type HookOutput,
} from '../../../lib/skill-gates';

const HOOK = 'autoplan-gate';
const MAX_STEP_BLOCKS = 3;
const MAX_RUN_BLOCKS = 12;
const SESSION_KIND_TIMEOUT_MS = 1000;

/** Under the session lock: the run's record (created with a fired marker on its first decision), and a save. */
function withRun<T>(p: GatePayload, load: SkillLoad, fn: (run: GateRun | undefined, open: (sys: string[]) => GateRun, save: () => void, h: ReturnType<typeof hookRecord>, key: string) => T): T {
  const key = `${SKILL}@${load.line}`;
  const dir = sessionDir(p.sessionId);
  return withSessionLock(dir, () => {
    const recFile = recordPath(p.sessionId);
    const rec = readGateRecord(recFile, p.sessionId);
    rec.transcript_path = p.transcriptPath;
    const h = hookRecord(rec, HOOK);
    const open = (sys: string[]) => {
      if (h.runs[key]) return h.runs[key];
      sys.push(note(HOOK, 'fired', p.sessionId, { skill: SKILL, on: p.event || 'Stop' }));
      pruneSessionDirs(dir);
      return (h.runs[key] = { skill: SKILL, load_line: load.line, fired_at: new Date().toISOString(), blocked: 0, observed: 0 });
    };
    return fn(h.runs[key], open, () => writeGateRecord(recFile, rec), h, key);
  });
}

function onPublish(p: GatePayload): HookOutput | undefined {
  const input = p.raw.tool_input as Record<string, unknown> | undefined;
  const phase = PUBLISHED.exec(String(input?.command ?? ''))?.[1] as Phase | undefined;
  if (p.raw.tool_name !== 'Bash' || !phase || p.raw.agent_id) return undefined;
  const t = transcriptWithToolUse(p.transcriptPath, String(p.raw.tool_use_id ?? ''));
  if (!t) return systemMessage([note(HOOK, 'skipped', p.sessionId, { skill: SKILL, reason: 'unsettled', phase })]);
  const load = skillLoads(t).filter(l => sameSkill(l.skill, SKILL)).pop();
  if (!load) return undefined;
  const check = checkRun(t, load);
  const refusal = publishCheck(check, phase);
  if (!refusal) return undefined;
  return withRun(p, load, (existing, open, save) => {
    if (existing?.released_at || existing?.exhausted_at) return undefined;
    const sys: string[] = [];
    const run = open(sys);
    run.phases = check.phases ?? undefined;
    run.published = check.published;
    run.denied = (run.denied ?? 0) + 1;
    save();
    const marker = note(HOOK, 'blocked', p.sessionId, { skill: SKILL, via: 'publish', phase, why: refusal.why, missing: refusal.due, n: run.denied });
    return denyTool(`${marker}\n${refusal.reason}`, sys);
  });
}

function handle(p: GatePayload): HookOutput | undefined {
  if (p.event === 'PreToolUse') return onPublish(p);
  if (p.event && p.event !== 'Stop') return undefined;
  const { t } = settledTranscript(p.transcriptPath, p.raw.last_assistant_message);
  const load = skillLoads(t).filter(l => sameSkill(l.skill, SKILL)).pop();
  if (!load) return undefined;
  if (!isFinalTurn(turnEnd(t), () => sessionKind(Math.min(SESSION_KIND_TIMEOUT_MS, remainingMs())))) return undefined;
  const check = checkRun(t, load);
  if (check.pendingAgents.length) return undefined;
  return withRun(p, load, (existing, open, save, h, key) => {
    if (check.mode === 'runner') {
      if (h.skipped[key]) return undefined;
      h.skipped[key] = new Date().toISOString();
      save();
      return systemMessage([note(HOOK, 'skipped', p.sessionId, { skill: SKILL, reason: 'runner' })]);
    }
    if (existing?.released_at || existing?.exhausted_at) return undefined;
    const sys: string[] = [];
    const run = open(sys);
    run.phases = check.phases ?? undefined;
    run.published = check.published;
    if (!check.missing) {
      run.released_at = new Date().toISOString();
      save();
      sys.push(note(HOOK, 'released', p.sessionId, { skill: SKILL, phases: check.published.join(','), blocked: run.blocked }));
      return systemMessage(sys);
    }
    const counting = check.reported.length > 0;
    if (run.step !== check.missing) { run.step = check.missing; run.step_blocks = 0; }
    if ((counting && (run.step_blocks ?? 0) >= MAX_STEP_BLOCKS) || run.blocked >= MAX_RUN_BLOCKS) {
      run.exhausted_at = new Date().toISOString();
      save();
      sys.push(note(HOOK, 'exhausted', p.sessionId, { skill: SKILL, missing: check.missing, blocked: run.blocked }));
      return systemMessage(sys);
    }
    run.blocked++;
    if (counting) run.step_blocks = (run.step_blocks ?? 0) + 1;
    save();
    const marker = note(HOOK, 'blocked', p.sessionId, { skill: SKILL, via: 'stop', missing: check.missing, published: check.published.join(',') || 'none', n: run.blocked });
    const body = [
      missingStep(check),
      `Applicable phases: ${check.phases?.join(', ') ?? 'unknown until Phase 0 runs scope'}. Published so far: ${check.published.join(', ') || 'none'}.`,
      'Phase notifications are progress updates: keep going in this turn instead of stopping.',
    ].join('\n');
    return blockWith(`${marker}\n${body}`, sys);
  });
}

runGateHook(HOOK, () => readSkillSwitch('autoplan_gate').on, handle).finally(() => process.exit(0));
