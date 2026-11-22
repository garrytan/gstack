/**
 * Command routes: POST /command (one command; the only non-/connect tunnel
 * route) and POST /batch (N commands in one round trip). Both accept root and
 * scoped tokens and run through the full command security pipeline. Also owns
 * the tunnel command allowlist.
 */

import { type RouteEntry, jsonError } from './table';
import { canonicalizeCommand } from '../commands';
import { hasOutArg } from '../read-commands';
import { parseScreenshotArgs } from '../meta-commands';
import { parseSnapshotArgs } from '../snapshot';
import { emitActivity } from '../activity';
import { logTunnelDenial } from '../tunnel-denial-log';
import { sanitizeBody, stripLoneSurrogateEscapes } from '../sanitize';

/**
 * Commands reachable via POST /command over the tunnel surface. A paired
 * remote agent can drive the browser (goto, click, text, etc.) but cannot
 * configure the daemon, bootstrap new sessions, import cookies, or reach
 * extension-inspector state. This allowlist maps to the eng-review decision
 * logged in the CEO plan for sec-wave v1.6.0.0.
 */
export const TUNNEL_COMMANDS = new Set<string>([
  // Original 17
  'goto', 'click', 'text', 'screenshot',
  'html', 'links', 'forms', 'accessibility',
  'attrs', 'media', 'data',
  'scroll', 'press', 'type', 'select', 'wait',
  // Tab + navigation primitives operator docs and CLI hints already promised
  'newtab', 'tabs', 'back', 'forward', 'reload',
  // Read/inspect/write operators paired agents need to be useful
  'snapshot', 'fill', 'url', 'closetab',
]);

/**
 * Pure gate: returns true iff the command is reachable over the tunnel surface.
 * Canonicalizes the command (so aliases hit the same set) and returns false
 * for null/undefined input.
 *
 * `args` is consulted so that over the tunnel a paired agent can't read local
 * files, can't choose a path on the daemon's disk, and can't make the daemon
 * save screenshot or snapshot images: `--out`, a screenshot without
 * `--base64` or with an output path, a snapshot with `-a`/`-H`/`-o`, and
 * goto/newtab to anything but an http(s) URL (file: reads) are refused.
 * `eval` is absent from the allowlist because it runs a file from the
 * daemon's disk. Omitting `args` (undefined) preserves the old command-only
 * behavior; null, a non-array, or an array with a non-string element is refused.
 */
export function canDispatchOverTunnel(command: string | undefined | null, args?: string[]): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  const cmd = canonicalizeCommand(command);
  if (!TUNNEL_COMMANDS.has(cmd)) return false;
  if (args === undefined) return true;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || hasOutArg(args)) return false;
  if (cmd === 'goto' && args.length > 0) return isWebUrl(args[0]);
  if (cmd === 'newtab') {
    const url = args.find(arg => arg !== '--json');
    return url === undefined || isWebUrl(url);
  }
  try {
    if (cmd === 'screenshot') {
      const shot = parseScreenshotArgs(args);
      return shot.base64Mode && shot.outputPath === undefined;
    }
    if (cmd === 'snapshot') {
      const snap = parseSnapshotArgs(args);
      return !snap.outputPath && !snap.annotate && !snap.heatmap;
    }
  } catch {
    return false;
  }
  return true;
}

function isWebUrl(value: unknown): boolean {
  try {
    const { protocol } = new URL(String(value));
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const commandRoutes: RouteEntry[] = [
  // ─── Batch endpoint — N commands, 1 HTTP round-trip ─────────────
  // Executes commands sequentially through the full security pipeline.
  // Designed for remote agents where tunnel latency dominates.
  {
    method: 'POST', path: '/batch', auth: 'scoped', surfaces: ['local'],
    handler: async (req, { tokenInfo }, ctx) => {
      const { browserManager } = ctx;
      ctx.resetIdleTimer();
      const body = await req.json();
      const { commands } = body;
      if (!Array.isArray(commands) || commands.length === 0) return jsonError(400, '"commands" must be a non-empty array');
      if (commands.length > 50) return jsonError(400, 'Max 50 commands per batch');

      const startTime = Date.now();
      emitActivity({
        type: 'command_start',
        command: 'batch',
        args: [`${commands.length} commands`],
        url: browserManager.getCurrentUrl(),
        tabs: browserManager.getTabCount(),
        mode: browserManager.getConnectionMode(),
        clientId: tokenInfo?.clientId,
      });

      const results: Array<{ index: number; status: number; result: string; command: string; tabId?: number }> = [];
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (!cmd || typeof cmd.command !== 'string') {
          results.push({ index: i, status: 400, result: JSON.stringify({ error: 'Missing "command" field' }), command: '' });
          continue;
        }
        // Reject nested batches
        if (cmd.command === 'batch') {
          results.push({ index: i, status: 400, result: JSON.stringify({ error: 'Nested batch commands are not allowed' }), command: 'batch' });
          continue;
        }
        const cr = await ctx.commands.handleInternal(
          { command: cmd.command, args: cmd.args, tabId: cmd.tabId, session: cmd.session ?? body.session },
          tokenInfo,
          { skipRateCheck: true, skipActivity: true },
        );
        // Sanitize lone surrogates per-result (#1440 — /batch bypasses the
        // handleCommand chokepoint, so it needs its own sanitization).
        const safeResult = typeof cr.result === 'string' ? sanitizeBody(cr.result, !!cr.json) : cr.result;
        results.push({
          index: i,
          status: cr.status,
          result: safeResult,
          command: cmd.command,
          tabId: cmd.tabId,
        });
      }

      const duration = Date.now() - startTime;
      emitActivity({
        type: 'command_end',
        command: 'batch',
        args: [`${commands.length} commands`],
        url: browserManager.getCurrentUrl(),
        duration,
        status: 'ok',
        result: `${results.filter(r => r.status === 200).length}/${commands.length} succeeded`,
        tabs: browserManager.getTabCount(),
        mode: browserManager.getConnectionMode(),
        clientId: tokenInfo?.clientId,
      });

      // Sanitize the JSON envelope a second time (defense in depth) — catches
      // any \uXXXX escape sequences for lone surrogates that survived the
      // per-result pass.
      const batchBody = stripLoneSurrogateEscapes(JSON.stringify({
        results,
        duration,
        total: commands.length,
        succeeded: results.filter(r => r.status === 200).length,
        failed: results.filter(r => r.status !== 200).length,
      }));
      return new Response(batchBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  },

  // ─── Command endpoint ───────────────────────────────────────────
  {
    method: 'POST', path: '/command', auth: 'scoped', surfaces: ['local', 'tunnel'],
    handler: async (req, { url, surface, tokenInfo }, ctx) => {
      ctx.resetIdleTimer();
      const body = await req.json() as any;
      // Tunnel surface: only commands in TUNNEL_COMMANDS are allowed.
      // Paired remote agents drive the browser but cannot configure the
      // daemon, launch new browsers, import cookies, or rotate tokens.
      if (surface === 'tunnel' && !canDispatchOverTunnel(body?.command, body?.args === undefined ? [] : body?.args)) {
        logTunnelDenial(req, url, `disallowed_command:${body?.command}`);
        return jsonError(403, `Command '${body?.command}' is not allowed over the tunnel surface`, {
          hint: `Tunnel commands: ${[...TUNNEL_COMMANDS].sort().join(', ')}. Over the tunnel, goto/newtab take http(s) URLs only, screenshot needs --base64 and cannot name an output path (target an element with screenshot --base64 --selector <css>), snapshot refuses -a/--annotate, -H/--heatmap and -o, and --out is never allowed.`,
        });
      }
      return ctx.commands.handle(body, tokenInfo);
    },
  },
];
