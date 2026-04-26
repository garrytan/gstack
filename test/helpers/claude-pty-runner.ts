/**
 * Real-PTY runner for Claude Code plan-mode E2E tests.
 *
 * Spawns the actual `claude` binary via `Bun.spawn({terminal:})`, drives
 * it through stdin/stdout, parses the rendered terminal frames, and exposes
 * primitives the 5 plan-mode tests need. Replaces the SDK-based
 * `runPlanModeSkillTest` from plan-mode-helpers.ts which never worked
 * because plan mode doesn't use the AskUserQuestion tool — it uses its
 * own TTY-rendered native confirmation UI.
 *
 * Why this exists: the SDK harness intercepts `canUseTool` for
 * `AskUserQuestion`. Claude in plan mode renders its "Ready to execute"
 * confirmation as a native option list (1-4 numbered options) without
 * invoking the AskUserQuestion tool. The SDK never sees it. Real PTY
 * does — it shows up as text on screen with `❯` cursor markers.
 *
 * Architecture: pure Bun.spawn — no node-pty, no native modules, no chmod
 * fixes. Bun 1.3.10+ has built-in PTY support via the `terminal:` spawn
 * option. Pattern borrowed from cc-pty-import branch's terminal-agent.ts
 * (the WS/cookie/Origin scaffolding there is for the browser sidebar;
 * tests don't need it).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Strip ANSI escapes for pattern-matching against visible text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\d;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78=>]/g, '');
}

/** Find claude on PATH, with fallback locations. Mirrors terminal-agent.ts. */
export function resolveClaudeBinary(): string | null {
  const override = process.env.BROWSE_TERMINAL_BINARY;
  if (override && fs.existsSync(override)) return override;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const which = (Bun as any).which?.('claude');
  if (which) return which;
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

export interface ClaudePtyOptions {
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
  /** Terminal size. Default 120x40. Plan-mode UI lays out cleanly at this size. */
  cols?: number;
  rows?: number;
  /** Working directory. Default: process.cwd(). The repo cwd has the gstack
   *  skill registry and trusted-folder cookie, so most tests want this. */
  cwd?: string;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** Total run timeout (ms). Default 240000 (4 min). */
  timeoutMs?: number;
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
  /**
   * Mark the current buffer position. Subsequent waitForAny / visibleSince
   * calls only look at output AFTER this mark. Use to scope assertions to
   * "after I sent the skill command" — avoids matching against the trust
   * dialog or boot banner residue. Returns a marker handle.
   */
  mark(): number;
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
   * Send SIGINT, then SIGKILL after 1s. Always safe to call multiple times.
   * Awaits process exit before resolving.
   */
  close(): Promise<void>;
}

/** Detect the workspace-trust dialog rendering. */
export function isTrustDialogVisible(visible: string): boolean {
  // Phrase Claude Code prints. Stable across versions in this branch's range.
  return visible.includes('trust this folder');
}

/** Detect plan-mode's native "ready to execute" confirmation. */
export function isPlanReadyVisible(visible: string): boolean {
  return /ready to execute|Would you like to proceed/i.test(visible);
}

/**
 * Detect a Claude Code permission dialog. These render as a numbered
 * option list (so isNumberedOptionListVisible matches them) but they
 * are NOT a skill's AskUserQuestion — they're claude asking the user
 * whether to grant a tool/file permission. Tests that look for skill
 * AskUserQuestions must explicitly skip these.
 *
 * Both English phrases below are stable across recent Claude Code
 * versions. The check is permissive on whitespace because TTY rendering
 * may wrap or reflow text.
 */
export function isPermissionDialogVisible(visible: string): boolean {
  return (
    /requested\s+permissions?\s+to/i.test(visible) ||
    /Do\s+you\s+want\s+to\s+proceed\?/i.test(visible) ||
    // "Yes / Yes, allow all edits / No" shape rendered by Claude Code for
    // file-edit permission grants. The middle option's "allow all" phrase
    // is the unique signature.
    /\ballow\s+all\s+edits\b/i.test(visible) ||
    // "Yes, and always allow access to <dir>" shape (workspace trust).
    /always\s+allow\s+access\s+to/i.test(visible) ||
    // Bash command permission prompts.
    /Bash\s+command\s+.*\s+requires\s+permission/i.test(visible)
  );
}

/** Detect any AskUserQuestion-shaped numbered option list with cursor. */
export function isNumberedOptionListVisible(visible: string): boolean {
  // ❯ cursor + at least two numbered options 1-9.
  // Matches the trust dialog AND plan-ready prompt AND skill questions.
  // Tighter classification happens via scope (after-trust, after-skill-cmd, etc).
  //
  // Note on the `2\.` regex: the TTY uses cursor-positioning escape codes
  // (`\x1b[40C`) for whitespace which stripAnsi removes — collapsing
  // `text 2.` to `text2.`. A `\b2\.` word-boundary regex therefore fails
  // because `t-2` is a word-to-word transition. We use the weaker
  // `[^0-9]2\.` to require a non-digit before `2` (so we don't match
  // `12.0`) without requiring whitespace.
  return /❯\s*1\./.test(visible) && /(^|[^0-9])2\./.test(visible);
}

/**
 * Parse a rendered numbered-option list out of the visible TTY text.
 *
 * Looks for lines like `❯ 1. label` (cursor) or `  2. label` (no cursor)
 * and returns them in order. Used by tests that need to ROUTE on a specific
 * option label (e.g. answer "HOLD SCOPE" by sending its index + Enter)
 * without hard-coding positional indexes that drift when option order
 * changes between skill versions.
 *
 * Reads only the LAST 4KB of visible to avoid matching stale option lists
 * from earlier prompts in the session.
 *
 * Returns [] when no list is rendered. Otherwise returns indices in the
 * order they appear (1-based, matching what the user types). Labels are
 * trimmed but otherwise verbatim from the TTY (may include trailing
 * `(recommended)` markers, etc).
 */
export function parseNumberedOptions(
  visible: string,
): Array<{ index: number; label: string }> {
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;
  // Split on lines, look for `❯ N.` or `  N.` patterns. Up to N=9.
  // The `\s*` after `.` (not `\s+`) is required because stripAnsi removes
  // TTY cursor-positioning escapes that render as spaces, so a label that
  // visually reads "1. Option" can come through as "1.Option".
  const optionRe = /^[\s❯]*([1-9])\.\s*(\S.*?)\s*$/;
  // We anchor on the LATEST `❯ 1.` line in the buffer — the cursor marker
  // for the active AskUserQuestion. Older numbered lists (e.g., a granted permission
  // dialog still in scrollback) sit above it and must be ignored. Without
  // this, parseNumberedOptions returns stale options after the dialog is
  // dismissed.
  const lines = tail.split('\n');
  // Anchor on the LAST `❯ 1.` line (cursor is on option 1 of the active
  // AskUserQuestion). Greedy character classes don't help here — we need a literal
  // `❯` after optional leading whitespace.
  let cursorLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*❯\s*1\./.test(lines[i] ?? '')) {
      cursorLineIdx = i;
      break;
    }
  }
  // Fallback: if cursor isn't on option 1 (user pressed Down), find the
  // last `1.` line. Allow leading `  ` or `❯ ` prefixes; do NOT include `❯`
  // in the leading character class because greedy matching would eat the
  // sigil and prevent the literal-cursor anchor above from finding it.
  if (cursorLineIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(?:\s*|\s*❯\s+)1\./.test(lines[i] ?? '')) {
        cursorLineIdx = i;
        break;
      }
    }
  }
  if (cursorLineIdx < 0) return [];
  const found: Array<{ index: number; label: string }> = [];
  const seenIndices = new Set<number>();
  for (let i = cursorLineIdx; i < lines.length; i++) {
    const m = optionRe.exec(lines[i] ?? '');
    if (!m) continue;
    const idx = Number(m[1]);
    const label = (m[2] ?? '').trim();
    if (seenIndices.has(idx)) continue;
    if (label.length === 0) continue;
    seenIndices.add(idx);
    found.push({ index: idx, label });
  }
  // Only return if we found a sequential 1.., 2.., ... block (at least 2
  // consecutive options starting at 1). Otherwise it's noise (e.g. a
  // numbered list inside prose, like "1. Read the file").
  found.sort((a, b) => a.index - b.index);
  if (found.length < 2) return [];
  if (found[0]!.index !== 1) return [];
  for (let i = 1; i < found.length; i++) {
    if (found[i]!.index !== found[i - 1]!.index + 1) {
      // Truncate at the first gap.
      return found.slice(0, i);
    }
  }
  return found;
}

/**
 * Spawn `claude --permission-mode plan` in a real PTY and return a session
 * handle. Caller is responsible for `await session.close()` to release the
 * subprocess and any timers.
 *
 * Auto-handles the workspace-trust dialog (presses "1\r" if it appears
 * during the boot window). Tests should NOT have to handle it themselves.
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

  let buffer = '';
  let exited = false;
  let exitCodeCaptured: number | null = null;

  // Permission mode: 'plan' default, null => omit flag entirely.
  const permissionMode = opts.permissionMode === undefined ? 'plan' : opts.permissionMode;
  const args: string[] = [];
  if (permissionMode !== null) {
    args.push('--permission-mode', permissionMode);
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (Bun as any).spawn([claudePath, ...args], {
    terminal: {
      cols,
      rows,
      data(_t: unknown, chunk: Buffer) {
        buffer += chunk.toString('utf-8');
      },
    },
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  // Track exit so waitForAny can fail fast if claude crashes.
  let exitedPromise: Promise<void> = Promise.resolve();
  if (proc.exited && typeof proc.exited.then === 'function') {
    exitedPromise = proc.exited
      .then((code: number | null) => {
        exitCodeCaptured = code;
        exited = true;
      })
      .catch(() => {
        exited = true;
      });
  }

  // Top-level timeout. If a test forgets to close, this kills it eventually.
  const wallTimer = setTimeout(() => {
    try {
      proc.kill?.('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  // Auto-handle the workspace-trust dialog. Runs once during the boot
  // window; idempotent (only fires if the phrase is still on screen).
  let trustHandled = false;
  const trustWatcher = setInterval(() => {
    if (trustHandled || exited) return;
    const visible = stripAnsi(buffer);
    if (isTrustDialogVisible(visible)) {
      trustHandled = true;
      try {
        proc.terminal?.write?.('1\r');
      } catch {
        /* ignore */
      }
    }
  }, 200);
  // Stop the watcher after 15s — by then the dialog has either fired or
  // doesn't exist on this run.
  const trustWatcherStop = setTimeout(() => clearInterval(trustWatcher), 15_000);

  function send(data: string): void {
    if (exited) return;
    try {
      proc.terminal?.write?.(data);
    } catch {
      /* ignore */
    }
  }

  type Key = Parameters<ClaudePtySession['sendKey']>[0];
  function sendKey(key: Key): void {
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
  }

  let lastMark = 0;
  function mark(): number {
    lastMark = buffer.length;
    return lastMark;
  }
  function visibleSince(marker?: number): string {
    const offset = marker ?? lastMark;
    return stripAnsi(buffer.slice(offset));
  }

  async function waitForAny(
    patterns: Array<RegExp | string>,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }> {
    const wTimeout = waitOpts?.timeoutMs ?? 60_000;
    const poll = waitOpts?.pollMs ?? 250;
    const since = waitOpts?.since;
    const start = Date.now();
    while (Date.now() - start < wTimeout) {
      if (exited) {
        throw new Error(
          `claude exited (code=${exitCodeCaptured}) before any pattern matched. ` +
            `Last visible:\n${stripAnsi(buffer).slice(-2000)}`,
        );
      }
      const visible = since !== undefined ? stripAnsi(buffer.slice(since)) : stripAnsi(buffer);
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
        since !== undefined ? stripAnsi(buffer.slice(since)).slice(-2000) : stripAnsi(buffer).slice(-2000)
      }`,
    );
  }

  async function waitFor(
    pattern: RegExp | string,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void> {
    await waitForAny([pattern], waitOpts);
  }

  async function close(): Promise<void> {
    clearTimeout(wallTimer);
    clearTimeout(trustWatcherStop);
    clearInterval(trustWatcher);
    if (exited) return;
    try {
      proc.kill?.('SIGINT');
    } catch {
      /* ignore */
    }
    // Wait up to 2s for graceful exit.
    await Promise.race([exitedPromise, Bun.sleep(2000)]);
    if (!exited) {
      try {
        proc.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      await Promise.race([exitedPromise, Bun.sleep(1000)]);
    }
  }

  return {
    send,
    sendKey,
    rawOutput: () => buffer,
    visibleText: () => stripAnsi(buffer),
    mark,
    visibleSince,
    waitForAny,
    waitFor,
    pid: () => proc.pid as number | undefined,
    exited: () => exited,
    exitCode: () => exitCodeCaptured,
    close,
  };
}

/**
 * High-level: invoke a slash command and observe the response. Used by the
 * 5 plan-mode tests so each only has ~10 LOC of orchestration.
 *
 * The `expectations` object names the patterns the caller cares about.
 * Returns which one matched first (or throws on timeout).
 *
 * @example
 * const session = await launchClaudePty();
 * const result = await invokeAndObserve(session, '/plan-ceo-review', {
 *   askUserQuestion: /❯\s*1\./,
 *   planReady: /ready to execute/i,
 *   silentWrite: /⏺\s*Write\(/,
 *   silentEdit: /⏺\s*Edit\(/,
 *   exitedPlanMode: /Exiting plan mode/i,
 * });
 * await session.close();
 */
export async function invokeAndObserve(
  session: ClaudePtySession,
  slashCommand: string,
  expectations: Record<string, RegExp | string>,
  opts?: { boot_grace_ms?: number; timeoutMs?: number },
): Promise<{ matched: string; rawPattern: RegExp | string; visibleAtMatch: string }> {
  // Brief grace period so the trust-dialog auto-press has time to clear and
  // claude is back at the input prompt before we type the command.
  const boot = opts?.boot_grace_ms ?? 6000;
  await Bun.sleep(boot);

  // Mark buffer position. All pattern matching scopes to text AFTER this point,
  // so the trust-dialog residue and boot banner numbered options don't cause
  // false positives.
  const sinceMark = session.mark();

  // Type and submit.
  session.send(slashCommand + '\r');

  const patterns = Object.entries(expectations);
  const result = await session.waitForAny(
    patterns.map(([, p]) => p),
    { timeoutMs: opts?.timeoutMs ?? 240_000, since: sinceMark },
  );
  // Map back to the named key.
  const idx = patterns.findIndex(([, p]) => p === result.matched);
  const [name, rawPattern] = patterns[idx]!;
  return {
    matched: name,
    rawPattern,
    visibleAtMatch: session.visibleText(),
  };
}

// ---------------------------------------------------------------------------
// High-level skill-mode test contract
// ---------------------------------------------------------------------------

export interface PlanSkillObservation {
  /**
   * What happened first. One of:
   *  - 'asked'      — skill emitted a numbered-option prompt (its Step 0
   *                   AskUserQuestion or the routing-injection prompt)
   *  - 'plan_ready' — claude wrote a plan and emitted its native
   *                   "Ready to execute" confirmation
   *  - 'silent_write' — a Write/Edit landed BEFORE any prompt, to a path
   *                   outside the sanctioned plan/project directories
   *  - 'exited'     — claude process died before any of the above
   *  - 'timeout'    — none of the above within budget
   */
  outcome: 'asked' | 'plan_ready' | 'silent_write' | 'exited' | 'timeout';
  /** Human-readable summary. */
  summary: string;
  /** Visible terminal text since the slash command was sent (last 2KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
}

/**
 * The contract for "skill X invoked in plan mode behaves correctly."
 *
 * PASS: outcome is 'asked' or 'plan_ready'.
 *   - 'asked' = the skill is gating decisions on the user, as expected.
 *   - 'plan_ready' = the skill ran end-to-end, wrote a plan file, and
 *     surfaced claude's native confirmation. Some skills (like
 *     plan-design-review on a no-UI branch) legitimately reach plan_ready
 *     without firing AskUserQuestion because they short-circuit.
 *
 * FAIL: 'silent_write' or 'exited' or 'timeout'.
 *
 * This replaces the SDK-based runPlanModeSkillTest which never worked
 * because plan mode renders its native confirmation as TTY UI, not via
 * the AskUserQuestion tool — so canUseTool never fired and the assertion
 * counted zero questions.
 */
export async function runPlanSkillObservation(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. */
  skillName: string;
  /** Whether to launch in plan mode. Default true. The no-op regression
   *  test sets this false to verify skills work outside plan mode. */
  inPlanMode?: boolean;
  /** Working directory. Default process.cwd(). */
  cwd?: string;
  /** Total budget for skill to reach a terminal outcome. Default 180000. */
  timeoutMs?: number;
}): Promise<PlanSkillObservation> {
  const startedAt = Date.now();
  const session = await launchClaudePty({
    permissionMode: opts.inPlanMode === false ? null : 'plan',
    cwd: opts.cwd,
    timeoutMs: (opts.timeoutMs ?? 180_000) + 30_000,
  });

  try {
    // Boot grace + trust-dialog auto-handle.
    await Bun.sleep(8000);
    const since = session.mark();
    session.send(`/${opts.skillName}\r`);

    const budgetMs = opts.timeoutMs ?? 180_000;
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
      await Bun.sleep(2000);
      const visible = session.visibleSince(since);

      if (session.exited()) {
        return {
          outcome: 'exited',
          summary: `claude exited (code=${session.exitCode()}) before reaching a terminal outcome`,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (visible.includes('Unknown command:')) {
        return {
          outcome: 'exited',
          summary: `claude rejected /${opts.skillName} as unknown command (skill not registered in this cwd)`,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
        };
      }
      // Silent-write detection: any Write/Edit tool render that targets a
      // path OUTSIDE ~/.claude/plans, ~/.gstack/, or the active worktree's
      // .gstack/. Plan files and gbrain artifacts are sanctioned.
      const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(visible)) !== null) {
        const target = m[1] ?? '';
        const sanctioned =
          target.includes('.claude/plans') ||
          target.includes('.gstack/') ||
          target.includes('/.context/') ||
          target.includes('CHANGELOG.md') ||
          target.includes('TODOS.md');
        if (!sanctioned && !isNumberedOptionListVisible(visible)) {
          return {
            outcome: 'silent_write',
            summary: `Write/Edit to ${target} fired before any AskUserQuestion`,
            evidence: visible.slice(-2000),
            elapsedMs: Date.now() - startedAt,
          };
        }
      }
      if (isPlanReadyVisible(visible)) {
        return {
          outcome: 'plan_ready',
          summary: 'skill ran end-to-end and emitted plan-mode "Ready to execute" confirmation',
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (isNumberedOptionListVisible(visible)) {
        return {
          outcome: 'asked',
          summary: 'skill fired a numbered-option prompt (AskUserQuestion or routing-injection)',
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
        };
      }
    }

    return {
      outcome: 'timeout',
      summary: `no terminal outcome within ${budgetMs}ms`,
      evidence: session.visibleSince(since).slice(-2000),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await session.close();
  }
}
