/**
 * Zalando size chart parser — content script
 *
 * Injected only on Zalando product pages (see manifest.json).
 * Uses only data-testid attributes — Zalando's CSS class names are
 * build-time hashed and change on every deploy; they are not usable
 * as stable selectors.
 *
 * Two-step approach:
 *   1. Look for a size table already rendered in the DOM
 *      (accordion content or an already-open size guide modal).
 *   2. If not found, click the "Size guide" link to open the modal,
 *      wait for it to render, then parse.
 *
 * Listens for the chrome message { type: 'parseZalandoSizeChart' }
 * and replies with a structured result object.
 */
'use strict';

// ─── Table extraction ────────────────────────────────────────────

function parseTable(tableEl) {
  const headers = [];
  const rows = [];

  // Headers: prefer <thead>, fall back to the first <tr>
  const theadCells = tableEl.querySelectorAll('thead tr th, thead tr td');
  if (theadCells.length > 0) {
    theadCells.forEach(cell => headers.push(cell.textContent.trim()));
  } else {
    const firstRow = tableEl.querySelector('tr');
    if (firstRow) {
      firstRow.querySelectorAll('th, td').forEach(cell => headers.push(cell.textContent.trim()));
    }
  }

  // Body rows: prefer <tbody>, skip first row if we used it as header
  const hasTbody = !!tableEl.querySelector('tbody');
  const bodyRows = hasTbody
    ? tableEl.querySelectorAll('tbody tr')
    : Array.from(tableEl.querySelectorAll('tr')).slice(headers.length > 0 ? 1 : 0);

  for (const row of bodyRows) {
    const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
    if (cells.length > 0 && cells.some(c => c !== '')) {
      rows.push(cells);
    }
  }

  return { headers, rows };
}

// ─── Available sizes from the size picker ────────────────────────

function parseAvailableSizes() {
  // Primary: stable Zalando testid
  let opts = document.querySelectorAll('[data-testid="pdp-size-picker"] [role="option"]');

  // Fallback: any testid containing "size-picker"
  if (opts.length === 0) {
    opts = document.querySelectorAll('[data-testid*="size-picker"] [role="option"]');
  }

  if (opts.length === 0) return null;

  return Array.from(opts)
    .map(opt => ({
      label: opt.textContent.trim(),
      available: opt.getAttribute('aria-disabled') !== 'true' && !opt.disabled,
    }))
    .filter(s => s.label.length > 0);
}

// ─── Find the size chart table in the current DOM ────────────────

function findSizeTable() {
  // 1. Any open dialog/modal (size guide opens one)
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.offsetParent) continue; // skip hidden
    const table = dialog.querySelector('table');
    if (table) return { table, source: 'modal' };
  }

  // 2. Size & Fit accordion — testid is stable across Zalando deploys
  const sizeAccordion = document.querySelector('[data-testid="pdp-accordion-size_fit"]');
  if (sizeAccordion) {
    const table = sizeAccordion.querySelector('table');
    if (table) return { table, source: 'accordion-size_fit' };
  }

  // 3. Any other pdp accordion that contains a table
  for (const section of document.querySelectorAll('[data-testid^="pdp-accordion-"]')) {
    const table = section.querySelector('table');
    if (table) return { table, source: section.dataset.testid };
  }

  // 4. Broad fallback: a table whose text content looks like a size chart
  for (const table of document.querySelectorAll('table')) {
    if (/\b(eu|uk|us|xs|s\b|\bm\b|\bl\b|xl|xxl|chest|waist|hip|inseam|size)\b/i.test(table.textContent)) {
      return { table, source: 'heuristic-fallback' };
    }
  }

  return null;
}

// ─── Click the size guide link to open its modal ─────────────────

function clickSizeGuideLink() {
  const candidates = [
    '[data-testid="pdp-size-guide-link"]',
    '[data-testid="pdp-size-guide"]',
    '[data-testid="size-guide-btn"]',
    '[data-testid="size-guide-link"]',
    'a[aria-label*="size guide" i]',
    'button[aria-label*="size guide" i]',
    'a[aria-label*="Größentabelle" i]',  // German
    'a[aria-label*="guide des tailles" i]', // French
  ];

  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }
  }

  // Last resort: any visible <a> or <button> whose text is "size guide" variant
  for (const el of document.querySelectorAll('a, button')) {
    if (/\b(size\s*guide|Größentabelle|guide des tailles|tabella delle taglie)\b/i.test(el.textContent)) {
      el.click();
      return true;
    }
  }

  return false;
}

// ─── Main parser ─────────────────────────────────────────────────

async function parseZalandoSizeChart() {
  const result = {
    url: location.href,
    hostname: location.hostname,
    productTitle: document.title.replace(/\s*[|–\-].*$/, '').trim(),
    timestamp: new Date().toISOString(),
    availableSizes: parseAvailableSizes(),
    sizeChart: null,
    source: null,
    error: null,
  };

  // Try to find a table already in the DOM
  let found = findSizeTable();

  // If not in DOM yet, try opening the size guide modal
  if (!found) {
    const clicked = clickSizeGuideLink();
    if (clicked) {
      // Wait for modal animation + React render (Zalando modals take ~400-600ms)
      await new Promise(resolve => setTimeout(resolve, 700));
      found = findSizeTable();
    }
  }

  if (found) {
    const parsed = parseTable(found.table);
    if (parsed.rows.length > 0 || parsed.headers.length > 0) {
      result.sizeChart = parsed;
      result.source = found.source;
    } else {
      result.error = 'Table found but contained no parseable rows';
    }
  } else {
    result.error = [
      'No size chart table found.',
      'This may not be a product page, or the product has no size guide.',
      `Available sizes: ${result.availableSizes ? result.availableSizes.map(s => s.label).join(', ') : 'none found'}`,
    ].join(' ');
  }

  return result;
}

// ─── Chrome message listener ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'parseZalandoSizeChart') return;
  parseZalandoSizeChart().then(sendResponse).catch(err => {
    sendResponse({ error: err.message, url: location.href });
  });
  return true; // keep the message channel open for the async response
});
