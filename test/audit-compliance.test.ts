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
    // P2 (v1.2.0): the browse QA examples moved from the root router to
    // browse/SKILL.md.tmpl. The security intent is unchanged — the QA form
    // examples must not ship real-looking credentials; generic placeholders
    // ("user@test.com", "password") are fine.
    const tmpl = readFileSync(join(ROOT, 'browse', 'SKILL.md.tmpl'), 'utf-8');
    expect(tmpl).not.toContain('"password123"');
    expect(tmpl).not.toContain('"test@example.com"');
    expect(tmpl).not.toContain('"test@test.com"');
  });

  // Fix 2: Conditional telemetry — binary calls wrapped with existence check
  test('preamble telemetry calls are conditional on _TEL and binary existence', () => {
    // Token-reduction Phase 1: the preamble's telemetry bash moved from the
    // resolvers into bin/gstack-skill-start (pending finalization) and
    // bin/gstack-skill-end (end-of-skill telemetry). Assert the semantic
    // contract against the scripts — the new home of the calls.
    const skillStart = readFileSync(join(ROOT, 'bin/gstack-skill-start'), 'utf-8');
    // Pending finalization must check _TEL and binary existence
    expect(skillStart).toContain('_TEL" != "off"');
    expect(skillStart).toContain('-x ');
    expect(skillStart).toContain('gstack-telemetry-log');
    // End-of-skill telemetry (gstack-skill-end) must also be conditional
    const skillEnd = readFileSync(join(ROOT, 'bin/gstack-skill-end'), 'utf-8');
    expect(skillEnd).toContain('_TEL" != "off"');
    expect(skillEnd).toContain('-x ');
    expect(skillEnd).toContain('gstack-telemetry-log');
    // The render-side epilogue prose survives in the resolvers and hands off
    // to gstack-skill-end.
    const preambleDir = join(ROOT, 'scripts/resolvers/preamble');
    const submoduleFiles = existsSync(preambleDir)
      ? readdirSync(preambleDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(preambleDir, f), 'utf-8'))
      : [];
    const preamble = submoduleFiles.join('\n');
    const completionIdx = preamble.indexOf('Telemetry (run last)');
    expect(completionIdx).toBeGreaterThan(-1);
    expect(preamble.slice(completionIdx)).toContain('gstack-skill-end');
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
    // Browse carve (token-reduction Phase 4): the command reference renders
    // into the on-demand section browse/sections/command-list.md. Read the
    // skeleton+section union so the pin holds across regeneration.
    let rootSkill = readFileSync(join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    const sectionPath = join(ROOT, 'browse', 'sections', 'command-list.md');
    if (existsSync(sectionPath)) rootSkill += '\n' + readFileSync(sectionPath, 'utf-8');
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
  // Fix 2+6: All generated SKILL.md files with telemetry are conditional
  test('all generated SKILL.md files with telemetry calls use conditional pattern', () => {
    // Phase 1 moved the _TEL-gated bash into the scripts. Render-side
    // gstack-telemetry-log calls (route + first-task events) rely on two
    // layers instead: every call line is best-effort (`|| true`), and the
    // binary itself no-ops when the telemetry tier is off.
    const telLog = readFileSync(join(ROOT, 'bin/gstack-telemetry-log'), 'utf-8');
    expect(telLog).toContain('if [ "$TIER" = "off" ]');
    expect(telLog).toMatch(/if \[ "\$TIER" = "off" \][\s\S]{0,200}?exit 0/);

    const skills = getAllSkillMds();
    let checked = 0;
    for (const { name, content } of skills) {
      for (const line of content.split('\n')) {
        if (!line.includes('gstack-telemetry-log')) continue;
        // Prose mentions aren't calls; only executable lines invoke the binary.
        if (!line.includes('bin/gstack-telemetry-log')) continue;
        checked++;
        expect(line, `${name}: telemetry call must be best-effort`).toContain('|| true');
        expect(line, `${name}: telemetry call must not surface errors`).toContain('2>/dev/null');
      }
    }
    // Guard against the scan silently matching nothing.
    expect(checked).toBeGreaterThan(0);
  });
});
