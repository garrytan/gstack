/**
 * GST-1955: `gstack-ship-receipt carry --pr` posts the rebound body with `gh pr edit`
 * itself, not through gstack-post, so it puts the receipt in its public form on a
 * public repository (or one whose visibility gh cannot read) and keeps today's form on
 * a private one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, placeReceipt } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function carryThroughGh(visibility: string | null) {
  const repo = makeFixtureRepo({ prefix: 'carry-public-' });
  repos.push(repo);
  fs.writeFileSync(path.join(repo.work, 'a.txt'), 'a\n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(repo.work, 'a.txt'), 'b\n');
  repo.git('commit', '-qam', 'feat');
  const reviewed = repo.git('rev-parse', 'HEAD');
  repo.git('commit', '-q', '--allow-empty', '-m', 'empty follow-up');
  const head = repo.git('rev-parse', 'HEAD');
  const shimDir = path.join(repo.root, 'gh');
  fs.mkdirSync(shimDir);
  const posted = path.join(shimDir, 'posted.md');
  const prBody = placeReceipt('## Summary\n\nProse.\n', {
    schema_version: 1, pr: 8, head: reviewed, base: 'main', spend_usd: 2.7, run: 'jam_01M6FGN8NNX1Y5JK5GZAMD8J4F', thread: 'GSTA-256',
    requires_remote: ['remote_gate: remote-gate tree=0db1a0a9fd29 tests=4556 receipt=/home/user/.capy/work/ship-b/remote-receipt.txt sha256=9b3385dae770'],
  } as any);
  fs.writeFileSync(path.join(shimDir, 'pr.json'), JSON.stringify({ body: prBody, headRefOid: head }));
  fs.writeFileSync(path.join(shimDir, 'gh'), [
    '#!/bin/sh',
    `if [ "$1" = pr ] && [ "$2" = view ]; then cat "${path.join(shimDir, 'pr.json')}"; exit 0; fi`,
    `if [ "$1" = pr ] && [ "$2" = edit ]; then shift 3; [ "$1" = --body-file ] || exit 9; cp "$2" "${posted}"; exit 0; fi`,
    visibility === null ? '' : `if [ "$1" = repo ] && [ "$2" = view ]; then echo ${visibility}; exit 0; fi`,
    'echo "unsupported $*" >&2; exit 1', '',
  ].join('\n'), { mode: 0o755 });
  const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), PATH: `${shimDir}:${process.env.PATH}` };
  const r = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', path.join(repo.root, 'run')], env);
  return { r, head, body: fs.existsSync(posted) ? fs.readFileSync(posted, 'utf8') : '' };
}

describe('gstack-ship-receipt carry --pr: the posted receipt follows the repo visibility', () => {
  test('a public repo gets the public form: no spend_usd, hashed run and thread, the pregate receipt path cut to its file name', () => {
    const { r, head, body } = carryThroughGh('PUBLIC');
    expect(r.status).toBe(EXIT.ok);
    expect(body).not.toContain('spend_usd');
    expect(body).not.toContain('/home/');
    expect(body).not.toContain('jam_');
    const ex = extractReceipt(body);
    expect(ex.errors).toEqual([]);
    expect(ex.receipt).toMatchObject({ pr: 8, head, run: expect.stringMatching(/^anon-[0-9a-f]{12}$/), thread: expect.stringMatching(/^anon-[0-9a-f]{12}$/) });
    expect(ex.receipt!.requires_remote![0]).toContain('receipt=remote-receipt.txt sha256=9b3385dae770');
  });

  test('visibility gh cannot read is treated as public', () => {
    const { r, body } = carryThroughGh(null);
    expect(r.status).toBe(EXIT.ok);
    expect(body).not.toContain('spend_usd');
  });

  test('a private repo keeps the receipt as written', () => {
    const { r, body } = carryThroughGh('PRIVATE');
    expect(r.status).toBe(EXIT.ok);
    expect(extractReceipt(body).receipt).toMatchObject({ spend_usd: 2.7, run: 'jam_01M6FGN8NNX1Y5JK5GZAMD8J4F', thread: 'GSTA-256' });
  });
});
