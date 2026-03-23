/**
 * Gemini CLI subprocess runner for skill E2E testing.
 *
 * Spawns `gemini -p` as an independent process, parses its stream-json
 * output, and returns structured results. Follows the same pattern as
 * codex-session-runner.ts but adapted for the Gemini CLI.
 *
 * Key differences from Codex session-runner:
 * - Uses `gemini -p` instead of `codex exec`
 * - Output is NDJSON with event types: init, message, tool_use, tool_result, result
 * - Uses `--output-format stream-json --yolo` instead of `--json -s read-only`
 * - No temp HOME needed — Gemini discovers skills from `.agents/skills/` in cwd
 * - Message events are streamed with `delta: true` — must concatenate
 */

import * as path from 'path';

// --- Interfaces ---

export interface GeminiResult {
  output: string;           // Full assistant message text (concatenated deltas)
  toolCalls: string[];      // Tool names from tool_use events
  tokens: number;           // Total tokens used
  exitCode: number;         // Process exit code
  durationMs: number;       // Wall clock time
  sessionId: string | null; // Session ID from init event
  rawLines: string[];       // Raw JSONL lines for debugging
}

// --- JSONL parser ---

export interface ParsedGeminiJSONL {
  output: string;
  toolCalls: string[];
  tokens: number;
  sessionId: string | null;
}

/**
 * Parse an array of JSONL lines from `gemini -p --output-format stream-json`.
 * Pure function — no I/O, no side effects.
 *
 * Handles these Gemini event types:
 * - init → extract session_id
 * - message (role=assistant, delta=true) → concatenate content into output
 * - tool_use → extract tool_name
 * - tool_result → logged but not extracted
 * - result → extract token usage from stats
 */
export function parseGeminiJSONL(lines: string[]): ParsedGeminiJSONL {
  const outputParts: string[] = [];
  const toolCalls: string[] = [];
  let tokens = 0;
  let sessionId: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const t = obj.type || '';

      if (t === 'init') {
        const sid = obj.session_id || '';
        if (sid) sessionId = sid;
      } else if (t === 'message') {
        if (obj.role === 'assistant' && obj.content) {
          outputParts.push(obj.content);
        }
      } else if (t === 'tool_use') {
        const name = obj.tool_name || '';
        if (name) toolCalls.push(name);
      } else if (t === 'result') {
        const stats = obj.stats || {};
        tokens = (stats.total_tokens || 0);
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    output: outputParts.join(''),
    toolCalls,
    tokens,
    sessionId,
  };
}

// --- Main runner ---

/**
 * Run a prompt via `gemini -p` and return structured results.
 *
 * Spawns gemini with stream-json output, parses JSONL events,
 * and returns a GeminiResult. Skips gracefully if gemini binary is not found.
 */
export async function runGeminiSkill(opts: {
  prompt: string;           // What to ask Gemini
  timeoutMs?: number;       // Default 300000 (5 min)
  cwd?: string;             // Working directory (where .agents/skills/ lives)
}): Promise<GeminiResult> {
  const {
    prompt,
    timeoutMs = 300_000,
    cwd,
  } = opts;

  const startTime = Date.now();

  // Check if gemini binary exists
  const whichResult = Bun.spawnSync(['which', 'gemini']);
  if (whichResult.exitCode !== 0) {
    return {
      output: 'SKIP: gemini binary not found',
      toolCalls: [],
      tokens: 0,
      exitCode: -1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      rawLines: [],
    };
  }

  // Build gemini command
  const args = ['-p', prompt, '--output-format', 'stream-json', '--yolo'];

  // Spawn gemini — uses real HOME for auth, cwd for skill discovery
  const proc = Bun.spawn(['gemini', ...args], {
    cwd: cwd || process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Race against timeout
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Stream and collect JSONL from stdout
  const collectedLines: string[] = [];
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

        // Real-time progress to stderr
        try {
          const event = JSON.parse(line);
          if (event.type === 'tool_use' && event.tool_name) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            process.stderr.write(`  [gemini ${elapsed}s] tool: ${event.tool_name}\n`);
          } else if (event.type === 'message' && event.role === 'assistant' && event.content) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            process.stderr.write(`  [gemini ${elapsed}s] message: ${event.content.slice(0, 100)}\n`);
          }
        } catch { /* skip — parseGeminiJSONL will handle it later */ }
      }
    }
  } catch { /* stream read error — fall through to exit code handling */ }

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
  }

  const stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const durationMs = Date.now() - startTime;

  // Parse all collected JSONL lines
  const parsed = parseGeminiJSONL(collectedLines);

  // Log stderr if non-empty (may contain auth errors, etc.)
  if (stderr.trim()) {
    process.stderr.write(`  [gemini stderr] ${stderr.trim().slice(0, 200)}\n`);
  }

  return {
    output: parsed.output,
    toolCalls: parsed.toolCalls,
    tokens: parsed.tokens,
    exitCode: timedOut ? 124 : exitCode,
    durationMs,
    sessionId: parsed.sessionId,
    rawLines: collectedLines,
  };
}
