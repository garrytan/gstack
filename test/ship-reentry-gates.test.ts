import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generatePlanCompletionGateShip } from '../scripts/resolvers/plan-gates';
import { generateTestBootstrap } from '../scripts/resolvers/testing';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { expectMentions } from './helpers/prompt-structure';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');
const ctx = { host: 'claude' as const, skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude };

test('ship stop lines block advancement while retaining the stated repair route', () => {
  const entry = compact(read('ship/SKILL.md.tmpl'));
  expectMentions(entry, [['stop', 'repair/resume', 'advancement']], 'entry');
  expectMentions(entry, [['before', 'askuserquestion', 'continuing']], 'entry');
  expectMentions(entry, [['never', 'authorization', 'decisions']], 'entry');
  const review = compact(read('ship/sections/review-army.md.tmpl'));
  expect(review).toMatch(/\*\*Dispatched reviewer output missing:\*\* stop\b/i);
  expect(review).toMatch(/\*\*Third fixing cycle reached \(`CYCLES >= 3`\):\*\* stop\b/i);
});

test('a new ship bootstrap choice overrides only the saved decline, not framework selection', () => {
  const ship = generateTestBootstrap(ctx);
  const decline = ship.slice(ship.indexOf('**If BOOTSTRAP_DECLINED**'), ship.indexOf('**If NO ecosystem marker matched:**'));
  expectMentions(compact(decline), [['only', 'invocation', 'overrides']], 'compact(decline)');
  expect(compact(decline)).toMatch(/including framework approval/i);
  expect(decline).not.toContain('rm ');
  expect(ship.indexOf('**If ANY existing-test evidence appears**')).toBeLessThan(ship.indexOf('**If BOOTSTRAP_DECLINED**'));
  const qa = generateTestBootstrap({ ...ctx, skillName: 'qa' });
  expect(compact(qa)).toMatch(/BOOTSTRAP_DECLINED[^\n]{0,120}skip the rest of bootstrap/i);
  expect(qa).not.toContain("Step 5's explicit Add tests choice");
});

test('an unverified item answered not done enters the existing decision before continuing', () => {
  const gate = generatePlanCompletionGateShip(ctx);
  const exits = compact(gate.slice(gate.indexOf('**Exit conditions:**'), gate.indexOf('**Cap.**')));
  expect(exits).toMatch(/any N: stop and report that item as NOT DONE/i);
  expectMentions(exits, [['only', 'required', 'verified']], 'exits');
  expect(exits).toMatch(/no second deferral choice/i);
  expect(exits).not.toContain('re-running /ship');
  expect(gate).toMatch(/per-item confirmation/i);
});

test('docs reentry distinguishes the initial audit from same-invocation accepted evidence', () => {
  const docs = compact(read('ship/sections/documentation.md.tmpl'));
  const entry = docs.slice(0, docs.indexOf('## Prepare the candidate'));
  expectMentions(entry, [['never', 'authorizes', 'reentry']], 'entry');
  expect(docs).toMatch(/never a third attempt/i);
  expectMentions(docs, [['never', 'invocations', 'across']], 'docs');
  expectMentions(docs, [['cannot', 'redaction/security', 'unauthorized']], 'docs');
});

test('late behavioral repairs rebuild before the docs decision and commit only remaining changes', () => {
  const entry = compact(read('ship/SKILL.md.tmpl'));
  expectMentions(entry, [['does not', 'ending', 'range']], 'entry');
  expectMentions(entry, [['before', 'rebuild', 'compare']], 'entry');
  const commit = entry.slice(entry.indexOf('### 5. Report, then push'), entry.indexOf('## Step 17:'));
  expectMentions(commit, [['never', 'create', 'commit']], 'commit');
  expect(commit).toMatch(/preserve unrelated user files/i);
});

test('the title is prefixed once before the exact scanned value is published', () => {
  const body = compact(read('ship/sections/pr-body.md.tmpl'));
  expect(body).toContain("Step 18's `NEW_TITLE` unchanged");
  expect(body).not.toContain('`NEW_TITLE`, prefixed with');
  expect(body).toContain('--title "$NEW_TITLE"');
  expect(body).toContain('scanned `NEW_TITLE`');
});
