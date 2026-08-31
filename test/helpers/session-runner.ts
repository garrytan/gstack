/**
 * Claude CLI subprocess runner for skill E2E testing.
 *
 * Spawns `claude -p` as a completely independent process (not via Agent SDK),
 * so it works inside Claude Code sessions. Pipes prompt via stdin, streams
 * NDJSON output for real-time progress, scans for browse errors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { Readable } from 'node:stream';
import { getProjectEvalDir } from './eval-store';
import { hermeticChildEnv, isHermeticEnabled } from './hermetic-env';
import { killProcessGroup } from '../../scripts/test-strict-output';

const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json'); // heartbeat stays global
const PROJECT_DIR = path.dirname(getProjectEvalDir()); // ~/.gstack/projects/$SLUG/

/** Sanitize test name for use as filename: strip leading slashes, replace / with - */
export function sanitizeTestName(name: string): string {
  return name.replace(/^\/+/, '').replace(/\//g, '-');
}

/** Atomic write: write to .tmp then rename. Non-fatal on error. */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export interface CostEstimate {
  inputChars: number;
  outputChars: number;
  estimatedTokens: number;
  estimatedCost: number;  // USD
  turnsUsed: number;
}

export interface SkillTestResult {
  toolCalls: Array<{ tool: string; input: any; output: string }>;
  browseErrors: string[];
  exitReason: string;
  duration: number;
  output: string;
  costEstimate: CostEstimate;
  transcript: any[];
  /** Which model was used for this test (added for Sonnet/Opus split diagnostics) */
  model: string;
  /** Time from spawn to first NDJSON line, in ms (added for rate-limit diagnostics) */
  firstResponseMs: number;
  /** Peak latency between consecutive tool calls, in ms */
  maxInterTurnMs: number;
}

/** Local default startup grace: 90s covers observed API queue latency
 *  (60-90s receipts) without letting a dead API burn a 600s budget. */
export const STARTUP_GRACE_MS = 90_000;
/** CI floor (TODOS-filed): shared runners queue harder; killing startup
 *  before 300s in CI converts ordinary queueing into false failures.
 *  Pinned by test/session-runner-startup-grace.test.ts. */
export const STARTUP_GRACE_CI_FLOOR_MS = 300_000;

const BROWSE_ERROR_PATTERNS = [
  /Unknown command: \w+/,
  /Unknown snapshot flag: .+/,
  /ERROR: browse binary not found/,
  /Server failed to start/,
  /no such file or directory.*browse/i,
];

// --- Testable NDJSON parser ---

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: any | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; input: any; output: string }>;
}

/**
 * Parse an array of NDJSON lines into structured transcript data.
 * Pure function — no I/O, no side effects. Used by both the streaming
 * reader and unit tests.
 */
export function parseNDJSON(lines: string[]): ParsedNDJSON {
  const transcript: any[] = [];
  let resultLine: any = null;
  let turnCount = 0;
  let toolCallCount = 0;
  const toolCalls: ParsedNDJSON['toolCalls'] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      transcript.push(event);

      // Track turns and tool calls from assistant events
      if (event.type === 'assistant') {
        turnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item.type === 'tool_use') {
            toolCallCount++;
            toolCalls.push({
              tool: item.name || 'unknown',
              input: item.input || {},
              output: '',
            });
          }
        }
      }

      if (event.type === 'result') resultLine = event;
    } catch { /* skip malformed lines */ }
  }

  return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// --- Main runner ---

export async function runSkillTest(options: {
  prompt: string;
  workingDirectory: string;
  maxTurns?: number;
  allowedTools?: string[];
  timeout?: number;
  testName?: string;
  runId?: string;
  /** Model to use. Defaults to claude-sonnet-4-6 (overridable via EVALS_MODEL env). */
  model?: string;
  /** Extra env vars merged into the spawned claude -p process. Useful for
   *  per-test GSTACK_HOME overrides so the test doesn't have to spell out
   *  env setup in the prompt itself. */
  env?: Record<string, string>;
  /** Startup-phase deadline: if NO NDJSON byte arrives within this window,
   *  the run is killed EARLY with exitReason 'timeout_startup' instead of
   *  burning the whole work budget waiting on an API that is not answering
   *  (the recurring '0 turns / $0.00' class — four budget-bump receipts).
   *  Defaults to min(STARTUP_GRACE_MS, timeout); the CI floor is higher
   *  because CI queueing is real. Total wall stays <= timeout either way —
   *  bun-level tier budgets are sized to the runner timeout with no margin,
   *  so this phase split must never extend the envelope. */
  startupGraceMs?: number;
}): Promise<SkillTestResult> {
  const {
    prompt,
    workingDirectory,
    maxTurns = 15,
    allowedTools = ['Bash', 'Read', 'Write'],
    timeout = 120_000,
    testName,
    runId,
    env: extraEnv,
  } = options;
  // The CI floor is a FLOOR, not a default: an explicit startupGraceMs below
  // 300s in CI would re-open the queueing-becomes-false-red hole the floor
  // exists for (review finding — the name promised a clamp the code lacked).
  // Local runs honor the caller verbatim; timeout still caps everything.
  const requestedGrace = options.startupGraceMs ?? (process.env.CI ? STARTUP_GRACE_CI_FLOOR_MS : STARTUP_GRACE_MS);
  const startupGraceMs = Math.min(
    process.env.CI ? Math.max(requestedGrace, STARTUP_GRACE_CI_FLOOR_MS) : requestedGrace,
    timeout,
  );
  const model = options.model ?? process.env.EVALS_MODEL ?? 'claude-sonnet-4-6';

  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Set up per-run log directory if runId is provided
  let runDir: string | null = null;
  const safeName = testName ? sanitizeTestName(testName) : null;
  if (runId) {
    try {
      runDir = path.join(PROJECT_DIR, 'e2e-runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch { /* non-fatal */ }
  }

  // Spawn claude -p with streaming NDJSON output. Prompt piped via stdin to
  // avoid shell escaping issues. --verbose is required for stream-json mode.
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--max-turns', String(maxTurns),
    '--allowed-tools', ...allowedTools,
  ];
  // Hermetic children get zero MCP servers (no --mcp-config is passed).
  // Gated on the same call-time check as the env scrub so EVALS_HERMETIC=0
  // restores operator MCP along with the operator env.
  if (isHermeticEnabled()) args.push('--strict-mcp-config');

  // Spawn claude directly with array-form args (no shell interpolation).
  // node:child_process spawn (not Bun.spawn): `detached` puts the child in
  // its OWN process group, so the timeout handler can killpg the whole tree.
  // Bun.spawn has no detached option, and its bare proc.kill() signalled only
  // claude itself — tool subprocesses claude spawned survived as orphans
  // burning shared API rate for the rest of the shard's lifetime.
  // Prompt is piped via stdin to avoid temp files and shell escaping.
  const proc = spawn('claude', args, {
    cwd: workingDirectory,
    // Hermetic by default (see test/helpers/hermetic-env.ts): operator
    // session context (CONDUCTOR_*, CLAUDECODE, ~/.claude config, ~/.gstack)
    // never reaches the child; EVALS_HERMETIC=0 restores the legacy env.
    // Default GSTACK_HEADLESS=1 so eval/E2E runs classify as headless (BLOCK on an
    // AskUserQuestion failure rather than emit a prose question no human reads). A
    // suite exercising the INTERACTIVE prose-fallback path opts out by passing
    // `env: { GSTACK_HEADLESS: '' }` — extraEnv wins because it spreads last.
    env: hermeticChildEnv({ GSTACK_HEADLESS: '1', ...extraEnv }),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  proc.stdin!.on('error', () => { /* child died before reading the prompt — exit handling reports it */ });
  proc.stdin!.write(prompt);
  proc.stdin!.end();
  const stdoutWeb = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stderrWeb = Readable.toWeb(proc.stderr!) as ReadableStream<Uint8Array>;
  // 'exit' vs 'close' matters here: 'close' waits for stdout/stderr to
  // drain, which an orphaned grandchild can hold open long after claude
  // itself died with a REAL exit code — labeling must key off 'exit' or an
  // auth failure gets triaged as 'timeout_startup' availability noise
  // (claude adversarial finding). procExited stays 'close'-based (streams
  // complete) for the drain race below.
  let childExited = false;
  const procExited: Promise<number> = new Promise((resolve) => {
    proc.on('exit', () => { childExited = true; });
    proc.on('close', (code) => { childExited = true; resolve(code ?? 1); });
    proc.on('error', () => { childExited = true; resolve(1); });
  });

  // Two-phase timeout. Phase 1 (startup): no NDJSON byte yet — a shorter
  // deadline kills a non-answering API run EARLY and names it, instead of
  // the old single timer burning the full work budget to produce an opaque
  // '0 turns / $0.00' failure. Phase 2 (work): armed by the read loop when
  // the FIRST byte arrives, for the REMAINING budget — total wall is always
  // <= timeout (tier envelopes are margin-free by convention).
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;
  let timedOutInStartup = false;
  let phaseTimer: ReturnType<typeof setTimeout>;

  const killRun = (startupPhase: boolean): void => {
    // Labeling and unblocking are SEPARATE concerns: a timer firing after
    // the child already exited must not relabel a real exit (auth error,
    // crash) as a timeout — but it must STILL group-kill and cancel the
    // reader, or an orphan holding the pipes re-creates the exact
    // blocked-drain hang this runner fixed (an early `return` here was the
    // bug the adversarial pass caught in the first version of this guard).
    if (!childExited) {
      timedOut = true;
      timedOutInStartup = startupPhase;
    }
    // Group SIGKILL (mirrors runShardChild): claude AND every tool
    // subprocess it spawned die together — a bare proc.kill() left orphans
    // that inherited our stdout/stderr pipes and kept the API burning
    // (observed: a 600s timeout stretching past 1400s while an orphan held
    // the pipes open).
    killProcessGroup(proc, 'SIGKILL');
    // Belt and braces with the group kill: even if an orphan survives (EPERM
    // fallback path), cancel() unblocks the read loop below.
    reader.cancel().catch(() => { /* stream already closed */ });
  };
  phaseTimer = setTimeout(() => killRun(true), startupGraceMs);
  /** Called once by the read loop on the first NDJSON byte. */
  const armWorkPhase = (elapsedMs: number): void => {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => killRun(false), Math.max(0, timeout - elapsedMs));
  };

  // Stream NDJSON from stdout for real-time progress
  const collectedLines: string[] = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  let firstResponseMs = 0;
  let workPhaseArmed = false;
  let lastToolTime = 0;
  let maxInterTurnMs = 0;
  const stderrPromise = new Response(stderrWeb).text();

  const reader = stdoutWeb.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        // Track time to first NDJSON line (measures latency from spawn to first Claude response)
        if (!workPhaseArmed) {
          // Flag, not `firstResponseMs === 0`: a first line landing in the
          // same millisecond as spawn would read as "not yet seen" and leave
          // the startup timer live for the whole run (claude adversarial).
          workPhaseArmed = true;
          firstResponseMs = Date.now() - startTime;
          // First byte: startup phase over — arm the work phase for the
          // REMAINING budget (total wall stays <= timeout).
          armWorkPhase(firstResponseMs);
        }

        // Real-time progress to stderr + persistent logs
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant') {
            liveTurnCount++;
            const content = event.message?.content || [];
            for (const item of content) {
              if (item.type === 'tool_use') {
                liveToolCount++;
                const now = Date.now();
                const elapsed = Math.round((now - startTime) / 1000);
                // Track inter-turn latency (tool call to tool call)
                if (lastToolTime > 0) {
                  const interTurn = now - lastToolTime;
                  if (interTurn > maxInterTurnMs) maxInterTurnMs = interTurn;
                }
                lastToolTime = now;
                const progressLine = `  [${elapsed}s] turn ${liveTurnCount} tool #${liveToolCount}: ${item.name}(${truncate(JSON.stringify(item.input || {}), 80)})\n`;
                process.stderr.write(progressLine);

                // Persist progress.log
                if (runDir) {
                  try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
                }

                // Write heartbeat (atomic)
                if (runId && testName) {
                  try {
                    const toolDesc = `${item.name}(${truncate(JSON.stringify(item.input || {}), 60)})`;
                    atomicWriteSync(HEARTBEAT_PATH, JSON.stringify({
                      runId,
                      pid: proc.pid,
                      startedAt,
                      currentTest: testName,
                      status: 'running',
                      turn: liveTurnCount,
                      toolCount: liveToolCount,
                      lastTool: toolDesc,
                      lastToolAt: new Date().toISOString(),
                      elapsedSec: elapsed,
                    }, null, 2) + '\n');
                  } catch { /* non-fatal */ }
                }
              }
            }
          }
        } catch { /* skip — parseNDJSON will handle it later */ }

        // Append raw NDJSON line to per-test transcript file
        if (runDir && safeName) {
          try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), line + '\n'); } catch { /* non-fatal */ }
        }
      }
    }
  } catch { /* stream read error — fall through to exit code handling */ }

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
  }

  // Same orphan hazard as stdout: an orphaned grandchild holding stderr open
  // would block the drain forever. Race it against child exit + a short grace
  // window; the normal path (pipes close with the child) still wins the race
  // and keeps full stderr.
  stderr = await Promise.race([
    stderrPromise,
    (async () => {
      await procExited;
      await new Promise((r) => setTimeout(r, 5_000));
      return '';
    })(),
  ]);
  const exitCode = await procExited;
  clearTimeout(phaseTimer);

  if (timedOut) {
    // 'timeout_startup' = the API never sent a byte inside the grace — an
    // availability problem, not a test failure worth reading transcripts
    // for. Distinct so triage (and WS10's inconclusive classification) can
    // key off it without receipts archaeology.
    exitReason = timedOutInStartup ? 'timeout_startup' : 'timeout';
  } else if (exitCode === 0) {
    exitReason = 'success';
  } else {
    exitReason = `exit_code_${exitCode}`;
  }

  const duration = Date.now() - startTime;

  // Parse all collected NDJSON lines
  const parsed = parseNDJSON(collectedLines);
  const { transcript, resultLine, toolCalls } = parsed;
  const browseErrors: string[] = [];

  // Scan transcript + stderr for browse errors
  const allText = transcript.map(e => JSON.stringify(e)).join('\n') + '\n' + stderr;
  for (const pattern of BROWSE_ERROR_PATTERNS) {
    const match = allText.match(pattern);
    if (match) {
      browseErrors.push(match[0].slice(0, 200));
    }
  }

  // Use resultLine for structured result data
  if (resultLine) {
    if (resultLine.subtype === 'success' && resultLine.is_error) {
      // claude -p can return subtype=success with is_error=true (e.g. API connection failure)
      exitReason = 'error_api';
    } else if (resultLine.subtype === 'success') {
      exitReason = 'success';
    } else if (resultLine.subtype) {
      // Preserve known subtypes like error_max_turns even if is_error is set
      exitReason = resultLine.subtype;
    }
  }

  // Save failure transcript to persistent run directory (or fallback to workingDirectory)
  if (browseErrors.length > 0 || exitReason !== 'success') {
    try {
      const failureDir = runDir || path.join(workingDirectory, '.gstack', 'test-transcripts');
      fs.mkdirSync(failureDir, { recursive: true });
      const failureName = safeName
        ? `${safeName}-failure.json`
        : `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(
        path.join(failureDir, failureName),
        JSON.stringify({
          prompt: prompt.slice(0, 500),
          testName: testName || 'unknown',
          exitReason,
          browseErrors,
          duration,
          turnAtTimeout: timedOut ? liveTurnCount : undefined,
          lastToolCall: liveToolCount > 0 ? `tool #${liveToolCount}` : undefined,
          stderr: stderr.slice(0, 2000),
          result: resultLine ? { type: resultLine.type, subtype: resultLine.subtype, result: resultLine.result?.slice?.(0, 500) } : null,
        }, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  // Cost from result line (exact) or estimate from chars
  const turnsUsed = resultLine?.num_turns || 0;
  const estimatedCost = resultLine?.total_cost_usd || 0;
  const inputChars = prompt.length;
  const outputChars = (resultLine?.result || '').length;
  const estimatedTokens = (resultLine?.usage?.input_tokens || 0)
    + (resultLine?.usage?.output_tokens || 0)
    + (resultLine?.usage?.cache_read_input_tokens || 0);

  const costEstimate: CostEstimate = {
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCost: Math.round((estimatedCost) * 100) / 100,
    turnsUsed,
  };

  return { toolCalls, browseErrors, exitReason, duration, output: resultLine?.result || '', costEstimate, transcript, model, firstResponseMs, maxInterTurnMs };
}
