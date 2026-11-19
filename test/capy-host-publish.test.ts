/**
 * GST-3183: on Capy (GSTACK_CAPY=1) the machine's gh is signed in as the owner's personal GitHub account, so a gh write
 * from /ship lands under their name. GBEV-105 (2026-11-19) saw `gstack-ship-receipt stub` edit an outside system's PR
 * body that way during an unattended /ship. Every /ship write path now hands the exact bytes to the host's PR tool
 * instead: it writes them to a private file and prints one HOST_PUBLISH: line. A recording gh shim proves no write call
 * reaches gh, and the negative control proves the shim does record one when GSTACK_CAPY is unset.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { placeReceipt } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); while (repos.length) cleanup(repos.pop()!); });

const WRITE = /^(pr\t(edit|comment|create|ready|close|merge|review)|issue\t(comment|create|edit|close))\t/;
/** A recorded gh call that changes GitHub: a pr or issue edit, comment, create, ready or close, or an api call that is not a GET. */
const isWrite = (call: string) => WRITE.test(call + '\t')
  || (/^api\t/.test(call) && (/\t(--method|-X)(=|\t)(POST|PATCH|PUT|DELETE)\t/.test(call + '\t') || (/\t(-f|-F|--field|--raw-field|--input)(=|\t)/.test(call + '\t') && !/\tgraphql\t/.test(call + '\t'))));

/** A gh on PATH that appends each call's argv (tab-separated) to calls.log and answers the reads /ship makes. */
function recordingGh(dir: string, pr: { body: string; head?: string }) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'body.md'), pr.body);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ body: pr.body, headRefOid: pr.head ?? 'f'.repeat(40) }));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\t' "$a"; done >> "${log}"; printf '\\n' >> "${log}"`,
    'case "$*" in',
    `  "pr view "*"--jq .body"*) cat "${path.join(dir, 'body.md')}"; exit 0 ;;`,
    '  "pr view "*"--jq .createdAt"*) echo 2026-11-19T00:00:00Z; exit 0 ;;',
    `  "pr view "*) cat "${path.join(dir, 'pr.json')}"; exit 0 ;;`,
    '  "pr list "*) echo "[]"; exit 0 ;;',
    '  "repo view "*) echo PUBLIC; exit 0 ;;',
    '  "pr create "*) cat >/dev/null; echo https://github.com/fx/fx/pull/7; exit 0 ;;',
    '  "pr "*|"issue "*|"api "*) cat >/dev/null; echo "{}"; exit 0 ;;',
    'esac',
    'exit 0', '',
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { calls, writes: () => calls().filter(isWrite) };
}

/** The files the HOST_PUBLISH: lines name, by part. */
function handedOff(stdout: string): Array<Record<string, string>> {
  return stdout.split('\n').filter(l => l.startsWith('HOST_PUBLISH: ')).map(l => Object.fromEntries([...l.matchAll(/\b(body|title)-file=(\S+)/g)].map(m => [m[1]!, fs.readFileSync(m[2]!, 'utf8')])));
}

function capyRepo() {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
  fxs.push(f);
  const gh = recordingGh(path.join(f.root, 'gh'), { body: 'Fixes a thing.\n' });
  const env = { PATH: `${path.join(f.root, 'gh')}:${process.env.PATH}`, GSTACK_APPROVALS_MIRROR: '0', GSTACK_CAPY: '1', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (bin: string, args: string[], extra: Record<string, string> = {}) => f.run(path.join(BIN, bin), args, { ...env, ...extra });
  /** gstack-post reads the origin URL itself, so drop the fixture's insteadOf mapping (it would show the bare path). */
  const githubOrigin = () => f.git('config', '--unset', `url.${f.origin}.insteadOf`);
  return { f, gh, run, githubOrigin, head: () => f.git('rev-parse', 'HEAD').stdout.trim() };
}

describe('on Capy, /ship calls no gh write (GST-3183)', () => {
  test('the negative control: without GSTACK_CAPY the shim records gstack-post pr-comment as a gh write', () => {
    const r = capyRepo();
    r.githubOrigin();
    fs.writeFileSync(path.join(r.f.root, 'c.md'), 'A plain comment.\n');
    const out = r.run('gstack-post', ['pr-comment', '7', '--body-file', path.join(r.f.root, 'c.md')], { GSTACK_CAPY: '' });
    expect(out.status, out.stderr).toBe(0);
    expect(r.gh.writes().map(c => c.split('\t').slice(0, 2).join(' '))).toEqual(['pr comment']);
  });

  test('gstack-ship-receipt stub writes the body with its run entry to a file and prints HOST_PUBLISH', () => {
    const r = capyRepo();
    const out = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1']);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('RUN_STUB: run=r1 status=started');
    expect(r.gh.writes()).toEqual([]);
    const [h] = handedOff(out.stdout);
    expect(h!.body).toStartWith('Fixes a thing.');
    expect(h!.body).toContain('"run":"r1"');
    expect(out.stdout).toMatch(/^HOST_PUBLISH: pr-body 7 body-file=\S+ /m);
    const again = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--repo', 'other/repo', '--run', 'r2']);
    expect(again.status, again.stderr).toBe(0);
    const file = (o: string) => /body-file=(\S+)/.exec(o)![1]!;
    expect(file(again.stdout)).not.toBe(file(out.stdout));
    expect(fs.readFileSync(file(out.stdout), 'utf8')).toContain('"run":"r1"');
    expect(fs.readFileSync(file(out.stdout), 'utf8')).not.toContain('"run":"r2"');
  });

  test('gstack-ship-receipt stop and claim hand their body edits off too', () => {
    const r = capyRepo();
    const start = r.run('gstack-review-log', ['--start', 'review']);
    expect(start.status, start.stderr).toBe(0);
    const logged = r.run('gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', pass: 1, review_scope: 'frozen', completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [{ fingerprint: 'src/x.ts:1:outside-voice', severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: 'p1/outside-voice#1', raised_by: 'outside-voice' }] }), '--finish', start.stdout.trim()]);
    expect(logged.status, logged.stderr).toBe(0);
    const stop = r.run('gstack-ship-receipt', ['stop', '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']);
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stdout).toContain('STOP_RECORD: run=ro head=' + r.head());
    expect(handedOff(stop.stdout)[0]!.body).toContain('"mark":"stop"');
    const g = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', r.head(), '--kind', 'extra-round', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)?.[1];
    expect(g).toBeDefined();
    const claim = r.run('gstack-ship-receipt', ['claim', '--pr', '7', '--run', 'r1', '--grant', g!]);
    expect(claim.status, claim.stderr).toBe(0);
    expect(claim.stdout).toContain('GRANT_CLAIMED: grant=' + g);
    expect(handedOff(claim.stdout)[0]!.body).toContain('"mark":"grant"');
    expect(r.gh.writes()).toEqual([]);
  });

  test('gstack-post hands every write op to the host PR tool after its checks, with the bytes it would have sent', () => {
    const r = capyRepo();
    r.githubOrigin();
    const file = (name: string, text: string) => { const p = path.join(r.f.root, name); fs.writeFileSync(p, text); return p; };
    const body = file('body.md', 'Adds a thing for users.\n\n## Why\n\nBecause.\n');
    const title = file('title.txt', 'Add a thing for users\n');
    const comment = file('comment.md', 'A plain comment.\n');
    const ops: Array<[string, string[], string, string]> = [
      ['pr-body', ['pr-body', '7', '--body-file', body], 'body', '7 repo=fx/fx'],
      ['pr-title', ['pr-title', '7', '--title-file', title], 'title', '7 repo=fx/fx'],
      ['pr-comment', ['pr-comment', '7', '--body-file', comment], 'body', '7 repo=fx/fx'],
      ['issue-comment', ['issue-comment', '7', '--body-file', comment], 'body', '7 repo=fx/fx'],
      ['reply', ['reply', '7', '--to', '99', '--body-file', comment], 'body', '7 repo=fx/fx to=99'],
      ['pr-create', ['pr-create', '--base', 'main', '--head', 'feat', '--draft', '--title-file', title, '--body-file', body], 'title', 'new repo=fx/fx base=main head=feat draft'],
      ['issue-create', ['issue-create', '--title-file', title, '--body-file', comment], 'title', 'new repo=fx/fx'],
    ];
    for (const [op, args, part, dest] of ops) {
      const out = r.run('gstack-post', args);
      expect([op, out.status, out.stderr]).toEqual([op, 0, expect.any(String)]);
      expect(out.stdout).not.toContain('POSTED:');
      expect(out.stdout).toMatch(new RegExp(`^HOST_PUBLISH: ${op} ${dest} body-file=|^HOST_PUBLISH: ${op} ${dest} title-file=`, 'm'));
      expect(handedOff(out.stdout)[0]![part]).toBeDefined();
    }
    expect(r.gh.writes()).toEqual([]);
    const pb = r.run('gstack-post', ['pr-body', '7', '--body-file', body]);
    expect(handedOff(pb.stdout)[0]!.body).toContain('<summary>Why</summary>');
  });

  test('gstack-post still refuses a HIGH finding on Capy and writes no hand-off file', () => {
    const r = capyRepo();
    r.githubOrigin();
    const p = path.join(r.f.root, 'leak.md');
    fs.writeFileSync(p, 'key AKIA' + '1234567890ABCDEF\n');
    const out = r.run('gstack-post', ['pr-comment', '7', '--body-file', p]);
    expect(out.status).toBe(1);
    expect(out.stdout).not.toContain('HOST_PUBLISH:');
    expect(r.gh.writes()).toEqual([]);
  });
});

describe('on Capy, gstack-ship-receipt carry calls no gh write (GST-3183)', () => {
  test('carry across a conflict-only base merge hands the carried body off instead of gh pr edit', () => {
    const repo = makeFixtureRepo({ prefix: 'capy-carry-' });
    repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'feat: a=2');
    const reviewed = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 2;\n');
    repo.git('commit', '-qam', 'main: o=2'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feat');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const head = repo.git('rev-parse', 'HEAD');
    const shim = path.join(repo.root, 'gh');
    const gh = recordingGh(shim, { body: placeReceipt('## Summary\n\nProse.\n', { schema_version: 1, pr: 8, head: reviewed, base: 'main' } as any), head });
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', path.join(repo.root, 'run')],
      { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended', GSTACK_CAPY: '1', PATH: `${shim}:${process.env.PATH}` });
    expect(out.status, out.err).toBe(0);
    expect(out.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    expect(gh.writes()).toEqual([]);
    const [h] = handedOff(out.out);
    expect(h!.body).toContain('## Summary\n\nProse.\n');
    expect(h!.body).toContain(head);
  });
});
