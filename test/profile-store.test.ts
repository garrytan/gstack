/**
 * scripts/profile-store.ts — pure-function unit tests (no subprocess, no fs).
 * Fast guard for the merge/aggregate/reconcile logic behind /office-hours
 * profile persistence.
 */

import { describe, test, expect } from 'bun:test';
import {
  emptyProfile,
  recompute,
  appendSession,
  mergeResources,
  migrateLegacy,
  foldLegacy,
  realSessions,
  designTitle,
  isResourcesRow,
} from '../scripts/profile-store';

describe('appendSession', () => {
  test('adds a session and stamps a date when missing', () => {
    const p = appendSession(emptyProfile(), { mode: 'builder', assignment: 'x' });
    expect(p.sessions.length).toBe(1);
    expect(typeof p.sessions[0].date).toBe('string');
    expect(p.sessions[0].date!.length).toBeGreaterThan(0);
  });

  test('preserves a provided date verbatim', () => {
    const p = appendSession(emptyProfile(), { date: '2026-01-02T03:04:05Z', mode: 'builder' });
    expect(p.sessions[0].date).toBe('2026-01-02T03:04:05Z');
  });

  test('tallies signals across appended sessions', () => {
    let p = emptyProfile();
    p = appendSession(p, { signals: ['taste', 'agency'] });
    p = appendSession(p, { signals: ['taste'] });
    expect(p.signals_accumulated.taste).toBe(2);
    expect(p.signals_accumulated.agency).toBe(1);
  });

  test('rejects non-object entries', () => {
    expect(() => appendSession(emptyProfile(), 'nope' as unknown as Record<string, unknown>)).toThrow();
    expect(() => appendSession(emptyProfile(), [1, 2] as unknown as Record<string, unknown>)).toThrow();
  });
});

describe('mergeResources', () => {
  test('unions resources and dedups', () => {
    let p = emptyProfile();
    p = mergeResources(p, { resources_shown: ['a', 'b'] });
    p = mergeResources(p, { resources_shown: ['b', 'c'] });
    expect(p.resources_shown.sort()).toEqual(['a', 'b', 'c']);
  });

  test('does not add a session', () => {
    const p = mergeResources(emptyProfile(), { resources_shown: ['a'] });
    expect(p.sessions.length).toBe(0);
  });

  test('recompute preserves merged resources (never shrinks)', () => {
    let p = mergeResources(emptyProfile(), { resources_shown: ['kept'] });
    p = appendSession(p, { mode: 'builder', resources_shown: ['from-session'] });
    expect(p.resources_shown.sort()).toEqual(['from-session', 'kept']);
  });
});

describe('migrateLegacy', () => {
  test('counts dropped malformed lines instead of silently losing them', () => {
    const { profile, dropped } = migrateLegacy([
      JSON.stringify({ mode: 'builder', signals: ['taste'] }),
      '{ broken',
      JSON.stringify({ mode: 'startup', signals: ['pushback'] }),
    ]);
    expect(dropped).toBe(1);
    expect(profile.sessions.length).toBe(2);
    expect(profile.signals_accumulated.taste).toBe(1);
  });

  test('resource rows do not become sessions but their resources merge', () => {
    const { profile } = migrateLegacy([
      JSON.stringify({ mode: 'builder', assignment: 'real' }),
      JSON.stringify({ mode: 'resources', resources_shown: ['https://r'] }),
    ]);
    expect(profile.sessions.length).toBe(1);
    expect(profile.resources_shown).toEqual(['https://r']);
  });
});

describe('foldLegacy', () => {
  test('adds only sessions not already present (dedup by signature)', () => {
    let p = appendSession(emptyProfile(), { date: 'd1', mode: 'builder', project_slug: 'app', assignment: 's1' });
    const before = p.sessions.length;
    const { profile, added } = foldLegacy(p, [
      JSON.stringify({ date: 'd1', mode: 'builder', project_slug: 'app', assignment: 's1' }), // dup
      JSON.stringify({ date: 'd2', mode: 'builder', project_slug: 'app', assignment: 's2' }), // new
    ]);
    expect(added).toBe(1);
    expect(profile.sessions.length).toBe(before + 1);
    expect(profile.sessions.at(-1)!.assignment).toBe('s2');
  });
});

describe('helpers', () => {
  test('realSessions excludes resource rows', () => {
    const p = emptyProfile();
    p.sessions = [{ mode: 'builder' }, { mode: 'resources' }, { mode: 'startup' }];
    expect(realSessions(p).length).toBe(2);
  });

  test('isResourcesRow', () => {
    expect(isResourcesRow({ mode: 'resources' })).toBe(true);
    expect(isResourcesRow({ mode: 'builder' })).toBe(false);
  });

  test('designTitle prefers title, then basename, then slug', () => {
    expect(designTitle({ design_title: 'Realtime Inbox', design_doc: '/p/x.md' })).toBe('Realtime Inbox');
    expect(designTitle({ design_doc: '/p/user-main-design-x.md' })).toBe('user-main-design-x.md');
    expect(designTitle({ project_slug: 'my-app' })).toBe('my-app');
    expect(designTitle({})).toBe('');
  });
});
