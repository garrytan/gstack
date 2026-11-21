/**
 * GSTA-167 calls PR 2: the staged pass manifest (lib/review-pass.ts), its bin commands, and the
 * checked-in Capy pass program (lib/capy-review-pass.js) run against a fake host whose shell is real.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promptHash } from '../lib/review-brief';
import { CHUNK_CHARS, chunkCount, chunkOf, markReader, renderStage, specialistFindings, type Manifest } from '../lib/review-pass';
import { FIXTURE_MARKER } from '../lib/fixture-marker';
import { ROOT, BIN, texts, SHA, spec, tmp, manifest, collectAll, writeManifestFile, repo, treeLine, host, PROGRAM, AsyncFunction, runPass, bin } from './helpers/review-pass-harness';

describe('pass manifest', () => {
  test('stages follow the plan: specialists, Red Team, voices; batched light depth keeps its checklists and exclusions; a fix-check needs its files', () => {
    const m = manifest([spec('testing'), { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }, { role: 'adversarial-native', name: 'adversarial', effort: 'full', exclude: [] }, { role: 'outside-voice', name: 'outside-voice', effort: 'host', exclude: [] }]);
    expect(m.readers.map(r => [r.reader, r.stage, r.title])).toEqual([
      ['specialist/testing', 'specialists', 'ship p1 specialist/testing'], ['red-team', 'red-team', 'ship p1 red-team'],
      ['adversarial-native', 'voices', 'ship p1 adversarial-native'], ['outside-voice', 'voices', 'ship p1 outside-voice']]);
    expect(m.stack).toBe('node');
    expect(m.test_fw).toBe('unknown');
    const light = manifest([{ role: 'specialist', name: 'batched', effort: 'full', exclude: [':(exclude)docs/a.md'], checklists: ['testing', 'red-team'] }]);
    expect(light.readers[0]).toMatchObject({ reader: 'specialist-batched', role: 'specialist-batched', exclude: "-- . ':(exclude)docs/a.md'", checklists: ['testing', 'red-team'] });
    expect(() => manifest([{ role: 'fix-check', name: 'fix-check', effort: 'full', exclude: [] }])).toThrow(/the plan dispatches a fix-check: pass needs --fix-list, --hunks and --tests/);
    // PR #3665 review: the batched reviewer reads each checklist by path, as the render CLI is given them, never by bare name.
    renderStage(light, 'specialists', texts, () => '');
    expect(fs.readFileSync(light.readers[0]!.file!, 'utf8')).toContain(`Read each checklist at ${path.join(ROOT, 'review/specialists/testing.md')}, ${path.join(ROOT, 'review/specialists/red-team.md')} (tag each finding`);
  });

  test('a manifest render is byte for byte the render CLI\'s brief for the same slots', () => {
    const m = manifest([spec('security', [':(exclude)test/x.ts'])]);
    renderStage(m, 'specialists', texts, () => '');
    const out = tmp('rp-cli-');
    const r = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['render', '--role', 'specialist', '--name', 'security', '--out', out, '--diff-base', SHA, '--stack', 'node', '--test-fw', 'unknown', '--exclude', "-- . ':(exclude)test/x.ts'"], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('sha256=' + m.readers[0]!.sha256);
    expect(fs.readFileSync(m.readers[0]!.file!, 'utf8')).toBe(fs.readFileSync(path.join(out, 'specialist-security.prompt.md'), 'utf8'));
  });

  test('the Red Team renders only after every earlier reader is collected, from the specialists\' merged lines byte for byte', () => {
    const m = manifest([spec('testing'), spec('security'), { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }]);
    renderStage(m, 'specialists', texts, () => '');
    expect(() => renderStage(m, 'red-team', texts, () => '')).toThrow(/still open: specialist\/testing, specialist\/security/);
    const lines = [{ id: 'specialist/testing#1', reader: 'specialist/testing', label: 'High', raw: 'High: a — ü', output_sha256: 'x' }, { id: 'red-team#1', reader: 'red-team', label: 'Low', raw: 'Low: b', output_sha256: 'y' }];
    fs.writeFileSync(m.merged, lines.map(l => JSON.stringify(l) + '\n').join(''));
    collectAll(m, 'specialists');
    renderStage(m, 'red-team', texts, () => '');
    const findings = fs.readFileSync(path.join(m.out, 'briefs/specialist-findings.jsonl'), 'utf8');
    expect(findings).toBe(JSON.stringify(lines[0]) + '\n');
    expect(findings).toBe(specialistFindings(m.merged));
    const rt = m.readers.find(r => r.reader === 'red-team')!;
    expect(rt.findings_sha256).toBe(promptHash(findings));
    const brief = fs.readFileSync(rt.file!, 'utf8');
    expect(brief).toContain('reviewed by 2 specialists');
    const batched = manifest([{ role: 'specialist', name: 'batched', effort: 'medium', exclude: [], checklists: ['testing', 'security', 'state-machines'] }, { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }]);
    renderStage(batched, 'specialists', texts, () => '');
    collectAll(batched, 'specialists');
    renderStage(batched, 'red-team', texts, () => '');
    expect(fs.readFileSync(batched.readers[1]!.file!, 'utf8')).toContain('reviewed by 3 specialists');
    expect(brief).toContain(findings.trim());
  });

  test('reader states move forward only: intent before create, a path with created or queued', () => {
    const m = manifest([spec('testing')]);
    renderStage(m, 'specialists', texts, () => '');
    expect(() => markReader(m, 'specialist/testing', 'created', { path: '1' })).toThrow(/cannot become created/);
    markReader(m, 'specialist/testing', 'intent');
    expect(() => markReader(m, 'specialist/testing', 'created')).toThrow(/only with its subagent path/);
    markReader(m, 'specialist/testing', 'queued', { path: '4' });
    markReader(m, 'specialist/testing', 'created');
    expect(() => markReader(m, 'specialist/testing', 'intent')).toThrow(/cannot become intent/);
    expect(m.readers[0]).toMatchObject({ state: 'created', path: '4' });
  });

  // Value: protects=an unreadable extra prompt stops as a BriefError naming the reader; fails_when=a directory prompt_file throws a raw
  //   EISDIR from the QA guard's read (GST-450 adversarial #4); seam=none
  test('a directory extra prompt stops as an unreadable prompt file, not a raw read error', () => {
    const d = manifest([spec('testing')], { extras: [{ name: 'plan', prompt_file: tmp('rp-qa-') }] });
    expect(() => renderStage(d, 'specialists', texts, () => '')).toThrow(/cannot read audit\/plan's prompt file/);
  });

  // The outside voice now reads its diff from a file (test/review-depth-lean.test.ts), so a large brief here is an audit
  // reader's prompt file carrying the same bytes.
  test('a brief over 1 MiB with invalid UTF-8 in it travels in bounded chunks that rejoin to the rendered sha', () => {
    const big = path.join(tmp('rp-big-'), 'plan.md');
    fs.writeFileSync(big, Buffer.concat([Buffer.from('+line \u00e9\n'.repeat(90_000)), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('+"quoted" \\ back\n'.repeat(20_000))]));
    const m = manifest([], { extras: [{ name: 'plan', prompt_file: big }] });
    renderStage(m, 'specialists', texts, () => '');
    const r = m.readers[0]!;
    const text = fs.readFileSync(r.file!, 'utf8');
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
    expect(r.chunks).toBe(chunkCount(text));
    let joined = '';
    for (let i = 0; i < r.chunks!; i++) {
      const c = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['chunk', '--manifest', writeManifestFile(m), '--reader', 'audit/plan', '--index', String(i)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      expect(c.status, c.stderr).toBe(0);
      const [head, body] = c.stdout.split('\n');
      expect(head).toBe('BRIEF_CHUNK: reader=audit/plan index=' + i + ' of=' + r.chunks + ' sha256=' + r.sha256);
      expect(Buffer.byteLength(body!)).toBeLessThan(1024 * 1024);
      joined += JSON.parse(body!);
    }
    expect(promptHash(joined)).toBe(r.sha256!);
    expect(() => chunkOf(text, r.chunks!)).toThrow(/outside/);
    expect(chunkOf(text, 0).length).toBe(CHUNK_CHARS);
  });
});

describe('the targeted reader in a pass (GST-257 on main)', () => {
  // Value: protects=a pass whose plan dispatches the targeted reader stages it with Step 11's voices on the merge base, its brief byte for byte the render CLI's, and its ledger row carrying the classes, rules, brief and patch the receipt's review_targeted record reads; fails_when=the manifest refuses or drops the targeted role, renders it on another base, or writes a rendered row verify --targeted-out cannot use;
  //   why_new=#3671 added the targeted reader after PR 2's manifest; seam=none; no_claim=the reader's findings
  test('a secret-path diff stages the targeted reader with the voices, identical to the render CLI, with its targeted ledger fields', () => {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
    sh("echo 'export const apiKeyName = \"X\";' > src/secrets.ts && git add -A && git commit -qm secret");
    const out = path.join(dir, '.state/run/p1');
    const p = bin(dir, env, ['pass', '--base', 'main', '--out', out, '--pass', 't1p1', '--', '--depth-floor', 'full']);
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^DISPATCH: targeted /m);
    const mf = path.join(out, 'pass-manifest.json');
    let m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
    const t = m.readers.find(r => r.role === 'targeted')!;
    expect(t).toMatchObject({ reader: 'targeted', stage: 'voices', classes: ['secret'] });
    const mergeBase = sh('git merge-base main HEAD').trim();
    expect(t.diff_base).toBe(mergeBase);
    for (const st of ['specialists', 'red-team']) {
      if (st === 'red-team') expect(bin(dir, env, ['stage', '--manifest', mf, '--stage', st]).status).toBe(0);
      m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
      for (const r of m.readers.filter(x => x.stage === st)) for (const [s, extra] of [['intent', []], ['created', ['--path', '1']], ['collected', []]] as const) expect(bin(dir, env, ['mark', '--manifest', mf, '--reader', r.reader, '--state', s, ...extra]).status).toBe(0);
    }
    const v = bin(dir, env, ['stage', '--manifest', mf, '--stage', 'voices']);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
    const staged = m.readers.find(r => r.role === 'targeted')!;
    const cli = bin(dir, env, ['render', '--role', 'targeted', '--classes', 'secret', '--base', 'main', '--diff-base', mergeBase, '--out', path.join(dir, '.state/cli'), '--stack', m.stack, '--test-fw', m.test_fw, ...(staged.exclude ? ['--exclude', staged.exclude] : [])]);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain('sha256=' + staged.sha256);
    const row = fs.readFileSync(m.ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.event === 'rendered' && e.reader === 'targeted');
    const cliRow = fs.readFileSync(path.join(dir, '.state/cli/review-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
    for (const k of ['classes', 'rules', 'brief_sha', 'diff_base', 'patch_id', 'sha256']) expect(row[k]).toEqual(cliRow[k]);
  }, 180_000);
});

describe('the targeted-only read in the Capy pass program (GST-1598, GST-1607)', () => {
  // Value: protects=a NEXT: targeted manifest driven through the checked-in pass program runs its one targeted reader (voices stage)
  //   and ends on NEXT: judge; fails_when=the program runs only first, specialists and red-team for a targeted manifest, so it creates
  //   no reader (lib/capy-review-pass.js activated voices only for fix-check); seam=lib/capy-review-pass.js stage selection;
  //   no_claim=what the reader finds
  test('a targeted-only manifest creates the one targeted reader', async () => {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
    sh("printf 'export const spendCapUsd = 25;\\n' > src/billing.ts && git add -A && git commit -qm money");
    const read = sh('git rev-parse HEAD').trim();
    const plan = spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const ran = JSON.parse(plan.stdout).targeted.targeted_patch_id as string;
    sh("mkdir -p changelog.d && echo '- Each PR eval run now costs about $4.20.' > changelog.d/cost.md && git add -A && git commit -qm claim");
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'td1p1', planFlags: ['--gate-tagged', '0', '--pass', '1', '--last', 'fix-check', '--fixed-below', '--range-base', read, '--targeted-ran', ran] });
    expect(res).toContain('NEXT: targeted');
    expect(h.creates.map(c => c.title)).toEqual(['ship td1p1 targeted']);
    expect(res).toContain('NEXT: judge');
  }, 180_000);
});

describe('a large diff (GST-507)', () => {
  // Value: protects=a pass on a results PR with thousands of files reads gstack-review-plan's whole JSON plan through the pipe and stages its readers; fails_when=either bin exits before its stdout drains, so the plan JSON arrives cut short and pass dies on JSON.parse;
  //   why_new=HARN-1 hit it on a 4,000-file receipt tree (a 1.39 MB plan); seam=none; no_claim=what reviewers read on a large diff (GST-508)
  test('a 4,000-file diff round-trips a plan JSON over 1 MB and pass stages its readers', () => {
    const { dir, env } = repo();
    const files = 4000;
    const made = spawnSync('bash', ['-c', `for d in $(seq 1 40); do p=receipts/harness-evals-lane-b-results-run-$d/per-case-receipts/skill-behavior-panel; mkdir -p $p; for i in $(seq 1 100); do echo "{\\"case\\":$i}" > $p/receipt-for-case-number-$i-trial-a.json; done; done && git add -A && git commit -qm receipts`], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    expect(made.status, made.stderr).toBe(0);
    const plan = spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout.length).toBeGreaterThan(1_000_000);
    expect((JSON.parse(plan.stdout) as { paths: string[] }).paths.filter(p => p.startsWith('receipts/'))).toHaveLength(files);
    const out = path.join(dir, '.state/run/p1');
    const p = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['pass', '--base', 'main', '--out', out, '--pass', 'big-p1'], { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^MANIFEST: file=.* pass=big-p1 readers=[1-9]/m);
  }, 300_000);
});

describe('the pass resolves --base the way preflight does', () => {
  function withOrigin(stale: boolean) {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(c + ': ' + r.stderr); return r.stdout.trim(); };
    const origin = tmp('rp-origin-');
    sh('git init -q --bare "$0" && git remote add origin "$0"'.split('$0').join(origin));
    if (stale) {
      sh('git checkout -q main && echo "# base" > BASE.md && git add BASE.md && git commit -qm m2 && git push -q origin main && git reset -q --hard HEAD~1 && git checkout -q feat && git merge -q --no-edit origin/main');
    } else {
      sh('git push -q origin main && git fetch -q origin && git branch -D main');
    }
    return { dir, env, originMain: sh('git rev-parse origin/main') };
  }
  // Value: protects=a checkout whose local main is missing or behind origin/main reviews the same fork point preflight merged, not a stale one or none; fails_when=pass resolves --base against the local branch only (replay C5-36: BRIEF_RENDER_FAILED: no merge base between main and HEAD);
  //   why_new=identity checks ran with local main equal to origin/main; seam=gstack-review-dispatch pass; no_claim=hosts whose remote is not named origin
  test.each([['no local main', false], ['a local main behind origin/main', true]])('%s: diff base is the fork point with origin/main, briefs byte for byte the render CLI there', (_, stale) => {
    const { dir, env, originMain } = withOrigin(stale as boolean);
    const out = path.join(dir, '.state/run/p1');
    const r = bin(dir, env, ['pass', '--base', 'main', '--out', out, '--pass', 'x22p1', '--', '--depth-floor', 'full']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    expect(m.diff_base).toBe(originMain);
    const spec = m.readers.find((x: { role?: string }) => x.role === 'specialist-batched');
    const cli = bin(dir, env, ['render', '--role', 'specialist-batched', '--out', path.join(dir, '.state/cli'), '--diff-base', originMain, '--checklists', spec.checklists.join(','), '--stack', m.stack, '--test-fw', m.test_fw]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(fs.readFileSync(spec.file, 'utf8')).toBe(fs.readFileSync(path.join(dir, '.state/cli/specialist-batched.prompt.md'), 'utf8'));
  }, 120_000);
});

describe('the Capy skill loader', () => {
  // The loader is copied from capy/skill/gstack/SKILL.md with only its placeholders filled, so a drift in either breaks here.
  test('runs the served program unchanged and the pass notes its readers in the budget', async () => {
    const skill = fs.readFileSync(path.join(ROOT, 'capy/skill/gstack/SKILL.md'), 'utf8');
    const at = skill.indexOf('one call to the checked-in pass program');
    const open = skill.indexOf('(fill only `input`): `', at) + '(fill only `input`): `'.length;
    const code = skill.slice(open, skill.indexOf('`', open));
    const { dir, env } = repo();
    const launch = path.join(dir, '.state/launch.env');
    const rec = path.join(dir, '.state/rec.md');
    fs.mkdirSync(path.dirname(launch), { recursive: true });
    fs.writeFileSync(launch, '');
    expect(spawnSync('bash', ['-c', 'gstack-ship-budget start --record "$1" --mode observe --reading 1000 --credits 1', '_', rec], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const filled = code.split('<launch file>').join(launch).split('<base>').join('main').split('<run dir>/p<n>').join(path.join(dir, '.state/run/p1'))
      .split('<run>-p<n>').join('x10p1').split('<jam id>').join('jam_test').split('<rec>').join(rec).split('<your model id>').join('anthropic/claude-opus-5-5').split('<repo>').join(dir);
    expect(filled).not.toMatch(/<[a-z ]+>/);
    const h = host(dir, env);
    const res = await new AsyncFunction('tools', 'sleep', 'now', filled)(h.tools, h.sleep, h.now);
    expect(res.split('\n')[0]).toBe('PROGRAM: v1 sha256=' + promptHash(PROGRAM) + ' bytes=' + Buffer.byteLength(PROGRAM));
    expect(res).toMatch(/REVIEW_LOG_START: review token=\S+/);
    expect(res).toMatch(/NOTE: \S+ used=\d+ credits=\S+ readers=\d+/);
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.length).toBeGreaterThan(0);
  }, 180_000);
});


describe('a scoped pass after a blocker fix (GST-619)', () => {
  // Value: protects=the pass command accepts the scoped plan gstack-review-plan writes after a blocking fix, invoked as GEVA-2 ran it: the Red Team reviews the fix range, Step 11's voices still pending keep the whole branch, the fix-check is named outside the manifest for Step 3.5, and a resumed pass names it again; fails_when=pass refuses the scoped plan, stages the Red Team on the merge base, stages pending Step 11 voices on the range, drops the fix-check silently, or puts it in the manifest;
  //   why_new=GEVA-82 on 1.91.379.0 hit BRIEF_RENDER_FAILED on every scoped pass and rendered briefs by hand; seam=none; no_claim=the fix-check's own brief
  function scoped(flags: string[], explicitMergeBase = false) {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    const mergeBase = sh('git merge-base main HEAD');
    const rangeBase = sh('git rev-parse HEAD');
    sh('for i in $(seq 1 24); do echo "export const f$i = $i;" >> src/fix.ts; done && git add -A && git commit -qm "fix: pre-landing review fixes"');
    const out = path.join(dir, '.state/run/p2');
    const extras = path.join(dir, '.state/extras.json');
    fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.state/plan.md'), 'Check the plan items against the fix.\n');
    fs.writeFileSync(extras, JSON.stringify([{ name: 'plan', prompt_file: path.join(dir, '.state/plan.md') }]));
    const args = ['pass', '--base', 'main', '--out', out, '--pass', 'p2', '--extras', extras, ...(explicitMergeBase ? ['--diff-base', mergeBase] : []), '--', '--pass', '1', '--last', 'full', '--pass1-depth', 'standard', '--fixed-blocking', ...flags, '--range-base', rangeBase.slice(0, 7)];
    const p = bin(dir, env, args);
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^NEXT: scoped /m);
    expect(p.stdout).toMatch(/^FIX_CHECK: planned effort=full \(Step 3\.5 runs it on its own; not in this manifest\)$/m);
    const mf = path.join(out, 'pass-manifest.json');
    return { dir, env, args, mf, mergeBase, rangeBase, m: JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest };
  }
  const settle = (s: ReturnType<typeof scoped>, stage: string) => {
    if (stage !== 'specialists') expect(bin(s.dir, s.env, ['stage', '--manifest', s.mf, '--stage', stage]).status).toBe(0);
    const m = JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
    const reply = path.join(s.dir, '.state/reply.txt');
    fs.writeFileSync(reply, treeLine(s.dir) + 'NO FINDINGS\n');
    for (const r of m.readers.filter(x => x.stage === stage)) for (const [st, extra] of [['intent', []], ['created', ['--path', '1']], ['collected', r.reader.startsWith('audit/') ? ['--output', reply] : []]] as const) expect(bin(s.dir, s.env, ['mark', '--manifest', s.mf, '--reader', r.reader, '--state', st, ...extra]).status).toBe(0);
    return JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
  };

  test('GEVA-2\'s invocation: the Red Team reads the fix range, the pending Step 11 voices read the whole branch, and the fix-check is named outside the manifest', () => {
    const s = scoped([]);
    expect(s.m.next).toBe('scoped');
    expect(s.m.diff_base).toBe(s.mergeBase);
    expect(s.m.readers.map(r => [r.reader, r.diff_base ?? null])).toEqual([['red-team', s.rangeBase], ['adversarial-native', null], ['outside-voice', null], ['audit/plan', null]]);
    settle(s, 'specialists');
    const m = settle(s, 'red-team');
    const redTeam = fs.readFileSync(m.readers.find(r => r.reader === 'red-team')!.file!, 'utf8');
    expect(redTeam).toContain(s.rangeBase);
    expect(redTeam).not.toContain(s.mergeBase);
    expect(bin(s.dir, s.env, ['stage', '--manifest', s.mf, '--stage', 'voices']).status).toBe(0);
    const voices = JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
    const outsideBrief = voices.readers.find(r => r.reader === 'outside-voice')!.file!;
    expect(fs.readFileSync(outsideBrief, 'utf8')).toContain(`The supplied branch diff is the file ${path.join(path.dirname(outsideBrief), 'outside-voice.diff')} `);
    expect(fs.readFileSync(path.join(path.dirname(outsideBrief), 'outside-voice.diff'), 'utf8')).toContain('+export const v1 = 1;');
    const again = bin(s.dir, s.env, s.args);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^FIX_CHECK: planned effort=full /m);
    expect(again.stdout).toContain('readers=4 resumed');
  }, 120_000);

  test('after Step 11 ran (--adversarial-ran), the whole scoped pass reads the fix range', () => {
    const s = scoped(['--adversarial-ran']);
    expect(s.m.diff_base).toBe(s.rangeBase);
    expect(s.m.readers.map(r => [r.reader, r.diff_base ?? null])).toEqual([['red-team', s.rangeBase], ['adversarial-native', null], ['audit/plan', null]]);
  }, 120_000);

  // Value: protects=an explicit --diff-base reaches every reader, the Red Team included; fails_when=a scoped pass asked to read the whole branch still stages its Red Team on the fix range; why_new=GST-738 (outside voice); seam=none; no_claim=none
  test('an explicit --diff-base widens the scoped Red Team too (GST-738)', () => {
    const s = scoped([], true);
    expect(s.m.diff_base).toBe(s.mergeBase);
    const m = settle(s, 'specialists') && settle(s, 'red-team');
    const redTeam = fs.readFileSync(m.readers.find(r => r.reader === 'red-team')!.file!, 'utf8');
    expect({ diffBase: m.readers.find(r => r.reader === 'red-team')!.diff_base ?? null, reads: redTeam.includes(s.mergeBase) }).toEqual({ diffBase: null, reads: true });
  }, 120_000);
});

describe('the fetch sweep quarantines a stage that fetched (GST-1322 PR B)', () => {
  const clone = (at: string) => { fs.mkdirSync(at, { recursive: true }); expect(spawnSync('bash', ['-c', 'git init -q && git remote add origin https://github.com/sealed-org/BEAM.git'], { cwd: at, encoding: 'utf8', timeout: 30_000 }).status).toBe(0); };
  const made: string[] = [];
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
  // Value: protects=a stage whose reader cloned a network repository is quarantined (reply out of merged.jsonl and the Red Team brief), reruns once as <reader>#2, and verifies clean only after the rerun sweeps clean; fails_when=the sweep runs outside the stage window, the quarantined findings reach the Red Team, or verify certifies the first attempt;
  //   why_new=gbrain-evals #362 (an unprompted 4.2 GB clone by a reader); seam=lib/capy-review-pass.js stage boundaries; no_claim=which reader of the stage fetched (Capy exposes no reader id)
  test('a clone during the specialists stage quarantines it, blocks the rerun while the clone exists, then reruns each slot once and verifies clean', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const beam = path.join(dir, '.state/BEAM');
    const h = host(dir, env, { output: t => { if (t === 'ship f1p1 specialist-batched') { clone(beam); return 'High: src/a.ts:3 SEALED-QUOTE leaked from the clone'; } return 'NO FINDINGS'; } });
    const blocked = await runPass(h, { base: 'main', out, pass: 'f1p1', planFlags: ['--depth-floor', 'full'] });
    expect(blocked).toContain('FETCH_VIOLATION: stage=specialists attempt=1 kind=repo path=' + "'" + fs.realpathSync(beam) + "'");
    expect(blocked).toContain('KEEP: ' + "'" + fs.realpathSync(beam) + "'");
    expect(blocked).toMatch(/^RERUN: stage=specialists readers=\S*specialist-batched#2/m);
    expect(blocked).toContain('FETCH_RERUN_BLOCKED: stage=specialists attempt=2 path=' + "'" + fs.realpathSync(beam) + "'");
    expect(h.creates.map(c => c.title)).not.toContain('ship f1p1 specialist-batched#2');
    fs.rmSync(beam, { recursive: true, force: true });
    const res = await runPass(h, { base: 'main', out, pass: 'f1p1', planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('NEXT: judge (Phase 4)');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    const first = m.readers.find(r => r.reader === 'specialist-batched')!;
    expect(first.superseded_by).toBe('specialist-batched#2');
    expect(fs.statSync(first.quarantined!.file).mode & 0o777).toBe(0o600);
    expect(h.creates.map(c => c.title)).toContain('ship f1p1 specialist-batched#2');
    expect(fs.existsSync(m.merged) ? fs.readFileSync(m.merged, 'utf8') : '').not.toContain('SEALED-QUOTE');
    expect(h.creates.find(c => c.title === 'ship f1p1 red-team')!.prompt).not.toContain('SEALED-QUOTE');
    expect(res).not.toContain('SEALED-QUOTE');
    expect(m.sweeps?.specialists).toMatchObject({ attempt: 2, end: { verdict: 'clean' } });
    expect(bin(dir, env, ['judge', '--ledger', m.ledger, '--merged', m.merged, '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.stdout).toMatch(/^FETCH f1p1\/specialists#1 RESOLVED found=1/m);
    expect(v.stdout).toMatch(/^BRIEF specialist-batched SUPERSEDED .* quarantined$/m);
    expect(v.stdout, v.stdout).toContain('VERIFY: clean');
  }, 240_000);

  // Value: protects=a rerun reader can never read what attempt 1 fetched and sweep clean: while any path attempt 1 found exists, the rerun dispatches no reader and verify keeps refusing;
  //   fails_when=the #2 readers start beside the kept clone, sweep clean, and their findings (read from the clone) reach merged.jsonl with verify RESOLVED; why_new=ship-c-p1 red-team#2 (CRITICAL; the Captain's ruling C on #4011);
  //   seam=gstack-review-dispatch sweep --phase start; no_claim=that the kept path is safe to keep
  test('a rerun reader cannot open attempt 1\'s kept clone: the rerun start refuses, dispatches nothing and verify stays dirty', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const beam = path.join(dir, '.state/BEAM');
    const h = host(dir, env, { output: t => { if (t === 'ship f3p1 specialist-batched') clone(beam); if (t === 'ship f3p1 specialist-batched#2' && fs.existsSync(beam)) return 'High: src/a.ts:3 SEALED-QUOTE read from the kept clone'; return 'NO FINDINGS'; } });
    let res = await runPass(h, { base: 'main', out, pass: 'f3p1', planFlags: ['--depth-floor', 'full'] });
    for (let i = 0; i < 4 && res.includes('NEXT: poll'); i++) res = await runPass(h, { base: 'main', out, pass: 'f3p1', planFlags: ['--depth-floor', 'full'] });
    const kept = fs.realpathSync(beam);
    expect(res).toContain("FETCH_RERUN_BLOCKED: stage=specialists attempt=2 path='" + kept + "'");
    expect(res).toMatch(/STOP: gstack-review-dispatch sweep --stage specialists --phase start exited 3/);
    expect(res).not.toContain('NEXT: judge');
    expect(res).not.toContain('SEALED-QUOTE');
    expect(h.creates.map(c => c.title)).not.toContain('ship f3p1 specialist-batched#2');
    expect(fs.existsSync(beam)).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    expect(fs.existsSync(m.merged) ? fs.readFileSync(m.merged, 'utf8') : '').not.toContain('SEALED-QUOTE');
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/^FETCH_VIOLATION: f3p1\/specialists#1 found=1/m);
    expect(v.stdout).toContain('VERIFY: dirty');
  }, 240_000);

  // Value: protects=a fetch on the stage's one rerun stops the pass and verify refuses with FETCH_VIOLATION; a path that holds an older one is reported, never given a delete command; fails_when=the program reruns again, returns NEXT: judge, or prints rm -rf for the sweep root;
  //   why_new=GST-1322 d3 (no unattended rm -rf) and d5 (one rerun per slot); seam=gstack-review-dispatch sweep --phase end; no_claim=who created the reported path
  test('a fetch on the rerun stops the pass, verify refuses, and a root-level repository gets KEEP, never a delete command', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { output: t => { if (t === 'ship f2p1 specialist-batched') clone(path.join(dir, '.state/BEAM')); if (t === 'ship f2p1 specialist-batched#2') clone(path.join(dir, '.state')); return 'NO FINDINGS'; } });
    let res = await runPass(h, { base: 'main', out, pass: 'f2p1', planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('FETCH_RERUN_BLOCKED: stage=specialists attempt=2');
    fs.rmSync(path.join(dir, '.state/BEAM'), { recursive: true, force: true });
    res = await runPass(h, { base: 'main', out, pass: 'f2p1', planFlags: ['--depth-floor', 'full'] });
    for (let i = 0; i < 4 && res.includes('NEXT: poll'); i++) res = await runPass(h, { base: 'main', out, pass: 'f2p1', planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('FETCH_RERUN_SPENT: stage=specialists');
    expect(res).toMatch(/STOP: gstack-review-dispatch sweep --stage specialists --phase end exited 3/);
    expect(res).not.toContain('NEXT: judge');
    const state = fs.realpathSync(path.join(dir, '.state'));
    expect(res).toContain("KEEP: '" + state + "' (no transcript attributes it to a reader");
    expect(res).not.toContain("rm -rf -- '" + state + "'");
    expect(h.creates.filter(c => c.title.endsWith('#3'))).toHaveLength(0);
    expect(h.creates.some(c => c.title === 'ship f2p1 red-team')).toBe(false);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/^FETCH_VIOLATION: f2p1\/specialists#2 found=1/m);
    expect(v.stdout).toContain('VERIFY: dirty');
  }, 240_000);

  // Value: protects=once a stage's rerun fetched too, resuming the same pass dispatches no later stage and returns no reader output;
  //   fails_when=the resumed program skips the recorded end, dispatches the Red Team beside the kept clone and returns NEXT: judge; why_new=ship-c-p1 outside-voice#2 (High; the Captain's grant on #4011);
  //   seam=lib/capy-review-pass.js stage selection; no_claim=that the kept path is safe to keep
  test('resuming after FETCH_RERUN_SPENT stops before any later stage starts', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const input = { base: 'main', out, pass: 'f4p1', planFlags: ['--depth-floor', 'full'] };
    const h = host(dir, env, { output: t => { if (t === 'ship f4p1 specialist-batched') clone(path.join(dir, '.state/BEAM')); if (t === 'ship f4p1 specialist-batched#2') clone(path.join(dir, '.state/BEAM2')); if (t === 'ship f4p1 red-team') return 'High: src/a.ts:3 SEALED-QUOTE read beside the kept clone'; return 'NO FINDINGS'; } });
    let res = await runPass(h, input);
    expect(res).toContain('FETCH_RERUN_BLOCKED: stage=specialists attempt=2');
    fs.rmSync(path.join(dir, '.state/BEAM'), { recursive: true, force: true });
    res = await runPass(h, input);
    for (let i = 0; i < 4 && res.includes('NEXT: poll'); i++) res = await runPass(h, input);
    expect(res).toContain('FETCH_RERUN_SPENT: stage=specialists');
    const again = await runPass(h, input);
    expect(again).toMatch(/STOP: .*FETCH_RERUN_SPENT/);
    expect(again).not.toContain('NEXT: judge');
    expect(again).not.toContain('SEALED-QUOTE');
    expect(h.creates.some(c => c.title === 'ship f4p1 red-team')).toBe(false);
  }, 240_000);

  // Value: protects=while a path an earlier attempt found still exists, no reader of any stage, Step 11's voices included, starts beside it;
  //   fails_when=the voices run on the same manifest dispatches its readers beside the kept clone while the specialists rerun is blocked; why_new=ship-c-p1 outside-voice#2 (High; the Captain's grant on #4011);
  //   seam=gstack-review-dispatch sweep --phase start; no_claim=that the kept path is safe to keep
  test('Step 11 voices dispatch nothing while another stage\'s rerun is blocked by a kept clone', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const base = { base: 'main', out, pass: 'f5p1', planFlags: ['--depth-floor', 'full'] };
    const h = host(dir, env, { output: t => { if (t === 'ship f5p1 specialist-batched') clone(path.join(dir, '.state/BEAM')); return 'NO FINDINGS'; } });
    expect(await runPass(h, base)).toContain('FETCH_RERUN_BLOCKED: stage=specialists attempt=2');
    const before = h.creates.length;
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const res = await runPass(h, { ...base, stage: 'voices', models });
    expect(res).toContain("FETCH_RERUN_BLOCKED: stage=specialists attempt=2 path='" + fs.realpathSync(path.join(dir, '.state/BEAM')) + "'");
    expect(res).toMatch(/STOP: gstack-review-dispatch sweep --stage voices --phase start exited 3/);
    expect(h.creates.length).toBe(before);
  }, 240_000);
// Value: protects=a remote URL git writes quoted (one holding '#') with credentials never reaches the printed FETCH_VIOLATION, the start inventory, the manifest or the ledger, while a remote without userinfo prints exactly as configured;
  //   fails_when=the sweep scans raw config text, so the quoted value skips the userinfo strip and FAKETOKEN is printed and recorded; why_new=ship-c-v2 outside-voice#1 (High, lib/review-sweep.ts:45; GSTA-297 on #4011);
  //   seam=lib/review-sweep.ts remotes (git config --null); no_claim=that other tools print remotes safely
  test('a quoted remote URL with userinfo prints and records without it; a remote without userinfo prints unchanged', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const FAKE = 'FAKETOKEN';
    const OLD = 'FAKETOKEN-old';
    const at = (p: string, url: string) => { fs.mkdirSync(p, { recursive: true }); expect(spawnSync('bash', ['-c', 'git init -q && git remote add origin "$1"', '_', url], { cwd: p, encoding: 'utf8', timeout: 30_000 }).status).toBe(0); };
    at(path.join(dir, '.state/OLD'), `https://ci-bot:${OLD}@github.com/me/old.git#main`);
    expect(fs.readFileSync(path.join(dir, '.state/OLD/.git/config'), 'utf8')).toContain(`url = "https://ci-bot:${OLD}@github.com/me/old.git#main"`);
    const h = host(dir, env, { output: t => { if (t === 'ship f6p1 specialist-batched') { at(path.join(dir, '.state/BEAM'), `https://bot:${FAKE}@github.com/sealed-org/BEAM.git#x`); at(path.join(dir, '.state/PLAIN'), 'https://github.com/sealed-org/PLAIN.git#x'); } return 'NO FINDINGS'; } });
    const res = await runPass(h, { base: 'main', out, pass: 'f6p1', planFlags: ['--depth-floor', 'full'] });
    expect(res).toMatch(/^FETCH_VIOLATION: stage=specialists attempt=1 kind=repo path='[^']*\/BEAM' remote=https:\/\/github\.com\/sealed-org\/BEAM\.git#x bytes=/m);
    expect(res).toMatch(/^FETCH_VIOLATION: stage=specialists attempt=1 kind=repo path='[^']*\/PLAIN' remote=https:\/\/github\.com\/sealed-org\/PLAIN\.git#x bytes=/m);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    const inventories = fs.readdirSync(path.join(out, 'sweep')).map(f => fs.readFileSync(path.join(out, 'sweep', f), 'utf8'));
    expect(inventories.join('')).toContain('https://github.com/me/old.git#main');
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    for (const text of [res, v.stdout, ...inventories, fs.readFileSync(m.ledger, 'utf8'), fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')]) expect(text).not.toMatch(/FAKETOKEN|ci-bot|bot:/);
  }, 240_000);

  // Value: protects=a test run's fixture repositories left beside a stage (a root carrying the fixture marker, ship-bin's clone whose https://github.com/fx/fx.git origin resolves locally) neither quarantine the stage nor block its rerun, while an unmarked network clone in the same stage still does both;
  //   fails_when=a reader's own `bun test` that timed out before cleanup, or a lane's background suite, quarantines the pass and FETCH_RERUN_BLOCKED stops it on the leftover fixture; why_new=GST-1695 (three /ship passes lost on 11-06/07 to /tmp/ship-bin-YUgvjd and a background suite's fixtures);
  //   seam=gstack-review-dispatch sweep --phase end and --phase start; no_claim=that a clone made inside a live fixture root is seen
  test('leftover test fixtures are printed as ignored and never block the rerun; an unmarked network clone beside them still does', async () => {
    const { dir, env } = repo();
    made.push(dir);
    const out = path.join(dir, '.state/run/p1');
    const beam = path.join(dir, '.state/BEAM');
    const fixture = path.join(dir, '.state/gst-left');
    const shipBin = path.join(dir, '.state/ship-bin-left/work');
    const leftovers = () => {
      clone(path.join(fixture, 'sweep-x', 'BEAM'));
      fs.writeFileSync(path.join(fixture, FIXTURE_MARKER), '');
      clone(shipBin);
      expect(spawnSync('git', ['config', `url.${path.join(dir, '.state/ship-bin-left/origin.git')}.insteadOf`, 'https://github.com/sealed-org/BEAM.git'], { cwd: shipBin, encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    };
    const h = host(dir, env, { output: t => { if (t === 'ship f7p1 specialist-batched') { clone(beam); leftovers(); } return 'NO FINDINGS'; } });
    const input = { base: 'main', out, pass: 'f7p1', planFlags: ['--depth-floor', 'full'] };
    const blocked = await runPass(h, input);
    const real = (p: string) => `'${fs.realpathSync(p)}'`;
    expect(blocked).toContain(`FETCH_VIOLATION: stage=specialists attempt=1 kind=repo path=${real(beam)}`);
    expect(blocked).toContain(`FETCH_IGNORED: stage=specialists attempt=1 path=${real(fixture)} reason=fixture-marker`);
    expect(blocked).toContain(`FETCH_IGNORED: stage=specialists attempt=1 path=${real(shipBin)} reason=local-remote remote=https://github.com/sealed-org/BEAM.git`);
    expect(blocked).toContain(`FETCH_RERUN_BLOCKED: stage=specialists attempt=2 path=${real(beam)}`);
    expect(blocked).not.toMatch(/^FETCH_(VIOLATION|RERUN_BLOCKED): .*(gst-left|ship-bin-left)/m);
    fs.rmSync(beam, { recursive: true, force: true });
    const res = await runPass(h, input);
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(res).not.toContain('FETCH_RERUN_BLOCKED');
    expect([fs.existsSync(fixture), fs.existsSync(shipBin)]).toEqual([true, true]);
  }, 240_000);
});
