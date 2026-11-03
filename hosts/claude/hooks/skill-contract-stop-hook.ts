#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * skill-contract-stop-hook — Stop hook that blocks once when a contract skill
 * ends without its required outputs (GST-1088, lane A). Off unless
 * skill_contracts is on (env GSTACK_SKILL_CONTRACTS, then config
 * skill_contracts; default off).
 *
 *   stdin -> switch on? -> transcript_path -> parse (+ last_assistant_message)
 *     -> the most recently loaded skill that declares a contract (none: allow)
 *     -> Agent dispatches still running? allow (outputs may still arrive)
 *     -> final turn? (a STATUS line, a headless or unattended session, or no
 *        pending user question) -> checkContract (lib/skill-contract.ts)
 *     -> unmet and this run never blocked: record "blocked", then block with
 *        blockMessage(); unmet again later: record "miss" and allow
 *     -> stop_hook_active (a Stop hook already blocked this turn): record the
 *        outcome after our block (met_after_block or miss), never block
 *
 * CONTRACT
 *   - Blocks at most once per skill run, and only through a record written
 *     atomically under $GSTACK_STATE_ROOT/skill-contracts/<session id>.json first.
 *   - Fails open on every read, write, parse or timeout error: exit 0, nothing on
 *     stdout, one stderr line (stateErrorLine). An unknown transcript shape also
 *     bumps hooks/skill-contract.canary.json.
 *   - The block text never names the off switch (gate rev 2, E1).
 *   - Every decision is one line in $GSTACK_STATE_ROOT/hooks/skill-contract.log.
 * Docs: docs/skill-routing-and-contracts.md.
 */
import { runBin } from './spawn-bin';
import { appendHookTrace, installedSkillsDir, readSkillSwitch, readStdinBounded } from '../../../lib/skill-route';
import {
  StateError, UnknownShape, blockMessage, bumpCanary, checkContract, lookupContract, nextOutcome, parseTranscript,
  readRecord, readTranscriptFile, recordPath, runKey, sameSkill, skillLoads, stateErrorLine, withFinalMessage, writeRecord,
  type CheckResult, type Contract, type Transcript,
} from '../../../lib/skill-contract';

export const DEADLINE_MS = 5000;
const STDIN_CAP_BYTES = 1024 * 1024;
const STDIN_DEADLINE_MS = 500;
const SESSION_KIND_TIMEOUT_MS = 1000;

let sessionId = '';
let failedOpen = false;
const trace = (fields: Record<string, string | number | boolean>, failed = false) => appendHookTrace('skill-contract', sessionId, fields, failed);

function failOpen(file: string, why: string): void {
  if (failedOpen) return;
  failedOpen = true;
  process.stderr.write(`${stateErrorLine(file, why)}\n`);
  trace({ event: 'state-error', why }, true);
}

function unknownShape(file: string, why: string): void {
  failOpen(file, `unknown transcript shape: ${why} (canary ${bumpCanary(why)})`);
}

/** The most recently loaded skill that declares a contract. An invalid contract is a state error. */
function target(t: Transcript): { skill: string; contract: Contract } | null {
  const dir = installedSkillsDir();
  const tried: string[] = [];
  for (const load of skillLoads(t).reverse()) {
    if (tried.some(s => sameSkill(s, load.skill))) continue;
    tried.push(load.skill);
    const found = lookupContract(load.skill, dir);
    if ('contract' in found) return { skill: load.skill, contract: found.contract };
    if (found.reason === 'invalid' && found.file) throw new StateError(found.file, found.error);
  }
  return null;
}

/** A STATUS line, a session no human answers, or a turn that does not end on a question. */
function isFinalTurn(result: CheckResult): boolean {
  if (result.statusLine && result.statusLine !== 'NEEDS_CONTEXT') return true;
  if (!result.pendingQuestion) return true;
  const r = runBin('gstack-session-kind', [], { encoding: 'utf8', timeout: SESSION_KIND_TIMEOUT_MS, windowsHide: true });
  const kind = String(r.stdout ?? '').trim();
  return kind === 'headless' || kind === 'unattended';
}

async function main(): Promise<void> {
  setTimeout(() => { failOpen('<hook>', `timed out after ${DEADLINE_MS} ms`); process.exit(0); }, DEADLINE_MS);
  if (!readSkillSwitch('skill_contracts').on) return;
  const stdin = await readStdinBounded(STDIN_CAP_BYTES, STDIN_DEADLINE_MS);
  if (stdin.overCap) return failOpen('<stdin>', `hook payload over ${STDIN_CAP_BYTES} bytes`);
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdin.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return failOpen('<stdin>', 'hook payload is not a JSON object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return failOpen('<stdin>', 'hook payload is not JSON');
  }
  const stopActive = payload.stop_hook_active === true;
  sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcriptPath || !sessionId) return unknownShape('<stdin>', 'payload has no transcript_path or session_id');
  let transcript: Transcript;
  try {
    transcript = withFinalMessage(parseTranscript(readTranscriptFile(transcriptPath)), payload.last_assistant_message);
  } catch (e) {
    if (e instanceof UnknownShape) return unknownShape(transcriptPath, e.message);
    throw e;
  }
  const t = target(transcript);
  if (!t) return trace({ event: 'no-contract-skill' });
  const result = checkContract(transcript, t.skill, t.contract);
  if (!result.load) return trace({ event: 'no-contract-skill' });
  if (result.pendingAgents.length) return trace({ event: 'agents-running', skill: t.skill, agents: result.pendingAgents.length });
  if (!isFinalTurn(result)) return trace({ event: 'not-final-turn', skill: t.skill });
  const file = recordPath(sessionId);
  const record = readRecord(file) ?? { version: 1 as const, session_id: sessionId, transcript_path: transcriptPath, runs: {} };
  const key = runKey(t.skill, result.load);
  const prev = record.runs[key];
  const { outcome, block } = nextOutcome(prev, result);
  if (block && stopActive) return trace({ event: 'stop-hook-active', skill: t.skill });
  const missing = result.missing.join(',') || '-';
  if (prev && prev.outcome === outcome && !block) return trace({ event: 'unchanged', skill: t.skill, outcome });
  const now = new Date().toISOString();
  const blockedAt = block ? now : prev?.blocked_at;
  record.transcript_path = transcriptPath;
  record.runs[key] = {
    skill: t.skill, load_line: result.load.line, outcome, missing: result.missing, waived: result.waived,
    ...(blockedAt ? { blocked_at: blockedAt } : {}), updated_at: now,
  };
  writeRecord(file, record);
  trace({ event: outcome, skill: t.skill, missing, waived: result.waived.join(',') || '-' });
  if (block) {
    const out = JSON.stringify({ decision: 'block', reason: blockMessage(result) });
    await new Promise<void>(resolve => process.stdout.write(out, () => resolve()));
  }
}

main()
  .catch(e => (e instanceof StateError ? failOpen(e.file, e.why) : failOpen('<hook>', `unexpected error: ${e instanceof Error ? e.message : String(e)}`)))
  .finally(() => process.exit(0));
