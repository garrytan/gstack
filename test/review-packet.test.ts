/**
 * gstack-review-packet: each /ship reviewer reads one packet file and the parent reads only
 * collect's record (docs/review-policy.md#reviewer-packets). Fixture repositories live under
 * the OS temp directory, outside this checkout, and every seed commit is asserted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as P from '../lib/review-prompts';
import { READ_CHUNK_BYTES, readManifest, shardChunks } from '../lib/review-packet';
import { parseNext } from '../lib/ship-budget';

const ROOT = path.join(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-review-packet');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

interface Repo { dir: string; state: string; out: string }
function repo(base: Record<string, string>, feat: Record<string, string>, untracked: Record<string, string> = {}): Repo {
  const dir = tmp('review-packet-');
  expect(path.relative(ROOT, dir).startsWith('..')).toBe(true);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  const write = (files: Record<string, string>) => { for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  write({ 'README.md': '# x\n', ...base });
  git('add', '.');
  expect(git('commit', '-qm', 'base').status).toBe(0);
  git('checkout', '-qb', 'feat');
  write(feat);
  git('add', '.');
  expect(git('commit', '-qm', 'feat').status).toBe(0);
  write(untracked);
  return { dir, state: tmp('review-packet-state-'), out: tmp('review-packet-out-') };
}
const run = (r: Repo, args: string[]) => spawnSync(BIN, args, { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
const build = (r: Repo, extra: string[] = []) => run(r, ['build', '--base', 'main', '--gate-tagged', '0', '--out-dir', r.out, ...extra]);
const packets = (stdout: string) => [...stdout.matchAll(/^PACKET: (\S+) (\S+) effort=\S+ bytes=(\d+) tokens~=\d+ budget_role=(\S+) read=(\S+) file=(\S+) out=(\S+)$/gm)].map(m => ({ role: m[1]!, name: m[2]!, bytes: Number(m[3]), budgetRole: m[4]!, read: m[5]!.split(',').map(r => r.split('-').map(Number) as [number, number]), file: m[6]!, out: m[7]!, text: fs.readFileSync(m[6]!, 'utf8') }));
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const readManifestOf = (dir: string) => readManifest(dir)!.packets;
const checklist = (name: string) => fs.readFileSync(path.join(ROOT, 'review', 'specialists', `${name}.md`), 'utf8');

describe('gstack-review-packet build', () => {
  test('a packet holds its instructions, contract, checklist, the diff and read budget, and no other repository content', () => {
    const r = repo({ 'src/unrelated.ts': 'export const UNRELATED_MARKER = 1;\n' }, { 'src/a.ts': lines(80, 'alpha') });
    const b = build(r);
    expect(b.status).toBe(0);
    const all = packets(b.stdout);
    const testing = all.find(p => p.name === 'testing')!;
    expect(testing.text).toContain(P.SPECIALIST_INTRO);
    expect(testing.text).toContain(P.SPECIALIST_CONTRACT.replace('{TEST_FW}', 'unknown'));
    expect(testing.text).toContain(checklist('testing'));
    expect(testing.text).toContain('+export const alpha79 = 79;');
    expect(testing.text).toContain(P.READ_BUDGET);
    expect(testing.text).toContain(`Output path: \`${testing.out}\``);
    expect(testing.text).toContain('DONE testing crit=<n> info=<n>');
    for (const p of all) expect(p.text).not.toContain('UNRELATED_MARKER');
    expect(b.stdout).toMatch(/^PACKETS: n=\d+ total_bytes=\d+ fingerprint=\S+$/m);
    expect(all.find(p => p.name === 'adversarial')!.text).toContain(P.ADVERSARIAL_NATIVE);
  });

  test('the defensive framing reaches the security and adversarial packets with fixtures as a stat; testing reads fixtures in full', () => {
    const r = repo({}, { 'src/auth/login.ts': lines(120, 'auth'), 'test/login.test.ts': 'PAYLOAD_MARKER\n' });
    const all = packets(build(r, ['--force', 'security']).stdout);
    for (const name of ['security', 'adversarial']) {
      const p = all.find(x => x.name === name)!;
      expect(p.text).toContain(P.DEFENSIVE_REVIEW_FRAMING);
      expect(p.text).toContain(P.FIXTURE_SUMMARY_PACKET);
      expect(p.text).not.toContain('+PAYLOAD_MARKER');
      expect(p.text).toContain('test/login.test.ts');
    }
    const testing = all.find(x => x.name === 'testing')!;
    expect(testing.text).not.toContain(P.DEFENSIVE_REVIEW_FRAMING);
    expect(testing.text).toContain('+PAYLOAD_MARKER');
  });

  test('light depth: the batched specialist inlines every checklist its plan line names', () => {
    const r = repo({}, { 'src/a.ts': lines(10, 'beta') });
    const plan = spawnSync(path.join(ROOT, 'bin', 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    const named = /DISPATCH: specialist batched effort=\S+ checklists=(\S+)/.exec(plan.stdout)![1]!.split(',');
    expect(named).toContain('red-team');
    const batched = packets(build(r).stdout).find(p => p.name === 'batched')!;
    for (const c of named) {
      expect(batched.text).toContain(`## Checklist: ${c}`);
      expect(batched.text).toContain(checklist(c));
    }
    expect(batched.text).toContain('Tag each finding with the checklist that found it');
  });

  test('exclusions are honored: maintainability leaves out docs and tests; testing keeps tests; untracked files are in', () => {
    const r = repo({}, { 'src/a.ts': lines(80, 'gamma'), 'docs/guide.md': '# Guide\nDOCS_MARKER\n', 'test/a.test.ts': 'TEST_MARKER\n' }, { 'src/new.ts': 'UNTRACKED_MARKER\n' });
    const all = packets(build(r).stdout);
    const m = all.find(p => p.name === 'maintainability')!;
    const t = all.find(p => p.name === 'testing')!;
    expect(m.text).not.toContain('+DOCS_MARKER');
    expect(m.text).not.toContain('+TEST_MARKER');
    expect(m.text).toContain('+UNTRACKED_MARKER');
    expect(t.text).toContain('+TEST_MARKER');
    expect(t.text).not.toContain('+DOCS_MARKER');
  });

  test('a diff past the cap is sharded by path: every path and every line survives, each packet under the cap', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = lines(400, `v${i}_`);
    const r = repo({}, files);
    const b = build(r, ['--only', 'testing']);
    expect(b.status).toBe(0);
    const shards = packets(b.stdout);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.map(s => s.name)).toEqual(shards.map((_, i) => `testing.${i + 1}of${shards.length}`));
    for (const s of shards) { expect(s.bytes).toBeLessThanOrEqual(200_000); expect(s.text).toContain(checklist('testing')); }
    const diffs = shards.map(s => s.text.slice(s.text.indexOf('## Diff (')));
    for (let i = 0; i < 30; i++) {
      expect(diffs.filter(d => d.includes(`diff --git a/src/f${i}.ts b/src/f${i}.ts`)).length).toBe(1);
      expect(diffs.some(d => d.includes(`+export const v${i}_399 = 399;`))).toBe(true);
    }
  });

  test('shardChunks splits a file at hunks and gives a hunk over the budget its own oversize shard, never truncated', () => {
    const header = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n';
    const big = '@@ -1 +1 @@\n' + '+y\n'.repeat(100);
    const small = '@@ -50 +50 @@\n+z\n';
    const shards = shardChunks([header + small + big + small, 'diff --git a/w b/w\n@@ -1 +1 @@\n+w\n'], 120);
    expect(shards.some(s => s.oversize && s.text === header + big)).toBe(true);
    expect(shards.map(s => s.text).join('').replaceAll(header, '')).toContain(big);
    expect(shards.at(-1)!.text).toContain('+w');
  });

  test('the Red Team is deferred until collect; with --findings it reads them, the framing and fixtures in summary mode', () => {
    const r = repo({}, { 'src/a.ts': lines(260, 'delta'), 'test/fixture.test.ts': 'PAYLOAD_MARKER\n' });
    expect(build(r).stdout).toContain('PACKET_DEFERRED: red-team');
    const merged = path.join(r.out, 'merged.jsonl');
    fs.writeFileSync(merged, JSON.stringify({ severity: 'CRITICAL', path: 'src/a.ts', line: 3, summary: 'KNOWN_FINDING', sources: ['testing'] }) + '\n');
    const red = packets(build(r, ['--only', 'red-team', '--findings', merged]).stdout)[0]!;
    expect(red.name).toBe('red-team');
    expect(red.text).toContain('KNOWN_FINDING');
    expect(red.text).toContain(P.DEFENSIVE_REVIEW_FRAMING);
    expect(red.text).toContain(P.RED_TEAM_OUTPUT);
    expect(red.text).toContain(checklist('red-team'));
    expect(red.text).not.toContain('+PAYLOAD_MARKER');
    expect(red.text).toContain('test/fixture.test.ts');
    const manifest = JSON.parse(fs.readFileSync(path.join(r.out, 'manifest.json'), 'utf8'));
    expect(manifest.packets.some((p: any) => p.name === 'testing')).toBe(true);
  });

  test('fix-check: the packet carries the fix-check prompt, the parent files and the --range hunks; missing inputs refuse', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'eps') });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    fs.appendFileSync(path.join(r.dir, 'src/a.ts'), 'export const FIXED = 1;\n');
    const flags = ['--pass', '1', '--last', 'full', '--fixed-below', '--range', head];
    expect(build(r, flags).status).toBe(2);
    const w = (n: string, t: string) => { const f = path.join(r.state, n); fs.writeFileSync(f, t); return f; };
    const b = build(r, [...flags, '--fix-list', w('fix.txt', 'FIX_LIST_MARKER'), '--tests', w('tests.txt', '12 pass')]);
    const fc = packets(b.stdout).find(p => p.role === 'fix-check')!;
    expect(fc.text).toContain(P.FIX_CHECK_INSTRUCTIONS);
    expect(fc.text).toContain('FIX_LIST_MARKER');
    expect(fc.text).toContain('+export const FIXED = 1;');
    expect(fc.text).not.toContain('+export const eps0 = 0;');
  });

  test('audits: the packet carries the generated section prompt fence with the base filled in', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'zeta') });
    const a = packets(build(r, ['--audit', 'test-coverage', '--generation', 'audit-only', '--passes-used', '1']).stdout)[0]!;
    expect(a.text).toContain('You are running a ship-workflow test coverage audit. Run `git diff main`');
    expect(a.text).toContain('Generation: audit-only; passes used: 1 of 2.');
    expect(a.text).toContain('+export const zeta19 = 19;');
    expect(build(r, ['--audit', 'plan-completion']).status).toBe(2);
  });

  // Value: protects=--base origin/main names origin/main in the audit prompt; fails_when=the prompt prefixes origin/ to a ref that already has it (git diff origin/origin/main);
  //   why_new=every build test passes --base main with no origin remote; seam=none; no_claim=a base with no origin remote (covered: it stays as given)
  test('--base origin/main and --base main both put origin/main in the audit prompt, never origin/origin/main', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'kappa') });
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: r.dir, timeout: 10_000 });
    for (const base of ['origin/main', 'main']) {
      const b = run(r, ['build', '--base', base, '--gate-tagged', '0', '--out-dir', r.out, '--audit', 'test-coverage']);
      expect(b.status).toBe(0);
      const a = packets(b.stdout)[0]!;
      expect(a.text).toContain('Run `git diff origin/main`');
      expect(a.text).not.toContain('origin/origin/');
    }
  });

  // Value: protects=every PACKET line names a role gstack-ship-budget accepts and build prints one ready BUDGET_NEXT; fails_when=a packet or shard name leaks into --next and check exits 2;
  //   why_new=no test joins the packet path to the budget's role contract; seam=none; no_claim=the budget's per-role pricing
  test('PACKET lines carry a budget_role the budget accepts; BUDGET_NEXT lists one role per packet, shards keep their parent role', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = lines(400, `w${i}_`);
    const r = repo({}, files);
    const b = build(r, ['--only', 'testing,adversarial,outside-voice']);
    expect(b.status).toBe(0);
    const ps = packets(b.stdout);
    expect(ps.some(p => p.name.startsWith('testing.1of'))).toBe(true);
    const want: Record<string, string> = { specialist: 'specialist', 'adversarial-native': 'adversarial-native', 'outside-voice': 'outside-voice' };
    for (const p of ps) expect(p.budgetRole).toBe(want[p.role]!);
    const next = /^BUDGET_NEXT: (\S+)$/m.exec(b.stdout)![1]!;
    expect(next).toBe(`dispatch:${ps.map(p => p.budgetRole).join(',')}`);
    expect(parseNext(next)).toEqual({ kind: 'dispatch', roles: ps.map(p => p.budgetRole) });
    const a = build(r, ['--audit', 'test-coverage']);
    expect(packets(a.stdout)[0]!.budgetRole).toBe('specialist');
    expect(a.stdout).toMatch(/^BUDGET_NEXT: dispatch:specialist$/m);
  });

  // Value: protects=a packet is read whole in one turn: its read= ranges cover every line, each under the read tool's measured budget, and it ends with END OF PACKET; fails_when=a range overruns the budget (silently truncated read) or a line falls between ranges;
  //   why_new=no test reads a packet the way a reviewer does; seam=none; no_claim=the host's read budget itself (measured on Capy at ~37.8K chars)
  test('read= ranges cover the packet line for line, each range under READ_CHUNK_BYTES, ending at END OF PACKET', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/g${i}.ts`] = lines(300, `r${i}_`);
    const r = repo({}, files);
    const ps = packets(build(r, ['--only', 'testing,maintainability']).stdout);
    expect(ps.map(p => p.name).sort()).toEqual(['maintainability', 'testing']);
    expect(ps.every(p => p.read.length > 1)).toBe(true);
    for (const p of ps) {
      const all = p.text.split('\n');
      expect(p.text.trimEnd().split('\n').at(-1)).toBe(`END OF PACKET ${p.name}`);
      let next = 1;
      for (const [from, to] of p.read) {
        expect(from).toBe(next);
        expect(Buffer.byteLength(all.slice(from - 1, to).join('\n'))).toBeLessThanOrEqual(READ_CHUNK_BYTES);
        next = to + 1;
      }
      expect(next - 1).toBeGreaterThanOrEqual(p.text.trimEnd().split('\n').length);
    }
  });

  // Value: protects=large data-format additions (#34's wiki *.json) reach reviewers as a summary (stat, head and tail, top-level keys), so each role gets one packet; fails_when=data files ride the diff whole and every role shards;
  //   why_new=FIXTURE_PATHSPECS misses data files outside test paths; seam=none; no_claim=reviewing the data content itself (testing still reads data under test/)
  test('a #34-shaped diff (three ~70 KB wiki JSON files and a small code change) gives every role one packet; testing still reads data under test/', () => {
    const big = (tag: string) => JSON.stringify({ pages: Array.from({ length: 1400 }, (_, i) => ({ id: `${tag}-${i}`, title: `Page ${i}`, body: 'lorem ipsum dolor' })), meta: { tag } }, null, 1) + '\n';
    const r = repo({}, { 'wiki/a.json': big('a'), 'wiki/b.json': big('b'), 'wiki/c.json': big('c'), 'test/fixtures/d.json': big('d'), 'src/a.ts': lines(60, 'lam'), 'package.json': '{"name":"x"}\n' });
    const b = build(r, ['--only', 'testing,maintainability,security,adversarial']);
    expect(b.status).toBe(0);
    const ps = packets(b.stdout);
    expect(ps.map(p => p.name).sort()).toEqual(['adversarial', 'maintainability', 'security', 'testing']);
    for (const p of ps) {
      expect(p.text).toContain('DATA SUMMARY: wiki/a.json');
      expect(p.text).toContain('top-level keys: pages, meta');
      expect(p.text).not.toContain('"id": "a-700"');
      expect(p.text).toContain('+export const lam59 = 59;');
    }
    expect(ps.find(p => p.name === 'testing')!.text).toContain('"id": "d-700"');
    expect(ps.find(p => p.name === 'maintainability')!.text).not.toContain('"id": "d-700"');
  });

  // Value: protects=a data summary is built from the diff alone, so no file outside the diff reaches a packet; fails_when=topLevelKeys reads the working tree and follows a symlink that replaced a large CSV;
  //   why_new=the #34 test adds plain files only; seam=none; no_claim=other symlink shapes git shows as one-line diffs
  test('a large CSV replaced by a symlink to a private file: the summary never reads the link target', () => {
    const secret = path.join(tmp('review-packet-secret-'), 'id_key');
    fs.writeFileSync(secret, 'PRIVATE-KEY-MATERIAL-7f3a,never,in,a,packet\n');
    const csv = 'id,name,score\n' + Array.from({ length: 500 }, (_, i) => `${i},row${i},${i % 7}`).join('\n') + '\n';
    const r = repo({ 'data/scores.csv': csv }, { 'src/a.ts': lines(5, 'nu') });
    fs.rmSync(path.join(r.dir, 'data/scores.csv'));
    fs.symlinkSync(secret, path.join(r.dir, 'data/scores.csv'));
    const b = build(r, ['--only', 'security,outside-voice']);
    expect(b.status).toBe(0);
    const ps = packets(b.stdout);
    expect(ps.map(p => p.name).sort()).toEqual(['outside-voice', 'security']);
    for (const p of ps) {
      expect(p.text).toContain('DATA SUMMARY: data/scores.csv');
      expect(p.text).not.toContain('PRIVATE-KEY-MATERIAL');
    }
  });

  // Value: protects=a partial build after the head moved drops the old run's reviewers and their outputs; fails_when=writeManifest keeps entries from another head, so stale clean results count as coverage of new code;
  //   why_new=partial-build tests stay on one head; seam=none; no_claim=a working-tree edit at the same head beyond the one exercised here
  test('a partial build keeps other reviewers only at the same head, base and content; otherwise it starts over, and a Red Team build refuses', () => {
    const r = repo({}, { 'src/a.ts': lines(80, 'mu') });
    const first = packets(build(r, ['--only', 'testing,maintainability']).stdout);
    for (const p of first) fs.writeFileSync(p.out, 'NO FINDINGS\n');
    expect(build(r, ['--only', 'testing']).status).toBe(0);
    expect(readManifestOf(r.out).map(p => p.reviewer).sort()).toEqual(['maintainability', 'testing']);
    fs.writeFileSync(path.join(r.dir, 'src/a.ts'), lines(81, 'mu'));
    fs.writeFileSync(path.join(r.out, 'merged.jsonl'), '');
    const red = build(r, ['--only', 'red-team', '--findings', path.join(r.out, 'merged.jsonl')]);
    expect(red.status).toBe(3);
    expect(red.stdout).toContain('STALE_MANIFEST: content changed');
    expect(readManifestOf(r.out).map(p => p.reviewer).sort()).toEqual(['maintainability', 'testing']);
    expect(build(r, ['--only', 'testing']).status).toBe(0);
    expect(readManifestOf(r.out).map(p => p.reviewer)).toEqual(['testing']);
    expect(fs.existsSync(first.find(p => p.name === 'maintainability')!.out)).toBe(false);
  });

  // Value: protects=a Step 7/8 audit past the packet cap stays one packet holding the whole diff, so the parent gets one coverage or plan verdict and one generation allowance; fails_when=audits shard like reviewers (a plan item built in another shard reads NOT DONE, each shard generates tests);
  //   why_new=the sharding test covers reviewers only; seam=none; no_claim=how a child reads a packet past its context (it reads the file in ranges)
  test('an audit past the cap is never sharded: one packet, every path of the diff', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = lines(400, `v${i}_`);
    const r = repo({}, files);
    fs.writeFileSync(path.join(r.state, 'plan.md'), '# Plan\n- [ ] add src/f0.ts\n');
    for (const extra of [['--audit', 'test-coverage'], ['--audit', 'plan-completion', '--plan-file', path.join(r.state, 'plan.md')]]) {
      const b = build(r, extra);
      expect(b.status).toBe(0);
      const ps = packets(b.stdout);
      expect(ps.map(p => p.name)).toEqual([extra[1]!]);
      expect(ps[0]!.bytes).toBeGreaterThan(200_000);
      expect(ps[0]!.text).not.toContain('This is shard');
      for (let i = 0; i < 30; i++) expect(ps[0]!.text).toContain(`+export const v${i}_399 = 399;`);
    }
  });
  // Value: protects=a full rebuild deletes the previous head's output files, so collect cannot count a stale review as fresh coverage; fails_when=writePackets/writeManifest stop removing old .out files;
  //   why_new=no test rebuilds over an out dir that holds results; seam=none; no_claim=removal of packets for reviewers absent from the new plan beyond the reviewer rebuilt here
  test('a rebuild clears earlier reviewer outputs: a stale result never stands as coverage of the new head', () => {
    const r = repo({}, { 'src/a.ts': lines(80, 'eta') });
    const first = packets(build(r, ['--only', 'testing']).stdout)[0]!;
    fs.writeFileSync(first.out, 'NO FINDINGS\n');
    expect(spawnSync(BIN, ['collect', '--dir', r.out], { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    expect(build(r, ['--only', 'testing']).status).toBe(0);
    expect(fs.existsSync(first.out)).toBe(false);
    const c = spawnSync(BIN, ['collect', '--dir', r.out], { encoding: 'utf8', timeout: 60_000 });
    expect(c.status).toBe(3);
    expect(c.stdout).toContain('REVIEWER: testing status=missing');
  });

  // Value: protects=build refuses bad inputs with usage exit 2 instead of writing packets; fails_when=an --audit name, unreadable --plan-file or non-commit --range is accepted;
  //   why_new=only missing fix-check inputs and plan-completion without a plan are tested; seam=none; no_claim=the stderr wording
  test('usage refusals: an unknown --audit, an unreadable --plan-file and a --range that is not a commit exit 2 with no packet', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'theta') });
    for (const extra of [['--audit', 'bogus'], ['--plan-file', path.join(r.state, 'nope.md')], ['--range', 'not-a-commit']]) {
      const b = build(r, extra);
      expect(b.status).toBe(2);
      expect(b.stdout).not.toContain('PACKET:');
    }
  });

  // Value: protects=build without --out-dir and collect without --dir refuse with usage exit 2 and write nothing; fails_when=either guard is dropped and the command defaults a directory (cwd) or crashes;
  //   why_new=every other test passes --out-dir/--dir; seam=none; no_claim=the stderr wording
  test('build without --out-dir and collect without --dir exit 2 and write nothing', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'iota') });
    const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout;
    const b = run(r, ['build', '--base', 'main', '--gate-tagged', '0']);
    expect(b.status).toBe(2);
    expect(b.stdout).not.toContain('PACKET:');
    const c = run(r, ['collect']);
    expect(c.status).toBe(2);
    expect(c.stdout).toBe('');
    expect(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout).toBe(before);
    expect(fs.readdirSync(r.out)).toEqual([]);
  });

  // Value: protects=the outside-voice packet carries CODEX_BOUNDARY_TEXT, OUTSIDE_CONTRACT and the verbatim-reply instruction; fails_when=the outside-voice role text drops the boundary, contract or reply line;
  //   why_new=only the resolver's boundary literal is compared, never the packet; seam=none; no_claim=that the outside model obeys the boundary
  test('the outside-voice packet carries the filesystem boundary, the severity contract and the verbatim-reply instruction', () => {
    const r = repo({}, { 'src/a.ts': lines(80, 'kappa') });
    const b = build(r, ['--only', 'outside-voice']);
    expect(b.status).toBe(0);
    const ov = packets(b.stdout).find(p => p.role === 'outside-voice')!;
    expect(ov.text).toContain(P.CODEX_BOUNDARY_TEXT);
    expect(ov.text).toContain(P.OUTSIDE_ADVERSARIAL);
    expect(ov.text).toContain(P.OUTSIDE_CONTRACT);
    expect(ov.text).toContain('the parent saves it verbatim to the output path below');
    expect(ov.text).toContain('+export const kappa79 = 79;');
  });

  // Value: protects=packets written under an in-repo --out-dir or anything under .gstack/tmp never enter a later packet's diff; fails_when=the insideOut skip is dropped, so a rebuild reviews the previous packets (and their diffs);
  //   why_new=every other test writes --out-dir outside the fixture repo; seam=none; no_claim=a later build into a different out dir, or tracked files under the out dir
  test('packets under an in-repo --out-dir and files under .gstack/tmp never appear in a later packet\'s diff', () => {
    const r = repo({}, { 'src/a.ts': lines(80, 'lambda') });
    fs.mkdirSync(path.join(r.dir, '.gstack/tmp/other'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.gstack/tmp/other/stray.md'), 'STRAY_TMP_MARKER\n');
    const inRepo = path.join(r.dir, 'review-out');
    const first = run(r, ['build', '--base', 'main', '--gate-tagged', '0', '--out-dir', inRepo, '--only', 'testing']);
    expect(first.status).toBe(0);
    expect(fs.readdirSync(inRepo).some(f => f.endsWith('.packet.md'))).toBe(true);
    const second = run(r, ['build', '--base', 'main', '--gate-tagged', '0', '--out-dir', inRepo]);
    expect(second.status).toBe(0);
    const all = packets(second.stdout);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.text).toContain('+export const lambda79 = 79;');
      expect(p.text).not.toContain('diff --git a/review-out/');
      expect(p.text).not.toMatch(/^ review-out\/\S* \|/m);
      expect(p.text).not.toContain('diff --git a/.gstack/tmp/');
      expect(p.text).not.toMatch(/^ \.gstack\/tmp\/\S* \|/m);
      expect(p.text).not.toContain('STRAY_TMP_MARKER');
    }
  });
});

describe('the packet prose and the generated SKILL.md prose are one text', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const quoted = (s: string) => s.replaceAll('"', '\\"');
  test('/review renders the shared specialist, Red Team and adversarial prompts; /ship renders the packet brief', () => {
    expect(read('review/sections/review-army.md')).toContain(quoted(P.SPECIALIST_CONTRACT));
    expect(read('review/sections/review-army.md')).toContain(P.RED_TEAM_INTRO);
    expect(read('review/sections/review-army.md')).toContain(P.RED_TEAM_OUTPUT);
    expect(read('review/sections/adversarial.md')).toContain(P.ADVERSARIAL_NATIVE);
    expect(read('review/sections/adversarial.md')).toContain(P.OUTSIDE_ADVERSARIAL);
    expect(read('ship/sections/review-army.md')).toContain(P.packetBrief('<file>', '<out>'));
    expect(read('ship/sections/adversarial.md')).toContain(P.packetBrief('<file>', '<out>'));
    expect(read('ship/sections/test-coverage.md')).toContain(P.packetBrief('<file>', '<out>'));
  });
  test('the outside voice boundary the safety-rule registry pins in the resolver is the packet\'s boundary', () => {
    const line = read('scripts/resolvers/outside-voice-steps.ts').split('\n').find(l => l.startsWith('const CODEX_BOUNDARY = '))!;
    expect(line).toBe(`const CODEX_BOUNDARY = '${P.CODEX_BOUNDARY_TEXT}\\\\n\\\\n';`);
  });
  // Value: protects=every gstack-review-packet command the /ship sections tell the parent to run uses only flags the binary documents; fails_when=a flag is renamed in the bin or the prose keeps a retired one (--hunks);
  //   why_new=build tests drive the bin directly, never the commands the prose names; seam=none; no_claim=flag values, argument order and the prose's "plus that plan run's flags" composition
  test('/ship prose names only gstack-review-packet flags the binary documents', () => {
    const known = new Set(spawnSync(BIN, ['--help'], { encoding: 'utf8', timeout: 30_000 }).stdout.match(/--[a-z][a-z-]*/g)!);
    const spans: string[] = [];
    for (const s of ['review-army', 'adversarial', 'test-coverage', 'plan-completion']) {
      const text = read(`ship/sections/${s}.md`);
      spans.push(...(text.match(/`[^`]*gstack-review-packet (?:build|collect)[^`]*`/g) ?? []));
      spans.push(...(text.match(/build its packet with that plan run's flags plus `[^`]*`/g) ?? []));
    }
    expect(spans.length).toBeGreaterThanOrEqual(7);
    const named = spans.flatMap(s => s.match(/--[a-z][a-z-]*/g) ?? []);
    expect(named).toContain('--fix-list');
    expect(named.filter(n => !known.has(n))).toEqual([]);
  });
  test('the resolvers import the prompt bodies instead of holding a copy', () => {
    for (const f of ['scripts/resolvers/review-army.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/fix-check.ts', 'scripts/resolvers/defensive-review.ts']) {
      const src = read(f);
      for (const clause of ['Required fields: severity, confidence', 'Think like an attacker and a chaos engineer. Your job', 'You are the fix-check reviewer', 'This is an authorized defensive-security review', 'Your job is to find what they\nMISSED']) expect(src).not.toContain(clause);
    }
  });
});

describe('gstack-review-packet collect', () => {
  type Entry = { role: string; name: string; checklists?: string[] };
  function dir(entries: Entry[], outs: Record<string, string | null>) {
    const d = tmp('review-packet-collect-');
    const packets = entries.map(e => ({ ...e, reviewer: e.name, effort: 'full', file: path.join(d, `${e.name}.packet.md`), out: path.join(d, `${e.name}.out`), bytes: 1, checklists: e.checklists ?? [], fixtures: 'full', shard: null }));
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: 1, head: 'h', diff_base: 'b', fingerprint: 'none', packets }));
    for (const [n, text] of Object.entries(outs)) if (text !== null) fs.writeFileSync(path.join(d, `${n}.out`), text);
    return d;
  }
  const collect = (d: string) => spawnSync(BIN, ['collect', '--dir', d], { encoding: 'utf8', timeout: 60_000 });
  const finding = (o: Record<string, unknown>) => JSON.stringify({ severity: 'INFORMATIONAL', confidence: 7, path: 'src/a.ts', line: 3, category: 'quality', summary: 's', specialist: 'testing', ...o });
  const specialists = [{ role: 'specialist', name: 'testing' }, { role: 'specialist', name: 'security' }];

  test('clean and findings: dedupe across sources keeps every label, invalid lines are counted, an advisory CRITICAL stays CRITICAL', () => {
    const d = dir(specialists, {
      testing: [finding({ severity: 'CRITICAL', fingerprint: 'fp-1', summary: 'shared defect', specialist: 'testing' }), 'not json', finding({ severity: 'CRITICAL', advisory: true, fingerprint: 'fp-2', summary: 'advisory critical' })].join('\n'),
      security: finding({ severity: 'CRITICAL', fingerprint: 'fp-1', confidence: 8, summary: 'shared defect', specialist: 'security' }),
    });
    const r = collect(d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEWER: testing status=findings crit=2 info=0 invalid_lines=1');
    expect(r.stdout).toContain('REVIEWER: security status=findings crit=1 info=0');
    const merged = fs.readFileSync(path.join(d, 'merged.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const shared = merged.find(m => m.fingerprint === 'fp-1');
    expect(shared.sources).toEqual(['testing', 'security']);
    expect(shared.confidence).toBe(9);
    const adv = merged.find(m => m.fingerprint === 'fp-2');
    expect(adv.severity).toBe('CRITICAL');
    expect(adv.advisory).toBeUndefined();
    expect(r.stdout).toMatch(/^COLLECT: reviewers=2 clean=0 findings=2 missing=0 invalid=0 crit=2 info=0 invalid_lines=1 /m);
  });

  test('NO FINDINGS is clean; a missing or unusable output is incomplete coverage, exit 3', () => {
    expect(collect(dir(specialists, { testing: 'NO FINDINGS\n', security: 'NO FINDINGS' })).status).toBe(0);
    const missing = collect(dir(specialists, { testing: 'NO FINDINGS', security: null }));
    expect(missing.status).toBe(3);
    expect(missing.stdout).toContain('REVIEWER: security status=missing');
    expect(missing.stdout).toMatch(/security=missing.*\(REVIEW_COVERAGE_INCOMPLETE\)$/m);
    const prose = collect(dir(specialists, { testing: 'NO FINDINGS', security: 'Looks fine to me overall.' }));
    expect(prose.status).toBe(3);
    expect(prose.stdout).toContain('REVIEWER: security status=invalid');
  });

  test('INFORMATIONAL findings are counts in the record and lines in informational.md', () => {
    const d = dir(specialists, { testing: finding({ summary: 'INFO_ONLY_MARKER', fix: 'do it' }), security: 'NO FINDINGS' });
    const r = collect(d);
    expect(r.stdout).not.toContain('INFO_ONLY_MARKER');
    expect(r.stdout).toMatch(/^INFORMATIONAL: 1 \(advisory 0\)/m);
    expect(fs.readFileSync(path.join(d, 'informational.md'), 'utf8')).toContain('INFO_ONLY_MARKER Fix: do it');
  });

  test('the record stays under 60 lines however many findings return, each CRITICAL line at most 300 chars', () => {
    const many = Array.from({ length: 120 }, (_, i) => finding({ severity: 'CRITICAL', fingerprint: `fp-${i}`, summary: 'x'.repeat(500) })).join('\n');
    const entries = Array.from({ length: 30 }, (_, i) => ({ role: 'specialist', name: `s${i}` }));
    const outs: Record<string, string> = Object.fromEntries(entries.map(e => [e.name, 'NO FINDINGS']));
    outs.s0 = many;
    const r = collect(dir(entries, outs));
    const out = r.stdout.trimEnd().split('\n');
    expect(out.length).toBeLessThanOrEqual(60);
    expect(r.stdout).toMatch(/^CRITICAL_MORE: \d+ more/m);
    for (const l of out.filter(x => x.startsWith('CRITICAL:'))) expect(l.length).toBeLessThanOrEqual(300);
  });

  test('the outside voice keeps its severity contract; adversarial JSONL keeps its Recommendation line', () => {
    const d = dir([{ role: 'outside-voice', name: 'outside-voice' }, { role: 'adversarial-native', name: 'adversarial' }], {
      'outside-voice': '[High] src/a.ts:4 — retries forever on 429\n[Low] src/b.ts — naming\nRecommendation: Fix the retry because it loops on 429',
      adversarial: JSON.stringify({ severity: 'INFORMATIONAL', path: 'src/a.ts', summary: 'edge', classification: 'INVESTIGATE' }) + '\nRecommendation: Ship as-is because the race needs two writers',
    });
    const r = collect(d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEWER: outside-voice status=findings crit=1 info=1');
    expect(r.stdout).toContain('REVIEWER: adversarial status=findings crit=0 info=1');
    expect(r.stdout).toContain('RECOMMENDATION: adversarial: Ship as-is because the race needs two writers');
  });
  // Value: protects=collect treats a missing or non-JSON Step 7/8 audit output as incomplete coverage (exit 3); fails_when=the AUDIT status check or its push into results is dropped or inverted;
  //   why_new=collect tests above use reviewer roles only; seam=none; no_claim=the audit's JSON schema (only that its last line parses as an object)
  test('an audit output whose last line is a JSON object is present; missing or prose output is incomplete coverage, exit 3', () => {
    const audit = [{ role: 'specialist', name: 'testing' }, { role: 'audit', name: 'test-coverage' }];
    const ok = collect(dir(audit, { testing: 'NO FINDINGS', 'test-coverage': 'diagram\n{"coverage_pct":50,"gaps":1}\n' }));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^AUDIT: test-coverage status=present /m);
    expect(ok.stdout).toMatch(/^COLLECT: reviewers=1 /m);
    const missing = collect(dir(audit, { testing: 'NO FINDINGS', 'test-coverage': null }));
    expect(missing.status).toBe(3);
    expect(missing.stdout).toMatch(/test-coverage=missing.*\(REVIEW_COVERAGE_INCOMPLETE\)$/m);
    const prose = collect(dir(audit, { testing: 'NO FINDINGS', 'test-coverage': 'All paths are covered.\n' }));
    expect(prose.status).toBe(3);
    expect(prose.stdout).toMatch(/^AUDIT: test-coverage status=invalid /m);
  });

  // Value: protects=a deferred Red Team is reported pending and neither read nor counted as missing coverage; fails_when=collect reads deferred entries' (empty) out path or drops the pending line;
  //   why_new=the build test asserts only PACKET_DEFERRED, never collect's handling; seam=none; no_claim=that the Red Team later runs (parent workflow)
  test('a deferred Red Team is listed pending with its build hint and does not make coverage incomplete', () => {
    const r = collect(dir([...specialists, { role: 'red-team', name: 'red-team', deferred: true } as Entry], { testing: 'NO FINDINGS', security: 'NO FINDINGS' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^REVIEWER: red-team status=pending \(build its packet with --findings \S+merged\.jsonl/m);
    expect(r.stdout).toMatch(/^COLLECT: reviewers=3 clean=2 findings=0 missing=0 invalid=0 .* pending=1 /m);
  });

  // Value: protects=per-role output validation: a matrix record alone is clean, a specialist line without its required fields is invalid, a refused outside voice is invalid;
  //   fails_when=validFinding stops requiring confidence/category/specialist, matrix records stop counting, or a refusal reads clean; why_new=no collect test covers these branches;
  //   seam=none; no_claim=gstack-state-matrix check semantics (matrix content is not validated here)
  test.each([
    ['state-machines matrix record alone is clean', 'specialist', '{"matrix":{"states":["a","b"]}}', 0, 'clean', ['state-machines']],
    ['specialist line missing confidence/category/specialist is invalid', 'specialist', '{"severity":"CRITICAL","path":"src/a.ts","summary":"s"}', 3, 'invalid', []],
    ['outside voice refusal is invalid', 'outside-voice', 'I cannot review this code.', 3, 'invalid', []],
  ])('%s', (_label, role, text, code, status, checklists) => {
    const r = collect(dir([{ role, name: 'r1', checklists }], { r1: text }));
    expect(r.status).toBe(code);
    expect(r.stdout).toContain(`REVIEWER: r1 status=${status}`);
  });

  // Value: protects=collect on a dir without a readable manifest exits 1 and never reports clean; fails_when=the missing-manifest guard is dropped and an empty plan reads as complete coverage (exit 0);
  //   why_new=every collect test writes a valid manifest; seam=none; no_claim=the stderr wording
  test('collect on a dir with no readable manifest exits 1 and never reports clean', () => {
    const empty = tmp('review-packet-collect-');
    const corrupt = tmp('review-packet-collect-');
    fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{not json');
    for (const d of [empty, corrupt]) {
      const r = collect(d);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('COLLECT:');
      expect(r.stderr).toContain('manifest');
    }
  });

  // Value: protects=a matrix record counts only for a reviewer that applies the state-machines checklist, and only as an object; fails_when={"matrix":null} from security reads clean;
  //   why_new=the matrix shortcut was never tested outside state-machines; seam=none; no_claim=gstack-state-matrix check semantics
  test('{"matrix":null} or a matrix from a non-state-machines reviewer is not a clean review', () => {
    for (const [checklists, text] of [[['security'], '{"matrix":{"states":["a"]}}'], [['state-machines'], '{"matrix":null}']] as [string[], string][]) {
      const r = collect(dir([{ role: 'specialist', name: 'r1', checklists }], { r1: text }));
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('REVIEWER: r1 status=invalid');
    }
  });

  // Value: protects=a CRITICAL line that fails validation makes the reviewer invalid (coverage incomplete) instead of vanishing behind a valid peer line; fails_when=the bad CRITICAL is only counted in invalid_lines and collect exits 0;
  //   why_new=invalid-line tests only use non-JSON text; seam=none; no_claim=the validity rules themselves
  test('a CRITICAL line missing required fields next to a valid finding makes the reviewer invalid, exit 3', () => {
    const r = collect(dir([{ role: 'specialist', name: 'testing' }], { testing: [finding({}), '{"severity":"CRITICAL","path":"src/a.ts","summary":"real blocker"}'].join('\n') }));
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('REVIEWER: testing status=invalid');
  });

  // Value: protects=a CRITICAL in another case or on an unparseable line still makes the reviewer invalid; fails_when=only an exact, parseable severity "CRITICAL" trips the guard;
  //   why_new=the guard test above uses a parseable exact-case line; seam=none; no_claim=prose findings, which the contract already rejects
  test.each(['{"severity":"Critical","confidence":8,"path":"a.ts","category":"x","summary":"s","specialist":"testing"}', '{"severity":"CRITICAL","path":"a.ts","summary":"trailing comma",}', '[CRITICAL] a.ts: prose blocker'])('a case-variant or unparseable CRITICAL line next to a valid finding makes the reviewer invalid: %s', bad => {
    const r = collect(dir([{ role: 'specialist', name: 'testing' }], { testing: [finding({}), bad].join('\n') }));
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('REVIEWER: testing status=invalid');
  });
});
