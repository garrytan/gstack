/**
 * /captain: the crew operating model as a skill plus templates.
 *
 * Pins the contract the skill teaches (one controller merges, the READY block
 * fields, the train loop, the digest shape, the approval shapes, the flaky
 * pass), the template set a team copies, and that everything shipped is
 * generic: no crew codes, no person's name, parameters instead of repo names.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const skill = read('captain/SKILL.md');
const tmpl = read('captain/SKILL.md.tmpl');
const flat = skill.replace(/\s+/g, ' ');
const TEMPLATES = ['CREW.md', 'AGENTS.md', 'NOTES.md', 'DIGEST.md', 'flaky-ledger.md', 'report.md', 'READY.md', 'slot-call.md', 'plan-ask.md', 'merge-ask.md', 'automation-flaky-pass.md', 'brief.md', 'merge-train-peer.md', 'postmortem.md'];

describe('/captain skill', () => {
  test('frontmatter names the skill and its /crew alias trigger', () => {
    expect(tmpl.startsWith('---\nname: captain\n')).toBe(true);
    expect(tmpl).toMatch(/^triggers:\n(?:  - .*\n)*  - crew\n/m);
    expect(flat).toContain('`/crew` is the same skill');
  });

  test('teaches the one rule and the READY contract fields', () => {
    expect(skill).toContain('The controller merges; a lane never merges');
    for (const field of ['READY #<n> <sha>', 'STAMP_VERSION', 'PREGATE', 'SHIP_RECEIPT', 'READY_RECEIPT', 'full 40-character head SHA', 'head frozen from now on']) {
      expect(skill, field).toContain(field);
    }
    expect(flat).toContain('A green list state, a passing PR page, a "looks good" in chat and a cheap-tier pass are not READYs');
  });

  test('READY and report carry an Unverified line that is asked for, never refused', () => {
    const ready = read('captain/templates/READY.md');
    expect(ready).toMatch(/^review passes: .*\nUnverified: <none \| [^>]+>\nHead frozen from now on;/m);
    const readyFlat = ready.replace(/\s+/g, ' ');
    for (const s of ['a review finding set aside on an assumption nobody tested', 'it never holds a PR out of a train, does not stale READYs sent before the line existed, and needs no new `ready` or /ship run']) {
      expect(readyFlat, s).toContain(s);
    }
    expect(read('captain/templates/report.md')).toMatch(/## Outcome\n\n<[^>]+>\n\nUnverified: <none \| [^>]+>\n\n## PR\n/);
    expect(skill).toMatch(/^\| `Unverified` \| each claim the lane did not check itself, or `none` \| never refused or staled; ask for it \|$/m);
    expect(flat).toContain('Outcome with its `Unverified:` line');
    const docFlat = read('docs/captain.md').replace(/\s+/g, ' ');
    expect(docFlat).toContain('The `Unverified:` line is the one exception: the controller asks for a missing line in a follow-up message, never refuses or stales a READY for it');
    expect(read('capy/skill/gstack/captain.md').replace(/\s+/g, ' ')).toContain('an `Unverified:` line: each claim you did not check yourself and why, or `none`');
  });

  test('the postmortem template asks why every reviewer believed it, and the step ships its rule change to gstack', () => {
    const pm = read('captain/templates/postmortem.md');
    expect(pm).toMatch(/^## What broke$[^]*^## How it was found$[^]*^## Impact$[^]*^## Timeline$[^]*^## Root cause: why did the lane and every reviewer believe it was right\?$[^]*^## What caught it and what should have$[^]*^## Playbook or skill change$[^]*^## Links$/m);
    expect(pm).toMatch(/^\| Believer \| What it was asked \| What it checked \| What it did not check \| Why it passed \| Source \|$/m);
    expect(pm).toMatch(/^\| Change \| Home in gstack \| Owner \| Status \| Effectiveness check \|$/m);
    const pmFlat = pm.replace(/\s+/g, ' ');
    for (const s of ['not from the diff alone', 'mark any item `not retained`', 'label anything else `inferred`', 'A change kept only in a crew file is a gap']) expect(pmFlat, s).toContain(s);
    expect(pm, 'no real PR numbers in the generic template').not.toMatch(/#\d{2,}/);
    expect(flat).toContain('After a revert or S1 fix of a merged crew PR, the controller writes a postmortem (`captain/templates/postmortem.md`): why did the lane and every reviewer believe it was right? Its rule change ships as a gstack PR.');
    expect(read('docs/captain.md').replace(/\s+/g, ' ')).toContain('Each rule change it names ships as a gstack PR, because gstack holds the how');
  });

  test('teaches the train loop, the red-train rules and the backstop', () => {
    for (const step of ['train build', 'train verdict', 'train bisect', 'train rebuild', 'train prune', 'verify --pr', '--match-head-commit', 'FLAKY N', 'exactly one unchanged', 'FREEZE: cleared', 'The tree rule', 'Gate-ahead (option)', 'Severe race (option)', 'beyond `STAMP_FILES`']) {
      expect(skill, step).toContain(step);
    }
  });

  test('teaches the digest shape, the three approval shapes and the flaky pass', () => {
    for (const s of ['**Needs you**', '**New**', '**In progress**', '**A. The per-thread approval record.**', '**B. The plan ask**', '**C. The merge ask.**', '"do it"', 'flake-records artifacts', 'red on `BASE` and green with the fix', 'KNOWN_INFRA_FLAKES']) {
      expect(flat, s).toContain(s);
    }
    expect(flat).toContain('no thresholds, trial counts, case kinds or budgets change to turn a red green');
  });

  test('ships every template the skill and docs name', () => {
    const doc = read('docs/captain.md');
    for (const t of TEMPLATES) {
      expect(fs.existsSync(path.join(ROOT, 'captain', 'templates', t)), t).toBe(true);
      expect(skill.includes('captain/templates/' + t) || doc.includes('captain/templates/' + t), t + ' is referenced').toBe(true);
    }
    const digest = read('captain/templates/DIGEST.md');
    for (const h of ['## Needs you', '## New', '## In progress']) expect(digest).toContain(h);
    const report = read('captain/templates/report.md');
    for (const h of ['## Outcome', '## PR', '## Needs', '## Cost', '## Lesson', '## Approvals']) expect(report).toContain(h);
    expect(read('captain/templates/READY.md')).toContain('SHIP_RECEIPT: pr=<n> head=<sha12>');
    expect(read('captain/templates/slot-call.md')).toContain('STAMP_VERSION=<X>');
    expect(read('captain/templates/flaky-ledger.md')).toMatch(/## Open[\s\S]*## Fixed[\s\S]*## Won't fix/);
    const crew = read('captain/templates/CREW.md');
    expect(crew).toMatch(/^24\. /m);
    expect(crew).not.toMatch(/^25\. /m);
    for (let n = 1; n <= 24; n++) expect(crew, 'rule ' + n + ' names its home').toMatch(new RegExp('^' + n + '\\. \\*\\*[^]*?Home:', 'm'));
    for (let n = 1; n <= 24; n++) expect(doc, 'docs/captain.md maps rule ' + n).toMatch(new RegExp('^\\| ' + n + ' \\| ', 'm'));
    for (const h of ['## Lane discipline', '## Plan before build', '## Contributions from outside the crew']) expect(doc).toContain(h);
    expect(doc).toMatch(/## Plan before build[^]*?reports `APPROVED`[^]*?## Contributions from outside the crew/);
    const brief = read('captain/templates/brief.md');
    expect(brief).toContain('Plan: required | approved: <autoplan run dir, or its checkpoint dir> | exempt: <reason');
    expect(brief).toContain('gstack-autoplan answer --out <run dir> --gate-rev <n> --reply <tokens>');
    expect(brief).toMatch(/^1\. Plan[^]*?^2\. Build after the word[^]*?^3\. Ship[^]*?^Done when:/m);
    expect(brief).toContain('gstack-approvals import --autoplan');
    expect(flat).toContain('**Plan before build.**');
    const capySkill = read('capy/skill/gstack/SKILL.md');
    expect(capySkill).toMatch(/^## Plan, approve, ship$/m);
    expect(capySkill).toMatch(/## Plan, approve, ship[^]*?reports `APPROVED`[^]*?Exempt from the plan step[^]*?## Working under a Captain/);
    expect(capySkill).not.toMatch(/## Plan, approve, ship[^]*?\]\((?:\.\.\/)?docs\//);
    expect(read('capy/skill/gstack/captain.md')).toContain('"Plan, approve, ship" section of SKILL.md');
    expect(read('captain/templates/plan-ask.md')).toContain('**do it**');
    expect(read('captain/templates/plan-ask.md')).toContain('gstack-approvals import --autoplan');
    expect(read('captain/templates/automation-flaky-pass.md')).toContain('never merge');
  });

  test('every copy of the plan-first exemptions names the two fix exemptions and the eng-only plan for every other fix', () => {
    for (const rel of ['docs/captain.md', 'captain/SKILL.md', 'captain/templates/CREW.md', 'capy/skill/gstack/SKILL.md']) {
      const text = read(rel).replace(/\s+/g, ' ');
      expect(text, rel).toMatch(/S1 emergenc(?:y|ies) \(a? ?broken install or upgrade, a? ?red main, a security bug\)/);
      expect(text, rel).toMatch(/already[- ]diagnosed,? (?:and )?audited problem list|problem list that was already diagnosed and audited/);
      expect(text, rel).toContain('one-round, eng-only plan');
    }
    expect(read('docs/captain.md')).toContain('gstack-autoplan close --out <run dir> --phase ceo --deferred');
    expect(read('captain/templates/brief.md').replace(/\s+/g, ' ')).toContain('gstack-autoplan close --out <run dir> --phase ceo --deferred');
  });

  test('is generic: parameters, not one crew\'s codes, names or repository', () => {
    const files = ['captain/SKILL.md.tmpl', 'docs/captain.md', ...TEMPLATES.map(t => 'captain/templates/' + t)];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/\b(?:GSTA|GBRA)-\d+\b/);
      expect(text, f).not.toMatch(/\bGarry\b/);
      expect(text, f).not.toMatch(/garrytan\/gstack/);
    }
    for (const p of ['REPO', 'BASE', 'REQUIRED_CHECKS', 'FULL_GATE_CHECK', 'MERGE_METHOD', 'STAMP_FILES', 'KNOWN_INFRA_FLAKES']) {
      expect(read('captain/templates/CREW.md'), p).toContain(p);
      expect(skill, p).toContain(p);
    }
  });

  test('docs/captain.md links resolve and the skill is registered where skills are listed', () => {
    const doc = read('docs/captain.md');
    const links = [...doc.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l));
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) expect(fs.existsSync(path.resolve(ROOT, 'docs', l)), l).toBe(true);
    for (const f of ['README.md', 'AGENTS.md', 'docs/skills.md', 'SKILL.md.tmpl', 'docs/PROJECT_STRUCTURE.md']) expect(read(f), f).toMatch(/\/captain\b/);
    expect(read('README.md')).toContain('docs/captain.md');
  });
});
