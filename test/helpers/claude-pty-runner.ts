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

import { resolveEvalModel } from '../../lib/eval-model';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripVTControlCharacters } from 'node:util';
import { hermeticChildEnv, hermeticSkillsConfigDir, isHermeticEnabled } from './hermetic-env';
import { withHermeticSkillRuntime } from './hermetic-skill-runtime';
import { createPlanCountFixture } from './plan-count-fixture';
import { createPlanCountSnapshotWriter } from './plan-count-artifacts';
import { nativeSeededPlanSelection } from './plan-scope-selection';
import { readPlanFloorTarget, type PlanFloorTargetDelivery } from './plan-floor-target';
import { findNativeAutoDecision, type NativeAutoDecision } from './native-auto-decide';
import { readPlanCountTranscript, unresolvedPlanQuestionCalls, type NativePlanQuestionCall, type PlanCountTranscript, type NativePublicToolEvent } from './plan-count-transcript';
import { createPendingExitRecorder, withPendingExit, isCurrentPlanApprovalScreen } from './plan-count-pending-exit';
import { createPendingQuestionRecorder } from './plan-count-pending-question';
import { createFilePermissionRecorder, currentFilePermissionBinding, type FilePermissionEpoch } from './plan-count-file-permission';
import { createAutoplanArtifactRecorder } from './autoplan-artifact-recorder';
import { trustDialogInput } from './pty-trust-dialog';
import { createPtyScreen } from './pty-screen';
import { isRecordedDxManualNavigation } from './dx-selected-navigation';
import { engCacheWriterDecision } from './eng-cache-writer-decision';

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
  /** Count-only pending identity; the hook never approves or changes native tools. */
  observePlanReady?: boolean;
  /** Pending AUQ identity for explicit navigation; never supplies answered coverage. */
  observeSetupQuestions?: boolean;
  /** Count-only native permission epochs for these exact disposable fixture/report paths. */
  observeFilePermissions?: readonly string[];
  /** Opt-in metadata only, limited to launcher-owned Autoplan review artifacts. */
  observeAutoplanArtifacts?: boolean;
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
  /** Flush the opted-in terminal parser and return only its current viewport. */
  currentScreen(): Promise<string>;
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

/** Detect a complete, recognized workspace-trust menu. */
export function isTrustDialogVisible(visible: string): boolean {
  return trustDialogInput(visible) !== null;
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
  if (/readytoexecute|Wouldyouliketoproceed/i.test(collapsed)) return true;
  // Claude also renders a compact ExitPlanMode approval, without a plan
  // preview. Recognize its complete active menu, not prose mentioning exit.
  // This identifies an input gate only; native/report evidence is separate.
  return /(?:^|\n)\s*Exit plan mode\?\s*\n\s*Claude wants to exit plan mode\s*\n\s*❯\s*1\.\s*Yes, and switch to default \(ask each time\) for this session\s*\n\s*2\.\s*No\s*$/i.test(visible);
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
function isNativeEditPermissionVisible(visible: string): boolean {
  const text = visible.replace(/\r+\n?/g, '\n');
  const panel = [...text.matchAll(/^ {0,3}Edit file[ \t]*\n {0,3}([^\n]+)\n/gm)].at(-1);
  if (!panel) return false;
  const before = text.slice(0, panel.index);
  // Source excerpts and native review questions cannot authorize file input.
  if (/[☐□]/.test(before) || /(?:^|\n)[ \t]*(?:>|(?:example|quoted|source)[^:\n]*:)[^\n]*$/i.test(before.trimEnd())) return false;
  let fence: string | undefined;
  for (const line of before.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
  }
  if (fence) return false;
  const tail = text.slice(panel.index + panel[0].length);
  const prompt = [...tail.matchAll(/^ {0,3}Do you want to make this edit to ([^\n?]+)\?[ \t]*\n([\s\S]*)$/gm)].at(-1);
  if (!prompt || prompt[1]!.trim() !== panel[1]!.trim()) return false;
  return /^ {0,3}❯[ \t]*1\.[ \t]*Yes[ \t]*\n {0,3}2\.[ \t]*Yes, and switch to accept edits[^\n]*\n {0,3}3\.[ \t]*No[ \t]*\n\s*Esc to cancel [·•] Tab to amend\s*$/.test(prompt[2]!);
}

export function isPermissionDialogVisible(visible: string): boolean {
  // Cursor-positioning escapes supply spaces visually, but stripping those
  // escapes leaves labels such as "alwaysallowaccessto" in captured frames.
  const compact = visible.replace(/\s+/g, '');
  if (isNativeEditPermissionVisible(visible)) return true;
  if (/requestedpermissions?to|allowalledits|alwaysallowaccessto|Bashcommand.*requirespermission/i.test(compact)) {
    return true;
  }
  // Native Write/Edit confirmation captured during the design-count eval.
  // Require the native footer as well as the file question so an AUQ about
  // whether the plan should overwrite a file remains a real skill question.
  if (/Doyouwantto(?:overwrite|create|edit)\S+\?/i.test(compact) &&
      /Esctocancel[·•]Tabtoamend/i.test(compact)) {
    return true;
  }
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
/**
 * Strip terminal residue that survives ANSI-stripping and can interleave
 * with AUQ text: DEC cursor-visibility fragments (`[?25l` / `[?25h` — the ESC
 * byte is gone but the bracket sequence remains) and the spinner frames
 * rendered between them. Observed in plan-design-with-ui's failure buffer,
 * where `[?25l✻Sprouting…[?25h` fragments sat inside the option lines.
 */
export function stripPtyResidue(visible: string): string {
  return visible.replace(/\[\?25[lh]/g, '');
}

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
  const cleaned = stripPtyResidue(visible);
  return /❯\s*1\./.test(cleaned) && /(^|[^0-9])2\./.test(cleaned);
}

// ────────────────────────────────────────────────────────────────────────────
// LLM judge — "is the model waiting for user input, working, or hung?"
//
// Regex detectors (isNumberedOptionListVisible, isProseAUQVisible) are fast
// and deterministic but brittle to PTY rendering quirks (cursor-positioning
// escapes that collapse multi-line option lists onto a single logical line).
// When they miss, the polling loop times out at the full budget — even
// though the model is correctly surfacing a question via a format the regex
// can't reassemble.
//
// This LLM judge takes a TTY snapshot and answers a trichotomy:
//   - 'waiting'  — agent surfaced a question/options, sitting at input prompt
//   - 'working'  — agent is still generating (spinner, tool calls, "Musing")
//   - 'hung'     — agent stopped without surfacing anything (rare)
//
// Used by polling loops as a fallback after N seconds with no terminal
// classification. On 'waiting' verdict, return outcome='asked' early.
//
// Cost: ~$0.0005 per call using claude haiku 4.5. Cached by snapshot hash so
// identical TTY frames don't re-charge. All verdicts logged to
// ~/.gstack/analytics/pty-judge.jsonl for offline analysis.
// ────────────────────────────────────────────────────────────────────────────

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export interface PtyStateVerdict {
  state: 'waiting' | 'working' | 'hung' | 'unknown';
  reasoning: string;
  /** SHA-1 of the normalized snapshot input (for caching/dedup). */
  hash: string;
  /** Wall time (ms) the judge call took. */
  elapsedMs: number;
}

const PTY_VERDICT_CACHE = new Map<string, PtyStateVerdict>();

/**
 * Persist a verdict (or snapshot dump) to the analytics JSONL log.
 * Best-effort — failures (disk full, permission denied, etc.) are swallowed
 * so the harness never fails on logging.
 */
function logPtyJudge(record: Record<string, unknown>): void {
  try {
    const dir = `${process.env.HOME}/.gstack/analytics`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/pty-judge.jsonl`, JSON.stringify(record) + '\n');
  } catch {
    /* best-effort */
  }
}

/**
 * Snapshot dump for postmortem debugging when GSTACK_PTY_LOG=1.
 * Writes the last 4KB of visible TTY plus context to
 * ~/.gstack/analytics/pty-snapshots/<testName>-<elapsed>ms.txt.
 */
export function logPtySnapshot(visible: string, ctx: { testName: string; elapsedMs: number; tag?: string }): void {
  if (process.env.GSTACK_PTY_LOG !== '1') return;
  try {
    const dir = `${process.env.HOME}/.gstack/analytics/pty-snapshots`;
    fs.mkdirSync(dir, { recursive: true });
    const tag = ctx.tag ? `-${ctx.tag}` : '';
    const file = `${dir}/${ctx.testName}-${ctx.elapsedMs}ms${tag}.txt`;
    fs.writeFileSync(
      file,
      `# testName: ${ctx.testName}\n# elapsedMs: ${ctx.elapsedMs}\n# tag: ${ctx.tag ?? ''}\n# visible.length: ${visible.length}\n\n${visible.slice(-4096)}`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Ask Claude Haiku 4.5 to classify a TTY snapshot as waiting/working/hung.
 *
 * Implementation: spawns `claude -p --model claude-haiku-4-5` synchronously
 * with the prompt piped via stdin. Uses subscription auth (no API key env
 * required). 30-second timeout; returns 'unknown' on any failure mode
 * (timeout, malformed JSON, missing claude binary).
 *
 * Cache: identical snapshot hashes return the cached verdict without
 * re-calling. Cache lives in-process; resets between test runs.
 */
export function judgePtyState(
  visible: string,
  ctx?: { testName?: string },
): PtyStateVerdict {
  // Normalize: strip trailing whitespace lines + take last 4KB. Hash the
  // normalized form so spinner-frame-only diffs (which all look "working")
  // don't bust the cache and rack up cost.
  const tail = visible.slice(-4096).replace(/[ \t]+$/gm, '');
  const hash = createHash('sha1').update(tail).digest('hex').slice(0, 16);

  const cached = PTY_VERDICT_CACHE.get(hash);
  if (cached) return cached;

  const judgeStart = Date.now();
  const prompt = `You are reading a snapshot of a terminal where Claude Code is running in plan mode for an automated test. Your job: classify the agent's current state.

Pick exactly ONE:
- WAITING — agent surfaced a question or option list and is sitting at the input prompt waiting for user reply. Signs: numbered/lettered options visible (1./2./3. or A)/B)/C)), "Recommendation:" line, cursor at empty input prompt with no recent generation activity, OR a fully-rendered question + reply-instruction (e.g. "Reply with A, B, or C" / "Recommendation:") is visible.
- WORKING — agent is actively generating or running tools. Signs: spinner glyphs (✻ ✶ ✳ ✢ ✽), "Musing..." or "Churned for ..." text, recent tool-call blocks (Read/Edit/Bash/Grep), in-flight token output.

PRECEDENCE OVERRIDE: if a lettered/numbered option list (A)/B)/1./2.) AND a "Recommendation:" or "Reply with"/"Reply A" instruction are BOTH visible in this snapshot, classify WAITING even when spinner glyphs (✻ ✶ ✳ ✢ ✽) are still animating — Claude Code keeps the spinner up at an idle prose decision, so a spinner alongside a fully-rendered question + reply-instruction is a residual render artifact, not active generation.
- HUNG — agent has stopped without surfacing a question and without any spinner/work activity. Rare; usually means a crash.

Respond with strict JSON ONLY (no markdown fences, no prose):
{"state":"waiting","reasoning":"one short sentence"}

Terminal snapshot (last 4KB):
\`\`\`
${tail}
\`\`\``;

  let verdict: PtyStateVerdict = {
    state: 'unknown',
    reasoning: 'judge call did not complete',
    hash,
    elapsedMs: 0,
  };

  try {
    // Use the same binary resolution as every PTY launch in this file —
    // judgePtyState previously hardcoded bare 'claude' three definitions
    // below resolveClaudeBinary(), breaking under hermetic PATHs.
    const result = nodeSpawnSync(
      resolveClaudeBinary() ?? 'claude',
      ['-p', '--model', resolveEvalModel('warmup'), '--max-turns', '1'],
      {
        input: prompt,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        encoding: 'utf-8',
      },
    );
    const elapsedMs = Date.now() - judgeStart;
    if (result.status === 0 && result.stdout) {
      // Pull the first {...} JSON object out of stdout. Haiku occasionally
      // wraps in ```json ...``` despite the prompt; tolerate that.
      const match = result.stdout.match(/\{[\s\S]*?"state"[\s\S]*?\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          const state = ['waiting', 'working', 'hung'].includes(parsed.state)
            ? (parsed.state as 'waiting' | 'working' | 'hung')
            : 'unknown';
          verdict = {
            state,
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
            hash,
            elapsedMs,
          };
        } catch {
          verdict = { state: 'unknown', reasoning: 'malformed JSON', hash, elapsedMs };
        }
      } else {
        verdict = { state: 'unknown', reasoning: 'no JSON in response', hash, elapsedMs };
      }
    } else {
      verdict = {
        state: 'unknown',
        reasoning: `claude exited ${result.status} (${(result.stderr ?? '').slice(0, 80)})`,
        hash,
        elapsedMs,
      };
    }
  } catch (err) {
    verdict = {
      state: 'unknown',
      reasoning: `judge spawn failed: ${(err as Error).message}`.slice(0, 200),
      hash,
      elapsedMs: Date.now() - judgeStart,
    };
  }

  PTY_VERDICT_CACHE.set(hash, verdict);
  logPtyJudge({
    ts: new Date().toISOString(),
    testName: ctx?.testName ?? 'unknown',
    state: verdict.state,
    reasoning: verdict.reasoning,
    hash: verdict.hash,
    judgeMs: verdict.elapsedMs,
  });
  return verdict;
}

/**
 * Detect a prose-rendered AskUserQuestion in plan mode.
 *
 * Plan-mode AUQs sometimes render as visible model output rather than via
 * the native numbered-prompt UI — e.g., when --disallowedTools AskUserQuestion
 * is set and no MCP variant is callable, the model surfaces the question as
 * lettered or numbered options in plain text. isNumberedOptionListVisible
 * doesn't catch these because the `❯` cursor sits on the empty input prompt,
 * not on option 1.
 *
 * Detection patterns:
 *   - 2+ distinct lettered options (A) B) C) D)) at line starts — typical
 *     for plan-eng / plan-design / plan-devex prose AUQ
 *   - 3+ distinct numbered options (1. 2. 3.) at line starts WITHOUT a
 *     `❯<spaces>1.` cursor — typical for autoplan / office-hours prose AUQ
 *   - 3+ markdown bold-bullet options (`- **label**`) following an
 *     interrogative line — office-hours renders its mode question this way
 *     (`> - **Building a startup**`), which has no letter/number marker
 *   - Pattern 4/5 (collapsed-form): a reply-instruction OR recommendation
 *     marker PLUS 2+ distinct A-D letter markers each punctuated by ) : or (
 *     anywhere in the tail. stripAnsi destroys the newlines + inter-word
 *     spaces that the line-anchored patterns above need, so a real prose AUQ
 *     arrives collapsed ("ReplywithA,B,orC", "A(recommended)", "-B:") and is
 *     invisible to Patterns 1-3. This is the dominant Shape-B render mode in
 *     the plan-design smoke + floor timeouts (verified against real run bytes).
 *
 * Used by classifyVisible and runPlanSkillFloorCheck to return outcome='asked'
 * (or auq_observed) instead of letting the harness time out when the model
 * is correctly surfacing the question and waiting for user input via prose.
 *
 * The 4KB tail window avoids matching stale options from earlier prompts in
 * scrollback. Permission dialogs are filtered out by the caller (see
 * isPermissionDialogVisible callers in classifyVisible).
 */
export function isProseAUQVisible(visible: string): boolean {
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;

  // Pattern 1: 2+ distinct lettered options at line starts. Allow leading
  // whitespace or `❯` cursor before the marker. PTY may collapse multiple
  // option lines onto one logical line via stripped cursor-positioning
  // escapes, but the NEWLINE before each option survives.
  const letteredRe = /(?:^|\n)[ \t❯]*([A-D])\)/g;
  const letteredHits = new Set<string>();
  let lm: RegExpExecArray | null;
  while ((lm = letteredRe.exec(tail)) !== null) {
    if (lm[1]) letteredHits.add(lm[1]);
  }
  if (letteredHits.size >= 2) return true;

  // Pattern 2: 2+ distinct numbered options at line starts, AND no
  // `❯<spaces>1.` cursor IN THE RECENT TAIL (not the full buffer — a
  // trust-dialog `❯ 1. Yes` at boot is in scrollback forever and
  // would otherwise suppress this path for the rest of the run).
  // The native-UI deferral only applies when the cursor list is
  // currently rendered, not historically.
  //
  // Threshold 2 (matching the lettered branch): the tail is a 4KB window,
  // and by the time the polling loop sees it, the model may have emitted
  // option 1 several KB earlier and only 2/3/4 remain in tail. False
  // positives on prose ("First, x. Second, y.") are extremely rare given
  // the line-start anchor + the no-cursor gate.
  if (/❯\s*1\./.test(tail)) return false;
  const numberedRe = /(?:^|\n)[ \t❯]*([1-9])\./g;
  const numberedHits = new Set<string>();
  let nm: RegExpExecArray | null;
  while ((nm = numberedRe.exec(tail)) !== null) {
    if (nm[1]) numberedHits.add(nm[1]);
  }
  if (numberedHits.size >= 2) return true;

  // Pattern 3: markdown bold-bullet option list. office-hours renders its
  // mode question as `> - **Building a startup**` lines under
  // --disallowedTools — no letter/number marker, so Patterns 1-2 miss it,
  // and the model keeps a spinner up so the Haiku judge scores it 'working'
  // and the run times out despite the question being on screen.
  // Require both: an interrogative line (the question stem ends in '?') AND
  // 3+ bold-bullet markers. The bold (`- **`) requirement is what separates
  // an option list from incidental prose bullets; the line anchor is dropped
  // because stripAnsi can collapse option lines (see Pattern 1 note), so we
  // count markers anywhere in the tail. The `❯ 1.` cursor gate above already
  // excludes a live native list.
  if (/\?/.test(tail)) {
    const boldBulletHits = (tail.match(/[-*•]\s+\*\*/g) || []).length;
    if (boldBulletHits >= 3) return true;
  }

  // Pattern 4/5: collapsed-form prose AUQ. stripAnsi removes the
  // cursor-positioning escapes that render option newlines + inter-word
  // spaces, so "Reply with A, B, or C" arrives as "ReplywithA,B,orC" and
  // "A) ..." as "A(recommended)" / "-B:" — defeating every line-anchored or
  // ')'-anchored pattern above (Patterns 1-3 all return false on the real
  // plan-design smoke + floor timeout bytes). Detect via two INDEPENDENT
  // signals that must BOTH hold — the corroboration is what separates a real
  // AUQ from incidental report prose that happens to mention a recommendation:
  //   (1) a reply-instruction matched space-insensitively OR a recommendation
  //       marker, AND
  //   (2) 2+ distinct A-D letter markers each punctuated by ) : or ( anywhere
  //       in the tail.
  // A single 'B)' + the word "recommendation", or a comma-only collapsed
  // "ReplywithA,B,orC" with no )/:/( punctuation on the letters, both stay
  // false — the two-signal contract is pinned by unit tests.
  const replyOrRec =
    /reply\s*(?:with)?\s*[A-D]/i.test(tail) ||
    /reply(?:with)?[A-D]/i.test(tail.replace(/\s+/g, '')) ||
    /\bRecommendation\s*:/i.test(tail) ||
    /\(recommended\)/i.test(tail);
  if (replyOrRec) {
    const collapsedLetterRe = /\b([A-D])[):(]/g;
    const collapsedHits = new Set<string>();
    let cm: RegExpExecArray | null;
    while ((cm = collapsedLetterRe.exec(tail)) !== null) {
      if (cm[1]) collapsedHits.add(cm[1]);
    }
    if (collapsedHits.size >= 2) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Scope-gate render detectors (plan-eng-review / plan-design-review)
// ---------------------------------------------------------------------------
//
// Both anchor on the RENDER SHAPE, not bare keywords, so model narration
// about the gate ("normally I'd ask what should I review…") stays false.
// Matching is whitespace-squished + lowercased because stripAnsi collapses
// TTY cursor-positioning escapes unpredictably (the same failure mode the
// Pattern-4/5 collapsed-form handling above exists for).

/**
 * True when the scope-gate QUESTION is actually rendered: the question text
 * plus option A's body text. Option-body anchoring (not `A)`/`B)` markers)
 * because native AskUserQuestion renders NUMBERED options in the TTY while
 * the --disallowedTools prose fallback renders lettered ones — the option
 * body appears in both renders; narration rarely quotes both the question
 * and an option body.
 */
export function isScopeGateQuestionVisible(visible: string): boolean {
  const squished = visible.replace(/\s+/g, '').toLowerCase();
  return /whatshouldi(?:design-?)?review/.test(squished) && squished.includes('currentbranchdiff');
}

/**
 * True when the plan-mode auto-select announcement is rendered:
 * "Scope gate: plan mode — auto-selected B (reviewing <target>)."
 * Requires BOTH the announcement prefix and an auto-select-B token so
 * narration ("in plan mode I'd auto-select B") stays false. The token is
 * tense-tolerant (selected/selecting/selects) because the smokes assert
 * must-be-TRUE on it — a semantically-perfect paraphrase must not fail a
 * paid run — while the prefix stays exact so paraphrase narration without
 * the announcement frame stays false. A prefix immediately preceded by a
 * quote character is a QUOTATION (e.g. the model explaining why it is NOT
 * announcing), not a render — the announcement line itself never renders
 * quoted.
 */
export function isScopeGateAutoSelectVisible(visible: string): boolean {
  const squished = visible.replace(/\s+/g, '').toLowerCase();
  const QUOTES = ['"', "'", '`', '“', '‘'];
  const re = /scopegate:planmode/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(squished)) !== null) {
    const before = m.index > 0 ? squished[m.index - 1]! : '';
    if (QUOTES.includes(before)) continue; // quoted occurrence — narration, keep scanning
    if (/auto-?select(?:ed|ing|s)?b/.test(squished.slice(m.index))) return true;
  }
  return false;
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
  visible = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
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
  // (`...divider...header...❯1. label`) — and, when the PTY reflows the whole
  // AUQ onto ONE logical line, options 2..N sit on the SAME line after it
  // (observed with /plan-design-review's Step-0 scope gate: `❯1.Branch diff
  // ... 2.Plan or design doc ... 5.Chat about this ... Enter to select`).
  // Parse the cursor line as a STREAM: find every `N.` token (not preceded
  // by a digit, not followed by one — excludes "12." and "1.5"), require
  // ascending indices starting from the cursor's option, and take each
  // label as the text between successive number tokens.
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorStart = cursorLine.indexOf('❯');
  const cursorSegment = cursorStart >= 0 ? cursorLine.slice(cursorStart) : cursorLine;
  const tokenRe = /(?:^|[^0-9])([1-9])\.(?!\d)\s*/g;
  const tokens: Array<{ idx: number; labelStart: number; matchStart: number }> = [];
  // The known cursor anchor is unambiguously an option, even when its label
  // starts with a digit (captured: "❯1.1retryattempt..."). Keep the decimal
  // guard for number-like text inside the remaining labels.
  const firstToken = /^[\s❯]*1\.\s*/.exec(cursorSegment);
  if (firstToken) {
    tokens.push({ idx: 1, labelStart: firstToken[0].length, matchStart: 0 });
    tokenRe.lastIndex = firstToken[0].length;
  }
  for (let m = tokenRe.exec(cursorSegment); m !== null; m = tokenRe.exec(cursorSegment)) {
    tokens.push({
      idx: Number(m[1]),
      labelStart: m.index + m[0].length,
      matchStart: m.index === 0 ? 0 : m.index + 1, // skip the [^0-9] guard char
    });
  }
  // Keep only the ascending run that starts the sequence (1, 2, 3, ...);
  // stray numbers inside labels break ascension and end the run.
  let expected = 1;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.idx !== expected) continue;
    const next = tokens
      .slice(t + 1)
      .find((candidate) => candidate.idx === expected + 1 && candidate.matchStart > token.labelStart);
    const labelEnd = next ? next.matchStart : cursorSegment.length;
    const label = cursorSegment.slice(token.labelStart, labelEnd).trim();
    if (label.length > 0 && !seenIndices.has(token.idx)) {
      seenIndices.add(token.idx);
      found.push({ index: token.idx, label });
      expected += 1;
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
 * The four /plan-ceo-review modes, used by the finding-count tests as a
 * Step-0 boundary signal: an AUQ whose options
 * match this regex IS the mode pick (the last Step-0 question for plan-ceo).
 *
 * Lifted out of the mode-routing test so multiple PTY tests can share one
 * source of truth — when /plan-ceo-review adds a fifth mode, one regex updates
 * everywhere instead of drifting per-test.
 */
// Cursor-positioning escapes render inter-word spaces that stripAnsi removes.
// Recognize both the spaced labels and their captured HOLDSCOPE-style forms.
export const MODE_RE = /HOLD\s*SCOPE|SCOPE\s*EXPANSION|SELECTIVE\s*EXPANSION|SCOPE\s*REDUCTION/i;

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
  | { outcome: 'wrote_findings_before_asking'; summary: string }
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

/**
 * Find the position of the first AskUserQuestion-style numbered-option list
 * that is NOT a permission dialog. Returns -1 if none has rendered yet.
 *
 * Used by the strict-plan-writes detector (D4) to distinguish legitimate
 * post-AUQ plan writes from the transcript bug ("write findings to plan
 * before asking").
 */
function findFirstAuqRenderIndex(visible: string): number {
  const re = /❯\s*1\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(visible)) !== null) {
    // 200 bytes back + TAIL_SCAN_BYTES forward gives enough context for
    // isPermissionDialogVisible to recognize the typical permission UI.
    const surroundStart = Math.max(0, m.index - 200);
    const surroundEnd = Math.min(visible.length, m.index + TAIL_SCAN_BYTES);
    const surround = visible.slice(surroundStart, surroundEnd);
    if (!isPermissionDialogVisible(surround)) {
      return m.index;
    }
  }
  return -1;
}

export function classifyVisible(
  visible: string,
  opts?: {
    /**
     * When true, treat Write/Edit to `.claude/plans/*` BEFORE any
     * AskUserQuestion render as `wrote_findings_before_asking` rather than
     * letting the sanctioned-write list silently approve it. Used by tests
     * that seed a draft plan with guaranteed-finding-triggering complexity
     * (D3-B), where a pre-AUQ plan write is the precise transcript bug.
     * Default false — preserves existing behavior for unseeded smoke tests
     * where zero-findings → write plan → plan_ready is legitimate.
     */
    strictPlanWrites?: boolean;
    /** Seeded observations require the complete native approval panel in this owned viewport. */
    currentScreen?: string;
  },
): ClassifyResult {
  // Silent-write detection: any Write/Edit tool render that targets a path
  // OUTSIDE the sanctioned dirs, AND no numbered prompt is currently on screen
  // (a numbered prompt means a permission/AskUserQuestion is gating the write,
  // not an actual silent write).
  const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  const auqRenderIdx = opts?.strictPlanWrites ? findFirstAuqRenderIndex(visible) : -1;
  while ((m = writeRe.exec(visible)) !== null) {
    const target = m[1] ?? '';
    const writePos = m.index;
    const isPlanWrite = target.includes('.claude/plans');
    const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) => target.includes(s));

    // D4-B: when strictPlanWrites is on, plan writes that precede the first
    // AUQ render are flagged. Legitimate end-of-workflow plan writes happen
    // AFTER an AUQ has rendered (i.e., the user has been asked). The
    // transcript bug is a plan write WITHOUT any AUQ render preceding it.
    if (opts?.strictPlanWrites && isPlanWrite) {
      if (auqRenderIdx < 0 || writePos < auqRenderIdx) {
        return {
          outcome: 'wrote_findings_before_asking',
          summary: `Write/Edit to ${target} fired before any AskUserQuestion render`,
        };
      }
      // post-AUQ plan write — legitimate, fall through to other writes
      continue;
    }

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
    if (opts?.currentScreen === undefined || isCurrentPlanApprovalScreen(opts.currentScreen)) {
      return {
        outcome: 'plan_ready',
        summary: 'skill ran end-to-end and emitted plan-mode "Ready to execute" confirmation',
      };
    }
    // Historical TODO prose and stale approval menus cannot finish a seeded
    // review. The viewport may corroborate an existing question, never add one.
    const current = opts.currentScreen;
    // A streaming or mismatched native approval panel is not an AUQ either.
    if (/Claude (?:has written up a plan|wants to exit plan mode)|Exit plan mode\?/i.test(current) ||
        !(isNumberedOptionListVisible(visible) && isNumberedOptionListVisible(current) ||
          isProseAUQVisible(visible) && isProseAUQVisible(current))) return null;
    visible = current;
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
  // Prose-rendered AUQ: model surfaced the question as lettered or numbered
  // options in plain text (typical under --disallowedTools AskUserQuestion
  // when no MCP variant is callable). The model is waiting for user input
  // via the plan-mode input prompt rather than via the AUQ tool UI; this
  // is still a legitimate "asked" surface — semantically equivalent to a
  // tool-call AUQ from the test's perspective.
  if (isProseAUQVisible(visible)) {
    if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      return null;
    }
    return {
      outcome: 'asked',
      summary: 'skill rendered a prose-style AskUserQuestion (model waiting for user input)',
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
  /** True for setup classification; administrative calls are false plus their marker. */
  preReview: boolean;
  /** An administrative call is preserved but adds neither setup nor finding coverage. */
  administrative?: 'completion-handoff' | 'artifact-generation';
  /** Lossless source metadata for observed calls; UI-only fingerprints omit it. */
  nativeCall?: NativePlanQuestionCall;
  /** Active tab for UI answering; completed coverage still counts the whole call once. */
  nativeQuestionIndex?: number;
}

/** Full question text feeds routing/phase predicates before diagnostics truncate it. */
export function nativePlanCallFingerprint(call: NativePlanQuestionCall, observedAtMs: number, preReview: boolean): AskUserQuestionFingerprint {
  // An unanswered mode tab cannot establish the selected review mode. Keep
  // every question in nativeCall, but classify and summarize only the
  // actually answered questions once a native call has completed.
  const questions = call.answered ? call.questions.filter(q => call.answers?.[q.question]) : call.questions;
  return {
    signature: `${call.sessionId}:${call.toolUseId}`,
    promptSnippet: questions.map(q => `${q.header} ${q.question}`).join('\n\n'),
    options: questions.flatMap(q => q.options.map((o, i) => ({ index: i + 1, label: o.label }))),
    observedAtMs, preReview, nativeCall: call,
  };
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

/** First findings start review immediately; recognized setup stays setup even when its order varies. */
export function planCountQuestionPhase(
  fp: AskUserQuestionFingerprint,
  reviewStarted: boolean,
  isLastStep0AUQ: Step0BoundaryPredicate,
  isFirstReviewAUQ?: Step0BoundaryPredicate,
  isSetupAUQ?: Step0BoundaryPredicate,
  isCompletionHandoffAUQ?: Step0BoundaryPredicate,
  isArtifactGenerationAUQ?: Step0BoundaryPredicate,
): { preReview: boolean; reviewStarted: boolean; administrative?: 'completion-handoff' | 'artifact-generation' } {
  // A completion menu cannot start review or satisfy a finding floor, even
  // if its summary mentions defects that a first-finding predicate recognizes.
  if (isCompletionHandoffAUQ?.(fp)) return { preReview: false, reviewStarted, administrative: 'completion-handoff' };
  if (isArtifactGenerationAUQ?.(fp)) return { preReview: false, reviewStarted, administrative: 'artifact-generation' };
  const inReview = reviewStarted || Boolean(isFirstReviewAUQ?.(fp));
  return { preReview: Boolean(isSetupAUQ?.(fp)) || !inReview, reviewStarted: inReview || isLastStep0AUQ(fp) };
}

/**
 * Parse the rendered question prompt out of a visible TTY buffer. The prompt
 * starts at the active boxed question header when available, otherwise at
 * the lines immediately ABOVE the latest `❯ 1.` cursor line.
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
  visible = visible.replace(/\r+\n?/g, '\n');
  // Anchor context to the latest menu, not the moving end of output. After
  // an answer, spinner/prose output can push just the prompt's beginning
  // out of a trailing 4KB window while leaving its options visible. That
  // shortened same prompt must not acquire a new finding fingerprint.
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return '';
  const tail = visible.slice(Math.max(0, cursor.index - 4096), cursor.index + cursor[0].length);
  const lines = tail.split('\n');
  const cursorLineIdx = lines.length - 1;

  // Box-layout case: prompt text may be ON the cursor line, BEFORE `❯1.`.
  // Extract that prefix (after stripping leading box-drawing characters and
  // dividers) as the last piece of the prompt — appended after any prior
  // multi-line prompt text we walk up to find.
  const cursorLine = lines[cursorLineIdx] ?? '';
  let inlinePrompt = '';
  const cursorPos = cursorLine.search(/❯\s*1\./);
  if (cursorPos > 0) {
    const prefix = cursorLine.slice(0, cursorPos);
    const boxStart = Math.max(prefix.lastIndexOf('☐'), prefix.lastIndexOf('□'));
    inlinePrompt = prefix
      .slice(boxStart >= 0 ? boxStart : 0)
      // Strip box-drawing chars + dividers + leading checkbox sigil.
      .replace(/^[─━┄┅┈┉─┌┐└┘├┤┬┴┼│┃☐□■\s]+/, '')
      .trim();
    // A complete inline AUQ starts at its checkbox/header. Earlier lines
    // belong to the CLI's Planning chrome or prior output, not this prompt.
    // Including them can consume all 240 chars before the question starts.
    if (boxStart >= 0 && inlinePrompt.length > 0) {
      return inlinePrompt.replace(/\s+/g, ' ').slice(0, 240);
    }
  }

  // Native boxed AUQs can contain many paragraphs separated by a lone │.
  // Walking upward from the options stops at that border (or the six-line
  // limit) and loses the question's identity. Start at the latest header
  // inside the same fixed, cursor-anchored context window instead. Reject
  // earlier menus / Planning chrome so an old header cannot label a new
  // unboxed dialog after its question has been dismissed.
  const questionStart = [...tail.matchAll(/(?:^|\n)[\t │┃]*[☐□][\t ]*(?=\S)/g)].at(-1);
  if (questionStart) {
    const question = tail.slice(questionStart.index, tail.length - cursor[0].length);
    if (!/❯\s*[1-9]\./.test(question) && !/(?:^|\n)\s*Plan+ing\s*:/i.test(question)) {
      const prompt = question
        .replace(/^[\t ─━┄┅┈┉┌┐└┘├┤┬┴┼│┃☐□■]+/gm, '')
        .replace(/\s+/g, ' ').trim();
      if (prompt) return prompt.slice(0, 240);
    }
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
    if (/^[─━┄┅┈┉╌┌┐└┘├┤┬┴┼│┃]+$/.test(trimmed) ||
        /^Plan+ing\s*:/i.test(trimmed)) break;
    // Stop if we hit what looks like a previous numbered list.
    if (/^[\s❯]*[1-9]\.\s+\S/.test(raw)) break;
    promptLines.unshift(trimmed);
    if (/[☐□]/.test(trimmed)) break;
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

/** Permission and question capture inspect the same cursor-anchored window. */
function planCountPermissionMenu(visible: string): {
  normalized: string; cursorAt: number; prompt: string; menu: string;
} | null {
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const start = Math.max(0, normalized.length - 4096);
  const cursor = [...normalized.slice(start).matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  const cursorAt = start + cursor.index;
  const before = normalized.slice(start, cursorAt);
  const header = [...before.matchAll(/(?:^|\n)[\t │┃]*[☐□]([^\n│]*)/g)].at(-1);
  const menu = normalized.slice(cursorAt);
  // The native question panel has its own header and navigation footer.
  // Its actual finding may discuss file creation or permission policy.
  if (header && !/❯\s*[1-9]\./.test(before.slice(header.index)) &&
      /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(menu)) return null;
  // Anchor redraw identity to its question line; prior tool output and
  // the preceding menu's footer must not change a permission signature.
  const prompt = [...before.matchAll(/^[^\n]*\?[^\n]*$/gm)].at(-1)?.[0].trim()
    ?? parseQuestionPrompt(normalized);
  if (!prompt || !(isPermissionDialogVisible(prompt + '\n' + menu) || isNativeEditPermissionVisible(before + menu))) return null;
  return { normalized, cursorAt, prompt, menu };
}

/** A scrolled question must retain its entire visible suffix, choices and footer. */
function matchesClippedNativeQuestion(visible: string, call: NativePlanQuestionCall): boolean {
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = visible.slice(0, cursor.index);
  // This is the top of the actual viewport, not a selected historical
  // snippet. A header, preceding menu or blank top is not clipped identity.
  if (!before.split('\n')[0]?.trim() || /[☐□❯]/.test(before)) return false;
  const suffix = before.replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  const exact = (value: string) => value.replace(/\s+/g, '');
  const question = call.questions[0]!;
  const native = exact(question.question);
  const displayed = exact(suffix);
  // Require substantial positive question text, including all visible
  // pre-menu lines. Shared option labels or a generic short tail cannot
  // borrow an unrelated pending call's routing policy.
  if (suffix.split('\n').filter(line => line.trim()).length < 2 || displayed.length < 160 ||
      displayed.length > native.length || !native.endsWith(displayed)) return false;
  const menu = visible.slice(cursor.index);
  const footer = /Enter\s*to\s*select\s*·\s*(?:↑\/↓\s*to\s*navigate(?:\s*·\s*n\s*to\s*add\s*notes)?|Tab\/Arrow\s*keys\s*to\s*navigate)\s*·\s*Esc\s*to\s*cancel/i.exec(menu);
  if (!footer || !/^[\s│┃─━└┘]*$/.test(menu.slice(footer.index + footer[0].length))) return false;
  const options = parseNumberedOptions(visible);
  const offered = options.slice(0, question.options.length);
  const controls = options.slice(question.options.length);
  return offered.length === question.options.length && offered.every((option, index) =>
    option.index === index + 1 && exact(option.label) === exact(question.options[index]!.label)) &&
    controls.length <= 2 && controls.every((option, index) => option.index === question.options.length + index + 1 &&
      (index === 0 ? /^Typesomething\.?$/ : /^Chataboutthis$/).test(exact(option.label)));
}

/** Match a pending packet's displayed tab by its full question and offered choices. */
function nativePacketQuestionIndex(visible: string, call: NativePlanQuestionCall): number | null {
  if (call.failed || call.questions.length < 2) return null;
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const cursor = [...normalized.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  const before = normalized.slice(0, cursor.index);
  const bar = [...before.matchAll(/←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→/g)].at(-1);
  if (!bar) {
    const clipped = call.questions.flatMap((question, index) =>
      matchesClippedNativeQuestion(normalized, {...call, questions: [question]}) ? [index] : []);
    return clipped.length === 1 ? clipped[0]! : null;
  }
  if (!/Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(normalized.slice(cursor.index))) return null;
  const compact = (value: string) => value.replace(/^[\t │┃]+/gm, '').replace(/\s+/g, '');
  const body = compact(before.slice(bar.index + bar[0].length));
  const options = parseNumberedOptions(normalized);
  const matched = call.questions.flatMap((q, index) => body === compact(q.question) &&
    q.options.every((option, i) => options[i]?.index === i + 1 && compact(options[i]!.label) === compact(option.label)) ? [index] : []);
  return matched.length === 1 ? matched[0]! : null;
}

/** Notes can share the left option row while remaining aligned to the preview. */
function hasSidebarPreviewNotes(visible: string): boolean {
  // The footer and active pane establish the protocol. A notes phrase in an
  // option label alone is insufficient: require its aligned, complete box.
  if (!/(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)[\s\S]*❯\s*[1-9]\.[\s\S]*\nEnter\s+to\s+select\s*·\s*↑\/↓\s+to\s+navigate\s*·\s*n\s+to\s+add\s+notes\s*·\s*(?:Tab\s+to\s+switch\s+questions\s*·\s*)?Esc\s+to\s+cancel\s*$/i.test(visible)) return false;
  const header = [...visible.matchAll(/(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)/g)].at(-1);
  if (!header) return false;
  const lines = visible.slice(header.index).split('\n');
  return lines.some((line, notesIndex) => {
    if (!/[\t ]{2,}Notes: press n to add notes[\t ]*$/i.test(line)) return false;
    const column = line.indexOf('Notes:');
    // The hint may align with a wrapped continuation of the option label.
    let optionIndex = notesIndex;
    while (optionIndex > 0 && /^[\t ]{4,}\S[^│┌└]*$/.test(lines[optionIndex]!.slice(0, column).trimEnd())) optionIndex--;
    if (!/^[\t ]*(?:❯\s*)?[1-9]\.\s*\S[^│┌└]*$/.test(lines[optionIndex]!.slice(0, column).trimEnd())) return false;
    const before = lines.slice(0, notesIndex);
    const top = before.findLastIndex(row => /^┌─+┐[\t ]*$/.test(row.slice(column)));
    const bottom = before.findLastIndex(row => /^└─+┘[\t ]*$/.test(row.slice(column)));
    const width = top < 0 ? 0 : before[top]!.slice(column).trimEnd().length;
    return top >= 0 && bottom > top + 1 && before[bottom]!.slice(column).trimEnd().length === width &&
      before.slice(top + 1, bottom).every(row => /^│[^\n]*│[\t ]*$/.test(row.slice(column)) &&
        row.slice(column).trimEnd().length === width);
  });
}

/** Preview digits focus an option; ordinary native digits accept or toggle it. */
export function planCountQuestionInput(visible: string, fp: AskUserQuestionFingerprint, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 9) throw new RangeError(`Invalid numbered option: ${index}`);
  const native = fp.nativeCall?.questions[fp.nativeQuestionIndex ?? 0];
  // A numeric shortcut toggles one native checkbox; Enter toggles it again.
  if (native?.multiSelect || nativeCheckboxPanel(visible)) return String(index);
  // Claude Code's preview pane uses numbers only to move focus. Its Return
  // handler submits that focused option, including when native JSONL has not
  // flushed yet. Require the complete active pane, not a quoted notes hint.
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const preview = /(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)[\s\S]*❯\s*[1-9]\.[\s\S]*\n[\t │┃]*Notes:[^\n]*\n[\s\S]*\nEnter\s+to\s+select\s*·\s*↑\/↓\s+to\s+navigate\s*·\s*n\s+to\s+add\s+notes\s*·\s*(?:Tab\s+to\s+switch\s+questions\s*·\s*)?Esc\s+to\s+cancel\s*$/i.test(normalized);
  if (preview || hasSidebarPreviewNotes(normalized)) return `${index}\r`;
  if (native) return String(index);
  if (/❯?\s*[1-9]\.\s*\[[ ✓✔xX]\]/m.test(visible)) return `${index}\r`;
  // Native JSONL may flush only after submission. Its complete tab bar and
  // navigation footer establish the input protocol without counting coverage.
  const packet = /←[^\r\n]*[☐☒][^\r\n]*✔\s*Submit\s*→[\s\S]*❯\s*1\./.test(visible) &&
    /Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(visible);
  const single = /(?:^|[\r\n])[\t │┃]*[☐□][^\r\n]+[\s\S]*❯\s*1\./.test(visible) &&
    /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(visible);
  const panel = packet || single;
  return panel ? String(index) : `${index}\r`;
}

/** A native single-question pane can elide its tail to leave room for choices. */
function matchesTruncatedNativeQuestion(visible: string, call: NativePlanQuestionCall): boolean {
  if (call.questions.length !== 1) return false;
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = visible.slice(0, cursor.index);
  const header = /^(?:[\t │┃]*\n)*[\t │┃]*[☐□]([^\n│]*)\n/.exec(before);
  if (!header || /[☐□❯]/.test(before.slice(header[0].length))) return false;
  const exact = (value: string) => value.replace(/\s+/g, '');
  const question = call.questions[0]!;
  if (exact(header[1]!) !== exact(question.header)) return false;
  const body = before.slice(header[0].length).replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  // Require the complete displayed prefix, not a fragment or common heading.
  // The final ellipsis is the native UI's elision indicator; missing or changed
  // text anywhere before it cannot borrow an unrelated call's answer policy.
  if (!body.endsWith('…')) return false;
  const prefix = exact(body.slice(0, -1));
  const native = exact(question.question);
  if (prefix.length < 160 || body.split('\n').filter(line => line.trim()).length < 2 ||
      prefix.length >= native.length || !native.startsWith(prefix)) return false;
  const menu = visible.slice(cursor.index);
  const footer = /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.exec(menu);
  if (!footer || !/^[\s│┃─━└┘]*$/.test(menu.slice(footer.index + footer[0].length))) return false;
  const options = parseNumberedOptions(visible);
  const offered = options.slice(0, question.options.length);
  const controls = options.slice(question.options.length);
  return offered.length === question.options.length && offered.every((option, index) =>
    option.index === index + 1 && exact(option.label) === exact(question.options[index]!.label)) &&
    controls.length <= 2 && controls.every((option, index) => option.index === question.options.length + index + 1 &&
      (index === 0 ? /^Typesomething\.?$/ : /^Chataboutthis$/).test(exact(option.label)));
}

/** Match native question identity before permission text can choose an answer. */
export function matchesNativePlanQuestion(visible: string, call: NativePlanQuestionCall): boolean {
  if (call.failed) return false;
  if (call.questions.length !== 1) return nativePacketQuestionIndex(visible, call) !== null;
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const tail = normalized.slice(-4096);
  const cursor = [...tail.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = tail.slice(0, cursor.index);
  const header = [...before.matchAll(/(?:^|\n)[\t │┃]*[☐□]([^\n│]*)/g)].at(-1);
  const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const question = call.questions[0]!;
  if (!header) return matchesClippedNativeQuestion(normalized, call);
  if (compact(header[1]!) !== compact(question.header) || /❯\s*[1-9]\./.test(before.slice(header.index))) return false;
  const identity = question.question.match(/<gstack-qid:[^>]+>/i)?.[0] ?? question.question;
  if (!compact(before.slice(header.index)).includes(compact(identity))) return matchesTruncatedNativeQuestion(normalized, call);
  // Preserve the captured damaged-option path when the native panel's
  // complete footer is intact, including the optional native preview notes key.
  // With a damaged footer, require the full
  // question and every offered label instead of guessing from keywords.
  if (/Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(tail.slice(cursor.index))) return true;
  const displayed = before.slice(header.index).replace(/^[\t ─━┄┅┈┉┌┐└┘├┤┬┴┼│┃☐□■]+/gm, '');
  const options = parseNumberedOptions(visible);
  return compact(displayed) === compact(`${question.header} ${question.question}`) &&
    options.length === question.options.length && options.every((option, index) =>
      option.index === index + 1 && compact(option.label) === compact(question.options[index]!.label));
}

/** Capture each distinct question once, including questions sharing a menu. */
export function capturePlanCountQuestion(
  visible: string,
  seen: Set<string>,
  observedAtMs: number,
  preReview: boolean,
  pending?: NativePlanQuestionCall,
): AskUserQuestionFingerprint | null {
  const tail = stripPtyResidue(visible).replace(/\r+\n?/g, '\n').slice(-4096);
  const cursor = [...tail.matchAll(/❯\s*1\./g)].at(-1);
  // The options parser can fall back to ordinary numbered prose when an
  // old cursor leaves its window. Do not pair that prose with the prompt
  // parser's still-visible historical question and queue spurious input.
  if (!cursor) return null;

  if (pending && !pending.answered && !pending.failed && matchesNativePlanQuestion(visible, pending)) {
    const activeIndex = pending.questions.length === 1 ? 0 : nativePacketQuestionIndex(visible, pending)!;
    const fp = nativePlanCallFingerprint(pending, observedAtMs, preReview);
    fp.nativeQuestionIndex = activeIndex;
    if (pending.questions.length > 1) {
      const question = pending.questions[activeIndex]!;
      fp.signature += `:question:${activeIndex}`;
      fp.promptSnippet = `${question.header} ${question.question}`;
      fp.options = question.options.map((option, i) => ({index: i + 1, label: option.label}));
    }
    const renderedOptions = parseNumberedOptions(visible);
    const renderedPrompt = parseQuestionPrompt(visible);
    const renderedSignature = renderedOptions.length >= 2 && renderedPrompt
      ? auqFingerprint(renderedPrompt, renderedOptions) : null;
    const alreadyHandled = seen.has(fp.signature) || Boolean(renderedSignature && seen.has(renderedSignature));
    // Once answered, the same menu may linger while the native call is
    // no longer pending, or the native record may arrive after the UI
    // answer. Bind both identities before testing either direction.
    if (renderedSignature) seen.add(renderedSignature);
    seen.add(fp.signature);
    if (alreadyHandled) return null;
    return fp;
  }
  // A permission cursor can outlive the short frame-classifier window.
  // Never turn it into an ordinary prompt answer, even when its question
  // was damaged by a redraw or its original grant was not observed.
  if (planCountPermissionMenu(visible)) return null;
  const options = parseNumberedOptions(visible);
  if (options.length < 2) return null;
  const promptSnippet = parseQuestionPrompt(visible);
  if (promptSnippet === '') return null;
  const signature = auqFingerprint(promptSnippet, options);
  if (seen.has(signature)) return null;
  seen.add(signature);
  return { signature, promptSnippet, options, observedAtMs, preReview };
}

/**
 * Consume file-permission menus separately from native review questions.
 * A granted menu can be repainted, then linger after the tool completes.
 * Its text is not a new answer request. The same file can ask again after
 * a successful native Write/Edit result, so content-only dedup is too broad.
 */
export function createPlanCountPermissionGuard(): (visible: string, completionHistory?: string, native?: FilePermissionEpoch | null) => 'grant' | 'handled' | null {
  let granted: { signature: string; completedAt: number; nativeId?: string } | undefined;
  return (visible, completionHistory = visible, native) => {
    // Only the current viewport can establish an actionable permission.
    // Historical file results release a later identical grant, never a menu.
    const candidate = planCountPermissionMenu(visible);
    if (!candidate) return null;
    const { normalized, cursorAt, prompt, menu } = candidate;
    // A whole quoted pane is source text, even if it contains a native cursor.
    // Returning handled also suppresses the dispatcher's default permission input.
    const rows = stripVTControlCharacters(normalized).split('\n').filter(row => row.trim());
    if (rows.length && rows.every(row => /^[\t ]*>/.test(row))) return 'handled';
    // File permission identity comes from the action or native approval
    // choices, not a brittle exact rendering of "Do you want to ...".
    // Other permission kinds retain the existing caller policy.
    if (!/(?:create|overwrite|edit)/i.test(prompt.replace(/\s+/g, '')) &&
        !/(?:acceptedits|allowalledits|auto-approvefileedits)/i.test(menu.replace(/\s+/g, ''))) return null;
    const signature = prompt.replace(/\s+/g, '');

    // Match actual native file-tool results, not proposed diff rows, tool
    // headers, or tips. A diff repaint after the menu is still pending.
    const completionPattern = /^[\t ]*⎿[\t \u00a0]*(?:Wrote\s*\d+\s*lines?|Added\s*\d+\s*lines?|Removed\s*\d+\s*lines?|Updated\b|Edited\b)/gm;
    const visibleCompletedAt = [...normalized.matchAll(completionPattern)].at(-1)?.index ?? -1;
    if (visibleCompletedAt > cursorAt) return 'handled';
    const history = stripPtyResidue(completionHistory).replace(/\r+\n?/g, '\n');
    const completedAt = [...history.matchAll(completionPattern)].at(-1)?.index ?? -1;
    if (native !== undefined) {
      // Native success alone is not a new prompt: the old pane may redraw.
      // Release only a distinct pending request after this exact grant completed.
      if (!native || (granted?.signature === signature &&
          (!granted.nativeId || native.pendingId === granted.nativeId ||
            (native.completedId !== granted.nativeId && !native.completedIds?.includes(granted.nativeId))))) return 'handled';
    } else if (granted?.signature === signature && completedAt <= granted.completedAt) return 'handled';
    granted = { signature, completedAt, ...(native ? {nativeId:native.pendingId} : {}) };
    return 'grant';
  };
}

/** Keep a seeded count plan intact by declining its optional prerequisite. */
export function planCountPrerequisitePick(fp: AskUserQuestionFingerprint, activeCapture: AskUserQuestionFingerprint = fp): number | null {
  // Require the recognized prerequisite body AND both opposed labels. A
  // generic Skip, an outside-review offer, or a review finding keeps its
  // existing answer policy. Collapsed whitespace occurs in captured PTYs.
  if (!fp.preReview || !/\/office-hours/i.test(fp.promptSnippet) ||
      !/(?:no\s*design\s*doc|produce\s*a\s*design\s*doc)/i.test(fp.promptSnippet)) return null;
  const run = fp.options.filter(({ label }) => /^Run\s*\/office-hours\s*(?:now|first)/i.test(label));
  const skip = fp.options.filter(({ label }) =>
    /^Skip\s*[—–-]\s*(?:proceed\s*with\s*)?standard\s*review(?:\s*\(recommended\))?$/i.test(label));
  if (run.length === 1 && skip.length === 1) return skip[0].index;
  // Short labels need the complete meaning of the active native tab. Other
  // questions in a packet cannot lend their prerequisite context or choices.
  const call = activeCapture.nativeCall;
  const activeIndex = activeCapture.nativeQuestionIndex ?? (call?.questions.length === 1 ? 0 : -1);
  if (call && call.answered === false && call.failed === false && activeCapture.preReview &&
      Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < call.questions.length) {
    const q = call.questions[activeIndex]!;
    const base = `${call.sessionId}:${call.toolUseId}`;
    const activeSignature = call.questions.length === 1 ? base : `${base}:question:${activeIndex}`;
    const routing = nativePlanCallFingerprint(call, fp.observedAtMs, fp.preReview);
    const optionsMatch = (capture: AskUserQuestionFingerprint) => capture.options.length === q.options.length &&
      capture.options.every((option, i) => option.index === i + 1 && option.label === q.options[i]!.label);
    const routingMatches = fp.nativeCall === call && (fp.signature === activeSignature
      ? fp.promptSnippet === `${q.header} ${q.question}` && optionsMatch(fp)
      : fp.signature === base && fp.promptSnippet === routing.promptSnippet &&
        JSON.stringify(fp.options) === JSON.stringify(routing.options));
    if (!q.multiSelect && q.options.length === 2 && activeCapture.signature === activeSignature &&
        activeCapture.promptSnippet === `${q.header} ${q.question}` && optionsMatch(activeCapture) && routingMatches &&
        /\/office-hours/i.test(q.question) && /(?:no\s*design\s*doc|produce\s*a\s*design\s*doc)/i.test(q.question)) {
      const nativeRun = q.options.findIndex(option => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(option.label));
      const nativeSkip = q.options.findIndex(option =>
        /^Skip(?:\s*[—–-]\s*proceed)?(?:\s*\(recommended\))?$/i.test(option.label) &&
        /^(?:(?:The\s+)?plan\s+(?:scope\s+)?is\s+(?:already\s+)?(?:precise|clear|well-defined|explicit)\.\s*)?Proceed\s+(?:with\s+standard(?:\s+DX(?:\s+(?:POLISH|EXPANSION|TRIAGE))?)?\s+review|straight\s+to\s+Step\s*0\s+premise\s+challenge\s+and\s+approach\s+alternatives)\.?$/i.test((option.description ?? '').trim()));
      // A full Skip label can use a comma. Admit that form only from the
      // bound active tab's direct opposed offer and unconditional review action.
      const offer = q.question.split('?', 1)[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '').trim();
      const commaSkip = q.options.findIndex(option =>
        /^Skip\s*,\s*(?:proceed\s+with\s+)?standard\s+review(?:\s*\(recommended\))?$/i.test(option.label) &&
        /^Proceed\s+(?:(?:directly|straight)\s+)?(?:with\s+(?:the\s+)?standard\s+review|to\s+Step\s*0\s+of\s+(?:the\s+)?(?:CEO\s+)?review)\.?$/i.test((option.description ?? '').trim()));
      if (nativeRun >= 0 && commaSkip >= 0 && nativeRun !== commaSkip && call.sessionId && call.toolUseId &&
          q.question.split('?').length === 2 &&
          /^Run\s*\/office-hours\s+(?:now|first),?\s+or\s+proceed\s+with\s+(?:the\s+)?standard\s+review$/i.test(offer) &&
          /^(?:Build|Create|Produce)\s+(?:a|the)\s+design\s+doc(?:ument)?\s+first[,;]\s*then\s+resume\s+(?:the|standard|CEO)\s+review\.?$/i.test((q.options[nativeRun]!.description ?? '').trim()) &&
          !/\b(?:must|need\s+to|have\s+to)\s+(?:run|complete|finish)\s*\/office-hours\b|(?:\/office-hours|design\s+doc(?:ument)?)\s+(?:is\s+)?(?:required|mandatory)\b|\breview\s+is\s+(?:forbidden|blocked)\b/i.test(q.question)) return commaSkip + 1;
      if (nativeRun >= 0 && nativeSkip >= 0 && nativeRun !== nativeSkip) return nativeSkip + 1;
    }
  }
  // The same prerequisite also offers "Skip — review now" or a direct
  // "Proceed with standard review". Require exactly
  // the two opposed actions so this wording cannot skip a mixed finding.
  const choices = fp.options.filter(({ label }) => !/^(?:Typesomething\.|Chataboutthis)$/i.test(label.replace(/\s+/g, '')));
  const reviewNow = choices.filter(({ label }) => /^(?:Skip\s*[—–-]\s*review\s*now|Proceed\s*with\s*standard\s*review)(?:\s*\(recommended\))?$/i.test(label));
  if (choices.length !== 2 || run.length !== 1 || reviewNow.length !== 1 || run[0].index === reviewNow[0].index ||
      !/^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(run[0].label) ||
      (fp.nativeCall && (fp.nativeCall.failed || fp.nativeCall.questions.length !== 1 || fp.nativeCall.questions[0]?.multiSelect))) return null;
  return reviewNow[0].index;
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
  /^[\t ]*(?:[⏺●][\t ]*)?(?:#{1,6}[\t ]*)?(?:GSTACK[\t ]*REVIEW[\t ]*REPORT|Completion[\t ]*[Ss]ummary|Status:[\t ]*(?:clean|issues_open)|(?:\*\*)?VERDICT:)/m;

/** Classify a counting frame before treating numbered native dialogs as AUQs. */
export function classifyPlanCountFrame(
  visible: string,
): 'permission' | 'completion_summary' | 'plan_ready' | null {
  const report = [...visible.matchAll(new RegExp(COMPLETION_SUMMARY_RE.source, 'gm'))].at(-1);
  const menuCursor = [...visible.matchAll(/❯\s*[1-9]\./g)].at(-1)?.index ?? -1;
  const activeQuestionStart = Math.max(
    visible.lastIndexOf('☐', menuCursor), visible.lastIndexOf('☒', menuCursor),
  );
  const permissionTail = visible.slice(Math.max(visible.length - TAIL_SCAN_BYTES, activeQuestionStart, 0));
  if (isNumberedOptionListVisible(visible) &&
      isPermissionDialogVisible(permissionTail) &&
      planCountPermissionMenu(visible) &&
      (!report || report.index <= menuCursor)) {
    return 'permission';
  }
  // Headings must be assistant output, not numbered Read/Write diff rows
  // such as "409 +## GSTACK REVIEW REPORT". The anchored matcher also
  // leaves a completed tool's diff in scrollback without ending the review.
  // A later assistant report supersedes a dismissed permission menu still
  // present in short scrollback; a pending menu below the report does not.
  if (report && report.index > menuCursor) return 'completion_summary';
  if (isPlanReadyVisible(visible)) return 'plan_ready';
  return null;
}

/** A complete native checkbox panel, including its separate Submit/Next button. */
function nativeCheckboxPanel(visible: string): { selected: boolean; submitFocused: boolean } | null {
  const text = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const bar = [...text.matchAll(/^ {0,3}←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→[ \t]*$/gm)].at(-1);
  if (!bar) return null;
  const precedingLine = text.slice(0, bar.index).trimEnd().split('\n').at(-1) ?? '';
  if (/\b(?:example|quoted|source)\b[^:\n]*:\s*$/i.test(precedingLine)) return null;
  let fence: string | undefined;
  for (const line of text.slice(0, bar.index).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
  }
  if (fence) return null;
  const panel = text.slice(bar.index + bar[0].length);
  if (!/Enter\s+to\s+select\s*·\s*(?:↑\/↓|Tab\/Arrow\s+keys)\s+to\s+navigate\s*·\s*Esc\s+to\s+cancel\s*$/i.test(panel)) return null;
  const rows = [...panel.matchAll(/^ {0,3}(❯)?[ \t]*([1-9])\.[ \t]*\[([ ✓✔xX])\][ \t]+[^\n]+$/gm)];
  if (rows.length < 2 || rows.some((row, i) => Number(row[2]) !== i + 1)) return null;
  const button = [...panel.matchAll(/^ {0,3}(❯)?[ \t]*(Submit|Next)[ \t]*$/gm)].at(-1);
  if (!button || button.index! <= rows.at(-1)!.index!) return null;
  const cursors = [...panel.matchAll(/❯/g)];
  if (cursors.length !== 1 || (!button[1] && !rows.some(row => row[1]))) return null;
  return { selected: rows.some(row => row[3] !== ' '), submitFocused: Boolean(button[1]) };
}

/** Navigate native multi-question review without counting Submit as a finding. */
export function planCountSubmissionInput(visible: string): string | null {
  const checkbox = nativeCheckboxPanel(visible);
  if (checkbox?.selected) return checkbox.submitFocused ? '\r' : '\t';
  const bars = [...visible.matchAll(/←[^\r\n]*[☐☒][^\r\n]*✔\s*Submit\s*→/g)];
  const bar = bars.at(-1);
  if (!bar) return null;
  const panel = visible.slice(bar.index + bar[0].length).replace(/\s+/g, '');
  const cursor = [...panel.matchAll(/❯([1-9])\.?/g)].at(-1);
  if (!/^Reviewyouranswe?rs/i.test(panel) || !cursor || cursor[1] !== '1') return null;
  const beforeCursor = panel.slice(0, cursor.index);
  // The native tab bar, review heading and immediately preceding question
  // identify Submit even when its button caption loses letters in a redraw.
  const readyPrompt = /Readytosubmityouranswers\?$/i.test(beforeCursor);
  // Older captures lack an intact Ready prompt. Keep their exact Submit
  // caption path only while no later question/menu has entered scrollback.
  const legacyCaption = /^❯1\.?Submit/i.test(panel.slice(cursor.index)) &&
    !/❯[1-9]|[☐☒]/.test(beforeCursor);
  if (!readyPrompt && !legacyCaption) return null;
  const tabs = [...bar[0].matchAll(/[☐☒]/g)].map((match) => match[0]);
  const unanswered = tabs.indexOf('☐');
  // At the Submit tab, move back to the first unanswered question. Only
  // submit after every question tab carries the native answered marker.
  return unanswered >= 0 ? '\x1b[Z'.repeat(tabs.length - unanswered) : '\r';
}

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
 * A final native completion can replace a lost terminal heading, but never
 * an unanswered question, an old report, or a quoted completion example.
 * The expected path is supplied by the caller, not extracted for filesystem
 * access from model output. This does not add any question-count coverage.
 */
export function hasNativePlanCompletion(
  transcript: PlanCountTranscript,
  expectedPlanPath: string,
  startedAt: number,
): boolean {
  if (transcript.status !== 'ready' || !path.isAbsolute(expectedPlanPath) ||
      !transcript.calls.length || transcript.calls.some(c => !c.answered || c.failed) ||
      !transcript.assistantMessages.length) return false;
  const sessions = new Set([...transcript.calls.map(c => c.sessionId),
    ...transcript.assistantMessages.map(m => m.sessionId)]);
  if (sessions.size !== 1) return false;
  const messages = [...transcript.assistantMessages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const final = messages.at(-1)!;
  const finishedAt = Date.parse(final.timestamp);
  const answerTimes = transcript.calls.map(c => Date.parse(c.answeredAt ?? ''));
  if (!Number.isFinite(finishedAt) || !answerTimes.every(t => Number.isFinite(t) && t < finishedAt)) return false;
  const text = final.text.trim();
  // Actual native prose, not ANSI aliases: the final announcement must say
  // the review is complete and identify the exact caller-owned deliverable.
  if (!/^(?:DX|Design|Eng(?:ineering)?|CEO) review complete[.!](?:\s|$)/i.test(text)) return false;
  const lastLine = text.split('\n').at(-1)!.trim();
  if (lastLine !== `Plan written to: \`${expectedPlanPath}\`` &&
      lastLine !== `Plan written to: ${expectedPlanPath}`) return false;
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`/g, '');
  if (/\?|\b(?:awaiting|waiting for|please (?:choose|answer|confirm))\b/i.test(prose)) return false;
  return hasCompletePlanReport(expectedPlanPath, Math.max(startedAt, ...answerTimes), finishedAt);
}

// Shared only by the opt-in Design report binding and its native completion
// route. A quoted example is inert; an owned quoted status remains evidence.
const DESIGN_CLOSURE_PROVISIONAL = /\b(?:example|sample|template|historical|previous|earlier|quoted|hypothetical|if|unless|until|once|assuming|provided|pending|would|will|could|might|may)\b/i;
function designClosureText(text: string, expectedPlanPath: string): string {
  const state = /^(?:(?:still|now) )?(?:pending|failed|incomplete|unfinished|unresolved|open|withdrawn|superseded|cancelled|canceled|historical|not complete|not passed|not current)$/i;
  return text.replace(/\*\*/g, '')
    .replace(/`([^`\n]+)`/g, (_, value: string) =>
      value === expectedPlanPath || state.test(value) ? value : '')
    .replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’/g, value =>
      state.test(value.slice(1, -1)) ? value.slice(1, -1) : '');
}
function conflictingDesignClosure(text: string): boolean {
  const owner = '(?:(?:the )?Design review(?: of PLAN\\.md)?|DESIGN CLEARED|(?:the )?(?:Design review )?exit gate|(?:the |this )?(?:review|report|gate|verdict|reviewed plan)|(?:(?:this|the|one|a|[1-9]\\d*) )?(?:design )?(?:decision|issue|finding)s?)';
  return new RegExp(`(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${owner} (?:(?:is|are|remains?|was|were|has been|have been) (?:(?:still|now) )?(?:not (?:the )?(?:complete|passed|current)|incomplete|unfinished|pending|failed|unresolved|open|withdrawn|superseded|cancelled|canceled|historical)|failed|did not pass|has not passed)\\b|${owner} (?:requires approval|applies only if approved)\\b|${owner}[^.!?\\n]*\\b(?:only if|conditional on|subject to)\\b|${owner} (?:belongs to|applies only to) (?:an? )?(?:another|different) (?:plan|project|review)\\b`, 'i').test(text) ||
    new RegExp(`(?:^|[.!?;]\\s+|\\n)(?:If|When|Once|Unless|Assuming|Provided)\\b[^.!?\\n]*\\b${owner}\\b`, 'i').test(text);
}

function hasCompletePlanReport(expectedPlanPath: string, minimumMtime: number, maximumMtime: number,
  allowRunHeaderForFailure = false, requiredReview?: 'Design'): boolean {
  if (!path.isAbsolute(expectedPlanPath)) return false;
  try {
    const stat = fs.lstatSync(expectedPlanPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 ||
        stat.mtimeMs < minimumMtime || stat.mtimeMs > maximumMtime) return false;
    // A template/example inside Markdown code is not the completed report.
    // Fences open with 3+ identical backticks or tildes, indented at most
    // three spaces. A close uses the same marker, at least the opening
    // length, and only horizontal whitespace after it.
    const reportLines: string[] = [];
    let fence: { marker: string; length: number } | undefined;
    for (const line of fs.readFileSync(expectedPlanPath, 'utf8').split(/\r?\n/)) {
      if (fence) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
        continue;
      }
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      // Backticks are forbidden in a backtick fence's info string.
      if (open && (open[1]![0] !== '`' || !open[2]!.includes('`'))) {
        fence = { marker: open[1]![0]!, length: open[1]!.length };
        continue;
      }
      reportLines.push(line);
    }
    if (fence) return false;
    const content = reportLines.join('\n');
    if (!assertReviewReportAtBottom(content).ok) return false;
    const report = content.slice(content.indexOf('## GSTACK REVIEW REPORT'));
    // Reject a provisional heading; retain both clean and issues-open reports.
    const rows = report.split('\n');
    // Positive completion keeps the canonical Review header. A failure-only
    // diagnostic may also recognize the Run header found in a native report;
    // it still requires a complete, fresh caller-owned deliverable.
    const tableHeader = allowRunHeaderForFailure
      ? /^\|(?:[^\n|]*\|)*[ \t]*(?:Review|Run)[ \t]*\|/
      : /^\|[^\n]*Review[^\n]*\|/;
    const table = rows.findIndex(line => tableHeader.test(line));
    const completeTable = table >= 0 && /^\|[ :|-]+\|$/.test(rows[table + 1] ?? '') &&
      /^\|.*[a-zA-Z].*\|$/.test(rows[table + 2] ?? '');
    const decisions = rows.findIndex(line => /^\*\*UNRESOLVED DECISIONS:\*\*$/.test(line));
    const trailing = rows.slice(decisions + 1).filter(line => line.trim());
    const closed = rows.filter(line => line.trim()).at(-1) === 'NO UNRESOLVED DECISIONS' ||
      (decisions >= 0 && trailing.length > 0 && trailing.every(line => /^[-*] \S|^\+ \d+ unresolved from prior reviews$/.test(line)));
    if (requiredReview === 'Design') {
      const cells = (row: string) => row.split('|').slice(1, -1).map(cell => cell.trim());
      const header = cells(rows[table] ?? '');
      const design = rows.slice(table + 2).filter(row => row.startsWith('|'))
        .map(cells).filter(row => row[header.indexOf('Review')] === 'Design Review');
      const verdicts = rows.filter(row => /^(?:[-*] )?(?:\*\*)?VERDICT:/i.test(row));
      const verdict = designClosureText(verdicts[0] ?? '', expectedPlanPath).replace(/^(?:[-*] )?VERDICT:\s*/i, '');
      if (design.length !== 1 || !/^(?:clean|clear(?: \(full\))?|complete[d]?)$/i.test(design[0]![header.indexOf('Status')] ?? '') ||
          verdicts.length !== 1 || !/^DESIGN CLEARED\b/i.test(verdict) ||
          /\?/.test(verdict) || /^DESIGN CLEARED\s+(?:is|was|were|has been|had been|not|never|no longer)\b/i.test(verdict) ||
          DESIGN_CLOSURE_PROVISIONAL.test(verdict) || conflictingDesignClosure(verdict) ||
          conflictingDesignClosure(designClosureText(report, expectedPlanPath)) ||
          rows.filter(row => row.trim()).at(-1) !== 'NO UNRESOLVED DECISIONS') return false;
    }
    return completeTable && /^(?:[-*] )?(?:\*\*)?VERDICT:(?:\*\*)?[ \t]*[A-Za-z]/m.test(report) && closed;
  } catch { return false; }
}

/** A final owned gate with no review questions is missing coverage, never success.
 * The caller may identify completed setup/navigation calls; unclassified,
 * pending, or failed questions cannot be dismissed by this failure diagnostic.
 */
export function isQuestionlessNativePlanExit(
  transcript: PlanCountTranscript, expectedPlanPath: string, startedAt: number, screen: string,
  nonReviewCalls: ReadonlySet<string> = new Set(),
): boolean {
  if (!isCurrentPlanApprovalScreen(screen)) return false;
  if (transcript.status !== 'ready' || transcript.calls.some(call =>
    !call.sessionId || !call.toolUseId || !call.answered || call.failed ||
    !nonReviewCalls.has(`${call.sessionId}:${call.toolUseId}`) ||
    !call.questions.length || call.questions.some(q => !call.answers?.[q.question]) ||
    !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length)) return false;
  const ready = [...(transcript.planReadyRequests ?? [])]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  if (!ready || ready.failed || !ready.sessionId || !ready.toolUseId) return false;
  const at = Date.parse(ready.timestamp);
  const sessions = new Set([...transcript.calls.map(call => call.sessionId),
    ...transcript.assistantMessages.map(m => m.sessionId),
    ...(transcript.planReadyRequests ?? []).map(r => r.sessionId)]);
  return sessions.size === 1 && Number.isFinite(at) && at >= startedAt && at <= Date.now() &&
    transcript.calls.every(call => {
      const answerAt = Date.parse(call.answeredAt ?? '');
      return Number.isFinite(answerAt) && answerAt >= startedAt && answerAt < at;
    }) &&
    hasCompletePlanReport(expectedPlanPath, startedAt, at, true);
}

/** Native report completion is independent of the terminal's streamed headings. */
export function hasNativePlanTerminal(
  transcript: PlanCountTranscript,
  expectedPlanPath: string,
  startedAt: number,
  frame: 'completion_summary' | 'plan_ready',
  administrativeCalls: ReadonlySet<string> = new Set(),
): boolean {
  if (transcript.status !== 'ready' || !transcript.calls.length ||
      transcript.calls.some(c => (!c.answered && !c.failed) || (c.answered && c.failed)) ||
      unresolvedPlanQuestionCalls(transcript.calls).length) return false;
  const sessions = new Set([...transcript.calls.map(c => c.sessionId),
    ...transcript.assistantMessages.map(m => m.sessionId),
    ...(transcript.planReadyRequests ?? []).map(r => r.sessionId)]);
  if (sessions.size !== 1) return false;
  const answered = transcript.calls.filter(c => c.answered);
  if (!answered.length) return false;
  const answerTimes = answered.map(c => Date.parse(c.answeredAt ?? ''));
  if (!answerTimes.every(Number.isFinite)) return false;
  const latestAnswer = Math.max(...answerTimes);
  const latestReady = [...(transcript.planReadyRequests ?? [])]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  if (latestReady?.failed) return false;
  const modifyingAnswers = answered.filter(c =>
    !administrativeCalls.has(`${c.sessionId}:${c.toolUseId}`) && !isCompletedDxHandoff(c))
    .map(c => Date.parse(c.answeredAt!));
  if (!modifyingAnswers.length || !hasCompletePlanReport(expectedPlanPath,
      Math.max(startedAt, ...modifyingAnswers), Date.now())) return false;

  if (frame === 'plan_ready') {
    // A real pending ExitPlanMode call is the approval gate. Do not answer
    // it or mistake its failed tool result for a completed review.
    return Boolean(latestReady && Date.parse(latestReady.timestamp) > latestAnswer &&
      Date.parse(latestReady.timestamp) <= Date.now());
  }
  const final = [...transcript.assistantMessages]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  if (!final || !Number.isFinite(Date.parse(final.timestamp)) || Date.parse(final.timestamp) <= latestAnswer) return false;
  const text = final.text.trim();
  // Only finished, fixture-scoped native prose supplies this evidence. A
  // rendered heading, quoted example, proposed write, or pending question
  // cannot substitute for an actual completion message.
  if (/^(?:>|`{3,}|~{3,}|(?:example|sample|template|quoted)\b)/i.test(text) ||
      /\b(?:cannot|can't|unable to)\s+(?:complete|finish)|\b(?:awaiting|waiting for|please (?:choose|answer|confirm))\b/i.test(text) ||
      text.endsWith('?')) return false;
  if (/^(?:CEO|Eng(?:ineering)?|Design|DX) review complete[.!](?:\s|$)/i.test(text)) return true;
  // A full native summary can precede the final report write; the independent
  // fresh-file check above prevents the observed heading-before-Write race.
  const lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      else if (delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      continue;
    }
    if (!fence && !/^(?: {4}|\t| {0,3}>)/.test(line)) lines.push(line);
  }
  if (fence) return false;
  // A Design review may finish at the user's manual handoff without invoking
  // ExitPlanMode. Bind its affirmative review and passed gate to this report;
  // the common native ownership, answered-call and fresh-file checks above
  // still apply. Other skills retain their existing completion routes below.
  const designText = designClosureText(lines.join('\n'), expectedPlanPath);
  const designParagraphs = designText.split(/\n\s*\n/).map(p => p.trim());
  const designComplete = /(?:^|[.!]\s+)(?:The )?Design review(?: of PLAN\.md)? (?:is complete|has been completed)[.!](?:\s|$)/i;
  const designGate = /(?:^|[.!]\s+)(?:The )?(?:Design review )?exit gate (?:has )?passed[.:!](?:\s|$)/i;
  const escapedPlanPath = expectedPlanPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const designReport = new RegExp(`(?:^|[.!]\\s+)(?:The )?(?:reviewed plan|review report) (?:is at|was written to|is saved at) ${escapedPlanPath}[.!](?:\\s|$)`, 'i');
  const designCompleted = designParagraphs.filter(p => designComplete.test(p) && designReport.test(p));
  const designPassed = designParagraphs.filter(p => designGate.test(p));
  const sourcedDesign = (paragraph: string) => DESIGN_CLOSURE_PROVISIONAL.test(paragraph) ||
    /\b(?:example|sample|template|historical|previous|earlier|quote|source|emit|print)\b.*[:：]\s*$/i
      .test(designParagraphs[designParagraphs.indexOf(paragraph) - 1] ?? '');
  if (designCompleted.length === 1 && designPassed.length === 1 &&
      (designText.match(/\b(?:reviewed plan|review report) (?:is at|was written to|is saved at)\b/gi)?.length ?? 0) === 1 &&
      ![...designCompleted, ...designPassed].some(sourcedDesign) &&
      !conflictingDesignClosure(designText) &&
      Date.parse(final.timestamp) <= Date.now() &&
      hasCompletePlanReport(expectedPlanPath, Math.max(startedAt, ...modifyingAnswers),
        Date.parse(final.timestamp), false, 'Design')) return true;
  const summary = lines.findIndex(line => /^(?:#{1,6}\s*)?(?:\*\*)?Completion\s+summary(?:\*\*)?\s*:?[ \t]*$/i.test(line.trim()));
  const preceding = lines.slice(0, summary).filter(line => line.trim()).at(-1) ?? '';
  if (summary < 0 || /\b(?:example|sample|template|quote|emit|print)\b.*[:：]\s*$/i.test(preceding)) return false;
  const rows = lines.slice(summary + 1).filter(line => /^\s*(?:[-*] |\|)/.test(line));
  return rows.length > 0 && rows.some(line => /\b(?:review|issues?|findings?|gaps?|resolved|scope)\b/i.test(line));
}

/** G's post-report DX next-step menu changes orchestration, not plan decisions. */
function isCompletedDxHandoff(call: NativePlanQuestionCall): boolean {
  if (!call.answered || call.failed || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return false;
  const q = call.questions[0]!;
  if (isRecordedDxManualNavigation(call) || manualDxTaskNavigation(call) || resolvedDxTaskNavigation(call) || specifiedDxTaskNavigation(call) || architecturalDxTaskNavigation(call)) return true;
  const header = q.header.trim().replace(/^D\s*\d+\s*(?:[—–:-]\s*)?/i, '');
  const question = q.question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  const completionLines: string[] = [];
  let completionFence: { marker: string; length: number } | undefined;
  for (const line of question.split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!completionFence) completionFence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      else if (delimiter[1]![0] === completionFence.marker && delimiter[1]!.length >= completionFence.length && !delimiter[2]!.trim()) completionFence = undefined;
    } else if (!completionFence && !/^(?: {4}|\t|\s*>)/.test(line)) completionLines.push(line);
  }
  const completionProse = completionLines.join('\n');
  const closedReviewNavigation = /^What(?:['’]s)? next\?\s*\n/i.test(question) &&
    /(?:^|\n)(?:ELI10:\s*)?(?:The )?DX review (?:is )?(?:done|complete)[.!](?:\s|$)/i.test(completionProse);
  if (q.multiSelect || !/^next(?:\s+steps?)?$/i.test(header) ||
      (!closedReviewNavigation && !/^DX review (?:is )?(?:done|complete)[.!]/i.test(question))) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if ((q.question.match(/<gstack-qid/gi)?.length ?? 0) !== ids.length) return false;
  let resultRecap = false;
  if (ids.length) {
    if (ids.length !== 1 || ids[0]![1] !== (closedReviewNavigation
      ? 'plan-devex-review-next-steps' : 'devex-next-steps')) return false;
    if (closedReviewNavigation) {
      const context = [q.question, ...q.options.map(o => o.description ?? '')].join('\n');
      const state = '(?:(?:is|are|was|were|becomes?|became)|(?:will|would|can|could|may|might) (?:be|become))';
      const closure = `(?:the )?(?:DX review (?:${state} )?(?:done|complete)|(?:all )?(?:decisions?|gaps?|issues?|findings?) (?:${state} )?resolved)`;
      const conditionalClosure = new RegExp(`\\b(?:once|when|after)\\b[^.!?\\n]*${closure}|${closure}[^.!?\\n]*\\b(?:once|when|after)\\b`, 'i');
      if ((q.question.match(/\?/g)?.length ?? 0) !== 1 ||
          q.options.some(option => /\?/.test(option.description ?? '')) ||
          !/\brequired (?:eng review )?gate (?:for|before) shipping\b/i.test(context) ||
          /\b(?:unresolved|pending|remaining|outstanding|if|unless|until)\b|\b(?:gap|issue|finding|decision)s?\s+(?:still\s+)?remains?\b/i.test(context) ||
          /\b(?:not all|not (?:done|complete|resolved)|only after)\b/i.test(context) || conditionalClosure.test(context) ||
          /(?:^|[.!?;]\s+|\b(?:proceed to|continue to|should|must|will|can|could|would|may|need to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|package|implement|resolve|decide)\b/im.test(context)) return false;
    }
  } else {
    // Some native final menus omit a qid. Require an explicit finished-review
    // declaration plus resolved findings and the navigation-only question;
    // malformed/unknown identities and outstanding decisions remain blockers.
    const navigation = /\bWhat(?:['’]s)? next\?/i.exec(q.question);
    const afterQuestion = navigation ? q.question.slice(navigation.index + navigation[0].length).trim() : '';
    resultRecap = /^DX Review result:\s*\d+(?:\.\d+)?\/10\s*(?:→|->)\s*\d+(?:\.\d+)?\/10[.!]/i.test(afterQuestion) &&
      /(?:^|\n)Recommendation:\s*(?:[A-Z]\s*[—–-]\s*)?\/plan-eng-review[.!](?:\s|$)/i.test(afterQuestion);
    const context = [q.question, ...q.options.map(o => o.description ?? '')].join('\n');
    if (resultRecap &&
        (/\b(?:if|unless|until)\b|\bnot(?:\s+[a-z-]+){0,4}\s+resolved\b/i.test(context) ||
         q.options.some(option => /\?/.test(option.description ?? '')) ||
         !/\brequired gate before shipping\b/i.test(context))) return false;
    if (/<gstack-qid/i.test(q.question) ||
        !/(?:^|[.!]\s+)(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten) (?:issues?|findings?|friction points?) (?:found and )?resolved\b/i.test(q.question) ||
        !navigation || (afterQuestion && !resultRecap) ||
        (q.question.match(/\?/g)?.length ?? 0) !== 1 ||
        /\b(?:unresolved|pending|remaining|outstanding)\b|\b(?:gap|issue|finding|decision)s?\s+(?:still\s+)?remains?\b/i.test(context) ||
        /(?:^|[.!?;]\s+|\b(?:proceed to|continue to|should|must|will|need to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|package|implement|resolve|decide)\b/im.test(context)) return false;
  }
  const labels = q.options.map(o => {
    const label = o.label.trim().replace(/\s*\(recommended\)\s*$/i, '');
    return closedReviewNavigation ? label.replace(/^[A-Z][.)]\s*/i, '') : label;
  });
  const runEng = (label: string) => /^Run \/plan-eng-review(?: next)?$/i.test(label);
  const ready = (label: string) => /^Ready to implement(?:\s*[—–-]\s*run \/devex-review after shipping)?$/i.test(label) ||
    (resultRecap && /^Start implementing now$/i.test(label));
  const manual = (label: string) => /^Skip(?:, handle manually|\s*[—–-]\s*I['’]ll handle next steps manually)$/i.test(label) ||
    (resultRecap && /^Skip, handle next steps manually$/i.test(label));
  return labels.every(label => runEng(label) || ready(label) || manual(label)) &&
    labels.filter(runEng).length === 1 && labels.filter(manual).length === 1 &&
    q.options.some(o => o.label === call.answers?.[q.question]);
}

/** A selected manual handoff leaves already recorded DX decisions unchanged. */
function manualDxTaskNavigation(call: NativePlanQuestionCall): boolean {
  const q = call.questions[0]!;
  if (call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      !Number.isFinite(Date.parse(call.answeredAt ?? '')) || q.multiSelect ||
      q.header.trim() !== 'Next steps' || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 || Object.keys(call.answers ?? {}).length !== 1) return false;
  const prose = (text: string) => text.split(/\r?\n/).filter(line =>
    !/^\s*>/.test(line) && !/^\s*(["'`]).*\1\s*$/.test(line)).join('\n').trim();
  const text = prose(q.question);
  if (/```|~~~|<gstack-qid/i.test(text) || (text.match(/\?/g)?.length ?? 0) !== 1 ||
      !/^(?:D[1-9]\d*\s*[—–-]\s*)?DX review (?:is )?complete(?: \((?:10|[0-9])(?:\.\d+)?\/10 (?:->|→) (?:10|[0-9])(?:\.\d+)?\/10\))?\. (?:What should happen next|What happens next|What['’]s next)\?\n/i.test(text) ||
      !/(?:^|\n)ELI10:\s*The DX review (?:found|identified)\b/i.test(text) ||
      !/(?:^|[.!]\s+)(?:All (?:are|have been) (?:written|recorded) (?:in|into) the plan as tasks\b|All DX decisions and tasks are recorded in the plan\.)/i.test(text)) return false;
  const metadata = /(?:^|\n)Project\/branch\/task:\s*([^\n]*)/i.exec(text)?.[1];
  if (metadata && /^(?:if|unless|when|once|after|provided|proposed|optional|source|example|historical|earlier review|previously)\b/i.test(metadata)) return false;
  const label = (value: string) => value.trim().replace(/\s*\((?:recommended|required gate)\)\s*$/i, '');
  const manual = (value: string) => /^Skip(?:,|\s*[—–-])\s*I['’]ll handle next steps manually$/i.test(label(value));
  const eng = (value: string) => /^Run \/plan-eng-review next$/i.test(label(value));
  const implement = (value: string) => /^Ready to implement(?:,|\s*[—–-])\s*run \/devex-review after shipping$/i.test(label(value));
  if (q.options.filter(o => manual(o.label)).length !== 1 || q.options.filter(o => eng(o.label)).length !== 1 ||
      q.options.filter(o => implement(o.label)).length !== 1) return false;
  const selected = q.options.find(o => o.label === call.answers?.[q.question]);
  if (!selected || !manual(selected.label)) return false;
  const description = prose(selected.description ?? '').replace(/[✅❌]/g, '').trim();
  if (!/^(?:Matches your stated intent\b|Plan exits now\b|Exit the plan now\b)/i.test(description) ||
      !/(?:^|[.!]\s+)(?:Plan exits now|Exit the plan now) with all DX (?:decisions and tasks|tasks and decisions) recorded[;.]\s*(?:nothing else is started|no further review is started)\./i.test(description)) return false;
  // A completed recap cannot conceal another plan decision or an instruction
  // to change the plan before the selected manual exit. Quoted archive lines
  // do not establish current obligations; direct current-status quotes do.
  const current = `${text}\n${description}`.replace(/\byou will run subsequent reviews yourself\b/gi, 'manual follow-up');
  if (/(?:^|\n|[.!;]\s+)(?:Source|Example|Historical(?: review)?|Previously|Earlier review(?: assessment)?):/i.test(current)) return false;
  if (/\b(?:This|The) (?:manual |DX )?handoff (?:is|has been) [\"'`]?(?:cancell?ed|withdrawn|retracted|superseded|not current)\b/i.test(current)) return false;
  return !/\b(?:unresolved|outstanding)\b|\b(?:not|never)\s+(?:all\s+)?(?:done|complete|completed|recorded|written|resolved)\b|\b(?:review|findings?|decisions?|tasks?|plan)\b[^.!?\n]{0,70}\b(?:pending|remaining|withdrawn|retracted|superseded)\b|\b(?:only|complete)\s+(?:after|if|when|once)\b/i.test(current) &&
    !/(?:^|[.!?;]\s+|\n|\b(?:should|must|need to|will)\s+)(?:(?:we|you|please|first|then|also)\s+)*(?:add|fix|edit|update|rewrite|remove|implement|resolve|decide|change|approve|start|run)\b/im.test(current);
}

/** The next gate may validate architecture already decided by this DX review. */
function architecturalDxTaskNavigation(call: NativePlanQuestionCall): boolean {
  const q = call.questions[0]!;
  if (call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      q.multiSelect || q.header.trim() !== 'Next steps' || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 || Object.keys(call.answers ?? {}).length !== 1) return false;
  const compact = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const match = /^D[1-9]\d* [—–-] Next steps: DX Review is complete \((?:10|[0-9])\/10 → (?:10|[0-9])\/10, ([1-9]\d*) P1 tasks, TTHW target achievable\)\. The ([1-9]\d*) fixes include architectural decisions \(demo CI exemption, arg order normalization\) that should go through an engineering gate\. What next\? <gstack-qid:plan-devex-next-steps>$/.exec(compact(q.question));
  if (!match || match[1] !== match[2]) return false;
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(Recommended\)$/, ''));
  const expected = ['Run /plan-eng-review next', 'Ready to implement — run /devex-review after shipping', "Skip, I'll handle next steps manually"];
  const descriptions = [
    'The demo CI exemption and argument order change are architectural decisions. Eng review validates the approach before implementation and is the required shipping gate.',
    `Skip eng review and implement the ${match[1]} tasks directly. Run /devex-review on the live SDK to verify the TTHW target was actually hit.`,
    'Take the plan file and implementation tasks and proceed independently.',
  ];
  // Consume every offered description in its own navigation role; an appended
  // remedy or unapproved scope change still requires a later report write.
  return new Set(labels).size === 3 && labels.every((label, index) => {
    const role = expected.indexOf(label);
    return role >= 0 && compact(q.options[index]!.description) === descriptions[role];
  }) && q.options.some(o => o.label === call.answers?.[q.question]);
}

/** A completed DX recap can offer navigation over already specified tasks. */
function specifiedDxTaskNavigation(call: NativePlanQuestionCall): boolean {
  const q = call.questions[0]!;
  if (call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      q.multiSelect || q.header.trim() !== 'Next steps' || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 ||
      Object.keys(call.answers ?? {}).length !== 1) return false;
  const compact = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const question = compact(q.question);
  const match = /^D\d+ [—–-] What's next\? DX review complete\. ([1-9]\d*) tasks specified \(([1-9]\d*) P1 block ship, ([1-9]\d*) P2 same branch\)\. DX score: (?:10|[0-9])\/10 → (?:10|[0-9])\/10\. TTHW: \d+(?:\.\d+)? min → < (\d+(?:\.\d+)?) min \(Champion tier\) after T\d+ lands\. The API changes \((T\d+, T\d+, T\d+)\) have architectural implications that warrant an eng review\. <gstack-qid:plan-devex-review-next-steps>$/.exec(question);
  if (!match || Number(match[1]) !== Number(match[2]) + Number(match[3]) || Number(match[4]) <= 0) return false;
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(Recommended\)$/, ''));
  const expected = ['Run /plan-eng-review next', 'Ready to implement', 'Skip — handle next steps manually'];
  const descriptions = [
    `API changes (${match[5]}) have architectural implications. Eng review validates the --skip-ci-check design, deprecation shim contract, and argument-order change scope before implementation.`,
    `Skip eng review. Start implementing T1–T${match[1]} directly. Run /devex-review after shipping to measure the real TTHW against the < ${match[4]} min target.`,
    'No follow-up review needed right now.',
  ];
  return labels.every((label, index) => {
    const role = expected.indexOf(label);
    return role >= 0 && compact(q.options[index]!.description) === descriptions[role];
  }) && new Set(labels).size === 3 && q.options.some(o => o.label === call.answers?.[q.question]);
}

/** Completed issue decisions can hand off their existing numbered tasks. */
function resolvedDxTaskNavigation(call: NativePlanQuestionCall): boolean {
  const q = call.questions[0]!;
  if (call.failed !== false || q.multiSelect || !/^Next steps$/i.test(q.header.trim()) ||
      q.options.length !== 4 || new Set(q.options.map(option => option.label)).size !== 4) return false;
  const question = q.question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '').replace(/\s+/g, ' ').trim();
  const count = String.raw`(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten)`;
  const match = new RegExp(String.raw`^Next steps: (${count}) P1 DX tasks are ready to implement The DX review found and resolved (${count}) P1 issues\. All decisions were made \(D(\d+)[–-]D(\d+)\)\. The implementation tasks \(T(\d+)[–-]T(\d+)\) are waiting\. The plan also needs an Eng Review before shipping\. What would you like to do next\? <gstack-qid:devex-review-next-steps>$`, 'i').exec(question);
  if (!match) return false;
  const number = (value: string) => /^\d+$/.test(value) ? Number(value) :
    ['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(value.toLowerCase()) + 1;
  const n = number(match[1]!);
  if (number(match[2]!) !== n || Number(match[4]) - Number(match[3]) + 1 !== n ||
      Number(match[6]) - Number(match[5]) + 1 !== n) return false;
  const labels = q.options.map(option => option.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  const expected = ['Run /plan-eng-review next', `Start implementing T${match[5]}–T${match[6]} now`,
    'Run /devex-review after shipping', "Done for now — I'll handle next steps manually"];
  const descriptions = [
    /^DX fixes touch [\w./-]+(?: \([\w -]+(?:, [\w -]+)*\))?(?: and [\w./-]+)*\. Eng review validates the implementation approach for those changes\.$/i,
    /^The tasks are well-defined\. Jump straight to implementation and run \/plan-eng-review after\.$/i,
    /^Implement the tasks and then run \/devex-review on the live SDK to verify TTHW actually hits the <\d+(?:\.\d+)?-minute target\.$/i,
    /^Save the plan and review report; return to it when ready\.$/i,
  ];
  return labels.every((label, index) => {
    const kind = expected.findIndex(expected => expected.toLowerCase() === label.replace(/T(\d+)-T(\d+)/g, 'T$1–T$2').toLowerCase());
    return kind >= 0 && descriptions[kind]!.test(q.options[index]!.description?.trim() ?? '');
  }) && q.options.some(option => option.label === call.answers?.[q.question]);
}



/**
 * Test helper: if `obs.planFile` was set, read it and assert
 * `## GSTACK REVIEW REPORT` is the last `## ` section. Throws on
 * violation with a diagnostic message including the plan path,
 * the reason, any trailing headings, and the last 2KB of TTY output.
 *
 * Used by the four plan-mode E2E tests
 * (skill-e2e-plan-{eng,ceo,design,devex}-plan-mode.test.ts) to enforce
 * the {{PLAN_FILE_REVIEW_REPORT}} resolver contract uniformly. Gates on
 * `obs.planFile` (artifact existing), not on `obs.outcome === 'plan_ready'`,
 * so it also catches the report-missing case under `'asked'` /
 * `'wrote_findings_before_asking'` when a plan was already written.
 */
export function assertReportAtBottomIfPlanWritten(
  obs: { planFile?: string; evidence: string; outcome?: string },
): void {
  if (!obs.planFile) return;
  // Skip when the plan file path was detected from TTY output but no file
  // exists on disk. This happens when the model mentions a path mid-stream
  // (e.g., as a tool-call argument that was interrupted, or in a draft that
  // was never persisted). The report-at-bottom contract is for fully-written
  // plan files; ENOENT means there's no file content to enforce against.
  if (!fs.existsSync(obs.planFile)) return;
  // Skip on 'asked' outcomes — these are smoke tests that exited at the
  // first AUQ render (Step 0 only). The model never reached the workflow's
  // report-writing step, so a partial plan file without the report section
  // is the expected mid-flight state, not a contract violation. The
  // report-at-bottom check applies to outcomes that imply the workflow
  // ran end-to-end (plan_ready, completion_summary, etc.).
  if (obs.outcome === 'asked') return;
  const content = fs.readFileSync(obs.planFile, 'utf-8');
  const verdict = assertReviewReportAtBottom(content);
  if (!verdict.ok) {
    const trailing = verdict.trailingHeadings?.length
      ? `\ntrailing headings: ${verdict.trailingHeadings.join(', ')}`
      : '';
    throw new Error(
      `GSTACK REVIEW REPORT contract violation in ${obs.planFile}: ${verdict.reason}${trailing}\n` +
        `--- evidence (last 2KB) ---\n${obs.evidence}`,
    );
  }
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

/** Complete native assertion briefs distinguish a current gap from test layout. */
function ceoAssertionMismatchBrief(q: NativePlanQuestionCall['questions'][number]): boolean {
  const explanation = (/^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  return /\bcontract\b/i.test(q.question.split('\n')[0] + ' ' + explanation) &&
    /\b(?:planned|proposed|current)\s+(?:test|assertion)\s+only\s+checks?\b/i.test(explanation) &&
    !/\b(?:gap|defect|issue|problem)\b[^.!?]{0,80}\b(?:was|were|already|now|has been|have been)\s+(?:resolved|fixed|closed)\b/i.test(explanation) &&
    q.options.some(option => {
      const label = option.label.replace(/^([1-9]\d*)?[A-Z][):.]\s*/i, '');
      if (/^(?:keep|leave|preserve)\b/i.test(label)) return false;
      const artifactTarget = (target: string) => /^(?:(?:the|a|an|this|prior|previous|completed|reviewed|current|saved|stored|exact|expected|full|complete|whole)\s+)*(?:(?:contents?|text|format|structure)\s+of\s+(?:(?:the|saved|current)\s+)*)?(?:review\s+)?(?:plan|report|summary|note|record|document|log|layout)s?\b/i.test(target);
      // Each assertion clause owns its qualifier and object. An independent
      // report instruction cannot make an unchanged assertion stronger.
      return [label, option.description ?? ''].some(text => text.trim()
        .split(/[.;]\s+|\s+(?:and|then)\s+(?=(?:assert|pin|verify|deep-equal|check|include|add|record|save|write|document|update|render|produce)\b)/i)
        .some(clause => {
          const action = /^(assert|pin|verify|deep-equal)\s+(.+)/i.exec(clause);
          if (!action || artifactTarget(action[2]!)) return false;
          if (action[1]!.toLowerCase() === 'deep-equal') return true;
          return [...action[2]!.matchAll(/\b(?:exact|exactly|full|complete|whole|expected)\s+/gi)].some(qualifier =>
            !/\bonly\b/i.test(action[2]!.slice(0, qualifier.index)) &&
            !artifactTarget(action[2]!.slice(qualifier.index! + qualifier[0].length)));
        }));
    });
}

/** Native finding evidence when CEO mode selection is omitted or left unanswered. */
function ceoNumberedBriefDecision(q: NativePlanQuestionCall['questions'][number], subject: string, inspectFullAssessment = false,
  currentOption?: (option: NativePlanQuestionCall['questions'][number]['options'][number]) => boolean): boolean {
  // A numbered title may be declarative. Its current problem and proposed
  // decision still have to be present in the complete native question.
  const publicText = (text: string) => text.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const prose = publicText(q.question
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, ''));
  const explanations = [...prose.matchAll(/^ELI10:\s*(.+)$/gm)];
  const recommendations = [...prose.matchAll(/^Recommendation:\s*([1-9]\d*)?([A-Z])\b/gim)];
  const explanation = explanations[0]?.[1] ?? '';
  // The opening declaration owns the assessment that follows. A source or
  // hypothetical frame cannot lend its later defect wording current status.
  const openingAssessment = explanation.trim().split(/[.!?]\s+/, 1)[0] ?? '';
  const recommendation = recommendations[0];
  const label = (text: string) => /^([1-9]\d*)?([A-Z])[):.]\s*/i.exec(text.trim());
  if (explanations.length !== 1 || recommendations.length !== 1 || !/\w/.test(explanation) ||
      /^(?:if|unless|whether|suppose|imagine|example|template|hypothetical|historical|quoted|source|previously|formerly)\b|^["'‘“`]/i.test(explanation.trim()) ||
      /\b(?:is|was|presents?|represents?)\s+(?:(?:only|just)\s+)?(?:an?\s+)?(?:quoted|hypothetical|historical|example|template)\b/i.test(openingAssessment) ||
      /\b(?:hypothetical|example|template)\b/i.test(publicText(subject)) ||
      !recommendation || q.options.length < 2 || q.options.some(o => !o.description?.trim()) ||
      !q.options.some(o => { const token = label(o.label); return token && `${token[1] ?? ''}${token[2]}`.toLowerCase() === `${recommendation[1] ?? ''}${recommendation[2]}`.toLowerCase(); })) return false;
  if (/\b(?:this|that|the) (?:issue|finding|gap|problem|defect)\s+(?:is|was|has been)\s+(?:(?:already|now)\s+)?(?:resolved|fixed|closed|withdrawn|retracted|rejected)\b|\b(?:I|we)\s+(?:(?:have|has)\s+)?(?:withdraw|withdrawn|retract|retracted|resolve|resolved)\s+(?:this|that|the)\s+(?:finding|issue|question)\b/i.test(prose)) return false;
  if (prose.split(/[.!?;]\s+|\n/).some(clause =>
    /^(?:there\s+(?:is|are)\s+no\s+(?:current\s+)?|no\s+current\s+)(?:defect|gap|issue|problem)s?\b/i.test(clause.trim()))) return false;
  const findingIdentity = /\b(?:Finding|Issue)\s+F?([1-9]\d*(?:\.[1-9]\d*)*)\b/i.exec(prose.split('\n')[0]!);
  // A decision counter is separate from its issue number. Numbered choices
  // and the recommendation must belong to that issue (or dotted section).
  const optionTokens = q.options.map(option => label(option.label));
  if (optionTokens.some(token => !token || (token[1] ?? '') !== (recommendation[1] ?? '')) ||
      new Set(optionTokens.map(token => token![2]!.toUpperCase())).size !== optionTokens.length ||
      (findingIdentity && recommendation[1] && recommendation[1] !== findingIdentity[1]!.split('.')[0])) return false;
  if (findingIdentity && new RegExp('\\b(?:(?:Finding|Issue)\\s+F?|F)' + findingIdentity[1]!.replace(/\./g, '\\.') + '\\s+(?:is|was|has been)\\s+(?:withdrawn|rejected|retracted|resolved)\\b', 'i').test(prose)) return false;
  if ([subject, explanation].some(text => /\b(?:gap|defect|issue|problem)\b[^.!?]{0,80}\b(?:already|now)\s+(?:resolved|fixed|closed)\b/i.test(publicText(text)))) return false;
  // A complete assessment can withdraw a historical problem in a later
  // sentence. Quoted old assessments do not make that current assertion.
  if ([subject, explanation].some(text => publicText(text).split(/[.!?;]\s+/).some(clause =>
    /^(?:there\s+(?:is|are)\s+no\s+(?:current\s+)?|no\s+current\s+)(?:defect|gap|issue|problem)s?\b/i.test(clause.trim())))) return false;
  const currentProblem = [subject, explanation].flatMap(text => {
    const statements = publicText(text).split(/[.!?]\s+/);
    return inspectFullAssessment ? statements : statements.slice(0, 1);
  }).some(statement => {
    // A numbered test may state its assertion gap through the regression it
    // cannot reject, without using the word "missing" or a question mark.
    const assertionGap = /^test\s+[1-9]\d*(?:\s+\([^()\n]*\))?\s+(?:cannot\s+(?:detect|catch|reject)\b[^.!?\n]*\bregressions|accepts\s+any\s+truthy\s+value)\b/i.test(statement.trim()) && ceoAssertionMismatchBrief(q);
    // This clause asserts the current plan's behavior. A source prefix,
    // negated failure, or historical/example qualification cannot supply it.
    const escapingMailFailure = /^(?:(?:today|currently|now)[,:]?\s+)?(?:(?:the|this|current)\s+)?(?:plan|handler|implementation)\s+(?:lets?|allows?)\s+(?:(?:any|a|an|the)\s+)?(?:mail|email|notification)\s+failures?(?:\s*\([^()\n]*\))?\s+(?:to\s+)?escape\b/i.test(statement.trim()) &&
      !/^(?:source|previously|formerly)\b/i.test(openingAssessment) &&
      !/\b(?:if|unless|whether|hypothetical|historical|quoted|example|template|previously|formerly)\b|\bsource\s+(?:excerpt|material|text)\b/i.test(statement);
    // A quoted contract term can describe the current plan's own behavior.
    // Keep the affirmative owner outside the quotation; source examples and
    // negated or past behavior cannot lend that term current status.
    const embeddedMissingContract = /^(?:the|this|current)\s+(?:plan|handler|implementation)\s+(?:sends?|delivers?|calls?|performs?|executes?|runs?)\b/i.test(statement.trim()) &&
      !/\b(?:if|unless|whether|not|never|historical|hypothetical|quoted|example|template|previously|formerly|source)\b|\b(?:no longer|used to)\b/i.test(statement) &&
      /\bwith\s+['‘]no\s+(?:(?:automated|explicit|defined)\s+)?(?:error handling|tests?|checks?|validation|coordination|cap|bound|timeout)(?:\s+(?:on|for|in)\s+[^'’\n.!?]+)?['’]/i.test(statement);
    const rawSqlGap = /^(?:the|this|current)\s+(?:plan|handler|implementation|(?:lookup\s+)?query)\s+pastes?\b[^.!?]*\bstraight into (?:a )?raw SQL\b/i.test(statement.trim()) &&
      !/\b(?:if|unless|whether|not|never|historical|hypothetical|quoted|example|template|previously|formerly|source)\b|\b(?:no longer|used to)\b/i.test(statement);
    return !/^(?:if|unless|whether|example|template|hypothetical|quoted)\b|\b(?:already resolved|no (?:current )?(?:defect|gap|issue|problem)s?\b|not true)\b/i.test(statement.trim()) &&
      !/\b(?:not|never|no longer|isn't)\s+(?:missing|unspecified|unvalidated|unhandled)\b/i.test(statement) &&
      !/\b(?:not|never|no longer|doesn't|does not)\s+(?:asserts?|checks?)\s+only\b/i.test(statement) &&
      !/\b(?:was|were)\s+(?:missing|unspecified|unvalidated|unhandled)\b/i.test(statement) &&
      !/\b(?:not|never|no longer|doesn't|does not|used to|previously|formerly)\s+(?:pastes?|sends?|delivers?|receives?)\b/i.test(statement) &&
      !/\b(?:not|never|no longer|doesn't|does not|used to|previously|formerly)\s+(?:interpolates?|reads?|fetch(?:es)?|loads?|quer(?:y|ies))\b/i.test(statement) &&
      (assertionGap || /\b(?:missing|unspecified|unvalidated|unhandled)\b|\b(?:(?:has|with|leaves)\s+no|without)\s+(?:(?:automated|explicit|defined)\s+)?(?:error handling|tests?|checks?|validation|coordination|cap|bound|timeout)\b|\b(?:asserts?|checks?)\s+only\b|\b(?:does not|doesn't|never)\s+(?:say|says|state|define|specify|cover|handle)\b|\bpastes?\b[^.!?]*\bstraight into (?:a )?SQL\b|\b(?:gets?|sends?|delivers?|receives?)\b[^.!?]*\btwice\b|\b(?:proves?|checks?|tests?|covers?)\s+(?:the\s+)?happy path\s+and\s+nothing else\b|\binterpolates?\b[^!?]*\b(?:raw\s+)?SQL\s+(?:fragment|string)\b|\bno\s+(?:automated\s+)?tests?\s+(?:are\s+)?planned\b|\b(?:fetch(?:es)?|reads?|loads?|queries)\b[^!?]*\bN\+1\b/i.test(statement) || escapingMailFailure || embeddedMissingContract || rawSqlGap);
  });
  const amendment = q.options.some(option => {
    if (currentOption && !currentOption(option)) return false;
    const token = label(option.label);
    const optionLabel = option.label.replace(/^([1-9]\d*)?[A-Z][):.]\s*/i, '');
    if (/^(?:keep|leave|preserve|save|archive|record|document|render|format|start|pause|resume|continue|finish|end|defer|proceed)\b/i.test(optionLabel) ||
        /^[a-z-]+\s+(?:(?:the|a|this|prior|previous|completed|reviewed|current|saved|stored|exact|expected|full|complete|whole)\s+)*(?:review\s+)?(?:plan|report|summary|note|record|document|log)\b/i.test(optionLabel)) return false;
    // The full brief may spell out an assertion while the native menu uses
    // an abbreviated label. Only that offered option's own numbered row can
    // supply the action; source quotations and neighboring choices cannot.
    const optionRows = token?.[1] ? [...prose.matchAll(new RegExp('^' + token[1] + token[2] + '[):.]\\s*(.+)$', 'gmi'))] : [];
    if (optionRows.length > 1) return false;
    const boundedConfiguration = /\b(?:no|without)\s+(?:cap|bound|timeout)\b/i.test(explanation) &&
      /^explicit\b[^.!?]*\b(?:timeout|budget|cap|bound)\b/i.test(optionLabel);
    const completeTestSuite = /\b(?:no|without)\s+(?:automated\s+)?tests?\b/i.test(`${subject} ${explanation}`) &&
      /^(?:full\s+(?:test\s+)?(?:matrix|table|suite)\b[^.!?]*\b(?:unit|integration|ordering|tests?)\b|full\s+unit\s*(?:\+|and)\s*integration\s+suite\b)/i.test(optionLabel);
    return boundedConfiguration || completeTestSuite || [optionLabel, option.description ?? '', optionRows[0]?.[1] ?? ''].some(text => {
    // Effort estimates are display text. A positive option bullet can own
    // an action; a drawback bullet and its continuation cannot supply one.
    // Preserve a source or conditional introduction before the first bullet.
    const actionText = publicText(text);
    if (actionText.split(/[✅❌]/, 1)[0]!.split(/[.;]\s+/).some(clause =>
      /^(?:if|unless|whether|suppose|imagine|example|template|hypothetical|historical|quoted|source)\b/i.test(clause.trim()) ||
      /\b(?:is|was|presents?|represents?)\s+(?:(?:only|just)\s+)?(?:an?\s+)?(?:quoted|hypothetical|historical|example|template)\b/i.test(clause))) return false;
    return actionText.split(/(?=[✅❌])/).filter(part => !/^\s*❌/.test(part))
      .flatMap(part => part.replace(/^\s*✅\s*/, '').split(/[.;]\s+/)).some(clause =>
      /^(?:add|remove|replace|send|rescue|handle|validate|check|assert|pin|deep-equal|require|define|specify|guard|serialize|parameterize|escape|use|implement|write)\b/i.test(clause.trim()) &&
      !/^[a-z-]+\s+(?:(?:the|a|this|prior|previous|completed|reviewed|current|saved|stored|exact|expected|full|complete|whole)\s+)*(?:review\s+)?(?:plan|report|summary|note|record|document|log)\b/i.test(clause.trim()));
    });
  });
  return currentProblem && amendment;
}

/** A descriptive menu header can accompany a fully numbered issue brief. */
function ceoParenthesizedIssueBrief(q: NativePlanQuestionCall['questions'][number], number: string): boolean {
  const title = q.question.split('\n')[0]!;
  const finding = /^D[1-9]\d*\s+\(Finding\s/i.test(title);
  if (!/^D[1-9]\d*\s+\((?:Issue|Finding) [1-9]\d*(?:\.[1-9]\d*)*\)\s*[—–-]\s*(?:What|How|Which|Should)\b[^\n?]+\?$/i.test(title) ||
      /\b(?:hypothetical|example|template)\b/i.test(title)) return false;
  const prose = q.question
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const explanations = [...prose.matchAll(/^ELI10:\s*(.+)$/gm)];
  const recommendations = [...prose.matchAll(/^Recommendation:\s*([1-9]\d*)?([A-Z])\b/gim)];
  const section = number.split('.')[0]!;
  // A bare recommendation letter can select an offered decision-numbered
  // choice (D4 / 4A) independently of the Finding number. Normalize only a
  // uniform prefix matching this exact decision; mixed or foreign IDs fail.
  const decision = /^D([1-9]\d*)\b/i.exec(title)![1]!;
  if (finding && recommendations.length === 1 && !recommendations[0]![1] &&
      q.options.every(option => new RegExp('^' + decision + '[A-Z][):.]\\s*\\S', 'i').test(option.label))) {
    q = { ...q, options: q.options.map(option => ({ ...option, label: option.label.replace(/^[1-9]\d*(?=[A-Z][):.])/i, '') })) };
  }
  const optionPrefix = recommendations[0]?.[1] ?? '';
  if (explanations.length !== 1 || recommendations.length !== 1 ||
      (optionPrefix ? optionPrefix !== section : !finding) || !/\w/.test(explanations[0]![1]!) ||
      /^(?:if|unless|whether|example|template|hypothetical|historical|quoted)\b/i.test(explanations[0]![1]!.trim())) return false;
  // Current prose may explicitly withdraw an earlier issue. Literal examples
  // and attributed quotations cannot supply either the brief or its withdrawal.
  if (/\b(?:no (?:(?:current|unresolved) )?(?:defect|gap|issue|problem)|(?:this|that|the) (?:issue|finding|gap|problem|defect)\s+(?:is|was|has been)\s+(?:(?:already|now)\s+)?(?:resolved|fixed|closed)|(?:this|that|the) (?:question|finding|issue)\s+is\s+(?:only\s+)?(?:an?\s+)?(?:example|hypothetical)|(?:I|we)\s+(?:withdraw|retract)\s+(?:this|that|the)\s+(?:finding|issue|question))\b/i.test(prose)) return false;
  // The number is identity, not evidence of a defect. Require a current
  // missing contract in the assessment and a concrete offered amendment.
  const assessment = [prose.split('\n')[0], /^Project\/branch\/task:\s*(.+)$/m.exec(prose)?.[1] ?? '', explanations[0]![1]!].join(' ');
  const missingContract = /\b(?:no|without)\s+(?:error handling|tests?|checks?|validation|coordination)\b|\b(?:the|this) plan(?: itself)?\s+(?:(?:says|states|defines|specifies)\s+nothing\b|(?:does not|doesn't)\s+(?:define|specify|cover|mention|handle)\b)/i.test(assessment);
  const amendment = q.options.some(option => [option.label.replace(/^[1-9]\d*[A-Z][):.]\s*/i, ''), option.description ?? ''].some(text =>
    text.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""')
      .replace(/^Completeness\s+\d+\/10\.\s*/i, '').split(/[.;]\s+/).some(clause =>
        /^(?:add|remove|replace|send|rescue|handle|validate|check|assert|pin|require|define|specify|guard|serialize|parameterize|use|implement|write)\b/i.test(clause.trim()) &&
        !/^[a-z]+\s+(?:(?:the|a|this|prior|previous|completed|reviewed|current|saved|stored)\s+)*(?:review\s+)?(?:plan|report|summary|note|record|document|log)\b/i.test(clause.trim()))));
  if (finding || number.includes('.') ? !ceoNumberedBriefDecision(q, title.replace(/^D[1-9]\d*\s+\((?:Issue|Finding) [^)]+\)\s*[—–-]\s*/i, ''), true) : !missingContract || !amendment) return false;
  const headerNumber = /^(?:(?:Finding|Issue)\s+F?|F)([1-9]\d*(?:\.[1-9]\d*)*)(?:\s+[a-z][a-z -]*)?$/i.exec(q.header.trim());
  if (/^(?:finding|issue)\b|^f\d/i.test(q.header.trim()) && !headerNumber) return false;
  if (headerNumber && headerNumber[1] !== number) return false;
  const labels = q.options.map(option => /^([1-9]\d*)?([A-Z])[):.]\s*\S/i.exec(option.label));
  return q.options.length >= 2 && q.options.every((option, i) =>
    Boolean(option.description?.trim()) && (labels[i]?.[1] ?? '') === optionPrefix) &&
    new Set(labels.map(label => label![2]!.toUpperCase())).size === labels.length &&
    labels.some(label => label![2]!.toUpperCase() === recommendations[0]![2]!.toUpperCase());
}

/** A section-numbered option brief remains a review decision when qids are omitted. */
function ceoSectionChoiceBrief(q: NativePlanQuestionCall['questions'][number], title: string): boolean {
  const identity = /^([1-9]\d*)([A-Z])\s*[—–-]\s*(?:What|How|Which|Should)\b[^\n?]+\?$/i.exec(title);
  if (!identity || /\b(?:hypothetical|example|template|report|summary|archive|routing|setup|completion|next review|completed review)\b/i.test(title)) return false;
  const prose = q.question
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const field = (name: string) => [...prose.matchAll(new RegExp('^' + name + ':\\s*(.+)$', 'gm'))];
  const contexts = field('Project/branch/task'), explanations = field('ELI10');
  const stakes = field('Stakes if we pick wrong'), recommendations = field('Recommendation');
  if ([contexts, explanations, stakes, recommendations].some(rows => rows.length !== 1)) return false;
  const section = /(?:^|[,;]\s*)Section ([1-9]\d*) [a-z][a-z -]*\.$/i.exec(contexts[0]![1]!);
  const recommended = /^([A-Z])\b/i.exec(recommendations[0]![1]!);
  if (section?.[1] !== identity[1] || recommended?.[1]?.toUpperCase() !== identity[2]!.toUpperCase() ||
      [explanations[0]![1]!, stakes[0]![1]!].some(text => !/\w/.test(text) || /^["'‘“`]/.test(text.trim())) ||
      /^(?:if|unless|whether|suppose|imagine|example|template|hypothetical|historical|quoted)\b/i.test(explanations[0]![1]!.trim())) return false;
  // Neither an administrative recap nor a withdrawn assessment starts review.
  if (/\b(?:no (?:(?:current|unresolved) )?(?:defect|gap|issue|problem)|(?:this|that|the) (?:issue|finding|gap|problem|defect)\s+(?:is|was|has been)\s+(?:(?:already|now)\s+)?(?:resolved|fixed|closed|withdrawn|retracted)|(?:I|we)\s+(?:(?:have|has)\s+)?(?:withdraw|withdrawn|retract|retracted|resolve|resolved)\s+(?:this|that|the)\s+(?:finding|issue|question))\b/i.test(prose)) return false;
  const explanation = explanations[0]![1]!;
  // A section/choice number is identity, not proof of a review issue. The
  // current assessment must state a correctness gap, with a substantive
  // offered change; administrative storage choices satisfy neither condition.
  const currentGap = /\bno\s+(?:error handling|tests?|checks?|validation|coordination)\b|\bbut not in which order\b|\bpastes?\b[^.!?]*\bstraight into a SQL fragment\b|\bcustomer gets a second\b/i.test(explanation);
  const amendment = q.options.some(option => /^(?:commit|rescue|bound parameter|skip email|full matrix)\b/i.test(option.label.replace(/^[A-Z][):.]\s*/i, '')));
  if (!currentGap || !amendment) return false;
  const labels = q.options.map(option => /^([A-Z])[):.]\s*\S/i.exec(option.label));
  return q.options.length >= 2 && q.options.every((option, i) => Boolean(option.description?.trim()) && labels[i]) &&
    new Set(labels.map(label => label![1]!.toUpperCase())).size === labels.length &&
    labels.some(label => label![1]!.toUpperCase() === recommended![1]!.toUpperCase());
}

function ceoCurrentBriefProse(text: string, inspectOpening = true): boolean {
  const prose = text
    .replace(/(^|\n|[.)!?]\s+|\s+(?=This\b|Correction:))((?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option|(?:no[- ]error[- ]handling\s+)?contract)\s+(?:is|has been)\s+)["“'](withdrawn|retracted|rejected|cancelled|canceled|resolved|closed|not current|historical|hypothetical|quoted|source|example)["”']/gim, '$1$2$3')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const sourceFrame = (clause: string) => /^(?:(?:the|an?)\s+)?(?:source|example|template|hypothetical|historical|quoted|earlier|previous|if|unless|whether|suppose|imagine)\b|^for\s+historical\s+context\b|^the\s+following\b[^.!?]*\b(?:source|example|template|hypothetical|historical|quoted)\b/i.test(clause.trim());
  return (!inspectOpening || !sourceFrame(prose.trim().split(/[.;!?]\s+|\n/, 1)[0]!)) &&
    !prose.replace(/\s+(?=This\b|Correction:)/g, '\n').split(/[.)!?]\s+|\n/).some(clause =>
      /^(?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option|(?:no[- ]error[- ]handling\s+)?contract)\s+(?:is|has been)\s+(?:(?:only|just|an?)\s+)*(?:withdrawn|retracted|rejected|cancelled|canceled|resolved|closed|not current|historical|hypothetical|quoted|source|example)\b/i.test(clause.trim()));
}

/** A transaction header can identify a current boundary decision without a section counter. */
function ceoTransactionBoundaryBrief(q: NativePlanQuestionCall['questions'][number], title: string): boolean {
  const decision = /^D([1-9]\d*)\s*[—–-]\s*(?:Where|When|How|What)\b[^\n]+\?$/i.exec(title);
  const header = /^(?:D([1-9]\d*)\s+)?(?:Txn|Transaction) boundary$/i.exec(q.header.trim());
  if (!decision || !header || (header[1] && header[1] !== decision[1]) ||
      !/\bcommit\b/i.test(title) || !/\b(?:email|mail)\b/i.test(title)) return false;
  const publicText = (text: string) => text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/(^|\n|[.)!?]\s+|\s+(?=This\b|Correction:))((?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option|transaction boundary)\s+(?:is|has been)\s+(?:(?:now|already)\s+)?)["“'](withdrawn|superseded|resolved|specified|defined|cancelled|canceled|not current|no longer current)["”']/gim, '$1$2$3')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const current = (text: string) => ceoCurrentBriefProse(text) &&
    !/^(?:assuming|provided|previously|formerly)\b/i.test(text.trim()) &&
    !publicText(text).split(/[.!?]\s+|\n/).some(clause =>
      /^(?:source|earlier|previous|historical|quoted|example|template|hypothetical)\s+(?:review\s+)?(?:assessment|finding|excerpt|material|text)\b/i.test(clause.trim())) &&
    !publicText(text).split(/[.)!?]\s+|\n|\s+(?=This\b|Correction:)/).some(clause =>
      /^(?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option|transaction boundary)\s+(?:is|has been)\s+(?:(?:now|already)\s+)?(?:withdrawn|superseded|resolved|specified|defined|cancelled|canceled|not current|no longer current)\b/i.test(clause.trim()));
  const prose = publicText(q.question);
  const field = (name: string) => [...prose.matchAll(new RegExp('^' + name + ':\\s*(.+)$', 'gm'))];
  const contexts = field('Project/branch/task'), assessments = field('ELI10');
  const stakes = field('Stakes if we pick wrong'), recommendations = field('Recommendation');
  if ([contexts, assessments, stakes, recommendations].some(rows => rows.length !== 1) ||
      !current(q.question) || ![contexts[0]![1]!, assessments[0]![1]!, stakes[0]![1]!].every(current)) return false;
  const prefix = prose.slice(title.length, prose.indexOf('\nELI10:')).split('\n').map(line => line.trim()).filter(Boolean);
  if (prefix.length !== 1 || prefix[0] !== contexts[0]![0]) return false;
  const labels = q.options.map(option => /^([1-9]\d*)([A-Z])(?:[):.]\s*|\s+)(\S[\s\S]*)$/i.exec(option.label));
  const recommended = /^([1-9]\d*)([A-Z])\b/i.exec(recommendations[0]![1]!);
  if (q.options.length < 2 || q.options.length > 4 || recommended?.[1] !== decision[1] ||
      labels.some(label => label?.[1] !== decision[1]) ||
      new Set(labels.map(label => label![2]!.toUpperCase())).size !== labels.length ||
      !labels.some(label => label![2]!.toUpperCase() === recommended![2]!.toUpperCase()) ||
      !q.options.every((option, i) => current(labels[i]![3]!) && current(option.description ?? ''))) return false;
  const remedy = q.options.findIndex((option, i) => {
    const description = publicText(option.description ?? '');
    return /^Commit (?:the )?update, then (?:email|mail)(?: \(recommended\))?$/i.test(labels[i]![3]!) &&
      /✅\s*Lookup and update commit in one transaction;\s*the (?:email|mail) call runs after commit, outside any DB transaction\b/i.test(description) &&
      /✅\s*A (?:mail|email) failure can never roll back paid status\b/i.test(description) &&
      !/(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|cancel|withdraw) commit\b/i.test(description);
  });
  const opposed = q.options.some((option, i) => i !== remedy &&
    /^(?:Leave|Keep) ordering unspecified$/i.test(labels[i]![3]!) &&
    /❌\s*If the (?:email|mail) lands inside the transaction, a (?:mail|email) timeout rolls back the payment while a retry record for its receipt already exists\b/i.test(publicText(option.description ?? '')));
  if (remedy < 0 || !opposed) return false;
  // These are presentation-only copies; the native menu and selected answer
  // remain exact. The established rich validator still owns gap/remedy proof.
  const semantic = { ...q, options: q.options.map((option, i) => ({ ...option,
    label: `${labels[i]![1]}${labels[i]![2]}) ${i === remedy ? labels[i]![3]!.replace(/^Commit/i, 'Write and commit') : labels[i]![3]}` })) };
  return ceoNumberedBriefDecision(semantic, title, true,
    option => current(option.label.replace(/^[1-9]\d*[A-Z][):.]\s*/i, '')) && current(option.description ?? ''));
}

/** An explicit sequencing decision needs the current missing contract and opposed remedies. */
function ceoSequenceChoiceBrief(q: NativePlanQuestionCall['questions'][number], title: string): boolean {
  const decision = /^D([1-9]\d*)\s*[—–-]\s*(?:In what order|How|What|Which)\b[^\n]+\?$/i.exec(title);
  const header = /^D([1-9]\d*)\s+(?:Sequence|Order|Transaction boundary)$/i.exec(q.header.trim());
  if (!decision || header?.[1] !== decision[1] || !/\b(?:order|sequence)\b/i.test(title) ||
      !/\btransaction\b/i.test(title)) return false;
  const plain = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '').replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  const prose = plain(q.question.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, ''));
  const field = (name: string) => [...prose.matchAll(new RegExp('^' + name + ':\\s*(.+)$', 'gm'))];
  const contexts = field('Project/branch/task'), explanations = field('ELI10');
  const stakes = field('Stakes if we pick wrong'), recommendations = field('Recommendation');
  if ([contexts, explanations, stakes, recommendations].some(rows => rows.length !== 1) ||
      !ceoCurrentBriefProse(q.question)) return false;
  const changedContract = (text: string) => text.split(/[.!?]\s+|\n/).some(clause =>
    /^(?:Correction:\s*)?(?:this|that|the)\s+(?:decision|gap|order|sequence|commit point|transaction boundary)\s+(?:is|has been)\s+(?:(?:already|now)\s+)?["“']?(?:resolved|fixed|closed|withdrawn|retracted|cancelled|canceled|superseded|not current|defined|specified)\b/i.test(clause.trim()));
  if (changedContract(q.question)) return false;
  const context = contexts[0]![1]!, explanation = explanations[0]![1]!;
  const prefix = prose.slice(title.length, prose.indexOf('\nELI10:'));
  if (!prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
      /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line)) ||
      ![context, explanation, stakes[0]![1]!].every(text => ceoCurrentBriefProse(text)) ||
      /\b(?:source|historical|previous|earlier|example|hypothetical|if|unless|whether|assuming|provided)\b/i.test(context) ||
      /\bno\s+(?:current\s+)?(?:sequencing\s+)?(?:gap|issue|problem|defect)\b/i.test(prose)) return false;
  const gap = /^(?:the|this|current)\s+plan(?:\s+(?:lists?|outlines?|describes?)\b[^.!?]*\bbut)?\s+(?:never|does not|doesn't)\s+(?:fix(?:es)?|defin(?:e|es)|specif(?:y|ies)|stat(?:e|es))\s+(?:the\s+)?(?:order|sequence)\b[^.!?]*\b(?:commit point|transaction boundary)\b[.!]?$/i;
  if (!context.split(/[;.!?]\s+/).some(clause => gap.test(clause.trim())) ||
      !/^(?:the|this|current)\s+handler\s+(?:does|performs|runs)\b/i.test(explanation) ||
      !/\b(?:payment|update)\b[^.!?]*\bcommitted\s+before\b/i.test(explanation) ||
      !/\b(?:mail|email|receipt)\b[^.!?]*\b(?:timeout|fail\w*|slow|undo|delay|rolls? back)\b/i.test(explanation)) return false;
  const recommendation = /^([A-Z])\b/i.exec(recommendations[0]![1]!);
  const labels = q.options.map(option => /^([A-Z])[):.]\s*\S/i.exec(option.label));
  if (!recommendation || q.options.length < 2 || labels.some(label => !label) ||
      new Set(labels.map(label => label![1]!.toUpperCase())).size !== labels.length ||
      !labels.some(label => label![1]!.toUpperCase() === recommendation[1]!.toUpperCase())) return false;
  const current = (option: NativePlanQuestionCall['questions'][number]['options'][number]) =>
    Boolean(option.description?.trim()) && ceoCurrentBriefProse(option.label.replace(/^[A-Z][):.]\s*/i, '')) &&
    ceoCurrentBriefProse(option.description!) && !changedContract(option.description!) && !/\b(?:previously|formerly|used to|do not|does not|don't|doesn't|never|no longer)\b/i.test(plain(option.description!));
  const remedy = q.options.some(option => current(option) &&
    /^commit\s+(?:the\s+)?(?:payment|update)\s+first\b/i.test(option.label.replace(/^[A-Z][):.]\s*/i, '')) &&
    /^(?:Transaction:\s*)?lookup\b[^.!?]*\bupdate\b[^.!?]*\bcommit[.;,]?\s+then\b[^.!?]*\b(?:mail|email|receipt)\b/i.test(plain(option.description!)) &&
    !/\bcommit\b[^.;!?]*\bafter\b[^.;!?]*\b(?:mail|email|receipt|send)\b/i.test(plain(option.description!)) &&
    !/\b(?:mail|email|receipt)\b[^.;!?]*\bbefore\b[^.;!?]*\bcommit\b/i.test(plain(option.description!)));
  const opposed = q.options.some(option => current(option) &&
    /^(?:leave|keep|preserve)\b[^.!?]*\b(?:sketched|written|unchanged|order)\b/i.test(option.label.replace(/^[A-Z][):.]\s*/i, '')) &&
    /\bno\s+(?:explicit|defined)\s+(?:commit point|transaction boundary)(?=[.;]|$)/i.test(plain(option.description!)));
  return remedy && opposed;
}

/** Extract the current plan's missing contract without promoting quoted source material. */
function ceoDeclaredMissingContract(explanation: string, reviewedPlan?: string): string | null {
  const namedOwner = reviewedPlan && new RegExp('^' + reviewedPlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s)');
  const statements = explanation.split(/[.!?]\s+/).map(statement =>
    namedOwner ? statement.trim().replace(namedOwner, 'The plan') : statement);
  const declared = statements.map((statement, index) =>
    statements.slice(0, index).every(prior => ceoCurrentBriefProse(prior)) &&
    /^(?:(?:the|this)(?:\s+current)?|current)\s+plan\s+(?:says|states|specifies|requires|calls for)\s+(["“'‘]?)(no\s+(?:(?:automated|explicit|defined)\s+)?(?:error handling|tests?|checks?|validation|coordination|cap|bound|timeout)(?:\s+(?:on|for|in)\s+[^"”'’\n.!?]+)?)(["”'’]?)[.!?]?$/i.exec(statement.trim()))
    .find(match => match && ({ '': '', '"': '"', '“': '”', "'": "'", '‘': '’' } as Record<string, string>)[match[1]!] === match[3]);
  return declared ? declared[2]! : null;
}

/** The decision counter and section metadata need not be repeated as "Finding N". */
function ceoMetadataDecisionBrief(q: NativePlanQuestionCall['questions'][number], title: string): boolean {
  const decision = /^D([1-9]\d*)(?:\s+\((?:Issue|Finding) ([1-9]\d*(?:\.[1-9]\d*)*)\))?\s*[—–-]\s*(?:What|How|Which|Should|Where|When)\b[^\n?]+\?$/i.exec(title);
  if (!decision || /^(?:Finding|Issue|Section|Test)\b|^F\d/i.test(q.header.trim())) return false;
  const contexts = [...q.question.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
  const assessments = [...q.question.matchAll(/^ELI10:\s*(.+)$/gm)];
  if (contexts.length !== 1 || assessments.length !== 1) return false;
  const sections = [...contexts[0]![1]!.matchAll(/\bSection\s+([1-9]\d*)\s*\(([A-Za-z][A-Za-z &/-]*)\)/gi)];
  if (sections.length !== 1 || !/\bCEO review\b/i.test(contexts[0]![1]!) ||
      (decision[2] && decision[2].split('.')[0] !== sections[0]![1])) return false;
  const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
  if (!prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
    /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line))) return false;
  const current = (text: string) => {
    const normalized = text.replace(/;\s+(?=(?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option)\b)/gi, '.\n')
      .replace(/((?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option)\s+(?:is|has been)\s+)["“'‘`](withdrawn|resolved|hypothetical|unproven|no longer current)["”'’`]/gi, '$1$2')
      .replace(/\b(?:is|has been)\s+(?:unproven|no longer current)\b/gi, 'is withdrawn');
    const prose = normalized.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '');
    return ceoCurrentBriefProse(normalized) &&
      !/\b(?:historical|quoted|source|example|hypothetical|previous|earlier)\s+(?:CEO\s+)?(?:review|finding|assessment|excerpt)\b/i.test(prose) &&
      !prose.split(/[.!?;]\s+|\n/).some(clause => /^(?:this|the|current) (?:handler|plan|implementation) (?:has no (?:current )?(?:defect|gap|issue|problem)\b|needs no (?:amendment|fix|change)\b)/i.test(clause.trim()));
  };
  if (!current(contexts[0]![1]!) || !current(assessments[0]![1]!) || !current(q.question)) return false;
  const recommendation = /^Recommendation:\s*([1-9]\d*)?[A-Z]\b/im.exec(q.question);
  if (recommendation?.[1] && recommendation[1] !== (decision[2]?.split('.')[0] ?? decision[1])) return false;
  const currentOption = (option: NativePlanQuestionCall['questions'][number]['options'][number]) =>
    current(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && current(option.description ?? '');
  // A literal reviewed plan name is an owner, not a new defect grammar.
  const reviewedPlan = /\bCEO review of ([A-Za-z0-9_./-]+\.md)(?=,|;|$)/i.exec(contexts[0]![1]!)?.[1];
  // Negating the quoted missing-contract declaration cannot itself become a
  // generic "does not say" omission. Keep the exact same statement owner.
  if (assessments[0]![1]!.split(/[.!?]\s+/).some(statement => {
    const affirmative = statement.replace(/\b(?:does not|doesn't|never)\s+(?:say|state|specify|require|call for)\b/i, 'says');
    return affirmative !== statement && ceoDeclaredMissingContract(affirmative, reviewedPlan) !== null;
  })) return false;
  if (ceoNumberedBriefDecision(q, title, true, currentOption)) return true;
  const declared = ceoDeclaredMissingContract(assessments[0]![1]!, reviewedPlan);
  return declared !== null && ceoNumberedBriefDecision(q, `The plan has ${declared}`, false, currentOption);
}

function nativeExplicitCeoFinding(fp: AskUserQuestionFingerprint, allowQuestionId = false): boolean {
  const call = fp.nativeCall;
  // QUESTION_TUNING=false omits qid injection. Accept an explicit Finding
  // title only after the real call completes; rendered prose is not evidence.
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 1) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || fp.options.length !== q.options.length ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      (!allowQuestionId && /<gstack-qid/i.test(q.question)) ||
      /^(?:review )?(?:mode|scope|approach|routing|prerequisites?|setup|next (?:steps?|review)|completion)$/i.test(q.header.trim()) ||
      q.options.some(option => MODE_RE.test(option.label)) ||
      new Set(q.options.map(option => option.label)).size !== q.options.length ||
      !q.options.some(option => option.label === call.answers?.[q.question])) return false;
  if (allowQuestionId && ((q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/<gstack-qid:\s*(?:plan-)?ceo-(?:review-)?[a-z0-9-]+\s*>/i.test(q.question))) return false;
  const title = q.question.split('\n')[0]!.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '');
  if ((!allowQuestionId || /^D[1-9]\d*\s+\((?:Issue|Finding) [1-9]\d*(?:\.[1-9]\d*)*\)/i.test(title)) &&
      (fp.nativeQuestionIndex === undefined || fp.nativeQuestionIndex === 0) &&
      Number.isFinite(Date.parse(call.answeredAt ?? '')) && ceoMetadataDecisionBrief(q, title)) return true;
  const sectionFindingIdentity = /^D([1-9]\d*)\s+\(Section ([1-9]\d*), finding ([1-9]\d*)\)\s*[—–-]\s*((?:What|How|Which|Should)\b[^\n?]+\?)$/i.exec(title);
  if (allowQuestionId && sectionFindingIdentity) {
    const section = sectionFindingIdentity[2]!, finding = sectionFindingIdentity[3]!;
    const qid = /<gstack-qid:\s*plan-ceo-review-s([1-9]\d*)-[a-z0-9-]+\s*>/i.exec(q.question);
    const headerSection = /^Section ([1-9]\d*)(?: finding ([1-9]\d*))?$/i.exec(q.header.trim());
    if (qid?.[1] !== section || (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        !Number.isFinite(Date.parse(call.answeredAt ?? '')) ||
        (/^Section\b/i.test(q.header.trim()) && (!headerSection || headerSection[1] !== section ||
          (headerSection[2] && headerSection[2] !== finding)))) return false;
    const current = (text: string, inspectOpening = true) => ceoCurrentBriefProse(text.replace(
      /(^|\n|[.)!?]\s+|\s+(?=This\b|Correction:))((?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option)\s+(?:is|has been)\s+)(["“']?)(?:superseded|no longer current)(["”']?)/gim,
      '$1$2$3withdrawn$4'), inspectOpening);
    const contexts = [...q.question.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    const prefix = q.question.slice(q.question.split('\n')[0]!.length, q.question.indexOf('\nELI10:'))
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    if (contexts.length !== 1 || !current(contexts[0]![1]!) || !current(explanation) || !current(q.question, false) ||
        !prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
          /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line)) ||
        !q.options.every(option => current(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && current(option.description ?? ''))) return false;
    // The section and qid have already been bound. Reuse the complete
    // numbered finding validator with a title that excludes inline metadata;
    // preserve the actual native question, choices and acknowledged answer.
    const semantic = { ...q, question: q.question.replace(q.question.split('\n')[0]!,
      `D${sectionFindingIdentity[1]} (Finding ${finding}) — ${sectionFindingIdentity[4]}`) };
    return ceoParenthesizedIssueBrief(semantic, finding);
  }
  if (!allowQuestionId && ceoSectionChoiceBrief(q, title)) return true;
  if (!allowQuestionId && (fp.nativeQuestionIndex === undefined || fp.nativeQuestionIndex === 0) &&
      typeof call.answeredAt === 'string' && Number.isFinite(Date.parse(call.answeredAt)) &&
      (ceoSequenceChoiceBrief(q, title) || ceoTransactionBoundaryBrief(q, title))) return true;
  // The issue identity is separate from the decision counter and section
  // numbering. A completed "Issue 2" choice and "Finding 2.1" choice carry
  // the same review evidence as the already-supported numbered findings.
  const normalized = title.replace(/^D\d+\s*[—–-]\s*/i, '');
  // The affected test can identify an assertion finding without an Issue
  // heading. Sentence punctuation and the form of the remedy question do
  // not change the completed brief's current defect and offered amendment.
  const testAssertion = /^Test ([1-9]\d*)(?:\s+\([^()\n]*\))?\s+(?:asserts?|checks?)\s+only\b[^\n]+\?$/i.exec(normalized);
  const testIdentity = testAssertion ?? /^Test ([1-9]\d*)(?:\s+\([^()\n]*\))?(?:\s*[:—–-]\s*|\s+)[^\n]+\?$/i.exec(normalized);
  if (testIdentity && !/^(?:finding|issue)\b|^f\d/i.test(q.header.trim())) {
    if ((fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        typeof call.answeredAt !== 'string' || !Number.isFinite(Date.parse(call.answeredAt))) return false;
    const headerTest = /^Test\s+([1-9]\d*)\b/i.exec(q.header.trim());
    const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    const ownedPrefix = prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
      /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line));
    const framed = /(?:^|\n)\s*(?:if|unless|whether|suppose|imagine)\b|\b(?:earlier|previous|historical|hypothetical|quoted|source)\s+(?:review\s+)?(?:assessment|example|excerpt|material|text|finding)\b|\b(?:assessment|finding|issue)\s+(?:is|was|represents?)\s+(?:(?:only|just|a|an)\s+)*(?:hypothetical|historical|quoted|example|source)\b/i.test(prefix);
    const conditionalContext = /^Project\/branch\/task:\s*(?:if|unless|whether|suppose|imagine)\b/im.test(prefix);
    // A direct current status may quote its status word. Whole historical
    // quotations start with their source frame and cannot revoke this brief.
    const withdrawn = q.question.split(/[.!?]\s+|\n/).some(clause =>
      /^(?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|remedy|assessment|explanation)\s+(?:is|has been)\s+["“']?(?:withdrawn|retracted|rejected|cancelled|canceled|resolved|closed|not current)\b/i.test(clause.trim()));
    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    const currentAssessment = /^(?:(?:today|currently|now)[,:]?\s+)?(?:the|this|current)\s+(?:plan|contract)\s+(?:states?|specifies?|defines?|requires?|says|calls for|establishes?)\b/i.test(explanation) &&
      /(?:^|[.!?]\s+)(?:But\s+)?(?:the\s+)?(?:planned|proposed|current)\s+test\s+only\s+checks?\b/i.test(explanation);
    const currentAmendment = q.options.some(option => {
      const label = option.label.replace(/^([1-9]\d*)?[A-Z][):.]\s*/i, '');
      if (!/^(?:assert|pin|verify|deep-equal)\b/i.test(label) ||
          !/\b(?:deep[- ]equality|deep-equal|exact|exactly|full|complete|expected)\b/i.test(label)) return false;
      const description = (option.description ?? '')
        .replace(/(^|\n|[.!?]\s+)((?:Correction:\s*)?(?:this|that|the)\s+(?:amendment|remedy|option|decision)\s+(?:is|has been)\s+)["“](withdrawn|retracted|rejected|cancelled|canceled|not current)["”]/gim, '$1$2$3')
        .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
      return !/^(?:source|example|template|hypothetical|historical|quoted|earlier|previous|if|unless|whether|suppose|imagine)\b/i.test(description.trim()) &&
        !/\b(?:is|was|presents?|represents?)\s+(?:(?:only|just|an?)\s+)*(?:quoted|hypothetical|historical|example|template|source)\b/i.test(description.split(/[✅❌]/, 1)[0]!) &&
        !description.split(/[.!?]\s+|\n/).some(clause =>
          /^(?:Correction:\s*)?(?:this|that|the)\s+(?:amendment|remedy|option|decision)\s+(?:is|has been)\s+(?:(?:only|just|an?)\s+)*(?:withdrawn|retracted|rejected|cancelled|canceled|not current|historical|hypothetical|quoted|source|example)\b/i.test(clause.trim()));
    });
    let reviewSubject = normalized;
    if (!testAssertion) {
      // A Test identity can ask for its assertion without restating the
      // defect in its title. Normalize only the current owned ELI10 clause;
      // retain the original title so source/competing identities stay visible.
      const clauses = explanation.split(/(?<=[.!?])\s+/);
      const assertion = /^(?:But\s+)?(?:the\s+)?(?:planned|proposed|current)\s+test\s+only\s+checks?\s+(.+)$/i;
      const at = clauses.findIndex(clause => assertion.test(clause.trim()));
      const decision = /^D([1-9]\d*)\s*[—–-]/i.exec(title);
      const recommended = /^Recommendation:\s*([1-9]\d*)?[A-Z]\b/im.exec(q.question);
      const headerIdentity = /^Test\s+([1-9]\d*)(?=\s|[:—–-]|$)/i.exec(q.header.trim());
      const titleIdentities = normalized.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""')
        .matchAll(/\bTest\s+(\d+(?:\.\d+)*)\b/gi);
      if ((/^Test\s+\d/i.test(q.header.trim()) && (!headerIdentity || headerIdentity[1] !== testIdentity[1])) ||
          (/^D\d/i.test(title) && !decision) ||
          [...titleIdentities].some(identity => identity[1] !== testIdentity[1])) return false;
      if (at < 0 || clauses.slice(0, at + 1).some(clause => !ceoCurrentBriefProse(clause)) ||
          !ceoCurrentBriefProse(q.question, false) || /\b(?:Finding|Issue)\s+F?[1-9]\d*/i.test(normalized) ||
          (decision && recommended?.[1] && decision[1] !== recommended[1])) return false;
      reviewSubject += ` Test ${testIdentity[1]} checks only ${assertion.exec(clauses[at]!.trim())![1]}`;
    }
    if ((!headerTest || headerTest[1] === testIdentity[1]) && ownedPrefix && !framed && !conditionalContext && !withdrawn &&
        currentAssessment && currentAmendment && ceoNumberedBriefDecision(q, reviewSubject, !testAssertion,
          testAssertion ? undefined : option => ceoCurrentBriefProse(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && ceoCurrentBriefProse(option.description ?? ''))) return true;
  }
  // Section and finding counters identify a brief; they cannot supply its
  // current assessment or the authority of an offered amendment.
  const architectureIssue = /^Section ([1-9]\d*) \(Architecture\), issue ([1-9]\d*): ([^\n]+\?)$/i.exec(normalized);
  if (architectureIssue) {
    if ((/^D\d/i.test(title) && !/^D[1-9]\d*\s*[—–-]/i.test(title)) ||
        (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        !Number.isFinite(Date.parse(call.answeredAt ?? '')) || q.options.length < 2 || q.options.length > 4) return false;
    const numberedHeader = /^(Section|Finding|Issue) ([1-9]\d*)$/i.exec(q.header.trim());
    if (/^(?:Section|Finding|Issue)\b/i.test(q.header.trim()) && (!numberedHeader ||
        numberedHeader[2] !== architectureIssue[numberedHeader[1]!.toLowerCase() === 'section' ? 1 : 2])) return false;
    const publicText = (text: string) => text
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/["“](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current)["”]/gi, '$1')
      .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '');
    const current = (text: string) => ceoCurrentBriefProse(text) &&
      !/^(?:provided|assuming|previously|formerly)\b/i.test(publicText(text).trim()) &&
      !/\b(?:this|the|that) (?:finding|issue|decision|assessment|explanation|amendment|remedy|option|(?:ordering )?gap) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current)\b/i.test(publicText(text));
    const prose = publicText(q.question), contexts = [...prose.matchAll(/^Project\/branch\/task: (.+)$/gm)];
    const assessments = [...prose.matchAll(/^ELI10: (.+)$/gm)];
    const prefix = prose.slice(0, assessments[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
    if (contexts.length !== 1 || assessments.length !== 1 || prefix.length !== 1 ||
        prefix[0] !== contexts[0]![0] || !current(contexts[0]![1]!) ||
        !current(assessments[0]![1]!) || !current(q.question)) return false;
    const labels = q.options.map(option => /^([1-9]\d*)([A-Z])[):.]\s*(\S[\s\S]*)$/i.exec(option.label));
    if (labels.some(token => token?.[1] !== architectureIssue[2]) ||
        new Set(labels.map(token => token![2]!.toUpperCase())).size !== labels.length) return false;
    // Commit is a write amendment here only when this same offered option
    // explicitly commits the update before calling mail. Normalize that
    // action for the existing rich validator after native identity checks;
    // the real question, menu and answer remain untouched.
    const commit = q.options.findIndex((option, i) => {
      const label = labels[i]![3]!.replace(/\s*\(recommended\)$/i, '');
      const description = publicText(option.description ?? '');
      return /^Commit the [a-z][a-z -]* update, then send email$/i.test(label) &&
        current(label) && current(option.description ?? '') &&
        /✅\s*Load [^✅❌.]+, assign [^✅❌.]+, COMMIT, then call the mail client\b/.test(description) &&
        /✅\s*Mail failure can never roll back a committed payment\b/.test(description) &&
        !/(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|cancel|withdraw) commit\b/i.test(description);
    });
    if (commit < 0) return false;
    const semantic = { ...q, options: q.options.map((option, i) => i === commit ?
      { ...option, label: option.label.replace(/\bCommit\b/i, 'Write and commit') } : option) };
    return ceoNumberedBriefDecision(semantic, architectureIssue[3]!, false,
      option => current(option.label.replace(/^[1-9]\d*[A-Z][):.]\s*/i, '')) && current(option.description ?? ''));
  }
  const sectionFinding = /^Section\s+([1-9]\d*)\s*,?\s+finding(?:\s+([1-9]\d*))?\s*[—–:-]\s*([^\n]+)$/i.exec(normalized);
  if (sectionFinding) {
    // A comma or declarative title does not weaken this newly admitted
    // route's explicit identity and single current assessment ownership.
    if (!/^Section\s+[1-9]\d*\s+finding(?:\s+[1-9]\d*)?\s*[—–:-]\s*[^\n]+\?$/i.test(normalized)) {
      const contexts = [...q.question.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
      const assessments = [...q.question.matchAll(/^ELI10:\s*(.+)$/gm)];
      // Preserve quoted history while recognizing a current supersession,
      // including a quoted status word, as withdrawal of this decision.
      const current = (text: string) => {
        const status = text.replace(/(^|\n|[.)!?]\s+|\s+(?=This\b|Correction:))((?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option|(?:no[- ]error[- ]handling\s+)?contract)\s+(?:is|has been)\s+)(["“']?)(?:superseded|no longer current)(["”']?)/gim, '$1$2$3withdrawn$4');
        return ceoCurrentBriefProse(status) &&
          !/^(?:assuming|provided|previously|formerly)\b/i.test(text.trim());
      };
      if ((/^D\d/i.test(title) && !/^D[1-9]\d*\s*[—–-]/i.test(title)) ||
          contexts.length !== 1 || assessments.length !== 1 ||
          !current(contexts[0]![1]!) || !current(assessments[0]![1]!) || !current(q.question) ||
          !q.options.every(option => current(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && current(option.description ?? ''))) return false;
    }
    if ((fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        typeof call.answeredAt !== 'string' || !Number.isFinite(Date.parse(call.answeredAt))) return false;
    const headerSection = /^Section\s+([1-9]\d*)(?:\s+finding\s+([1-9]\d*))?$/i.exec(q.header.trim());
    const headerFinding = /^(?:Finding|Issue)\s+([1-9]\d*)$/i.exec(q.header.trim());
    if ((headerSection && (headerSection[1] !== sectionFinding[1] || (headerSection[2] && headerSection[2] !== sectionFinding[2]))) ||
        (headerFinding && headerFinding[1] !== sectionFinding[2]) ||
        (/^(?:Section|Finding|Issue)\b/i.test(q.header.trim()) && !headerSection && !headerFinding)) return false;
    const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    const ownedPrefix = prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
      /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line));
    const framed = /(?:^|\n)\s*(?:if|unless|whether|suppose|imagine)\b|\b(?:earlier|previous|historical|hypothetical|quoted|source)\s+(?:review\s+)?(?:assessment|example|excerpt|material|text|finding)\b|^Project\/branch\/task:\s*(?:if|unless|whether|suppose|imagine)\b/im.test(prefix);
    if (!ownedPrefix || framed) return false;

    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    if (!ceoCurrentBriefProse(explanation) || !ceoCurrentBriefProse(q.question, false)) return false;
    let subject = sectionFinding[3]!;
    const boundary = /[.!?](?=\s|$)/.exec(subject)?.index ?? subject.length;
    const declaration = subject.slice(0, boundary);
    if (/^["'‘“`]|\b(?:if|unless|whether|hypothetical|historical|quoted|source|example|template|previously|formerly)\b|\b(?:no longer|used to)\b/i.test(declaration)) return false;
    // These affirmative owned clauses express the same semantics already
    // checked by the shared decision validator. Preserve literal quotes
    // elsewhere; a quoted whole statement cannot supply either clause.
    const sql = /^((?:the|this|current)\s+(?:lookup|(?:lookup\s+)?query|plan|handler|implementation))\s+reads?\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+into\s+((?:a\s+)?raw SQL (?:fragment|string))$/i.exec(declaration);
    const missing = /^((?:the|this|current)\s+(?:(?:receipt|notification)\s+)?(?:email|mail|handler|plan|implementation))\s+has\s+(["“'‘])(no error handling)(["”'’])$/i.exec(declaration);
    if (sql) subject = `${sql[1]} interpolates ${sql[2]} into ${sql[3]}` + subject.slice(boundary);
    if (missing && ({ '"': '"', '“': '”', "'": "'", '‘': '’' } as Record<string, string>)[missing[2]!] === missing[4])
      subject = `${missing[1]} has ${missing[3]}` + subject.slice(boundary);
    if (ceoNumberedBriefDecision(q, subject, true, option => ceoCurrentBriefProse(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && ceoCurrentBriefProse(option.description ?? ''))) return true;
  }
  // A test's stated exact contract and its weaker assertion form a concrete
  // finding even when the native header uses the affected behavior's name.
  const assertionGap = /^Test [1-9]\d* asserts only [^,\n?]+, but the plan states ([^.!?\n]+)\. (?:Pin|Assert|Verify) [^\n?]+\?$/i.exec(normalized);
  if (assertionGap && /\b(?:exact|exactly|full|complete)\b/i.test(assertionGap[1]!) &&
      !/\b(?:if|unless|hypothetical|no|not|already)\b/i.test(normalized) &&
      q.options.some(o => /^(?:[A-Z][).]\s*)?(?:Assert|Pin|Verify)\b/i.test(o.label) && Boolean(o.description?.trim())) &&
      q.options.some(o => /^(?:[A-Z][).]\s*)?Keep\b.*\bassertion\b/i.test(o.label) && Boolean(o.description?.trim()))) return true;
  // The title may name the affected test while the native header carries
  // its finding number. Require the complete current mismatch and repair
  // brief, and bind that header to the numbered recommendation.
  const directAssertion = /^Test [1-9]\d* asserts only [^,\n?]+, but (?:the plan states|the contract is) ([^.!?\n]+)\. (?:Pin|Assert|Verify|Fix) [^\n?]+\?$/i.exec(normalized);
  const assertionNumber = /^Finding ([1-9]\d*)$/i.exec(q.header.trim());
  const recommendedNumber = /^Recommendation:\s*([1-9]\d*)[A-Z]\b/im.exec(q.question);
  if (directAssertion && assertionNumber && recommendedNumber && assertionNumber[1] === recommendedNumber[1] &&
      /\b(?:exact|exactly|full|complete)\b/i.test(directAssertion[1]!) &&
      !/\b(?:if|unless|hypothetical|no|not|already)\b/i.test(normalized) &&
      ceoAssertionMismatchBrief(q) && ceoNumberedBriefDecision(q, normalized)) return true;
  const identity = /^(Finding|Issue)\s+F?([1-9]\d*(?:\.[1-9]\d*)*)(?:\s+\(Sections?\s+[1-9]\d*(?:\s+(?:and|&)\s+[1-9]\d*|,\s*[1-9]\d*)*(?:,\s*[a-z][a-z -]*)?\))?\s*:\s*([^\n]+)$/i.exec(normalized);
  const annotation = /\((Sections?\s+[^)]+)\)/i.exec(normalized)?.[1];
  let descriptiveAnnotatedFinding = false;
  if (identity && annotation && !/^Section\s+[1-9]\d*$/i.test(annotation)) {
    if (/\b(?:hypothetical|example|template|historical|quoted)\b/i.test(annotation) ||
        !ceoNumberedBriefDecision(q, identity[3]!)) return false;
    const recommended = /^Recommendation:\s*([1-9]\d*)?([A-Z])\b/im.exec(q.question);
    const labels = q.options.map(option => /^([1-9]\d*)?([A-Z])[):.]\s*\S/i.exec(option.label));
    if (!recommended || labels.some(token => !token || (token[1] ?? '') !== (recommended[1] ?? '')) ||
        (recommended[1] && recommended[1] !== identity[2]) ||
        new Set(labels.map(token => token![2]!.toUpperCase())).size !== labels.length) return false;
    // A section annotation does not require the short native header to
    // repeat the finding number. Admit descriptive headers only through
    // this complete, current, numbered brief; explicit counters stay bound.
    const current = (text: string, inspectOpening = true) => ceoCurrentBriefProse(text.replace(
      /(^|\n|[.)!?]\s+|\s+(?=This\b|Correction:))((?:Correction:\s*)?(?:this|that|the)\s+(?:finding|issue|decision|assessment|explanation|amendment|remedy|option)\s+(?:is|has been)\s+)(["“']?)(?:superseded|no longer current)(["”']?)/gim,
      '$1$2$3withdrawn$4'), inspectOpening);
    const contexts = [...q.question.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    const currentAssessment = explanation.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '').split(/[.!?]\s+/);
    const resolved = currentAssessment.some(clause =>
      /^(?:this|the|current) (?:handler|plan|implementation) (?:has no (?:current )?(?:defect|gap|issue|problem)\b|needs no (?:amendment|fix|change)\b)/i.test(clause.trim()));
    const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    descriptiveAnnotatedFinding = !/^(?:Finding|Issue|Section)\b|^F\d/i.test(q.header.trim()) &&
      (fp.nativeQuestionIndex === undefined || fp.nativeQuestionIndex === 0) &&
      Number.isFinite(Date.parse(call.answeredAt ?? '')) && contexts.length === 1 &&
      prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
        /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line)) &&
      current(contexts[0]![1]!) && current(identity[3]!) &&
      current(explanation) && !resolved && current(q.question, false) &&
      q.options.every(option => current(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) &&
        current(option.description ?? ''));
  }
  const numberedSubject = /^([1-9]\d*(?:\.[1-9]\d*)+)\s+([^:\n]+):\s*([^\n]+)$/.exec(normalized);
  const parenthesized = /^D[1-9]\d*\s+\((?:issue|finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)\)\s*[—–-]\s*([^\n?]+\?)$/i.exec(title);
  const premise = parenthesized && /^((?:the|this|current)\s+[^\n?]+[.!])\s+(?:What|How|Which|Should)\b[^\n?]+\?$/i.exec(parenthesized[2]!);
  if (allowQuestionId && premise) {
    // The same owned issue can state its defect before asking for a remedy.
    // Keep the native identity and current assessment; punctuation supplies
    // neither a finding nor an offered change.
    if ((fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        typeof call.answeredAt !== 'string' || !Number.isFinite(Date.parse(call.answeredAt))) return false;
    const ownedText = (text: string) => text
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    const currentProse = (text: string) => ceoCurrentBriefProse(text) && !/^(?:previously|formerly)\b/i.test(text.trim());
    const prefix = ownedText(q.question.slice(title.length, q.question.indexOf('\nELI10:')));
    const contexts = [...prefix.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
    const numberedHeader = /^(?:(?:Finding|Issue)\s+F?|F)([1-9]\d*(?:\.[1-9]\d*)*)(?:\s+[a-z][a-z -]*)?$/i.exec(q.header.trim());
    if (contexts.length !== 1 || !currentProse(contexts[0]![1]!) ||
        !prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
          /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line)) ||
        (/^(?:Finding|Issue)\b|^F\d/i.test(q.header.trim()) && (!numberedHeader || numberedHeader[1] !== parenthesized![1])) ||
        /\b(?:if|unless|whether|hypothetical|historical|quoted|source|example|template|previously|formerly|not|never)\b|\b(?:no longer|used to)\b/i.test(ownedText(premise[1]!)) ||
        !currentProse(premise[1]!) || !ceoCurrentBriefProse(q.question, false) ||
        !currentProse(/^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '')) return false;
    return ceoNumberedBriefDecision(q, premise[1]!, false, option =>
      currentProse(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) &&
      currentProse(option.description ?? '') && /\w/.test(ownedText(option.description ?? '')));
  }
  if (allowQuestionId && !identity && !parenthesized && !numberedSubject) {
    // "Does not say whether" states the same current missing contract as
    // "does not specify whether". Only its owned assessment can supply that
    // equivalence; keep the completed native decision and rich remedy checks.
    const decision = /^D([1-9]\d*)\s*[—–-]\s*[^\n?]+\?$/i.exec(title);
    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    const clauses = explanation.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '').split(/[.!?]\s+/);
    const currentProse = (text: string) => ceoCurrentBriefProse(text) && !/^(?:previously|formerly)\b/i.test(text.trim());
    const omission = /^(?:the|this)\s+plan\s+(?:also\s+)?(?:does not|doesn't)\s+say\s+whether\s+(.+)$/i;
    const at = clauses.findIndex(clause => omission.test(clause.trim()));
    if (decision && at >= 0) {
      const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
        .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
      const contexts = [...prefix.matchAll(/^Project\/branch\/task:\s*(.+)$/gm)];
      const recommendation = /^Recommendation:\s*([1-9]\d*)?[A-Z]\b/im.exec(q.question);
      if ((fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
          typeof call.answeredAt !== 'string' || !Number.isFinite(Date.parse(call.answeredAt)) ||
          /^(?:Finding|Issue|Section|Test)\b|^F\d/i.test(q.header.trim()) ||
          /\b(?:source|quoted|historical|hypothetical|example|template|earlier|previous)\b/i.test(title) ||
          (recommendation?.[1] && recommendation[1] !== decision[1]) ||
          contexts.length !== 1 || !currentProse(contexts[0]![1]!) ||
          !prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
            /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line)) ||
          !clauses.slice(0, at + 1).every(clause => currentProse(clause)) ||
          !ceoCurrentBriefProse(q.question, false)) return false;
      return ceoNumberedBriefDecision(q, `The plan does not specify whether ${omission.exec(clauses[at]!.trim())![1]}`, false,
        option => currentProse(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && currentProse(option.description ?? ''));
    }
  }
  if (parenthesized && (allowQuestionId || /^D[1-9]\d*\s+\(Finding\s/i.test(title) || (parenthesized[1]!.includes('.') &&
      !/^(?:(?:Finding|Issue)\s+F?|F)[1-9]\d*/i.test(q.header.trim())))) return ceoParenthesizedIssueBrief(q, parenthesized[1]!);
  // A descriptive header can name the affected test. The full owned brief,
  // rather than that header, must supply its current gap and offered remedy.
  if (parenthesized && !/^(?:finding|issue)\b|^f\d/i.test(q.header.trim())) {
    const prefix = q.question.slice(title.length, q.question.indexOf('\nELI10:'))
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    // A standalone preface owns the assessment below it. Only current
    // question metadata or a wholly quoted note may precede this new path.
    const ownedPrefix = prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
      /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line));
    const framed = /(?:^|\n)\s*(?:if|unless|whether|suppose|imagine)\b|\b(?:earlier|previous|historical|hypothetical|quoted|source)\s+(?:review\s+)?(?:assessment|example|excerpt|material|text|finding)\b|\b(?:assessment|finding|issue)\s+(?:is|was|represents?)\s+(?:(?:only|just|a|an)\s+)*(?:hypothetical|historical|quoted|example|source)\b/i.test(prefix);
    if (ownedPrefix && !framed && ceoNumberedBriefDecision(q, parenthesized[2]!)) return true;
  }
  if (identity && !/^[^\n?]+\?$/.test(identity[3]!) && !ceoNumberedBriefDecision(q, identity[3]!)) {
    if ((fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
        typeof call.answeredAt !== 'string' || !Number.isFinite(Date.parse(call.answeredAt))) return false;
    // A later sentence can state the current plan's exact missing contract.
    // Its asserted owner stays outside the quotation; a source quotation,
    // conditional contract or withdrawn assessment cannot supply the gap.
    const prefix = q.question.slice(q.question.split('\n')[0]!.length, q.question.indexOf('\nELI10:'))
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""');
    if (!prefix.split('\n').map(line => line.trim()).filter(Boolean).every(line =>
      /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line) || /^[A-Za-z][A-Za-z -]*:\s*""[.!?]?$/.test(line)) ||
      prefix.split('\n').filter(line => /^Project\/branch\/task:/.test(line.trim())).some(line => !ceoCurrentBriefProse(line.trim().replace(/^Project\/branch\/task:\s*/, '')))) return false;
    const explanation = /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? '';
    if (!ceoCurrentBriefProse(explanation) || !ceoCurrentBriefProse(q.question, false)) return false;
    const declared = ceoDeclaredMissingContract(explanation);
    if (!declared || !ceoNumberedBriefDecision(q, `The plan has ${declared}`, false,
      option => ceoCurrentBriefProse(option.label.replace(/^(?:[1-9]\d*)?[A-Z][):.]\s*/i, '')) && ceoCurrentBriefProse(option.description ?? ''))) return false;
  }
  if (numberedSubject && (numberedSubject[2]!.trim().toLowerCase() !== q.header.trim().toLowerCase() ||
      !ceoNumberedBriefDecision(q, numberedSubject[3]!))) return false;
  // A native menu may put its finding identity in the short header and ask
  // for the remedy in the title. Preserve any explicit title identity too.
  const remedy = /^F([1-9]\d*) remedy$/i.exec(q.header.trim());
  if (remedy && /^D[1-9]\d*\s*[—–-]\s*[^\n?]+\?$/i.test(title)) {
    if (/^(?:Finding|Issue)\b/i.test(normalized) && !identity) return false;
    return (!identity || identity[2] === remedy[1]) &&
      (!parenthesized || parenthesized[1] === remedy[1]);
  }
  if (!identity && !parenthesized && !numberedSubject) return false;
  const expected = identity ? identity[2] : parenthesized ? parenthesized[1] : numberedSubject![1];
  const header = q.header.trim().toLowerCase();
  const numberedHeader = /^(?:(?:finding|issue)\s+f?|f)([1-9]\d*(?:\.[1-9]\d*)*)(?:\s+[a-z][a-z -]*)?$/.exec(header);
  if (/^(?:finding|issue)\b|^f\d/i.test(header) && !numberedHeader) return false;
  // Finding and Issue name the same numeric identity. A descriptive header
  // is fine after the section brief is validated; preserve explicit counters.
  return !(numberedHeader || parenthesized || (/\(Section\s/i.test(title) && !descriptiveAnnotatedFinding)) || numberedHeader?.[1] === expected;
}

export const ceoFirstReviewAUQ: Step0BoundaryPredicate = (fp) =>
  nativeExplicitCeoFinding(fp) || (fp.nativeCall?.questions.some(q => {
    if (fp.nativeCall?.answered && !fp.nativeCall.answers?.[q.question]) return false;
    const id = /<gstack-qid:\s*(?:plan-)?ceo-(?:review-)?([a-z0-9-]+)/i.exec(q.question)?.[1];
    if (!id || /(?:^|-)(?:scope|mode|approach|routing|office-hours|prerequisites?|setup|next-steps|completion)(?:-|$)/i.test(id)) return false;
    const title = q.question.split('\n')[0];
    if (/^D[1-9]\d*\s+\(Section [1-9]\d*, finding [1-9]\d*\)\s*[—–-]/i.test(title)) return nativeExplicitCeoFinding(fp, true);
    if (/^D[1-9]\d*\s+\((?:Issue|Finding)\s+[1-9]\d*(?:\.[1-9]\d*)*\)\s*[—–-]/i.test(title)) return nativeExplicitCeoFinding(fp, true);
    if (!/^(?:D\s*\d+\s*[—–-]|(?:Finding|Section)\s*\d+)/i.test(title)) return false;
    if (/^(?:D\s*\d+\s*[—–-]\s*)?(?:Finding|Issue)\s+F?\d/i.test(title)) return nativeExplicitCeoFinding(fp, true);
    if (/\bfinding\b|\bmissing\b|\bambiguous\b|\bundefined\b|doesn['’]t\s+(?:define|specify|cover|mention)/i.test(title)) return true;
    // Native decision briefs often put the question in the title and explain
    // the plan's defect in ELI10. Read that evidence without treating a setup
    // or navigation decision's recap of findings as its first review question.
    if (/^(?:review )?(?:mode|scope|approach|routing|prerequisites?|setup|next steps|completion)$/i.test(q.header.trim()) ||
        q.options.some(option => MODE_RE.test(option.label))) return false;
    if (nativeExplicitCeoFinding(fp, true)) return true;
    const body = q.question.slice(title.length)
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^\s*>.*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""').trim();
    // Match an assertion boundary, not a substring inside "if ..." or
    // "it is not true that ...". The brief may introduce it with ELI10/but.
    const omission = /(?:^|[.!?]\s+|\bELI10:\s*|\bbut\s+)(?:the|this) plan\s+(?:(?:says|states|calls for|requires)\b[^\n.!?]{0,240}?(?:without\s+defining|(?:doesn['’]t|does not)\s+(?:define|specify|cover|mention))|(?:doesn['’]t|does not)\s+(?:define|specify|cover|mention))\b/i.test(body);
    const amendment = q.options.some(option => [option.label, option.description ?? ''].some(text =>
      /^(?:(?:Specify|Define|Clarify|Require|Amend|Update)\b|Add to (?:the )?plan\b|Plan specifies:)/i.test(text.trim())));
    return omission && amendment;
  }) ?? false);

/** A closed whole-plan complexity choice sets review scope, not an issue remedy. */
function engWholePlanSetupAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Scope$/i.test(q.header.trim()) || q.options.length !== 2 ||
      new Set(q.options.map(o => o.label)).size !== 2 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-review-scope-challenge') return false;
  const body = q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim().replace(/\s+/g, ' ');
  const counts = /^D\s*\d+\s*[—–:-]\s*This plan introduces ([1-9]\d*) new classes across ([1-9]\d*) files\. Recommend scope reduction before reviewing, or accept the complexity and review as-is\?$/i.exec(body);
  if (!counts || !counts.slice(1).every(n => Number.isFinite(Number(n)))) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const accept = q.options.find(o => /^Accept complexity\s*[—–-]\s*review as-is$/i.test(label(o.label)));
  const reduce = q.options.find(o => /^Recommend scope reduction first$/i.test(label(o.label)));
  if (!accept || !reduce) return false;
  const description = (s: string) => s.trim().replace(/\s+/g, ' ');
  const accepted = /^Proceed with the full review of all ([1-9]\d*) classes across ([1-9]\d*) files\. Flag any specific overengineering during the Architecture section, but don't block on scope reduction now\. Recommended: the scope smell is already called out in the plan and the review will surface whether it's justified\.$/i.exec(description(accept.description ?? ''));
  return Boolean(accepted && accepted[1] === counts[1] && accepted[2] === counts[2] &&
    /^Propose a minimal version(?: \([^()\n]*\))? and ask the user to confirm before reviewing the full plan\. This risks re-scoping before we understand the full design rationale\.$/i.test(description(reduce.description ?? '')));
}

/** Native setup needs an answered scope decision, not a particular model-chosen qid. */
export const engSetupAUQ: Step0BoundaryPredicate = (fp) => {
  if (engWholePlanSetupAUQ(fp)) return true;
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  const answered = call.questions.filter(q => Boolean(call.answers?.[q.question]));
  // A mixed packet containing an answered finding is not wholly setup.
  return answered.length > 0 && answered.every(q => {
    if (!q.options.some(option => option.label === call.answers?.[q.question])) return false;
    const actions = q.options.map(option => option.label.trim().replace(/^[A-Z][.)]\s+/i, ''));
    const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1]?.toLowerCase();
    const body = q.question.replace(/<gstack-qid:[^>]*>/gi, '').trim()
      .replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
    // A finding about one component or a TODO remains substantive even if
    // it cites the plan's size or offers to reduce that individual issue.
    if (/\b(?:issue|finding|gap|TODO)\b/i.test(q.header) ||
        /^(?:(?:architecture|code quality|test|performance|security)\s+)?(?:issue|finding|gap|TODO)\b/i.test(body)) return false;
    const learningPremise = /\bcross[- ]project\s+(?:learnings|lessons)\b|\b(?:learnings|lessons)\b[^.!?]{0,100}\b(?:other|all)\s+(?:projects|repositories)\b/i.test(body);
    const crossProject = id === 'cross-project-learnings' || id === 'preamble-cross-project-learnings' ||
      (!id && /^cross[- ]project$/i.test(q.header.trim())) || learningPremise;
    if (crossProject) {
      return actions.some((enabled, i) =>
        (/^enable\s+cross[- ]project\b/i.test(enabled) ||
          (learningPremise && /^enable(?:\s*\(recommended\))?$/i.test(enabled))) &&
        actions.some((scoped, j) => j !== i && /\bproject[- ]scoped\b/i.test(scoped)));
    }
    // The skill's complexity gate concerns the whole plan and a concrete
    // file/class/service count. Its qid and header can vary across native runs.
    const scopeHeading = /^scope(?:\s+(?:challenge|reduction|complexity))?\s*:/i.test(body);
    const wholePlanStatement = /(?:^|\n)(?:ELI10:\s*)?(?:this|the|whole|entire)\s+plan\s+(?:touches|spans|covers|changes|introduces|involves)\b/i.test(body);
    const wholePlanScope = (/^(?:(?:scope(?:\s+(?:challenge|reduction|complexity))?|complexity\s+check)\s*:\s*)?(?:this|the|whole|entire)\s+plan\s+(?:touches|spans|covers|changes|introduces|involves)\b/i.test(body) ||
        (scopeHeading && wholePlanStatement)) && /\b\d+\s+(?:new\s+)?(?:files|classes|services)\b/i.test(body);
    // The native complexity gate may give the plan's file/class counts
    // directly, without spelling out "this plan touches". Keep that shape
    // tied to a Scope header and the explicit whole-scope opposed action.
    const countedComplexityGate = /^scope$/i.test(q.header.trim()) &&
      (/^complexity\s+check(?:\s+triggered)?\s*:\s*\d+\s+files\b/i.test(body) ||
        /^(?:the\s+)?plan['’]s\s+scope\b[^.!?]{0,180}\bcomplexity(?:\s+smell)?\s+check\b/i.test(body)) &&
      /\b\d+\s+files\b/i.test(body) &&
      /\b\d+\+?\s+(?:new\s+)?(?:classes|services)\b/i.test(body) &&
      actions.some(action => /^reduce\s+scope\b/i.test(action));
    // An explicit Step 0 gate may put the whole-plan size in the native
    // full-scope option instead of repeating it in the question. Keep the
    // step, whole-plan premise and both numeric dimensions bound together.
    const explicitStep0Gate = /^step\s*0\s+scope$/i.test(q.header.trim()) &&
      /^step\s*0\s+scope\s+challenge:\s*(?:this|the)\s+plan\s+triggers\s+(?:the\s+)?complexity\s+gate\b/i.test(body) &&
      q.options.some((option, i) => /^proceed\s+at\s+full\s+scope\b/i.test(actions[i] ?? '') &&
        /\b(?:review|implement)\b[^.!?]{0,60}\bas\s+written\b/i.test(option.description ?? '') &&
        /\b\d+\s+files\b/i.test(option.description ?? '') &&
        /\b\d+\+?\s+(?:new\s+)?(?:classes|services)\b/i.test(option.description ?? ''));
    const scopeComplexity = id === 'plan-eng-scope-complexity' || id === 'plan-eng-review-scope-reduce' || wholePlanScope || countedComplexityGate || explicitStep0Gate;
    return scopeComplexity &&
      actions.some((proceed, i) =>
        (/^proceed\s+(?:as[- ]is|at\s+full\s+scope)\b/i.test(proceed) || /^accept\b.*\bdesign\b.*\bfocus\b.*\bquality\b/i.test(proceed)) &&
        actions.some((reduce, j) => j !== i && /^(?:reduce\b|flag\s+scope\s+reduction\b)/i.test(reduce)));
  });
};

/** A native architecture repair may state the defect without an "issue" label. */
function engExplicitRepairAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Architecture$/i.test(q.header.trim()) || q.options.length < 2 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/^plan-eng-(?:review-)?arch(?:itecture)?-[a-z0-9-]+$/i.test(ids[0]![1]!) ||
      /(?:^|-)(?:scope|focus|mode|setup|routing|learnings|prerequisite|onboarding|next-steps?)(?:-|$)/i.test(ids[0]![1]!)) return false;
  const body = q.question.replace(/<gstack-qid:[^>]+>/i, '').trim().replace(/\s+/g, ' ');
  const issue = /^D\s*\d+\s*[—–:-]\s*Architecture:\s+((?:shared|a|an|the)\s+[^.!?]+)\s+is a race condition\.\s+How should (?:it be fixed|we fix it)\?$/i.exec(body);
  return Boolean(issue && !/\b(?:false|not|never|no longer|denies?|claim|assertion|example)\b/i.test(issue[1]!));
}

/** A component choice can name its existing defect in an offered remedy. */
function engArchitectureChoiceAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^(?:Retry arch|Architecture)$/i.test(q.header.trim()) || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/^plan-eng-(?:review-)?arch(?:itecture)?-retry-scheduler$/i.test(ids[0]![1]!)) return false;
  const body = q.question.replace(/<gstack-qid:[^>]+>/i, '').trim().replace(/\s+/g, ' ');
  if (!/^D\s*\d+\s*[—–:-]\s*Architecture:\s*Custom retry scheduler vs\.? the library['’]s built-in retry hooks\?$/i.test(body)) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  if (!q.options.some(o => /^Use library built-in with curve config$/i.test(label(o.label))) ||
      !q.options.some(o => /^Custom scheduler, shared module$/i.test(label(o.label)))) return false;
  const unchanged = q.options.find(o => /^Proceed as planned\s*[—–-]\s*custom, inline per worker$/i.test(label(o.label)));
  return Boolean(unchanged && /^Each worker gets its own copy of the retry logic\.\s+Completeness:\s*\d+\/10\.\s+Creates \d+ divergence points; acknowledged DRY violation from the start\.$/i.test(unchanged.description ?? ''));
}

/** A closed dependency choice can expose the current plan's coupling in its options. */
function engDependencyBindingAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Cache binding$/i.test(q.header.trim()) || q.options.length !== 2 ||
      new Set(q.options.map(o => o.label)).size !== 2 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-cache-binding') return false;
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');
  const body = normalize(q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, ''));
  const choice = /^D\s*\d+\s*[—–:-]\s*Architecture: How should ([A-Za-z_$][\w$]*) access the cache adapter after scope reduction\?$/i.exec(body);
  if (!choice) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const injected = q.options.find(o => /^Constructor injection$/i.test(label(o.label)));
  const imported = q.options.find(o => /^Module-level import$/i.test(label(o.label)));
  if (!injected || !imported) return false;
  // Consume both descriptions: the current-plan coupling and the offered
  // alternative must be affirmative, not quoted, conditional, or mixed with new work.
  const core = (s: string) => normalize(s).replace(/ Completeness: (?:10|[0-9])\/10\. \(human: (?:no change|~?\d+(?:\.\d+)?(?:min|h| days?)) \/ CC: (?:no change|~?\d+(?:\.\d+)?(?:min|h))\)$/, '');
  return core(injected.description ?? '') === `${choice[1]} receives the cache adapter as a constructor argument (or factory function parameter). Tests pass a stub; production passes the real adapter. Eliminates module-level mutable state entirely. Requires wiring at the call site.` &&
    core(imported.description ?? '') === `${choice[1]} imports the adapter directly at module scope, same pattern as the current plan. Works fine in production; makes tests require module-level mocking (jest.mock, proxyquire). Matches the existing codebase pattern if that's what's already used.`;
}

/** A direct shared-state risk is a finding even when its qid omits the section name. */
function engSharedMutableCacheAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Shared cache$/i.test(q.header.trim()) || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 3 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-shared-mutable-cache') return false;
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');
  const body = normalize(q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, ''));
  const risk = /^D\s*\d+\s*[—–:-]\s*Architecture: Two services share a global mutable ([A-Za-z_$][\w$]*) via module-level export\. This is the #[1-9]\d* reliability risk in multi-tenant auth [—–-] concurrent mutations can corrupt tenant isolation\. How should the plan address this\?$/i.exec(body);
  if (!risk) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const injected = q.options.find(o => /^Dependency injection$/i.test(label(o.label)));
  const guarded = q.options.find(o => /^Mutation guards on the global$/i.test(label(o.label)));
  const accepted = q.options.find(o => /^Accept as-is, flag as known risk$/i.test(label(o.label)));
  if (!injected || !guarded || !accepted) return false;
  const core = (s: string) => normalize(s).replace(/ Completeness: (?:10|[0-9])\/10\.$/, '');
  const remedy = /^The plan is updated to pass ([A-Za-z_$][\w$]*) as a constructor argument to both ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*)\. No module-level mutable export\. Tests can inject a mock\/stub\. Single shared instance still possible at the app root\.$/.exec(core(injected.description ?? ''));
  return Boolean(remedy && remedy[1] === risk[1] && remedy[2] !== remedy[3] &&
    core(guarded.description ?? '') === 'Keep the global export but wrap every mutation site in explicit locking or compare-and-swap. Safer than bare shared state but still couples both services to the global. Adds concurrency primitives that need their own tests.' &&
    core(accepted.description ?? '') === 'Note the shared-global pattern in the review report as a known risk. Leave the plan unchanged. Suitable only if the runtime is single-threaded and concurrent mutation is architecturally impossible.');
}

/** A completed explicit issue retains its identity when question tuning omits qids. */
function engNumberedFindingAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 1 ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      /<gstack-qid/i.test(q.question)) return false;
  const title = q.question.split('\n')[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  // A declarative severity-labelled issue can own the same cache repair as
  // an interrogative title. Require its native decision, current assessment,
  // and opposed implementation options; metadata alone never opens review.
  const declaredCache = /^(?:Issue|Finding) ([1-9]\d*) \[P[0-3]\] \(confidence (?:10|[1-9])\/10\) [A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?: ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) share a global mutable ([A-Za-z_$][\w$]*) via module-level export, and both mutate it\.$/.exec(title);
  if (declaredCache) {
    if (!/^Shared cache$/i.test(q.header.trim()) || declaredCache[2] === declaredCache[3]) return false;
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedCache = escaped(declaredCache[4]!);
    const decision = /^D([1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
    const owner = `(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|risk)|(?:Issue|Finding) ${declaredCache[1]}${decision ? `|D${decision}` : ''})`;
    const boundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
    const scalarOwner = new RegExp(`${boundary}${owner} (?:is|was|has been) (?:(?:now|already) )?$`, 'i');
    const current = (value: string) => value
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’|`(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)`/gi,
        (quoted: string, index: number, source: string) =>
          /^(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)$/i.test(quoted.slice(1, -1)) &&
          scalarOwner.test(source.slice(0, index)) ? quoted.slice(1, -1) : '')
      .replace(/`([^`\n]*)`/g, (_, code: string) => /^[A-Za-z_$][\w$]*$/.test(code) ? code : '')
      .replace(/\*\*/g, '');
    const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
    const closed = new RegExp(`${boundary}${owner} (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|${boundary}no current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
    const removed = new RegExp(`${boundary}(?:(?:${escapedCache}|(?:the|this|that) (?:cache|export|global|writers?|writes?|services?)) (?:is|are|has been|have been) (?:no longer (?:global|mutable|shared|unordered)|(?:now |already )?(?:ordered|serialized|removed))|(?:${escaped(declaredCache[2]!)}|${escaped(declaredCache[3]!)}|(?:the|this|both) services?) no longer (?:share|mutate|write)[a-z]*)\\b`, 'i');
    const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:inject|receive|remove|delete|serialize|order|keep|proceed|accept)\b/i;
    const inactive = (value: string) => framed.test(value) || closed.test(value) || cancelled.test(value);
    const text = current(q.question), assessment = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const preface = text.slice(text.indexOf('\n') + 1, assessment[0]?.index ?? 0).trim().split('\n').filter(Boolean);
    if (assessment.length !== 1 || preface.length !== 1 ||
        !/^Project\/branch\/task: \S[^\n]*\bSection [1-9]\d* Architecture\b/.test(preface[0]!) ||
        !/^Two services write to the same cache through a global variable\./.test(assessment[0]![1]!) ||
        !/\b(?:writes can interleave|no ordering|unordered writes)\b/.test(assessment[0]![1]!) || inactive(text) ||
        removed.test(text)) return false;
    const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
    if (optionIds.some(id => id?.[1] !== declaredCache[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
    const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
    return q.options.some((remedy, index) => {
      if (!new RegExp(`^Inject ${escapedCache};`).test(actions[index]!)) return false;
      const body = current(remedy.description ?? '').trim();
      if (inactive(body) ||
          !new RegExp(`^✅\\s*Both services receive the one ${escapedCache} instance via constructor; the module export goes away\\b`).test(body) ||
          !new RegExp(`✅\\s*${escapedCache} exposes only [^✅❌.!?]{1,180} and serializes writes per key\\b`).test(body) ||
          /\b(?:module export (?:stays|remains|is retained)|writes (?:remain|stay) unordered|(?:do not|never) serialize)\b/i.test(body)) return false;
      return q.options.some((opposed, other) => other !== index && /^Proceed as written$/i.test(actions[other]!) &&
        !inactive(current(opposed.description ?? '')) && !removed.test(current(opposed.description ?? '')) &&
        new RegExp(`❌\\s*Ships an? (?:auth cache|${escapedCache}) with two unordered writers and shared test state\\b`).test(current(opposed.description ?? '')) &&
        !/\b(?:risk|race) (?:is |has been )?(?:resolved|closed|fixed)|\bno (?:race|risk) remains\b/i.test(current(opposed.description ?? '')));
    });
  }
  if (engCacheWriterDecision(q)) return true;
  // The category may precede the issue number. Bind this library choice to
  // the current scheduling defect and both concrete outcomes, not its label.
  const declaredLibraryHooks = /^Issue ([1-9]\d*): Custom inline scheduler vs\. the job library's built-in retry hooks \([A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?\)$/i.exec(title);
  const implicitLibraryHooks = /^D([1-9]\d*)\s*[—–:-]\s*Custom inline backoff scheduler vs the job library's built-in retry hooks$/i.exec(q.question.split('\n')[0]!);
  const scopedLibraryHooks = /^Issue ([1-9]\d*): custom inline scheduler per worker, or the job library's retry hook with a custom curve\?$/i.exec(title) ?? implicitLibraryHooks;
  const libraryHooks = /^Architecture issue ([1-9]\d*): custom inline scheduler vs the job library's built-in retry hooks\?$/i.exec(title) ?? declaredLibraryHooks ?? scopedLibraryHooks;
  if (libraryHooks) {
    if (!(implicitLibraryHooks ? /^Architecture$/i : new RegExp(`^${declaredLibraryHooks ? 'Issue' : 'Arch(?:itecture)?'} ${libraryHooks[1]}$`, 'i')).test(q.header.trim())) return false;
    const ordinal = (declaredLibraryHooks || scopedLibraryHooks) && /^D([1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
    const declaredOwner = `(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${libraryHooks[1]}${ordinal ? `|D${ordinal}` : ''})`;
    const declaredBoundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
    const scalarOwner = new RegExp(`${declaredBoundary}${declaredOwner} (?:is|was|has been) (?:(?:now|already) )?$`, 'i');
    const current = (text: string) => {
      const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
        .replace(/^(?:\s*>| {4}|\t).*$/gm, '');
      if (declaredLibraryHooks || scopedLibraryHooks) return prose.replace(/\*\*/g, '')
        .replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’|`[^`\n]*`/g,
          (quoted: string, at: number, source: string) => {
            const status = /^["“'‘`](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)["”'’`]$/i.exec(quoted);
            return status && scalarOwner.test(source.slice(0, at)) ? status[1]! : '';
          }).replace(/\*\*/g, '');
      return prose
        .replace(/["“](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)["”]/gi, '$1')
        .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '')
        .replace(/\*\*/g, '');
    };
    const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
    const closed = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${libraryHooks[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
    const text = current(q.question), lines = text.split('\n');
    const contexts = lines.filter(line => /^Project\/branch\/task: \S/.test(line));
    const assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const preface = text.slice(0, assessments[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
    // A crash consequence explains the current defect; approval conditions
    // still suspend the owned decision and are checked below.
    const framingText = scopedLibraryHooks ? text.replace(/(?:^|[.!?]\s+)If (?:that|the|this) (?:worker )?process (?:dies|restarts|crashes)\b[^.!?\n]*[.!?]?/gi, '') : text;
    if (contexts.length !== 1 || assessments.length !== 1 || preface.length !== 1 || preface[0] !== contexts[0] ||
        framed.test(framingText) || closed.test(text) || /\b(?:the|this) plan no longer rebuilds retry scheduling\b|\bretry scheduling no longer runs inside each worker\b/i.test(text)) return false;
    const assessment = assessments[0]![1]!;
    // A declarative issue with a source location can own the same concrete
    // scheduling decision. Bind the assessment and each offered outcome;
    // the issue number and source location alone do not begin review.
    if (declaredLibraryHooks || scopedLibraryHooks) {
      const ownClosed = new RegExp(`${declaredBoundary}${declaredOwner} (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i');
      // Read approval clauses in the original text, including an owned
      // condition after a crash premise or after an option's tradeoffs.
      const approvalBoundary = scopedLibraryHooks ? `(?:${declaredBoundary}|,\\s+)` : declaredBoundary;
      const approvalPremise = scopedLibraryHooks ? '(?:(?:if|when|once) (?:approved|accepted)|(?:assuming|provided) (?:approval|acceptance))' : '(?:if|when|once) (?:approved|accepted)';
      const conditional = new RegExp(`${approvalBoundary}(?:${declaredOwner} (?:(?:applies|holds) (?:only )?(?:if|when|once|unless) (?:approved|accepted)|is (?:conditional|contingent|dependent) on (?:approval|acceptance)|requires (?:approval|acceptance))|${approvalPremise},? (?:use|adopt|accept|keep|proceed|choose|preserve)\\b)`, 'i');
      if (ownClosed.test(text) || conditional.test(text)) return false;
      if (scopedLibraryHooks) {
        const workers = /(?:^|[.!?]\s+)The plan writes its own\s+loop inside each of the ([1-9]\d*) workers\./i.exec(assessment)?.[1] ??
          /(?:^|[.!?]\s+)The plan says \([A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?\) to ignore it and hand-roll a scheduler inside each of the ([1-9]\d*) workers\b/i.exec(assessment)?.[1];
        if (!workers || Number(workers) < 2) return false;
        const ids = q.options.map(o => /^([1-9]\d*)([A-D])[).:]\s+(\S[\s\S]*)$/.exec(o.label));
        if (ids.some(id => id?.[1] !== libraryHooks[1]) || new Set(ids.map(id => id![2])).size !== q.options.length) return false;
        const actions = ids.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
        const repair = actions.findIndex(action => /^Library hooks? \+ (?:custom curve|shared backoff fn)$/i.test(action));
        const keep = actions.findIndex(action => /^Custom inline scheduler as planned$/i.test(action) ||
          new RegExp(`^Proceed as planned \\(inline in ${workers} workers\\)$`, 'i').test(action));
        if (repair < 0 || keep < 0 || repair === keep) return false;
        const remedy = current(q.options[repair]!.description ?? '').trim(), unchanged = current(q.options[keep]!.description ?? '').trim();
        const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose|preserve|register)\b/i;
        if ([remedy, unchanged].some(value => framed.test(value.split('❌')[0]!) || closed.test(value) || ownClosed.test(value) || conditional.test(value) || cancelled.test(value)) ||
            /\bthe library will not own (?:persistence|attempt counting|crash safety)\b/i.test(remedy) ||
            /\b(?:the|this) (?:unchanged |per-worker )?scheduler is (?:now |already )?crash-safe\b|\bretry state no longer lives in-process\b/i.test(unchanged)) return false;
        const persisted = /^(?:✅\s*)?Retry state persisted by the library: [^.!?✅❌]*\bsurvives\b[^.!?✅❌]*\b(?:crash|restart|deploy)\b[^.!?✅❌]*/i.exec(remedy);
        const registered = /^Register the library's retry hook in each worker, pass one shared pure [A-Za-z_$][\w$]*\(attempt\) for the curve\./i.test(remedy);
        const lost = /(?:^|❌\s*)Retry state lives in process memory: [^.!?✅❌]*\b(?:crash|restart)\b[^.!?✅❌]*\b(?:drops|loses)\b[^.!?✅❌]*\b(?:job|retry|retries)\b/i.exec(unchanged);
        const drift = /^Keep the plan as written\.[\s\S]*?\bRetries die with the process; ([a-z]+|[1-9]\d*) copies drift\./i.exec(unchanged);
        const count = drift && (/^[1-9]\d*$/.test(drift[1]!) ? Number(drift[1]) :
          ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(drift[1]!.toLowerCase()));
        return Boolean((registered || (persisted && !/\b(?:not|never|no longer)\b/i.test(persisted[0]))) &&
          ((lost && !/\b(?:not|never|no longer)\b/i.test(lost[0])) || (drift && count === Number(workers))));
      }
      if (!/^The job library already knows how to retry a failed job later; you just tell it how long to wait\. The plan instead rebuilds that waiting-and-rescheduling machinery by hand inside each worker\./.test(assessment) ||
          !/\bjobs get lost \(worker dies mid-sleep\)/.test(assessment) ||
          !/\bno attempt cap or dead-letter path\b/.test(assessment)) return false;
      const ids = q.options.map(o => /^([1-9]\d*)([A-D])[).:]\s+(\S[\s\S]*)$/.exec(o.label));
      if (ids.some(id => id?.[1] !== libraryHooks[1]) || new Set(ids.map(id => id![2])).size !== q.options.length) return false;
      const actions = ids.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
      const remedyIndex = actions.indexOf('Use library retry hook + custom curve fn');
      const unchangedIndex = actions.indexOf('Custom scheduler inline per worker, as planned');
      if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
      const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
      const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
      const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose|preserve)\b/i;
      if ([remedy, unchanged].some(value => framed.test(value.split("❌")[0]!) || closed.test(value) || ownClosed.test(value) || conditional.test(value) || cancelled.test(value)) ||
          /\bthe library will not own (?:persistence|attempt counting|crash safety)\b/i.test(remedy) ||
          /\b(?:the|this) (?:unchanged |per-worker )?scheduler is (?:now |already )?crash-safe\b|\bretry state no longer lives in-process\b/i.test(unchanged)) return false;
      return /^✅\s*Persistence, attempt counting, max-attempts, and dead-letter come from the library; you own only delay\(attempt\) with full jitter\b/.test(remedy) &&
        /✅\s*Curve is still 100% yours: a pure function, trivially unit-tested\./.test(remedy) &&
        /❌\s*Retry state lives in-process, so a crash or deploy mid-backoff drops the retry; (?:[a-z]+|[1-9]\d*) copies of scheduler logic drift\b/.test(unchanged);
    }
    const workers = /^The plan rebuilds retry scheduling by hand inside each of ([1-9]\d*) workers\b/.exec(assessment)?.[1];
    if (!workers || Number(workers) < 2 ||
        !/\bpersisting attempt counts across process restarts, not double-scheduling when a worker crashes mid-dispatch\b/.test(assessment) ||
        !/\bthe plan does not mention any of it\./.test(assessment)) return false;
    const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
    if (optionIds.some(id => id?.[1] !== libraryHooks[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
    const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
    const remedyIndex = actions.indexOf('Library hooks + custom backoff fn');
    const unchangedIndex = actions.indexOf('Proceed as written (inline in each worker)');
    if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
    const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
    const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
    const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose)\b/i;
    if (framed.test(remedy) || framed.test(unchanged) || closed.test(remedy) || closed.test(unchanged) ||
        cancelled.test(remedy) || cancelled.test(unchanged) ||
        /\bthe library will not own (?:attempt counting|crash safety)\b|\b(?:do not|don't|never|cancel|withdraw) preserve the exported backoff function\b/i.test(remedy) ||
        /\bthe unchanged per-worker scheduler is (?:now )?crash-safe\b/i.test(unchanged)) return false;
    const risk = /❌\s*([A-Za-z]+|[1-9]\d*) copies of crash-unsafe scheduling logic, each drifting independently; every bug gets fixed ([A-Za-z]+|[1-9]\d*) times\./.exec(unchanged);
    const number = (value: string) => /^[1-9]\d*$/.test(value) ? Number(value) :
      ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(value.toLowerCase());
    return Boolean(risk && number(risk[1]!) === Number(workers) && number(risk[2]!) === Number(workers) &&
      /✅\s*Attempt counting, crash safety, and dashboard visibility come from the library for free\./.test(remedy) &&
      /✅\s*The backoff curve lives in one exported function, so\s+is preserved and testable in isolation\./.test(remedy));
  }
  // A cache-ownership brief can name its actors in the current assessment
  // instead of the headline. Bind those actors to the offered single writer.
  const cacheOwner = /^(?:Issue|Finding) ([1-9]\d*): two services mutate (?:one|the same) shared cache with no (?:serialized writes|serialization)\. How should cache ownership work\?$/i.exec(title);
  if (cacheOwner) {
    if (!/^(?:Cache owner(?:ship)?|Shared cache)$/i.test(q.header.trim()) &&
        !new RegExp(`^(?:Issue|Finding|Architecture) ${cacheOwner[1]}$`, 'i').test(q.header.trim())) return false;
    const current = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/["“](withdrawn|rejected|cancelled|canceled|resolved|closed|not current)["”]/gi, '$1')
      .replace(/"[^"\n]*"|“[^”\n]*”|`[^`]*`/g, '');
    const framing = /\b(?:source|quoted|historical|hypothetical|proposed|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|text)\b|(?:^|\n|:\s*)(?:if|unless|suppose|imagine)\b/i;
    const withdrawn = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|race|single-writer requirement)|Issue ${cacheOwner[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|defect|finding) (?:remains|exists)\\b`, 'i');
    const text = current(q.question), assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const prefix = text.slice(text.indexOf('\n') + 1, assessments[0]?.index ?? 0).trim().split('\n').filter(Boolean);
    const actors = assessments.length === 1 && /^([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both (?:write into|mutate) the same (?:tenant-keyed )?cache, and the plan says nothing orders those writes\./.exec(assessments[0]![1]!);
    if (!actors || actors[1] === actors[2] || !prefix.length ||
        !prefix.every(line => /^Project\/branch\/task:/.test(line)) || framing.test(text) || withdrawn.test(text)) return false;
    const ids = q.options.map(option => /^([A-D])\)\s+/.exec(option.label)?.[1]);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) return false;
    const active = (description: string) => !framing.test(description) && !withdrawn.test(description) &&
      !/(?:^|[.!?]\s+)(?:Correction:\s*)?(?:do not|don't|never|cancel|withdraw) (?:inject|use|keep|apply)\b/i.test(description);
    return q.options.some(remedy => {
      const body = current(remedy.description ?? '').trim();
      const owner = /^Constructor-inject the existing adapter into both services\. Only ([A-Za-z_$][\w$]*) writes; ([A-Za-z_$][\w$]*) returns minted material to the broker, which stores it\./.exec(body);
      if (!owner || owner[1] === owner[2] || ![actors[1], actors[2]].includes(owner[1]) ||
          ![actors[1], actors[2]].includes(owner[2]) || !active(body)) return false;
      const otherWriter = new RegExp(`(?:^|[.!?]\\s+)(?:Correction:\\s*)?${owner[2]} (?:will |can |may |still )?(?:also )?write(?:s)? (?:directly )?(?:to|into) (?:the )?cache\\b`, 'i');
      if (otherWriter.test(body)) return false;
      return q.options.some(opposed => opposed !== remedy &&
        /^(?:[A-D]\) )?Keep (?:the )?module-level global as planned(?: \(recommended\))?$/i.test(opposed.label) &&
        /^Do nothing here; both services import and mutate the singleton\./.test(current(opposed.description ?? '').trim()) &&
        /❌\s*Race stays open and tests share mutable state across the whole suite\./.test(current(opposed.description ?? '')) &&
        active(current(opposed.description ?? '')));
    });
  }
  // A descriptive native header can carry the decision ordinal while the
  // current brief owns the architecture finding and its cache remedy.
  const injected = /^Module-level ([A-Za-z_$][\w$]*) singleton (?:→|->) constructor injection with a single writer\?$/i.exec(title);
  if (injected) {
    const ordinal = /^D([1-9]\d*)\s*[—–:-]/i.exec(q.question);
    if (!ordinal || !new RegExp(`^D${ordinal[1]} DI$`, 'i').test(q.header.trim())) return false;
    const current = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/["“](withdrawn|rejected|cancelled|canceled|resolved|closed|not current)["”]/gi, '$1')
      .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '');
    const text = current(q.question), assessment = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const preface = text.slice(text.indexOf('\n') + 1, assessment[0]?.index ?? 0).trim().split('\n').filter(Boolean);
    const framing = /\b(?:source|quoted|historical|hypothetical|proposed|unrelated|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|text)\b|(?:^|\n)\s*(?:if|unless|suppose|imagine)\b/i;
    const finding = /\bArchitecture finding (A[1-9]\d*)\b/.exec(preface.join(' '));
    const closed = /\b(?:this|the|that) (?:finding|issue|gap|remedy|amendment|explanation|assessment) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\b|\bno current (?:gap|defect|finding) (?:remains|exists)\b|\bno longer (?:share|write|mutate)\b/i;
    if (assessment.length !== 1 || !finding || !preface.length ||
        !preface.every(line => /^Project\/branch\/task:/.test(line)) || framing.test(preface.join(' ')) ||
        /\b(?:if|unless|when|suppose|imagine)\b/i.test(preface.join(' ').slice(0, finding.index)) ||
        !q.question.split('\n').some(line => /^Project\/branch\/task:/.test(line) && new RegExp(`\\b${injected[1]}\\b`).test(line)) ||
        !/^(?:Right now|Today) both services (?:grab|import) the same global cache (?:object|instance) from a module import and both (?:write to|mutate) it\./i.test(assessment[0]![1]!) ||
        framing.test(assessment[0]![1]!) || closed.test(text)) return false;
    const letters = q.options.map(o => /^([A-D])\)\s+/.exec(o.label)?.[1]);
    const recommendation = /^Recommendation: ([A-D]) because\b/m.exec(text)?.[1];
    if (letters.some(letter => !letter) || new Set(letters).size !== letters.length ||
        !recommendation || !letters.includes(recommendation) ||
        q.options.filter(o => /\(recommended\)/i.test(o.label)).length !== 1 ||
        !q.options[letters.indexOf(recommendation)]!.label.toLowerCase().includes('(recommended)')) return false;
    const affirmative = (option: typeof q.options[number]) => {
      const body = current(option.description ?? '').trim();
      if (!/^✅/.test(body) || framing.test(body) || closed.test(body)) return [];
      return [...body.matchAll(/✅\s*([^✅❌]+)/g)].map(m => m[1]!.trim()).filter(pro =>
        !/^(?:if|unless|when|source|historical|hypothetical|example|previously)\b/i.test(pro));
    };
    const remedy = q.options.find(o => /^[A-D]\) Composition-root injection, single writer(?: \(recommended\))?$/i.test(o.label));
    const unchanged = q.options.find(o => /^[A-D]\) Do nothing(?: \(recommended\))?$/i.test(o.label));
    const owner = remedy && affirmative(remedy).map(pro => /^([A-Za-z_$][\w$]*) is the only session writer and ([A-Za-z_$][\w$]*) gets a read-only port, enforced by types not convention\./.exec(pro)).find(Boolean);
    const remaining = unchanged && current(unchanged.description ?? '').trim();
    return Boolean(owner && owner[1] !== owner[2] && remaining && /^✅/.test(remaining) &&
      !framing.test(remaining) && !closed.test(remaining) &&
      new RegExp(`❌\\s*Both ${finding[1]} failure scenarios stay live and the plan's own test coverage cannot isolate state\\.$`).test(remaining));
  }
  // The category can live in the title while the header carries the issue
  // number. Require the direct shared-state defect and technical choices;
  // an Issue heading on setup or report navigation is insufficient.
  const sharedWriters = /^(Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)\s+\(Architecture\)\s*[—–:-]\s*([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both mutate (?:one|the same) shared cache with no owner and no serialization\. How should shared[- ]state access be structured\?$/i.exec(title);
  if (sharedWriters) {
    const header = /^(Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)$/i.exec(q.header.trim());
    if (!header || header[1]!.toLowerCase() !== sharedWriters[1]!.toLowerCase() ||
        header[2] !== sharedWriters[2] || sharedWriters[3] === sharedWriters[4] || q.options.length !== 3 ||
        q.options.some(option => !option.description?.trim())) return false;
    const labels = q.options.map(option => option.label.trim()
      .replace(/^[1-9]\d*[A-Z]\)\s*/i, '').replace(/\s*\(recommended\)$/i, ''));
    return [
      /^Constructor[- ]inject the adapter; single[- ]writer ownership per operation; per[- ]key serialization on the [A-Za-z][\w-]* path; race test$/i,
      /^Constructor[- ]inject the adapter only; both services keep writing freely$/i,
      /^Keep the module[- ]level shared export as planned$/i,
    ].every(pattern => labels.filter(label => pattern.test(label)).length === 1);
  }
  const issue = /^(?:Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)(?:\s*\(D[1-9]\d*\))?\s*[—–:-]\s*([^\n?]+\?)$/i.exec(title);
  const header = /^(?:Arch(?:itecture)?|Code\s+Q(?:uality)?|Tests?|Perf(?:ormance)?)\s+([1-9]\d*(?:\.[1-9]\d*)*)$/i.exec(q.header.trim());
  if (!issue || !header || issue[1] !== header[1]) return false;
  // A title number or verb can also label report administration. Keep the
  // concrete defect, implementation query and offered technical alternatives
  // together. Unknown issue families remain on the existing qid paths.
  const label = (s: string) => s.trim().replace(/^[1-9]\d*[A-Z]\)\s*/i, '').replace(/\s*\(recommended\)$/i, '');
  const alternatives = (a: RegExp, b: RegExp) => [a, b].every(pattern =>
    q.options.some(option => pattern.test(label(option.label)) && Boolean(option.description?.trim())));
  const body = issue[2]!;
  // An imperative can ask for the same owned cache amendment that the older
  // numbered form states as a defect. Bind the current actors and both offered
  // outcomes; an Issue label or the word "inject" cannot open review alone.
  const injectedExport = /^Replace the module-level mutable ([A-Za-z_$][\w$]*) export with injected ownership\?$/i.exec(body);
  if (injectedExport) {
    if (!/^[1-9]\d*$/.test(issue[1]!) || !/^Arch(?:itecture)? [1-9]\d*$/i.test(q.header.trim())) return false;
    const current = (text: string) => text
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
      .replace(/["“](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)["”]/gi, '$1')
      .replace(/"[^"\n]*"|“[^”\n]*”/g, '')
      .replace(/`([^`\n]*)`/g, (_, code: string) => /^[A-Za-z_$][\w$]*$/.test(code) ? code : '')
      .replace(/\*\*/g, '');
    const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
    const closed = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${issue[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
    const removedGlobal = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:this|the|that) cache no longer has a module-level mutable export\b/i;
    const text = current(q.question), lines = text.split('\n');
    const contexts = lines.filter(line => /^Project\/branch\/task: \S/.test(line));
    const assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const preface = text.slice(0, assessments[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
    if (contexts.length !== 1 || assessments.length !== 1 || preface.length !== 1 || preface[0] !== contexts[0] ||
        framed.test(text) || closed.test(text) || removedGlobal.test(text)) return false;
    const assessment = assessments[0]![1]!;
    if (!/^(?:Right now|Today) the cache is a global variable that two different services reach into and change\./i.test(assessment)) return false;
    const actors = /\ba bug in ([A-Za-z_$][\w$]*) can silently corrupt what ([A-Za-z_$][\w$]*) reads\./.exec(assessment);
    if (!actors || actors[1] === actors[2]) return false;
    const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
    if (optionIds.some(id => id?.[1] !== issue[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
    const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
    const remedyIndex = actions.indexOf(`Inject ${injectedExport[1]}`), unchangedIndex = actions.indexOf('Do nothing');
    if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
    const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
    const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
    const removalCancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:delete|remove) the module-level export\b/i;
    const acceptanceCancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) accept the shared global as-is\b/i;
    if (framed.test(remedy) || framed.test(unchanged) || closed.test(remedy) || closed.test(unchanged) ||
        removalCancelled.test(remedy) || acceptanceCancelled.test(unchanged)) return false;
    const injection = /^Construct one ([A-Za-z_$][\w$]*) at the composition root, pass it into ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) constructors, (?:delete|remove) the module-level export, add a test that two service instances with separate caches never observe each other\./.exec(remedy);
    return Boolean(injection && injection[1] === injectedExport[1] && injection[2] !== injection[3] &&
      [injection[2], injection[3]].every(actor => actor === actors[1] || actor === actors[2]) &&
      /^Accept the shared global as-is\./.test(unchanged) &&
      /❌\s*Documented [A-Za-z][\w-]* footgun for testability and request isolation; tenant leakage risk (?:stays|remains)\b/.test(unchanged));
  }
  return (
    /^[A-Za-z_$][\w$]* is a (?:global|shared) mutable module-level export that (?:two|multiple|\d+) services mutate\. Inject it(?: instead)?\?$/i.test(body) &&
      alternatives(/^Constructor[- ]inject$/i, /^Getter \+ reset hook$/i)
  ) || (
    /^Two writers, no serialization: an? [A-Za-z_$][\w$]* write can land after an? [A-Za-z_$][\w$]* invalidation and resurrect a revoked token\. (?:Guard it|Serialize the writes)\?$/i.test(body) &&
      alternatives(/^Invalidation epoch in [A-Za-z_$][\w$]*$/i, /^Re-check before write$/i)
  ) || (
    /^[A-Za-z_$][\w$]*\(\) is \d+ lines with (?:two|three|multiple|\d+) nested try\/catch blocks that each swallow a different error class\. Restructure it\?$/i.test(body) &&
      alternatives(/^Split \+ typed Result$/i, /^Flatten \+ log$/i)
  ) || (
    /^Planned coverage is unit \+ integration on the new components only\. Add an? end-to-end [\w -]+ test across (?:two|multiple|\d+) tenants\?$/i.test(body) &&
      alternatives(/^Add E2E journey test$/i, /^Facade isolation test only$/i)
  ) || (
    /^Token validation makes \d+ sequential [A-Za-z_$][\w$]* calls that are independent\. Parallelize, and with what failure semantics\?$/i.test(body) &&
      alternatives(/^Promise\.all \+ timeouts \+ typed errors$/i, /^Bare Promise\.all$/i)
  );
}

/** An answered substantive finding can start review even in a mixed setup packet. */
export const engFirstReviewAUQ: Step0BoundaryPredicate = (fp) => {
  if (engNumberedFindingAUQ(fp) || engExplicitRepairAUQ(fp) || engArchitectureChoiceAUQ(fp) || engDependencyBindingAUQ(fp) || engSharedMutableCacheAUQ(fp)) return true;
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  return call.questions.some(q => {
    if (!call.answers?.[q.question]) return false;
    // These are review section identities, including the registry's
    // arch-finding/test-gap IDs. Scope and onboarding IDs cannot qualify.
    const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1] ?? '';
    if (/^plan-eng-(?:review-)?(?:arch(?:itecture)?|quality|test|perf(?:ormance)?)-(?:focus|mode|setup|routing|learnings|prerequisite|onboarding|next-steps?)(?:-|$)/i.test(id)) return false;
    const title = `${q.header} ${q.question.split('\n')[0]}`.replace(/<gstack-qid:[^>]*>/gi, '');
    return /^plan-eng-(?:review-)?(?:arch(?:itecture)?|quality|test|perf(?:ormance)?)-/i.test(id) &&
      /\b(?:issue|finding|gap)\b/i.test(title);
  });
};

/** A skipped optional prerequisite can share one completed native setup call. */
function engSetupPacketBoundary(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false || call.questions.length !== 2 ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 2 || !Number.isFinite(Date.parse(call.answeredAt ?? '')) ||
      JSON.stringify(fp.options) !== JSON.stringify(nativePlanCallFingerprint(call, 0, true).options)) return false;
  const projected = call.questions.map(q => {
    if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
        new Set(q.options.map(o => o.label)).size !== q.options.length ||
        q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return null;
    return nativePlanCallFingerprint({ ...call, questions: [q],
      answers: { [q.question]: call.answers![q.question]! } }, fp.observedAtMs, true);
  });
  return projected.some((prerequisite, i) => {
    if (!prerequisite || !projected[1 - i]) return false;
    const skip = planCountPrerequisitePick(prerequisite);
    return skip !== null && prerequisite.options.find(o => o.index === skip)?.label ===
      call.answers?.[call.questions[i]!.question] && engSetupAUQ(projected[1 - i]!);
  });
}

export const engStep0Boundary: Step0BoundaryPredicate = (fp) =>
  engSetupPacketBoundary(fp) ||
  engSetupAUQ(fp) ||
  /scope\s*reduction\s*recommendation|cross[\s-]*project\s*learnings/i.test(
    fp.promptSnippet,
  ) ||
  // plan-eng-review's Step 0 may legitimately end with NO scope-reduction /
  // learnings AUQ. When it does, the first answered review-phase question —
  // tagged <gstack-qid:plan-eng-review-...> ({skill}-{slug} convention) —
  // must fire the boundary, or every per-finding AUQ stays classified
  // preReview and the multi-finding batching counter reads 0. Anchor allows
  // the skill-name prefix; live qids observed: plan-eng-review-jitter,
  // plan-eng-review-idempotency, plan-eng-review-todos-e2e-concurrent.
  /gstack-qid:\s*(?:plan-)?eng-review-/i.test(fp.promptSnippet);

export const designStep0Boundary: Step0BoundaryPredicate = (fp) =>
  /design\s*(?:system|posture|score|completeness)|first\s*dimension/i.test(
    fp.promptSnippet,
  );

/** Positive review identity when a design run goes directly to findings without a focus AUQ. */
export const designFirstReviewAUQ: Step0BoundaryPredicate = (fp) => {
  // A numbered setup decision is not sufficient. Require the design review's
  // question ID as well, and exclude its scope/focus/onboarding identities.
  const id = /<gstack-qid:\s*plan-design-review-([a-z0-9-]+)/i.exec(fp.promptSnippet)?.[1];
  if (id && /(?:^|[│\s])D\s*\d+\s*[—–-]/i.test(fp.promptSnippet) &&
      !/(?:^|-)(?:scope|focus|setup|routing|onboarding|posture|mockups?|target)(?:-|$)/i.test(id) &&
      !designStep0Boundary(fp)) return true;
  // Explicit pass headings are also review evidence; an initial assessment
  // that merely mentions reviewing seven passes does not match this shape.
  return /(?:^|│)\s*Pass\s*[1-7]\s*(?:\([^)]*\)\s*)?[—–:]/i.test(fp.promptSnippet);
};

export const devexStep0Boundary: Step0BoundaryPredicate = (fp) =>
  /developer\s*persona|target\s*persona|persona\s*selection|TTHW\s*target/i.test(
    fp.promptSnippet,
  );

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

  let buffer = '';
  let exited = false;
  let exitCodeCaptured: number | null = null;

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

  // Construction must succeed before any CLI can be spawned.
  const screen = opts.observeScreen ? await createPtyScreen(cols, rows) : undefined;
  let screenClosing: Promise<void> | undefined;
  let screenFailure: unknown;
  const disposeScreen = () => screenClosing ??= (screen?.dispose() ?? Promise.resolve()).catch(error => { screenFailure = error; });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proc: any;
  let pendingExit: ReturnType<typeof createPendingExitRecorder> | undefined;
  let pendingQuestion: ReturnType<typeof createPendingQuestionRecorder> | undefined;
  let pendingArtifact: ReturnType<typeof createAutoplanArtifactRecorder> | undefined;
  const pendingFiles: Array<{ expected: string; recorder: NonNullable<ReturnType<typeof createFilePermissionRecorder>> }> = [];
  try {
    if (opts.observePlanReady && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
      pendingExit = createPendingExitRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR);
    }
    if (opts.observeSetupQuestions && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
      pendingQuestion = createPendingQuestionRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR);
    }
    if (opts.observeAutoplanArtifacts && hermetic && childEnv.CLAUDE_CONFIG_DIR && hermeticSkillStateRoot) {
      pendingArtifact = createAutoplanArtifactRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR, hermeticSkillStateRoot);
    }
    if (opts.observeFilePermissions && hermetic && childEnv.CLAUDE_CONFIG_DIR) {
      for (const expected of new Set(opts.observeFilePermissions)) {
        const recorder = createFilePermissionRecorder(cwd, childEnv.CLAUDE_CONFIG_DIR, expected);
        if (recorder) pendingFiles.push({ expected, recorder });
      }
    }
    if (pendingFiles.length || pendingQuestion || pendingArtifact) {
      const hooks = pendingExit ? JSON.parse(pendingExit.settings).hooks : {};
      for (const recorder of [...pendingFiles.map(p => p.recorder), ...(pendingQuestion ? [pendingQuestion] : []), ...(pendingArtifact ? [pendingArtifact] : [])]) for (const [event, entries] of Object.entries(recorder.hooks))
        hooks[event] = [...(hooks[event] ?? []), ...entries];
      args.push('--settings', JSON.stringify({hooks}));
    } else if (pendingExit) args.push('--settings', pendingExit.settings);
    proc = (Bun as any).spawn([claudePath, ...args], {
    terminal: {
      cols,
      rows,
      data(_t: unknown, chunk: Buffer) {
        const text = chunk.toString('utf-8');
        buffer += text;
        if (screen && !screenClosing) screen.write(text);
      },
    },
    cwd,
    env: childEnv,
  }); } catch (error) { pendingFiles.forEach(({ recorder }) => recorder.dispose()); pendingExit?.dispose(); pendingQuestion?.dispose(); pendingArtifact?.dispose(); await disposeScreen(); throw error; }

  // Track exit so waitForAny can fail fast if claude crashes.
  let exitedPromise: Promise<void> = Promise.resolve();
  if (proc.exited && typeof proc.exited.then === 'function') {
    exitedPromise = proc.exited
      .then(async (code: number | null) => {
        exitCodeCaptured = code;
        exited = true;
        await disposeScreen();
      })
      .catch(async () => {
        exited = true;
        await disposeScreen();
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
  // window, after both choices and the selected cursor are visible. Newer
  // unnumbered menus default to "No, exit", so "1\r" would reject trust.
  // The first paint can precede the input handler's readiness. Let startup
  // settle, then deliver navigation and confirmation as separate events.
  let trustHandled = false;
  let trustVisibleAt: number | undefined;
  const trustInputTimers: ReturnType<typeof setTimeout>[] = [];
  const trustWatcher = setInterval(() => {
    if (trustHandled || exited) return;
    const input = trustDialogInput(buffer);
    if (input !== null) {
      trustVisibleAt ??= Date.now();
      if (Date.now() - trustVisibleAt < 1_500) return;
      trustHandled = true;
      const keys = input.match(/\x1b\[[AB]|\r/g) ?? [];
      for (const [i, key] of keys.entries()) {
        trustInputTimers.push(setTimeout(() => {
          if (exited) return;
          try { proc.terminal?.write?.(key); } catch { /* ignore */ }
        }, i * 500));
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
    for (const timer of trustInputTimers) clearTimeout(timer);
    if (exited) { pendingFiles.forEach(({ recorder }) => recorder.dispose()); pendingExit?.dispose(); pendingQuestion?.dispose(); pendingArtifact?.dispose(); await disposeScreen(); return; }
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
    pendingFiles.forEach(({ recorder }) => recorder.dispose());
    pendingExit?.dispose();
    pendingQuestion?.dispose(); pendingArtifact?.dispose();
    await disposeScreen();
  }

  return {
    send,
    sendKey,
    rawOutput: () => buffer,
    visibleText: () => stripAnsi(buffer),
    currentScreen: async () => {
      if (!screen) throw new Error('PTY screen observation was not enabled for this session.');
      if (screenClosing) await screenClosing;
      if (screenFailure) throw new Error('PTY screen observation failed.', { cause: screenFailure });
      return screen.read();
    },
    mark,
    visibleSince,
    waitForAny,
    waitFor,
    pid: () => proc.pid as number | undefined,
    exited: () => exited,
    exitCode: () => exitCodeCaptured,
    hermeticConfigDir: hermetic ? childEnv.CLAUDE_CONFIG_DIR ?? null : null,
    hermeticSkillStateRoot,
    pendingPlanReadyFile: pendingExit?.file,
    pendingQuestionFile: pendingQuestion?.file,
    pendingAutoplanArtifactFile: pendingArtifact?.file,
    pendingFilePermissionFiles: pendingFiles.map(({ expected, recorder }) => ({ expected, file: recorder.file })),
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
  /** Exact owned public-native annotation when terminal redraws lose it. */
  nativeAutoDecide?: NativeAutoDecision;
  /** Persisted public diagnostics for this attempt, when eval recording is enabled. */
  artifactDir?: string;
  artifactError?: string;
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
   *  - 'wrote_findings_before_asking' — strictPlanWrites only (seeded runs):
   *                     the plan file was rewritten with findings before any
   *                     AskUserQuestion render (the May-2026 transcript bug)
   *  - 'exited'       — claude process died before any of the above
   *  - 'timeout'      — none of the above within budget
   */
  outcome:
    | 'asked'
    | 'auto_decided'
    | 'plan_ready'
    | 'silent_write'
    | 'wrote_findings_before_asking'
    | 'exited'
    | 'timeout';
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
  /**
   * High-water-mark flag: did the polling loop ever observe a
   * prose-rendered AskUserQuestion (lettered or numbered options visible)
   * during the run? Set true the first poll iteration that
   * isProseAUQVisible returns true on the recent buffer; remains true
   * for the rest of the observation.
   *
   * The 2KB `evidence` window often misses the prose-AUQ moment because
   * by the time outcome=plan_ready fires, the ExitPlanMode "Ready to
   * execute" UI has pushed the options out of the tail. Tests that need
   * to assert "the user saw the question at SOME point" should check
   * this flag rather than re-running isProseAUQVisible on the truncated
   * evidence.
   */
  proseAUQEverObserved?: boolean;
  /**
   * High-water-mark flag: did the LLM judge ever return state='waiting'
   * during the run? Same shape as proseAUQEverObserved but driven by the
   * Haiku judge fallback rather than the regex detector.
   */
  waitingEverObserved?: boolean;
  /**
   * High-water-mark flag: did the scope-gate QUESTION ("What should I
   * review?" plus option-body text) ever render during the run? Same
   * lossy-2KB-evidence rationale as proseAUQEverObserved. The plan-mode
   * smokes assert this stays false (gate bypassed via auto-select B); the
   * no-op regression asserts it fires outside plan mode.
   */
  scopeGateQuestionObserved?: boolean;
  /**
   * High-water-mark flag: did the plan-mode auto-select announcement
   * ("Scope gate: plan mode — auto-selected B …") ever render? The
   * plan-mode smokes assert true; the no-op regression asserts false.
   */
  scopeGateAutoSelectObserved?: boolean;
  /**
   * High-water map for opts.trackTokens: token → did it EVER appear in the
   * cumulative visible buffer? Consumption asserts (e.g. "the pasted target's
   * distinctive token shows up in the review output") must not depend on the
   * lossy 2KB evidence tail — plan-file fallbacks are unreachable outside
   * plan mode (extractPlanFilePath only matches plan-mode save renders).
   */
  tokensObserved?: Record<string, boolean>;
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
  /** Keep observing a judge-only waiting verdict when the caller requires
   * a rendered prose choice list. Deterministic terminal outcomes retain
   * precedence; this does not grant prose credit to a judge verdict. */
  requireProseEvidence?: boolean;
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
  /**
   * Seed an initial plan that the spawned `claude` process operates on.
   * STOP-gate regression tests need a plan with guaranteed-finding-triggering
   * complexity (8+ files, custom-vs-builtin smell) so the skill MUST emit
   * AskUserQuestion or fall back to a Decisions section. Without this,
   * plan-mode creates a fresh empty plan and the skill has nothing to find
   * issues with.
   *
   * Implementation: claude has no `--plan-file` flag (verified via
   * `claude --help`). We pre-pump a user message containing the draft
   * plan, wait for it to register, then invoke the skill. The skill's
   * Step 0 reads the prior conversation context so it sees the draft.
   */
  initialPlanContent?: string;
  /** Override the spawned model. Defaults via launchClaudePty's chain
   *  (opts.model ?? EVALS_MODEL ?? resolveEvalModel('capture')). */
  model?: string;
  /** Literal tokens to track as high-water marks over the CUMULATIVE visible
   *  buffer (case-sensitive). Results land in obs.tokensObserved. Use for
   *  consumption asserts that must survive the 2KB evidence tail. */
  trackTokens?: string[];
}): Promise<PlanSkillObservation> {
  const startedAt = Date.now();
  // Explicitly identify only a new seeded plan-mode session. Caller-owned
  // resume/session arguments retain their existing behavior.
  const scopeSessionId = opts.initialPlanContent && opts.inPlanMode !== false &&
    !opts.extraArgs?.some(arg => /^(?:--session-id|--resume|--continue|-r|-c)(?:=|$)/.test(arg))
    ? randomUUID() : undefined;
  const session = await launchClaudePty({
    permissionMode: opts.inPlanMode === false ? null : 'plan',
    cwd: opts.cwd,
    timeoutMs: (opts.timeoutMs ?? 180_000) + 30_000,
    extraArgs: [...(opts.extraArgs ?? []), ...(scopeSessionId ? ['--session-id', scopeSessionId] : [])],
    env: opts.env,
    model: opts.model,
    seedSkills: true,
    observeScreen: !!opts.initialPlanContent,
  });

  try {
    // Boot grace + trust-dialog auto-handle.
    await Bun.sleep(8000);
    if (opts.initialPlanContent) {
      // Pre-pump the draft as a user message so the skill's Step 0 has
      // concrete content to scope-challenge. The trailing `\r` submits
      // the message; embedded `\n` are preserved as line breaks within
      // the message (claude-code uses Enter to send, Shift+Enter for
      // newlines, but raw `\r` from a PTY just submits whatever's in
      // the input buffer).
      const seed = `Please review the following draft plan when I run the skill below:\n\n${opts.initialPlanContent}`;
      session.send(`${seed}\r`);
      // Wait for the seed message to render before sending the skill
      // command. Without this gap the two messages can fuse and the
      // skill name becomes part of the user prompt instead of a slash
      // command.
      await Bun.sleep(3000);
    }
    const commandStartedAt = Date.now();
    const since = session.mark();
    session.send(`/${opts.skillName}\r`);

    const budgetMs = opts.timeoutMs ?? 180_000;
    const start = Date.now();
    let lastJudgeAt = 0;
    let lastJudgeVerdict: PtyStateVerdict | null = null;
    // High-water marks: did we EVER see a prose-AUQ surface or a judge
    // 'waiting' verdict during the run? Models may surface options
    // briefly, then resume thinking when no user response comes (test
    // env has no responder). At timeout we trust historical signals
    // even if the current state is 'working'.
    let proseAUQEverObserved = false;
    let waitingEverObserved = false;
    let scopeGateQuestionObserved = false;
    let scopeGateAutoSelectObserved = false;
    let scopeTranscript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
    let scopeTools: NativePublicToolEvent[] = [];
    let nativeAutoDecide: NativeAutoDecision | null = null;
    let nativePolledAt: number | null = null;
    const saveSnapshot = createPlanCountSnapshotWriter();
    const tokensObserved: Record<string, boolean> = {};
    for (const t of opts.trackTokens ?? []) tokensObserved[t] = false;
    // Single source for the high-water flags at EVERY return site. Hand-
    // spreading them per-site already drifted once (the judge-waiting return
    // omitted the prose/waiting flags); a site that forgets a must-stay-false
    // flag makes `obs.flag ?? false` negative assertions pass vacuously.
    const highWaterFlags = () => {
      const flags = { proseAUQEverObserved, waitingEverObserved,
        scopeGateQuestionObserved, scopeGateAutoSelectObserved,
        ...(nativeAutoDecide ? { nativeAutoDecide } : {}),
        ...(opts.trackTokens?.length ? { tokensObserved } : {}) };
      // Preserve the measured terminal flags and public evidence before the
      // hermetic session is removed, including when a later assertion fails.
      const artifacts = saveSnapshot({ skillName: opts.skillName,
        cwd: path.resolve(opts.cwd ?? process.cwd()), claudeConfigDir: session.hermeticConfigDir,
        raw: session.rawOutput(), visible: session.visibleSince(since),
        observation: { state: 'plan_skill_observation_terminal', ...flags,
          commandStartedAt, scopeSessionId, native: scopeTranscript, publicTools: scopeTools,
          nativePolledAt, nativeScope: 'Latest owned native poll, refreshed while observing; not an exhaustive terminal journal.' } });
      return { ...flags, ...artifacts };
    };
    const JUDGE_AFTER_MS = 60_000;
    const JUDGE_INTERVAL_MS = 30_000;
    while (Date.now() - start < budgetMs) {
      await Bun.sleep(2000);
      const visible = session.visibleSince(since);

      if (session.exited()) {
        return {
          outcome: 'exited',
          summary: `claude exited (code=${session.exitCode()}) before reaching a terminal outcome`,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
          ...highWaterFlags(),
        };
      }
      if (visible.includes('Unknown command:')) {
        return {
          outcome: 'exited',
          summary: `claude rejected /${opts.skillName} as unknown command (skill not registered in this cwd)`,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
          ...highWaterFlags(),
        };
      }

      const classified = classifyVisible(visible, {
        strictPlanWrites: !!opts.initialPlanContent,
        currentScreen: opts.initialPlanContent ? await session.currentScreen() : undefined,
      });
      const pendingSeededCompletion = !!opts.initialPlanContent &&
        isPlanReadyVisible(visible) && classified === null;

      // Cheap surface-tracking: did the model ever surface a prose AUQ in
      // this tick's recent buffer? Track once-true (high water).
      if (!proseAUQEverObserved && !pendingSeededCompletion && isProseAUQVisible(visible)) {
        proseAUQEverObserved = true;
        logPtySnapshot(visible, {
          testName: opts.skillName,
          elapsedMs: Date.now() - start,
          tag: 'prose-auq-surfaced',
        });
      }
      // Scope-gate render tracking (same high-water shape). Full-run
      // detection matters because the 2KB evidence tail usually scrolls
      // past the gate render before the outcome fires.
      if (!scopeGateQuestionObserved && isScopeGateQuestionVisible(visible)) {
        scopeGateQuestionObserved = true;
      }
      if (!scopeGateAutoSelectObserved && isScopeGateAutoSelectVisible(visible)) {
        scopeGateAutoSelectObserved = true;
      }
      // Keep reading after scope selection: an AUTO_DECIDE annotation may
      // arrive later, and a prior poll cannot establish its current ownership.
      if (scopeSessionId && opts.initialPlanContent && session.hermeticConfigDir) {
        scopeTools = [];
        scopeTranscript = readPlanCountTranscript(session.hermeticConfigDir,
          path.resolve(opts.cwd ?? process.cwd()), event => scopeTools.push(event));
        nativePolledAt = Date.now();
        if (!scopeGateAutoSelectObserved) scopeGateAutoSelectObserved = nativeSeededPlanSelection(scopeTranscript, scopeTools, {
          seed: opts.initialPlanContent, skillName: opts.skillName, sessionId: scopeSessionId, commandStartedAt,
        });
      }
      for (const t of opts.trackTokens ?? []) {
        if (!tokensObserved[t] && visible.includes(t)) tokensObserved[t] = true;
      }

      if (classified) {
        const obs: PlanSkillObservation = {
          ...classified,
          evidence: visible.slice(-2000),
          elapsedMs: Date.now() - startedAt,
          ...highWaterFlags(),
        };
        // Capture the plan file path on any outcome where one may have been
        // written. Gating only on 'plan_ready' missed two cases: (1) the
        // 'asked' outcome where the model wrote a plan partway through then
        // paused on a question, and (2) 'wrote_findings_before_asking' where
        // the bug is precisely that the plan was written. The
        // assertReviewReportAtBottom checks downstream gate on planFile
        // existing, not on the outcome.
        const planFile = extractPlanFilePath(visible);
        if (planFile) obs.planFile = planFile;
        return obs;
      }

      // Terminal classification retains precedence (including actual questions
      // and writes). Only an unclassified frame may use exact owned native prose.
      if (scopeSessionId) {
        nativeAutoDecide = findNativeAutoDecision(scopeTranscript, scopeTools, {
          skillName: opts.skillName, sessionId: scopeSessionId, commandStartedAt, now: Date.now(),
        });
        if (nativeAutoDecide) return {
          outcome: 'auto_decided',
          summary: 'owned native session emitted the exact AUTO_DECIDE preference annotation after loading the invoked skill',
          evidence: visible.slice(-2000), elapsedMs: Date.now() - startedAt,
          ...highWaterFlags(),
        };
      }

      // LLM judge fallback: if regex detectors didn't classify and we've
      // burned >60s with periodic ticks, ask Haiku "is the model waiting,
      // working, or hung?" Treat 'waiting' as 'asked' (model surfaced a
      // question via prose the regex couldn't reassemble). Snapshot the
      // visible buffer at each judge call when GSTACK_PTY_LOG=1.
      const elapsed = Date.now() - start;
      if (elapsed > JUDGE_AFTER_MS && Date.now() - lastJudgeAt > JUDGE_INTERVAL_MS) {
        lastJudgeAt = Date.now();
        logPtySnapshot(visible, { testName: opts.skillName, elapsedMs: elapsed, tag: 'judge-tick' });
        lastJudgeVerdict = judgePtyState(visible, { testName: opts.skillName });
        if (lastJudgeVerdict.state === 'waiting' && !pendingSeededCompletion) {
          waitingEverObserved = true;
          if (opts.requireProseEvidence && !proseAUQEverObserved) continue;
          return {
            outcome: 'asked',
            summary: `LLM judge: ${lastJudgeVerdict.reasoning} (state=waiting after ${Math.round(elapsed / 1000)}s)`,
            evidence: visible.slice(-2000),
            elapsedMs: Date.now() - startedAt,
            ...highWaterFlags(),
          };
        }
      }
    }

    // Timeout fallback: if we observed a prose-AUQ surface OR a judge
    // 'waiting' verdict at any point during the run, treat as 'asked'.
    // This catches the model-surfaced-then-resumed-thinking case where
    // by the time the timeout fires, the buffer has moved past the
    // options into spinner state but the question DID surface earlier.
    const finalVisible = session.visibleSince(since);
    if (proseAUQEverObserved || waitingEverObserved && !opts.requireProseEvidence) {
      return {
        outcome: 'asked',
        summary:
          `prose-AUQ surface observed during run (proseAUQEverObserved=${proseAUQEverObserved}, waitingEverObserved=${waitingEverObserved}); model surfaced the question and the test budget elapsed without a follow-up classification` +
          (lastJudgeVerdict
            ? ` (last LLM judge: ${lastJudgeVerdict.state} — ${lastJudgeVerdict.reasoning})`
            : ''),
        evidence: finalVisible.slice(-2000),
        elapsedMs: Date.now() - startedAt,
        ...highWaterFlags(),
      };
    }
    return {
      outcome: 'timeout',
      summary:
        `no terminal outcome within ${budgetMs}ms` +
        (lastJudgeVerdict
          ? ` (last LLM judge: state=${lastJudgeVerdict.state} — ${lastJudgeVerdict.reasoning})`
          : ''),
      evidence: finalVisible.slice(-2000),
      elapsedMs: Date.now() - startedAt,
      ...highWaterFlags(),
    };
  } finally {
    await session.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillCounting — drives a plan-* skill end-to-end through Step 0 then
// counts completed review-phase AskUserQuestion calls. The actual
// product asserted by the per-finding-count tests.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `runPlanSkillCounting` run. Includes both the count summary
 * (`step0Count`, `reviewCount`, `administrativeCount`) and the full fingerprint list for diagnostic
 * dumps when an assertion fails.
 */
export interface PlanSkillCountObservation {
  /** Durable full raw/visible PTY output plus JSON observation, when EVALS_RUN_ID is set. */
  artifactDir?: string;
  artifactError?: string;
  outcome:
    | 'plan_ready'
    | 'completion_summary'
    | 'ceiling_reached'
    | 'silent_write'
    | 'transcript_unavailable'
    | 'no_review_questions'
    | 'exited'
    | 'timeout';
  summary: string;
  /** Visible terminal text at terminal time (last 3KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /** All distinct AskUserQuestions observed, in observation order. */
  fingerprints: AskUserQuestionFingerprint[];
  /** Actual native calls, including unanswered/failed ones that add no coverage. */
  transcript: PlanCountTranscript;
  /** Setup questions; administrative calls are excluded. */
  step0Count: number;
  /** Review questions; administrative calls are excluded. */
  reviewCount: number;
  /** Answered administrative handoffs and artifact rendering, preserved separately. */
  administrativeCount: number;
}

/**
 * Drive a plan-* skill in plan mode and count distinct native review-phase
 * AskUserQuestions until a terminal signal fires. Each run disables the
 * extra outside review in its own gstack config: independent reviewers can
 * add valid findings unrelated to the seeded-N cadence band. These counts
 * do not assert outside-review dispatch or its approval-question cadence.
 *
 * Flow:
 *   1. Seed the complete fixture request in an isolated git repository's
 *      PLAN.md and initial CLAUDE.md context, with owned native-only config,
 *      then boot the PTY in that cwd
 *      (8s grace + auto-trust dialog). Skills remain registered in user scope.
 *   2. Send `slashCommand` alone. The fixture is already in context; sending
 *      it later can queue it behind the skill's first question while the
 *      review incorrectly starts against the operator's live branch.
 *   3. Poll loop:
 *      - Skip permission dialogs (auto-grant with `defaultPick`).
 *      - Read fixture-scoped native JSONL. Count each AskUserQuestion call
 *        once after its matching successful answer record, regardless of
 *        how many questions the call batches. Full native metadata feeds
 *        phase predicates; ANSI redraws and permissions cannot add counts.
 *      - On a new numbered-option list, keep the existing PTY answer driver.
 *        Decline only the recognized optional office-hours
 *        prerequisite by label so a different skill does not rewrite the
 *        seeded plan before this review begins.
 *      - After the native answer, evaluate `isLastStep0AUQ(fingerprint)`. If true,
 *        subsequent AUQs are review-phase unless the caller positively identifies native setup.
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
 * UI fingerprints still dedupe redraws. Counted fingerprints use the
 * native session/tool call IDs, so shared answer labels never collapse
 * different calls and one multi-question call remains one finding.
 */
export async function runPlanSkillCounting(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command to send alone, e.g. '/plan-ceo-review'. No trailing args. */
  slashCommand: string;
  /** Fixture request seeded in initial project context before the slash command. */
  followUpPrompt: string;
  /** Observe this caller-owned disposable plan for permission identity only.
   * Does not impose the expectedPlanPath terminal-report contract. */
  permissionPlanPath?: string;
  /** Per-skill predicate: which answered AUQ is the last Step-0 question. */
  isLastStep0AUQ: Step0BoundaryPredicate;
  /** Optional positive identity for a first finding when no final setup AUQ was emitted. */
  isFirstReviewAUQ?: Step0BoundaryPredicate;
  /** Optional native setup classifier; late/reordered setup must not become a finding. */
  isSetupAUQ?: Step0BoundaryPredicate;
  /** Optional native completed-review handoff identity, excluded from both count bands. */
  isCompletionHandoffAUQ?: Step0BoundaryPredicate;
  /** Accepted artifact rendering is not a finding; its answer still requires a fresh report. */
  isArtifactGenerationAUQ?: Step0BoundaryPredicate;
  /** Optional issue classifier across phases; receives full native call metadata. */
  isReviewAUQ?: (fp: AskUserQuestionFingerprint, priorCalls?: readonly NativePlanQuestionCall[]) => boolean;
  /** Narrow caller-specific selection; null retains the normal answer policy.
   * The first argument retains full pending metadata for existing callers.
   * Native-bound selection uses activeCapture, whose metadata is present only
   * when capturePlanCountQuestion matched the currently visible native question. */
  pickAUQ?: (fp: AskUserQuestionFingerprint, activeCapture: AskUserQuestionFingerprint) => number | null;
  /** Require native completion plus this caller-owned final report before accepting a soft terminal. */
  expectedPlanPath?: string;
  /** Additional versioned files available in the isolated fixture before the skill starts. */
  fixtureFiles?: Record<string, string>;
  /** Hard cap on review-phase count; helper returns when reached. Should be
   *  set ABOVE the test's assertion ceiling so the test sees the cap as a
   *  failure rather than a silent stop. */
  reviewCountCeiling: number;
  /** Numbered option to press by default. Defaults to 1 (recommended). */
  defaultPick?: number;
  /**
   * Optional override for the FIRST AUQ observed. Receives the fingerprint;
   * returns the option index to press. Subsequent review AUQs use defaultPick;
   * only the recognized optional office-hours prerequisite is declined by label.
   *
   * Skill-specific routing helper: /plan-ceo-review's first AUQ asks "what
   * scope?" with options like "branch diff" / "describe inline" / "skip
   * interview". Pressing the default 1 routes to "branch diff" (the wrong
   * review target for a seeded fixture). firstAUQPick lets the test pick
   * "Skip interview" or "describe inline" so the agent reviews the
   * fixture plan content, not the git diff.
   */
  firstAUQPick?: (fp: AskUserQuestionFingerprint) => number;
  /** Total budget including startup and cleanup. Must exceed the 5s cleanup reserve. Default 1_500_000. */
  timeoutMs?: number;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
  /** Override the spawned model. Defaults via launchClaudePty's chain. */
  model?: string;
}): Promise<PlanSkillCountObservation> {
  const budgetStarted = performance.now();
  const startedAt = Date.now();
  const defaultPick = opts.defaultPick ?? 1;
  const timeoutMs = opts.timeoutMs ?? 1_500_000;
  // The caller may use this same limit as its Bun timeout. Leave room for
  // close()'s 2s graceful + 1s forced exit waits and artifact/fixture cleanup.
  // A second work window after boot lets Bun retry while this body is alive.
  const cleanupReserveMs = 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= cleanupReserveMs) {
    throw new RangeError('Plan counting timeout must exceed the 5000ms cleanup reserve');
  }
  const workDeadline = budgetStarted + timeoutMs - cleanupReserveMs;
  const remainingWork = () => Math.max(0, workDeadline - performance.now());
  async function waitForWork(ms: number): Promise<boolean> {
    const remaining = remainingWork();
    if (remaining <= 0) return false;
    const clipped = ms >= remaining;
    await Bun.sleep(Math.min(ms, remaining));
    // A clipped wait cannot finish the requested interval. Timers may wake
    // just before the fractional deadline; that is no license to advance.
    return !clipped && remainingWork() > 0;
  }

  const fixture = createPlanCountFixture(opts.followUpPrompt, { nativeReviewOnly: true, files: opts.fixtureFiles });
  const permissionPaths = [
    ...(opts.expectedPlanPath ? [opts.expectedPlanPath, path.join(fixture.cwd, 'PLAN.md')] : []),
    ...(opts.permissionPlanPath ? [opts.permissionPlanPath] : []),
  ];
  let session: ClaudePtySession;
  try {
    session = await launchClaudePty({
      permissionMode: 'plan',
      cwd: fixture.cwd,
      // Stop new output at the work cutoff so screen drain cannot consume
      // the reserve while the CLI continues streaming.
      timeoutMs: Math.max(1, remainingWork()),
      env: { ...opts.env, ...fixture.env },
      model: opts.model,
      seedSkills: true,
      observeScreen: true,
      observePlanReady: true,
      observeFilePermissions: permissionPaths.length ? [...new Set(permissionPaths)] : undefined,
    });
  } catch (error) {
    fixture.cleanup();
    throw error;
  }

  const fingerprints: AskUserQuestionFingerprint[] = [];
  const seen = new Set<string>();
  const countedCalls = new Set<string>();
  const filePermission = createPlanCountPermissionGuard();
  // Each owned path keeps its own grant history when the workflow switches
  // between the active plan and the separate caller-owned final report.
  const ownedFilePermissions = (session.pendingFilePermissionFiles ?? []).map(binding =>
    ({ ...binding, guard: createPlanCountPermissionGuard() }));
  let lastMatchedNativeQuestion: NativePlanQuestionCall | undefined;
  let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
  let boundaryFired = false;
  let step0Count = 0;
  let reviewCount = 0;
  let administrativeCount = 0;
  let isFirstAUQ = true;
  const saveSnapshot = createPlanCountSnapshotWriter();
  let lastCheckpointAt = Date.now();
  let viewport = '';

  const capture = (observation: object) => saveSnapshot({
    skillName: opts.skillName, observation, raw: session.rawOutput(), visible: session.visibleText(), viewport,
    cwd: fixture.cwd, claudeConfigDir: session.hermeticConfigDir,
  });

  function snapshot(
    outcome: PlanSkillCountObservation['outcome'],
    summary: string,
    visible: string,
  ): PlanSkillCountObservation {
    const clean = (text: string) => stripVTControlCharacters(text)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    const failed = outcome === 'exited' || outcome === 'timeout';
    const observation: PlanSkillCountObservation = {
      outcome,
      summary,
      evidence: failed
        ? `exitCode=${session.exitCode()}\n--- post-command evidence (last 3KB) ---\n${clean(visible).slice(-3000)}` +
          `\n--- full-session evidence, including startup (last 6KB) ---\n${clean(session.visibleText()).slice(-6000)}`
        : visible.slice(-3000),
      elapsedMs: Date.now() - startedAt,
      fingerprints,
      transcript,
      step0Count,
      reviewCount,
      administrativeCount,
    };
    const artifacts = capture(observation);
    Object.assign(observation, artifacts);
    if (artifacts.artifactDir) observation.evidence += `\nFull PTY artifacts: ${artifacts.artifactDir}`;
    if (artifacts.artifactError) observation.evidence += `\nPTY artifact write failed: ${artifacts.artifactError}`;
    return observation;
  }

  try {
    if (await waitForWork(8000)) { // boot grace is part of the total budget
      session.mark();
      session.send(`${opts.slashCommand}\r`);
    }

    while (remainingWork() > 0) {
      if (!await waitForWork(2000)) break;
      const visible = viewport = await session.currentScreen();
      if (remainingWork() <= 0) break;
      transcript = session.hermeticConfigDir
        ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd)
        : { status: 'error', calls: [], assistantMessages: [], error: 'Claude count session has no isolated transcript directory' };
      transcript = withPendingExit(transcript, session.pendingPlanReadyFile, fixture.cwd,
        session.hermeticConfigDir, startedAt, visible);
      if (transcript.status === 'error') {
        return snapshot('transcript_unavailable', transcript.error!, visible);
      }
      for (const [callIndex, call] of transcript.calls.entries()) {
        const signature = `${call.sessionId}:${call.toolUseId}`;
        if (!call.answered || countedCalls.has(signature)) continue;
        const fp = nativePlanCallFingerprint(call, Date.now() - startedAt, !boundaryFired);
        const phase = planCountQuestionPhase(fp, boundaryFired, opts.isLastStep0AUQ, opts.isFirstReviewAUQ, opts.isSetupAUQ, opts.isCompletionHandoffAUQ, opts.isArtifactGenerationAUQ);
        if (phase.administrative) {
          fp.preReview = false;
          fp.administrative = phase.administrative;
          administrativeCount += 1;
        } else {
          fp.preReview = opts.isReviewAUQ ? !opts.isReviewAUQ(fp, transcript.calls.slice(0, callIndex)) : phase.preReview;
          if (fp.preReview) step0Count += 1;
          else reviewCount += 1;
        }
        fp.promptSnippet = fp.promptSnippet.replace(/\s+/g, ' ').slice(0, 240);
        fingerprints.push(fp);
        countedCalls.add(signature);
        boundaryFired = phase.reviewStarted;
      }
      if (reviewCount >= opts.reviewCountCeiling) {
        if (unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Question count reached its ceiling with unresolved failed native calls', visible);
        }
        return snapshot('ceiling_reached', `review-phase AUQ count reached ceiling (${opts.reviewCountCeiling})`, visible);
      }
      // An outer test timeout/cancellation may prevent a terminal snapshot.
      // Keep bounded-cadence evidence without adding a timer to clean up.
      if (Date.now() - lastCheckpointAt >= 30_000) {
        lastCheckpointAt = Date.now();
        const saved = capture({ state: 'in_progress', elapsedMs: Date.now() - startedAt,
          fingerprints, step0Count, reviewCount, administrativeCount, transcript });
        if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
      }

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

      const pending = transcript.calls.find(c => !c.answered && !c.failed);
      const newlyMatched = pending && matchesNativePlanQuestion(visible, pending);
      if (newlyMatched) lastMatchedNativeQuestion = pending;
      const renderedFrame = classifyPlanCountFrame(visible);
      const administrative = new Set(fingerprints.filter(fp => fp.administrative === 'completion-handoff').map(fp => fp.signature));
      // A long completed summary may scroll its heading off the viewport.
      // With no active input UI, retain the existing native/report validator;
      // neither display text nor a missing heading supplies completion evidence.
      const nativeCompletion = opts.expectedPlanPath && hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt);
      const nativeSummary = !nativeCompletion && renderedFrame === null && opts.expectedPlanPath &&
        !isNumberedOptionListVisible(visible) && !isPermissionDialogVisible(visible) && !isProseAUQVisible(visible) &&
        hasNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt, 'completion_summary', administrative);
      const terminalFrame = nativeSummary ? 'completion_summary' : renderedFrame;
      const isTerminalHint = terminalFrame === 'completion_summary' || terminalFrame === 'plan_ready';
      const verifiedTerminal = nativeSummary || (opts.expectedPlanPath && isTerminalHint &&
        hasNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt, terminalFrame, administrative));
      if (reviewCount === 0 && fingerprints.some(fp => fp.administrative === 'artifact-generation') &&
          (nativeCompletion || verifiedTerminal)) {
        return snapshot('no_review_questions', 'Completed artifact generation supplied no review finding decisions', visible);
      }
      // A streamed heading cannot dismiss the last bound native question.
      // Only an accepted terminal may supersede its answered redraw; otherwise
      // permission wording inside that question could queue a stray answer.
      const acceptedTerminal = isTerminalHint && (!opts.expectedPlanPath || verifiedTerminal);
      const nativeQuestionVisible = newlyMatched || (!acceptedTerminal &&
        lastMatchedNativeQuestion && matchesNativePlanQuestion(visible, lastMatchedNativeQuestion));
      const terminalHint = nativeQuestionVisible ? null : terminalFrame;
      let frame = terminalHint;
      // Clear unverified hints before routing active permissions and Submit.
      if (opts.expectedPlanPath && isTerminalHint && !verifiedTerminal) frame = null;
      // A real approval gate is never an AUQ or a file permission. Wait for
      // its report/native evidence before input routing; verified gates still
      // pass the existing silent-write check below. A positively matched
      // native question above takes precedence over gate text.
      const nonReviewCalls = new Set(fingerprints.filter(fp => fp.preReview || fp.administrative)
        .map(fp => fp.signature));
      if (opts.expectedPlanPath && terminalHint === 'plan_ready' && reviewCount === 0 &&
          isQuestionlessNativePlanExit(transcript, opts.expectedPlanPath, startedAt, visible, nonReviewCalls)) {
        return snapshot('no_review_questions',
          'Native plan approval reached with zero review-phase AskUserQuestion calls; review coverage is missing', visible);
      }
      if (opts.expectedPlanPath && terminalHint === 'plan_ready' && !verifiedTerminal) continue;
      let permissionGuard = filePermission;
      let permissionEpoch: FilePermissionEpoch | null | undefined;
      const currentBinding = currentFilePermissionBinding(ownedFilePermissions, fixture.cwd,
        session.hermeticConfigDir, startedAt, transcript, visible);
      if (currentBinding) { permissionGuard = currentBinding.binding.guard; permissionEpoch = currentBinding.epoch; }
      else permissionEpoch = currentBinding;
      const permission = nativeQuestionVisible || terminalHint === 'plan_ready'
        ? null : permissionGuard(visible, session.visibleText(), permissionEpoch);
      if (frame === 'permission' || (permission === 'grant' && frame === null)) {
        if (remainingWork() <= 0) break;
        if (permission !== 'handled') session.send(`${defaultPick}\r`);
        await waitForWork(1500);
        continue;
      }

      const submissionInput = frame === null ? planCountSubmissionInput(visible) : null;
      if (submissionInput !== null) {
        if (remainingWork() <= 0) break;
        session.send(submissionInput);
        await waitForWork(1500);
        continue;
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

      if (opts.expectedPlanPath && verifiedTerminal && (frame === 'completion_summary' || frame === 'plan_ready')) {
        return snapshot(frame, `native ${frame} and final report verified (step0=${step0Count}, review=${reviewCount})`, visible);
      }

      // Legacy callers without a report contract retain their terminal policy.
      if (frame === 'completion_summary') {
        if (transcript.status !== 'ready' || transcript.calls.some(c => !c.answered && !c.failed) ||
            unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Completion has no complete native question transcript', visible);
        }
        return snapshot(
          'completion_summary',
          `skill emitted completion summary / verdict / status line (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }
      if (frame === 'plan_ready') {
        if (transcript.status !== 'ready' || transcript.calls.some(c => !c.answered && !c.failed) ||
            unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Plan-ready gate has no complete native question transcript', visible);
        }
        return snapshot(
          'plan_ready',
          `skill emitted plan-mode "Ready to execute" confirmation (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }

      if (opts.expectedPlanPath && !transcript.planReadyRequests?.length && !isNumberedOptionListVisible(visible) &&
          hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt)) {
        return snapshot('completion_summary',
          `native review completion and final report verified (step0=${step0Count}, review=${reviewCount})`, visible);
      }

      // A dismissed or repainted permission is never a native question.
      if (permission === 'handled') continue;

      // Dedupe the complete question, not just its answer labels: separate
      // findings often reuse the same Add to plan / Defer / Skip menu.
      const fp = capturePlanCountQuestion(visible, seen, Date.now() - startedAt, !boundaryFired, pending);
      if (!fp) continue;
      // Press to advance — first AUQ may use the override pick.
      const routing = pending?.questions.length === 1
        ? nativePlanCallFingerprint(pending, fp.observedAtMs, fp.preReview) : fp;
      const prerequisitePick = planCountPrerequisitePick(routing, fp);
      // Native tool records may flush only after the answer. Let a guarded
      // caller recognize that visible menu. A known packet needs a positively
      // matched active tab before a caller can change that tab's choice.
      // The captured fingerprint alone proves whether native metadata matched
      // this active UI; an unrelated pending record is not a routing identity.
      const boundNativeTab = pending && fp.nativeCall === pending && fp.nativeQuestionIndex !== undefined;
      const callerPick = !pending || pending.questions.length === 1 || boundNativeTab
        ? opts.pickAUQ?.(routing, fp) ?? null : null;
      const pickIdx = prerequisitePick ?? callerPick ??
        (isFirstAUQ && opts.firstAUQPick ? opts.firstAUQPick(routing) : defaultPick);
      isFirstAUQ = false;
      const questionInput = planCountQuestionInput(visible, fp, pickIdx);
      if (remainingWork() <= 0) break;
      if (questionInput.includes('\r')) {
        // The helper separates digit and Enter by 500ms. Do not let that
        // delayed confirmation send input after this counting window closes.
        await selectPtyNumberedOption({ send: input => {
          if (remainingWork() > 0) session.send(input);
        } }, pickIdx);
      } else session.send(questionInput);

      // Give the agent a beat to advance to the next state.
      await waitForWork(2000);
    }

    return snapshot(
      'timeout',
      `no terminal outcome within ${timeoutMs}ms total budget (including startup and ${cleanupReserveMs}ms cleanup reserve; step0=${step0Count}, review=${reviewCount})`,
      viewport,
    );
  } finally {
    try {
      await session.close();
    } finally {
      fixture.cleanup();
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillFloorCheck — minimal "did the agent fire ANY AskUserQuestion?"
// observer for gate-tier floor tests catching the May 2026 transcript bug
// (model wrote plan + ExitPlanMode'd with reviewCount=0).
//
// Why this exists separately from runPlanSkillCounting: plan-mode AUQs render
// every option on a single logical line via cursor-positioning escapes that
// stripAnsi can't simulate. parseNumberedOptions therefore returns < 2 options
// from those frames and never records a fingerprint. The full counting helper
// works for periodic finding-count tests because their 25-min budgets give the
// agent enough redraws that one frame eventually parses cleanly. Gate-tier
// floor tests don't have that wall-time budget and need to exit early on the
// first observation. This helper trades fingerprint precision for early-exit
// reliability.
//
// Contract:
//   - PASS  → outcome === 'auq_observed' (agent rendered any non-permission
//             numbered-option list; we exit immediately and report success)
//   - FAIL  → outcome === 'plan_ready' | 'completion_summary' | 'silent_write'
//             (agent reached a terminal state without ever firing an AUQ —
//             this IS the transcript bug)
//   - SOFT  → outcome === 'timeout' (neither happened in budget; agent may
//             just be slow — test should retry with a larger budget rather
//             than treat as a hard regression)
// ────────────────────────────────────────────────────────────────────────────

export interface PlanSkillFloorObservation {
  /** True iff a review-phase AUQ render was observed. */
  auqObserved: boolean;
  /** Owned native acknowledgment of the exact seeded target command. */
  targetDelivery?: PlanFloorTargetDelivery;
  outcome:
    | 'auq_observed'
    | 'plan_ready'
    | 'silent_write'
    | 'exited'
    | 'timeout';
  summary: string;
  /** Visible TTY tail (last 3KB) at terminal time. */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
}

/**
 * Drive a plan-* skill in plan mode and exit at the first non-permission
 * numbered-option render. See block comment above for the contract.
 */
export async function runPlanSkillFloorCheck(opts: {
  /** Skill name, e.g. 'plan-eng-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command; the owned PLAN.md target is supplied in the same submission. */
  slashCommand: string;
  /** Complete request seeded in an isolated project before the command starts. */
  followUpPrompt: string;
  /** Installation cwd retained for caller compatibility; review uses an owned seeded project. */
  cwd?: string;
  /** Total budget. Default 600000 (10 min). Tests exit early on AUQ. */
  timeoutMs?: number;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
  /** Override the spawned model. Defaults via launchClaudePty's chain. */
  model?: string;
}): Promise<PlanSkillFloorObservation> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const fixture = createPlanCountFixture(opts.followUpPrompt);
  const sessionId = randomUUID();
  let session: ClaudePtySession;
  try {
    session = await launchClaudePty({
      permissionMode: 'plan',
      cwd: fixture.cwd,
      timeoutMs: timeoutMs + 60_000,
      env: { ...opts.env, ...fixture.env },
      model: opts.model,
      seedSkills: true,
      extraArgs: ['--session-id', sessionId],
    });
  } catch (error) {
    fixture.cleanup();
    throw error;
  }

  try {
    await Bun.sleep(8000); // boot grace + auto-trust handler window
    const since = session.mark();
    const commandStartedAt = Date.now();
    session.send(`${opts.slashCommand} PLAN.md\r`);
    const deliveryOptions = { seed: opts.followUpPrompt, sessionId,
      slashCommand: opts.slashCommand, startedAt: commandStartedAt };
    let targetDelivery = readPlanFloorTarget(session.hermeticConfigDir, fixture.cwd,
      { ...deliveryOptions, now: Date.now() });
    const saveSnapshot = createPlanCountSnapshotWriter();
    const finish = (observation: PlanSkillFloorObservation): PlanSkillFloorObservation => {
      const artifacts = saveSnapshot({ skillName: opts.skillName, cwd: fixture.cwd,
        claudeConfigDir: session.hermeticConfigDir, raw: session.rawOutput(),
        visible: session.visibleSince(since), observation: { ...observation, targetDelivery, commandStartedAt } });
      return { ...observation, targetDelivery, ...artifacts };
    };

    const start = Date.now();
    let lastJudgeAt = 0;
    let lastJudgeVerdict: PtyStateVerdict | null = null;
    // Positional anchor for the scope-gate exclusion. The visible buffer is
    // append-only (old renders never leave scrollback), so a gate question
    // rendered in the 3s pre-target window would keep satisfying the
    // full-buffer acceptance checks forever while a tail-only exclusion
    // stops seeing it after ~TAIL_SCAN_BYTES of output — a vacuous
    // auq_observed (found independently by 4 review passes). Once the gate
    // render is seen, acceptance only counts AUQ renders in content APPENDED
    // after that point.
    let gateSeenIdx = -1;
    const JUDGE_AFTER_MS = 60_000;
    const JUDGE_INTERVAL_MS = 30_000;
    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(2000);
      const visible = session.visibleSince(since);
      if (gateSeenIdx === -1 && isScopeGateQuestionVisible(visible)) {
        gateSeenIdx = visible.length;
      }

      if (session.exited()) {
        return finish({
          auqObserved: false,
          outcome: 'exited',
          summary: `claude exited (code=${session.exitCode()}) before any AUQ render`,
          evidence: visible.slice(-3000),
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (visible.includes('Unknown command:')) {
        return finish({
          auqObserved: false,
          outcome: 'exited',
          summary: `claude rejected ${opts.slashCommand} as unknown command`,
          evidence: visible.slice(-3000),
          elapsedMs: Date.now() - startedAt,
        });
      }

      if (targetDelivery.status !== 'ready') {
        targetDelivery = readPlanFloorTarget(session.hermeticConfigDir, fixture.cwd,
          { ...deliveryOptions, now: Date.now() });
        if (targetDelivery.status !== 'ready') continue;
      }

      // Success: ANY non-permission numbered-option list is an AUQ render —
      // either via the native numbered-prompt UI (isNumberedOptionListVisible)
      // OR via prose-rendered options under --disallowedTools when no MCP
      // variant is callable (isProseAUQVisible). Both surface the question
      // to the user; the bug we're catching is "fired zero AUQs."
      //
      // Scope-gate renders do NOT count: the gate's "What should I review?"
      // can fire inside the 3s pre-target window and would trivially satisfy
      // the floor, but the floor measures FINDING-driven questions. Once a
      // gate render has been seen, acceptance scans only the content APPENDED
      // after it (positional anchor above) — the buffer is append-only, so a
      // whole-buffer acceptance would keep matching the stale gate render
      // forever.
      //
      // The gate veto is ACTIVE-RENDER-aware, not blanket-tail: when a
      // numbered menu is up, parseNumberedOptions anchors on the LAST cursor
      // line, so we veto only when the pending menu IS the gate — a finding
      // AUQ that renders within TAIL_SCAN_BYTES of the gate (model waiting,
      // no further output) still satisfies the floor. Prose renders have no
      // cursor anchor, so the prose path falls back to the tail check
      // (accepted residual: prose gate + prose finding inside one tail can
      // suppress until timeout; floors run the native-menu path in practice).
      const tail = visible.slice(-TAIL_SCAN_BYTES);
      const acceptWindow = gateSeenIdx === -1 ? visible : visible.slice(gateSeenIdx);
      const activeMenu = parseNumberedOptions(visible);
      const gateIsActiveRender =
        activeMenu.length > 0
          ? activeMenu.some((o) => /current\s*branch\s*diff/i.test(o.label))
          : isScopeGateQuestionVisible(tail);
      if (
        (isNumberedOptionListVisible(acceptWindow) || isProseAUQVisible(acceptWindow)) &&
        !isPermissionDialogVisible(tail) &&
        !gateIsActiveRender
      ) {
        return finish({
          auqObserved: true,
          outcome: 'auq_observed',
          summary: 'agent rendered an AskUserQuestion (floor met)',
          evidence: visible.slice(-3000),
          elapsedMs: Date.now() - startedAt,
        });
      }

      // LLM judge fallback: same shape as runPlanSkillObservation. After 60s
      // of polling without a regex hit, ask Haiku to classify the snapshot.
      // 'waiting' verdict counts as floor met (model surfaced a question via
      // prose the regex couldn't catch). 'working' / 'hung' / 'unknown' don't
      // change the outcome — they enrich the eventual timeout summary so the
      // failure diagnostic is more actionable than "no AUQ render."
      const elapsed = Date.now() - start;
      if (elapsed > JUDGE_AFTER_MS && Date.now() - lastJudgeAt > JUDGE_INTERVAL_MS) {
        lastJudgeAt = Date.now();
        logPtySnapshot(visible, { testName: opts.skillName, elapsedMs: elapsed, tag: 'floor-judge-tick' });
        lastJudgeVerdict = judgePtyState(visible, { testName: opts.skillName });
        // The judge can't tell a scope-gate question from a finding question,
        // so a 'waiting' verdict while the gate menu is the pending render
        // must NOT satisfy the floor — same active-render exclusion as the
        // regex path.
        if (lastJudgeVerdict.state === 'waiting' && !gateIsActiveRender) {
          return finish({
            auqObserved: true,
            outcome: 'auq_observed',
            summary: `LLM judge: ${lastJudgeVerdict.reasoning} (state=waiting after ${Math.round(elapsed / 1000)}s; floor met)`,
            evidence: visible.slice(-3000),
            elapsedMs: Date.now() - startedAt,
          });
        }
      }

      // Silent write outside sanctioned dirs is the transcript-bug shape.
      const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(visible)) !== null) {
        const target = m[1] ?? '';
        const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) => target.includes(s));
        if (!sanctioned && !isNumberedOptionListVisible(visible)) {
          return finish({
            auqObserved: false,
            outcome: 'silent_write',
            summary: `Write/Edit to ${target} fired before any AskUserQuestion`,
            evidence: visible.slice(-3000),
            elapsedMs: Date.now() - startedAt,
          });
        }
      }

      // Reached terminal without AUQ → transcript-bug regression.
      // Note: COMPLETION_SUMMARY_RE is intentionally NOT checked here — it
      // matches "GSTACK REVIEW REPORT" anywhere in the buffer, including
      // when the agent does recon by reading existing plan files (which
      // contain that string as a generated section). The plan_ready check
      // (claude's actual "Ready to execute" confirmation) is the reliable
      // terminal signal for "agent finished without asking."
      if (isPlanReadyVisible(visible)) {
        return finish({
          auqObserved: false,
          outcome: 'plan_ready',
          summary: 'agent reached plan_ready without firing any AskUserQuestion',
          evidence: visible.slice(-3000),
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    return finish({
      auqObserved: false,
      outcome: 'timeout',
      summary: targetDelivery.status === 'ready'
        ? `no AUQ render and no terminal outcome within ${timeoutMs}ms`
        : `seeded target delivery unavailable within ${timeoutMs}ms: ${targetDelivery.reason ?? targetDelivery.status}`,
      evidence: session.visibleSince(since).slice(-3000),
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    try { await session.close(); } finally { fixture.cleanup(); }
  }
}
