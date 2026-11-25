/**
 * A ruled edit after the final review (GST-3775, GBRA-795 on garrytan/gbrain#10256): the read-only final review ran, a
 * one-line edit followed, finish stopped and gstack-review-plan --post-review stopped for the owner. The owner's "ship it
 * with the note" is recorded as one ruling per changed path, `gstack-approvals rule --finding edit:<path> --head <stop head>`,
 * and finish routes exactly those paths, at exactly the ruled bytes, as RULED_EDIT instead of stopping again.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const TEST_V2 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); }, 1_000);\n";
const TEST_V3 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); }, 2_000);\n";
const STOPPED = 'STOP: behavior, tests or build inputs changed since review';

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, '..', bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
const finish = (f: ShipFx, reviewed: string, post: string) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
const rule = (f: ShipFx, file: string, head: string) => run(f, 'bin/gstack-approvals', ['rule', '--finding', `edit:${file}`, '--head', head, '--reason', 'the one-line timeout edit after the final review ships as a disclosed note', '--words', 'ship it with the note', '--by', 'GStack Minder (GSTA-36)']);

/** GBRA-795's sequence: the read-only final review read passHead, then a one-line edit to a test landed after it. */
function editedAfterFinalReview() {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
  ships.push(f);
  const passHead = f.git('rev-parse', 'HEAD').stdout.trim();
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  f.write({ 'test/x.test.ts': TEST_V2 }); f.commit('raise the test timeout');
  return { f, passHead, stopHead: f.git('rev-parse', 'HEAD').stdout.trim(), reviewed, post };
}

// Value: protects=the owner's ship-with-the-note ruling on an edit after the final review is honoured: finish routes the ruled
//   path as RULED_EDIT and goes on; fails_when=finish stops on the same edit after the ruling is recorded (GBRA-795, a
//   gstack-approvals add row a-4f45c3661ca2 that nothing read); seam=finish's route reading the approval record
describe('finish honours an edit ruling after the final review (GST-3775)', () => {
  test('GBRA-795: finish stops, the owner rules the edit a note at the stop head, and finish goes on', () => {
    const { f, stopHead, reviewed, post } = editedAfterFinalReview();
    const before = finish(f, reviewed, post);
    expect([before.status, before.stdout]).toEqual([3, expect.stringContaining(`${STOPPED} (test/x.test.ts)`)]);
    expect(rule(f, 'test/x.test.ts', stopHead).status).toBe(0);
    const r = finish(f, reviewed, post);
    expect(r.stdout).not.toContain(STOPPED);
    expect(lineOf(r.stdout, 'RULED_EDIT')).toMatch(new RegExp(`^RULED_EDIT: test/x\\.test\\.ts \\(ruled at ${stopHead.slice(0, 12)} by GStack Minder \\(GSTA-36\\), approval a-[0-9a-f]{12}\\)$`));
    expect(lineOf(r.stdout, 'RULED_NOTE')).toMatch(/^RULED_NOTE: edit:test\/x\.test\.ts at /);
    expect([r.status, lineOf(r.stdout, 'EVIDENCE')]).toEqual([0, expect.stringMatching(/^EVIDENCE: FRESH label=tests /)]);
  });

  // Value: protects=a ruling covers only the path it names, at the bytes it was made on; fails_when=one ruling accepts every
  //   edit after review, or a path edited again after the ruling ships unread; seam=finish's route matching edit:<path> rulings
  test('a ruling covers only its own path at the ruled bytes', () => {
    const other = editedAfterFinalReview();
    expect(rule(other.f, 'src/x.ts', other.stopHead).status).toBe(0);
    expect(finish(other.f, other.reviewed, other.post).stdout).toContain(`${STOPPED} (test/x.test.ts)`);

    const later = editedAfterFinalReview();
    expect(rule(later.f, 'test/x.test.ts', later.stopHead).status).toBe(0);
    later.f.write({ 'test/x.test.ts': TEST_V3 }); later.f.commit('edit it again after the ruling');
    const r = finish(later.f, later.reviewed, later.post);
    expect([r.status, r.stdout]).toEqual([3, expect.stringContaining(`${STOPPED} (test/x.test.ts)`)]);
    expect(r.stdout).not.toContain('RULED_EDIT:');
    expect(lineOf(r.stdout, 'RULED_EDIT_REFUSED')).toStartWith(`RULED_EDIT_REFUSED: test/x.test.ts (its mode or bytes differ from the ruled head ${later.stopHead.slice(0, 12)};`);
    expect(lineOf(r.stdout, 'RULED_NOTE')).toEndWith('(no RULED_EDIT at this head; not applied)');
    later.f.write({ 'test/x.test.ts': TEST_V2 }); later.f.commit('restore the ruled bytes');
    const restored = finish(later.f, later.reviewed, later.post);
    expect([restored.status, restored.stdout]).toEqual([3, expect.stringContaining(`${STOPPED} (test/x.test.ts)`)]);

    const early = editedAfterFinalReview();
    expect(rule(early.f, 'test/x.test.ts', early.passHead).status).toBe(0);
    expect(finish(early.f, early.reviewed, early.post).stdout).toContain(`${STOPPED} (test/x.test.ts)`);
  });

  // Value: protects=finish fails closed when git cannot hold the ruled path under the spelling it routes: a filename with
  //   invalid UTF-8 reaches finish with a replacement character, both ls-tree lookups find nothing, and that must not read as
  //   equal bytes; fails_when=a ruling on a path neither tree holds clears the stop; seam=finish's route reading each ls-tree
  test('a ruled path neither tree holds under its routed spelling stops finish (no file, not equal bytes)', () => {
    const { f, reviewed, post } = editedAfterFinalReview();
    const raw = Buffer.concat([Buffer.from(path.join(f.work, 'test') + path.sep), Buffer.from([0xff]), Buffer.from('y.test.ts')]);
    fs.writeFileSync(raw, TEST_V1); f.commit('add a test whose name is not UTF-8');
    const stopHead = f.git('rev-parse', 'HEAD').stdout.trim();
    const routed = 'test/\uFFFDy.test.ts';
    for (const p of ['test/x.test.ts', routed]) expect(rule(f, p, stopHead).status).toBe(0);
    const r = finish(f, reviewed, post);
    expect([r.status, r.stdout]).toEqual([3, expect.stringContaining(`${STOPPED} (${routed})`)]);
    expect(lineOf(r.stdout, 'RULED_EDIT_REFUSED')).toBe(`RULED_EDIT_REFUSED: ${routed} (no file at ${stopHead.slice(0, 12)}: a ruling covers a file git holds under this spelling, never a deletion; keep the edit and run /ship again, docs/ship-policy.md#ruled-edits)`);
    expect(r.stdout).toContain('RULED_EDIT: test/x.test.ts (');
    expect(r.stdout).toMatch(new RegExp(`^RULED_NOTE: edit:test/\\uFFFDy\\.test\\.ts at .* \\(no RULED_EDIT at this head; not applied\\)$`, 'm'));
  });
});
