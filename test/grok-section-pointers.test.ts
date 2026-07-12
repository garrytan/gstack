/**
 * Grok Build section-pointer mode (Option A token-ceiling fix).
 *
 * Carved skills must emit STOP-Read pointers + separate section files under
 * .grok/skills/gstack-<skill>/sections/, not a monolith that exceeds the
 * gen-skill-docs soft ceiling (~160KB / ~40k tokens).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  hostUsesSectionPointers,
  externalSkillPackageName,
  sectionPointerPath,
  SECTION,
  SECTION_INDEX,
} from '../scripts/resolvers/sections';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

function shipCtx(host: 'claude' | 'grok-build' | 'codex'): TemplateContext {
  return {
    skillName: 'ship',
    tmplPath: path.join(ROOT, 'ship', 'SKILL.md.tmpl'),
    host,
    paths: HOST_PATHS[host],
  };
}

describe('hostUsesSectionPointers', () => {
  test('claude and grok-build use pointers; codex inlines', () => {
    expect(hostUsesSectionPointers('claude')).toBe(true);
    expect(hostUsesSectionPointers('grok-build')).toBe(true);
    expect(hostUsesSectionPointers('codex')).toBe(false);
    expect(hostUsesSectionPointers('factory')).toBe(false);
  });
});

describe('sectionPointerPath', () => {
  test('grok uses flat package under ~/.grok/skills', () => {
    expect(sectionPointerPath('grok-build', 'ship', 'tests.md', '$GSTACK_ROOT')).toBe(
      '~/.grok/skills/gstack-ship/sections/tests.md',
    );
    expect(externalSkillPackageName('ship')).toBe('gstack-ship');
    expect(externalSkillPackageName('gstack-upgrade')).toBe('gstack-upgrade');
  });

  test('claude uses nested skillRoot layout', () => {
    expect(sectionPointerPath('claude', 'ship', 'tests.md', '~/.claude/skills/gstack')).toBe(
      '~/.claude/skills/gstack/ship/sections/tests.md',
    );
  });
});

describe('SECTION / SECTION_INDEX resolvers', () => {
  test('grok ship SECTION emits STOP-Read to gstack-ship package path', () => {
    const out = SECTION(shipCtx('grok-build'), ['tests']);
    expect(out).toContain('**STOP.**');
    expect(out).toContain('~/.grok/skills/gstack-ship/sections/tests.md');
    expect(out).not.toContain('## Test Framework Bootstrap'); // not inlined
  });

  test('codex ship SECTION still inlines section body', () => {
    const out = SECTION(shipCtx('codex'), ['tests']);
    expect(out).not.toContain('**STOP.**');
    // tests.md.tmpl has substantive body (not a pointer)
    expect(out.length).toBeGreaterThan(200);
  });

  test('grok SECTION_INDEX lists full paths; codex SECTION_INDEX is empty', () => {
    const grok = SECTION_INDEX(shipCtx('grok-build'), ['ship']);
    expect(grok).toContain('## Section index');
    expect(grok).toContain('~/.grok/skills/gstack-ship/sections/review-army.md');
    expect(SECTION_INDEX(shipCtx('codex'), ['ship'])).toBe('');
  });
});

describe('generated grok ship package (when present)', () => {
  const shipPkg = path.join(ROOT, '.grok', 'skills', 'gstack-ship');
  const skillMd = path.join(shipPkg, 'SKILL.md');
  const sectionsDir = path.join(shipPkg, 'sections');

  test('gstack-ship SKILL.md is under soft token ceiling when generated', () => {
    if (!fs.existsSync(skillMd)) return; // gen not run in this env
    const bytes = fs.statSync(skillMd).size;
    // Soft ceiling in gen-skill-docs: 160_000 bytes (~40k tokens)
    expect(bytes).toBeLessThan(160_000);
  });

  test('gstack-ship has carved section files + STOP pointers when generated', () => {
    if (!fs.existsSync(skillMd)) return;
    const body = fs.readFileSync(skillMd, 'utf-8');
    expect(body).toContain('**STOP.**');
    expect(body).toContain('~/.grok/skills/gstack-ship/sections/');
    // Heavy steps must not be inlined into the skeleton
    expect(body).not.toMatch(/## Step 9\.1: Review Army/);
    expect(fs.existsSync(path.join(sectionsDir, 'review-army.md'))).toBe(true);
    expect(fs.existsSync(path.join(sectionsDir, 'adversarial.md'))).toBe(true);
    expect(fs.existsSync(path.join(sectionsDir, 'tests.md'))).toBe(true);
  });
});
