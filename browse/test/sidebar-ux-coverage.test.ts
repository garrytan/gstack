/**
 * Sidebar UX coverage ledger and the pins upstream had not restored.
 *
 * Reconciliation from PR #1984. `sidebar-ux.test.ts` now tracks upstream
 * verbatim, so the ledger and the net-new pins live here instead of
 * re-opening that file's history.
 *
 *
 * ─── Coverage preservation ledger (PR #1984 reconciliation) ─────────
 *
 * The June 2026 PR #1984 rewrite deleted 1,613 stale chat-era assertions
 * from this file and replaced them with 244 source-pattern lines. Upstream
 * has since reworked every surface those lines pinned. Deleted assertion
 * groups and their CURRENT homes:
 *
 *  1. Chat queue + model router (sidebar-agent.ts, /sidebar-command,
 *     /sidebar-chat, /sidebar-tabs, /sidebar-session, per-tab chat
 *     context, stop button, chat polling, processAgentEvent,
 *     pickSidebarModel, ANALYSIS_WORDS, ACTION_PATTERNS)
 *     → absence-pinned in sidebar-tabs.test.ts
 *       ('server.ts: chat / sidebar-agent endpoints are gone',
 *        'No pickSidebarModel/word-list declarations',
 *        'cli.ts: sidebar-agent is no longer spawned')
 *  2. Terminal pane primary surface + toolbar quick actions
 *     → sidebar-tabs.test.ts ('Terminal pane is .active by default and
 *        has the toolbar', 'Quick-actions buttons survive in the terminal
 *        toolbar', 'No chat input / send button / experimental banner')
 *  3. /health liveness contract (terminalPort survives; chatEnabled,
 *     agentStatus, messageQueue, agentStartTime absent)
 *     → extension-token.test.ts ('GET /health is liveness-only') —
 *        behavioral: builds the real fetch handler and asserts the body
 *  4. PTY autoconnect / reattach / restart / dispose
 *     → sidepanel-patient-autoconnect.test.ts (v1.44+ patience loop),
 *       sidepanel-reattach.test.ts (reattach backoff + RIS replay),
 *       sidepanel-restart-dispose.test.ts (forceRestart via /pty-restart)
 *  5. Quick-action toolbar injection (cleanup/screenshot/cookies)
 *     → this file: 'cleanup and screenshot buttons' + 'LLM-based cleanup'
 *  6. CSP fallback basic picker → this file: 'CSP fallback basic picker'
 *  7. Cleanup heuristics → this file: 'cleanup heuristics
 *     (write-commands.ts)' + 'LLM-based cleanup'
 *  8. Welcome page + auto-open + arrow hint chain → this file:
 *     'welcome page', 'server /welcome endpoint', 'sidebar auto-open
 *     (background.js)', 'sidebar arrow hint hide flow'
 *  9. Auth race + startup health retry → this file:
 *     'sidebar auth race prevention', 'startup health check fast-retry'
 * 10. Tab tracking + no-focus-steal → this file: 'browser tab bar',
 *     'sidebar→browser tab switch', 'browser→sidebar tab sync',
 *     'tab switching does not steal focus'
 * 11. Terminal-agent shutdown teardown → terminal-agent.test.ts
 *     (disposeSession idempotency: SIGINT-then-SIGKILL)
 * 12. PTY routes off the tunnel allowlist → terminal-agent.test.ts
 *     ('Source-level guard: /pty-session is not on the tunnel surface')
 *
 * Net-new pins restored at the bottom of this file (verified against
 * current sources; gaps left by the upstream rewrite): debug panes behind
 * the debug toggle, xterm asset loading, terminal-mount bootstrap,
 * terminal auto-connect without a chat keypress, and terminal-toolbar
 * CSS styling.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

// ─── Terminal pane structure (restored from PR #1984) ────────────

describe('terminal pane structure (sidepanel.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');

  test('terminal-mount and debug panes survive the chat rip', () => {
    expect(html).toContain('id="terminal-mount"');
    expect(html).toContain('id="tab-activity"');
    expect(html).toContain('id="tab-refs"');
    expect(html).toContain('id="tab-inspector"');
    expect(html).toContain('id="debug-toggle"');
    expect(html).toContain('id="debug-tabs"');
  });

  test('xterm assets and terminal bootstrap script are loaded', () => {
    expect(html).toContain('lib/xterm.js');
    expect(html).toContain('lib/xterm-addon-fit.js');
    expect(html).toContain('sidepanel-terminal.js');
  });
});

describe('terminal auto-connect (sidepanel-terminal.js)', () => {
  const termSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel-terminal.js'), 'utf-8');

  test('terminal auto-connects without waiting for a chat keypress', () => {
    expect(termSrc).toContain('tryAutoConnect');
    expect(termSrc).not.toContain('function onAnyKey');
    expect(termSrc).not.toContain("addEventListener('keydown'");
  });

  test('terminal mints a PTY session over websocket with attach-token protocol', () => {
    expect(termSrc).toContain('/pty-session');
    expect(termSrc).toContain('new WebSocket');
    expect(termSrc).toContain('gstack-pty.');
    expect(termSrc).toContain('keepalive');
  });
});

describe('terminal toolbar styling (sidepanel.css)', () => {
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('terminal toolbar and debug toggle stay styled', () => {
    expect(css).toContain('.terminal-toolbar');
    expect(css).toContain('.terminal-toolbar-btn');
    expect(css).toContain('.debug-toggle');
  });
});
