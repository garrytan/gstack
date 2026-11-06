/**
 * GST-1613: test/ship-queue-land-direct.test.ts and test/ubicloud-runner-recovery.test.ts in one bun process, as a
 * free shard can pack them (shard 10, run 42207455885). The land file ran lib/land-merged-checks.ts runMergedChecks in
 * the runner, whose prctl(PR_SET_CHILD_SUBREAPER) made the runner adopt every later orphan without reaping it, so the
 * fake VM's detached phases stayed zombies that tail --pid and kill -0 count as alive and recovery's run cases hung at
 * 90 s. The child selects the merged-checks case and one run case; recovery's afterAll fails on any zombie child.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

test.skipIf(process.platform === 'win32')('the land-direct merged-checks case and a recovery run case pass in one process with no zombie left', () => {
  const r = spawnSync(process.execPath, ['test', 'test/ship-queue-land-direct.test.ts', 'test/ubicloud-runner-recovery.test.ts', '-t', 'runMergedChecks: HEAD is|run keeps the presigned URL'],
    { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 150_000 });
  const out = r.stdout + r.stderr;
  expect(r.status, out).toBe(0);
  expect(out.match(/^\(pass\) .*(runMergedChecks: HEAD is|run keeps the presigned URL)/gm) ?? [], out).toHaveLength(2);
  expect(out, out).not.toMatch(/^\(fail\)/m);
}, 180_000);
