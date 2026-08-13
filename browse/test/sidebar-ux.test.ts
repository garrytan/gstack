/**
 * Sidebar UX regression coverage.
 *
 * The old sidebar-chat surface was removed when the live PTY terminal became
 * the primary sidebar experience. This file used to assert the removed
 * one-shot `sidebar-agent.ts` chat queue, including pickSidebarModel(),
 * ANALYSIS_WORDS, and ACTION_PATTERNS. Those assertions made main red after
 * v1.57.10.0. These tests now pin the current UX contract instead:
 * Terminal is the only primary surface, browser quick-actions survive, and
 * removed chat/model-router code stays removed.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf-8');
const BM_SRC = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');
const WRITE_COMMANDS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'write-commands.ts'), 'utf-8');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');
const JS = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
const TERM_JS = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel-terminal.js'), 'utf-8');
const CSS = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');
const BG_SRC = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, '..', 'extension', 'content.js'), 'utf-8');
const WELCOME_SRC = fs.readFileSync(path.join(ROOT, 'src', 'welcome.html'), 'utf-8');

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = source.indexOf(end, i + start.length);
  expect(j).toBeGreaterThan(i);
  return source.slice(i, j);
}

describe('sidebar terminal-first layout', () => {
  test('terminal pane is the only primary surface', () => {
    expect(HTML).toMatch(/<main[^>]*id="tab-terminal"[^>]*class="tab-content active"/);
    expect(HTML).toContain('id="terminal-mount"');
    expect(HTML).toContain('id="terminal-toolbar"');
    expect(HTML).toContain('id="terminal-restart-now"');
    expect(HTML).not.toContain('id="tab-chat"');
    expect(HTML).not.toContain('id="command-input"');
    expect(HTML).not.toContain('id="send-btn"');
    expect(HTML).not.toContain('id="stop-agent-btn"');
  });

  test('debug panes remain behind the debug toggle', () => {
    expect(HTML).toContain('id="tab-activity"');
    expect(HTML).toContain('id="tab-refs"');
    expect(HTML).toContain('id="tab-inspector"');
    expect(HTML).toContain('id="debug-toggle"');
    expect(HTML).toContain('id="debug-tabs"');
  });

  test('quick browser actions survive in the terminal toolbar', () => {
    const toolbarBlock = sliceBetween(HTML, 'id="terminal-toolbar"', 'id="terminal-restart-now"');
    expect(toolbarBlock).toContain('id="chat-cleanup-btn"');
    expect(toolbarBlock).toContain('id="chat-screenshot-btn"');
    expect(toolbarBlock).toContain('id="chat-cookies-btn"');
  });

  test('xterm assets and terminal bootstrap script are loaded', () => {
    expect(HTML).toContain('lib/xterm.js');
    expect(HTML).toContain('lib/xterm-addon-fit.js');
    expect(HTML).toContain('sidepanel-terminal.js');
  });
});

describe('removed chat queue and model router stay removed', () => {
  test('server no longer declares sidebar-agent chat state or helpers', () => {
    expect(SERVER_SRC).not.toMatch(/^let agentStatus/m);
    expect(SERVER_SRC).not.toMatch(/^let messageQueue/m);
    expect(SERVER_SRC).not.toMatch(/^let sidebarSession/m);
    expect(SERVER_SRC).not.toMatch(/^const tabAgents/m);
    expect(SERVER_SRC).not.toMatch(/^function processAgentEvent/m);
    expect(SERVER_SRC).not.toMatch(/^function killAgent/m);
    expect(SERVER_SRC).not.toMatch(/^function addChatEntry/m);
  });

  test('pickSidebarModel and its obsolete word lists are gone', () => {
    expect(SERVER_SRC).not.toMatch(/^function pickSidebarModel/m);
    expect(SERVER_SRC).not.toContain('ANALYSIS_WORDS');
    expect(SERVER_SRC).not.toContain('ACTION_PATTERNS');
    expect(SERVER_SRC).toContain('terminal-agent.ts');
  });

  test('server no longer exposes sidebar chat endpoints', () => {
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-command['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-chat['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname\.startsWith\(['"]\/sidebar-agent\//);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-tabs['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-session['"]/);
  });

  test('sidebar-agent file is deleted and terminal-agent is the active process', () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'sidebar-agent.ts'))).toBe(false);
    expect(CLI_SRC).not.toMatch(/^\s*let agentScript = path\.resolve/m);
    expect(CLI_SRC).toContain("import { spawnTerminalAgent } from './terminal-agent-control'");
    expect(CLI_SRC).toContain('spawnTerminalAgent({');
    expect(CLI_SRC).toContain('Terminal agent started');
  });
});

describe('terminal PTY UX', () => {
  test('sidepanel exposes server bootstrap globals for terminal startup', () => {
    const update = JS.slice(JS.indexOf('function updateConnection'), JS.indexOf('function updateConnection') + 1800);
    expect(update).toContain('window.gstackServerPort');
    expect(update).toContain('window.gstackAuthToken');
    expect(update).toContain("{ type: 'sidebarOpened' }");
    expect(update).not.toContain('pollChat');
    expect(update).not.toContain('pollTabs');
  });

  test('terminal auto-connects without waiting for a chat keypress', () => {
    expect(TERM_JS).toContain('function tryAutoConnect');
    expect(TERM_JS).toContain('tryAutoConnect();');
    expect(TERM_JS).not.toContain('function onAnyKey');
    expect(TERM_JS).not.toContain("addEventListener('keydown'");
  });

  test('terminal mints a PTY session and opens websocket with attach token protocol', () => {
    expect(TERM_JS).toContain('/pty-session');
    expect(TERM_JS).toContain('new WebSocket');
    expect(TERM_JS).toContain('gstack-pty.${attachToken}');
    expect(TERM_JS).toContain("{ type: 'resize'");
    expect(TERM_JS).toContain("{ type: 'keepalive' }");
  });

  test('terminal supports reattach replay and user-initiated restart', () => {
    expect(TERM_JS).toContain('/pty-session/reattach');
    expect(TERM_JS).toContain("msg.type === 'reattach-begin'");
    expect(TERM_JS).toContain('function forceRestart');
    expect(TERM_JS).toContain('/pty-restart');
    expect(TERM_JS).toContain("els.restart?.addEventListener('click', forceRestart)");
    expect(TERM_JS).toContain("els.restartNow?.addEventListener('click', forceRestart)");
  });

  test('cross-pane actions inject into the live terminal instead of the removed chat queue', () => {
    const cleanupFn = sliceBetween(JS, 'async function runCleanup', 'async function runScreenshot');
    expect(cleanupFn).toContain('window.gstackInjectToTerminal');
    expect(cleanupFn).toContain('$B cleanup --all');
    expect(cleanupFn).toContain('$B snapshot -i');
    expect(cleanupFn).toContain('$B eval');
    expect(cleanupFn).not.toContain('/sidebar-command');

    const inspectorSend = JS.slice(JS.indexOf('inspectorSendBtn.addEventListener'));
    expect(inspectorSend).toContain('window.gstackInjectToTerminal');
    expect(inspectorSend).not.toContain("type: 'sidebar-command'");
  });

  test('screenshot remains deterministic via /command', () => {
    const screenshotFn = sliceBetween(JS, 'async function runScreenshot', '// ─── Wire up all cleanup/screenshot buttons');
    expect(screenshotFn).toContain('/command');
    expect(screenshotFn).toContain("command: 'screenshot'");
  });
});

describe('server routes for terminal and health', () => {
  test('/health exposes terminal state but not chat queue state', () => {
    const health = SERVER_SRC.slice(SERVER_SRC.indexOf("url.pathname === '/health'"));
    const block = health.slice(0, 2200);
    expect(block).toContain('terminalPort');
    expect(block).toMatch(/chatEnabled:\s*false/);
    expect(block).not.toContain('agentStatus');
    expect(block).not.toContain('messageQueue');
    expect(block).not.toContain('agentStartTime');
  });

  test('PTY session routes stay off the tunnel allowlist', () => {
    const tunnelPaths = sliceBetween(SERVER_SRC, 'const TUNNEL_PATHS = new Set<string>([', ']);');
    expect(tunnelPaths).toContain('/connect');
    expect(tunnelPaths).toContain('/command');
    expect(tunnelPaths).not.toContain('/pty-session');
    expect(tunnelPaths).not.toContain('/pty-restart');
    expect(tunnelPaths).not.toContain('/terminal/');
  });

  test('/pty-session validates auth, mints a lease, grants loopback attach, and sets cookie', () => {
    const route = sliceBetween(SERVER_SRC, "url.pathname === '/pty-session' &&", "url.pathname === '/pty-session/reattach'");
    expect(route).toContain('validateAuth(req)');
    expect(route).toContain('mintLease()');
    expect(route).toContain('mintPtySessionToken()');
    expect(route).toContain('grantPtyToken(minted.token');
    expect(route).toContain('Set-Cookie');
  });

  test('/welcome endpoint serves headed-browser onboarding HTML', () => {
    const welcome = sliceBetween(SERVER_SRC, "url.pathname === '/welcome'", "url.pathname === '/health'");
    expect(welcome).toContain("'Content-Type': 'text/html");
    expect(welcome).toContain('GStack Browser ready');
    expect(welcome).toContain('status: 200');
    expect(WELCOME_SRC).toContain('GStack Browser');
    expect(WELCOME_SRC).toContain('gstack-extension-ready');
    expect(WELCOME_SRC).toContain('arrow-right');
    expect(WELCOME_SRC).not.toContain('text-align: center');
  });
});

describe('browser tab and focus behavior', () => {
  test('BrowserManager tracks and switches tabs without stealing focus when requested', () => {
    expect(BM_SRC).toContain('switchTab(id: number, opts?');
    expect(BM_SRC).toContain('bringToFront?: boolean');
    expect(BM_SRC).toContain('bringToFront !== false');
    expect(BM_SRC).toContain("context.on('page'");
    expect(BM_SRC).toContain('syncActiveTabByUrl(activeUrl: string)');
  });

  test('handleCommand tab pinning uses bringToFront: false', () => {
    const handleFn = SERVER_SRC.slice(
      SERVER_SRC.indexOf('async function handleCommandInternalImpl('),
      SERVER_SRC.indexOf('async function handleCommandInternal(', SERVER_SRC.indexOf('async function handleCommandInternalImpl(')),
    );
    const switchCalls = handleFn.match(/switchTab\([^\n]+\)/g) || [];
    expect(switchCalls.length).toBeGreaterThan(0);
    for (const call of switchCalls) {
      expect(call).toContain('bringToFront: false');
    }
  });
});

describe('inspector and welcome-page message bridge', () => {
  test('background allowlist includes inspector and sidebar-open messages', () => {
    const allowList = sliceBetween(BG_SRC, 'const ALLOWED_TYPES = new Set([', ']);');
    for (const type of ['sidebarOpened', 'startInspector', 'stopInspector', 'elementPicked', 'pickerCancelled', 'applyStyle', 'inspectResult']) {
      expect(allowList).toContain(type);
    }
  });

  test('sidebarOpened signal hides the welcome arrow only after sidebar connects', () => {
    expect(BG_SRC).toContain("msg.type === 'sidebarOpened'");
    expect(BG_SRC).toContain('chrome.tabs.sendMessage');
    expect(CONTENT_SRC).toContain("msg.type === 'sidebarOpened'");
    expect(CONTENT_SRC).toContain("new CustomEvent('gstack-extension-ready')");
    const beforeListener = CONTENT_SRC.slice(0, CONTENT_SRC.indexOf('chrome.runtime.onMessage'));
    expect(beforeListener).not.toContain("dispatchEvent(new CustomEvent('gstack-extension-ready'))");
  });

  test('content-script basic picker covers CSP fallback inspection', () => {
    expect(CONTENT_SRC).toContain("msg.type === 'startBasicPicker'");
    expect(CONTENT_SRC).toContain('function captureBasicData(');
    expect(CONTENT_SRC).toContain('getComputedStyle(');
    expect(CONTENT_SRC).toContain('document.styleSheets');
    expect(CONTENT_SRC).toContain('cssRules');
    expect(CONTENT_SRC).toContain('same-origin only');
    expect(CONTENT_SRC).toContain('basicPickerSavedOutline');
    expect(CONTENT_SRC).toContain("e.key === 'Escape'");
  });
});

describe('cleanup heuristics and styling', () => {
  test('deterministic cleanup defaults to broad cleanup and has major clutter categories', () => {
    expect(WRITE_COMMANDS_SRC).toContain('if (args.length === 0)');
    expect(WRITE_COMMANDS_SRC).toContain('doAll = true');
    for (const needle of ['ads: [', 'cookies: [', 'social: [', 'overlays: [', 'clutter: [']) {
      expect(WRITE_COMMANDS_SRC).toContain(needle);
    }
  });

  test('cleanup hides overlays, unlocks scroll, and preserves obvious nav', () => {
    expect(WRITE_COMMANDS_SRC).toContain("setProperty('display', 'none', 'important')");
    expect(WRITE_COMMANDS_SRC).toContain("overflow === 'hidden'");
    expect(WRITE_COMMANDS_SRC).toContain("setProperty('overflow', 'auto', 'important')");
    expect(WRITE_COMMANDS_SRC).toContain('preservedTopNav');
    expect(WRITE_COMMANDS_SRC).toContain('viewportWidth * 0.8');
    expect(WRITE_COMMANDS_SRC).toContain("tag === 'nav'");
    expect(WRITE_COMMANDS_SRC).toContain("tag === 'header'");
  });

  test('sidebar CSS keeps terminal toolbar, inspector, and debug UI styled', () => {
    expect(CSS).toContain('.terminal-toolbar');
    expect(CSS).toContain('.terminal-toolbar-btn');
    expect(CSS).toContain('.inspector-action-btn');
    expect(CSS).toContain('.browser-tabs');
    expect(CSS).toContain('.debug-toggle');
  });
});

describe('startup and auth race prevention', () => {
  test('background getPort response includes auth token', () => {
    const getPort = sliceBetween(BG_SRC, "msg.type === 'getPort'", "msg.type === 'getTabState'");
    expect(getPort).toContain('token: authToken');
  });

  test('sidepanel uses token from getPort response when connecting', () => {
    const tryConnectFn = JS.slice(JS.indexOf('async function tryConnect()'), JS.indexOf('// Initial connect', JS.indexOf('async function tryConnect()')));
    expect(tryConnectFn).toContain('resp.token');
    expect(tryConnectFn).not.toContain('updateConnection(url, null)');
  });

  test('startup health check uses fast retry before slow polling', () => {
    expect(BG_SRC).toContain('startupAttempts');
    expect(BG_SRC).toContain('setInterval(async ()');
    expect(BG_SRC).toContain('}, 1000);');
    expect(BG_SRC).toContain('isConnected || startupAttempts >= 15');
    expect(BG_SRC).toContain('setInterval(checkHealth, 10000)');
  });
});
