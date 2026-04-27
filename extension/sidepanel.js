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

  // Inject into the running claude PTY so the user can ask claude to act
  // on the inspector data. Replaces the old `sidebar-command` route which
  // spawned a one-shot claude -p (sidebar-agent.ts is gone).
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
  } else {
    document.getElementById('footer-dot').className = 'dot';
    document.getElementById('footer-port').textContent = '';
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
