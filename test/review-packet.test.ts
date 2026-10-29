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
import { shardChunks, SPECIALIST_PACKING } from '../lib/review-packet';

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
const packets = (stdout: string) => [...stdout.matchAll(/^PACKET: (\S+) (\S+) effort=\S+ bytes=(\d+) tokens~=\d+ file=(\S+) out=(\S+)$/gm)].map(m => ({ role: m[1]!, name: m[2]!, bytes: Number(m[3]), file: m[4]!, out: m[5]!, text: fs.readFileSync(m[4]!, 'utf8') }));
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const checklist = (name: string) => fs.readFileSync(path.join(ROOT, 'review', 'specialists', `${name}.md`), 'utf8');

describe('gstack-review-packet build', () => {
  test('a packet holds its instructions, contract, checklist, the diff and read budget, and no other repository content', () => {
    const r = repo({ 'src/unrelated.ts': 'export const UNRELATED_MARKER = 1;\n' }, { 'src/a.ts': lines(80, 'alpha') });
    const b = build(r, ['--fanout', 'parallel']);
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
    const all = packets(build(r, ['--force', 'security', '--fanout', 'parallel']).stdout);
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
    const all = packets(build(r, ['--fanout', 'parallel']).stdout);
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
    expect(build(r, ['--fanout', 'parallel']).stdout).toContain('PACKET_DEFERRED: red-team');
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
    expect(a.text).toContain('You are running a ship-workflow test coverage audit. Run `git diff origin/main`');
    expect(a.text).toContain('Generation: audit-only; passes used: 1 of 2.');
    expect(a.text).toContain('+export const zeta19 = 19;');
    expect(build(r, ['--audit', 'plan-completion']).status).toBe(2);
  });

  const planDispatches = (r: Repo, extra: string[] = []) => {
    const plan = spawnSync(path.join(ROOT, 'bin', 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', ...extra], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    return [...plan.stdout.matchAll(/^DISPATCH: (\S+) (\S+)/gm)].map(m => ({ role: m[1]!, name: m[2]! }));
  };

  test('standard depth: the pass\'s specialist lines are one batched packet inlining every selected checklist; red-team and adversarial stay separate', () => {
    const r = repo({}, { 'src/a.ts': lines(260, 'kappa'), 'test/a.test.ts': 'TEST_MARKER\n', 'docs/guide.md': '# Guide\nDOCS_MARKER\n' });
    const selected = planDispatches(r).filter(d => d.role === 'specialist').map(d => d.name);
    expect(selected.length).toBeGreaterThan(1);
    const b = build(r);
    expect(b.status).toBe(0);
    const all = packets(b.stdout);
    const specialists = all.filter(p => p.role === 'specialist');
    expect(specialists.map(p => p.name)).toEqual(['batched']);
    const batched = specialists[0]!;
    for (const c of selected) { expect(batched.text).toContain(`## Checklist: ${c}`); expect(batched.text).toContain(checklist(c)); }
    expect(batched.text).not.toContain('## Checklist: red-team');
    expect(batched.text).toContain('Tag each finding with the checklist that found it');
    expect(batched.text).toContain(`COVERED: ${selected.join(',')}`);
    expect(batched.text).toContain('+TEST_MARKER');
    expect(batched.text).not.toContain('+DOCS_MARKER');
    expect(batched.text).toContain('the parent runs `gstack-state-matrix check` on it');
    expect(b.stdout).toContain(`PACKED: specialist batched checklists=${selected.join(',')} shards=1`);
    expect(b.stdout).toContain('PACKET_DEFERRED: red-team');
    expect(all.some(p => p.role === 'adversarial-native')).toBe(true);
    const parallel = packets(build(r, ['--fanout', 'parallel']).stdout).filter(p => p.role === 'specialist');
    expect(parallel.map(p => p.name)).toEqual(selected);
    expect(build(r, ['--fanout', 'serial']).status).toBe(2);
  });

  test('the default packing is the one switch SPECIALIST_PACKING names', () => {
    expect(SPECIALIST_PACKING).toBe('batched');
  });

  test('full depth: every specialist batched, the diff unexcluded; the Red Team counts the batched checklists', () => {
    const r = repo({}, { 'src/a.ts': lines(260, 'lambda'), 'docs/guide.md': '# Guide\nDOCS_MARKER\n' });
    const selected = planDispatches(r, ['--depth-floor', 'full']).filter(d => d.role === 'specialist').map(d => d.name);
    const b = build(r, ['--depth-floor', 'full']);
    const specialists = packets(b.stdout).filter(p => p.role === 'specialist');
    expect(specialists.map(p => p.name)).toEqual(['batched']);
    expect(specialists[0]!.text).toContain('+DOCS_MARKER');
    const merged = path.join(r.out, 'merged.jsonl');
    fs.writeFileSync(merged, '');
    const red = packets(build(r, ['--depth-floor', 'full', '--only', 'red-team', '--findings', merged]).stdout)[0]!;
    expect(red.text).toContain(`reviewed by ${selected.length} specialists`);
  });

  test('a batched diff past the cap is one batched packet per shard, each with every checklist', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = lines(400, `w${i}_`);
    const r = repo({}, files);
    const shards = packets(build(r, ['--only', 'specialist']).stdout);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.map(s => s.name)).toEqual(shards.map((_, i) => `batched.${i + 1}of${shards.length}`));
    for (const s of shards) { expect(s.bytes).toBeLessThanOrEqual(200_000); expect(s.text).toContain(checklist('testing')); expect(s.text).toContain(checklist('maintainability')); }
  });

  test('Step 7: a diff with no code path (docs and data only) builds no audit packet and says why', () => {
    const r = repo({}, { 'docs/guide.md': '# Guide\n', 'data/scores.json': '{"a":1}\n' });
    const b = build(r, ['--audit', 'test-coverage']);
    expect(b.status).toBe(0);
    expect(packets(b.stdout)).toEqual([]);
    expect(b.stdout).toMatch(/^AUDIT_SKIPPED: test-coverage code_paths=0 \(.*docs\/guide\.md.*\)/m);
    expect(fs.existsSync(path.join(r.out, 'test-coverage.packet.md'))).toBe(false);
    const code = repo({}, { 'src/a.ts': lines(5, 'mu'), 'data/scores.json': '{"a":1}\n' });
    expect(packets(build(code, ['--audit', 'test-coverage']).stdout).length).toBe(1);
  });

  test('the coverage audit packet is read-only: no edits, no test runs, three calls, whatever generation the parent has', () => {
    const r = repo({}, { 'src/a.ts': lines(20, 'nu') });
    const a = packets(build(r, ['--audit', 'test-coverage', '--generation', 'allowed', '--passes-used', '0']).stdout)[0]!;
    expect(a.text).toContain('Generation: audit-only; passes used: 0 of 2.');
    expect(a.text).toContain(P.AUDIT_READ_ONLY);
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
  });
  test('/ship Step 9 dispatches the batched packet at every depth and logs its checklists; Step 7 skips a no-code audit and writes tests itself', () => {
    const army = read('ship/sections/review-army.md');
    expect(army).toContain('--fanout parallel');
    expect(army).toContain('"checklists":[');
    expect(army).toContain('PACKED:');
    expect(army).toMatch(/checklists include state-machines/);
    const coverage = read('ship/sections/test-coverage.md');
    expect(coverage).toContain('AUDIT_SKIPPED:');
    expect(coverage).not.toContain('--generation <allowed|audit-only>');
    expect(coverage).toMatch(/the parent writes and runs the tests/);
  });
  test('the outside voice boundary the safety-rule registry pins in the resolver is the packet\'s boundary', () => {
    const line = read('scripts/resolvers/outside-voice-steps.ts').split('\n').find(l => l.startsWith('const CODEX_BOUNDARY = '))!;
    expect(line).toBe(`const CODEX_BOUNDARY = '${P.CODEX_BOUNDARY_TEXT}\\\\n\\\\n';`);
  });
  test('the resolvers import the prompt bodies instead of holding a copy', () => {
    for (const f of ['scripts/resolvers/review-army.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/fix-check.ts', 'scripts/resolvers/defensive-review.ts']) {
      const src = read(f);
      for (const clause of ['Required fields: severity, confidence', 'Think like an attacker and a chaos engineer. Your job', 'You are the fix-check reviewer', 'This is an authorized defensive-security review', 'Your job is to find what they\nMISSED']) expect(src).not.toContain(clause);
    }
  });
});

describe('gstack-review-packet collect', () => {
  type Entry = { role: string; name: string };
  function dir(entries: Entry[], outs: Record<string, string | null>) {
    const d = tmp('review-packet-collect-');
    const packets = entries.map(e => ({ ...e, reviewer: e.name, effort: 'full', file: path.join(d, `${e.name}.packet.md`), out: path.join(d, `${e.name}.out`), bytes: 1, checklists: [], fixtures: 'full', shard: null }));
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

  test('a batched packet must end with COVERED naming every checklist it inlined; a missing one is incomplete coverage', () => {
    const d = (out: string) => {
      const x = dir([{ role: 'specialist', name: 'batched' }], { batched: out });
      const m = JSON.parse(fs.readFileSync(path.join(x, 'manifest.json'), 'utf8'));
      m.packets[0].checklists = ['testing', 'security'];
      fs.writeFileSync(path.join(x, 'manifest.json'), JSON.stringify(m));
      return x;
    };
    const ok = collect(d('NO FINDINGS\nCOVERED: testing, security'));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('REVIEWER: batched status=clean crit=0 info=0 covered=testing,security');
    const partial = collect(d(finding({ specialist: 'testing' }) + '\nCOVERED: testing'));
    expect(partial.status).toBe(3);
    expect(partial.stdout).toContain('REVIEWER: batched status=findings crit=0 info=1 covered=testing uncovered=security');
    expect(partial.stdout).toMatch(/batched=uncovered:security.*\(REVIEW_COVERAGE_INCOMPLETE\)$/m);
    expect(collect(d('NO FINDINGS')).status).toBe(3);
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
});
