/**
 * gstack-config default-table completeness (gate, free).
 *
 * Skill preambles read configuration with
 *
 *     VAR=$(gstack-config get <key> 2>/dev/null || echo "<default>")
 *
 * and that fallback only fires on a NON-ZERO exit. `get` used to answer a key
 * it did not know with "" and exit 0, so VAR came back empty and the default
 * written right there in the preamble was unreachable. The skill then branched
 * on a value it never specified -- "skip entirely if QUESTION_TUNING is false"
 * reached with QUESTION_TUNING="".
 *
 * Four keys skills actually read had no entry in lookup_default and took that
 * path: question_tuning, repo_mode, team_mode, transcript_ingest_mode.
 *
 * Three invariants are pinned so the class cannot reopen:
 *
 *   1. every key read anywhere in the tree is matched by an arm of the DEFAULTS
 *      table. Add a `gstack-config get some_new_key` to a preamble without
 *      adding its default and this test fails. Checked by parsing the case arms
 *      rather than shelling out per key, which keeps it fast and makes the
 *      failure name the key.
 *   2. a genuinely unknown key exits non-zero, so the caller fallback fires.
 *   3. a known key whose default is intentionally empty still exits 0 --
 *      cross_project_learnings ("unset triggers the first-time prompt") and
 *      redact_repo_visibility ("empty falls through to gh/glab detection")
 *      depend on receiving "" successfully.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG_BIN = path.join(ROOT, 'bin', 'gstack-config');
const SELF = 'gstack-config-defaults.test.ts';

// Isolated state dir, so a value the developer happens to have set in their own
// ~/.gstack/config.yaml cannot mask a missing default.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-config-test-'));

function get(key: string): { out: string; code: number } {
  const r = spawnSync('bash', [CONFIG_BIN, 'get', key], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GSTACK_STATE_ROOT: STATE },
  });
  return { out: r.stdout ?? '', code: r.status ?? -1 };
}

/** Case-arm patterns of lookup_default, in order, excluding the catch-all. */
function defaultArms(): string[] {
  const src = fs.readFileSync(CONFIG_BIN, 'utf-8');
  const body = src.slice(src.indexOf('lookup_default()'));
  const end = body.indexOf('\n}');
  const arms: string[] = [];
  // e.g. `    proactive) echo "true" ;;` or `    user_slug_at_*) echo "" ;;`
  for (const m of body.slice(0, end).matchAll(/^\s{4}([a-zA-Z0-9_*]+)\)/gm)) {
    if (m[1] !== '*') arms.push(m[1]);
  }
  return arms;
}

function isCovered(key: string, arms: string[]): boolean {
  return arms.some((a) =>
    a.endsWith('*') ? key.startsWith(a.slice(0, -1)) : key === a,
  );
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/** Every `gstack-config get <key>` call site in the tree. */
function keysReadInTree(): string[] {
  const keys = new Set<string>();
  // [ \t]+ rather than \s+: \s crosses newlines and would pair a trailing
  // "gstack-config get" with the first word of the next line.
  const re = /gstack-config["']?[ \t]+get[ \t]+([a-zA-Z0-9_]+)/g;
  const stack = [ROOT];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      // Skip this file: its own prose cites example keys.
      if (ent.name === SELF) continue;
      if (!/\.(md|ts|sh)$|^gstack-[a-z-]+$/.test(ent.name)) continue;
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(re)) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

describe('gstack-config defaults (gate, free)', () => {
  test('every key read in the tree is covered by the DEFAULTS table', () => {
    const arms = defaultArms();
    expect(arms.length).toBeGreaterThan(10); // the parse actually found the table
    const uncovered = keysReadInTree().filter((k) => !isCovered(k, arms));
    expect(uncovered).toEqual([]);
  });

  test('an unknown key exits non-zero, so the caller fallback fires', () => {
    const r = get('definitely_not_a_gstack_key_9f3a');
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  test('a known key whose default is intentionally empty still exits 0', () => {
    // repo_mode is in this class BY CONTRACT: gstack-repo-mode treats any
    // non-empty answer as a user override and skips classification, so a
    // synthesized "unknown" default would turn the classifier into dead code
    // (caught live by test/gstack-repo-mode.test.ts during the wave).
    for (const key of ['cross_project_learnings', 'salience_allowlist', 'redact_repo_visibility', 'repo_mode']) {
      expect({ key, ...get(key) }).toEqual({ key, out: '', code: 0 });
    }
  });

  test('the regressed keys resolve to the values their callers assume', () => {
    expect(get('question_tuning').out).toBe('false');
    expect(get('team_mode').out).toBe('false');
    expect(get('transcript_ingest_mode').out).toBe('off');
  });
});
