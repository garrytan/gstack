/**
 * Value: protects=outside review packets include code changes while source artifacts stay metadata-only;
 * fails_when=a caller restores an unbounded raw diff, misses untracked code, or leaks a source body through a rename;
 * why_new=the previous full branch context exceeded Claude Code's prompt limit on a spec-heavy PR;
 * seam=provider execution is covered separately, while this test proves exact packet construction and workflow wiring.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReviewContextPacket, REVIEW_PACKET_MAX_BYTES, REVIEW_PROMPT_MAX_BYTES, writeReviewContextPacket } from '../lib/review-context-packet';
import { outsideVoiceInvocation } from '../scripts/resolvers/outside-voice';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { expectMentions } from './helpers/prompt-structure';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'review-context-packet-'));
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repository(name: string): string {
  const root = fs.mkdtempSync(path.join(temporary, `${name}-`));
  fs.mkdirSync(path.join(root, 'sources'));
  fs.writeFileSync(path.join(root, 'changed.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'sources/spec.txt'), 'BASE_SOURCE_BODY_'.repeat(8));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

const context = (skillName = 'review', host: TemplateContext['host'] = 'codex'): TemplateContext => ({
  skillName,
  tmplPath: `${skillName}/SKILL.md.tmpl`,
  host,
  paths: HOST_PATHS[host],
});

describe('bounded Claude review context', () => {
  test('lists source artifacts and includes tracked and untracked code without source bodies', () => {
    const root = repository('ordinary');
    fs.appendFileSync(path.join(root, 'changed.ts'), 'export const changed = true;\n');
    fs.appendFileSync(path.join(root, 'sources/spec.txt'), 'CURRENT_SOURCE_BODY_'.repeat(8));
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'UNTRACKED_CODE\n');
    fs.writeFileSync(path.join(root, 'sources/untracked.docx'), 'UNTRACKED_SOURCE_BODY_'.repeat(8));
    fs.copyFileSync(path.join(root, 'sources/spec.txt'), path.join(root, 'copied-source.txt'));
    git(root, 'add', 'copied-source.txt');
    fs.copyFileSync(path.join(root, 'sources/spec.txt'), path.join(root, 'untracked-source-copy.txt'));
    const outside = path.join(temporary, 'outside-secret.txt');
    fs.writeFileSync(outside, 'SYMLINK_TARGET_MUST_NOT_BE_READ\n');
    fs.symlinkSync(outside, path.join(root, 'untracked-link'));

    const packet = buildReviewContextPacket(root, 'main', Buffer.from('Review request with cited section excerpt.\n'));
    const text = packet.toString('utf8');
    expect(text).toContain('"M"\t"sources/spec.txt"');
    expect(text).toContain('"?"\t"untracked.ts"');
    expect(text).toContain('"?"\t"sources/untracked.docx"');
    expect(text).toContain('+export const changed = true;');
    expect(text).toContain('UNTRACKED_CODE');
    expect(text).toContain('tracked file diff omitted because it contains a source artifact');
    expect(text).toContain('file body omitted because it contains a source artifact');
    expect(text).not.toContain('CURRENT_SOURCE_BODY_');
    expect(text).not.toContain('UNTRACKED_SOURCE_BODY_');
    expect(text).not.toContain('SYMLINK_TARGET_MUST_NOT_BE_READ');
  });

  test('a rename across the sources boundary stays metadata-only', () => {
    const root = repository('rename');
    const leaked = 'RENAMED_SOURCE_BODY_'.repeat(16);
    fs.writeFileSync(path.join(root, 'sources/renamed.txt'), leaked);
    git(root, 'add', 'sources/renamed.txt');
    git(root, 'commit', '-m', 'add source');
    fs.renameSync(path.join(root, 'sources/renamed.txt'), path.join(root, 'renamed.txt'));
    git(root, 'add', '-A');

    const text = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n')).toString('utf8');
    expect(text).toContain('sources/renamed.txt');
    expect(text).toContain('renamed.txt');
    expect(text).not.toContain(leaked);
  });

  test('the CLI resolves the repository root when invoked from a nested directory', () => {
    const root = repository('nested-cli');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.appendFileSync(path.join(root, 'changed.ts'), 'export const nested = true;\n');
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'ROOT_UNTRACKED_CODE\n');
    const input = path.join(temporary, 'nested-cli-prompt.txt');
    const baseCommit = Bun.spawnSync(['git', 'rev-parse', 'main'], { cwd: root, stdout: 'pipe' }).stdout.toString().trim();
    fs.writeFileSync(input, `GSTACK_DIFF_BASE: ${baseCommit}\nReview request\n`);

    const result = Bun.spawnSync([
      process.execPath,
      path.resolve(import.meta.dir, '../bin/gstack-review-context.ts'),
      '--base-from-input',
      '--input',
      input,
    ], { cwd: path.join(root, 'nested'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const text = fs.readFileSync(input, 'utf8');
    expect(text).toContain('+export const nested = true;');
    expect(text).toContain('ROOT_UNTRACKED_CODE');

    const hostile = "evil';touch${IFS}PWNED;#";
    git(root, 'branch', hostile, 'main');
    fs.writeFileSync(input, 'Review hostile ref\n');
    const hostileResult = Bun.spawnSync([
      process.execPath,
      path.resolve(import.meta.dir, '../bin/gstack-review-context.ts'),
      '--base',
      hostile,
      '--input',
      input,
    ], { cwd: path.join(root, 'nested'), stdout: 'pipe', stderr: 'pipe' });
    expect(hostileResult.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
  });

  test('omits staged text and binary copies of changed source bodies, including short bodies', () => {
    const root = repository('tracked-copies');
    const binary = Buffer.from([0, 1, 2, 3, 4, 5, 255]);
    fs.writeFileSync(path.join(root, 'sources/data.bin'), binary);
    fs.writeFileSync(path.join(root, 'sources/unchanged.txt'), 'UNCHANGED_SOURCE_BODY');
    git(root, 'add', 'sources/data.bin', 'sources/unchanged.txt');
    git(root, 'commit', '-m', 'add source fixtures');
    fs.writeFileSync(path.join(root, 'sources/spec.txt'), 'short');
    const changedBinary = Buffer.concat([binary, Buffer.from([6])]);
    fs.writeFileSync(path.join(root, 'sources/data.bin'), changedBinary);
    fs.copyFileSync(path.join(root, 'sources/spec.txt'), path.join(root, 'copied-short.txt'));
    fs.writeFileSync(path.join(root, 'copied-binary.bin'), changedBinary);
    fs.copyFileSync(path.join(root, 'sources/unchanged.txt'), path.join(root, 'copied-unchanged.txt'));
    git(root, 'add', '-A');

    expect(() => buildReviewContextPacket(root, 'main', Buffer.from('short'))).toThrow('whole body');
    const text = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n')).toString('utf8');
    expect(text).toContain('copied-short.txt');
    expect(text).toContain('copied-binary.bin');
    expect(text).toContain('copied-unchanged.txt');
    expect(text.match(/tracked file diff omitted because it contains a source artifact/g)?.length).toBe(3);
    expect(text).not.toContain('+short');
    expect(text).not.toContain('+UNCHANGED_SOURCE_BODY');
  });

  test('short source artifacts block embedded copies without blocking unrelated code', () => {
    const root = repository('tiny-sources');
    const shortSource = 'SHORT_SOURCE_BODY_20';
    fs.writeFileSync(path.join(root, 'sources/short.txt'), shortSource);
    git(root, 'add', 'sources/short.txt');
    git(root, 'commit', '-m', 'add short source');
    fs.writeFileSync(path.join(root, 'ordinary.ts'), 'export const review = true;\n');
    fs.writeFileSync(path.join(root, 'embedded-short.txt'), `prefix=${shortSource};suffix\n`);
    git(root, 'add', '-A');

    const text = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n')).toString('utf8');
    expect(text).toContain('+export const review = true;');
    expect(text).toContain('tracked file diff omitted because it contains a source artifact');
    expect(text).not.toContain(shortSource);
  });

  test('ambiguous one-byte sources block exact copies without suppressing ordinary review text', () => {
    const root = repository('ambiguous-sources');
    fs.writeFileSync(path.join(root, 'sources/one.txt'), 'e');
    fs.writeFileSync(path.join(root, 'sources/newline.txt'), '\n');
    git(root, 'add', 'sources/one.txt', 'sources/newline.txt');
    git(root, 'commit', '-m', 'add ambiguous sources');
    fs.writeFileSync(path.join(root, 'ordinary.ts'), 'export const review = true;\n');
    fs.copyFileSync(path.join(root, 'sources/one.txt'), path.join(root, 'copied-one.txt'));
    fs.copyFileSync(path.join(root, 'sources/newline.txt'), path.join(root, 'copied-newline.txt'));
    git(root, 'add', '-A');

    const text = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n')).toString('utf8');
    expect(text).toContain('+export const review = true;');
    expect(text.match(/tracked file diff omitted because it contains a source artifact/g)?.length).toBe(2);
  });

  test('disables external diff helpers and text conversion', () => {
    const root = repository('external-diff');
    const sourceBody = fs.readFileSync(path.join(root, 'sources/spec.txt'), 'utf8');
    const helper = path.join(temporary, 'hostile-diff-helper.sh');
    fs.writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' '${sourceBody}'\n`);
    fs.chmodSync(helper, 0o700);
    git(root, 'config', 'diff.external', helper);
    fs.appendFileSync(path.join(root, 'changed.ts'), 'export const safeDiff = true;\n');

    const text = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n')).toString('utf8');
    expect(text).toContain('+export const safeDiff = true;');
    expect(text).not.toContain(sourceBody);
  });

  test('rejects whole source bodies and oversized prepared prompts', () => {
    const root = repository('prepared');
    fs.appendFileSync(path.join(root, 'sources/spec.txt'), 'changed\n');
    const wholeSource = fs.readFileSync(path.join(root, 'sources/spec.txt'));
    expect(() => buildReviewContextPacket(root, 'main', wholeSource)).toThrow('whole body of a source artifact');
    expect(() => buildReviewContextPacket(root, 'main', Buffer.alloc(REVIEW_PROMPT_MAX_BYTES + 1))).toThrow('limit');
    const oversizedInput = path.join(temporary, 'oversized-prompt.txt');
    fs.writeFileSync(oversizedInput, Buffer.alloc(REVIEW_PROMPT_MAX_BYTES + 1));
    expect(() => writeReviewContextPacket(root, 'main', oversizedInput)).toThrow('limit');
  });

  test('hard-caps a huge non-source diff and treats the base as argv, not shell', () => {
    const root = repository('limits');
    const copiedSource = 'LARGE_TRACKED_SOURCE_COPY_'.repeat(8);
    fs.writeFileSync(path.join(root, 'sources/large-snippet.txt'), copiedSource);
    fs.writeFileSync(path.join(root, 'large.txt'), 'small\n');
    fs.writeFileSync(path.join(root, 'large-small-diff.txt'), 'line\n'.repeat(600_000));
    fs.writeFileSync(path.join(root, 'large-source-copy.txt'), 'small\n');
    fs.writeFileSync(path.join(root, 'later.ts'), 'export const later = 1;\n');
    git(root, 'add', 'sources/large-snippet.txt', 'large.txt', 'large-small-diff.txt', 'large-source-copy.txt', 'later.ts');
    git(root, 'commit', '-m', 'add large fixtures');
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(17 * 1024 * 1024));
    const largeSmall = fs.readFileSync(path.join(root, 'large-small-diff.txt'), 'utf8');
    fs.writeFileSync(path.join(root, 'large-small-diff.txt'), largeSmall.replace('line\n', 'changed\n'));
    fs.writeFileSync(path.join(root, 'large-source-copy.txt'), copiedSource + 'x'.repeat(3 * 1024 * 1024));
    fs.appendFileSync(path.join(root, 'later.ts'), 'export const stillReviewed = true;\n');
    fs.writeFileSync(path.join(root, 'huge-untracked.txt'), 'u'.repeat(3 * 1024 * 1024));
    const packet = buildReviewContextPacket(root, 'main', Buffer.from('Review request\n'));
    expect(packet.length).toBeLessThanOrEqual(REVIEW_PACKET_MAX_BYTES);
    expect(packet.toString('utf8').endsWith('[DIFF CONTENT OMITTED OR TRUNCATED BY PACKET LIMITS]\n')).toBe(true);
    expect(packet.toString('utf8')).toContain('"M"\t"large-small-diff.txt"');
    expect(packet.toString('utf8')).toContain('+export const stillReviewed = true;');
    expect(packet.toString('utf8')).toContain('file exceeds the source scan limit');
    expect(packet.toString('utf8')).not.toContain(copiedSource);

    const marker = path.join(root, 'INJECTION_RAN');
    expect(() => buildReviewContextPacket(root, `main; touch ${marker}`, Buffer.from('Review request\n'))).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('the generated review and ship steps invoke the bounded packet builder', () => {
    const invocation = outsideVoiceInvocation(context(), {
      timeoutMs: 3000,
      reviewPacket: true,
      reviewBaseFromInput: true,
    });
    expect(invocation).toContain('gstack-review-context.ts');
    expect(invocation).toContain('--base-from-input');
    expect(invocation).not.toContain('${DIFF_BASE:');
    expect(invocation).not.toContain("--base 'origin/<base>'");
    expectMentions(invocation, [
      ['bounded', 'review', 'packet'],
      ['tracked', 'untracked', 'non-`sources/`', 'excerpts'],
      ['cited', 'spec', 'sections'],
      ['never', 'whole', 'spec', 'DOCX'],
    ], 'Claude review preparation');

    for (const host of ['codex', 'claude'] as const) {
      for (const skillName of ['review', 'ship']) {
        const step = generateAdversarialStep(context(skillName, host));
        expect(step).toContain('gstack-review-context.ts');
        expect(step).toContain('--base-from-input');
        expect(step).toContain('GSTACK_DIFF_BASE: <commit>');
        expect(step.indexOf("printf 'DIFF_BASE: %s")).toBeLessThan(step.indexOf('GSTACK_DIFF_BASE: <commit>'));
        expect(step).not.toContain('${DIFF_BASE:');
        expect(step).not.toContain("--base 'origin/<base>'");
        expectMentions(step, [
          ['tracked', 'untracked', 'changed-path'],
          ['sources/', 'omitted'],
          ['cited', 'spec', 'sections'],
          ['never', 'sources/', 'file', 'bodies'],
        ], `${host} ${skillName} adversarial step`);
      }
    }
  });
});
