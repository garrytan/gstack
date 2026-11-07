/**
 * GST-1695: every temp path a test makes lands under one per-process root that carries the fixture marker
 * (lib/fixture-marker.ts), and test-setup.ts removes that root after the last file, even when a test timed out
 * before its own cleanup ran.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURE_MARKER } from '../lib/fixture-marker';
import { shipFixture } from './helpers/ship-bin-fixture';

const ROOT = path.resolve(import.meta.dir, '..');

describe('the per-process test fixture root (GST-1695)', () => {
  // Value: protects=os.tmpdir() in a test process, and so every fixture helper that makes a git repository there (ship-bin's fake https://github.com/fx/fx.git origin included), resolves inside one root that carries the fixture marker;
  //   fails_when=fixtures land straight in the OS temp dir with nothing marking them, so /ship's fetch sweep reads a concurrent test run's repositories as a reader's fetch; why_new=GST-1695 (FETCH_RERUN_BLOCKED on /tmp/ship-bin-YUgvjd); seam=test-setup.ts; no_claim=that a test which sets its own TMPDIR stays inside the root
  test('os.tmpdir() and a ship-bin fixture live under the marked root (this process\'s, or the shard sandbox\'s)', () => {
    const root = process.env.GSTACK_TEST_TMP ?? '';
    expect(root).not.toBe('');
    expect(path.relative(root, os.tmpdir()).startsWith('..')).toBe(false);
    expect(fs.statSync(path.join(root, FIXTURE_MARKER)).isFile()).toBe(true);
    const fx = shipFixture();
    try {
      expect(path.relative(fs.realpathSync(root), fx.root).startsWith('..')).toBe(false);
    } finally { fx.cleanup(); }
  });

  // Value: protects=a fixture whose test hit its timeout before its cleanup line still leaves nothing behind once the run ends;
  //   fails_when=Bun's timeout skips the fixture's cleanup and its git repository stays in the temp dir for the next /ship sweep; why_new=GST-1695 (a reader's own `bun test` hit Bun's 5 s timeout and left /tmp/ship-bin-YUgvjd);
  //   seam=test-setup.ts afterAll; no_claim=that a SIGKILLed run cleans up (its root keeps the marker instead)
  test('a child bun test whose fixture test timed out before cleanup leaves no fixture behind', () => {
    const work = fs.mkdtempSync(path.join(path.dirname(process.env.GSTACK_TEST_TMP ?? os.tmpdir()), 'fixture-root-'));
    try {
      const report = path.join(work, 'report.json');
      const file = path.join(work, 'leftover.test.ts');
      fs.writeFileSync(file, [
        "import { test } from 'bun:test';",
        "import { spawnSync } from 'node:child_process';",
        "import * as fs from 'node:fs';",
        "import * as os from 'node:os';",
        "import * as path from 'node:path';",
        "test('times out before its cleanup', async () => {",
        "  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-bin-'));",
        "  spawnSync('git', ['init', '-q', repo], { timeout: 30_000 });",
        "  const root = process.env.GSTACK_TEST_TMP ?? '';",
        `  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ root, repo, git: fs.existsSync(path.join(repo, '.git')), marked: root !== '' && fs.existsSync(path.join(root, ${JSON.stringify(FIXTURE_MARKER)})) }));`,
        '  await Bun.sleep(5_000);',
        '  fs.rmSync(repo, { recursive: true, force: true });',
        '}, 200);',
      ].join('\n'));
      const r = spawnSync(process.execPath, ['test', file], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: work, TMP: work, TEMP: work } });
      expect(r.stderr).toContain('timed out after 200ms');
      const seen = JSON.parse(fs.readFileSync(report, 'utf8')) as { root: string; repo: string; git: boolean; marked: boolean };
      expect([seen.git, seen.marked, seen.root !== '' && seen.repo.startsWith(seen.root + path.sep)]).toEqual([true, true, true]);
      expect([fs.existsSync(seen.repo), fs.existsSync(seen.root)]).toEqual([false, false]);
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  });

  // Value: protects=a `bun test` a test spawns with a TMPDIR inside this run's root sees exactly that TMPDIR, so fixtures that compare a child's os.tmpdir() with the dir they handed it keep working;
  //   fails_when=the child's preload nests a second root and moves its TMPDIR (the plan-design UI fixtures' registration tests failed this way); why_new=GST-1695 test:quick on the first draft; seam=test-setup.ts; no_claim=none
  test('a child bun test handed a TMPDIR inside this run\'s root keeps it', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'));
    const report = path.join(work, 'report.json');
    const file = path.join(work, 'nested.test.ts');
    fs.writeFileSync(file, [
      "import { test } from 'bun:test';",
      "import * as fs from 'node:fs';",
      "import * as os from 'node:os';",
      `test('reports', () => { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ tmp: os.tmpdir(), root: process.env.GSTACK_TEST_TMP })); });`,
    ].join('\n'));
    const r = spawnSync(process.execPath, ['test', file], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: work, TMP: work, TEMP: work } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ tmp: work, root: process.env.GSTACK_TEST_TMP });
    expect(fs.readdirSync(work).sort()).toEqual(['nested.test.ts', 'report.json']);
  });
});
