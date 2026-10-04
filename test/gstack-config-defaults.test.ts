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
 *
 * The reverse direction is pinned too: every key in the DEFAULTS table must
 * be read by code (bin/, lib/, scripts/, browse/src/, setup, or a .tmpl), or be listed in
 * PROSE_ONLY_KEYS with a reason. A documented setting no code reads is a
 * switch that does nothing, which is how a consent choice once went unread.
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

const SKIP_DIRS = new Set(['node_modules', '.git', '.context', 'dist', 'build', '.next']);

/** Every `gstack-config get <key>` call site in the tree. */
function keysReadInTree(root = ROOT): string[] {
  const keys = new Set<string>();
  // [ \t]+ rather than \s+: \s crosses newlines and would pair a trailing
  // "gstack-config get" with the first word of the next line.
  const re = /gstack-config["']?[ \t]+get[ \t]+([a-zA-Z0-9_]+)/g;
  const stack = [root];
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
      if (ent.name === SELF || ent.name === 'CHANGELOG.md') continue;
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

/**
 * DEFAULTS-table keys no code reads. Each entry needs a reason; an empty list
 * means every documented setting has a reader.
 */
const PROSE_ONLY_KEYS: Record<string, string> = {};

const READER_DIRS = ['bin', 'lib', 'scripts', 'browse/src'];
const READER_FILES = ['setup'];

/**
 * Source text a config reader could live in: everything under READER_DIRS,
 * READER_FILES, and every .tmpl in the tree. bin/gstack-config counts too,
 * minus its documentation header and its DEFAULTS table.
 */
function readerCorpus(root = ROOT): string {
  const files = new Set<string>();
  const walk = (dir: string, all: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, all);
      else if (all || ent.name.endsWith('.tmpl')) files.add(full);
    }
  };
  for (const d of READER_DIRS) walk(path.join(root, d), true);
  walk(root, false);
  for (const f of READER_FILES) files.add(path.join(root, f));
  return [...files]
    .map((f) => {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf-8');
      } catch {
        return '';
      }
      if (f === path.join(root, 'bin', 'gstack-config')) {
        text = text.replace(/CONFIG_HEADER='[\s\S]*?\n'\n/, '').replace(/lookup_default\(\) \{[\s\S]*?\n\}/, '');
      }
      return text;
    })
    .join('\n');
}

/**
 * A key counts as read when the corpus calls `gstack-config get|has <key>`
 * (directly or through a variable naming the config binary), passes
 * ['get', '<key>'] to a spawn, calls a config-reader function with the key,
 * or anchors the YAML key (`^<key>:`). Wildcard keys match by prefix.
 */
function isReadInCorpus(arm: string, corpus: string): boolean {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wildcard = arm.endsWith('*');
  const k = wildcard ? esc(arm.slice(0, -1)) : `${esc(arm)}(?![A-Za-z0-9_])`;
  const re = new RegExp([
    `(?:gstack-config|\\$\\{?[A-Z_]*CONF[A-Z_]*\\}?)["']?[ \\t]+(?:get|has)[ \\t]+["']?${k}`,
    `['"](?:get|has)['"]\\s*,\\s*['"]${k}`,
    `(?:readConfigKey|readConfigKeyWithRoot|readGstackConfigYamlKey|configValue|configGet|gstack_read_config_key|gstack_config_select)\\(?[ \\t]*['"\`]?${k}`,
    `\\^${k}${wildcard ? '' : ':'}`,
  ].join('|'));
  return re.test(corpus);
}

describe('gstack-config defaults (gate, free)', () => {
  test('retired checkpoint keys have no defaults or advertised configuration', () => {
    expect(fs.readFileSync(CONFIG_BIN, 'utf8')).not.toMatch(/checkpoint/i);
    for (const key of ['checkpoint_mode', 'checkpoint_push']) {
      expect(defaultArms()).not.toContain(key);
      expect(get(key)).toEqual({ out: '', code: 1 });
    }
    for (const command of ['list', 'defaults']) {
      const result = spawnSync('bash', [CONFIG_BIN, command], {
        encoding: 'utf8', timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: STATE, GSTACK_STATE_ROOT: STATE },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/checkpoint_mode|checkpoint_push/);
    }
  });

  test('workspace history does not add call sites to the source census', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-config-census-'));
    try {
      fs.mkdirSync(path.join(root, '.context', 'old-checkout'), { recursive: true });
      fs.writeFileSync(path.join(root, 'active.md'), 'gstack-config get question_tuning\n');
      fs.writeFileSync(path.join(root, '.context', 'old-checkout', 'old.md'), 'gstack-config get retired_workspace_key\n');
      fs.writeFileSync(path.join(root, 'CHANGELOG.md'), 'Previously used gstack-config get retired_release_key\n');
      expect(keysReadInTree(root)).toEqual(['question_tuning']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('every key read in the tree is covered by the DEFAULTS table', () => {
    const arms = defaultArms();
    expect(arms.length).toBeGreaterThan(10); // the parse actually found the table
    const uncovered = keysReadInTree().filter((k) => !isCovered(k, arms));
    expect(uncovered).toEqual([]);
  });

  test('every DEFAULTS key is read by code or listed as prose-only', () => {
    const corpus = readerCorpus();
    const arms = defaultArms();
    const unread = arms.filter((a) => !(a in PROSE_ONLY_KEYS) && !isReadInCorpus(a, corpus));
    if (unread.length > 0) {
      throw new Error(
        `DEFAULTS keys with no reader: ${unread.join(', ')}. Fix one of two ways: ` +
          `add the code that reads the key (gstack-config get/has <key> in bin/, lib/, scripts/, setup or a .tmpl), ` +
          `or add it to PROSE_ONLY_KEYS in ${SELF} with the reason it has no reader.`,
      );
    }
    const stale = Object.keys(PROSE_ONLY_KEYS).filter((k) => !arms.includes(k) || isReadInCorpus(k, corpus));
    if (stale.length > 0) {
      throw new Error(
        `PROSE_ONLY_KEYS entries that are no longer prose-only: ${stale.join(', ')}. Fix one of two ways: ` +
          `remove the entry because code now reads the key, or remove it because the key left the DEFAULTS table.`,
      );
    }
  });

  test('the reader matcher finds each reader form and nothing in prose', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-config-readers-'));
    try {
      fs.mkdirSync(path.join(root, 'bin'));
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'bin', 'a'), [
        'V=$("$CONFIG_BIN" get key_one 2>/dev/null)',
        'gstack-config has key_two',
        "spawnSync(bin, ['get', 'key_three'], { timeout: 2000 })",
        "readConfigKey('key_four')",
        "readGstackConfigYamlKey('key_eight')",
        'grep -E "^key_five_${hash}:" "$F"',
      ].join('\n'));
      fs.writeFileSync(path.join(root, 'docs', 'prose.md'), 'gstack-config get key_six\n');
      fs.writeFileSync(path.join(root, 'skill.md.tmpl'), 'gstack-config get key_seven\n');
      const corpus = readerCorpus(root);
      const read = ['key_one', 'key_two', 'key_three', 'key_four', 'key_five_*', 'key_six', 'key_seven', 'key_eight', 'key_one_more']
        .filter((k) => isReadInCorpus(k, corpus));
      expect(read).toEqual(['key_one', 'key_two', 'key_three', 'key_four', 'key_five_*', 'key_seven', 'key_eight']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe('design_detector (auto|off, rejecting validator)', () => {
  test('defaults to auto', () => {
    expect(get('design_detector')).toEqual({ out: 'auto', code: 0 });
  });

  test('set to an invalid value exits 1 and leaves the file unchanged', () => {
    const file = path.join(STATE, 'config.yaml');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    const r = spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector', 'maybe'], {
      encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: STATE },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("design_detector 'maybe' not recognized");
    const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    expect(after).toBe(before);
    expect(get('design_detector').out).toBe('auto');
  });

  test('list and defaults enumerate design_detector', () => {
    for (const verb of ['list', 'defaults']) {
      const r = spawnSync('bash', [CONFIG_BIN, verb], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: STATE } });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/design_detector:\s+auto/);
    }
  });

  test('set off / set auto round-trip', () => {
    spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector', 'off'], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: STATE } });
    expect(get('design_detector').out).toBe('off');
    spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector', 'auto'], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: STATE } });
    expect(get('design_detector').out).toBe('auto');
  });
});

describe('design_detector_install_prompted (true|false, rejecting validator)', () => {
  const env = { ...process.env, GSTACK_STATE_ROOT: STATE };
  test('defaults to false, rejects a typo with the file unchanged, round-trips true/false, and is enumerated', () => {
    expect(get('design_detector_install_prompted')).toEqual({ out: 'false', code: 0 });
    const file = path.join(STATE, 'config.yaml');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    const bad = spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector_install_prompted', 'yes'], { encoding: 'utf-8', timeout: 30_000, env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("design_detector_install_prompted 'yes' not recognized");
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null).toBe(before);
    spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector_install_prompted', 'true'], { encoding: 'utf-8', timeout: 30_000, env });
    expect(get('design_detector_install_prompted').out).toBe('true');
    spawnSync('bash', [CONFIG_BIN, 'set', 'design_detector_install_prompted', 'false'], { encoding: 'utf-8', timeout: 30_000, env });
    expect(get('design_detector_install_prompted').out).toBe('false');
    for (const verb of ['list', 'defaults']) {
      const r = spawnSync('bash', [CONFIG_BIN, verb], { encoding: 'utf-8', timeout: 30_000, env });
      expect(r.stdout).toMatch(/design_detector_install_prompted:\s+false/);
    }
  });
});

describe('transcript_ingest_mode (recent|all|off, rejecting validator)', () => {
  const env = { ...process.env, GSTACK_STATE_ROOT: STATE };
  const set = (key: string, value: string) =>
    spawnSync('bash', [CONFIG_BIN, 'set', key, value], { encoding: 'utf-8', timeout: 30_000, env });
  const has = (key: string) => spawnSync('bash', [CONFIG_BIN, 'has', key], { encoding: 'utf-8', timeout: 30_000, env }).status;
  const file = path.join(STATE, 'config.yaml');
  const snapshot = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

  test('accepts recent, all and off', () => {
    for (const value of ['recent', 'all', 'off']) {
      expect(set('transcript_ingest_mode', value).status).toBe(0);
      expect(get('transcript_ingest_mode').out).toBe(value);
    }
    expect(has('transcript_ingest_mode')).toBe(0);
  });

  test('rejects legacy letters and unknown values with the file unchanged', () => {
    set('transcript_ingest_mode', 'recent');
    for (const value of ['A', 'incremental', 'new-only', 'yes', 'Recent']) {
      const before = snapshot();
      const r = set('transcript_ingest_mode', value);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `Error: transcript_ingest_mode '${value}' not recognized. Valid values: recent, all, off. Existing value left unchanged.`,
      );
      expect(snapshot()).toBe(before);
    }
    expect(get('transcript_ingest_mode').out).toBe('recent');
  });
});

describe('set rejects empty and multi-line values for every key', () => {
  const env = { ...process.env, GSTACK_STATE_ROOT: STATE };
  const file = path.join(STATE, 'config.yaml');
  const snapshot = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

  test('an empty value exits 1 and leaves the file unchanged', () => {
    for (const key of ['workspace_root', 'transcript_ingest_mode', 'some_free_form_key']) {
      const before = snapshot();
      const r = spawnSync('bash', [CONFIG_BIN, 'set', key, ''], { encoding: 'utf-8', timeout: 30_000, env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/empty/i);
      expect(snapshot()).toBe(before);
    }
  });

  test('a value containing a newline exits 1 and leaves the file unchanged', () => {
    for (const key of ['workspace_root', 'transcript_ingest_mode', 'some_free_form_key']) {
      const before = snapshot();
      const r = spawnSync('bash', [CONFIG_BIN, 'set', key, 'recent\nall'], { encoding: 'utf-8', timeout: 30_000, env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/newline/i);
      expect(snapshot()).toBe(before);
    }
  });
});
