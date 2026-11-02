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

  // Value: protects=an unfinished merge, cherry-pick or revert stops at Step 3 with its name and conflicted files, though the base is in HEAD, and no git merge runs;
  //   fails_when=the ancestor shortcut reports up to date over one, or the stop is a guard's refusal that names no cause;
  //   why_new=GST-691 /ship adversarial findings; seam=MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD; no_claim=how the agent resolves it
  test('an unfinished merge, cherry-pick or revert with the base already in HEAD stops and names it, conflicted or resolved', () => {
    const { f, merges } = guarded();
    f.git('checkout', '-q', '-b', 'other', 'main'); f.write({ 'src/a.ts': 'export const a = 5;\n' }); f.commit('other edits a');
    f.git('checkout', '-q', 'feat'); f.write({ 'src/a.ts': 'export const a = 6;\n' }); f.commit('feat edits a');
    expect(f.git('merge', '--no-edit', 'other').status).not.toBe(0);
    const conflicted = f.run(PREFLIGHT, ['--base', 'main']);
    expect([conflicted.status, lineOf(conflicted.stdout, 'MERGE')]).toEqual([3, '']);
    expect(conflicted.stdout).toContain('STOP: an unfinished merge is in progress (MERGE_HEAD, conflicts in src/a.ts)');
    f.write({ 'src/a.ts': 'export const a = 7;\n' }); f.git('add', 'src/a.ts');
    expect(f.run(PREFLIGHT, ['--base', 'main']).stdout).toContain('STOP: an unfinished merge is in progress (MERGE_HEAD):');
    f.git('merge', '--abort');
    expect(f.git('cherry-pick', 'other').status).not.toBe(0);
    f.write({ 'src/a.ts': 'export const a = 8;\n' }); f.git('add', 'src/a.ts');
    expect(f.run(PREFLIGHT, ['--base', 'main']).stdout).toContain('STOP: an unfinished cherry-pick is in progress (CHERRY_PICK_HEAD):');
    f.git('cherry-pick', '--abort');
    f.write({ 'src/a.ts': 'export const a = 9;\n' }); f.commit('feat edits a again');
    expect(f.git('revert', '--no-edit', 'HEAD~1').status).not.toBe(0);
    f.write({ 'src/a.ts': 'export const a = 10;\n' }); f.git('add', 'src/a.ts');
    expect(f.run(PREFLIGHT, ['--base', 'main']).stdout).toContain('STOP: an unfinished revert is in progress (REVERT_HEAD):');
    expect(merges()).toEqual([]);
  });

  // Value: protects=only a real in-progress operation stops Step 3, and unresolved index entries with none in progress stop with their files named before any git merge;
  //   fails_when=a branch or tag named like MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD gives a stop no abort can clear, or a conflicted stash pop reaches git merge and gets a merge-specific stop;
  //   why_new=GST-732 /ship adversarial findings 2 and 4; seam=git rev-parse --git-path, git diff --diff-filter=U; no_claim=git am or sequencer state
  test('a ref named REVERT_HEAD is not an unfinished revert, and a conflicted stash pop stops with its files named', () => {
    const { f, merges } = guarded();
    f.git('branch', 'REVERT_HEAD'); f.git('tag', 'CHERRY_PICK_HEAD');
    const named = f.run(PREFLIGHT, ['--base', 'main']);
    expect([named.status, lineOf(named.stdout, 'MERGE')]).toEqual([0, 'MERGE: up to date']);
    f.write({ 'src/a.ts': 'export const a = 6;\n' }); f.git('stash');
    f.write({ 'src/a.ts': 'export const a = 7;\n' }); f.commit('feat edits a');
    expect(f.git('stash', 'pop').status).not.toBe(0);
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('STOP: unresolved conflicts in src/a.ts with no merge, cherry-pick or revert in progress');
    expect(merges()).toEqual([]);
  });
});
