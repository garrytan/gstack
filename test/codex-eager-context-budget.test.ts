import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const BASELINE_BYTES: Record<string, number> = {
  review: 16308,
  ship: 16178,
  'land-and-deploy': 16230,
};
const INVARIANTS = [
  'ECPE-SCOPE-RESOLUTION',
  'ECPE-EXPLICIT-EFFECT-SEPARATION',
  'ECPE-TRUSTED-SUBJECT-IDENTITY',
  'ECPE-HARD-STOP',
  'ECPE-FINAL-EVIDENCE-HONESTY',
];

function eagerPrefix(skill: string): string {
  const content = fs.readFileSync(path.join(root, `.agents/skills/gstack-${skill}/SKILL.md`), 'utf8');
  const step = content.indexOf('## Step 0');
  expect(step).toBeGreaterThan(0);
  return content.slice(0, step);
}

describe('Codex governed eager context budget', () => {
  test('review/ship/land pre-Step0 context shrinks by at least 40% and stays under 16 KiB', () => {
    for (const [skill, baseline] of Object.entries(BASELINE_BYTES)) {
      const bytes = Buffer.byteLength(eagerPrefix(skill));
      expect(bytes).toBeLessThanOrEqual(Math.floor(baseline * 0.6));
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
    }
  });

  test('the five eager safety invariants remain exactly once', () => {
    for (const skill of Object.keys(BASELINE_BYTES)) {
      const prefix = eagerPrefix(skill);
      for (const invariant of INVARIANTS) {
        expect(prefix.split(invariant)).toHaveLength(2);
      }
    }
  });
});
