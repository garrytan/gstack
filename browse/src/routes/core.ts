/**
 * Daemon routes outside the named areas: the cookie-picker sub-router, the
 * welcome page, the pinned-origin token bootstrap, liveness, refs and the
 * memory diagnostic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveStateRoot } from '../../../lib/state-root';
import { json, type RouteEntry } from './table';
import { handleCookiePickerRoute } from '../cookie-picker-routes';
import { sanitizeReplacer } from '../sanitize';

function resolveWelcomePath(): string | null {
  // Gate GSTACK_SLUG on a strict regex BEFORE interpolating it into the
  // filesystem path. Without this, a slug like "../../etc/passwd" would
  // resolve to ~/.gstack/projects/../../etc/passwd/... — path traversal.
  const rawSlug = process.env.GSTACK_SLUG || 'unknown';
  const slug = /^[a-z0-9_-]+$/.test(rawSlug) ? rawSlug : 'unknown';
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const projectWelcome = path.join(resolveStateRoot(), 'projects', slug, 'designs', 'welcome-page-20260331', 'finalized.html');
  if (fs.existsSync(projectWelcome)) return projectWelcome;
  // Fallback: built-in welcome page from gstack install. Reject SKILL_ROOT
  // values containing '..' for the same defense-in-depth reason.
  const rawSkillRoot = process.env.GSTACK_SKILL_ROOT || `${homeDir}/.claude/skills/gstack`;
  if (rawSkillRoot.includes('..')) return null;
  const builtinWelcome = `${rawSkillRoot}/browse/src/welcome.html`;
  if (fs.existsSync(builtinWelcome)) return builtinWelcome;
  return null;
}

export const coreRoutes: RouteEntry[] = [
  // Cookie picker sub-router — HTML page unauthenticated, data/action routes require auth
  {
    method: '*', path: '/cookie-picker', prefix: true, auth: 'handler', surfaces: ['local'],
    handlerAuth: 'sub-router in cookie-picker-routes.ts: OPTIONS preflight open; GET /cookie-picker needs a one-time code or picker session cookie (403 text); every other /cookie-picker/* needs the root bearer or a picker session (401 Unauthorized)',
    handler: (req, { url }, ctx) => handleCookiePickerRoute(url, req, ctx.browserManager, ctx.bootstrapRootToken),
  },

  // Welcome page — served when GStack Browser launches in headed mode
  {
    method: '*', path: '/welcome', auth: 'none', surfaces: ['local'],
    handler: () => {
      const welcomePath = resolveWelcomePath();
      if (welcomePath) {
        try {
          const html = fs.readFileSync(welcomePath, 'utf-8');
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (err: any) {
          console.error('[browse] Failed to read welcome page:', welcomePath, err.message);
        }
      }
      // No welcome page found — serve a simple fallback (avoid ERR_UNSAFE_REDIRECT on Windows)
      return new Response(
        `<!DOCTYPE html><html><head><title>GStack Browser</title>
          <style>body{background:#111;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
          .msg{text-align:center;opacity:.7;}.gold{color:#f5a623;font-size:2em;margin-bottom:12px;}</style></head>
          <body><div class="msg"><div class="gold">◈</div><p>GStack Browser ready.</p><p style="font-size:.85em">Waiting for commands from Claude Code.</p></div></body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    },
  },

  // ─── POST /extension-token — pinned-origin token bootstrap ──────
  //
  // The ONLY endpoint that hands out AUTH_TOKEN. The token is released only
  // to the one extension identity we ship: the Origin header must be exactly
  // `chrome-extension://<GSTACK_EXTENSION_ID>` and the Host must be loopback
  // (the extension-origin gate). Chrome sets Origin on cross-origin POSTs
  // from extension contexts and web pages cannot forge a chrome-extension://
  // Origin. Local listener only: NEVER added to TUNNEL_PATHS.
  {
    method: 'POST', path: '/extension-token', auth: 'extension-origin', surfaces: ['local'],
    handler: (_req, _r, ctx) => json({ token: ctx.bootstrapRootToken }),
  },

  // Health check — no auth required, does NOT reset idle timer. NEVER carries
  // a token in any mode: token bootstrap is POST /extension-token and shell
  // auth is POST /pty-session. Liveness/status only.
  //
  // `status` is daemon liveness (Chromium connected); the CLI gates every
  // command on it. `activeTab.responsive` is the active tab's main thread,
  // probed for at most TAB_PROBE_TIMEOUT_MS and reported beside it: one busy
  // page must not read as a dead daemon (#3247).
  {
    method: '*', path: '/health', auth: 'none', surfaces: ['local'],
    handler: async (_req, _r, ctx) => {
      const { browserManager } = ctx;
      const healthy = browserManager.isHealthy();
      return json({
        status: healthy ? 'healthy' : 'unhealthy',
        activeTab: healthy ? await browserManager.probeActiveTab() : null,
        mode: browserManager.getConnectionMode(),
        uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
        tabs: browserManager.getTabCount(),
        // No `security` field (#2557): the live defenses report through
        // their own call sites, not through /health.
        // Terminal-agent discovery. ONLY a port number — never a token.
        // Tokens flow via the /pty-session HttpOnly cookie path.
        terminalPort: ctx.terminal.readPort(),
      });
    },
  },

  // Refs endpoint — does NOT reset idle timer
  {
    method: '*', path: '/refs', auth: 'root-bearer', surfaces: ['local'],
    handler: (_req, _r, { browserManager }) => json({
      refs: browserManager.getRefMap(),
      url: browserManager.getCurrentUrl(),
      mode: browserManager.getConnectionMode(),
    }),
  },

  // GET /memory — diagnostic snapshot, does NOT reset idle. Root-bearer: it
  // sat behind the if-chain's blanket root-bearer check, so the SSE cookie
  // its handler also accepted never reached it.
  {
    method: 'GET', path: '/memory', auth: 'root-bearer', surfaces: ['local'],
    handler: async (_req, _r, ctx) => {
      const { buildMemorySnapshotJson } = await import('../memory-command');
      const snapshot = await buildMemorySnapshotJson(ctx.browserManager);
      // sanitizeReplacer is required at every JSON egress that ships
      // page-content-derived strings — tab.url and tab.title come from page
      // content.
      return json(snapshot, { replacer: sanitizeReplacer });
    },
  },
];
