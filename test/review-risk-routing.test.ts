/**
 * R51: review scales to risk, not size (docs/review-policy.md#review-depth, #risk-classes). The risk classes
 * (lib/review-risk.ts), the round cap, and the routing table: every gate,
 * security, user-data and money fixture still plans the full panel, and non-risky code is light at any size.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyDiff, nextStep, planReview, scanNumbers, type PlanInput } from '../lib/review-depth';
import { matchRisk, RISK_RULES } from '../lib/review-risk';
import { targetedClasses } from '../lib/review-targeted';
import { parseReviewLoop, receiptSummaryLine } from '../lib/ship-receipt';

const ROOT = path.join(import.meta.dir, '..');
const risk = (codePaths: string[], added: Record<string, string[]> = {}, scopeAuth = false) => [...matchRisk({ codePaths, added, removed: {}, scopeAuth }).keys()];

describe('risk classes', () => {
  // Value: protects=security and user-data code reaches the full panel; fails_when=a trust-boundary or data-loss signal is missed,
  //   or an unrelated path or line raises a class; seam=matchRisk
  test('security and data: paths and lines, each with a negative', () => {
    expect(risk(['src/core/trust/owner-actions.ts'])).toEqual(['security']);
    expect(risk(['lib/redact-patterns.ts'])).toEqual(['security']);
    expect(risk(['src/run.ts'], { 'src/run.ts': ['const child = spawn(cmd, { shell: true });'] })).toEqual(['security']);
    expect(risk(['src/view.tsx'], { 'src/view.tsx': ['<div dangerouslySetInnerHTML={{ __html: body }} />'] })).toEqual(['security']);
    expect(risk(['bin/x.sh'], { 'bin/x.sh': ['eval "$CMD"'] })).toEqual(['security']);
    expect(risk(['src/run.ts'], { 'src/run.ts': ['const m = re.exec(line);', 'const s = trustee.name;'] })).toEqual([]);
    expect(risk(['src/core/persistence/git-door.ts'])).toEqual(['data']);
    expect(risk(['src/db/users.ts'], { 'src/db/users.ts': ['await sql`DELETE FROM users WHERE id = ${id}`;'] })).toEqual(['data']);
    expect(risk(['app/models/user.rb'], { 'app/models/user.rb': ['User.where(stale: true).destroy_all'] })).toEqual(['data']);
    expect(risk(['src/list.ts'], { 'src/list.ts': ['// delete from the list when done', 'arr.splice(i, 1);'] })).toEqual([]);
    for (const line of ['db.exec("delete from users");', 'await sql`delete from sessions where id = 1`;', 'DELETE FROM users;', 'drop database app;', 'DROP SCHEMA s;',
      'await sql`DELETE FROM ${table} WHERE id = ?`;', 'DELETE FROM users u WHERE u.stale', 'DELETE FROM sessions USING users WHERE x', 'DELETE FROM users RETURNING id', 'const q = "DELETE FROM " + table;'])
      expect(risk(['src/db.ts'], { 'src/db.ts': [line] })).toEqual(['data']);
    for (const line of ["const r = spawn('sh', ['-c', cmd], { timeout: 1 });", "Bun.spawn(['bash', '-lc', x]);", "fs.rmSync(t, { recursive: true, force: true });", 'rm -rf "$DIR"'])
      expect(risk(['src/run.ts'], { 'src/run.ts': [line] })).toEqual(['security']);
    expect(risk(['scripts/test-pr-profile.ts', 'lib/storyboard.ts'])).toEqual([]);
    expect(RISK_RULES).toMatch(/^[0-9a-f]{16}$/);
  });
  // Value: protects=the targeted pass keeps its exact classes now that its matchers live in lib/review-risk.ts; fails_when=the move
  //   changes a money, auth or secret verdict; seam=targetedClasses over matchRisk
  test('money, auth and secret come from the same matchers the targeted pass reads', () => {
    const lines = { 'src/run.ts': ['const spend_cap_usd = 5;', 'const k = process.env.OPENAI_API_KEY;'] };
    expect(risk(['src/run.ts', 'src/auth/session.ts'], lines, true)).toEqual(['money', 'auth', 'secret']);
    expect(targetedClasses({ paths: ['src/run.ts', 'src/auth/session.ts'], added: lines, removed: {}, scope: { SCOPE_AUTH: 'true' }, gateTagged: 0 }).classes).toEqual(['money', 'auth', 'secret']);
  });
});

describe('UI text and SVGs stay code (R51: the docs paths are deferred to an allowlist classifier)', () => {
  // Value: protects=a copy edit, a Vue binding or a namespaced SVG script never plans as docs; fails_when=any of them leaves the code
  //   class or its lines skip the risk scan; seam=classifyDiff
  test.each([
    ['a JSX copy edit', 'src/App.tsx', ['<h1>Old copy</h1>'], ['<h1>New copy</h1>']],
    ['a Vue binding', 'src/App.vue', ['<div :title="user.name">Profile</div>'], ['<div :title="leak(document.cookie)">Profile</div>']],
    ['a locale value', 'locales/en.yml', ['save: "Save"'], ['save: "<img src=x onerror=alert(1)>"']],
    ['a namespaced SVG script', 'docs/chart.svg', [], ['<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>window.x=42</s:script></svg>']],
  ])('%s is code', (_n, p, removed, added) => {
    expect(classifyDiff({ paths: [p], gateTagged: 0, added: { [p]: added }, removed: { [p]: removed }, perPath: [{ path: p, lines: removed.length + added.length, binary: false }] }).class).toBe('code');
  });
});

describe('round 2 never ships an unread gate edit', () => {
  // Value: protects=a gate-class edit after round 1 always gets the owner's eyes; fails_when=a round-2 or fix-check gate edit
  //   returns done; seam=nextStep
  test('a gate edit in round 2 or in the fix-check stops for the owner; a plain below-floor fix there finishes', () => {
    expect(nextStep({ fullPasses: 2, last: 'full', fixedBelow: true, touchedGate: true })).toMatchObject({ step: 'stop', reason: expect.stringContaining('gate-class') });
    expect(nextStep({ fullPasses: 1, last: 'fix-check', touchedGate: true })).toMatchObject({ step: 'stop', reason: expect.stringContaining('gate-class') });
    expect(nextStep({ fullPasses: 2, last: 'full', fixedBelow: true }).step).toBe('done');
  });
});

const none = scanNumbers({});
const plan = (o: Partial<PlanInput>) => planReview({ paths: ['src/app.ts'], scope: { SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 10, numbers: none, history: { fullPasses: 0, last: 'none' }, ...o });
const roles = (p: ReturnType<typeof planReview>) => [...new Set(p.dispatches.map(d => d.role))];
const FULL_PANEL = ['specialist', 'red-team', 'adversarial-native', 'outside-voice'];
const captured = (name: string): Partial<PlanInput> => {
  const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-depth', name + '.json'), 'utf8'));
  return { paths: x.paths, deleted: x.deleted, stampOnly: x.stamp_only ?? [], scope: x.scope, gateTagged: x.gate_tagged, diffLines: x.diff_lines, numbers: x.numbers, perPath: x.per_path };
};
const one = (p: string, lines: string[] = ['export const a = 1;']) => ({ paths: [p], added: { [p]: lines }, removed: {}, perPath: [{ path: p, lines: lines.length, binary: false }] });

describe('routing: every gate, security, user-data and money fixture plans the full panel', () => {
  // Value: protects=R51 never lowers review on risky code; fails_when=a gate or risk fixture plans less than outside voice, Red Team,
  //   batched specialist and the native adversarial pass, or loses the targeted reader it had; seam=planReview
  test.each([
    ['captured gate fixture', captured('code'), []],
    ['gate path', one('.github/workflows/ci.yml', ['on: push']), []],
    ['gate tag', { ...one('src/a.ts'), gateTagged: 2 }, ['gate']],
    ['deleted test', { ...one('src/a.ts'), deleted: ['test/a.test.ts'] }, []],
    ['auth scope', { ...one('src/auth/session.ts'), scope: { SCOPE_AUTH: 'true' } }, ['auth']],
    ['migration scope', { ...one('db/migrate/001.sql', ['ALTER TABLE users ADD COLUMN email text;']), scope: { SCOPE_MIGRATIONS: 'true' } }, []],
    ['secret path', one('lib/credentials.ts'), ['secret']],
    ['secret line', one('src/client.ts', ['const k = process.env.OPENAI_API_KEY;']), ['secret']],
    ['money path', one('src/billing/invoice.ts'), ['money']],
    ['money line', one('src/charge.ts', ['export const spend_cap_usd = 5;']), ['money']],
    ['security path', one('lib/redact-patterns.ts'), []],
    ['security line', one('src/run.ts', ['const run = new Function(body);']), []],
    ['user-data path', one('src/core/persistence/store.ts'), []],
    ['user-data line', one('src/db/purge.ts', ['await db.users.deleteMany({ where: { stale: true } });']), []],
  ] as const)('%s', (_n, o, targeted) => {
    const p = plan({ ...(o as Partial<PlanInput>), targeted: { classes: [...targeted] } });
    expect(p.depth).toBe('full');
    expect(FULL_PANEL.filter(r => !roles(p).includes(r as never))).toEqual([]);
    expect(roles(p).includes('targeted')).toBe(targeted.length > 0);
  });
  test('non-risky code is light at any size: one batched reader with the Red Team prompt and the native adversarial', () => {
    const p = plan({ ...one('src/util.ts', Array.from({ length: 900 }, (_, n) => `export const v${n} = ${n};`)), diffLines: 900 });
    expect([p.depth, roles(p)]).toEqual(['light', ['specialist', 'adversarial-native']]);
    const docs = plan({ paths: ['docs/evals/run.md'], perPath: [{ path: 'docs/evals/run.md', lines: 400, binary: false }], numbers: scanNumbers({ 'docs/evals/run.md': ['recall 33/41'] }) });
    expect([docs.depth, roles(docs)]).toEqual(['light', ['outside-voice']]);
  });
});

describe('the receipt records the tier and the rounds', () => {
  // Value: protects=a receipt carries review_loop.rounds and the summary line prints depth and rounds; fails_when=the parser drops
  //   rounds or a legacy loop without it gains one; seam=parseReviewLoop and receiptSummaryLine
  test('rounds parse and print; a legacy loop prints no rounds', () => {
    expect(parseReviewLoop({ passes: 1, blocking_found: 0, deferred: 0, fix_checks: 1, rounds: 2 })).toMatchObject({ rounds: 2 });
    const r = { pr: 7, head: 'a'.repeat(40), base: 'main', review_depth: { depth: 'light' }, review_loop: { passes: 1, blocking_found: 0, deferred: 0, fix_checks: 1, rounds: 2 } } as never;
    expect(receiptSummaryLine(r)).toContain('depth=light passes=1 blocking_found=0 deferred=0 fix_checks=1 rounds=2');
    const legacy = { pr: 7, head: 'a'.repeat(40), base: 'main', review_loop: { passes: 2, blocking_found: 1, deferred: 0 } } as never;
    expect(receiptSummaryLine(legacy)).not.toContain('rounds=');
  });
});
