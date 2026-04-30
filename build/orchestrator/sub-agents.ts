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
import type { RoleReasoning } from './role-config';
import { BUILD_DEFAULTS, envNumberOrDefault } from './build-config';

const MAX_BUFFER = 20 * 1024 * 1024;

const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const GEMINI_TIMEOUT_MS = envNumberOrDefault('GSTACK_BUILD_GEMINI_TIMEOUT', BUILD_DEFAULTS.timeoutsMs.gemini);
const CODEX_TIMEOUT_MS = envNumberOrDefault('GSTACK_BUILD_CODEX_TIMEOUT', BUILD_DEFAULTS.timeoutsMs.codex);
const SHIP_TIMEOUT_MS = envNumberOrDefault('GSTACK_BUILD_SHIP_TIMEOUT', BUILD_DEFAULTS.timeoutsMs.ship);

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
        // Detect timeout via Node's own kill flag (fires before our +1000ms setTimeout).
        if (err?.killed) timedOut = true;

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
function mergeOutputFile(
  result: SubAgentResult,
  outputFilePath: string,
  opts?: { emptyFileIsError?: boolean }
): SubAgentResult {
  try {
    const fileContent = fs.readFileSync(outputFilePath, 'utf8');
    if (fileContent.trim() === '') {
      if (opts?.emptyFileIsError) {
        // For judge calls the output file is the only authoritative source.
        // An empty file means the judge didn't write its verdict. Do NOT embed
        // any original stdout in the returned stdout — parseJudgeVerdict scans
        // stdout for WINNER: and a stray line from judge narration would give a
        // false verdict. All debugging content goes to stderr only.
        return {
          ...result,
          stderr:
            result.stderr +
            `\n# judge output file ${outputFilePath} was empty — treating as parse failure` +
            (result.stdout ? `\n# original shell stdout:\n${result.stdout}` : ''),
          stdout: '',
        };
      }
      // Sub-agent left the output file empty (e.g. Codex applied edits inline but
      // skipped writing the report). Preserve captured streams so parseVerdict can
      // still find GATE PASS / GATE FAIL — Codex writes its verdict to stderr.
      return {
        ...result,
        stdout: [result.stdout, result.stderr].filter(Boolean).join('\n'),
      };
    }
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

export function buildCodexReviewArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  command?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  reasoning?: RoleReasoning;
  model?: string;
  gate?: boolean;
}): string[] {
  const command = opts.command || '/gstack-review';
  const reasoning = opts.reasoning || 'high';
  const sandbox = opts.sandbox || 'workspace-write';

  const codexPrompt = [
    `Read review context at ${opts.inputFilePath}.`,
    `Run ${command}.`,
    `Write your full review report to ${opts.outputFilePath}.`,
    opts.gate === false
      ? `Report whether the command completed successfully.`
      : `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  return [
    'exec',
    codexPrompt,
    ...(opts.model ? ['-m', opts.model] : []),
    '-s',
    sandbox,
    '-c',
    `model_reasoning_effort="${reasoning}"`,
    '-C',
    opts.cwd,
  ];
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
  /** Reasoning effort: low | medium | high | xhigh. Default xhigh for reviews (thinking mode). */
  reasoning?: RoleReasoning;
  /** Sandbox mode. `workspace-write` lets the review loop fix bugs;
   * `read-only` makes it report-only. Default workspace-write because the
   * recursive loop expects fix-and-rereview. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string;
  gate?: boolean;
  logPrefix?: string;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const argv = buildCodexReviewArgv({
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
    cwd: opts.cwd,
    command: opts.command,
    sandbox: opts.sandbox,
    reasoning: opts.reasoning,
    model: opts.model,
    gate: opts.gate,
  });

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${opts.logPrefix ?? 'codex'}-${opts.iteration}.log`
  );

  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;

  let result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs,
    logPath,
    closeStdin: true, // codex exec hangs without this
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-${opts.logPrefix ?? 'codex'}-${opts.iteration}-retry.log`
    );
    const retryResult = await spawnCaptured({
      bin: CODEX_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs,
      logPath: retryLog,
      closeStdin: true,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * Build the argv for a Claude file-path task. Claude does not expose the same
 * reasoning flag shape as Codex here, so reasoning is carried as an explicit
 * instruction in the prompt.
 */
export function buildClaudeTaskArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
}): string[] {
  const commandLine = opts.command ? `Run ${opts.command}.` : 'Do the requested work.';
  const gateLine = opts.gate
    ? `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`
    : '';
  const prompt = [
    `Use ${opts.reasoning || 'high'} thinking.`,
    `Read instructions at ${opts.inputFilePath}.`,
    commandLine,
    `Write your complete output to ${opts.outputFilePath}.`,
    gateLine,
    `Return ONLY the output file path. No narrative.`,
  ].filter(Boolean).join(' ');
  return [...(opts.model ? ['--model', opts.model] : []), '-p', prompt];
}

export async function runClaudeTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
  timeoutMs?: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const argv = buildClaudeTaskArgv(opts);
  const logPath = path.join(
    logDir(opts.slug),
    opts.phaseNumber
      ? `phase-${opts.phaseNumber}-${opts.logPrefix}-${opts.iteration ?? 1}.log`
      : `${opts.logPrefix}.log`
  );
  let result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });
  if (result.timedOut) {
    const retryLog = logPath.replace(/\.log$/, '-retry.log');
    const retryResult = await spawnCaptured({
      bin: CLAUDE_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? CODEX_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}

/**
 * Final ship step: run the configurable ship command, then land command.
 * Returns the FIRST failure, or the final land result on full success.
 */
export async function runShip(opts: {
  cwd: string;
  slug: string;
  ship: {
    provider: 'claude' | 'codex';
    model: string;
    reasoning: RoleReasoning;
    command: string;
  };
  land: {
    provider: 'claude' | 'codex';
    model: string;
    reasoning: RoleReasoning;
    command: string;
  };
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shipInput = path.join(logDir(opts.slug), 'ship-input.md');
  const shipOutput = path.join(logDir(opts.slug), 'ship-output.md');
  fs.writeFileSync(shipInput, `Run ${opts.ship.command} for this repository. Report exactly what happened.`);
  fs.writeFileSync(shipOutput, '');
  const shipResult = await runSlashCommand({
    inputFilePath: shipInput,
    outputFilePath: shipOutput,
    cwd: opts.cwd,
    slug: opts.slug,
    logPrefix: 'ship',
    role: opts.ship,
    timeoutMs: SHIP_TIMEOUT_MS,
    gate: false,
  });

  // Bail out before /land-and-deploy if /ship failed.
  if (shipResult.timedOut || shipResult.exitCode !== 0) {
    return shipResult;
  }

  const landInput = path.join(logDir(opts.slug), 'land-and-deploy-input.md');
  const landOutput = path.join(logDir(opts.slug), 'land-and-deploy-output.md');
  fs.writeFileSync(landInput, `Run ${opts.land.command} for this repository. Report exactly what happened.`);
  fs.writeFileSync(landOutput, '');
  return runSlashCommand({
    inputFilePath: landInput,
    outputFilePath: landOutput,
    cwd: opts.cwd,
    slug: opts.slug,
    logPrefix: 'land-and-deploy',
    role: opts.land,
    timeoutMs: SHIP_TIMEOUT_MS,
    gate: false,
  });
}

export async function runSlashCommand(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: {
    provider: 'claude' | 'codex';
    model: string;
    reasoning: RoleReasoning;
    command: string;
  };
  timeoutMs?: number;
  gate?: boolean;
}): Promise<SubAgentResult> {
  if (opts.role.provider === 'claude') {
    return runClaudeTask({
      inputFilePath: opts.inputFilePath,
      outputFilePath: opts.outputFilePath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: opts.phaseNumber,
      iteration: opts.iteration,
      logPrefix: opts.logPrefix,
      command: opts.role.command,
      model: opts.role.model,
      reasoning: opts.role.reasoning,
      gate: opts.gate,
      timeoutMs: opts.timeoutMs,
    });
  }
  return runCodexReview({
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
    cwd: opts.cwd,
    slug: opts.slug,
    phaseNumber: opts.phaseNumber ?? 'ship',
    iteration: opts.iteration ?? 1,
    command: opts.role.command,
    model: opts.role.model,
    reasoning: opts.role.reasoning,
    gate: opts.gate,
    logPrefix: opts.logPrefix,
    timeoutMs: opts.timeoutMs,
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
  /** Optional suffix to disambiguate parallel runs (dual-impl: 'gemini' / 'codex'). */
  logSuffix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const parts = opts.testCmd.trim().split(/\s+/);
  const bin = parts[0];
  const argv = parts.slice(1);

  const suffix = opts.logSuffix ? `-${opts.logSuffix}` : '';
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-tests-${opts.iteration}${suffix}.log`
  );

  return spawnCaptured({
    bin,
    argv,
    cwd: opts.cwd,
    timeoutMs: envNumberOrDefault('GSTACK_BUILD_TEST_TIMEOUT', BUILD_DEFAULTS.timeoutsMs.test),
    logPath,
    closeStdin: true,
  });
}

// ---------------------------------------------------------------------------
// Dual-implementor (--dual-impl) sub-agents
// ---------------------------------------------------------------------------

/**
 * Count failing test cases in a test runner's stdout.
 *
 * Returns `undefined` when no signal is detectable — phase-runner uses
 * undefined as "no signal" and falls back to fail-closed if BOTH impls
 * lack a count. Returning 0 here was misleading: a compile-error or
 * "no tests ran" output would beat a real "1 test failed" output in
 * tie-breaking. (Codex Phase 3 review, MEDIUM.)
 *
 * Tries multiple signals in priority order:
 *   1. Explicit summary line: `N failed`, `N fail` (bun, jest, vitest, pytest)
 *   2. ✗ marker count (bun-style)
 *   3. ^FAIL line count (jest/pytest-style)
 */
export function parseFailureCount(output: string): number | undefined {
  if (!output) return undefined;
  const clean = stripAnsi(output);

  // Priority 1: pytest summary like "===== 2 failed in 0.10s =====" or "===== 2 failed, 3 passed".
  // Pytest decorates with `=` and `_` chars before/around the summary line.
  const pytestMatch = clean.match(/^=+\s*(\d+)\s+failed\b/im);
  if (pytestMatch) return Number(pytestMatch[1]);

  // Priority 2: bun/jest/vitest/cargo summary at start of line, like "3 failed" / "3 fail".
  // Anchored to ^\s* so it doesn't match "✗ test 1 failed" mid-line.
  const summaryMatch = clean.match(/^\s*(\d+)\s+fail(?:ed|ing)?\b/im);
  if (summaryMatch) return Number(summaryMatch[1]);

  // Priority 3: per-test marker counts as fallback.
  // ✗ (bun-style), FAIL or FAILED at start of line (jest=FAIL, pytest=FAILED).
  const cross = (clean.match(/✗/g) || []).length;
  const fail = (clean.match(/^FAIL(?:ED)?\b/gm) || []).length;
  const markerMax = Math.max(cross, fail);
  return markerMax > 0 ? markerMax : undefined;
}

/**
 * Parse the tournament judge's output for a verdict + reasoning.
 *
 * Expected format (anchored to start-of-line; case-insensitive on the value):
 *   WINNER: gemini|codex
 *   REASONING: <one paragraph>
 *
 * Returns `verdict: null` when no anchored WINNER line is found. Caller
 * (Phase 4 CLI handler) MUST treat null as a hard failure — passing a fake
 * verdict here would defeat the fail-closed semantics in phase-runner where
 * dual_winner_pending without selectedImplementor → FAIL.
 *
 * (Codex Phase 3 review, HIGH — silent fallback to gemini was the original
 * defect; null surfaces it instead.)
 */
export function parseJudgeVerdict(output: string): {
  verdict: 'gemini' | 'codex' | null;
  reasoning: string;
  hardeningNotes: string;
} {
  const clean = stripAnsi(output || '').replace(/\r/g, '');
  // Anchored: WINNER must be at start of line. Avoids false matches like
  // "I think the WINNER: gemini is better" embedded in narrative prose.
  const winnerMatch = clean.match(/^\s*WINNER:\s*(gemini|codex)\b/im);
  if (!winnerMatch) {
    return {
      verdict: null,
      reasoning: 'no anchored WINNER line found in judge output — caller must fail-closed',
      hardeningNotes: '',
    };
  }
  const verdict = winnerMatch[1].toLowerCase() as 'gemini' | 'codex';

  // REASONING: runs from marker to next anchored HARDENING section or EOS.
  // Lookahead on HARDENING: captures any inline value (e.g. "HARDENING: none"),
  // not just standalone lines, so prose that contains "HARDENING:" mid-sentence
  // still requires it to be at the start of a line before truncating.
  const reasoningMatch = clean.match(/^\s*REASONING:\s*([\s\S]*?)(?=^\s*HARDENING:\s|$(?![\s\S]))/im);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

  // HARDENING: runs from its marker to the next known section keyword or EOS.
  // Non-greedy so trailing prose / section order variations don't bleed in.
  const hardeningMatch = clean.match(/^\s*HARDENING:\s*([\s\S]*?)(?=^\s*WINNER:|^\s*REASONING:|$(?![\s\S]))/im);
  const hardeningNotes = hardeningMatch ? hardeningMatch[1].trim() : '';

  return { verdict, reasoning, hardeningNotes };
}

/**
 * Build the argv that runCodexImpl passes to the codex CLI. Extracted as a pure
 * helper so tests can verify the invocation shape without spawning the binary.
 *
 * Sandbox defaults to `workspace-write` — `danger-full-access` was unsafe
 * because linked git worktrees share the .git dir, remotes, and credentials
 * with the main cwd, so a destructive command in Codex (e.g. `git push --delete
 * origin main`) would damage the parent repo. Override via GSTACK_BUILD_CODEX_IMPL_SANDBOX
 * for environments where that risk is accepted. (Codex Phase 3 review, HIGH.)
 */
export function buildCodexImplArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  reasoning?: RoleReasoning;
  model?: string;
}): string[] {
  const codexPrompt = [
    `Read implementation instructions at ${opts.inputFilePath}.`,
    `Implement the changes autonomously using your edit tools.`,
    `Do NOT change test assertions — only make tests pass.`,
    `When done, write your output summary (files changed, tests run, what's verified) to ${opts.outputFilePath}.`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const sandbox =
    opts.sandbox ||
    (process.env.GSTACK_BUILD_CODEX_IMPL_SANDBOX as
      | 'read-only'
      | 'workspace-write'
      | 'danger-full-access'
      | undefined) ||
    'workspace-write';

  const reasoning = opts.reasoning || 'high';

  return [
    'exec',
    codexPrompt,
    ...(opts.model ? ['-m', opts.model] : []),
    '-s',
    sandbox,
    '-c',
    `model_reasoning_effort="${reasoning}"`,
    '-C',
    opts.cwd,
  ];
}

/**
 * Run the Codex implementation pass for one half of a dual-impl tournament.
 * Mirrors runGemini's structure: file-path I/O, captured output, single retry
 * on timeout. Default sandbox is workspace-write because git worktrees share
 * .git/remotes with the parent repo — danger-full-access would allow Codex to
 * push or delete remote branches. Override via GSTACK_BUILD_CODEX_IMPL_SANDBOX.
 */
export async function runCodexImpl(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** The worktree cwd Codex should operate in (e.g. /tmp/gstack-dual-.../codex). */
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
  reasoning?: RoleReasoning;
  model?: string;
  /** Optional prefix for log filenames — used by fix-loop passes to avoid overwriting the initial impl log. */
  logPrefix?: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const argv = buildCodexImplArgv(opts);

  const logName = opts.logPrefix ?? 'codex-impl';
  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-${logName}-${opts.iteration}.log`
  );

  let result = await spawnCaptured({
    bin: CODEX_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: CODEX_TIMEOUT_MS,
    logPath,
    closeStdin: true,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-${logName}-${opts.iteration}-retry.log`
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

const JUDGE_TIMEOUT_MS = envNumberOrDefault('GSTACK_BUILD_JUDGE_TIMEOUT', BUILD_DEFAULTS.timeoutsMs.judge);

/**
 * Run the configured Claude judge. Caller writes the full judge prompt
 * (task + tests + both diffs + both test results) to inputFilePath BEFORE calling.
 * The judge reads it, picks a winner, and writes verdict to outputFilePath.
 *
 * Caller should call parseJudgeVerdict on the returned result.stdout to extract
 * { verdict, reasoning }.
 */
export async function runJudge(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** Main cwd (judge is read-only — doesn't matter much, but stay in main). */
  cwd: string;
  slug: string;
  phaseNumber: string;
  model?: string;
  reasoning?: RoleReasoning;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shellPrompt = [
    `Use ${opts.reasoning || 'xhigh'} thinking.`,
    `Read judge prompt at ${opts.inputFilePath}.`,
    `Pick the better of the two implementations described inside.`,
    `Write your verdict to ${opts.outputFilePath} in this exact format:`,
    `WINNER: gemini|codex`,
    `REASONING: <one paragraph, concrete reasons>`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const argv = ['--model', opts.model || process.env.GSTACK_BUILD_JUDGE_MODEL || BUILD_DEFAULTS.roles.judge.model, '-p', shellPrompt];

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-judge.log`
  );

  let result = await spawnCaptured({
    bin: CLAUDE_BIN,
    argv,
    cwd: opts.cwd,
    timeoutMs: JUDGE_TIMEOUT_MS,
    logPath,
    closeStdin: false,
  });

  if (result.timedOut) {
    const retryLog = path.join(
      logDir(opts.slug),
      `phase-${opts.phaseNumber}-judge-retry.log`
    );
    const retryResult = await spawnCaptured({
      bin: CLAUDE_BIN,
      argv,
      cwd: opts.cwd,
      timeoutMs: JUDGE_TIMEOUT_MS,
      logPath: retryLog,
      closeStdin: false,
    });
    retryResult.retries = 1;
    return mergeOutputFile(retryResult, opts.outputFilePath, { emptyFileIsError: true });
  }
  return mergeOutputFile(result, opts.outputFilePath, { emptyFileIsError: true });
}
