/**
 * Cookie picker UI — self-contained HTML page
 *
 * Dark theme, two-panel layout, vanilla HTML/CSS/JS.
 * Left: source browser domains with search + import buttons.
 * Right: imported domains with trash buttons.
 * No cookie values exposed anywhere.
 */

export function getCookiePickerHTML(serverPort: number, authToken?: string): string {
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cookie Import — gstack browse</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    height: 100vh;
    overflow: hidden;
  }

  /* ─── Header ──────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid #222;
    background: #0f0f0f;
  }
  .header h1 {
    font-size: 16px;
    font-weight: 600;
    color: #fff;
  }
  .header .port {
    font-size: 12px;
    color: #666;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  /* ─── Layout ──────────────────────────── */
  .container {
    display: flex;
    height: calc(100vh - 53px);
  }
  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel-left {
    border-right: 1px solid #222;
  }
  .panel-header {
    padding: 16px 20px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
  }

  /* ─── Browser Pills ───────────────────── */
  .browser-pills {
    display: flex;
    gap: 8px;
    padding: 0 20px 12px;
    flex-wrap: wrap;
  }
  .pill {
    padding: 6px 14px;
    border-radius: 20px;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #aaa;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pill:hover { border-color: #555; color: #ddd; }
  .pill.active {
    border-color: #4ade80;
    background: #0a2a14;
    color: #4ade80;
  }
  .pill .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #4ade80;
  }

  /* ─── Profile Pills ─────────────────── */
  .profile-pills {
    display: flex;
    gap: 6px;
    padding: 0 20px 12px;
    flex-wrap: wrap;
  }
  .profile-pill {
    padding: 4px 10px;
    border-radius: 14px;
    border: 1px solid #2a2a2a;
    background: #141414;
    color: #888;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .profile-pill:hover { border-color: #444; color: #bbb; }
  .profile-pill.active {
    border-color: #60a5fa;
    background: #0a1a2a;
    color: #60a5fa;
  }

  /* ─── Search ──────────────────────────── */
  .search-wrap {
    padding: 0 20px 12px;
  }
  .search-input {
    width: 100%;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #141414;
    color: #e0e0e0;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  .search-input::placeholder { color: #555; }
  .search-input:focus { border-color: #555; }

  /* ─── Domain List ─────────────────────── */
  .domain-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px;
  }
  .domain-list::-webkit-scrollbar { width: 6px; }
  .domain-list::-webkit-scrollbar-track { background: transparent; }
  .domain-list::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

  .domain-row {
    display: flex;
    align-items: center;
    padding: 8px 10px;
    border-radius: 6px;
    transition: background 0.1s;
    gap: 8px;
  }
  .domain-row:hover { background: #1a1a1a; }
  .domain-name {
    flex: 1;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 13px;
    color: #ccc;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .domain-count {
    font-size: 12px;
    color: #666;
    font-family: 'SF Mono', 'Fira Code', monospace;
    min-width: 28px;
    text-align: right;
  }
  .btn-add, .btn-trash {
    width: 28px; height: 28px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #888;
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .btn-add:hover { border-color: #4ade80; color: #4ade80; background: #0a2a14; }
  .btn-trash:hover { border-color: #f87171; color: #f87171; background: #2a0a0a; }
  .btn-add:disabled, .btn-trash:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    pointer-events: none;
  }
  .btn-add.imported {
    border-color: #333;
    color: #4ade80;
    background: transparent;
    cursor: default;
    font-size: 14px;
  }

  /* ─── Footer ──────────────────────────── */
  .panel-footer {
    padding: 12px 20px;
    border-top: 1px solid #222;
    font-size: 12px;
    color: #666;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .btn-import-all {
    padding: 4px 12px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #4ade80;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-import-all:hover { border-color: #4ade80; background: #0a2a14; }
  .btn-import-all:disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }

  /* ─── Imported Panel ──────────────────── */
  .imported-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #444;
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }

  /* ─── Banner ──────────────────────────── */
  .banner {
    padding: 10px 20px;
    font-size: 13px;
    display: none;
    align-items: center;
    gap: 10px;
  }
  .banner.error {
    background: #1a0a0a;
    border-bottom: 1px solid #3a1111;
    color: #f87171;
  }
  .banner.info {
    background: #0a1a2a;
    border-bottom: 1px solid #112233;
    color: #60a5fa;
  }
  .banner .banner-text { flex: 1; }
  .banner .banner-close, .banner .banner-retry {
    background: none;
    border: 1px solid currentColor;
    color: inherit;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  /* ─── Spinner ─────────────────────────── */
  .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid #333;
    border-top-color: #4ade80;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-row {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    gap: 10px;
    color: #666;
    font-size: 13px;
  }
</style>
</head>
<body>

<div class="header">
  <h1>Cookie Import</h1>
  <span class="port">localhost:${serverPort}</span>
</div>

<div id="banner" class="banner"></div>

<div class="container">
  <!-- Left Panel: Source Browser -->
  <div class="panel panel-left">
    <div class="panel-header">Source Browser</div>
    <div id="browser-pills" class="browser-pills"></div>
    <div id="profile-pills" class="profile-pills" style="display:none"></div>
    <div class="search-wrap">
      <input type="text" class="search-input" id="search" placeholder="Search domains..." />
    </div>
    <div class="domain-list" id="source-domains">
      <div class="loading-row"><span class="spinner"></span> Detecting browsers...</div>
    </div>
    <div class="panel-footer" id="source-footer"><span id="source-footer-text"></span><button class="btn-import-all" id="btn-import-all" style="display:none">Import All</button></div>
  </div>

  <!-- Right Panel: Imported -->
  <div class="panel panel-right">
    <div class="panel-header">Imported to Session</div>
    <div class="domain-list" id="imported-domains">
      <div class="imported-empty">No cookies imported yet</div>
    </div>
    <div class="panel-footer" id="imported-footer"></div>
  </div>
</div>

<script>
(function() {
  const BASE = '${baseUrl}';
  const AUTH_TOKEN = '${authToken || ''}';
  let activeBrowser = null;
  let activeProfile = 'Default';
  let allProfiles = [];
  let allDomains = [];
  let importedSet = {};  // domain → count
  let inflight = {};     // domain → true (prevents double-click)

  const $pills = document.getElementById('browser-pills');
  const $profilePills = document.getElementById('profile-pills');
  const $search = document.getElementById('search');
  const $sourceDomains = document.getElementById('source-domains');
  const $importedDomains = document.getElementById('imported-domains');
  const $sourceFooter = document.getElementById('source-footer-text');
  const $btnImportAll = document.getElementById('btn-import-all');
  const $importedFooter = document.getElementById('imported-footer');
  const $banner = document.getElementById('banner');

  // ─── Banner ────────────────────────────
  function showBanner(msg, type, retryFn) {
    $banner.className = 'banner ' + type;
    $banner.style.display = 'flex';
    let html = '<span class="banner-text">' + escHtml(msg) + '</span>';
    if (retryFn) {
      html += '<button class="banner-retry" id="banner-retry">Retry</button>';
    }
    html += '<button class="banner-close" id="banner-close">×</button>';
    $banner.innerHTML = html;
    document.getElementById('banner-close').onclick = () => { $banner.style.display = 'none'; };
    if (retryFn) {
      document.getElementById('banner-retry').onclick = () => {
        $banner.style.display = 'none';
        retryFn();
      };
    }
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── API ────────────────────────────────
  async function api(path, opts) {
    const headers = { ...(opts?.headers || {}) };
    if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
    const res = await fetch(BASE + '/cookie-picker' + path, { ...opts, headers });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.code = data.code;
      err.action = data.action;
      throw err;
    }
    return data;
  }

  // ─── Init ───────────────────────────────
  async function init() {
    try {
      const [browserData, importedData] = await Promise.all([
        api('/browsers'),
        api('/imported'),
      ]);

      // Populate imported state
      for (const entry of importedData.domains) {
        importedSet[entry.domain] = entry.count;
      }
      renderImported();

      // Render browser pills
      const browsers = browserData.browsers;
      if (browsers.length === 0) {
        $sourceDomains.innerHTML = '<div class="imported-empty">No Chromium browsers detected</div>';
        return;
      }

      $pills.innerHTML = '';
      browsers.forEach(b => {
        const pill = document.createElement('button');
        pill.className = 'pill';
        pill.innerHTML = '<span class="dot"></span>' + escHtml(b.name);
        pill.onclick = () => selectBrowser(b.name);
        $pills.appendChild(pill);
      });

      // Auto-select first browser
      selectBrowser(browsers[0].name);
    } catch (err) {
      showBanner(err.message, 'error', init);
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load</div>';
    }
  }

  // ─── Select Browser ────────────────────
  async function selectBrowser(name) {
    activeBrowser = name;
    activeProfile = 'Default';

    // Update pills
    $pills.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', p.textContent === name);
    });

    $sourceDomains.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading...</div>';
    $sourceFooter.textContent = '';
    $search.value = '';

    try {
      // Fetch profiles for this browser
      const profileData = await api('/profiles?browser=' + encodeURIComponent(name));
      allProfiles = profileData.profiles || [];

      if (allProfiles.length > 1) {
        // Show profile pills when multiple profiles exist
        $profilePills.style.display = 'flex';
        renderProfilePills();
        // Auto-select profile with the most recent/largest cookie DB, or Default
        activeProfile = allProfiles[0].name;
      } else {
        $profilePills.style.display = 'none';
        activeProfile = allProfiles.length === 1 ? allProfiles[0].name : 'Default';
      }

      await loadDomains();
    } catch (err) {
      showBanner(err.message, 'error', err.action === 'retry' ? () => selectBrowser(name) : null);
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load</div>';
      $profilePills.style.display = 'none';
    }
  }

  // ─── Render Profile Pills ─────────────
  function renderProfilePills() {
    let html = '';
    for (const p of allProfiles) {
      const isActive = p.name === activeProfile;
      const label = p.displayName || p.name;
      html += '<button class="profile-pill' + (isActive ? ' active' : '') + '" data-profile="' + escHtml(p.name) + '">' + escHtml(label) + '</button>';
    }
    $profilePills.innerHTML = html;

    $profilePills.querySelectorAll('.profile-pill').forEach(btn => {
      btn.addEventListener('click', () => selectProfile(btn.dataset.profile));
    });
  }

  // ─── Select Profile ───────────────────
  async function selectProfile(profileName) {
    activeProfile = profileName;
    renderProfilePills();

    $sourceDomains.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading domains...</div>';
    $sourceFooter.textContent = '';
    $search.value = '';

    await loadDomains();
  }

  // ─── Load Domains ─────────────────────
  async function loadDomains() {
    try {
      const data = await api('/domains?browser=' + encodeURIComponent(activeBrowser) + '&profile=' + encodeURIComponent(activeProfile));
      allDomains = data.domains;
      renderSourceDomains();
    } catch (err) {
      showBanner(err.message, 'error', err.action === 'retry' ? () => loadDomains() : null);
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load domains</div>';
    }
  }

  // ─── Render Source Domains ─────────────
  function renderSourceDomains() {
    const query = $search.value.toLowerCase();
    const filtered = query
      ? allDomains.filter(d => d.domain.toLowerCase().includes(query))
      : allDomains;

    if (filtered.length === 0) {
      $sourceDomains.innerHTML = '<div class="imported-empty">' +
        (query ? 'No matching domains' : 'No cookie domains found') + '</div>';
      $sourceFooter.textContent = '';
      return;
    }

    let html = '';
    for (const d of filtered) {
      const isImported = d.domain in importedSet;
      const isInflight = inflight[d.domain];
      html += '<div class="domain-row">';
      html += '<span class="domain-name">' + escHtml(d.domain) + '</span>';
      html += '<span class="domain-count">' + d.count + '</span>';
      if (isInflight) {
        html += '<span class="btn-add" disabled><span class="spinner" style="width:12px;height:12px;border-width:1.5px;"></span></span>';
      } else if (isImported) {
        html += '<span class="btn-add imported">&#10003;</span>';
      } else {
        html += '<button class="btn-add" data-domain="' + escHtml(d.domain) + '" title="Import">+</button>';
      }
      html += '</div>';
    }
    $sourceDomains.innerHTML = html;

    // Total counts
    const totalDomains = allDomains.length;
    const totalCookies = allDomains.reduce((s, d) => s + d.count, 0);
    $sourceFooter.textContent = totalDomains + ' domains · ' + totalCookies.toLocaleString() + ' cookies';

    // Show/hide Import All button
    const unimported = filtered.filter(d => !(d.domain in importedSet) && !inflight[d.domain]);
    if (unimported.length > 0) {
      $btnImportAll.style.display = '';
      $btnImportAll.disabled = false;
      $btnImportAll.textContent = 'Import All (' + unimported.length + ')';
    } else {
      $btnImportAll.style.display = 'none';
    }

    // Click handlers
    $sourceDomains.querySelectorAll('.btn-add[data-domain]').forEach(btn => {
      btn.addEventListener('click', () => importDomain(btn.dataset.domain));
    });
  }

  // ─── Import Domain ─────────────────────
  async function importDomain(domain) {
    if (inflight[domain] || domain in importedSet) return;
    inflight[domain] = true;
    renderSourceDomains();

    try {
      const data = await api('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser: activeBrowser, domains: [domain], profile: activeProfile }),
      });

      if (data.domainCounts) {
        for (const [d, count] of Object.entries(data.domainCounts)) {
          importedSet[d] = (importedSet[d] || 0) + count;
        }
      }
      renderImported();
    } catch (err) {
      showBanner('Import failed for ' + domain + ': ' + err.message, 'error',
        err.action === 'retry' ? () => importDomain(domain) : null);
    } finally {
      delete inflight[domain];
      renderSourceDomains();
    }
  }

  // ─── Import All ───────────────────────
  async function importAll() {
    const query = $search.value.toLowerCase();
    const filtered = query
      ? allDomains.filter(d => d.domain.toLowerCase().includes(query))
      : allDomains;
    const toImport = filtered.filter(d => !(d.domain in importedSet) && !inflight[d.domain]);
    if (toImport.length === 0) return;

    $btnImportAll.disabled = true;
    $btnImportAll.textContent = 'Importing...';

    const domains = toImport.map(d => d.domain);
    try {
      const data = await api('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser: activeBrowser, domains: domains, profile: activeProfile }),
      });

      if (data.domainCounts) {
        for (const [d, count] of Object.entries(data.domainCounts)) {
          importedSet[d] = (importedSet[d] || 0) + count;
        }
      }
      renderImported();
    } catch (err) {
      showBanner('Import all failed: ' + err.message, 'error',
        err.action === 'retry' ? () => importAll() : null);
    } finally {
      renderSourceDomains();
    }
  }

  $btnImportAll.addEventListener('click', importAll);

  // ─── Render Imported ───────────────────
  function renderImported() {
    const entries = Object.entries(importedSet).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      $importedDomains.innerHTML = '<div class="imported-empty">No cookies imported yet</div>';
      $importedFooter.textContent = '';
      return;
    }

    let html = '';
    for (const [domain, count] of entries) {
      const isInflight = inflight['remove:' + domain];
      html += '<div class="domain-row">';
      html += '<span class="domain-name">' + escHtml(domain) + '</span>';
      html += '<span class="domain-count">' + count + '</span>';
      if (isInflight) {
        html += '<span class="btn-trash" disabled><span class="spinner" style="width:12px;height:12px;border-width:1.5px;border-top-color:#f87171;"></span></span>';
      } else {
        html += '<button class="btn-trash" data-domain="' + escHtml(domain) + '" title="Remove">&#128465;</button>';
      }
      html += '</div>';
    }
    $importedDomains.innerHTML = html;

    const totalCookies = entries.reduce((s, e) => s + e[1], 0);
    $importedFooter.textContent = entries.length + ' domains · ' + totalCookies.toLocaleString() + ' cookies imported';

    // Click handlers
    $importedDomains.querySelectorAll('.btn-trash[data-domain]').forEach(btn => {
      btn.addEventListener('click', () => removeDomain(btn.dataset.domain));
    });
  }

  // ─── Remove Domain ─────────────────────
  async function removeDomain(domain) {
    if (inflight['remove:' + domain]) return;
    inflight['remove:' + domain] = true;
    renderImported();

    try {
      await api('/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: [domain] }),
      });
      delete importedSet[domain];
      renderImported();
      renderSourceDomains(); // update checkmarks
    } catch (err) {
      showBanner('Remove failed for ' + domain + ': ' + err.message, 'error',
        err.action === 'retry' ? () => removeDomain(domain) : null);
    } finally {
      delete inflight['remove:' + domain];
      renderImported();
    }
  }

  // ─── Search ────────────────────────────
  $search.addEventListener('input', renderSourceDomains);

  // ─── Start ─────────────────────────────
  init();
})();
</script>
</body>
</html>`;
}
