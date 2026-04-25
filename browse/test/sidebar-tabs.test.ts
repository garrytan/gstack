/**
 * Regression: changing the default sidebar tab to Terminal must NOT break
 * the existing Chat path or the debug-tab return-to logic.
 *
 * Original /plan-eng-review Issue 3A asked for a Playwright + extension
 * E2E test. The codebase doesn't ship Playwright extension launcher
 * infrastructure (extension tests here are source-level), so this regression
 * is implemented as a structural assertion suite over the extension files.
 * That's enough to lock the load-bearing invariants:
 *
 *   1. Terminal is the default-active primary tab.
 *   2. Chat exists as a non-active primary tab.
 *   3. The xterm assets are loaded.
 *   4. The debug-close path no longer hardcodes `tab-chat` (uses the
 *      activePrimaryPaneId helper that respects whichever primary tab
 *      the user has selected).
 *   5. Manifest declares the ws://127.0.0.1 host permission so MV3
 *      doesn't block the WebSocket upgrade.
 *   6. The chat surface (chat-messages, chat input wiring) still exists
 *      and was not accidentally deleted alongside the default-tab change.
 *
 * If a future refactor regresses any of these, this test fails BEFORE the
 * change ships.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const HTML = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.html'), 'utf-8');
const JS = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.js'), 'utf-8');
const TERM_JS = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel-terminal.js'), 'utf-8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../extension/manifest.json'), 'utf-8'));

describe('sidebar tabs regression: Terminal is default, Chat survives', () => {
  test('primary tab bar declares Terminal and Chat with Terminal active', () => {
    // Terminal is the active button.
    expect(HTML).toMatch(/<button[^>]*class="primary-tab active"[^>]*data-pane="terminal"/);
    // Chat is a primary tab, present and non-active.
    expect(HTML).toMatch(/<button[^>]*class="primary-tab"[^>]*data-pane="chat"/);
  });

  test('Terminal pane is active and Chat pane is not active', () => {
    // tab-terminal has the .active class on its <main>.
    expect(HTML).toMatch(/<main id="tab-terminal" class="tab-content active"/);
    // tab-chat is present but NOT active.
    expect(HTML).toMatch(/<main id="tab-chat" class="tab-content"(?! active)/);
  });

  test('xterm assets are loaded for the Terminal pane', () => {
    expect(HTML).toContain('lib/xterm.css');
    expect(HTML).toContain('lib/xterm.js');
    expect(HTML).toContain('lib/xterm-addon-fit.js');
    expect(HTML).toContain('sidepanel-terminal.js');
  });

  test('chat surface still exists (no accidental deletion)', () => {
    // The chat input and chat-messages containers are load-bearing for the
    // existing sidebar-agent flow. If the default-tab change accidentally
    // removed them, this catches it before users do.
    expect(HTML).toContain('id="chat-messages"');
    expect(HTML).toContain('id="chat-loading"');
  });

  test('debug-close path no longer hardcodes tab-chat', () => {
    // Before the Terminal default flip, sidepanel.js had two literal
    // `getElementById('tab-chat').classList.add('active')` calls inside the
    // debug-close handlers. Both must now go through activePrimaryPaneId()
    // so closing debug returns to whichever primary tab is selected.
    expect(JS).toContain('function activePrimaryPaneId');
    // Old hardcoded form is gone (don't ban the string everywhere — there
    // are legitimate references elsewhere in the file).
    const debugToggleBlock = JS.slice(
      JS.indexOf("debugToggle.addEventListener('click'"),
      JS.indexOf("closeDebug.addEventListener('click'"),
    );
    expect(debugToggleBlock).not.toContain("'tab-chat'");
    expect(debugToggleBlock).toContain('activePrimaryPaneId');
  });

  test('primary-tab click handler exists and toggles classes', () => {
    expect(JS).toContain("querySelectorAll('.primary-tab')");
    expect(JS).toContain('aria-selected');
  });
});

describe('sidebar terminal: lazy spawn + auth chain', () => {
  test('terminal JS waits for first key to start (lazy-spawn)', () => {
    expect(TERM_JS).toContain('function onAnyKey');
    expect(TERM_JS).toContain('terminalActive');
    expect(TERM_JS).toContain('connect()');
  });

  test('terminal JS does NOT auto-reconnect on close (codex finding #8)', () => {
    // Close handler transitions to ENDED and shows a restart button,
    // not a reconnect timer.
    const closeBlock = TERM_JS.slice(TERM_JS.indexOf("addEventListener('close'"));
    expect(closeBlock).toContain('ENDED');
    // Forbid bare setTimeout(...connect... patterns inside this file's
    // close handler — would indicate auto-reconnect crept back in.
    expect(TERM_JS).not.toMatch(/close[\s\S]{0,200}setTimeout\([^)]*connect/);
  });

  test('terminal JS reaches /pty-session with the bootstrap auth token', () => {
    expect(TERM_JS).toContain('/pty-session');
    expect(TERM_JS).toContain('Bearer ${token}');
    expect(TERM_JS).toContain('credentials');
  });

  test('terminal JS opens ws://127.0.0.1 (not wss)', () => {
    expect(TERM_JS).toContain('new WebSocket(`ws://127.0.0.1:');
    // Origin is implicit (browser sets chrome-extension://<id>); no manual override.
  });
});

describe('manifest: ws permission + xterm-safe CSP', () => {
  test('host_permissions covers ws localhost', () => {
    expect(MANIFEST.host_permissions).toContain('ws://127.0.0.1:*/');
  });

  test('host_permissions still covers http localhost', () => {
    expect(MANIFEST.host_permissions).toContain('http://127.0.0.1:*/');
  });

  test('manifest does NOT add unsafe-eval to extension_pages CSP', () => {
    // xterm@5 is eval-free (verified at vendor time). If a future xterm
    // upgrade requires unsafe-eval, this test fires and forces a decision.
    const csp = MANIFEST.content_security_policy;
    if (csp && csp.extension_pages) {
      expect(csp.extension_pages).not.toContain('unsafe-eval');
    }
  });
});
