/**
 * Static tripwire for .github/workflows/free-tests.yml — the Linux free-suite
 * lane. Pins the three properties that made the lane worth having:
 *
 *   1. It invokes the CANONICAL runner (bun run test:free), not a raw
 *      `bun test <dirs>` glob — the runner owns TEST_ROOTS and strict-output
 *      classification, so a truncated run can't report green.
 *   2. It is SECRETLESS: free tests make no API calls, and keeping keys out
 *      means fork PRs get real signal here. Any `secrets.` reference is a
 *      regression.
 *   3. It triggers on `pull_request` (never `pull_request_target`, which
 *      would hand a fork PR the base repo's context).
 *
 * Same wiring-tripwire class as test/hermetic-wiring.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'free-tests.yml');

describe('free-tests workflow wiring', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow exists and invokes the canonical runner', () => {
    expect(source).toContain('bun run test:free');
    expect(source).not.toMatch(/run:\s*bun test\s/);
  });

  test('secretless: no secrets reach the free lane', () => {
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('OPENAI_API_KEY');
  });

  test('pull_request trigger, never pull_request_target', () => {
    expect(source).toContain('pull_request:');
    expect(source).not.toContain('pull_request_target');
  });

  test('if sharded (matrix), the matrix count matches --shards N', () => {
    // Single-job --parallel mode has no matrix — vacuously fine. If someone
    // switches to the shard matrix (the V3 fallback), the two encodings of
    // the shard count must agree or CI silently drops files.
    const shardsFlag = source.match(/--shards\s+(\d+)/);
    const matrix = source.match(/shard:\s*\[([^\]]+)\]/);
    if (shardsFlag || matrix) {
      expect(shardsFlag, 'matrix present but no --shards N flag').toBeTruthy();
      expect(matrix, '--shards N present but no shard matrix').toBeTruthy();
      const count = parseInt(shardsFlag![1], 10);
      const entries = matrix![1].split(',').map(s => s.trim()).filter(Boolean);
      expect(entries.length).toBe(count);
    }
  });

  test('flake telemetry stays wired: retry flag, single-writer ledger, unconditional artifact', () => {
    // WS1: a timing flake must not red the required lane, but every
    // flaky-pass must be recorded and uploaded — a green run is exactly when
    // the evidence matters. Removing any of these silently returns flakes to
    // either merge-blocking (flag off) or invisibility (ledger/artifact off).
    expect(source).toMatch(/GSTACK_FREE_RETRY_FLAKY:\s*"1"/);
    expect(source).toMatch(/GSTACK_FLAKE_LEDGER:\s*\$\{\{ runner\.temp \}\}\/flake-ledger\.jsonl/);
    expect(source).toContain('name: flake-ledger');
    expect(source).toMatch(/name: Upload flake ledger\s*\n\s*if: always\(\)/);
  });

  test('least-privilege token: contents read-only, credentials not persisted', () => {
    // The job executes PR-controlled code (install lifecycle scripts + the
    // suite itself). A default-grant GITHUB_TOKEN persisted into .git/config
    // by checkout would hand that code whatever the repo default allows.
    expect(source).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(source).toMatch(/persist-credentials:\s*false/);
  });
});
