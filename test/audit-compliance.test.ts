import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

function getAllSkillMds(): Array<{ name: string; content: string }> {
  const results: Array<{ name: string; content: string }> = [];
  const rootPath = join(ROOT, 'SKILL.md');
  if (existsSync(rootPath)) {
    results.push({ name: 'root', content: readFileSync(rootPath, 'utf-8') });
  }
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const skillPath = join(ROOT, entry.name, 'SKILL.md');
    if (existsSync(skillPath)) {
      results.push({ name: entry.name, content: readFileSync(skillPath, 'utf-8') });
    }
  }
  return results;
}

describe('Audit compliance', () => {
  // Fix 1: W007 — No hardcoded credentials in documentation
  test('no hardcoded credential patterns in SKILL.md.tmpl', () => {
    const tmpl = readFileSync(join(ROOT, 'SKILL.md.tmpl'), 'utf-8');
    expect(tmpl).not.toContain('"password123"');
    expect(tmpl).not.toContain('"test@example.com"');
    expect(tmpl).not.toContain('"test@test.com"');
    expect(tmpl).toContain('$TEST_EMAIL');
    expect(tmpl).toContain('$TEST_PASSWORD');
  });

  // Fix 2: Conditional telemetry — binary calls wrapped with existence check
  test('preamble telemetry calls are conditional on _TEL and binary existence', () => {
    const preamble = readFileSync(join(ROOT, 'scripts/resolvers/preamble.ts'), 'utf-8');
    // Pending finalization must check _TEL and binary existence
    expect(preamble).toContain('_TEL" != "off"');
    expect(preamble).toContain('-x ');
    expect(preamble).toContain('gstack-telemetry-log');
    // End-of-skill telemetry must also be conditional
    const completionIdx = preamble.indexOf('Telemetry (run last)');
    expect(completionIdx).toBeGreaterThan(-1);
    const completionSection = preamble.slice(completionIdx);
    expect(completionSection).toContain('_TEL" != "off"');
  });

  // Round 2 Fix 1: W012 — Bun install uses checksum verification
  test('bun install uses checksum-verified method', () => {
    const browseResolver = readFileSync(join(ROOT, 'scripts/resolvers/browse.ts'), 'utf-8');
    expect(browseResolver).toContain('shasum -a 256');
    expect(browseResolver).toContain('BUN_INSTALL_SHA');
    const setup = readFileSync(join(ROOT, 'setup'), 'utf-8');
    // Setup error message should not have unverified curl|bash
    const lines = setup.split('\n');
    for (const line of lines) {
      if (line.includes('bun.sh/install') && line.includes('| bash') && !line.includes('shasum')) {
        throw new Error(`Unverified bun install found: ${line.trim()}`);
      }
    }
  });

  // Fix 4: W011 — Untrusted content warning in command reference
  test('command reference includes untrusted content warning after Navigation', () => {
    const rootSkill = readFileSync(join(ROOT, 'SKILL.md'), 'utf-8');
    const navIdx = rootSkill.indexOf('### Navigation');
    const readingIdx = rootSkill.indexOf('### Reading');
    expect(navIdx).toBeGreaterThan(-1);
    expect(readingIdx).toBeGreaterThan(navIdx);
    const between = rootSkill.slice(navIdx, readingIdx);
    expect(between.toLowerCase()).toContain('untrusted');
  });

  // Round 2 Fix 2: Trust boundary markers + helper + wrapping in all paths
  test('browse wraps untrusted content with trust boundary markers', () => {
    const commands = readFileSync(join(ROOT, 'browse/src/commands.ts'), 'utf-8');
    expect(commands).toContain('PAGE_CONTENT_COMMANDS');
    expect(commands).toContain('wrapUntrustedContent');
    const server = readFileSync(join(ROOT, 'browse/src/server.ts'), 'utf-8');
    expect(server).toContain('wrapUntrustedContent');
    const meta = readFileSync(join(ROOT, 'browse/src/meta-commands.ts'), 'utf-8');
    expect(meta).toContain('wrapUntrustedContent');
  });

  // Fix 5: Data flow documentation in review.ts
  test('review.ts has data flow documentation', () => {
    const review = readFileSync(join(ROOT, 'scripts/resolvers/review.ts'), 'utf-8');
    expect(review).toContain('Data sent');
    expect(review).toContain('Data NOT sent');
  });

  // Round 2 Fix 3: Extension sender validation + message type allowlist
  test('extension background.js validates message sender', () => {
    const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf-8');
    expect(bg).toContain('sender.id !== chrome.runtime.id');
    expect(bg).toContain('ALLOWED_TYPES');
  });

  // Round 2 Fix 4: Chrome CDP binds to localhost only
  test('chrome-cdp binds to localhost only', () => {
    const cdp = readFileSync(join(ROOT, 'bin/chrome-cdp'), 'utf-8');
    expect(cdp).toContain('--remote-debugging-address=127.0.0.1');
    expect(cdp).toContain('--remote-allow-origins=');
  });

  // Fix 2+6: All generated SKILL.md files with telemetry are conditional
  test('all generated SKILL.md files with telemetry calls use conditional pattern', () => {
    const skills = getAllSkillMds();
    for (const { name, content } of skills) {
      if (content.includes('gstack-telemetry-log')) {
        expect(content).toContain('_TEL" != "off"');
      }
    }
  });

  test('git does not track local-only state or generated runtime artifacts', () => {
    const result = Bun.spawnSync(['git', 'ls-files'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);

    const trackedFiles = result.stdout
      .toString()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const forbiddenPatterns = [
      /^\.env($|\.)/,
      /^\.claude\//,
      /^\.codex\//,
      /^\.gstack\//,
      /^extension\/\.auth\.json$/,
      /^browse\/dist\//,
      /^design\/dist\//,
      /^\.vscode\/(launch|extensions)\.json$/,
    ];

    const offenders = trackedFiles.filter(file => {
      if (file === '.env.example') {
        return false;
      }
      return forbiddenPatterns.some(pattern => pattern.test(file));
    });

    expect(offenders).toEqual([]);
  });

  test('gitignore covers local-only env and editor files', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf-8');

    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.*');
    expect(gitignore).toContain('extension/.auth.json');
    expect(gitignore).toContain('.vscode/launch.json');
    expect(gitignore).toContain('.vscode/extensions.json');
  });

  test('dockerignore excludes local secrets and agent state from build context', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');

    expect(dockerignore).toContain('.env');
    expect(dockerignore).toContain('.env.*');
    expect(dockerignore).toContain('.gstack');
    expect(dockerignore).toContain('.claude');
    expect(dockerignore).toContain('.codex');
  });

  test('dockerfiles use checksum-verified Bun install instead of curl piping into bash', () => {
    const runtimeDockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');
    const ciDockerfile = readFileSync(join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf-8');

    for (const content of [runtimeDockerfile, ciDockerfile]) {
      expect(content).toContain('BUN_INSTALL_SHA');
      expect(content).toContain('sha256sum');
      expect(content).toContain('curl -fsSL https://bun.sh/install -o "$tmpfile"');
      expect(content).not.toContain('curl -fsSL https://bun.sh/install |');
    }
  });

  test('eval workflows mask provider secrets and keep artifact retention short', () => {
    const evalsWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'evals.yml'), 'utf-8');
    const periodicWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'evals-periodic.yml'), 'utf-8');

    for (const content of [evalsWorkflow, periodicWorkflow]) {
      expect(content).toContain('name: Mask provider secrets');
      expect(content).toContain('::add-mask::');
      expect(content).toContain('retention-days: 14');
    }
  });

  test('readme documents published-image usage without a full repo clone', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8');

    expect(readme).toContain('Use The Published Image Without Cloning gstack');
    expect(readme).toContain('You do not need a full checkout of this repo to use the published container.');
    expect(readme).toContain('Keep local-only state out of git:');
  });

  test('security check entrypoints exist in package, make, and CI', () => {
    const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf-8');
    const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf-8');
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'security-policy.yml'), 'utf-8');

    expect(packageJson).toContain('"security:check"');
    expect(packageJson).toContain('bun run stack:health --only audit-compliance');
    expect(makefile).toContain('security_check:');
    expect(makefile).toContain('bun run security:check');
    expect(workflow).toContain('name: Security Policy');
    expect(workflow).toContain('bun run security:check');
  });
});
