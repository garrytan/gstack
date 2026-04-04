/**
 * Dashboard UI — self-contained HTML page for gstack's team engineering intelligence platform.
 *
 * Served by a Supabase edge function. All auth (PKCE), data fetching, and rendering
 * happen client-side. The server only injects supabaseUrl and anonKey into the template.
 */

export function getDashboardHTML(supabaseUrl: string, anonKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gstack Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0a0a0a;
    color: #e5e5e5;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }

  /* ---------- Layout ---------- */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid #222;
  }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header-right { display: flex; align-items: center; gap: 16px; font-size: 13px; color: #888; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    display: inline-block; margin-right: 6px;
  }
  .status-dot.ok { background: #4ade80; }
  .status-dot.err { background: #ef4444; }
  .btn-signout {
    background: transparent; border: 1px solid #333; color: #888;
    padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .btn-signout:hover { color: #e5e5e5; border-color: #555; }

  /* ---------- Tabs ---------- */
  .tabs {
    display: flex; gap: 0; border-bottom: 1px solid #222;
    padding: 0 24px; overflow-x: auto;
  }
  .tab {
    padding: 10px 18px; cursor: pointer; color: #888;
    border-bottom: 2px solid transparent; white-space: nowrap;
    font-size: 13px; font-weight: 500; transition: color 0.15s;
  }
  .tab:hover { color: #ccc; }
  .tab.active { color: #4ade80; border-bottom-color: #4ade80; }

  /* ---------- Content ---------- */
  .content { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ---------- Cards ---------- */
  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card {
    background: #141414; border: 1px solid #222; border-radius: 10px; padding: 20px;
  }
  .stat-card .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .stat-card .value { font-size: 28px; font-weight: 700; font-family: 'SF Mono', 'Fira Code', monospace; }

  /* ---------- Tables ---------- */
  .panel { background: #141414; border: 1px solid #222; border-radius: 10px; padding: 20px; margin-bottom: 24px; }
  .panel h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; padding: 8px 12px; border-bottom: 1px solid #222; }
  td { padding: 8px 12px; border-bottom: 1px solid #1a1a1a; font-size: 13px; }
  td.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
  a { color: #4ade80; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ---------- Health score colors ---------- */
  .score-green { color: #4ade80; }
  .score-yellow { color: #facc15; }
  .score-red { color: #ef4444; }

  /* ---------- Online dot ---------- */
  .online-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #4ade80;
    display: inline-block; margin-right: 6px;
  }

  /* ---------- Login ---------- */
  .login-card {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: #0a0a0a;
  }
  .login-card .inner {
    background: #141414; border: 1px solid #222; border-radius: 12px;
    padding: 40px; text-align: center; max-width: 380px;
  }
  .login-card h2 { font-size: 20px; margin-bottom: 8px; }
  .login-card p { color: #888; margin-bottom: 24px; font-size: 14px; }
  .btn-github {
    background: #e5e5e5; color: #0a0a0a; border: none; padding: 10px 24px;
    border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .btn-github:hover { background: #fff; }

  /* ---------- Error / empty ---------- */
  .panel-error { color: #888; font-size: 13px; padding: 16px 0; }
  .panel-empty { color: #555; font-size: 13px; padding: 16px 0; font-style: italic; }

  /* ---------- SVG charts ---------- */
  .chart-container { margin-bottom: 16px; }
  svg text { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; fill: #888; }
</style>
</head>
<body>

<!-- Login screen -->
<div id="login-screen" class="login-card" style="display:none">
  <div class="inner">
    <h2>gstack Dashboard</h2>
    <p>Team engineering intelligence</p>
    <button class="btn-github" id="btn-login">Sign in with GitHub</button>
  </div>
</div>

<!-- Dashboard (shown after auth) -->
<div id="dashboard" style="display:none">
  <div class="header">
    <h1>gstack Dashboard</h1>
    <div class="header-right">
      <span><span id="status-dot" class="status-dot ok"></span><span id="status-text">Updated just now</span></span>
      <button class="btn-signout" id="btn-signout">Sign out</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="overview">Overview</div>
    <div class="tab" data-tab="evals">Evals</div>
    <div class="tab" data-tab="ships">Ships</div>
    <div class="tab" data-tab="costs">Costs</div>
    <div class="tab" data-tab="leaderboard">Leaderboard</div>
    <div class="tab" data-tab="qa">QA</div>
  </div>

  <div class="content">
    <!-- Overview -->
    <div class="tab-panel active" id="panel-overview">
      <div class="stat-row">
        <div class="stat-card"><div class="label">Eval Runs This Week</div><div class="value" id="stat-evals-week">-</div></div>
        <div class="stat-card"><div class="label">Ships This Week</div><div class="value" id="stat-ships-week">-</div></div>
        <div class="stat-card"><div class="label">Active Now</div><div class="value" id="stat-active-now">-</div></div>
        <div class="stat-card"><div class="label">Cost This Week</div><div class="value" id="stat-cost-week">-</div></div>
      </div>
      <div class="panel"><h3>Recent Eval Runs</h3><table id="tbl-overview-evals"><thead><tr><th>Date</th><th>Branch</th><th>Pass Rate</th><th>Cost</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-overview-evals" style="display:none">No eval runs yet. Push results with: gstack eval push result.json</div></div>
      <div class="panel"><h3>Recent Ships</h3><table id="tbl-overview-ships"><thead><tr><th>Date</th><th>Version</th><th>Branch</th><th>PR</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-overview-ships" style="display:none">No ships yet. Ship your first PR with: /ship</div></div>
    </div>

    <!-- Evals -->
    <div class="tab-panel" id="panel-evals">
      <div class="panel"><h3>Pass Rate Trend</h3><div class="chart-container" id="chart-sparkline"></div></div>
      <div class="panel"><h3>Recent Eval Runs</h3><table id="tbl-evals"><thead><tr><th>Date</th><th>User</th><th>Branch</th><th>Pass Rate</th><th>Cost</th><th>Tier</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-evals" style="display:none">No eval data yet. Run your test suite and push results: gstack eval push result.json</div></div>
    </div>

    <!-- Ships -->
    <div class="tab-panel" id="panel-ships">
      <div class="panel"><h3>Recent Ships</h3><table id="tbl-ships"><thead><tr><th>Date</th><th>Version</th><th>Branch</th><th>PR</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-ships" style="display:none">No ships yet. Use /ship to create PRs with full review and version bumps.</div></div>
      <div class="panel"><h3>Ships Per Person This Week</h3><div class="chart-container" id="chart-ships-per-person"></div></div>
    </div>

    <!-- Costs -->
    <div class="tab-panel" id="panel-costs">
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total All-Time Cost</div><div class="value" id="stat-cost-total">-</div></div>
      </div>
      <div class="panel"><h3>Weekly Cost Trend</h3><div class="chart-container" id="chart-weekly-cost"></div></div>
    </div>

    <!-- Leaderboard -->
    <div class="tab-panel" id="panel-leaderboard">
      <div class="panel"><h3>This Week</h3><table id="tbl-leaderboard"><thead><tr><th>#</th><th>Who</th><th>Ships</th><th>Evals</th><th>Sessions</th><th>Pass Rate</th><th>Cost</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-leaderboard" style="display:none">No activity this week yet. Ship, run evals, or start a Claude session to appear here.</div></div>
    </div>

    <!-- QA -->
    <div class="tab-panel" id="panel-qa">
      <div class="panel"><h3>Recent QA Reports</h3><table id="tbl-qa"><thead><tr><th>Date</th><th>Repo</th><th>Health Score</th></tr></thead><tbody></tbody></table><div class="panel-empty" id="empty-qa" style="display:none">No QA reports yet. Run /qa on a web app to generate your first health score.</div></div>
    </div>
  </div>
</div>

<script>
(function() {
  'use strict';

  // ---- Config injected by the edge function ----
  const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
  const ANON_KEY = ${JSON.stringify(anonKey)};

  // ---- DOM refs ----
  const $login = document.getElementById('login-screen');
  const $dashboard = document.getElementById('dashboard');
  const $statusDot = document.getElementById('status-dot');
  const $statusText = document.getElementById('status-text');

  // ---- State ----
  let accessToken = null;
  let refreshToken = null;
  let lastFetchTime = 0;
  let refreshTimer = null;

  // All fetched data
  let data = { evalRuns: [], shipLogs: [], evalCosts: [], qaReports: [], transcripts: [], heartbeats: [] };

  // ================================================================
  // PKCE Auth helpers
  // ================================================================

  /** Generate a random string for PKCE code_verifier (43 chars, URL-safe) */
  function generateVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
      .slice(0, 43);
  }

  /** SHA-256 hash, then base64url encode for code_challenge */
  async function sha256Challenge(verifier) {
    const encoded = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  /** Decode a JWT payload (base64url middle segment) */
  function decodeJWT(token) {
    try {
      const payload = token.split('.')[1];
      const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(padded));
    } catch { return null; }
  }

  /** Check if a JWT is expired (with 60s buffer) */
  function isExpired(token) {
    const claims = decodeJWT(token);
    if (!claims || !claims.exp) return true;
    return claims.exp * 1000 < Date.now() - 60000;
  }

  // ================================================================
  // Auth flow
  // ================================================================

  /** Try to restore session from localStorage */
  function restoreSession() {
    accessToken = localStorage.getItem('sb-access-token');
    refreshToken = localStorage.getItem('sb-refresh-token');
    if (accessToken && !isExpired(accessToken)) return true;
    if (accessToken && refreshToken) return tryRefresh();
    return false;
  }

  /** Exchange refresh token for a new access token */
  async function tryRefresh() {
    try {
      const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!res.ok) throw new Error('refresh failed');
      const json = await res.json();
      accessToken = json.access_token;
      refreshToken = json.refresh_token;
      localStorage.setItem('sb-access-token', accessToken);
      localStorage.setItem('sb-refresh-token', refreshToken);
      return true;
    } catch {
      signOut();
      return false;
    }
  }

  /** Exchange authorization code for tokens (PKCE) */
  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem('pkce-verifier');
    if (!verifier) { showLogin(); return; }
    try {
      const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
        body: JSON.stringify({ auth_code: code, code_verifier: verifier })
      });
      if (!res.ok) throw new Error('token exchange failed');
      const json = await res.json();
      accessToken = json.access_token;
      refreshToken = json.refresh_token;
      localStorage.setItem('sb-access-token', accessToken);
      localStorage.setItem('sb-refresh-token', refreshToken);
      sessionStorage.removeItem('pkce-verifier');
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
      showDashboard();
    } catch {
      showLogin();
    }
  }

  /** Redirect to GitHub OAuth with PKCE */
  async function startLogin() {
    const verifier = generateVerifier();
    sessionStorage.setItem('pkce-verifier', verifier);
    const challenge = await sha256Challenge(verifier);
    const redirectTo = window.location.origin + window.location.pathname;
    const url = SUPABASE_URL + '/auth/v1/authorize'
      + '?provider=github'
      + '&redirect_to=' + encodeURIComponent(redirectTo)
      + '&flow_type=pkce'
      + '&code_challenge_method=s256'
      + '&code_challenge=' + challenge;
    window.location.href = url;
  }

  function signOut() {
    localStorage.removeItem('sb-access-token');
    localStorage.removeItem('sb-refresh-token');
    accessToken = null;
    refreshToken = null;
    showLogin();
  }

  function showLogin() {
    $login.style.display = 'flex';
    $dashboard.style.display = 'none';
    stopAutoRefresh();
  }

  function showDashboard() {
    $login.style.display = 'none';
    $dashboard.style.display = 'block';
    fetchAll();
    startAutoRefresh();
  }

  // ================================================================
  // Data fetching
  // ================================================================

  /** Fetch a single REST endpoint with auth headers */
  async function apiFetch(path) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    if (res.status === 401) {
      const ok = await tryRefresh();
      if (!ok) { signOut(); throw new Error('auth expired'); }
      // Retry once with new token
      const retry = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
        headers: {
          'apikey': ANON_KEY,
          'Authorization': 'Bearer ' + accessToken
        }
      });
      if (!retry.ok) throw new Error('fetch failed: ' + path);
      return retry.json();
    }
    if (!res.ok) throw new Error('fetch failed: ' + path);
    return res.json();
  }

  /** Fetch all 6 data sources in parallel */
  async function fetchAll() {
    const fetches = [
      apiFetch('eval_runs?order=timestamp.desc&limit=100').then(d => { data.evalRuns = d; }).catch(() => { data.evalRuns = null; }),
      apiFetch('ship_logs?order=created_at.desc&limit=100').then(d => { data.shipLogs = d; }).catch(() => { data.shipLogs = null; }),
      apiFetch('eval_costs?order=created_at.desc&limit=200').then(d => { data.evalCosts = d; }).catch(() => { data.evalCosts = null; }),
      apiFetch('qa_reports?order=created_at.desc&limit=100').then(d => { data.qaReports = d; }).catch(() => { data.qaReports = null; }),
      apiFetch('session_transcripts?order=started_at.desc&limit=100').then(d => { data.transcripts = d; }).catch(() => { data.transcripts = null; }),
      apiFetch('sync_heartbeats?order=timestamp.desc&limit=50').then(d => { data.heartbeats = d; }).catch(() => { data.heartbeats = null; }),
    ];
    await Promise.allSettled(fetches);
    lastFetchTime = Date.now();
    updateStatus(true);
    renderAll();
  }

  // ================================================================
  // Auto-refresh (60s, pauses when tab hidden)
  // ================================================================

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => { fetchAll(); }, 60000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      // Fetch immediately when tab becomes visible, then resume timer
      if (accessToken) { fetchAll(); startAutoRefresh(); }
    }
  });

  function updateStatus(ok) {
    $statusDot.className = 'status-dot ' + (ok ? 'ok' : 'err');
    updateStatusText();
  }

  function updateStatusText() {
    const elapsed = Math.floor((Date.now() - lastFetchTime) / 1000);
    if (elapsed < 5) { $statusText.textContent = 'Updated just now'; }
    else { $statusText.textContent = 'Updated ' + elapsed + 's ago'; }
  }
  // Update the "Xs ago" label every 5 seconds
  setInterval(updateStatusText, 5000);

  // ================================================================
  // Helpers
  // ================================================================

  /** Format an ISO date string to a short readable form */
  function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /** Format USD cost */
  function fmtCost(n) {
    if (n == null || isNaN(n)) return '-';
    return '$' + Number(n).toFixed(2);
  }

  /** Get the start of the current ISO week (Monday) */
  function weekStart() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(diff);
    return monday;
  }

  /** Check if a timestamp is within the last N minutes */
  function withinMinutes(iso, mins) {
    if (!iso) return false;
    return (Date.now() - new Date(iso).getTime()) < mins * 60 * 1000;
  }

  /** Create a table row, setting textContent for each cell (XSS safe) */
  function makeRow(cells) {
    const tr = document.createElement('tr');
    cells.forEach(function(cell) {
      const td = document.createElement('td');
      if (typeof cell === 'object' && cell.href) {
        // Clickable link — still safe, we control the href
        const a = document.createElement('a');
        a.href = cell.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = cell.text || cell.href;
        td.appendChild(a);
      } else if (typeof cell === 'object' && cell.html) {
        // For inline dots — only used with controlled content
        td.innerHTML = cell.html;
      } else {
        td.textContent = String(cell != null ? cell : '-');
        if (typeof cell === 'number' || (typeof cell === 'string' && /^[\\$\\d\\.\\-]+$/.test(cell))) {
          td.classList.add('mono');
        }
      }
      tr.appendChild(td);
    });
    return tr;
  }

  /** Show/hide empty placeholder */
  function toggleEmpty(tableId, emptyId, hasData) {
    const tbl = document.getElementById(tableId);
    const empty = document.getElementById(emptyId);
    if (!tbl || !empty) return;
    tbl.style.display = hasData ? '' : 'none';
    empty.style.display = hasData ? 'none' : '';
  }

  /** Show error text inside a panel */
  function showPanelError(tableId, emptyId) {
    const empty = document.getElementById(emptyId);
    if (empty) {
      empty.textContent = 'Could not load data';
      empty.className = 'panel-error';
      empty.style.display = '';
    }
    const tbl = document.getElementById(tableId);
    if (tbl) tbl.style.display = 'none';
  }

  /** Clear a table body */
  function clearTbody(tableId) {
    const tbl = document.getElementById(tableId);
    if (!tbl) return null;
    const tbody = tbl.querySelector('tbody');
    if (tbody) tbody.innerHTML = '';
    return tbody;
  }

  // ================================================================
  // SVG chart builders
  // ================================================================

  /** Sparkline: dots connected by a polyline */
  function renderSparkline(containerId, values) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!values || values.length === 0) { el.innerHTML = '<span class="panel-empty">No data points yet. Run evals to see pass rate trends.</span>'; return; }

    const W = 600, H = 120, PAD = 30;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const pts = values.map(function(v, i) {
      const x = PAD + (i / Math.max(values.length - 1, 1)) * (W - PAD * 2);
      const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
      return { x: x, y: y, v: v };
    });

    const polyline = pts.map(function(p) { return p.x + ',' + p.y; }).join(' ');
    const dots = pts.map(function(p) {
      return '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#4ade80" />';
    }).join('');

    // Y-axis labels
    const yLabels = '<text x="4" y="' + (PAD + 4) + '">' + Math.round(max * 100) + '%</text>'
      + '<text x="4" y="' + (H - PAD + 4) + '">' + Math.round(min * 100) + '%</text>';

    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">'
      + yLabels
      + '<polyline points="' + polyline + '" fill="none" stroke="#4ade80" stroke-width="2" />'
      + dots
      + '</svg>';
  }

  /** Horizontal bar chart */
  function renderHBarChart(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items || items.length === 0) { el.innerHTML = '<span class="panel-empty">No activity to chart yet. Ship PRs to see the breakdown.</span>'; return; }

    const W = 600, barH = 28, gap = 6;
    const H = items.length * (barH + gap) + 20;
    const maxVal = Math.max(...items.map(function(d) { return d.value; }), 1);
    const LABEL_W = 120, BAR_AREA = W - LABEL_W - 60;

    let bars = '';
    items.forEach(function(item, i) {
      const y = i * (barH + gap) + 10;
      const bw = Math.max((item.value / maxVal) * BAR_AREA, 2);
      bars += '<text x="' + (LABEL_W - 8) + '" y="' + (y + barH / 2 + 4) + '" text-anchor="end" fill="#ccc" font-size="12">'
        + escapeHTML(item.label) + '</text>';
      bars += '<rect x="' + LABEL_W + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="4" fill="#4ade80" opacity="0.8" />';
      bars += '<text x="' + (LABEL_W + bw + 8) + '" y="' + (y + barH / 2 + 4) + '" fill="#888" font-size="12">' + item.value + '</text>';
    });

    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + bars + '</svg>';
  }

  /** Vertical bar chart (for weekly cost) */
  function renderVBarChart(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items || items.length === 0) { el.innerHTML = '<span class="panel-empty">No cost data yet. Eval costs appear here after runs are pushed.</span>'; return; }

    const W = 600, H = 180, PAD_BOTTOM = 40, PAD_TOP = 20, PAD_LEFT = 50;
    const maxVal = Math.max(...items.map(function(d) { return d.value; }), 0.01);
    const barW = Math.min(50, (W - PAD_LEFT - 20) / items.length - 8);
    const chartH = H - PAD_BOTTOM - PAD_TOP;

    let bars = '';
    items.forEach(function(item, i) {
      const x = PAD_LEFT + i * ((W - PAD_LEFT - 20) / items.length) + 4;
      const bh = Math.max((item.value / maxVal) * chartH, 2);
      const y = PAD_TOP + chartH - bh;
      bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bh + '" rx="3" fill="#4ade80" opacity="0.8" />';
      // Value on top
      bars += '<text x="' + (x + barW / 2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="10" fill="#888">$' + item.value.toFixed(2) + '</text>';
      // Label at bottom
      bars += '<text x="' + (x + barW / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#666">' + escapeHTML(item.label) + '</text>';
    });

    // Y-axis line
    bars += '<line x1="' + PAD_LEFT + '" y1="' + PAD_TOP + '" x2="' + PAD_LEFT + '" y2="' + (H - PAD_BOTTOM) + '" stroke="#333" />';

    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + bars + '</svg>';
  }

  /** Minimal HTML escape for chart labels (numbers + short strings we control) */
  function escapeHTML(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ================================================================
  // Render functions
  // ================================================================

  function renderAll() {
    renderOverview();
    renderEvals();
    renderShips();
    renderCosts();
    renderLeaderboard();
    renderQA();
  }

  // ---- Overview ----
  function renderOverview() {
    const ws = weekStart();

    // Stat cards
    if (data.evalRuns) {
      const thisWeek = data.evalRuns.filter(function(r) { return new Date(r.timestamp) >= ws; });
      document.getElementById('stat-evals-week').textContent = thisWeek.length;
    }
    if (data.shipLogs) {
      const thisWeek = data.shipLogs.filter(function(r) { return new Date(r.created_at) >= ws; });
      document.getElementById('stat-ships-week').textContent = thisWeek.length;
    }
    if (data.heartbeats) {
      const active = data.heartbeats.filter(function(h) { return withinMinutes(h.timestamp, 15); });
      // Count unique hostnames
      const uniqueHosts = new Set(active.map(function(h) { return h.hostname || h.user_id; }));
      document.getElementById('stat-active-now').textContent = uniqueHosts.size;
    }
    if (data.evalCosts) {
      const thisWeek = data.evalCosts.filter(function(c) { return new Date(c.created_at) >= ws; });
      const total = thisWeek.reduce(function(s, c) { return s + Number(c.estimated_cost_usd || 0); }, 0);
      document.getElementById('stat-cost-week').textContent = fmtCost(total);
    }

    // Recent eval runs table (last 10)
    if (data.evalRuns === null) {
      showPanelError('tbl-overview-evals', 'empty-overview-evals');
    } else {
      const tbody = clearTbody('tbl-overview-evals');
      const rows = data.evalRuns.slice(0, 10);
      rows.forEach(function(r) {
        const rate = r.total_tests ? ((r.passed / r.total_tests) * 100).toFixed(0) + '%' : '-';
        tbody.appendChild(makeRow([fmtDate(r.timestamp), r.branch || '-', rate, fmtCost(r.total_cost_usd)]));
      });
      toggleEmpty('tbl-overview-evals', 'empty-overview-evals', rows.length > 0);
    }

    // Recent ships table (last 10)
    if (data.shipLogs === null) {
      showPanelError('tbl-overview-ships', 'empty-overview-ships');
    } else {
      const tbody = clearTbody('tbl-overview-ships');
      const rows = data.shipLogs.slice(0, 10);
      rows.forEach(function(r) {
        const pr = r.pr_url ? { href: r.pr_url, text: 'PR' } : '-';
        tbody.appendChild(makeRow([fmtDate(r.created_at), r.version || '-', r.branch || '-', pr]));
      });
      toggleEmpty('tbl-overview-ships', 'empty-overview-ships', rows.length > 0);
    }
  }

  // ---- Evals ----
  function renderEvals() {
    if (data.evalRuns === null) {
      showPanelError('tbl-evals', 'empty-evals');
      return;
    }

    // Sparkline — pass rate for last 20 runs (oldest first for left-to-right)
    const last20 = data.evalRuns.slice(0, 20).reverse();
    const rates = last20.map(function(r) {
      return r.total_tests ? r.passed / r.total_tests : 0;
    });
    renderSparkline('chart-sparkline', rates);

    // Table
    const tbody = clearTbody('tbl-evals');
    const rows = data.evalRuns.slice(0, 20);
    rows.forEach(function(r) {
      const rate = r.total_tests ? ((r.passed / r.total_tests) * 100).toFixed(0) + '%' : '-';
      tbody.appendChild(makeRow([
        fmtDate(r.timestamp),
        r.hostname || '-',
        r.branch || '-',
        rate,
        fmtCost(r.total_cost_usd),
        r.tier || '-'
      ]));
    });
    toggleEmpty('tbl-evals', 'empty-evals', rows.length > 0);
  }

  // ---- Ships ----
  function renderShips() {
    if (data.shipLogs === null) {
      showPanelError('tbl-ships', 'empty-ships');
      return;
    }

    // Table
    const tbody = clearTbody('tbl-ships');
    const rows = data.shipLogs.slice(0, 20);
    rows.forEach(function(r) {
      const pr = r.pr_url ? { href: r.pr_url, text: 'PR' } : '-';
      tbody.appendChild(makeRow([fmtDate(r.created_at), r.version || '-', r.branch || '-', pr]));
    });
    toggleEmpty('tbl-ships', 'empty-ships', rows.length > 0);

    // Ships per person this week (horizontal bar chart)
    const ws = weekStart();
    const thisWeek = data.shipLogs.filter(function(r) { return new Date(r.created_at) >= ws; });
    const counts = {};
    thisWeek.forEach(function(r) {
      const who = r.user_id || 'unknown';
      counts[who] = (counts[who] || 0) + 1;
    });
    const items = Object.keys(counts).map(function(k) {
      return { label: k.slice(0, 8), value: counts[k] };
    }).sort(function(a, b) { return b.value - a.value; });
    renderHBarChart('chart-ships-per-person', items);
  }

  // ---- Costs ----
  function renderCosts() {
    if (data.evalCosts === null) return;

    // Total all-time
    const allTime = data.evalCosts.reduce(function(s, c) { return s + Number(c.estimated_cost_usd || 0); }, 0);
    document.getElementById('stat-cost-total').textContent = fmtCost(allTime);

    // Weekly cost trend — last 8 weeks
    const now = new Date();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(now);
      start.setDate(start.getDate() - (i * 7 + now.getDay()));
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const label = (start.getMonth() + 1) + '/' + start.getDate();
      const weekCosts = data.evalCosts.filter(function(c) {
        const d = new Date(c.created_at);
        return d >= start && d < end;
      });
      const total = weekCosts.reduce(function(s, c) { return s + Number(c.estimated_cost_usd || 0); }, 0);
      weeks.push({ label: label, value: total });
    }
    renderVBarChart('chart-weekly-cost', weeks);
  }

  // ---- Leaderboard ----
  // NOTE: This leaderboard aggregation mirrors lib/dashboard-queries.ts computeLeaderboard().
  // If you change the logic here, update the shared pure function too (used by CLI).
  function renderLeaderboard() {
    const ws = weekStart();
    const hasAnyData = data.evalRuns || data.shipLogs || data.transcripts;
    if (!hasAnyData) {
      showPanelError('tbl-leaderboard', 'empty-leaderboard');
      return;
    }

    // Aggregate per user_id
    const board = {};
    function ensure(uid) {
      if (!board[uid]) board[uid] = { ships: 0, evals: 0, sessions: 0, passed: 0, total_tests: 0, cost: 0, online: false };
    }

    if (data.shipLogs) {
      data.shipLogs.filter(function(r) { return new Date(r.created_at) >= ws; }).forEach(function(r) {
        const uid = r.user_id || 'unknown';
        ensure(uid);
        board[uid].ships++;
      });
    }
    if (data.evalRuns) {
      data.evalRuns.filter(function(r) { return new Date(r.timestamp) >= ws; }).forEach(function(r) {
        const uid = r.user_id || r.hostname || 'unknown';
        ensure(uid);
        board[uid].evals++;
        board[uid].passed += r.passed || 0;
        board[uid].total_tests += r.total_tests || 0;
        board[uid].cost += Number(r.total_cost_usd || 0);
      });
    }
    if (data.transcripts) {
      data.transcripts.filter(function(r) { return new Date(r.started_at) >= ws; }).forEach(function(r) {
        const uid = r.user_id || 'unknown';
        ensure(uid);
        board[uid].sessions++;
      });
    }
    // Online status from heartbeats (also capture repo_slug)
    if (data.heartbeats) {
      data.heartbeats.forEach(function(h) {
        const uid = h.user_id || h.hostname;
        if (uid && board[uid] && withinMinutes(h.timestamp, 15)) {
          board[uid].online = true;
          if (h.repo_slug) board[uid].repo = h.repo_slug;
        }
      });
    }

    // Compute streak badges from ship_logs (consecutive ship days this week)
    const streaks = {};
    if (data.shipLogs) {
      const byUser = {};
      data.shipLogs.filter(function(r) { return new Date(r.created_at) >= ws; }).forEach(function(r) {
        const uid = r.user_id || 'unknown';
        if (!byUser[uid]) byUser[uid] = new Set();
        byUser[uid].add(new Date(r.created_at).toISOString().slice(0, 10));
      });
      Object.keys(byUser).forEach(function(uid) {
        const dates = Array.from(byUser[uid]).sort();
        let maxRun = 1, run = 1;
        for (let i = 1; i < dates.length; i++) {
          const prev = new Date(dates[i - 1]);
          const curr = new Date(dates[i]);
          const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
          if (diffDays === 1) { run++; if (run > maxRun) maxRun = run; }
          else { run = 1; }
        }
        streaks[uid] = maxRun;
      });
    }

    // Sort by ships desc, then evals desc
    const sorted = Object.keys(board).map(function(uid) {
      return Object.assign({ uid: uid }, board[uid]);
    }).sort(function(a, b) { return (b.ships + b.evals) - (a.ships + a.evals); });

    const tbody = clearTbody('tbl-leaderboard');
    sorted.forEach(function(entry, i) {
      const rate = entry.total_tests ? ((entry.passed / entry.total_tests) * 100).toFixed(0) + '%' : '-';
      const streak = streaks[entry.uid] || 0;
      const streakBadge = streak >= 5 ? '\u{1F525}\u{1F525} ' : (streak >= 3 ? '\u{1F525} ' : '');
      const displayName = entry.uid.slice(0, 8) + (entry.repo ? ' &mdash; ' + escapeHTML(entry.repo) : '');
      const nameCell = entry.online
        ? { html: '<span class="online-dot"></span>' + streakBadge + displayName }
        : { html: streakBadge + displayName };
      tbody.appendChild(makeRow([
        i + 1,
        nameCell,
        entry.ships,
        entry.evals,
        entry.sessions,
        rate,
        fmtCost(entry.cost)
      ]));
    });
    toggleEmpty('tbl-leaderboard', 'empty-leaderboard', sorted.length > 0);
  }

  // ---- QA ----
  function renderQA() {
    if (data.qaReports === null) {
      showPanelError('tbl-qa', 'empty-qa');
      return;
    }

    const tbody = clearTbody('tbl-qa');
    const rows = data.qaReports.slice(0, 20);
    rows.forEach(function(r) {
      const score = Number(r.health_score);
      const scoreText = isNaN(score) ? '-' : score.toFixed(0);
      const cls = score > 80 ? 'score-green' : (score >= 50 ? 'score-yellow' : 'score-red');
      const scoreCell = { html: '<span class="' + cls + '">' + escapeHTML(scoreText) + '</span>' };
      tbody.appendChild(makeRow([fmtDate(r.created_at), r.repo_slug || '-', scoreCell]));
    });
    toggleEmpty('tbl-qa', 'empty-qa', rows.length > 0);
  }

  // ================================================================
  // Tab switching
  // ================================================================

  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      tab.classList.add('active');
      const panelId = 'panel-' + tab.getAttribute('data-tab');
      document.getElementById(panelId).classList.add('active');
    });
  });

  // ================================================================
  // Event listeners
  // ================================================================

  document.getElementById('btn-login').addEventListener('click', startLogin);
  document.getElementById('btn-signout').addEventListener('click', signOut);

  // ================================================================
  // Init
  // ================================================================

  (async function init() {
    // Check for OAuth callback code in URL
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      await exchangeCode(code);
      return;
    }

    // Try to restore existing session
    const restored = await restoreSession();
    if (restored) {
      showDashboard();
    } else {
      showLogin();
    }
  })();

})();
</script>
</body>
</html>`;
}
