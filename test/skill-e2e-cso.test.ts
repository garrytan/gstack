import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-cso');

afterAll(() => {
  finalizeEvalCollector(evalCollector);
});

// --- CSO v2 E2E Tests ---

describeIfSelected('CSO v2 — full audit', ['cso-full-audit'], () => {
  let csoDir: string;

  beforeAll(() => {
    csoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cso-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: csoDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a minimal app with a planted vulnerability
    fs.writeFileSync(path.join(csoDir, 'package.json'), JSON.stringify({
      name: 'cso-test-app',
      version: '1.0.0',
      dependencies: { express: '4.18.0' },
    }, null, 2));

    // Planted vuln: hardcoded API key
    fs.writeFileSync(path.join(csoDir, 'server.ts'), `
import express from 'express';
const app = express();
const API_KEY = "sk-1234567890abcdef1234567890abcdef";
app.get('/api/data', (req, res) => {
  const id = req.query.id;
  res.json({ data: \`result for \${id}\` });
});
app.listen(3000);
`);

    // Planted vuln: .env tracked by git
    fs.writeFileSync(path.join(csoDir, '.env'), 'DATABASE_URL=postgres://admin:secretpass@prod.db.example.com:5432/myapp\n');

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
  });

  afterAll(() => {
    try { fs.rmSync(csoDir, { recursive: true, force: true }); } catch {}
  });

  test('/cso finds planted vulnerabilities', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ${path.join(ROOT, 'cso', 'SKILL.md')} for the CSO skill instructions.

Run /cso on this repo (full daily audit, no flags).

IMPORTANT:
- Do NOT use AskUserQuestion — skip any interactive prompts.
- Focus on finding the planted vulnerabilities in this small repo.
- Produce the SECURITY FINDINGS table.
- Save the report to .nstack/security-reports/.`,
      workingDirectory: csoDir,
      maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent'],
      timeout: 300_000,
    });

    logCost('cso', result);
    expect(result.exitReason).toBe('success');

    // Should detect hardcoded API key
    const output = result.output.toLowerCase();
    expect(
      output.includes('sk-') || output.includes('hardcoded') || output.includes('api key') || output.includes('api_key')
    ).toBe(true);

    // Should detect .env tracked by git
    expect(
      output.includes('.env') && (output.includes('tracked') || output.includes('gitignore'))
    ).toBe(true);

    // Should produce a findings table
    expect(
      output.includes('security findings') || output.includes('SECURITY FINDINGS')
    ).toBe(true);

    // Should save a report
    const reportDir = path.join(csoDir, '.nstack', 'security-reports');
    const reportExists = fs.existsSync(reportDir);
    if (reportExists) {
      const reports = fs.readdirSync(reportDir).filter(f => f.endsWith('.json'));
      expect(reports.length).toBeGreaterThanOrEqual(1);
    }

    recordE2E(evalCollector, 'cso-full-audit', 'e2e-cso', result);
  }, 300_000);
});

describeIfSelected('CSO v2 — diff mode', ['cso-diff-mode'], () => {
  let csoDiffDir: string;

  beforeAll(() => {
    csoDiffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cso-diff-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: csoDiffDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Clean initial commit
    fs.writeFileSync(path.join(csoDiffDir, 'package.json'), JSON.stringify({
      name: 'cso-diff-test', version: '1.0.0',
    }, null, 2));
    fs.writeFileSync(path.join(csoDiffDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Feature branch with a vuln
    run('git', ['checkout', '-b', 'feat/add-webhook']);
    fs.writeFileSync(path.join(csoDiffDir, 'webhook.ts'), `
import express from 'express';
const app = express();
// No signature verification!
app.post('/webhook/stripe', (req, res) => {
  const event = req.body;
  processPayment(event);
  res.sendStatus(200);
});
`);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add webhook']);
  });

  afterAll(() => {
    try { fs.rmSync(csoDiffDir, { recursive: true, force: true }); } catch {}
  });

  test('/cso --diff scopes to branch changes', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ${path.join(ROOT, 'cso', 'SKILL.md')} for the CSO skill instructions.

Run /cso --diff on this repo. The base branch is "main".

IMPORTANT:
- Do NOT use AskUserQuestion — skip any interactive prompts.
- Focus on changes in the current branch vs main.
- The webhook.ts file was added on this branch — it should be analyzed.`,
      workingDirectory: csoDiffDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent'],
      timeout: 240_000,
    });

    logCost('cso', result);
    expect(result.exitReason).toBe('success');

    const output = result.output.toLowerCase();
    // Should mention webhook and missing signature verification
    expect(
      output.includes('webhook') && (output.includes('signature') || output.includes('verify'))
    ).toBe(true);

    recordE2E(evalCollector, 'cso-diff-mode', 'e2e-cso', result);
  }, 240_000);
});

describeIfSelected('CSO v2 — infra scope', ['cso-infra-scope'], () => {
  let csoInfraDir: string;

  beforeAll(() => {
    csoInfraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cso-infra-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: csoInfraDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // CI workflow with unpinned action
    fs.mkdirSync(path.join(csoInfraDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(csoInfraDir, '.github', 'workflows', 'ci.yml'), `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: some-third-party/action@main
      - run: echo "Building..."
`);

    // Dockerfile running as root
    fs.writeFileSync(path.join(csoInfraDir, 'Dockerfile'), `
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
  });

  afterAll(() => {
    try { fs.rmSync(csoInfraDir, { recursive: true, force: true }); } catch {}
  });

  test('/cso --infra runs infrastructure phases only', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ${path.join(ROOT, 'cso', 'SKILL.md')} for the CSO skill instructions.

Run /cso --infra on this repo. This should run infrastructure-only phases (0-6, 12-14).

IMPORTANT:
- Do NOT use AskUserQuestion — skip any interactive prompts.
- This is a TINY repo with only 3 files: .github/workflows/ci.yml, Dockerfile, and package.json. Do NOT waste turns exploring — just read those files directly and audit them.
- The Dockerfile has no USER directive (runs as root). The CI workflow uses an unpinned third-party GitHub Action (some-third-party/action@main).
- Focus on infrastructure findings, NOT code-level OWASP scanning.
- Skip the preamble (nstack-update-check, telemetry, etc.) — go straight to the audit.
- Do NOT use the Agent tool for exploration or verification — read the files yourself. This repo is too small to need subagents.`,
      workingDirectory: csoInfraDir,
      maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 360_000,
    });

    logCost('cso', result);
    expect(result.exitReason).toBe('success');

    const output = result.output.toLowerCase();
    // Should mention unpinned action or Dockerfile issues
    expect(
      output.includes('unpinned') || output.includes('third-party') ||
      output.includes('user directive') || output.includes('root')
    ).toBe(true);

    recordE2E(evalCollector, 'cso-infra-scope', 'e2e-cso', result);
  }, 360_000);
});
