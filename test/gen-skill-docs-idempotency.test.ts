/**
 * Idempotency test for gen-skill-docs (regression for v1.45.0.0 timestamp flap).
 *
 * Running `bun run gen:skill-docs` twice in a row must produce a no-op on
 * the second run: every output file is byte-identical to itself. Without
 * this gate, CI freshness checks flap whenever someone introduces a
 * timestamp, a random seed, or any other non-deterministic field into a
 * generated artifact.
 *
 * v1.45.0.0 shipped with a `generated_at` ISO timestamp in
 * scripts/proactive-suggestions.json that updated every run. CI freshness
 * checks failed because the committed file's timestamp never matched the
 * latest gen. Fixed in 43e18af4 — this test pins the contract going forward.
 *
 * The test pays a small cost (~2 gen-skill-docs invocations, ~3s total) but
 * catches a class of bugs that's invisible until CI fails.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

/** Files that gen-skill-docs writes and that must be byte-stable across runs. */
const STABLE_OUTPUTS = [
  'scripts/proactive-suggestions.json',
  'SKILL.md',
  'ship/SKILL.md',
  'plan-ceo-review/SKILL.md',
  'office-hours/SKILL.md',
  'gstack/llms.txt',
];

/**
 * Sampled outputs from EVERY non-Claude host. The full host-all run touches
 * .agents/, .cursor/, .factory/, .gbrain/, .hermes/, .kiro/, .openclaw/,
 * .opencode/, .slate/ — picking one canonical file per host catches per-host
 * non-determinism without paying the cost of snapshotting hundreds of files.
 */
const STABLE_HOST_ALL_OUTPUTS = [
  'scripts/proactive-suggestions.json',
  'SKILL.md',
  'ship/SKILL.md',
  '.agents/skills/gstack-ship/SKILL.md',
  '.cursor/skills/gstack-ship/SKILL.md',
  '.factory/skills/gstack-ship/SKILL.md',
  '.gbrain/skills/gstack-ship/SKILL.md',
];

function runGen(extraArgs: string[] = []): { exitCode: number; stderr: string } {
  const result = spawnSync('bun', ['run', 'gen:skill-docs', ...extraArgs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr?.toString() ?? '',
  };
}

function snapshot(files: string[] = STABLE_OUTPUTS): Map<string, string> {
  const m = new Map<string, string>();
  for (const rel of files) {
    const full = path.join(REPO_ROOT, rel);
    if (fs.existsSync(full)) {
      m.set(rel, fs.readFileSync(full, 'utf-8'));
    }
  }
  return m;
}

describe('gen-skill-docs idempotency', () => {
  test('two consecutive runs produce byte-identical outputs (no flapping fields)', () => {
    const firstRun = runGen();
    expect(firstRun.exitCode).toBe(0);

    const after1 = snapshot();
    expect(after1.size).toBeGreaterThan(0);

    const secondRun = runGen();
    expect(secondRun.exitCode).toBe(0);

    const after2 = snapshot();

    // Compare each stable output byte-for-byte.
    const flapping: string[] = [];
    for (const [file, before] of after1.entries()) {
      const now = after2.get(file);
      if (now !== before) flapping.push(file);
    }

    if (flapping.length > 0) {
      throw new Error(
        `${flapping.length} file(s) changed between two consecutive gen-skill-docs runs (flapping):\n` +
        flapping.map(f => `  - ${f}`).join('\n') +
        `\nLikely cause: a non-deterministic field (timestamp, random ID, ` +
        `filesystem-iteration order) leaked into the generated output. CI freshness ` +
        `checks (git diff --exit-code) will fail unpredictably until this is fixed.`,
      );
    }
  }, 180_000); // ~2 min budget for two gen runs

  test('--dry-run after a fresh gen reports zero stale files', () => {
    // Pre-condition: working tree gen must be fresh (idempotency test above ran first).
    // If a contributor introduces a non-deterministic field, this dry-run reports STALE.
    const result = spawnSync('bun', ['run', 'gen:skill-docs', '--dry-run'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    // STALE: prefix means a file would change. Count them.
    const staleLines = stdout.split('\n').filter(l => l.startsWith('STALE:'));
    if (staleLines.length > 0) {
      throw new Error(
        `--dry-run reports ${staleLines.length} stale file(s) after a fresh gen:\n` +
        staleLines.map(l => `  ${l}`).join('\n') +
        `\nRun \`bun run gen:skill-docs\` and commit the result.`,
      );
    }
  }, 90_000);

  test('--host all idempotency: every host output is byte-stable across two runs', () => {
    // Gap A: the default test above runs Claude host only. Non-Claude hosts
    // (Codex, Factory, Cursor, OpenClaw, GBrain, Slate, OpenCode, Hermes,
    // Kiro) have their own output paths and could carry their own
    // non-deterministic fields. We hit a "--host all needed for freshness
    // check" mid-/ship; this test pins the contract across every host.
    const firstRun = runGen(['--host', 'all']);
    expect(firstRun.exitCode).toBe(0);

    const after1 = snapshot(STABLE_HOST_ALL_OUTPUTS);
    expect(after1.size).toBeGreaterThan(0);

    const secondRun = runGen(['--host', 'all']);
    expect(secondRun.exitCode).toBe(0);

    const after2 = snapshot(STABLE_HOST_ALL_OUTPUTS);

    const flapping: string[] = [];
    for (const [file, before] of after1.entries()) {
      const now = after2.get(file);
      if (now !== before) flapping.push(file);
    }

    if (flapping.length > 0) {
      throw new Error(
        `${flapping.length} file(s) changed between two consecutive --host all gen runs:\n` +
        flapping.map(f => `  - ${f}`).join('\n') +
        `\nLikely cause: a non-deterministic field leaked into a non-Claude host adapter ` +
        `(scripts/host-adapters/*.ts). CI freshness checks for that host will flap.`,
      );
    }
  }, 300_000); // ~5 min budget for two host-all runs
});
