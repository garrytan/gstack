/**
 * Static-grep tripwire for PTY slash-command skill seeding. Free tier — no API.
 *
 * The default hermetic config dir registers NO skills, so a PTY test that
 * TYPES a /skill slash command against it gets "Unknown command" before any
 * model turn — the test still runs, still spends money, and measures nothing.
 * Every test file that sends a slash command over the PTY must therefore
 * either route through a runPlanSkill* helper (which opts in for you) or pass
 * `seedSkills: true` in its own launchClaudePty options.
 *
 * Pattern mirrors test/hermetic-wiring.test.ts: read sources as text, assert
 * invariants on their contents. Brittle by design — changing the seeding
 * wiring must force the author to look here.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.path, '..', '..');

/** A PTY send whose payload starts with a slash command (`/name`, optionally
 * followed by `\r`, whitespace, or the closing quote). A second slash right
 * after the name (a file path like '/tmp/x') does NOT match. */
const SLASH_SEND = /\.send\(\s*(['"`])\/[a-z][a-z0-9-]*(\\r|\s|\1)/;

const RUN_PLAN_HELPER = /\brunPlanSkill(Observation|Counting|FloorCheck)\s*\(/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('PTY skill-seeding tripwire', () => {
  test('every slash-command PTY test seeds skills (helper or seedSkills: true)', () => {
    const offenders: string[] = [];
    for (const full of testFiles(path.join(ROOT, 'test'))) {
      if (path.basename(full) === 'pty-skill-seeding-wiring.test.ts') continue;
      const src = fs.readFileSync(full, 'utf-8');
      const lines = src.split('\n');
      const sendLine = lines.findIndex((l) => SLASH_SEND.test(l));
      if (sendLine === -1) continue;
      if (RUN_PLAN_HELPER.test(src)) continue;
      if (src.includes('seedSkills: true')) continue;
      offenders.push(`${path.relative(ROOT, full)}:${sendLine + 1}`);
    }
    expect(
      offenders,
      'These tests type a /skill slash command into a hermetic PTY child that has ' +
        'no skills registered — claude rejects it as Unknown command and the test ' +
        'measures nothing. Pass seedSkills: true to launchClaudePty (or route ' +
        'through a runPlanSkill* helper): ' + offenders.join(', '),
    ).toEqual([]);
  });

  test('the runPlanSkill* helpers all opt in via seedSkills: true', () => {
    // The helper family types slash commands on behalf of ~20 test files;
    // dropping the opt-in there silently un-measures all of them at once.
    const src = fs.readFileSync(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'), 'utf-8');
    const optIns = src.match(/seedSkills: true/g) ?? [];
    expect(optIns.length).toBeGreaterThanOrEqual(3);
  });

  test('launchClaudePty wires seedSkills to hermeticSkillsConfigDir()', () => {
    const src = fs.readFileSync(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'), 'utf-8');
    // Gated on hermetic (EVALS_HERMETIC=0 must keep the operator config) and
    // on the per-test env override (explicit CLAUDE_CONFIG_DIR wins).
    const wired =
      /if\s*\(opts\.seedSkills && hermetic && !opts\.env\?\.CLAUDE_CONFIG_DIR\)\s*\{\s*\n\s*childEnv\.CLAUDE_CONFIG_DIR = hermeticSkillsConfigDir\(\);/.test(src);
    expect(wired, 'launchClaudePty must set CLAUDE_CONFIG_DIR from hermeticSkillsConfigDir() when seedSkills && hermetic && no per-test override').toBe(true);
  });
});
