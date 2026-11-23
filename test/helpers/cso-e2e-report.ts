import { expect } from 'bun:test';
import { validateCoverage, validateFinding, completeness, type FindingV3, type RunReportV3 } from '../../lib/cso/contracts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Synthetic credential-shaped canary: its bytes must never appear in agent output or saved reports.
export const CANARY = ['ghp_', 'f7K3mV9nT2qR8sL4xP6dW0bH5jY1cZ3aF9uE'].join('');
export const PACKAGE = JSON.stringify({ name: 'cso-v3-evaluation', version: '1.0.0', private: true });
export const DIFF_MODE_BASE = { 'package.json': PACKAGE, 'app.js': 'console.log("fixture baseline");\n' };
export const DIFF_MODE_CHANGE = {
  'webhook.js': `const http = require('node:http');
const sessions = new Map([['alice-token', 'alice'], ['bob-token', 'bob']]);
const payments = new Map();
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/reports/premium') {
    const account = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
    if (!account) { res.writeHead(401); return res.end(); }
    if (payments.get(account)?.plan !== 'paid') { res.writeHead(402); return res.end('upgrade required'); }
    return res.end('premium revenue report');
  }
  if (req.method !== 'POST' || req.url !== '/webhook/payment') { res.writeHead(404); return res.end(); }
  let body = ''; req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const event = JSON.parse(body);
    payments.set(event.accountId, { plan: 'paid', amount: event.amount });
    res.end('payment applied');
  });
}).listen(3000);
`,
};

export interface Fixture { repo: string; state: string; original: Map<string, string>; }
export function git(repo: string, ...args: string[]): string {
  // Seed commits must not depend on the host's Git configuration (signing, hooks, templates).
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
function fixture(files: Record<string, string>, diff?: Record<string, string>): Fixture {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cso-v3-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cso-state-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'CSO Test');
  const write = (inputs: Record<string, string>) => {
    for (const [name, content] of Object.entries(inputs)) {
      fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
      fs.writeFileSync(path.join(repo, name), content);
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'CSO fixture');
  };
  write(files);
  if (diff) { git(repo, 'checkout', '-b', 'fixture-change'); write(diff); }
  return { repo, state, original: new Map(Object.entries({ ...files, ...diff })) };
}
function removeFixture(f: Fixture): void {
  fs.rmSync(f.repo, { recursive: true, force: true });
  fs.rmSync(f.state, { recursive: true, force: true });
}
export async function withFixture<T>(files: Record<string, string>, diff: Record<string, string> | undefined, run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const f = fixture(files, diff);
  try { return await run(f); } finally { removeFixture(f); }
}
function reportsUnder(dir: string): string[] {
  // Bounded to the exact private namespace; no report in source or old v2 namespace is accepted.
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(dir, entry.name);
    return entry.isDirectory() ? reportsUnder(child) : entry.name === 'report.json' ? [child] : [];
  });
}
/** Daily reports carry supported findings and, since #4739, low-confidence hypotheses (never dropped candidates). */
export function expectDailyFinding(finding: FindingV3): void {
  const { id, fingerprint, reproduction, repair, closure, verificationId, reproductionAttemptId, ...submitted } = finding;
  validateFinding(submitted);
  expect(id).toBe(fingerprint);
  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(['supported', 'hypothesis']).toContain(finding.evidence);
  if (finding.evidence === 'hypothesis') expect(finding.confidence).toBe('low');
  expect(reproduction).toBe('not_attempted');
  expect(repair).toBe('not_attempted');
  expect(closure).toBe('open');
  expect(verificationId).toBeUndefined();
  expect(reproductionAttemptId).toBeUndefined();
}
export function requireReport(f: Fixture): RunReportV3 {
  const reports = reportsUnder(path.join(f.state, 'security', 'cso'));
  expect(reports).toHaveLength(1); // A mandatory assertion: absent reports used to silently pass.
  const raw = fs.readFileSync(reports[0], 'utf8');
  expect(raw).not.toContain(CANARY);
  expect(raw).not.toContain(fs.realpathSync(f.repo));
  const report: RunReportV3 = JSON.parse(raw);
  expect(report.schemaVersion).toBe(3);
  expect(report.status).toBe('finished');
  expect(report.source.root).toBe('<REDACTED-internal.user_path>');
  expect(report.policy.mode).toBe('daily');
  expect(report.policy.offline).toBe(true);
  expect(report.coverage.length).toBeGreaterThan(0);
  report.coverage.forEach(validateCoverage);
  expect(report.completeness).toBe(completeness(report));
  report.findings.forEach(expectDailyFinding);
  const markdown = fs.readFileSync(path.join(path.dirname(reports[0]), 'report.md'), 'utf8');
  expect(markdown).toMatch(/^(complete|partial|not assessed) — /);
  expect(markdown).not.toContain(CANARY);
  if (report.findings.some(item => item.evidence === 'hypothesis')) expect(markdown).toContain('\nHypotheses (unconfirmed):\n');
  if (process.platform !== 'win32') expect(fs.statSync(reports[0]).mode & 0o777).toBe(0o600);
  for (const [name, content] of f.original) expect(fs.readFileSync(path.join(f.repo, name), 'utf8')).toBe(content);
  expect(git(f.repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  return report;
}
/** The finding that names the changed webhook's missing authentication (title or root cause, not a side effect in its impact). */
export const isWebhookAuthFinding = (item: FindingV3): boolean => item.location.path === 'webhook.js'
  && /signature|authentic|forg|spoof|hmac/i.test(`${item.title} ${item.rootCause}`);
/** cso-diff-mode's case contract: the changed webhook's missing authentication is a supported finding, and nothing outside the diff is reported. */
export function expectDiffModeReport(report: RunReportV3, f: Fixture): void {
  expect(report.policy.diff).toBe(true);
  expect(report.policy.base).toBe('main');
  expect(report.source.baseCommit).toBe(git(f.repo, 'rev-parse', 'main').trim());
  expect(report.findings.some(item => item.evidence === 'supported' && isWebhookAuthFinding(item))).toBe(true);
  expect(report.findings.every(item => item.location.path === 'webhook.js')).toBe(true);
}
