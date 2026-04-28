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
    if (fileContent.trim() === '') {
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
    timeoutMs: Number(process.env.GSTACK_BUILD_TEST_TIMEOUT) || 5 * 60_000,
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
 * Parse the Opus tournament judge's output for a verdict + reasoning.
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
} {
  const clean = stripAnsi(output || '');
  // Anchored: WINNER must be at start of line. Avoids false matches like
  // "I think the WINNER: gemini is better" embedded in narrative prose.
  const winnerMatch = clean.match(/^\s*WINNER:\s*(gemini|codex)\b/im);
  if (!winnerMatch) {
    return {
      verdict: null,
      reasoning: 'no anchored WINNER line found in judge output — caller must fail-closed',
    };
  }
  const verdict = winnerMatch[1].toLowerCase() as 'gemini' | 'codex';

  // REASONING runs from the anchored marker to end of input; trim whitespace.
  // Single multi-paragraph reasoning is fine — Opus prompt template asks for
  // one paragraph, but we accept anything until EOS.
  const reasoningMatch = clean.match(/^\s*REASONING:\s*([\s\S]*)$/im);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';
  return { verdict, reasoning };
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

  return [
    'exec',
    codexPrompt,
    '-s',
    sandbox,
    '-c',
    'model_reasoning_effort="high"',
    '-C',
    opts.cwd,
  ];
}

/**
 * Run the Codex implementation pass for one half of a dual-impl tournament.
 * Mirrors runGemini's structure: file-path I/O, captured output, single retry
 * on timeout. Each call expects to be running in an isolated git worktree so
 * danger-full-access is safe (changes can't leak to main cwd).
 */
export async function runCodexImpl(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** The worktree cwd Codex should operate in (e.g. /tmp/gstack-dual-.../codex). */
  cwd: string;
  slug: string;
  phaseNumber: string;
  iteration: number;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);
  const argv = buildCodexImplArgv(opts);

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-codex-impl-${opts.iteration}.log`
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
      `phase-${opts.phaseNumber}-codex-impl-${opts.iteration}-retry.log`
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

const JUDGE_TIMEOUT_MS = Number(process.env.GSTACK_BUILD_JUDGE_TIMEOUT) || 10 * 60_000;
const JUDGE_MODEL = process.env.GSTACK_BUILD_JUDGE_MODEL || 'claude-opus-4-7';

/**
 * Run Claude Opus as the tournament judge. Caller writes the full judge prompt
 * (task + tests + both diffs + both test results) to inputFilePath BEFORE calling.
 * Opus reads it, picks a winner, writes verdict to outputFilePath.
 *
 * Caller should call parseJudgeVerdict on the returned result.stdout to extract
 * { verdict, reasoning }.
 */
export async function runJudgeOpus(opts: {
  inputFilePath: string;
  outputFilePath: string;
  /** Main cwd (judge is read-only — doesn't matter much, but stay in main). */
  cwd: string;
  slug: string;
  phaseNumber: string;
}): Promise<SubAgentResult> {
  ensureLogDir(opts.slug);

  const shellPrompt = [
    `Read judge prompt at ${opts.inputFilePath}.`,
    `Pick the better of the two implementations described inside.`,
    `Write your verdict to ${opts.outputFilePath} in this exact format:`,
    `WINNER: gemini|codex`,
    `REASONING: <one paragraph, concrete reasons>`,
    `Return ONLY the output file path. No narrative.`,
  ].join(' ');

  const argv = ['--model', JUDGE_MODEL, '-p', shellPrompt];

  const logPath = path.join(
    logDir(opts.slug),
    `phase-${opts.phaseNumber}-judge-opus.log`
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
      `phase-${opts.phaseNumber}-judge-opus-retry.log`
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
    return mergeOutputFile(retryResult, opts.outputFilePath);
  }
  return mergeOutputFile(result, opts.outputFilePath);
}
