#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * investigate-gate — opt-in enforcement for /investigate (GST-1461). Off
 * unless investigate_gate is on (env GSTACK_INVESTIGATE_GATE, then config,
 * then SWITCH_DEFAULT). Registered per event through four shims:
 * investigate-gate-pre (PreToolUse Edit|Write|MultiEdit|NotebookEdit|Bash),
 * investigate-gate-post (PostToolUse Bash), investigate-gate-post-failure
 * (PostToolUseFailure Bash) and investigate-gate-stop (Stop).
 *
 *   payload -> transcript -> the last /investigate load (none: nothing)
 *     -> released for this run? nothing
 *     -> first call of the run: pin the baseline, marker fired
 *     -> tree check: a gated path changed -> put back, marker blocked via=bash
 *        (deny at PreToolUse, block at PostToolUse/Stop)
 *     -> PreToolUse edit of tracked gated source -> marker blocked via=edit, deny
 *     -> Root cause line stated -> marker released, everything allowed after
 *
 * Every marker is counted in the session record and traced in
 * $GSTACK_STATE_ROOT/hooks/investigate-gate.log; blocks carry it as the first
 * line of their reason, the others ride systemMessage. Errors fail open
 * (lib/skill-gates.ts runGateHook). Docs: docs/skill-gates.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EDIT_TOOLS, armBaseline, checkTree, isGatedTracked, repoRoot, rootCause, type Baseline } from '../../../lib/investigate-gate';
import { StateError, UnknownShape, parseTranscript, readTranscriptFile, sameSkill, skillLoads, type Transcript } from '../../../lib/skill-contract';
import { readSkillSwitch } from '../../../lib/skill-route';
import {
  GateError, blockWith, denyTool, hookRecord, note, pruneSessionDirs, readGateRecord, recordPath, remainingMs, runGateHook, sessionDir, systemMessage,
  withSessionLock, writeGateRecord, type GatePayload, type HookOutput,
} from '../../../lib/skill-gates';

const HOOK = 'investigate-gate';
const SKILL = 'investigate';

const SYNC_WAIT_MS = 2000;

/**
 * Claude Code can fire a tool hook before the turn's earlier blocks reach the
 * transcript file (the smoke saw a Root cause line land after the Edit's
 * PreToolUse). The call's own tool_use block is written after them, so wait,
 * briefly and within the deadline, until the file holds this call's id.
 */
function readTranscript(file: string, toolUseId: unknown): Transcript {
  try {
    let raw = readTranscriptFile(file);
    if (typeof toolUseId === 'string' && toolUseId) {
      const needle = JSON.stringify(toolUseId);
      const until = Date.now() + Math.min(SYNC_WAIT_MS, remainingMs() - 2500);
      while (!raw.includes(needle) && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        raw = readTranscriptFile(file);
      }
    }
    return parseTranscript(raw);
  } catch (e) {
    if (e instanceof StateError || e instanceof UnknownShape) throw new GateError('GATE_TRANSCRIPT', e.message);
    throw e;
  }
}

function howToRelease(rejected?: { value: string; why: string }): string {
  return [
    ...(rejected ? [`Your line "Root cause: ${rejected.value}" does not count: ${rejected.why}.`] : []),
    'State the root cause first, in your reply, as one line in this form:',
    'Root cause: <what is actually wrong, with file:line>',
    'It counts once you have read the code or run something. Until then you can read code, run commands, and write new untracked files or tests (a repro script, a failing test, temporary logging in a scratch file).',
  ].join('\n');
}

function handle(p: GatePayload): HookOutput | undefined {
  const t = readTranscript(p.transcriptPath, p.raw.tool_use_id);
  const load = skillLoads(t).filter(l => sameSkill(l.skill, SKILL)).pop();
  if (!load) return undefined;
  const key = `${SKILL}@${load.line}`;
  const dir = sessionDir(p.sessionId);
  const gateDir = path.join(dir, HOOK);
  const blobs = path.join(gateDir, 'blobs');
  const basePath = path.join(gateDir, `baseline-${load.line}.json`);
  return withSessionLock(dir, () => {
    const file = recordPath(p.sessionId);
    const rec = readGateRecord(file, p.sessionId);
    rec.transcript_path = p.transcriptPath;
    const h = hookRecord(rec, HOOK);
    let run = h.runs[key];
    if (run?.released_at) return undefined;
    const sys: string[] = [];
    const save = () => writeGateRecord(file, rec);
    let base: Baseline | null = null;
    if (!run) {
      const root = repoRoot(p.cwd);
      const skip = (reason: string) => {
        if (h.skipped[reason]) return undefined;
        h.skipped[reason] = new Date().toISOString();
        save();
        return systemMessage([note(HOOK, 'skipped', p.sessionId, { skill: SKILL, reason })]);
      };
      if (!root) return skip('no-git');
      base = armBaseline(root, blobs);
      if (!base) return skip('no-head');
      fs.mkdirSync(gateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(basePath, JSON.stringify(base), { mode: 0o600 });
      run = h.runs[key] = { skill: SKILL, load_line: load.line, fired_at: new Date().toISOString(), blocked: 0, observed: 0 };
      save();
      sys.push(note(HOOK, 'fired', p.sessionId, { skill: SKILL, on: p.event, root: path.basename(root) }));
      pruneSessionDirs(dir);
    } else {
      try { base = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Baseline; } catch (e) { throw new GateError('GATE_STATE', `cannot read ${basePath} (${(e as Error).message})`); }
    }
    const check = checkTree(base!, blobs);
    fs.writeFileSync(basePath, JSON.stringify(check.baseline), { mode: 0o600 });
    if (check.observed.length) {
      run.observed += check.observed.length;
      save();
      note(HOOK, 'observed', p.sessionId, { skill: SKILL, files: check.observed.join(',') });
    }
    const block = (via: string, files: string[], body: string): HookOutput => {
      run!.blocked++;
      save();
      const marker = note(HOOK, 'blocked', p.sessionId, { skill: SKILL, via, files: files.join(','), n: run!.blocked });
      const reason = `${marker}\n${body}`;
      return p.event === 'PreToolUse' ? denyTool(reason, sys) : blockWith(reason, sys);
    };
    if (check.violations.length) {
      if (check.failed.length) {
        const why = check.failed.map(f => `${f.path}: ${f.why}`).join('; ');
        h.errors.push({ at: new Date().toISOString(), code: 'GATE_RESTORE_FAILED', why });
        sys.push(note(HOOK, 'error', p.sessionId, { code: 'GATE_RESTORE_FAILED', why }));
      }
      const failed = check.failed.map(f => f.path);
      const body = [
        `This session loaded /investigate and has not stated a root cause, so changes to tracked source are not allowed yet. A command changed ${check.violations.join(', ')}.`,
        ...(check.restored.length ? [`The gate put these back to how they were: ${check.restored.join(', ')}.`] : []),
        ...(check.saved.length ? [`The content it replaced is saved: ${check.saved.map(s => `${s.path} at ${s.file}`).join(', ')}.`] : []),
        ...(check.reset ? [`It also moved the branch back to ${check.reset.slice(0, 12)}; the new commit stays in the reflog.`] : []),
        ...(check.staged.length ? [`The commit's other changes are still staged: ${check.staged.join(', ')}.`] : []),
        ...(failed.length ? [`These could not be put back and are in an unknown state: ${failed.join(', ')}. Run git diff HEAD -- ${failed.join(' ')} to see them.`] : []),
        howToRelease(),
      ].join('\n');
      return block('bash', check.violations, body);
    }
    const cause = rootCause(t, load);
    if (cause.stated) {
      run.released_at = new Date().toISOString();
      run.cause = cause.cause;
      save();
      sys.push(note(HOOK, 'released', p.sessionId, { skill: SKILL, cause: cause.cause!, blocked: run.blocked }));
      return systemMessage(sys);
    }
    if (p.event === 'PreToolUse' && EDIT_TOOLS.test(String(p.raw.tool_name ?? ''))) {
      const input = (p.raw.tool_input ?? {}) as Record<string, unknown>;
      const target = String(input.file_path ?? input.notebook_path ?? '');
      if (target) {
        const abs = path.resolve(p.cwd, target);
        const rel = path.relative(base!.root, fs.existsSync(path.dirname(abs)) ? path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)) : abs).split(path.sep).join('/');
        if (!rel.startsWith('..') && !path.isAbsolute(rel) && isGatedTracked(base!.root, rel, base!.head)) {
          return block('edit', [rel], `This session loaded /investigate and has not stated a root cause, so edits to tracked source (${rel}) are blocked.\n${howToRelease(cause.rejected)}`);
        }
      }
    }
    return systemMessage(sys);
  });
}

runGateHook(HOOK, () => readSkillSwitch('investigate_gate').on, handle).finally(() => process.exit(0));
