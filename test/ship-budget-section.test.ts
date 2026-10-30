/**
 * Skill structure for the /ship budget (GSTA-152 plan items 5 and 9): the
 * budget-handoff section is registered, the skeleton points at it and names the
 * start/check/close calls, every step id gstack-ship-budget accepts is a ship
 * step, and the dispatch sections pass a reservation into gstack-review-log.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DISPATCH_ROLES, SHIP_STEPS } from '../lib/ship-budget';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const templates = ['ship/SKILL.md.tmpl', ...fs.readdirSync(path.join(ROOT, 'ship/sections')).filter(f => f.endsWith('.md.tmpl')).map(f => `ship/sections/${f}`)];

describe('ship budget skill structure', () => {
  test('budget-handoff is registered in the manifest and read from the skeleton', () => {
    const manifest = JSON.parse(read('ship/sections/manifest.json'));
    const entry = manifest.sections.find((s: any) => s.id === 'budget-handoff');
    expect(entry).toMatchObject({ file: 'budget-handoff.md' });
    expect(fs.existsSync(path.join(ROOT, 'ship/sections/budget-handoff.md.tmpl'))).toBe(true);
    const skeleton = read('ship/SKILL.md.tmpl');
    expect(skeleton).toContain('sections/budget-handoff.md');
    for (const call of ['gstack-ship-budget start', 'check', 'close', '--token-cap', '--resume', '--continue', 'verdict=']) expect(skeleton).toContain(call);
  });

  test('every step id the budget accepts is a step the ship templates define', () => {
    const text = templates.map(read).join('\n');
    for (const step of SHIP_STEPS) expect(text, `Step ${step}`).toMatch(new RegExp(`Step ${step.replace('.', '\\.')}(?![\\d.])`));
  });

  test('the budget section names only valid steps and roles in its commands', () => {
    const text = read('ship/sections/budget-handoff.md.tmpl');
    for (const m of text.matchAll(/--(?:step|from|to) ([\d.]+)/g)) expect(SHIP_STEPS as readonly string[]).toContain(m[1]!);
    for (const m of text.matchAll(/--next dispatch:([a-z,-]+)/g)) for (const role of m[1]!.split(',')) expect(DISPATCH_ROLES as readonly string[]).toContain(role);
  });

  test('every review-log --start in the dispatch sections takes a reservation when a cap is set', () => {
    for (const rel of ['ship/sections/review-army.md.tmpl', 'ship/sections/adversarial.md.tmpl']) expect(read(rel)).toContain('--reservation');
  });
});
