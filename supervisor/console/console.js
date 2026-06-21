/* Fleet Console — vanilla JS, no dependencies */

const SSE_URL = '/api/events';
const FLEET_URL = '/api/fleet';
const QUEUE_URL = '/api/queue';
const RECONNECT_DELAY_MS = 3000;
const FLEET_STALE_MS = 30000;

const $ = (id) => document.getElementById(id);

const attentionCards = $('attention-cards');
const approvalCards = $('approval-cards');
const attentionEmpty = $('attention-empty');
const approvalEmpty = $('approval-empty');
const allClearBanner = $('all-clear-banner');
const reconnectBanner = $('reconnect-banner');
const sseDot = $('sse-dot');
const sseLabel = $('sse-label');
const attentionBadge = $('attention-badge');
const approvalBadge = $('approval-badge');

let sseConnected = false;
let attentionCount = 0;
let approvalCount = 0;

/* ── Tab state ── */

let currentTab = 'fleet';
let fleetLastEventTs = 0;
let fleetStalenessHandle = null;
const fleetElapsedTimers = new Map();

const tabBtns = {
  fleet: $('tab-fleet'),
  queue: $('tab-queue'),
  cost: $('tab-cost'),
};

const sectionFleet = $('section-fleet');
const sectionAttention = $('section-attention');
const sectionApproval = $('section-approval');
const sectionCost = $('section-cost');

function switchTab(name) {
  currentTab = name;

  for (const [key, btn] of Object.entries(tabBtns)) {
    btn.setAttribute('aria-selected', String(key === name));
  }

  /* Fleet panel */
  if (name === 'fleet') {
    sectionFleet.removeAttribute('hidden');
  } else {
    sectionFleet.setAttribute('hidden', '');
  }

  /* Queue sections — AC9: use hidden attribute, not display:none */
  if (name === 'queue') {
    sectionAttention.removeAttribute('hidden');
    sectionApproval.removeAttribute('hidden');
  } else {
    sectionAttention.setAttribute('hidden', '');
    sectionApproval.setAttribute('hidden', '');
  }

  /* Cost panel */
  if (name === 'cost') {
    sectionCost.removeAttribute('hidden');
  } else {
    sectionCost.setAttribute('hidden', '');
  }

  if (name === 'fleet') {
    fetchFleet();
    startFleetStalenessTimer();
  } else {
    stopFleetStalenessTimer();
  }

  if (name === 'queue') {
    fetchQueue();
  }

  syncState();
}

/* ── Fleet data ── */

async function fetchFleet() {
  try {
    const res = await fetch(FLEET_URL);
    if (!res.ok) return;
    const agents = await res.json();
    renderFleet(agents);
  } catch (_) {}
}

function renderFleet(agents) {
  const loading = $('fleet-loading');
  const table = $('fleet-table');
  const empty = $('fleet-empty');
  const tbody = $('fleet-tbody');

  fleetElapsedTimers.forEach((timer) => clearInterval(timer));
  fleetElapsedTimers.clear();

  if (!agents || agents.length === 0) {
    loading.style.display = 'none';
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }

  loading.style.display = 'none';
  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = '';
  for (const a of agents) {
    const tr = document.createElement('tr');
    const taskCell = a.task
      ? `<span class="fleet-task-id">${esc(a.task)}</span>`
      : `<span class="fleet-no-task">no tasks</span>`;
    const toolCell = a.lastTool ? esc(a.lastTool) : '—';
    const summaryText = a.lastSummary ? a.lastSummary.slice(0, 60) : '';
    const summaryCell = summaryText ? esc(summaryText) : '';

    tr.innerHTML = `
      <td class="fleet-agent">${esc(a.name)}</td>
      <td>${stateToHtml(a.state)}</td>
      <td>${taskCell}</td>
      <td class="fleet-elapsed">—</td>
      <td class="fleet-tool">${toolCell}</td>
      <td class="fleet-summary">${summaryCell}</td>
    `;

    tbody.appendChild(tr);

    if (!a.ended && a.sessionStart) {
      const elapsedEl = tr.querySelector('.fleet-elapsed');
      updateElapsed(elapsedEl, a.sessionStart);
      const timer = setInterval(() => updateElapsed(elapsedEl, a.sessionStart), 1000);
      fleetElapsedTimers.set(a.name, timer);
    }
  }
}

function updateElapsed(el, sessionStart) {
  const secs = Math.floor((Date.now() - sessionStart) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  el.textContent = h > 0
    ? `${h}h ${m}m`
    : `${m}m ${String(s).padStart(2, '0')}s`;
}

function stateToHtml(state) {
  const map = {
    working: 'state-working',
    checking: 'state-checking',
    idle: 'state-idle',
    stopped: 'state-stopped',
    rate_limited: 'state-rate-limited',
  };
  const cls = map[state] || 'state-stopped';
  const label = state === 'rate_limited' ? 'RATE LIMITED' : (state || 'unknown').toUpperCase();
  return `<span class="state-badge ${cls}">${esc(label)}</span>`;
}

/* ── Fleet staleness polling (AC6) ── */

function startFleetStalenessTimer() {
  stopFleetStalenessTimer();
  fleetLastEventTs = Date.now();
  fleetStalenessHandle = setInterval(() => {
    if (currentTab === 'fleet' && Date.now() - fleetLastEventTs >= FLEET_STALE_MS) {
      fleetLastEventTs = Date.now();
      fetchFleet();
    }
  }, 1000);
}

function stopFleetStalenessTimer() {
  if (fleetStalenessHandle) {
    clearInterval(fleetStalenessHandle);
    fleetStalenessHandle = null;
  }
}

/* ── Queue bootstrap ── */

async function fetchQueue() {
  try {
    const res = await fetch(QUEUE_URL);
    if (!res.ok) return;
    const data = await res.json();

    for (const item of (data.approvals || [])) {
      if (!item.id) continue;
      const cardId = `approval-${item.id}`;
      if (document.getElementById(cardId)) continue;
      const card = buildApprovalCard(item);
      approvalCards.prepend(card);
      approvalCount++;
    }

    for (const task of (data.attention || [])) {
      if (!task.id) continue;
      const cardId = `attention-${task.id}`;
      if (document.getElementById(cardId)) continue;
      const ev = {
        id: task.id,
        task_id: task.id,
        agent: task.claimed_by || task.domain || 'unknown',
        title: task.description || task.id,
        failure_count: parseInt(task.failure_count || '0', 10) || 0,
      };
      const card = buildAttentionCard(ev);
      attentionCards.prepend(card);
      attentionCount++;
    }

    syncState();
  } catch (_) {}
}

/* ── State sync ── */

function syncState() {
  const bothEmpty = attentionCount === 0 && approvalCount === 0;

  attentionEmpty.style.display = attentionCount === 0 ? '' : 'none';
  approvalEmpty.style.display = approvalCount === 0 ? '' : 'none';
  /* all-clear banner only shown on Queue tab when both queues are empty */
  allClearBanner.style.display = (bothEmpty && currentTab === 'queue') ? '' : 'none';

  if (attentionCount > 0) {
    attentionBadge.style.display = '';
    attentionBadge.textContent = `${attentionCount} blocked`;
  } else {
    attentionBadge.style.display = 'none';
  }

  if (approvalCount > 0) {
    approvalBadge.style.display = '';
    approvalBadge.textContent = `${approvalCount} pending`;
  } else {
    approvalBadge.style.display = 'none';
  }

  const total = attentionCount + approvalCount;
  document.title = total > 0 ? `(${total}) Fleet Console` : 'Fleet Console';
}

/* ── Card exit helper ── */

function exitCard(card, onRemove) {
  card.classList.add('card-exit');
  setTimeout(() => {
    card.remove();
    if (onRemove) onRemove();
  }, 150);
}

/* ── Approval card ── */

function buildApprovalCard(ev) {
  const risk = ev.risk || 'medium';
  const cardId = `approval-${ev.id}`;

  const article = document.createElement('article');
  article.className = `approval-card ${risk} card-new`;
  article.setAttribute('aria-label', `Approval request: ${ev.command || 'action'} from ${ev.agent}`);
  article.id = cardId;

  const filePillsHtml = ev.files && ev.files.length
    ? `<div class="file-pills" aria-label="Affected files">${ev.files.map(f => `<span class="file-pill">${esc(f)}</span>`).join('')}</div>`
    : `<div class="no-files-note">No files affected</div>`;

  const riskClass = risk === 'high' ? 'risk-high' : 'risk-medium';
  const riskLabel = risk.toUpperCase() + ' RISK';

  article.innerHTML = `
    <div class="card-meta">
      <span class="card-agent">${esc(ev.agent)}</span>
      <span class="card-sep">—</span>
      <span class="card-task-id">${esc(ev.action_type || 'ACTION')}</span>
      <div class="card-meta-spacer"></div>
      <span class="approval-risk-label ${riskClass}">${riskLabel}</span>
    </div>
    <div class="approval-command" role="code">${esc(ev.command || '')}</div>
    <div class="approval-description">${esc(ev.description || '')}</div>
    ${filePillsHtml}
    <div class="approval-footer">
      <span class="approval-timer" aria-live="polite" data-started="${Date.now()}"></span>
      <button class="btn-reject" aria-label="Reject ${esc(ev.action_type || 'action')} from ${esc(ev.agent)}">Reject</button>
      <button class="btn-approve" aria-label="Approve ${esc(ev.action_type || 'action')} from ${esc(ev.agent)}">
        <span class="spinner" aria-hidden="true"></span>
        Approve →
      </button>
    </div>
  `;

  const approveBtn = article.querySelector('.btn-approve');
  const rejectBtn = article.querySelector('.btn-reject');

  /* AC4a: spinner + disabled on click; AC10: <button> handles Enter natively */
  approveBtn.addEventListener('click', () => {
    approveBtn.classList.add('loading');
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    sendDecision(ev.id, 'approve').finally(() => {
      /* AC4b: card-exit + DOM removal after 150ms */
      exitCard(article, () => {
        approvalCount--;
        syncState();
      });
    });
  });

  rejectBtn.addEventListener('click', () => {
    approveBtn.classList.add('loading');
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    sendDecision(ev.id, 'reject').finally(() => {
      exitCard(article, () => {
        approvalCount--;
        syncState();
      });
    });
  });

  startTimer(article.querySelector('.approval-timer'), ev.timeout_at);

  return article;
}

/* ── Attention card ── */

function buildAttentionCard(ev) {
  const cardId = `attention-${ev.id}`;
  const textareaId = `decision-${ev.id}`;
  const draftPanelId = `draft-panel-${ev.id}`;
  const failureCount = ev.failure_count || 0;

  const article = document.createElement('article');
  article.className = 'attention-card card-new';
  article.setAttribute('aria-label', `Blocked task: ${ev.task_id}`);
  article.id = cardId;

  /* AC5: amber failure badge when failure_count >= 2 */
  const failureBadgeHtml = failureCount >= 2
    ? `<span class="failure-badge" aria-label="Blocked ${failureCount} times">⚠ blocked ${failureCount} times</span>`
    : '';

  const acsHtml = (ev.acs || []).map(ac =>
    `<div class="card-ac-row"><span class="ac-id">${esc(ac.id)}</span><span>${esc(ac.text)}</span></div>`
  ).join('');

  /* AC6: AI draft panel (collapsed by default, toggle reveals it) */
  const draftText = ev.ai_draft || '';
  const draftPanelHtml = draftText ? `
    <div class="ai-draft-panel" id="${draftPanelId}" aria-label="AI draft decision" style="display:none">
      <div class="ai-draft-panel-header">
        <span class="ai-draft-panel-title">AI draft</span>
        <span class="ai-draft-disclaimer">AI draft — review before sending</span>
      </div>
      <div class="ai-draft-text">${esc(draftText)}</div>
      <button class="ai-draft-use-btn" data-target="${textareaId}">Use this draft ↑</button>
    </div>
  ` : '';

  const draftToggleHtml = draftText ? `
    <button class="ai-draft-toggle" aria-expanded="false" aria-controls="${draftPanelId}">
      AI Draft
      <span class="ai-draft-label">AI</span>
    </button>
  ` : '';

  article.innerHTML = `
    <div class="card-meta">
      <span class="card-agent">${esc(ev.agent)}</span>
      <span class="card-sep">—</span>
      <span class="card-task-id">${esc(ev.task_id)}</span>
      <div class="card-meta-spacer"></div>
      ${failureBadgeHtml}
      <span class="card-timer" aria-live="polite" data-started="${Date.now()}"></span>
    </div>
    <div class="card-task-title">${esc(ev.title || ev.task_id)}</div>
    ${ev.agent_note ? `<div class="card-agent-note" role="note">${esc(ev.agent_note)}</div>` : ''}
    ${acsHtml ? `<div class="card-acs"><div class="card-acs-label">Acceptance criteria context</div>${acsHtml}</div>` : ''}
    ${draftPanelHtml}
    <div class="card-textarea-wrapper">
      <label class="card-textarea-label" for="${textareaId}">Your decision</label>
      <textarea
        class="card-textarea"
        id="${textareaId}"
        placeholder="Type your decision for the agent..."
        aria-required="true"
      ></textarea>
    </div>
    <div class="card-actions">
      ${draftToggleHtml}
      <button class="btn-send" aria-label="Send decision back to ${esc(ev.agent)} for task ${esc(ev.task_id)}">Send back to agent →</button>
    </div>
  `;

  /* AC6: AI draft toggle */
  if (draftText) {
    const toggle = article.querySelector('.ai-draft-toggle');
    const panel = article.querySelector(`#${draftPanelId}`);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      panel.style.display = expanded ? 'none' : '';
    });

    /* "Use this draft ↑" copies draft text to textarea */
    article.querySelector('.ai-draft-use-btn').addEventListener('click', () => {
      const textarea = article.querySelector(`#${textareaId}`);
      textarea.value = draftText;
      textarea.focus();
    });
  }

  /* Send decision */
  const sendBtn = article.querySelector('.btn-send');
  sendBtn.addEventListener('click', () => {
    const textarea = article.querySelector(`#${textareaId}`);
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    sendBtn.disabled = true;
    sendDecision(ev.id, 'unblock', text).finally(() => {
      exitCard(article, () => {
        attentionCount--;
        syncState();
      });
    });
  });

  startTimer(article.querySelector('.card-timer'), null);

  return article;
}

/* ── Timer ── */

function startTimer(el, timeoutAt) {
  if (!el) return;
  const started = Number(el.dataset.started) || Date.now();
  function tick() {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    el.textContent = `${m}m ${String(s).padStart(2, '0')}s`;
  }
  tick();
  setInterval(tick, 1000);
}

/* ── Network ── */

function sendDecision(id, action, text) {
  return fetch('/api/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, text }),
  }).catch(() => {});
}

/* ── SSE ── */

function connect() {
  const es = new EventSource(SSE_URL);

  es.addEventListener('open', () => {
    sseConnected = true;
    sseDot.classList.remove('disconnected');
    sseLabel.textContent = 'live';
    reconnectBanner.style.display = 'none';
    fetchQueue();
  });

  es.addEventListener('approval', (e) => {
    const ev = JSON.parse(e.data);
    const card = buildApprovalCard(ev);
    approvalCards.prepend(card);
    approvalCount++;
    syncState();
  });

  es.addEventListener('attention', (e) => {
    const ev = JSON.parse(e.data);
    const card = buildAttentionCard(ev);
    attentionCards.prepend(card);
    attentionCount++;
    syncState();
  });

  es.addEventListener('resolve', (e) => {
    const ev = JSON.parse(e.data);
    const card = document.getElementById(`approval-${ev.id}`) || document.getElementById(`attention-${ev.id}`);
    if (!card) return;
    const isApproval = card.id.startsWith('approval-');
    exitCard(card, () => {
      if (isApproval) approvalCount--; else attentionCount--;
      syncState();
    });
  });

  /* AC5: re-fetch fleet table on fleet-update event (within 500ms) */
  es.addEventListener('fleet-update', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'fleet-update') {
      fleetLastEventTs = Date.now();
      if (currentTab === 'fleet') fetchFleet();
    }
  });

  /* AC9: SSE reconnect banner on error */
  es.addEventListener('error', () => {
    sseConnected = false;
    sseDot.classList.add('disconnected');
    sseLabel.textContent = 'offline';
    reconnectBanner.style.display = '';
    es.close();
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}

/* ── HTML escape ── */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Boot ── */

for (const [name, btn] of Object.entries(tabBtns)) {
  btn.addEventListener('click', () => switchTab(name));
}

switchTab('fleet');
connect();
