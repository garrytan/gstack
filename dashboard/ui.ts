/**
 * gstack Dashboard — Complete SPA UI
 *
 * Self-contained HTML/CSS/JS served as a single string.
 * Dark + Light themes, SVG charts, vanilla JS, no dependencies.
 *
 * Views:
 *   1. Overview      — Sprint pipeline + key metrics + activity
 *   2. QA            — QA reports, health scores, bug severity
 *   3. Performance   — Benchmarks, Core Web Vitals, trends
 *   4. Canary        — Production health monitoring
 *   5. Design        — Design review scores + radar chart
 *   6. Analytics     — Skill usage, success rates, timelines
 *   7. Browser       — Console/network/dialog logs
 *   8. Eureka        — Eureka moment timeline
 */

export function getDashboardHTML(serverPort: number): string {
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gstack Dashboard</title>
<style>
/* ─── Reset & Base ──────────────────────────── */
* { margin: 0; padding: 0; box-sizing: border-box; }
/* ─── Dark theme (default) ──────────────────── */
:root, [data-theme="dark"] {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --bg-card: #161b22;
  --border: #30363d;
  --border-light: #21262d;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #484f58;
  --accent-blue: #58a6ff;
  --accent-green: #3fb950;
  --accent-yellow: #d29922;
  --accent-orange: #db6d28;
  --accent-red: #f85149;
  --accent-purple: #bc8cff;
  --accent-pink: #f778ba;
  --accent-cyan: #39d2c0;
  --chart-label: #8b949e;
  --chart-value: #484f58;
  --chart-grid: #21262d;
  --chart-accent: #58a6ff;
  --chart-area-start: rgba(88,166,255,0.2);
  --chart-area-end: rgba(88,166,255,0.02);
  --chart-radar-fill: rgba(88,166,255,0.15);
  --ring-track: #21262d;
  --ring-green: #3fb950;
  --ring-yellow: #d29922;
  --ring-red: #f85149;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  --radius: 8px;
  --radius-lg: 12px;
  --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
  --transition: 150ms ease;
}

/* ─── Light theme ───────────────────────────── */
[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-tertiary: #eef1f5;
  --bg-card: #ffffff;
  --border: #d1d9e0;
  --border-light: #e8ecf0;
  --text-primary: #1f2328;
  --text-secondary: #59636e;
  --text-muted: #8b949e;
  --accent-blue: #0969da;
  --accent-green: #1a7f37;
  --accent-yellow: #9a6700;
  --accent-orange: #bc4c00;
  --accent-red: #d1242f;
  --accent-purple: #8250df;
  --accent-pink: #bf3989;
  --accent-cyan: #0e8a7a;
  --chart-label: #59636e;
  --chart-value: #8b949e;
  --chart-grid: #e8ecf0;
  --chart-accent: #0969da;
  --chart-area-start: rgba(9,105,218,0.15);
  --chart-area-end: rgba(9,105,218,0.02);
  --chart-radar-fill: rgba(9,105,218,0.12);
  --ring-track: #e8ecf0;
  --ring-green: #1a7f37;
  --ring-yellow: #9a6700;
  --ring-red: #d1242f;
  --shadow: 0 1px 3px rgba(31,35,40,0.08), 0 1px 2px rgba(31,35,40,0.06);
  --shadow-lg: 0 4px 12px rgba(31,35,40,0.1);
}

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  height: 100vh;
  overflow: hidden;
  display: flex;
  transition: background var(--transition), color var(--transition);
}
/* Smooth theme transitions on key elements */
.sidebar, .main-header, .card, .nav-item, .log-viewer,
.vital-card, .eureka-card, .pipeline-stage, .badge, .tab {
  transition: background var(--transition), color var(--transition),
              border-color var(--transition), box-shadow var(--transition);
}
/* Light mode card shadow */
[data-theme="light"] .card {
  box-shadow: var(--shadow);
}
[data-theme="light"] .pipeline-stage.active {
  box-shadow: 0 0 12px rgba(9, 105, 218, 0.12);
}

/* ─── Sidebar ───────────────────────────────── */
.sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.sidebar-header {
  padding: 20px 16px 16px;
  border-bottom: 1px solid var(--border);
}
.sidebar-logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.5px;
}
.sidebar-logo span {
  color: var(--accent-blue);
}
.sidebar-subtitle {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  font-family: var(--font-mono);
}
.sidebar-nav {
  flex: 1;
  padding: 8px;
  overflow-y: auto;
}
.nav-section {
  margin-bottom: 8px;
}
.nav-section-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 8px 4px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  transition: all var(--transition);
  user-select: none;
}
.nav-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.nav-item.active {
  background: rgba(88, 166, 255, 0.1);
  color: var(--accent-blue);
}
.nav-icon {
  width: 18px;
  text-align: center;
  font-size: 14px;
}
.nav-badge {
  margin-left: auto;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-family: var(--font-mono);
}
.nav-item.active .nav-badge {
  background: rgba(88, 166, 255, 0.15);
  color: var(--accent-blue);
}

/* Sidebar footer */
.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.daemon-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-red);
}
.daemon-dot.alive {
  background: var(--accent-green);
  box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
}
.daemon-label {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

/* ─── Theme Toggle ──────────────────────────── */
.theme-toggle {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  width: 32px;
  height: 32px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  transition: all var(--transition);
  flex-shrink: 0;
  line-height: 1;
  padding: 0;
}
.theme-toggle:hover {
  background: var(--border);
  color: var(--text-primary);
}
.theme-toggle .icon-sun,
.theme-toggle .icon-moon { display: none; }
[data-theme="dark"] .theme-toggle .icon-sun { display: inline; }
[data-theme="light"] .theme-toggle .icon-moon { display: inline; }
/* Default (no attribute yet) shows sun */
:root:not([data-theme]) .theme-toggle .icon-sun { display: inline; }

/* ─── Main Content ──────────────────────────── */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.main-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-secondary);
}
.main-title {
  font-size: 16px;
  font-weight: 600;
}
.main-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.refresh-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  font-family: var(--font-mono);
  transition: all var(--transition);
}
.refresh-btn:hover {
  background: var(--border);
  color: var(--text-primary);
}
.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* ─── Cards ─────────────────────────────────── */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.card-value {
  font-size: 32px;
  font-weight: 700;
  font-family: var(--font-mono);
  line-height: 1;
}

/* ─── Grid Layouts ──────────────────────────── */
.grid-4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.grid-2-1 {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

/* ─── Pipeline ──────────────────────────────── */
.pipeline {
  display: flex;
  gap: 4px;
  align-items: stretch;
  margin-bottom: 24px;
}
.pipeline-stage {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 12px;
  text-align: center;
  position: relative;
  transition: all var(--transition);
}
.pipeline-stage.active {
  border-color: var(--accent-blue);
  box-shadow: 0 0 12px rgba(88, 166, 255, 0.15);
}
.pipeline-stage.completed {
  border-color: var(--accent-green);
}
.pipeline-icon {
  font-size: 24px;
  margin-bottom: 8px;
}
.pipeline-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.pipeline-skills {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.pipeline-time {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 8px;
  font-family: var(--font-mono);
}
.pipeline-arrow {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  font-size: 16px;
  padding: 0 2px;
}
.pipeline-status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin: 8px auto 0;
}
.pipeline-status.idle { background: var(--text-muted); }
.pipeline-status.active { background: var(--accent-blue); box-shadow: 0 0 6px rgba(88,166,255,0.4); }
.pipeline-status.completed { background: var(--accent-green); }

/* ─── Metric Cards ──────────────────────────── */
.metric-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  font-family: var(--font-mono);
}
.metric-trend {
  font-size: 12px;
  margin-top: 4px;
}
.metric-trend.up { color: var(--accent-green); }
.metric-trend.down { color: var(--accent-red); }

/* ─── Tables ────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th {
  text-align: left;
  padding: 10px 12px;
  color: var(--text-muted);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text-secondary);
}
tr:hover td {
  background: rgba(88, 166, 255, 0.03);
}
.mono { font-family: var(--font-mono); font-size: 12px; }

/* ─── Status Badges ─────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  font-family: var(--font-mono);
}
.badge-green { background: rgba(63,185,80,0.15); color: var(--accent-green); }
.badge-yellow { background: rgba(210,153,34,0.15); color: var(--accent-yellow); }
.badge-red { background: rgba(248,81,73,0.15); color: var(--accent-red); }
.badge-blue { background: rgba(88,166,255,0.15); color: var(--accent-blue); }
.badge-purple { background: rgba(188,140,255,0.15); color: var(--accent-purple); }

/* ─── Bar Charts ────────────────────────────── */
.bar-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bar-label {
  width: 120px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  text-align: right;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-track {
  flex: 1;
  height: 24px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 600ms ease;
  min-width: 2px;
}
.bar-value {
  width: 60px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

/* ─── SVG Charts ────────────────────────────── */
.chart-container {
  width: 100%;
  overflow: hidden;
}
.chart-container svg {
  width: 100%;
  height: auto;
}

/* ─── Log Viewer ────────────────────────────── */
.log-viewer {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-height: 500px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.log-entry {
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-light);
  display: flex;
  gap: 8px;
}
.log-entry:hover { background: var(--bg-tertiary); }
.log-ts {
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
.log-level {
  width: 48px;
  flex-shrink: 0;
  font-weight: 600;
}
.log-level.error { color: var(--accent-red); }
.log-level.warn { color: var(--accent-yellow); }
.log-level.info { color: var(--accent-blue); }
.log-level.log { color: var(--text-muted); }
.log-text {
  color: var(--text-secondary);
  word-break: break-all;
}
.log-method {
  font-weight: 600;
  width: 48px;
  flex-shrink: 0;
}
.log-method.GET { color: var(--accent-green); }
.log-method.POST { color: var(--accent-blue); }
.log-method.PUT { color: var(--accent-yellow); }
.log-method.DELETE { color: var(--accent-red); }
.log-status { width: 36px; flex-shrink: 0; }
.log-status.s2xx { color: var(--accent-green); }
.log-status.s3xx { color: var(--accent-yellow); }
.log-status.s4xx { color: var(--accent-orange); }
.log-status.s5xx { color: var(--accent-red); }

/* ─── Eureka Cards ──────────────────────────── */
.eureka-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-yellow);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
}
.eureka-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  margin-bottom: 8px;
}
.eureka-insight {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.5;
}

/* ─── Empty State ───────────────────────────── */
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-muted);
}
.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.empty-text {
  font-size: 13px;
  max-width: 400px;
  margin: 0 auto;
  line-height: 1.5;
}

/* ─── Tabs ──────────────────────────────────── */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}
.tab {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all var(--transition);
  margin-bottom: -1px;
}
.tab:hover { color: var(--text-secondary); }
.tab.active {
  color: var(--accent-blue);
  border-bottom-color: var(--accent-blue);
}

/* ─── Report Detail ─────────────────────────── */
.report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.report-date {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}

/* ─── Health Score ──────────────────────────── */
.health-score {
  display: flex;
  align-items: center;
  gap: 12px;
}
.health-ring {
  position: relative;
  width: 80px;
  height: 80px;
}
.health-ring svg {
  transform: rotate(-90deg);
}
.health-ring-value {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 20px;
  font-weight: 700;
  font-family: var(--font-mono);
}

/* ─── Vitals Gauges ─────────────────────────── */
.vitals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.vital-card {
  background: var(--bg-tertiary);
  border-radius: var(--radius);
  padding: 14px;
  text-align: center;
}
.vital-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 6px;
}
.vital-value {
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-mono);
}
.vital-unit {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* ─── Radar Chart ───────────────────────────── */
.radar-container {
  display: flex;
  justify-content: center;
  padding: 20px;
}

/* ─── Scrollbar ─────────────────────────────── */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover { background: var(--border); }

/* ─── Animations ────────────────────────────── */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.loading { animation: pulse 1.5s ease-in-out infinite; }

/* ─── View visibility ───────────────────────── */
.view { display: none; }
.view.active { display: block; }

/* ─── Responsive ────────────────────────────── */
@media (max-width: 1200px) {
  .grid-4 { grid-template-columns: repeat(2, 1fr); }
}
/* ─── Stage Mode ────────────────────────────── */
body.stage-mode .sidebar { display: none; }
body.stage-mode .main-header { display: none; }
body.stage-mode .main-content { padding: 32px 48px; }
body.stage-mode .view { display: none !important; }
body.stage-mode #view-stage { display: block !important; }

/* Stage branding */
.stage-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 32px;
}
.stage-brand-left {
  display: flex;
  align-items: baseline;
  gap: 16px;
}
.stage-brand h1 {
  font-size: 36px;
  font-weight: 800;
  letter-spacing: -1px;
}
.stage-brand h1 span { color: var(--accent-blue); }
.stage-brand-sub {
  font-size: 14px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.stage-brand-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.stage-branch {
  font-size: 13px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 6px 14px;
  border-radius: 20px;
}
.stage-clock {
  font-size: 36px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

/* Stage pipeline — large */
.stage-pipeline {
  display: flex;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 32px;
}
.stage-pipeline-stage {
  flex: 1;
  background: var(--bg-card);
  border: 2px solid var(--border);
  border-radius: 16px;
  padding: 24px 16px;
  text-align: center;
  transition: all 400ms ease;
  position: relative;
  overflow: hidden;
}
.stage-pipeline-stage.active {
  border-color: var(--accent-blue);
  box-shadow: 0 0 24px rgba(88, 166, 255, 0.2);
}
.stage-pipeline-stage.active::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(135deg, rgba(88,166,255,0.06) 0%, transparent 60%);
  pointer-events: none;
}
.stage-pipeline-stage.completed {
  border-color: var(--accent-green);
}
.stage-pipeline-stage.completed::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(135deg, rgba(63,185,80,0.06) 0%, transparent 60%);
  pointer-events: none;
}
.stage-pipeline-icon { font-size: 36px; margin-bottom: 8px; }
.stage-pipeline-name {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 4px;
}
.stage-pipeline-skills {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.stage-pipeline-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  margin: 10px auto 0;
}
.stage-pipeline-dot.idle { background: var(--text-muted); opacity: 0.4; }
.stage-pipeline-dot.active {
  background: var(--accent-blue);
  box-shadow: 0 0 10px rgba(88,166,255,0.6);
  animation: stage-pulse 1.5s ease-in-out infinite;
}
.stage-pipeline-dot.completed { background: var(--accent-green); }
.stage-pipeline-arrow {
  display: flex;
  align-items: center;
  color: var(--border);
  font-size: 22px;
  padding: 0 2px;
}

@keyframes stage-pulse {
  0%, 100% { box-shadow: 0 0 10px rgba(88,166,255,0.6); transform: scale(1); }
  50% { box-shadow: 0 0 20px rgba(88,166,255,0.9); transform: scale(1.3); }
}

/* Stage metrics — big counters */
.stage-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin-bottom: 32px;
}
.stage-metric {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
  text-align: center;
}
.stage-metric-value {
  font-size: 56px;
  font-weight: 800;
  font-family: var(--font-mono);
  line-height: 1;
  transition: color 300ms ease;
}
.stage-metric-label {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Stage activity feed */
.stage-feed {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 20px;
}
.stage-feed-list {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
  max-height: 320px;
  overflow-y: auto;
}
.stage-feed-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}
.feed-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-light);
  animation: feed-slide-in 400ms ease;
}
.feed-item:last-child { border-bottom: none; }
@keyframes feed-slide-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
.feed-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.feed-skill {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-blue);
  width: 140px;
  flex-shrink: 0;
}
.feed-text {
  font-size: 13px;
  color: var(--text-secondary);
  flex: 1;
}
.feed-time {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

/* Stage top skills sidebar */
.stage-skills-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
}
.stage-skill-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-light);
}
.stage-skill-row:last-child { border-bottom: none; }
.stage-skill-name {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-secondary);
  width: 110px;
  flex-shrink: 0;
}
.stage-skill-bar {
  flex: 1;
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  overflow: hidden;
}
.stage-skill-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 800ms ease;
}
.stage-skill-count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  width: 40px;
  text-align: right;
  flex-shrink: 0;
}

/* Light mode adjustments for stage */
[data-theme="light"] .stage-pipeline-stage.active {
  box-shadow: 0 0 24px rgba(9,105,218,0.15);
}
[data-theme="light"] .stage-pipeline-dot.active {
  background: var(--accent-blue);
  box-shadow: 0 0 10px rgba(9,105,218,0.5);
}

@media (max-width: 900px) {
  .sidebar { width: 56px; min-width: 56px; }
  .sidebar-header, .nav-section-title, .nav-item span, .nav-badge, .sidebar-subtitle, .daemon-label { display: none; }
  .sidebar-logo { font-size: 14px; padding: 12px 0; text-align: center; }
  .nav-item { justify-content: center; padding: 10px; }
  .nav-icon { width: auto; font-size: 18px; }
  .sidebar-footer { justify-content: center; }
  .pipeline { flex-wrap: wrap; }
  .pipeline-arrow { display: none; }
  .grid-4, .grid-3 { grid-template-columns: repeat(2, 1fr); }
  .grid-2-1 { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<!-- ─── Sidebar ──────────────────────────────── -->
<nav class="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-logo">g<span>stack</span></div>
    <div class="sidebar-subtitle" id="branch-info">loading...</div>
  </div>
  <div class="sidebar-nav">
    <div class="nav-section">
      <div class="nav-section-title">Dashboard</div>
      <div class="nav-item active" data-view="overview" onclick="switchView('overview')">
        <span class="nav-icon">&#9671;</span>
        <span>Overview</span>
      </div>
      <div class="nav-item" data-view="pipeline" onclick="switchView('pipeline')">
        <span class="nav-icon">&#9654;</span>
        <span>Pipeline</span>
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Reports</div>
      <div class="nav-item" data-view="qa" onclick="switchView('qa')">
        <span class="nav-icon">&#10004;</span>
        <span>QA</span>
        <span class="nav-badge" id="qa-count">0</span>
      </div>
      <div class="nav-item" data-view="performance" onclick="switchView('performance')">
        <span class="nav-icon">&#9889;</span>
        <span>Performance</span>
        <span class="nav-badge" id="perf-count">0</span>
      </div>
      <div class="nav-item" data-view="canary" onclick="switchView('canary')">
        <span class="nav-icon">&#9673;</span>
        <span>Canary</span>
        <span class="nav-badge" id="canary-count">0</span>
      </div>
      <div class="nav-item" data-view="design" onclick="switchView('design')">
        <span class="nav-icon">&#9830;</span>
        <span>Design</span>
        <span class="nav-badge" id="design-count">0</span>
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Insights</div>
      <div class="nav-item" data-view="analytics" onclick="switchView('analytics')">
        <span class="nav-icon">&#9783;</span>
        <span>Analytics</span>
      </div>
      <div class="nav-item" data-view="browser" onclick="switchView('browser')">
        <span class="nav-icon">&#9881;</span>
        <span>Browser</span>
      </div>
      <div class="nav-item" data-view="eureka" onclick="switchView('eureka')">
        <span class="nav-icon">&#10023;</span>
        <span>Eureka</span>
        <span class="nav-badge" id="eureka-count">0</span>
      </div>
    </div>
  </div>
  <div class="sidebar-footer">
    <div class="daemon-dot" id="daemon-dot"></div>
    <span class="daemon-label" id="daemon-label">offline</span>
  </div>
</nav>

<!-- ─── Main ─────────────────────────────────── -->
<main class="main">
  <header class="main-header">
    <h1 class="main-title" id="view-title">Overview</h1>
    <div class="main-meta">
      <span id="git-info"></span>
      <button class="refresh-btn" onclick="window.location.search='?mode=stage'" title="Presentation mode">Stage</button>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark theme">
        <span class="icon-sun">&#9728;</span>
        <span class="icon-moon">&#9790;</span>
      </button>
      <button class="refresh-btn" onclick="refreshAll()">Refresh</button>
    </div>
  </header>
  <div class="main-content" id="content">

    <!-- ═══ OVERVIEW VIEW ═══ -->
    <div class="view active" id="view-overview">
      <div class="grid-4" id="overview-metrics"></div>
      <div class="card">
        <div class="card-title">Sprint Pipeline</div>
        <div class="pipeline" id="overview-pipeline"></div>
      </div>
      <div class="grid-2-1">
        <div class="card">
          <div class="card-title">Activity Timeline (30 days)</div>
          <div class="chart-container" id="overview-timeline"></div>
        </div>
        <div class="card">
          <div class="card-title">Top Skills</div>
          <div id="overview-top-skills"></div>
        </div>
      </div>
    </div>

    <!-- ═══ PIPELINE VIEW ═══ -->
    <div class="view" id="view-pipeline">
      <div class="pipeline" id="pipeline-full" style="margin-bottom:24px"></div>
      <div class="grid-2" id="pipeline-details"></div>
    </div>

    <!-- ═══ QA VIEW ═══ -->
    <div class="view" id="view-qa">
      <div id="qa-content"></div>
    </div>

    <!-- ═══ PERFORMANCE VIEW ═══ -->
    <div class="view" id="view-performance">
      <div id="perf-content"></div>
    </div>

    <!-- ═══ CANARY VIEW ═══ -->
    <div class="view" id="view-canary">
      <div id="canary-content"></div>
    </div>

    <!-- ═══ DESIGN VIEW ═══ -->
    <div class="view" id="view-design">
      <div id="design-content"></div>
    </div>

    <!-- ═══ ANALYTICS VIEW ═══ -->
    <div class="view" id="view-analytics">
      <div class="tabs" id="analytics-tabs">
        <div class="tab active" onclick="switchAnalyticsTab('usage')">Usage</div>
        <div class="tab" onclick="switchAnalyticsTab('success')">Success Rate</div>
        <div class="tab" onclick="switchAnalyticsTab('duration')">Duration</div>
      </div>
      <div id="analytics-content"></div>
    </div>

    <!-- ═══ BROWSER VIEW ═══ -->
    <div class="view" id="view-browser">
      <div class="tabs" id="browser-tabs">
        <div class="tab active" onclick="switchBrowserTab('console')">Console</div>
        <div class="tab" onclick="switchBrowserTab('network')">Network</div>
        <div class="tab" onclick="switchBrowserTab('dialog')">Dialog</div>
      </div>
      <div id="browser-content"></div>
    </div>

    <!-- ═══ EUREKA VIEW ═══ -->
    <div class="view" id="view-eureka">
      <div id="eureka-content"></div>
    </div>

    <!-- ═══ STAGE MODE VIEW ═══ -->
    <div class="view" id="view-stage">
      <div class="stage-brand">
        <div class="stage-brand-left">
          <h1>g<span>stack</span></h1>
          <span class="stage-brand-sub" id="stage-repo"></span>
        </div>
        <div class="stage-brand-right">
          <span class="stage-branch" id="stage-branch"></span>
          <span class="stage-clock" id="stage-clock">00:00</span>
        </div>
      </div>

      <div class="stage-pipeline" id="stage-pipeline"></div>

      <div class="stage-metrics" id="stage-metrics"></div>

      <div class="stage-feed">
        <div class="stage-feed-list">
          <div class="stage-feed-title">Live Activity</div>
          <div id="stage-feed-items"></div>
        </div>
        <div class="stage-skills-card">
          <div class="stage-feed-title">Top Skills</div>
          <div id="stage-top-skills"></div>
        </div>
      </div>
    </div>

  </div>
</main>

<script>
// ─── State ──────────────────────────────────────────────────────
const API = '${baseUrl}/api';
let currentView = 'overview';
let currentAnalyticsTab = 'usage';
let currentBrowserTab = 'console';
let cache = {};

// ─── Theme ──────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('gstack-dashboard-theme');
  const theme = saved || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('gstack-dashboard-theme', next);
  // Re-render current view so SVG charts pick up new colors
  cache = {};
  loadView(currentView);
}
function themeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    label: s.getPropertyValue('--chart-label').trim() || '#8b949e',
    value: s.getPropertyValue('--chart-value').trim() || '#484f58',
    grid: s.getPropertyValue('--chart-grid').trim() || '#21262d',
    accent: s.getPropertyValue('--chart-accent').trim() || '#58a6ff',
    areaStart: s.getPropertyValue('--chart-area-start').trim() || 'rgba(88,166,255,0.2)',
    areaEnd: s.getPropertyValue('--chart-area-end').trim() || 'rgba(88,166,255,0.02)',
    radarFill: s.getPropertyValue('--chart-radar-fill').trim() || 'rgba(88,166,255,0.15)',
    ringTrack: s.getPropertyValue('--ring-track').trim() || '#21262d',
    ringGreen: s.getPropertyValue('--ring-green').trim() || '#3fb950',
    ringYellow: s.getPropertyValue('--ring-yellow').trim() || '#d29922',
    ringRed: s.getPropertyValue('--ring-red').trim() || '#f85149',
  };
}
initTheme();

// ─── API Helpers ────────────────────────────────────────────────
async function api(path) {
  try {
    const r = await fetch(API + path);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── Navigation ─────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  const titles = {
    overview: 'Overview', pipeline: 'Sprint Pipeline', qa: 'QA Reports',
    performance: 'Performance', canary: 'Canary Monitor', design: 'Design Review',
    analytics: 'Analytics', browser: 'Browser Sessions', eureka: 'Eureka Log'
  };
  document.getElementById('view-title').textContent = titles[view] || view;
  loadView(view);
}

function switchAnalyticsTab(tab) {
  currentAnalyticsTab = tab;
  document.querySelectorAll('#analytics-tabs .tab').forEach((t, i) => {
    t.classList.toggle('active', ['usage','success','duration'][i] === tab);
  });
  renderAnalytics();
}

function switchBrowserTab(tab) {
  currentBrowserTab = tab;
  document.querySelectorAll('#browser-tabs .tab').forEach((t, i) => {
    t.classList.toggle('active', ['console','network','dialog'][i] === tab);
  });
  renderBrowserLogs();
}

// ─── Data Loading ───────────────────────────────────────────────
async function loadView(view) {
  switch (view) {
    case 'overview': await loadOverview(); break;
    case 'pipeline': await loadPipeline(); break;
    case 'qa': await loadQA(); break;
    case 'performance': await loadPerformance(); break;
    case 'canary': await loadCanary(); break;
    case 'design': await loadDesign(); break;
    case 'analytics': await loadAnalytics(); break;
    case 'browser': await loadBrowser(); break;
    case 'eureka': await loadEureka(); break;
  }
}

async function refreshAll() {
  cache = {};
  await loadView(currentView);
}

// ─── SVG Chart Helpers ──────────────────────────────────────────
function barChartSvg(data, { width = 600, barHeight = 28, maxLabel = 120, color = 'var(--accent-blue)' } = {}) {
  if (!data.length) return '<div class="empty-state"><div class="empty-icon">&#9783;</div><div class="empty-title">No data yet</div></div>';
  const tc = themeColors();
  const max = Math.max(...data.map(d => d.value), 1);
  const h = data.length * (barHeight + 4) + 10;
  const barW = width - maxLabel - 80;
  let svg = '<svg viewBox="0 0 ' + width + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
  data.forEach((d, i) => {
    const y = i * (barHeight + 4) + 4;
    const w = (d.value / max) * barW;
    const fill = d.color || color;
    svg += '<text x="' + (maxLabel - 4) + '" y="' + (y + barHeight / 2 + 4) + '" text-anchor="end" fill="' + tc.label + '" font-size="12" font-family="SF Mono, monospace">' + escHtml(d.label.slice(0, 16)) + '</text>';
    svg += '<rect x="' + maxLabel + '" y="' + y + '" width="' + barW + '" height="' + barHeight + '" rx="4" fill="' + tc.grid + '"/>';
    svg += '<rect x="' + maxLabel + '" y="' + y + '" width="' + Math.max(w, 2) + '" height="' + barHeight + '" rx="4" fill="' + fill + '" opacity="0.8"/>';
    svg += '<text x="' + (maxLabel + barW + 8) + '" y="' + (y + barHeight / 2 + 4) + '" fill="' + tc.value + '" font-size="12" font-family="SF Mono, monospace">' + d.value + (d.suffix || '') + '</text>';
  });
  svg += '</svg>';
  return svg;
}

function timelineSvg(data, { width = 700, height = 160, color = 'var(--accent-blue)' } = {}) {
  if (!data.length) return '';
  const tc = themeColors();
  const max = Math.max(...data.map(d => d.count), 1);
  const padL = 40, padR = 10, padT = 10, padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const step = plotW / Math.max(data.length - 1, 1);

  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">';
  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    const v = Math.round(max * (1 - i / 4));
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="' + tc.grid + '" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="' + tc.value + '" font-size="10" font-family="SF Mono, monospace">' + v + '</text>';
  }

  // Area + line
  let pathD = '';
  let areaD = 'M' + padL + ',' + (padT + plotH);
  data.forEach((d, i) => {
    const x = padL + i * step;
    const y = padT + plotH - (d.count / max) * plotH;
    if (i === 0) { pathD += 'M' + x + ',' + y; }
    else { pathD += 'L' + x + ',' + y; }
    areaD += 'L' + x + ',' + y;
  });
  areaD += 'L' + (padL + (data.length - 1) * step) + ',' + (padT + plotH) + 'Z';

  svg += '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + tc.accent + '" stop-opacity="0.18"/><stop offset="100%" stop-color="' + tc.accent + '" stop-opacity="0.02"/></linearGradient></defs>';
  svg += '<path d="' + areaD + '" fill="url(#areaGrad)"/>';
  svg += '<path d="' + pathD + '" fill="none" stroke="' + tc.accent + '" stroke-width="2" stroke-linejoin="round"/>';

  // Dots
  data.forEach((d, i) => {
    const x = padL + i * step;
    const y = padT + plotH - (d.count / max) * plotH;
    svg += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="' + tc.accent + '"/>';
  });

  // X labels (every nth)
  const labelEvery = Math.max(1, Math.floor(data.length / 8));
  data.forEach((d, i) => {
    if (i % labelEvery === 0 || i === data.length - 1) {
      const x = padL + i * step;
      svg += '<text x="' + x + '" y="' + (height - 6) + '" text-anchor="middle" fill="' + tc.value + '" font-size="10" font-family="SF Mono, monospace">' + d.date.slice(5) + '</text>';
    }
  });

  svg += '</svg>';
  return svg;
}

function radarSvg(dimensions, scores, { size = 300 } = {}) {
  const tc = themeColors();
  const cx = size / 2, cy = size / 2, r = size / 2 - 40;
  const n = dimensions.length;
  const angleStep = (2 * Math.PI) / n;

  let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">';

  // Grid rings
  for (let ring = 2; ring <= 10; ring += 2) {
    const rr = (ring / 10) * r;
    let pts = '';
    for (let i = 0; i < n; i++) {
      const a = i * angleStep - Math.PI / 2;
      pts += (cx + rr * Math.cos(a)) + ',' + (cy + rr * Math.sin(a)) + ' ';
    }
    svg += '<polygon points="' + pts + '" fill="none" stroke="' + tc.grid + '" stroke-width="1"/>';
  }

  // Axis lines + labels
  for (let i = 0; i < n; i++) {
    const a = i * angleStep - Math.PI / 2;
    const x2 = cx + r * Math.cos(a);
    const y2 = cy + r * Math.sin(a);
    svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + tc.grid + '" stroke-width="1"/>';
    const lx = cx + (r + 18) * Math.cos(a);
    const ly = cy + (r + 18) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.1 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
    svg += '<text x="' + lx + '" y="' + (ly + 4) + '" text-anchor="' + anchor + '" fill="' + tc.label + '" font-size="10" font-family="SF Mono, monospace">' + dimensions[i] + '</text>';
  }

  // Data polygon
  let dataPts = '';
  for (let i = 0; i < n; i++) {
    const a = i * angleStep - Math.PI / 2;
    const v = (scores[i] || 0) / 10;
    dataPts += (cx + r * v * Math.cos(a)) + ',' + (cy + r * v * Math.sin(a)) + ' ';
  }
  svg += '<polygon points="' + dataPts + '" fill="' + tc.radarFill + '" stroke="' + tc.accent + '" stroke-width="2"/>';

  // Data dots
  for (let i = 0; i < n; i++) {
    const a = i * angleStep - Math.PI / 2;
    const v = (scores[i] || 0) / 10;
    svg += '<circle cx="' + (cx + r * v * Math.cos(a)) + '" cy="' + (cy + r * v * Math.sin(a)) + '" r="4" fill="' + tc.accent + '"/>';
  }

  svg += '</svg>';
  return svg;
}

function healthRingSvg(score, { size = 80, stroke = 6 } = {}) {
  const tc = themeColors();
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? tc.ringGreen : score >= 50 ? tc.ringYellow : tc.ringRed;

  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + tc.ringTrack + '" stroke-width="' + stroke + '"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + stroke + '" ' +
    'stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" transform="rotate(-90 ' + c + ' ' + c + ')"/>' +
    '<text x="' + c + '" y="' + (c + 6) + '" text-anchor="middle" fill="' + color + '" font-size="18" font-weight="700" font-family="SF Mono, monospace">' + score + '</text>' +
    '</svg>';
}

// ─── Render Helpers ─────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function formatDuration(secs) {
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + 'm ' + s + 's';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function statusBadge(status) {
  if (!status) return '';
  const s = String(status).toUpperCase();
  if (s === 'HEALTHY' || s === 'SHIP_READY' || s === 'SUCCESS') return '<span class="badge badge-green">' + s + '</span>';
  if (s === 'DEGRADED' || s === 'WARNING') return '<span class="badge badge-yellow">' + s + '</span>';
  if (s === 'BROKEN' || s === 'FAILED' || s === 'ERROR') return '<span class="badge badge-red">' + s + '</span>';
  return '<span class="badge badge-blue">' + s + '</span>';
}

function emptyState(icon, title, text) {
  return '<div class="empty-state"><div class="empty-icon">' + icon + '</div><div class="empty-title">' + title + '</div><div class="empty-text">' + text + '</div></div>';
}

// ─── OVERVIEW ───────────────────────────────────────────────────
async function loadOverview() {
  const [overview, pipeline, analytics, skills] = await Promise.all([
    api('/overview'),
    api('/pipeline'),
    api('/analytics/timeline?days=30'),
    api('/analytics/skills?days=30'),
  ]);

  // Metrics cards
  const m = overview?.metrics || {};
  const metricsHtml = [
    { label: 'Total Runs', value: m.totalRuns || 0, color: 'var(--accent-blue)' },
    { label: 'Success Rate', value: (m.successRate || 0) + '%', color: m.successRate >= 80 ? 'var(--accent-green)' : 'var(--accent-yellow)' },
    { label: 'Avg Duration', value: formatDuration(m.avgDuration || 0), color: 'var(--accent-purple)' },
    { label: 'Reports', value: m.reportsTotal || 0, color: 'var(--accent-cyan)' },
  ].map(c => '<div class="card"><div class="card-title">' + c.label + '</div><div class="card-value" style="color:' + c.color + '">' + c.value + '</div><div class="metric-label">last 30 days</div></div>').join('');
  document.getElementById('overview-metrics').innerHTML = metricsHtml;

  // Pipeline
  renderPipeline('overview-pipeline', pipeline?.stages || []);

  // Timeline chart
  const tl = analytics?.timeline || [];
  document.getElementById('overview-timeline').innerHTML = tl.length
    ? timelineSvg(tl)
    : emptyState('&#9783;', 'No activity data', 'Run some gstack skills to see activity here');

  // Top skills
  const stats = (skills?.stats || []).slice(0, 8);
  if (stats.length) {
    document.getElementById('overview-top-skills').innerHTML = barChartSvg(
      stats.map(s => ({ label: '/' + s.name, value: s.runs, suffix: ' runs' })),
      { color: 'var(--accent-blue)' }
    );
  } else {
    document.getElementById('overview-top-skills').innerHTML = emptyState('&#9783;', 'No skills tracked', 'Skill usage appears after running gstack commands');
  }

  // Sidebar updates
  const daemon = overview?.daemon;
  const dot = document.getElementById('daemon-dot');
  const label = document.getElementById('daemon-label');
  if (daemon?.alive) {
    dot.className = 'daemon-dot alive';
    label.textContent = 'daemon :' + (daemon.port || '?');
  } else {
    dot.className = 'daemon-dot';
    label.textContent = 'offline';
  }

  const git = overview?.git || {};
  document.getElementById('branch-info').textContent = git.branch || 'no branch';
  document.getElementById('git-info').textContent = git.remoteSlug ? git.remoteSlug + ' @ ' + (git.branch || '?') : '';

  // Update badge counts
  const [qa, perf, canary, design, eureka] = await Promise.all([
    api('/qa/reports'), api('/benchmark/reports'), api('/canary/reports'),
    api('/design/reports'), api('/eureka?days=90'),
  ]);
  document.getElementById('qa-count').textContent = qa?.reports?.length || 0;
  document.getElementById('perf-count').textContent = perf?.reports?.length || 0;
  document.getElementById('canary-count').textContent = canary?.reports?.length || 0;
  document.getElementById('design-count').textContent = design?.reports?.length || 0;
  document.getElementById('eureka-count').textContent = eureka?.entries?.length || 0;
}

function renderPipeline(containerId, stages) {
  const el = document.getElementById(containerId);
  if (!stages.length) { el.innerHTML = emptyState('&#9654;', 'No pipeline data', 'Sprint pipeline populates as you use gstack skills'); return; }

  el.innerHTML = stages.map((s, i) => {
    const arrow = i < stages.length - 1 ? '<div class="pipeline-arrow">&#8594;</div>' : '';
    return '<div class="pipeline-stage ' + s.status + '">' +
      '<div class="pipeline-icon">' + s.icon + '</div>' +
      '<div class="pipeline-name">' + s.name + '</div>' +
      '<div class="pipeline-skills">' + s.skills.slice(0, 3).map(sk => '/' + sk).join(', ') + '</div>' +
      (s.lastRun ? '<div class="pipeline-time">' + timeAgo(s.lastRun) + '</div>' : '') +
      '<div class="pipeline-status ' + s.status + '"></div>' +
      '</div>' + arrow;
  }).join('');
}

// ─── PIPELINE ───────────────────────────────────────────────────
async function loadPipeline() {
  const data = await api('/pipeline');
  const stages = data?.stages || [];
  renderPipeline('pipeline-full', stages);

  const detailsHtml = stages.map(s =>
    '<div class="card">' +
    '<div class="card-title">' + s.icon + ' ' + s.name + '</div>' +
    '<div style="margin-bottom:8px">' + statusBadge(s.status) + '</div>' +
    '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Skills: ' + s.skills.map(sk => '<span class="badge badge-blue">/' + sk + '</span>').join(' ') + '</div>' +
    (s.reportCount ? '<div style="font-size:12px;color:var(--text-secondary)">' + s.reportCount + ' reports</div>' : '') +
    (s.lastRun ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last: ' + timeAgo(s.lastRun) + '</div>' : '') +
    '</div>'
  ).join('');
  document.getElementById('pipeline-details').innerHTML = detailsHtml;
}

// ─── QA ─────────────────────────────────────────────────────────
async function loadQA() {
  const data = await api('/qa/reports');
  const reports = data?.reports || [];

  if (!reports.length) {
    document.getElementById('qa-content').innerHTML = emptyState('&#10004;', 'No QA reports', 'Run /qa to generate quality assurance reports. Reports are saved to .gstack/qa-reports/');
    return;
  }

  let html = '<div class="grid-3">';
  html += reports.slice(0, 12).map(r => {
    const d = r.data;
    const verdict = d.verdict || d.status || 'N/A';
    const healthBefore = d.health_before?.score ?? d.health_before ?? '?';
    const healthAfter = d.health_after?.score ?? d.health_after ?? '?';
    const fixes = d.fixes?.length || 0;

    return '<div class="card">' +
      '<div class="report-header"><div class="card-title">QA Report</div><div class="report-date">' + r.date + '</div></div>' +
      '<div style="margin-bottom:12px">' + statusBadge(verdict) + '</div>' +
      '<div style="display:flex;gap:16px;margin-bottom:12px">' +
        '<div><div class="vital-label">Before</div><div>' + healthRingSvg(typeof healthBefore === 'number' ? healthBefore : 50, {size:60, stroke:5}) + '</div></div>' +
        '<div><div class="vital-label">After</div><div>' + healthRingSvg(typeof healthAfter === 'number' ? healthAfter : 50, {size:60, stroke:5}) + '</div></div>' +
      '</div>' +
      (fixes ? '<div style="font-size:12px;color:var(--text-secondary)">' + fixes + ' fixes applied</div>' : '') +
      (d.url ? '<div class="mono" style="color:var(--text-muted);margin-top:4px;font-size:11px">' + escHtml(d.url) + '</div>' : '') +
      renderBugSeverity(d) +
      '</div>';
  }).join('');
  html += '</div>';

  document.getElementById('qa-content').innerHTML = html;
}

function renderBugSeverity(d) {
  const before = d.health_before;
  if (!before || typeof before !== 'object') return '';
  const sevs = ['critical', 'high', 'medium', 'low'];
  const colors = ['var(--accent-red)', 'var(--accent-orange)', 'var(--accent-yellow)', 'var(--text-muted)'];
  let bars = '<div style="display:flex;gap:4px;margin-top:8px">';
  sevs.forEach((s, i) => {
    const v = before[s] || 0;
    if (v > 0) bars += '<span class="badge" style="background:' + colors[i] + '20;color:' + colors[i] + '">' + s + ': ' + v + '</span>';
  });
  bars += '</div>';
  return bars;
}

// ─── PERFORMANCE ────────────────────────────────────────────────
async function loadPerformance() {
  const data = await api('/benchmark/reports');
  const reports = data?.reports || [];

  if (!reports.length) {
    document.getElementById('perf-content').innerHTML = emptyState('&#9889;', 'No benchmark reports', 'Run /benchmark to capture Core Web Vitals and performance metrics.');
    return;
  }

  let html = '';
  reports.slice(0, 6).forEach(r => {
    const d = r.data;
    const pages = d.pages || {};
    const pageKeys = Object.keys(pages);

    html += '<div class="card"><div class="report-header"><div class="card-title">Benchmark — ' + escHtml(d.url || 'unknown') + '</div><div class="report-date">' + r.date + '</div></div>';

    if (d.branch) html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Branch: ' + escHtml(d.branch) + '</div>';

    pageKeys.forEach(page => {
      const p = pages[page];
      html += '<div style="margin-bottom:16px"><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">' + escHtml(page) + '</div>';
      html += '<div class="vitals-grid">';

      const vitals = [
        { label: 'TTFB', value: p.ttfb_ms, unit: 'ms', good: 200, bad: 600 },
        { label: 'FCP', value: p.fcp_ms, unit: 'ms', good: 1800, bad: 3000 },
        { label: 'LCP', value: p.lcp_ms, unit: 'ms', good: 2500, bad: 4000 },
        { label: 'DOM Ready', value: p.dom_interactive_ms, unit: 'ms', good: 1500, bad: 3000 },
        { label: 'Full Load', value: p.full_load_ms, unit: 'ms', good: 3000, bad: 5000 },
        { label: 'Requests', value: p.total_requests, unit: '', good: 50, bad: 100 },
        { label: 'Transfer', value: p.total_transfer_bytes ? Math.round(p.total_transfer_bytes / 1024) : null, unit: 'KB', good: 500, bad: 2000 },
        { label: 'JS Bundle', value: p.js_bundle_bytes ? Math.round(p.js_bundle_bytes / 1024) : null, unit: 'KB', good: 200, bad: 500 },
      ];

      vitals.forEach(v => {
        if (v.value == null) return;
        const color = v.value <= v.good ? 'var(--accent-green)' : v.value <= v.bad ? 'var(--accent-yellow)' : 'var(--accent-red)';
        html += '<div class="vital-card"><div class="vital-label">' + v.label + '</div><div class="vital-value" style="color:' + color + '">' + v.value + '</div><div class="vital-unit">' + v.unit + '</div></div>';
      });
      html += '</div></div>';
    });

    // Largest resources
    if (pageKeys.length && pages[pageKeys[0]]?.largest_resources?.length) {
      const resources = pages[pageKeys[0]].largest_resources.slice(0, 5);
      html += '<div style="margin-top:12px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Largest Resources</div>';
      html += '<div class="table-wrap"><table><tr><th>Resource</th><th>Size</th><th>Duration</th></tr>';
      resources.forEach(r => {
        html += '<tr><td class="mono">' + escHtml(r.name || '?') + '</td><td class="mono">' + (r.size ? Math.round(r.size / 1024) + ' KB' : '?') + '</td><td class="mono">' + (r.duration || '?') + 'ms</td></tr>';
      });
      html += '</table></div></div>';
    }

    html += '</div>';
  });

  document.getElementById('perf-content').innerHTML = html;
}

// ─── CANARY ─────────────────────────────────────────────────────
async function loadCanary() {
  const data = await api('/canary/reports');
  const reports = data?.reports || [];

  if (!reports.length) {
    document.getElementById('canary-content').innerHTML = emptyState('&#9673;', 'No canary reports', 'Run /canary after deploying to monitor production health.');
    return;
  }

  let html = '';
  reports.slice(0, 8).forEach(r => {
    const d = r.data;
    const status = d.status || 'UNKNOWN';
    const alerts = d.alerts || [];

    html += '<div class="card"><div class="report-header"><div class="card-title">Canary — ' + escHtml(d.url || 'unknown') + '</div><div class="report-date">' + r.date + '</div></div>';
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' + statusBadge(status);
    if (d.duration_min) html += '<span class="mono" style="color:var(--text-muted)">' + d.duration_min + ' min monitoring</span>';
    html += '</div>';

    // Pages summary
    const pages = d.pages || {};
    const pageKeys = Object.keys(pages);
    if (pageKeys.length) {
      html += '<div class="vitals-grid" style="margin-bottom:16px">';
      pageKeys.forEach(pk => {
        const p = pages[pk];
        const errColor = (p.console_errors || 0) > 0 ? 'var(--accent-red)' : 'var(--accent-green)';
        html += '<div class="vital-card"><div class="vital-label">' + escHtml(pk) + '</div>' +
          '<div class="vital-value" style="font-size:16px;color:' + errColor + '">' + (p.console_errors || 0) + ' errors</div>' +
          '<div class="vital-unit">' + (p.load_time_ms || '?') + 'ms load</div></div>';
      });
      html += '</div>';
    }

    // Alerts
    if (alerts.length) {
      html += '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Alerts (' + alerts.length + ')</div>';
      html += '<div class="table-wrap"><table><tr><th>Type</th><th>Page</th><th>Finding</th><th>When</th></tr>';
      alerts.forEach(a => {
        const typeColor = a.type === 'CRITICAL' ? 'badge-red' : a.type === 'HIGH' ? 'badge-red' : a.type === 'MEDIUM' ? 'badge-yellow' : 'badge-blue';
        html += '<tr><td><span class="badge ' + typeColor + '">' + (a.type || '?') + '</span></td>' +
          '<td class="mono">' + escHtml(a.page || '?') + '</td>' +
          '<td>' + escHtml(a.finding || '?') + '</td>' +
          '<td class="mono">' + escHtml(a.time || a.check_number ? 'check #' + a.check_number : '?') + '</td></tr>';
      });
      html += '</table></div>';
    }

    html += '</div>';
  });

  document.getElementById('canary-content').innerHTML = html;
}

// ─── DESIGN ─────────────────────────────────────────────────────
async function loadDesign() {
  const data = await api('/design/reports');
  const reports = data?.reports || [];

  if (!reports.length) {
    document.getElementById('design-content').innerHTML = emptyState('&#9830;', 'No design reports', 'Run /design-review or /plan-design-review to generate design audit reports.');
    return;
  }

  let html = '';
  reports.slice(0, 6).forEach(r => {
    const d = r.data;

    html += '<div class="card"><div class="report-header"><div class="card-title">Design Review</div><div class="report-date">' + r.date + '</div></div>';

    // Try to find dimension scores
    const dimensions = ['Typography', 'Color', 'Spacing', 'Layout', 'Hierarchy', 'Consistency', 'Accessibility', 'Responsiveness', 'Interaction', 'Polish'];
    const scores = dimensions.map(dim => {
      const key = dim.toLowerCase();
      return d[key] ?? d.scores?.[key] ?? d.dimensions?.[key] ?? null;
    });

    const hasScores = scores.some(s => s !== null);

    if (hasScores) {
      html += '<div class="grid-2"><div class="radar-container">' +
        radarSvg(dimensions, scores.map(s => s ?? 0)) +
        '</div><div class="vitals-grid">';
      dimensions.forEach((dim, i) => {
        if (scores[i] == null) return;
        const v = scores[i];
        const color = v >= 8 ? 'var(--accent-green)' : v >= 5 ? 'var(--accent-yellow)' : 'var(--accent-red)';
        html += '<div class="vital-card"><div class="vital-label">' + dim + '</div><div class="vital-value" style="font-size:18px;color:' + color + '">' + v + '</div><div class="vital-unit">/ 10</div></div>';
      });
      html += '</div></div>';
    }

    // Show issues if available
    const issues = d.issues || d.findings || [];
    if (issues.length) {
      html += '<div style="margin-top:16px"><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Issues (' + issues.length + ')</div>';
      html += '<div class="table-wrap"><table><tr><th>Severity</th><th>Issue</th><th>Recommendation</th></tr>';
      issues.slice(0, 10).forEach(issue => {
        html += '<tr><td>' + statusBadge(issue.severity || 'info') + '</td>' +
          '<td>' + escHtml(issue.issue || issue.description || '?') + '</td>' +
          '<td>' + escHtml(issue.recommendation || issue.fix || '') + '</td></tr>';
      });
      html += '</table></div></div>';
    }

    // Raw data fallback
    if (!hasScores && !issues.length) {
      html += '<pre style="font-size:12px;color:var(--text-muted);overflow-x:auto;white-space:pre-wrap">' + escHtml(JSON.stringify(d, null, 2).slice(0, 2000)) + '</pre>';
    }

    html += '</div>';
  });

  document.getElementById('design-content').innerHTML = html;
}

// ─── ANALYTICS ──────────────────────────────────────────────────
async function loadAnalytics() {
  cache.analyticsSkills = cache.analyticsSkills || await api('/analytics/skills?days=30');
  cache.analyticsTimeline = cache.analyticsTimeline || await api('/analytics/timeline?days=30');
  renderAnalytics();
}

function renderAnalytics() {
  const stats = cache.analyticsSkills?.stats || [];
  const timeline = cache.analyticsTimeline?.timeline || [];
  let html = '';

  if (!stats.length) {
    document.getElementById('analytics-content').innerHTML = emptyState('&#9783;', 'No analytics data', 'Run gstack skills to generate usage analytics.');
    return;
  }

  if (currentAnalyticsTab === 'usage') {
    html += '<div class="card"><div class="card-title">Skill Usage (30 days)</div>';
    html += barChartSvg(stats.map(s => ({ label: '/' + s.name, value: s.runs, suffix: ' runs' })), { color: 'var(--accent-blue)' });
    html += '</div>';

    html += '<div class="card"><div class="card-title">Activity Timeline</div>';
    html += timeline.length ? timelineSvg(timeline) : '<div style="color:var(--text-muted);text-align:center;padding:20px">No timeline data</div>';
    html += '</div>';
  }

  if (currentAnalyticsTab === 'success') {
    html += '<div class="card"><div class="card-title">Success Rate by Skill</div>';
    html += barChartSvg(stats.filter(s => s.runs > 0).map(s => ({
      label: '/' + s.name,
      value: s.successRate,
      suffix: '%',
      color: s.successRate >= 80 ? 'var(--accent-green)' : s.successRate >= 50 ? 'var(--accent-yellow)' : 'var(--accent-red)',
    })));
    html += '</div>';

    html += '<div class="card"><div class="card-title">Error Count by Skill</div>';
    const withErrors = stats.filter(s => s.errors > 0);
    html += withErrors.length
      ? barChartSvg(withErrors.map(s => ({ label: '/' + s.name, value: s.errors, suffix: ' errors', color: 'var(--accent-red)' })))
      : '<div style="color:var(--accent-green);text-align:center;padding:20px">No errors recorded</div>';
    html += '</div>';
  }

  if (currentAnalyticsTab === 'duration') {
    html += '<div class="card"><div class="card-title">Average Duration by Skill</div>';
    html += barChartSvg(stats.filter(s => s.avgDuration > 0).map(s => ({
      label: '/' + s.name,
      value: s.avgDuration,
      suffix: 's',
      color: 'var(--accent-purple)',
    })));
    html += '</div>';

    // Skills using browse
    const browseSkills = stats.filter(s => s.usedBrowse > 0);
    if (browseSkills.length) {
      html += '<div class="card"><div class="card-title">Browser Usage</div>';
      html += barChartSvg(browseSkills.map(s => ({ label: '/' + s.name, value: s.usedBrowse, suffix: ' sessions', color: 'var(--accent-cyan)' })));
      html += '</div>';
    }
  }

  // Stats table
  html += '<div class="card"><div class="card-title">All Skills</div><div class="table-wrap"><table>';
  html += '<tr><th>Skill</th><th>Runs</th><th>Success</th><th>Errors</th><th>Avg Duration</th><th>Browse</th><th>Last Run</th></tr>';
  stats.forEach(s => {
    const srColor = s.successRate >= 80 ? 'badge-green' : s.successRate >= 50 ? 'badge-yellow' : 'badge-red';
    html += '<tr>' +
      '<td class="mono">/' + escHtml(s.name) + '</td>' +
      '<td class="mono">' + s.runs + '</td>' +
      '<td><span class="badge ' + srColor + '">' + s.successRate + '%</span></td>' +
      '<td class="mono">' + (s.errors || '—') + '</td>' +
      '<td class="mono">' + formatDuration(s.avgDuration) + '</td>' +
      '<td class="mono">' + (s.usedBrowse || '—') + '</td>' +
      '<td class="mono" style="color:var(--text-muted)">' + (s.lastRun ? timeAgo(s.lastRun) : '—') + '</td>' +
      '</tr>';
  });
  html += '</table></div></div>';

  document.getElementById('analytics-content').innerHTML = html;
}

// ─── BROWSER LOGS ───────────────────────────────────────────────
async function loadBrowser() {
  cache.consoleLogs = cache.consoleLogs || await api('/logs/console?lines=300');
  cache.networkLogs = cache.networkLogs || await api('/logs/network?lines=300');
  cache.dialogLogs = cache.dialogLogs || await api('/logs/dialog?lines=100');
  renderBrowserLogs();
}

function renderBrowserLogs() {
  let html = '';

  if (currentBrowserTab === 'console') {
    const entries = cache.consoleLogs?.entries || [];
    if (!entries.length) {
      html = emptyState('&#9881;', 'No console logs', 'Browser console output will appear here when the browse daemon is running.');
    } else {
      html = '<div class="log-viewer">';
      entries.slice(-200).forEach(e => {
        const level = (e.level || 'log').toLowerCase();
        const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        html += '<div class="log-entry">' +
          '<span class="log-ts">' + ts + '</span>' +
          '<span class="log-level ' + level + '">' + level + '</span>' +
          '<span class="log-text">' + escHtml(e.text || e.message || JSON.stringify(e)) + '</span>' +
          '</div>';
      });
      html += '</div>';
    }
  }

  if (currentBrowserTab === 'network') {
    const entries = cache.networkLogs?.entries || [];
    if (!entries.length) {
      html = emptyState('&#9881;', 'No network logs', 'Network requests will appear here when the browse daemon is running.');
    } else {
      html = '<div class="log-viewer">';
      entries.slice(-200).forEach(e => {
        const method = (e.method || 'GET').toUpperCase();
        const status = e.status || '';
        const statusClass = status >= 500 ? 's5xx' : status >= 400 ? 's4xx' : status >= 300 ? 's3xx' : 's2xx';
        const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        html += '<div class="log-entry">' +
          '<span class="log-ts">' + ts + '</span>' +
          '<span class="log-method ' + method + '">' + method + '</span>' +
          '<span class="log-status ' + statusClass + '">' + status + '</span>' +
          '<span class="log-text">' + escHtml(e.url || '') + '</span>' +
          (e.duration ? '<span class="mono" style="color:var(--text-muted);margin-left:auto;flex-shrink:0">' + e.duration + 'ms</span>' : '') +
          '</div>';
      });
      html += '</div>';
    }
  }

  if (currentBrowserTab === 'dialog') {
    const entries = cache.dialogLogs?.entries || [];
    if (!entries.length) {
      html = emptyState('&#9881;', 'No dialog logs', 'Browser dialog interactions will appear here.');
    } else {
      html = '<div class="log-viewer">';
      entries.forEach(e => {
        const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        html += '<div class="log-entry">' +
          '<span class="log-ts">' + ts + '</span>' +
          '<span class="badge badge-purple">' + (e.type || 'dialog') + '</span>' +
          '<span class="log-text">' + escHtml(e.message || '') + '</span>' +
          (e.action ? '<span class="badge badge-blue" style="margin-left:auto">' + e.action + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
    }
  }

  document.getElementById('browser-content').innerHTML = html;
}

// ─── EUREKA ─────────────────────────────────────────────────────
async function loadEureka() {
  const data = await api('/eureka?days=365');
  const entries = data?.entries || [];

  if (!entries.length) {
    document.getElementById('eureka-content').innerHTML = emptyState('&#10023;', 'No eureka moments', 'First-principles insights are logged when gstack discovers something unexpected. These are the most valuable artifacts of AI-assisted development.');
    return;
  }

  let html = '<div style="margin-bottom:16px;font-size:13px;color:var(--text-secondary)">' + entries.length + ' eureka moments captured</div>';
  entries.forEach(e => {
    html += '<div class="eureka-card">' +
      '<div class="eureka-meta">' +
      '<span>' + (e.ts ? new Date(e.ts).toLocaleDateString() : 'unknown date') + '</span>' +
      (e.skill ? '<span class="badge badge-blue">/' + escHtml(e.skill) + '</span>' : '') +
      (e.branch ? '<span>' + escHtml(e.branch) + '</span>' : '') +
      '</div>' +
      '<div class="eureka-insight">' + escHtml(e.insight) + '</div>' +
      '</div>';
  });

  document.getElementById('eureka-content').innerHTML = html;
}

// ─── STAGE MODE ─────────────────────────────────────────────────
let stageMode = false;
let stageStartTime = null;
let stageClockInterval = null;
let prevFeedEntries = [];

function initStageMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') !== 'stage') return;

  stageMode = true;
  document.body.classList.add('stage-mode');
  stageStartTime = Date.now();

  // Start elapsed clock
  stageClockInterval = setInterval(updateStageClock, 1000);
  updateStageClock();

  // Load stage view
  loadStage();

  // Fast polling — every 5 seconds in stage mode
  setInterval(() => { cache = {}; loadStage(); }, 5000);
}

function updateStageClock() {
  const elapsed = Math.floor((Date.now() - stageStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  const el = document.getElementById('stage-clock');
  if (el) el.textContent = m + ':' + s;
}

async function loadStage() {
  const [overview, pipeline, skills, usage] = await Promise.all([
    api('/overview'),
    api('/pipeline'),
    api('/analytics/skills?days=30'),
    api('/analytics/usage?days=7'),
  ]);

  // Brand
  const git = overview?.git || {};
  const repoEl = document.getElementById('stage-repo');
  const branchEl = document.getElementById('stage-branch');
  if (repoEl) repoEl.textContent = git.remoteSlug || '';
  if (branchEl) branchEl.textContent = git.branch || '';

  // Pipeline
  renderStagePipeline(pipeline?.stages || []);

  // Metrics
  renderStageMetrics(overview?.metrics || {});

  // Activity feed
  renderStageFeed(usage?.entries || []);

  // Top skills
  renderStageTopSkills(skills?.stats || []);
}

function renderStagePipeline(stages) {
  const el = document.getElementById('stage-pipeline');
  if (!el || !stages.length) return;

  el.innerHTML = stages.map((s, i) => {
    const arrow = i < stages.length - 1 ? '<div class="stage-pipeline-arrow">&#8594;</div>' : '';
    return '<div class="stage-pipeline-stage ' + s.status + '">' +
      '<div class="stage-pipeline-icon">' + s.icon + '</div>' +
      '<div class="stage-pipeline-name">' + s.name + '</div>' +
      '<div class="stage-pipeline-skills">' + s.skills.slice(0, 2).map(sk => '/' + sk).join(', ') + '</div>' +
      '<div class="stage-pipeline-dot ' + s.status + '"></div>' +
      '</div>' + arrow;
  }).join('');
}

function renderStageMetrics(m) {
  const el = document.getElementById('stage-metrics');
  if (!el) return;

  const metrics = [
    { value: m.totalRuns || 0, label: 'Skill Runs', color: 'var(--accent-blue)' },
    { value: (m.successRate || 0) + '%', label: 'Success Rate', color: m.successRate >= 80 ? 'var(--accent-green)' : 'var(--accent-yellow)' },
    { value: m.reportsTotal || 0, label: 'Reports', color: 'var(--accent-purple)' },
    { value: m.eurekaCount || 0, label: 'Eureka Moments', color: 'var(--accent-yellow)' },
  ];

  el.innerHTML = metrics.map(mt =>
    '<div class="stage-metric">' +
    '<div class="stage-metric-value" style="color:' + mt.color + '">' + mt.value + '</div>' +
    '<div class="stage-metric-label">' + mt.label + '</div>' +
    '</div>'
  ).join('');
}

function renderStageFeed(entries) {
  const el = document.getElementById('stage-feed-items');
  if (!el) return;

  // Sort by timestamp, newest first, take last 15
  const sorted = entries
    .filter(e => e.ts && e.skill)
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, 15);

  if (!sorted.length) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">Waiting for skill activity...</div>';
    return;
  }

  const outcomeColors = {
    success: 'var(--accent-green)',
    error: 'var(--accent-red)',
    unknown: 'var(--text-muted)',
  };

  el.innerHTML = sorted.map(e => {
    const dotColor = outcomeColors[e.outcome] || outcomeColors.unknown;
    const duration = e.duration_s ? formatDuration(e.duration_s) : '';
    const desc = e.outcome === 'success' ? 'completed' : e.outcome === 'error' ? 'failed' : 'ran';
    return '<div class="feed-item">' +
      '<div class="feed-dot" style="background:' + dotColor + '"></div>' +
      '<div class="feed-skill">/' + escHtml(e.skill) + '</div>' +
      '<div class="feed-text">' + desc + (duration ? ' in ' + duration : '') + (e.used_browse ? ' (browser)' : '') + '</div>' +
      '<div class="feed-time">' + timeAgo(e.ts) + '</div>' +
      '</div>';
  }).join('');
}

function renderStageTopSkills(stats) {
  const el = document.getElementById('stage-top-skills');
  if (!el) return;

  const top = stats.slice(0, 8);
  if (!top.length) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">No skill data yet</div>';
    return;
  }

  const maxRuns = Math.max(...top.map(s => s.runs), 1);
  const colors = ['var(--accent-blue)', 'var(--accent-green)', 'var(--accent-purple)', 'var(--accent-cyan)', 'var(--accent-yellow)', 'var(--accent-orange)', 'var(--accent-pink)', 'var(--accent-red)'];

  el.innerHTML = top.map((s, i) =>
    '<div class="stage-skill-row">' +
    '<div class="stage-skill-name">/' + escHtml(s.name) + '</div>' +
    '<div class="stage-skill-bar"><div class="stage-skill-fill" style="width:' + ((s.runs / maxRuns) * 100) + '%;background:' + colors[i % colors.length] + '"></div></div>' +
    '<div class="stage-skill-count">' + s.runs + '</div>' +
    '</div>'
  ).join('');
}

// ─── Init ───────────────────────────────────────────────────────
initStageMode();

if (!stageMode) {
  loadOverview();
  // Auto-refresh every 30 seconds in normal mode
  setInterval(() => {
    cache = {};
    loadView(currentView);
  }, 30000);
}
</script>
</body>
</html>`;
}
