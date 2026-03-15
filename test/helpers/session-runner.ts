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

const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json');

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
}

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
}): Promise<SkillTestResult> {
  const {
    prompt,
    workingDirectory,
    maxTurns = 15,
    allowedTools = ['Bash', 'Read', 'Write'],
    timeout = 120_000,
    testName,
    runId,
  } = options;

  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Set up per-run log directory if runId is provided
  let runDir: string | null = null;
  const safeName = testName ? sanitizeTestName(testName) : null;
  if (runId) {
    try {
      runDir = path.join(GSTACK_DEV_DIR, 'e2e-runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch { /* non-fatal */ }
  }

  // Spawn claude -p with streaming NDJSON output. Prompt piped via stdin to
  // avoid shell escaping issues. --verbose is required for stream-json mode.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--max-turns', String(maxTurns),
    '--allowed-tools', ...allowedTools,
  ];

  // Write prompt to a temp file and pipe it via shell to avoid stdin buffering issues
  const promptFile = path.join(workingDirectory, '.prompt-tmp');
  fs.writeFileSync(promptFile, prompt);

  const proc = Bun.spawn(['sh', '-c', `cat "${promptFile}" | claude ${args.map(a => `"${a}"`).join(' ')}`], {
    cwd: workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Race against timeout
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Stream NDJSON from stdout for real-time progress
  const collectedLines: string[] = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
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

        // Real-time progress to stderr + persistent logs
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant') {
            liveTurnCount++;
            const content = event.message?.content || [];
            for (const item of content) {
              if (item.type === 'tool_use') {
                liveToolCount++;
                const elapsed = Math.round((Date.now() - startTime) / 1000);
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

  stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  try { fs.unlinkSync(promptFile); } catch { /* non-fatal */ }

  if (timedOut) {
    exitReason = 'timeout';
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
    if (resultLine.is_error) {
      // claude -p can return subtype=success with is_error=true (e.g. API connection failure)
      exitReason = 'error_api';
    } else if (resultLine.subtype === 'success') {
      exitReason = 'success';
    } else if (resultLine.subtype) {
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

  return { toolCalls, browseErrors, exitReason, duration, output: resultLine?.result || '', costEstimate, transcript };
}
