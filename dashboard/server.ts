/**
 * gstack Dashboard — HTTP Server
 *
 * Bun.serve on localhost, serves the dashboard SPA + JSON API.
 * No auth required (localhost only, read-only data).
 *
 * Usage:
 *   bun run dashboard/server.ts
 *   DASHBOARD_PORT=3333 bun run dashboard/server.ts
 */

import {
  getDaemonStatus,
  getQAReports,
  getBenchmarkReports,
  getCanaryReports,
  getDesignReports,
  getSkillStats,
  getSkillUsage,
  getEurekaMoments,
  getConsoleLogs,
  getNetworkLogs,
  getDialogLogs,
  getPipelineStages,
  getOverviewMetrics,
  getGitInfo,
  getAnalyticsTimeline,
} from './data';
import { getDashboardHTML } from './ui';

const PORT = parseInt(process.env.DASHBOARD_PORT || '0', 10);

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function html(content: string): Response {
  return new Response(content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── Route Handler ──────────────────────────────────────────────

function handleRequest(req: Request): Response {
  const url = new URL(req.url);
  const p = url.pathname;

  // ── HTML routes ──
  if (p === '/' || p === '/index.html') {
    return html(getDashboardHTML(server.port));
  }

  // ── API routes ──
  if (p === '/api/overview') {
    return json({
      metrics: getOverviewMetrics(),
      git: getGitInfo(),
      daemon: getDaemonStatus(),
    });
  }

  if (p === '/api/pipeline') {
    return json({ stages: getPipelineStages() });
  }

  if (p === '/api/qa/reports') {
    return json({ reports: getQAReports() });
  }

  if (p === '/api/benchmark/reports') {
    return json({ reports: getBenchmarkReports() });
  }

  if (p === '/api/canary/reports') {
    return json({ reports: getCanaryReports() });
  }

  if (p === '/api/design/reports') {
    return json({ reports: getDesignReports() });
  }

  if (p === '/api/analytics/skills') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    return json({ stats: getSkillStats(days) });
  }

  if (p === '/api/analytics/timeline') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    return json({ timeline: getAnalyticsTimeline(days) });
  }

  if (p === '/api/analytics/usage') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    return json({ entries: getSkillUsage(days) });
  }

  if (p === '/api/eureka') {
    const days = parseInt(url.searchParams.get('days') || '90', 10);
    return json({ entries: getEurekaMoments(days) });
  }

  if (p === '/api/logs/console') {
    const lines = parseInt(url.searchParams.get('lines') || '200', 10);
    return json({ entries: getConsoleLogs(lines) });
  }

  if (p === '/api/logs/network') {
    const lines = parseInt(url.searchParams.get('lines') || '200', 10);
    return json({ entries: getNetworkLogs(lines) });
  }

  if (p === '/api/logs/dialog') {
    const lines = parseInt(url.searchParams.get('lines') || '100', 10);
    return json({ entries: getDialogLogs(lines) });
  }

  if (p === '/api/health') {
    return json({ status: 'ok', uptime: process.uptime() });
  }

  return json({ error: 'Not found' }, 404);
}

// ─── Server ─────────────────────────────────────────────────────

async function findPort(): Promise<number> {
  if (PORT > 0) return PORT;
  // Let OS assign a random available port
  const testServer = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = testServer.port;
  testServer.stop(true);
  return port;
}

const port = await findPort();

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch: handleRequest,
});

console.log(`\n  gstack dashboard`);
console.log(`  ────────────────────────────────`);
console.log(`  Local:   http://127.0.0.1:${server.port}`);
console.log(`  Press Ctrl+C to stop\n`);

// Auto-open browser
try {
  const openCmd = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  Bun.spawn([openCmd, `http://127.0.0.1:${server.port}`], { stdout: 'ignore', stderr: 'ignore' });
} catch {}
