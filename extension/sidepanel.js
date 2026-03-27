/**
 * gstack browse — Side Panel
 *
 * Chat tab: two-way messaging with Claude Code via file queue.
 * Debug tabs: activity feed (SSE) + refs (REST).
 * Polls /sidebar-chat for new messages every 1s.
 */

const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);
const INTERACTION_COMMANDS = new Set(['click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait', 'upload']);
const OBSERVE_COMMANDS = new Set(['snapshot', 'screenshot', 'diff', 'console', 'network', 'text', 'html', 'links', 'forms', 'accessibility', 'cookies', 'storage', 'perf']);

let lastId = 0;
let eventSource = null;
let serverUrl = null;
let serverToken = null;
let chatLineCount = 0;
let chatPollInterval = null;
let connState = 'disconnected'; // disconnected | connected | reconnecting | dead
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 30; // 30 * 2s = 60s before showing "dead"

// Auth headers for sidebar endpoints
function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (serverToken) h['Authorization'] = `Bearer ${serverToken}`;
  return h;
}

// ─── Connection State Machine ─────────────────────────────────────

function setConnState(state) {
  const prev = connState;
  connState = state;
  const banner = document.getElementById('conn-banner');
  const bannerText = document.getElementById('conn-banner-text');
  const bannerActions = document.getElementById('conn-banner-actions');

  if (state === 'connected') {
    if (prev === 'reconnecting' || prev === 'dead') {
      // Show "reconnected" toast that fades
      banner.style.display = '';
      banner.className = 'conn-banner reconnected';
      bannerText.textContent = 'Reconnected';
      bannerActions.style.display = 'none';
      setTimeout(() => { banner.style.display = 'none'; }, 5000);
    } else {
      banner.style.display = 'none';
    }
    reconnectAttempts = 0;
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  } else if (state === 'reconnecting') {
    banner.style.display = '';
    banner.className = 'conn-banner reconnecting';
    bannerText.textContent = `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`;
    bannerActions.style.display = 'none';
  } else if (state === 'dead') {
    banner.style.display = '';
    banner.className = 'conn-banner dead';
    bannerText.textContent = 'Server offline';
    bannerActions.style.display = '';
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  } else {
    banner.style.display = 'none';
  }
}

function startReconnect() {
  if (reconnectTimer) return;
  setConnState('reconnecting');
  reconnectTimer = setInterval(() => {
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      setConnState('dead');
      return;
    }
    setConnState('reconnecting');
    tryConnect();
  }, 2000);
}

// ─── Chat ───────────────────────────────────────────────────────

const chatMessages = document.getElementById('chat-messages');
const commandInput = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const commandHistory = [];
let historyIndex = -1;

function formatChatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// Current streaming state
let agentContainer = null; // The container for the current agent response
let agentTextEl = null;    // The text accumulator element
let agentText = '';        // Accumulated text

function addChatEntry(entry) {
  // Remove welcome message on first real message
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // User messages → chat bubble
  if (entry.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble user';
    bubble.innerHTML = `${escapeHtml(entry.message)}<span class="chat-time">${formatChatTime(entry.ts)}</span>`;
    chatMessages.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }

  // Legacy assistant messages (from /sidebar-response)
  if (entry.role === 'assistant') {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    let content = escapeHtml(entry.message);
    content = content.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
    content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\n/g, '<br>');
    bubble.innerHTML = `${content}<span class="chat-time">${formatChatTime(entry.ts)}</span>`;
    chatMessages.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }

  // Agent streaming events
  if (entry.role === 'agent') {
    handleAgentEvent(entry);
    return;
  }
}

function handleAgentEvent(entry) {
  if (entry.type === 'agent_start') {
    // Create a new agent response container
    agentText = '';
    agentContainer = document.createElement('div');
    agentContainer.className = 'agent-response';
    agentTextEl = null;
    chatMessages.appendChild(agentContainer);

    // Add thinking indicator
    const thinking = document.createElement('div');
    thinking.className = 'agent-thinking';
    thinking.id = 'agent-thinking';
    thinking.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
    agentContainer.appendChild(thinking);
    agentContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }

  if (entry.type === 'agent_done') {
    // Remove thinking indicator
    const thinking = document.getElementById('agent-thinking');
    if (thinking) thinking.remove();
    // Add timestamp
    if (agentContainer) {
      const ts = document.createElement('span');
      ts.className = 'chat-time';
      ts.textContent = formatChatTime(entry.ts);
      agentContainer.appendChild(ts);
    }
    agentContainer = null;
    agentTextEl = null;
    return;
  }

  if (entry.type === 'agent_error') {
    const thinking = document.getElementById('agent-thinking');
    if (thinking) thinking.remove();
    if (!agentContainer) {
      agentContainer = document.createElement('div');
      agentContainer.className = 'agent-response';
      chatMessages.appendChild(agentContainer);
    }
    const err = document.createElement('div');
    err.className = 'agent-error';
    err.textContent = entry.error || 'Unknown error';
    agentContainer.appendChild(err);
    agentContainer = null;
    return;
  }

  if (!agentContainer) {
    agentContainer = document.createElement('div');
    agentContainer.className = 'agent-response';
    chatMessages.appendChild(agentContainer);
  }

  // Remove thinking indicator on first real content
  const thinking = document.getElementById('agent-thinking');
  if (thinking) thinking.remove();

  if (entry.type === 'tool_use') {
    const toolEl = document.createElement('div');
    toolEl.className = 'agent-tool';
    const toolName = entry.tool || 'Tool';
    const toolInput = entry.input || '';
    toolEl.innerHTML = `<span class="tool-name">${escapeHtml(toolName)}</span> <span class="tool-input">${escapeHtml(toolInput)}</span>`;
    agentContainer.appendChild(toolEl);
    agentContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }

  if (entry.type === 'text' || entry.type === 'result') {
    // Full text replacement
    agentText = entry.text || '';
    if (!agentTextEl) {
      agentTextEl = document.createElement('div');
      agentTextEl.className = 'agent-text';
      agentContainer.appendChild(agentTextEl);
    }
    let content = escapeHtml(agentText);
    content = content.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
    content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\n/g, '<br>');
    agentTextEl.innerHTML = content;
    agentContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }

  if (entry.type === 'text_delta') {
    // Incremental text append
    agentText += entry.text || '';
    if (!agentTextEl) {
      agentTextEl = document.createElement('div');
      agentTextEl.className = 'agent-text';
      agentContainer.appendChild(agentTextEl);
    }
    let content = escapeHtml(agentText);
    content = content.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
    content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\n/g, '<br>');
    agentTextEl.innerHTML = content;
    agentContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }
}

async function sendMessage() {
  const msg = commandInput.value.trim();
  if (!msg) return;

  commandHistory.push(msg);
  historyIndex = commandHistory.length;
  commandInput.value = '';
  commandInput.disabled = true;
  sendBtn.disabled = true;

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'sidebar-command', message: msg }, resolve);
  });

  commandInput.disabled = false;
  sendBtn.disabled = false;
  commandInput.focus();

  if (result?.ok) {
    // Immediately poll to show the user's own message
    pollChat();
  } else {
    commandInput.classList.add('error');
    commandInput.placeholder = result?.error || 'Failed to send';
    setTimeout(() => {
      commandInput.classList.remove('error');
      commandInput.placeholder = 'Message Claude Code...';
    }, 2000);
  }
}

commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIndex > 0) { historyIndex--; commandInput.value = commandHistory[historyIndex]; }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) { historyIndex++; commandInput.value = commandHistory[historyIndex]; }
    else { historyIndex = commandHistory.length; commandInput.value = ''; }
  }
});

sendBtn.addEventListener('click', sendMessage);

// Poll for new chat messages
let initialLoadDone = false;

async function pollChat() {
  if (!serverUrl || !serverToken) return;
  try {
    const resp = await fetch(`${serverUrl}/sidebar-chat?after=${chatLineCount}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const data = await resp.json();

    // First successful poll — hide loading spinner
    if (!initialLoadDone) {
      initialLoadDone = true;
      const loading = document.getElementById('chat-loading');
      const welcome = document.getElementById('chat-welcome');
      if (loading) loading.style.display = 'none';
      // Show welcome only if no chat history
      if (data.total === 0 && welcome) welcome.style.display = '';
    }

    if (data.entries && data.entries.length > 0) {
      // Hide welcome on first real entry
      const welcome = document.getElementById('chat-welcome');
      if (welcome) welcome.style.display = 'none';
      for (const entry of data.entries) {
        addChatEntry(entry);
      }
      chatLineCount = data.total;
    }
  } catch {}
}

// ─── Clear Chat ─────────────────────────────────────────────────

document.getElementById('clear-chat').addEventListener('click', async () => {
  if (!serverUrl) return;
  try {
    await fetch(`${serverUrl}/sidebar-chat/clear`, { method: 'POST', headers: authHeaders() });
  } catch {}
  // Reset local state
  chatLineCount = 0;
  agentContainer = null;
  agentTextEl = null;
  agentText = '';
  chatMessages.innerHTML = `
    <div class="chat-welcome" id="chat-welcome">
      <div class="chat-welcome-icon">G</div>
      <p>Send a message to Claude Code.</p>
      <p class="muted">Your agent will see it and act on it.</p>
    </div>`;
});

// ─── Debug Tabs ─────────────────────────────────────────────────

const debugToggle = document.getElementById('debug-toggle');
const debugTabs = document.getElementById('debug-tabs');
const closeDebug = document.getElementById('close-debug');
let debugOpen = false;

debugToggle.addEventListener('click', () => {
  debugOpen = !debugOpen;
  debugToggle.classList.toggle('active', debugOpen);
  debugTabs.style.display = debugOpen ? 'flex' : 'none';
  if (!debugOpen) {
    // Close debug panels, show chat
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-chat').classList.add('active');
    document.querySelectorAll('.debug-tabs .tab').forEach(t => t.classList.remove('active'));
  }
});

closeDebug.addEventListener('click', () => {
  debugOpen = false;
  debugToggle.classList.remove('active');
  debugTabs.style.display = 'none';
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-chat').classList.add('active');
});

document.querySelectorAll('.debug-tabs .tab:not(.close-debug)').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.debug-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'refs') fetchRefs();
  });
});

// ─── Activity Feed ──────────────────────────────────────────────

function getEntryClass(entry) {
  if (entry.status === 'error') return 'error';
  if (entry.type === 'command_start') return 'pending';
  const cmd = entry.command || '';
  if (NAV_COMMANDS.has(cmd)) return 'nav';
  if (INTERACTION_COMMANDS.has(cmd)) return 'interaction';
  if (OBSERVE_COMMANDS.has(cmd)) return 'observe';
  return '';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let pendingEntries = new Map();

function createEntryElement(entry) {
  const div = document.createElement('div');
  div.className = `activity-entry ${getEntryClass(entry)}`;
  div.setAttribute('role', 'article');
  div.tabIndex = 0;

  const argsText = entry.args ? entry.args.join(' ') : '';
  const statusIcon = entry.status === 'ok' ? '\u2713' : entry.status === 'error' ? '\u2717' : '';
  const statusClass = entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'err' : '';
  const duration = entry.duration ? `${entry.duration}ms` : '';

  div.innerHTML = `
    <div class="entry-header">
      <span class="entry-time">${formatTime(entry.timestamp)}</span>
      <span class="entry-command">${entry.command || entry.type}</span>
    </div>
    ${argsText ? `<div class="entry-args">${escapeHtml(argsText)}</div>` : ''}
    ${entry.type === 'command_end' ? `
      <div class="entry-status">
        <span class="${statusClass}">${statusIcon}</span>
        <span class="duration">${duration}</span>
      </div>
    ` : ''}
    ${entry.result ? `
      <div class="entry-detail">
        <div class="entry-result">${escapeHtml(entry.result)}</div>
      </div>
    ` : ''}
  `;

  div.addEventListener('click', () => div.classList.toggle('expanded'));
  return div;
}

function addEntry(entry) {
  const feed = document.getElementById('activity-feed');
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'none';

  if (entry.type === 'command_end') {
    for (const [id, el] of pendingEntries) {
      if (el.querySelector('.entry-command')?.textContent === entry.command) {
        el.remove();
        pendingEntries.delete(id);
        break;
      }
    }
  }

  const el = createEntryElement(entry);
  feed.appendChild(el);
  if (entry.type === 'command_start') pendingEntries.set(entry.id, el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });

  if (entry.url) document.getElementById('footer-url')?.textContent && (document.getElementById('footer-url').textContent = new URL(entry.url).hostname);
  lastId = Math.max(lastId, entry.id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── SSE Connection ─────────────────────────────────────────────

function connectSSE() {
  if (!serverUrl) return;
  if (eventSource) { eventSource.close(); eventSource = null; }

  const url = `${serverUrl}/activity/stream?after=${lastId}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('activity', (e) => {
    try { addEntry(JSON.parse(e.data)); } catch {}
  });

  eventSource.addEventListener('gap', (e) => {
    try {
      const data = JSON.parse(e.data);
      const feed = document.getElementById('activity-feed');
      const banner = document.createElement('div');
      banner.className = 'gap-banner';
      banner.textContent = `Missed ${data.availableFrom - data.gapFrom} events`;
      feed.appendChild(banner);
    } catch {}
  });
}

// ─── Refs Tab ───────────────────────────────────────────────────

async function fetchRefs() {
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl}/refs`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const data = await resp.json();

    const list = document.getElementById('refs-list');
    const empty = document.getElementById('refs-empty');
    const footer = document.getElementById('refs-footer');

    if (!data.refs || data.refs.length === 0) {
      empty.style.display = '';
      list.innerHTML = '';
      footer.textContent = '';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = data.refs.map(r => `
      <div class="ref-row">
        <span class="ref-id">${escapeHtml(r.ref)}</span>
        <span class="ref-role">${escapeHtml(r.role)}</span>
        <span class="ref-name">"${escapeHtml(r.name)}"</span>
      </div>
    `).join('');
    footer.textContent = `${data.refs.length} refs`;
  } catch {}
}

// ─── Server Discovery ───────────────────────────────────────────

function updateConnection(url, token) {
  const wasConnected = !!serverUrl;
  serverUrl = url;
  serverToken = token || null;
  if (url) {
    document.getElementById('footer-dot').className = 'dot connected';
    const port = new URL(url).port;
    document.getElementById('footer-port').textContent = `:${port}`;
    setConnState('connected');
    connectSSE();
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(pollChat, 1000);
    pollChat();
  } else {
    document.getElementById('footer-dot').className = 'dot';
    document.getElementById('footer-port').textContent = '';
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    if (wasConnected) {
      startReconnect();
    }
  }
}

// ─── Port Configuration ─────────────────────────────────────────

const portLabel = document.getElementById('footer-port');
const portInput = document.getElementById('port-input');

portLabel.addEventListener('click', () => {
  portLabel.style.display = 'none';
  portInput.style.display = '';
  chrome.runtime.sendMessage({ type: 'getPort' }, (resp) => {
    portInput.value = resp?.port || '';
    portInput.focus();
    portInput.select();
  });
});

function savePort() {
  const port = parseInt(portInput.value, 10);
  if (port > 0 && port < 65536) {
    chrome.runtime.sendMessage({ type: 'setPort', port });
  }
  portInput.style.display = 'none';
  portLabel.style.display = '';
}
portInput.addEventListener('blur', savePort);
portInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePort();
  if (e.key === 'Escape') { portInput.style.display = 'none'; portLabel.style.display = ''; }
});

// ─── Reconnect / Copy Buttons ────────────────────────────────────

document.getElementById('conn-reconnect').addEventListener('click', () => {
  reconnectAttempts = 0;
  startReconnect();
});

document.getElementById('conn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText('/connect-chrome').then(() => {
    const btn = document.getElementById('conn-copy');
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = '/connect-chrome'; }, 2000);
  });
});

// Try to connect immediately, retry every 2s until connected
function tryConnect() {
  chrome.runtime.sendMessage({ type: 'getPort' }, (resp) => {
    if (resp && resp.port && resp.connected) {
      const url = `http://127.0.0.1:${resp.port}`;
      // Get the token from background
      chrome.runtime.sendMessage({ type: 'getToken' }, (tokenResp) => {
        updateConnection(url, tokenResp?.token);
      });
    } else {
      setTimeout(tryConnect, 2000);
    }
  });
}
tryConnect();

// ─── Message Listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'health') {
    if (msg.data) {
      const url = `http://127.0.0.1:${msg.data.port || 34567}`;
      updateConnection(url, msg.data.token);
      applyChatEnabled(!!msg.data.chatEnabled);
    } else {
      updateConnection(null);
    }
  }
  if (msg.type === 'refs') {
    if (document.querySelector('.tab[data-tab="refs"].active')) {
      fetchRefs();
    }
  }
});

// ─── Chat Gate ──────────────────────────────────────────────────
// Show/hide Chat tab + command bar based on chatEnabled from server

function applyChatEnabled(enabled) {
  const commandBar = document.querySelector('.command-bar');
  const chatTab = document.getElementById('tab-chat');
  const banner = document.getElementById('experimental-banner');
  const clearBtn = document.getElementById('clear-chat');

  if (enabled) {
    // Chat is enabled: show command bar, chat tab, experimental banner
    if (commandBar) commandBar.style.display = '';
    if (chatTab) chatTab.style.display = '';
    if (banner) banner.style.display = '';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    // Chat disabled: hide command bar, chat content, clear button
    if (commandBar) commandBar.style.display = 'none';
    if (banner) banner.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    // If currently on chat tab, switch to activity
    if (chatTab && chatTab.classList.contains('active')) {
      chatTab.classList.remove('active');
      // Open debug tabs and show activity
      const debugToggle = document.getElementById('debug-toggle');
      const debugTabs = document.getElementById('debug-tabs');
      if (debugToggle) debugToggle.classList.add('active');
      if (debugTabs) debugTabs.style.display = 'flex';
      const activityTab = document.getElementById('tab-activity');
      if (activityTab) activityTab.classList.add('active');
      const activityBtn = document.querySelector('.tab[data-tab="activity"]');
      if (activityBtn) activityBtn.classList.add('active');
    }
  }
}
