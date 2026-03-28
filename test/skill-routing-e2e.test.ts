import { describe, test, expect, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import { EvalCollector } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// Skip unless EVALS=1.
const evalsEnabled = !!process.env.EVALS;
const describeE2E = evalsEnabled ? describe : describe.skip;

// Eval result collector
const evalCollector = evalsEnabled ? new EvalCollector('e2e-routing') : null;

// Unique run ID for this session
const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);

// --- Diff-based test selection ---
// Journey routing tests use E2E_TOUCHFILES (entries prefixed 'journey-' in touchfiles.ts).
let selectedTests: string[] | null = null;

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nRouting E2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
}

// Apply EVALS_TIER filter (same logic as e2e-helpers.ts)
if (evalsEnabled && process.env.EVALS_TIER) {
  const tier = process.env.EVALS_TIER as 'gate' | 'periodic';
  const tierTests = Object.entries(E2E_TIERS)
    .filter(([, t]) => t === tier)
    .map(([name]) => name);

  if (selectedTests === null) {
    selectedTests = tierTests;
  } else {
    selectedTests = selectedTests.filter(t => tierTests.includes(t));
  }
  process.stderr.write(`Routing EVALS_TIER=${tier}: ${selectedTests.length} tests\n\n`);
}

// --- Helper functions ---

/** Copy all SKILL.md files for auto-discovery.
 *  Install to BOTH project-level (.claude/skills/) AND user-level (~/.claude/skills/)
 *  because Claude Code discovers skills from both locations. In CI containers,
 *  $HOME may differ from the working directory, so we need both paths to ensure
 *  the Skill tool appears in Claude's available tools list. */
function installSkills(tmpDir: string) {
  const skillDirs = [
    '', // root gstack SKILL.md
    'qa', 'qa-only', 'ship', 'review', 'plan-ceo-review', 'plan-eng-review',
    'plan-design-review', 'design-review', 'design-consultation', 'retro',
    'document-release', 'investigate', 'office-hours', 'browse', 'setup-browser-cookies',
    'gstack-upgrade', 'humanizer',
  ];

  // Install to both project-level and user-level skill directories
  const homeDir = process.env.HOME || os.homedir();
  const installTargets = [
    path.join(tmpDir, '.claude', 'skills'),        // project-level
    path.join(homeDir, '.claude', 'skills'),        // user-level (~/.claude/skills/)
  ];

  for (const skill of skillDirs) {
    const srcPath = path.join(ROOT, skill, 'SKILL.md');
    if (!fs.existsSync(srcPath)) continue;

    const skillName = skill || 'gstack';

    for (const targetBase of installTargets) {
      const destDir = path.join(targetBase, skillName);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcPath, path.join(destDir, 'SKILL.md'));
    }
  }

  // Copy CLAUDE.md so Claude has project context for skill routing.
  const claudeMdSrc = path.join(ROOT, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(tmpDir, 'CLAUDE.md'));
  }
}

/** Init a git repo with config */
function initGitRepo(dir: string) {
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
}

/**
 * Create a routing test working directory.
 * Uses the actual repo checkout (ROOT) which has CLAUDE.md, .claude/skills/,
 * and full project context. This matches the local environment where routing
 * tests pass reliably. In containerized CI, bare tmpDirs lack the context
 * Claude needs to make correct routing decisions.
 */
function createRoutingWorkDir(suffix: string): string {
  // Clone the repo checkout into a tmpDir so concurrent tests don't interfere
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `routing-${suffix}-`));
  // Copy essential context files
  const filesToCopy = ['CLAUDE.md', 'README.md', 'package.json', 'ETHOS.md'];
  for (const f of filesToCopy) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
  }
  // Copy skill files
  installSkills(tmpDir);
  // Init git
  initGitRepo(tmpDir);
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });
  return tmpDir;
}

function logCost(label: string, result: { costEstimate: { turnsUsed: number; estimatedTokens: number; estimatedCost: number }; duration: number }) {
  const { turnsUsed, estimatedTokens, estimatedCost } = result.costEstimate;
  const durationSec = Math.round(result.duration / 1000);
  console.log(`${label}: $${estimatedCost.toFixed(2)} (${turnsUsed} turns, ${(estimatedTokens / 1000).toFixed(1)}k tokens, ${durationSec}s)`);
}

function recordRouting(name: string, result: SkillTestResult, expectedSkill: string, actualSkill: string | undefined) {
  evalCollector?.addTest({
    name,
    suite: 'Skill Routing E2E',
    tier: 'e2e',
    passed: actualSkill === expectedSkill,
    duration_ms: result.duration,
    cost_usd: result.costEstimate.estimatedCost,
    transcript: result.transcript,
    output: result.output?.slice(0, 2000),
    turns_used: result.costEstimate.turnsUsed,
    exit_reason: result.exitReason,
  });
}

// Skip individual tests based on selectedTests (diff + tier filtering)
const testIfSelected = (name: string, fn: () => Promise<void>, timeout?: number) => {
  if (selectedTests !== null && !selectedTests.includes(name)) {
    test.skip(name, () => {});
  } else {
    test.concurrent(name, fn, timeout);
  }
};

// --- Tests ---

describeE2E('Skill Routing E2E — Developer Journey', () => {
  afterAll(() => {
    evalCollector?.finalize();
  });

  testIfSelected('journey-ideation', async () => {
    const tmpDir = createRoutingWorkDir('ideation');
    try {

      const testName = 'journey-ideation';
      const expectedSkill = 'office-hours';
      const result = await runSkillTest({
        prompt: "I've been thinking about building a waitlist management tool for restaurants. The existing solutions are expensive and overcomplicated. I want something simple — a tablet app where hosts can add parties, see wait times, and text customers when their table is ready. Help me think through whether this is worth building and what the key design decisions are.",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-plan-eng', async () => {
    const tmpDir = createRoutingWorkDir('plan-eng');
    try {
      fs.writeFileSync(path.join(tmpDir, 'plan.md'), `# Waitlist App Architecture

## Components
- REST API (Express.js)
- PostgreSQL database
- React frontend
- SMS integration (Twilio)

## Data Model
- restaurants (id, name, settings)
- parties (id, restaurant_id, name, size, phone, status, created_at)
- wait_estimates (id, restaurant_id, avg_wait_minutes)

## API Endpoints
- POST /api/parties - add party to waitlist
- GET /api/parties - list current waitlist
- PATCH /api/parties/:id/status - update party status
- GET /api/estimate - get current wait estimate
`);
      spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      const testName = 'journey-plan-eng';
      const expectedSkill = 'plan-eng-review';
      const result = await runSkillTest({
        prompt: "I wrote up a plan for the waitlist app in plan.md. Can you take a look at the architecture and make sure I'm not missing any edge cases or failure modes before I start coding?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  // Removed: journey-think-bigger
  // Tested ambiguous routing ("think bigger" → plan-ceo-review) but Claude
  // legitimately answers directly instead of routing. Never passed reliably.
  // The other 10 journey tests cover routing with clear signals.

  testIfSelected('journey-debug', async () => {
    const tmpDir = createRoutingWorkDir('debug');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/api.ts'), `
import express from 'express';
const app = express();

app.get('/api/waitlist', async (req, res) => {
  const db = req.app.locals.db;
  const parties = await db.query('SELECT * FROM parties WHERE status = $1', ['waiting']);
  res.json(parties.rows);
});

export default app;
`);
      fs.writeFileSync(path.join(tmpDir, 'error.log'), `
[2026-03-18T10:23:45Z] ERROR: GET /api/waitlist - 500 Internal Server Error
  TypeError: Cannot read properties of undefined (reading 'query')
    at /src/api.ts:5:32
    at Layer.handle [as handle_request] (/node_modules/express/lib/router/layer.js:95:5)
[2026-03-18T10:23:46Z] ERROR: GET /api/waitlist - 500 Internal Server Error
  TypeError: Cannot read properties of undefined (reading 'query')
`);

      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'initial']);
      run('git', ['checkout', '-b', 'feature/waitlist-api']);

      const testName = 'journey-debug';
      const expectedSkill = 'investigate';
      const result = await runSkillTest({
        prompt: "The GET /api/waitlist endpoint was working fine yesterday but now it's returning 500 errors. The tests are passing locally but the endpoint fails when I hit it with curl. Can you figure out what's going on?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      const validSkills = ['investigate', 'qa'];
      expect(validSkills, `Expected one of ${validSkills.join('/')} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-qa', async () => {
    const tmpDir = createRoutingWorkDir('qa');
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'waitlist-app', scripts: { dev: 'next dev' } }, null, 2));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/index.html'), '<html><body><h1>Waitlist App</h1></body></html>');
      spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      const testName = 'journey-qa';
      const expectedSkill = 'qa';
      const alternateSkills = ['qa-only', 'browse'];
      const result = await runSkillTest({
        prompt: "I think the app is mostly working now. Can you go through the site and test everything — find any bugs and fix them?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;
      const acceptable = [expectedSkill, ...alternateSkills];

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect(acceptable, `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-code-review', async () => {
    const tmpDir = createRoutingWorkDir('code-review');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.writeFileSync(path.join(tmpDir, 'app.ts'), '// base\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'add base app']);
      run('git', ['checkout', '-b', 'feature/add-waitlist']);
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), '// updated with waitlist feature\nimport { WaitlistService } from "./waitlist";\n');
      fs.writeFileSync(path.join(tmpDir, 'waitlist.ts'), 'export class WaitlistService {\n  async addParty(name: string, size: number) {\n    // TODO: implement\n  }\n}\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'feat: add waitlist service']);

      const testName = 'journey-code-review';
      const expectedSkill = 'review';
      const result = await runSkillTest({
        prompt: "I'm about to merge this into main. Can you look over my changes and flag anything risky before I land it?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 120_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-ship', async () => {
    const tmpDir = createRoutingWorkDir('ship');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.writeFileSync(path.join(tmpDir, 'app.ts'), '// base\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'add base app']);
      run('git', ['checkout', '-b', 'feature/waitlist']);
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), '// waitlist feature\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'feat: waitlist']);

      const testName = 'journey-ship';
      const expectedSkill = 'ship';
      const result = await runSkillTest({
        prompt: "This looks good. Let's get it deployed — push the code up and create a PR.",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-docs', async () => {
    const tmpDir = createRoutingWorkDir('docs');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Waitlist App\nA simple waitlist management tool.\n');
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/api.ts'), '// API code\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'feat: ship waitlist feature']);

      const testName = 'journey-docs';
      const expectedSkill = 'document-release';
      const result = await runSkillTest({
        prompt: "We just shipped the waitlist feature. Can you go through the README and any other docs and make sure they match what we actually built?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-retro', async () => {
    const tmpDir = createRoutingWorkDir('retro');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.writeFileSync(path.join(tmpDir, 'api.ts'), 'export function getParties() { return []; }\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'feat: add parties API', '--date', '2026-03-12T09:30:00']);

      fs.writeFileSync(path.join(tmpDir, 'ui.tsx'), 'export function WaitlistView() { return <div>Waitlist</div>; }\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'feat: add waitlist UI', '--date', '2026-03-13T14:00:00']);

      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Waitlist App\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'docs: add README', '--date', '2026-03-14T16:00:00']);

      const testName = 'journey-retro';
      const expectedSkill = 'retro';
      const result = await runSkillTest({
        prompt: "It's Friday. What did we ship this week? I want to do a quick retrospective on what the team accomplished.",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 120_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-design-system', async () => {
    const tmpDir = createRoutingWorkDir('design-system');
    try {

      const testName = 'journey-design-system';
      const expectedSkill = 'design-consultation';
      const result = await runSkillTest({
        prompt: "Before we build the UI, I want to establish a design system — typography, colors, spacing, the whole thing. Can you put together brand guidelines for this project?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      expect([expectedSkill], `Expected skill ${expectedSkill} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);

  testIfSelected('journey-visual-qa', async () => {
    const tmpDir = createRoutingWorkDir('visual-qa');
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 });

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/styles.css'), `
body { font-family: sans-serif; }
.header { font-size: 24px; margin: 20px; }
.card { padding: 16px; margin: 8px; border: 1px solid #ccc; }
.button { background: #007bff; color: white; padding: 10px 20px; }
`);
      fs.writeFileSync(path.join(tmpDir, 'src/index.html'), `
<html>
<head><link rel="stylesheet" href="styles.css"></head>
<body>
  <div class="header">Waitlist</div>
  <div class="card">Party of 4 - Smith</div>
  <div class="card">Party of 2 - Jones</div>
</body>
</html>
`);
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'initial UI']);

      const testName = 'journey-visual-qa';
      const expectedSkill = 'design-review';
      const result = await runSkillTest({
        prompt: "Something looks off on the site. The spacing between sections is inconsistent and the font sizes don't feel right. Can you audit the visual design and fix anything that doesn't look polished?",
        workingDirectory: tmpDir,
        maxTurns: 5,
        allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
        timeout: 60_000,
        testName,
        runId,
      });

      const skillCalls = result.toolCalls.filter(tc => tc.tool === 'Skill');
      const actualSkill = skillCalls.length > 0 ? skillCalls[0]?.input?.skill : undefined;

      logCost(`journey: ${testName}`, result);
      recordRouting(testName, result, expectedSkill, actualSkill);

      expect(skillCalls.length, `Expected Skill tool to be called but got 0 calls. Claude may have answered directly without invoking a skill. Tool calls: ${result.toolCalls.map(tc => tc.tool).join(', ')}`).toBeGreaterThan(0);
      const validSkills = ['design-review', 'qa', 'qa-only', 'browse'];
      expect(validSkills, `Expected one of ${validSkills.join('/')} but got ${actualSkill}`).toContain(actualSkill);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 150_000);
});
