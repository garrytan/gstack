/**
 * gstack browse — Side Panel
 *
 * Terminal pane (default): live claude PTY via xterm.js, driven by
 * sidepanel-terminal.js. The chat queue + sidebar-agent.ts were ripped
 * in favor of the interactive REPL — no more one-shot claude -p.
 *
 * Debug tabs (behind the `debug` toggle): activity feed (SSE) + refs +
 * inspector. Quick-actions toolbar (Cleanup / Screenshot / Cookies)
 * lives at the top of the Terminal pane.
 */

const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);
const INTERACTION_COMMANDS = new Set(['click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait', 'upload']);
const OBSERVE_COMMANDS = new Set(['snapshot', 'screenshot', 'diff', 'console', 'network', 'text', 'html', 'links', 'forms', 'accessibility', 'cookies', 'storage', 'perf']);

let lastId = 0;
let eventSource = null;
let serverUrl = null;
let serverToken = null;
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


// ─── Chat path ripped ────────────────────────────────────────────
// Chat queue + sendMessage + pollChat + switchChatTab + browser-tabs
// strip + security banner all lived here. Replaced by the interactive
// claude PTY in sidepanel-terminal.js (and terminal-agent.ts on the
// server side).

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

// The Terminal pane is the only primary surface; Activity / Refs / Inspector
// are debug overlays behind the `debug` toggle. Closing debug returns to
// the Terminal pane, which is always present.
const PRIMARY_PANE_ID = 'tab-terminal';

function showPrimaryPane() {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(PRIMARY_PANE_ID).classList.add('active');
  document.querySelectorAll('.debug-tabs .tab').forEach(t => t.classList.remove('active'));
}

debugToggle.addEventListener('click', () => {
  debugOpen = !debugOpen;
  debugToggle.classList.toggle('active', debugOpen);
  debugTabs.style.display = debugOpen ? 'flex' : 'none';
  if (!debugOpen) showPrimaryPane();
});

closeDebug.addEventListener('click', () => {
  debugOpen = false;
  debugToggle.classList.remove('active');
  debugTabs.style.display = 'none';
  showPrimaryPane();
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
  // DOM text-node serialization escapes &, <, > but NOT " or '. Call sites
  // that interpolate escapeHtml output inside an attribute value (title="...",
  // data-x="...") need those escaped too or an attacker-controlled value can
  // break out of the attribute. Add both manually.
  return div.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── SSE Connection ─────────────────────────────────────────────

// Fetch a view-only SSE session cookie before opening EventSource.
// EventSource can't send Authorization headers, and putting the root
// token in the URL (the old ?token= path) leaks it to logs, referer
// headers, and browser history. POST /sse-session issues an HttpOnly
// SameSite=Strict cookie scoped to SSE reads only; withCredentials:true
// on EventSource makes the browser send it back.
async function ensureSseSessionCookie() {
  if (!serverUrl || !serverToken) return false;
  try {
    const resp = await fetch(`${serverUrl}/sse-session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': `Bearer ${serverToken}` },
    });
    return resp.ok;
  } catch (err) {
    console.warn('[gstack sidebar] Failed to mint SSE session cookie:', err && err.message);
    return false;
  }
}

async function connectSSE() {
  if (!serverUrl) return;
  if (eventSource) { eventSource.close(); eventSource = null; }

  await ensureSseSessionCookie();
  const url = `${serverUrl}/activity/stream?after=${lastId}`;
  eventSource = new EventSource(url, { withCredentials: true });

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

// ─── Memory Footer Readout ──────────────────────────────────────
//
// Polls /memory every 30s and renders "RSS: 1.4 GB · 12 tabs" in the
// footer. Backs off to 5min if a poll takes > 2s (Codex flag — diagnostic
// shouldn't add load when the browser is already unhealthy). Uses Bearer
// auth like /refs above; /memory is a plain GET so EventSource semantics
// don't apply.

const MEM_POLL_FAST_MS = 30_000;
const MEM_POLL_SLOW_MS = 5 * 60_000;
const MEM_POLL_TIMEOUT_MS = 8_000;
const MEM_POLL_SLOW_THRESHOLD_MS = 2_000;
let memPollTimer = null;
let memPollMode = 'fast'; // 'fast' | 'slow'

function fmtBytesShort(n) {
  if (typeof n !== 'number' || isNaN(n)) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function renderMemFooter(snapshot) {
  const el = document.getElementById('footer-mem');
  if (!el) return;
  const bunRss = snapshot?.bunServer?.rss ?? 0;
  const tabCount = Array.isArray(snapshot?.tabs) ? snapshot.tabs.length : 0;
  el.textContent = `${fmtBytesShort(bunRss)} · ${tabCount} tabs`;
  // Color thresholds: ~2 GB Bun RSS or 50 tabs is "watch this"; ~8 GB or
  // 200 tabs is "this is the cliff" (matches the 200-tab guardrail).
  el.classList.remove('warn', 'bad');
  if (bunRss > 8 * 1024 * 1024 * 1024 || tabCount > 200) el.classList.add('bad');
  else if (bunRss > 2 * 1024 * 1024 * 1024 || tabCount > 50) el.classList.add('warn');
}

async function pollMemoryOnce() {
  if (!serverUrl || !serverToken) return { ok: false, slow: false };
  const start = Date.now();
  try {
    const resp = await fetch(`${serverUrl}/memory`, {
      headers: { 'Authorization': `Bearer ${serverToken}` },
      signal: AbortSignal.timeout(MEM_POLL_TIMEOUT_MS),
      credentials: 'include',
    });
    const elapsed = Date.now() - start;
    if (!resp.ok) return { ok: false, slow: elapsed > MEM_POLL_SLOW_THRESHOLD_MS };
    const snapshot = await resp.json();
    renderMemFooter(snapshot);
    // Evaluate guardrail triggers (single-heavy-tab OR tab-count crossing 200).
    // Toast is hidden when no trigger fires; snooze state suppresses re-fire.
    try { evaluateMemToast(snapshot); } catch (err) {
      console.debug('[gstack sidebar] mem-toast evaluation failed:', err && err.message);
    }
    return { ok: true, slow: elapsed > MEM_POLL_SLOW_THRESHOLD_MS };
  } catch (err) {
    const elapsed = Date.now() - start;
    // Don't log every poll failure — common during browser restarts / restoring
    // sessions. Only log on the slow path so the user sees something in the
    // console if the diagnostic itself is misbehaving.
    if (elapsed > MEM_POLL_SLOW_THRESHOLD_MS) {
      console.debug('[gstack sidebar] /memory poll slow/failed:', elapsed, 'ms', err && err.message);
    }
    return { ok: false, slow: elapsed > MEM_POLL_SLOW_THRESHOLD_MS };
  }
}

function scheduleNextMemPoll(delayMs) {
  if (memPollTimer) clearTimeout(memPollTimer);
  memPollTimer = setTimeout(async () => {
    const { ok, slow } = await pollMemoryOnce();
    if (!ok || slow) {
      memPollMode = 'slow';
      scheduleNextMemPoll(MEM_POLL_SLOW_MS);
    } else {
      // Successful + fast → back to fast cadence.
      if (memPollMode === 'slow') memPollMode = 'fast';
      scheduleNextMemPoll(MEM_POLL_FAST_MS);
    }
  }, delayMs);
}

function startMemPolling() {
  if (memPollTimer) return; // already running
  // Kick off an immediate poll so the footer populates within ~1s of sidebar
  // open, instead of waiting 30s for the first cycle.
  scheduleNextMemPoll(500);
}

function stopMemPolling() {
  if (memPollTimer) {
    clearTimeout(memPollTimer);
    memPollTimer = null;
  }
}

// ─── Tab guardrail toast (D5 + Codex single-tab flag) ───────
//
// Each /memory poll evaluates two trigger conditions:
//   1. Tab count crossed 200 — show "top 5 tabs by max(jsHeap, ...)" with
//      Close-selected + Snooze.
//   2. Any single tab over 4 GB JS heap — show one-tab toast (catches the
//      Codex case where a runaway WebGL/video page balloons one tab).
// Snooze persists in chrome.storage.session: next warn fires at tabCount +
// snoozeBumpTabs OR when a single tab crosses (snoozedJsHeapBytes + 1).
//
// "Close selected" runs $B closetab <id> via the existing /command path —
// no chrome.tabs.remove bridge needed.

const HEAVY_TAB_HEAP_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB per Codex flag
const TOAST_SNOOZE_TAB_BUMP = 50;                    // re-warn at 200+50
const TOAST_SNOOZE_HEAP_BUMP = 2 * 1024 * 1024 * 1024;

const memToastSnooze = {
  tabsAbove: 0,         // suppress the count-toast until tabs strictly exceeds this
  heapAbove: 0,         // suppress the single-tab toast until heap strictly exceeds this
};

async function loadSnoozeState() {
  if (!chrome?.storage?.session) return;
  try {
    const stored = await chrome.storage.session.get(['memToastSnooze']);
    if (stored?.memToastSnooze) {
      memToastSnooze.tabsAbove = stored.memToastSnooze.tabsAbove | 0;
      memToastSnooze.heapAbove = stored.memToastSnooze.heapAbove | 0;
    }
  } catch (err) {
    console.debug('[gstack sidebar] mem-toast snooze load failed:', err && err.message);
  }
}

async function saveSnoozeState() {
  if (!chrome?.storage?.session) return;
  try {
    await chrome.storage.session.set({ memToastSnooze: { ...memToastSnooze } });
  } catch (err) {
    console.debug('[gstack sidebar] mem-toast snooze save failed:', err && err.message);
  }
}

function dismissMemToast() {
  const toast = document.getElementById('mem-toast');
  if (toast) toast.style.display = 'none';
}

/**
 * Sort key for "RAM-heavy" tabs. JS heap × 4 is a rough proxy for total
 * tab footprint (renderers tend to spend ~4× their JS heap on native +
 * Skia + cache); when a tab is heavy via WebGL/video the JS heap is
 * small but listeners/nodes spike. Take the max.
 */
function tabRamScore(tab) {
  const heap = tab?.jsHeapUsed || 0;
  const nodes = tab?.nodes || 0;
  const listeners = tab?.listeners || 0;
  // ~1 KB per DOM node + ~200 bytes per listener as a back-of-envelope
  // native-memory estimate. Keeps the sort meaningful when JS heap is small.
  const nativeEstimate = nodes * 1024 + listeners * 200;
  return Math.max(heap, nativeEstimate);
}

function showMemToast(title, body, tabsForClose) {
  const toast = document.getElementById('mem-toast');
  const titleEl = document.getElementById('mem-toast-title');
  const bodyEl = document.getElementById('mem-toast-body');
  const closeBtn = document.getElementById('mem-toast-close-selected');
  if (!toast || !titleEl || !bodyEl || !closeBtn) return;

  titleEl.textContent = title;
  bodyEl.innerHTML = '';

  for (const t of tabsForClose) {
    const row = document.createElement('div');
    row.className = 'mem-toast-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `mem-toast-tab-${t.id}`;
    cb.value = String(t.id);
    cb.checked = true; // default-selected so a fast user just hits Close
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    const urlShort = (t.url || '').length > 50 ? t.url.slice(0, 47) + '...' : (t.url || '(no url)');
    label.textContent = `tab #${t.id} — ${urlShort}`;
    const size = document.createElement('span');
    size.className = 'mem-toast-size';
    size.textContent = fmtBytesShort(tabRamScore(t));
    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(size);
    bodyEl.appendChild(row);
  }

  toast.style.display = '';

  closeBtn.onclick = async () => {
    const ids = tabsForClose
      .filter((t) => document.getElementById(`mem-toast-tab-${t.id}`)?.checked)
      .map((t) => t.id);
    dismissMemToast();
    for (const id of ids) {
      try {
        await fetch(`${serverUrl}/command`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ command: 'closetab', args: [String(id)] }),
        });
      } catch (err) {
        console.warn('[gstack sidebar] mem-toast closetab failed:', id, err && err.message);
      }
    }
  };
}

/**
 * Driven by every successful /memory poll. Decides whether to surface
 * the toast and which payload to show.
 */
function evaluateMemToast(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tabs)) return;
  const tabs = snapshot.tabs;

  // Trigger 1: any single tab over 4 GB JS heap. Catches the WebGL/video
  // case before the tab count threshold ever fires.
  const heavyTab = tabs.find((t) => (t.jsHeapUsed || 0) > HEAVY_TAB_HEAP_BYTES);
  if (heavyTab && (heavyTab.jsHeapUsed || 0) > memToastSnooze.heapAbove) {
    showMemToast(
      `Heavy tab: ${fmtBytesShort(heavyTab.jsHeapUsed)} JS heap`,
      '',
      [heavyTab],
    );
    return;
  }

  // Trigger 2: tab count crossed the hard guardrail (200) and isn't snoozed.
  if (tabs.length >= 200 && tabs.length > memToastSnooze.tabsAbove) {
    const top5 = [...tabs].sort((a, b) => tabRamScore(b) - tabRamScore(a)).slice(0, 5);
    showMemToast(
      `${tabs.length} tabs open — close some?`,
      '',
      top5,
    );
    return;
  }

  // No trigger: keep toast hidden.
}

function setupMemToastWiring() {
  const close = document.getElementById('mem-toast-close');
  if (close) close.addEventListener('click', dismissMemToast);
  const snooze = document.getElementById('mem-toast-snooze');
  if (snooze) {
    snooze.addEventListener('click', async () => {
      // Snooze logic: bump the thresholds above the current snapshot so the
      // toast won't re-fire until the user has accumulated MORE tabs or one
      // tab has grown ANOTHER 2 GB beyond what we just warned about. Stored
      // in chrome.storage.session so a sidebar reload doesn't lose the
      // snooze (but a Chrome restart does).
      try {
        const resp = await fetch(`${serverUrl}/memory`, {
          headers: { 'Authorization': `Bearer ${serverToken}` },
          signal: AbortSignal.timeout(MEM_POLL_TIMEOUT_MS),
          credentials: 'include',
        });
        if (resp.ok) {
          const snap = await resp.json();
          const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];
          memToastSnooze.tabsAbove = tabs.length + TOAST_SNOOZE_TAB_BUMP;
          const maxHeap = tabs.reduce((m, t) => Math.max(m, t.jsHeapUsed || 0), 0);
          memToastSnooze.heapAbove = maxHeap + TOAST_SNOOZE_HEAP_BUMP;
          await saveSnoozeState();
        }
      } catch (err) {
        console.debug('[gstack sidebar] mem-toast snooze fetch failed:', err && err.message);
      }
      dismissMemToast();
    });
  }
  void loadSnoozeState();
}

// Wire the toast on DOM ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupMemToastWiring);
} else {
  setupMemToastWiring();
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

inspectorSendBtn.addEventListener('click', async () => {
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

  // Inject into the running claude PTY so the user can ask claude to act
  // on the inspector data. Replaces the old `sidebar-command` route which
  // spawned a one-shot claude -p (sidebar-agent.ts is gone).
  //
  // Pre-scan via /pty-inject-scan before injection (D6, closes #1370).
  // gstackScanForPTYInject is async; gstackInjectToTerminal stays sync.
  const verdict = await window.gstackScanForPTYInject?.(message + '\n', 'inspector-send');
  if (verdict?.verdict === 'BLOCK') {
    console.warn('[gstack sidebar] Inspector send BLOCKED by /pty-inject-scan:', verdict.reasons);
    return;
  }
  if (verdict?.verdict === 'WARN') {
    const confirmed = window.confirm(
      `Inspector send flagged as suspicious (${(verdict.reasons || []).join(', ')}). Inject anyway?`,
    );
    if (!confirmed) return;
  }
  const ok = window.gstackInjectToTerminal?.(message + '\n');
  if (!ok) {
    console.warn('[gstack sidebar] Inspector send needs an active Terminal session.');
  }
});

// ─── Quick Action Helpers (toolbar buttons) ──────────────────────

/**
 * "Cleanup" injects a prompt into the running claude PTY. claude takes the
 * prompt, snapshots the page, hides ads/banners/popups, leaves article
 * content. The user watches it happen in the Terminal pane.
 *
 * Replaced the old chat-queue path (sidebar-agent.ts spawning a one-shot
 * claude -p) — we have a live REPL now, so route through that instead.
 */
async function runCleanup(...buttons) {
  buttons.forEach(b => b?.classList.add('loading'));
  const cleanupPrompt = [
    'Clean up the active browser page for reading. Run:',
    '$B cleanup --all',
    'then $B snapshot -i, identify any remaining ads, cookie/consent banners,',
    'newsletter popups, login walls, video autoplay, sidebar widgets, share',
    'buttons, floating chat widgets, and hide each via $B eval. Keep the site',
    'header/masthead, headline, article body, images, byline, and date. Also',
    'unlock scrolling if the page is scroll-locked.',
  ].join('\n');
  // Pre-scan via /pty-inject-scan before injection (D6, closes #1370).
  // The cleanup prompt is a STATIC template (no page-derived content), so
  // it will always PASS, but we still route it through the scan path so
  // the invariant test in test/extension-pty-inject-invariant.test.ts
  // confirms every call site goes through gstackScanForPTYInject first.
  const verdict = await window.gstackScanForPTYInject?.(cleanupPrompt + '\n', 'cleanup-button');
  if (verdict?.verdict === 'BLOCK') {
    console.warn('[gstack sidebar] Cleanup BLOCKED by /pty-inject-scan:', verdict.reasons);
    setTimeout(() => buttons.forEach(b => b?.classList.remove('loading')), 200);
    return;
  }
  if (verdict?.verdict === 'WARN') {
    const confirmed = window.confirm(
      `Cleanup flagged as suspicious (${(verdict.reasons || []).join(', ')}). Inject anyway?`,
    );
    if (!confirmed) {
      setTimeout(() => buttons.forEach(b => b?.classList.remove('loading')), 200);
      return;
    }
  }
  const sent = window.gstackInjectToTerminal?.(cleanupPrompt + '\n');
  if (!sent) {
    console.warn('[gstack sidebar] Cleanup needs an active Terminal session.');
  }
  setTimeout(() => buttons.forEach(b => b?.classList.remove('loading')), 1200);
}

async function runScreenshot(...buttons) {
  if (!serverUrl || !serverToken) return;
  buttons.forEach(b => b?.classList.add('loading'));
  try {
    const resp = await fetch(`${serverUrl}/command`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'screenshot', args: [] }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.warn('[gstack sidebar] Screenshot failed:', text);
    } else {
      console.log('[gstack sidebar] Screenshot:', text);
    }
  } catch (err) {
    console.error('[gstack sidebar] Screenshot error:', err.message);
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

async function connectInspectorSSE() {
  if (!serverUrl || !serverToken) return;
  if (inspectorSSE) { inspectorSSE.close(); inspectorSSE = null; }

  // Same session-cookie pattern as connectSSE. ?token= is gone (see N1
  // in the v1.6.0.0 security wave plan).
  await ensureSseSessionCookie();
  const url = `${serverUrl}/inspector/events?_=${Date.now()}`;

  try {
    inspectorSSE = new EventSource(url, { withCredentials: true });

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
  // Expose for sidepanel-terminal.js (PTY surface). The terminal pane needs
  // the bootstrap token to POST /pty-session and the port to derive the WS
  // URL. We never expose the PTY token — it lives in an HttpOnly cookie.
  if (url) {
    try { window.gstackServerPort = parseInt(new URL(url).port, 10); } catch {}
    window.gstackAuthToken = token || null;
  } else {
    window.gstackServerPort = null;
    window.gstackAuthToken = null;
  }
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
    startMemPolling();
  } else {
    document.getElementById('footer-dot').className = 'dot';
    document.getElementById('footer-port').textContent = '';
    const memEl = document.getElementById('footer-mem');
    if (memEl) {
      memEl.textContent = '';
      memEl.classList.remove('warn', 'bad');
    }
    stopMemPolling();
    setActionButtonsEnabled(false);
    if (wasConnected) startReconnect();
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
  // The status line lives inside the Terminal bootstrap card now —
  // sidepanel-terminal.js owns it. We only update the debug pre block,
  // and trust the terminal pane to surface the human-readable status.
  const dbg = document.getElementById('loading-debug');
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
          `token: yes (from /health)\nStarting SSE + activity feed...`
        );
        updateConnection(`http://127.0.0.1:${port}`, data.token);
        // The SEC shield used to drive off /health.security via the chat
        // path's classifier; with the chat path ripped, the indicator is
        // not driven yet. Leaving the shield element hidden by default.
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
  // browserTabState: full snapshot of all open tabs + the active one,
  // pushed by background.js on chrome.tabs events. We forward it as a
  // custom event so sidepanel-terminal.js can relay to terminal-agent.ts.
  // Result: claude's <stateDir>/tabs.json + active-tab.json stay live.
  if (msg.type === 'browserTabState') {
    document.dispatchEvent(new CustomEvent('gstack:tab-state', {
      detail: { active: msg.active, tabs: msg.tabs, reason: msg.reason },
    }));
  }
});

// ─── v1.44 pagehide: explicit PTY dispose on sidebar close ──────────
//
// Codex T3 of the eng review: WS close codes alone can't distinguish
// "intentional close" (sidebar closed, browser quit, extension reload)
// from "transient blip" (wifi hiccup) reliably — Chrome routes the
// former through code 1001 (going-away) and the latter through 1006
// (abnormal), but neither is a load-bearing contract across browsers
// and extension lifecycles.
//
// pagehide fires reliably for tab close, panel close, extension reload,
// and navigation-away. We use it to fire-and-forget a /pty-dispose POST
// so the server can synchronously dispose the PtySession instead of
// waiting for the 60s detach window (Commit 3) to time out. Zombie
// claude processes lingering for 60s on every browser quit was the
// codex-flagged failure mode.
//
// sendBeacon is the only fetch primitive that survives a closing page —
// it doesn't accept custom headers, which is why the server's
// /pty-dispose route accepts the auth token in the BODY (see
// server-pty-lease-routes.test.ts test 4).
window.addEventListener('pagehide', () => {
  const sessionId = window.gstackPtySession;
  const authToken = window.gstackAuthToken;
  const port = window.gstackServerPort;
  if (!sessionId || !authToken || !port) return;
  try {
    const blob = new Blob([JSON.stringify({ sessionId, authToken })], {
      type: 'application/json',
    });
    navigator.sendBeacon(`http://127.0.0.1:${port}/pty-dispose`, blob);
  } catch {
    // Best-effort — the 60s detach timer will catch any session we miss.
  }
});
