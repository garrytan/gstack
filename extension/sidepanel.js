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
let lastOptimisticMsg = null; // track optimistically rendered user msg to avoid dupes
let sidebarActiveTabId = null; // which browser tab's chat we're showing
const chatLineCountByTab = {}; // tabId -> last seen chatLineCount
const chatDomByTab = {}; // tabId -> saved DocumentFragment (never serialized HTML)
let pollInProgress = false; // reentrancy guard — prevents concurrent/recursive pollChat calls
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

// Dedup: track which entry IDs have already been rendered to prevent
// repeat rendering on reconnect or tab switch (server replays from disk)
const renderedEntryIds = new Set();

function addChatEntry(entry) {
  // Dedup by entry ID — prevent repeat rendering on reconnect/replay
  if (entry.id !== undefined) {
    if (renderedEntryIds.has(entry.id)) return;
    renderedEntryIds.add(entry.id);
  }

  // Remove welcome message on first real message
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // User messages → chat bubble (skip if we already rendered it optimistically)
  if (entry.role === 'user') {
    if (lastOptimisticMsg === entry.message) {
      lastOptimisticMsg = null; // consumed — don't skip next identical msg
      return;
    }
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

  // System notifications (cleanup, screenshot, errors)
  if (entry.type === 'notification') {
    const note = document.createElement('div');
    note.className = 'chat-notification';
    note.textContent = entry.message;
    chatMessages.appendChild(note);
    note.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
    // If we already showed thinking dots optimistically in sendMessage(),
    // don't duplicate. Just ensure fast polling is on.
    if (agentContainer && document.getElementById('agent-thinking')) {
      startFastPoll();
      updateStopButton(true);
      return;
    }
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
    startFastPoll();
    updateStopButton(true);
    return;
  }

  if (entry.type === 'agent_done') {
    // Remove thinking indicator
    const thinking = document.getElementById('agent-thinking');
    if (thinking) thinking.remove();
    updateStopButton(false);
    stopFastPoll();
    // Collapse tool calls into a "See reasoning" disclosure
    if (agentContainer) {
      const tools = agentContainer.querySelectorAll('.agent-tool');
      if (tools.length > 0) {
        const details = document.createElement('details');
        details.className = 'agent-reasoning';
        const summary = document.createElement('summary');
        summary.textContent = `See reasoning (${tools.length} step${tools.length > 1 ? 's' : ''})`;
        details.appendChild(summary);
        for (const tool of tools) {
          details.appendChild(tool);
        }
        // Insert the disclosure before the text response (if any)
        const textEl = agentContainer.querySelector('.agent-text');
        if (textEl) {
          agentContainer.insertBefore(details, textEl);
        } else {
          agentContainer.appendChild(details);
        }
      }
      // Add timestamp
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
    // Suppress timeout errors that fire after agent_done (cleanup noise)
    if (entry.error && entry.error.includes('Timed out') && !agentContainer) {
      return;
    }
    const thinking = document.getElementById('agent-thinking');
    if (thinking) thinking.remove();
    updateStopButton(false);
    stopFastPoll();
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
    const toolName = entry.tool || 'Tool';
    const toolInput = entry.input || '';

    // Skip tool uses with no description (e.g. internal tool-result file reads)
    if (!toolInput) return;

    const toolEl = document.createElement('div');
    toolEl.className = 'agent-tool';

    // Use the verbose description as the primary text
    // The tool name becomes a subtle badge
    const toolIcon = toolName === 'Bash' ? '▸' : toolName === 'Read' ? '📄' : toolName === 'Grep' ? '🔍' : toolName === 'Glob' ? '📁' : '⚡';
    toolEl.innerHTML = `<span class="tool-icon">${toolIcon}</span> <span class="tool-description">${escapeHtml(toolInput)}</span>`;
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

  // Show user bubble + thinking dots IMMEDIATELY — don't wait for poll.
  // This eliminates up to 1000ms of perceived latency.
  lastOptimisticMsg = msg;
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.innerHTML = `${escapeHtml(msg)}<span class="chat-time">${formatChatTime(new Date().toISOString())}</span>`;
  chatMessages.appendChild(userBubble);

  agentText = '';
  agentContainer = document.createElement('div');
  agentContainer.className = 'agent-response';
  agentTextEl = null;
  chatMessages.appendChild(agentContainer);
  const thinking = document.createElement('div');
  thinking.className = 'agent-thinking';
  thinking.id = 'agent-thinking';
  thinking.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
  agentContainer.appendChild(thinking);
  agentContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
  updateStopButton(true);

  // Speed up polling while agent is working
  startFastPoll();

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'sidebar-command', message: msg, tabId: sidebarActiveTabId }, resolve);
  });

  commandInput.disabled = false;
  sendBtn.disabled = false;
  commandInput.focus();

  if (result?.ok) {
    // Poll immediately to sync server state
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
document.getElementById('stop-agent-btn').addEventListener('click', stopAgent);

// Poll for new chat messages
let initialLoadDone = false;

async function pollChat() {
  if (pollInProgress) return;
  pollInProgress = true;
  if (!serverUrl || !serverToken) { pollInProgress = false; return; }
  try {
    // Request chat for the currently displayed tab
    const tabParam = sidebarActiveTabId !== null ? `&tabId=${sidebarActiveTabId}` : '';
    const resp = await fetch(`${serverUrl}/sidebar-chat?after=${chatLineCount}${tabParam}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      console.warn(`[gstack sidebar] Chat poll failed: ${resp.status} ${resp.statusText}`);
      return;
    }
    const data = await resp.json();

    // Detect tab switch from server — swap chat context.
    // IMPORTANT: return before cleaning up thinking dots — the agent may be
    // processing on the NEW tab while the OLD tab is idle. Removing the
    // thinking indicator here would kill the optimistic UI before the switch.
    if (data.activeTabId !== undefined && data.activeTabId !== sidebarActiveTabId) {
      switchChatTab(data.activeTabId);
      return; // switchChatTab triggers a fresh poll on the correct tab
    }

    // First successful poll — hide loading spinner
    if (!initialLoadDone) {
      initialLoadDone = true;
      sidebarActiveTabId = data.activeTabId ?? null;
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

    // Clean up orphaned thinking indicators after replay.
    // Only remove if we're on the CORRECT tab and the agent is truly idle.
    // Don't clean up during tab switches — the agent may be processing on
    // the new tab while the old tab shows idle.
    const thinking = document.getElementById('agent-thinking');
    if (thinking && data.agentStatus !== 'processing') {
      thinking.remove();
      agentContainer = null;
      agentTextEl = null;
    }

    // Show/hide stop button based on agent status
    updateStopButton(data.agentStatus === 'processing');
  } catch (err) {
    console.error('[gstack sidebar] Chat poll error:', err.message);
  } finally {
    pollInProgress = false;
  }
}

/** Switch the sidebar to show a different tab's chat context */
function switchChatTab(newTabId) {
  if (newTabId === sidebarActiveTabId) return;

  // Save current tab's chat DOM + scroll position
  if (sidebarActiveTabId !== null) {
    const frag = document.createDocumentFragment();
    while (chatMessages.firstChild) {
      frag.appendChild(chatMessages.firstChild);
    }
    chatDomByTab[sidebarActiveTabId] = frag;
    chatLineCountByTab[sidebarActiveTabId] = chatLineCount;
  }

  sidebarActiveTabId = newTabId;

  // Restore saved chat for new tab, or carry over current DOM if we're
  // mid-message (the server may have switched tabs because the user's
  // Chrome tab changed, but we still want to show the optimistic UI).
  if (chatDomByTab[newTabId]) {
    while (chatMessages.firstChild) chatMessages.removeChild(chatMessages.firstChild);
    chatMessages.appendChild(chatDomByTab[newTabId]);
    chatLineCount = chatLineCountByTab[newTabId] || 0;
    // Reset agent state for restored tab
    agentContainer = null;
    agentTextEl = null;
    agentText = '';
  } else if (lastOptimisticMsg && document.getElementById('agent-thinking')) {
    // We're mid-send with optimistic UI — keep it, don't blow it away.
    // The poll for the new tab will pick up the entries and sync naturally.
    chatLineCount = 0;
    // agentContainer/agentTextEl are already set from sendMessage()
  } else {
    while (chatMessages.firstChild) chatMessages.removeChild(chatMessages.firstChild);
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'chat-welcome';
    welcomeDiv.id = 'chat-welcome';
    const iconDiv = document.createElement('div');
    iconDiv.className = 'chat-welcome-icon';
    iconDiv.textContent = 'G';
    welcomeDiv.appendChild(iconDiv);
    const p1 = document.createElement('p');
    p1.textContent = 'Send a message about this page.';
    welcomeDiv.appendChild(p1);
    const p2 = document.createElement('p');
    p2.className = 'muted';
    p2.textContent = 'Each tab has its own conversation.';
    welcomeDiv.appendChild(p2);
    chatMessages.appendChild(welcomeDiv);
    chatLineCount = 0;
    // Reset agent state for fresh tab
    agentContainer = null;
    agentTextEl = null;
    agentText = '';
  }

  // Immediately poll the new tab's chat
  setTimeout(pollChat, 0);
}

function updateStopButton(agentRunning) {
  const stopBtn = document.getElementById('stop-agent-btn');
  if (!stopBtn) return;
  stopBtn.style.display = agentRunning ? '' : 'none';
}

async function stopAgent() {
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl}/sidebar-agent/stop`, { method: 'POST', headers: authHeaders() });
    if (!resp.ok) console.warn(`[gstack sidebar] Stop agent failed: ${resp.status}`);
  } catch (err) {
    console.error('[gstack sidebar] Stop agent error:', err.message);
  }
  // Immediately clean up UI
  const thinking = document.getElementById('agent-thinking');
  if (thinking) thinking.remove();
  if (agentContainer) {
    const notice = document.createElement('div');
    notice.className = 'agent-text';
    notice.style.color = 'var(--text-meta)';
    notice.style.fontStyle = 'italic';
    notice.textContent = 'Stopped';
    agentContainer.appendChild(notice);
    agentContainer = null;
    agentTextEl = null;
  }
  updateStopButton(false);
  stopFastPoll();
}

// ─── Adaptive poll speed ─────────────────────────────────────────
// 300ms while agent is working (fast first-token), 1000ms when idle.
const FAST_POLL_MS = 300;
const SLOW_POLL_MS = 1000;

function startFastPoll() {
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(pollChat, FAST_POLL_MS);
}

function stopFastPoll() {
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(pollChat, SLOW_POLL_MS);
}

// ─── Browser Tab Bar ─────────────────────────────────────────────
let tabPollInterval = null;
let lastTabJson = '';

async function pollTabs() {
  if (!serverUrl || !serverToken) return;
  try {
    // Tell the server which Chrome tab the user is actually looking at.
    // This syncs manual tab switches in the browser → server activeTabId.
    let activeTabUrl = null;
    try {
      const chromeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabUrl = chromeTabs?.[0]?.url || null;
    } catch (err) {
      console.debug('[gstack sidebar] Failed to get active tab URL:', err.message);
    }

    const resp = await fetch(`${serverUrl}/sidebar-tabs${activeTabUrl ? '?activeUrl=' + encodeURIComponent(activeTabUrl) : ''}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) {
      console.warn(`[gstack sidebar] Tab poll failed: ${resp.status} ${resp.statusText}`);
      return;
    }
    const data = await resp.json();
    if (!data.tabs) return;

    // Only re-render if tabs changed
    const json = JSON.stringify(data.tabs);
    if (json === lastTabJson) return;
    lastTabJson = json;

    renderTabBar(data.tabs);
  } catch (err) {
    console.error('[gstack sidebar] Tab poll error:', err.message);
  }
}

function renderTabBar(tabs) {
  const bar = document.getElementById('browser-tabs');
  if (!bar) return;

  if (!tabs || tabs.length <= 1) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  bar.innerHTML = '';

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'browser-tab' + (tab.active ? ' active' : '');
    el.title = tab.url || '';

    // Show favicon-style domain + title
    let label = tab.title || '';
    if (!label && tab.url) {
      try { label = new URL(tab.url).hostname; } catch { label = tab.url; }
    }
    if (label.length > 20) label = label.slice(0, 20) + '…';

    el.textContent = label || `Tab ${tab.id}`;
    el.dataset.tabId = tab.id;

    el.addEventListener('click', () => switchBrowserTab(tab.id));
    bar.appendChild(el);
  }
}

async function switchBrowserTab(tabId) {
  if (!serverUrl) return;
  try {
    await fetch(`${serverUrl}/sidebar-tabs/switch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: tabId }),
    });
    // Switch chat context + re-poll tabs
    switchChatTab(tabId);
    pollTabs();
  } catch (err) {
    console.error('[gstack sidebar] Failed to switch browser tab:', err.message);
  }
}

// ─── Clear Chat ─────────────────────────────────────────────────

document.getElementById('clear-chat').addEventListener('click', async () => {
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl}/sidebar-chat/clear`, { method: 'POST', headers: authHeaders() });
    if (!resp.ok) console.warn(`[gstack sidebar] Clear chat failed: ${resp.status}`);
  } catch (err) {
    console.error('[gstack sidebar] Clear chat error:', err.message);
  }
  // Reset local state
  chatLineCount = 0;
  renderedEntryIds.clear();
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

// ─── Reload Sidebar ─────────────────────────────────────────────
document.getElementById('reload-sidebar').addEventListener('click', () => {
  location.reload();
});

// ─── Copy Cookies ───────────────────────────────────────────────
document.getElementById('chat-cookies-btn').addEventListener('click', async () => {
  if (!serverUrl) return;
  // Navigate the browser to the cookie picker page hosted by the browse server
  try {
    await fetch(`${serverUrl}/command`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ command: 'goto', args: [`${serverUrl}/cookie-picker`] }),
    });
  } catch (err) {
    console.error('[gstack sidebar] Failed to open cookie picker:', err.message);
  }
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
      <span class="entry-command">${escapeHtml(entry.command || entry.type)}</span>
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

  const tokenParam = serverToken ? `&token=${serverToken}` : '';
  const url = `${serverUrl}/activity/stream?after=${lastId}${tokenParam}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('activity', (e) => {
    try { addEntry(JSON.parse(e.data)); } catch (err) {
      console.error('[gstack sidebar] Failed to parse activity event:', err.message);
    }
  });

  eventSource.addEventListener('gap', (e) => {
    try {
      const data = JSON.parse(e.data);
      const feed = document.getElementById('activity-feed');
      const banner = document.createElement('div');
      banner.className = 'gap-banner';
      banner.textContent = `Missed ${data.availableFrom - data.gapFrom} events`;
      feed.appendChild(banner);
    } catch (err) {
      console.error('[gstack sidebar] Failed to parse gap event:', err.message);
    }
  });
}

// ─── Refs Tab ───────────────────────────────────────────────────

async function fetchRefs() {
  if (!serverUrl) return;
  try {
    const headers = {};
    if (serverToken) headers['Authorization'] = `Bearer ${serverToken}`;
    const resp = await fetch(`${serverUrl}/refs`, { signal: AbortSignal.timeout(3000), headers });
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
  } catch (err) {
    console.error('[gstack sidebar] Failed to fetch refs:', err.message);
  }
}

// ─── Inspector Tab ──────────────────────────────────────────────

let inspectorPickerActive = false;
let inspectorData = null; // last inspect result
let inspectorModifications = []; // tracked style changes
let inspectorSSE = null;

// Inspector DOM refs
const inspectorPickBtn = document.getElementById('inspector-pick-btn');
const inspectorSelected = document.getElementById('inspector-selected');
const inspectorModeBadge = document.getElementById('inspector-mode-badge');
const inspectorEmpty = document.getElementById('inspector-empty');
const inspectorLoading = document.getElementById('inspector-loading');
const inspectorError = document.getElementById('inspector-error');
const inspectorPanels = document.getElementById('inspector-panels');
const inspectorBoxmodel = document.getElementById('inspector-boxmodel');
const inspectorRules = document.getElementById('inspector-rules');
const inspectorRuleCount = document.getElementById('inspector-rule-count');
const inspectorComputed = document.getElementById('inspector-computed');
const inspectorQuickedit = document.getElementById('inspector-quickedit');
const inspectorSend = document.getElementById('inspector-send');
const inspectorSendBtn = document.getElementById('inspector-send-btn');

// Pick button
inspectorPickBtn.addEventListener('click', () => {
  if (inspectorPickerActive) {
    inspectorPickerActive = false;
    inspectorPickBtn.classList.remove('active');
    chrome.runtime.sendMessage({ type: 'stopInspector' });
  } else {
    inspectorPickerActive = true;
    inspectorPickBtn.classList.add('active');
    inspectorShowLoading(false); // don't show loading yet, just activate
    chrome.runtime.sendMessage({ type: 'startInspector' }, (result) => {
      if (result?.error) {
        inspectorPickerActive = false;
        inspectorPickBtn.classList.remove('active');
        inspectorShowError(result.error);
      }
    });
  }
});

function inspectorShowEmpty() {
  inspectorEmpty.style.display = '';
  inspectorLoading.style.display = 'none';
  inspectorError.style.display = 'none';
  inspectorPanels.style.display = 'none';
  inspectorSend.style.display = 'none';
}

function inspectorShowLoading(show) {
  if (show) {
    inspectorEmpty.style.display = 'none';
    inspectorLoading.style.display = '';
    inspectorError.style.display = 'none';
    inspectorPanels.style.display = 'none';
  } else {
    inspectorLoading.style.display = 'none';
  }
}

function inspectorShowError(message) {
  inspectorEmpty.style.display = 'none';
  inspectorLoading.style.display = 'none';
  inspectorError.style.display = '';
  inspectorError.textContent = message;
  inspectorPanels.style.display = 'none';
}

function inspectorShowData(data) {
  inspectorData = data;
  inspectorModifications = [];
  inspectorEmpty.style.display = 'none';
  inspectorLoading.style.display = 'none';
  inspectorError.style.display = 'none';
  inspectorPanels.style.display = '';
  inspectorSend.style.display = '';

  // Update toolbar
  const tag = data.tagName || '?';
  const cls = data.classes && data.classes.length > 0 ? '.' + data.classes.join('.') : '';
  const idStr = data.id ? '#' + data.id : '';
  inspectorSelected.textContent = `<${tag}>${idStr}${cls}`;
  inspectorSelected.title = data.selector;

  // Mode badge
  if (data.mode === 'basic') {
    inspectorModeBadge.textContent = 'Basic mode';
    inspectorModeBadge.style.display = '';
    inspectorModeBadge.className = 'inspector-mode-badge basic';
  } else if (data.mode === 'cdp') {
    inspectorModeBadge.textContent = 'CDP';
    inspectorModeBadge.style.display = '';
    inspectorModeBadge.className = 'inspector-mode-badge cdp';
  } else {
    inspectorModeBadge.style.display = 'none';
  }

  // Render sections
  renderBoxModel(data);
  renderMatchedRules(data);
  renderComputedStyles(data);
  renderQuickEdit(data);
  updateSendButton();
}

// ─── Box Model Rendering ────────────────────────────────────────

function renderBoxModel(data) {
  const box = data.basicData?.boxModel || data.boxModel;
  if (!box) { inspectorBoxmodel.innerHTML = '<span class="inspector-no-data">No box model data</span>'; return; }

  const m = box.margin || {};
  const b = box.border || {};
  const p = box.padding || {};
  const c = box.content || {};

  inspectorBoxmodel.innerHTML = `
    <div class="boxmodel-margin">
      <span class="boxmodel-label">margin</span>
      <span class="boxmodel-value boxmodel-top">${fmtBoxVal(m.top)}</span>
      <span class="boxmodel-value boxmodel-right">${fmtBoxVal(m.right)}</span>
      <span class="boxmodel-value boxmodel-bottom">${fmtBoxVal(m.bottom)}</span>
      <span class="boxmodel-value boxmodel-left">${fmtBoxVal(m.left)}</span>
      <div class="boxmodel-border">
        <span class="boxmodel-label">border</span>
        <span class="boxmodel-value boxmodel-top">${fmtBoxVal(b.top)}</span>
        <span class="boxmodel-value boxmodel-right">${fmtBoxVal(b.right)}</span>
        <span class="boxmodel-value boxmodel-bottom">${fmtBoxVal(b.bottom)}</span>
        <span class="boxmodel-value boxmodel-left">${fmtBoxVal(b.left)}</span>
        <div class="boxmodel-padding">
          <span class="boxmodel-label">padding</span>
          <span class="boxmodel-value boxmodel-top">${fmtBoxVal(p.top)}</span>
          <span class="boxmodel-value boxmodel-right">${fmtBoxVal(p.right)}</span>
          <span class="boxmodel-value boxmodel-bottom">${fmtBoxVal(p.bottom)}</span>
          <span class="boxmodel-value boxmodel-left">${fmtBoxVal(p.left)}</span>
          <div class="boxmodel-content">
            <span>${Math.round(c.width || 0)} x ${Math.round(c.height || 0)}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function fmtBoxVal(v) {
  if (v === undefined || v === null) return '-';
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (isNaN(n) || n === 0) return '0';
  return Math.round(n * 10) / 10;
}

// ─── Matched Rules Rendering ────────────────────────────────────

function renderMatchedRules(data) {
  const rules = data.matchedRules || data.basicData?.matchedRules || [];
  inspectorRuleCount.textContent = rules.length > 0 ? `(${rules.length})` : '';

  if (rules.length === 0) {
    inspectorRules.innerHTML = '<div class="inspector-no-data">No matched rules</div>';
    return;
  }

  // Separate UA rules from author rules
  const authorRules = [];
  const uaRules = [];
  for (const rule of rules) {
    if (rule.origin === 'user-agent' || rule.isUA) {
      uaRules.push(rule);
    } else {
      authorRules.push(rule);
    }
  }

  let html = '';

  // Author rules (expanded)
  for (const rule of authorRules) {
    html += renderRule(rule, false);
  }

  // UA rules (collapsed by default)
  if (uaRules.length > 0) {
    html += `
      <div class="inspector-ua-rules">
        <button class="inspector-ua-toggle collapsed" aria-expanded="false">
          <span class="inspector-toggle-arrow">&#x25B6;</span>
          User Agent (${uaRules.length})
        </button>
        <div class="inspector-ua-body collapsed">
    `;
    for (const rule of uaRules) {
      html += renderRule(rule, true);
    }
    html += '</div></div>';
  }

  inspectorRules.innerHTML = html;

  // Bind UA toggle
  const uaToggle = inspectorRules.querySelector('.inspector-ua-toggle');
  if (uaToggle) {
    uaToggle.addEventListener('click', () => {
      const body = inspectorRules.querySelector('.inspector-ua-body');
      const isCollapsed = uaToggle.classList.contains('collapsed');
      uaToggle.classList.toggle('collapsed', !isCollapsed);
      uaToggle.setAttribute('aria-expanded', isCollapsed);
      uaToggle.querySelector('.inspector-toggle-arrow').innerHTML = isCollapsed ? '&#x25BC;' : '&#x25B6;';
      body.classList.toggle('collapsed', !isCollapsed);
    });
  }
}

function renderRule(rule, isUA) {
  const selectorText = escapeHtml(rule.selector || '');
  const truncatedSelector = selectorText.length > 35 ? selectorText.slice(0, 35) + '...' : selectorText;
  const source = rule.source || '';
  const sourceDisplay = source.includes('/') ? source.split('/').pop() : source;
  const specificity = rule.specificity || '';

  let propsHtml = '';
  const props = rule.properties || [];
  for (const prop of props) {
    const overridden = prop.overridden ? ' overridden' : '';
    const nameHtml = escapeHtml(prop.name);
    const valText = escapeHtml(prop.value || '');
    const truncatedVal = valText.length > 30 ? valText.slice(0, 30) + '...' : valText;
    const priority = prop.priority === 'important' ? ' <span class="inspector-important">!important</span>' : '';
    propsHtml += `<div class="inspector-prop${overridden}"><span class="inspector-prop-name">${nameHtml}</span>: <span class="inspector-prop-value" title="${valText}">${truncatedVal}</span>${priority};</div>`;
  }

  return `
    <div class="inspector-rule" role="treeitem">
      <div class="inspector-rule-header">
        <span class="inspector-selector" title="${selectorText}">${truncatedSelector}</span>
        ${specificity ? `<span class="inspector-specificity">${escapeHtml(specificity)}</span>` : ''}
      </div>
      <div class="inspector-rule-props">${propsHtml}</div>
      ${sourceDisplay ? `<div class="inspector-rule-source">${escapeHtml(sourceDisplay)}</div>` : ''}
    </div>
  `;
}

// ─── Computed Styles Rendering ──────────────────────────────────

function renderComputedStyles(data) {
  const styles = data.computedStyles || data.basicData?.computedStyles || {};
  const keys = Object.keys(styles);

  if (keys.length === 0) {
    inspectorComputed.innerHTML = '<div class="inspector-no-data">No computed styles</div>';
    return;
  }

  let html = '';
  for (const key of keys) {
    const val = styles[key];
    if (!val || val === 'none' || val === 'normal' || val === 'auto' || val === '0px' || val === 'rgba(0, 0, 0, 0)') continue;
    html += `<div class="inspector-computed-row"><span class="inspector-prop-name">${escapeHtml(key)}</span>: <span class="inspector-prop-value">${escapeHtml(val)}</span></div>`;
  }

  if (!html) {
    html = '<div class="inspector-no-data">All values are defaults</div>';
  }

  inspectorComputed.innerHTML = html;
}

// ─── Quick Edit ─────────────────────────────────────────────────

function renderQuickEdit(data) {
  const selector = data.selector;
  if (!selector) { inspectorQuickedit.innerHTML = ''; return; }

  // Show common editable properties with current values
  const editableProps = ['color', 'background-color', 'font-size', 'padding', 'margin', 'border', 'display', 'opacity'];
  const computed = data.computedStyles || data.basicData?.computedStyles || {};

  let html = '<div class="inspector-quickedit-list">';
  for (const prop of editableProps) {
    const val = computed[prop] || '';
    html += `
      <div class="inspector-quickedit-row" data-prop="${escapeHtml(prop)}">
        <span class="inspector-prop-name">${escapeHtml(prop)}</span>:
        <span class="inspector-quickedit-value" data-selector="${escapeHtml(selector)}" data-prop="${escapeHtml(prop)}" tabindex="0" role="button" title="Click to edit">${escapeHtml(val || '(none)')}</span>
      </div>
    `;
  }
  html += '</div>';
  inspectorQuickedit.innerHTML = html;

  // Bind click-to-edit
  inspectorQuickedit.querySelectorAll('.inspector-quickedit-value').forEach(el => {
    el.addEventListener('click', () => startQuickEdit(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startQuickEdit(el); }
    });
  });
}

function startQuickEdit(valueEl) {
  if (valueEl.querySelector('input')) return; // already editing

  const currentVal = valueEl.textContent === '(none)' ? '' : valueEl.textContent;
  const prop = valueEl.dataset.prop;
  const selector = valueEl.dataset.selector;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inspector-quickedit-input';
  input.value = currentVal;
  valueEl.textContent = '';
  valueEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim();
    valueEl.textContent = newVal || '(none)';
    if (newVal && newVal !== currentVal) {
      chrome.runtime.sendMessage({
        type: 'applyStyle',
        selector,
        property: prop,
        value: newVal,
      });
      inspectorModifications.push({ property: prop, value: newVal, selector });
      updateSendButton();
    }
  }

  function cancel() {
    valueEl.textContent = currentVal || '(none)';
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
  });
}

// ─── Send to Agent ──────────────────────────────────────────────

function updateSendButton() {
  if (inspectorModifications.length > 0) {
    inspectorSendBtn.textContent = 'Send to Code';
    inspectorSendBtn.title = `${inspectorModifications.length} modification(s) to send`;
  } else {
    inspectorSendBtn.textContent = 'Send to Agent';
    inspectorSendBtn.title = 'Send full inspector data';
  }
}

inspectorSendBtn.addEventListener('click', () => {
  if (!inspectorData) return;

  let message;
  if (inspectorModifications.length > 0) {
    // Format modification diff
    const diffs = inspectorModifications.map(m =>
      `  ${m.property}: ${m.value} (selector: ${m.selector})`
    ).join('\n');
    message = `CSS Inspector modifications:\n\nSelector: ${inspectorData.selector}\n\nChanges:\n${diffs}`;

    // Include source file info if available
    const rules = inspectorData.matchedRules || inspectorData.basicData?.matchedRules || [];
    const sources = rules.filter(r => r.source && r.source !== 'inline').map(r => r.source);
    if (sources.length > 0) {
      message += `\n\nSource files:\n${[...new Set(sources)].map(s => `  ${s}`).join('\n')}`;
    }
  } else {
    // Send full inspector data
    message = `CSS Inspector data for: ${inspectorData.selector}\n\n${JSON.stringify(inspectorData, null, 2)}`;
  }

  chrome.runtime.sendMessage({ type: 'sidebar-command', message });
});

// ─── Quick Action Helpers (shared between chat toolbar + inspector) ──

async function runCleanup(...buttons) {
  if (!serverUrl || !serverToken) {
    return;
  }
  buttons.forEach(b => b?.classList.add('loading'));

  // Smart cleanup: send a chat message to the sidebar agent (an LLM).
  // The agent snapshots the page, understands it semantically, and removes
  // clutter intelligently. Much better than brittle CSS selectors.
  const cleanupPrompt = [
    'Clean up this page for reading. First run a quick deterministic pass:',
    '$B cleanup --all',
    '',
    'Then take a snapshot to see what\'s left:',
    '$B snapshot -i',
    '',
    'Look at the snapshot and identify remaining non-content elements:',
    '- Ad placeholders, "ADVERTISEMENT" labels, sponsored content',
    '- Cookie/consent banners, newsletter popups, login walls',
    '- Audio/podcast player widgets, video autoplay',
    '- Sidebar widgets (puzzles, games, "most popular", recommendations)',
    '- Social share buttons, follow prompts, "See more on Google"',
    '- Floating chat widgets, feedback buttons',
    '- Navigation drawers, mega-menus (unless they ARE the page content)',
    '- Empty whitespace from removed ads',
    '',
    'KEEP: the site header/masthead/logo, article headline, article body,',
    'article images, author byline, date. The page should still look like',
    'the site it is, just without the crap.',
    '',
    'For each element to remove, run JavaScript via $B to hide it:',
    '$B eval "document.querySelector(\'SELECTOR\').style.display=\'none\'"',
    '',
    'Also unlock scrolling if the page is scroll-locked:',
    '$B eval "document.body.style.overflow=\'auto\';document.documentElement.style.overflow=\'auto\'"',
  ].join('\n');

  try {
    // Send as a sidebar command (spawns the agent)
    const resp = await fetch(`${serverUrl}/sidebar-command`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message: cleanupPrompt }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      addChatEntry({ type: 'notification', message: 'Cleaning up page (agent is analyzing...)' });
    } else {
      addChatEntry({ type: 'notification', message: 'Failed to start cleanup' });
    }
  } catch (err) {
    addChatEntry({ type: 'notification', message: 'Cleanup failed: ' + err.message });
  } finally {
    // Remove loading after a short delay (agent runs async)
    setTimeout(() => buttons.forEach(b => b?.classList.remove('loading')), 2000);
  }
}

async function runScreenshot(...buttons) {
  if (!serverUrl || !serverToken) {
    return;
  }
  buttons.forEach(b => b?.classList.add('loading'));
  try {
    const resp = await fetch(`${serverUrl}/command`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'screenshot', args: [] }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    if (resp.ok) {
      addChatEntry({ type: 'notification', message: text || 'Screenshot saved' });
    } else {
      const err = JSON.parse(text).error || 'Screenshot failed';
      addChatEntry({ type: 'notification', message: 'Error: ' + err });
    }
  } catch (err) {
    addChatEntry({ type: 'notification', message: 'Screenshot failed: ' + err.message });
  } finally {
    buttons.forEach(b => b?.classList.remove('loading'));
  }
}

// ─── Wire up all cleanup/screenshot buttons (inspector + chat toolbar) ──

const inspectorCleanupBtn = document.getElementById('inspector-cleanup-btn');
const inspectorScreenshotBtn = document.getElementById('inspector-screenshot-btn');
const chatCleanupBtn = document.getElementById('chat-cleanup-btn');
const chatScreenshotBtn = document.getElementById('chat-screenshot-btn');

if (inspectorCleanupBtn) inspectorCleanupBtn.addEventListener('click', () => runCleanup(inspectorCleanupBtn, chatCleanupBtn));
if (inspectorScreenshotBtn) inspectorScreenshotBtn.addEventListener('click', () => runScreenshot(inspectorScreenshotBtn, chatScreenshotBtn));
if (chatCleanupBtn) chatCleanupBtn.addEventListener('click', () => runCleanup(chatCleanupBtn, inspectorCleanupBtn));
if (chatScreenshotBtn) chatScreenshotBtn.addEventListener('click', () => runScreenshot(chatScreenshotBtn, inspectorScreenshotBtn));

// ─── Section Toggles ────────────────────────────────────────────

document.querySelectorAll('.inspector-section-toggle').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const section = toggle.dataset.section;
    const body = document.getElementById(`inspector-${section}`);
    const isCollapsed = toggle.classList.contains('collapsed');

    toggle.classList.toggle('collapsed', !isCollapsed);
    toggle.setAttribute('aria-expanded', isCollapsed);
    toggle.querySelector('.inspector-toggle-arrow').innerHTML = isCollapsed ? '&#x25BC;' : '&#x25B6;';
    body.classList.toggle('collapsed', !isCollapsed);
  });
});

// ─── Inspector SSE ──────────────────────────────────────────────

function connectInspectorSSE() {
  if (!serverUrl || !serverToken) return;
  if (inspectorSSE) { inspectorSSE.close(); inspectorSSE = null; }

  const tokenParam = serverToken ? `&token=${serverToken}` : '';
  const url = `${serverUrl}/inspector/events?_=${Date.now()}${tokenParam}`;

  try {
    inspectorSSE = new EventSource(url);

    inspectorSSE.addEventListener('inspectResult', (e) => {
      try {
        const data = JSON.parse(e.data);
        inspectorShowData(data);
      } catch (err) {
        console.error('[gstack sidebar] Failed to parse inspectResult:', err.message);
      }
    });

    inspectorSSE.addEventListener('error', () => {
      // SSE connection failed — inspector works without it (basic mode)
      if (inspectorSSE) { inspectorSSE.close(); inspectorSSE = null; }
    });
  } catch (err) {
    console.debug('[gstack sidebar] Inspector SSE not available:', err.message);
  }
}

// ─── Server Discovery ───────────────────────────────────────────

function setActionButtonsEnabled(enabled) {
  const btns = document.querySelectorAll('.quick-action-btn, .inspector-action-btn');
  btns.forEach(btn => {
    btn.disabled = !enabled;
    btn.classList.toggle('disabled', !enabled);
  });
}

function updateConnection(url, token) {
  const wasConnected = !!serverUrl;
  serverUrl = url;
  serverToken = token || null;
  if (url) {
    document.getElementById('footer-dot').className = 'dot connected';
    const port = new URL(url).port;
    document.getElementById('footer-port').textContent = `:${port}`;
    setConnState('connected');
    setActionButtonsEnabled(true);
    // Tell the active tab's content script the sidebar is open — this hides
    // the welcome page arrow hint. Only fires on actual sidebar connection.
    chrome.runtime.sendMessage({ type: 'sidebarOpened' }).catch(() => {});
    connectSSE();
    connectInspectorSSE();
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(pollChat, SLOW_POLL_MS);
    pollChat();
    // Poll browser tabs every 2s (lightweight, just tab list)
    if (tabPollInterval) clearInterval(tabPollInterval);
    tabPollInterval = setInterval(pollTabs, 2000);
    pollTabs();
  } else {
    document.getElementById('footer-dot').className = 'dot';
    document.getElementById('footer-port').textContent = '';
    setActionButtonsEnabled(false);
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    if (tabPollInterval) { clearInterval(tabPollInterval); tabPollInterval = null; }
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
  navigator.clipboard.writeText('/open-gstack-browser').then(() => {
    const btn = document.getElementById('conn-copy');
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = '/open-gstack-browser'; }, 2000);
  });
});

// Try to connect immediately, retry every 2s until connected.
// Show exactly what's happening at each step so the user is never
// staring at a blank "Connecting..." with no info.
let connectAttempts = 0;
function setLoadingStatus(msg, debug) {
  const status = document.getElementById('loading-status');
  const dbg = document.getElementById('loading-debug');
  if (status) status.textContent = msg;
  if (dbg && debug !== undefined) dbg.textContent = debug;
}

async function tryConnect() {
  connectAttempts++;
  setLoadingStatus(
    `Looking for browse server... (attempt ${connectAttempts})`,
    `Asking background.js for server port...`
  );

  // Step 1: Ask background for the port
  const resp = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'getPort' }, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(r || {});
      }
    });
  });

  if (resp.error) {
    setLoadingStatus(
      `Extension error (attempt ${connectAttempts})`,
      `chrome.runtime.sendMessage failed:\n${resp.error}`
    );
    setTimeout(tryConnect, 2000);
    return;
  }

  const port = resp.port || 34567;

  // Step 2: If background says connected + has token, use that
  if (resp.port && resp.connected && resp.token) {
    setLoadingStatus(
      `Server found on port ${port}, connecting...`,
      `token: yes\nStarting SSE + chat polling...`
    );
    updateConnection(`http://127.0.0.1:${port}`, resp.token);
    return;
  }

  // Step 3: Background not connected yet. Try hitting /health directly.
  // This bypasses the background.js health poll timing gap.
  setLoadingStatus(
    `Checking server directly... (attempt ${connectAttempts})`,
    `port: ${port}\nbackground connected: ${resp.connected || false}\nTrying GET http://127.0.0.1:${port}/health ...`
  );

  try {
    const healthResp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    if (healthResp.ok) {
      const data = await healthResp.json();
      if (data.status === 'healthy' && data.token) {
        setLoadingStatus(
          `Server healthy on port ${port}, connecting...`,
          `token: yes (from /health)\nStarting SSE + chat polling...`
        );
        updateConnection(`http://127.0.0.1:${port}`, data.token);
        return;
      }
      setLoadingStatus(
        `Server responded but not healthy (attempt ${connectAttempts})`,
        `status: ${data.status}\ntoken: ${data.token ? 'yes' : 'no'}`
      );
    } else {
      setLoadingStatus(
        `Server returned ${healthResp.status} (attempt ${connectAttempts})`,
        `GET /health → ${healthResp.status} ${healthResp.statusText}`
      );
    }
  } catch (e) {
    setLoadingStatus(
      `Server not reachable on port ${port} (attempt ${connectAttempts})`,
      `GET /health failed: ${e.message}\n\nThe browse server may still be starting.\nRun /open-gstack-browser in Claude Code.`
    );
  }

  setTimeout(tryConnect, 2000);
}
tryConnect();

// ─── Message Listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'health') {
    if (msg.data) {
      const url = `http://127.0.0.1:${msg.data.port || 34567}`;
      // Request token via targeted sendResponse (not broadcast) to limit exposure
      chrome.runtime.sendMessage({ type: 'getToken' }, (resp) => {
        updateConnection(url, resp?.token || null);
      });
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
  if (msg.type === 'inspectResult') {
    inspectorPickerActive = false;
    inspectorPickBtn.classList.remove('active');
    if (msg.data) {
      inspectorShowData(msg.data);
    } else {
      inspectorShowError('Element not found, try picking again');
    }
  }
  if (msg.type === 'pickerCancelled') {
    inspectorPickerActive = false;
    inspectorPickBtn.classList.remove('active');
  }
  // Instant tab switch — background.js fires this on chrome.tabs.onActivated
  if (msg.type === 'browserTabActivated') {
    // Tell the server which tab is now active, then switch chat context
    if (serverUrl && serverToken) {
      fetch(`${serverUrl}/sidebar-tabs?activeUrl=${encodeURIComponent(msg.url || '')}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2000),
      }).then(r => r.json()).then(data => {
        if (data.tabs) {
          renderTabBar(data.tabs);
          // Find the server-side tab ID for this Chrome tab
          const activeTab = data.tabs.find(t => t.active);
          if (activeTab && activeTab.id !== sidebarActiveTabId) {
            switchChatTab(activeTab.id);
          }
        }
      }).catch(() => {});
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
