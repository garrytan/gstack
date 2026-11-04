/**
 * /modernize: an aging pull request gets a disposition before any push.
 *
 * Pins the three verdicts and what each permits, the hard rules (no push and
 * no close before the verdict; the skill never closes a PR; a clean rebase is
 * not currency; age and sunk cost are not evidence), the range-diff proof and
 * the lease pinned to the observed head, and the catalog rows a new skill owes.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmpl = read('modernize/SKILL.md.tmpl');
const skill = read('modernize/SKILL.md');
const flat = skill.replace(/\s+/g, ' ');

describe('/modernize skill', () => {
  test('frontmatter: tier 2, sensitive, a Codex default prompt and the four triggers', () => {
    expect(tmpl.startsWith('---\nname: modernize\npreamble-tier: 2\n')).toBe(true);
    expect(tmpl).toMatch(/^sensitive: true$/m);
    expect(tmpl).toMatch(/^codex_default_prompt: "Use \$gstack-modernize to /m);
    for (const t of ['modernize this pr', 'rebase this old pr', 'revive this branch', 'is this pr still worth landing']) {
      expect(tmpl, t).toContain('  - ' + t + '\n');
    }
    expect(skill.slice(0, skill.indexOf('\n---', 4))).not.toContain('codex_default_prompt');
  });

  test('the disposition table names the three verdicts and comes before any push', () => {
    for (const v of ['**MODERNIZE**', '**REWORK**', '**CLOSE**']) expect(skill).toContain('| ' + v + ' |');
    expect(flat).toContain('The disposition comes first. No rebase is pushed, and no PR is closed, until the verdict below is written and shown.');
    expect(skill.indexOf('## Step 3: The disposition')).toBeLessThan(skill.indexOf('## Step 4 (MODERNIZE only)'));
    expect(skill.indexOf('## Step 4 (MODERNIZE only)')).toBeLessThan(skill.indexOf('## Step 5 (MODERNIZE only)'));
    expect(flat).toContain('STOP and ask (AskUserQuestion) before any push or any closing comment');
    expect(flat).toContain('If the session is unattended, the verdict and its evidence are the handoff and nothing is pushed.');
  });

  test('never closes a PR on its own', () => {
    expect(flat).toContain('You never close a PR.');
    expect(flat).toContain('Without explicit permission in this session, the PR stays open.');
    expect(flat).toContain('The PR stays open until someone with the authority says so.');
    expect(skill).not.toMatch(/gh pr close/);
  });

  test('a clean rebase is not currency and age is not evidence', () => {
    expect(flat).toContain('Textual cleanliness is not currency.');
    expect(flat).toContain('Age is not evidence either way.');
    expect(flat).toContain('Effort already spent on it is not a reason to keep it.');
    expect(flat).toContain('conceptual: did the base change the thing the PR relies on, even in files the PR never touches?');
  });

  test('the rebase is proved with git range-diff and pushed with a lease pinned to the observed head', () => {
    expect(skill).toContain('git range-diff "$MERGE_BASE..$OLD_HEAD" "origin/$BASE..HEAD"');
    expect(flat).toContain('A hunk you cannot explain is a lost intent: stop and look again.');
    expect(skill).toContain('OBSERVED=$(gh pr view "$PR" --json headRefOid -q .headRefOid)');
    expect(skill).toContain('git push "--force-with-lease=$HEAD_BRANCH:$OBSERVED" origin "HEAD:$HEAD_BRANCH"');
    expect(flat).toContain('`--force` is never used');
    expect(skill).not.toMatch(/git push (-f|--force)(?!-with-lease)/);
    expect(flat).toContain("Keep the author's commits as theirs; your fixes are separate commits on top.");
  });

  test('/careful already rates the lease push MEDIUM, so no new HIGH pattern was added', () => {
    expect(read('careful/SKILL.md.tmpl')).toContain('`--force-with-lease` is never HIGH');
  });

  test('is listed where every skill is listed', () => {
    expect(read('README.md')).toMatch(/^\| `\/modernize` \| /m);
    expect(read('AGENTS.md')).toMatch(/^\| `\/modernize` \| /m);
    expect(read('docs/skills.md')).toMatch(/^\| \[`\/modernize`\]\(#modernize\) \| /m);
    expect(read('docs/skills.md')).toContain('## `/modernize`');
    expect(read('SKILL.md.tmpl')).toContain('type `/modernize`');
    expect(read('gstack/llms.txt')).toContain('[/modernize](modernize/SKILL.md)');
    expect(read('docs/PROJECT_STRUCTURE.md')).toMatch(/^├── modernize\//m);
    expect(read('lib/doctor-components.ts')).toMatch(/^  modernize: CLAUDE_ONLY,$/m);
  });
});
