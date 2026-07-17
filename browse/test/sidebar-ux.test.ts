/**
 * Source-contract tests for the terminal-first browser sidepanel.
 *
 * The one-shot chat queue and sidebar-agent daemon were removed. These
 * checks intentionally cover the current PTY surface and its retained debug
 * tools without preserving obsolete chat implementation details.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const BROWSE_ROOT = path.resolve(import.meta.dir, '..');
const REPO_ROOT = path.resolve(BROWSE_ROOT, '..');
const EXTENSION_ROOT = path.join(REPO_ROOT, 'extension');

const html = fs.readFileSync(path.join(EXTENSION_ROOT, 'sidepanel.html'), 'utf8');
const sidepanel = fs.readFileSync(path.join(EXTENSION_ROOT, 'sidepanel.js'), 'utf8');
const terminal = fs.readFileSync(path.join(EXTENSION_ROOT, 'sidepanel-terminal.js'), 'utf8');
const background = fs.readFileSync(path.join(EXTENSION_ROOT, 'background.js'), 'utf8');

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('terminal-first sidepanel', () => {
  test('terminal is the sole active primary pane', () => {
    const activeMainIds = [...html.matchAll(
      /<main\s+id="([^"]+)"\s+class="[^"]*\bactive\b[^"]*"/g,
    )].map((match) => match[1]);

    expect(activeMainIds).toEqual(['tab-terminal']);
    expect(html).toContain('id="tab-terminal"');
    expect(html).toContain('role="tabpanel" aria-label="Terminal"');
    expect(html).not.toContain('id="tab-chat"');
    expect(sidepanel).toContain("const PRIMARY_PANE_ID = 'tab-terminal';");
    expect(sidepanel).toContain('document.getElementById(PRIMARY_PANE_ID).classList.add(\'active\')');
  });

  test('xterm, fit, and terminal bootstrap assets are shipped and ordered', () => {
    const assets = [
      'lib/xterm.css',
      'lib/xterm.js',
      'lib/xterm-addon-fit.js',
      'sidepanel-terminal.js',
    ];
    for (const asset of assets) {
      expect(fs.existsSync(path.join(EXTENSION_ROOT, asset))).toBe(true);
      expect(html).toContain(asset);
    }

    const scriptOrder = [
      html.indexOf('lib/xterm.js'),
      html.indexOf('lib/xterm-addon-fit.js'),
      html.indexOf('sidepanel.js'),
      html.indexOf('sidepanel-terminal.js'),
    ];
    expect(scriptOrder.every((index) => index >= 0)).toBe(true);
    expect(scriptOrder).toEqual([...scriptOrder].sort((left, right) => left - right));

    for (const id of [
      'terminal-bootstrap',
      'terminal-bootstrap-status',
      'terminal-install-card',
      'terminal-mount',
      'terminal-ended',
      'terminal-restart',
      'terminal-restart-now',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(terminal).toContain("setState(STATE.IDLE, { message: 'Starting Claude Code...' })");
    expect(terminal).toContain('tryAutoConnect();');
  });

  test('retired chat queue code and daemon stay removed', () => {
    const executableSidepanel = withoutComments(sidepanel);
    const executableTerminal = withoutComments(terminal);
    const removedFunctions = ['sendMessage', 'pollChat', 'switchChatTab'];

    expect(fs.existsSync(path.join(BROWSE_ROOT, 'src', 'sidebar-agent.ts'))).toBe(false);
    for (const name of removedFunctions) {
      const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
      expect(executableSidepanel).not.toMatch(declaration);
      expect(executableTerminal).not.toMatch(declaration);
    }
    expect(executableSidepanel).not.toContain('/sidebar-chat');
    expect(executableSidepanel).not.toContain('/sidebar-command');
    expect(html).not.toContain('id="chat-input"');
    expect(html).not.toContain('id="chat-messages"');
    expect(html).not.toContain('id="stop-agent-btn"');
  });
});

describe('PTY lifecycle security', () => {
  test('bootstrap uses authenticated POST and a one-use WebSocket protocol token', () => {
    const connection = between(sidepanel, 'function updateConnection(', '// ─── Port Configuration');
    const mint = between(terminal, 'async function mintSession()', 'function startReattachLoop(');

    expect(connection).toContain('window.gstackServerPort');
    expect(connection).toContain('window.gstackAuthToken');
    expect(mint).toContain('`http://127.0.0.1:${serverPort}/pty-session`');
    expect(mint).toContain("method: 'POST'");
    expect(mint).toContain("'Authorization': `Bearer ${token}`");
    expect(mint).toContain("credentials: 'include'");
    expect(terminal).toContain('const attachToken = minted.attachToken || minted.ptySessionToken');
    expect(terminal).toContain(
      'new WebSocket(`ws://127.0.0.1:${terminalPort}/ws`, [`gstack-pty.${attachToken}`])',
    );
    expect(terminal).not.toContain('?token=');
  });

  test('session identity is retained only for explicit pagehide disposal', () => {
    const disposal = sidepanel.slice(sidepanel.indexOf("window.addEventListener('pagehide'"));

    expect(terminal).toContain('currentSessionId = sessionId || null');
    expect(terminal).toContain('window.gstackPtySession = currentSessionId');
    expect(disposal).toContain('const sessionId = window.gstackPtySession');
    expect(disposal).toContain('const authToken = window.gstackAuthToken');
    expect(disposal).toContain('if (!sessionId || !authToken || !port) return');
    expect(disposal).toContain('JSON.stringify({ sessionId, authToken })');
    expect(disposal).toContain('navigator.sendBeacon(`http://127.0.0.1:${port}/pty-dispose`, blob)');
    expect(disposal).not.toContain('?token=');
  });

  test('tab state crosses the extension boundary only through the live PTY relay', () => {
    const push = between(background, 'async function pushTabState(', "chrome.tabs.onActivated.addListener");
    const sidepanelRelay = between(sidepanel, "if (msg.type === 'browserTabState')", '// ─── v1.44 pagehide');
    const terminalRelay = between(
      terminal,
      "document.addEventListener('gstack:tab-state'",
      '// Repaint after a debug-tab',
    );

    expect(push).toContain("type: 'browserTabState'");
    expect(push).toContain('...snapshot');
    expect(background).toContain("pushTabState('activated')");
    expect(background).toContain("pushTabState('created')");
    expect(background).toContain("pushTabState('removed')");
    expect(sidepanelRelay).toContain("new CustomEvent('gstack:tab-state'");
    expect(sidepanelRelay).toContain('detail: { active: msg.active, tabs: msg.tabs, reason: msg.reason }');
    expect(terminalRelay).toContain('if (!ws || ws.readyState !== WebSocket.OPEN) return');
    expect(terminalRelay).toContain("type: 'tabState'");
    expect(terminalRelay).toContain('active: ev.detail?.active');
    expect(terminalRelay).toContain('tabs: ev.detail?.tabs');
  });

  test('page-derived inspector and cleanup prompts are scanned before PTY injection', () => {
    const inspectorSend = between(sidepanel, "inspectorSendBtn.addEventListener('click'", '// ─── Quick Action Helpers');
    const cleanup = between(sidepanel, 'async function runCleanup(', 'async function runScreenshot(');

    for (const block of [inspectorSend, cleanup]) {
      const scan = block.indexOf('gstackScanForPTYInject');
      const inject = block.indexOf('gstackInjectToTerminal');
      expect(scan).toBeGreaterThan(0);
      expect(inject).toBeGreaterThan(scan);
      expect(block).toContain("verdict === 'BLOCK'");
      expect(block).toContain("verdict === 'WARN'");
    }
  });
});

describe('retained debug tools and quick actions', () => {
  test('activity, refs, and inspector remain hidden debug panels', () => {
    const debugNav = between(html, '<nav class="tabs debug-tabs"', '</nav>');

    expect(html).toContain('id="tab-activity"');
    expect(html).toContain('id="activity-feed"');
    expect(html).toContain('id="tab-refs"');
    expect(html).toContain('id="refs-list"');
    expect(html).toContain('id="tab-inspector"');
    expect(html).toContain('id="inspector-content"');
    expect(debugNav).toContain('id="debug-tabs"');
    expect(debugNav).toContain('style="display:none"');
    expect([...debugNav.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'activity',
      'refs',
      'inspector',
    ]);
  });

  test('debug streams use the authenticated current endpoints', () => {
    const refs = between(sidepanel, 'async function fetchRefs()', '// ─── Inspector Tab');
    const sseCookie = between(sidepanel, 'async function ensureSseSessionCookie()', 'async function connectSSE()');
    const inspectorSse = between(sidepanel, 'async function connectInspectorSSE()', '// ─── Server Discovery');

    expect(refs).toContain('`${serverUrl}/refs`');
    expect(refs).toContain("headers['Authorization'] = `Bearer ${serverToken}`");
    expect(sseCookie).toContain('`${serverUrl}/sse-session`');
    expect(sseCookie).toContain("method: 'POST'");
    expect(sseCookie).toContain("'Authorization': `Bearer ${serverToken}`");
    expect(inspectorSse).toContain('await ensureSseSessionCookie()');
    expect(inspectorSse).toContain('`${serverUrl}/inspector/events?_=${Date.now()}`');
    expect(inspectorSse).toContain('new EventSource(url, { withCredentials: true })');
  });

  test('terminal toolbar exposes exactly the current quick actions', () => {
    const toolbar = between(html, '<div class="terminal-toolbar"', '<div class="terminal-bootstrap"');
    const buttonIds = [...toolbar.matchAll(/<button[^>]+id="([^"]+)"/g)].map((match) => match[1]);

    expect(buttonIds).toEqual([
      'chat-cleanup-btn',
      'chat-screenshot-btn',
      'chat-cookies-btn',
      'terminal-restart-now',
    ]);
    expect(toolbar).toContain('🧹 Cleanup');
    expect(toolbar).toContain('📸 Screenshot');
    expect(toolbar).toContain('🍪 Cookies');
    expect(toolbar).toContain('↻ Restart');
    expect(toolbar).not.toContain('<input');
    expect(toolbar).not.toContain('<textarea');
  });

  test('quick actions route through the PTY or authenticated local command API', () => {
    const cleanup = between(sidepanel, 'async function runCleanup(', 'async function runScreenshot(');
    const screenshot = between(sidepanel, 'async function runScreenshot(', '// ─── Wire up all cleanup');
    const cookies = between(sidepanel, "getElementById('chat-cookies-btn')", '// ─── Debug Tabs');

    expect(cleanup).toContain("'$B cleanup --all'");
    expect(cleanup).toContain('window.gstackInjectToTerminal');
    expect(cleanup).not.toContain('/sidebar-command');
    expect(screenshot).toContain('`${serverUrl}/command`');
    expect(screenshot).toContain("command: 'screenshot'");
    expect(screenshot).toContain('headers: { ...authHeaders()');
    expect(cookies).toContain('`${serverUrl}/command`');
    expect(cookies).toContain("command: 'goto'");
    expect(cookies).toContain('`${serverUrl}/cookie-picker`');
    expect(cookies).toContain('headers: authHeaders()');
  });
});
