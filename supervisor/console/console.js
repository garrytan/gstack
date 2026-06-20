/* Fleet Console — vanilla JS, no dependencies */

const SSE_URL = '/api/events';
const RECONNECT_DELAY_MS = 3000;

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

/* ── State sync ── */

function syncState() {
  const bothEmpty = attentionCount === 0 && approvalCount === 0;

  attentionEmpty.style.display = attentionCount === 0 ? '' : 'none';
  approvalEmpty.style.display = approvalCount === 0 ? '' : 'none';
  allClearBanner.style.display = bothEmpty ? '' : 'none';

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

  /* AC8: dynamic document title */
  const total = attentionCount + approvalCount;
  document.title = total > 0 ? `(${total}) Fleet Console` : 'Fleet Console — All clear';
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
    /* AC9: hide reconnect banner once SSE reconnects */
    reconnectBanner.style.display = 'none';
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

syncState();
connect();
