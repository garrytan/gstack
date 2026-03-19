/**
 * Codex CLI subprocess runner for skill smoke testing.
 *
 * Spawns `codex exec --json` as an independent process, pipes the prompt over stdin,
 * streams JSONL events for real-time progress, and scans the transcript for browse errors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json');
const LOCAL_CODEX = path.join(ROOT, 'node_modules', '.bin', 'codex');

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

export function deriveExitReason(
  timedOut: boolean,
  exitCode: number,
  resultLine: any | null,
): string {
  if (timedOut) {
    return 'timeout';
  }

  let exitReason = exitCode === 0 ? 'success' : `exit_code_${exitCode}`;

  if (resultLine) {
    if (resultLine.is_error) {
      return 'error_api';
    }
    if (resultLine.subtype === 'success') {
      return 'success';
    }
    if (resultLine.subtype) {
      return resultLine.subtype;
    }
  }

  return exitReason;
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

      // Legacy session format.
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

      if (event.type === 'result') {
        resultLine = event;
      }

      // codex exec JSONL format.
      if (event.type === 'turn.started') {
        turnCount++;
      }

      if (event.type === 'turn.completed') {
        resultLine = {
          ...(resultLine || { type: 'result' }),
          subtype: 'success',
          usage: {
            input_tokens: event.usage?.input_tokens || 0,
            output_tokens: event.usage?.output_tokens || 0,
            cache_read_input_tokens: event.usage?.cached_input_tokens || 0,
          },
        };
      }

      if (event.type === 'turn.failed') {
        resultLine = {
          ...(resultLine || { type: 'result' }),
          subtype: 'error',
          is_error: true,
          error: event.error,
        };
      }

      const item = event.item;
      if (event.type === 'item.completed' && item) {
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          resultLine = {
            ...(resultLine || { type: 'result', subtype: 'success' }),
            result: item.text,
          };
        }

        if (item.type === 'command_execution') {
          toolCallCount++;
          toolCalls.push({
            tool: 'Bash',
            input: { command: item.command || '' },
            output: item.aggregated_output || '',
          });
        }

        if (item.type === 'mcp_tool_call') {
          toolCallCount++;
          toolCalls.push({
            tool: `${item.server || 'mcp'}:${item.tool || 'unknown'}`,
            input: item.arguments || {},
            output: JSON.stringify(item.result || item.error || {}),
          });
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCodexBinary(): string {
  return fs.existsSync(LOCAL_CODEX) ? LOCAL_CODEX : 'codex';
}

// --- Main runner ---

export async function runSkillTest(options: {
  prompt: string;
  workingDirectory: string;
  timeout?: number;
  testName?: string;
  runId?: string;
}): Promise<SkillTestResult> {
  const {
    prompt,
    workingDirectory,
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

  // Spawn codex exec --json with streaming JSONL output. Prompt is piped via stdin to
  // avoid shell escaping issues.
  const args = [
    'exec',
    '--json',
    '--sandbox', 'danger-full-access',
    '--skip-git-repo-check',
    '-C', workingDirectory,
    '-',
  ];
  const codexBinary = resolveCodexBinary();

  // Write prompt to a temp file and redirect it into codex. Using `exec` makes the
  // codex process replace the shell so timeout kills target the real child process.
  const promptFile = path.join(
    workingDirectory,
    `.prompt-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(promptFile, prompt);

  const proc = Bun.spawn(['sh', '-c', `exec ${shellQuote(codexBinary)} ${args.map(shellQuote).join(' ')} < ${shellQuote(promptFile)}`], {
    cwd: workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Treat timeout as an idle timeout. Long Codex turns can legitimately run for
  // several minutes while still streaming progress, so only kill when output has
  // gone quiet for too long.
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);
  };
  armIdleTimeout();

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
      armIdleTimeout();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        // Real-time progress to stderr + persistent logs
        try {
          const event = JSON.parse(line);
          if (event.type === 'turn.started') {
            liveTurnCount++;
          }

          const item = event.item;
          if (event.type === 'item.completed' && item) {
            const isTrackedTool = item.type === 'command_execution' || item.type === 'mcp_tool_call';
            if (isTrackedTool) {
              liveToolCount++;
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const toolName = item.type === 'command_execution'
                ? 'Bash'
                : `${item.server || 'mcp'}:${item.tool || 'unknown'}`;
              const toolInput = item.type === 'command_execution'
                ? { command: item.command || '' }
                : (item.arguments || {});
              const progressLine = `  [${elapsed}s] turn ${liveTurnCount} tool #${liveToolCount}: ${toolName}(${truncate(JSON.stringify(toolInput), 80)})\n`;
              process.stderr.write(progressLine);

              if (runDir) {
                try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
              }

              if (runId && testName) {
                try {
                  const toolDesc = `${toolName}(${truncate(JSON.stringify(toolInput), 60)})`;
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
  if (timeoutId) clearTimeout(timeoutId);

  try { fs.unlinkSync(promptFile); } catch { /* non-fatal */ }

  exitReason = deriveExitReason(timedOut, exitCode, null);

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
  exitReason = deriveExitReason(timedOut, exitCode, resultLine);

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
  const turnsUsed = resultLine?.num_turns || parsed.turnCount;
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
