/**
 * gstack browse — background service worker
 *
 * Polls /health every 10s to detect browse server.
 * Fetches /refs on snapshot completion, relays to content script.
 * Proxies commands from sidebar → browse server.
 * Updates badge: amber (connected), gray (disconnected).
 * Denies token/port reads to content-script and foreign senders.
 */

// Sender authorization for privileged message types (the token/port surface).
// Classic (non-module) service worker: importScripts puts gstackSenderAuth on
// the worker global. The same file is require()-able from bun tests.
importScripts('sender-auth.js');

const DEFAULT_PORT = 34567;  // Well-known port used by `$B connect`
let serverPort = null;
let authToken = null;
let isConnected = false;
let healthInterval = null;

// ─── Port Discovery ────────────────────────────────────────────

async function loadPort() {
  const data = await chrome.storage.local.get('port');
  serverPort = data.port || DEFAULT_PORT;
  return serverPort;
}

async function savePort(port) {
  serverPort = port;
  await chrome.storage.local.set({ port });
}

function getBaseUrl() {
  return serverPort ? `http://127.0.0.1:${serverPort}` : null;
}

// ─── Auth Token Bootstrap ─────────────────────────────────────

// Token bootstrap: POST /extension-token. The server validates our Origin
// (chrome-extension://<pinned id> — the manifest "key" pins the ID) before
// releasing the token. GET /health is liveness/status only and never
// carries a token. Returns true on success, false on failure; a 403 means
// the server doesn't trust this extension identity — treat as disconnected
// rather than retrying forever with a stale token.
async function loadAuthToken() {
  const base = getBaseUrl();
  if (!base) return false;
  try {
    const resp = await fetch(`${base}/extension-token`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (resp.status === 403) {
      console.error('[gstack bg] /extension-token 403 — extension identity not trusted by server');
      authToken = null;
      setDisconnected();
      return false;
    }
    if (resp.ok) {
      const data = await resp.json();
      if (data.token) { authToken = data.token; return true; }
    }
  } catch (err) {
    console.error('[gstack bg] Failed to load auth token:', err.message);
  }
  return false;
}

// ─── Health Polling ────────────────────────────────────────────

async function checkHealth() {
  const base = getBaseUrl();
  if (!base) {
    setDisconnected();
    return;
  }

  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { setDisconnected(); return; }
    const data = await resp.json();
    if (data.status === 'healthy') {
      // Always refresh the auth token — the server generates a new token
      // on each restart, so the old one becomes stale. loadAuthToken()
      // already flips to disconnected on a 403.
      const gotToken = await loadAuthToken();
      if (!gotToken && !authToken) return;
      setConnected(data);
    } else {
      setDisconnected();
    }
  } catch (err) {
    console.error('[gstack bg] Health check failed:', err.message);
    setDisconnected();
  }
}

function setConnected(healthData) {
  const wasDisconnected = !isConnected;
  isConnected = true;
  chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
  chrome.action.setBadgeText({ text: ' ' });

  // Broadcast health to popup and side panel (token excluded — use getToken message instead)
  chrome.runtime.sendMessage({ type: 'health', data: healthData }).catch((err) => {
    console.debug('[gstack bg] No listener for health broadcast:', err.message);
  });

  // Notify content scripts on connection change
  if (wasDisconnected) {
    notifyContentScripts('connected');
  }
}

function setDisconnected() {
  const wasConnected = isConnected;
  isConnected = false;
  // Keep authToken — it persists across reconnections
  chrome.action.setBadgeText({ text: '' });

  chrome.runtime.sendMessage({ type: 'health', data: null }).catch((err) => {
    console.debug('[gstack bg] No listener for disconnect broadcast:', err.message);
  });

  // Notify content scripts on disconnection
  if (wasConnected) {
    notifyContentScripts('disconnected');
  }
}

async function notifyContentScripts(type) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
          // Expected: tabs without content script
        });
      }
    }
  } catch (err) {
    console.error('[gstack bg] Failed to query tabs for notification:', err.message);
  }
}

// ─── Command Proxy ─────────────────────────────────────────────

async function executeCommand(command, args) {
  const base = getBaseUrl();
  if (!base || !authToken) {
    return { error: 'Not connected to browse server' };
  }

  try {
    const resp = await fetch(`${base}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data;
  } catch (err) {
    return { error: err.message || 'Command failed' };
  }
}

// ─── Refs Relay ─────────────────────────────────────────────────

async function fetchAndRelayRefs() {
  const base = getBaseUrl();
  if (!base || !isConnected) return;

  try {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const resp = await fetch(`${base}/refs`, { signal: AbortSignal.timeout(3000), headers });
    if (!resp.ok) {
      console.warn(`[gstack bg] Refs endpoint returned ${resp.status}`);
      return;
    }
    const data = await resp.json();

    // Send to all tabs' content scripts
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'refs', data }).catch(() => {
          // Expected: tabs without content script
        });
      }
    }
  } catch (err) {
    console.error('[gstack bg] Failed to fetch/relay refs:', err.message);
  }
}

// ─── Inspector ──────────────────────────────────────────────────

// Track inspector mode per tab — 'full' (inspector.js injected) or 'basic' (content.js fallback)
let inspectorMode = 'full';

async function injectInspector(tabId) {
  // Try full inspector injection first
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inspector.js'],
    });
    // CSS injection failure alone doesn't need fallback
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: true },
        files: ['inspector.css'],
      });
    } catch (err) {
      console.debug('[gstack bg] Inspector CSS injection failed (non-fatal):', err.message);
    }
    // Send startPicker to the injected inspector.js
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'startPicker' });
    } catch (err) {
      console.warn('[gstack bg] Failed to send startPicker:', err.message);
    }
    inspectorMode = 'full';
    return { ok: true, mode: 'full' };
  } catch (err) {
    // Script injection failed (CSP, chrome:// page, etc.)
    // Fall back to content.js basic picker (loaded by manifest on most pages)
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'startBasicPicker' });
      inspectorMode = 'basic';
      return { ok: true, mode: 'basic' };
    } catch (err2) {
      console.error('[gstack bg] Inspector injection failed completely:', err.message, '| Basic fallback:', err2.message);
      inspectorMode = 'full';
      return { error: 'Cannot inspect this page' };
    }
  }
}

async function stopInspector(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'stopPicker' });
  } catch (err) {
    console.debug('[gstack bg] Failed to stop picker on tab', tabId, ':', err.message);
  }
  return { ok: true };
}

async function postInspectorPick(selector, frameInfo, basicData, activeTabUrl) {
  const base = getBaseUrl();
  if (!base || !authToken) {
    // No browse server — return basic data as fallback
    return { mode: 'basic', selector, basicData, frameInfo };
  }

  try {
    const resp = await fetch(`${base}/inspector/pick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ selector, activeTabUrl, frameInfo }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      // Server error — fall back to basic mode
      return { mode: 'basic', selector, basicData, frameInfo };
    }
    const data = await resp.json();
    return { mode: 'cdp', ...data };
  } catch (err) {
    console.debug('[gstack bg] Inspector pick server unavailable, using basic mode:', err.message);
    return { mode: 'basic', selector, basicData, frameInfo };
  }
}

async function sendToContentScript(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response || { ok: true };
  } catch {
    return { error: 'Content script not available' };
  }
}

// ─── Message Handling ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Security: only accept messages from this extension's own scripts
  if (sender.id !== chrome.runtime.id) {
    console.warn('[gstack] Rejected message from unknown sender:', sender.id);
    return;
  }

  const ALLOWED_TYPES = new Set([
    'getPort', 'setPort', 'getServerUrl', 'getToken', 'fetchRefs',
    'openSidePanel', 'sidebarOpened', 'command',
    'getTabState',
    // Inspector message types
    'startInspector', 'stopInspector', 'elementPicked', 'pickerCancelled',
    'applyStyle', 'toggleClass', 'injectCSS', 'resetAll',
    'inspectResult'
  ]);
  if (!ALLOWED_TYPES.has(msg.type)) {
    console.warn('[gstack] Rejected unknown message type:', msg.type);
    return;
  }

  // Privileged types — anything that returns or spends the auth token or
  // server port, or dumps the full tab list — are for this extension's own
  // pages only (sidepanel/popup). Content scripts run inside web pages and
  // can be influenced by page content; foreign extensions are foreign. Both
  // get { error: 'unauthorized' } and nothing else — never the token, never
  // the port. Policy + type list live in sender-auth.js.
  const denial = gstackSenderAuth.denialFor(msg.type, sender, chrome.runtime.id);
  if (denial) {
    console.warn('[gstack] Rejected privileged message from unauthorized sender:', msg.type, sender.url || '(no sender url)');
    sendResponse(denial);
    return true;
  }

  if (msg.type === 'getPort') {
    sendResponse({ port: serverPort, connected: isConnected, token: authToken });
    return true;
  }

  if (msg.type === 'getTabState') {
    snapshotTabs().then(snap => sendResponse(snap || { active: null, tabs: [] }));
    return true; // async sendResponse
  }

  if (msg.type === 'setPort') {
    savePort(msg.port).then(() => {
      checkHealth();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'getServerUrl') {
    sendResponse({ url: getBaseUrl() });
    return true;
  }

  // Token delivered via targeted sendResponse, not broadcast — limits exposure.
  // Only this extension's own pages reach here: the sender-auth gate above
  // denies content scripts (sender.tab set) and foreign senders before any
  // privileged handler runs.
  if (msg.type === 'getToken') {
    sendResponse({ token: authToken });
    return true;
  }

  if (msg.type === 'fetchRefs') {
    fetchAndRelayRefs().then(() => sendResponse({ ok: true }));
    return true;
  }

  // Open side panel from content script pill click
  if (msg.type === 'openSidePanel') {
    if (chrome.sidePanel?.open && sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => {
        console.warn('[gstack bg] Failed to open side panel:', err.message);
      });
    }
    return;
  }

  // Sidebar opened — tell active tab's content script so the welcome page
  // can hide its arrow hint. Only fires when the sidebar actually connects.
  if (msg.type === 'sidebarOpened') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'sidebarOpened' }).catch(() => {
          // Expected: tab may not have content script
        });
      }
    });
    return;
  }

  // Inspector: inject + start picker
  if (msg.type === 'startInspector') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) { sendResponse({ error: 'No active tab' }); return; }
      injectInspector(tabId).then(result => sendResponse(result));
    });
    return true;
  }

  // Inspector: stop picker
  if (msg.type === 'stopInspector') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) { sendResponse({ error: 'No active tab' }); return; }
      stopInspector(tabId).then(result => sendResponse(result));
    });
    return true;
  }

  // Inspector: element picked by content script
  if (msg.type === 'elementPicked') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabUrl = tabs?.[0]?.url || null;
      const frameInfo = msg.frameSrc ? { frameSrc: msg.frameSrc, frameName: msg.frameName } : null;
      postInspectorPick(msg.selector, frameInfo, msg.basicData, activeTabUrl)
        .then(result => {
          // Forward enriched result to sidepanel
          chrome.runtime.sendMessage({
            type: 'inspectResult',
            data: {
              ...result,
              selector: msg.selector,
              tagName: msg.tagName,
              classes: msg.classes,
              id: msg.id,
              dimensions: msg.dimensions,
              basicData: msg.basicData,
              frameInfo,
            },
          }).catch((err) => {
            console.warn('[gstack bg] Failed to forward inspectResult to sidepanel:', err.message);
          });
          sendResponse({ ok: true });
        });
    });
    return true;
  }

  // Inspector: picker cancelled
  if (msg.type === 'pickerCancelled') {
    chrome.runtime.sendMessage({ type: 'pickerCancelled' }).catch((err) => {
      console.debug('[gstack bg] No listener for pickerCancelled:', err.message);
    });
    return;
  }

  // Inspector: route alteration commands to content script
  if (msg.type === 'applyStyle' || msg.type === 'toggleClass' || msg.type === 'injectCSS' || msg.type === 'resetAll') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) { sendResponse({ error: 'No active tab' }); return; }
      sendToContentScript(tabId, msg).then(result => sendResponse(result));
    });
    return true;
  }

  // Sidebar → browse server command proxy
  if (msg.type === 'command') {
    executeCommand(msg.command, msg.args).then(result => sendResponse(result));
    return true;
  }

});

// ─── Side Panel ─────────────────────────────────────────────────

// Click extension icon → open side panel directly (no popup)
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn('[gstack bg] Failed to set panel behavior:', err.message);
  });
}

// Auto-open side panel with retry. chrome.sidePanel.open() can fail silently
// if the window/tab isn't fully ready yet. Retry up to 5 times with backoff.
async function autoOpenSidePanel() {
  if (!chrome.sidePanel?.open) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (wins.length > 0) {
        await chrome.sidePanel.open({ windowId: wins[0].id });
        console.log(`[gstack] Side panel opened on attempt ${attempt + 1}`);
        return; // success
      }
    } catch (e) {
      // May throw if window isn't ready or user gesture required
      console.log(`[gstack] Side panel open attempt ${attempt + 1} failed:`, e.message);
    }
    // Backoff: 500ms, 1000ms, 2000ms, 3000ms, 5000ms
    await new Promise(r => setTimeout(r, [500, 1000, 2000, 3000, 5000][attempt]));
  }
  console.log('[gstack] Side panel auto-open failed after 5 attempts');
}

// Fire on install/update
chrome.runtime.onInstalled.addListener(() => {
  autoOpenSidePanel();
});

// Fire on every service worker startup (covers persistent context reuse)
autoOpenSidePanel();

// ─── Tab Awareness ───────────────────────────────────────────────
// Push live tab state to the sidepanel so claude in the Terminal pane
// always has up-to-date tabs.json + active-tab.json on disk. The
// sidepanel relays these to terminal-agent.ts over the live WebSocket;
// terminal-agent writes the files for claude to read.

async function snapshotTabs() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const all = await chrome.tabs.query({});
    const slim = all.map(t => ({
      tabId: t.id,
      url: t.url || '',
      title: t.title || '',
      active: !!t.active,
      windowId: t.windowId,
      pinned: !!t.pinned,
      audible: !!t.audible,
    }));
    return {
      active: active ? { tabId: active.id, url: active.url || '', title: active.title || '' } : null,
      tabs: slim,
    };
  } catch {
    return null;
  }
}

async function pushTabState(reason) {
  const snapshot = await snapshotTabs();
  if (!snapshot) return;
  chrome.runtime.sendMessage({
    type: 'browserTabState',
    reason,
    ...snapshot,
  }).catch(() => {}); // expected: sidepanel may not be open
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  // Keep the legacy event for any consumer still listening to it (the chat
  // path is gone but the message type is harmless), and also fire the new
  // unified state push so claude's tabs.json reflects the new active tab.
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.runtime.sendMessage({
      type: 'browserTabActivated',
      tabId: activeInfo.tabId,
      url: tab.url || '',
      title: tab.title || '',
    }).catch(() => {});
  });
  pushTabState('activated');
});

chrome.tabs.onCreated.addListener(() => pushTabState('created'));
chrome.tabs.onRemoved.addListener(() => pushTabState('removed'));
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  // Throttle: only re-push on URL or title changes, not on every loading
  // tick. We don't want to spam claude with a state push every 50ms while
  // a page loads.
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    pushTabState('updated');
  }
});

// ─── identity-pin migration notice (v1.63) ────────────────────
//
// The manifest "key" added in v1.63 pins the extension ID, which changes
// the ID for existing installs — chrome.storage.local is keyed by
// extension ID, so panel-local state (saved port, snoozes) resets once.
// Explain that in-product, one time. The flag name is version-free so a
// release re-slot never orphans an already-set flag.
async function announceIdentityPinOnce() {
  try {
    const data = await chrome.storage.local.get('gstack_id_pin_migrated');
    if (data.gstack_id_pin_migrated) return;
    console.log('[gstack] gstack sidebar: extension identity pinned in v1.63 — panel state reset once.');
    chrome.runtime.sendMessage({
      type: 'gstack-migration-notice',
      message: 'gstack sidebar: extension identity pinned in v1.63 — panel state reset once.',
    }).catch(() => {
      // Expected: panel not open. The console line above still lands.
    });
    await chrome.storage.local.set({ gstack_id_pin_migrated: true });
  } catch (err) {
    console.debug('[gstack] identity-pin notice failed (non-fatal):', err.message);
  }
}

// ─── Startup ────────────────────────────────────────────────────

// Fast-retry health check on startup. The server may not be listening yet
// (Chromium launches before Bun.serve starts). Retry every 1s for the
// first 15 seconds, then switch to 10s polling.
announceIdentityPinOnce();
loadPort().then(() => {
  let startupAttempts = 0;
  const startupCheck = setInterval(async () => {
    startupAttempts++;
    await checkHealth();
    if (isConnected || startupAttempts >= 15) {
      clearInterval(startupCheck);
      // Switch to slow polling now that we're connected (or gave up)
      if (!healthInterval) {
        healthInterval = setInterval(checkHealth, 10000);
      }
      if (!isConnected) {
        console.log('[gstack] Startup health checks failed after 15 attempts, falling back to 10s polling');
      }
    }
  }, 1000);
});
