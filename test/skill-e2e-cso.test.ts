import { test, expect, afterAll } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { ROOT, describeIfSelected, logCost, recordE2E, createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { validateCoverage, validateFinding, completeness, type RunReportV3 } from '../lib/cso/contracts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const evalCollector = createEvalCollector('e2e-cso');
afterAll(() => finalizeEvalCollector(evalCollector));

// Synthetic credential-shaped canary: its bytes must never appear in agent output or saved reports.
const CANARY = 'ghp_f7K3mV9nT2qR8sL4xP6dW0bH5jY1cZ3aF9uE';
interface Fixture { repo: string; state: string; original: Map<string, string>; }
function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 });
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
async function withFixture<T>(files:Record<string,string>,diff:Record<string,string>|undefined,run:(fixture:Fixture)=>Promise<T>):Promise<T>{const f=fixture(files,diff);try{return await run(f);}finally{removeFixture(f);}}
function reportsUnder(dir: string): string[] {
  // Bounded to the exact private namespace; no report in source or old v2 namespace is accepted.
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(dir, entry.name);
    return entry.isDirectory() ? reportsUnder(child) : entry.name === 'report.json' ? [child] : [];
  });
}
function requireReport(f: Fixture): RunReportV3 {
  const reports = reportsUnder(path.join(f.state, 'security', 'cso'));
  expect(reports).toHaveLength(1); // A mandatory assertion: absent reports used to silently pass.
  const raw = fs.readFileSync(reports[0], 'utf8');
  expect(raw).not.toContain(CANARY);
  const report: RunReportV3 = JSON.parse(raw);
  expect(report.schemaVersion).toBe(3);
  expect(report.status).toBe('finished');
  expect(report.source.root).toBe(fs.realpathSync(f.repo));
  expect(report.policy.mode).toBe('daily');
  expect(report.policy.offline).toBe(true);
  expect(report.coverage.length).toBeGreaterThan(0);
  report.coverage.forEach(validateCoverage);
  expect(report.completeness).toBe(completeness(report));
  for (const finding of report.findings) {
    const { id, fingerprint, reproduction, repair, closure, verificationId, reproductionAttemptId, ...submitted } = finding;
    validateFinding(submitted);
    expect(id).toBe(fingerprint);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(finding.evidence).toBe('supported');
    expect(reproduction).toBe('not_attempted');
    expect(repair).toBe('not_attempted');
    expect(closure).toBe('open');
    expect(verificationId).toBeUndefined();
    expect(reproductionAttemptId).toBeUndefined();
  }
  const markdown = fs.readFileSync(path.join(path.dirname(reports[0]), 'report.md'), 'utf8');
  expect(markdown).toMatch(/^(complete|partial|not assessed) — /);
  expect(markdown).not.toContain(CANARY);
  if (process.platform !== 'win32') expect(fs.statSync(reports[0]).mode & 0o777).toBe(0o600);
  for (const [name, content] of f.original) expect(fs.readFileSync(path.join(f.repo, name), 'utf8')).toBe(content);
  expect(git(f.repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  return report;
}
function prompt(f: Fixture, flags: string): string {
  return `Read ${path.join(ROOT, 'cso/SKILL.md')} and perform /cso ${flags} --offline --base main on ${f.repo}.
The trusted installed helper for this evaluation is ${path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher')}.
GSTACK_HOME is already set to the private evaluation state directory.
Complete the helper-owned report even when coverage is partial. Do not use AskUserQuestion or request new scope.
Use one sequential challenge (independent agent unavailable for this evaluation); do not spawn agents.
This is a static audit: do not execute the application, test provider credentials, or install dependencies.
Do not read or execute files outside this repository except the trusted skill/helper and its private run artifacts.`;
}

const PACKAGE = JSON.stringify({ name: 'cso-v3-evaluation', version: '1.0.0', private: true });

describeIfSelected('CSO v3 — full audit', ['cso-full-audit'], () => {
  test('/cso persists supported tenant-boundary findings with redacted evidence', async () => {
    await withFixture({
      'package.json': PACKAGE,
      '.env': `PROVIDER_TOKEN=${CANARY}\n`,
      'server.js': `const http = require('node:http');
const sessions = new Map([['alice-token', { tenant: 'alice' }], ['bob-token', { tenant: 'bob' }]]);
const invoices = [{ id: 'invoice-a', tenant: 'alice', total: 42 }, { id: 'invoice-b', tenant: 'bob', total: 950 }];
http.createServer((req, res) => {
  const user = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!user) { res.writeHead(401); return res.end('unauthorized'); }
  const id = req.url.split('/').pop();
  const invoice = invoices.find(item => item.id === id);
  if (!invoice) { res.writeHead(404); return res.end('not found'); }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(invoice));
}).listen(3000);
`,
    },undefined,async f=>{
      const result = await runSkillTest({ prompt: prompt(f, ''), workingDirectory: f.repo,
      env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS });
      logCost('cso', result);
      expect(result.exitReason).toBe('success');
      expect(result.output).not.toContain(CANARY);
      expect(JSON.stringify(result.transcript)).not.toContain(CANARY);
      // Dedicated carve behavioral guard: a real audit must actually load its domain section.
      expect(result.toolCalls.some(call => /Read|Bash/.test(call.tool)
        && JSON.stringify(call.input).includes('sections/audit-phases.md'))).toBe(true);
      const report = requireReport(f);
      const tenant = report.findings.filter(item => item.location.path === 'server.js' && /tenant|owner|authoriz|access control/i.test(`${item.rootCause} ${item.impact}`));
      expect(tenant.length).toBeGreaterThan(0);
      expect(tenant.every(item => item.trace.length > 0 && item.challenge.controls.length > 0)).toBe(true);
      recordE2E(evalCollector, 'cso-full-audit', 'e2e-cso', result);
    });
  }, CAPTURE_LONG_MS);
});

describeIfSelected('CSO v3 — diff mode', ['cso-diff-mode'], () => {
  test('/cso --diff records its base and investigates changed security paths', async () => {
    await withFixture({ 'package.json': PACKAGE, 'app.js': 'console.log("fixture baseline");\n' }, {
      'webhook.js': `const http = require('node:http');
const payments = new Map();
http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook/payment') { res.writeHead(404); return res.end(); }
  let body = ''; req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const event = JSON.parse(body);
    payments.set(event.accountId, { plan: 'paid', amount: event.amount });
    res.end('payment applied');
  });
}).listen(3000);
`,
    },async f=>{
      const result = await runSkillTest({ prompt: prompt(f, '--diff'), workingDirectory: f.repo,
      env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS });
      logCost('cso', result);
      expect(result.exitReason).toBe('success');
      const report = requireReport(f);
      expect(report.policy.diff).toBe(true);
      expect(report.policy.base).toBe('main');
      expect(report.source.baseCommit).toBe(git(f.repo, 'rev-parse', 'main').trim());
      expect(report.findings.some(item => item.location.path === 'webhook.js' && /signature|authenticat|forg/i.test(`${item.rootCause} ${item.impact}`))).toBe(true);
      expect(report.findings.every(item => item.location.path === 'webhook.js')).toBe(true);
      recordE2E(evalCollector, 'cso-diff-mode', 'e2e-cso', result);
    });
  }, CAPTURE_LONG_MS);
});

describeIfSelected('CSO v3 — infra scope', ['cso-infra-scope'], () => {
  test('/cso --infra finds an attacker-to-credential execution path', async () => {
    await withFixture({ 'package.json': PACKAGE,
      '.github/workflows/comment.yml': `name: comment automation
on:
  issue_comment:
    types: [created]
permissions:
  contents: write
jobs:
  reply:
    runs-on: ubuntu-latest
    steps:
      - name: Handle untrusted comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: echo "\${{ github.event.comment.body }}"
`,
      'Dockerfile': 'FROM node:22\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n',
    },undefined,async f=>{
      const result = await runSkillTest({ prompt: prompt(f, '--infra'), workingDirectory: f.repo,
      env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS });
      logCost('cso', result);
      expect(result.exitReason).toBe('success');
      const report = requireReport(f);
      expect(report.policy.scope).toBe('infra');
      const workflow=report.findings.find(item=>item.location.path==='.github/workflows/comment.yml');
      expect(workflow).toBeDefined();
      const chain=[workflow!.title,workflow!.rootCause,workflow!.attackerControl,workflow!.impact,workflow!.scenario,...workflow!.trace].join(' ');
      expect(chain).toMatch(/github\.event\.comment\.body|issue comment body|comment body/i);
      expect(chain).toMatch(/run(?: step|:)|shell|bash/i);
      expect(chain).toMatch(/GITHUB_TOKEN|contents:\s*write|repository write/i);
      // A missing USER directive is only a hardening lead without demonstrated attacker impact.
      expect(report.findings.some(item => item.location.path === 'Dockerfile' && /critical|high/.test(item.severity))).toBe(false);
      recordE2E(evalCollector, 'cso-infra-scope', 'e2e-cso', result);
    });
  }, CAPTURE_LONG_MS);
});
