/**
 * gstack-ship-receipt carry across a harness pin that a base merge re-recorded (GSTA-749, #4652 at cc9b831d): the branch
 * edits a pinned harness file and records the edit as non-behavioral; the base lands its own edit and re-pin of the same
 * file; merging the base re-records the pin's blob for the merged file and nothing else. The pin is then a function of
 * the pinned file's bytes, which the carry still compares as product, so it carries as a regenerated output. Controls:
 * a pin whose blob is not the file's, a changed reason, a moved harness version and a blob-only re-pin of a pinned test
 * helper (which carries as a test change on its own) and a pin turned into a symlink still refuse.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const FILE = 'scripts/profile.ts';
const PIN = `scripts/harness-pins/${FILE}.json`;
const MANIFEST = 'scripts/harness-version.json';
const manifest = (version = 7) => `${JSON.stringify({ version, patterns: ['scripts/profile.ts'] }, null, 2)}\n`;
const BRANCH_REASON = 'the branch adds one free-only workflow name to the list, so no paid case selection can change';
const pin = (blob: string, reason: string, since = 7) => `${JSON.stringify({ blob, since, nonBehavioral: reason })}\n`;
const LINES = ['export const FREE = [', "  'a.yml',", '];', ...Array.from({ length: 8 }, (_, i) => `export const K${i} = ${i};`), ''];

/** main pins FILE; feature edits its start and re-pins, /ship receipt there; main edits its end and re-pins; feature merges main and resolves the pin with `resolve`. */
function repinned(resolve: (merged: string) => Record<string, string>, linkPin = false): { body: string; repo: FixtureRepo } {
  const repo = makeFixtureRepo(); repos.push(repo);
  const blob = () => repo.git('rev-parse', `HEAD:${FILE}`);
  repo.git('checkout', '-q', 'main');
  commit(repo, { [MANIFEST]: manifest(), [FILE]: LINES.join('\n') }, 'main: harness file');
  commit(repo, { [PIN]: pin(blob(), 'main pins the harness file') }, 'main: pin');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', 'origin/main');
  commit(repo, { [FILE]: [...LINES.slice(0, 2), "  'mutation.yml',", ...LINES.slice(2)].join('\n') }, 'feat: add a free-only workflow');
  commit(repo, { [PIN]: pin(blob(), BRANCH_REASON) }, 'feat: re-pin as non-behavioral');
  const body = path.join(repo.root, 'body.md');
  expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '4652', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
  repo.git('checkout', '-q', 'main');
  commit(repo, { [FILE]: [...LINES.slice(0, -1), '// shared harness list', ''].join('\n') }, 'main: comment');
  commit(repo, { [PIN]: pin(blob(), 'main adds a comment') }, 'main: re-pin');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  try { repo.git('merge', '-q', '--no-edit', 'origin/main'); } catch { /* the pin conflicts; resolved below */ }
  for (const [rel, text] of Object.entries(resolve(repo.git('hash-object', FILE)))) {
    if (!linkPin || rel !== PIN) { write(repo.work, rel, text); continue; }
    fs.rmSync(path.join(repo.work, rel), { force: true });
    fs.symlinkSync(text.trim(), path.join(repo.work, rel));
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '--no-edit');
  return { body, repo };
}
/** main pins a test helper; feature edits it and re-pins it as non-behavioral, /ship receipt there; then changes the helper's behavior and re-pins only its blob. */
function repinnedHelper(): { body: string; repo: FixtureRepo; pinPath: string } {
  const helper = 'test/helpers/gate.ts';
  const pinPath = `scripts/harness-pins/${helper}.json`;
  const repo = makeFixtureRepo(); repos.push(repo);
  const blob = () => repo.git('rev-parse', `HEAD:${helper}`);
  repo.git('checkout', '-q', 'main');
  commit(repo, { [MANIFEST]: manifest(), [helper]: 'export const RETRIES = 1;\n' }, 'main: harness helper');
  commit(repo, { [pinPath]: pin(blob(), 'main pins the helper') }, 'main: pin');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', 'origin/main');
  commit(repo, { [helper]: '// retry budget\nexport const RETRIES = 1;\n' }, 'feat: comment the helper');
  commit(repo, { [pinPath]: pin(blob(), 'a comment only, so no case verdict can change') }, 'feat: re-pin as non-behavioral');
  const body = path.join(repo.root, 'body.md');
  expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '4652', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
  commit(repo, { [helper]: '// retry budget\nexport const RETRIES = 5;\n' }, 'feat: retry more');
  commit(repo, { [pinPath]: pin(blob(), 'a comment only, so no case verdict can change') }, 'feat: re-pin');
  return { body, repo, pinPath };
}
const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--dry-run']);

describe('carry across a harness pin a base merge re-recorded (GSTA-749)', () => {
  // Value: protects=a sibling PR keeps its receipt when a base merge only re-records a pin it shares (#4652 paid a fresh
  //   /ship); fails_when=the pin's new blob reads as a product change; seam=lib/ship-receipt-patch.ts productSpec; no_claim=gh pr edit
  test('a pin whose only change is the merged file\'s blob carries as a regenerated output', () => {
    const { repo, body } = repinned(merged => ({ [PIN]: pin(merged, BRANCH_REASON) }));
    const out = carry(repo, body);
    expect(out.status, out.err).toBe(EXIT.ok);
    expect(out.out + out.err).toContain('regenerated outputs');
  }, 90_000);

  // Value: protects=fail closed on a pin that is not the pinned file's blob; fails_when=any pin edit carries; seam=productSpec; no_claim=gh pr edit
  test('a pin whose blob is not the pinned file\'s still refuses', () => {
    const { repo, body } = repinned(() => ({ [PIN]: pin('0'.repeat(40), BRANCH_REASON) }));
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain(PIN);
  }, 90_000);

  // Value: protects=the reviewed non-behavioral claim is the one that ships; fails_when=a rewritten reason carries; seam=productSpec; no_claim=gh pr edit
  test('a pin whose reason changed since review still refuses', () => {
    const { repo, body } = repinned(merged => ({ [PIN]: pin(merged, `${BRANCH_REASON}; also the base comment`) }));
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain(PIN);
  }, 90_000);

  // Value: protects=a pinned test helper's behavior change after review still needs a fresh /ship: the helper carries as a test
  //   change, so its pin is the only product path that stops it (cross-family trail read on #4669); fails_when=any pin whose blob
  //   is its file's carries; seam=productSpec; no_claim=gh pr edit
  test('a blob-only re-pin of a pinned test helper still refuses', () => {
    const { repo, body, pinPath } = repinnedHelper();
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain(pinPath);
  }, 90_000);

  // Value: protects=the harness reads the pin git shows: a symlink's link text can spell the reviewed pin while the harness
  //   follows it elsewhere (second-model review of #4669); fails_when=a pin is read without its tree mode; seam=productSpec;
  //   no_claim=gh pr edit
  test.skipIf(process.platform === 'win32')('a pin turned into a symlink whose link text is the pin still refuses', () => {
    const { repo, body } = repinned(merged => ({ [PIN]: pin(merged, BRANCH_REASON) }), true);
    expect(repo.git('ls-tree', 'HEAD', '--', PIN)).toStartWith('120000 ');
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain(PIN);
  }, 90_000);

  // Value: protects=a version bump starts a new pass-rate series, a behavior change; fails_when=a bump rides a re-record; seam=productSpec; no_claim=gh pr edit
  test('a re-record beside a harness version bump still refuses', () => {
    const { repo, body } = repinned(merged => ({ [PIN]: pin(merged, BRANCH_REASON, 8), [MANIFEST]: manifest(8) }));
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
  }, 90_000);
});
