/**
 * Tripwire: design skills read the paths `$D` printed for this round, never a
 * fixed variant name or a directory glob, because `$D` never overwrites and a
 * second round lands at bumped names (variant-A-2.png). Runs on the generated
 * SKILL.md files (with their sections) and the resolver sources.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

/** The one reasoned exception, anchored on content rather than a line number. */
const ALLOWLIST = [{
  file: 'design-html/SKILL.md',
  line: '_VARIANTS=$(ls -t "$GSTACK_STATE_ROOT/projects/$SLUG/designs/"*/variant-*.png 2>/dev/null | head -1)',
  reason: 'cross-session discovery probe: design-html runs no generator, it only detects that earlier rounds exist; its approved image comes from approved.json',
}];

const GENERATOR = /(?:\$D|"\$D")\s+(generate|variants|iterate|evolve)\b/;
const CONSUMER = /^\s*(?:\$D|"\$D")\s+(compare|check)\b/m;

function flowFiles(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const skill = `${entry.name}/SKILL.md`;
    if (fs.existsSync(path.join(ROOT, skill))) out.push(skill);
    const sections = `${entry.name}/sections`;
    if (fs.existsSync(path.join(ROOT, sections))) {
      for (const f of fs.readdirSync(path.join(ROOT, sections))) if (f.endsWith('.md')) out.push(`${sections}/${f}`);
    }
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts/resolvers'))) if (f.endsWith('.ts')) out.push(`scripts/resolvers/${f}`);
  return out;
}

function bashLines(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n'));
}

function argAfter(line: string, flag: string): string | null {
  const m = line.match(new RegExp(`${flag}\\s+("([^"]+)"|(\\S+))`));
  return m ? (m[2] ?? m[3]) : null;
}

/** Concrete bans only; returns one message per violation. */
export function scanForBannedReads(file: string, text: string): string[] {
  const violations: string[] = [];
  const allowed = new Set(ALLOWLIST.filter(a => a.file === file).map(a => a.line.trim()));
  const outputs = new Set<string>();
  for (const line of text.split('\n')) {
    if (GENERATOR.test(line)) {
      const out = argAfter(line, '--output');
      if (out) outputs.add(out);
    }
  }
  text.split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    if (allowed.has(line.trim())) return;
    if (/variant-[A-Z]\.png/.test(line)) violations.push(`${where} fixed variant name: ${line.trim()}`);
    if (/variant-\*\.png/.test(line)) violations.push(`${where} variant glob: ${line.trim()}`);
    if (/variant-\{letter\}/.test(line) && !/gstack-design-claim/.test(line)) violations.push(`${where} variant-{letter} placeholder read: ${line.trim()}`);
    const copy = line.match(/(?:^|[\s;&|(`])(?:cp|mv)\s+(.*)$/);
    if (copy && (/variant|responsive-|outputPath/.test(copy[1]) || [...outputs].some(o => copy[1].includes(o)))) {
      violations.push(`${where} cp/mv of a $D output (publish with gstack-design-claim): ${line.trim()}`);
    }
    const image = /\$D\s+check\b/.test(line) ? argAfter(line, '--image') : /\$D\s+verify\b/.test(line) ? argAfter(line, '--mockup') : null;
    if (image && outputs.has(image)) violations.push(`${where} reads the requested --output instead of the printed path: ${line.trim()}`);
  });
  return violations;
}

const files = flowFiles();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('design printed-paths tripwire', () => {
  // Value: protects=no skill reads a fixed variant name, glob or requested --output after $D bumps a name;
  //   fails_when=a template reintroduces variant-A.png, variant-*.png, a cp of a $D output or a literal check path; why_new=#1529; seam=none
  test('generated skills and resolvers read only printed paths', () => {
    const violations = files.flatMap(f => scanForBannedReads(f, read(f)));
    expect(violations).toEqual([]);
  });

  // Value: protects=the allowlist cannot rot into a blanket pass; fails_when=the probe line changes and the entry no longer anchors;
  //   why_new=content-anchored allowlist; seam=none
  test('the allowlist entry still anchors to real content', () => {
    for (const a of ALLOWLIST) {
      expect(read(a.file).split('\n').map(l => l.trim())).toContain(a.line);
      expect(a.reason.length).toBeGreaterThan(20);
    }
  });

  // Value: protects=the scanner actually catches each banned form; fails_when=a regex is loosened until it matches nothing;
  //   why_new=negative controls for the tripwire; seam=none
  test('fixtures with each banned form fail', () => {
    const cases = [
      '$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png"',
      '_IMAGES=$(ls "$_DESIGN_DIR"/variant-*.png)',
      '5. Quality check: {$D path} check --image {_DESIGN_DIR}/variant-{letter}.png',
      'cp /tmp/variant-B.png "$_DESIGN_DIR/"',
      '$D generate --brief "x" --output "$DIR/target.png"\n$D verify --mockup "$DIR/target.png" --screenshot after.png',
      '$D generate --brief "x" --output "$DIR/target.png"\n$D check --image "$DIR/target.png" --brief x',
    ];
    for (const c of cases) expect(scanForBannedReads('fixture.md', c).length, c).toBeGreaterThan(0);
    expect(scanForBannedReads('fixture.md', 'FINAL=$(gstack-design-claim "<outputPath>" "{dir}/variant-{letter}.png")')).toEqual([]);
  });
});

describe('design generating flows', () => {
  const flows: Record<string, string[]> = {
    'office-hours': ['office-hours/SKILL.md'],
    'plan-design-review': ['plan-design-review/SKILL.md'],
    'design-consultation': ['design-consultation/sections/proposal-and-preview.md'],
    'design-shotgun': ['design-shotgun/SKILL.md'],
  };

  for (const [skill, sources] of Object.entries(flows)) {
    // Value: protects=round accounting (with the zero-saved stop) comes before the first board or check in each flow;
    //   fails_when=a template moves the board or check above the accounting marker or drops the stop; why_new=CEO accounting position; seam=none
    test(`${skill}: round accounting precedes the first consumer and stops on zero saved`, () => {
      const text = sources.map(read).join('\n');
      const accounting = text.indexOf('<!-- design:round-accounting -->');
      const board = text.indexOf('<!-- design:board -->');
      const consumer = text.search(CONSUMER);
      expect(accounting).toBeGreaterThan(-1);
      expect(board).toBeGreaterThan(accounting);
      expect(consumer).toBeGreaterThan(accounting);
      const span = text.slice(accounting, Math.min(board, consumer));
      expect(span).toMatch(/stop/i);
      expect(span).toMatch(/nothing was saved|saves nothing|zero/i);
    });
  }

  // Value: protects=generating steps capture JSON and the exit code instead of dying under set -e;
  //   fails_when=a bare `$D generate ...` line returns; why_new=eng template exit handling; seam=none
  test('every generating bash line captures stdout and the exit code', () => {
    const bare = files.filter(f => f.endsWith('.md')).flatMap(f => bashLines(read(f))
      .filter(l => GENERATOR.test(l) && !/=\$\(.*\);\s*_?RC=\$\?/.test(l))
      .map(l => `${f}: ${l.trim()}`));
    expect(bare).toEqual([]);
  });

  // Value: protects=every approval writer records approved_path so a bumped round resolves to the right image;
  //   fails_when=a writer goes back to approved_variant only; why_new=approved-image identity; seam=none
  test('every approval-record writer stores approved_path', () => {
    const writers = files.flatMap(f => read(f).split('\n')
      .filter(l => /approved_variant/.test(l) && (/>\s*"\$_DESIGN_DIR\/approved\.json"/.test(l) || /Write of `\$_DESIGN_DIR\/approved\.json`/.test(l)))
      .map(l => ({ f, l })));
    expect(writers.length).toBeGreaterThanOrEqual(3);
    for (const { f, l } of writers) expect(l, f).toContain('approved_path');
  });

  // Value: protects=shotgun generation stages in a fresh mktemp dir and publishes through the no-clobber helper;
  //   fails_when=the shared /tmp/variant file and cp return; why_new=eng staging requirement; seam=none
  test('design-shotgun stages per run and publishes with gstack-design-claim', () => {
    const shotgun = read('design-shotgun/SKILL.md');
    const prompt = shotgun.slice(shotgun.indexOf('### Step 3c'), shotgun.indexOf('### Step 3d'));
    // INV-3: the per-run staging dir honors TMPDIR.
    expect(prompt).toContain('mktemp -d "${TMPDIR:-/tmp}/');
    expect(prompt).toMatch(/gstack-design-claim "<saved path>"/);
    expect(prompt).not.toMatch(/\/tmp\/variant-/);
    expect(prompt).toMatch(/every published path/);
  });
});
