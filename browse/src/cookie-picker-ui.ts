/**
 * Cookie picker UI — self-contained HTML page
 *
 * Dark theme, two-panel layout, vanilla HTML/CSS/JS.
 * Left: source browser domains with search + import buttons.
 * Right: imported domains with trash buttons.
 * No cookie values exposed anywhere.
 */

export function getCookiePickerHTML(serverPort: number, options: {
  pickerInstance?: string;
  browser?: string;
  profile?: string;
  targetOrigin?: string;
  verifyAuth?: boolean;
  clearStorage?: boolean;
  verificationAvailable?: boolean;
  storageResetAvailable?: boolean;
} = {}): string {
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  let targetOrigin: string | undefined;
  try {
    const target = new URL(options.targetOrigin ?? '');
    if (['http:', 'https:'].includes(target.protocol)) targetOrigin = target.origin;
  } catch {}
  const config = JSON.stringify({
    pickerInstance: options.pickerInstance,
    browser: options.browser,
    profile: options.profile,
    targetOrigin,
    verifyAuth: options.verifyAuth === true,
    clearStorage: options.clearStorage === true,
    verificationAvailable: options.verificationAvailable === true,
    storageResetAvailable: options.storageResetAvailable !== false,
  }).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

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
    display: flex;
    flex-direction: column;
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

  .subtitle {
    padding: 10px 24px 12px;
    font-size: 13px;
    color: #999;
    line-height: 1.5;
    border-bottom: 1px solid #222;
    background: #0f0f0f;
  }

  /* ─── Layout ──────────────────────────── */
  .container {
    display: flex;
    flex: 1;
    min-height: 0;
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
    display: flex;
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
  .banner.warning {
    background: #241b0a;
    border-bottom: 1px solid #49330d;
    color: #fbbf24;
  }
  .target-options {
    border: 0;
    border-bottom: 1px solid #222;
    padding: 10px 24px;
    font-size: 12px;
    color: #aaa;
    display: grid;
    gap: 8px;
  }
  .target-options legend { padding-top: 10px; color: #ccc; }
  .target-options label { display: flex; align-items: flex-start; gap: 8px; line-height: 1.5; }
  .target-options input { margin-top: 3px; accent-color: #60a5fa; }
  .target-options small { color: #888; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:focus-visible, input:focus-visible { outline: 2px solid #60a5fa; outline-offset: 3px; }
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

<p class="subtitle">Copy cookies from the browser and profile you choose to this GStack Browser session. Copying cookies does not prove that you are signed in. Cookies are shared by tabs in this session.</p>

<fieldset class="target-options">
  <legend>Captured target: <span id="target-origin">No HTTP(S) target bound</span></legend>
  <label><input id="clear-storage" type="checkbox"><span>Clear storage for this target origin before importing.<br><small>Chromium targets only. Clears origin localStorage (shared across tabs) and this target tab's sessionStorage only. Other origins and other tabs' sessionStorage are preserved.</small></span></label>
  <label><input id="verify-auth" type="checkbox"><span>Reload the captured target and verify the configured account identity.<br><small id="verification-help">Requires an explicitly configured identity assertion and an HTTP(S) target.</small></span></label>
</fieldset>
<div id="banner" class="banner info" role="status" aria-live="polite" aria-atomic="true">Choose a browser and profile to inspect cookie domains.</div>

<div class="container">
  <!-- Left Panel: Source Browser -->
  <div class="panel panel-left">
    <div class="panel-header">Source Browser</div>
    <div id="browser-pills" class="browser-pills"></div>
    <div id="profile-pills" class="profile-pills" style="display:none"></div>
    <div class="search-wrap">
      <input type="text" class="search-input" id="search" placeholder="Search domains..." aria-label="Search cookie domains" />
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

<script id="picker-config" type="application/json">${config}</script>
<script>
(function() {
  const BASE = '${baseUrl}';
  const config = JSON.parse(document.getElementById('picker-config').textContent);
  let activeBrowser = null;
  let configuredBrowser = null;
  let activeProfile = null;
  let allProfiles = [];
  let allDomains = [];
  let importedSet = Object.create(null);
  let generation = 0;
  let mutation = false;
  const errorMessages = {
    picker_changed: 'This picker is stale because another picker was opened. Reopen the picker from the intended page before continuing.',
    keychain_denied: 'Keychain access was denied. Allow access in the OS permission prompt or settings, then retry manually.',
    keychain_timeout: 'Credential lookup timed out. Check for a pending OS permission prompt, then retry manually.',
    keychain_error: 'Credential lookup failed. Check the OS credential store or sign in manually in GStack Browser.',
    db_locked: 'The source cookie database is busy. Close the source browser, then retry manually.',
    db_corrupt: 'The source cookie database is invalid or corrupt. Choose another profile or sign in manually in GStack Browser.',
    db_permission: 'Cookie database access was denied. Check source-profile permissions, then retry manually.',
    db_read_error: 'Cookie data could not be read from this profile. Choose another profile or sign in manually in GStack Browser.',
    sqlite_unavailable: 'Cookie import needs Node.js 22.13 or newer with built-in SQLite enabled. Upgrade the runtime or sign in manually in GStack Browser.',
    storage_reset_unsupported: 'Storage reset requires a Chromium target. Import cookies without storage reset on other browsers.',
    profile_required: 'Choose a source profile explicitly; multiple or unavailable profiles cannot be selected automatically.',
    target_changed: 'The captured target changed or is unavailable. Reopen the picker from the intended HTTP(S) page.',
    target_closed: 'The captured target is closed. Reopen the picker from the intended HTTP(S) page.',
    target_mismatch: 'The selected cookies do not match the captured target. Select its cookie domain or reopen the picker from the intended page.',
    not_supported: 'Native cookie import is unsupported for this browser or runtime. Sign in manually in GStack Browser.',
    native_profile_unsupported: 'This browser profile does not support native cookie extraction. Sign in manually in GStack Browser.',
    native_unqualified: 'Native extraction is disabled because process ownership and cleanup are not qualified for this browser and runtime. Sign in manually in GStack Browser.',
    native_cleanup_failed: 'Native browser cleanup could not be confirmed. Inspect the source browser before any manual retry, or sign in manually in GStack Browser.',
    native_supervision_failed: 'Native browser supervision could not start. Sign in manually in GStack Browser.',
    native_timeout: 'Native cookie extraction timed out. Sign in manually in GStack Browser.',
    browser_running: 'The source browser is already running. Close it yourself before retrying, or sign in manually in GStack Browser.',
  };

  const $pills = document.getElementById('browser-pills');
  const $profilePills = document.getElementById('profile-pills');
  const $search = document.getElementById('search');
  const $sourceDomains = document.getElementById('source-domains');
  const $importedDomains = document.getElementById('imported-domains');
  const $sourceFooter = document.getElementById('source-footer-text');
  const $btnImportAll = document.getElementById('btn-import-all');
  const $importedFooter = document.getElementById('imported-footer');
  const $banner = document.getElementById('banner');
  const $clearStorage = document.getElementById('clear-storage');
  const $verifyAuth = document.getElementById('verify-auth');
  const canVerify = !!config.targetOrigin && config.verificationAvailable;
  const canReset = !!config.targetOrigin && config.storageResetAvailable;
  document.getElementById('target-origin').textContent = config.targetOrigin || 'No HTTP(S) target bound';
  $clearStorage.checked = canReset && config.clearStorage;
  $clearStorage.disabled = !canReset;
  $verifyAuth.checked = canVerify && config.verifyAuth;
  $verifyAuth.disabled = !canVerify;
  if (canVerify) document.getElementById('verification-help').textContent = 'Optional. Uses the server-configured exact identity assertion; the identity is never displayed here.';

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function errorMessage(error) {
    return error && Object.hasOwn(errorMessages, error.code) ? errorMessages[error.code]
      : 'Inspect the source and destination before retrying, or reopen the picker.';
  }

  function showBanner(message, type, retry) {
    $banner.className = 'banner ' + type;
    $banner.innerHTML = '<span class="banner-text">' + escHtml(message) + '</span>';
    if (retry) {
      const button = document.createElement('button');
      button.className = 'banner-retry';
      button.textContent = 'Retry';
      button.disabled = mutation;
      button.onclick = () => { if (!mutation) retry(); };
      $banner.appendChild(button);
    }
  }

  async function api(path, opts) {
    const headers = new Headers(opts && opts.headers);
    headers.set('X-Gstack-Picker-Instance', config.pickerInstance || '');
    const response = await fetch(BASE + '/cookie-picker' + path, { ...opts, headers, credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error('Cookie picker request failed.');
      if (data && typeof data.code === 'string' && Object.hasOwn(errorMessages, data.code)) error.code = data.code;
      throw error;
    }
    return data;
  }

  async function init() {
    try {
      const [browserData, importedData] = await Promise.all([api('/browsers'), api('/imported')]);
      for (const entry of importedData.domains || []) {
        if (Number.isFinite(entry.count) && entry.count > 0) importedSet[entry.domain] = entry.count;
      }
      renderImported();
      const browsers = browserData.browsers || [];
      $pills.innerHTML = '';
      for (const browser of browsers) {
        const button = document.createElement('button');
        button.className = 'pill';
        button.dataset.browser = browser.name;
        button.setAttribute('aria-pressed', 'false');
        button.innerHTML = '<span class="dot"></span>' + escHtml(browser.name);
        button.onclick = () => selectBrowser(browser.name);
        $pills.appendChild(button);
      }
      if (!browsers.length) {
        $sourceDomains.innerHTML = '<div class="imported-empty">No Chromium browsers detected</div>';
        showBanner('No supported source browsers were detected.', 'warning');
        return;
      }
      const selected = config.browser
        ? browsers.find(browser => [browser.name, ...(Array.isArray(browser.aliases) ? browser.aliases : [])]
          .some(name => typeof name === 'string' && name.toLowerCase() === config.browser.trim().toLowerCase()))
        : browsers[0];
      configuredBrowser = config.browser && selected ? selected.name : null;
      if (selected) await selectBrowser(selected.name);
      else {
        $sourceDomains.innerHTML = '<div class="imported-empty">Choose an available source browser</div>';
        showBanner('The requested browser is unavailable. Choose an available browser explicitly.', 'warning');
      }
    } catch (error) {
      showBanner('Could not load the cookie picker. ' + errorMessage(error), 'error', init);
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load</div>';
    }
  }

  async function selectBrowser(name) {
    if (mutation) return;
    const selection = ++generation;
    activeBrowser = name;
    activeProfile = null;
    allProfiles = [];
    allDomains = [];
    $search.value = '';
    $profilePills.innerHTML = '';
    $profilePills.style.display = 'none';
    $btnImportAll.style.display = 'none';
    $sourceFooter.textContent = '';
    $pills.querySelectorAll('button').forEach(button => {
      const active = button.dataset.browser === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $sourceDomains.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading profiles...</div>';
    showBanner('Loading profiles from ' + name + '.', 'info');
    try {
      const data = await api('/profiles?browser=' + encodeURIComponent(name));
      if (selection !== generation) return;
      allProfiles = data.profiles || [];
      const explicit = config.profile && configuredBrowser === name;
      const requested = explicit ? config.profile : data.recommendedProfile;
      activeProfile = allProfiles.some(profile => profile.name === requested) ? requested : null;
      renderProfilePills();
      if (!activeProfile) {
        $sourceDomains.innerHTML = '<div class="imported-empty">' + (allProfiles.length ? 'Choose a profile to inspect its domains' : 'No profiles found') + '</div>';
        showBanner(explicit ? 'The requested profile is unavailable. Choose a profile explicitly.'
          : allProfiles.length ? 'Choose a profile. No unambiguous profile was recommended.' : 'No source profiles were found.', 'warning');
        return;
      }
      await loadDomains(selection, name, activeProfile);
    } catch (error) {
      if (selection !== generation) return;
      showBanner('Could not load profiles for ' + name + '. ' + errorMessage(error), 'error', () => selectBrowser(name));
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load profiles</div>';
    }
  }

  function renderProfilePills() {
    $profilePills.style.display = allProfiles.length ? 'flex' : 'none';
    $profilePills.innerHTML = allProfiles.map(profile => {
      const active = profile.name === activeProfile;
      const label = (profile.displayName || profile.name) + ' (' + profile.name + ')' + (profile.unavailable ? ' — could not inspect' : '');
      return '<button class="profile-pill' + (active ? ' active' : '') + '" aria-pressed="' + active + '" data-profile="' + escHtml(profile.name) + '"' + (mutation ? ' disabled' : '') + '>' + escHtml(label) + '</button>';
    }).join('');
    $profilePills.querySelectorAll('button').forEach(button => {
      button.onclick = () => selectProfile(button.dataset.profile);
    });
  }

  async function selectProfile(name) {
    if (mutation || !allProfiles.some(profile => profile.name === name)) return;
    const selection = ++generation;
    activeProfile = name;
    allDomains = [];
    $search.value = '';
    renderProfilePills();
    $profilePills.querySelectorAll('button').forEach(button => { if (button.dataset.profile === name) button.focus(); });
    await loadDomains(selection, activeBrowser, name);
  }

  async function loadDomains(selection, browser, profile) {
    $sourceDomains.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading domains...</div>';
    $sourceFooter.textContent = '';
    $btnImportAll.style.display = 'none';
    showBanner('Loading domains from ' + browser + ' (' + profile + ').', 'info');
    try {
      const data = await api('/domains?browser=' + encodeURIComponent(browser) + '&profile=' + encodeURIComponent(profile));
      if (selection !== generation) return;
      allDomains = data.domains || [];
      renderSourceDomains();
      showBanner(allDomains.length ? 'Ready to import from ' + browser + ' (' + profile + '). Authentication has not been checked.'
        : 'No cookie domains found in ' + browser + ' (' + profile + ').', allDomains.length ? 'info' : 'warning');
    } catch (error) {
      if (selection !== generation) return;
      showBanner('Could not read domains from ' + browser + ' (' + profile + '). ' + errorMessage(error), 'error', () => selectProfile(profile));
      $sourceDomains.innerHTML = '<div class="imported-empty">Failed to load domains</div>';
    }
  }

  function renderSourceDomains() {
    const query = $search.value.toLowerCase();
    const filtered = allDomains.filter(domain => domain.domain.toLowerCase().includes(query));
    $btnImportAll.style.display = filtered.length && activeProfile ? '' : 'none';
    $btnImportAll.disabled = mutation || !activeProfile;
    $btnImportAll.textContent = 'Import All (' + filtered.length + ')';
    $sourceFooter.textContent = allDomains.length ? allDomains.length + ' domains · ' + allDomains.reduce((sum, domain) => sum + domain.count, 0).toLocaleString() + ' cookies' : '';
    if (!filtered.length) {
      $sourceDomains.innerHTML = '<div class="imported-empty">' + (!activeProfile ? 'Choose a profile to inspect its domains' : query ? 'No matching domains' : 'No cookie domains found') + '</div>';
      return;
    }
    $sourceDomains.innerHTML = filtered.map(domain => {
      const label = (domain.domain in importedSet ? 'Reimport ' : 'Import ') + domain.domain;
      return '<div class="domain-row"><span class="domain-name">' + escHtml(domain.domain) + '</span><span class="domain-count">' + escHtml(domain.count) + '</span><button class="btn-add" data-domain="' + escHtml(domain.domain) + '" title="' + escHtml(label) + '" aria-label="' + escHtml(label) + '"' + (mutation ? ' disabled' : '') + '>' + (domain.domain in importedSet ? '&#8635;' : '+') + '</button></div>';
    }).join('');
    $sourceDomains.querySelectorAll('button').forEach(button => {
      button.onclick = () => importDomains([button.dataset.domain]);
    });
  }

  function setMutationBusy(busy) {
    mutation = busy;
    $pills.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    $profilePills.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    $search.disabled = busy;
    $clearStorage.disabled = busy || !canReset;
    $verifyAuth.disabled = busy || !canVerify;
    renderSourceDomains();
    renderImported();
  }

  async function importDomains(domains) {
    if (mutation || !activeBrowser || !activeProfile || !domains.length) return;
    const request = { browser: activeBrowser, profile: activeProfile, domains: domains.slice(),
      clearStorage: canReset && $clearStorage.checked, verifyAuth: canVerify && $verifyAuth.checked };
    setMutationBusy(true);
    showBanner('Importing from ' + request.browser + ' (' + request.profile + '). Keep this picker open.', 'info');
    try {
      const data = await api('/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const imported = Number.isFinite(data.imported) && data.imported > 0 ? data.imported : 0;
      const failed = Number.isFinite(data.failed) && data.failed > 0 ? data.failed : 0;
      for (const [domain, count] of Object.entries(data.domainCounts || {})) {
        if (imported > 0 && Number.isFinite(count) && count > 0) importedSet[domain] = count;
      }
      const partial = data.outcome === 'partial' || (imported > 0 && failed > 0);
      let type = data.outcome === 'failed' || data.reset === 'failed' ? 'error' : partial || !imported ? 'warning' : 'info';
      let message = (data.outcome === 'failed' ? 'Import failed. ' : partial ? 'Partial import. ' : !imported ? 'No cookies imported. ' : 'Cookies imported. ')
        + imported + ' imported; ' + failed + ' failed. Source: ' + request.browser + ' (' + request.profile + ').';
      if (typeof data.message === 'string' && data.message) message += ' ' + data.message;
      const failureLabels = { unsupported_encryption: 'unsupported encryption', decryption_failed: 'decryption failed', native_unrecovered: 'not recovered by native import' };
      for (const [reason, count] of Object.entries(data.failureReasons || {})) {
        if (Object.hasOwn(failureLabels, reason) && Number.isFinite(count) && count > 0) message += ' ' + failureLabels[reason] + ': ' + count + '.';
      }
      message += data.reset === 'cleared' ? ' Storage cleared for ' + config.targetOrigin + '.'
        : data.reset === 'failed' ? ' Storage reset failed; storage may be partially cleared.' : ' Storage preserved.';
      if (!request.verifyAuth) message += ' Authentication not checked.';
      else if (imported > 0 && data.verification && data.verification.verified === true) message += ' Authentication verified on the captured target.';
      else {
        const reasons = { not_configured: 'identity assertion not configured', no_cookies_imported: 'no cookies imported',
          identity_missing: 'visible identity missing', identity_ambiguous: 'multiple visible identities', identity_mismatch: 'identity did not match',
          login_redirect: 'login page detected', target_changed: 'target changed', target_closed: 'target closed',
          timeout: 'check timed out', http_error: 'unsuccessful HTTP response', reset_failed: 'storage reset failed', application_failed: 'cookie application failed' };
        const reason = data.verification && data.verification.reason;
        message += ' Authentication not verified' + (Object.hasOwn(reasons, reason) ? ': ' + reasons[reason] : '') + '.';
        if (type === 'info') type = 'warning';
      }
      showBanner(message, type);
    } catch (error) {
      showBanner('Import did not complete for ' + request.browser + ' (' + request.profile + '). ' + errorMessage(error) + ' Authentication was not verified.', 'error');
    } finally {
      setMutationBusy(false);
      if (domains.length === 1) {
        $sourceDomains.querySelectorAll('button').forEach(button => { if (button.dataset.domain === domains[0]) button.focus(); });
      } else $btnImportAll.focus();
    }
  }

  $btnImportAll.onclick = () => importDomains(allDomains.filter(domain => domain.domain.toLowerCase().includes($search.value.toLowerCase())).map(domain => domain.domain));

  function renderImported() {
    const entries = Object.entries(importedSet).sort((a, b) => b[1] - a[1]);
    $importedFooter.textContent = entries.length ? entries.length + ' domains · ' + entries.reduce((sum, entry) => sum + entry[1], 0).toLocaleString() + ' cookies imported' : '';
    $importedDomains.innerHTML = entries.length ? entries.map(([domain, count]) => '<div class="domain-row"><span class="domain-name">' + escHtml(domain) + '</span><span class="domain-count">' + escHtml(count) + '</span><button class="btn-trash" data-domain="' + escHtml(domain) + '" aria-label="' + escHtml('Remove ' + domain) + '" title="Remove"' + (mutation ? ' disabled' : '') + '>&#128465;</button></div>').join('')
      : '<div class="imported-empty">No cookies imported yet</div>';
    $importedDomains.querySelectorAll('button').forEach(button => { button.onclick = () => removeDomain(button.dataset.domain); });
  }

  async function removeDomain(domain) {
    if (mutation) return;
    setMutationBusy(true);
    showBanner('Removing imported cookies for ' + domain + '.', 'info');
    try {
      await api('/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: [domain] }) });
      delete importedSet[domain];
      showBanner('Removed imported cookies for ' + domain + '. Storage was not cleared.', 'info');
    } catch (error) {
      showBanner('Cookie removal did not complete. ' + errorMessage(error), 'error');
    } finally {
      setMutationBusy(false);
      const first = $importedDomains.querySelector('button') || $sourceDomains.querySelector('button');
      if (first) first.focus();
    }
  }

  $search.addEventListener('input', renderSourceDomains);
  init();
})();
</script>
</body>
</html>`;
}
