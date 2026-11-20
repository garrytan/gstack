/**
 * GST-3183: on Capy (GSTACK_CAPY=1) the machine's gh is signed in as the owner's personal GitHub account, so a gh write
 * from /ship lands under their name. GBEV-105 (2026-11-19) saw `gstack-ship-receipt stub` edit an outside system's PR
 * body that way during an unattended /ship. Every /ship write path now hands the exact bytes to the host's PR tool
 * instead: it writes them to a private file and prints one HOST_PUBLISH: line. A recording gh shim proves no write call
 * reaches gh, and the negative control proves the shim does record one when GSTACK_CAPY is unset.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

/**
 * A gh on PATH that appends each call's argv (tab-separated) to calls.log and answers the reads /ship makes. `repo` is
 * what `gh repo view --json nameWithOwner,url` answers for the checkout (null: the read fails); a named repository answers
 * as itself on github.com.
 */
function recordingGh(dir: string, pr: { body: string; head?: string }, repo: { nameWithOwner: string; url: string } | null = { nameWithOwner: 'fx/fx', url: 'https://github.com/fx/fx' }) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'body.md'), pr.body);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ body: pr.body, headRefOid: pr.head ?? 'f'.repeat(40) }));
  if (repo) fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(repo));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\t' "$a"; done >> "${log}"; printf '\\n' >> "${log}"`,
    'case "$*" in',
    `  "pr view "*"--jq .body"*) cat "${path.join(dir, 'body.md')}"; exit 0 ;;`,
    '  "pr view "*"--jq .createdAt"*) echo 2026-11-19T00:00:00Z; exit 0 ;;',
    `  "pr view "*) cat "${path.join(dir, 'pr.json')}"; exit 0 ;;`,
    '  "pr list "*) echo "[]"; exit 0 ;;',
    `  "repo view --json nameWithOwner"*) cat "${path.join(dir, 'repo.json')}" 2>/dev/null || { echo "no git remotes found" >&2; exit 1; }; exit 0 ;;`,
    '  "repo view "*"--json nameWithOwner"*) printf \'{"nameWithOwner":"%s","url":"https://github.com/%s"}\\n\' "$3" "$3"; exit 0 ;;',
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

/**
 * Where each HOST_PUBLISH: line sends its write: op, target, and every key=value (or bare draft) before the first file.
 * The host tool has nothing else to go on, so a missing repo= sends the write to whatever repository it defaults to.
 */
function destinations(stdout: string): Array<Record<string, string | true>> {
  return stdout.split('\n').filter(l => l.startsWith('HOST_PUBLISH: ')).map(l => {
    const [op, target, ...rest] = l.slice('HOST_PUBLISH: '.length).split(' ');
    const d: Record<string, string | true> = { op: op!, target: target! };
    for (const t of rest) {
      if (/^\w+-file=/.test(t) || t.startsWith('(')) break;
      const eq = t.indexOf('=');
      d[eq < 0 ? t : t.slice(0, eq)] = eq < 0 ? true : t.slice(eq + 1);
    }
    return d;
  });
}

function capyRepo(repo?: { nameWithOwner: string; url: string } | null) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
  fxs.push(f);
  const gh = recordingGh(path.join(f.root, 'gh'), { body: 'Fixes a thing.\n' }, repo);
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
    expect(destinations(out.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'fx/fx' }]);
    const again = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--repo', 'other/repo', '--run', 'r2']);
    expect(again.status, again.stderr).toBe(0);
    expect(destinations(again.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'other/repo' }]);
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
    expect(destinations(stop.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'fx/fx' }]);
    const g = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', r.head(), '--kind', 'extra-round', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)?.[1];
    expect(g).toBeDefined();
    const claim = r.run('gstack-ship-receipt', ['claim', '--pr', '7', '--run', 'r1', '--grant', g!]);
    expect(claim.status, claim.stderr).toBe(0);
    expect(claim.stdout).toContain('GRANT_CLAIMED: grant=' + g);
    expect(handedOff(claim.stdout)[0]!.body).toContain('"mark":"grant"');
    expect(destinations(claim.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'fx/fx' }]);
    expect(r.gh.writes()).toEqual([]);
  });

  test('in a two-repo thread, stub without --repo names the checkout\'s repository, not the primary one', () => {
    const primary = capyRepo({ nameWithOwner: 'acme/primary', url: 'https://github.com/acme/primary' });
    const second = capyRepo({ nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets' });
    const a = primary.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1']);
    const b = second.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1']);
    expect([a.status, b.status], a.stderr + b.stderr).toEqual([0, 0]);
    expect(destinations(a.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'acme/primary' }]);
    expect(destinations(b.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'acme/widgets' }]);
    expect([...primary.gh.writes(), ...second.gh.writes()]).toEqual([]);
  });

  test('stub names a GitHub Enterprise host beside the repo', () => {
    const r = capyRepo({ nameWithOwner: 'acme/tools', url: 'https://ghe.acme.test/acme/tools' });
    const out = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1']);
    expect(out.status, out.stderr).toBe(0);
    expect(destinations(out.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'acme/tools', host: 'ghe.acme.test' }]);
  });

  test('stub refuses, with no hand-off and no write, when the repository cannot be resolved', () => {
    const r = capyRepo(null);
    const out = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1']);
    expect(out.status).not.toBe(0);
    expect(out.stdout).not.toContain('HOST_PUBLISH:');
    expect(out.stderr).toContain('repo');
    expect(r.gh.writes()).toEqual([]);
  });

  test('gstack-post hands every write op to the host PR tool after its checks, with the bytes it would have sent', () => {
    const r = capyRepo();
    r.githubOrigin();
    const file = (name: string, text: string) => { const p = path.join(r.f.root, name); fs.writeFileSync(p, text); return p; };
    const body = file('body.md', 'Adds a thing for users.\n\n## Why\n\nBecause.\n');
    const title = file('title.txt', 'Add a thing for users\n');
    const comment = file('comment.md', 'A plain comment.\n');
    const ops: Array<[string, string[], string, Record<string, string | true>]> = [
      ['pr-body', ['pr-body', '7', '--body-file', body], 'body', { target: '7', repo: 'fx/fx' }],
      ['pr-title', ['pr-title', '7', '--title-file', title], 'title', { target: '7', repo: 'fx/fx' }],
      ['pr-comment', ['pr-comment', '7', '--body-file', comment], 'body', { target: '7', repo: 'fx/fx' }],
      ['issue-comment', ['issue-comment', '7', '--body-file', comment], 'body', { target: '7', repo: 'fx/fx' }],
      ['reply', ['reply', '7', '--to', '99', '--body-file', comment], 'body', { target: '7', repo: 'fx/fx', to: '99' }],
      ['pr-create', ['pr-create', '--base', 'main', '--head', 'feat', '--draft', '--title-file', title, '--body-file', body], 'title', { target: 'new', repo: 'fx/fx', base: 'main', head: 'feat', draft: true }],
      ['issue-create', ['issue-create', '--title-file', title, '--body-file', comment], 'title', { target: 'new', repo: 'fx/fx' }],
    ];
    for (const [op, args, part, dest] of ops) {
      const out = r.run('gstack-post', args);
      expect([op, out.status, out.stderr]).toEqual([op, 0, expect.any(String)]);
      expect(out.stdout).not.toContain('POSTED:');
      expect(destinations(out.stdout)).toEqual([{ op, ...dest }]);
      expect(handedOff(out.stdout)[0]![part]).toBeDefined();
    }
    expect(r.gh.writes()).toEqual([]);
    const pb = r.run('gstack-post', ['pr-body', '7', '--body-file', body]);
    expect(handedOff(pb.stdout)[0]!.body).toContain('<summary>Why</summary>');
  });

  test('in a fork checkout gstack-post names the repository gh resolves (gh repo set-default, GH_REPO), not origin', () => {
    const r = capyRepo({ nameWithOwner: 'upstream/fx', url: 'https://github.com/upstream/fx' });
    r.githubOrigin();
    r.f.git('remote', 'set-url', 'origin', 'https://github.com/forker/fx.git');
    const body = path.join(r.f.root, 'b.md');
    fs.writeFileSync(body, 'Adds a thing for users.\n\n## Why\n\nBecause.\n');
    const comment = path.join(r.f.root, 'c.md');
    fs.writeFileSync(comment, 'A plain comment.\n');
    for (const [op, args] of [['pr-body', ['pr-body', '7', '--body-file', body]], ['pr-comment', ['pr-comment', '7', '--body-file', comment]]] as const) {
      const out = r.run('gstack-post', [...args]);
      expect(out.status, out.stderr).toBe(0);
      expect(destinations(out.stdout)).toEqual([{ op, target: '7', repo: 'upstream/fx' }]);
    }
    const byUrl = r.run('gstack-post', ['pr-comment', 'https://github.com/forker/fx/pull/7', '--body-file', comment]);
    expect(byUrl.status).toBe(64);
    expect(byUrl.stdout).not.toContain('HOST_PUBLISH:');
    expect(byUrl.stderr).toContain('upstream/fx');
    expect(r.gh.writes()).toEqual([]);
  });

  test('gstack-post refuses, with no hand-off and no write, when gh cannot resolve the repository', () => {
    const r = capyRepo(null);
    r.githubOrigin();
    const comment = path.join(r.f.root, 'c.md');
    fs.writeFileSync(comment, 'A plain comment.\n');
    const out = r.run('gstack-post', ['pr-comment', '7', '--body-file', comment]);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('HOST_PUBLISH:');
    expect(out.stderr).toContain('cannot resolve the repository');
    expect(r.gh.writes()).toEqual([]);
  });

  test('gstack-post names a GitHub Enterprise host, and the branch gh pr create would have used as head', () => {
    const r = capyRepo({ nameWithOwner: 'acme/tools', url: 'https://github.acme.test/acme/tools' });
    r.githubOrigin();
    r.f.git('remote', 'set-url', 'origin', 'https://github.acme.test/acme/tools.git');
    const comment = path.join(r.f.root, 'c.md');
    fs.writeFileSync(comment, 'A plain comment.\n');
    const title = path.join(r.f.root, 't.txt');
    fs.writeFileSync(title, 'Add a thing for users\n');
    const body = path.join(r.f.root, 'b.md');
    fs.writeFileSync(body, 'Adds a thing for users.\n\n## Why\n\nBecause.\n');
    const c = r.run('gstack-post', ['pr-comment', '7', '--body-file', comment]);
    expect(c.status, c.stderr).toBe(0);
    expect(destinations(c.stdout)).toEqual([{ op: 'pr-comment', target: '7', repo: 'acme/tools', host: 'github.acme.test' }]);
    const branch = r.f.git('branch', '--show-current').stdout.trim();
    expect(branch).not.toBe('');
    const n = r.run('gstack-post', ['pr-create', '--base', 'main', '--title-file', title, '--body-file', body]);
    expect(n.status, n.stderr).toBe(0);
    expect(destinations(n.stdout)).toEqual([{ op: 'pr-create', target: 'new', repo: 'acme/tools', host: 'github.acme.test', base: 'main', head: branch }]);
    expect(r.gh.writes()).toEqual([]);
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

  test('gstack-post pr-create on Capy with a detached HEAD and no --head refuses with no hand-off', () => {
    const r = capyRepo();
    r.githubOrigin();
    const title = path.join(r.f.root, 't.txt');
    fs.writeFileSync(title, 'Add a thing for users\n');
    const body = path.join(r.f.root, 'b.md');
    fs.writeFileSync(body, 'Adds a thing for users.\n\n## Why\n\nBecause.\n');
    r.f.git('checkout', '-q', '--detach');
    const out = r.run('gstack-post', ['pr-create', '--base', 'main', '--title-file', title, '--body-file', body]);
    expect(out.status).toBe(64);
    expect(out.stderr).toContain('--head <branch>');
    expect(out.stdout).not.toContain('HOST_PUBLISH:');
    expect(r.gh.writes()).toEqual([]);
  });

  test('a hand-off that cannot be written is a failure with no HOST_PUBLISH line, never a HIGH refusal', () => {
    const r = capyRepo();
    r.githubOrigin();
    const blocked = path.join(r.f.root, 'not-a-dir');
    fs.writeFileSync(blocked, '');
    const comment = path.join(r.f.root, 'c.md');
    fs.writeFileSync(comment, 'A plain comment.\n');
    const post = r.run('gstack-post', ['pr-comment', '7', '--body-file', comment], { GSTACK_STATE_ROOT: blocked });
    expect(post.status).toBe(3);
    expect(post.stderr).toContain('could not write the hand-off');
    expect(post.stdout).not.toContain('HOST_PUBLISH:');
    const stub = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1'], { GSTACK_STATE_ROOT: blocked });
    expect(stub.status).not.toBe(0);
    expect(stub.stderr).toContain('cannot write the hand-off');
    expect(stub.stdout).not.toContain('HOST_PUBLISH:');
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
    const gh = recordingGh(shim, { body: placeReceipt('## Summary\n\nProse.\n', { schema_version: 1, pr: 8, head: reviewed, base: 'main' } as any), head }, { nameWithOwner: 'acme/tools', url: 'https://ghe.acme.test/acme/tools' });
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', path.join(repo.root, 'run')],
      { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended', GSTACK_CAPY: '1', PATH: `${shim}:${process.env.PATH}` });
    expect(out.status, out.err).toBe(0);
    expect(out.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    expect(gh.writes()).toEqual([]);
    expect(destinations(out.out)).toEqual([{ op: 'pr-body', target: '8', repo: 'acme/tools', host: 'ghe.acme.test' }]);
    const [h] = handedOff(out.out);
    expect(h!.body).toContain('## Summary\n\nProse.\n');
    expect(h!.body).toContain(head);
  });
});

/** The real gh on PATH (on a Capy machine the wrapper's gh.real), pointed at a fake GitHub API on a unix socket it owns. */
const REAL_GH = Bun.which('gh.real') ?? Bun.which('gh');
async function fakeGithub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  const sock = path.join(dir, 's');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'config.yml'), `http_unix_socket: ${sock}\n`);
  fs.writeFileSync(path.join(dir, 'srv.ts'), [
    'Bun.serve({ unix: process.argv[2], async fetch(req) {',
    '  let v = {}; try { v = JSON.parse(await req.text()).variables || {}; } catch {}',
    '  const owner = v.owner, name = v.name || v.repo;',
    "  return Response.json({ data: { repository: { id: 'R', name, owner: { login: owner }, nameWithOwner: owner + '/' + name, url: 'https://github.com/' + owner + '/' + name, pullRequest: { id: 'P', number: v.pr_number || 7, body: 'Fixes a thing.\\n' } } } });",
    '} });', '',
  ].join('\n'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(REAL_GH!, path.join(bin, 'gh'));
  const server = Bun.spawn([process.execPath, path.join(dir, 'srv.ts'), sock], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await Bun.sleep(50);
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_CONFIG_DIR: cfg, GH_TOKEN: 'fake', GH_HOST: 'github.com', GH_ENTERPRISE_TOKEN: '', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };
  return { env, stop: () => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('GH_REPO and fork heads on the HOST_PUBLISH hand-off (#4518 follow-up)', () => {
  // Value: protects=with GH_REPO set, both hand-off paths name the repository gh's own write would have used, as real gh
  //   resolves it (gh repo view ignores GH_REPO; gh pr view and edit honour it); fails_when=the destination read drops GH_REPO
  //   and names origin's repository; seam=bin/gstack-post and bin/gstack-ship-receipt with real gh over a fake API socket
  test.skipIf(!REAL_GH || process.platform === 'win32')('real gh: gstack-post and stub name GH_REPO, not origin', async () => {
    const r = capyRepo();
    r.githubOrigin();
    r.f.git('remote', 'set-url', 'origin', 'https://github.com/forker/fx.git');
    const gh = await fakeGithub();
    try {
      const comment = path.join(r.f.root, 'c.md');
      fs.writeFileSync(comment, 'A plain comment.\n');
      const post = r.run('gstack-post', ['pr-comment', '7', '--body-file', comment], { ...gh.env, GH_REPO: 'upstream/fx' });
      expect(post.status, post.stderr).toBe(0);
      expect(destinations(post.stdout)).toEqual([{ op: 'pr-comment', target: '7', repo: 'upstream/fx' }]);
      const stub = r.run('gstack-ship-receipt', ['stub', '--pr', '7', '--run', 'r1'], { ...gh.env, GH_REPO: 'upstream/fx' });
      expect(stub.status, stub.stderr).toBe(0);
      expect(destinations(stub.stdout)).toEqual([{ op: 'pr-body', target: '7', repo: 'upstream/fx' }]);
    } finally { gh.stop(); }
  });

  // Value: protects=a pr-create hand-off from a fork checkout names owner:branch, as gh pr create would, and refuses when the
  //   fork is on another host; fails_when=head= is the bare branch, which the base repository reads as its own; seam=bin/gstack-post
  test('a fork pr-create names the head as origin-owner:branch, or refuses across hosts', () => {
    const title = (r: ReturnType<typeof capyRepo>) => { const t = path.join(r.f.root, 't.txt'); fs.writeFileSync(t, 'Add a thing for users\n'); return t; };
    const body = (r: ReturnType<typeof capyRepo>) => { const b = path.join(r.f.root, 'b.md'); fs.writeFileSync(b, 'Adds a thing for users.\n\n## Why\n\nBecause.\n'); return b; };
    const r = capyRepo({ nameWithOwner: 'upstream/fx', url: 'https://github.com/upstream/fx' });
    r.githubOrigin();
    r.f.git('remote', 'set-url', 'origin', 'https://github.com/forker/fx.git');
    const branch = r.f.git('branch', '--show-current').stdout.trim();
    const n = r.run('gstack-post', ['pr-create', '--base', 'main', '--title-file', title(r), '--body-file', body(r)]);
    expect(n.status, n.stderr).toBe(0);
    expect(destinations(n.stdout)).toEqual([{ op: 'pr-create', target: 'new', repo: 'upstream/fx', base: 'main', head: `forker:${branch}` }]);
    const named = r.run('gstack-post', ['pr-create', '--base', 'main', '--head', 'someone:topic', '--title-file', title(r), '--body-file', body(r)]);
    expect(destinations(named.stdout)).toEqual([{ op: 'pr-create', target: 'new', repo: 'upstream/fx', base: 'main', head: 'someone:topic' }]);
    const far = capyRepo({ nameWithOwner: 'upstream/fx', url: 'https://github.acme.test/upstream/fx' });
    far.githubOrigin();
    far.f.git('remote', 'set-url', 'origin', 'https://github.com/forker/fx.git');
    const refused = far.run('gstack-post', ['pr-create', '--base', 'main', '--title-file', title(far), '--body-file', body(far)]);
    expect(refused.status).toBe(64);
    expect(refused.stdout).not.toContain('HOST_PUBLISH:');
    expect(refused.stderr).toContain('pass --head <owner>:<branch>');
    expect([...r.gh.writes(), ...far.gh.writes()]).toEqual([]);
  });
});

