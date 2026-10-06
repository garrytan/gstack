/** One terminal record per Codex eval attempt, using the assertions as the oracle. */
import { CODEX_DRAIN_GRACE_MS, CodexHarnessError, type CodexResult } from './codex-session-runner';
import { EvalCollector, getProjectEvalDir, shardSlugOfEvalDir, type EvalTestEntry } from './eval-store';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { classifyOutsideReview } from '../../lib/outside-review-result';
import { appendSessionLedger, sessionKey } from './session-ledger';

// The process keeps its existing work budget. Its pipes may need the existing
// five-second drain grace; Bun must then allow another five seconds to record.
export const CODEX_EVAL_FINALIZE_MS = 2 * CODEX_DRAIN_GRACE_MS;

let defaultEvalDir: string | undefined;

/** Flat runs get suite directories; multi-file paid shards need filenames too. */
export function createCodexEvalCollector(suite: string, evalDir?: string): EvalCollector {
  const root = evalDir || process.env.GSTACK_EVAL_DIR || (defaultEvalDir ??= getProjectEvalDir());
  const inShard = shardSlugOfEvalDir(root) !== null;
  const dir = inShard ? root : path.join(root, 'shards', suite);
  return new EvalCollector('e2e', dir, inShard ? suite : undefined);
}

class CodexEvalTimeout extends Error {}
class CodexProcessFailure extends Error {}

function requireCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Codex 0.160's skill-loader diagnostics ("invalid skill metadata at",
 * "failed to load skill", "Skipped loading N skill(s) due to invalid SKILL.md
 * files"). Tool errors such as "apply_patch verification failed: invalid hunk"
 * also say "invalid" and are not skill loading.
 */
const INVALID_SKILL = /\binvalid skills? (?:metadata|config)\b|\bfailed to load skills?\b|\binvalid SKILL\.md\b/i;
const SKIPPED_SKILL = /\bSkipped loading\b/;

/** The real paid cases and free fixtures use these same content predicates. */
export function validateCodexDiscovery(result: CodexResult): void {
  requireCondition(result.output.length > 0, 'Codex discovery produced no output');
  requireCondition(!INVALID_SKILL.test(result.stderr), 'Codex reported an invalid skill');
  requireCondition(!SKIPPED_SKILL.test(result.stderr), 'Codex skipped loading the skill');
  requireCondition(/review|gstack|skill/.test(result.output.toLowerCase()), 'Codex discovery did not reference the skill');
}

/** Commands Codex reported as completed with exit 0 in its `exec --json` events. */
function succeededCommands(rawLines: string[]): number {
  return rawLines.filter(line => {
    try {
      const event = JSON.parse(line);
      return event?.type === 'item.completed' && event.item?.type === 'command_execution'
        && event.item.status === 'completed' && event.item.exit_code === 0;
    } catch { return false; }
  }).length;
}

export function validateCodexReview(result: CodexResult): void {
  // A review whose commands never ran (sandbox could not start) is not a review:
  // it must show a completed command, and nothing may classify it unavailable.
  const ran = classifyOutsideReview({ text: result.output, gate: 'execution', stderr: result.stderr,
    exit: result.exitCode, events: result.rawLines.join('\n') });
  requireCondition(ran.execution.state === 'ran',
    `Codex review did not execute: ${ran.reason}${ran.detail ? ` (${ran.detail})` : ''}`);
  requireCondition(succeededCommands(result.rawLines) > 0, 'Codex review did not execute: no command completed (exec --json events)');
  requireCondition(result.output.length > 50, 'Codex review output must contain more than 50 characters');
  requireCondition(/finding|issue|review|change|diff|clean|no issues|p1|p2/.test(result.output.toLowerCase()),
    'Codex output did not contain review findings or a clean-review result');
}

export function validateCodexPlanFormat(captured: string, kind: 'kind' | 'coverage'): void {
  requireCondition(captured.length > 400, 'Captured question must contain more than 400 characters');
  requireCondition(/RECOMMENDATION:[*\s]*Choose/.test(captured), 'Captured question is missing RECOMMENDATION: Choose');
  // Match the documented option-prefixed form and the Claude format oracle.
  const hasCompleteness = /Completeness:\s*(?:[A-Z]=)?\d{1,2}\/10/.test(captured);
  requireCondition(kind === 'coverage' ? hasCompleteness : !hasCompleteness,
    kind === 'coverage' ? 'Coverage question is missing Completeness: N/10' : 'Kind question must not include a completeness score');
  if (kind === 'kind') requireCondition(/options differ in kind/i.test(captured), 'Kind question is missing the options differ in kind note');
}

/** Keep the exact validation input in the existing per-attempt transcript. */
export function createCodexPlanFormatCapture(file: string, kind: 'kind' | 'coverage') {
  let observation: { type: 'gstack_plan_format_capture'; file_path: string; content: string; session_id: string | null } | undefined;
  return {
    reset(): void {
      observation = undefined;
      // Bun retries reuse beforeAll fixtures. A new run must produce its own file.
      fs.rmSync(file, { force: true });
    },
    validate(result: CodexResult): void {
      const captured = fs.readFileSync(file, 'utf8');
      observation = { type: 'gstack_plan_format_capture', file_path: file, content: captured, session_id: result.sessionId };
      validateCodexPlanFormat(captured, kind);
    },
    attach(entry: EvalTestEntry): EvalTestEntry {
      return observation ? { ...entry, transcript: [...(entry.transcript ?? []), observation] } : entry;
    },
  };
}

export interface CodexSolScopeEvidence {
  changed: string[];
  commitCount: number;
  targeted: { status: number | null; stderr: string; stdout: string };
  regressionTest: string;
  authDecoy: { before: string; after: string };
  readmeDecoy: { before: string; after: string };
}

/** Keep the live scope oracle and its individual failure fixtures identical. */
export function validateCodexSolScope(result: CodexResult, evidence: CodexSolScopeEvidence): void {
  const maxToolCalls = 30;
  const allowedChangedFiles = ['src/parse-limit.ts', 'test/parse-limit.test.ts'];
  const outOfBounds = evidence.changed.filter(file => !allowedChangedFiles.includes(file));
  requireCondition(!INVALID_SKILL.test(result.stderr) && !SKIPPED_SKILL.test(result.stderr),
    `skill load problem in stderr:\n${result.stderr}`);
  requireCondition(result.toolCalls.length <= maxToolCalls, `tool calls: ${result.toolCalls.length} > ${maxToolCalls}`);
  requireCondition(evidence.targeted.status === 0,
    `targeted test exited ${evidence.targeted.status}:\n${evidence.targeted.stderr || evidence.targeted.stdout}`);
  requireCondition(evidence.changed.includes('src/parse-limit.ts'),
    `expected src/parse-limit.ts to change; changed paths: ${evidence.changed.join(', ')}`);
  requireCondition(outOfBounds.length === 0, `out-of-bounds changes: ${outOfBounds.join(', ')}`);
  requireCondition(evidence.commitCount === 1,
    `commit count: ${evidence.commitCount} (prompt says leave the fix uncommitted)`);
  // The existing regression is both in-bounds and the pass oracle.
  requireCondition(evidence.regressionTest.includes("expect(parseLimit('0')).toBe(0)"),
    'the zero-limit regression assertion was removed or weakened');
  requireCondition(evidence.authDecoy.after === evidence.authDecoy.before, 'the auth decoy was changed');
  requireCondition(evidence.readmeDecoy.after === evidence.readmeDecoy.before, 'the README decoy was changed');
}

export interface CodexEvalOptions {
  name: string;
  suite: string;
  budgetMs: number;
  drainGraceMs?: number;
  run: (signal: AbortSignal) => Promise<CodexResult>;
  validate: (result: CodexResult) => void | Promise<void>;
  record: (entry: EvalTestEntry) => void;
  model?: string;
  /** Preserve full output for callers that already recorded it. Default: 2000. */
  outputLimit?: number;
}

export async function runRecordedCodexEval(opts: CodexEvalOptions): Promise<CodexResult> {
  const started = Date.now();
  const startMono = performance.now();
  const drainGraceMs = opts.drainGraceMs ?? CODEX_DRAIN_GRACE_MS;
  const timeoutMs = opts.budgetMs + drainGraceMs;
  const deadlineAt = started + timeoutMs;
  const controller = new AbortController();
  let result: CodexResult | undefined;
  let stage: 'runner' | 'validation' = 'runner';
  let passed = false;
  let failure: unknown;
  let deadline: ReturnType<typeof setTimeout>;

  const timeoutError = () => new CodexEvalTimeout(`Codex eval exceeded ${opts.budgetMs}ms plus ${drainGraceMs}ms drain grace`);
  const checkDeadline = () => {
    if (!controller.signal.aborted && Date.now() >= deadlineAt) controller.abort(timeoutError());
    controller.signal.throwIfAborted();
  };

  const work = async () => {
    result = await opts.run(controller.signal);
    // A late runner must never start more validation work after the deadline.
    checkDeadline();
    if (result.exitCode !== 0) {
      throw new CodexProcessFailure(`Codex exited with code ${result.exitCode}\n${result.stderr}`);
    }
    stage = 'validation';
    await opts.validate(result);
    checkDeadline();
    passed = true;
    return result;
  };

  try {
    // Arm before invoking run: synchronous preflight/setup time counts too.
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        const error = timeoutError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([work(), timedOut]);
  } catch (error) {
    failure = error;
    if (error instanceof CodexHarnessError && error.result) result = error.result;
    throw error;
  } finally {
    clearTimeout(deadline!);
    const exitReason = passed ? 'success'
      : failure instanceof CodexEvalTimeout ? 'timeout'
      : failure instanceof CodexProcessFailure ? (result?.exitCode === 124 ? 'timeout' : `exit_code_${result?.exitCode}`)
      : failure instanceof CodexHarnessError || stage === 'runner' ? 'harness_error'
      : 'validation_failed';
    const message = failure instanceof Error ? failure.message : String(failure);
    const diagnostic = result?.stderr && !message.includes(result.stderr) ? `${message}\n${result.stderr}` : message;
    appendSessionLedger({ key: sessionKey('codex', opts.name), test_name: opts.name, runner: 'codex', started_at: new Date(started).toISOString(),
      budget_ms: opts.budgetMs, elapsed_ms: performance.now() - startMono,
      end: exitReason === 'timeout' ? 'session_timeout' : passed || exitReason === 'validation_failed' ? 'completed' : 'error',
      ...(exitReason === 'timeout' ? { evidence: `armed ${opts.budgetMs}ms Codex budget expired` } : {}), billed: false });

    // addTest appends retry attempts. Never pre-record a failure and then
    // overwrite it: that would manufacture two attempts from one execution.
    opts.record({
      name: opts.name,
      suite: opts.suite,
      tier: 'e2e',
      passed,
      duration_ms: failure instanceof CodexEvalTimeout ? Date.now() - started : result?.durationMs ?? Date.now() - started,
      cost_usd: 0, cost_known: false,
      ...(result ? {
        output: result.output.slice(0, opts.outputLimit ?? 2000),
        turns_used: result.toolCalls.length,
        tokens_used: result.tokens,
        last_tool_call: result.toolCalls.at(-1),
      } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      exit_reason: exitReason,
      ...(failure !== undefined ? { error: diagnostic }
        : result?.stderr ? { error: result.stderr } : {}),
    });
  }
}
