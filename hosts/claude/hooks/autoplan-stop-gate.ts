#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * autoplan-stop-gate — opt-in enforcement for /autoplan (GST-1666). Off unless
 * autoplan_gate is on (env GSTACK_AUTOPLAN_GATE, then config, then
 * SWITCH_DEFAULT). Registered through one shim: autoplan-stop-gate-stop (Stop).
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
 *     -> every applicable phase published and the gate written (lib/autoplan-stop-gate.ts): released
 *     -> 3 blocks already: exhausted, the stop goes through
 *     -> otherwise blocked via=stop missing=<step>, the reason names the next step
 *
 * Markers are counted in the session record (with the run's phases and
 * publications) and traced in $GSTACK_STATE_ROOT/hooks/autoplan-gate.log; a
 * block carries its marker as the reason's first line, the others ride
 * systemMessage. Errors fail open (lib/skill-gates.ts runGateHook). Docs:
 * docs/skill-gates.md.
 */
import { sessionKind } from './spawn-bin';
import { SKILL, checkRun, missingStep } from '../../../lib/autoplan-stop-gate';
import { isFinalTurn, sameSkill, skillLoads, turnEnd } from '../../../lib/skill-contract';
import { readSkillSwitch } from '../../../lib/skill-route';
import {
  blockWith, hookRecord, note, pruneSessionDirs, readGateRecord, recordPath, remainingMs, runGateHook, sessionDir, settledTranscript, systemMessage,
  withSessionLock, writeGateRecord, type GatePayload, type HookOutput,
} from '../../../lib/skill-gates';

const HOOK = 'autoplan-gate';
const MAX_BLOCKS = 3;
const SESSION_KIND_TIMEOUT_MS = 1000;

function handle(p: GatePayload): HookOutput | undefined {
  if (p.event && p.event !== 'Stop') return undefined;
  const { t } = settledTranscript(p.transcriptPath, p.raw.last_assistant_message);
  const load = skillLoads(t).filter(l => sameSkill(l.skill, SKILL)).pop();
  if (!load) return undefined;
  if (!isFinalTurn(turnEnd(t), () => sessionKind(Math.min(SESSION_KIND_TIMEOUT_MS, remainingMs())))) return undefined;
  const check = checkRun(t, load);
  if (check.pendingAgents.length) return undefined;
  const key = `${SKILL}@${load.line}`;
  const dir = sessionDir(p.sessionId);
  return withSessionLock(dir, () => {
    const recFile = recordPath(p.sessionId);
    const rec = readGateRecord(recFile, p.sessionId);
    rec.transcript_path = p.transcriptPath;
    const h = hookRecord(rec, HOOK);
    const save = () => writeGateRecord(recFile, rec);
    if (check.mode === 'runner') {
      if (h.skipped[key]) return undefined;
      h.skipped[key] = new Date().toISOString();
      save();
      return systemMessage([note(HOOK, 'skipped', p.sessionId, { skill: SKILL, reason: 'runner' })]);
    }
    let run = h.runs[key];
    if (run?.released_at || run?.exhausted_at) return undefined;
    const sys: string[] = [];
    if (!run) {
      run = h.runs[key] = { skill: SKILL, load_line: load.line, fired_at: new Date().toISOString(), blocked: 0, observed: 0 };
      sys.push(note(HOOK, 'fired', p.sessionId, { skill: SKILL, on: p.event || 'Stop' }));
      pruneSessionDirs(dir);
    }
    run.phases = check.phases ?? undefined;
    run.published = check.published;
    if (!check.missing) {
      run.released_at = new Date().toISOString();
      save();
      sys.push(note(HOOK, 'released', p.sessionId, { skill: SKILL, phases: check.published.join(','), blocked: run.blocked }));
      return systemMessage(sys);
    }
    if (run.blocked >= MAX_BLOCKS) {
      run.exhausted_at = new Date().toISOString();
      save();
      sys.push(note(HOOK, 'exhausted', p.sessionId, { skill: SKILL, missing: check.missing, blocked: run.blocked }));
      return systemMessage(sys);
    }
    run.blocked++;
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
