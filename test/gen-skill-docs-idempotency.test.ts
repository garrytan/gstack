/**
 * Idempotency test for gen-skill-docs (regression for v1.45.0.0 timestamp flap).
 *
 * Running `bun run gen:skill-docs` twice in a row must produce a no-op on
 * the second run: every output file is byte-identical to itself. Without
 * this gate, CI freshness checks flap whenever someone introduces a
 * timestamp, a random seed, or any other non-deterministic field into a
 * generated artifact.
 *
 * v1.45.0.0 shipped a generated artifact with a `generated_at` ISO timestamp
 * that updated every run. CI freshness checks failed because the committed
 * file's timestamp never matched the latest gen. Fixed in 43e18af4 — this
 * test pins the contract going forward.
 *
 * Isolation: each run renders into its OWN --out-dir (the working tree is
 * never written), and the two out-dirs are diffed RECURSIVELY byte-for-byte
 * — strictly stronger than the old sampled-file snapshot of an in-place
 * double regen. The only tolerated difference is the out-dir path itself:
 * --out-dir repoints section-base paths into the render, so each file is
 * normalized by replacing its own out-dir path with a placeholder before
 * comparison. Any OTHER byte difference (timestamp, random ID, iteration
 * order) still fails.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

/** Presence sanity list: key Claude-host outputs that must exist in a render
 * (guards the recursive diff against vacuously comparing two empty dirs). */
const STABLE_OUTPUTS = [
  'SKILL.md',
  'ship/SKILL.md',
  'plan-ceo-review/SKILL.md',
  'office-hours/SKILL.md',
  'gstack/llms.txt',
];

/**
 * Presence sanity for the --host all render: one canonical file per
 * representative non-Claude host. The full host-all run touches .agents/,
 * .cursor/, .factory/, .gbrain/, .hermes/, .kiro/, .openclaw/, .opencode/,
 * .slate/ — the recursive diff covers every file; this list only proves the
 * render actually fanned out across hosts.
 */
const STABLE_HOST_ALL_OUTPUTS = [
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

/** Recursively list all regular files under dir as sorted relative paths. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Diff two render dirs recursively. Every generated output is text, so files
 * are read as utf-8 and each dir's own absolute path is normalized to
 * <OUT_DIR> (the section-base repoint is the ONLY sanctioned difference
 * between two renders of the same tree). Returns human-readable mismatches.
 */
function diffRenderDirs(dirA: string, dirB: string): string[] {
  const filesA = listFiles(dirA);
  const filesB = listFiles(dirB);
  const problems: string[] = [];
  const setB = new Set(filesB);
  for (const f of filesA) {
    if (!setB.has(f)) { problems.push(`${f} (only in first render)`); continue; }
    const a = fs.readFileSync(path.join(dirA, f), 'utf-8').replaceAll(dirA, '<OUT_DIR>');
    const b = fs.readFileSync(path.join(dirB, f), 'utf-8').replaceAll(dirB, '<OUT_DIR>');
    if (a !== b) problems.push(`${f} (content differs)`);
  }
  const setA = new Set(filesA);
  for (const f of filesB) {
    if (!setA.has(f)) problems.push(`${f} (only in second render)`);
  }
  return problems;
}

/** Render twice into two fresh out-dirs, assert byte-identical outputs. */
function assertDoubleRenderStable(extraArgs: string[], presenceSanity: string[], label: string): void {
  const outA = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-idem-a-'));
  const outB = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-idem-b-'));
  try {
    const firstRun = runGen([...extraArgs, '--out-dir', outA]);
    expect(firstRun.exitCode).toBe(0);
    const secondRun = runGen([...extraArgs, '--out-dir', outB]);
    expect(secondRun.exitCode).toBe(0);

    // Non-vacuous guard: the key outputs actually rendered.
    for (const rel of presenceSanity) {
      expect({ file: rel, exists: fs.existsSync(path.join(outA, rel)) })
        .toEqual({ file: rel, exists: true });
    }

    const flapping = diffRenderDirs(outA, outB);
    if (flapping.length > 0) {
      throw new Error(
        `${flapping.length} file(s) differ between two consecutive ${label} gen runs (flapping):\n` +
        flapping.map(f => `  - ${f}`).join('\n') +
        `\nLikely cause: a non-deterministic field (timestamp, random ID, ` +
        `filesystem-iteration order) leaked into the generated output. CI freshness ` +
        `checks (git diff --exit-code) will fail unpredictably until this is fixed.`,
      );
    }
  } finally {
    fs.rmSync(outA, { recursive: true, force: true });
    fs.rmSync(outB, { recursive: true, force: true });
  }
}

describe('gen-skill-docs idempotency', () => {
  test('two consecutive runs produce byte-identical outputs (no flapping fields)', () => {
    assertDoubleRenderStable([], STABLE_OUTPUTS, 'claude-host');
  }, 180_000); // ~2 min budget for two gen runs

  test('--dry-run against the tracked tree reports zero stale files', () => {
    // Tracked-tree freshness assertion (deliberately a READ of the committed
    // files — the out-dir renders above never touch them). If a contributor
    // edits a template without regenerating, or introduces a
    // non-deterministic field, this dry-run reports STALE.
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
        `--dry-run reports ${staleLines.length} stale file(s) against the tracked tree:\n` +
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
    // check" mid-/ship; this test pins the contract across every host — the
    // recursive diff covers EVERY rendered file for EVERY host.
    assertDoubleRenderStable(['--host', 'all'], STABLE_HOST_ALL_OUTPUTS, '--host all');
  }, 300_000); // ~5 min budget for two host-all runs
});
