/**
 * gstack-ship-preflight's Step 3 merge when the base is already in HEAD (GST-691, GEVA-85): a shared-tree guard that
 * refuses `git merge` stopped /ship's preflight even though origin/<base> was an ancestor of HEAD and the merge had
 * nothing to do. A guard stands in as a `git` shim on PATH that refuses `merge` and logs every merge it sees.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lineOf, PREFLIGHT, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();

/** A fixture whose PATH puts a guard first: `git merge …` is logged and refused, every other git command runs. */
function guarded(): { f: ShipFx; merges: () => string[] } {
  const f = shipFixture(); fixtures.push(f);
  const log = path.join(f.root, 'merges.log');
  fs.writeFileSync(path.join(f.root, 'stub', 'git'), `#!/bin/sh\nif [ "$1" = merge ]; then echo "$*" >> '${log}'; echo 'shared-tree guard: git merge is not allowed in this checkout' >&2; exit 1; fi\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  return { f, merges: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

describe('preflight merge when the base is already in HEAD (GST-691)', () => {
  // Value: protects=/ship on a checkout whose guard refuses git merge gets past Step 3 when origin/<base> is already an ancestor of HEAD;
  //   fails_when=preflight runs git merge even though there is nothing to merge, and the guard's refusal stops the run;
  //   why_new=GEVA-85 hit it on gstack-evals; seam=git merge-base --is-ancestor; no_claim=what the guard allows otherwise
  test('origin/main already in HEAD: no git merge runs and MERGE reports up to date', () => {
    expect(REAL_GIT).not.toBe('');
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
});
