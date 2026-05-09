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
    // After the preamble.ts refactor (Item 9), the bash/telemetry logic lives
    // in submodules under scripts/resolvers/preamble/. Concatenate all preamble
    // source (root + submodules) and assert against the combined text so this
    // test tracks the semantic contract, not the file layout.
    const preambleDir = join(ROOT, 'scripts/resolvers/preamble');
    const submoduleFiles = existsSync(preambleDir)
      ? readdirSync(preambleDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(preambleDir, f), 'utf-8'))
      : [];
    const rootPreamble = readFileSync(join(ROOT, 'scripts/resolvers/preamble.ts'), 'utf-8');
    const preamble = [rootPreamble, ...submoduleFiles].join('\n');
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
});
