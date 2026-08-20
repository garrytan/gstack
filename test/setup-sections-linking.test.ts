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
  test('link_claude_skill_dirs installs runtime assets (incl. sections/) via the shared helper', () => {
    // #2317/#2454 generalized the sections/-only install into
    // _link_skill_runtime_assets, which carries EVERY runtime asset a skill
    // references (sections/, checklist.md, specialists/, ...). That helper
    // routes through _link_or_copy internally (windows-safe), so the old
    // per-directory _link_or_copy assertion moved there.
    const body = fnBody(SETUP, 'link_claude_skill_dirs');
    expect(body).toMatch(/_link_skill_runtime_assets\s+"\$gstack_dir\/\$dir_name"\s+"\$target"/);
    const helper = fnBody(SETUP, '_link_skill_runtime_assets');
    expect(helper).toContain('_link_or_copy');
    expect(helper).not.toMatch(/\bln -s/);
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
