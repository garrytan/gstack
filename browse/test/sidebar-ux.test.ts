/**
 * Tests for sidebar UX changes:
 * - System prompt does not bake in page URL (navigation fix)
 * - --resume is never used (stale context fix)
 * - /sidebar-chat response includes agentStatus
 * - Sidebar HTML has updated banner, placeholder, stop button
 * - Narration instructions present in system prompt
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

// ─── System prompt tests (server.ts spawnClaude) ─────────────────

describe('sidebar system prompt (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('system prompt does not bake in page URL', () => {
    // The old prompt had: `The user is currently viewing: ${pageUrl}`
    // The new prompt should NOT contain this pattern
    // Extract the systemPrompt array from spawnClaude
    const promptSection = serverSrc.slice(
      serverSrc.indexOf('const systemPrompt = ['),
      serverSrc.indexOf("].join('\\n');", serverSrc.indexOf('const systemPrompt = [')) + 15,
    );
    expect(promptSection).not.toContain('currently viewing');
    expect(promptSection).not.toContain('${pageUrl}');
  });

  test('system prompt tells agent to check URL before acting', () => {
    const promptSection = serverSrc.slice(
      serverSrc.indexOf('const systemPrompt = ['),
      serverSrc.indexOf("].join('\\n');", serverSrc.indexOf('const systemPrompt = [')) + 15,
    );
    expect(promptSection).toContain('NEVER');
    expect(promptSection).toContain('navigate back');
    expect(promptSection).toContain('NEVER assume');
    expect(promptSection).toContain('url`');
  });

  test('system prompt includes conciseness and stop instructions', () => {
    const promptSection = serverSrc.slice(
      serverSrc.indexOf('const systemPrompt = ['),
      serverSrc.indexOf("].join('\\n');", serverSrc.indexOf('const systemPrompt = [')) + 15,
    );
    expect(promptSection).toContain('CONCISE');
    expect(promptSection).toContain('STOP');
  });

  test('--resume is never used in spawnClaude args', () => {
    // Extract the spawnClaude function
    const fnStart = serverSrc.indexOf('function spawnClaude(');
    const fnEnd = serverSrc.indexOf('\nfunction ', fnStart + 1);
    const fnBody = serverSrc.slice(fnStart, fnEnd);
    // Should not push --resume to args
    expect(fnBody).not.toContain("'--resume'");
    expect(fnBody).not.toContain('"--resume"');
  });

  test('system prompt includes inspect and style commands', () => {
    const promptSection = serverSrc.slice(
      serverSrc.indexOf('const systemPrompt = ['),
      serverSrc.indexOf("].join('\\n');", serverSrc.indexOf('const systemPrompt = [')) + 15,
    );
    expect(promptSection).toContain('inspect');
    expect(promptSection).toContain('style');
    expect(promptSection).toContain('cleanup');
  });
});

// ─── /sidebar-chat response includes agentStatus ─────────────────

describe('/sidebar-chat agentStatus', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('sidebar-chat response includes agentStatus field', () => {
    // Find the GET /sidebar-chat handler — look for the data response, not the auth error
    const handlerStart = serverSrc.indexOf("url.pathname === '/sidebar-chat'");
    // Find the response that returns entries + total (skip the auth error response)
    const entriesResponse = serverSrc.indexOf('{ entries, total', handlerStart);
    expect(entriesResponse).toBeGreaterThan(handlerStart);
    const responseLine = serverSrc.slice(entriesResponse, entriesResponse + 100);
    expect(responseLine).toContain('agentStatus');
  });
});

// ─── Sidebar HTML tests ──────────────────────────────────────────

describe('sidebar HTML (sidepanel.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');

  test('banner says "Browser co-pilot" not "Standalone mode"', () => {
    expect(html).toContain('Browser co-pilot');
    expect(html).not.toContain('Standalone mode');
  });

  test('input placeholder says "Ask about this page"', () => {
    expect(html).toContain('Ask about this page');
    expect(html).not.toContain('Message Claude Code');
  });

  test('stop button exists with id stop-agent-btn', () => {
    expect(html).toContain('id="stop-agent-btn"');
    expect(html).toContain('class="stop-btn"');
  });

  test('stop button is hidden by default', () => {
    // The stop button should have style="display: none;" initially
    const stopBtnMatch = html.match(/id="stop-agent-btn"[^>]*/);
    expect(stopBtnMatch).not.toBeNull();
    expect(stopBtnMatch![0]).toContain('display: none');
  });
});

// ─── Sidebar JS tests ───────────────────────────────────────────

describe('sidebar JS (sidepanel.js)', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('stopAgent function exists', () => {
    expect(js).toContain('async function stopAgent()');
  });

  test('stopAgent calls /sidebar-agent/stop endpoint', () => {
    expect(js).toContain('/sidebar-agent/stop');
  });

  test('stop button click handler is wired up', () => {
    expect(js).toContain("getElementById('stop-agent-btn')");
    expect(js).toContain('stopAgent');
  });

  test('updateStopButton function exists', () => {
    expect(js).toContain('function updateStopButton(');
  });

  test('agent_start shows stop button', () => {
    // Find the agent_start handler and verify it calls updateStopButton(true)
    const startHandler = js.slice(
      js.indexOf("entry.type === 'agent_start'"),
      js.indexOf("entry.type === 'agent_done'"),
    );
    expect(startHandler).toContain('updateStopButton(true)');
  });

  test('agent_done hides stop button', () => {
    const doneHandler = js.slice(
      js.indexOf("entry.type === 'agent_done'"),
      js.indexOf("entry.type === 'agent_error'"),
    );
    expect(doneHandler).toContain('updateStopButton(false)');
  });

  test('agent_error hides stop button', () => {
    const errorIdx = js.indexOf("entry.type === 'agent_error'");
    const errorHandler = js.slice(errorIdx, errorIdx + 500);
    expect(errorHandler).toContain('updateStopButton(false)');
  });

  test('orphaned thinking cleanup checks agentStatus from server', () => {
    // After polling, if agentStatus !== processing, thinking dots are removed
    expect(js).toContain("data.agentStatus !== 'processing'");
  });

  test('orphaned thinking cleanup removes thinking dots silently', () => {
    // Thinking dots are removed when agent is idle — no "(session ended)"
    // notice, which was removed as noisy false-positive UX
    expect(js).toContain('thinking.remove()');
  });

  test('sendMessage renders user bubble + thinking dots optimistically', () => {
    // sendMessage should create user bubble and agent-thinking BEFORE the server responds
    const sendFn = js.slice(js.indexOf('async function sendMessage()'), js.indexOf('async function sendMessage()') + 2000);
    expect(sendFn).toContain('chat-bubble user');
    expect(sendFn).toContain('agent-thinking');
    expect(sendFn).toContain('lastOptimisticMsg');
  });

  test('fast polling during agent execution (300ms), slow when idle (1000ms)', () => {
    expect(js).toContain('FAST_POLL_MS');
    expect(js).toContain('SLOW_POLL_MS');
    expect(js).toContain('startFastPoll');
    expect(js).toContain('stopFastPoll');
    // Fast = 300ms
    expect(js).toContain('300');
    // Slow = 1000ms
    expect(js).toContain('1000');
  });

  test('agent_done calls stopFastPoll', () => {
    const doneHandler = js.slice(
      js.indexOf("entry.type === 'agent_done'"),
      js.indexOf("entry.type === 'agent_error'"),
    );
    expect(doneHandler).toContain('stopFastPoll');
  });

  test('duplicate user bubble prevention via lastOptimisticMsg', () => {
    expect(js).toContain('lastOptimisticMsg');
    // When polled message matches optimistic, skip rendering
    expect(js).toContain('lastOptimisticMsg === entry.message');
  });
});

// ─── Sidebar agent queue poll (sidebar-agent.ts) ─────────────────

describe('sidebar agent queue poll (sidebar-agent.ts)', () => {
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar-agent.ts'), 'utf-8');

  test('queue poll interval is 200ms or less for fast TTFO', () => {
    const match = agentSrc.match(/const POLL_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const pollMs = parseInt(match![1], 10);
    expect(pollMs).toBeLessThanOrEqual(200);
  });
});

// ─── System prompt size (TTFO optimization) ──────────────────────

describe('system prompt size', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('system prompt is compact (under 30 lines)', () => {
    const start = serverSrc.indexOf('const systemPrompt = [');
    const end = serverSrc.indexOf("].join('\\n');", start);
    const promptBlock = serverSrc.slice(start, end);
    const lines = promptBlock.split('\n').length;
    // Compact prompt = fewer input tokens = faster first response
    // Higher limit accommodates security lines (prompt injection defense, allowed commands)
    expect(lines).toBeLessThan(30);
  });

  test('system prompt does not contain verbose narration examples', () => {
    // We trimmed examples to reduce token count. The agent gets the
    // instruction to narrate, not 6 examples of how.
    const start = serverSrc.indexOf('const systemPrompt = [');
    const end = serverSrc.indexOf("].join('\\n');", start);
    const promptBlock = serverSrc.slice(start, end);
    expect(promptBlock).not.toContain('Examples of good narration');
    expect(promptBlock).not.toContain('I can see a login form');
  });
});

// ─── TTFO latency chain invariants ──────────────────────────────

describe('TTFO latency chain', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar-agent.ts'), 'utf-8');

  test('optimistic render happens BEFORE chrome.runtime.sendMessage', () => {
    // In sendMessage(), the bubble + thinking dots must be created
    // before the async POST to the server
    const sendFn = js.slice(
      js.indexOf('async function sendMessage()'),
      js.indexOf('async function sendMessage()') + 3000,
    );
    const optimisticIdx = sendFn.indexOf('agent-thinking');
    const sendIdx = sendFn.indexOf('chrome.runtime.sendMessage');
    expect(optimisticIdx).toBeGreaterThan(0);
    expect(sendIdx).toBeGreaterThan(0);
    expect(optimisticIdx).toBeLessThan(sendIdx);
  });

  test('sendMessage calls startFastPoll before server request', () => {
    const sendFn = js.slice(
      js.indexOf('async function sendMessage()'),
      js.indexOf('async function sendMessage()') + 3000,
    );
    const fastPollIdx = sendFn.indexOf('startFastPoll');
    const sendIdx = sendFn.indexOf('chrome.runtime.sendMessage');
    expect(fastPollIdx).toBeGreaterThan(0);
    expect(fastPollIdx).toBeLessThan(sendIdx);
  });

  test('agent_start from server does not duplicate thinking dots', () => {
    // When we already showed dots optimistically, agent_start from
    // the poll should skip creating a second set
    const startHandler = js.slice(
      js.indexOf("entry.type === 'agent_start'"),
      js.indexOf("entry.type === 'agent_done'"),
    );
    expect(startHandler).toContain('agent-thinking');
    // Should check if thinking already exists and skip
    expect(startHandler).toContain("getElementById('agent-thinking')");
  });

  test('FAST_POLL_MS is strictly less than SLOW_POLL_MS', () => {
    const fastMatch = js.match(/FAST_POLL_MS\s*=\s*(\d+)/);
    const slowMatch = js.match(/SLOW_POLL_MS\s*=\s*(\d+)/);
    expect(fastMatch).not.toBeNull();
    expect(slowMatch).not.toBeNull();
    expect(parseInt(fastMatch![1], 10)).toBeLessThan(parseInt(slowMatch![1], 10));
  });

  test('stopAgent also calls stopFastPoll', () => {
    const stopFn = js.slice(
      js.indexOf('async function stopAgent()'),
      js.indexOf('async function stopAgent()') + 1000,
    );
    expect(stopFn).toContain('stopFastPoll');
  });
});

// ─── Browser tab bar ────────────────────────────────────────────

describe('browser tab bar (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('/sidebar-tabs endpoint exists', () => {
    expect(serverSrc).toContain("/sidebar-tabs'");
    expect(serverSrc).toContain('getTabListWithTitles');
  });

  test('/sidebar-tabs/switch endpoint exists', () => {
    expect(serverSrc).toContain("/sidebar-tabs/switch'");
    expect(serverSrc).toContain('switchTab');
  });

  test('/sidebar-tabs requires auth', () => {
    // Find the handler and verify auth check
    const handlerIdx = serverSrc.indexOf("/sidebar-tabs'");
    const handlerBlock = serverSrc.slice(handlerIdx, handlerIdx + 300);
    expect(handlerBlock).toContain('validateAuth');
  });
});

describe('browser tab bar (sidepanel.js)', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('pollTabs function exists and calls /sidebar-tabs', () => {
    expect(js).toContain('async function pollTabs()');
    expect(js).toContain('/sidebar-tabs');
  });

  test('renderTabBar function exists', () => {
    expect(js).toContain('function renderTabBar(tabs)');
  });

  test('tab bar hidden when only 1 tab', () => {
    const renderFn = js.slice(
      js.indexOf('function renderTabBar('),
      js.indexOf('function renderTabBar(') + 600,
    );
    expect(renderFn).toContain('tabs.length <= 1');
    expect(renderFn).toContain("display = 'none'");
  });

  test('switchBrowserTab calls /sidebar-tabs/switch', () => {
    expect(js).toContain('async function switchBrowserTab(');
    expect(js).toContain('/sidebar-tabs/switch');
  });

  test('tab polling interval is set on connection', () => {
    expect(js).toContain('tabPollInterval');
    expect(js).toContain('setInterval(pollTabs');
  });

  test('tab polling cleaned up on disconnect', () => {
    expect(js).toContain('clearInterval(tabPollInterval)');
  });

  test('only re-renders when tabs change (diff check)', () => {
    expect(js).toContain('lastTabJson');
    expect(js).toContain('json === lastTabJson');
  });
});

describe('browser tab bar (sidepanel.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');

  test('browser-tabs container exists', () => {
    expect(html).toContain('id="browser-tabs"');
  });

  test('browser-tabs hidden by default', () => {
    const match = html.match(/id="browser-tabs"[^>]*/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('display:none');
  });
});

// ─── Bidirectional tab sync ──────────────────────────────────────

describe('sidebar→browser tab switch', () => {
  const bmSrc = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');

  test('switchTab supports bringToFront option', () => {
    expect(bmSrc).toContain('switchTab(id: number, opts?');
    expect(bmSrc).toContain('bringToFront');
    // Default behavior still brings to front (opt-out, not opt-in)
    expect(bmSrc).toContain('bringToFront !== false');
  });
});

describe('browser→sidebar tab sync', () => {
  const bmSrc = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('syncActiveTabByUrl method exists on BrowserManager', () => {
    expect(bmSrc).toContain('syncActiveTabByUrl(activeUrl: string)');
  });

  test('syncActiveTabByUrl updates activeTabId when URL matches a different tab', () => {
    const fn = bmSrc.slice(
      bmSrc.indexOf('syncActiveTabByUrl('),
      bmSrc.indexOf('syncActiveTabByUrl(') + 1200,
    );
    expect(fn).toContain('this.activeTabId = id');
    // Exact match
    expect(fn).toContain('pageUrl === activeUrl');
    // Fuzzy match (origin+pathname)
    expect(fn).toContain('activeOriginPath');
    expect(fn).toContain('fuzzyId');
  });

  test('context.on("page") tracks user-created tabs', () => {
    expect(bmSrc).toContain("context.on('page'");
    expect(bmSrc).toContain('this.pages.set(id, page)');
    // Should log when new tab detected
    expect(bmSrc).toContain('New tab detected');
  });

  test('page close handler removes tab from pages map', () => {
    expect(bmSrc).toContain("page.on('close'");
    expect(bmSrc).toContain('this.pages.delete(id)');
    expect(bmSrc).toContain('Tab closed');
  });

  test('syncActiveTabByUrl skips when only 1 tab (no ambiguity)', () => {
    const fn = bmSrc.slice(
      bmSrc.indexOf('syncActiveTabByUrl('),
      bmSrc.indexOf('syncActiveTabByUrl(') + 600,
    );
    expect(fn).toContain('this.pages.size <= 1');
  });

  test('/sidebar-tabs reads activeUrl param and calls syncActiveTabByUrl', () => {
    const handler = serverSrc.slice(
      serverSrc.indexOf("/sidebar-tabs'"),
      serverSrc.indexOf("/sidebar-tabs'") + 700,
    );
    expect(handler).toContain("get('activeUrl')");
    expect(handler).toContain('syncActiveTabByUrl');
  });

  test('/sidebar-command syncs activeTabUrl BEFORE reading tabId', () => {
    // The server must call syncActiveTabByUrl before getActiveTabId
    // so the agent targets the correct tab
    const cmdIdx = serverSrc.indexOf("url.pathname === '/sidebar-command'");
    const handler = serverSrc.slice(cmdIdx, cmdIdx + 1200);
    const syncIdx = handler.indexOf('syncActiveTabByUrl');
    const getIdIdx = handler.indexOf('getActiveTabId');
    expect(syncIdx).toBeGreaterThan(0);
    expect(getIdIdx).toBeGreaterThan(syncIdx); // sync happens BEFORE reading ID
  });

  test('background.js listens for chrome.tabs.onActivated', () => {
    const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');
    expect(bgSrc).toContain('chrome.tabs.onActivated.addListener');
    expect(bgSrc).toContain('browserTabActivated');
  });

  test('sidepanel handles browserTabActivated message instantly', () => {
    expect(js).toContain("msg.type === 'browserTabActivated'");
    // Should call switchChatTab for instant context swap
    expect(js).toContain('switchChatTab');
  });

  test('pollTabs sends Chrome active tab URL to server', () => {
    const pollFn = js.slice(
      js.indexOf('async function pollTabs()'),
      js.indexOf('async function pollTabs()') + 800,
    );
    expect(pollFn).toContain('chrome.tabs.query');
    expect(pollFn).toContain('activeUrl=');
  });
});

describe('browser tab bar (sidepanel.css)', () => {
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('browser-tabs styles exist', () => {
    expect(css).toContain('.browser-tabs');
    expect(css).toContain('.browser-tab');
    expect(css).toContain('.browser-tab.active');
  });

  test('tab bar is horizontally scrollable', () => {
    const barStyle = css.slice(
      css.indexOf('.browser-tabs {'),
      css.indexOf('}', css.indexOf('.browser-tabs {')) + 1,
    );
    expect(barStyle).toContain('overflow-x: auto');
  });

  test('active tab is visually distinct', () => {
    const activeStyle = css.slice(
      css.indexOf('.browser-tab.active {'),
      css.indexOf('}', css.indexOf('.browser-tab.active {')) + 1,
    );
    expect(activeStyle).toContain('--bg-surface');
    expect(activeStyle).toContain('--text-body');
  });
});

// ─── Event relay (processAgentEvent) ────────────────────────────

describe('processAgentEvent handles sidebar-agent event types', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  // Extract processAgentEvent function body
  const fnStart = serverSrc.indexOf('function processAgentEvent(');
  const fnEnd = serverSrc.indexOf('\nfunction ', fnStart + 1);
  const fnBody = serverSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 2000);

  test('handles tool_use events directly (not raw Claude stream format)', () => {
    // Must handle { type: 'tool_use', tool, input } from sidebar-agent
    expect(fnBody).toContain("event.type === 'tool_use'");
    expect(fnBody).toContain('event.tool');
    expect(fnBody).toContain('event.input');
  });

  test('handles text_delta events directly', () => {
    expect(fnBody).toContain("event.type === 'text_delta'");
    expect(fnBody).toContain('event.text');
  });

  test('handles text events directly', () => {
    expect(fnBody).toContain("event.type === 'text'");
  });

  test('handles result events', () => {
    expect(fnBody).toContain("event.type === 'result'");
  });

  test('handles agent_error events', () => {
    expect(fnBody).toContain("event.type === 'agent_error'");
    expect(fnBody).toContain('event.error');
  });

  test('does NOT re-parse raw Claude stream events (no content_block_start)', () => {
    // sidebar-agent.ts already transforms these. Server should not duplicate.
    expect(fnBody).not.toContain('content_block_start');
    expect(fnBody).not.toContain('content_block_delta');
    expect(fnBody).not.toContain("event.type === 'assistant'");
  });

  test('all event types call addChatEntry with role: agent', () => {
    // Every addChatEntry in processAgentEvent should have role: 'agent'
    const addCalls = fnBody.match(/addChatEntry\(\{[^}]+\}\)/g) || [];
    for (const call of addCalls) {
      expect(call).toContain("role: 'agent'");
    }
  });
});

// ─── Per-tab chat context ────────────────────────────────────────

describe('per-tab chat context (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('/sidebar-chat accepts tabId query param', () => {
    const handler = serverSrc.slice(
      serverSrc.indexOf("/sidebar-chat'"),
      serverSrc.indexOf("/sidebar-chat'") + 600,
    );
    expect(handler).toContain('tabId');
  });

  test('addChatEntry takes a tabId parameter', () => {
    // addChatEntry should route entries to the correct tab's buffer
    expect(serverSrc).toContain('tabId');
    // Look for tabId in addChatEntry function
    const fnIdx = serverSrc.indexOf('function addChatEntry(');
    if (fnIdx > -1) {
      const fnBody = serverSrc.slice(fnIdx, fnIdx + 300);
      expect(fnBody).toContain('tabId');
    }
  });

  test('spawnClaude passes active tab ID to queue entry', () => {
    const spawnFn = serverSrc.slice(
      serverSrc.indexOf('function spawnClaude('),
      serverSrc.indexOf('\nfunction ', serverSrc.indexOf('function spawnClaude(') + 1),
    );
    expect(spawnFn).toContain('tabId');
  });

  test('tab isolation uses BROWSE_TAB env var instead of system prompt hack', () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar-agent.ts'), 'utf-8');
    // Agent passes BROWSE_TAB env var to claude (not a system prompt instruction)
    expect(agentSrc).toContain('BROWSE_TAB');
    // Server handleCommand reads tabId from body and pins to that tab
    expect(serverSrc).toContain('savedTabId');
    expect(serverSrc).toContain('switchTab(tabId)');
  });
});

describe('per-tab chat context (sidepanel.js)', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('tracks activeTabId for chat context', () => {
    expect(js).toContain('activeTabId');
  });

  test('pollChat sends tabId to server', () => {
    const pollFn = js.slice(
      js.indexOf('async function pollChat()'),
      js.indexOf('async function pollChat()') + 600,
    );
    expect(pollFn).toContain('tabId');
  });

  test('switching tabs swaps displayed chat', () => {
    // When tab changes, old chat is saved and new tab's chat is shown
    expect(js).toContain('switchChatTab');
  });

  test('switchChatTab saves current tab DOM and restores new tab', () => {
    const fn = js.slice(
      js.indexOf('function switchChatTab('),
      js.indexOf('function switchChatTab(') + 800,
    );
    expect(fn).toContain('chatDomByTab');
    expect(fn).toContain('createDocumentFragment');
  });

  test('sendMessage includes tabId in message', () => {
    const sendFn = js.slice(
      js.indexOf('async function sendMessage()'),
      js.indexOf('async function sendMessage()') + 2000,
    );
    expect(sendFn).toContain('tabId');
    expect(sendFn).toContain('sidebarActiveTabId');
  });
});

// ─── Sidebar CSS tests ──────────────────────────────────────────

describe('sidebar CSS (sidepanel.css)', () => {
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('stop button style exists', () => {
    expect(css).toContain('.stop-btn');
  });

  test('stop button uses error color', () => {
    const stopBtnSection = css.slice(
      css.indexOf('.stop-btn {'),
      css.indexOf('}', css.indexOf('.stop-btn {')) + 1,
    );
    expect(stopBtnSection).toContain('--error');
  });

  test('experimental-banner no longer uses amber warning colors', () => {
    const bannerSection = css.slice(
      css.indexOf('.experimental-banner {'),
      css.indexOf('}', css.indexOf('.experimental-banner {')) + 1,
    );
    // Should not be amber/warning anymore
    expect(bannerSection).not.toContain('245, 158, 11, 0.15');
    expect(bannerSection).not.toContain('#F59E0B');
  });

  test('tool description uses system font not mono', () => {
    const toolSection = css.slice(
      css.indexOf('.agent-tool {'),
      css.indexOf('}', css.indexOf('.agent-tool {')) + 1,
    );
    expect(toolSection).toContain('font-system');
    expect(toolSection).not.toContain('font-mono');
  });
});

// ─── Inspector message allowlist fix ────────────────────────────

describe('inspector message allowlist fix', () => {
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');

  test('ALLOWED_TYPES includes inspector message types', () => {
    const allowListSection = bgSrc.slice(
      bgSrc.indexOf('const ALLOWED_TYPES'),
      bgSrc.indexOf(']);', bgSrc.indexOf('const ALLOWED_TYPES')) + 3,
    );
    expect(allowListSection).toContain('startInspector');
    expect(allowListSection).toContain('stopInspector');
    expect(allowListSection).toContain('elementPicked');
    expect(allowListSection).toContain('pickerCancelled');
    expect(allowListSection).toContain('applyStyle');
    expect(allowListSection).toContain('inspectResult');
  });
});

// ─── CSP fallback basic picker ──────────────────────────────────

describe('CSP fallback basic picker', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'content.js'), 'utf-8');
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');

  test('content.js contains startBasicPicker message handler', () => {
    expect(contentSrc).toContain("msg.type === 'startBasicPicker'");
    expect(contentSrc).toContain('startBasicPicker()');
  });

  test('content.js contains captureBasicData function with getComputedStyle', () => {
    expect(contentSrc).toContain('function captureBasicData(');
    expect(contentSrc).toContain('getComputedStyle(');
    expect(contentSrc).toContain('getBoundingClientRect()');
  });

  test('content.js contains CSSOM iteration with cross-origin try/catch', () => {
    expect(contentSrc).toContain('document.styleSheets');
    expect(contentSrc).toContain('cssRules');
    expect(contentSrc).toContain('cross-origin');
  });

  test('content.js saves and restores outline on elements', () => {
    expect(contentSrc).toContain('basicPickerSavedOutline');
    // Outline is restored in cleanup and highlight functions
    expect(contentSrc).toContain('.style.outline = basicPickerSavedOutline');
  });

  test('content.js basic picker sends inspectResult with mode basic', () => {
    expect(contentSrc).toContain("mode: 'basic'");
    expect(contentSrc).toContain("type: 'inspectResult'");
  });

  test('content.js basic picker cleans up on Escape', () => {
    expect(contentSrc).toContain('onBasicKeydown');
    expect(contentSrc).toContain("e.key === 'Escape'");
    expect(contentSrc).toContain('basicPickerCleanup');
  });

  test('background.js injectInspector has separate try blocks for executeScript and insertCSS', () => {
    const injectFn = bgSrc.slice(
      bgSrc.indexOf('async function injectInspector('),
      bgSrc.indexOf('\n}', bgSrc.indexOf('async function injectInspector(') + 1) + 2,
    );
    // executeScript and insertCSS should be in separate try blocks
    expect(injectFn).toContain('executeScript');
    expect(injectFn).toContain('insertCSS');
    // Fallback sends startBasicPicker
    expect(injectFn).toContain("type: 'startBasicPicker'");
    expect(injectFn).toContain("mode: 'basic'");
  });

  test('background.js stores inspectorMode for routing', () => {
    expect(bgSrc).toContain('inspectorMode');
  });
});

// ─── Cleanup and screenshot buttons ─────────────────────────────

describe('cleanup and screenshot buttons', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('sidepanel.html contains cleanup and screenshot buttons in inspector', () => {
    expect(html).toContain('inspector-cleanup-btn');
    expect(html).toContain('inspector-screenshot-btn');
    expect(html).toContain('inspector-action-btn');
  });

  test('sidepanel.html contains cleanup and screenshot buttons in chat toolbar', () => {
    expect(html).toContain('chat-cleanup-btn');
    expect(html).toContain('chat-screenshot-btn');
    expect(html).toContain('quick-actions');
  });

  test('cleanup button sends smart prompt to sidebar agent (not just deterministic selectors)', () => {
    // Should use /sidebar-command endpoint (agent-based) not just /command (deterministic)
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    expect(cleanupFn).toContain('sidebar-command');
    expect(cleanupFn).toContain('cleanupPrompt');
    // Should include both deterministic first pass AND agent snapshot analysis
    expect(cleanupFn).toContain('cleanup --all');
    expect(cleanupFn).toContain('snapshot -i');
    // Should instruct agent to KEEP site branding
    expect(cleanupFn).toContain('KEEP');
    expect(cleanupFn).toContain('header/masthead/logo');
  });

  test('sidepanel.js screenshot handler POSTs to /command with screenshot', () => {
    expect(js).toContain("command: 'screenshot'");
  });

  test('sidepanel.js has notification rendering for type notification', () => {
    expect(js).toContain("entry.type === 'notification'");
    expect(js).toContain('chat-notification');
  });

  test('sidepanel.css contains inspector-action-btn styles', () => {
    expect(css).toContain('.inspector-action-btn');
    expect(css).toContain('.inspector-action-btn.loading');
  });

  test('sidepanel.css contains quick-action-btn styles for chat toolbar', () => {
    expect(css).toContain('.quick-action-btn');
    expect(css).toContain('.quick-action-btn.loading');
    expect(css).toContain('.quick-actions');
  });

  test('cleanup and screenshot use shared helper functions', () => {
    expect(js).toContain('async function runCleanup(');
    expect(js).toContain('async function runScreenshot(');
    // Both inspector and chat buttons are wired
    expect(js).toContain('chatCleanupBtn');
    expect(js).toContain('chatScreenshotBtn');
  });

  test('sidepanel.css contains chat-notification styles', () => {
    expect(css).toContain('.chat-notification');
  });
});

describe('cleanup heuristics (write-commands.ts)', () => {
  const wcSrc = fs.readFileSync(path.join(ROOT, 'src', 'write-commands.ts'), 'utf-8');

  test('cleanup defaults to --all when no args provided', () => {
    // Should not throw on empty args, should default to doAll
    expect(wcSrc).toContain('if (args.length === 0)');
    expect(wcSrc).toContain('doAll = true');
  });

  test('CLEANUP_SELECTORS has overlays category', () => {
    expect(wcSrc).toContain('overlays: [');
    expect(wcSrc).toContain('paywall');
    expect(wcSrc).toContain('newsletter');
    expect(wcSrc).toContain('interstitial');
    expect(wcSrc).toContain('push-notification');
    expect(wcSrc).toContain('app-banner');
  });

  test('CLEANUP_SELECTORS ads has major ad networks', () => {
    expect(wcSrc).toContain('doubleclick');
    expect(wcSrc).toContain('googlesyndication');
    expect(wcSrc).toContain('amazon-adsystem');
    expect(wcSrc).toContain('outbrain');
    expect(wcSrc).toContain('taboola');
    expect(wcSrc).toContain('criteo');
  });

  test('CLEANUP_SELECTORS cookies has major consent frameworks', () => {
    expect(wcSrc).toContain('onetrust');
    expect(wcSrc).toContain('CybotCookiebot');
    expect(wcSrc).toContain('truste');
    expect(wcSrc).toContain('qc-cmp2');
    expect(wcSrc).toContain('Quantcast');
  });

  test('cleanup uses !important to override inline styles', () => {
    // Elements with inline style="display:block" need !important to hide
    expect(wcSrc).toContain("setProperty('display', 'none', 'important')");
  });

  test('cleanup unlocks scroll (body overflow:hidden)', () => {
    expect(wcSrc).toContain("overflow === 'hidden'");
    expect(wcSrc).toContain("setProperty('overflow', 'auto', 'important')");
  });

  test('cleanup removes blur effects (paywall blur)', () => {
    expect(wcSrc).toContain("filter?.includes('blur')");
    expect(wcSrc).toContain("setProperty('filter', 'none', 'important')");
  });

  test('cleanup removes article truncation (max-height)', () => {
    expect(wcSrc).toContain('truncat');
    expect(wcSrc).toContain("setProperty('max-height', 'none', 'important')");
  });

  test('cleanup collapses empty ad placeholder whitespace', () => {
    expect(wcSrc).toContain('empty placeholders');
    // Should check text content length before collapsing
    expect(wcSrc).toContain('text.length < 20');
  });

  test('sticky cleanup skips gstack control indicator', () => {
    expect(wcSrc).toContain("gstack-ctrl");
  });

  test('CLEANUP_SELECTORS has clutter category', () => {
    expect(wcSrc).toContain('clutter: [');
    expect(wcSrc).toContain('audio-player');
    expect(wcSrc).toContain('podcast-player');
    expect(wcSrc).toContain('puzzle');
    expect(wcSrc).toContain('recirculation');
    expect(wcSrc).toContain('everlit');
  });

  test('cleanup removes "ADVERTISEMENT" text labels', () => {
    expect(wcSrc).toContain('adTextPatterns');
    expect(wcSrc).toContain('/^advertisement$/i');
    expect(wcSrc).toContain('/article continues/i');
    expect(wcSrc).toContain('ad labels');
  });

  test('sticky cleanup preserves topmost full-width nav bar', () => {
    // Should preserve the first full-width element near the top
    expect(wcSrc).toContain('preservedTopNav');
    expect(wcSrc).toContain('viewportWidth * 0.8');
    // Should sort sticky elements by vertical position
    expect(wcSrc).toContain('sort((a, b) => a.top - b.top)');
  });
});

describe('chat toolbar buttons disabled state', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('setActionButtonsEnabled function exists', () => {
    expect(js).toContain('function setActionButtonsEnabled(enabled)');
  });

  test('buttons are disabled when disconnected', () => {
    // updateConnection should call setActionButtonsEnabled(false) when no URL
    expect(js).toContain('setActionButtonsEnabled(false)');
    expect(js).toContain('setActionButtonsEnabled(true)');
  });

  test('runCleanup silently returns when disconnected (no error spam)', () => {
    // Should NOT show "Not connected" notification, just return silently
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('\n}', js.indexOf('async function runCleanup(') + 1) + 2,
    );
    expect(cleanupFn).not.toContain('Not connected to browse server');
  });

  test('CSS has disabled style for action buttons', () => {
    expect(css).toContain('.quick-action-btn.disabled');
    expect(css).toContain('.inspector-action-btn.disabled');
    expect(css).toContain('pointer-events: none');
  });
});

// ─── Chat message dedup ─────────────────────────────────────────

describe('chat message dedup (prevents repeat rendering)', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('renderedEntryIds Set exists for dedup tracking', () => {
    expect(js).toContain('const renderedEntryIds = new Set()');
  });

  test('addChatEntry checks entry.id against renderedEntryIds', () => {
    const addFn = js.slice(
      js.indexOf('function addChatEntry(entry)'),
      js.indexOf('\n  // User messages', js.indexOf('function addChatEntry(entry)')),
    );
    expect(addFn).toContain('renderedEntryIds.has(entry.id)');
    expect(addFn).toContain('renderedEntryIds.add(entry.id)');
    // Should return early (skip) if already rendered
    expect(addFn).toContain('return');
  });

  test('addChatEntry skips dedup for entries without id (local notifications)', () => {
    const addFn = js.slice(
      js.indexOf('function addChatEntry(entry)'),
      js.indexOf('\n  // User messages', js.indexOf('function addChatEntry(entry)')),
    );
    // Should only check dedup when entry.id is defined
    expect(addFn).toContain('entry.id !== undefined');
  });

  test('clear chat resets renderedEntryIds', () => {
    expect(js).toContain('renderedEntryIds.clear()');
  });
});

// ─── Agent conciseness and focus stealing ───────────────────────

describe('sidebar agent conciseness + no focus stealing', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');
  const bmSrc = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');

  test('system prompt tells agent to STOP when task is done', () => {
    const promptSection = serverSrc.slice(
      serverSrc.indexOf('const systemPrompt = ['),
      serverSrc.indexOf("].join('\\n');", serverSrc.indexOf('const systemPrompt = [')),
    );
    expect(promptSection).toContain('STOP');
    expect(promptSection).toContain('CONCISE');
    expect(promptSection).toContain('Do NOT keep exploring');
  });

  test('sidebar agent auto-routes model based on message type', () => {
    // Model router exists and defaults to opus for analysis tasks
    expect(serverSrc).toContain('function pickSidebarModel(');
    expect(serverSrc).toContain("return 'opus'");
    expect(serverSrc).toContain("return 'sonnet'");
    // spawnClaude uses the router, not a hardcoded model
    const spawnFn = serverSrc.slice(
      serverSrc.indexOf('function spawnClaude('),
      serverSrc.indexOf('\nfunction ', serverSrc.indexOf('function spawnClaude(') + 1),
    );
    expect(spawnFn).toContain('pickSidebarModel(userMessage)');
  });

  test('switchTab has bringToFront option', () => {
    expect(bmSrc).toContain('bringToFront?: boolean');
    expect(bmSrc).toContain('bringToFront !== false');
  });

  test('handleCommand tab pinning does NOT steal focus', () => {
    // All switchTab calls in handleCommand should use bringToFront: false
    const handleFn = serverSrc.slice(
      serverSrc.indexOf('async function handleCommand('),
      serverSrc.indexOf('\n// ', serverSrc.indexOf('async function handleCommand(') + 200),
    );
    const switchCalls = handleFn.match(/switchTab\([^)]+\)/g) || [];
    for (const call of switchCalls) {
      expect(call).toContain('bringToFront: false');
    }
  });
});

// ─── LLM-based cleanup architecture ─────────────────────────────

describe('LLM-based cleanup (smart agent cleanup)', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const wcSrc = fs.readFileSync(path.join(ROOT, 'src', 'write-commands.ts'), 'utf-8');

  test('cleanup button uses /sidebar-command not /command', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Should POST to sidebar-command (agent) not /command (deterministic)
    expect(cleanupFn).toContain('/sidebar-command');
    // Should NOT directly call the cleanup command endpoint
    expect(cleanupFn).not.toMatch(/fetch.*\/command['"]/);
  });

  test('cleanup prompt includes deterministic first pass', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // First run the deterministic sweep
    expect(cleanupFn).toContain('cleanup --all');
  });

  test('cleanup prompt instructs agent to snapshot and analyze', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Agent should take a snapshot to see what deterministic pass missed
    expect(cleanupFn).toContain('snapshot -i');
    // Agent should analyze what remains
    expect(cleanupFn).toContain('identify remaining non-content');
  });

  test('cleanup prompt lists specific clutter categories for agent', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Should guide the agent on what to look for
    expect(cleanupFn).toContain('Ad placeholder');
    expect(cleanupFn).toContain('ADVERTISEMENT');
    expect(cleanupFn).toContain('Cookie');
    expect(cleanupFn).toContain('Audio/podcast');
    expect(cleanupFn).toContain('Sidebar widget');
    expect(cleanupFn).toContain('Social share');
    expect(cleanupFn).toContain('Floating chat');
  });

  test('cleanup prompt instructs agent to preserve site identity', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Must keep the site looking like itself
    expect(cleanupFn).toContain('KEEP');
    expect(cleanupFn).toContain('header/masthead/logo');
    expect(cleanupFn).toContain('article headline');
    expect(cleanupFn).toContain('article body');
    expect(cleanupFn).toContain('author byline');
  });

  test('cleanup prompt instructs agent to unlock scrolling', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    expect(cleanupFn).toContain('unlock scrolling');
    expect(cleanupFn).toContain('overflow');
  });

  test('cleanup prompt instructs agent to use $B eval for removal', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Agent should use $B eval to hide elements via JavaScript
    expect(cleanupFn).toContain('$B eval');
    expect(cleanupFn).toContain("display=");
  });

  test('cleanup shows notification while agent works', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    expect(cleanupFn).toContain('agent is analyzing');
  });

  test('cleanup removes loading state after short delay (agent is async)', () => {
    const cleanupFn = js.slice(
      js.indexOf('async function runCleanup('),
      js.indexOf('async function runScreenshot('),
    );
    // Should use setTimeout since agent runs asynchronously
    expect(cleanupFn).toContain('setTimeout');
    expect(cleanupFn).toContain("classList.remove('loading')");
  });

  test('deterministic cleanup still has comprehensive selectors as first pass', () => {
    // The deterministic $B cleanup --all still needs good selectors for the quick pass
    expect(wcSrc).toContain('ads: [');
    expect(wcSrc).toContain('cookies: [');
    expect(wcSrc).toContain('social: [');
    expect(wcSrc).toContain('overlays: [');
    expect(wcSrc).toContain('clutter: [');
  });

  test('deterministic cleanup clutter covers audio/podcast widgets', () => {
    expect(wcSrc).toContain('audio-player');
    expect(wcSrc).toContain('podcast-player');
    expect(wcSrc).toContain('listen-widget');
    expect(wcSrc).toContain('everlit');
    expect(wcSrc).toContain("'audio'"); // bare audio elements
  });

  test('deterministic cleanup clutter covers sidebar recirculation', () => {
    expect(wcSrc).toContain('most-popular');
    expect(wcSrc).toContain('most-read');
    expect(wcSrc).toContain('recommended');
    expect(wcSrc).toContain('taboola');
    expect(wcSrc).toContain('outbrain');
    expect(wcSrc).toContain('nativo');
  });

  test('deterministic cleanup clutter covers games/puzzles', () => {
    expect(wcSrc).toContain('puzzle');
    expect(wcSrc).toContain('daily-game');
    expect(wcSrc).toContain('crossword-promo');
  });

  test('ad label text detection catches common patterns', () => {
    expect(wcSrc).toContain('/^advertisement$/i');
    expect(wcSrc).toContain('/^sponsored$/i');
    expect(wcSrc).toContain('/^promoted$/i');
    expect(wcSrc).toContain('/article continues/i');
    expect(wcSrc).toContain('/continues below/i');
    expect(wcSrc).toContain('/^paid content$/i');
    expect(wcSrc).toContain('/^partner content$/i');
  });

  test('ad label detection skips elements with too much text (not a label)', () => {
    // Should skip elements with >50 chars (probably real content)
    expect(wcSrc).toContain('text.length > 50');
  });

  test('ad label detection hides parent wrapper when small enough', () => {
    // If parent has little content, hide the whole wrapper
    expect(wcSrc).toContain('parent.textContent');
    expect(wcSrc).toContain('trim().length < 80');
  });

  test('sticky removal sorts by vertical position (topmost first)', () => {
    expect(wcSrc).toContain('sort((a, b) => a.top - b.top)');
  });

  test('sticky removal preserves first full-width element near top', () => {
    expect(wcSrc).toContain('preservedTopNav');
    // Should check element spans most of viewport
    expect(wcSrc).toContain('viewportWidth * 0.8');
    // Should only preserve the first one
    expect(wcSrc).toContain('!preservedTopNav');
    // Should check it's near the top
    expect(wcSrc).toContain('top <= 50');
    // Should check it's not too tall (it's a nav, not a hero)
    expect(wcSrc).toContain('height < 120');
  });

  test('sticky removal still skips semantic nav/header elements', () => {
    expect(wcSrc).toContain("tag === 'nav'");
    expect(wcSrc).toContain("tag === 'header'");
    expect(wcSrc).toContain("role') === 'navigation'");
  });
});

// ─── Welcome page + sidebar auto-open ────────────────────────────

describe('welcome page', () => {
  const welcomePath = path.join(ROOT, 'src', 'welcome.html');
  const welcomeExists = fs.existsSync(welcomePath);
  const welcomeSrc = welcomeExists ? fs.readFileSync(welcomePath, 'utf-8') : '';

  test('welcome.html exists in browse/src/', () => {
    expect(welcomeExists).toBe(true);
  });

  test('welcome page has GStack Browser branding', () => {
    expect(welcomeSrc).toContain('GStack Browser');
  });

  test('welcome page has extension-ready listener to hide prompt', () => {
    expect(welcomeSrc).toContain('gstack-extension-ready');
    expect(welcomeSrc).toContain('sidebar-prompt');
  });

  test('welcome page points RIGHT toward sidebar (not UP at toolbar)', () => {
    // Up arrow can never align with browser chrome. Right arrow always
    // points toward the sidebar area regardless of window size.
    expect(welcomeSrc).not.toContain('arrow-up');
    expect(welcomeSrc).toContain('arrow-right');
  });

  test('welcome page has left-aligned text (no center-align on headings)', () => {
    // User preference: always left-align, never center
    expect(welcomeSrc).not.toMatch(/text-align:\s*center/);
  });

  test('welcome page uses dark theme', () => {
    expect(welcomeSrc).toContain('#0C0C0C'); // --base (near-black)
    expect(welcomeSrc).toContain('#141414'); // --surface (card bg)
  });
});

describe('server /welcome endpoint', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('/welcome endpoint exists in server.ts', () => {
    expect(serverSrc).toContain("url.pathname === '/welcome'");
  });

  test('/welcome serves HTML content type', () => {
    const welcomeSection = serverSrc.slice(
      serverSrc.indexOf("url.pathname === '/welcome'"),
      serverSrc.indexOf("url.pathname === '/health'"),
    );
    expect(welcomeSection).toContain("'Content-Type': 'text/html");
  });

  test('/welcome serves fallback HTML if no welcome file found', () => {
    const welcomeSection = serverSrc.slice(
      serverSrc.indexOf("url.pathname === '/welcome'"),
      serverSrc.indexOf("url.pathname === '/health'"),
    );
    // Changed from 302 redirect to about:blank (ERR_UNSAFE_REDIRECT on Windows)
    // to inline HTML fallback page (PR #822)
    expect(welcomeSection).toContain('GStack Browser ready');
    expect(welcomeSection).toContain('status: 200');
  });
});

describe('headed launch navigates to welcome page', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('server navigates to /welcome after startup in headed mode', () => {
    // Navigation must happen AFTER Bun.serve() starts (not during launchHeaded)
    // because the HTTP server needs to be listening before the browser requests /welcome
    const afterServe = serverSrc.slice(serverSrc.indexOf('Bun.serve('));
    expect(afterServe).toContain('/welcome');
    expect(afterServe).toContain("getConnectionMode() === 'headed'");
  });

  test('welcome navigation does NOT happen in browser-manager (too early)', () => {
    const bmSrc = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');
    // browser-manager.ts should NOT navigate to /welcome because the server
    // isn't listening yet when launchHeaded() runs
    const launchHeadedSection = bmSrc.slice(
      bmSrc.indexOf('async launchHeaded('),
      bmSrc.indexOf('// Browser disconnect handler'),
    );
    expect(launchHeadedSection).not.toContain('/welcome');
  });
});

describe('sidebar auto-open (background.js)', () => {
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');

  test('autoOpenSidePanel function exists with retry logic', () => {
    expect(bgSrc).toContain('async function autoOpenSidePanel');
    expect(bgSrc).toContain('attempt < 5');
  });

  test('auto-open fires on install AND on every service worker startup', () => {
    // onInstalled fires on first install / extension update
    expect(bgSrc).toContain('chrome.runtime.onInstalled.addListener');
    expect(bgSrc).toContain('autoOpenSidePanel()');
    // Top-level call fires on every service worker startup
    const topLevelCalls = bgSrc.match(/^autoOpenSidePanel\(\)/gm);
    expect(topLevelCalls).not.toBeNull();
    expect(topLevelCalls!.length).toBeGreaterThanOrEqual(1);
  });

  test('retry uses backoff delays (not fixed interval)', () => {
    expect(bgSrc).toContain('500');
    expect(bgSrc).toContain('1000');
    expect(bgSrc).toContain('2000');
    expect(bgSrc).toContain('3000');
    expect(bgSrc).toContain('5000');
  });

  test('auto-open uses chrome.sidePanel.open with windowId', () => {
    expect(bgSrc).toContain('chrome.sidePanel.open');
    expect(bgSrc).toContain('windowId');
  });

  test('auto-open logs success and failure for debugging', () => {
    expect(bgSrc).toContain('Side panel opened on attempt');
    expect(bgSrc).toContain('Side panel auto-open failed');
  });
});

describe('sidebar arrow hint hide flow (4-step signal chain)', () => {
  // The arrow hint on the welcome page should ONLY hide when the sidebar
  // is actually opened, not when the extension content script loads.
  //
  // Signal flow:
  //   1. sidepanel.js connects → sends { type: 'sidebarOpened' } to background
  //   2. background.js receives → relays to active tab's content script
  //   3. content.js receives 'sidebarOpened' → dispatches 'gstack-extension-ready'
  //   4. welcome.html listens for 'gstack-extension-ready' → hides arrow
  //
  const contentSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'content.js'), 'utf-8');
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');
  const spSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const welcomeSrc = fs.readFileSync(path.join(ROOT, 'src', 'welcome.html'), 'utf-8');

  // Step 1: sidepanel sends sidebarOpened when connected
  test('step 1: sidepanel sends sidebarOpened message on connect', () => {
    expect(spSrc).toContain("{ type: 'sidebarOpened' }");
    // Should be in updateConnection, after setConnState('connected')
    const connectFn = spSrc.slice(
      spSrc.indexOf('function updateConnection('),
      spSrc.indexOf('function updateConnection(') + 800,
    );
    expect(connectFn).toContain('sidebarOpened');
  });

  // Step 2: background.js accepts and relays sidebarOpened
  test('step 2: background.js allows sidebarOpened message type', () => {
    expect(bgSrc).toContain("'sidebarOpened'");
    // Must be in ALLOWED_TYPES
    const allowedBlock = bgSrc.slice(
      bgSrc.indexOf('ALLOWED_TYPES'),
      bgSrc.indexOf('ALLOWED_TYPES') + 300,
    );
    expect(allowedBlock).toContain('sidebarOpened');
  });

  test('step 2: background.js relays sidebarOpened to active tab content script', () => {
    expect(bgSrc).toContain("msg.type === 'sidebarOpened'");
    // Should send to active tab via chrome.tabs.sendMessage
    const handler = bgSrc.slice(
      bgSrc.indexOf("msg.type === 'sidebarOpened'"),
      bgSrc.indexOf("msg.type === 'sidebarOpened'") + 400,
    );
    expect(handler).toContain('chrome.tabs.sendMessage');
    expect(handler).toContain("{ type: 'sidebarOpened' }");
  });

  // Step 3: content.js fires gstack-extension-ready ONLY on sidebarOpened
  test('step 3: content.js dispatches extension-ready on sidebarOpened message', () => {
    expect(contentSrc).toContain("msg.type === 'sidebarOpened'");
    expect(contentSrc).toContain("new CustomEvent('gstack-extension-ready')");
  });

  test('step 3: content.js does NOT auto-fire extension-ready on load', () => {
    // The old pattern was: fire immediately when content script loads.
    // Now it should only fire when sidebarOpened message arrives.
    // Check there's no top-level dispatchEvent outside the message handler.
    const beforeListener = contentSrc.slice(0, contentSrc.indexOf('chrome.runtime.onMessage'));
    expect(beforeListener).not.toContain("dispatchEvent(new CustomEvent('gstack-extension-ready'))");
  });

  // Step 4: welcome page hides arrow on gstack-extension-ready
  test('step 4: welcome page hides arrow on gstack-extension-ready event', () => {
    expect(welcomeSrc).toContain("'gstack-extension-ready'");
    expect(welcomeSrc).toContain("classList.add('hidden')");
  });

  test('step 4: welcome page does NOT auto-hide via status pill polling', () => {
    // The old fallback (checkPill/gstack-status-pill) would hide the arrow
    // as soon as the content script injected the pill, even without sidebar open.
    expect(welcomeSrc).not.toContain('checkPill');
    expect(welcomeSrc).not.toContain('gstack-status-pill');
  });
});

describe('sidebar auth race prevention', () => {
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');
  const spSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('getPort response includes authToken (not just port + connected)', () => {
    // The auth race: sidepanel calls getPort, gets {port, connected} but no token.
    // All subsequent requests fail 401. Token must be in the getPort response.
    const getPortHandler = bgSrc.slice(
      bgSrc.indexOf("msg.type === 'getPort'"),
      bgSrc.indexOf("msg.type === 'setPort'"),
    );
    expect(getPortHandler).toContain('token: authToken');
  });

  test('tryConnect uses token from getPort response', () => {
    // Sidepanel must pass resp.token to updateConnection, not null
    const start = spSrc.indexOf('function tryConnect()');
    const end = spSrc.indexOf('\ntryConnect();', start); // top-level call after the function
    const tryConnectFn = spSrc.slice(start, end);
    expect(tryConnectFn).toContain('resp.token');
    expect(tryConnectFn).not.toContain('updateConnection(url, null)');
  });
});

describe('startup health check fast-retry', () => {
  const bgSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');

  test('initial health check retries every 1s (not 10s)', () => {
    // The server may not be listening when the extension starts because
    // Chromium launches before Bun.serve(). A 10s gap means the user
    // stares at "Connecting..." for 10 seconds. 1s retry fixes this.
    expect(bgSrc).toContain('startupAttempts');
    expect(bgSrc).toContain('setInterval(async ()');
    // Fast retry uses 1000ms, not the 10000ms slow poll
    expect(bgSrc).toContain('}, 1000);');
  });

  test('startup retry stops after connection or max attempts', () => {
    expect(bgSrc).toContain('isConnected || startupAttempts >= 15');
    expect(bgSrc).toContain('clearInterval(startupCheck)');
  });

  test('slow 10s polling only starts after startup phase completes', () => {
    expect(bgSrc).toContain('if (!healthInterval)');
    expect(bgSrc).toContain('setInterval(checkHealth, 10000)');
  });
});

describe('sidebar debug visibility when stuck', () => {
  const spSrc = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('connection state machine has a dead state with user-visible message', () => {
    expect(spSrc).toContain("'dead'");
    expect(spSrc).toContain('MAX_RECONNECT_ATTEMPTS');
  });

  test('reconnect attempt counter is visible in the UI', () => {
    // The banner should show attempt count so user knows something is happening
    expect(spSrc).toContain('reconnectAttempts');
  });
});

describe('BROWSE_NO_AUTOSTART (sidebar headless prevention)', () => {
  const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf-8');
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar-agent.ts'), 'utf-8');

  test('cli.ts checks BROWSE_NO_AUTOSTART before starting a new server', () => {
    // ensureServer must check this env var BEFORE calling startServer()
    const ensureServerFn = cliSrc.slice(
      cliSrc.indexOf('async function ensureServer()'),
      cliSrc.indexOf('async function startServer()'),
    );
    expect(ensureServerFn).toContain('BROWSE_NO_AUTOSTART');
    expect(ensureServerFn).toContain('process.exit(1)');
  });

  test('cli.ts shows actionable error message when BROWSE_NO_AUTOSTART blocks', () => {
    expect(cliSrc).toContain('/open-gstack-browser');
    expect(cliSrc).toContain('BROWSE_NO_AUTOSTART is set');
  });

  test('sidebar-agent.ts sets BROWSE_NO_AUTOSTART=1', () => {
    expect(agentSrc).toContain("BROWSE_NO_AUTOSTART: '1'");
  });

  test('sidebar-agent.ts sets BROWSE_PORT for headed server reuse', () => {
    expect(agentSrc).toContain('BROWSE_PORT');
  });

  test('BROWSE_NO_AUTOSTART check happens before lock acquisition', () => {
    // The guard must be BEFORE the lock acquisition. If it's after,
    // we'd acquire a lock and then exit, leaving a stale lock file.
    const ensureServerStart = cliSrc.indexOf('async function ensureServer()');
    const noAutoStart = cliSrc.indexOf('BROWSE_NO_AUTOSTART', ensureServerStart);
    const lockAcquisition = cliSrc.indexOf('Acquire lock', ensureServerStart);
    expect(noAutoStart).toBeGreaterThan(0);
    expect(lockAcquisition).toBeGreaterThan(0);
    expect(noAutoStart).toBeLessThan(lockAcquisition);
  });
});

// ─── Tool-result file filtering (sidebar-agent.ts) ──────────────

describe('sidebar-agent hides internal tool-result reads', () => {
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar-agent.ts'), 'utf-8');

  test('describeToolCall returns empty for tool-results paths', () => {
    expect(agentSrc).toContain("input.file_path.includes('/tool-results/')");
  });

  test('describeToolCall returns empty for .claude/projects paths', () => {
    expect(agentSrc).toContain("input.file_path.includes('/.claude/projects/')");
  });

  test('empty description causes early return (no event sent)', () => {
    // describeToolCall returns '' for internal reads, which means
    // summarizeToolInput returns '', which means event.input is ''
    const readHandler = agentSrc.slice(
      agentSrc.indexOf("if (tool === 'Read'"),
      agentSrc.indexOf("if (tool === 'Edit'"),
    );
    expect(readHandler).toContain("return ''");
  });
});

// ─── Sidebar skips empty tool_use entries (sidepanel.js) ────────

describe('sidebar skips empty tool_use descriptions', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('tool_use with no input returns early', () => {
    const toolUseHandler = js.slice(
      js.indexOf("entry.type === 'tool_use'"),
      js.indexOf("entry.type === 'tool_use'") + 400,
    );
    expect(toolUseHandler).toContain("if (!toolInput) return");
  });
});

// ─── Tool calls collapse into "See reasoning" on agent_done ─────

describe('tool calls collapse into reasoning disclosure', () => {
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');
  const css = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.css'), 'utf-8');

  test('agent_done wraps tool calls in <details> element', () => {
    const doneHandler = js.slice(
      js.indexOf("entry.type === 'agent_done'"),
      js.indexOf("entry.type === 'agent_done'") + 1200,
    );
    expect(doneHandler).toContain("createElement('details')");
    expect(doneHandler).toContain('agent-reasoning');
  });

  test('disclosure summary shows step count', () => {
    const doneHandler = js.slice(
      js.indexOf("entry.type === 'agent_done'"),
      js.indexOf("entry.type === 'agent_done'") + 1200,
    );
    expect(doneHandler).toContain('See reasoning');
    expect(doneHandler).toContain('tools.length');
  });

  test('disclosure inserts before text response', () => {
    const doneHandler = js.slice(
      js.indexOf("entry.type === 'agent_done'"),
      js.indexOf("entry.type === 'agent_done'") + 1200,
    );
    // Tool calls should appear before the text answer, not after
    expect(doneHandler).toContain("querySelector('.agent-text')");
    expect(doneHandler).toContain('insertBefore(details, textEl)');
  });

  test('CSS styles the reasoning disclosure', () => {
    expect(css).toContain('.agent-reasoning');
    expect(css).toContain('.agent-reasoning summary');
    // Starts collapsed (no [open] by default)
    expect(css).toContain('.agent-reasoning[open]');
  });

  test('disclosure uses custom triangle markers', () => {
    // No default list-style, custom ▶/▼ via ::before
    expect(css).toContain('list-style: none');
    expect(css).toMatch(/agent-reasoning summary::before/);
  });
});

// ─── Idle timeout disabled in headed mode (server.ts) ───────────

describe('idle timeout behavior (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('idle check skips in headed mode', () => {
    const idleCheck = serverSrc.slice(
      serverSrc.indexOf('idleCheckInterval'),
      serverSrc.indexOf('idleCheckInterval') + 300,
    );
    expect(idleCheck).toContain("=== 'headed'");
    expect(idleCheck).toContain('return');
  });

  test('sidebar-command resets idle timer', () => {
    const sidebarCmd = serverSrc.slice(
      serverSrc.indexOf("url.pathname === '/sidebar-command'"),
      serverSrc.indexOf("url.pathname === '/sidebar-command'") + 300,
    );
    expect(sidebarCmd).toContain('resetIdleTimer');
  });
});

// ─── Shutdown kills sidebar-agent daemon (server.ts) ────────────

describe('shutdown cleanup (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('shutdown kills sidebar-agent daemon process', () => {
    const shutdownFn = serverSrc.slice(
      serverSrc.indexOf('async function shutdown()'),
      serverSrc.indexOf('async function shutdown()') + 800,
    );
    expect(shutdownFn).toContain('sidebar-agent');
    expect(shutdownFn).toContain('pkill');
  });
});

// ─── Cookie button in sidebar footer ────────────────────────────

describe('cookie import button (sidebar)', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.html'), 'utf-8');
  const js = fs.readFileSync(path.join(ROOT, '..', 'extension', 'sidepanel.js'), 'utf-8');

  test('quick actions toolbar has cookies button', () => {
    expect(html).toContain('id="chat-cookies-btn"');
    expect(html).toContain('Cookies');
  });

  test('cookies button navigates to cookie-picker', () => {
    expect(js).toContain("'chat-cookies-btn'");
    expect(js).toContain('cookie-picker');
  });
});

// ─── Model routing (server.ts) ──────────────────────────────────

describe('sidebar model routing (server.ts)', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

  test('pickSidebarModel routes actions to sonnet', () => {
    expect(serverSrc).toContain("return 'sonnet'");
  });

  test('pickSidebarModel routes analysis to opus', () => {
    expect(serverSrc).toContain("return 'opus'");
  });

  test('analysis words override action verbs', () => {
    // ANALYSIS_WORDS check comes before ACTION_PATTERNS
    const routerFn = serverSrc.slice(
      serverSrc.indexOf('function pickSidebarModel('),
      serverSrc.indexOf('function pickSidebarModel(') + 600,
    );
    const analysisCheck = routerFn.indexOf('ANALYSIS_WORDS');
    const actionCheck = routerFn.indexOf('ACTION_PATTERNS');
    expect(analysisCheck).toBeGreaterThan(0);
    expect(actionCheck).toBeGreaterThan(0);
    expect(analysisCheck).toBeLessThan(actionCheck);
  });
});
