import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateQAMethodology } from '../scripts/resolvers/utility';
import { generateQAExploratory } from '../scripts/resolvers/qa';
import { generateTestBootstrap } from '../scripts/resolvers/testing';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { runBashScript } from './helpers/bash-script';
import { qaProbeNames } from './helpers/qa-probe-names';
import { expectMentions, expectTokens } from './helpers/prompt-structure';

const ctx = { host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude };
const method = generateQAMethodology(ctx);
const bootstrap = fs.readFileSync(path.resolve(import.meta.dir, '../qa/sections/test-bootstrap.md.tmpl'), 'utf8');
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-browser-contracts-'));
afterAll(() => fs.rmSync(owned, { recursive: true, force: true }));

function detection(body: string): string {
  const script = body.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  if (!script) throw new Error('Missing native detection script');
  return script;
}

const cases: Array<[string, Record<string, string>]> = [
  ['Django beside-source tests', { 'manage.py': '', 'requirements.txt': 'Django', 'polls/tests.py': 'test' }],
  ['Python standalone tests', { 'setup.cfg': '', 'test_math.py': 'test' }],
  ['Python declared pytest', { 'pyproject.toml': 'pytest' }],
  ['Node script and Next.js', { 'package.json': '{"scripts":{"test":"node --test"},"dependencies":{"next":"1"}}' }],
  ['Go beside-source tests', { 'go.mod': 'module fixture', 'main_test.go': 'test' }],
  ['Rust in-source tests', { 'Cargo.toml': '', 'src/lib.rs': '#[test]\nfn example() {}' }],
  ['Ruby/Rails tests', { 'Gemfile': 'rails', 'Rakefile': '', 'test_math.rb': '', 'math_spec.rb': 'test' }],
  ['PHP config', { 'composer.json': '{}', 'phpunit.xml.dist': '<phpunit/>' }],
  ['Elixir tests', { 'mix.exs': '', 'math_test.exs': 'test' }],
  ['Maven JVM tests', { 'pom.xml': '', 'ExampleTest.java': 'test' }],
  ['Gradle JVM tests', { 'build.gradle.kts': '', 'ExampleTest.kt': 'test' }],
  ['Make test target', { 'Makefile': 'test:\n\ttrue\n' }],
  ['Make check target', { 'Makefile': 'check:\n\ttrue\n' }],
  ['Runner configs', { 'jest.config.js': '', 'vitest.config.ts': '', 'playwright.config.ts': '', '.rspec': '', 'pytest.ini': '', 'tox.ini': '' }],
  ['Test directories and extensions', { 'spec/example.rb': '', '__tests__/example.ts': '', 'tests/example.py': '', 'example.test.tsx': '', 'example.spec.jsx': '' }],
  ['Untested project', { 'go.mod': '', 'main.go': 'package main' }],
  ['Unknown runtime', { 'README.md': 'fixture' }],
  ['Persistent opt-out', { '.gstack/no-test-bootstrap': '', 'package.json': '{}' }],
];

describe('compact QA bootstrap preserves native detection', () => {
  for (const shell of ['bash', 'zsh']) for (const [name, files] of cases) {
    test.skipIf(shell === 'zsh' && !Bun.which('zsh'))(`${name} (${shell})`, () => {
      const cwd = fs.mkdtempSync(path.join(owned, 'markers-'));
      for (const [relative, value] of Object.entries(files)) {
        const target = path.join(cwd, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
      }
      const init = runBashScript('git init -q && git add --all', { cwd, timeout: 10_000 });
      expect(init.status, init.stderr).toBe(0);
      const run = (source: string) => shell === 'bash'
        ? runBashScript(detection(source), { cwd, timeout: 10_000 })
        : spawnSync('zsh', ['-f', '-c', detection(source)], { cwd, timeout: 10_000, encoding: 'utf8' });
      const before = run(generateTestBootstrap(ctx));
      const after = run(bootstrap);
      expect([0, 1]).toContain(before.status);
      expect(after.status, after.stderr).toBe(before.status);
      expect(after.stdout.trim().split('\n').sort()).toEqual(before.stdout.trim().split('\n').sort());
      for (const [relative, value] of Object.entries(files)) expect(fs.readFileSync(path.join(cwd, relative), 'utf8')).toBe(value);
    });
  }

  test('QA bootstrap owns approval, cleanup, red-test evidence, CI and documentation', () => {
    expect(bootstrap).not.toContain('{{TEST_BOOTSTRAP}}');
    for (const contract of [
      'never functional/report-only', 'documented command skips bootstrap', '**do not bootstrap**',
      'AskUserQuestion and WAIT', 'install only the actual choice', 'ONLY owned changes', 'preserve user edits',
      'Never silently delete a valid red regression', '/qa\'s diagnosis/fix gate', 'First real tests',
      'min 1, max 5', 'full verified command', '.github/workflows/test.yml', 'push + pull_request',
      'ubuntu-latest', 'manual test-step addition', 'never overwrite TESTING.md', '100% test coverage',
      'BOTH branches', 'unrelated staged edits', '{{ASIDE_EXEC_PRELUDE}}', 'WebSearch',
    ]) expect(bootstrap).toContain(contract);
    expect(bootstrap).not.toContain('git checkout --');
    expect(bootstrap).not.toContain('delete silently');
  });

  test('shared {{TEST_BOOTSTRAP}} copy undoes only owned changes, like the QA copy', () => {
    for (const skillName of ['ship', 'design-review']) {
      const shared = generateTestBootstrap({ ...ctx, skillName });
      expect(shared).not.toContain('git checkout --');
      expect(shared).not.toMatch(/delete silently/i);
      expect(shared).not.toMatch(/revert all bootstrap changes/i);
      expect(shared).toMatch(/undo only/i);
      expect(shared).toMatch(/preserve the user's edits/i);
      expectMentions(shared, [['stop', 'unrelated', 'already']], 'shared');
    }
  });
});

async function runRecipe(marker: string, options: { flow?: boolean; hostname?: string; response?: string } = {}) {
  const scripts = [...method.matchAll(/aside repl '([\s\S]*?)'\n```/g)].map(match => match[1]);
  const matches = scripts.filter(script => script.includes(marker));
  expect(matches).toHaveLength(1);
  let script = matches[0];
  if (options.flow) script = script.replace('const flow = false;', 'const flow = true;');
  const events: Array<{ name: string; value?: any }> = [];
  const output: string[] = [];
  const hostname = options.hostname ?? 'localhost';
  const origin = `http://${hostname}:3000`;
  const listeners = new Map<string, (event: any) => void>();
  const window: any = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn) };
  const pageConsole = { error: (...args: unknown[]) => events.push({ name: 'console', value: args }) };
  const document = {
    body: { innerText: 'Page text' },
    querySelectorAll: () => ['/ok', '/ok', '/logout', '/signout', '/delete', '/remove', '/cancel', '/unsubscribe']
      .map(relative => ({ href: origin + relative })).concat([{ href: 'https://other.example/foreign' }]),
  };
  const pg = {
    _sendToTarget: async (name: string, value: any) => {
      events.push({ name, value });
      if (name === 'Page.addScriptToEvaluateOnNewDocument') new Function('window', 'console', value.source)(window, pageConsole);
    },
    goto: async () => {
      events.push({ name: 'goto' });
      pageConsole.error('load failure');
      listeners.get('error')?.({ message: 'uncaught failure' });
      listeners.get('unhandledrejection')?.({ reason: { message: 'promise failure' } });
    },
    screenshot: async (value: any) => events.push({ name: 'screenshot', value }),
    locator: (ref: string) => ({ click: async () => events.push({ name: 'click', value: ref }) }),
    evaluate: async (fn: Function) => new Function('window', 'document', 'location', `return (${fn.toString()})();`)(window, document, { origin, hostname }),
    url: () => origin,
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('openTab', 'closeTab', 'snapshot', 'console', 'sleep', 'pwd', 'fetch', 'annotatedScreenshot', 'fs', 'path', 'Buffer', script)(
    async (url: string) => { events.push({ name: 'open', value: url }); return pg; },
    async (page: unknown) => { expect(page).toBe(pg); events.push({ name: 'close' }); },
    async (_page: unknown, value: unknown) => { events.push({ name: 'snapshot', value }); return { tree: '[ref=e12] Save', diff: 'Saved' }; },
    { log: (...args: unknown[]) => output.push(args.map(String).join(' ')) },
    async (value: number) => events.push({ name: 'sleep', value }),
    '/owned-session',
    async (url: string, value: unknown) => { events.push({ name: 'fetch', value: { url, ...value as object } }); return { status: 200, text: async () => options.response ?? 'body' }; },
    async () => ({ base64Image: Buffer.from('image').toString('base64') }),
    { writeFile: async (file: string, bytes: Buffer) => events.push({ name: 'writeFile', value: { file, bytes: bytes.toString() } }) },
    path.posix, Buffer,
  );
  expect(events[0].name).toBe('open');
  expect(events.at(-1)?.name).toBe('close');
  expect(output.at(-1)).toBe('GSTACK_STEP_OK');
  return { events, output };
}

describe('compact QA browser recipes retain native operations', () => {
  test('bounded exploration rechecks the clock around checkpoints without replacing probe evidence', () => {
    for (const skillName of ['qa', 'qa-only', 'review', 'ship']) {
      const loop = generateQAExploratory({ ...ctx, skillName });
      const n = qaProbeNames(loop);
      for (const contract of [
        `bun ${n.guard} start ${n.deadline} SECONDS [EARLIER_UTC]`,
        'Set SECONDS to the shorter mode/caller limit',
        `${n.guard} enforces the deadline`,
        'QA_DEADLINE receipts are not observations',
        'Report refusals as not-run',
        `\`bun ${n.guard} run ${n.deadline} -- COMMAND ARGS\``,
        'announce finite command timeouts',
      ]) expect(loop).toContain(contract);
      expect(loop).toMatch(new RegExp(`never reset ${n.deadline}\\W+bypass ${n.guard}`, 'i'));
      for (const field of ['observationCommand', 'observed', 'hypothesis', 'nextCommand']) expect(loop).toContain(`${field}:`);
      expectMentions(loop, [['no', 'functional', 'regression']], 'loop');
      if (skillName !== 'qa-only') expect(loop).toContain('Explicit plan checks and revalidation remain required beyond this smoke budget');
    }
  });

  test('one shared loop owns the preserved phases, checkpoints and time limits', () => {
    const prose = method.replace(/\s+/g, ' ');
    for (const contract of [
      'shared exploratory loop owns execution order, not these technique phases',
      'checkpoint rule covers every probe after the baseline, including orientation, links, exact replay and additional evidence',
      'Never batch across checkpoints',
      'Time caps include checkpoints and evidence',
      'stop probing and report unfinished coverage, never skip checkpoints',
      'For /qa and /qa-only, choose Full, Quick or Regression',
      "/review and /ship keep their caller's smoke and plan bounds",
      'Resolve conflicting depth flags by asking before probes',
      'Diff-aware selects scope, not another pass',
      'After selecting and isolating a browser surface',
      'Visit every reachable page (5-15 minutes)', '3 minutes: homepage + top 5 navigation targets',
      "skip detailed issues/checklist, never the shared loop's gates",
    ]) expect(prose).toContain(contract);
    const titles = ['Initialize', 'Authenticate (if needed)', 'Orient', 'Explore', 'Document', 'Wrap Up'];
    const phases = titles.map((title, index) => {
      const heading = `### Phase ${index + 1}: ${title}`;
      expect(method).toContain(heading);
      const start = method.indexOf(heading);
      const next = index < 5 ? method.indexOf(`### Phase ${index + 2}:`) : method.indexOf('## Health Score Rubric');
      expect(next).toBeGreaterThan(start);
      return method.slice(start, next).replace(/\s+/g, ' ');
    });
    expect(phases[0]).toContain("Reuse the caller's BROWSER SETUP");
    expect(phases[0]).toContain('owned artifact paths');
    expectMentions(phases[0], [['only', 'authority', 'complete']], 'phases[0]');
    expectMentions(phases[2], [['before', 'successful', 'challenges']], 'phases[2]');
    expectMentions(phases[2], [['not', 'result/state', 'successful']], 'phases[2]');
    expect(phases[4]).toContain("shared loop's exact-replay rule");
    expectMentions(phases[4], [['before', 'confirmation', 'incomplete']], 'phases[4]');
    expect(phases[4]).toContain('evidence or minimization unfinished');
    expectMentions(phases[5], [['without', 'retained', 'evidence']], 'phases[5]');
    expect(phases[5]).toContain("caller's artifact/mixed-report rules");
    for (const skillName of ['qa', 'qa-only']) {
      const loop = generateQAExploratory({ ...ctx, skillName }).replace(/\s+/g, ' ');
      for (const contract of [
        'Each probe is one native command/interaction', 'demonstrate success: output AND durable effects',
        '**Publish before probing.** Create',
        'Wait for successful checkpoint publication before dispatch',
        'Never backfill or overwrite notes',
        'Replay the exact failing command/request from the same initial fixture state',
        'then minimize via those gates',
        'Another input or a regression test is not that replay',
      ]) expect(loop).toContain(contract);
    }
  });

  test('consolidated QA rules survive at their authoritative execution steps', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, '../qa/SKILL.md.tmpl'), 'utf8');
    const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end)).replace(/\s+/g, ' ');
    const setup = section('## Setup', '## Phases 1-6:');
    expect(setup).toContain('git status --porcelain');
    expect(setup).toContain('If dirty, **STOP** and use AskUserQuestion');
    for (const choice of ['Commit all current changes with a descriptive message', 'Stash changes, run QA, then pop the stash', 'Abort for manual cleanup']) expect(setup).toContain(choice);
    expectMentions(setup, [['only', 'continuing', 'execute']], 'setup');
    expectMentions(section('### 8d.', '### 8e.'), [['never', 'regression', 'unrelated']], 'section(### 8d., ### 8e.)');
    const classification = section('### 8e.', '### 8e.5.');
    for (const rule of ['passed 8c', 'native regression when available', 'disclose missing test coverage', "undo only this run's repair", 'revert its commit if already committed', 'retain the valid regression/evidence', '"deferred"', 'Never discard user changes']) expect(classification).toContain(rule);
    const regulation = section('### 8f.', '## Phase 9:');
    for (const rule of [/every 5 fixes/i, /after any revert/i, /STOP immediately/i, /ask whether to continue/i, /Hard cap: 50 fixes/]) expect(regulation).toMatch(rule);
    for (const signal of [/STOP immediately/i, /revert/i, /unrelated/i]) expect(regulation).toMatch(signal);
    expectMentions(source, [['stop', 'doubt']], 'source');
    const rules = source.slice(source.indexOf('## Additional Rules'));
    for (const rule of ['Outside an explicitly approved browser bootstrap', 'Only create tests through authorized codification in Phase 8a.5', 'Never modify CI configuration or weaken existing tests', 'use new native test files']) expect(rules).toContain(rule);
    const loop = generateQAExploratory(ctx).replace(/\s+/g, ' ');
    for (const rule of ['unit for logic', 'integration for state/requests', 'E2E only if smaller tests miss the journey', 'not automatically both', 'Mock only unrelated services', 'Phase 8 regression gates before verified repair', 'Never freeze buggy output, weaken tests or delete valid red tests']) expect(loop).toContain(rule);
    expectMentions(section('### 8a.5.', '### 8b.'), [['not', 'detected', 'command']], 'section(### 8a.5., ### 8b.)');
    expectMentions(section('### 8e.5.', '### 8f.'), [['does not', 'records', 'results']], 'section(### 8e.5., ### 8f.)');
  });

  test('browser repair verification points at the actual read/flow recipe', () => {
    const verify = fs.readFileSync(path.resolve(import.meta.dir, '../qa/sections/browser-verify.md.tmpl'), 'utf8');
    expectTokens(verify, ['`flow = true`'], 'verify');
    for (const contract of ['original reproduction', '`flow = false`', 'Keep the error hook',
      '`GSTACK_STEP_OK` check', 'fresh screenshot names', 'add a suffix if it exists',
      'Read the copied screenshot', 'Functional repairs never load this section']) expect(verify).toContain(contract);
    expect(verify).not.toContain('const HOOK =');
    expect(verify).not.toContain('Phase 5 Drive-a-flow');
    const orient = method.slice(method.indexOf('### Phase 3: Orient'), method.indexOf('### Phase 4: Explore'));
    expect(orient).toContain('const flow = false;');
    expect(orient).toContain('if (flow)');
    expect(orient).toContain('"DIFF_START"');
    expect(orient).toContain('"CONSOLE_ERRORS="');
  });

  test('browser selection, evidence, consent and report contracts remain explicit', () => {
    for (const contract of [
      'selected browser surfaces', 'Map diffs with source', 'discovery stays black-box',
      '### Diff-aware (automatic when on a feature branch with no URL)', '### Full', '### Quick', '### Regression',
      'BROWSER SETUP', 'NEEDS_ASIDE', 'ASIDE_NOT_RUNNING', '/setup-browser-cookies', '$B handoff', '$B resume',
      'Never handle credentials', 'EVERY screenshot', 'then Read it', 'Never delete reports/screenshots',
      'Confirm each issue by retrying once', 'severity counts', 'page/screenshot counts', 'YYYY-MM-DD',
      'baseline.json', 'healthScore', 'categoryScores', 'BROWSER SETUP safety/sentinel rules',
      'one AskUserQuestion listing non-LOCAL mutations per run, BEFORE acting',
      'Never refuse to use the browser for a selected browser surface',
    ]) expect(method).toContain(contract);
  });

  for (const flow of [false, true]) {
    test(flow ? 'interactive before/action/after evidence' : 'page orientation and load-time error capture', async () => {
      const { events, output } = await runRecipe('const flow = false', { flow });
      const names = events.map(event => event.name);
      expect(names.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(names.indexOf('goto'));
      const screenshots = events.filter(event => event.name === 'screenshot').map(event => event.value);
      expect(screenshots).toEqual(flow ? [
        { path: 'issue-001-step-1.jpg', type: 'jpeg', quality: 60, fullPage: false },
        { path: 'issue-001-result.jpg', type: 'jpeg', quality: 60 },
      ] : [{ path: 'initial.jpg', type: 'jpeg', quality: 60, fullPage: true }]);
      expect(output).toContain('CONSOLE_ERRORS=["load failure","uncaught: uncaught failure","unhandledrejection: promise failure"]');
      expect(output).toContain('ASIDE_DIR=/owned-session');
      expect(output).toContain('Page text');
      expect(names.filter(name => name === 'click')).toHaveLength(flow ? 1 : 0);
      if (flow) {
        expect(names.indexOf('screenshot')).toBeLessThan(names.indexOf('click'));
        expect(names.indexOf('click')).toBeLessThan(names.lastIndexOf('screenshot'));
        expect(output).toContain('DIFF_START');
        expect(output).toContain('Saved');
        expect(output).toContain('DIFF_END');
      }
    });
  }

  for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'app.localhost', 'app.test', 'example.com', 'app.local']) {
    test(`link checks preserve local-only requests and dangerous-path exclusions (${hostname})`, async () => {
      const { events, output } = await runRecipe('const links =', { hostname });
      const requests = events.filter(event => event.name === 'fetch');
      const local = hostname !== 'example.com' && hostname !== 'app.local';
      expect(requests).toEqual(local ? [{ name: 'fetch', value: { url: `http://${hostname}:3000/ok`, method: 'HEAD' } }] : []);
      expect(output).toContain(`LINK ${local ? '200' : '?'} http://${hostname}:3000/ok`);
    });
  }

  test('responsive capture restores viewport', async () => {
    const { events, output } = await runRecipe('Emulation.setDeviceMetricsOverride');
    expect(events).toContainEqual({ name: 'Emulation.setDeviceMetricsOverride', value: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true } });
    expect(events).toContainEqual({ name: 'Emulation.clearDeviceMetricsOverride', value: {} });
    expect(output).toContain('ASIDE_DIR=/owned-session');
  });

  test('annotated evidence is written inside the Aside session', async () => {
    const { events, output } = await runRecipe('annotatedScreenshot(pg)');
    expect(events).toContainEqual({ name: 'writeFile', value: { file: '/owned-session/issue-002.png', bytes: 'image' } });
    expect(output).toContain('ASIDE_DIR=/owned-session');
  });

  test('session API requests retain status and bounded body evidence', async () => {
    const { events, output } = await runRecipe('API_STATUS=', { response: 'x'.repeat(6000) });
    expect(events).toContainEqual({ name: 'fetch', value: { url: '<base-url>/api/...', method: 'GET' } });
    expect(output).toContain('API_STATUS=200');
    expect(output).toContain('API_BODY_START');
    expect(output).toContain('x'.repeat(4000));
    expect(output).toContain('API_BODY_END');
  });
});
