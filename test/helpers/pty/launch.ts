/**
 * Spawn `claude` in a real PTY (launchClaudePty) and the session handle. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as path from 'node:path';
import { resolveEvalModel } from '../../../lib/eval-model';
import { hermeticChildEnv, hermeticSkillsConfigDir, isHermeticEnabled } from '../hermetic-env';
import { withHermeticSkillRuntime } from '../hermetic-skill-runtime';
import { ownedNativeReviewStateRoot, type NativeReviewState } from '../plan-count-fixture';
import { createPendingExitRecorder } from '../plan-count-pending-exit';
import { createPendingQuestionRecorder } from '../plan-count-pending-question';
import { createFilePermissionRecorder } from '../plan-count-file-permission';
import { createAutoplanArtifactRecorder } from '../autoplan-artifact-recorder';
import { trustDialogInput } from '../pty-trust-dialog';
import { resolveClaudeBinary } from './binary';
import { createPtyScreen, idlePanelEnd, stripAnsi } from './screen';
import { appendSessionLedger, sessionKey } from '../session-ledger';

export interface ClaudePtyOptions {
  /** Register the repo's shipped skills in the child's user scope via
   * hermeticSkillsConfigDir(). Required by any test that types a /skill
   * slash command; without it hermetic claude rejects the command as
   * Unknown before any model turn. No effect when EVALS_HERMETIC=0. */
  seedSkills?: boolean;
  /**
   * Permission mode for the session.
   *  - 'plan' (default) — launches with --permission-mode plan
   *  - undefined — no --permission-mode flag at all (regular interactive)
   *  Other valid SDK modes ('default', 'acceptEdits', 'bypassPermissions',
   *  'auto', 'dontAsk') are passed through verbatim.
   */
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto' | 'dontAsk' | null;
  /** Extra args after the permission-mode flag. */
  extraArgs?: string[];
  /**
   * Model for the spawned interactive `claude`. Without an explicit --model the
   * child inherits the operator's ~/.claude/settings.json model (e.g.
   * the operator's own settings. Resolution mirrors session-runner.ts exactly:
   * opts.model ?? EVALS_MODEL ?? resolveEvalModel('capture').
   * Pushed BEFORE extraArgs so a test-supplied --model still wins (last flag wins).
   */
  model?: string;
  /** Terminal size. Default 120x40. Plan-mode UI lays out cleanly at this size. */
  cols?: number;
  rows?: number;
  /** Opt in when input targeting or completion needs the actual VT viewport. */
  observeScreen?: boolean;
  screenDeadlineAt?: number;
  /** Count-only pending identity; the hook never approves or changes native tools. */
  observePlanReady?: boolean;
  /** Pending AUQ identity for explicit navigation; never supplies answered coverage. */
  observeSetupQuestions?: boolean;
  /** Count-only native permission epochs for these exact disposable fixture/report paths. */
  observeFilePermissions?: readonly string[];
  /** Opt-in metadata only, limited to launcher-owned Autoplan review artifacts. */
  observeAutoplanArtifacts?: boolean;
  /** AP-only exact artifact Edit approvals; inactive until the owner starts its command. */
  approveAutoplanArtifactEdits?: boolean;
  /** Restrict an opted-in artifact approval hook to the owned Eng QA test plan. */
  engTestPlanArtifactOnly?: boolean;
  /** Explicit disposable state from createNativeReviewState; ambient env grants no ownership. */
  autoplanArtifactState?: NativeReviewState;
  /** Working directory. Default: process.cwd(). The repo cwd has the gstack
   *  skill registry and trusted-folder cookie, so most tests want this. */
  cwd?: string;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** Total run timeout (ms). Default 240000 (4 min). */
  timeoutMs?: number;
  /** Append this session's session-ledger row on close (default). runPtySession writes its own. */
  sessionLedger?: boolean;
}

export interface ClaudePtySession {
  /** Send raw bytes to PTY stdin. Newlines = "\r" in TTY world. */
  send(data: string): void;
  /** Send a key by name. Limited set used by these tests. */
  sendKey(key: 'Enter' | 'Up' | 'Down' | 'Esc' | 'Tab' | 'ShiftTab' | 'CtrlC'): void;
  /** Raw accumulated stdout (with ANSI). For forensics. */
  rawOutput(): string;
  /** Visible (ANSI-stripped) output for the entire session. For pattern matching. */
  visibleText(): string;
  /** Flush the opted-in terminal parser and return only its current viewport. */
  currentScreen(deadlineAt?: number): Promise<string>;
  /** Same decoded viewport with styles and input epoch for acknowledged paste. */
  currentScreenFrame(deadlineAt?: number): Promise<{ text: string; rawEnd: number;
    styledText: Array<{ row: number; start: number; text: string; dim: boolean; inverse: boolean }> }>;
  /**
   * Mark the current buffer position. Subsequent waitForAny / visibleSince
   * calls only look at output AFTER this mark. Use to scope assertions to
   * "after I sent the skill command" — avoids matching against the trust
   * dialog or boot banner residue. Returns a marker handle.
   */
  mark(): number;
  waitForOutput(since: number, timeoutMs: number): Promise<void>;
  /** Visible text since the most recent (or specific) mark. */
  visibleSince(marker?: number): string;
  /**
   * Wait for any of the supplied patterns to appear in visibleText. Resolves
   * with the first match. Throws on timeout (with last 2KB of visible text).
   * If `since` is supplied, only matches text after that mark.
   */
  waitForAny(
    patterns: Array<RegExp | string>,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }>;
  /** Convenience: single-pattern wait. */
  waitFor(
    pattern: RegExp | string,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void>;
  /** Process pid (for debug). */
  pid(): number | undefined;
  /** Whether the underlying process has exited. */
  exited(): boolean;
  /** Exit code, if known. */
  exitCode(): number | null;
  /**
   * The hermetic CLAUDE_CONFIG_DIR this session's claude was pointed at, or
   * null when EVALS_HERMETIC=0. Forensics: hermetic plan files live under
   * `<hermeticConfigDir>/plans/` (extractPlanFilePath still matches them —
   * the dir name ends in `/.claude` by contract).
   */
  hermeticConfigDir: string | null;
  /** Owned HOME/.gstack created by the seeded launcher; absent for caller overrides. */
  hermeticSkillStateRoot?: string;
  /** Owned pre-tool identity record, removed by close(). */
  pendingPlanReadyFile?: string;
  pendingQuestionFile?: string;
  pendingAutoplanArtifactFile?: string;
  /** The same validated root bound into the artifact hook, distinct from legacy HOME/.gstack. */
  autoplanArtifactStateRoot?: string;
  /** Legacy QA namespace from this launcher; native artifacts retain their own root. */
  autoplanEngTestPlanStateRoot?: string;
  startAutoplanArtifactEditApproval?: (commandStartedAt: number) => void;
  pendingFilePermissionFiles?: Array<{ expected: string; file: string }>;
  /**
   * Send SIGINT, then SIGKILL after 1s. Always safe to call multiple times.
   * Awaits process exit before resolving.
   */
  close(): Promise<void>;
}

/** Let a numbered menu apply its selection before confirming it. */
export async function selectPtyNumberedOption(
  session: Pick<ClaudePtySession, 'send'>,
  index: number,
): Promise<void> {
  if (!Number.isInteger(index) || index < 1 || index > 9) {
    throw new RangeError(`Invalid numbered option: ${index}`);
  }
  session.send(String(index));
  await Bun.sleep(500);
  session.send('\r');
}

/**
 * Spawn `claude --permission-mode plan` in a real PTY and return a session
 * handle. Caller is responsible for `await session.close()` to release the
 * subprocess and any timers.
 *
 * Auto-handles the workspace-trust dialog by selecting its explicit
 * affirmative option. Tests should NOT have to handle it themselves.
 */
export async function launchClaudePty(
  opts: ClaudePtyOptions = {},
): Promise<ClaudePtySession> {
  const claudePath = resolveClaudeBinary();
  if (!claudePath) {
    throw new Error(
      'claude binary not found on PATH. Install: https://docs.anthropic.com/en/docs/claude-code',
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const startedMono = performance.now();
  const startedAt = new Date().toISOString();
  const wallDeadline = startedMono + timeoutMs;
  const screenAbort = new AbortController();
  const launch = prepareLaunch(opts);

  // Construction must succeed before any CLI can be spawned.
  const screen = opts.observeScreen ? await createPtyScreen(cols, rows, {
    deadlineAt: Math.min(opts.screenDeadlineAt ?? wallDeadline, wallDeadline), signal: screenAbort.signal,
  }) : undefined;
  const pty: PtyProcess = { buffer: '', exited: false, closing: false, exitCode: null, outputWaiters: new Set(),
    screen, screenAbort, screenClosing: undefined, screenFailure: undefined, proc: undefined,
    exitedPromise: Promise.resolve(), wallDeadline, recorders: { pendingFiles: [] } };

  try {
    createLaunchRecorders(opts, cwd, launch, pty.recorders);
    pty.proc = (Bun as any).spawn([claudePath, ...launch.args], {
    terminal: {
      cols,
      rows,
      data(_t: unknown, chunk: Buffer) {
        const text = chunk.toString('utf-8');
        pty.buffer += text;
        if (screen && !pty.screenClosing) screen.write(text);
        notifyOutput(pty);
      },
    },
    cwd,
    env: launch.childEnv,
  }); } catch (error) { screenAbort.abort(error); disposeRecorders(pty.recorders); await disposeScreen(pty); throw error; }

  // Track exit so waitForAny can fail fast if claude crashes.
  if (pty.proc.exited && typeof pty.proc.exited.then === 'function') {
    pty.exitedPromise = pty.proc.exited
      .then((code: number | null) => {
        pty.exitCode = code;
        pty.exited = true;
        notifyOutput(pty);
        void disposeScreen(pty);
      })
      .catch(() => {
        pty.exited = true;
        notifyOutput(pty);
        void disposeScreen(pty);
      });
  }

  // Top-level timeout. If a test forgets to close, this kills it eventually.
  const wallTimer = setTimeout(() => {
    screenAbort.abort(new Error('PTY work deadline exceeded.'));
    try {
      pty.proc.kill?.('SIGKILL');
    } catch {
      /* ignore */
    }
  }, Math.max(0, wallDeadline - performance.now()));
  const trust = watchTrustDialog(pty);
  const handle = sessionHandle(pty, launch, wallTimer, trust);
  if (opts.sessionLedger === false) return handle;
  const close = handle.close;
  let recorded = false;
  return Object.assign(handle, { close: () => {
    if (!recorded) {
      recorded = true;
      const elapsed = performance.now() - startedMono;
      appendSessionLedger({ key: sessionKey('pty', undefined), runner: 'pty', started_at: startedAt, budget_ms: timeoutMs,
        elapsed_ms: elapsed, end: elapsed >= timeoutMs ? 'session_timeout' : 'completed', ...idlePanelEnd(handle.visibleText()), billed: false });
    }
    return close();
  } });
}

/** Arguments, child environment and owned state roots, decided before any spawn. */
interface LaunchSetup {
  args: string[];
  childEnv: Record<string, string>;
  hermetic: boolean;
  hermeticSkillStateRoot: string | undefined;
  autoplanArtifactStateRoot: string | undefined;
  autoplanEngTestPlanStateRoot: string | undefined;
}

function prepareLaunch(opts: ClaudePtyOptions): LaunchSetup {
  const args: string[] = [];
  // Pin the model so smokes don't inherit the operator's settings.json model
  // (see ClaudePtyOptions.model). Chain mirrors session-runner.ts so PTY and
  // `claude -p` evals always agree. Pushed before extraArgs => a test-supplied
  // --model wins (last flag wins).
  const model = opts.model ?? process.env.EVALS_MODEL ?? resolveEvalModel('capture');
  args.push('--model', model);
  // Permission mode: 'plan' default, null => omit flag entirely.
  const permissionMode = opts.permissionMode === undefined ? 'plan' : opts.permissionMode;
  if (permissionMode !== null) {
    args.push('--permission-mode', permissionMode);
  }
  // Hermetic children get zero MCP servers; gated on the same call-time
  // check as the env scrub so EVALS_HERMETIC=0 restores operator MCP too.
  // Before opts.extraArgs so a test could theoretically supply --mcp-config.
  const hermetic = isHermeticEnabled();
  if (hermetic) args.push('--strict-mcp-config');
  if (opts.extraArgs) args.push(...opts.extraArgs);

  // Hermetic by default (test/helpers/hermetic-env.ts): operator session
  // context never reaches the child; per-test opts.env merges last.
  let childEnv = hermeticChildEnv(opts.env);
  // The opted-in viewport emulates xterm; placeholder styles are required to
  // distinguish an empty suggestion from text the user has actually entered.
  if (opts.observeScreen) {
    childEnv.TERM = 'xterm-256color';
    childEnv.FORCE_COLOR = '1';
  }
  let hermeticSkillStateRoot: string | undefined;
  if (opts.seedSkills && hermetic && !opts.env?.CLAUDE_CONFIG_DIR) {
    childEnv.CLAUDE_CONFIG_DIR = hermeticSkillsConfigDir();
    if (opts.env?.HOME === undefined) {
      const runtime = withHermeticSkillRuntime(childEnv);
      childEnv = runtime.env;
      hermeticSkillStateRoot = runtime.stateRoot;
      // Runtime paths, registered skill assets, and ~/.gstack snapshots are
      // owned inputs outside the fixture cwd. The registry has separate real
      // directories, so its paths also need a grant beside the runtime symlink.
      // Explicit HOME/config/state and operator permission settings stay separate.
      args.push('--add-dir', runtime.root, '--add-dir', runtime.stateRoot,
        '--add-dir', path.join(childEnv.CLAUDE_CONFIG_DIR, 'skills'));
    }
  }

  let autoplanArtifactStateRoot = hermeticSkillStateRoot;
  if (opts.autoplanArtifactState !== undefined) {
    if (!opts.observeAutoplanArtifacts || !hermeticSkillStateRoot)
      throw new Error('Explicit Autoplan artifact state requires the seeded hermetic launcher');
    autoplanArtifactStateRoot = ownedNativeReviewStateRoot(opts.autoplanArtifactState, childEnv);
  }

  const autoplanEngTestPlanStateRoot = opts.approveAutoplanArtifactEdits && opts.autoplanArtifactState !== undefined
    ? hermeticSkillStateRoot : undefined;
  return { args, childEnv, hermetic, hermeticSkillStateRoot, autoplanArtifactStateRoot, autoplanEngTestPlanStateRoot };
}

interface LaunchRecorders {
  pendingExit?: ReturnType<typeof createPendingExitRecorder>;
  pendingQuestion?: ReturnType<typeof createPendingQuestionRecorder>;
  pendingArtifact?: ReturnType<typeof createAutoplanArtifactRecorder>;
  pendingFiles: Array<{ expected: string; recorder: NonNullable<ReturnType<typeof createFilePermissionRecorder>> }>;
}

/** Opted-in owned hook recorders, merged into one --settings argument. Each is
 * added to `recorders` as it is created, so a throw leaves the partial set for
 * the caller to dispose. */
function createLaunchRecorders(opts: ClaudePtyOptions, cwd: string, launch: LaunchSetup, recorders: LaunchRecorders): void {
  const { hermetic, childEnv, args, autoplanArtifactStateRoot } = launch;
  if (opts.observePlanReady && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
    recorders.pendingExit = createPendingExitRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR);
  }
  if (opts.observeSetupQuestions && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
    recorders.pendingQuestion = createPendingQuestionRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR);
  }
  if (opts.observeAutoplanArtifacts && hermetic && childEnv.CLAUDE_CONFIG_DIR && autoplanArtifactStateRoot) {
    recorders.pendingArtifact = createAutoplanArtifactRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR, autoplanArtifactStateRoot,
      opts.approveAutoplanArtifactEdits === true, opts.engTestPlanArtifactOnly === true, launch.autoplanEngTestPlanStateRoot);
  }
  if (opts.observeFilePermissions && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
    for (const expected of new Set(opts.observeFilePermissions)) {
      const recorder = createFilePermissionRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR, expected);
      if (recorder) recorders.pendingFiles.push({ expected, recorder });
    }
  }
  const { pendingExit, pendingQuestion, pendingArtifact, pendingFiles } = recorders;
  if (pendingFiles.length || pendingQuestion || pendingArtifact) {
    const hooks = pendingExit ? JSON.parse(pendingExit.settings).hooks : {};
    for (const recorder of [...pendingFiles.map(p => p.recorder), ...(pendingQuestion ? [pendingQuestion] : []), ...(pendingArtifact ? [pendingArtifact] : [])]) for (const [event, entries] of Object.entries(recorder.hooks))
      hooks[event] = [...(hooks[event] ?? []), ...entries];
    args.push('--settings', JSON.stringify({hooks}));
  } else if (pendingExit) args.push('--settings', pendingExit.settings);
}

function disposeRecorders(recorders: LaunchRecorders): void {
  recorders.pendingFiles.forEach(({ recorder }) => recorder.dispose());
  recorders.pendingExit?.dispose();
  recorders.pendingQuestion?.dispose(); recorders.pendingArtifact?.dispose();
}

/** One spawned CLI: output buffer, exit state, viewport and owned recorders. */
interface PtyProcess {
  buffer: string;
  exited: boolean;
  closing: boolean;
  exitCode: number | null;
  outputWaiters: Set<() => void>;
  screen: Awaited<ReturnType<typeof createPtyScreen>> | undefined;
  screenAbort: AbortController;
  screenClosing: Promise<void> | undefined;
  screenFailure: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc: any;
  exitedPromise: Promise<void>;
  wallDeadline: number;
  recorders: LaunchRecorders;
}

function notifyOutput(pty: PtyProcess): void { for (const done of pty.outputWaiters) done(); }

function disposeScreen(pty: PtyProcess): Promise<void> {
  return pty.screenClosing ??= (pty.screen?.dispose() ?? Promise.resolve()).catch(error => { pty.screenFailure = error; });
}

function writeTerminal(pty: PtyProcess, data: string): void {
  if (pty.exited) return;
  try {
    pty.proc.terminal?.write?.(data);
  } catch {
    /* ignore */
  }
}

/**
 * Auto-handle the workspace-trust dialog. Runs once during the boot
 * window, after both choices and the selected cursor are visible. Newer
 * unnumbered menus default to "No, exit", so "1\r" would reject trust.
 * The first paint can precede the input handler's readiness. Let startup
 * settle, then deliver navigation and confirmation as separate events.
 */
function watchTrustDialog(pty: PtyProcess) {
  let trustHandled = false;
  let trustVisibleAt: number | undefined;
  const inputTimers: ReturnType<typeof setTimeout>[] = [];
  const watcher = setInterval(() => {
    if (trustHandled || pty.exited) return;
    const input = trustDialogInput(pty.buffer);
    if (input !== null) {
      trustVisibleAt ??= Date.now();
      if (Date.now() - trustVisibleAt < 1_500) return;
      trustHandled = true;
      const keys = input.match(/\x1b\[[AB]|\r/g) ?? [];
      for (const [i, key] of keys.entries()) {
        inputTimers.push(setTimeout(() => {
          if (pty.exited) return;
          try { pty.proc.terminal?.write?.(key); } catch { /* ignore */ }
        }, i * 500));
      }
    }
  }, 200);
  // Stop the watcher after 15s — by then the dialog has either fired or
  // doesn't exist on this run.
  const stop = setTimeout(() => clearInterval(watcher), 15_000);
  return { watcher, stop, inputTimers };
}

async function waitForAnyOutput(
  pty: PtyProcess,
  patterns: Array<RegExp | string>,
  waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
): Promise<{ matched: RegExp | string; index: number }> {
  const wTimeout = waitOpts?.timeoutMs ?? 60_000;
  const poll = waitOpts?.pollMs ?? 250;
  const since = waitOpts?.since;
  const start = Date.now();
  while (Date.now() - start < wTimeout) {
    if (pty.exited) {
      throw new Error(
        `claude exited (code=${pty.exitCode}) before any pattern matched. ` +
          `Last visible:\n${stripAnsi(pty.buffer).slice(-2000)}`,
      );
    }
    const visible = since !== undefined ? stripAnsi(pty.buffer.slice(since)) : stripAnsi(pty.buffer);
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i]!;
      const matchIdx = typeof p === 'string' ? visible.indexOf(p) : visible.search(p);
      if (matchIdx >= 0) {
        return { matched: p, index: matchIdx };
      }
    }
    await Bun.sleep(poll);
  }
  throw new Error(
    `Timed out after ${wTimeout}ms waiting for any of: ${patterns
      .map((p) => (typeof p === 'string' ? JSON.stringify(p) : p.source))
      .join(', ')}\nLast visible (since=${since ?? 'all'}):\n${
      since !== undefined ? stripAnsi(pty.buffer.slice(since)).slice(-2000) : stripAnsi(pty.buffer).slice(-2000)
    }`,
  );
}

/** SIGINT, then SIGKILL, each bounded by a shared 3s cleanup deadline; then recorders and viewport. */
async function closePty(pty: PtyProcess, wallTimer: ReturnType<typeof setTimeout>,
  trust: ReturnType<typeof watchTrustDialog>): Promise<void> {
  pty.closing = true;
  notifyOutput(pty);
  const cleanupDeadline = Math.min(pty.wallDeadline, performance.now() + 3_000);
  const cleanupTimer = setTimeout(() => pty.screenAbort.abort(new Error('PTY cleanup deadline exceeded.')),
    Math.max(0, cleanupDeadline - performance.now()));
  clearTimeout(trust.stop);
  clearInterval(trust.watcher);
  for (const timer of trust.inputTimers) clearTimeout(timer);
  try {
    for (const [signal, timeout] of [['SIGINT', 2000], ['SIGKILL', 1000]] as const) {
      if (pty.exited) break;
      try {
        pty.proc.kill?.(signal);
      } catch {
        /* ignore */
      }
      let deadline!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([pty.exitedPromise, new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, Math.max(0, Math.min(timeout, cleanupDeadline - performance.now())));
        })]);
      } finally {
        clearTimeout(deadline);
      }
    }
    disposeRecorders(pty.recorders);
    await disposeScreen(pty);
    if (pty.screenFailure) throw pty.screenFailure;
  } finally {
    clearTimeout(cleanupTimer);
    clearTimeout(wallTimer);
    pty.proc.terminal?.close?.();
  }
}

function sessionHandle(pty: PtyProcess, launch: LaunchSetup, wallTimer: ReturnType<typeof setTimeout>,
  trust: ReturnType<typeof watchTrustDialog>): ClaudePtySession {
  const { screen } = pty;
  const { pendingExit, pendingQuestion, pendingArtifact, pendingFiles } = pty.recorders;
  const send = (data: string) => writeTerminal(pty, data);
  let lastMark = 0;
  let closePromise: Promise<void> | undefined;
  const readable = () => {
    if (!screen) throw new Error('PTY screen observation was not enabled for this session.');
    if (pty.screenFailure) throw new Error('PTY screen observation failed.', { cause: pty.screenFailure });
    return screen;
  };
  const waitForAny = (patterns: Array<RegExp | string>, waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number }) =>
    waitForAnyOutput(pty, patterns, waitOpts);
  return {
    send,
    sendKey: key => {
      const map: Record<string, string> = {
        Enter: '\r',
        Up: '\x1b[A',
        Down: '\x1b[B',
        Esc: '\x1b',
        Tab: '\t',
        ShiftTab: '\x1b[Z',
        CtrlC: '\x03',
      };
      send(map[key] ?? '');
    },
    rawOutput: () => pty.buffer,
    visibleText: () => stripAnsi(pty.buffer),
    currentScreen: async (deadlineAt?: number) => readable().read(deadlineAt),
    currentScreenFrame: async (deadlineAt?: number) => {
      const frame = await readable().readFrame(deadlineAt);
      return {text: frame.text, rawEnd: frame.inputOffset, styledText: frame.styledText};
    },
    mark: () => (lastMark = pty.buffer.length),
    waitForOutput: async (since: number, timeoutMs: number) => {
      if (pty.buffer.length > since || pty.exited || pty.closing) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          pty.outputWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        pty.outputWaiters.add(done);
      });
    },
    visibleSince: (marker?: number) => stripAnsi(pty.buffer.slice(marker ?? lastMark)),
    waitForAny,
    waitFor: async (pattern, waitOpts) => { await waitForAny([pattern], waitOpts); },
    pid: () => pty.proc.pid as number | undefined,
    exited: () => pty.exited,
    exitCode: () => pty.exitCode,
    hermeticConfigDir: launch.hermetic ? launch.childEnv.CLAUDE_CONFIG_DIR ?? null : null,
    hermeticSkillStateRoot: launch.hermeticSkillStateRoot,
    pendingPlanReadyFile: pendingExit?.file,
    pendingQuestionFile: pendingQuestion?.file,
    pendingAutoplanArtifactFile: pendingArtifact?.file,
    autoplanArtifactStateRoot: pendingArtifact ? launch.autoplanArtifactStateRoot : undefined,
    autoplanEngTestPlanStateRoot: pendingArtifact ? launch.autoplanEngTestPlanStateRoot : undefined,
    startAutoplanArtifactEditApproval: pendingArtifact?.startEditApproval,
    pendingFilePermissionFiles: pendingFiles.map(({ expected, recorder }) => ({ expected, file: recorder.file })),
    close: () => closePromise ??= closePty(pty, wallTimer, trust),
  };
}
