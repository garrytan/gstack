/* Fleet Console — vanilla JS, no dependencies */

const SSE_URL = '/api/events';
const FLEET_URL = '/api/fleet';
const QUEUE_URL = '/api/queue';
const PIPELINE_URL = '/api/pipeline';
const STUCK_URL = '/api/stuck';
const RECONNECT_DELAY_MS = 3000;
const FLEET_STALE_MS = 30000;
const DOMAIN_FILTER_KEY = 'console-pipeline-domain-filter';

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

let es = null;
let sseConnected = false;
let currentEs = null;
let attentionCount = 0;
let approvalCount = 0;
let pipelineData = [];
let pipelineDomainFilter = localStorage.getItem(DOMAIN_FILTER_KEY) || 'all';
let pipelineBootstrapped = false;

/* T15: stuck agent state */
const stuckAgents = new Map(); // agent → { agent, signal, detail, since }
const agentLastTaskId = new Map(); // agent → last known task_id (for AC6 auto-dismiss)

/* ── Tab state ── */

let currentTab = 'fleet';
let fleetLastEventTs = 0;
let fleetStalenessHandle = null;
const fleetElapsedTimers = new Map();

const tabBtns = {
  fleet: $('tab-fleet'),
  queue: $('tab-queue'),
  pipeline: $('tab-pipeline'),
  cost: $('tab-cost'),
};

const sectionFleet = $('section-fleet');
const sectionAttention = $('section-attention');
const sectionApproval = $('section-approval');
const sectionPipeline = $('section-pipeline');
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

  /* Pipeline panel */
  if (name === 'pipeline') {
    sectionPipeline.removeAttribute('hidden');
    if (!pipelineBootstrapped) {
      pipelineBootstrapped = true;
      fetchPipeline();
    }
  } else {
    sectionPipeline.setAttribute('hidden', '');
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

async function fetchFleet(baseTs) {
  try {
    const res = await fetch(FLEET_URL);
    if (!res.ok) return;
    const agents = await res.json();
    renderFleet(agents, baseTs);
  } catch (_) {}
}

function renderFleet(agents, baseTs) {
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
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(a.name)}&size=32`;
    const taskCell = a.task
      ? `<span class="fleet-task-id">${esc(a.task)}</span>`
      : `<span class="fleet-no-task">no tasks</span>`;
    const toolCell = a.lastTool ? esc(a.lastTool) : '—';
    const summaryText = a.lastSummary ? a.lastSummary.slice(0, 60) : '';
    const summaryCell = summaryText ? esc(summaryText) : '';
    const avatarSrc = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(a.name)}&size=32`;

    tr.innerHTML = `
      <td class="fleet-agent" data-label="Agent">
        <img class="fleet-avatar" src="${avatarUrl}" width="32" height="32" alt="" loading="lazy">
        <div class="fleet-avatar-fallback" hidden aria-hidden="true"></div>
        ${esc(a.name)}
      </td>
      <td data-label="State">${stateToHtml(a.state)}</td>
      <td data-label="Task">${taskCell}</td>
      <td class="fleet-elapsed" data-label="Elapsed">—</td>
      <td class="fleet-tool" data-label="Last tool">${toolCell}</td>
      <td class="fleet-summary" data-label="Activity">${summaryCell}</td>
    `;

    tbody.appendChild(tr);

    /* AC1: fallback to grey circle if Dicebear fails to load */
    const avatarImg = tr.querySelector('.fleet-avatar');
    if (avatarImg) {
      avatarImg.onerror = function() {
        this.style.display = 'none';
        const fallback = this.nextElementSibling;
        if (fallback) fallback.removeAttribute('hidden');
      };
    }

    if (!a.ended && a.sessionStart) {
      /* AC2: base timestamp from fleet-update ev.ts; update every 10 s */
      const base = baseTs != null ? baseTs : Date.parse(a.sessionStart);
      const elapsedEl = tr.querySelector('.fleet-elapsed');
      updateElapsed(elapsedEl, base);
      const timer = setInterval(() => updateElapsed(elapsedEl, base), 10000);
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

/* ── Stuck alert (T15) ── */

async function fetchStuck() {
  try {
    const res = await fetch(STUCK_URL);
    if (!res.ok) return;
    const data = await res.json();
    for (const s of (data.stuck || [])) {
      stuckAgents.set(s.agent, s);
    }
    renderStuckSection();
  } catch (_) {}
}

function renderStuckSection() {
  const section = $('stuck-alert-slot');
  const container = $('stuck-cards');
  if (!section || !container) return;

  if (stuckAgents.size === 0) {
    section.setAttribute('hidden', '');
    container.innerHTML = '';
    return;
  }

  /* AC3: show only the card for the agent with the earliest (oldest) since time */
  let earliest = null;
  for (const s of stuckAgents.values()) {
    if (!earliest || new Date(s.since) < new Date(earliest.since)) earliest = s;
  }

  const extra = stuckAgents.size - 1;
  container.innerHTML = '';
  container.appendChild(buildStuckCard(earliest, extra));
  section.removeAttribute('hidden');
}

function buildStuckCard(s, extraCount) {
  const cardId = `stuck-${s.agent}`;
  const article = document.createElement('article');
  article.className = 'stuck-alert-card card-new';
  article.id = cardId;
  article.setAttribute('aria-label', `Stuck agent: ${s.agent}`);

  const extraBadge = extraCount > 0
    ? `<span class="stuck-more-badge" aria-label="${extraCount} more stuck agents">+${extraCount} more</span>`
    : '';
  const sinceStr = s.since ? relativeTime(s.since) : '—';

  article.innerHTML = `
    <div class="stuck-card-header">
      <span class="stuck-signal-dot" aria-hidden="true"></span>
      <span class="stuck-agent-name">${esc(s.agent)}</span>
      ${extraBadge}
      <span class="stuck-card-spacer"></span>
      <span class="stuck-since">${esc(sinceStr)}</span>
    </div>
    <div class="stuck-detail">${esc(s.detail)}</div>
    <div class="stuck-card-actions">
      <button class="btn-force-restart" data-agent="${esc(s.agent)}">Force restart</button>
    </div>
  `;

  article.querySelector('.btn-force-restart').addEventListener('click', () => {
    showRestartModal(s.agent);
  });

  return article;
}

function dismissStuckAgent(agent) {
  if (!stuckAgents.has(agent)) return;
  stuckAgents.delete(agent);
  const card = document.getElementById(`stuck-${agent}`);
  if (card) {
    exitCard(card, renderStuckSection);
  } else {
    renderStuckSection();
  }
}

/* ── Force restart modal (AC4–AC8) ── */

function showRestartModal(agent) {
  const modal = $('restart-modal');
  if (!modal) return;
  const taskId = agentLastTaskId.get(agent) || 'current task unknown';
  modal.querySelector('.restart-modal-heading').textContent = `Restart ${agent}?`;
  modal.querySelector('.restart-modal-body').textContent =
    `Current task ${taskId} will be marked failed. This cannot be undone.`;
  const restartBtn = modal.querySelector('.btn-modal-restart');
  restartBtn.textContent = `Restart ${agent}`;
  restartBtn.dataset.agent = agent;
  restartBtn.disabled = false;
  modal.showModal();
}

function initRestartModal() {
  const modal = $('restart-modal');
  if (!modal) return;

  /* AC7: close on backdrop click */
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  modal.querySelector('.btn-modal-cancel').addEventListener('click', () => modal.close());

  modal.querySelector('.btn-modal-restart').addEventListener('click', () => {
    const btn = modal.querySelector('.btn-modal-restart');
    const agent = btn.dataset.agent;
    btn.textContent = 'Restarting…';
    btn.disabled = true;
    fetch(`/api/fleet/restart?agent=${encodeURIComponent(agent)}`, { method: 'POST' })
      .catch(() => {})
      .finally(() => modal.close());
  });
}

/* ── Pipeline ── */

const PIPELINE_STATUS_GROUPS = [
  { label: 'In progress', statuses: ['in_progress', 'testing', 'documenting'] },
  { label: 'Blocked',     statuses: ['needs_human', 'awaiting_info'] },
  { label: 'Open',        statuses: ['open'] },
  { label: 'Done',        statuses: ['done'] },
];

async function fetchPipeline() {
  try {
    const res = await fetch(PIPELINE_URL);
    if (!res.ok) return;
    const data = await res.json();
    pipelineData = data.tasks || [];
    renderPipeline();
  } catch (_) {}
}

function renderPipeline() {
  const groupsEl = $('pipeline-groups');
  if (!groupsEl) return;

  const filtered = pipelineDomainFilter === 'all'
    ? pipelineData
    : pipelineData.filter((t) => t.domain === pipelineDomainFilter || t.origin_domain === pipelineDomainFilter);

  groupsEl.innerHTML = '';
  for (const group of PIPELINE_STATUS_GROUPS) {
    const tasks = filtered.filter((t) => group.statuses.includes(t.status));
    const count = tasks.length;
    const collapsed = count === 0;

    const section = document.createElement('section');
    section.className = 'pipeline-group';
    section.dataset.group = group.label;

    const header = document.createElement('div');
    header.className = 'pipeline-group-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', String(!collapsed));
    header.innerHTML = `
      <span class="pipeline-group-name">${esc(group.label)}</span>
      <span class="pipeline-group-count${count === 0 ? ' count-zero' : ''}">${count}</span>
    `;

    const body = document.createElement('div');
    body.className = 'pipeline-group-body';
    if (collapsed) body.setAttribute('hidden', '');

    for (const task of tasks) {
      body.appendChild(buildTaskCard(task));
    }

    header.addEventListener('click', () => {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', String(!expanded));
      if (expanded) body.setAttribute('hidden', ''); else body.removeAttribute('hidden');
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
    });

    section.appendChild(header);
    section.appendChild(body);
    groupsEl.appendChild(section);
  }
}

function buildTaskCard(task) {
  const failureCount = parseInt(task.failure_count || '0', 10);
  const agentName = task.claimed_by && task.claimed_by !== '-' ? task.claimed_by : null;
  const domain = task.domain || task.origin_domain || '?';
  const timeSince = relativeTime(task.updated_at);

  const article = document.createElement('article');
  article.className = 'pipeline-task-card';
  article.dataset.taskId = task.id;
  article.setAttribute('tabindex', '0');
  article.setAttribute('role', 'button');
  article.setAttribute('aria-label', `Task ${task.id}`);

  const failureBadge = failureCount >= 1
    ? `<span class="pipeline-failure-badge" aria-label="${failureCount} failures">${failureCount} ✕</span>`
    : '';

  article.innerHTML = `
    <div class="pipeline-card-header">
      <span class="pipeline-task-id">${esc(task.id)}</span>
      <span class="pipeline-domain-pill">${esc(domain)}</span>
      ${failureBadge}
      <span class="pipeline-card-spacer"></span>
      <span class="pipeline-card-agent${agentName ? '' : ' pipeline-card-agent-none'}">${agentName ? esc(agentName) : '—'}</span>
    </div>
    <div class="pipeline-card-desc">${esc(task.description || task.id)}</div>
    <div class="pipeline-card-time">${esc(timeSince)}</div>
  `;

  article.addEventListener('click', () => openSpecPanel(task.id));
  article.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSpecPanel(task.id); }
  });

  return article;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function openSpecPanel(taskId) {
  const panel = $('spec-panel');
  const content = $('spec-content');
  const title = $('spec-panel-title');
  if (!panel || !content) return;

  title.textContent = taskId;
  content.textContent = 'Loading…';
  panel.removeAttribute('hidden');

  try {
    const res = await fetch(`/api/spec/${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      content.textContent = `Error: ${res.status} — spec not found`;
      return;
    }
    const data = await res.json();
    content.textContent = data.markdown || '(empty)';
  } catch (_) {
    content.textContent = 'Failed to load spec.';
  }
}

/* Domain filter chips — initialize from localStorage, handle clicks */
(function initDomainChips() {
  for (const chip of document.querySelectorAll('.domain-chip')) {
    if (chip.dataset.domain === pipelineDomainFilter) chip.classList.add('domain-chip-active');
    chip.addEventListener('click', () => {
      pipelineDomainFilter = chip.dataset.domain;
      localStorage.setItem(DOMAIN_FILTER_KEY, pipelineDomainFilter);
      for (const c of document.querySelectorAll('.domain-chip')) {
        c.classList.toggle('domain-chip-active', c.dataset.domain === pipelineDomainFilter);
      }
      renderPipeline();
    });
  }
})();

/* Spec panel close button */
(function initSpecClose() {
  const btn = $('spec-close');
  const panel = $('spec-panel');
  if (btn && panel) {
    btn.addEventListener('click', () => panel.setAttribute('hidden', ''));
  }
})();

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
  }, 300);
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
  const riskLabel = risk.toUpperCase();

  article.innerHTML = `
    <div class="card-meta">
      <span class="card-agent">${esc(ev.agent)}</span>
      <span class="card-sep">—</span>
      <span class="card-task-id">${esc(ev.action_type || 'ACTION')}</span>
      <div class="card-meta-spacer"></div>
      <span class="approval-risk-label ${riskClass}">${riskLabel}</span>
    </div>
    <code class="approval-command">${esc(ev.command || '')}</code>
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
  const unblockSectionId = `unblock-section-${ev.id}`;
  const draftPanelId = `draft-panel-${ev.id}`;
  const failureCount = ev.failure_count || 0;

  const article = document.createElement('article');
  article.className = 'attention-card card-new';
  article.setAttribute('aria-label', `Blocked task: ${ev.task_id}`);
  article.id = cardId;

  const failureBadgeHtml = failureCount >= 2
    ? `<span class="failure-badge" aria-label="Blocked ${failureCount} times">⚠ blocked ${failureCount} times</span>`
    : '';

  const acsHtml = (ev.acs || []).map(ac =>
    `<div class="card-ac-row"><span class="ac-id">${esc(ac.id)}</span><span>${esc(ac.text)}</span></div>`
  ).join('');

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

  /* AI draft toggle hidden initially — revealed after Unblock is clicked */
  const draftToggleHtml = draftText ? `
    <button class="ai-draft-toggle" hidden aria-expanded="false" aria-controls="${draftPanelId}">
      AI Draft
      <span class="ai-draft-label">AI</span>
    </button>
  ` : '';

  /* AC5: cap mailbox note at 160 chars */
  const rawNote = ev.agent_note || '';
  const noteText = rawNote.length > 160 ? rawNote.slice(0, 160) + '…' : rawNote;

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
    ${noteText ? `<div class="card-agent-note" role="note">${esc(noteText)}</div>` : ''}
    ${acsHtml ? `<div class="card-acs"><div class="card-acs-label">Acceptance criteria context</div>${acsHtml}</div>` : ''}
    ${draftPanelHtml}
    <div class="card-textarea-wrapper" id="textarea-wrapper-${ev.id}" hidden>
      <label class="card-textarea-label" for="${textareaId}">Your decision</label>
      <textarea
        class="card-textarea"
        id="${textareaId}"
        placeholder="Type your decision for the agent..."
        aria-required="true"
      ></textarea>
    </div>
    <div class="card-actions">
      <button class="btn-unblock" aria-label="Unblock task ${esc(ev.task_id)} for agent ${esc(ev.agent)}">Unblock</button>
      ${draftToggleHtml}
      <button class="btn-send" hidden aria-label="Send decision back to ${esc(ev.agent)} for task ${esc(ev.task_id)}">Send reply</button>
    </div>
  `;

  if (draftText) {
    const toggle = article.querySelector('.ai-draft-toggle');
    const panel = article.querySelector(`#${draftPanelId}`);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      panel.style.display = expanded ? 'none' : '';
    });
    article.querySelector('.ai-draft-use-btn').addEventListener('click', () => {
      const textarea = article.querySelector(`#${textareaId}`);
      textarea.value = draftText;
      textarea.focus();
    });
  }

  const unblockBtn = article.querySelector('.btn-unblock');
  const sendBtn = article.querySelector('.btn-send');
  const textareaWrapper = article.querySelector(`#textarea-wrapper-${ev.id}`);

  /* AC5: Unblock click reveals textarea + Send reply */
  unblockBtn.addEventListener('click', () => {
    unblockBtn.setAttribute('hidden', '');
    textareaWrapper.removeAttribute('hidden');
    sendBtn.removeAttribute('hidden');
    if (draftText) article.querySelector('.ai-draft-toggle').removeAttribute('hidden');
    article.querySelector(`#${textareaId}`).focus();
  });

  /* AC6: Send reply — POST with agentName + taskId; shows Sending… while in-flight */
  sendBtn.addEventListener('click', () => {
    const textarea = article.querySelector(`#${textareaId}`);
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    sendBtn.textContent = 'Sending…';
    sendBtn.disabled = true;
    fetch('/api/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unblock', text, agentName: ev.agent, taskId: ev.task_id }),
    }).catch(() => {}).finally(() => {
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
  es = new EventSource(SSE_URL);

  es.addEventListener('open', () => {
    sseConnected = true;
    sseDot.classList.remove('disconnected');
    sseLabel.textContent = 'live';
    reconnectBanner.style.display = 'none';
    fetchQueue();
    fetchPipeline();
    fetchStuck();
    pipelineBootstrapped = true;
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

  es.addEventListener('fleet-update', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'fleet-update') {
      fleetLastEventTs = Date.now();
      if (currentTab === 'fleet') fetchFleet(ev.ts);

      /* AC6: auto-dismiss stuck card if agent moved to a new task or was stopped */
      if (ev.agent && stuckAgents.has(ev.agent)) {
        const prev = agentLastTaskId.get(ev.agent);
        if (ev.task !== undefined) agentLastTaskId.set(ev.agent, ev.task);
        const movedOn = ev.task != null && ev.task !== prev;
        const stopped = ev.action === 'stop' || ev.action === 'restart';
        if (movedOn || stopped) dismissStuckAgent(ev.agent);
      } else if (ev.agent && ev.task !== undefined) {
        agentLastTaskId.set(ev.agent, ev.task);
      }
    }
  });

  /* T15 AC2: handle stuck SSE event — insert card above Queue attention section */
  es.addEventListener('stuck', (e) => {
    const ev = JSON.parse(e.data);
    if (!ev.agent) return;
    stuckAgents.set(ev.agent, { agent: ev.agent, signal: ev.signal, detail: ev.detail, since: ev.since || new Date().toISOString() });
    renderStuckSection();
  });

  es.addEventListener('pipeline-update', () => {
    if (currentTab === 'pipeline') fetchPipeline();
  });

  es.addEventListener('error', () => {
    sseConnected = false;
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
fetchStuck();
initRestartModal();

/* AC3: poll SSE readyState every 2 s to cycle dot green/amber/red */
setInterval(() => {
  if (!es) return;
  if (es.readyState === EventSource.OPEN) {
    sseDot.classList.remove('disconnected', 'connecting');
  } else if (es.readyState === EventSource.CONNECTING) {
    sseDot.classList.add('connecting');
    sseDot.classList.remove('disconnected');
  } else {
    sseDot.classList.add('disconnected');
    sseDot.classList.remove('connecting');
  }
}, 2000);

/* Test injection helpers — used by qa-smoke.sh via browse js */
window.__injectApproval = function(ev) {
  approvalCards.prepend(buildApprovalCard(ev));
  approvalCount++;
  syncState();
};
window.__injectAttention = function(ev) {
  attentionCards.prepend(buildAttentionCard(ev));
  attentionCount++;
  syncState();
};
window.__injectStuck = function(ev) {
  stuckAgents.set(ev.agent, {
    agent: ev.agent,
    signal: ev.signal || 'silent',
    detail: ev.detail || 'test signal',
    since: ev.since || new Date().toISOString(),
  });
  renderStuckSection();
};
window.__injectFleetUpdate = function(ev) {
  const payload = { type: 'fleet-update', ...ev };
  if (payload.agent && stuckAgents.has(payload.agent)) {
    const prev = agentLastTaskId.get(payload.agent);
    if (payload.task !== undefined) agentLastTaskId.set(payload.agent, payload.task);
    const movedOn = payload.task != null && payload.task !== prev;
    const stopped = payload.action === 'stop' || payload.action === 'restart';
    if (movedOn || stopped) dismissStuckAgent(payload.agent);
  } else if (payload.agent && payload.task !== undefined) {
    agentLastTaskId.set(payload.agent, payload.task);
  }
};
