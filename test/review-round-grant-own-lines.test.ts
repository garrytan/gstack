/**
 * GST-2968 follow-up (#4449's read-only final review): a round grant applies at another head only when the PR's own lines are
 * the same there. ownLinesSame compared zero-context patch-ids, which ignore where a hunk sits, so moving the PR's own audit()
 * call from publicTask() into privateTask() kept the grant. It now also compares each own hunk's place, carried through the
 * base's changes, so a pure base merge still keeps the grant.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ownLinesSame } from '../lib/review-round-grant';
import { shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fxs: ShipFx[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); });

const task = (pub: string[], priv: string[], top: string[] = []) =>
  [...top, 'export function publicTask() {', ...pub, '  return 1;', '}', '', 'export function privateTask() {', ...priv, '  return 2;', '}', ''].join('\n');
const AUDIT = '  audit();';

function granted(): { f: ShipFx; head: string; same: (b: string) => boolean } {
  const f = shipFixture({ 'src/task.ts': task([], []) }, { 'src/task.ts': task([AUDIT], []) });
  fxs.push(f);
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  return { f, head, same: b => ownLinesSame(f.work, 'origin/main', head, b) && ownLinesSame(f.work, 'origin/main', b, head) };
}
const tip = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const mergeBase = (f: ShipFx, files: Record<string, string>, resolved?: Record<string, string>) => {
  f.advanceBase(files);
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status === 0) return;
  expect(resolved).toBeDefined();
  f.write(resolved!);
  f.commit('merge main');
};

describe('a round grant follows the PR\'s own lines, not just their text (GST-2968)', () => {
  // Value: protects=a grant recorded at one head does not open a round at a head whose own code moved; fails_when=moving audit()
  //   between functions with no base change still matches; seam=ownLinesSame as grantFor calls it; no_claim=other grant fields
  test('moving the PR\'s own line to another function needs a new grant', () => {
    const { f, same } = granted();
    f.write({ 'src/task.ts': task([], [AUDIT]) });
    f.commit('move audit into privateTask');
    expect(same(tip(f))).toBe(false);
  });

  // Value: protects=negative controls: a pure base merge that moves the PR's own hunk down still matches, and a base edit right next
  //   to that hunk does not; fails_when=the place check breaks base-merge grants (ghome#17) or carries a hunk the base touched;
  //   seam=ownLinesSame
  test('a base merge that only shifts the own line still matches; a base edit beside it does not', () => {
    const shifted = granted();
    mergeBase(shifted.f, { 'src/task.ts': task([], [], ['// header', '// added by main', '']), 'src/c.ts': 'export const c = 3;\n' });
    expect(shifted.same(tip(shifted.f))).toBe(true);
    const beside = granted();
    const typed = (s: string) => s.replace('export function publicTask() {', 'export function publicTask(): number {');
    mergeBase(beside.f, { 'src/task.ts': typed(task([], [])) }, { 'src/task.ts': typed(task([AUDIT], [])) });
    expect(beside.same(tip(beside.f))).toBe(false);
  });
});
