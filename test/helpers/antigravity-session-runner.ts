/**
 * Antigravity CLI subprocess runner for skill E2E testing.
 *
 * Spawns `antigravity exec` as a completely independent process, parses its JSONL
 * output, and returns structured results. Follows the same pattern as
 * session-runner.ts but adapted for the Antigravity CLI.
 *
 * Key differences from Antigravity session-runner:
 * - Uses `antigravity exec` instead of `antigravity -p`
 * - Output is JSONL with different event types (item.completed, turn.completed, thread.started)
 * - Uses `--json` flag instead of `--output-format stream-json`
 * - Needs temp HOME with skill installed at ~/.antigravity/skills/{skillName}/SKILL.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Interfaces ---

export interface AntigravityResult {
  output: string;           // Full agent message text
  reasoning: string[];      // [antigravity thinking] blocks
  toolCalls: string[];      // [antigravity ran] commands
  tokens: number;           // Total tokens used
  exitCode: number;         // Process exit code
  durationMs: number;       // Wall clock time
  sessionId: string | null; // Thread ID for session continuity
  rawLines: string[];       // Raw JSONL lines for debugging
  stderr: string;           // Stderr output (skill loading errors, auth failures)
}

// --- JSONL parser (ported from Python in antigravity/SKILL.md.tmpl) ---

export interface ParsedAntigravityJSONL {
  output: string;
  reasoning: string[];
  toolCalls: string[];
  tokens: number;
  sessionId: string | null;
}

/**
 * Parse an array of JSONL lines from `antigravity exec --json` into structured data.
 * Pure function — no I/O, no side effects.
 *
 * Handles these Antigravity event types:
 * - thread.started → extract thread_id (session ID)
 * - item.completed → extract reasoning, agent_message, command_execution
 * - turn.completed → extract token usage
 */
export function parseAntigravityJSONL(lines: string[]): ParsedAntigravityJSONL {
  const outputParts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: string[] = [];
  let tokens = 0;
  let sessionId: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const t = obj.type || '';

      if (t === 'thread.started') {
        const tid = obj.thread_id || '';
        if (tid) sessionId = tid;
      } else if (t === 'item.completed' && obj.item) {
        const item = obj.item;
        const itype = item.type || '';
        const text = item.text || '';

        if (itype === 'reasoning' && text) {
          reasoning.push(text);
        } else if (itype === 'agent_message' && text) {
          outputParts.push(text);
        } else if (itype === 'command_execution') {
          const cmd = item.command || '';
          if (cmd) toolCalls.push(cmd);
        }
      } else if (t === 'turn.completed') {
        const usage = obj.usage || {};
        const turnTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
        tokens += turnTokens;
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    output: outputParts.join('\n'),
    reasoning,
    toolCalls,
    tokens,
    sessionId,
  };
}

// --- Skill installation helper ---

/**
 * Install a SKILL.md into a temp HOME directory for Antigravity to discover.
 * Creates ~/.antigravity/skills/{skillName}/SKILL.md in the temp HOME and copies
 * agents/openai.yaml when present so Antigravity sees the same metadata as a real install.
 *
 * Returns the temp HOME path. Caller is responsible for cleanup.
 */
export function installSkillToTempHome(
  skillDir: string,
  skillName: string,
  tempHome?: string,
): string {
  const home = tempHome || fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-e2e-'));
  const destDir = path.join(home, '.antigravity', 'skills', skillName);
  fs.mkdirSync(destDir, { recursive: true });

  const srcSkill = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(srcSkill)) {
    fs.copyFileSync(srcSkill, path.join(destDir, 'SKILL.md'));
  }

  const srcOpenAIYaml = path.join(skillDir, 'agents', 'openai.yaml');
  if (fs.existsSync(srcOpenAIYaml)) {
    const destAgentsDir = path.join(destDir, 'agents');
    fs.mkdirSync(destAgentsDir, { recursive: true });
    fs.copyFileSync(srcOpenAIYaml, path.join(destAgentsDir, 'openai.yaml'));
  }

  return home;
}

// --- Main runner ---

/**
 * Run a Antigravity skill via `antigravity exec` and return structured results.
 *
 * Spawns antigravity in a temp HOME with the skill installed, parses JSONL output,
 * and returns a AntigravityResult. Skips gracefully if antigravity binary is not found.
 */
export async function runAntigravitySkill(opts: {
  skillDir: string;         // Path to skill directory containing SKILL.md
  prompt: string;           // What to ask Antigravity to do with the skill
  timeoutMs?: number;       // Default 300000 (5 min)
  cwd?: string;             // Working directory
  skillName?: string;       // Skill name for installation (default: dirname)
  sandbox?: string;         // Sandbox mode (default: 'read-only')
}): Promise<AntigravityResult> {
  const {
    skillDir,
    prompt,
    timeoutMs = 300_000,
    cwd,
    skillName,
    sandbox = 'read-only',
  } = opts;

  const startTime = Date.now();
  const name = skillName || path.basename(skillDir) || 'gstack';

  // Check if antigravity binary exists
  const whichResult = Bun.spawnSync(['which', 'antigravity']);
  if (whichResult.exitCode !== 0) {
    return {
      output: 'SKIP: antigravity binary not found',
      reasoning: [],
      toolCalls: [],
      tokens: 0,
      exitCode: -1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      rawLines: [],
      stderr: '',
    };
  }

  // Set up temp HOME with skill installed
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-e2e-'));
  const realHome = os.homedir();

  try {
    installSkillToTempHome(skillDir, name, tempHome);

    // Symlink real Antigravity auth config so antigravity can authenticate from temp HOME.
    // Antigravity stores auth in ~/.antigravity/ — we need the config but not the skills
    // (we install our own test skills above).
    const realAntigravityConfig = path.join(realHome, '.antigravity');
    const tempAntigravityDir = path.join(tempHome, '.antigravity');
    if (fs.existsSync(realAntigravityConfig)) {
      // Copy auth-related files from real ~/.antigravity/ into temp ~/.antigravity/
      // (skills/ is already set up by installSkillToTempHome)
      const entries = fs.readdirSync(realAntigravityConfig);
      for (const entry of entries) {
        if (entry === 'skills') continue; // don't clobber our test skills
        const src = path.join(realAntigravityConfig, entry);
        const dst = path.join(tempAntigravityDir, entry);
        if (!fs.existsSync(dst)) {
          fs.cpSync(src, dst, { recursive: true });
        }
      }
    }

    // Build antigravity exec command
    const args = ['exec', prompt, '--json', '-s', sandbox];

    // Spawn antigravity with temp HOME so it discovers our installed skill
    const proc = Bun.spawn(['antigravity', ...args], {
      cwd: cwd || skillDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: tempHome,
      },
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
            if (event.type === 'item.completed' && event.item) {
              const item = event.item;
              if (item.type === 'command_execution' && item.command) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                process.stderr.write(`  [antigravity ${elapsed}s] ran: ${item.command.slice(0, 100)}\n`);
              } else if (item.type === 'agent_message' && item.text) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                process.stderr.write(`  [antigravity ${elapsed}s] message: ${item.text.slice(0, 100)}\n`);
              }
            }
          } catch { /* skip — parseAntigravityJSONL will handle it later */ }
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
    const parsed = parseAntigravityJSONL(collectedLines);

    // Log stderr if non-empty (may contain auth errors, etc.)
    if (stderr.trim()) {
      process.stderr.write(`  [antigravity stderr] ${stderr.trim().slice(0, 200)}\n`);
    }

    return {
      output: parsed.output,
      reasoning: parsed.reasoning,
      toolCalls: parsed.toolCalls,
      tokens: parsed.tokens,
      exitCode: timedOut ? 124 : exitCode,
      durationMs,
      sessionId: parsed.sessionId,
      rawLines: collectedLines,
      stderr,
    };
  } finally {
    // Clean up temp HOME
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}
