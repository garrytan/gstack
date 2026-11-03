import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyDiff, nextStep, planReview, platformFits, scanNumbers, type PlanInput, type ReviewShape } from '../lib/review-depth';
import { appendEvent, verify } from '../lib/review-ledger';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { matchRisk } from '../lib/review-risk';
import { renderBrief, sectionTexts, sliceDiff, sliceNote } from '../lib/review-brief';
import { validatePolicy, DEFAULT_POLICY, REVIEW_POLICY_KEY_VERSION } from '../lib/ship-policy';

const ROOT = path.join(import.meta.dir, '..');
const none = scanNumbers({});
const HEAD = 'a'.repeat(40);
const lean = (o: Partial<ReviewShape> = {}): ReviewShape => ({ panel: 'risk', readerModel: 'lane', platform: 'off', head: HEAD, platformReview: null, ...o });
const base = (o: Partial<PlanInput>): PlanInput => ({ paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120, history: { fullPasses: 0, last: 'none' }, numbers: none, shape: lean(), ...o });
const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}:${d.effort}:${d.model ?? '-'}`);

describe('HARN-1 false triggers (harness-evals#231 on 1.93.7.0): data, config and stats scripts never raise the depth', () => {
  const sqlite = 'docs/benchmarks/2026-11-01-installer-cc-codex/results/cc-none.smoke.ledger.sqlite';
  test('committed sqlite ledgers git cannot count are data, not code, and never name money', () => {
    const c = classifyDiff({ paths: [sqlite, 'README.md'], gateTagged: 0, perPath: [{ path: sqlite, lines: 0, binary: true }, { path: 'README.md', lines: 3, binary: false }], consumed: [] });
    expect([c.class, c.errors.map(e => e.code), c.risk]).toEqual(['docs', [], []]);
  });
  test('run logs are data too: *.log, *.out and extensionless files under logs/ never name money or security (subagent replay at f6a7eba)', () => {
    const logs = ['docs/b/results/cc-installer.plan.log', 'docs/b/results/trials/t1/r1/agent.out', 'docs/b/results/trials/t1/r1/logs/ready'];
    const c = classifyDiff({ paths: logs, gateTagged: 0, added: Object.fromEntries(logs.map(p => [p, ['spend_cap_usd=5 fetch(url) rm -rf /tmp/x']])) });
    expect([c.class, c.risk]).toEqual(['docs', []]);
    expect(classifyDiff({ paths: ['src/logs/rotate.ts'], gateTagged: 0 }).class).toBe('code');
  });
  // Value: protects=a directory name or a data extension never downgrades an executable (GSTA-258 L7 Addendum 1 and 7);
  //   fails_when=scripts/logs/prune or an executable .out classes as docs; seam=collector executables -> classifyDiff
  test('an executable (exec bit or shebang) under logs/ or named .out stays code; plain logs stay docs', () => {
    const exe = ['scripts/logs/prune', 'tools/build/runner.out'];
    const c = classifyDiff({ paths: [...exe, 'logs/run.txt'], gateTagged: 0, executables: exe });
    expect(c.class).toBe('code');
    expect(c.reasons).toEqual(expect.arrayContaining(['code: scripts/logs/prune']));
    for (const p of exe) expect(classifyDiff({ paths: [p], gateTagged: 0, executables: [p] }).class).toBe('code');
    const txt = 'scripts/logs/prune.txt';
    const printsKey = classifyDiff({ paths: [txt], gateTagged: 0, executables: [txt], added: { [txt]: ['curl -H "Authorization: Bearer abcdefgh12345678"'] } });
    expect([printsKey.class, printsKey.risk]).toEqual(['code', ['security']]);
    expect(classifyDiff({ paths: ['logs/run.txt', 'docs/r/logs/ready'], gateTagged: 0, executables: [] }).class).toBe('docs');
  });
  // Value: protects=sealed custody and outside-model prompt egress plan full depth (GST-1177: harness-evals#237, gstack #3921);
  //   fails_when=scripts/sealed/seal.ts or the #3921 secret-egress lines class light with no risk; seam=matchRisk path and line rules
  test('sealed custody and code that redacts or ships repo content to an outside model are security', () => {
    const sec = (p: string, lines: string[] = ['export const x = 1;']) => matchRisk({ codePaths: [p], added: { [p]: lines }, scopeAuth: false }).has('security');
    expect(sec('scripts/sealed/seal.ts')).toBe(true);
    expect(sec('lib/eval-custody.ts')).toBe(true);
    expect(sec('lib/autoplan-lean.ts', ["import { redactFindingSpans } from './redact-engine';"])).toBe(true);
    expect(sec('lib/autoplan-lean.ts', ['  const redacted = (patch: string) => redactFindingSpans(patch) ?? "";'])).toBe(true);
    expect(sec('lib/autoplan-lean.ts', ['const SECRET_NAME = /(^|\\/)(\\.env[^/]*)$/i;'])).toBe(true);
    expect(sec('lib/review-x.ts', ["import { runOutsideVoice } from './outside-voice-runner';"])).toBe(true);
    for (const l of ['out = redact_secrets(text)', 'from gstack.redact import scrub', "import './outside-voice';", 'SECRET_PATTERNS = [/sk-[a-z]+/]', 'const CREDENTIAL_RE = new RegExp(src);']) expect(sec('lib/x.ts', [l])).toBe(true);
    expect(sec('lib/autoplan-lean.ts', ['const INLINE_DRAFT_BYTES = 64_000;'])).toBe(false);
    expect(sec('lib/x.ts', ['const SECRET_COUNT = total / 2;', "import { readFile } from 'node:fs';"])).toBe(false);
    expect(sec('lib/seasonal.ts')).toBe(false);
    expect(classifyDiff({ paths: ['scripts/sealed/seal.ts'], gateTagged: 0 }).risk).toContain('security');
  });
  test('a sqlite file is data even when a script names it', () => {
    const c = classifyDiff({ paths: [sqlite, 'scripts/load.py'], gateTagged: 0, perPath: [{ path: sqlite, lines: 0, binary: true }, { path: 'scripts/load.py', lines: 4, binary: false }], consumed: [sqlite] });
    expect([c.class, c.errors.map(e => e.code), c.runtimeLines]).toEqual(['code', [], 4]);
  });
  test('money on lease_usd lines of a JSON config a script reads is not a risk class; the config is judged by its path', () => {
    const p = 'docs/benchmarks/x/results/cc-none.shard-vm.json';
    expect(matchRisk({ codePaths: [p], added: { [p]: ['  "lease_usd": 32.9,', '  "list_price_usd": 1.2485,'] }, scopeAuth: false }).size).toBe(0);
    expect(matchRisk({ codePaths: ['config/billing.json'], added: { 'config/billing.json': ['{}'] }, scopeAuth: false }).has('money')).toBe(true);
    expect(matchRisk({ codePaths: ['lib/lease.ts'], added: { 'lib/lease.ts': ['const lease_usd = 3;'] }, scopeAuth: false }).has('money')).toBe(true);
  });
  test('a stats script under a results directory is judged by its path: no security or money from its name or lines', () => {
    const p = 'docs/benchmarks/2026-11-01-installer-cc-codex/results/cost-intervals.py';
    expect(matchRisk({ codePaths: [p], added: { [p]: ["rows = [json.loads(l) for l in open(os.path.join(sys.argv[1], 'trials.jsonl'))]"] }, scopeAuth: false }).size).toBe(0);
    expect(matchRisk({ codePaths: ['tools/fetch.py'], added: { 'tools/fetch.py': ['p = os.path.join(sys.argv[1], name)'] }, scopeAuth: false }).has('security')).toBe(true);
  });
  test('a paid-provider call, a spend cap or a key in a results script or config file still counts', () => {
    const run = 'benchmarks/run_models.py', sweep = 'analysis/sweep.py', cfg = 'evals/config.yaml';
    expect(matchRisk({ codePaths: [run], added: { [run]: ['resp = client.messages.create(model=m)'] }, scopeAuth: false }).has('money')).toBe(true);
    expect(matchRisk({ codePaths: [sweep], added: { [sweep]: ['MAX = spend_cap(5)'] }, scopeAuth: false }).has('money')).toBe(true);
    expect(matchRisk({ codePaths: [run], added: { [run]: ['key = os.environ["OPENAI_API_KEY"]'] }, scopeAuth: false }).has('secret')).toBe(true);
    expect(matchRisk({ codePaths: [cfg], added: { [cfg]: ['spend_cap: 9999'] }, scopeAuth: false }).has('money')).toBe(true);
    expect(matchRisk({ codePaths: [cfg], added: { [cfg]: ['lease_usd: 3'] }, scopeAuth: false }).has('money')).toBe(false);
    expect(matchRisk({ codePaths: ['lib/analysis/billing.py'], added: { 'lib/analysis/billing.py': ['charge(customer, amount_usd)'] }, scopeAuth: false }).has('money')).toBe(true);
    expect(matchRisk({ codePaths: ['docs/conf.py'], added: { 'docs/conf.py': ['p = os.path.join(sys.argv[1], name)'] }, scopeAuth: false }).has('security')).toBe(true);
  });
  test('a secret in a config file still counts', () => {
    expect(matchRisk({ codePaths: ['deploy/app.yaml'], added: { 'deploy/app.yaml': ['  key: ${OPENAI_API_KEY}'] }, scopeAuth: false }).has('secret')).toBe(true);
  });
});

describe('FOUN-64 item 4: docs that can print a credential are security risk (gbrain#8417)', () => {
  const docsWith = (line: string) => classifyDiff({ paths: ['docs/mcp.md'], gateTagged: 0, added: { 'docs/mcp.md': [line] } });
  test.each([['$ claude mcp get gbrain'], ['Authorization: Bearer abcdefgh12345678'], ['export OPENAI_API_KEY=sk-live-0123456789abcdefghij'], ['gh auth token']])('%s', l => expect(docsWith(l).risk).toEqual(['security']));
  test('ordinary docs stay risk-free', () => expect(docsWith('Run gstack-review-plan --base main to see the plan.').risk).toEqual([]));
});

describe('FOUN-32 §4: eval scorers, judges and graders are risk class eval by path', () => {
  test.each([['lib/eval-scorer.ts'], ['evals/judges/rubric.py'], ['scripts/grade-trials.ts']])('%s', p => expect(classifyDiff({ paths: [p], gateTagged: 0 }).risk).toContain('eval'));
  test('a test helper named judge stays tests class, and an ordinary path is not eval', () => {
    expect(classifyDiff({ paths: ['test/helpers/llm-judge.ts'], gateTagged: 0 }).risk).toEqual([]);
    expect(classifyDiff({ paths: ['lib/review-pass.ts'], gateTagged: 0 }).risk).not.toContain('eval');
  });
});

describe('risk_paths: a repo extends the risk classes from its base policy (FOUN-64)', () => {
  const rp = ['src/balance/**', 'src/outcome*.ts'];
  test('a matching code path is risk class policy; data and docs under the glob are not', () => {
    expect(classifyDiff({ paths: ['src/balance/view.tsx'], gateTagged: 0, riskPaths: rp }).risk).toEqual(['policy']);
    expect(classifyDiff({ paths: ['src/outcome-score.ts'], gateTagged: 0, riskPaths: rp }).risk).toEqual(['policy']);
    expect(classifyDiff({ paths: ['src/balance/snap.sqlite', 'src/balance/notes.md'], gateTagged: 0, riskPaths: rp, consumed: [] }).risk).toEqual([]);
    expect(classifyDiff({ paths: ['src/app.ts'], gateTagged: 0, riskPaths: rp }).risk).toEqual([]);
  });
  test('a policy risk path plans the merged reader at full depth', () => {
    const p = planReview(base({ paths: ['src/balance/x.ts'], riskPaths: rp, shape: lean({ panel: 'off' }) }));
    expect([p.depth, roles(p)]).toEqual(['full', ['adversarial-native:merged:full:lane']]);
    expect(planReview(base({ paths: ['src/balance/x.ts'], riskPaths: rp })).mode).toBe('panel');
  });
});

describe('R65 lean dispatch (GSTA-258 build C): one reviewer, once', () => {
  test('non-risk code: one native reader at the lane\'s reasoning carrying the adversarial brief, the checklists and the Red Team', () => {
    const p = planReview(base({}));
    expect([p.mode, roles(p)]).toEqual(['lean', ['adversarial-native:single:full:lane']]);
    expect(p.dispatches[0]!.checklists).toEqual(['testing', 'security', 'red-team']);
    expect(p.skipped.join('\n')).toMatch(/outside-voice/);
  });
  test('non-risk code that publishes numbers keeps the native reader by default (FOUN-32 §3, ggstack#52); cross-family is a setting', () => {
    const p = planReview(base({ paths: ['src/app.ts', 'docs/results.md'], numbers: scanNumbers({ 'docs/results.md': ['recall 87% (26/30)'] }) }));
    expect(roles(p)).toEqual(['adversarial-native:single:full:lane']);
    expect(roles(planReview(base({ shape: lean({ readerModel: 'cross-family' }) })))).toEqual(['adversarial-native:single:full:cross-family']);
  });
  test('panel risk (opt-in, FOUN-64 item 1): a risk-class diff gets the printed full-depth panel; a fixed blocker re-runs the printed plan as round 2 (FOUN-32 §5)', () => {
    const today = roles(planReview(base({ paths: ['lib/billing.ts'], targeted: { classes: ['money'] }, shape: undefined })));
    const p = planReview(base({ paths: ['lib/billing.ts'], targeted: { classes: ['money'] } }));
    expect([p.depth, p.mode, roles(p)]).toEqual(['full', 'panel', today]);
    expect(today.length).toBeGreaterThan(1);
    expect(planReview(base({ paths: ['lib/billing.ts'], history: { fullPasses: 1, last: 'full', fixedBlocking: true } })).next.step).toBe('full');
    expect(planReview(base({ paths: ['lib/billing.ts'], history: { fullPasses: 2, last: 'full', fixedBlocking: true } })).next.step).toBe('stop');
    expect(planReview(base({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } })).next.step).toBe('fix-check');
  });
  test('panel off: risk class gets one reader on the configured model with the merged panel brief; it carries the targeted classes', () => {
    const p = planReview(base({ paths: ['lib/billing.ts'], targeted: { classes: ['money'] }, shape: lean({ panel: 'off' }) }));
    expect([p.depth, roles(p)]).toEqual(['full', ['adversarial-native:merged:full:lane']]);
    expect(p.dispatches[0]!.classes).toEqual(['money']);
    expect(p.dispatches[0]!.checklists).toContain('red-team');
    const opus = planReview(base({ paths: ['.github/workflows/ci.yml'], shape: lean({ panel: 'off', readerModel: 'anthropic/claude-opus-5-5' }) }));
    expect(roles(opus)).toEqual(['adversarial-native:merged:full:anthropic/claude-opus-5-5']);
  });
  test('docs and tests stay core only; docs with numbers keep the outside voice', () => {
    expect(planReview(base({ paths: ['README.md'], gateTagged: null })).dispatches).toEqual([]);
    expect(roles(planReview(base({ paths: ['docs/r.md'], numbers: scanNumbers({ 'docs/r.md': ['cost $4.10'] }) })))).toEqual(['outside-voice:outside-voice:host:-']);
  });
  test('panel all is today\'s panel; panel risk keeps it on risk class only', () => {
    const today = (o: Partial<PlanInput>) => roles(planReview(base({ ...o, shape: undefined })));
    expect(roles(planReview(base({ paths: ['lib/billing.ts'], shape: lean({ panel: 'all' }) })))).toEqual(today({ paths: ['lib/billing.ts'] }));
    expect(roles(planReview(base({ paths: ['lib/billing.ts'], shape: lean({ panel: 'risk' }) })))).toEqual(today({ paths: ['lib/billing.ts'] }));
    expect(planReview(base({ shape: lean({ panel: 'risk' }) })).mode).toBe('lean');
    expect(planReview(base({ shape: lean({ panel: 'all' }) })).mode).toBe('panel');
  });
});

describe('C6 platform depth (FOUN-32, founderstar#496): a planned skip needs the platform review at the exact head', () => {
  test('runtime code never fits the platform depth, even with no runtime lines (a registered generated output, a mode-only change)', () => {
    const none = scanNumbers({});
    expect(platformFits('code', ['dist/app.js'], 0, none)).toBe(false);
    expect(platformFits('gate', ['scripts/start.sh'], 0, none)).toBe(false);
    expect(platformFits('docs', ['docs/a.md'], 0, none)).toBe(true);
    expect(platformFits('tests', ['test/a.test.ts'], 0, none)).toBe(true);
  });
  test('verify marks an outside-voice diff file changed after render as a mismatch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
    const ledger = path.join(dir, 'ledger.jsonl'), brief = path.join(dir, 'brief.md'), diff = path.join(dir, 'outside-voice.diff');
    fs.writeFileSync(brief, 'brief'); fs.writeFileSync(diff, '+code\n');
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    appendEvent(ledger, { event: 'rendered', reader: 'outside-voice', role: 'outside-voice', file: brief, sha256: sha('brief'), payload: { file: diff, sha256: sha('+code\n') } } as any);
    expect(verify(ledger).rows.find(r => r.kind === 'BRIEF')!.detail).not.toContain('payload_changed_since_render');
    fs.writeFileSync(diff, '+docs only\n');
    const row = verify(ledger).rows.find(r => r.kind === 'BRIEF')!;
    expect([row.status, row.detail.includes('payload_changed_since_render')]).toEqual(['MISMATCH', true]);
  });
  const on = (review: ReviewShape['platformReview']) => lean({ platform: 'on', platformReview: review });
  const docs = { paths: ['docs/howto-install.md', 'test/a.test.ts'] };
  test('platform on with the review at HEAD on a docs or tests diff: no reader, a planned SKIP for every reader, the core read included', () => {
    const p = planReview(base({ ...docs, shape: on({ id: '5744388738', head: HEAD, reviewer: 'capy-ai[bot]' }) }));
    expect([p.mode, p.next.step, p.dispatches]).toEqual(['platform', 'platform', []]);
    expect(p.skipped.filter(s => /planned skip/.test(s)).length).toBeGreaterThanOrEqual(2);
    expect(p.skipped.join('\n')).toMatch(/core.*planned skip.*5744388738/);
  });
  test('without the evidence, or with it at another head, the core read stands', () => {
    expect(planReview(base({ ...docs, shape: on(null) })).mode).toBe('lean');
    expect(planReview(base({ ...docs, shape: on({ id: '1', head: 'b'.repeat(40), reviewer: 'capy-ai[bot]' }) })).next.step).toBe('full');
  });
  test('FOUN-64 item 2: runtime code, results or prereg paths never take the platform depth', () => {
    const ev = { id: '1', head: HEAD, reviewer: 'capy-ai[bot]' };
    expect(roles(planReview(base({ shape: on(ev) })))).toEqual(['adversarial-native:single:full:lane']);
    expect(planReview(base({ paths: ['docs/benchmarks/run/results/summary.md'], shape: on(ev) })).mode).toBe('lean');
    expect(planReview(base({ paths: ['evals/prereg.md'], shape: on(ev) })).mode).toBe('lean');
  });
  test('risk class and published numbers never take the platform depth', () => {
    const ev = { id: '1', head: HEAD, reviewer: 'capy-ai[bot]' };
    expect(planReview(base({ paths: ['lib/billing.ts'], shape: on(ev) })).mode).toBe('panel');
    expect(planReview(base({ paths: ['src/app.ts', 'docs/r.md'], numbers: scanNumbers({ 'docs/r.md': ['p50 4.7 h'] }), shape: on(ev) })).mode).toBe('lean');
  });
  test('under the default panel all, platform on still takes the platform depth at HEAD; everything else keeps today\'s panel', () => {
    const ev = { id: '1', head: HEAD, reviewer: 'capy-ai[bot]' };
    const all = (review: ReviewShape['platformReview']) => lean({ panel: 'all', platform: 'on', platformReview: review });
    expect(planReview(base({ ...docs, shape: all(ev) })).mode).toBe('platform');
    expect(planReview(base({ ...docs, shape: all(null) })).mode).toBe('panel');
    expect(planReview(base({ shape: all(ev) })).mode).toBe('panel');
  });
  test('the platform skip is pass 1 only: a later step plans as lean', () => {
    const p = planReview(base({ shape: on({ id: '1', head: HEAD, reviewer: 'capy-ai[bot]' }), history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(p.next.step).toBe('fix-check');
  });
});

describe('R65 lean loop: one fix round, never more than 2 rounds', () => {
  const h = (o: object) => ({ fullPasses: 1, last: 'full' as const, lean: true, ...o });
  test('non-risk: a fixed blocker earns one fix-check; below-floor fixes ship as notes', () => {
    expect(nextStep(h({ fixedBlocking: true }), 'light').step).toBe('fix-check');
    expect(nextStep(h({ fixedBelow: true }), 'light')).toMatchObject({ step: 'done', reason: expect.stringContaining('notes') });
  });
  test('risk: any fix earns one scoped fix-check, a gate-class edit included, never a second full pass', () => {
    for (const o of [{ fixedBlocking: true }, { fixedBelow: true }, { fixedBelow: true, touchedGate: true }]) expect(nextStep(h(o), 'full').step).toBe('fix-check');
  });
  test('a fix-check blocker stops for the owner; a recorded grant adds one fix-check, never two', () => {
    expect(nextStep(h({ last: 'fix-check', fixedBlocking: true, fixChecks: 1 }), 'full').step).toBe('stop');
    expect(nextStep(h({ last: 'fix-check', fixedBlocking: true, fixChecks: 1, granted: 'apr_1' }), 'full').step).toBe('fix-check');
    expect(nextStep(h({ last: 'fix-check', fixedBlocking: true, fixChecks: 2, granted: 'apr_1' }), 'full').step).toBe('stop');
    expect(nextStep(h({ last: 'fix-check', fixedBlocking: true, granted: 'apr_1' }), 'full').step).toBe('stop');
  });
  test('planReview marks the loop lean and a fix-check dispatches one full-effort reader', () => {
    expect(roles(planReview(base({ paths: ['lib/billing.ts'], history: { fullPasses: 1, last: 'full', fixedBlocking: true }, shape: lean({ panel: 'off' }) })))).toEqual(['fix-check:fix-check:full:-']);
  });
});

describe('C7 merged reader brief and the outside voice reading its diff from disk', () => {
  const t = sectionTexts(ROOT);
  const sha = 'c'.repeat(40);
  test('the merged reader renders the targeted brief and every checklist in one native adversarial context', () => {
    const brief = fs.readFileSync(path.join(ROOT, 'review/specialists/targeted.md'), 'utf8');
    const text = renderBrief('adversarial-native', { diff_base: sha, checklists: '/x/testing.md,/x/red-team.md', classes: 'money', brief, checklist: '/x/targeted.md' }, t);
    expect(text).toContain(t.native.slice(0, 60));
    expect(text).toContain('/x/testing.md, /x/red-team.md');
    expect(text).toMatch(/money/);
  });
  test('past the cap the outside voice reads a path-scoped slice that names what it left out (FOUN-32 §3)', () => {
    const sec = (p: string, n: number) => `diff --git a/${p} b/${p}\n+${'x'.repeat(n)}\n`;
    const s = sliceDiff(sec('a.ts', 10) + sec('big.json', 500) + sec('b.ts', 10), 100);
    expect([s.sliced, s.kept, s.files, s.left]).toEqual([true, 2, 3, ['big.json']]);
    expect(s.text).toContain('b/b.ts');
    expect(sliceNote(s, 100)).toMatch(/2 of 3 files.*big\.json/);
    expect(sliceDiff(sec('a.ts', 10), 100).sliced).toBe(false);
  });
  // Value: protects=no file leaves the outside voice's slice unnamed (GSTA-258 L7 Addendum 1.2); fails_when=a git-quoted header
  //   before the first plain one is dropped unlisted, or glued onto the file before it; seam=sliceDiff headers
  test('a git-quoted or spaced filename is its own file in the slice and is named when left out', () => {
    const quoted = (p: string, n: number) => `diff --git "a/${p}" "b/${p}"\n+${'x'.repeat(n)}\n`;
    const sec = (p: string, n: number) => `diff --git a/${p} b/${p}\n+${'x'.repeat(n)}\n`;
    const s = sliceDiff(quoted('t\\303\\251st.sql', 500) + sec('a.ts', 10) + quoted('tab\\there.ts', 10), 100);
    expect([s.files, s.kept, s.left]).toEqual([3, 2, ['"t\\303\\251st.sql"']]);
    expect(s.text).toContain('tab\\there.ts');
    const spaced = sliceDiff(sec('my notes/big data.csv', 500) + sec('a.ts', 10), 100);
    expect(spaced.left).toEqual(['my notes/big data.csv']);
  });
  test('the outside voice gets a path and a hash, not the pasted diff', () => {
    const text = renderBrief('outside-voice', { diff_base: sha, diff_file: '/tmp/o/outside-voice.diff', diff_sha256: 'd'.repeat(64), diff_bytes: '1234' }, t);
    expect(text).toContain('/tmp/o/outside-voice.diff');
    expect(text).toContain('d'.repeat(64));
    expect(text).not.toContain('```diff');
  });
});

describe('ship policy: the base-read review key', () => {
  const codes = (raw: object) => validatePolicy(raw).map(e => `${e.code}:${e.path}`);
  test('defaults: panel all (today\'s panel; risk is opt-in until its no-loss replay passes), the lane\'s native reader, platform off, no extra risk paths', () => expect(DEFAULT_POLICY.review).toEqual({ panel: 'all', reader_model: 'lane', platform: 'off', risk_paths: [] }));
  test('valid values pass with min_gstack_version; bad ones name the field', () => {
    const v = REVIEW_POLICY_KEY_VERSION;
    expect(codes({ review: { platform: 'on', reader_model: 'anthropic/claude-opus-5-5', panel: 'risk', risk_paths: ['src/balance/**'] }, min_gstack_version: v })).toEqual([]);
    expect(codes({ review: { platform: 'yes' }, min_gstack_version: v })).toEqual(['POLICY_INVALID:review.platform']);
    expect(codes({ review: { panel: 'some' }, min_gstack_version: v })).toEqual(['POLICY_INVALID:review.panel']);
    expect(codes({ review: { reader_model: 'a b' }, min_gstack_version: v })).toEqual(['POLICY_INVALID:review.reader_model']);
    expect(codes({ review: { risk_paths: ['../x'] }, min_gstack_version: v })).toEqual(['POLICY_CONTAINMENT:review.risk_paths[0]']);
    expect(codes({ review: { other: 1 }, min_gstack_version: v })).toEqual(['POLICY_INVALID:review.other']);
    expect(codes({ review: { platform: 'on' } })).toContain('POLICY_INVALID:review');
  });
});
