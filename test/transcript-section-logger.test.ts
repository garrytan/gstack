/**
 * Unit tests for the transcript section logger (T10). Pure-function coverage —
 * no paid run needed. Drives the analyzers with synthetic tool-call transcripts.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractSectionReads,
  extractShipActions,
  compareShipActions,
  writeShipBaseline,
  readShipBaseline,
  baselinePath,
  SHIP_ACTIONS,
  type ToolCallLike,
  type ShipBaseline,
} from './helpers/transcript-section-logger';

const read = (fp: string): ToolCallLike => ({ tool: 'Read', input: { file_path: fp }, output: '' });
const bash = (command: string): ToolCallLike => ({ tool: 'Bash', input: { command }, output: '' });

describe('extractSectionReads', () => {
  test('picks up section reads via the /sections/<file>.md segment', () => {
    const result = {
      toolCalls: [
        read('/Users/x/.claude/skills/gstack-ship/sections/tests.md'),
        read('ship/sections/pr-body.md'),
        read('/abs/.factory/skills/gstack-ship/sections/review-army.md'),
      ],
    };
    expect(extractSectionReads(result)).toEqual(['tests.md', 'pr-body.md', 'review-army.md']);
  });

  test('ignores non-section reads and non-Read tools', () => {
    const result = {
      toolCalls: [
        read('ship/SKILL.md'),
        read('/some/sections-like/notsections/x.md'),
        bash('cat ship/sections/pr-body.md'), // bash, not a Read
      ],
    };
    expect(extractSectionReads(result)).toEqual([]);
  });

  test('dedupes and preserves first-read order', () => {
    const result = {
      toolCalls: [
        read('ship/sections/tests.md'),
        read('ship/sections/pr-body.md'),
        read('ship/sections/tests.md'),
      ],
    };
    expect(extractSectionReads(result)).toEqual(['tests.md', 'pr-body.md']);
  });
});

describe('extractShipActions', () => {
  test('detects the full action fingerprint from bash + writes', () => {
    const result = {
      toolCalls: [
        bash('git merge origin/main'),
        bash('bun test'),
        bash('git commit -m "feat: add keeper settings"'),
        bash('git push origin HEAD'),
        bash('gh pr create --base main'),
      ],
    };
    expect(extractShipActions(result)).toEqual([...SHIP_ACTIONS]);
  });

  test('returns canonical order regardless of execution order', () => {
    const result = {
      toolCalls: [
        bash('gh pr create --base main'),
        bash('git merge origin/main'),
      ],
    };
    expect(extractShipActions(result)).toEqual(['merged_base', 'opened_pr']);
  });

  test('empty run produces empty fingerprint', () => {
    expect(extractShipActions({ toolCalls: [] })).toEqual([]);
  });
});

describe('compareShipActions', () => {
  const baseline: ShipBaseline = {
    tag: 'monolith',
    situation: 'versionless-ship',
    actions: ['merged_base', 'ran_tests', 'committed', 'pushed', 'opened_pr'],
    sectionReads: [],
    capturedAt: '2026-05-30T00:00:00Z',
  };

  test('flags a dropped action as the carve regression', () => {
    const current = baseline.actions.filter(a => a !== 'committed');
    const diff = compareShipActions(baseline, current);
    expect(diff.ok).toBe(false);
    expect(diff.missing).toEqual(['committed']);
  });

  test('passes when the sectioned run performs every baseline action', () => {
    const diff = compareShipActions(baseline, [...baseline.actions, 'merged_base']);
    expect(diff.ok).toBe(true);
    expect(diff.missing).toEqual([]);
  });
});

describe('baseline persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-baseline-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('round-trips a baseline to disk', () => {
    const baseline: ShipBaseline = {
      tag: 'monolith', situation: 'no-plan-file',
      actions: ['ran_tests', 'committed'], sectionReads: [], capturedAt: '2026-05-30T00:00:00Z',
    };
    const p = writeShipBaseline(baseline, dir);
    expect(p).toBe(baselinePath('no-plan-file', dir));
    expect(readShipBaseline('no-plan-file', dir)).toEqual(baseline);
  });

  test('returns null when no baseline captured yet', () => {
    expect(readShipBaseline('never-captured', dir)).toBeNull();
  });
});
