/**
 * gstack browse — background service worker
 *
 * Polls /health every 10s to detect browse server.
 * Fetches /refs on snapshot completion, relays to content script.
 * Proxies commands from sidebar → browse server.
 * Updates badge: amber (connected), gray (disconnected).
 */

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

async function loadAuthToken() {
  if (authToken) return;
  try {
    const resp = await fetch(chrome.runtime.getURL('.auth.json'));
    if (resp.ok) {
      const data = await resp.json();
      if (data.token) authToken = data.token;
    }
  } catch {}
}

// ─── Health Polling ────────────────────────────────────────────

async function checkHealth() {
  const base = getBaseUrl();
  if (!base) {
    setDisconnected();
    return;
  }

  // Retry loading auth token if we don't have one yet
  if (!authToken) await loadAuthToken();

  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { setDisconnected(); return; }
    const data = await resp.json();
    if (data.status === 'healthy') {
      // Forward chatEnabled so sidepanel can show/hide chat tab
      setConnected({ ...data, chatEnabled: !!data.chatEnabled });
    } else {
      setDisconnected();
    }
  } catch {
    setDisconnected();
  }
}

function setConnected(healthData) {
  const wasDisconnected = !isConnected;
  isConnected = true;
  chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
  chrome.action.setBadgeText({ text: ' ' });

  // Broadcast health to popup and side panel (include token for sidepanel auth)
  chrome.runtime.sendMessage({ type: 'health', data: { ...healthData, token: authToken } }).catch(() => {});

  // Notify content scripts on connection change
  if (wasDisconnected) {
    notifyContentScripts('connected');
  }
}

function setDisconnected() {
  const wasConnected = isConnected;
  isConnected = false;
  // Keep authToken — it comes from .auth.json, not /health
  chrome.action.setBadgeText({ text: '' });

  chrome.runtime.sendMessage({ type: 'health', data: null }).catch(() => {});

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
        chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
      }
    }
  } catch {}
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
    if (!resp.ok) return;
    const data = await resp.json();

    // Send to all tabs' content scripts
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'refs', data }).catch(() => {});
      }
    }
  } catch {}
}

// ─── Message Handling ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Security: only accept messages from this extension's own scripts
  if (sender.id !== chrome.runtime.id) {
    console.warn('[gstack] Rejected message from unknown sender:', sender.id);
    return;
  }

  const ALLOWED_TYPES = new Set([
    'getPort', 'setPort', 'getServerUrl', 'fetchRefs',
    'openSidePanel', 'command', 'sidebar-command'
  ]);
  if (!ALLOWED_TYPES.has(msg.type)) {
    console.warn('[gstack] Rejected unknown message type:', msg.type);
    return;
  }

  if (msg.type === 'getPort') {
    sendResponse({ port: serverPort, connected: isConnected });
    return true;
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

  // getToken handler removed — token distributed via health broadcast

  if (msg.type === 'fetchRefs') {
    fetchAndRelayRefs().then(() => sendResponse({ ok: true }));
    return true;
  }

  // Open side panel from content script pill click
  if (msg.type === 'openSidePanel') {
    if (chrome.sidePanel?.open && sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    return;
  }

  // Sidebar → browse server command proxy
  if (msg.type === 'command') {
    executeCommand(msg.command, msg.args).then(result => sendResponse(result));
    return true;
  }

  // Sidebar → Claude Code (file-based message queue)
  if (msg.type === 'sidebar-command') {
    const base = getBaseUrl();
    if (!base || !authToken) {
      sendResponse({ error: 'Not connected' });
      return true;
    }
    // Capture the active tab's URL so the sidebar agent knows what page
    // the user is actually looking at (Playwright's page.url() can be stale
    // if the user navigated manually in headed mode).
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabUrl = tabs?.[0]?.url || null;
      fetch(`${base}/sidebar-command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ message: msg.message, activeTabUrl }),
      })
        .then(r => r.json())
        .then(data => sendResponse(data))
        .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }
});

// ─── Side Panel ─────────────────────────────────────────────────

// Click extension icon → open side panel directly (no popup)
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// Auto-open side panel on install/update — zero friction
chrome.runtime.onInstalled.addListener(async () => {
  // Small delay to let the browser window fully initialize
  setTimeout(async () => {
    try {
      const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (win && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch {}
  }, 1000);
});

// ─── Startup ────────────────────────────────────────────────────

// Load auth token BEFORE first health poll (token no longer in /health response)
loadAuthToken().then(() => {
  loadPort().then(() => {
    checkHealth();
    healthInterval = setInterval(checkHealth, 10000);
  });
});
