/**
 * GST-1179: gstack-ship-receipt's terminal line names the full head it bound, so a leftover line from an earlier ship can't
 * pass for a new head (harness-evals' merge lane requires it from 2026-11-09T08:00Z).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, parseResult } from '../lib/headless-artifacts';
import { renderReceiptBlock } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('GSTACK_RESULT head= token (GST-1179)', () => {
  test('result prints head=<full sha> between status and run, and parseResult reads it', () => {
    const repo = makeFixtureRepo({ prefix: 'ship-result-head-' }); repos.push(repo);
    const head = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, renderReceiptBlock({ schema_version: 1, head, base: 'main' } as any));
    const out = path.join(repo.root, 'run');
    const r = runBin(repo, 'gstack-ship-receipt', ['result', '--body', body, '--out', out], { GSTACK_STATE_ROOT: path.join(repo.root, 'state') });
    expect(r.status).toBe(EXIT.ok);
    const line = r.out.trim().split('\n').at(-1)!;
    expect(line).toBe(`GSTACK_RESULT: skill=ship status=complete head=${head} run=${out}`);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(parseResult(r.out)).toEqual({ skill: 'ship', status: 'complete', head, run: out });
  }, 30_000);

  test('a line without head= still parses, with no head', () => {
    expect(parseResult('GSTACK_RESULT: skill=pregate status=complete run=.gstack/tmp/pregate.json')).toEqual({ skill: 'pregate', status: 'complete', run: '.gstack/tmp/pregate.json' });
  });
});
