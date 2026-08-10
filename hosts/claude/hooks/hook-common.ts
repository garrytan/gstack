/**
 * Shared plumbing for the AskUserQuestion hooks (question-log,
 * question-preference, auq-error-fallback).
 *
 * Every hook reads the same stdin envelope, filters on the same tool-name
 * matcher, logs errors to the same file, and shells out to the same bins under
 * `bin/`. Keeping one copy here means the crash-safety invariants (never throw,
 * always exit 0, hard stdin cutoff) are stated once.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/** `<gstack-qid:foo-bar>` marker embedded in question text (D18). */
export const MARKER_RE = /<gstack-qid:([a-z0-9-]{1,64})>/i;
/** `(recommended)` suffix on an option label (D2). */
export const RECOMMENDED_LABEL_RE = /\(recommended\)\s*$/i;

/** Hard cutoff so a hook never hangs the user's session waiting for stdin. */
const STDIN_TIMEOUT_MS = 2000;
/** Subprocess budget for the `bin/gstack-*` helpers a hook shells out to. */
const BIN_TIMEOUT_MS = 3000;

export type AuqOption = string | { label?: string; description?: string };

export interface AuqQuestion {
  question?: string;
  options?: AuqOption[];
  multiSelect?: boolean;
}

/** The Claude Code hook stdin envelope, narrowed to the fields hooks read. */
export interface HookStdin {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { questions?: AuqQuestion[] };
  tool_response?: unknown;
  cwd?: string;
}

export function stateRoot(): string {
  return (
    process.env.GSTACK_STATE_ROOT ||
    process.env.GSTACK_HOME ||
    path.join(os.homedir(), '.gstack')
  );
}

/** Build the `~/.gstack/hook-errors.log` appender for one hook. */
export function makeHookErrorLogger(hookName: string): (msg: string) => void {
  return (msg: string) => {
    try {
      const sr = stateRoot();
      fs.mkdirSync(sr, { recursive: true });
      fs.appendFileSync(
        path.join(sr, 'hook-errors.log'),
        `${new Date().toISOString()} ${hookName}: ${msg}\n`,
      );
    } catch {
      // last-resort swallow — a hook must never block the session
    }
  };
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), STDIN_TIMEOUT_MS);
  });
}

/** True for the native tool and every `mcp__<server>__AskUserQuestion` variant. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const name = toolName || '';
  return name === 'AskUserQuestion' || /^mcp__.+__AskUserQuestion$/.test(name);
}

/** Repo root, resolved from this module's location (hosts/claude/hooks/). */
export function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

/** Absolute path to a helper in `bin/`. */
export function gstackBin(name: string): string {
  return path.join(repoRoot(), 'bin', name);
}

export function optionLabels(opts: AuqOption[]): string[] {
  return opts.map((o) => (typeof o === 'string' ? o : o.label || o.description || ''));
}

/**
 * Resolve the recommended option per D2: `(recommended)` label first, then a
 * `Recommendation: X` prose match against the labels. Ambiguity (more than one
 * candidate) is reported rather than guessed so callers can fail safe.
 */
export function extractRecommended(
  questionText: string,
  opts: string[],
): { recommended: string | undefined; ambiguous: boolean } {
  const labelMatches = opts.filter((o) => RECOMMENDED_LABEL_RE.test(o));
  if (labelMatches.length === 1) {
    return { recommended: labelMatches[0].replace(RECOMMENDED_LABEL_RE, '').trim(), ambiguous: false };
  }
  if (labelMatches.length > 1) return { recommended: undefined, ambiguous: true };

  const m = questionText.match(/Recommendation:\s*([^\n]+)/i);
  if (!m) return { recommended: undefined, ambiguous: false };
  const recPhrase = m[1].trim();
  const prefixMatches = opts.filter((o) =>
    o.toLowerCase().startsWith(recPhrase.toLowerCase().slice(0, 12)),
  );
  if (prefixMatches.length === 1) return { recommended: prefixMatches[0], ambiguous: false };
  if (prefixMatches.length > 1) return { recommended: undefined, ambiguous: true };
  return { recommended: undefined, ambiguous: false };
}

/**
 * Hand a question-log payload to `bin/gstack-question-log`, which owns
 * validation, dedup and the async derive. Runs from the originating tool
 * call's cwd so gstack-slug resolves the user's project, not the hook's
 * location.
 */
export function spawnQuestionLog(
  payload: Record<string, unknown>,
  cwd: string | undefined,
  logError: (msg: string) => void,
): void {
  try {
    const res = spawnSync(gstackBin('gstack-question-log'), [JSON.stringify(payload)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: BIN_TIMEOUT_MS,
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    });
    if (res.status !== 0) {
      logError(`gstack-question-log exited ${res.status}: ${res.stderr || res.stdout}`);
    }
  } catch (e) {
    logError(`gstack-question-log spawn failed: ${(e as Error).message}`);
  }
}

/**
 * Read + parse the hook stdin envelope. Returns null when stdin is empty or
 * unparseable (the caller's cue to take its own no-op path).
 */
export async function readHookStdin(logError: (msg: string) => void): Promise<HookStdin | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as HookStdin;
  } catch (e) {
    logError(`stdin parse failed: ${(e as Error).message}`);
    return null;
  }
}
