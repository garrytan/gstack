/**
 * Plan B4: every review skill carries `sections/checklist.md` (at most 200
 * lines) whose obligation table maps each required output to the heading in
 * `sections/review-sections.md` that produces it, so a condensed profile can
 * never drop a required output silently. The manifest's `scope` is optional
 * (default `always`), every value is in the enum, the checklist is
 * `runner_only` and absent from the rendered Section index (interactive
 * renders ignore the field), and the runner's loader keeps the deep section
 * whenever scope is uncertain. Negative controls: a row naming a heading that
 * does not exist, and a required-output heading missing from the table.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SECTION_SCOPES, sectionLoadFor, sectionScopeOff, type Scope } from '../lib/autoplan-prompts';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILLS = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'] as const;
const PHASE: Record<string, 'ceo' | 'eng' | 'design' | 'dx'> = { 'plan-ceo-review': 'ceo', 'plan-eng-review': 'eng', 'plan-design-review': 'design', 'plan-devex-review': 'dx' };

const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const headings = (text: string) => text.split('\n').flatMap(l => { const m = /^#{2,3}\s+(.+?)\s*$/.exec(l); return m ? [m[1]!] : []; });
/** Obligation rows: | Output | Produced by | Scope | */
function obligationRows(checklist: string): Array<{ output: string; section: string; scope: string }> {
  const start = checklist.indexOf('| Output | Produced by | Scope |');
  if (start < 0) throw new Error('checklist lacks the obligation table header');
  return checklist.slice(start).split('\n').slice(2).filter(l => l.startsWith('|')).map(l => {
    const [, output, section, scope] = l.split('|').map(c => c.trim());
    return { output: output!, section: section!, scope: scope! };
  });
}
/** Every row must name a heading that exists; every `### ` under Required Outputs must be mapped. */
function checkObligationMap(checklist: string, deep: string): string[] {
  const failures: string[] = [];
  const all = headings(deep);
  const rows = obligationRows(checklist);
  for (const row of rows) {
    if (!all.some(h => h.startsWith(row.section))) failures.push(`row "${row.output}" names a heading that does not exist: ${row.section}`);
    if (!SECTION_SCOPES.includes(row.scope as any)) failures.push(`row "${row.output}" has scope ${row.scope} outside ${SECTION_SCOPES.join('|')}`);
  }
  const lines = deep.split('\n');
  const reqStart = lines.findIndex(l => /^## Required [Oo]utputs/.test(l));
  if (reqStart < 0) return [...failures, 'review-sections.md lacks a Required Outputs section'];
  let reqEnd = lines.findIndex((l, i) => i > reqStart && /^## /.test(l));
  if (reqEnd < 0) reqEnd = lines.length;
  const skip = /^(Stage 1|Review facts|Output reference|TODOS\.md updates|Approved Mockups)/;
  for (const line of lines.slice(reqStart, reqEnd)) {
    const m = /^### (.+?)\s*$/.exec(line);
    if (!m || skip.test(m[1]!)) continue;
    if (!rows.some(r => m[1]!.startsWith(r.section))) failures.push(`required output not in the checklist table: ${m[1]}`);
  }
  return failures;
}

describe('review checklists (plan B4)', () => {
  for (const skill of SKILLS) {
    test(`${skill}: checklist <= 200 lines, generated, and its obligation map covers Required Outputs`, () => {
      const checklist = read(skill, 'sections', 'checklist.md');
      expect(checklist.split('\n').length).toBeLessThanOrEqual(200);
      expect(checklist.slice(0, 200)).toContain('AUTO-GENERATED');
      expect(fs.existsSync(path.join(ROOT, skill, 'sections', 'checklist.md.tmpl'))).toBe(true);
      expect(checkObligationMap(checklist, read(skill, 'sections', 'review-sections.md'))).toEqual([]);
      expect(obligationRows(checklist).length).toBeGreaterThanOrEqual(8);
    });

    test(`${skill}: manifest scope is optional with always as the default, in the enum, and the checklist is runner_only and out of the Section index`, () => {
      const manifest = JSON.parse(read(skill, 'sections', 'manifest.json'));
      expect(manifest.note).toContain('scope');
      expect(manifest.note).toContain('bin/gstack-autoplan');
      const checklist = manifest.sections.find((s: any) => s.id === 'checklist');
      expect(checklist).toMatchObject({ file: 'checklist.md', runner_only: true });
      for (const s of manifest.sections) expect(SECTION_SCOPES).toContain(s.scope ?? 'always');
      const skeleton = read(skill, 'SKILL.md');
      const index = skeleton.slice(skeleton.indexOf('## Section index'), skeleton.indexOf('\n## ', skeleton.indexOf('## Section index') + 1));
      expect(index).toContain('sections/review-sections.md');
      expect(index).not.toContain('checklist');
    });
  }

  test('negative controls: a row naming a missing heading fails, and an unmapped required output fails', () => {
    const deep = read('plan-eng-review', 'sections', 'review-sections.md');
    const checklist = read('plan-eng-review', 'sections', 'checklist.md');
    const bogus = checklist.replace('| Diagrams | Diagrams | always |', '| Diagrams | Diagrams of the moon | always |');
    expect(checkObligationMap(bogus, deep)).toEqual(['row "Diagrams" names a heading that does not exist: Diagrams of the moon', 'required output not in the checklist table: Diagrams']);
    const dropped = checklist.replace(/\| Failure modes \|.*\n/, '');
    expect(checkObligationMap(dropped, deep)).toEqual(['required output not in the checklist table: Failure modes']);
    const badScope = checklist.replace('| Diagrams | Diagrams | always |', '| Diagrams | Diagrams | moon |');
    expect(checkObligationMap(badScope, deep)[0]).toContain('outside');
  });

  test('the runner loads the checklist in light mode, keeps always sections, and falls back to the deep section when scope is uncertain', () => {
    const detectedNoUi: Scope = { ui: false, dx: true, ui_matches: 0, dx_matches: 4, developer_tool: false, agent_primary: false, source: 'detected' };
    const light = sectionLoadFor('ceo', detectedNoUi, 'light');
    expect(light.checklist).toContain('## Checklist (runner profile)');
    expect(light.loaded).toEqual(['review-sections']);
    expect(light.skipped).toEqual([]);
    expect(light.line).toBe('Skipped sections: none (scope: ui=no,dx=yes,source=detected)');
    const full = sectionLoadFor('ceo', detectedNoUi, 'full');
    expect(full.checklist).toBeNull();
    expect(full.loaded).toEqual(['review-sections']);
    // a scoped section is skipped only when its scope is off by flags or detected with zero matches; weak detection keeps it
    expect(sectionScopeOff('ui', detectedNoUi)).toBe(true);
    expect(sectionScopeOff('ui', { ...detectedNoUi, ui_matches: 1 })).toBe(false);
    expect(sectionScopeOff('ui', { ...detectedNoUi, source: 'flags' })).toBe(true);
    expect(sectionScopeOff('ui', { ...detectedNoUi, source: 'flags', ui: true })).toBe(false);
    expect(sectionScopeOff('dx', { ...detectedNoUi, dx: false, dx_matches: 0 })).toBe(true);
    expect(sectionScopeOff('dx', { ...detectedNoUi, dx: false, dx_matches: 2 })).toBe(false);
    for (const s of ['always', 'db', 'perf', 'security', 'incident'] as const) expect(sectionScopeOff(s, { ...detectedNoUi, ui: false, dx: false, dx_matches: 0 })).toBe(false);
  });
});
