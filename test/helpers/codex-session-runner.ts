/**
 * Codex CLI subprocess runner for skill E2E testing.
 *
 * Spawns `codex exec` as a completely independent process, parses its JSONL
 * output, and returns structured results. Follows the same pattern as
 * session-runner.ts but adapted for the Codex CLI.
 *
 * Key differences from Claude session-runner:
 * - Uses `codex exec` instead of `claude -p`
 * - Output is JSONL with different event types (item.completed, turn.completed, thread.started)
 * - Uses `--json` flag instead of `--output-format stream-json`
 * - Needs temp HOME with skill installed at ~/.codex/skills/{skillName}/SKILL.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { Readable } from 'node:stream';
import { hermeticChildEnv } from './hermetic-env';
import { extractSkillSections } from './skill-fixture';
import { killProcessGroup } from '../../scripts/test-strict-output';

// --- Interfaces ---

export interface CodexResult {
  output: string;           // Full agent message text
  reasoning: string[];      // [codex thinking] blocks
  toolCalls: string[];      // [codex ran] commands
  tokens: number;           // Total tokens used
  exitCode: number;         // Process exit code
  durationMs: number;       // Wall clock time
  sessionId: string | null; // Thread ID for session continuity
  rawLines: string[];       // Raw JSONL lines for debugging
  stderr: string;           // Stderr output (skill loading errors, auth failures)
}

// --- JSONL parser (ported from Python in codex/SKILL.md.tmpl) ---

export interface ParsedCodexJSONL {
  output: string;
  reasoning: string[];
  toolCalls: string[];
  tokens: number;
  sessionId: string | null;
}

/**
 * Parse an array of JSONL lines from `codex exec --json` into structured data.
 * Pure function — no I/O, no side effects.
 *
 * Handles these Codex event types:
 * - thread.started → extract thread_id (session ID)
 * - item.completed → extract reasoning, agent_message, command_execution
 * - turn.completed → extract token usage
 */
export function parseCodexJSONL(lines: string[]): ParsedCodexJSONL {
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
 * Install a SKILL.md into a temp HOME directory for Codex to discover.
 * Creates ~/.codex/skills/{skillName}/SKILL.md in the temp HOME and copies
 * agents/openai.yaml when present so Codex sees the same metadata as a real install.
 *
 * When `sections` is provided, the installed SKILL.md is an EXTRACTION
 * (frontmatter + the named `## <section>` blocks via
 * test/helpers/skill-fixture.ts) instead of the full 1000-1900-line file —
 * CLAUDE.md: "E2E test fixtures: extract, don't copy". Omit `sections` only
 * when the test's purpose is to validate the real generated artifact itself
 * (e.g., codex-discover-skill asserts the full SKILL.md loads without
 * "invalid" / "Skipped loading" stderr from Codex).
 *
 * Returns the temp HOME path. Caller is responsible for cleanup.
 */
export function installSkillToTempHome(
  skillDir: string,
  skillName: string,
  tempHome?: string,
  sections?: string[],
): string {
  const home = tempHome || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
  const destDir = path.join(home, '.codex', 'skills', skillName);
  fs.mkdirSync(destDir, { recursive: true });

  const srcSkill = path.join(skillDir, 'SKILL.md');
  if (sections && sections.length > 0) {
    // extractSkillSections throws loudly on a missing file or renamed
    // section — a fixture is never silently written empty.
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), extractSkillSections(skillDir, sections));
  } else if (fs.existsSync(srcSkill)) {
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
 * Run a Codex skill via `codex exec` and return structured results.
 *
 * Spawns codex in a temp HOME with the skill installed, parses JSONL output,
 * and returns a CodexResult. Skips gracefully if codex binary is not found.
 */
export async function runCodexSkill(opts: {
  skillDir: string;         // Path to skill directory containing SKILL.md
  prompt: string;           // What to ask Codex to do with the skill
  timeoutMs?: number;       // Default 300000 (5 min)
  cwd?: string;             // Working directory
  skillName?: string;       // Skill name for installation (default: dirname)
  sandbox?: string;         // Sandbox mode (default: 'read-only')
  sections?: string[];      // Install only these `## <section>` blocks (extract, don't copy)
  model?: string;           // Exact Codex model ID (passed with --model)
  configOverrides?: string[]; // TOML key=value overrides (passed with -c)
  ignoreUserConfig?: boolean; // Add --ignore-user-config; auth still comes from CODEX_HOME
}): Promise<CodexResult> {
  const {
    skillDir,
    prompt,
    timeoutMs = 300_000,
    cwd,
    skillName,
    sandbox = 'read-only',
    sections,
    model,
    configOverrides = [],
    ignoreUserConfig = false,
  } = opts;

  const startTime = Date.now();
  const name = skillName || path.basename(skillDir) || 'gstack';

  // Check if codex binary exists
  const whichResult = Bun.spawnSync(['which', 'codex'], { timeout: 30_000 });
  if (whichResult.exitCode !== 0) {
    return {
      output: 'SKIP: codex binary not found',
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
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
  const realHome = os.homedir();

  try {
    installSkillToTempHome(skillDir, name, tempHome, sections);

    // Copy authentication only. Copying the whole operator ~/.codex tree leaks
    // plugins, MCP servers, rules, memories, and skills into a supposedly
    // hermetic E2E; required private MCPs can then fail before the model starts.
    const realCodexConfig = process.env.CODEX_HOME || path.join(realHome, '.codex');
    const tempCodexDir = path.join(tempHome, '.codex');
    if (fs.existsSync(realCodexConfig)) {
      for (const entry of ['auth.json']) {
        const src = path.join(realCodexConfig, entry);
        const dst = path.join(tempCodexDir, entry);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.cpSync(src, dst, { recursive: true });
        }
      }
    }

    // Build codex exec command.
    // --skip-git-repo-check: newer codex CLIs refuse exec in an untrusted
    // non-git directory ("Not inside a trusted directory and
    // --skip-git-repo-check was not specified") — our temp skill dirs are
    // exactly that. Empirically verified against codex on this machine.
    const args = ['exec', '--json', '-s', sandbox, '--skip-git-repo-check'];
    if (ignoreUserConfig) args.push('--ignore-user-config');
    if (model) args.push('--model', model);
    for (const override of configOverrides) args.push('-c', override);
    args.push(prompt);

    // Spawn codex with temp HOME so it discovers our installed skill.
    // Hermetic scrub (test/helpers/hermetic-env.ts) with codex's auth surface
    // re-admitted: codex auths from $HOME/.codex (copied into tempHome above)
    // plus OPENAI_API_KEY/CODEX_* when present. HOME override merges last.
    // node:child_process spawn with `detached` (own process group) — mirrors
    // session-runner.ts. Bun.spawn's bare proc.kill() signalled only codex
    // itself; command subprocesses codex spawned survived as orphans holding
    // our pipes open (the same blocked-drain hang the claude runner fixed —
    // this copy never inherited that fix until now).
    const proc = spawn('codex', args, {
      cwd: cwd || skillDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: hermeticChildEnv(
        { HOME: tempHome, CODEX_HOME: tempCodexDir },
        { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] },
      ),
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
            if (event.type === 'item.completed' && event.item) {
              const item = event.item;
              if (item.type === 'command_execution' && item.command) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                process.stderr.write(`  [codex ${elapsed}s] ran: ${item.command.slice(0, 100)}\n`);
              } else if (item.type === 'agent_message' && item.text) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                process.stderr.write(`  [codex ${elapsed}s] message: ${item.text.slice(0, 100)}\n`);
              }
            }
          } catch { /* skip — parseCodexJSONL will handle it later */ }
        }
      }
    } catch { /* stream read error — fall through to exit code handling */ }

    // Flush remaining buffer
    if (buf.trim()) {
      collectedLines.push(buf);
    }

    // Same orphan hazard as stdout: a grandchild holding stderr open would
    // block this drain forever. Race it against child exit + a short grace
    // window (ported from session-runner.ts — the codex copy lacked it).
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
    const parsed = parseCodexJSONL(collectedLines);

    // Log stderr if non-empty (may contain auth errors, etc.)
    if (stderr.trim()) {
      process.stderr.write(`  [codex stderr] ${stderr.trim().slice(0, 200)}\n`);
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
