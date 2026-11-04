/**
 * gstack-ship-receipt carry never guesses which base entry a branch-added pin file holds (GST-1210, GSTA-202 #3903 at
 * f0613db8): the branch splits the base's JSON map of pins into one file per entry, and a pin file that changes after review
 * is a product change whatever the base did to a same-named entry. Inferring the mapping from names and values let an
 * unrelated base edit carry an unreviewed change (GSTA-36 ruling A on #3937), so these controls keep every such pin refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
const RETRY = '{"blob":"aaa","since":6,"nonBehavioral":"first pin"}';
const UTIL = '{"blob":"bbb","since":6}';
const RETRY_MAIN = '{"blob":"ccc","since":6,"nonBehavioral":"main repinned retry"}';
const manifest = (retry: string, short?: string) => `{\n  "version": 6,\n  "files": {\n    "lib/retry.js": ${retry},\n    "lib/util.js": ${UTIL}${short ? `,\n    "retry.js": ${short}` : ''}\n  }\n}\n`;
const PIN = 'scripts/harness-pins/lib/retry.js.json';

/** main holds the pin map; feature splits it into one file per entry beside a product change, /ship receipt there; main repins retry; feature merges main and writes `ports`. */
function ported(repo: FixtureRepo, ports: Record<string, string>, maps: [string, string] = [manifest(RETRY), manifest(RETRY_MAIN)]): { reviewed: string; body: string } {
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/harness-version.json': maps[0] }, 'main: harness pins');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', 'origin/main');
  const reviewed = commit(repo, { 'lib/retry.js': "exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n", [PIN]: `${RETRY}\n`, 'scripts/harness-pins/lib/util.js.json': `${UTIL}\n` }, 'feat: one file per harness pin');
  const body = path.join(repo.root, 'body.md');
  expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '3903', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/harness-version.json': maps[1], 'docs/README.md': '# docs after the repin\n' }, 'main: repin retry');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--no-edit', 'origin/main');
  commit(repo, ports, 'port the base repin into its pin file');
  return { reviewed, body };
}

describe('carry across a ported harness-pin entry (GST-1210)', () => {
  // Value: protects=fail closed on a pin the branch changed beyond the base's entry (an unreviewed repin);
  // fails_when=any pin file change carries; seam=none; no_claim=gh pr edit
  test('a pin entry that differs from the base\'s still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = ported(repo, { [PIN]: `${RETRY_MAIN.replace('ccc', 'ddd')}\n` });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain(PIN);
  }, 90_000);

  // Value: protects=fail closed when the base's entry lands in another entry's pin file; fails_when=the port matches the
  // value without its key; seam=none; no_claim=gh pr edit
  test('the base\'s entry written into another entry\'s pin file still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = ported(repo, { [PIN]: `${RETRY_MAIN}\n`, 'scripts/harness-pins/lib/util.js.json': `${RETRY_MAIN}\n` });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('scripts/harness-pins/lib/util.js.json');
  }, 90_000);

  // Value: protects=fail closed when a shorter key's repin lands in a longer key's pin file (`retry.js` for
  // `…/lib/retry.js.json`); fails_when=the key is matched as a bare path suffix; seam=none; no_claim=gh pr edit
  test('a repin of a key that is only a suffix of the pin path still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = ported(repo, { [PIN]: `${RETRY_MAIN}\n` }, [manifest(RETRY, RETRY), manifest(RETRY, RETRY_MAIN)]);
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain(PIN);
  }, 90_000);
});
