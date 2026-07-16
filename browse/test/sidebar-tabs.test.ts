/**
 * Regression: sidebar layout invariants after the chat-tab rip.
 *
 * The Chrome side panel used to host two surfaces: Chat (one-shot
 * `claude -p` queue) and Terminal (interactive PTY). Chat was ripped
 * once the PTY proved out — sidebar-agent.ts is gone, the chat queue
 * endpoints are gone, and the primary-tab nav (Terminal | Chat) is
 * gone. Terminal is now the sole primary surface.
 *
 * This file locks the load-bearing invariants of that layout so a
 * future refactor can't silently re-introduce the old surface or break
 * the new one.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const HTML = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.html'), 'utf-8');
const JS = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.js'), 'utf-8');
const TERM_JS = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel-terminal.js'), 'utf-8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../extension/manifest.json'), 'utf-8'));

describe('sidebar: chat tab + nav are removed, Terminal is sole primary surface', () => {
  test('No primary-tab nav element exists', () => {
    expect(HTML).not.toContain('class="primary-tabs"');
    expect(HTML).not.toContain('data-pane="chat"');
    expect(HTML).not.toContain('data-pane="terminal"');
  });

  test('No <main id="tab-chat"> pane', () => {
    expect(HTML).not.toMatch(/<main[^>]*id="tab-chat"/);
    expect(HTML).not.toContain('id="chat-messages"');
    expect(HTML).not.toContain('id="chat-loading"');
    expect(HTML).not.toContain('id="chat-welcome"');
  });

  test('No chat input / send button / experimental banner', () => {
    expect(HTML).not.toContain('class="command-bar"');
    expect(HTML).not.toContain('id="command-input"');
    expect(HTML).not.toContain('id="send-btn"');
    expect(HTML).not.toContain('id="stop-agent-btn"');
    expect(HTML).not.toContain('id="experimental-banner"');
  });

  test('No clear-chat button in footer', () => {
    expect(HTML).not.toContain('id="clear-chat"');
  });

  test('Terminal pane is .active by default and has the toolbar', () => {
    expect(HTML).toMatch(/<main[^>]*id="tab-terminal"[^>]*class="tab-content active"/);
    expect(HTML).toContain('id="terminal-toolbar"');
    expect(HTML).toContain('id="terminal-restart-now"');
  });

  test('Quick-actions buttons (Cleanup / Screenshot / Cookies) survive in the terminal toolbar', () => {
    // Garry explicitly wanted these kept after the chat rip — they drive
    // browser actions, not chat.
    expect(HTML).toContain('id="chat-cleanup-btn"');
    expect(HTML).toContain('id="chat-screenshot-btn"');
    expect(HTML).toContain('id="chat-cookies-btn"');
    // They live inside the terminal toolbar now (siblings of the Restart
    // button), not as a separate strip below all panes.
    const toolbarStart = HTML.indexOf('id="terminal-toolbar"');
    const toolbarEnd = HTML.indexOf('</div>', toolbarStart);
    const toolbarBlock = HTML.slice(toolbarStart, toolbarEnd + 6);
    expect(toolbarBlock).toContain('id="chat-cleanup-btn"');
    expect(toolbarBlock).toContain('id="chat-screenshot-btn"');
    expect(toolbarBlock).toContain('id="chat-cookies-btn"');
  });
});

describe('sidepanel.js: chat helpers ripped, terminal-injection helper survives', () => {
  test('No primary-tab click handler', () => {
    expect(JS).not.toContain("querySelectorAll('.primary-tab')");
    expect(JS).not.toContain('activePrimaryPaneId');
  });

  test('No chat polling, sendMessage, sendChat, stopAgent, or pollTabs', () => {
    expect(JS).not.toContain('chatPollInterval');
    expect(JS).not.toContain('function sendMessage');
    expect(JS).not.toContain('function pollChat');
    expect(JS).not.toContain('function pollTabs');
    expect(JS).not.toContain('function switchChatTab');
    expect(JS).not.toContain('function stopAgent');
    expect(JS).not.toContain('function applyChatEnabled');
    expect(JS).not.toContain('function showSecurityBanner');
  });

  test('Cleanup runs through the live PTY (no /sidebar-command POST)', () => {
    // The new Cleanup handler injects the prompt straight into claude's
    // PTY via gstackInjectToTerminal. The dead code path was a POST to
    // /sidebar-command which kicked off a fresh claude -p subprocess.
    const cleanup = JS.slice(JS.indexOf('async function runCleanup'));
    expect(cleanup).toContain('window.gstackInjectToTerminal');
    expect(cleanup).not.toContain('/sidebar-command');
    expect(cleanup).not.toContain('addChatEntry');
  });

  test('Inspector "Send to Code" routes through the live PTY', () => {
    const sendBtn = JS.slice(JS.indexOf('inspectorSendBtn.addEventListener'));
    expect(sendBtn).toContain('window.gstackInjectToTerminal');
    expect(sendBtn).not.toContain("type: 'sidebar-command'");
  });

  test('updateConnection no longer kicks off chat / tab polling', () => {
    const update = JS.slice(JS.indexOf('function updateConnection'), JS.indexOf('function updateConnection') + 1500);
    expect(update).not.toContain('chatPollInterval');
    expect(update).not.toContain('tabPollInterval');
    expect(update).not.toContain('pollChat');
    expect(update).not.toContain('pollTabs');
    // BUT must still expose the bootstrap globals for sidepanel-terminal.js.
    expect(update).toContain('window.gstackServerPort');
    expect(update).toContain('window.gstackAuthToken');
  });
});

describe('sidepanel-terminal.js: eager auto-connect + injection API', () => {
  test('Exposes window.gstackInjectToTerminal for cross-pane use', () => {
    expect(TERM_JS).toContain('window.gstackInjectToTerminal');
    // Returns false when no live session, true when bytes go out.
    const inject = TERM_JS.slice(TERM_JS.indexOf('window.gstackInjectToTerminal'));
    expect(inject).toContain('return false');
    expect(inject).toContain('return true');
    expect(inject).toContain('ws.readyState !== WebSocket.OPEN');
  });

  test('Auto-connects on init (no keypress required)', () => {
    expect(TERM_JS).not.toContain('function onAnyKey');
    expect(TERM_JS).not.toContain("addEventListener('keydown'");
    expect(TERM_JS).toContain('function tryAutoConnect');
  });

  test('Repaint hook fires when Terminal pane becomes visible', () => {
    // The chat-tab rip removed gstack:primary-tab-changed; we use a
    // MutationObserver on #tab-terminal's class attr instead. The
    // observer must call repaintIfLive when the .active class returns.
    expect(TERM_JS).toContain('MutationObserver');
    expect(TERM_JS).toContain("attributeFilter: ['class']");
    expect(TERM_JS).toContain('repaintIfLive');
    const repaint = TERM_JS.slice(TERM_JS.indexOf('function repaintIfLive'));
    expect(repaint).toContain('fitAddon && fitAddon.fit()');
    expect(repaint).toContain('term.refresh');
    expect(repaint).toContain("type: 'resize'");
  });

  test('No auto-reconnect on close (Restart is user-initiated)', () => {
    const closeOnly = TERM_JS.slice(
      TERM_JS.indexOf("ws.addEventListener('close'"),
      TERM_JS.indexOf("ws.addEventListener('error'"),
    );
    expect(closeOnly).not.toContain('setTimeout');
    expect(closeOnly).not.toContain('tryAutoConnect');
    expect(closeOnly).not.toContain('connect()');
  });

  test('forceRestart helper closes ws, disposes xterm, returns to IDLE', () => {
    expect(TERM_JS).toContain('function forceRestart');
    const fn = TERM_JS.slice(TERM_JS.indexOf('function forceRestart'));
    expect(fn).toContain('ws && ws.close()');
    expect(fn).toContain('term.dispose()');
    expect(fn).toContain('STATE.IDLE');
    expect(fn).toContain('tryAutoConnect()');
  });

  test('Both restart buttons (mid-session and ENDED) call forceRestart', () => {
    expect(TERM_JS).toContain("els.restart?.addEventListener('click', forceRestart)");
    expect(TERM_JS).toContain("els.restartNow?.addEventListener('click', forceRestart)");
  });
});

describe('server.ts: chat / sidebar-agent endpoints are gone', () => {
  const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');

  test('No /sidebar-command, /sidebar-chat, /sidebar-agent/* routes', () => {
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-command['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-chat['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname\.startsWith\(['"]\/sidebar-agent\//);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-agent\/event['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-tabs['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-session['"]/);
  });

  test('No chat-related state declarations or helpers', () => {
    // Allow the symbol names inside the rip-marker comments — but no
    // `let`, `const`, `function`, or `interface` declarations of them.
    expect(SERVER_SRC).not.toMatch(/^let agentProcess/m);
    expect(SERVER_SRC).not.toMatch(/^let agentStatus/m);
    expect(SERVER_SRC).not.toMatch(/^let messageQueue/m);
    expect(SERVER_SRC).not.toMatch(/^let sidebarSession/m);
    expect(SERVER_SRC).not.toMatch(/^const tabAgents/m);
    expect(SERVER_SRC).not.toMatch(/^function pickSidebarModel/m);
    expect(SERVER_SRC).not.toMatch(/^function processAgentEvent/m);
    expect(SERVER_SRC).not.toMatch(/^function killAgent/m);
    expect(SERVER_SRC).not.toMatch(/^function addChatEntry/m);
    expect(SERVER_SRC).not.toMatch(/^interface ChatEntry/m);
    expect(SERVER_SRC).not.toMatch(/^interface SidebarSession/m);
  });

  test('/health no longer surfaces agentStatus or messageQueue length', () => {
    const health = SERVER_SRC.slice(SERVER_SRC.indexOf("url.pathname === '/health'"));
    const slice = health.slice(0, 2000);
    expect(slice).not.toContain('agentStatus');
    expect(slice).not.toContain('messageQueue');
    expect(slice).not.toContain('agentStartTime');
    // chatEnabled is hardcoded false now (older clients still see the field).
    expect(slice).toMatch(/chatEnabled:\s*false/);
    // terminalPort survives.
    expect(slice).toContain('terminalPort');
  });
});

describe('cli.ts: sidebar-agent is no longer spawned', () => {
  const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');

  test('No Bun.spawn of sidebar-agent.ts', () => {
    expect(CLI_SRC).not.toMatch(/Bun\.spawn\(\s*\['bun',\s*'run',\s*\w*[Aa]gent[Ss]cript\][\s\S]{0,300}sidebar-agent/);
    // The variable name `agentScript` was for sidebar-agent. After the
    // rip there's only termAgentScript. Allow comments to mention the
    // history but not active spawn calls.
    expect(CLI_SRC).not.toMatch(/^\s*let agentScript = path\.resolve/m);
  });

  test('Terminal-agent spawn survives', () => {
    expect(CLI_SRC).toContain('terminal-agent.ts');
    expect(CLI_SRC).toMatch(/Bun\.spawn\(\['bun',\s*'run',\s*termAgentScript\]/);
  });
});

describe('files: sidebar-agent.ts and its tests are deleted', () => {
  test('browse/src/sidebar-agent.ts is gone', () => {
    expect(fs.existsSync(path.join(import.meta.dir, '../src/sidebar-agent.ts'))).toBe(false);
  });

  test('sidebar-agent test files are gone', () => {
    expect(fs.existsSync(path.join(import.meta.dir, 'sidebar-agent.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(import.meta.dir, 'sidebar-agent-roundtrip.test.ts'))).toBe(false);
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
    const csp = MANIFEST.content_security_policy;
    if (csp && csp.extension_pages) {
      expect(csp.extension_pages).not.toContain('unsafe-eval');
    }
  });
});

describe('manifest: live tab awareness needs "tabs" permission', () => {
  // Without "tabs", chrome.tabs.query() returns tab objects with undefined
  // url/title for any site outside host_permissions (e.g., everything except
  // 127.0.0.1). snapshotTabs() then writes empty strings into tabs.json and
  // active-tab.json silently skips the write — the sidebar agent loses track
  // of what page the user is on. activeTab is too narrow (only after a user
  // gesture on the extension action) for background polling.
  test('permissions includes "tabs"', () => {
    expect(MANIFEST.permissions).toContain('tabs');
  });
});
