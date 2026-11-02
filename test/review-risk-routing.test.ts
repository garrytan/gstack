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

const SVG_PATH = 'docs/evals/chart.svg';
const CHART = ['<?xml version="1.0" encoding="UTF-8"?>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="img" aria-label="recall by arm">', '  <title>Recall by arm</title>',
  '  <defs><linearGradient id="g"><stop offset="0" stop-color="#4a90d9"/><stop offset="1" stop-color="#1c5fa8"/></linearGradient></defs>', '  <g font-family="sans-serif" font-size="10">',
  '    <rect x="10" y="20" width="40" height="70" fill="url(#g)" style="opacity: 0.9"/>', '    <path d="M10 90 H190" stroke="#333" stroke-width="1"/>', '    <text x="30" y="15" text-anchor="middle">33/41 &amp; up</text>', '    <use href="#g"/>', '  </g>', '</svg>', ''];
const classOf = (p: string, added: string[], removed: string[] = [], created: string[] = []) =>
  classifyDiff({ paths: [p], created, gateTagged: 0, added: { [p]: added }, removed: { [p]: removed }, perPath: [{ path: p, lines: added.length + removed.length, binary: false }] }).class;
const svgClass = (lines: string[]) => classOf(SVG_PATH, lines, [], [SVG_PATH]);
const swap = (from: string, to: string) => CHART.map(l => l.replace(from, to));

describe('GST-850 choice A: a clean chart SVG and a locale value edit stay code (light)', () => {
  // Value: protects=UI text and SVGs keep one batched reader plus the native adversarial pass (the allowlist docs paths were dropped
  //   for review cost); fails_when=a clean chart or a locale value edit plans as docs, or the batched specialist drops a write-up
  //   that publishes numbers; seam=classifyDiff and planReview
  test('a new clean chart SVG is code, and a write-up with it plans light with the batched reader', () => {
    expect(svgClass(CHART)).toBe('code');
    const md = 'docs/evals/run.md';
    const added = { [md]: ['Recall rose to 33/41.'], [SVG_PATH]: CHART };
    const p = plan({ paths: [md, SVG_PATH], created: [SVG_PATH], added, removed: {}, perPath: [{ path: md, lines: 1, binary: false }, { path: SVG_PATH, lines: CHART.length, binary: false }], numbers: scanNumbers(added) });
    expect([p.depth, roles(p)]).toEqual(['light', ['specialist', 'adversarial-native', 'outside-voice']]);
  });
  test('the batched specialist reads a write-up that publishes numbers, and leaves docs out when nothing is published', () => {
    const md = 'docs/evals/run.md', code = 'scripts/score.ts';
    const base = { paths: [code, md], added: { [code]: ['export const k = 1;'], [md]: ['Recall rose to 33/41.'] }, removed: {}, perPath: [{ path: code, lines: 1, binary: false }, { path: md, lines: 1, binary: false }] };
    const batched = (numbers: ReturnType<typeof scanNumbers>) => plan({ ...base, numbers }).dispatches.find(d => d.name === 'batched')!.exclude.join(' ');
    expect(batched(scanNumbers(base.added))).not.toContain(md);
    expect(batched(none)).toContain(md);
  });
  test.each([
    ['json', 'locales/en.json', '  "save": "Save",', '  "save": "Save now",'],
    ['arb', 'lib/l10n/app_en.arb', '  "greeting": "Hello {name}",', '  "greeting": "Hi there {name}",'],
    ['yaml quoted', 'app/i18n/en.yml', '  save: "Save"', '  save: "Save now"'],
    ['yaml plain', 'locales/en.yaml', '    cancel: Cancel', '    cancel: Cancel it'],
    ['po', 'locale/fr/LC_MESSAGES/app.po', 'msgstr "Enregistrer %s"', 'msgstr "Sauvegarder %s"'],
    ['strings', 'Resources/lang/en.lproj/Localizable.strings', '"save" = "Save";', '"save" = "Save now";'],
    ['xliff', 'translations/messages.fr.xlf', '        <target>Enregistrer</target>', '        <target>Sauvegarder</target>'],
    ['ftl', 'locales/en-US/main.ftl', 'welcome = Welcome, { $user }!', 'welcome = Hello, { $user }!'],
    ['properties', 'src/main/resources/i18n/messages_en.properties', 'button.save=Save', 'button.save=Save now'],
  ])('a %s value edit under a locale directory is code', (_n, p, before, after) => {
    expect(classOf(p, [after], [before])).toBe('code');
  });
});

describe('GST-850: every bypass of the line-pattern docs paths stays code', () => {
  // Value: protects=active or bound content never plans as docs; fails_when=any bypass from GST-850 or a sibling spelling classes docs;
  //   seam=classifyDiff
  test.each([
    ['namespaced <s:script>', ['<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>window.x=42</s:script></svg>']],
    ['a <script> element', swap('<title>', '<script>alert(1)</script><title>')],
    ['an uppercase SCRIPT', swap('<title>', '<SCRIPT>alert(1)</SCRIPT><title>')],
    ['a multi-line onload attribute', ['<svg xmlns="http://www.w3.org/2000/svg"', '  onload', '  ="alert(1)">', '</svg>']],
    ['an onclick handler', swap('<rect ', '<rect onclick="alert(1)" ')],
    ['a Vue :fill binding', swap('<rect ', '<rect :fill="leak(document.cookie)" ')],
    ['a v-bind: binding', swap('<rect ', '<rect v-bind:fill="x" ')],
    ['an Alpine x-bind: binding', swap('<rect ', '<rect x-bind:fill="x" ')],
    ['an @click binding', swap('<rect ', '<rect @click="x()" ')],
    ['mustache text', swap('33/41 &amp; up', '{{ constructor.constructor("alert(1)")() }}')],
    ['a foreignObject', swap('<title>', '<foreignObject><div>x</div></foreignObject><title>')],
    ['an animate on href', swap('<use href="#g"/>', '<use href="#g"><animate attributeName="href" to="javascript:alert(1)"/></use>')],
    ['a set element', swap('<use href="#g"/>', '<set attributeName="fill" to="red"/>')],
    ['a doctype with an entity', ['<!DOCTYPE svg [<!ENTITY x "y">]>', ...CHART.slice(1)]],
    ['an xlink:href', swap('<use href="#g"/>', '<use xlink:href="#g"/>')],
    ['an outside use href', swap('<use href="#g"/>', '<use href="https://evil.example/x.svg#a"/>')],
    ['an href off use', swap('<text x="30"', '<text href="#g" x="30"')],
    ['a style url(', swap('style="opacity: 0.9"', 'style="fill: url(#g)"')],
    ['a style @import', swap('style="opacity: 0.9"', 'style="@import url(x.css)"')],
    ['an outside fill url', swap('fill="url(#g)"', 'fill="url(https://evil.example/x)"')],
    ['a CSS-escaped url', swap('fill="url(#g)"', 'fill="\\75rl(https://evil.example/x)"')],
    ['an xml-stylesheet instruction', ['<?xml-stylesheet href="https://evil.example/x.css"?>', ...CHART.slice(1)]],
    ['a CDATA section', swap('33/41 &amp; up', '<![CDATA[<script>x</script>]]>')],
    ['an image element', swap('<title>', '<image href="https://evil.example/x.png"/><title>')],
    ['a style element', swap('<title>', '<style>@import url(x.css);</style><title>')],
    ['another namespace', swap('xmlns="http://www.w3.org/2000/svg"', 'xmlns="http://www.w3.org/1999/xhtml"')],
    ['a numeric entity in an attribute', swap('fill="url(#g)"', 'fill="&#117;rl(https://evil.example/x)"')],
    ['an unclosed root', CHART.slice(0, -2)],
    ['two roots', [...CHART, '<svg xmlns="http://www.w3.org/2000/svg"></svg>']],
    ['text after the root', [...CHART, 'trailing']],
    ['an HTML-closed empty comment <!-->', swap('<title>', '<!--><image width="1" height="1"/>--><title>')],
    ['an HTML-closed empty comment <!--->', swap('<title>', '<!---><foreignObject/>--><title>')],
    ['numeric references spelling an interpolation', swap('33/41 &amp; up', '&#123;&#123;run()&#125;&#125;')],
    ['an attribute interpolation', swap('<text x="30"', '<text class="{{run()}}" x="30"')],
  ])('a new SVG with %s is code', (_n, lines) => {
    expect(svgClass(lines as string[])).toBe('code');
  });
  test('an edited SVG is code even when both sides are clean', () => {
    expect(classOf(SVG_PATH, CHART, swap('33/41', '30/41'))).toBe('code');
    expect(classOf(SVG_PATH, CHART)).toBe('code');
  });
  test.each([
    ['i18n .ts', 'src/i18n/en.ts', "  save: 'Save',", "  save: 'Save now',"],
    ['string-concat HTML', 'src/App.tsx', "const html = '<h1>' + title + '</h1>';", "const html = '<h1>' + leak() + '</h1>';"],
    ['an edit inside an existing <script>', 'src/App.vue', '  const label = "Save";', '  const label = "Save now";'],
    ['a Vue :title binding', 'src/App.vue', '<div :title="user.name">Profile</div>', '<div :title="leak(document.cookie)">Profile</div>'],
    ['a markup value', 'locales/en.json', '  "save": "Save",', '  "save": "<img src=x onerror=alert(1)>",'],
    ['a changed placeholder', 'locales/en.json', '  "hi": "Hi {name}",', '  "hi": "Hi {user.password}",'],
    ['a new mustache expression', 'locales/en.json', '  "hi": "Hi",', '  "hi": "Hi {{constructor.constructor(1)()}}",'],
    ['a vue-i18n linked message', 'locales/en.json', '  "hi": "Hi",', '  "hi": "Hi @:secret.key",'],
    ['an i18next nesting', 'locales/en.json', '  "hi": "Hi",', '  "hi": "Hi $t(secret)",'],
    ['a renamed key', 'locales/en.json', '  "save": "Save",', '  "store": "Save",'],
    ['an escaped character', 'locales/en.json', '  "save": "Save",', '  "save": "\\u003cscript\\u003e",'],
    ['a script URL', 'locales/en.yml', '  link: "https://example.com"', '  link: "javascript:alert(1)"'],
    ['a locale file outside a locale directory', 'src/en.json', '  "save": "Save",', '  "save": "Save now",'],
    ['a locale file under config/', 'config/locales/en.yml', '  save: "Save"', '  save: "Save now"'],
    ['an escaped script scheme', 'locales/en.json', '  "go": "Continue",', '  "go": "java\\nscript:alert(1)",'],
    ['a protocol-relative link', 'locales/en.json', '  "help": "[docs](/help)",', '  "help": "[docs](//evil.example/help)",'],
    ['a YAML null', 'locales/en.yml', '  label: Save', '  label: null'],
    ['a YAML boolean', 'locales/en.yml', '  label: Save', '  label: false'],
    ['a renamed gettext placeholder', 'locale/fr/LC_MESSAGES/app.po', 'msgstr "Bonjour %(name)s"', 'msgstr "Bonjour %(password)s"'],
    ['an Ansible task under a locale role', 'roles/locale/tasks/main.yml', '    command: a-tool one', '    command: b-tool two'],
    ['a non-message .properties under lang/', 'src/main/resources/lang/app.properties', 'db.url=host-a', 'db.url=host-b'],
    ['a non-locale JSON under lang/', 'tools/lang/rules.json', '  "pattern": "^[a-z]+$",', '  "pattern": ".*",'],
    ['a locale value carrying a risk line', 'src/i18n/en.yml', '  command: echo ok', '  command: rm -rf /tmp/x'],
  ])('%s is code', (_n, p, before, after) => {
    expect(classOf(p, [after], [before])).toBe('code');
  });
  test('an added key and the backtracking input are code, and the input finishes fast', () => {
    expect(classOf('locales/en.json', ['  "extra": "Extra",'])).toBe('code');
    expect(classOf('src/i18n/en.yml', ['  title: Hello', '  sub: World'], ['  title: Hello', '  sub: World'])).toBe('code');
    const t = performance.now();
    expect(classOf('locales/en.yml', ['  save: "' + '\\'.repeat(10_000) + 'x'], ['  save: "Save"'])).toBe('code');
    expect(classOf('locales/en.yml', ['  save: "' + '\\'.repeat(9_999) + '"'], ['  save: "Save"'])).toBe('code');
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('GST-850: security reaches outbound URLs, archives, path traversal and every child_process spelling', () => {
  // Value: protects=an SSRF, archive-extraction, traversal or shell-exec diff reaches the full panel; fails_when=a spelling of any of
  //   them reads light, or a literal URL, a spawnSync import or a tarball create raises a class; seam=matchRisk
  test.each([
    "import { exec } from 'node:child_process';", 'import { execSync as run } from "child_process";', "import { spawn, spawnSync } from 'node:child_process';",
    "import cp from 'node:child_process';", "import * as cp from 'child_process';", "import cp, { spawnSync } from 'child_process';",
    "const { exec } = require('child_process');", "const cp = require('node:child_process');", "const cp = await import('node:child_process');",
    'exec(cmd, cb);', 'cp.exec(cmd);',
    'const res = await fetch(url);', "await fetch('https://' + host + '/v1');", 'https.get(target, cb);', 'await axios.get(req.query.u);', 'const body = await got(url).text();',
    'r = requests.get(url, timeout=5)', 'urllib.request.urlopen(target)', 'const next = new URL(req.query.next, base);', "import { request } from 'undici';",
    "const res = await fetch('https://x.example', { redirect: 'follow' });", 'maxRedirects: 10,', 'r = httpx.get("https://x.example", follow_redirects=True)', 'const p = process.env.HTTPS_PROXY;', 'const agent = new HttpsProxyAgent(p);',
    "const ALLOWED_HOSTS = ['api.example.com'];", 'hostAllowlist.push(h);',
    'await tar.x({ file, cwd: dest });', 'new AdmZip(buf).extractAllTo(dir, true);', "import yauzl from 'yauzl';", "import extract from 'extract-zip';", 'zipfile.ZipFile(p).extractall(d)',
    'tarfile.open(p).extractall(d)', 'tar -xzf "$TGZ" -C "$DIR"', 'unzip -o "$ZIP" -d "$DIR"', 'fs.writeFileSync(path.join(root, entry.path), data);', 'const dest = path.resolve(out, req.params.name);',
    "if (rel.startsWith('..')) throw new Error('escape');", "if (parts.includes('..')) return;", '  exec as run,', '  exec: run,',
  ])('%s is security', line => {
    expect(risk(['src/net.ts'], { 'src/net.ts': [line] })).toEqual(['security']);
  });
  test('a named import split over lines is security, from either side of the diff', () => {
    const split = ['import {', '  spawnSync,', '  exec,', "} from 'node:child_process';"];
    expect(risk(['src/run.ts'], { 'src/run.ts': split })).toEqual(['security']);
    expect([...matchRisk({ codePaths: ['src/run.ts'], added: {}, removed: { 'src/run.ts': split }, scopeAuth: false }).keys()]).toEqual(['security']);
    expect(risk(['src/run.ts'], { 'src/run.ts': ['import {', '  spawnSync,', "} from 'node:child_process';"] })).toEqual([]);
  });
  test('literal URLs, spawnSync imports, tarball creation and parent-dir joins are not security', () => {
    for (const line of ["const r = await fetch('https://api.github.com/repos');", "const u = new URL('https://example.com');", 'const here = new URL(import.meta.url);',
      "import { spawnSync } from 'node:child_process';", "import type { ExecOptions } from 'node:child_process';", 'tar -czf out.tgz dir', "const root = path.join(import.meta.dir, '..');",
      'const m = re.exec(line);', "ENV.fetch('HOME')", 'git fetch origin main'])
      expect(risk(['src/run.ts'], { 'src/run.ts': [line] })).toEqual([]);
  });
});

describe('GST-850: money reaches metering, charge and credit code', () => {
  // Value: protects=a billing-client or metering diff gets the money reader; fails_when=gbrain-evals #289 reads required=none again,
  //   or costume, a CLI usage line or a proxy with no billing names money; seam=matchRisk and targetedClasses
  test('gbrain-evals #289 (metering proxy and particle billing clients) reads money, each code path on its own', () => {
    const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-risk/gbrain-evals-289.json'), 'utf8'));
    expect(targetedClasses({ paths: x.paths, added: x.added, removed: x.removed, scope: { SCOPE_AUTH: 'false' }, gateTagged: 0 }).classes).toEqual(['money']);
    expect(classifyDiff({ paths: x.paths, added: x.added, removed: x.removed, gateTagged: 0 }).risk).toContain('money');
    const code = Object.keys({ ...x.added, ...x.removed });
    expect(code.length).toBe(7);
    for (const p of code) expect(matchRisk({ codePaths: [p], added: { [p]: x.added[p] ?? [] }, removed: { [p]: x.removed[p] ?? [] }, scopeAuth: false }).has('money')).toBe(true);
  });
  test('metering, charge and credit words and pairs name money; costume, CLI usage and a plain proxy do not', () => {
    expect(risk(['eval/runner/harness-metering-proxy.ts'])).toEqual(['money']);
    expect(risk(['lib/usage-tokens.ts'])).toEqual(['money']);
    for (const line of ['if (compatMayHaveBilled(e)) break;', 'const left = credits - spent;', 'await meter.record(n);', 'const usd = res.usage.output_tokens * rate;',
      'const billingProxy = startProxy();', 'export class CostClient {', 'const billable = true;'])
      expect(risk(['src/run.ts'], { 'src/run.ts': [line] })).toEqual(['money']);
    expect(risk(['src/costume.ts'])).toEqual([]);
    expect(risk(['src/cli/usage.ts'], { 'src/cli/usage.ts': ['export function printUsage() { console.log(USAGE); }'] })).toEqual([]);
    expect(risk(['src/proxy.ts'], { 'src/proxy.ts': ['const target = proxyTarget(host);'] })).toEqual([]);
    expect(risk(['src/geometry.ts'], { 'src/geometry.ts': ['const diameter = 2 * r; // a parameter'] })).toEqual([]);
    expect(classifyDiff({ paths: ['docs/usage.md'], gateTagged: 0, added: { 'docs/usage.md': ['Usage: gstack run'] }, removed: {} }).risk).toEqual([]);
  });
});
