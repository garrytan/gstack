/**
 * Terminal viewport (xterm headless) and ANSI/TUI text detectors for PTY frames.
 * Moved from test/helpers/pty-screen.ts (which re-exports it) and claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentFilePermissionTarget, currentBashPermissionCard, currentReadPermissionCard, currentWebFetchPermissionCard, hasCurrentBashPermissionHeading, hasCurrentReadPermissionHeading, hasCurrentWebFetchPermissionHeading } from '../plan-skill-questions';
import { createRequire } from 'node:module';

/** The existing xterm package ships this headless source beside its browser bundle. */
let terminalConstructor: Promise<any> | undefined;
function loadTerminal(): Promise<any> {
  return terminalConstructor ??= (async () => {
    try {
      const source = path.join(path.dirname(createRequire(import.meta.url).resolve('xterm/package.json')), 'src');
      const entry = path.join(source, 'headless/public/Terminal.ts');
      if (!fs.existsSync(entry)) throw new Error(`Installed xterm headless source is missing: ${entry}`);
      const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun', trimUnusedImports: true,
        tsconfig: JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }) });
      const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm',
        // xterm5 detects Node by navigator absence. This changes only the
        // compiled module; Bun's global navigator and other tests stay intact.
        define: { navigator: 'undefined' },
        plugins: [{ name: 'installed-xterm-headless', setup(builder) {
          builder.onResolve({ filter: /^(common|headless)\// }, args => {
            const stem = path.join(source, args.path);
            return { path: fs.existsSync(`${stem}.ts`) ? `${stem}.ts` : `${stem}.d.ts` };
          });
          builder.onLoad({ filter: /[/\\]xterm[/\\]src[/\\].*\.ts$/ }, async args => ({
            contents: transpiler.transformSync(await Bun.file(args.path).text()), loader: 'js',
          }));
        } }],
      });
      if (!build.success) throw new AggregateError(build.logs, 'Installed xterm headless build failed');
      const encoded = Buffer.from(await build.outputs[0].text()).toString('base64');
      return (await import(`data:text/javascript;base64,${encoded}`)).Terminal;
    } catch (cause) {
      throw new Error('PTY screen unavailable; cannot safely observe terminal input.', { cause });
    }
  })();
}

export interface PtyScreenFrame {
  text: string;
  /** JS string offset of the same writes consumed by the viewport. */
  inputOffset: number;
  styledText: Array<{ row: number; start: number; text: string; dim: boolean; inverse: boolean }>;
}

export interface PtyScreen {
  write(text: string): void;
  read(deadlineAt?: number): Promise<string>;
  readFrame(deadlineAt?: number): Promise<PtyScreenFrame>;
  dispose(): Promise<void>;
}

/** One terminal per session; read only the actual viewport, never scrollback. */
export async function createPtyScreen(cols: number, rows: number,
  options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<PtyScreen> {
  const deadlineAt = options.deadlineAt ?? performance.now() + 5_000;
  if (!Number.isFinite(deadlineAt)) throw new RangeError('PTY screen requires a finite absolute deadline.');
  const Terminal = await loadTerminal();
  const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  // Match current CLI scalar column widths instead of xterm5's Unicode 6
  // default. xterm still handles combining cells; this is not grapheme shaping.
  terminal.unicode.register({
    version: 'bun-scalar',
    wcwidth(codepoint: number) {
      const width = Bun.stringWidth(String.fromCodePoint(codepoint));
      if (width !== 0 && width !== 1 && width !== 2) throw new Error('Invalid terminal scalar width.');
      return width;
    },
  });
  terminal.unicode.activeVersion = 'bun-scalar';
  let pending = 0;
  let inputOffset = 0;
  let failure: unknown;
  let final: PtyScreenFrame | undefined;
  let closing: Promise<void> | undefined;
  const waiting = new Set<() => void>();
  const settled = () => { if (pending === 0 || failure) { for (const done of waiting) done(); waiting.clear(); } };
  const fail = (error: unknown) => {
    failure ??= new Error('PTY screen parse failed; viewport is incomplete.', { cause: error });
    settled();
  };
  const drain = async (readDeadline = deadlineAt) => {
    if (!Number.isFinite(readDeadline)) throw new RangeError('PTY screen requires a finite absolute deadline.');
    while (pending > 0 && !failure) {
      if (options.signal?.aborted) { fail(options.signal.reason); break; }
      const remaining = Math.min(deadlineAt, readDeadline) - performance.now();
      if (remaining <= 0) { fail(new Error('PTY screen write callback deadline exceeded.')); break; }
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          waiting.delete(done);
          resolve();
        };
        const abort = () => fail(options.signal?.reason);
        const timer = setTimeout(() => fail(new Error('PTY screen write callback deadline exceeded.')), remaining);
        waiting.add(done);
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (failure) throw failure;
  };
  const viewport = () => {
    const buffer = terminal.buffer.active;
    const styledText: PtyScreenFrame['styledText'] = [];
    const lines = Array.from({ length: rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row);
      let start = 0, previous = '';
      for (let col = 0; col <= cols; col++) {
        const cell = col < cols ? line?.getCell(col) : undefined;
        const key = cell && (cell.getChars() || cell.getWidth() === 0)
          ? `${Number(!!cell.isDim())}${Number(!!cell.isInverse())}` : '';
        if (key === previous) continue;
        if (previous && previous !== '00') styledText.push({row, start,
          text: line!.translateToString(false, start, col), dim: previous[0] === '1', inverse: previous[1] === '1'});
        start = col; previous = key;
      }
      return line?.translateToString(true) ?? '';
    });
    return {text: lines.join('\n'), inputOffset, styledText};
  };
  const readFrame = async (readDeadline?: number) => {
    await drain(readDeadline);
    if (closing) { await closing; return final!; }
    return viewport();
  };
  return {
    write(text) {
      if (closing) throw new Error('Cannot write to a disposed PTY screen.');
      if (!text) return;
      pending++;
      inputOffset += text.length;
      let completed = false;
      const complete = () => { if (!completed) { completed = true; pending--; settled(); } };
      try { terminal.write(text, complete); }
      catch (error) { fail(error); complete(); }
    },
    async read(readDeadline) {
      return (await readFrame(readDeadline)).text;
    },
    readFrame,
    dispose() {
      return closing ??= (async () => {
        try { await drain(); final = viewport(); }
        finally {
          try { terminal.dispose(); }
          catch (error) { if (!failure) throw error; }
        }
      })();
    },
  };
}

/** Strip ANSI escapes for pattern-matching against visible text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\d;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78=>]/g, '');
}

/** Only consider rejection text naming the invoked slash command. */
export function isRejectedSlashCommand(visible: string, slashCommand: string): boolean {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9:_.-]*$/.test(slashCommand)) return false;
  const message = `Unknown command: ${slashCommand}`;
  return stripAnsi(visible).split(/\r?\n/).some(line => {
    const text = line.trim();
    return text === message || text.startsWith(`${message}. Did you mean /`)
      && /^\/[A-Za-z0-9][A-Za-z0-9:_.-]*\?$/.test(text.slice(`${message}. Did you mean `.length));
  });
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
  const collapsed = visible.replace(/\s+/g, '');
  // The public CLI transcript can attribute the completed choice inside
  // parentheses instead of repeating the canonical template annotation.
  // Keep the complete attribution so negated/future choices do not match.
  if (/\(auto-decidedfromplan-tunepreference\)/i.test(collapsed)) return true;
  const stemMatch =
    /Auto-decided\b/i.test(visible) || /Auto-decided/i.test(collapsed);
  if (!stemMatch) return false;
  if (/\(your preference\)/i.test(visible)) return true;
  return /\(yourpreference\)/i.test(collapsed);
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
export function isNativeEditPermissionVisible(visible: string): boolean {
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
  const target = currentFilePermissionTarget(text);
  const currentPanel = target?.operation === 'edit' && target.filePath === panel[1]!.trim();
  if (!prompt || prompt[1]!.trim() !== panel[1]!.trim() && !currentPanel) return false;
  // Current nested/settings cards show the basename in the question. Their
  // parsed full header still needs this pane's provenance and complete footer.
  if (currentPanel && /3\.NoEsctocancel[·•]Tabtoamend$/.test(prompt[2]!.replace(/\s+/g, ''))) return true;
  return /^ {0,3}❯[ \t]*1\.[ \t]*Yes[ \t]*\n {0,3}2\.[ \t]*Yes, and switch to accept edits[^\n]*\n {0,3}3\.[ \t]*No[ \t]*\n\s*Esc to cancel [·•] Tab to amend\s*$/.test(prompt[2]!);
}

export function isPermissionDialogVisible(visible: string, includeBoundPermission = false): boolean {
  // Current cards must satisfy their complete controls before legacy phrases
  // can classify them. Read and directory access remain ownership-bound opt-ins.
  if (includeBoundPermission && hasCurrentReadPermissionHeading(visible)) return currentReadPermissionCard(visible) !== null;
  if (hasCurrentWebFetchPermissionHeading(visible)) return currentWebFetchPermissionCard(visible) !== null;
  if (hasCurrentBashPermissionHeading(visible)) return currentBashPermissionCard(visible, includeBoundPermission) !== null;
  // Cursor-positioning escapes supply spaces visually, but stripping those
  // escapes leaves labels such as "alwaysallowaccessto" in captured frames.
  const compact = visible.replace(/\s+/g, '');
  const file = currentFilePermissionTarget(visible);
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  const bareEdit = cursor && /^Do\s*you\s*want\s*to\s*(?:edit|make\s+this\s+edit\s+to)\s+[^\r\n?]+\?\s*$/.test(visible.slice(0, cursor.index).trim());
  // A scoped target parser may recover only an Edit basename below a cropped
  // preview. Generic callers need the full native pane, or a bare current
  // menu with no preview/history prefix; ownership remains the scoped caller's.
  if (file && /3\.NoEsctocancel[·•]Tabtoamend$/.test(compact) &&
      (file.operation !== 'edit' || bareEdit)) return true;
  if (isNativeEditPermissionVisible(visible)) return true;
  if (/requestedpermissions?to|allowalledits|alwaysallowaccessto|Bashcommand.*requirespermission/i.test(compact)) {
    return true;
  }
  // Main's cursor-positioning capture can collapse the path separator too.
  // Classification still requires the complete current choices and footer;
  // this projection never establishes native path ownership for a grant.
  if (/(?:^|\n)Doyouwantto(?:overwrite|create|edit)[^\s?]+\?\n❯1\.Yes\n(?:2\.No|2\.Yes,andswitchtoacceptedits\(auto-approvefileeditsandcommonfilecommands\)forthissession\n3\.No)\nEsctocancel[·•]Tabtoamend\s*$/.test(visible.replace(/[ \t\r]/g, ''))) return true;
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

/** Start of the CLI's public "API Error:" panel. The native AUQ capture reads the same panel. */
export const API_ERROR_PANEL = /(?:^|\n)[\t │┃]*(?:[⎿●⏺]\s*)?API Error:/i;

/** Session-ledger end from the last idle turn's public error panel: a safeguards panel is a refusal, any other an API error. */
export function idlePanelEnd(visible: string): { end: 'refusal' | 'api_error'; evidence: string } | null {
  const panel = idleTurnEnd(visible)?.apiError;
  if (!panel) return null;
  return { end: /safeguards flagged|can't respond to this message/i.test(panel) ? 'refusal' : 'api_error', evidence: panel };
}

/** The CLI's end-of-turn line, e.g. "✻ Cooked for 24s · done 12:46 AM" (spaces may collapse in the PTY text). */
const TURN_DONE_RE = /✻[ \t]*\p{L}[\p{L}'’-]*[ \t]*for[ \t]*(?=\d)(?:\d+h[ \t]*)?(?:\d+m[ \t]*)?(?:\d+s)?[ \t]*·[ \t]*done[^\n]*/gu;
/** An empty input prompt and its known idle footers, nothing else. */
const IDLE_PROMPT_RE = /^[\s─]*❯[\s─]*(?:(?:←[ \t]*for[ \t]*agents|\?[ \t]*for[ \t]*shortcuts)[\s─]*)*$/;

/**
 * The CLI ended its turn and sits at an empty prompt: the last end-of-turn
 * line is followed only by the prompt and an idle footer. A spinner, menu,
 * background task or any other text after it means the turn is not idle.
 * Returns that line and the last public API Error panel line of the same turn.
 */
export function idleTurnEnd(visible: string): { done: string; apiError?: string } | null {
  const text = visible.replace(/\x1b?\[\?25[lh]/g, '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const turns = [...text.matchAll(TURN_DONE_RE)];
  const done = turns.at(-1);
  if (!done || !IDLE_PROMPT_RE.test(text.slice(done.index + done[0].length))) return null;
  const previous = turns.at(-2);
  const turn = text.slice(previous ? previous.index + previous[0].length : 0, done.index);
  const apiError = [...turn.matchAll(new RegExp(`${API_ERROR_PANEL.source}[^\\n]*`, 'gi'))].at(-1)?.[0].trim();
  return { done: done[0].trim(), ...(apiError ? { apiError: apiError.slice(0, 300) } : {}) };
}
