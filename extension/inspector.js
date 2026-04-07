/**
 * gstack browse — CSS Inspector content script
 *
 * Dynamically injected via chrome.scripting.executeScript.
 * Provides element picker, selector generation, basic computed style capture,
 * and page alteration handlers for agent-pushed CSS changes.
 */

(() => {
  // Guard against double-injection
  if (window.__gstackInspectorActive) return;
  window.__gstackInspectorActive = true;

  // ─── State ──────────────────────────────────────────────────────
  let pickerActive = false;
  let highlightEl = null;
  let tooltipEl = null;
  let lastPickTime = 0;
  const PICK_DEBOUNCE_MS = 200;

  // Track original inline styles for resetAll
  const originalStyles = new Map(); // element -> Map<property, value>
  const injectedStyleIds = new Set();

  // ─── Highlight Overlay ──────────────────────────────────────────

  function createHighlight() {
    if (highlightEl) return;

    highlightEl = document.createElement('div');
    highlightEl.id = 'gstack-inspector-highlight';
    highlightEl.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: rgba(59, 130, 246, 0.15);
      border: 2px solid rgba(59, 130, 246, 0.6);
      border-radius: 2px;
      transition: top 50ms, left 50ms, width 50ms, height 50ms;
    `;
    document.documentElement.appendChild(highlightEl);

    tooltipEl = document.createElement('div');
    tooltipEl.id = 'gstack-inspector-tooltip';
    tooltipEl.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: #27272A;
      color: #e0e0e0;
      font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: none;
    `;
    document.documentElement.appendChild(tooltipEl);
  }

  function removeHighlight() {
    if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  }

  function updateHighlight(el) {
    if (!highlightEl || !tooltipEl) return;
    const rect = el.getBoundingClientRect();

    highlightEl.style.top = rect.top + 'px';
    highlightEl.style.left = rect.left + 'px';
    highlightEl.style.width = rect.width + 'px';
    highlightEl.style.height = rect.height + 'px';
    highlightEl.style.display = 'block';

    // Build tooltip text: <tag> .classes WxH
    const tag = el.tagName.toLowerCase();
    const classes = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '';
    const dims = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    tooltipEl.textContent = `<${tag}> ${classes} ${dims}`.trim();

    // Position tooltip above element, or below if no room
    const tooltipHeight = 24;
    const gap = 6;
    let tooltipTop = rect.top - tooltipHeight - gap;
    if (tooltipTop < 4) tooltipTop = rect.bottom + gap;
    let tooltipLeft = rect.left;
    if (tooltipLeft < 4) tooltipLeft = 4;

    tooltipEl.style.top = tooltipTop + 'px';
    tooltipEl.style.left = tooltipLeft + 'px';
    tooltipEl.style.display = 'block';
  }

  // ─── Selector Generation ────────────────────────────────────────

  function buildSelector(el) {
    // If element has an id, use it directly
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (isUnique(sel)) return sel;
    }

    // Build path from element up to nearest ancestor with id or body
    const parts = [];
    let current = el;

    while (current && current !== document.body && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();

      // If current has an id, use it and stop
      if (current.id) {
        part = '#' + CSS.escape(current.id);
        parts.unshift(part);
        break;
      }

      // Add classes
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
          part += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }

      // Add nth-child if needed to disambiguate
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          s => s.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          part += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    // If we didn't reach an id, prepend body
    if (parts.length > 0 && !parts[0].startsWith('#')) {
      // Don't prepend body, just use the path as-is
    }

    const selector = parts.join(' > ');

    // Verify uniqueness
    if (isUnique(selector)) return selector;

    // Fallback: add nth-child at each level until unique
    return selector;
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  // ─── Basic Mode Data Capture ────────────────────────────────────

  const KEY_PROPERTIES = [
    'display', 'position', 'top', 'right', 'bottom', 'left',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'text-align', 'text-decoration', 'text-transform',
    'overflow', 'overflow-x', 'overflow-y',
    'opacity', 'z-index',
    'flex-direction', 'justify-content', 'align-items', 'flex-wrap', 'gap',
    'grid-template-columns', 'grid-template-rows',
    'box-shadow', 'border-radius',
    'transition', 'transform',
  ];

  function captureBasicData(el) {
    const computed = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Capture key computed properties
    const computedStyles = {};
    for (const prop of KEY_PROPERTIES) {
      computedStyles[prop] = computed.getPropertyValue(prop);
    }

    // Box model from computed
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

  // ─── Picker Event Handlers ──────────────────────────────────────

  function onMouseMove(e) {
    if (!pickerActive) return;
    // Ignore our own overlay elements
    const target = e.target;
    if (target === highlightEl || target === tooltipEl) return;
    if (target.id === 'gstack-inspector-highlight' || target.id === 'gstack-inspector-tooltip') return;

    updateHighlight(target);
  }

  function onClick(e) {
    if (!pickerActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Debounce
    const now = Date.now();
    if (now - lastPickTime < PICK_DEBOUNCE_MS) return;
    lastPickTime = now;

    const target = e.target;
    if (target === highlightEl || target === tooltipEl) return;
    if (target.id === 'gstack-inspector-highlight' || target.id === 'gstack-inspector-tooltip') return;

    const selector = buildSelector(target);
    const basicData = captureBasicData(target);

    // Frame detection
    const frameInfo = {};
    if (window !== window.top) {
      try {
        frameInfo.frameSrc = window.location.href;
        frameInfo.frameName = window.name || null;
      } catch { /* cross-origin frame */ }
    }

    chrome.runtime.sendMessage({
      type: 'elementPicked',
      selector,
      tagName: target.tagName.toLowerCase(),
      classes: target.className && typeof target.className === 'string'
        ? target.className.trim().split(/\s+/).filter(c => c.length > 0)
        : [],
      id: target.id || null,
      dimensions: {
        width: Math.round(target.getBoundingClientRect().width),
        height: Math.round(target.getBoundingClientRect().height),
      },
      basicData,
      ...frameInfo,
    });

    // Keep highlight on the picked element
  }

  function onKeyDown(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopPicker();
      chrome.runtime.sendMessage({ type: 'pickerCancelled' });
    }
  }

  // ─── Picker Start/Stop ──────────────────────────────────────────

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    createHighlight();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    removeHighlight();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ─── Page Alteration Handlers ───────────────────────────────────

  function findElement(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function applyStyle(selector, property, value) {
    // Validate property name: alphanumeric + hyphens only
    if (!/^[a-zA-Z-]+$/.test(property)) return { error: 'Invalid property name' };
    // Validate CSS value: block exfiltration vectors (url(), expression(), @import, javascript:, data:)
    if (/url\s*\(|expression\s*\(|@import|javascript:|data:/i.test(value)) {
      return { error: 'CSS value contains blocked pattern' };
    }

    const el = findElement(selector);
    if (!el) return { error: 'Element not found' };

    // Track original value for resetAll
    if (!originalStyles.has(el)) {
      originalStyles.set(el, new Map());
    }
    const origMap = originalStyles.get(el);
    if (!origMap.has(property)) {
      origMap.set(property, el.style.getPropertyValue(property));
    }

    el.style.setProperty(property, value, 'important');
    return { ok: true };
  }

  function toggleClass(selector, className, action) {
    if (!/^[a-zA-Z0-9_-]+$/.test(className)) {
      return { error: 'Invalid class name' };
    }
    const el = findElement(selector);
    if (!el) return { error: 'Element not found' };

    if (action === 'add') {
      el.classList.add(className);
    } else if (action === 'remove') {
      el.classList.remove(className);
    } else {
      el.classList.toggle(className);
    }
    return { ok: true };
  }

  function injectCSS(id, css) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return { error: 'Invalid CSS injection id' };
    }
    if (/url\s*\(|expression\s*\(|@import|javascript:|data:/i.test(css)) {
      return { error: 'CSS contains blocked pattern (url, expression, @import)' };
    }
    const styleId = `gstack-inject-${id}`;
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    injectedStyleIds.add(styleId);
    return { ok: true };
  }

  function resetAll() {
    // Restore original inline styles
    for (const [el, propMap] of originalStyles) {
      for (const [prop, origVal] of propMap) {
        if (origVal) {
          el.style.setProperty(prop, origVal);
        } else {
          el.style.removeProperty(prop);
        }
      }
    }
    originalStyles.clear();

    // Remove injected style elements
    for (const id of injectedStyleIds) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    injectedStyleIds.clear();

    return { ok: true };
  }

  // ─── Message Listener ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'startPicker') {
      startPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'stopPicker') {
      stopPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'applyStyle') {
      const result = applyStyle(msg.selector, msg.property, msg.value);
      sendResponse(result);
      return;
    }
    if (msg.type === 'toggleClass') {
      const result = toggleClass(msg.selector, msg.className, msg.action);
      sendResponse(result);
      return;
    }
    if (msg.type === 'injectCSS') {
      const result = injectCSS(msg.id, msg.css);
      sendResponse(result);
      return;
    }
    if (msg.type === 'resetAll') {
      const result = resetAll();
      sendResponse(result);
      return;
    }
  });
})();
