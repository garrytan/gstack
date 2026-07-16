/**
 * Regression: refMap must be cleared when an iframe detaches.
 *
 * `TabSession.getActiveFrameOrPage()` (tab-session.ts:151) auto-recovers
 * from detached iframes by setting `activeFrame = null` and silently
 * falling back to the main page. The asymmetric bug: the matching
 * `clearRefs()` call is missing.
 *
 * Compare to `onMainFrameNavigated()` (tab-session.ts:167) — the
 * staleness condition is equivalent (refs were captured against a frame
 * that no longer exists), and the main-frame path correctly clears both
 * the activeFrame AND the refMap:
 *
 *     onMainFrameNavigated(): void {
 *       this.clearRefs();           //  ← clears refs
 *       this.activeFrame = null;
 *       this.loadedHtml = null;
 *       this.loadedHtmlWaitUntil = undefined;
 *     }
 *
 *     getActiveFrameOrPage(): Page | Frame {
 *       if (this.activeFrame?.isDetached()) {
 *         this.activeFrame = null;  //  ← but no clearRefs() here
 *       }
 *       return this.activeFrame ?? this.page;
 *     }
 *
 * The lazy click-time staleness check at `resolveRef` (tab-session.ts:97)
 * partially saves us — `entry.locator.count()` on a detached-frame
 * locator throws or returns 0, so a click against a stale ref errors out
 * with "Ref X is stale". But the user has no signal that frame context
 * silently changed underfoot: the next `snapshot` runs against
 * `this.page` (main) while old iframe refs still litter `refMap` with
 * the same role+name keys. New refs collide with stale ones, the
 * resolver picks one at random, the user clicks the wrong element.
 *
 * Behavior the test locks: when an iframe detaches and
 * `getActiveFrameOrPage()` auto-recovers, the refMap is cleared in the
 * same step (matching the `onMainFrameNavigated` symmetry). TODOS.md
 * line 816-820 documents "Detached frame auto-recovery" as a feature;
 * this restores the documented intent.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { TabSession, type RefEntry } from '../src/tab-session';
import type { Page, Frame, Locator } from 'playwright';

// Minimal type-cast mocks. Same pattern as tab-isolation.test.ts —
// pure-logic tests don't launch a browser.
function mockPage(): Page {
  return {} as Page;
}

function mockDetachedFrame(): Frame {
  return { isDetached: () => true } as unknown as Frame;
}

function mockAttachedFrame(): Frame {
  return { isDetached: () => false } as unknown as Frame;
}

function mockRefEntry(role: string, name: string): RefEntry {
  return {
    locator: {} as Locator,
    role,
    name,
  };
}

// Fresh refs Map per call — avoid by-reference mutation poisoning across
// halves of the symmetry test (clearRefs() clears the same Map instance
// the test holds a reference to).
function makeRefs(): Map<string, RefEntry> {
  const r = new Map<string, RefEntry>();
  r.set('e1', mockRefEntry('button', 'Submit'));
  r.set('e2', mockRefEntry('textbox', 'Email'));
  r.set('e3', mockRefEntry('link', 'Forgot password'));
  return r;
}

describe('TabSession — frame detach + ref staleness', () => {
  let session: TabSession;

  beforeEach(() => {
    session = new TabSession(mockPage());
    session.setRefMap(makeRefs());
  });

  test('refs cleared when getActiveFrameOrPage detects detached iframe', () => {
    // Pre-condition: refs captured inside an iframe context
    session.setFrame(mockDetachedFrame());
    expect(session.getRefCount()).toBe(3);

    // Act: caller invokes getActiveFrameOrPage (e.g. via the next /command
    // dispatch). The detach gets noticed inside.
    const result = session.getActiveFrameOrPage();

    // Auto-recovery: activeFrame nulled (already worked pre-fix)
    expect(session.getFrame()).toBeNull();

    // The fix: refs ALSO cleared so the next snapshot runs against a
    // clean ref namespace. Pre-fix this was 3 — refs lingered against a
    // dead frame, colliding with refs the next snapshot would emit.
    expect(session.getRefCount()).toBe(0);
  });

  test('refs preserved when active frame is still attached', () => {
    // No regression on the happy path — attached frame should NOT
    // trigger the cleanup.
    session.setFrame(mockAttachedFrame());
    expect(session.getRefCount()).toBe(3);

    session.getActiveFrameOrPage();

    // Frame still set, refs still present.
    expect(session.getFrame()).not.toBeNull();
    expect(session.getRefCount()).toBe(3);
  });

  test('refs preserved when no frame is set (page-level snapshot)', () => {
    // No frame ever set → the if-branch never enters → refs untouched.
    expect(session.getFrame()).toBeNull();
    expect(session.getRefCount()).toBe(3);

    session.getActiveFrameOrPage();

    expect(session.getRefCount()).toBe(3);
  });

  test('matches onMainFrameNavigated symmetry (refs+frame both cleared)', () => {
    // Pin the design symmetry: both staleness paths (main-frame nav AND
    // iframe detach) must clear both pieces of state together. If a
    // future refactor splits these, the test fails before merge.
    session.setFrame(mockDetachedFrame());
    expect(session.getRefCount()).toBe(3);

    session.onMainFrameNavigated();

    expect(session.getFrame()).toBeNull();
    expect(session.getRefCount()).toBe(0);

    // Reset with a FRESH Map (the previous one was emptied by clearRefs
    // by-reference) and exercise the iframe-detach path. End state must
    // match.
    session.setRefMap(makeRefs());
    session.setFrame(mockDetachedFrame());
    expect(session.getRefCount()).toBe(3);

    session.getActiveFrameOrPage();

    expect(session.getFrame()).toBeNull();
    expect(session.getRefCount()).toBe(0);
  });
});
