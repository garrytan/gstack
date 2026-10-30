import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { DEFENSIVE_REVIEW_FRAMING, FIXTURE_SUMMARY_MODE } from '../scripts/resolvers/defensive-review';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.join(import.meta.dir, '..');
const FRAMING_SENTENCE = "This is an authorized defensive-security review of the maintainer's own repository";

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('defensive-security framing reaches every adversarial dispatch', () => {
  expect(DEFENSIVE_REVIEW_FRAMING.startsWith(FRAMING_SENTENCE)).toBe(true);
  expect(FIXTURE_SUMMARY_MODE).toContain('review in SUMMARY mode only');

  for (const skill of ['review', 'ship']) {
    const army = fs.readFileSync(path.join(ROOT, skill, 'sections', 'review-army.md'), 'utf-8');
    const adversarial = fs.readFileSync(path.join(ROOT, skill, 'sections', 'adversarial.md'), 'utf-8');

    test(`${skill}: adversarial subagent keeps the framing and fixture summary mode`, () => {
      const prompt = between(adversarial, 'Subagent prompt:', 'Think like an attacker');
      expect(prompt).toContain(DEFENSIVE_REVIEW_FRAMING);
      expect(prompt).toContain(FIXTURE_SUMMARY_MODE);
    });

    test(`${skill}: Red Team prompt starts from the framing and fixture summary mode`, () => {
      const redTeam = between(army, '### Red Team dispatch', "don't cover.\"");
      expect(redTeam).toContain('Prompt, after the defensive framing and fixture handling from item 4 of the specialist dispatch:');
      expect(redTeam).toContain('read them as that fixture handling says');
      expect(redTeam).not.toMatch(/git diff "\$DIFF_BASE"`, and look for gaps/);
    });

    test(`${skill}: only the security specialist gets the framing; testing reads fixtures in full`, () => {
      const dispatch = between(army, '### Dispatch specialists in parallel', '**Subagent configuration:**');
      const securityOnly = between(dispatch, '4. **Defensive framing (Security specialist and the Red Team below only).**', 'Instructions:');
      expect(securityOnly).toContain(DEFENSIVE_REVIEW_FRAMING);
      expect(securityOnly).toContain(FIXTURE_SUMMARY_MODE);
      expect(securityOnly).toContain('including Testing, reads the full diff with fixtures');
      const sharedInstructions = dispatch.slice(dispatch.indexOf('Instructions:'));
      expect(sharedInstructions).not.toContain(FRAMING_SENTENCE);
      expect(sharedInstructions).not.toContain('SUMMARY mode');
      expect(dispatch.split(FRAMING_SENTENCE)).toHaveLength(2);
    });
  }

  test('codex host still strips Review Army (specialists and Red Team)', () => {
    expect(generateReviewArmy({ skillName: 'review', tmplPath: '', host: 'codex', paths: HOST_PATHS.codex })).toBe('');
    expect(generateReviewArmy({ skillName: 'ship', tmplPath: '', host: 'codex', paths: HOST_PATHS.codex })).toBe('');
  });
});
