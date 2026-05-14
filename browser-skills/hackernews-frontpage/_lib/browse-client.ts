/**
 * browse-client — canonical SDK that browser-skill scripts import to drive the
 * gstack daemon over loopback HTTP.
 *
 * Distribution model:
 *   This file is the canonical source. Each browser-skill ships a sibling
 *   copy at `<skill>/_lib/browse-client.ts` (Phase 2's generator copies it
 *   alongside every generated skill; Phase 1's bundled `hackernews-frontpage`
 *   reference skill ships a hand-copied version). The skill imports the
 *   sibling via relative path: `import { browse } from './_lib/browse-client'`.
 *
 *   Why per-skill copies and not a single global SDK: each skill is fully
 *   portable (copy the directory anywhere, it runs), version drift is
 *   impossible (the SDK is frozen at the version the skill was authored
 *   against), no npm publish workflow, no fixed-path tilde imports.
 *
 * Auth resolution:
 *   1. GSTACK_PORT + GSTACK_SKILL_TOKEN env vars (set by `$B skill run` when
 *      spawning the script). The token is a per-spawn scoped capability bound
 *      to read+write commands; it expires when the spawn ends.
 *   2. State file fallback: read `BROWSE_STATE_FILE` env or `<git-root>/.gstack/browse.json`
 *      and use the `port` + `token` (the daemon root token). This path exists
 *      for developers running a skill directly via `bun run script.ts` outside
 *      the harness — your own authority, not an agent's.
 *
 * Trust:
 *   The SDK exposes only the daemon's existing HTTP surface (POST /command).
 *   No new capabilities. The token's scopes (read+write for spawned skills,
 *   full root for standalone debug) determine what actually executes.
 *
 * Zero side effects on import. Safe to import from tests or plain scripts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export interface BrowseClientOptions {
  /** Override port. Default: GSTACK_PORT env or state file. */
  port?: number;
  /** Override token. Default: GSTACK_SKILL_TOKEN env, then state file root token. */
  token?: string;
  /** Tab id to target (every command can scope to a tab). Default: BROWSE_TAB env or undefined (active tab). */
  tabId?: number;
  /** Per-request timeout in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Override state-file path. Default: BROWSE_STATE_FILE env or <git-root>/.gstack/browse.json. */
  stateFile?: string;
}

interface ResolvedAuth {
  port: number;
  token: string;
  source: 'env' | 'state-file';
}

function parseIntegerEnvValue(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Resolve the daemon port + token. Throws a clear error if neither path works. */
export function resolveBrowseAuth(opts: BrowseClientOptions = {}): ResolvedAuth {
  if (opts.port !== undefined && opts.token !== undefined) {
    return { port: opts.port, token: opts.token, source: 'env' };
  }

  // 1. Env vars (set by $B skill run when spawning).
  const envPort = process.env.GSTACK_PORT;
  const envToken = process.env.GSTACK_SKILL_TOKEN;
  if (envPort && envToken) {
    const port = opts.port ?? parseIntegerEnvValue(envPort);
    if (port !== undefined) {
      return { port, token: opts.token ?? envToken, source: 'env' };
    }
  }

  // 2. State file fallback (developer running `bun run script.ts` directly).
  const stateFile = opts.stateFile ?? process.env.BROWSE_STATE_FILE ?? defaultStateFile();
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (typeof data.port === 'number' && typeof data.token === 'string') {
        return {
          port: opts.port ?? data.port,
          token: opts.token ?? data.token,
          source: 'state-file',
        };
      }
    } catch {
      // fall through to error
    }
  }

  throw new Error(
    'browse-client: cannot find daemon port + token. Either spawn via `$B skill run` ' +
    '(sets GSTACK_PORT + GSTACK_SKILL_TOKEN) or run from a project with a live daemon ' +
    '(.gstack/browse.json must exist).'
  );
}

function defaultStateFile(): string | null {
  try {
    const proc = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: 2000 });
    const root = proc.status === 0 ? proc.stdout.trim() : null;
    const base = root || process.cwd();
    return path.join(base, '.gstack', 'browse.json');
  } catch {
    return path.join(process.cwd(), '.gstack', 'browse.json');
  }
}

export class BrowseClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'BrowseClientError';
  }
}

/**
 * Thin client over the daemon's POST /command endpoint.
 *
 * Convenience methods cover the common cases (goto, click, text, snapshot,
 * etc.). For anything not exposed as a method, use `command(cmd, args)`.
 */
export class BrowseClient {
  readonly port: number;
  readonly token: string;
  readonly tabId?: number;
  readonly timeoutMs: number;

  constructor(opts: BrowseClientOptions = {}) {
    const auth = resolveBrowseAuth(opts);
    this.port = auth.port;
    this.token = auth.token;
    this.tabId = opts.tabId ?? parseIntegerEnvValue(process.env.BROWSE_TAB);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ─── Low-level dispatch ─────────────────────────────────────────

  /** Send an arbitrary command; returns raw response text. Throws on non-2xx. */
  async command(cmd: string, args: string[] = []): Promise<string> {
    const body = JSON.stringify({
      command: cmd,
      args,
      ...(this.tabId !== undefined && !isNaN(this.tabId) ? { tabId: this.tabId } : {}),
    });

    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${this.port}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new BrowseClientError(`browse-client: command "${cmd}" timed out after ${this.timeoutMs}ms`);
      }
      if (err.code === 'ECONNREFUSED') {
        throw new BrowseClientError(`browse-client: daemon not running on port ${this.port}`);
      }
      throw new BrowseClientError(`browse-client: ${err.message ?? err}`);
    }

    const text = await resp.text();
    if (!resp.ok) {
      let message = `browse-client: command "${cmd}" failed with status ${resp.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) message += `: ${parsed.error}`;
      } catch {
        if (text) message += `: ${text.slice(0, 200)}`;
      }
      throw new BrowseClientError(message, resp.status, text);
    }
    return text;
  }

  // ─── Navigation ─────────────────────────────────────────────────

  async goto(url: string): Promise<string> { return this.command('goto', [url]); }
  async wait(arg: string): Promise<string> { return this.command('wait', [arg]); }

  // ─── Reading ────────────────────────────────────────────────────

  async text(selector?: string): Promise<string> {
    return this.command('text', selector ? [selector] : []);
  }
  async html(selector?: string): Promise<string> {
    return this.command('html', selector ? [selector] : []);
  }
  async links(): Promise<string> { return this.command('links'); }
  async forms(): Promise<string> { return this.command('forms'); }
  async accessibility(): Promise<string> { return this.command('accessibility'); }
  async attrs(selector: string): Promise<string> { return this.command('attrs', [selector]); }
  async media(...flags: string[]): Promise<string> { return this.command('media', flags); }
  async data(...flags: string[]): Promise<string> { return this.command('data', flags); }

  // ─── Interaction ────────────────────────────────────────────────

  async click(selector: string): Promise<string> { return this.command('click', [selector]); }
  async fill(selector: string, value: string): Promise<string> { return this.command('fill', [selector, value]); }
  async select(selector: string, value: string): Promise<string> { return this.command('select', [selector, value]); }
  async hover(selector: string): Promise<string> { return this.command('hover', [selector]); }
  async type(text: string): Promise<string> { return this.command('type', [text]); }
  async press(key: string): Promise<string> { return this.command('press', [key]); }
  async scroll(selector?: string): Promise<string> {
    return this.command('scroll', selector ? [selector] : []);
  }

  // ─── Snapshot + screenshot ──────────────────────────────────────

  /** Snapshot returns the ARIA tree. Pass flags like '-i' (interactive only), '-c' (compact). */
  async snapshot(...flags: string[]): Promise<string> { return this.command('snapshot', flags); }
  async screenshot(...args: string[]): Promise<string> { return this.command('screenshot', args); }
}

/**
 * Default singleton. Lazily resolves auth on first method call so a script can
 * import `browse` and immediately call `await browse.goto(...)` without
 * threading through a constructor.
 */
class LazyBrowseClient {
  private inner: BrowseClient | null = null;
  private get(): BrowseClient {
    if (!this.inner) this.inner = new BrowseClient();
    return this.inner;
  }
  // Mirror the BrowseClient surface; each method delegates to a freshly resolved instance.
  command(cmd: string, args: string[] = []) { return this.get().command(cmd, args); }
  goto(url: string) { return this.get().goto(url); }
  wait(arg: string) { return this.get().wait(arg); }
  text(selector?: string) { return this.get().text(selector); }
  html(selector?: string) { return this.get().html(selector); }
  links() { return this.get().links(); }
  forms() { return this.get().forms(); }
  accessibility() { return this.get().accessibility(); }
  attrs(selector: string) { return this.get().attrs(selector); }
  media(...flags: string[]) { return this.get().media(...flags); }
  data(...flags: string[]) { return this.get().data(...flags); }
  click(selector: string) { return this.get().click(selector); }
  fill(selector: string, value: string) { return this.get().fill(selector, value); }
  select(selector: string, value: string) { return this.get().select(selector, value); }
  hover(selector: string) { return this.get().hover(selector); }
  type(text: string) { return this.get().type(text); }
  press(key: string) { return this.get().press(key); }
  scroll(selector?: string) { return this.get().scroll(selector); }
  snapshot(...flags: string[]) { return this.get().snapshot(...flags); }
  screenshot(...args: string[]) { return this.get().screenshot(...args); }
}

export const browse = new LazyBrowseClient();
