/**
 * Claude installer runtime-asset coverage (#2317 / #2454).
 *
 * `link_claude_skill_dirs` historically installed only SKILL.md (+ sections/)
 * per skill, so every skill that reads a sibling runtime file at
 * `.claude/skills/<name>/<file>` — review's checklist.md + specialists/, qa's
 * templates/ + references/, gstack-upgrade's migrations/, careful/freeze's
 * bin/ — was broken on a fresh Claude install. This suite runs the REAL
 * installer functions (extracted from `setup`) against the live repo into a
 * temp skills dir and asserts the install is complete.
 *
 * Two-class referenced-paths assertion (eng review ENG-OV7):
 *   - Class 1 (alias-relative): a `.claude/skills/<name>/<relpath>` reference
 *     in an INSTALLED SKILL.md must resolve under the install dir. These are
 *     runtime reads against the flattened alias — a miss is a broken skill.
 *   - Class 2 (repo-anchored): a `~/.claude/skills/gstack/<relpath>`
 *     reference must exist in the source tree, EXCEPT built artifacts
 *     (browse/dist, design/dist, make-pdf/dist, the compiled
 *     bin/gstack-global-discover) — the free suite never builds binaries, so
 *     a naive "every path exists" either false-fails on dist or gets watered
 *     down to uselessness.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runBashScript } from './helpers/bash-script';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

/** Built-at-setup artifacts: allowed to be absent from a fresh clone. */
const BUILT_ARTIFACT_ALLOWLIST = [
  'browse/dist/',
  'design/dist/',
  'make-pdf/dist/',
  'bin/gstack-global-discover', // compiled from bin/gstack-global-discover.ts at build time
];

/**
 * Repo-anchored references that are KNOWN BROKEN on the current tree.
 * Each entry must name the fix that removes it. An empty list is the goal —
 * do not add entries without an issue + a scheduled fix.
 */
const KNOWN_BROKEN_CLASS2: Record<string, string> = {
  // (empty — #2250's bare bin names were the last entries; keep it that way)
};

/** Extract a named shell function body (through its closing brace) from setup. */
function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-claude-install-'));

beforeAll(() => {
  const script = [
    'set -e',
    'IS_WINDOWS=0',
    'SKILL_PREFIX=0',
    'QUIET=1',
    '_WINDOWS_COPY_NOTE_PRINTED=1',
    extractFn('_link_or_copy'),
    extractFn('_print_windows_copy_note_once'),
    extractFn('_link_skill_runtime_assets'),
    extractFn('_gstack_link_target_abs'),
    extractFn('_gstack_target_is_ours'),
    extractFn('_gstack_generated_header'),
    extractFn('_claude_entry_owned_strongly'),
    extractFn('_claude_entry_is_ours'),
    extractFn('_write_owned_marker'),
    extractFn('_backup_skill_md'),
    extractFn('_cleanup_weak_dir'),
    extractFn('_gstack_dir_only_links'),
    extractFn('_cleanup_linked_dir'),
    '_FOREIGN_SKIPPED_ENTRIES=()',
    '_BACKED_UP_SKILL_MDS=()',
    `_SKILL_BACKUP_ROOT="${os.tmpdir()}/gstack-harness-backups-${process.pid}"`,
    extractFn('link_claude_skill_dirs'),
    `link_claude_skill_dirs "${ROOT}" "${installDir}"`,
  ].join('\n');
  const result = runBashScript(script, { timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`installer functions failed: ${result.stderr}\n${result.stdout}`);
  }
});

afterAll(() => {
  // rmSync does not follow symlinks — the repo sources the links point at survive.
  fs.rmSync(installDir, { recursive: true, force: true });
});

function installedSkillDirs(): string[] {
  return fs
    .readdirSync(installDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(installDir, name, 'SKILL.md')));
}

describe('link_claude_skill_dirs installs every runtime asset (#2317, #2454)', () => {
  test('review skill ships its full runtime asset set', () => {
    const review = path.join(installDir, 'review');
    for (const asset of [
      'checklist.md',
      'design-checklist.md',
      'greptile-triage.md',
      'TODOS-format.md',
      'specialists',
    ]) {
      expect(fs.existsSync(path.join(review, asset))).toBe(true);
    }
    // specialists/ resolves to real content, not an empty shell
    const specialists = fs.readdirSync(path.join(review, 'specialists'));
    expect(specialists.length).toBeGreaterThan(0);
    expect(specialists).toContain('testing.md');
  });

  test('the #2454 affected-skills table is fully installed', () => {
    const expected: Array<[string, string]> = [
      ['qa', 'references'],
      ['qa', 'templates'],
      ['plan-devex-review', 'dx-hall-of-fame.md'],
      ['gstack-upgrade', 'migrations'],
      ['careful', 'bin'],
      ['freeze', 'bin'],
    ];
    for (const [skill, asset] of expected) {
      expect(fs.existsSync(path.join(installDir, skill, asset))).toBe(true);
    }
  });

  test('sections/ still installs for carved skills', () => {
    expect(fs.existsSync(path.join(installDir, 'ship', 'sections'))).toBe(true);
    expect(
      fs.readdirSync(path.join(installDir, 'ship', 'sections')).length,
    ).toBeGreaterThan(0);
  });

  test('exclusion list holds: no node_modules, dist, test, or .tmpl installed', () => {
    for (const skill of installedSkillDirs()) {
      const entries = fs.readdirSync(path.join(installDir, skill));
      expect(entries).not.toContain('node_modules');
      expect(entries).not.toContain('dist');
      expect(entries).not.toContain('test');
      const tmpl = entries.filter((e) => e.endsWith('.tmpl'));
      expect(tmpl).toEqual([]);
    }
  });

  test('hidden files are not installed (gstack\'s own provenance marker is the one allowed dotfile)', () => {
    for (const skill of installedSkillDirs()) {
      const hidden = fs
        .readdirSync(path.join(installDir, skill))
        .filter((e) => e.startsWith('.'))
        // .gstack-owned is written by the linker for directories it creates (#2119),
        // not copied from the skill source; every other dotfile must stay out.
        .filter((e) => e !== '.gstack-owned');
      expect(hidden).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Two-class referenced-paths assertion (ENG-OV7)
// ---------------------------------------------------------------------------

interface Ref {
  fromSkill: string;
  skillName: string;
  rel: string;
}

const REF_RE = /~?\.claude\/skills\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.\/-]+)/g;

/** Placeholder-ish captures (globs, template vars, <angle> examples) are prose, not paths. */
function isConcretePath(raw: string): boolean {
  return !/[<>*$(){}|]/.test(raw) && !raw.includes('..');
}

function collectRefs(): Ref[] {
  const refs: Ref[] = [];
  for (const skill of installedSkillDirs()) {
    const content = fs.readFileSync(path.join(installDir, skill, 'SKILL.md'), 'utf-8');
    for (const m of content.matchAll(REF_RE)) {
      const rel = m[2].replace(/[.,:;/]+$/, '');
      if (!rel || !isConcretePath(rel)) continue;
      refs.push({ fromSkill: skill, skillName: m[1], rel });
    }
  }
  return refs;
}

describe('two-class referenced-paths (ENG-OV7)', () => {
  test('class 1: alias-relative references resolve under the install dir', () => {
    const missing: string[] = [];
    for (const { fromSkill, skillName, rel } of collectRefs()) {
      if (skillName === 'gstack') continue; // class 2
      // Prefix-mode prose may reference gstack-<name>; the flat install dir
      // is the unprefixed name.
      const candidates = [skillName, skillName.replace(/^gstack-/, '')];
      const found = candidates.some((c) => fs.existsSync(path.join(installDir, c, rel)));
      if (!found) missing.push(`${fromSkill}/SKILL.md → .claude/skills/${skillName}/${rel}`);
    }
    expect(missing).toEqual([]);
  });

  test('class 2: repo-anchored references exist in the tree (modulo built artifacts)', () => {
    const missing: string[] = [];
    for (const { fromSkill, skillName, rel } of collectRefs()) {
      if (skillName !== 'gstack') continue; // class 1
      if (rel.startsWith('.')) continue; // runtime state (.git; feature markers now live in ~/.gstack — #2728)
      if (BUILT_ARTIFACT_ALLOWLIST.some((a) => rel === a || rel.startsWith(a))) continue;
      if (KNOWN_BROKEN_CLASS2[rel]) continue;
      if (!fs.existsSync(path.join(ROOT, rel))) {
        missing.push(`${fromSkill}/SKILL.md → ~/.claude/skills/gstack/${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the referenced-path scan actually sees the review checklist refs (self-check)', () => {
    // Guard against the extraction regex silently rotting: the review skill's
    // checklist refs are KNOWN to exist. Since #2518 they anchor at the
    // installed gstack root (class 2: gstack/review/checklist.md), not the
    // alias-relative form — if the scanner stops seeing them, the class-2
    // assertion is vacuous.
    const refs = collectRefs();
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.skillName === 'gstack' && r.rel === 'review/checklist.md')).toBe(true);
  });

  test('KNOWN_BROKEN_CLASS2 entries are still actually broken (ratchet)', () => {
    // When a fix lands, its entry MUST be removed so the class-2 assertion
    // guards the path again.
    for (const rel of Object.keys(KNOWN_BROKEN_CLASS2)) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
    }
  });
});
