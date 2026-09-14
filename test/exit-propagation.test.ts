import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shardRunLooksTruncated } from '../scripts/test-free-shards';

// Fault-injection companion to test/no-suicide-exit.test.ts.
//
// The static tripwire prevents OUR files from scheduling a delayed
// process.exit. This file proves, with real bun output, WHY that guard and
// the sharded runner's summary check both exist: `bun test` itself exits 0
// when a mid-suite process.exit(0) fires — the truncated run is
// indistinguishable from a green one by exit code alone. The sharded
// runner's shardRunLooksTruncated() predicate is the detection layer; these
// tests drive it with genuine truncated and genuine complete runs.

function runBunTest(dir: string) {
  return spawnSync('bun', ['test', '.'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env },
  });
}

function withFixtureDir(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-prop-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fixture sources live as .txt (test/fixtures/exit-propagation/) and are
// copied to .test.ts names inside a temp dir at runtime — the no-suicide-exit
// static tripwire scans every *.test.ts in the repo, and inlining the suicide
// pattern here (even as a string) would rightly trip it.
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'exit-propagation');
const SUICIDE_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'suicide.txt'), 'utf8');
const FAILING_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'failing.txt'), 'utf8');
const PASSING_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'passing.txt'), 'utf8');

describe('exit-code propagation (fault injection)', () => {
  test('a mid-suite process.exit(0) yields exit 0 with NO summary — and the shard predicate catches it', () => {
    withFixtureDir(
      { 'a-suicide.test.ts': SUICIDE_FIXTURE, 'b-failing.test.ts': FAILING_FIXTURE },
      (dir) => {
        const r = runBunTest(dir);
        const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        if (r.status === 0) {
          // The dangerous shape: green exit, truncated run. The predicate
          // MUST flag it — this is the assertion that guards the suite.
          expect(shardRunLooksTruncated(r.status, combined)).toBe(true);
        } else {
          // If a future bun version starts propagating the failure itself,
          // even better — nothing to detect. Either way, never green+silent.
          expect(r.status).not.toBe(0);
        }
      },
    );
  });

  test('a complete green run is NOT flagged as truncated', () => {
    withFixtureDir({ 'ok.test.ts': PASSING_FIXTURE }, (dir) => {
      const r = runBunTest(dir);
      const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).toBe(0);
      expect(shardRunLooksTruncated(r.status, combined)).toBe(false);
    });
  });

  test('a plain failing run propagates nonzero and is not the silent case', () => {
    withFixtureDir({ 'fail.test.ts': FAILING_FIXTURE }, (dir) => {
      const r = runBunTest(dir);
      const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).not.toBe(0);
      expect(shardRunLooksTruncated(r.status, combined)).toBe(false);
    });
  });
});
