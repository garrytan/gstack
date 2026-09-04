import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard for #2440 (which itself regressed the #497 fix).
//
// Claude Code v2.1.198 made subagents run in the BACKGROUND by default.
// Guidance written before that ("do NOT use run_in_background") stopped
// producing a foreground run — the review army and autoplan dual-voice
// steps silently launched specialists in the background and merged before
// they completed. The only guidance that works post-2.1.198 is an explicit
// `run_in_background: false` on the Agent call.
//
// This tripwire pins the corrected phrasing in the generated skill output
// and fails if the inverted form ever comes back through a template or
// resolver edit.

const ROOT = path.resolve(import.meta.dir, '..');

// review's specialist-dispatch guidance lives in its carved Review Army section
// (Step 4.5 moved out of the skeleton), so the pin follows it there. Same for
// autoplan: the dual-voice dispatch (Phase 1 override rules) lives in its
// carved CEO-phase section.
//
// Third recurrence (#497 → #2440 → /ship Step 18): the four ship dispatch
// sections (Steps 7/8/10/18) never carried the flag and were never pinned, so
// a backgrounded doc-sync dispatch stranded the ship run waiting on LAST-line
// JSON that never came. Every synchronous dispatch carrier is pinned here now;
// add new dispatch sites to this list in the same commit that creates them.
const GENERATED_WITH_GUIDANCE = [
  'review/sections/review-army.md',
  'autoplan/sections/ceo-phase.md',
  'ship/sections/review-army.md',
  'ship/sections/pr-body.md',
  'ship/sections/test-coverage.md',
  'ship/sections/plan-completion.md',
  'ship/sections/greptile.md',
  // Sweep carriers (v1.79): every remaining synchronous Agent-dispatch site.
  'autoplan/sections/design-phase.md',
  'autoplan/sections/eng-phase.md',
  'autoplan/sections/dx-phase.md',
  'cso/SKILL.md',
  'design-consultation/SKILL.md',
  'design-review/SKILL.md',
  'design-shotgun/SKILL.md',
  'document-release/sections/release-body.md',
  'office-hours/SKILL.md',
  'office-hours/sections/design-and-handoff.md',
  'plan-ceo-review/SKILL.md',
  'plan-ceo-review/sections/review-sections.md',
  'plan-design-review/SKILL.md',
  'plan-devex-review/sections/review-sections.md',
  'plan-eng-review/sections/review-sections.md',
  'review/sections/adversarial.md',
  'ship/sections/adversarial.md',
];

// The inverted, post-2.1.198-inert phrasings. Checked across every generated
// SKILL.md so the regression can't migrate to another skill unnoticed.
const INVERTED = /do not use\s+`?run_in_background`?/i;

function allGeneratedSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = path.join(ROOT, entry.name, 'SKILL.md');
    if (fs.existsSync(p)) out.push(p);
    // Generated on-demand section files (e.g. ship/sections/review-army.md)
    // carry the same resolver output as SKILL.md bodies — scan them too.
    const sections = path.join(ROOT, entry.name, 'sections');
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) {
        if (f.endsWith('.md')) out.push(path.join(sections, f));
      }
    }
  }
  const rootSkill = path.join(ROOT, 'SKILL.md');
  if (fs.existsSync(rootSkill)) out.push(rootSkill);
  return out;
}

describe('run_in_background guidance (#2440)', () => {
  test('foreground-required skills instruct run_in_background: false explicitly', () => {
    for (const rel of GENERATED_WITH_GUIDANCE) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).toContain('run_in_background: false');
    }
  });

  // Third recurrence (#497 → #2440 → /ship Step 18): a backgrounded doc-sync
  // dispatch stranded the ship run. Pin the deadline/recovery branch and the
  // docs-sync scope guard in both the generated section and its template, so
  // neither a template edit nor a stale regen can drop them silently.
  const PR_BODY_SITES = ['ship/sections/pr-body.md', 'ship/sections/pr-body.md.tmpl'];
  test('ship pr-body carries the doc-sync deadline recovery + scope guard', () => {
    for (const rel of PR_BODY_SITES) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).toContain('document-release did not complete');
      expect(content).toContain('Scope guard — docs sync ONLY');
    }
  });

  // The spawned-dispatch contract is as regression-prone as the flag — this
  // class regressed twice via unpinned prose. Pin the document-release
  // contract, the Step 8.4d spawned note, and the resolver-side Codex
  // doc-review skip in both generated output and templates.
  const CONTRACT_PINS: Array<[string[], string]> = [
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'When dispatched as a subagent'],
    [
      ['document-release/sections/release-body.md', 'document-release/sections/release-body.md.tmpl'],
      'A spawned run must never change VERSION',
    ],
    [['document-release/sections/release-body.md'], 'Spawned-session skip'],
    // Anti-injection trigger + invariant carve-out — the two clauses whose
    // deletion would silently reopen the prompt-injection / silent-VERSION
    // holes while the 'When dispatched' heading pin stays green.
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'NEVER trigger it on their own'],
    // (short form — the sentence wraps across template lines; toContain is literal)
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'The NEVER-do invariants below do'],
  ];
  test('document-release carries the spawned-dispatch contract', () => {
    for (const [sites, phrase] of CONTRACT_PINS) {
      for (const rel of sites) {
        const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
        expect(content).toContain(phrase);
      }
    }
  });

  // Structural scanner (4th-recurrence net): GENERATED_WITH_GUIDANCE is a
  // hand-enumerated list — the exact mechanism that missed three recurrences
  // (#497 → #2440 → /ship Step 18, each a NEW dispatch site outside the
  // pinned set). Any generated file that carries an Agent-dispatch imperative
  // (or the inert "(foreground)" prose shape that #2440 proved insufficient)
  // must either state the flag or hold a reasoned exemption below. Same
  // pattern as the egress-receipt new-sink scanner.
  const DISPATCH_IMPERATIVE =
    /(?:via|using) the Agent tool|dispatch(?:es)? (?:a|an|the|one|each|it as a)[^.\n]{0,60}subagent|\(foreground[^)]*\)|foreground Agent tool/i;
  // Reasoned exemptions: files where the match is a reference to a dispatch
  // that lives (flag and all) in another file, not a dispatch spec itself.
  const BACKGROUND_OK: Record<string, string> = {
    'ship/SKILL.md':
      'skeleton anchors reference the Step 18 dispatch by name (carve-guards mustStayInSkeleton); the dispatch spec + flag live in sections/pr-body.md',
  };
  test('structural scanner: every generated dispatch imperative carries the flag', () => {
    for (const file of allGeneratedSkillFiles()) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (BACKGROUND_OK[rel]) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (DISPATCH_IMPERATIVE.test(content) && !content.includes('run_in_background: false')) {
        throw new Error(
          `${rel} contains an Agent-dispatch imperative (or bare "foreground" prose) but never states ` +
          '`run_in_background: false` — pin the flag at the dispatch site or add a reasoned BACKGROUND_OK ' +
          'exemption (see #497/#2440: prose without the explicit flag is inert since Claude Code v2.1.198).',
        );
      }
    }
  });

  test('the inverted "do NOT use run_in_background" phrasing never comes back', () => {
    for (const file of allGeneratedSkillFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      if (INVERTED.test(content)) {
        throw new Error(
          `${path.relative(ROOT, file)} contains the inverted run_in_background guidance — ` +
          'since Claude Code v2.1.198 subagents default to background, so "do not use" is inert; ' +
          'instruct `run_in_background: false` instead (see #2440).',
        );
      }
    }
  });
});
