import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CORPORA = [
  { lens: 'insider-abuse', phase: 'Phase 1 READY' },
  { lens: 'enterprise-readiness', phase: 'Phase 2 DRAFT' },
];
const REQUIRED_KINDS = new Set([
  'positive', 'negative', 'insufficient_evidence', 'prompt_injection', 'malformed_output', 'baseline_comparison', 'rerun_stability',
]);

describe('stakeholder lens regression fixture corpus', () => {
  for (const corpus of CORPORA) {
    test(`${corpus.lens} has a balanced ${corpus.phase} corpus`, () => {
      const file = path.join(ROOT, 'test', 'fixtures', 'lens-regression', corpus.lens, 'cases.json');
      const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
      expect(cases).toHaveLength(9);
      expect(new Set(cases.map((item) => item.id)).size).toBe(9);
      const kinds = new Set(cases.map((item) => item.kind));
      for (const required of REQUIRED_KINDS) expect(kinds.has(required)).toBe(true);
      expect(cases.filter((item) => item.kind === 'positive')).toHaveLength(2);
      expect(cases.filter((item) => item.kind === 'negative')).toHaveLength(2);
      expect(cases.filter((item) => item.kind === 'rerun_stability')).toHaveLength(1);
    });
  }
});
