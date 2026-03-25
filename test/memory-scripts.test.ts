import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const INIT_SCRIPT = path.join(ROOT, 'scripts', 'init-memory.sh');
const STATUS_SCRIPT = path.join(ROOT, 'scripts', 'gstack-status.sh');
const RESET_SCRIPT = path.join(ROOT, 'scripts', 'gstack-reset.sh');

// Fake slug and branch for tests
const TEST_SLUG = 'test-org-test-repo';
const TEST_BRANCH = 'feat-test';

function runScript(
  scriptPath: string,
  cwd: string,
  gstackHome: string
): { exitCode: number; stdout: string; stderr: string } {
  // Create a stub gstack-slug in the expected location
  const binDir = path.join(ROOT, 'bin');
  const slugScript = path.join(binDir, 'gstack-slug');

  // We override PATH so the scripts find gstack-slug from the repo's bin/
  const result = spawnSync('bash', [scriptPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GSTACK_HOME: gstackHome,
      // Override gstack-slug to return test values by creating a wrapper
      PATH: `${gstackHome}/bin:${process.env.PATH}`,
    },
    timeout: 5000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

let tmpDir: string;
let gstackHome: string;
let sessionDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-memory-test-'));
  gstackHome = path.join(tmpDir, 'home-gstack');
  sessionDir = path.join(gstackHome, 'projects', TEST_SLUG);

  // Create a fake gstack-slug that returns test values
  const binDir = path.join(gstackHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gstack-slug'),
    `#!/usr/bin/env bash\necho "SLUG=${TEST_SLUG}"\necho "BRANCH=${TEST_BRANCH}"\n`
  );
  fs.chmodSync(path.join(binDir, 'gstack-slug'), 0o755);

  // Init a git repo in tmpDir so gstack-slug fallback doesn't error
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['checkout', '-b', TEST_BRANCH], { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// init-memory.sh tests
// ============================================================
describe('init-memory.sh', () => {

  test('creates session dir and team knowledge dir', () => {
    const { exitCode, stdout } = runScript(INIT_SCRIPT, tmpDir, gstackHome);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('gstack memory initialized');

    // Session state in ~/.gstack/projects/$SLUG/
    expect(fs.existsSync(path.join(sessionDir, 'state.md'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, `findings-${TEST_BRANCH}.md`))).toBe(true);

    // Team knowledge in .gstack/
    expect(fs.existsSync(path.join(tmpDir, '.gstack', 'decisions.log'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.gstack', 'anti-patterns.md'))).toBe(true);
  });

  test('state.md contains expected fields', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const content = fs.readFileSync(path.join(sessionDir, 'state.md'), 'utf-8');
    expect(content).toContain('skill: null');
    expect(content).toContain('phase: idle');
    expect(content).toContain('turn: 0');
  });

  test('findings file is branch-scoped and contains header', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const content = fs.readFileSync(
      path.join(sessionDir, `findings-${TEST_BRANCH}.md`),
      'utf-8'
    );
    expect(content).toContain('# Findings Registry');
    expect(content).toContain(TEST_BRANCH);
    expect(content).toContain('source of truth');
  });

  test('anti-patterns.md contains expected header', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const content = fs.readFileSync(
      path.join(tmpDir, '.gstack', 'anti-patterns.md'),
      'utf-8'
    );
    expect(content).toContain('# Anti-Patterns Registry');
  });

  test('decisions.log is created empty', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const content = fs.readFileSync(
      path.join(tmpDir, '.gstack', 'decisions.log'),
      'utf-8'
    );
    expect(content).toBe('');
  });

  test('idempotent: running twice does not overwrite existing files', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);

    // Modify state.md
    const statePath = path.join(sessionDir, 'state.md');
    const modified = 'skill: review\nphase: testing\nturn: 5\n';
    fs.writeFileSync(statePath, modified);

    // Run again
    runScript(INIT_SCRIPT, tmpDir, gstackHome);

    // Should NOT be overwritten
    const content = fs.readFileSync(statePath, 'utf-8');
    expect(content).toBe(modified);
  });
});

// ============================================================
// gstack-status.sh tests
// ============================================================
describe('gstack-status.sh', () => {

  test('no session: shows project info and "No active session"', () => {
    const { exitCode, stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(TEST_SLUG);
    expect(stdout).toContain('No active session');
  });

  test('initialized session shows defaults', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const { exitCode, stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('idle');
    expect(stdout).toContain('Findings');
  });

  test('correctly distinguishes UNRESOLVED vs RESOLVED findings', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const findings = `# Findings Registry — ${TEST_BRANCH}

---

### F001 — [P0] SQL injection
- **Status:** UNRESOLVED
- **File:** auth.py:42

### F002 — [P1] Missing null check
- **Status:** RESOLVED
- **File:** user.py:23

### F003 — [P1] Race condition
- **Status:** UNRESOLVED
- **File:** payment.py:187
`;
    fs.writeFileSync(
      path.join(sessionDir, `findings-${TEST_BRANCH}.md`),
      findings
    );
    const { stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(stdout).toContain('2 unresolved');
    expect(stdout).toContain('1 resolved');
  });

  test('shows team knowledge status', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const decisions = `[2026-03-20T14:35:00Z] DECISION: Skip CSS linting
CONTEXT: User confirmed backend-only review
SKILL: /review
`;
    fs.writeFileSync(path.join(tmpDir, '.gstack', 'decisions.log'), decisions);
    const { stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(stdout).toContain('Decisions:');
    expect(stdout).toContain('lines logged');
  });

  test('shows anti-pattern count', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    const antiPatterns = `# Anti-Patterns Registry

---

### AP001 — Mutex-based payment fix
- **Attempted:** 2026-03-20T14:42:00Z
- **Why it failed:** Deadlock under concurrent requests
`;
    fs.writeFileSync(
      path.join(tmpDir, '.gstack', 'anti-patterns.md'),
      antiPatterns
    );
    const { stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(stdout).toContain('Anti-patterns: 1');
  });

  test('detects handoff presence', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    fs.writeFileSync(path.join(sessionDir, 'handoff.md'), '# Handoff');
    const { stdout } = runScript(STATUS_SCRIPT, tmpDir, gstackHome);
    expect(stdout).toContain('Handoff: present');
  });
});

// ============================================================
// gstack-reset.sh tests
// ============================================================
describe('gstack-reset.sh', () => {

  test('no session: prints "Nothing to reset" and exits 0', () => {
    const { exitCode, stdout } = runScript(RESET_SCRIPT, tmpDir, gstackHome);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Nothing to reset');
  });

  test('archives session state before resetting', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);

    // Populate session state
    fs.writeFileSync(path.join(sessionDir, 'state.md'), 'skill: review\nphase: done\nturn: 10\n');
    fs.writeFileSync(
      path.join(sessionDir, `findings-${TEST_BRANCH}.md`),
      '# Test findings'
    );
    fs.writeFileSync(path.join(sessionDir, 'handoff.md'), '# Handoff');

    // Populate team knowledge
    fs.writeFileSync(path.join(tmpDir, '.gstack', 'decisions.log'), 'DECISION: test');

    // Reset
    const { exitCode, stdout } = runScript(RESET_SCRIPT, tmpDir, gstackHome);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Archived session state');
    expect(stdout).toContain('Team knowledge (.gstack/) preserved');

    // Check archive exists in session dir
    const archives = fs.readdirSync(sessionDir).filter(f => f.startsWith('archive-'));
    expect(archives.length).toBe(1);

    // Check archive contains session files
    const archiveDir = path.join(sessionDir, archives[0]);
    expect(fs.existsSync(path.join(archiveDir, 'state.md'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, `findings-${TEST_BRANCH}.md`))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'handoff.md'))).toBe(true);

    // Team knowledge should be preserved (NOT archived or deleted)
    expect(fs.readFileSync(path.join(tmpDir, '.gstack', 'decisions.log'), 'utf-8')).toBe('DECISION: test');
  });

  test('re-initializes after reset', () => {
    runScript(INIT_SCRIPT, tmpDir, gstackHome);
    fs.writeFileSync(path.join(sessionDir, 'state.md'), 'skill: review\nphase: done\nturn: 10\n');

    runScript(RESET_SCRIPT, tmpDir, gstackHome);

    // state.md should be fresh
    const content = fs.readFileSync(path.join(sessionDir, 'state.md'), 'utf-8');
    expect(content).toContain('skill: null');
    expect(content).toContain('phase: idle');
  });
});
