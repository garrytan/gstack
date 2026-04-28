/**
 * Sub-agent invocation wrappers for gstack-build.
 *
 * Three callable subagents, all spawned as fresh CLI processes (no MCP):
 *   - runGemini(opts)       implements a phase
 *   - runCodexReview(opts)  reviews an implementation
 *   - runShip(opts)         final ship + land-and-deploy
 *
 * Each invocation:
 *   - Streams stdout+stderr to a log file under ~/.gstack/build-state/<slug>/
 *   - Returns a SubAgentResult with the captured output, exit code, timeout flag
 *   - Has a configurable timeout via env var (sensible 10/15/30 min defaults)
 *   - Retries ONCE on timeout. Non-timeout failures bubble up immediately so
 *     the caller can decide.
 *
 * Idioms borrowed from ~/mcp-llm-bridge/src/server.ts:
 *   - Codex needs stdin closed or `codex exec` hangs forever
 *   - 20MB max buffer for stdout
 *   - --yolo on Gemini for autonomous file edits
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logDir, ensureLogDir } from './state';

const MAX_BUFFER = 20 * 1024 * 1024;

const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const GEMINI_TIMEOUT_MS = Number(process.env.GSTACK_BUILD_GEMINI_TIMEOUT) || 10 * 60_000;
const CODEX_TIMEOUT_MS = Number(process.env.GSTACK_BUILD_CODEX_TIMEOUT) || 15 * 60_000;
const SHIP_TIMEOUT_MS = Number(process.env.GSTACK_BUILD_SHIP_TIMEOUT) || 30 * 60_000;

export type Verdict = 'pass' | 'fail' | 'unclear';

export interface SubAgentResult {
  /** Captured stdout (also written to logPath). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Exit code; null if process was killed by signal. */
  exitCode: number | null;
  /** True if killed by the timeout, not a real exit. */
  timedOut: boolean;
  /** Absolute path to the log file written for this invocation. */
  logPath: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Number of retries used (0 if first attempt succeeded). */
  retries: number;
}

/**
 * Spawn a child, capture stdout+stderr to a log file, and resolve with
 * structured result. Closes stdin if `closeStdin` (Codex needs this).
 */
function spawnCaptured(args: {
  bin: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  logPath: string;
  closeStdin: boolean;
}): Promise<SubAgentResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    const child = execFile(
      args.bin,
      args.argv,
      {
        maxBuffer: MAX_BUFFER,
        timeout: args.timeoutMs,
        cwd: args.cwd,
      },
      (err, stdout, stderr) => {
        // Persist captured output regardless of success.
        try {
          fs.writeFileSync(
            args.logPath,
            `# command: ${args.bin} ${args.argv.map(quote).join(' ')}\n` +
              `# cwd: ${args.cwd || process.cwd()}\n` +
              `# started: ${new Date(startedAt).toISOString()}\n` +
              `# duration_ms: ${Date.now() - startedAt}\n` +
              `# timed_out: ${timedOut}\n` +
              `# exit: ${err ? (err as any).code ?? 'killed' : 0}\n` +
              `\n# ---- stdout ----\n${stdout}\n# ---- stderr ----\n${stderr}\n`
          );
        } catch {
          // Log file write failures shouldn't sink the orchestrator.
        }

        const exitCode = err ? ((err as any).code as number | null) ?? null : 0;
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          exitCode,
          timedOut,
          logPath: args.logPath,
          durationMs: Date.now() - startedAt,
          retries: 0,
        });
      }
    );

    // Detect timeout — Node's execFile sets err.signal='SIGTERM' when timeout
    // fires, so we shadow that detection with our own flag for clarity.
    if (args.timeoutMs > 0) {
      const t = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, args.timeoutMs + 1000); // run slightly after Node's own timer fires
      child.once('exit', () => clearTimeout(t));
    }

    if (args.closeStdin) child.stdin?.end();
  });
}

function quote(s: string): string {
  if (/^[a-zA-Z0-9_\/\.\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a Gemini implementation pass via FILE-PATH I/O.
 *
 * The caller writes the full instruction body to `inputFilePath` BEFORE calling
 * this function. We construct a short shell-prompt that just tells Gemini where
 * to read instructions and where to write output. Pass `--yolo` for autonomous
 * file edits (without it Gemini drops to plan mode for multi-file tasks).
 *
 * After Gemini exits, we read `outputFilePath` and put its content into the
 * returned `stdout` field — so callers (like phase-runner) can parse output
 * the same way they always have. The shell stdout becomes status-only.
 *
 * Universal rule: never pass content inline. Always file paths in, file paths
 * out. See ~/.claude/projects/.../memory/feedback_llm_file_io.md.
 */
export async function runGemini(opts: {
  /** Path to the file containing the full prompt body. Caller must write it first. */
  inputFilePath: string;
  /** Path where Gemini will write its output summary. Caller decides the path. */
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  model?: string;
  logPrefix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shellPrompt = [
    `Read instructions at ${opts.inputFilePath}.`,
    `Do the work autonomously using your --yolo file tools.`,
    `When done, write your output summary (what files changed, what tests pass, what was committed) to ${opts.outputFilePath}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const argv = ['-p', shellPrompt];
  if (opts.model) argv.push('-m', opts.model);
  argv.push('--yolo');

  const prefix = opts.logPrefix ?? 'gemini';
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${prefix}-${opts.iteration}.log`
  );

  let result = await spawnCaptured({
    bin: GEMINI_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  // Single retry on timeout only.
  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-gemini-${opts.iteration}-retry.log`
    );
    const retryResult = await spawnCaptured({
      bin: GEMINI_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: GEMINI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * After a sub-agent exits, read the file it was supposed to write and put
 * its content into the result's `stdout` field. Callers (parseVerdict,
 * phase-runner) keep working with `stdout` as the work-product source —
 * they just don't know whether it came from shell stdout or a file.
 *
 * If the output file is missing or unreadable, the sub-agent didn't follow
 * the protocol. We synthesize a clear error message into stdout so verdict
 * parsing fails the way it should ("unclear"), and surface the original
 * shell stdout in stderr for forensics.
 */
function mergeOutputFile(result: SubAgentResult, outputFilePath: string): SubAgentResult {
  try {
    const fileContent = fs.readFileSync(outputFilePath, 'utf8');
    return {
      ...result,
      stderr: result.stderr + (result.stdout ? `\n# original stdout:\n${result.stdout}` : ''),
      stdout: fileContent,
    };
  } catch (err) {
    return {
      ...result,
      stderr: result.stderr + `\n# expected output file ${outputFilePath} not readable: ${(err as Error).message}`,
      stdout: `Sub-agent did not write expected output file ${outputFilePath}. Original shell stdout:\n${result.stdout}`,
    };
  }
}

/**
 * Run one iteration of Codex review (i.e. `codex exec /gstack-review`).
 * Caller checks the verdict via parseVerdict(stdout) and decides whether
 * to loop again.
 */
export async function runCodexReview(opts: {
  /** Path to file with full review context (which phase, what changed, what to verify). Caller writes it first. */
  inputFilePath: string;
  /** Path where Codex will write its review report including the GATE PASS/FAIL line. */
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  /** Which slash-command to run, e.g. `/gstack-review` or `/gstack-qa`. */
  command?: string;
  /** Reasoning effort: low | medium | high. Default high for reviews. */
  reasoning?: 'low' | 'medium' | 'high';
  /** Sandbox mode. `workspace-write` lets the review loop fix bugs;
   * `read-only` makes it report-only. Default workspace-write because the
   * recursive loop expects fix-and-rereview. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const command = opts.command || '/gstack-review';
  const reasoning = opts.reasoning || 'high';
  const sandbox = opts.sandbox || 'workspace-write';

  const codexPrompt = [
    `Read review context at ${opts.inputFilePath}.`,
    `Run ${command}.`,
    `Write your full review report to ${opts.outputFilePath}.`,
    `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const argv = [
    'exec',
    codexPrompt,
    '-s',
    sandbox,
    '-c',
    `model_reasoning_effort="${reasoning}"`,
    '-C',
    opts.cwd,
  ];

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-codex-${opts.iteration}.log`
  );

  let result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: true, // codex exec hangs without this
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-codex-${opts.iteration}-retry.log`
    );
    const retryResult = await spawnCaptured({
      bin: CODEX_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: CODEX_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: true,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * Final ship step: spawn Claude Code with /ship, then /land-and-deploy.
 * These are TWO sequential claude invocations, not one chained call —
 * `&&` inside a -p argument is treated as part of the prompt, not as
 * a shell operator. Long timeout (30 min default per phase) because
 * deploys can wait on CI.
 *
 * Returns the FIRST failure, or the final /land-and-deploy result on
 * full success. The combined log captures both invocations.
 */
export async function runShip(opts: {
  cwd: string;
  slug: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shipLog = path.join(logDir(opts.slug), 'ship.log');
  const shipResult = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv: ['--model', 'sonnet', '-p', '/ship'],
    cwd: opts.cwd,
    timeoutMs: SHIP_TIMEOUT_MS,
    logPath: shipLog,
    closeStdin: false,
  });

  // Bail out before /land-and-deploy if /ship failed.
  if (shipResult.timedOut || shipResult.exitCode !== 0) {
    return shipResult;
  }

  const deployLog = path.join(logDir(opts.slug), 'land-and-deploy.log');
  return spawnCaptured({
    bin: CLAUDE_BIN,
    argv: ['--model', 'sonnet', '-p', '/land-and-deploy'],
    cwd: opts.cwd,
    timeoutMs: SHIP_TIMEOUT_MS,
    logPath: deployLog,
    closeStdin: false,
  });
}

/**
 * Strip ANSI escape sequences so verdict parsing isn't fooled by colored
 * output from codex.
 */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Parse Codex review output for the GATE PASS / GATE FAIL keyword.
 * Case-sensitive on the keyword (matches the convention used in real plans
 * — see ~/Documents/Antigravity/agnt2-workspace/.../agnt2-impl-plan-...md).
 *
 * Strategy: strip ANSI, then look for the LAST occurrence of either
 * keyword (last verdict wins, in case Codex iterated mid-output).
 */
export function parseVerdict(stdout: string): Verdict {
  const clean = stripAnsi(stdout);
  const passIdx = clean.lastIndexOf('GATE PASS');
  const failIdx = clean.lastIndexOf('GATE FAIL');
  if (passIdx < 0 && failIdx < 0) return 'unclear';
  if (passIdx > failIdx) return 'pass';
  return 'fail';
}

export function detectTestCmd(cwd: string): string | null {
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return pkg.scripts.test;
    } catch {
      console.warn('  ⚠ package.json is not valid JSON; skipping npm/bun test detection');
    }
  }
  if (fs.existsSync(path.join(cwd, 'pytest.ini'))) return 'pytest';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    const toml = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
    if (toml.includes('[tool.pytest.ini_options]')) return 'pytest';
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  return null;
}

export async function runGeminiTestSpec(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  model?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shellPrompt = [
    `Read instructions at ${opts.inputFilePath}.`,
    `Do the work autonomously using your --yolo file tools.`,
    `When done, write your output summary (what files changed, what tests pass, what was committed) to ${opts.outputFilePath}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const argv = ['-p', shellPrompt];
  if (opts.model) argv.push('-m', opts.model);
  argv.push('--yolo');

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-gemini-testspec-${opts.iteration}.log`
  );

  let result = await spawnCaptured({
    bin: GEMINI_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: GEMINI_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-gemini-testspec-${opts.iteration}-retry.log`
    );
    const retryResult = await spawnCaptured({
      bin: GEMINI_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: GEMINI_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}

export async function runTests(opts: {
  testCmd: string;
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const parts = opts.testCmd.trim().split(/\s+/);
  const bin = parts[0];
  const argv = parts.slice(1);

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-tests-${opts.iteration}.log`
  );

  return spawnCaptured({
    bin,
    argv,
    cwd: opts.cwd,
    timeoutMs: Number(process.env.GSTACK_BUILD_TEST_TIMEOUT) || 5 * 60_000,
    logPath,
    closeStdin: true,
  });
}
