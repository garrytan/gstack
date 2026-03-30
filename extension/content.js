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

// ─── Basic Inspector Picker (CSP fallback) ──────────────────
// When inspector.js can't be injected (CSP, chrome:// pages), content.js
// provides a basic element picker using getComputedStyle + CSSOM.

let basicPickerActive = false;
let basicPickerOverlay = null;
let basicPickerLastEl = null;
let basicPickerSavedOutline = '';

const BASIC_KEY_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'line-height',
  'text-align', 'text-decoration',
  'overflow', 'overflow-x', 'overflow-y',
  'opacity', 'z-index',
  'flex-direction', 'justify-content', 'align-items', 'flex-wrap', 'gap',
  'grid-template-columns', 'grid-template-rows',
  'box-shadow', 'border-radius', 'transform',
];

function captureBasicData(el) {
  const computed = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  const computedStyles = {};
  for (const prop of BASIC_KEY_PROPERTIES) {
    computedStyles[prop] = computed.getPropertyValue(prop);
  }

  const boxModel = {
    content: { width: rect.width, height: rect.height },
    padding: {
      top: parseFloat(computed.paddingTop) || 0,
      right: parseFloat(computed.paddingRight) || 0,
      bottom: parseFloat(computed.paddingBottom) || 0,
      left: parseFloat(computed.paddingLeft) || 0,
    },
    border: {
      top: parseFloat(computed.borderTopWidth) || 0,
      right: parseFloat(computed.borderRightWidth) || 0,
      bottom: parseFloat(computed.borderBottomWidth) || 0,
      left: parseFloat(computed.borderLeftWidth) || 0,
    },
    margin: {
      top: parseFloat(computed.marginTop) || 0,
      right: parseFloat(computed.marginRight) || 0,
      bottom: parseFloat(computed.marginBottom) || 0,
      left: parseFloat(computed.marginLeft) || 0,
    },
  };

  // Matched CSS rules via CSSOM (same-origin only)
  const matchedRules = [];
  try {
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.type !== CSSRule.STYLE_RULE) continue;
          try {
            if (el.matches(rule.selectorText)) {
              const properties = [];
              for (let i = 0; i < rule.style.length; i++) {
                const prop = rule.style[i];
                properties.push({
                  name: prop,
                  value: rule.style.getPropertyValue(prop),
                  priority: rule.style.getPropertyPriority(prop),
                });
              }
              matchedRules.push({
                selector: rule.selectorText,
                properties,
                source: sheet.href || 'inline',
              });
            }
          } catch { /* skip rules that can't be matched */ }
        }
      } catch { /* cross-origin sheet — silently skip */ }
    }
  } catch { /* CSSOM not available */ }

  return { computedStyles, boxModel, matchedRules };
}

function basicBuildSelector(el) {
  if (el.id) {
    const sel = '#' + CSS.escape(el.id);
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
  }
  const parts = [];
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift('#' + CSS.escape(current.id));
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0);
      if (classes.length > 0) part += '.' + classes.map(c => CSS.escape(c)).join('.');
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(s => s.tagName === current.tagName);
      if (siblings.length > 1) {
        part += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function basicPickerHighlight(el) {
  // Restore previous element
  if (basicPickerLastEl && basicPickerLastEl !== el) {
    basicPickerLastEl.style.outline = basicPickerSavedOutline;
  }
  if (el) {
    basicPickerSavedOutline = el.style.outline;
    el.style.outline = '2px solid rgba(59, 130, 246, 0.6)';
    basicPickerLastEl = el;
  }
}

function basicPickerCleanup() {
  if (basicPickerLastEl) {
    basicPickerLastEl.style.outline = basicPickerSavedOutline;
    basicPickerLastEl = null;
    basicPickerSavedOutline = '';
  }
  basicPickerActive = false;
  document.removeEventListener('mousemove', onBasicMouseMove, true);
  document.removeEventListener('click', onBasicClick, true);
  document.removeEventListener('keydown', onBasicKeydown, true);
}

function onBasicMouseMove(e) {
  if (!basicPickerActive) return;
  e.preventDefault();
  e.stopPropagation();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (el && el !== basicPickerLastEl) {
    basicPickerHighlight(el);
  }
}

function onBasicClick(e) {
  if (!basicPickerActive) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target;

  const basicData = captureBasicData(el);
  const selector = basicBuildSelector(el);
  const tagName = el.tagName.toLowerCase();
  const id = el.id || null;
  const classes = el.className && typeof el.className === 'string'
    ? el.className.trim().split(/\s+/).filter(c => c.length > 0)
    : [];

  basicPickerCleanup();

  chrome.runtime.sendMessage({
    type: 'inspectResult',
    data: {
      selector,
      tagName,
      id,
      classes,
      basicData,
      mode: 'basic',
      boxModel: basicData.boxModel,
      computedStyles: basicData.computedStyles,
      matchedRules: basicData.matchedRules,
    },
  });
}

function onBasicKeydown(e) {
  if (e.key === 'Escape') {
    basicPickerCleanup();
    chrome.runtime.sendMessage({ type: 'pickerCancelled' });
  }
}

function startBasicPicker() {
  basicPickerActive = true;
  document.addEventListener('mousemove', onBasicMouseMove, true);
  document.addEventListener('click', onBasicClick, true);
  document.addEventListener('keydown', onBasicKeydown, true);
}

// Listen for messages from background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'startBasicPicker') {
    startBasicPicker();
    return;
  }
  if (msg.type === 'stopBasicPicker') {
    basicPickerCleanup();
    return;
  }
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
