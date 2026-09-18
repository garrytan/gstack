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
import { hermeticChildEnv } from './hermetic-env';
import { extractSkillSections } from './skill-fixture';
import { killProcessGroup } from '../../scripts/test-strict-output';
import { CODEX_FRONTIER_MODEL } from '../../scripts/resolvers/constants';

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

/** Existing pipe-drain allowance, separate from the model's work budget. */
export const CODEX_DRAIN_GRACE_MS = 5_000;

export class CodexHarnessError extends Error {
  constructor(message: string, readonly result?: CodexResult) {
    super(message);
    this.name = 'CodexHarnessError';
  }
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
  } else {
    // A missing/unreadable full fixture must fail just like an extraction.
    // Preserve copyFileSync's filesystem diagnostic; an agent can mention a
    // nonexistent skill in its response and otherwise pass discovery checks.
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
  signal?: AbortSignal;     // Abort the process group when an enclosing eval expires
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
    signal,
  } = opts;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  const name = skillName || path.basename(skillDir) || 'gstack';

  const emptyResult = (exitCode: number, output = ''): CodexResult => ({
    output, reasoning: [], toolCalls: [], tokens: 0, exitCode,
    durationMs: Date.now() - startTime, sessionId: null, rawLines: [], stderr: '',
  });
  if (signal?.aborted || Date.now() >= deadline) return emptyResult(124);

  // Preflight and setup are part of the budget, not extra time before it.
  const whichResult = Bun.spawnSync(['which', 'codex'], { timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) });
  if (signal?.aborted || Date.now() >= deadline) return emptyResult(124);
  if (whichResult.exitCode !== 0) {
    if (whichResult.signalCode) throw new CodexHarnessError('Codex binary lookup did not complete');
    return emptyResult(-1, 'SKIP: codex binary not found');
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

    if (signal?.aborted || Date.now() >= deadline) return emptyResult(124);

    // Build codex exec command.
    // --skip-git-repo-check: newer codex CLIs refuse exec in an untrusted
    // non-git directory ("Not inside a trusted directory and
    // --skip-git-repo-check was not specified") — our temp skill dirs are
    // exactly that. Empirically verified against codex on this machine.
    const args = ['exec', '--json', '-s', sandbox, '--skip-git-repo-check'];
    if (ignoreUserConfig) args.push('--ignore-user-config');
    args.push('--model', model ?? process.env.GSTACK_CODEX_MODEL ?? CODEX_FRONTIER_MODEL);
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
    const collectedLines: string[] = [];
    // work --exit--> drain (<=5s) --> result
    //   \--timeout/abort--> kill group + close pipes --> timeout result
    // Exit status comes from 'exit'; a forced drain after exit 0 is an error.
    let stdoutBuffer = '';
    let stderr = '';
    let exitCode: number | undefined;
    let timedOut = false;
    let drainExpired = false;
    let streamError: { stream: 'stdout' | 'stderr'; error: Error } | undefined;
    let spawnError: Error | undefined;
    let stdoutDone = false;
    let stderrDone = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let finalized = false;
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });

    const maybeFinish = () => {
      if (exitCode !== undefined && stdoutDone && stderrDone) finish();
    };
    const closePipes = () => {
      // Destroy both streams: canceling stdout alone cannot release an
      // inherited stderr pipe held by a descendant in another process group.
      proc.stdout!.destroy();
      proc.stderr!.destroy();
    };
    const expireDrain = () => {
      drainExpired = !stdoutDone || !stderrDone;
      killProcessGroup(proc, 'SIGKILL');
      closePipes();
      // Also bound the rare case where a failed group kill produces no exit.
      finish();
    };
    const stopRun = () => {
      // A real auth/crash exit that preceded a pipe stall stays a real exit.
      if (exitCode === undefined) timedOut = true;
      else drainExpired ||= !stdoutDone || !stderrDone;
      killProcessGroup(proc, 'SIGKILL');
      closePipes();
      clearTimeout(drainTimer);
      drainTimer = setTimeout(expireDrain, CODEX_DRAIN_GRACE_MS);
      maybeFinish();
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exitCode = code ?? (exitSignal ? 128 + (os.constants.signals[exitSignal] ?? 0) : 1);
      clearTimeout(workTimer);
      clearTimeout(drainTimer);
      // 'exit' means the child is gone; 'close' also waits for descendant
      // pipes. Start the drain allowance at actual exit, never at close.
      drainTimer = setTimeout(expireDrain, CODEX_DRAIN_GRACE_MS);
      maybeFinish();
    };
    const onSpawnError = (error: Error) => {
      if (finalized) return;
      spawnError = error;
      exitCode = 1;
      closePipes();
      finish();
    };
    // Closure releases lifecycle waits, but only 'end' proves all bytes were
    // drained. A destroyed pipe can emit 'close' without either EOF or error.
    const onStdoutDone = () => { if (!finalized) { stdoutDone = true; maybeFinish(); } };
    const onStderrDone = () => { if (!finalized) { stderrDone = true; maybeFinish(); } };
    const onStdoutEnd = () => { if (!finalized) { stdoutEnded = true; onStdoutDone(); } };
    const onStderrEnd = () => { if (!finalized) { stderrEnded = true; onStderrDone(); } };
    const onStreamError = (stream: 'stdout' | 'stderr', error: Error) => {
      if (!finalized) streamError ??= { stream, error };
    };
    const onStdout = (chunk: string) => {
      if (finalized) return;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item) {
            const item = event.item;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (item.type === 'command_execution' && item.command) {
              process.stderr.write(`  [codex ${elapsed}s] ran: ${item.command.slice(0, 100)}\n`);
            } else if (item.type === 'agent_message' && item.text) {
              process.stderr.write(`  [codex ${elapsed}s] message: ${item.text.slice(0, 100)}\n`);
            }
          }
        } catch { /* malformed JSONL is ignored by parseCodexJSONL too */ }
      }
    };
    const onStderr = (chunk: string) => { if (!finalized) stderr += chunk; };

    proc.on('exit', onExit);
    proc.on('error', onSpawnError);
    proc.stdout!.setEncoding('utf8');
    proc.stderr!.setEncoding('utf8');
    proc.stdout!.on('data', onStdout);
    proc.stderr!.on('data', onStderr);
    proc.stdout!.on('end', onStdoutEnd).on('close', onStdoutDone).on('error', error => onStreamError('stdout', error));
    proc.stderr!.on('end', onStderrEnd).on('close', onStderrDone).on('error', error => onStreamError('stderr', error));
    signal?.addEventListener('abort', stopRun, { once: true });
    workTimer = setTimeout(stopRun, Math.max(0, deadline - Date.now()));
    if (signal?.aborted || Date.now() >= deadline) stopRun();

    try {
      await finished;
      if (stdoutBuffer.trim()) collectedLines.push(stdoutBuffer);
      const parsed = parseCodexJSONL(collectedLines);
      const result: CodexResult = {
        ...parsed,
        exitCode: timedOut ? 124 : exitCode ?? 1,
        durationMs: Date.now() - startTime,
        rawLines: collectedLines,
        stderr,
      };
      if (stderr.trim()) process.stderr.write(`  [codex stderr] ${stderr.trim().slice(0, 200)}\n`);
      if (spawnError) throw new CodexHarnessError(`Could not start Codex: ${spawnError.message}`, result);
      const incompleteStreams = [!stdoutEnded && 'stdout', !stderrEnded && 'stderr'].filter(Boolean).join(' and ');
      if (result.exitCode === 0 && (drainExpired || streamError || incompleteStreams)) {
        throw new CodexHarnessError(
          drainExpired ? `Codex output drain exceeded ${CODEX_DRAIN_GRACE_MS}ms after exit 0`
            : streamError ? `Codex ${streamError.stream} stream failed: ${streamError.error.message}`
            : `Codex ${incompleteStreams} closed before EOF after exit 0`,
          result,
        );
      }
      return result;
    } finally {
      finalized = true;
      clearTimeout(workTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', stopRun);
      // Child exit and closed pipes do not prove its descendants exited:
      // background tools may redirect both streams. Reap the owned group on
      // every result, including ordinary success and genuine process failure.
      killProcessGroup(proc, 'SIGKILL');
      closePipes();
      proc.removeListener('exit', onExit);
      // Retain the harmless error listener through stream teardown so a late
      // OS spawn error cannot turn into an unhandled event after cleanup.
      proc.stdout!.removeListener('data', onStdout);
      proc.stderr!.removeListener('data', onStderr);
    }

  } finally {
    // Clean up temp HOME
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}
