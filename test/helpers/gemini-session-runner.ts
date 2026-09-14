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
 *   (`--skip-trust` was removed in gemini-cli 0.34; folder trust is settings-driven now)
 * - No temp HOME needed — Gemini discovers skills from `.agents/skills/` in cwd
 * - Message events are streamed with `delta: true` — must concatenate
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'node:stream';
import { hermeticChildEnv } from './hermetic-env';
import { killProcessGroup } from '../../scripts/test-strict-output';

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
  const whichResult = Bun.spawnSync(['which', 'gemini'], { timeout: 30_000 });
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

  // Build gemini command.
  // --skip-trust was REMOVED in gemini-cli 0.34 ("Unknown arguments:
  // skip-trust"); folder trust moved to settings and no longer needs a flag
  // for headless runs. --yolo still auto-approves tool actions.
  const args = ['-p', prompt, '--output-format', 'stream-json', '--yolo'];

  // Spawn gemini — uses real HOME for auth (~/.gemini; HOME is allowlisted),
  // cwd for skill discovery. Hermetic scrub with gemini's auth surface
  // re-admitted (previously this spawn inherited the full operator env).
  // node:child_process spawn with `detached` (own process group) — mirrors
  // session-runner.ts. A bare kill signalled only gemini itself; tool
  // subprocesses survived as orphans holding our pipes open (the same
  // blocked-drain hang the claude runner fixed — this copy lacked it).
  const proc = spawn('gemini', args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: hermeticChildEnv(undefined, {
      extraAllow: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_*', 'GEMINI_*'],
    }),
  });
  const stdoutWeb = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stderrWeb = Readable.toWeb(proc.stderr!) as ReadableStream<Uint8Array>;
  const procExited: Promise<number> = new Promise((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });

  // Race against timeout
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    // Group SIGKILL + reader cancel: kill the whole tree AND unblock the
    // read loop even if a stray grandchild survives the group kill.
    killProcessGroup(proc, 'SIGKILL');
    reader.cancel().catch(() => { /* stream already closed */ });
  }, timeoutMs);

  // Stream and collect JSONL from stdout
  const collectedLines: string[] = [];
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

  // Same orphan hazard as stdout: a grandchild holding stderr open would
  // block this drain forever. Race against child exit + a short grace window
  // (ported from session-runner.ts — the gemini copy lacked it).
  const stderr = await Promise.race([
    stderrPromise,
    (async () => {
      await procExited;
      await new Promise((r) => setTimeout(r, 5_000));
      return '';
    })(),
  ]);
  const exitCode = await procExited;
  clearTimeout(timeoutId);

  const durationMs = Date.now() - startTime;

  // Parse all collected JSONL lines
  const parsed = parseGeminiJSONL(collectedLines);

  // Log stderr if non-empty (may contain auth errors, etc.)
  if (stderr.trim()) {
    process.stderr.write(`  [gemini stderr] ${stderr.trim().slice(0, 200)}\n`);
  }

  // Environment-unusable classification: these are Google-side conditions no
  // test assertion can act on — the deprecated individual code-assist auth
  // path ("migrate to the Antigravity suite") and argv drift on older/newer
  // CLIs. Return the same SKIP shape as binary-not-found so callers report
  // SKIPPED instead of a false FAIL.
  const unusableMarkers = [
    'no longer supported for Gemini Code Assist',
    'antigravity',
    'Unknown arguments: skip-trust',
  ];
  if (exitCode !== 0 && parsed.tokens === 0) {
    const marker = unusableMarkers.find((m) => stderr.toLowerCase().includes(m.toLowerCase()));
    if (marker) {
      return {
        output: `SKIP: gemini CLI unusable (${marker})`,
        toolCalls: [],
        tokens: 0,
        exitCode: -1,
        durationMs,
        sessionId: null,
        rawLines: collectedLines,
      };
    }
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
