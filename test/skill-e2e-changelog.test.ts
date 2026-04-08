import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-changelog');

// --- Multi-commit CHANGELOG generation E2E ---

describeIfSelected('Multi-commit CHANGELOG E2E', ['ship-changelog-multi-commit'], () => {
  let workDir: string;
  let changelogInstructions: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-changelog-'));

    // Extract ONLY the CHANGELOG section from ship/SKILL.md (never copy the full file)
    const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const start = full.indexOf('## Step 5: CHANGELOG (auto-generate)');
    const end = full.indexOf('\n---\n', start);
    changelogInstructions = full.slice(start, end > start ? end : undefined);
    fs.writeFileSync(path.join(workDir, 'changelog-instructions.md'), changelogInstructions);

    // Init git repo with initial commit on main
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Initial files
    fs.writeFileSync(path.join(workDir, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(workDir, 'CHANGELOG.md'),
      '# Changelog\n\nAll notable changes to this project.\n\n');
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'src', 'app.ts'), 'export function main() { return "v1"; }\n');

    run('git', ['add', 'VERSION', 'CHANGELOG.md', 'src/app.ts']);
    run('git', ['commit', '-m', 'initial release']);

    // Feature branch with 5+ commits across 3+ themes
    run('git', ['checkout', '-b', 'feature/multi-theme']);

    // Commit 1: Feature - add user authentication
    fs.writeFileSync(path.join(workDir, 'src', 'auth.ts'),
      `export function authenticate(token: string): boolean {
  if (!token) return false;
  return token.startsWith('sk_');
}

export function generateSession(userId: string): string {
  return \`session_\${userId}_\${Date.now()}\`;
}
`);
    run('git', ['add', 'src/auth.ts']);
    run('git', ['commit', '-m', 'feat: add user authentication with token validation']);

    // Commit 2: Feature - add webhook support
    fs.writeFileSync(path.join(workDir, 'src', 'webhooks.ts'),
      `export interface WebhookEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export function dispatchWebhook(url: string, event: WebhookEvent): Promise<void> {
  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'Content-Type': 'application/json' },
  }).then(() => {});
}
`);
    run('git', ['add', 'src/webhooks.ts']);
    run('git', ['commit', '-m', 'feat: add webhook dispatch system']);

    // Commit 3: Bug fix - handle null input in app
    fs.writeFileSync(path.join(workDir, 'src', 'app.ts'),
      `export function main(input?: string) {
  if (!input) return "default";
  return input.trim();
}
`);
    run('git', ['add', 'src/app.ts']);
    run('git', ['commit', '-m', 'fix: handle null input in main function']);

    // Commit 4: Infrastructure - add CI config and test setup
    fs.writeFileSync(path.join(workDir, '.github-ci.yml'),
      `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`);
    fs.mkdirSync(path.join(workDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'test', 'auth.test.ts'),
      `import { authenticate } from '../src/auth';
test('rejects empty token', () => {
  expect(authenticate('')).toBe(false);
});
test('accepts valid token', () => {
  expect(authenticate('sk_live_123')).toBe(true);
});
`);
    run('git', ['add', '.github-ci.yml', 'test/auth.test.ts']);
    run('git', ['commit', '-m', 'infra: add CI pipeline and auth tests']);

    // Commit 5: Docs - add API documentation
    fs.writeFileSync(path.join(workDir, 'API.md'),
      `# API Reference

## Authentication
- \`authenticate(token)\` - Validates an API token
- \`generateSession(userId)\` - Creates a new session

## Webhooks
- \`dispatchWebhook(url, event)\` - Sends webhook to target URL
`);
    run('git', ['add', 'API.md']);
    run('git', ['commit', '-m', 'docs: add API reference documentation']);

    // Commit 6: Feature - add rate limiting (extra commit for robustness)
    fs.writeFileSync(path.join(workDir, 'src', 'rate-limit.ts'),
      `const windowMs = 60_000;
const maxRequests = 100;
const store = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const entry = store.get(clientId);
  if (!entry || now > entry.resetAt) {
    store.set(clientId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}
`);
    run('git', ['add', 'src/rate-limit.ts']);
    run('git', ['commit', '-m', 'feat: add rate limiting middleware']);
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('ship-changelog-multi-commit', async () => {
    const result = await runSkillTest({
      prompt: `Read the file changelog-instructions.md for the CHANGELOG generation workflow.

You are on branch "feature/multi-theme" with the base branch "main".
This repo has 6 commits on this branch spanning multiple themes:
features (authentication, webhooks, rate limiting), a bug fix (null input handling),
infrastructure (CI pipeline + tests), and documentation (API reference).

Follow the CHANGELOG instructions to generate a CHANGELOG entry:
1. Run: git log main..HEAD --oneline
2. Run: git diff main...HEAD
3. Group commits by theme
4. Write the CHANGELOG entry to CHANGELOG.md with version 1.1.0 dated today
5. Cross-check that ALL themes are covered

IMPORTANT:
- Do NOT ask the user anything. Infer everything from the diff and commits.
- Do NOT run any other ship workflow steps (no VERSION bump, no push, no PR).
- Just write the CHANGELOG.md file with the new entry.`,
      workingDirectory: workDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      timeout: 120_000,
      testName: 'ship-changelog-multi-commit',
      runId,
    });

    logCost('/ship CHANGELOG multi-commit', result);

    // Read the generated CHANGELOG
    const changelog = fs.readFileSync(path.join(workDir, 'CHANGELOG.md'), 'utf-8');
    const changelogLower = changelog.toLowerCase();

    // Verify all themes are covered
    const hasAuth = changelogLower.includes('auth');
    const hasWebhook = changelogLower.includes('webhook');
    const hasRateLimit = changelogLower.includes('rate limit') || changelogLower.includes('rate-limit') || changelogLower.includes('ratelimit');
    const hasNullFix = changelogLower.includes('null') || changelogLower.includes('fix') || changelogLower.includes('input');
    const hasCI = changelogLower.includes('ci') || changelogLower.includes('pipeline') || changelogLower.includes('infra') || changelogLower.includes('test');
    const hasDocs = changelogLower.includes('doc') || changelogLower.includes('api reference') || changelogLower.includes('api.md');

    // Must have version header
    const hasVersion = changelog.includes('1.1.0');

    // Count how many themes are represented (need at least 3 of the theme categories)
    const featuresCovered = hasAuth || hasWebhook || hasRateLimit;
    const fixCovered = hasNullFix;
    const infraCovered = hasCI;
    const docsCovered = hasDocs;
    const themesRepresented = [featuresCovered, fixCovered, infraCovered, docsCovered].filter(Boolean).length;

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    const allThemesCovered = themesRepresented >= 3;

    recordE2E(evalCollector, '/ship CHANGELOG multi-commit', 'Multi-commit CHANGELOG E2E', result, {
      passed: exitOk && hasVersion && allThemesCovered,
    });

    // Log diagnostics
    console.log(`CHANGELOG themes: auth=${hasAuth} webhook=${hasWebhook} rateLimit=${hasRateLimit} fix=${hasNullFix} CI=${hasCI} docs=${hasDocs}`);
    console.log(`Themes represented: ${themesRepresented}/4 (features=${featuresCovered}, fix=${fixCovered}, infra=${infraCovered}, docs=${docsCovered})`);
    console.log(`Version header present: ${hasVersion}`);

    // Assertions
    expect(exitOk).toBe(true);
    expect(hasVersion).toBe(true);
    expect(allThemesCovered).toBe(true);

    // Informational: check for individual feature commits
    if (!hasAuth) console.warn('CHANGELOG missing authentication theme');
    if (!hasWebhook) console.warn('CHANGELOG missing webhook theme');
    if (!hasRateLimit) console.warn('CHANGELOG missing rate limiting theme');
  }, 180_000);
});

// Module-level afterAll
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
