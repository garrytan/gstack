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

  // Value: protects=the budget section's dispatch program starts the review log once per logged row on the batch's reservation, and a later batch of the same pass (the Red Team, an ADMIT remainder) takes no start, so no start token is left unfinished; fails_when=the program starts once per role or tells every batch to start;
  //   why_new=main's tests only check that each review file mentions --reservation; seam=none; no_claim=the agent follows the order
  test('the dispatch program starts once per logged row on its reservation, and a later batch of the pass takes no start', () => {
    const handoff = read('ship/sections/budget-handoff.md.tmpl');
    expect(handoff).toContain('`gstack-review-log --start <skill> --reservation <id>` once per\nrow the step logs');
    expect(handoff).not.toContain('once per role on the printed reservation');
    expect(handoff).toMatch(/later batch of the same pass \(the Red Team or an ADMIT remainder\) takes no start/);
  });

  // Value: protects=every concrete check command in the ship sections passes the counter, since on the Capy meter a check without --reading exits 2 and the dispatch it gates never starts (#3633 pass 2); fails_when=a section spells `gstack-ship-budget check --run` without `--reading`;
  //   why_new=no test reads the check commands; seam=none; no_claim=the agent fills the reading
  test('every gstack-ship-budget check --run command in the ship sections passes --reading', () => {
    for (const rel of fs.readdirSync(path.join(ROOT, 'ship/sections')).filter(n => n.endsWith('.md.tmpl'))) {
      for (const cmd of read(`ship/sections/${rel}`).match(/gstack-ship-budget check --run [^`]*/g) ?? []) {
        expect(cmd, rel).toContain('--reading');
      }
    }
  });

  // Value: protects=the prose that takes a reservation id reads the RESERVATION_ID: line, never a field cut from RESERVATION:; fails_when=the budget section or the Capy skill names the id without that line;
  //   why_new=the line is new; seam=none; no_claim=the agent copies it
  test('the budget section and the Capy skill read the id from the RESERVATION_ID: line', () => {
    for (const rel of ['ship/sections/budget-handoff.md.tmpl', 'capy/skill/gstack/SKILL.md']) {
      expect(read(rel), rel).toContain('`RESERVATION_ID:`');
    }
  });

  // Value: protects=the budget section's Capy meter reads tokens and credits in the program that runs the command, never spends a call only to read the meter, and points a driver run at observe mode; fails_when=the section asks for a per-call meter read again (budget-handoff.md:12-13 at b617445: 11 meter-only calls at 286k each on #34's child), drops --credits, or loses the observe pointer;
  //   why_new=variant G; seam=none; no_claim=the agent's adherence
  test('the budget section reads credits beside tokens, never spends a call on the meter, and points driver runs at observe mode', () => {
    const text = read('ship/sections/budget-handoff.md.tmpl').replace(/\s+/g, ' ');
    for (const s of ['--reading <cost.tokens> --credits <cost.credits>', 'never spend a call only to read the meter', 'A `ship/DRIVER.md` run starts `--mode observe` instead: no check, reservation or handoff; each program ends with `note`']) expect(text).toContain(s);
    expect(read('docs/ship-budget.md')).toContain('## Observe mode (ship/DRIVER.md)');
  });

  test('every review-log --start in the dispatch sections takes a reservation when a cap is set', () => {
    for (const rel of ['ship/sections/review-army.md.tmpl', 'ship/sections/adversarial.md.tmpl']) expect(read(rel)).toContain('--reservation');
  });
});
