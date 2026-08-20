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
        read('/Users/x/.claude/skills/gstack-ship/sections/version-bump.md'),
        read('ship/sections/changelog.md'),
        read('/abs/.factory/skills/gstack-ship/sections/review-army.md'),
      ],
    };
    expect(extractSectionReads(result)).toEqual(['version-bump.md', 'changelog.md', 'review-army.md']);
  });

  test('ignores non-section reads and non-Read tools', () => {
    const result = {
      toolCalls: [
        read('ship/SKILL.md'),
        read('/some/sections-like/notsections/x.md'),
        bash('cat ship/sections/version-bump.md'), // bash, not a Read
      ],
    };
    expect(extractSectionReads(result)).toEqual([]);
  });

  test('dedupes and preserves first-read order', () => {
    const result = {
      toolCalls: [
        read('ship/sections/tests.md'),
        read('ship/sections/version-bump.md'),
        read('ship/sections/tests.md'),
      ],
    };
    expect(extractSectionReads(result)).toEqual(['tests.md', 'version-bump.md']);
  });
});

describe('extractShipActions', () => {
  test('detects the full action fingerprint from bash + writes', () => {
    const result = {
      toolCalls: [
        bash('git merge origin/main'),
        bash('bun test'),
        bash('gstack-version-bump --bump minor'),
        { tool: 'Edit', input: { file_path: 'CHANGELOG.md' }, output: '' },
        bash('git commit -m "v1.2.0.0 feat"'),
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

  test('VERSION write counts as a version bump even without the CLI', () => {
    const result = { toolCalls: [{ tool: 'Write', input: { file_path: 'VERSION' }, output: '' }] };
    expect(extractShipActions(result)).toEqual(['bumped_version']);
  });

  test('empty run produces empty fingerprint', () => {
    expect(extractShipActions({ toolCalls: [] })).toEqual([]);
  });
});

describe('compareShipActions', () => {
  const baseline: ShipBaseline = {
    tag: 'monolith',
    situation: 'fresh-version-changing',
    actions: ['merged_base', 'ran_tests', 'bumped_version', 'wrote_changelog', 'committed', 'pushed', 'opened_pr'],
    sectionReads: [],
    capturedAt: '2026-05-30T00:00:00Z',
  };

  test('flags a dropped action as the carve regression', () => {
    const current = baseline.actions.filter(a => a !== 'bumped_version');
    const diff = compareShipActions(baseline, current);
    expect(diff.ok).toBe(false);
    expect(diff.missing).toEqual(['bumped_version']);
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
