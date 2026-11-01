/**
 * gstack-ship-preflight's Step 3 merge when the base is already in HEAD (GST-691, GEVA-85): a shared-tree guard that
 * refuses `git merge` stopped /ship's preflight even though origin/<base> was an ancestor of HEAD and the merge had
 * nothing to do. A guard stands in as a `git` shim on PATH that refuses `merge` and logs every merge it sees.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lineOf, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
const PREFLIGHT = path.join(import.meta.dir, '..', 'bin', 'gstack-ship-preflight');

/** A fixture whose PATH puts a guard first: `git merge …` is logged and refused, every other git command runs the next git
 * on PATH by name (a pinned path recurses when that git is itself a PATH-walking wrapper, as Capy's shared-tree guard is). */
function guarded(): { f: ShipFx; merges: () => string[] } {
  const f = shipFixture(); fixtures.push(f);
  const log = path.join(f.root, 'merges.log');
  const stub = path.join(f.root, 'stub');
  fs.writeFileSync(path.join(stub, 'git'), `#!/bin/sh\nif [ "$1" = merge ]; then echo "$*" >> '${log}'; echo 'shared-tree guard: git merge is not allowed in this checkout' >&2; exit 1; fi\nPATH="\${PATH#${stub}:}" exec git "$@"\n`, { mode: 0o755 });
  return { f, merges: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

describe('preflight merge when the base is already in HEAD (GST-691)', () => {
  // Value: protects=/ship on a checkout whose guard refuses git merge gets past Step 3 when origin/<base> is already an ancestor of HEAD;
  //   fails_when=preflight runs git merge even though there is nothing to merge, and the guard's refusal stops the run;
  //   why_new=GEVA-85 hit it on gstack-evals; seam=git merge-base --is-ancestor; no_claim=what the guard allows otherwise
  test('origin/main already in HEAD: no git merge runs and MERGE reports up to date', () => {
    const { f, merges } = guarded();
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect([r.status, lineOf(r.stdout, 'MERGE'), r.stdout.split('\n').find(l => l.startsWith('STOP:'))]).toEqual([0, 'MERGE: up to date', undefined]);
    expect(merges()).toEqual([]);
  });

  // Value: protects=a base that moved is still merged, so tests and reviews keep covering the integrated code;
  //   fails_when=the ancestor check skips a merge that has work to do; seam=git merge; no_claim=conflict handling (test/ship-preflight.test.ts)
  test('a moved base still runs git merge', () => {
    const { f, merges } = guarded();
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(merges()).toEqual(['merge origin/main --no-edit']);
    expect(r.stdout).toContain('STOP: git merge origin/main failed: shared-tree guard: git merge is not allowed in this checkout');
  });

  // Value: protects=an unfinished merge of another branch still stops at Step 3 with its conflicted files named, though the base is in HEAD;
  //   fails_when=the ancestor shortcut reports up to date over an index with unmerged paths and the run tests conflict markers;
  //   why_new=GST-691 /ship adversarial finding 1; seam=git ls-files -u; no_claim=how the agent resolves it
  test('an unfinished merge with the base already in HEAD still stops, conflicted or resolved and staged', () => {
    const { f } = guarded();
    f.git('checkout', '-q', '-b', 'other', 'main'); f.write({ 'src/a.ts': 'export const a = 5;\n' }); f.commit('other edits a');
    f.git('checkout', '-q', 'feat'); f.write({ 'src/a.ts': 'export const a = 6;\n' }); f.commit('feat edits a');
    expect(f.git('merge', '--no-edit', 'other').status).not.toBe(0);
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect([r.status, lineOf(r.stdout, 'MERGE')]).toEqual([3, '']);
    expect(r.stdout).toMatch(/STOP: merge conflicts in src\/a\.ts/);
    f.write({ 'src/a.ts': 'export const a = 7;\n' }); f.git('add', 'src/a.ts');
    const staged = f.run(PREFLIGHT, ['--base', 'main']);
    expect([staged.status, lineOf(staged.stdout, 'MERGE')]).toEqual([3, '']);
    expect(staged.stdout).toContain('STOP: git merge origin/main failed:');
  });
});
