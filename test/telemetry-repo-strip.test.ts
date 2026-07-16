/**
 * Telemetry "no repo identity egress" invariant.
 *
 * The telemetry consent copy promises a user's repo name is recorded locally
 * only and stripped before any upload (scripts/resolvers/preamble/
 * generate-telemetry-prompt.ts). Two producers write repo/branch identity into
 * the local skill-usage.jsonl:
 *
 *   - the preamble epilogue        → "repo"
 *     (scripts/resolvers/preamble/generate-preamble-bash.ts)
 *   - gstack-telemetry-log         → "_repo_slug", "_branch"
 *     (bin/gstack-telemetry-log)
 *
 * gstack-telemetry-sync MUST strip every one of those fields before the remote
 * POST (bin/gstack-telemetry-sync). This test enforces that contract three ways:
 *
 *   1. Coverage — every repo/branch field the producers emit is also stripped.
 *      Catches "added a new repo field, forgot to strip it" (the rename-to-_repo
 *      landmine, or any future producer drift).
 *   2. Behavior — run the ACTUAL sed strip expressions from the sync script over
 *      a sample event line and assert no repo/branch field survives, while benign
 *      fields do. Catches a broken/edited regex, not just a missing line.
 *   3. Floor — the three known fields are always in the stripped set, so deleting
 *      a strip rule fails CI even if a producer also stops emitting it.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'bun';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SYNC = path.join(ROOT, 'bin', 'gstack-telemetry-sync');
const PREAMBLE = path.join(ROOT, 'scripts', 'resolvers', 'preamble', 'generate-preamble-bash.ts');
const TEL_LOG = path.join(ROOT, 'bin', 'gstack-telemetry-log');

// Fields that identify the user's repo/branch. The promise is that NONE of
// these reach the network. Add to this floor if a new identity field is born.
const REPO_IDENTITY_FLOOR = ['repo', '_repo_slug', '_branch'];

const isRepoIdentity = (field: string) => /repo|branch/i.test(field);

/** Pull every `sed -e 's/.../g'` expression out of the sync script. */
function extractSedExprs(scriptText: string): string[] {
  return [...scriptText.matchAll(/-e\s+'(s\/[^']*)'/g)].map((m) => m[1]);
}

/** The JSON key a strip expression targets, e.g. `,"repo":"[^"]*"` -> `repo`. */
function fieldFromSedExpr(expr: string): string | null {
  const m = expr.match(/,"([A-Za-z_][A-Za-z0-9_]*)":/);
  return m ? m[1] : null;
}

/**
 * Repo/branch JSON keys a producer writes INTO skill-usage.jsonl — the only
 * file gstack-telemetry-sync reads and uploads. Scoped to the emission lines
 * that target the synced file so local-only sinks (e.g. the timeline log, which
 * carries "branch" but is never synced) don't count against the egress invariant.
 */
function emittedRepoFields(lines: string[]): string[] {
  const text = lines.join('\n');
  const keys = [...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)":/g)].map((m) => m[1]);
  return [...new Set(keys.filter(isRepoIdentity))];
}

describe('telemetry no-repo-identity-egress invariant', () => {
  const syncText = fs.readFileSync(SYNC, 'utf-8');
  const sedExprs = extractSedExprs(syncText);
  const strippedRepoExprs = sedExprs.filter((e) => {
    const f = fieldFromSedExpr(e);
    return f !== null && isRepoIdentity(f);
  });
  const strippedFields = new Set(
    strippedRepoExprs.map(fieldFromSedExpr).filter((f): f is string => f !== null),
  );

  test('floor: the three known repo-identity fields are stripped', () => {
    for (const field of REPO_IDENTITY_FLOOR) {
      expect(strippedFields.has(field)).toBe(true);
    }
  });

  test('coverage: every repo/branch field the producers emit into skill-usage.jsonl is stripped', () => {
    // Only emission lines that target the synced file (skill-usage.jsonl). The
    // preamble appends directly; gstack-telemetry-log builds the synced event
    // with a `printf '{"v":1,...` line into $JSONL_FILE (= skill-usage.jsonl).
    const preambleSynced = fs
      .readFileSync(PREAMBLE, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('skill-usage.jsonl'));
    const telLogSynced = fs
      .readFileSync(TEL_LOG, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('"v":1') || l.includes('skill-usage'));
    const emitted = new Set<string>([
      ...emittedRepoFields(preambleSynced),
      ...emittedRepoFields(telLogSynced),
    ]);
    // The preamble must emit "repo" — guards against the test silently passing
    // because a regex stopped matching the producer.
    expect(emitted.has('repo')).toBe(true);
    for (const field of emitted) {
      expect(
        strippedFields.has(field),
        `producer emits repo-identity field "${field}" but gstack-telemetry-sync does not strip it (would leak to remote)`,
      ).toBe(true);
    }
  });

  test('behavior: the real sed expressions remove repo identity, keep benign fields', () => {
    const sample =
      '{"v":1,"ts":"2026-06-02T00:00:00Z","skill":"design-shotgun",' +
      '"repo":"my-secret-repo","_repo_slug":"acme-my-secret-repo","_branch":"feature-x",' +
      '"sessions":3,"installation_id":"abc123"}';

    const sedArgs: string[] = [];
    for (const e of strippedRepoExprs) {
      sedArgs.push('-e', e);
    }
    const out = spawnSync(['sed', ...sedArgs], {
      stdin: Buffer.from(sample),
    });
    const cleaned = out.stdout.toString();

    // No repo/branch identity survives, value or key.
    expect(cleaned).not.toContain('my-secret-repo');
    expect(cleaned).not.toContain('feature-x');
    expect(cleaned).not.toContain('"repo"');
    expect(cleaned).not.toContain('_repo_slug');
    expect(cleaned).not.toContain('_branch');

    // Benign fields are untouched — the strip is surgical, not a blanket wipe.
    expect(cleaned).toContain('"skill":"design-shotgun"');
    expect(cleaned).toContain('"sessions":3');
    expect(cleaned).toContain('"ts":"2026-06-02T00:00:00Z"');
  });
});
