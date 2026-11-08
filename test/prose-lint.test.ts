/**
 * gstack-prose-lint: the AI tells a regular expression can decide, over the
 * CHANGELOG entry and PR body /ship writes (absorbed from pstack's unslop,
 * rewritten; NOTICE.md). Positive and negative fixtures per rule, the two
 * selections (--unreleased, --base), the exit codes, and the template and
 * workflow wiring that calls it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addedOnly, lintProse, maskProse, renderProseLint, sectionsOnly, unreleasedBlock } from '../lib/prose-lint';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'prose-lint');
const BIN = path.join(ROOT, 'bin', 'gstack-prose-lint');
const run = (args: string[], cwd = ROOT) => {
  const r = spawnSync('bun', [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const rules = (text: string) => lintProse(text, 'x.md').map(f => f.rule);

describe('lintProse: each rule, positive and negative', () => {
  test('vocabulary flags the autopilot words and leaves plain prose alone', () => {
    expect(rules('This release showcases a vibrant, pivotal change that underscores our intricate work.')).toEqual(['vocabulary', 'vocabulary', 'vocabulary', 'vocabulary', 'vocabulary']);
    expect(rules('The lint reads the entry and names each line to rewrite.')).toEqual([]);
    expect(rules('Rotate the photo to landscape orientation; a leading underscore marks a private name.')).toEqual([]);
    expect(rules('They mapped the vendor landscape before choosing.')).toEqual(['vocabulary']);
  });

  test('not-just-but catches the contrast in both spellings', () => {
    expect(rules("It isn't just a linter, but a whole new way of writing.")).toEqual(['not-just-but']);
    expect(rules('This is not only faster but also smaller.')).toEqual(['not-just-but']);
    expect(rules('The lint is fast. It is also small.')).toEqual([]);
  });

  test('metaphor-noun names the plain word', () => {
    const f = lintProse('The queue is the substrate every lane builds on, and its north star is a green train.', 'x.md');
    expect(f.map(x => [x.rule, x.match, x.hint])).toEqual([
      ['metaphor-noun', 'substrate', 'say "base"'],
      ['metaphor-noun', 'north star', 'say "goal"'],
    ]);
    expect(rules('A smaller API with two exported names is easier to keep stable.')).toEqual([]);
    expect(rules('Shrink the API surface before the release.')).toEqual(['metaphor-noun']);
  });

  test("mid-sentence-colon flags a colon doing a conjunction's job and spares labels, lists and times", () => {
    expect(rules('If you come from other tools: instead of reading every entry by hand, run one command.')).toEqual(['mid-sentence-colon']);
    expect(rules('- The classifier is conservative: a local lane that cannot prove its base is refused.')).toEqual(['mid-sentence-colon']);
    expect(rules('Fix: run the command again.')).toEqual([]);
    expect(rules('The gate reads three inputs: the head, the base and the receipt.')).toEqual([]);
    expect(rules('The run started at 12:30 and the following rules apply: no retries, no merges.')).toEqual([]);
    expect(rules('- **`gstack-post`**: the receipt is written first.')).toEqual([]);
    expect(lintProse(['The parser stops at the end of a line here', 'see note: something else happens now'].join('\n'), 'x.md')).toEqual([]);
  });

  test('inline-header-list flags a bold label that restates its line and spares a label that adds detail', () => {
    expect(rules('- **Performance:** Performance improved by 40% on the hot path.')).toEqual(['inline-header-list']);
    expect(rules('- **Performance.** The hot path is 40% faster because the parser short-circuits.')).toEqual([]);
    expect(rules('- **`bin/gstack-prose-lint`**: `--gate` exits 1 on a finding.')).toEqual([]);
  });

  test('arrow flags symbol-speak and keeps measurements and the before → after heading', () => {
    expect(rules('Bad input → exit 2, no write.')).toEqual(['arrow']);
    expect(rules('policy -> warn')).toEqual(['arrow']);
    expect(rules('The ratio moved 1.6740 → 1.7010 (measured 323,295 / 187,706) and the pins 250 -> 500.')).toEqual([]);
    expect(rules('### Before → after')).toEqual([]);
    expect(rules('Rename `old` → `new` in one pass.')).toEqual([]);
  });

  test('dropped-article flags a bare noun opening a sentence and spares one with its article', () => {
    expect(rules('Gate refuses stale receipt and exits.')).toEqual(['dropped-article']);
    expect(rules('- Gate refuses the head when the receipt is stale.')).toEqual(['dropped-article']);
    expect(rules('The gate refuses a stale receipt and exits.')).toEqual([]);
    expect(rules('Garry approves the plan; Bun runs the tests.')).toEqual([]);
    expect(rules('Parser errors are rare.')).toEqual([]);
    for (const s of ['Test runs now finish faster.', 'Error logs are rotated daily.', 'Tool calls take a while.', 'Merge commits stay.']) expect(rules(s), s).toEqual([]);
  });

  test('fenced code, inline code, URLs and HTML comments are never scanned, and line numbers hold', () => {
    const text = [
      '# Title',
      '',
      '```bash',
      'echo "not just X, but Y" → substrate',
      '```',
      'See https://example.com/vibrant-tapestry and `a pivotal → change`. <!-- showcases -->',
      'Gate refuses stale receipt.',
    ].join('\n');
    const f = lintProse(text, 'x.md');
    expect(f.map(x => [x.rule, x.line])).toEqual([['dropped-article', 7]]);
    const { masked, unclosed } = maskProse(text);
    expect(unclosed).toBeNull();
    expect(masked.split('\n').length).toBe(text.split('\n').length);
    expect(masked).not.toContain('substrate');
    expect(masked).not.toContain('vibrant');
  });

  // Value: protects=someone else's words are never the author's finding (the Capy `## Why` quotes the person's problem verbatim), and a double-backtick code span holding a single backtick is one code span; fails_when=a quoted tell gates the body, or the inner backtick splits the span and leaks its text; why_new=new masking; seam=none; no_claim=a quote spanning lines is read
  test('quoted words and multi-backtick code spans are masked', () => {
    expect(rules('"Please enhance the landscape view." The fix names the view.')).toEqual([]);
    expect(rules('“Please enhance the landscape view.” The fix names the view.')).toEqual([]);
    expect(rules('He asked to enhance the view.')).toEqual(['vocabulary']);
    expect(rules('Use `` `name` showcases the result `` as the span.')).toEqual([]);
    expect(rules('Rename --foo -> --bar in the flags.')).toEqual(['arrow']);
  });

  // Value: protects=a fence or comment left open is a finding instead of a silent mask of everything after it, and a fence closes only on a bare fence line; fails_when=an unclosed block reads as clean, or a fence line with an info string closes the block early; why_new=the fence test above pinned the fail-open behaviour; seam=none; no_claim=an indented code block is not a fence
  test('an unclosed fence or comment is a finding at its opening line, and an info string never closes a fence', () => {
    expect(lintProse(['Plain.', '```', 'showcasing a vibrant release'].join('\n'), 'x.md').map(f => [f.rule, f.line])).toEqual([['unclosed-block', 2]]);
    expect(lintProse(['Plain. <!-- oops', 'It is crucial and pivotal.'].join('\n'), 'x.md').map(f => [f.rule, f.line])).toEqual([['unclosed-block', 1]]);
    expect(lintProse(['```', 'foo', '```js', 'crucial', '```', 'done, and vibrant.'].join('\n'), 'x.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 6]]);
  });

  // Value: protects=a longer fence is closed only by a fence at least as long, so a quoted template in a PR body draft is never linted; fails_when=a shorter inner fence or a tilde fence closes the block early, or an unclosed fence stops masking; why_new=the case above uses one three-backtick fence; seam=none; no_claim=other fence syntaxes (indented code blocks) are not masked
  test('a longer fence holds a shorter inner fence, a tilde fence masks too, and an unclosed fence masks to the end', () => {
    const text = [
      '````md',
      '```',
      'Showcasing a vibrant release.',
      '````',
      'Gate refuses stale receipt.',
      '~~~',
      'Showcasing a vibrant release.',
      '~~~',
      '```',
      'Showcasing a vibrant release.',
    ].join('\n');
    expect(lintProse(text, 'x.md').map(f => [f.rule, f.line])).toEqual([['dropped-article', 5], ['unclosed-block', 9]]);
  });

  test('findings are sorted by line and the render ends in the trailer', () => {
    const text = renderProseLint({ findings: lintProse('Showcasing a vibrant release.\n\nParser rejects it.', 'f.md'), scanned: ['f.md'], empty: [] });
    expect(text.split('\n').filter(Boolean)).toEqual([
      'PROSE: f.md:1 vocabulary "Showcasing" (use the plain word)',
      'PROSE: f.md:1 vocabulary "vibrant" (use the plain word)',
      'PROSE: f.md:3 dropped-article "Parser rejects" (start with "the" or "a")',
      'PROSE_LINT: found=3 files=1',
    ]);
    expect(renderProseLint({ findings: [], scanned: ['a'], empty: [] })).toBe('PROSE_LINT: ok files=1\n');
    expect(renderProseLint({ findings: [], scanned: [], empty: ['a'] })).toBe('PROSE_LINT: none files=0 nothing-to-scan=1\n');
  });
});

describe('selections', () => {
  // Value: protects=the Step 19 compose gate reads only the sections an author writes, so a verbatim tool section (a review line such as "Problem → what you did") can never dead-end /ship; fails_when=a tool section's text is linted, an author section is skipped, heading case is significant, or a body with none of the headings reads as scanned; why_new=new selection; seam=none; no_claim=the compose block's heading list itself is pinned by the wiring test
  test('sectionsOnly keeps only the named ## sections, line numbers intact, and is null when none is present', () => {
    const body = [
      '## Summary', 'The parser showcases a vibrant result.', '',
      '## Pre-Landing Review', '[AUTO-FIXED] [x.ts:1] Problem → what you did', '',
      '## blast radius', 'Touches the compose block only.', 'Caller -> callee is the only arrow here.',
      '## Test plan', '- [x] bun test → 20 pass',
    ].join('\n');
    const picked = sectionsOnly(body, ['Summary', 'Blast radius'])!;
    expect(picked.split('\n')).toHaveLength(body.split('\n').length);
    expect(lintProse(picked, 'b.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 2], ['vocabulary', 2], ['arrow', 9]]);
    expect(sectionsOnly(body, ['Why'])).toBeNull();
    const fenced = ['## Summary', 'Fine.', '', '## Pre-Landing Review', '```codex-review', '## Summary', 'The parser showcases a vibrant result.', '```', '', '## Blast radius', '```', '## Why', 'a fenced heading showcases nothing', '```', 'but this vibrant line is read.'].join('\n');
    expect(lintProse(sectionsOnly(fenced, ['Summary', 'Blast radius'])!, 'b.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 15]]);
    const gated = run([path.join(FIXTURES, 'slopped-changelog.md'), '--sections', '[1.0.0] - 2026-10-01', '--gate']);
    expect(gated.code).toBe(1);
    expect(gated.out).toMatch(/^PROSE: \S+slopped-changelog\.md:16 /m);
    expect(gated.out).not.toMatch(/^PROSE: \S+slopped-changelog\.md:(5|8|9|10) /m);
    expect(run([path.join(FIXTURES, 'clean-changelog.md'), '--sections', 'Nope']).out).toContain('PROSE_LINT: none');
    const lost = run([path.join(FIXTURES, 'clean-changelog.md'), '--sections', 'Nope', '--gate']);
    expect(lost.code).toBe(2);
    expect(lost.err).toContain('nothing would be gated');
    const commented = ['## Summary', 'Fine.', '<!--', '## Test plan', '-->', 'Still the summary, showcasing a vibrant tell.'].join('\n');
    expect(lintProse(sectionsOnly(commented, ['Summary'])!, 'b.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 6], ['vocabulary', 6]]);
  });

  // Value: protects=an HTML comment that spans lines is never read, as the header promises; fails_when=the second line of a comment, or the text before its closing marker, produces a finding, or prose after the close is skipped; why_new=the mask test above covers one-line comments only; seam=none; no_claim=none beyond protects
  test('a multi-line HTML comment is masked through its closing marker and prose after it is read', () => {
    const text = ['Plain start. <!-- a vibrant', 'multi-line crucial comment', 'still pivotal --> The parser showcases it.', 'Showcasing a vibrant end.'].join('\n');
    expect(lintProse(text, 'x.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 3], ['vocabulary', 4], ['vocabulary', 4]]);
    const quoted = ['Use `<!--` to open a comment, or see https://example.com/<!--', 'The parser showcases a vibrant result.'].join('\n');
    expect(lintProse(quoted, 'x.md').map(f => [f.rule, f.line])).toEqual([['vocabulary', 2], ['vocabulary', 2]]);
  });

  test('unreleasedBlock returns the block with its heading line, or null', () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'slopped-changelog.md'), 'utf8');
    const block = unreleasedBlock(text)!;
    expect(block.line).toBe(3);
    expect(block.text).toStartWith('## [Unreleased]');
    expect(block.text).not.toContain('[1.0.0]');
    expect(unreleasedBlock('# Changelog\n\n## [1.0.0] - 2026-01-01\n- x\n')).toBeNull();
  });

  // Value: protects=the Step 13 call (--base <ref> --gate): exit 1 on a tell the branch added, none for an older one, exit 2 and no trailer on an unresolvable ref; fails_when=a bad ref or failed git diff reads as ok, --gate stops gating, or a ref with no merge base is not diffed directly; why_new=this test asserted only the none case and addedOnly's return values; seam=none; no_claim=origin/<base> resolution in a real clone (a temp repo with a local main stands in)
  test('addedOnly keeps only the lines the working tree added, with their line numbers, and reads an untracked file whole', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prose-lint-'));
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\nOld entry showcases a vibrant tapestry.\n');
      git('add', '.'); git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.1] - 2026-01-02\n\nGate refuses stale receipt → exit 3.\n\n## [1.0.0] - 2026-01-01\n\nOld entry showcases a vibrant tapestry.\n');
      const cwd = process.cwd();
      process.chdir(repo);
      try {
        const added = addedOnly('CHANGELOG.md', 'main')!;
        expect([...added.added!]).toEqual([3, 4, 5, 6]);
        expect(added.text.split('\n')[8]).toBe('Old entry showcases a vibrant tapestry.');
        const gated = run(['CHANGELOG.md', '--base', 'main', '--gate'], repo);
        expect(gated.code).toBe(1);
        expect(gated.out).toMatch(/^PROSE: CHANGELOG\.md:5 arrow /m);
        expect(gated.out).toMatch(/^PROSE: CHANGELOG\.md:5 dropped-article /m);
        expect(gated.out).not.toMatch(/^PROSE: CHANGELOG\.md:9 /m);
        expect(gated.err).toContain('PROSE_LINT_FOUND');
        fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n```\nold line\nit delves into a vibrant example\n```\nOld entry showcases a vibrant tapestry.\n');
        git('add', '.'); git('commit', '-q', '-m', 'base with a fence');
        git('checkout', '-q', 'main'); git('merge', '-q', '--ff-only', 'feature'); git('checkout', '-q', 'feature');
        fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n```\nold line\nit delves into a vibrant example\nadded line that showcases code\n```\nOld entry showcases a vibrant tapestry.\n');
        const fenced = run(['CHANGELOG.md', '--base', 'main', '--gate'], repo);
        expect(fenced.code).toBe(0);
        expect(fenced.out).toBe('PROSE_LINT: ok files=1\n');
        git('checkout', '-q', '--', 'CHANGELOG.md');
        fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.1] - 2026-01-02\n\nGate refuses stale receipt → exit 3.\n\n## [1.0.0] - 2026-01-01\n\n```\nold line\nit delves into a vibrant example\n```\nOld entry showcases a vibrant tapestry.\n');
        const badRef = run(['CHANGELOG.md', '--base', 'no-such-ref', '--gate'], repo);
        expect(badRef.code).toBe(2);
        expect(badRef.out).not.toContain('PROSE_LINT:');
        git('branch', 'orphan', git('commit-tree', git('write-tree'), '-m', 'unrelated history'));
        expect(() => git('merge-base', 'orphan', 'HEAD')).toThrow();
        expect([...addedOnly('CHANGELOG.md', 'orphan')!.added!]).toEqual([3, 4, 5, 6]);
        fs.writeFileSync(path.join(repo, 'NEW.md'), 'A vibrant note.\n');
        expect(addedOnly('NEW.md', 'main')).toEqual({ text: 'A vibrant note.\n', added: null });
        git('checkout', '-q', '--', 'CHANGELOG.md');
        expect(addedOnly('CHANGELOG.md', 'main')).toBeNull();
      } finally { process.chdir(cwd); }
      const r = run(['CHANGELOG.md', '--base', 'main'], repo);
      expect(r.out.trim()).toBe('PROSE_LINT: none files=0 nothing-to-scan=1');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('bin/gstack-prose-lint', () => {
  // Value: protects=printed line numbers locate the finding in the file, and one gated call covers several files (the Step 19 body-draft shape); fails_when=the block offset is off by one, or a later file's findings are dropped or misattributed; why_new=the line check here was a 3..12 range and the multi-file call ran only as a report; seam=none; no_claim=none beyond protects
  test('a slopped [Unreleased] block gates with exit 1, every rule named, and the result code on stderr', () => {
    const r = run([path.join(FIXTURES, 'slopped-changelog.md'), '--unreleased', '--gate']);
    expect(r.code).toBe(1);
    const found = [...r.out.matchAll(/^PROSE: \S+:(\d+) (\S+) /gm)].map(m => [Number(m[1]), m[2]] as const);
    for (const rule of ['vocabulary', 'not-just-but', 'metaphor-noun', 'mid-sentence-colon', 'inline-header-list', 'arrow', 'dropped-article']) expect(found.map(f => f[1])).toContain(rule);
    expect(found.every(f => f[0] >= 3 && f[0] <= 12)).toBe(true);
    for (const pair of [[5, 'not-just-but'], [8, 'inline-header-list'], [9, 'arrow'], [10, 'mid-sentence-colon']] as const) expect(found).toContainEqual(pair);
    const both = run([path.join(FIXTURES, 'clean-changelog.md'), path.join(FIXTURES, 'slopped-changelog.md'), '--unreleased', '--gate']);
    expect(both.code).toBe(1);
    expect(both.out).toMatch(/^PROSE: \S+slopped-changelog\.md:5 /m);
    expect(both.out).not.toMatch(/^PROSE: \S+clean-changelog\.md/m);
    expect(both.out).toMatch(/\nPROSE_LINT: found=\d+ files=2\n$/);
    expect(r.out).toMatch(/\nPROSE_LINT: found=\d+ files=1\n$/);
    expect(r.err).toMatch(/^gstack-prose-lint: .+; fix: .+ \(PROSE_LINT_FOUND\)$/m);
  });

  test('the clean block is ok, and the same file read whole shows the older entry the selection skipped', () => {
    const clean = path.join(FIXTURES, 'clean-changelog.md');
    const gated = run([clean, '--unreleased', '--gate']);
    expect(gated.code).toBe(0);
    expect(gated.out.trim()).toBe('PROSE_LINT: ok files=1');
    const whole = run([clean]);
    expect(whole.code).toBe(0);
    expect(whole.out).toMatch(/^PROSE: \S+clean-changelog\.md:15 vocabulary/m);
    expect(whole.out).toMatch(/PROSE_LINT: found=\d+ files=1\n$/);
  });

  test('no [Unreleased] block is none, exit 0, even with --gate', () => {
    const r = run([path.join(ROOT, 'NOTICE.md'), '--unreleased', '--gate']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('PROSE_LINT: none files=0 nothing-to-scan=1');
  });

  // Value: protects=a --base with no ref, a directory and a call with no file exit 2 with their own message, never a clean run; fails_when=a missing ref falls through to a whole-file lint (exit 0) or no file reads as none; why_new=the rows above cover unknown flags, a missing file and --base with --unreleased only; seam=none; no_claim=none beyond protects
  test('--json carries the findings; usage errors exit 2', () => {
    const j = run([path.join(FIXTURES, 'slopped-changelog.md'), '--unreleased', '--json']);
    expect(j.code).toBe(0);
    const parsed = JSON.parse(j.out);
    expect(parsed.findings.length).toBeGreaterThan(5);
    expect(parsed.findings[0]).toMatchObject({ rule: expect.any(String), line: expect.any(Number), match: expect.any(String), hint: expect.any(String) });
    expect(run([]).code).toBe(2);
    expect(run(['--help']).code).toBe(0);
    expect(run(['--help']).out).toContain('--unreleased');
    expect(run([path.join(FIXTURES, 'missing.md')]).code).toBe(2);
    expect(run([path.join(FIXTURES, 'clean-changelog.md'), '--nope']).code).toBe(2);
    expect(run([path.join(FIXTURES, 'clean-changelog.md'), '--unreleased', '--base', 'main']).code).toBe(2);
    expect(run([path.join(FIXTURES, 'clean-changelog.md'), '--sections', 'Added', '--base', 'main']).code).toBe(2);
    expect(run([path.join(FIXTURES, 'clean-changelog.md'), '--sections', '--gate']).code).toBe(2);
    const dir = run([FIXTURES]);
    expect(dir.code).toBe(2);
    expect(dir.err).toContain('cannot read');
    expect(run(['--gate']).code).toBe(2);
    const noRef = run([path.join(FIXTURES, 'slopped-changelog.md'), '--base']);
    expect(noRef.code).toBe(2);
    expect(noRef.err).toContain('--base needs a ref');
  });
});

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  test('/ship Step 13 lints the added CHANGELOG lines and Step 19 gates the body drafts before composing', () => {
    const changelog = read('ship/sections/changelog.md.tmpl');
    expect(changelog).toContain('gstack-prose-lint CHANGELOG.md --base origin/<base> --gate');
    const prBody = read('ship/sections/pr-body.md.tmpl');
    const compose = prBody.slice(prBody.indexOf(': "${DOCS_SECTION_FILE:?'), prBody.indexOf('echo "PR_BODY_FILE: $PR_BODY_FILE"'));
    expect(compose).toContain(`gstack-prose-lint "$BODY_TOP_FILE" --sections 'Why,Summary,Blast radius' --gate`);
    expect(compose).not.toContain('What changed,');
    expect(compose).not.toContain('"$BODY_REST_FILE" --gate');
    expect(compose.indexOf('gstack-prose-lint')).toBeGreaterThan(compose.indexOf('is empty, so the body was never written'));
    expect(compose.indexOf('gstack-prose-lint')).toBeLessThan(compose.indexOf('{ awk 1 "$BODY_TOP_FILE"'));
    for (const host of ['claude', 'codex', 'factory', 'agy']) expect(fs.existsSync(path.join(ROOT, 'test', 'fixtures', 'golden', host + '-ship-SKILL.md'))).toBe(true);
  });

  test('the PR body leads with the problem and carries a Blast radius item, on both the standard and the Capy path', () => {
    const prBody = read('ship/sections/pr-body.md.tmpl');
    const summary = prBody.slice(prBody.indexOf('## Summary'), prBody.indexOf('## Test Coverage'));
    expect(summary).toContain("Open with the problem in the user's words");
    expect(summary).toContain('Never an inventory or a commit list.');
    expect(summary).toMatch(/BAD: ".+" GOOD: "/s);
    expect(summary).toContain('## Blast radius');
    expect(summary).toContain('the one fact that makes that safe');
    expect(summary).toContain('file:line read, walked failure path, script ran, repro');
    expect(summary).not.toContain('/investigate');
    expect(prBody).toContain('names what the user gets, not the mechanism');
    const capy = read('ship/sections/capy-pr.md.tmpl');
    expect(capy).toContain('`## What changed`, `## Why` and `## Blast radius`');
    expect(capy).toMatch(/\*\*`## Why`:\*\* two or three sentences\. The first states the problem in the person's words/);
    expect(capy).toMatch(/BAD "[\s\S]+" GOOD "/);
    expect(capy).toContain("**`## Blast radius`:** the body template's item, written once");
    expect(capy).toContain('the evidence-ladder rung it reached (file:line read, walked failure path, script ran, repro)');
    expect(capy).not.toContain('/investigate');
  });

  test('the quality gate runs the lint over the [Unreleased] block, and NOTICE.md credits unslop', () => {
    const wf = read('.github/workflows/quality-gate.yml');
    expect(wf).toContain('bun --no-env-file --config=/dev/null bin/gstack-prose-lint CHANGELOG.md --unreleased --gate');
    expect(read('NOTICE.md')).toContain('## pstack (unslop) — Copyright Lauren Tan — MIT License');
    expect(read('docs/troubleshooting.md')).toContain('<a id="prose-lint-found"></a>');
  });

  // Value: protects=report mode (no --gate) exits 0 with a trailer even over a file full of findings, which is what lets the templates and docs keep their em dashes; fails_when=a finding exits nonzero without --gate, or a template run prints no trailer or writes to stderr; why_new=the earlier row accepted ok or found over the templates alone and so proved nothing about findings; seam=none; no_claim=the templates' own findings count is not pinned (it moves with every prose edit, and ok is as valid as found)
  test('report mode never gates: the slopped fixture exits 0 without --gate, and the shipped templates get a trailer and no stderr', () => {
    const slop = run([path.join(FIXTURES, 'slopped-changelog.md')]);
    expect(slop.code).toBe(0);
    expect(slop.out).toMatch(/PROSE_LINT: found=\d+ files=1\n$/);
    expect(slop.err).toBe('');
    const r = run(['ship/sections/changelog.md.tmpl', 'ship/sections/capy-pr.md.tmpl', 'ship/sections/pr-body.md.tmpl']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PROSE_LINT: (ok|found=\d+) files=3\n$/);
    expect(r.err).toBe('');
  });
});
