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

/**
 * Detect plan-mode's native "ready to execute" confirmation. Tests both the
 * spaced and whitespace-collapsed forms because stripAnsi removes cursor-
 * positioning escapes (e.g. `\x1b[40C`) that render visually as spaces but
 * leave no character behind — so "ready to execute" can come through as
 * "readytoexecute" depending on the rendering path.
 */
export function isPlanReadyVisible(visible: string): boolean {
  if (/ready to execute|Would you like to proceed/i.test(visible)) return true;
  const collapsed = visible.replace(/\s+/g, '');
  return /readytoexecute|Wouldyouliketoproceed/i.test(collapsed);
}

/**
 * Detect the AUTO_DECIDE preamble template firing. The model prints
 * "Auto-decided <summary> → <option> (your preference). Change with /plan-tune."
 * when it short-circuits an AskUserQuestion via the question-tuning resolver
 * (`scripts/resolvers/question-tuning.ts:26`). The "Auto-decided ..." stem +
 * "(your preference)" tail combination is the tightest signal. Whitespace-
 * collapsed forms covered for the same TTY-rendering reason as
 * isPlanReadyVisible.
 */
export function isAutoDecidedVisible(visible: string): boolean {
  const stemMatch =
    /Auto-decided\b/i.test(visible) || /Auto-decided/i.test(visible.replace(/\s+/g, ''));
  if (!stemMatch) return false;
  if (/\(your preference\)/i.test(visible)) return true;
  return /\(yourpreference\)/i.test(visible.replace(/\s+/g, ''));
}

/**
 * Extract the plan file path from rendered TTY output. Plan-mode's native
 * confirmation includes one of these formats near the "Ready to execute?"
 * prompt:
 *   - `Plan saved to: /path/to/plan.md`
 *   - `Plan file: /path/to/plan.md`
 *   - `ctrl-g to edit in VSCode · ~/.claude/plans/<name>.md`
 *
 * stripAnsi may collapse whitespace via cursor-positioning escape removal,
 * so the regex tolerates variable spacing. Returns the resolved absolute
 * path with `~` expanded, or null if no path was rendered.
 *
 * Used by v1.22 AskUserQuestion-blocked regression tests to read the plan
 * file post-`plan_ready` and verify it contains a decisions section, which
 * distinguishes the legitimate fallback flow ("write decision brief into
 * plan file") from the silent-skip regression ("write a plan that didn't
 * surface any decisions").
 */
export function extractPlanFilePath(visible: string): string | null {
  // Patterns checked in order of specificity. Each captures the .md path.
  // The visible buffer may have stripAnsi-collapsed whitespace ("yet at" can
  // become "yetat"), so the captured path MUST start at a clear path-anchor
  // character: `~/`, `/Users/`, `/home/`, `/var/`, or `/tmp/`. Anchoring on
  // these prefixes prevents earlier non-whitespace characters from being
  // glommed into the path (real bug seen in the wild: `yetat/Users/...`).
  const PATH_ANCHOR = '(~\\/|\\/Users\\/|\\/home\\/|\\/var\\/|\\/tmp\\/|\\.\\/)';
  const patterns: RegExp[] = [
    new RegExp(`Plan\\s*saved\\s*to\\s*:?\\s*(${PATH_ANCHOR}\\S+\\.md)`, 'i'),
    new RegExp(`Plan\\s*file\\s*:?\\s*(${PATH_ANCHOR}\\S+\\.md)`, 'i'),
    new RegExp(`·\\s*(${PATH_ANCHOR}\\S*\\.claude\\/plans\\/\\S+\\.md)`, 'i'),
    // Fallback: any path-anchored reference to a .claude/plans .md file.
    new RegExp(`(${PATH_ANCHOR}\\S*\\.claude\\/plans\\/[\\w-]+\\.md)`, 'i'),
  ];
  for (const p of patterns) {
    const m = visible.match(p);
    if (m && m[1]) {
      let raw = m[1];
      // Strip trailing punctuation that some patterns may capture.
      raw = raw.replace(/\.+$/, '.md').replace(/\.md\.+$/, '.md');
      // Tilde expansion to absolute path.
      if (raw.startsWith('~')) {
        const home = process.env.HOME ?? '';
        raw = home + raw.slice(1);
      }
      return raw;
    }
  }
  return null;
}

/**
 * Read a plan file written by a plan-mode skill and verify it contains a
 * "decisions" section — evidence the skill surfaced the decisions it was
 * supposed to gate on, even when AskUserQuestion is --disallowedTools and
 * the model used the plan-file fallback flow instead of a numbered prompt.
 *
 * Accepts any `## Decisions ...` heading (the canonical form from the
 * preamble is `## Decisions to confirm`, but small variants like
 * `## Decisions needed` or `## Decisions for review` are common). Returns
 * false if the file is unreadable, missing, or has no decisions section.
 */
export function planFileHasDecisionsSection(planFile: string): boolean {
  try {
    const content = fs.readFileSync(planFile, 'utf-8');
    return /^##\s+Decisions\b/im.test(content);
  } catch {
    return false;
  }
}

/**
 * Recent-tail window (in bytes of stripped TTY text) used when classifying
 * permission dialogs. Old permission text persists in the visibleSince buffer
 * after the dialog is dismissed, so callers should pass `visible.slice(-TAIL_SCAN_BYTES)`
 * to avoid re-triggering on stale scrollback. Shared between `runPlanSkillObservation`
 * and `navigateToModeAskUserQuestion` in the routing test so tuning stays in sync.
 */
export const TAIL_SCAN_BYTES = 1500;

/**
 * Detect a Claude Code permission dialog. These render as a numbered
 * option list (so isNumberedOptionListVisible matches them) but they
 * are NOT a skill's AskUserQuestion — they're claude asking the user
 * whether to grant a tool/file permission. Tests that look for skill
 * AskUserQuestions must explicitly skip these.
 *
 * The English phrases below are stable across recent Claude Code
 * versions. The check is permissive on whitespace because TTY rendering
 * may wrap or reflow text.
 *
 * Co-trigger requirement: the bare phrase "Do you want to proceed?" is
 * generic enough that a skill question could legitimately use it
 * ("Do you want to proceed with HOLD SCOPE?"). To avoid mis-classifying
 * skill questions as permission dialogs, this phrase only counts when it
 * co-occurs with a file-edit context ("Edit to <path>" or "Write to <path>").
 * The standalone permission signatures (`requested permissions to`,
 * `allow all edits`, `always allow access to`, `Bash command requires permission`)
 * remain unconditional.
 */
export function isPermissionDialogVisible(visible: string): boolean {
  // Standalone signatures — high specificity, never appear in skill questions.
  if (/requested\s+permissions?\s+to/i.test(visible)) return true;
  // "Yes / Yes, allow all edits / No" shape — file-edit permission grants.
  if (/\ballow\s+all\s+edits\b/i.test(visible)) return true;
  // "Yes, and always allow access to <dir>" shape — workspace trust.
  if (/always\s+allow\s+access\s+to/i.test(visible)) return true;
  // Bash command permission prompts.
  if (/Bash\s+command\s+.*\s+requires\s+permission/i.test(visible)) return true;
  // "Do you want to proceed?" only counts as a permission dialog when paired
  // with a file-edit context. Skill questions can use the bare phrase.
  if (
    /Do\s+you\s+want\s+to\s+proceed\?/i.test(visible) &&
    /(Edit|Write)\s+to\s+\S+/i.test(visible)
  ) {
    return true;
  }
  return false;
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
  // Anchor on the LAST line containing `❯<spaces>1.` ANYWHERE on the line.
  // The /plan-*-review skill's box-layout AUQ uses TTY cursor-positioning
  // escapes that stripAnsi removes — leaving the cursor `❯1.` mid-line,
  // after dividers + header + prompt text on the same logical line. The
  // earlier `^\s*❯` anchor missed those entirely.
  let cursorLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/❯\s*1\./.test(lines[i] ?? '')) {
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

  // Cursor line: option 1 may be inline after box dividers + prompt header
  // (`...divider...header...❯1. label`). Use a non-anchored regex that
  // captures `❯N. label` from anywhere on the line through end-of-line.
  // Only used for the cursor line — subsequent options are parsed with the
  // start-of-line `optionRe`.
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorInlineRe = /❯\s*([1-9])\.\s*(\S.*?)\s*$/;
  const inlineMatch = cursorInlineRe.exec(cursorLine);
  if (inlineMatch) {
    const idx = Number(inlineMatch[1]);
    const label = (inlineMatch[2] ?? '').trim();
    if (label.length > 0 && !seenIndices.has(idx)) {
      seenIndices.add(idx);
      found.push({ index: idx, label });
    }
  } else {
    // No inline cursor match — fall back to start-of-line regex.
    const startMatch = optionRe.exec(cursorLine);
    if (startMatch) {
      const idx = Number(startMatch[1]);
      const label = (startMatch[2] ?? '').trim();
      if (label.length > 0 && !seenIndices.has(idx)) {
        seenIndices.add(idx);
        found.push({ index: idx, label });
      }
    }
  }

  // Subsequent lines: standard start-of-line option parsing.
  for (let i = cursorLineIdx + 1; i < lines.length; i++) {
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
 * The four /plan-ceo-review modes. Used by `skill-e2e-plan-ceo-mode-routing`
 * to detect Step 0F mode-selection AskUserQuestions, and by the upcoming
 * finding-count tests as a Step-0 boundary signal: an AUQ whose options
 * match this regex IS the mode pick (the last Step-0 question for plan-ceo).
 *
 * Lifted out of the mode-routing test so multiple PTY tests can share one
 * source of truth — when /plan-ceo-review adds a fifth mode, one regex updates
 * everywhere instead of drifting per-test.
 */
export const MODE_RE = /HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION/i;

/**
 * Stable signature for a parsed numbered-option list — used by tests to detect
 * "is this AUQ the same as the last poll, or has the agent advanced to a new
 * one?" Joins each option as `${index}:${label}` after sorting by index.
 *
 * Defensive sort means the signature is order-independent at the input level,
 * even though `parseNumberedOptions` already returns indices in ascending order.
 */
export function optionsSignature(
  opts: Array<{ index: number; label: string }>,
): string {
  return [...opts]
    .sort((a, b) => a.index - b.index)
    .map((o) => `${o.index}:${o.label}`)
    .join('|');
}

/**
 * Pure classifier for the visible TTY buffer. Decides which outcome the
 * polling loop should return on this tick, or `null` to keep polling.
 *
 * Extracted from `runPlanSkillObservation` so the unit suite can exercise
 * the actual branch order with synthetic input strings — a future contributor
 * who reorders the branches (e.g., moves the permission short-circuit) gets
 * caught by the unit tests, not by a stochastic E2E run.
 *
 * Live-state branches (process exited, "Unknown command") stay in the runner
 * since they need the session handle.
 */
export type ClassifyResult =
  | { outcome: 'silent_write'; summary: string }
  | { outcome: 'auto_decided'; summary: string }
  | { outcome: 'plan_ready'; summary: string }
  | { outcome: 'asked'; summary: string }
  | null;

const SANCTIONED_WRITE_SUBSTRINGS = [
  '.claude/plans',
  '.gstack/',
  '/.context/',
  'CHANGELOG.md',
  'TODOS.md',
];

export function classifyVisible(visible: string): ClassifyResult {
  // Silent-write detection: any Write/Edit tool render that targets a path
  // OUTSIDE the sanctioned dirs, AND no numbered prompt is currently on screen
  // (a numbered prompt means a permission/AskUserQuestion is gating the write,
  // not an actual silent write).
  const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(visible)) !== null) {
    const target = m[1] ?? '';
    const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) => target.includes(s));
    if (!sanctioned && !isNumberedOptionListVisible(visible)) {
      return {
        outcome: 'silent_write',
        summary: `Write/Edit to ${target} fired before any AskUserQuestion`,
      };
    }
  }
  // 'auto_decided' must beat 'plan_ready': when AUTO_DECIDE fires upstream of
  // plan-ready, both signals are visible by the time the polling loop checks.
  // The annotation text is the more informative outcome — it explains WHY
  // we got to plan_ready without surfacing the question.
  if (isAutoDecidedVisible(visible)) {
    return {
      outcome: 'auto_decided',
      summary:
        'skill auto-decided an AskUserQuestion via the AUTO_DECIDE preamble (the user never saw the prompt)',
    };
  }
  if (isPlanReadyVisible(visible)) {
    return {
      outcome: 'plan_ready',
      summary: 'skill ran end-to-end and emitted plan-mode "Ready to execute" confirmation',
    };
  }
  if (isNumberedOptionListVisible(visible)) {
    // Permission dialogs render numbered lists too. Skip them — the
    // bug we want to catch is "skill question never fired."
    if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      return null;
    }
    return {
      outcome: 'asked',
      summary: 'skill fired a numbered-option prompt (AskUserQuestion or routing-injection)',
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-finding AskUserQuestion count primitives (used by runPlanSkillCounting).
//
// These are pure helpers extracted up-front so the unit suite can exercise
// them deterministically before the live-PTY counter runs them. Each one is
// independently unit-testable against synthetic visible-buffer strings.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Captured identity of an AskUserQuestion — the rendered question text plus
 * its numbered options. Used by `runPlanSkillCounting` to dedupe redrawn
 * prompts and to feed `Step0BoundaryPredicate` callers.
 *
 * `signature` is the stable hash. Two AUQs with identical prompt + options
 * produce the same signature; differences in either field produce different
 * signatures. Critically: two AUQs with shared option labels (e.g. the
 * generic "A) Add to plan / B) Defer / C) Build now" menu) but different
 * question text get DIFFERENT signatures because the prompt is in the hash.
 */
export interface AskUserQuestionFingerprint {
  /** Stable hash combining normalized prompt text + options signature. */
  signature: string;
  /** First 240 chars of the rendered question prompt (post-normalization). */
  promptSnippet: string;
  /** Captured option labels, in index order. */
  options: Array<{ index: number; label: string }>;
  /** Wall-clock when first observed (ms since the helper started polling). */
  observedAtMs: number;
  /** True if observed BEFORE the Step-0 boundary fired. */
  preReview: boolean;
}

/**
 * Predicate fired against the AUQ we just answered (not the visible buffer).
 * Returns true if this AUQ's fingerprint marks the LAST Step-0 question for
 * its skill — all subsequent AUQs are review-phase findings.
 *
 * Event-based by design: matching against an answered AUQ's fingerprint
 * (prompt + options) is deterministic, whereas matching against later
 * rendered content (section headers, summary text) races with the agent's
 * output cadence. See plan §D14 for the rationale.
 */
export type Step0BoundaryPredicate = (
  answeredFingerprint: AskUserQuestionFingerprint,
) => boolean;

/**
 * Parse the rendered question prompt out of a visible TTY buffer. The prompt
 * is the 1–3 lines of text immediately ABOVE the latest `❯ 1.` cursor line —
 * not part of the option list, not the permission-dialog header.
 *
 * Returns the prompt normalized to a single-spaced 240-char snippet (strip
 * ANSI residue, collapse internal whitespace, trim) — short enough to use as
 * a hash key, long enough to disambiguate distinct questions.
 *
 * Returns "" when no prompt could be parsed (cursor not yet rendered, or
 * cursor is at the top of the buffer with no preceding text). Callers that
 * use the empty string as a fingerprint input should treat empty-prompt
 * AUQs as "wait one more poll" rather than fingerprinting them — otherwise
 * the same options + empty prompt across two distinct questions collide.
 */
export function parseQuestionPrompt(visible: string): string {
  // Tail-only — older prompts higher in the buffer are stale.
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;
  const lines = tail.split('\n');

  // Find the latest line containing `❯<spaces>1.` (matching parseNumberedOptions —
  // unanchored to handle the box-layout case where cursor is mid-line after
  // divider + header + prompt text on the same logical line).
  let cursorLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/❯\s*1\./.test(lines[i] ?? '')) {
      cursorLineIdx = i;
      break;
    }
  }
  if (cursorLineIdx < 0) return '';

  // Box-layout case: prompt text may be ON the cursor line, BEFORE `❯1.`.
  // Extract that prefix (after stripping leading box-drawing characters and
  // dividers) as the last piece of the prompt — appended after any prior
  // multi-line prompt text we walk up to find.
  const cursorLine = lines[cursorLineIdx] ?? '';
  let inlinePrompt = '';
  const cursorPos = cursorLine.search(/❯\s*1\./);
  if (cursorPos > 0) {
    inlinePrompt = cursorLine
      .slice(0, cursorPos)
      // Strip box-drawing chars + dividers + leading checkbox sigil.
      .replace(/^[─━┄┅┈┉─┌┐└┘├┤┬┴┼│┃☐□■\s]+/, '')
      .trim();
  }

  // Walk up at most 6 lines collecting prompt text. Stop at:
  //   - a blank line preceded by another blank line (paragraph break)
  //   - top of buffer
  //   - a line that itself starts with `N.` (we're inside an option list)
  const promptLines: string[] = [];
  let blankRun = 0;
  for (let i = cursorLineIdx - 1; i >= 0 && promptLines.length < 6; i--) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '') {
      blankRun += 1;
      if (blankRun >= 2 && promptLines.length > 0) break;
      continue;
    }
    blankRun = 0;
    // Stop if we hit what looks like a previous numbered list.
    if (/^[\s❯]*[1-9]\.\s+\S/.test(raw)) break;
    promptLines.unshift(trimmed);
  }

  const all = inlinePrompt.length > 0 ? [...promptLines, inlinePrompt] : promptLines;
  const joined = all.join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, 240);
}

/**
 * Stable hash for an AskUserQuestion's identity — combines normalized prompt
 * text with the options signature so two distinct questions with shared menu
 * labels (the generic A/B/C TODO-proposal menu, for instance) get different
 * fingerprints.
 *
 * Uses Bun's fast non-crypto hash since these strings are short and we only
 * need collision resistance against accidental TTY redraws, not adversaries.
 * Hex-encoded for diagnostic dumps.
 */
export function auqFingerprint(
  promptSnippet: string,
  opts: Array<{ index: number; label: string }>,
): string {
  const normalized = promptSnippet.replace(/\s+/g, ' ').trim();
  const sig = optionsSignature(opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Bun as any).hash(normalized + '||' + sig).toString(16);
}

/**
 * Detects when a plan-* skill has reached its Completion Summary / Review
 * Report — a terminal signal complementary to plan-mode's "Ready to execute"
 * confirmation. Each plan-review skill writes one of these phrasings near
 * the end of its run; matching any one is enough to stop counting.
 *
 * Best-effort: this is a content marker, not a deterministic event. Hard
 * ceiling (`reviewCountCeiling` in `runPlanSkillCounting`) is the reliable
 * stop signal; this regex is the "we're done, go gracefully" hint.
 */
export const COMPLETION_SUMMARY_RE =
  /(GSTACK REVIEW REPORT|## Completion [Ss]ummary|Status:\s*(clean|issues_open)|^VERDICT:)/m;

/**
 * Result of asserting that a plan file ends with `## GSTACK REVIEW REPORT`
 * as its last `## ` heading. `ok` is true iff the report is present AND no
 * other `## ` heading appears after it. Diagnostic fields are populated only
 * on failure to keep the success path cheap.
 */
export interface ReviewReportAtBottomResult {
  ok: boolean;
  reason?: string;
  trailingHeadings?: string[];
}

/**
 * Assert that `## GSTACK REVIEW REPORT` is the last `## ` heading in a plan
 * file's content. Pure string operation — no filesystem access. Used by the
 * finding-count E2E tests as a second assertion on each test's produced plan.
 *
 * The plan-mode skill template mandates the agent move/append the review
 * report so it's always the last `##` section. A regression where the agent
 * appends additional sections after the report (or skips it entirely) ships
 * silently today; this assertion catches both.
 */
export function assertReviewReportAtBottom(
  content: string,
): ReviewReportAtBottomResult {
  const re = /^## GSTACK REVIEW REPORT\s*$/m;
  const match = re.exec(content);
  if (!match) {
    return { ok: false, reason: 'no GSTACK REVIEW REPORT section' };
  }
  const after = content.slice(match.index + match[0].length);
  // Match any `## ` heading after the report. Reject `## ` followed by
  // newline-only (trailing-whitespace ## headers) to avoid false positives.
  const trailingHeadings = Array.from(
    after.matchAll(/^## \S.*$/gm),
  ).map((m) => m[0]);
  if (trailingHeadings.length > 0) {
    return {
      ok: false,
      reason: 'trailing ## heading(s) after GSTACK REVIEW REPORT',
      trailingHeadings,
    };
  }
  return { ok: true };
}

/**
 * Per-skill Step-0 boundary predicates. Each fires `true` when the answered
 * AUQ's fingerprint matches the LAST question of that skill's Step 0 phase.
 *
 * - `ceoStep0Boundary`: matches the mode-pick AUQ (options match `MODE_RE`).
 * - `engStep0Boundary`: matches the cross-project-learnings or scope-reduction
 *   AUQ that closes plan-eng-review's preamble.
 * - `designStep0Boundary`: matches plan-design-review's first dimension /
 *   posture AUQ.
 * - `devexStep0Boundary`: matches plan-devex-review's persona-selection AUQ.
 *
 * Predicates live alongside the helper so the unit suite can exercise each
 * against synthetic fingerprints (positive AND negative cases). Skill test
 * files import them directly.
 */
export const ceoStep0Boundary: Step0BoundaryPredicate = (fp) =>
  // Mode-pick path (Step 0F): one of HOLD SCOPE / SCOPE EXPANSION / etc.
  fp.options.some((o) => MODE_RE.test(o.label)) ||
  // Skip-interview path: scope-selection AUQ has "Skip interview and plan
  // immediately" — picking it bypasses the rest of Step 0 and routes
  // directly to review-phase. Boundary fires on the scope AUQ itself.
  fp.options.some((o) => /skip\s+interview|plan\s+immediately/i.test(o.label));

export const engStep0Boundary: Step0BoundaryPredicate = (fp) =>
  /scope reduction recommendation|cross[\s-]?project learnings/i.test(
    fp.promptSnippet,
  );

export const designStep0Boundary: Step0BoundaryPredicate = (fp) =>
  /design system|design posture|design score|first dimension/i.test(
    fp.promptSnippet,
  );

export const devexStep0Boundary: Step0BoundaryPredicate = (fp) =>
  /developer persona|target persona|persona selection|TTHW target/i.test(
    fp.promptSnippet,
  );

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
   *  - 'asked'        — skill emitted a numbered-option prompt (its Step 0
   *                     AskUserQuestion or the routing-injection prompt)
   *  - 'auto_decided' — visible TTY shows "Auto-decided ... → ..." (the
   *                     AUTO_DECIDE preamble template fired). Distinguishes
   *                     "the regression we're tracking" (auto-mode silently
   *                     auto-deciding questions the user wanted to see) from
   *                     "skill legitimately reached plan_ready". Detected
   *                     before plan_ready/silent_write so the auto-decide
   *                     evidence wins when both are present.
   *  - 'plan_ready'   — claude wrote a plan and emitted its native
   *                     "Ready to execute" confirmation
   *  - 'silent_write' — a Write/Edit landed BEFORE any prompt, to a path
   *                     outside the sanctioned plan/project directories
   *  - 'exited'       — claude process died before any of the above
   *  - 'timeout'      — none of the above within budget
   */
  outcome: 'asked' | 'auto_decided' | 'plan_ready' | 'silent_write' | 'exited' | 'timeout';
  /** Human-readable summary. */
  summary: string;
  /** Visible terminal text since the slash command was sent (last 2KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /**
   * Path to the plan file the skill wrote (if outcome is 'plan_ready').
   * Extracted from the visible TTY via {@link extractPlanFilePath}. Lets the
   * v1.22 AskUserQuestion-blocked regression tests verify the plan file
   * contains a `## Decisions to confirm` section under --disallowedTools —
   * a model that silently skips Step 0 reaches plan_ready WITHOUT writing
   * the section, and that's the regression we want to catch.
   */
  planFile?: string;
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
  /** Extra CLI args appended after --permission-mode. Used by the v1.22+
   *  AskUserQuestion-blocked regression tests to pass
   *  `['--disallowedTools', 'AskUserQuestion']` (the flag set Conductor
   *  uses to remove native AskUserQuestion in favor of its MCP variant).
   *  Plumbs straight through to launchClaudePty. */
  extraArgs?: string[];
  /**
   * Extra env merged into the spawned `claude` process. `launchClaudePty`
   * already supports this; exposing it here lets per-skill tests isolate
   * from local config that would mask the regression they're trying to
   * catch (e.g., `QUESTION_TUNING=true` causing AUTO_DECIDE to skip the
   * rendered AskUserQuestion list).
   */
  env?: Record<string, string>;
}): Promise<PlanSkillObservation> {
  const startedAt = Date.now();
  const session = await launchClaudePty({
    permissionMode: opts.inPlanMode === false ? null : 'plan',
    cwd: opts.cwd,
    timeoutMs: (opts.timeoutMs ?? 180_000) + 30_000,
    extraArgs: opts.extraArgs,
    env: opts.env,
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
      const classified = classifyVisible(visible);
      if (classified) {
        const obs: PlanSkillObservation = {
          ...classified,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
        };
        // For plan_ready outcomes, capture the plan file path from the full
        // visible buffer — tests under --disallowedTools verify the file's
        // contents to distinguish legitimate fallback flow from silent-skip.
        if (classified.outcome === 'plan_ready') {
          const planFile = extractPlanFilePath(visible);
          if (planFile) obs.planFile = planFile;
        }
        return obs;
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

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillCounting — drives a plan-* skill end-to-end through Step 0 then
// counts distinct review-phase AskUserQuestion fingerprints. The actual
// product asserted by the per-finding-count tests.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `runPlanSkillCounting` run. Includes both the count summary
 * (`step0Count`, `reviewCount`) and the full fingerprint list for diagnostic
 * dumps when an assertion fails.
 */
export interface PlanSkillCountObservation {
  outcome:
    | 'plan_ready'
    | 'completion_summary'
    | 'ceiling_reached'
    | 'silent_write'
    | 'exited'
    | 'timeout';
  summary: string;
  /** Visible terminal text at terminal time (last 3KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /** All distinct AskUserQuestions observed, in observation order. */
  fingerprints: AskUserQuestionFingerprint[];
  /** Count of fingerprints with `preReview === true`. */
  step0Count: number;
  /** Count of fingerprints with `preReview === false`. */
  reviewCount: number;
}

/**
 * Drive a plan-* skill in plan mode and count distinct review-phase
 * AskUserQuestions until a terminal signal fires.
 *
 * Flow:
 *   1. Boot PTY in plan mode (8s grace + auto-trust dialog).
 *   2. Send `slashCommand` alone. Sleep ~3s.
 *   3. Send `followUpPrompt` as a chat message — this is the plan content
 *      the skill reviews. Slash commands with trailing args are rejected by
 *      Claude Code unless the skill defines them, so the plan goes as a
 *      follow-up message (the proven pattern at
 *      skill-e2e-plan-design-with-ui.test.ts:57-71).
 *   4. Poll loop:
 *      - Skip permission dialogs (auto-grant with `defaultPick`).
 *      - On a new numbered-option list, parse prompt + options, build
 *        fingerprint via `auqFingerprint`. Empty-prompt parses are skipped
 *        and re-polled (avoids the empty-prompt collision documented in
 *        the auqFingerprint contract).
 *      - First time we see a fingerprint: push it, classify as Step 0 or
 *        review-phase based on `boundaryFired`, press `defaultPick` to
 *        advance.
 *      - After pressing, evaluate `isLastStep0AUQ(fingerprint)`. If true,
 *        all subsequent AUQs are review-phase.
 *      - Hard ceiling: if `reviewCount >= reviewCountCeiling`, return
 *        `ceiling_reached`. This bounds runaway counts; tests should set
 *        the ceiling above their assertion CEILING.
 *      - Soft terminals: `COMPLETION_SUMMARY_RE` match → `completion_summary`;
 *        plan-ready confirmation → `plan_ready`; silent write outside
 *        sanctioned dirs → `silent_write`; process exited → `exited`;
 *        wall clock exceeded → `timeout`.
 *
 * Boundary detection (D14): event-based, fired against the answered AUQ's
 * fingerprint, not against later rendered content. This avoids the race
 * where Step-0-final and Section-1-first AUQs straddle a section header
 * regex match.
 *
 * Fingerprint composition (D9): `auqFingerprint(prompt, options)` mixes
 * normalized prompt text with the options signature so distinct findings
 * with shared menu structure (the generic A/B/C TODO menu) get distinct
 * fingerprints.
 */
export async function runPlanSkillCounting(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command to send alone, e.g. '/plan-ceo-review'. No trailing args. */
  slashCommand: string;
  /** Plan content sent as a follow-up message ~3s after the slash command. */
  followUpPrompt: string;
  /** Per-skill predicate: which answered AUQ is the last Step-0 question. */
  isLastStep0AUQ: Step0BoundaryPredicate;
  /** Hard cap on review-phase count; helper returns when reached. Should be
   *  set ABOVE the test's assertion ceiling so the test sees the cap as a
   *  failure rather than a silent stop. */
  reviewCountCeiling: number;
  /** Numbered option to press by default. Defaults to 1 (recommended). */
  defaultPick?: number;
  /**
   * Optional override for the FIRST AUQ observed. Receives the fingerprint;
   * returns the option index to press. Subsequent AUQs always use defaultPick.
   *
   * Skill-specific routing helper: /plan-ceo-review's first AUQ asks "what
   * scope?" with options like "branch diff" / "describe inline" / "skip
   * interview". Pressing the default 1 routes to "branch diff" (the wrong
   * review target for a seeded fixture). firstAUQPick lets the test pick
   * "Skip interview" or "describe inline" so the agent reviews the
   * follow-up plan content the test sent, not the git diff.
   */
  firstAUQPick?: (fp: AskUserQuestionFingerprint) => number;
  /** Working directory. Default process.cwd() (repo cwd holds skill registry). */
  cwd?: string;
  /** Total budget for skill to reach a terminal outcome. Default 1_500_000 (25 min). */
  timeoutMs?: number;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
}): Promise<PlanSkillCountObservation> {
  const startedAt = Date.now();
  const defaultPick = opts.defaultPick ?? 1;
  const timeoutMs = opts.timeoutMs ?? 1_500_000;

  const session = await launchClaudePty({
    permissionMode: 'plan',
    cwd: opts.cwd,
    timeoutMs: timeoutMs + 60_000,
    env: opts.env,
  });

  const fingerprints: AskUserQuestionFingerprint[] = [];
  const seen = new Set<string>();
  let boundaryFired = false;
  let step0Count = 0;
  let reviewCount = 0;
  let isFirstAUQ = true;
  let lastSig = '';

  function snapshot(
    outcome: PlanSkillCountObservation['outcome'],
    summary: string,
    visible: string,
  ): PlanSkillCountObservation {
    return {
      outcome,
      summary,
      evidence: visible.slice(-3000),
      elapsedMs: Date.now() - startedAt,
      fingerprints,
      step0Count,
      reviewCount,
    };
  }

  try {
    await Bun.sleep(8000); // boot grace + auto-trust handler window
    const since = session.mark();
    session.send(`${opts.slashCommand}\r`);
    await Bun.sleep(3000);
    session.send(`${opts.followUpPrompt}\r`);

    const budgetStart = Date.now();
    while (Date.now() - budgetStart < timeoutMs) {
      await Bun.sleep(2000);
      const visible = session.visibleSince(since);

      // Process exited?
      if (session.exited()) {
        return snapshot(
          'exited',
          `claude exited (code=${session.exitCode()}) during counting (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }
      if (visible.includes('Unknown command:')) {
        return snapshot(
          'exited',
          `claude rejected ${opts.slashCommand} as unknown command (skill not registered in this cwd)`,
          visible,
        );
      }

      // Silent write detection — only fires if no numbered prompt is on
      // screen (otherwise the write is gated by a permission/AUQ).
      const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(visible)) !== null) {
        const target = m[1] ?? '';
        const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) =>
          target.includes(s),
        );
        if (!sanctioned && !isNumberedOptionListVisible(visible)) {
          return snapshot(
            'silent_write',
            `Write/Edit to ${target} fired before any AskUserQuestion`,
            visible,
          );
        }
      }

      // Soft terminal signals — check before AUQ processing so a final
      // completion-summary doesn't get misclassified as a bonus AUQ.
      if (COMPLETION_SUMMARY_RE.test(visible)) {
        return snapshot(
          'completion_summary',
          `skill emitted completion summary / verdict / status line (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }
      if (isPlanReadyVisible(visible)) {
        return snapshot(
          'plan_ready',
          `skill emitted plan-mode "Ready to execute" confirmation (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }

      // Numbered option list?
      if (!isNumberedOptionListVisible(visible)) continue;

      // Permission dialog? Auto-grant with defaultPick. Only act on the
      // recent tail to avoid re-triggering on stale dialogs in scrollback.
      if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
        session.send(`${defaultPick}\r`);
        await Bun.sleep(1500);
        continue;
      }

      // Parse the active AUQ. Skip same-redraw and empty-prompt cases.
      const options = parseNumberedOptions(visible);
      if (options.length < 2) continue;
      const sig = optionsSignature(options);
      if (sig === lastSig) continue;
      const promptSnippet = parseQuestionPrompt(visible);
      if (promptSnippet === '') continue; // not yet rendered, poll again
      lastSig = sig;

      const fingerprintHash = auqFingerprint(promptSnippet, options);
      if (seen.has(fingerprintHash)) {
        // Same content, already counted (TTY redrew with whitespace diff).
        continue;
      }
      seen.add(fingerprintHash);

      const fp: AskUserQuestionFingerprint = {
        signature: fingerprintHash,
        promptSnippet,
        options,
        observedAtMs: Date.now() - startedAt,
        preReview: !boundaryFired,
      };
      fingerprints.push(fp);
      if (boundaryFired) reviewCount += 1;
      else step0Count += 1;

      // Press to advance — first AUQ may use the override pick.
      const pickIdx =
        isFirstAUQ && opts.firstAUQPick ? opts.firstAUQPick(fp) : defaultPick;
      isFirstAUQ = false;
      session.send(`${pickIdx}\r`);

      // Evaluate boundary AFTER pressing — if THIS AUQ was the last Step 0
      // question, all subsequent AUQs go to reviewCount.
      if (!boundaryFired && opts.isLastStep0AUQ(fp)) {
        boundaryFired = true;
      }

      // Hard ceiling — runaway protection.
      if (reviewCount >= opts.reviewCountCeiling) {
        return snapshot(
          'ceiling_reached',
          `review-phase AUQ count reached ceiling (${opts.reviewCountCeiling})`,
          session.visibleSince(since),
        );
      }

      // Give the agent a beat to advance to the next state.
      await Bun.sleep(2000);
    }

    return snapshot(
      'timeout',
      `no terminal outcome within ${timeoutMs}ms (step0=${step0Count}, review=${reviewCount})`,
      session.visibleSince(since),
    );
  } finally {
    await session.close();
  }
}
