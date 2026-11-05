#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * ceo-review-gate — opt-in enforcement for /plan-ceo-review (GST-1461). Off
 * unless ceo_review_gate is on (env GSTACK_CEO_REVIEW_GATE, then config, then
 * SWITCH_DEFAULT). Registered through two shims: ceo-review-gate-stop (Stop)
 * and ceo-review-gate-subagent-stop (SubagentStop).
 *
 *   Stop: payload transcript_path (+ last_assistant_message)
 *   SubagentStop: payload agent_transcript_path, sidechain records included,
 *     so only a subagent that itself loaded /plan-ceo-review is gated
 *     -> the last /plan-ceo-review load (none: nothing)
 *     -> Stop only: a final turn? (lib/skill-contract.ts isFinalTurn; a
 *        question to a human in an interactive session is never blocked)
 *     -> released or exhausted for this run? nothing
 *     -> first final stop of the run: marker fired
 *     -> an output file ranks the top risks (lib/ceo-review-gate.ts): released
 *     -> 3 blocks already: exhausted, the stop goes through
 *     -> otherwise blocked via=stop, the reason names what to write and where
 *
 * stop_hook_active (a Stop hook already blocked this turn) does not skip the
 * check: the cap ends repeats. Markers are counted in the session record and
 * traced in $GSTACK_STATE_ROOT/hooks/ceo-review-gate.log; a block carries its
 * marker as the reason's first line, the others ride systemMessage. Errors
 * fail open (lib/skill-gates.ts runGateHook). Docs: docs/skill-gates.md.
 */
import * as path from 'path';
import { runBin, sessionKind } from './spawn-bin';
import { SKILL, checkOutput } from '../../../lib/ceo-review-gate';
import { StateError, UnknownShape, isFinalTurn, parseTranscript, readTranscriptFile, sameSkill, skillLoads, turnEnd, withFinalMessage } from '../../../lib/skill-contract';
import { readSkillSwitch } from '../../../lib/skill-route';
import {
  GateError, blockWith, hookRecord, note, pruneSessionDirs, readGateRecord, recordPath, remainingMs, runGateHook, sessionDir, systemMessage,
  withSessionLock, writeGateRecord, type GatePayload, type HookOutput,
} from '../../../lib/skill-gates';

const HOOK = 'ceo-review-gate';
const MAX_BLOCKS = 3;
const SESSION_KIND_TIMEOUT_MS = 1000;
const SLUG_TIMEOUT_MS = 2000;

function slug(cwd: string): string {
  const r = runBin('gstack-slug', ['--get', 'SLUG'], { cwd, encoding: 'utf8', timeout: Math.min(SLUG_TIMEOUT_MS, remainingMs()), windowsHide: true });
  const value = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !value) throw new GateError('GATE_SLUG', `gstack-slug failed: ${String(r.stderr ?? r.error ?? '').trim().split('\n')[0] || `exit ${r.status}`}`);
  return value;
}

function handle(p: GatePayload): HookOutput | undefined {
  const sub = p.event === 'SubagentStop';
  const file = sub ? p.raw.agent_transcript_path : p.transcriptPath;
  if (typeof file !== 'string' || !file) return undefined;
  let raw: string;
  let t;
  try {
    raw = readTranscriptFile(file);
    t = withFinalMessage(parseTranscript(raw, { includeSidechain: sub }), p.raw.last_assistant_message);
  } catch (e) {
    if (e instanceof StateError || e instanceof UnknownShape) throw new GateError('GATE_TRANSCRIPT', e.message);
    throw e;
  }
  const load = skillLoads(t).filter(l => sameSkill(l.skill, SKILL)).pop();
  if (!load) return undefined;
  if (!sub && !isFinalTurn(turnEnd(t), () => sessionKind(Math.min(SESSION_KIND_TIMEOUT_MS, remainingMs())))) return undefined;
  let since = Number.NaN;
  try { since = Date.parse(JSON.parse(raw.split('\n')[load.line - 1]).timestamp); } catch { /* checked below */ }
  if (Number.isNaN(since)) throw new GateError('GATE_TRANSCRIPT', `the /plan-ceo-review load on line ${load.line} has no timestamp`);
  const agent = sub ? path.basename(file, '.jsonl') : undefined;
  const key = `${SKILL}@${agent ? `${agent}:` : ''}${load.line}`;
  const dir = sessionDir(p.sessionId);
  return withSessionLock(dir, () => {
    const recFile = recordPath(p.sessionId);
    const rec = readGateRecord(recFile, p.sessionId);
    rec.transcript_path = p.transcriptPath;
    const h = hookRecord(rec, HOOK);
    let run = h.runs[key];
    if (run?.released_at || run?.exhausted_at) return undefined;
    const save = () => writeGateRecord(recFile, rec);
    const sys: string[] = [];
    if (!run) {
      run = h.runs[key] = { skill: SKILL, load_line: load.line, fired_at: new Date().toISOString(), blocked: 0, observed: 0, ...(agent ? { agent } : {}) };
      save();
      sys.push(note(HOOK, 'fired', p.sessionId, { skill: SKILL, on: p.event }));
      pruneSessionDirs(dir);
    }
    const check = checkOutput(t, load, { cwd: p.cwd, since, envOutput: process.env.GSTACK_CEO_REVIEW_OUTPUT, slug: () => slug(p.cwd) });
    if (check.met) {
      run.released_at = new Date().toISOString();
      run.file = path.basename(check.met);
      save();
      sys.push(note(HOOK, 'released', p.sessionId, { skill: SKILL, file: run.file, blocked: run.blocked }));
      return systemMessage(sys);
    }
    if (run.blocked >= MAX_BLOCKS) {
      run.exhausted_at = new Date().toISOString();
      save();
      sys.push(note(HOOK, 'exhausted', p.sessionId, { skill: SKILL, blocked: run.blocked }));
      return systemMessage(sys);
    }
    run.blocked++;
    save();
    const files = check.checked.map(c => path.basename(c.file));
    const marker = note(HOOK, 'blocked', p.sessionId, { skill: SKILL, via: 'stop', files: files.join(',') || 'none', n: run.blocked });
    const body = [
      `/plan-ceo-review is not done: its output does not rank the top risks yet. Before you stop, write a '## Findings' section ranking the top risks as a numbered list (1. most severe ...) in the review's output file: ${check.dest}`,
      'Each item names one concrete risk, most severe first; a placeholder such as [risk] or TBD does not count. A heading that says "Top risks" works too.',
      ...check.checked.map(c => `Checked ${c.file}: ${c.why}.`),
      ...check.missing.map(f => `${f} does not exist yet.`),
    ].join('\n');
    return blockWith(`${marker}\n${body}`, sys);
  });
}

runGateHook(HOOK, () => readSkillSwitch('ceo_review_gate').on, handle).finally(() => process.exit(0));
