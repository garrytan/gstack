/**
 * No-Claude temp-window runner for skill E2E testing.
 *
 * TEMP SWAP 2026-05-01: the original runner spawned Claude print mode as a
 * completely independent process. During the no-Claude window, this runner
 * returns a typed skip result instead of launching any subprocess.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProjectEvalDir } from './eval-store';

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
  /** Model to use. Defaults to claude-sonnet-4-6 for historical result labels. */
  model?: string;
  /** Extra env vars merged into the historical spawned process. Useful for
   *  per-test GSTACK_HOME overrides so the test doesn't have to spell out
   *  env setup in the prompt itself. */
  env?: Record<string, string>;
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
  const model = options.model ?? process.env.EVALS_MODEL ?? 'claude-sonnet-4-6';

  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  void startedAt;
  void workingDirectory;
  void maxTurns;
  void allowedTools;
  void timeout;
  void testName;
  void runId;
  void extraEnv;

  return {
    toolCalls: [],
    browseErrors: [],
    exitReason: 'skip_no_claude_temp_window',
    duration: Date.now() - startTime,
    output: 'SKIP: Claude print mode disabled by no-Claude temp migration. Use codex-session-runner.ts.',
    costEstimate: {
      inputChars: prompt.length,
      outputChars: 0,
      estimatedTokens: 0,
      estimatedCost: 0,
      turnsUsed: 0,
    },
    transcript: [],
    model,
    firstResponseMs: 0,
    maxInterTurnMs: 0,
  };
  // TEMP SWAP 2026-05-01: original Claude spawn for revert:
  // const proc = Bun.spawn(['sh', '-c', `cat "${promptFile}" | claude ${args.map(a => `"${a}"`).join(' ')}`], { ... });
}
