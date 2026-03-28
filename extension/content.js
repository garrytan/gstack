/**
 * gstack browse — content script
 *
 * Receives ref data from background worker via chrome.runtime.onMessage.
 * Renders @ref overlay badges on the page (CDP mode only — positions are accurate).
 * In headless mode, shows a floating ref panel instead (positions unknown).
 */

let overlayContainer = null;
let statusPill = null;
let pillFadeTimer = null;
let refCount = 0;

// ─── Connection Status Pill ──────────────────────────────────

function showStatusPill(connected, refs) {
  refCount = refs || 0;

  if (!statusPill) {
    statusPill = document.createElement('div');
    statusPill.id = 'gstack-status-pill';
    statusPill.style.cursor = 'pointer';
    statusPill.addEventListener('click', () => {
      // Ask background to open the side panel
      chrome.runtime.sendMessage({ type: 'openSidePanel' });
    });
    document.body.appendChild(statusPill);
  }

  if (!connected) {
    statusPill.style.display = 'none';
    return;
  }

  const refText = refCount > 0 ? ` · ${refCount} refs` : '';
  statusPill.innerHTML = `<span class="gstack-pill-dot"></span> gstack${refText}`;
  statusPill.style.display = 'flex';
  statusPill.style.opacity = '1';

  // Fade to subtle after 3s
  clearTimeout(pillFadeTimer);
  pillFadeTimer = setTimeout(() => {
    statusPill.style.opacity = '0.3';
  }, 3000);
}

function hideStatusPill() {
  if (statusPill) {
    statusPill.style.display = 'none';
  }
}

function ensureContainer() {
  if (overlayContainer) return overlayContainer;
  overlayContainer = document.createElement('div');
  overlayContainer.id = 'gstack-ref-overlays';
  overlayContainer.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  document.body.appendChild(overlayContainer);
  return overlayContainer;
}

function clearOverlays() {
  if (overlayContainer) {
    overlayContainer.innerHTML = '';
  }
}

function renderRefBadges(refs) {
  clearOverlays();
  if (!refs || refs.length === 0) return;

  const container = ensureContainer();

  for (const ref of refs) {
    // Try to find the element using accessible name/role for positioning
    // In CDP mode, we could use bounding boxes from the server
    // For now, use a floating panel approach
    const badge = document.createElement('div');
    badge.className = 'gstack-ref-badge';
    badge.textContent = ref.ref;
    badge.title = `${ref.role}: "${ref.name}"`;
    container.appendChild(badge);
  }
}

function renderRefPanel(refs) {
  clearOverlays();
  if (!refs || refs.length === 0) return;

  const container = ensureContainer();

  const panel = document.createElement('div');
  panel.className = 'gstack-ref-panel';

  const header = document.createElement('div');
  header.className = 'gstack-ref-panel-header';
  header.textContent = `gstack refs (${refs.length})`;
  header.style.cssText = 'pointer-events: auto; cursor: move;';
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'gstack-ref-panel-list';
  for (const ref of refs.slice(0, 30)) { // Show max 30 in panel
    const row = document.createElement('div');
    row.className = 'gstack-ref-panel-row';
    const idSpan = document.createElement('span');
    idSpan.className = 'gstack-ref-panel-id';
    idSpan.textContent = ref.ref;
    const roleSpan = document.createElement('span');
    roleSpan.className = 'gstack-ref-panel-role';
    roleSpan.textContent = ref.role;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'gstack-ref-panel-name';
    nameSpan.textContent = '"' + ref.name + '"';
    row.append(idSpan, document.createTextNode(' '), roleSpan, document.createTextNode(' '), nameSpan);
    list.appendChild(row);
  }
  if (refs.length > 30) {
    const more = document.createElement('div');
    more.className = 'gstack-ref-panel-more';
    more.textContent = `+${refs.length - 30} more`;
    list.appendChild(more);
  }
  panel.appendChild(list);
  container.appendChild(panel);
}

// Listen for messages from background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'refs' && msg.data) {
    const refs = msg.data.refs || [];
    const mode = msg.data.mode;

    if (refs.length === 0) {
      clearOverlays();
      showStatusPill(true, 0);
      return;
    }

    // CDP mode: could use bounding boxes (future)
    // For now: floating panel for all modes
    renderRefPanel(refs);
    showStatusPill(true, refs.length);
  }

  if (msg.type === 'clearRefs') {
    clearOverlays();
    showStatusPill(true, 0);
  }

  if (msg.type === 'connected') {
    showStatusPill(true, refCount);
  }

  if (msg.type === 'disconnected') {
    hideStatusPill();
    clearOverlays();
  }
});
