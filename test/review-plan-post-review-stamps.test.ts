/**
 * GST-1702 (GBRA-341, gbrain #8705): after an owner-granted fix-check, only release stamps and a docs-audit edit followed (VERSION,
 * package.json, .claude-plugin/plugin.json, a BOOTSTRAP stamp comment, the CHANGELOG re-heading, a behavior-change row's
 * since: 'TBD' moved to the version under stamp_patterns and stamp_placeholders, and a docs line). gstack-ship-receipt write
 * carries the targeted record across that delta (GST-1689's docsChangeSince), and gstack-review-plan --post-review --last
 * fix-check classifies the same delta with the same classifier: it is no gate-class edit, so the plan is done, or targeted when
 * the docs rule says a claim needs the read. Any non-stamp line in a stamp file still counts as an edit and stops.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { checkoutTree } from '../lib/review-brief';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(180_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const POLICY = {
  ...BASE_POLICY,
  min_gstack_version: '1.94.16.0',
  stamp_paths: [],
  stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md', '.claude-plugin/plugin.json', 'BOOTSTRAP_FOR_AGENTS.md', 'src/core/behavior-change-notice.ts'],
  stamp_patterns: ['"version": "{version}"', "since: '{version}'", '<!-- gbrain-template-stamp: {version} -->'],
  stamp_placeholders: ['TBD'],
};
const plugin = (v: string, extra = '') => `{\n  "name": "fixture",\n  "version": "${v}"${extra}\n}\n`;
const bootstrap = (v: string, line = '') => `# Bootstrap\n\n<!-- gbrain-template-stamp: ${v} -->\n\nRun setup first.\n${line}`;
const NOTICE_BASE = "export const NOTICES = [\n  { id: 'old', since: '1.2.3.0' },\n];\n";

const commit = (repo: FixtureRepo, files: Record<string, string>, msg: string) => {
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(repo.work, f), t); }
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
  return repo.git('rev-parse', 'HEAD');
};
const read = (repo: FixtureRepo, f: string) => fs.readFileSync(path.join(repo.work, f), 'utf8');

/**
 * A branch with the GBRA-341 shape up to the fix-check: a money-class change (or a plain code change with money false), a
 * behavior-change row at since: 'TBD' and an [Unreleased] CHANGELOG entry, then the fix-check's commit, which the targeted
 * reader read clean through the real dispatch steps.
 */
function fixChecked(money = true): { repo: FixtureRepo; fc: string; record: string } {
  const repo = makeFixtureRepo({ prefix: 'gst1702-', policy: POLICY });
  repos.push(repo);
  commit(repo, { '.claude-plugin/plugin.json': plugin('1.2.3.0'), 'BOOTSTRAP_FOR_AGENTS.md': bootstrap('1.2.3.0'), 'src/core/behavior-change-notice.ts': NOTICE_BASE }, 'manifests');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', '-b', 'feat');
  const changelog = read(repo, 'CHANGELOG.md').replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- Adds the new notice.\n');
  const [file, code] = money ? ['src/charge.ts', 'export const spend_cap_usd = 5;\n'] : ['src/greet.ts', 'export const greeting = "hi";\n'];
  commit(repo, { [file]: code, 'src/core/behavior-change-notice.ts': NOTICE_BASE.replace('];', "  { id: 'new', since: 'TBD' },\n];"), 'CHANGELOG.md': changelog }, 'feature');
  const fc = commit(repo, { [file]: code + 'export const retries = 2;\n' }, 'granted fix-check fix');
  const out = path.join(repo.root, 'read');
  const ledger = path.join(out, 'review-ledger.jsonl');
  const record = path.join(repo.root, 'targeted.json');
  if (!money) return { repo, fc, record };
  const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--diff-base', repo.git('merge-base', 'origin/main', 'HEAD'), '--out', out]);
  expect(render.status, render.err).toBe(0);
  expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', ledger, '--role', 'targeted', '--sent', /file=(\S+)/.exec(render.out)![1]!]).status).toBe(0);
  fs.writeFileSync(path.join(out, 'targeted.out'), `REVIEWED_TREE: ${checkoutTree(repo.work)}\nNO FINDINGS\n`);
  expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', ledger, '--role', 'targeted', '--output', path.join(out, 'targeted.out'), '--merged', path.join(out, 'merged.jsonl')]).status).toBe(0);
  fs.writeFileSync(path.join(out, 'judged.jsonl'), '');
  expect(runBin(repo, 'gstack-review-dispatch', ['judge', '--ledger', ledger, '--merged', path.join(out, 'merged.jsonl'), '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
  expect(runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger, '--targeted-out', record]).out).toContain('TARGETED_RECORD: classes=money status=done findings=0 ');
  return { repo, fc, record };
}

/** /ship's release stamp to 1.2.4.0, committed: VERSION, package.json, plugin.json, the BOOTSTRAP comment, the TBD row and the CHANGELOG heading. */
function stamp(repo: FixtureRepo, edits: { plugin?: string; notice?: string; bootstrap?: string } = {}): void {
  commit(repo, {
    VERSION: '1.2.4.0\n',
    'package.json': read(repo, 'package.json').replace('"version": "1.2.3"', '"version": "1.2.4"'),
    '.claude-plugin/plugin.json': plugin('1.2.4.0', edits.plugin),
    'BOOTSTRAP_FOR_AGENTS.md': bootstrap('1.2.4.0', edits.bootstrap),
    'src/core/behavior-change-notice.ts': read(repo, 'src/core/behavior-change-notice.ts').replace("since: 'TBD'", "since: '1.2.4.0'") + (edits.notice ?? ''),
    'CHANGELOG.md': read(repo, 'CHANGELOG.md').replace('## [Unreleased]', '## [1.2.4.0] - 2026-11-06'),
  }, 'release stamp 1.2.4.0');
}
const docsAudit = (repo: FixtureRepo, line = 'Read the overview first, then the walkthrough.') => commit(repo, { 'docs/run-order.md': `# Run order\n\n${line}\n` }, 'Step 14.5 docs audit');

const write = (repo: FixtureRepo, record: string) => runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', '--review-targeted', `@${record}`, '--json']);
/** GBRA-341's invocation: Step 16's Step 9 after the granted fix-check. */
const postReview = (repo: FixtureRepo, fc: string) => runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--post-review', '--pass', '1', '--last', 'fix-check', '--fix-checks', '1', '--range-base', fc]);
const dispatches = (out: string) => out.split('\n').filter(l => l.startsWith('DISPATCH: '));

describe('GST-1702: release stamps and a docs-audit edit after the last fix-check are no gate-class edit', () => {
  // Value: protects=GBRA-341's delta (manifest stamps, a BOOTSTRAP stamp comment, a since: 'TBD' row moved to the version in a
  //   code file, the CHANGELOG re-heading and a plain docs line) after the fix-check the targeted reader read: write binds the
  //   record and the post-review plan is done; fails_when=write refuses RECEIPT_INVALID or the plan stops on 'the fix-check edited
  //   a gate-class path' (GBRA-341 needed a second owner grant and a fix-check on a 39-line stamp delta);
  //   seam=gstack-ship-receipt write --review-targeted and gstack-review-plan --post-review --last fix-check
  test('stamps plus a plain docs-audit edit: write binds the record and the post-review plan is done', () => {
    const { repo, fc, record } = fixChecked();
    stamp(repo);
    docsAudit(repo);
    const w = write(repo, record);
    expect(w.status, w.err).toBe(EXIT.ok);
    expect(JSON.parse(w.out).review_targeted).toMatchObject({ classes: ['money'], status: 'done' });
    const p = postReview(repo, fc);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: done');
    expect(p.out).not.toContain('edited a gate-class path');
    expect(p.out).toContain(`the edits after the last fix-check ${fc.slice(0, 12)} are plain docs and release stamps`);
    expect(dispatches(p.out)).toEqual([]);
  });

  // Value: protects=stamps alone after the fix-check plan done too; fails_when=an empty docs remainder counts as an edit;
  //   seam=gstack-review-plan --post-review
  test('stamps alone: the post-review plan is done', () => {
    const { repo, fc } = fixChecked();
    stamp(repo);
    const p = postReview(repo, fc);
    expect(p.out).toContain('NEXT: done');
    expect(p.out).toContain(`the edits after the last fix-check ${fc.slice(0, 12)} are release stamps`);
    expect(dispatches(p.out)).toEqual([]);
  });

  // Value: protects=a stamp match is line-exact: a real field added to plugin.json, or a code line added to the behavior-change
  //   file, beside the stamps still stops for the owner; fails_when=a stamp file's other lines ride the stamp;
  //   seam=gstack-review-plan --post-review
  test('a non-stamp line in plugin.json or in the behavior-change file still stops', () => {
    for (const edits of [{ plugin: ',\n  "main": "dist/index.js"' }, { notice: 'export const NOTICE_LIMIT = 3;\n' }]) {
      const { repo, fc } = fixChecked();
      stamp(repo, edits);
      docsAudit(repo);
      const p = postReview(repo, fc);
      expect(p.status, p.err).toBe(0);
      expect(p.out).toContain("NEXT: stop (edits after the review bound (Step 16 stage 2.1) plan as a fix to a gate-class path, never a note: the fix-check edited a gate-class path");
    }
  });

  // Value: protects=on a money-class PR a docs-audit line with a numeric claim after the fix-check still plans the one targeted
  //   reader on HEAD (and write still refuses the record); fails_when=the carry lets a claim through; seam=gstack-review-plan
  //   --post-review and gstack-ship-receipt write
  test('a docs edit with a numeric claim on a money-class PR plans the targeted read', () => {
    const { repo, fc, record } = fixChecked();
    stamp(repo);
    docsAudit(repo, 'Each run now finishes 40% faster.');
    expect(write(repo, record).status).toBe(EXIT.fail);
    const p = postReview(repo, fc);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: targeted');
    expect(dispatches(p.out)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(p.out).toContain(`TARGETED_DELTA: range_base=${fc} paths=docs/run-order.md classes=money`);
  });

  // Value: protects=a numeric claim on a PR with no targeted class needs no read: the plan is done; fails_when=the claim stops or
  //   dispatches a reader the docs rule does not ask for; seam=gstack-review-plan --post-review
  test('a docs edit with a numeric claim on a PR with no targeted class is done', () => {
    const { repo, fc } = fixChecked(false);
    stamp(repo);
    docsAudit(repo, 'Each run now finishes 40% faster.');
    const p = postReview(repo, fc);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: done');
    expect(dispatches(p.out)).toEqual([]);
  });

  // Value: protects=an executable file with a docs extension after the fix-check is code to the gate, not a docs-audit edit;
  //   fails_when=the carry reads the path name alone and plans done for an unreviewed script; seam=gstack-review-plan --post-review
  test('an executable docs-extension file after the fix-check still stops', () => {
    const { repo, fc } = fixChecked(false);
    stamp(repo);
    fs.mkdirSync(path.join(repo.work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'docs/task.md'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    repo.git('add', '-A'); repo.git('update-index', '--chmod=+x', 'docs/task.md'); repo.git('commit', '-q', '-m', 'Step 14.5 docs audit');
    const p = postReview(repo, fc);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: stop (edits after the review bound (Step 16 stage 2.1) plan as a fix to a gate-class path');
  });

  // Value: protects=a commit the gate scan tags after the fix-check (a [skip ci] message on a docs-audit commit) keeps the stop;
  //   fails_when=the carry drops the range's gate tag and plans done; seam=gstack-review-plan --post-review
  test('a docs-audit commit with [skip ci] after the fix-check still stops', () => {
    const { repo, fc } = fixChecked(false);
    stamp(repo);
    commit(repo, { 'docs/run-order.md': '# Run order\n\nRead the overview first.\n' }, 'Step 14.5 docs audit [skip ci]');
    const p = postReview(repo, fc);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: stop (edits after the review bound (Step 16 stage 2.1) plan as a fix to a gate-class path');
  });
});

/**
 * GST-1775 (GBRA-347, gbrain#8730): /ship Step 16 stage 2.1 inserted a Step 9 for edits after the review bound on a gate-class
 * diff. `gstack-review-plan --post-review --pass 2 --last full` printed NEXT: voices with the voices' DISPATCH lines, and Step 11's
 * `gstack-review-dispatch pass --voices` with the same plan flags printed PASS: none, so the voices the plan asked for could not run.
 */
function postReviewBranch(): { repo: FixtureRepo; flags: string[] } {
  const repo = makeFixtureRepo({ prefix: 'gst1775-voices-' });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'feat');
  const edit = (code: string, msg: string) => {
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src/charge.ts'), code);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
    return repo.git('rev-parse', 'HEAD');
  };
  const rangeBase = edit('export const spend_cap_usd = 5;\n', 'feature');
  edit('export const spend_cap_usd = 5;\nexport const retries = 2;\n', 'edit after the review bound');
  return { repo, flags: ['--gate-tagged', '1', '--post-review', '--pass', '2', '--last', 'full', '--range-base', rangeBase, '--pass1-depth', 'full'] };
}
const dispatchLines = (out: string) => out.split('\n').filter(l => l.startsWith('DISPATCH: ')).map(l => l.split(' ')[1]);

describe('GST-1775: a post-review NEXT: voices plan dispatches through pass --voices', () => {
  // Value: protects=Step 11 renders exactly the voices a NEXT: voices plan lists, so plan and dispatch agree;
  //   fails_when=pass --voices prints PASS: none for NEXT: voices, or renders a reader the plan does not list;
  //   seam=gstack-review-plan --post-review and gstack-review-dispatch pass --voices; no_claim=the readers' replies
  test('pass --voices builds the voices manifest the NEXT: voices plan names; without --voices it is still no reviewer pass', () => {
    const { repo, flags } = postReviewBranch();
    const plan = runBin(repo, 'gstack-review-plan', ['--base', 'main', ...flags]);
    expect(plan.status, plan.err).toBe(0);
    expect(plan.out).toContain('NEXT: voices');
    const planned = dispatchLines(plan.out);
    expect(planned).toEqual(['adversarial-native', 'outside-voice', 'targeted']);

    const out = path.join(repo.root, 'p2-voices');
    const pass = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p2-voices', '--voices', '--', ...flags]);
    expect(pass.status, pass.err).toBe(0);
    expect(pass.out).not.toContain('PASS: none');
    expect(pass.out).toMatch(/MANIFEST: file=\S+ pass=p2-voices readers=3 first=0 specialists=0 red-team=0 voices=3/);
    const m = JSON.parse(fs.readFileSync(pass.out.match(/MANIFEST: file=(\S+)/)![1]!, 'utf8'));
    expect(m.next).toBe('voices');
    expect(m.voices_only).toBe(true);
    expect(m.readers.map((r: any) => [r.role, r.stage]).sort()).toEqual(planned.map(r => [r, 'voices']).sort());

    const noVoices = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', path.join(repo.root, 'p3'), '--pass', 'p3', '--', ...flags]);
    expect(noVoices.status, noVoices.err).toBe(0);
    expect(noVoices.out).toContain('PASS: none next=voices');
  });
});
