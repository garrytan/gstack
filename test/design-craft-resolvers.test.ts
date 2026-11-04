/**
 * Craft resolvers (scripts/resolvers/design-craft.ts) shared by /design-review's
 * craft audit and /plan-design-review.
 *
 * Value: protects=DESIGN_CRAFT_RULE returns a craft paragraph with its bullets and fails generation on a missing or renamed lead; fails_when=the lookup returns '' or the first paragraph instead of throwing, or drops bullets; why_new=only the freshness golden exercises the resolver, and no test reaches its throw paths; seam=none; no_claim=agent use of the rendered rules (behavioral, no paid case)
 * Value: protects=design-review and plan-design-review render the same five Persuade checks; fails_when=either surface drops or hand-forks the {{DESIGN_PERSUADE_CHECKS}} block; why_new=carve-guards checks one phrase in design-review only, nothing checks plan-design-review; seam=none; no_claim=that an agent applies the checks (eval)
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { DESIGN_CRAFT_RULE, DESIGN_PERSUADE_CHECKS } from '../scripts/resolvers/design-craft';
import { selectTests } from './helpers/test-selection';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const ctx = { skillName: 'design-review', tmplPath: 'design-review/sections/craft-audit.md.tmpl' } as TemplateContext;

describe('craft resolvers', () => {
  test('DESIGN_CRAFT_RULE renders the craft paragraph with its bullets; a missing or unknown lead fails generation', () => {
    const motion = DESIGN_CRAFT_RULE(ctx, ['Motion']);
    expect(motion).toStartWith('**Motion.**');
    expect(motion).toContain("Never an unthrottled `window.addEventListener('scroll')`");
    expect(motion).toContain('`min-height: 100dvh`, not `100vh`.');
    expect(motion).not.toContain('\n\n');
    expect(DESIGN_CRAFT_RULE(ctx, ['Claims come from the user'])).toStartWith('**Claims come from the user, never from you.**');
    expect(read('design-html', 'sections', 'craft.md')).toContain(motion);
    expect(() => DESIGN_CRAFT_RULE(ctx, ['No such lead'])).toThrow('No such lead');
    expect(() => DESIGN_CRAFT_RULE(ctx, ['Claims'])).toThrow('0 paragraphs');
    expect(() => DESIGN_CRAFT_RULE(ctx, ['Mot'])).toThrow('need exactly one');
    expect(() => DESIGN_CRAFT_RULE(ctx, [])).toThrow('requires the bold lead');
    expect(() => DESIGN_CRAFT_RULE(ctx)).toThrow('requires the bold lead');
  });

  test('design-review and plan-design-review carry the same five Persuade checks', () => {
    const checks = DESIGN_PERSUADE_CHECKS(ctx);
    expect(checks.split('\n').map(l => l.slice(0, 3))).toEqual(['1. ', '2. ', '3. ', '4. ', '5. ']);
    expect(read('design-review', 'sections', 'craft-audit.md')).toContain(checks);
    expect(read('plan-design-review', 'sections', 'review-sections.md')).toContain(checks);
  });

  test('the design-review craft audit settles each lint outcome and waiver, and keeps the saved page private', () => {
    const audit = read('design-review', 'sections', 'craft-audit.md');
    expect(audit).toContain('gstack-design-lint <path-to-page.html>');
    expect(audit).toContain('line is one category 9 finding under its rule id and line');
    expect(audit).toContain('No `LINT_SUMMARY` line: say the lint was unavailable for that page and judge the tells below by eye.');
    expect(audit).toContain('`empty-mount-node` (script renders the page): lint the saved DOM, not the repo file.');
    expect(audit).toContain('A `waived` line is one the page answered on the record: list it with its reason, do not file it, except `needs-proof` and `lorem`');
    expect(audit).not.toContain('gstack-design-craft');
    expect(audit).toContain('A saved page loses its linked CSS (`skipped … not found`): file only its `craft`-gate lines');
    expect(audit).toContain('Never mark or cut a claim as a rule or fix says: defer it and ask for the proof.');
    expect(audit).toContain('never copy it to the report directory');
  });
});

describe('design-shotgun to design-html handoff', () => {
  const ARCHETYPES = ['classic-hero', 'long-form-story', 'minimal-conversion', 'comparison'];

  test('design-shotgun records the chosen archetype and outline in approved.json, and design-html takes them as given', () => {
    const shotgun = read('design-shotgun', 'SKILL.md');
    const craft = read('design-html', 'sections', 'craft.md');
    const html = read('design-html', 'SKILL.md');
    for (const id of ARCHETYPES) {
      expect(shotgun).toContain(`\`${id}\``);
      expect(craft).toContain(`\`${id}\``);
    }
    const save = shotgun.slice(shotgun.indexOf('## Step 6: Save & Next Steps'));
    expect(save).toMatch(/add the chosen variant's `archetype` id and `sections`[^.]*to it with the Edit tool/);
    expect(html.slice(html.indexOf('### Case A'), html.indexOf('### Case B'))).toContain('any `archetype`\nand `sections`');
    expect(craft).toMatch(/When approved\.json carries an `archetype`[^.]*: take it and its `sections` outline as given[^.]*do not re-pick or re-ask/);
  });

  test('a change to the design lint selects the design-html-slop-gate E2E that runs it', () => {
    for (const file of ['lib/design-lint/rules/copy.ts', 'lib/design-catalog.ts', 'bin/gstack-design-lint']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('design-html-slop-gate');
    }
  });

  // Value: protects=a change to the shared craft resolver reruns the paid cases whose prompts it renders; fails_when=scripts/resolvers/design-craft.ts drops from those touchfile lists; why_new=the row above covers the lint and its bin only; seam=none; no_claim=that the selected cases pass
  test('a change to the craft resolvers selects the design-review and plan-design-review cases that render them', () => {
    const e2e = selectTests(['scripts/resolvers/design-craft.ts'], E2E_TOUCHFILES).selected;
    for (const name of ['design-review-fix', 'design-review-detector-shim', 'design-review-detector-shim-dom', 'design-review-plugin-handoff', 'plan-design-review-plan-mode']) expect(e2e).toContain(name);
  });

  // Value: protects=design-html runs the lint and keeps waivers in the page, with no finalized.json exception record left behind; fails_when=the prose names the deleted checker, --accepted or craft_exceptions again; why_new=option (a) replaced craft_exceptions with in-page waivers; seam=none; no_claim=that an agent writes good waiver reasons (paid case)
  test('design-html runs the lint and records waivers in the page, not in finalized.json', () => {
    const html = read('design-html', 'SKILL.md');
    const craft = read('design-html', 'sections', 'craft.md');
    expect(html).toContain('gstack-design-lint <path-to-finalized.html> --render`, one fix pass and one rerun');
    expect(craft).toContain('<!-- gstack-lint-disable <rule-id>: <reason about this page, 24+ chars> -->');
    for (const text of [html, craft]) for (const gone of ['gstack-design-craft', 'craft_exceptions', '--accepted', 'CRAFT_']) expect(text).not.toContain(gone);
  });

  // Value: protects=the content-realism tells have one checker, the lint's copy tier, and NOTICE.md credits the adapted rules to the file that ships them; fails_when=a merge restores the removed checker, its bin or its suite beside the copy tier, or NOTICE.md still credits the removed files; why_new=the fold deleted the second checker and no other test notices its return; seam=none; no_claim=what each tell detects (test/design-lint.test.ts)
  test('the content-realism tells have one checker, the lint copy tier, and NOTICE.md credits it', () => {
    for (const gone of ['lib/design-craft.ts', 'bin/gstack-design-craft', 'test/design-craft.test.ts']) expect(fs.existsSync(path.join(ROOT, gone))).toBe(false);
    const notice = read('NOTICE.md');
    expect(notice).toContain('`lib/design-lint/rules/copy.ts`: the content-realism and ship-floor tells');
    expect(notice).not.toContain('lib/design-craft.ts');
    expect(notice).not.toContain('bin/gstack-design-craft');
  });
});
