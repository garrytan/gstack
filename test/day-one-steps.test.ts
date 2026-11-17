import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { DAY_ONE_BLOCK, DAY_ONE_STEPS } from '../lib/day-one-steps';
import { leanPrompt } from '../lib/autoplan-lean';
import type { RunState } from '../lib/autoplan-state';

const ROOT = path.resolve(import.meta.dir, '..');

// GST-2947: the day-one pass sits above the preamble, in the first 4 KB, byte-identical in every plan review.
test.each(['plan-ceo-review', 'plan-design-review', 'autoplan'])('%s renders the day-one block once, above the preamble, in its first 4 KB', skill => {
  const text = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf8');
  const at = text.indexOf(DAY_ONE_BLOCK);
  expect(at).toBeGreaterThan(-1);
  expect(text.indexOf(DAY_ONE_BLOCK, at + 1)).toBe(-1);
  expect(Buffer.byteLength(text.slice(0, at))).toBeLessThan(4096);
  expect(at).toBeLessThan(text.indexOf('## Shared preamble (load first)'));
});

test('the lean reviewer reads the day-one steps before any lens', () => {
  const state = { scope: { ui: true, dx: false, ui_matches: 1, dx_matches: 0, developer_tool: false, agent_primary: false, sources: { ui: 'flag', dx: 'flag' } } } as unknown as RunState;
  const { brief } = leanPrompt(state, { base: 'origin/main', none: 'no code changes against origin/main' }, ROOT);
  const steps = brief.indexOf(DAY_ONE_STEPS);
  expect(steps).toBeGreaterThan(-1);
  expect(steps).toBeLessThan(brief.indexOf('### CEO lens'));
  expect(brief).toContain('### Design lens');
});
