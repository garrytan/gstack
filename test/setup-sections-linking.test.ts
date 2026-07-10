/**
 * Static invariant: the two install targets that cherry-pick SKILL.md (Claude
 * prefixed dirs + Kiro) must ALSO install the sections/ subdir, or a carved
 * skill's runtime "Read sections/<name>.md" 404s. codex/factory/opencode link
 * the whole generated dir, so sections ride along for free there.
 *
 * Matches the repo's static-tripwire style (setup-windows-fallback,
 * cdp-session-cleanup). End-to-end "sections resolve in a temp install" runs in
 * the group-5/6 functional pass once real ship/sections/ exist.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SETUP = fs.readFileSync(path.join(import.meta.dir, '..', 'setup'), 'utf-8');

/** Body of a shell function `name() { ... }` up to the closing line `}`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) return '';
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe('setup links sections/ for cherry-pick install targets', () => {
  test('link_claude_skill_dirs links sections/ via _link_or_copy', () => {
    const body = fnBody(SETUP, 'link_claude_skill_dirs');
    expect(body).toContain('sections');
    // sections install must route through the windows-safe helper, not raw ln.
    expect(body).toMatch(/_link_or_copy\s+"\$gstack_dir\/\$dir_name\/sections"\s+"\$target\/sections"/);
    expect(body).toMatch(/if \[ -d "\$gstack_dir\/\$dir_name\/sections" \]/);
  });

  test('kiro per-skill loop rewrites + copies sections/*', () => {
    // Kiro builds from the codex output and sed-rewrites paths; sections must get
    // the same rewrite so they resolve under ~/.kiro, not ~/.codex or ~/.claude.
    expect(SETUP).toMatch(/if \[ -d "\$skill_dir\/sections" \]/);
    expect(SETUP).toMatch(/mkdir -p "\$target_dir\/sections"/);
    expect(SETUP).toContain('$target_dir/sections/$(basename "$section_file")');
  });

  test('no raw ln introduced (windows-fallback invariant still holds)', () => {
    // Every new line touching sections uses _link_or_copy or sed redirect, never ln.
    const sectionLines = SETUP.split('\n').filter(l => l.includes('sections') && /\bln\s+-/.test(l));
    expect(sectionLines).toEqual([]);
  });
});
