import { test, expect, afterAll } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest, SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { ROOT, runId, describeIfSelected, logCost, recordE2E, createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { CANARY, PACKAGE, DIFF_MODE_BASE, DIFF_MODE_CHANGE, withFixture, requireReport, expectDiffModeReport, type Fixture } from './helpers/cso-e2e-report';
import * as path from 'node:path';

const evalCollector = createEvalCollector('e2e-cso');
// runSkillTest can drain stderr for 5s after its unchanged CLI deadline.
// Let cleanup and failure recording finish before Bun starts a retry.
const CSO_FINALIZE_MS = SESSION_DRAIN_GRACE_MS + 5_000;
let captureSequence = 0;
afterAll(() => finalizeEvalCollector(evalCollector));

function prompt(f: Fixture, flags: string): string {
  return `Read ${path.join(ROOT, 'cso/SKILL.md')} and perform /cso ${flags} --offline --base main on ${f.repo}.
The trusted installed helper for this evaluation is ${path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher')}.
GSTACK_HOME is already set to the private evaluation state directory.
Complete the helper-owned report even when coverage is partial. Do not use AskUserQuestion or request new scope.
Use one sequential challenge (independent agent unavailable for this evaluation); do not spawn agents.
This is a static audit: do not execute the application, test provider credentials, or install dependencies.
Do not read or execute files outside this repository except the trusted skill/helper and its private run artifacts.`;
}

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
      const result = await runSkillTest({
        testName: 'cso-full-audit',
        runId: `cso-full-audit-${process.env.EVALS_RUN_ID ?? runId}-${process.pid}-${++captureSequence}`,
        publicStreamDiagnostics: true,
        prompt: prompt(f, ''), workingDirectory: f.repo,
        env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS,
      });
      logCost('cso', result);
      let passed = false;
      try {
        expect(result.exitReason).toBe('success');
        expect(result.output).not.toContain(CANARY);
        expect(JSON.stringify(result.transcript)).not.toContain(CANARY);
        // Dedicated carve behavioral guard: a real audit must actually load its domain section.
        expect(result.toolCalls.some(call => /Read|Bash/.test(call.tool)
          && JSON.stringify(call.input).includes('sections/audit-phases.md'))).toBe(true);
        const report = requireReport(f);
        const tenant = report.findings.filter(item => item.evidence === 'supported' && item.location.path === 'server.js' && /tenant|owner|authoriz|access control/i.test(`${item.rootCause} ${item.impact}`));
        expect(tenant.length).toBeGreaterThan(0);
        expect(tenant.every(item => item.trace.length > 0 && item.challenge.controls.length > 0)).toBe(true);
        passed = result.browseErrors.length === 0;
      } finally {
        recordE2E(evalCollector, 'cso-full-audit', 'e2e-cso', result, { passed });
      }
    });
  }, CAPTURE_LONG_MS + CSO_FINALIZE_MS);
});

describeIfSelected('CSO v3 — diff mode', ['cso-diff-mode'], () => {
  test('/cso --diff records its base and investigates changed security paths', async () => {
    await withFixture(DIFF_MODE_BASE, DIFF_MODE_CHANGE, async f => {
      const result = await runSkillTest({
        testName: 'cso-diff-mode',
        runId: `cso-diff-mode-${process.env.EVALS_RUN_ID ?? runId}-${process.pid}-${++captureSequence}`,
        publicStreamDiagnostics: true,
        prompt: prompt(f, '--diff'), workingDirectory: f.repo,
        env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS,
      });
      logCost('cso', result);
      let passed = false;
      try {
        expect(result.exitReason).toBe('success');
        const report = requireReport(f);
        expectDiffModeReport(report, f);
        passed = result.browseErrors.length === 0;
      } finally {
        recordE2E(evalCollector, 'cso-diff-mode', 'e2e-cso', result, { passed });
      }
    });
  }, CAPTURE_LONG_MS + CSO_FINALIZE_MS);
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
      const result = await runSkillTest({
        testName: 'cso-infra-scope',
        runId: `cso-infra-scope-${process.env.EVALS_RUN_ID ?? runId}-${process.pid}-${++captureSequence}`,
        publicStreamDiagnostics: true,
        prompt: prompt(f, '--infra'), workingDirectory: f.repo,
        env: { GSTACK_HOME: f.state }, maxTurns: 40, allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob'], timeout: CAPTURE_LONG_MS,
      });
      logCost('cso', result);
      let passed = false;
      try {
        expect(result.exitReason).toBe('success');
        const report = requireReport(f);
        expect(report.policy.scope).toBe('infra');
        const workflow=report.findings.find(item=>item.evidence==='supported'&&item.location.path==='.github/workflows/comment.yml');
        expect(workflow).toBeDefined();
        const chain=[workflow!.title,workflow!.rootCause,workflow!.attackerControl,workflow!.impact,workflow!.scenario,...workflow!.trace].join(' ');
        expect(chain).toMatch(/github\.event\.comment\.body|issue comment body|comment body/i);
        expect(chain).toMatch(/run(?: step|:)|shell|bash/i);
        expect(chain).toMatch(/GITHUB_TOKEN|contents:\s*write|repository write/i);
        // A missing USER directive is only a hardening lead without demonstrated attacker impact.
        expect(report.findings.some(item => item.location.path === 'Dockerfile' && /critical|high/.test(item.severity))).toBe(false);
        passed = result.browseErrors.length === 0;
      } finally {
        recordE2E(evalCollector, 'cso-infra-scope', 'e2e-cso', result, { passed });
      }
    });
  }, CAPTURE_LONG_MS + CSO_FINALIZE_MS);
});
