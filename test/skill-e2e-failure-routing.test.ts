/**
 * Router failure routing (#3157, #3158). The gstack router checks a reported
 * failure's cause before it routes: a user-supplied cause that one read-only
 * check confirms is fixed directly; an unknown cause gets one bounded triage
 * pass; anything still unverified goes to /investigate before any edit.
 *
 * Four fixtures, two per issue. The direct cases (verified cause, triage that
 * resolves it) must fix the bug without /investigate and leave the suite
 * green. The fallback cases (contradicted cause, unclear intermittent failure)
 * are the negative controls: an edit before /investigate is a contract
 * violation. Every case needs one to four read-only calls before it routes. The agent sees the rendered router section, sliced from
 * SKILL.md; GSTACK_ROUTER_ARM=before slices the base branch's router instead.
 */
import { afterAll, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import { expectContract } from './helpers/eval-store';
import {
  ROOT, runId, describeIfSelected, testConcurrentIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { extractSkillHead, sliceBetween } from './helpers/skill-fixture';
import { bunIsolationArgs } from '../lib/bun-isolation';

const collector = createEvalCollector('e2e-failure-routing');
const ARM = process.env.GSTACK_ROUTER_ARM === 'before' ? 'before' : 'current';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
const SHELL_WRITE = /\b(?:sed|perl)\b[^|;&]*\s-[a-z]*i|(?<![=0-9&>])>>?\s*(?!&|\/dev\/null)\S|\btee\b|\b(?:mv|cp|rm)\s|\bgit\s+(?:apply|checkout|restore)\b/;

function isEdit(call: { tool: string; input: any }): boolean {
  return EDIT_TOOLS.has(call.tool) || (call.tool === 'Bash' && SHELL_WRITE.test(String(call.input?.command ?? '')));
}

interface Fixture {
  name: string;
  route: 'direct' | 'investigate';
  files: Record<string, string>;
  request: string;
}

const FIXTURES: Fixture[] = [
  {
    name: 'router-failure-verified-cause',
    route: 'direct',
    files: {
      'src/slug.js': "export function slugify(title) {\n  return title.trim().toLowerCase().replace(/ /, '-');\n}\n",
      'test/slug.test.js': "import { expect, test } from 'bun:test';\nimport { slugify } from '../src/slug.js';\n\ntest('slugify joins every word with a hyphen', () => {\n  expect(slugify('Hello Big World')).toBe('hello-big-world');\n});\n",
    },
    request: "test/slug.test.js fails: slugify('Hello Big World') returns 'hello-big world'. The cause is the regex in src/slug.js: / / has no g flag, so only the first space is replaced. Fix it by making it / /g.",
  },
  {
    name: 'router-failure-contradicted-cause',
    route: 'investigate',
    files: {
      'src/price.js': "import { discountRate } from './rates.js';\n\nexport function applyDiscount(price, code) {\n  return Math.round(price * (1 - discountRate(code)));\n}\n",
      'src/rates.js': "import rates from '../config/rates.json' with { type: 'json' };\n\nexport function discountRate(code) {\n  return rates[code] ?? 0;\n}\n",
      'config/rates.json': '{\n  "SAVE10": 10,\n  "SAVE25": 0.25\n}\n',
      'test/price.test.js': "import { expect, test } from 'bun:test';\nimport { applyDiscount } from '../src/price.js';\n\ntest('SAVE10 takes ten percent off', () => {\n  expect(applyDiscount(200, 'SAVE10')).toBe(180);\n});\n",
    },
    request: "test/price.test.js fails: applyDiscount(200, 'SAVE10') returns -1800 instead of 180. It's a floating-point rounding problem in src/price.js; wrap the result in Math.round() and it will pass.",
  },
  {
    name: 'router-failure-triage-resolves',
    route: 'direct',
    files: {
      'src/initials.js': "export function initials(fullName) {\n  const [first, last] = fullName.split(',');\n  return (first[0] + last[0]).toUpperCase();\n}\n",
      'test/initials.test.js': "import { expect, test } from 'bun:test';\nimport { initials } from '../src/initials.js';\n\ntest('initials of a first and last name', () => {\n  expect(initials('Ada Lovelace')).toBe('AL');\n});\n",
    },
    request: "bun test fails on test/initials.test.js with: TypeError: undefined is not an object (evaluating 'last[0]') at initials (src/initials.js:3). Can you fix it?",
  },
  {
    name: 'router-failure-competing-causes',
    route: 'investigate',
    files: {
      'src/dispatch.js': "import { accepts } from './filter.js';\nimport { deliver } from './transport.js';\n\nexport function dispatch(event, sink) {\n  if (accepts(event)) deliver(event, sink);\n}\n",
      'src/filter.js': "export function accepts(event) {\n  return event.priority === 'high';\n}\n",
      'src/transport.js': "export function deliver(event, sink) {\n  if (event.channel === 'alerts') sink.push(event);\n}\n",
      'test/dispatch.test.js': "import { expect, test } from 'bun:test';\nimport { dispatch } from '../src/dispatch.js';\n\ntest('scheduled event reaches the sink', () => {\n  const sink = [];\n  dispatch({ type: 'scheduled', priority: 'normal', channel: 'updates' }, sink);\n  expect(sink).toHaveLength(1);\n});\n",
    },
    request: "test/dispatch.test.js fails: a scheduled event never reaches the sink. Can you fix it?",
  },
  {
    name: 'router-failure-triage-unclear',
    route: 'investigate',
    files: {
      'src/queue.js': "const pending = [];\nlet timer = null;\n\nexport function enqueue(job, sink) {\n  pending.push(job);\n  if (!timer) timer = setTimeout(() => flush(sink), Number(process.env.FLUSH_MS ?? 5));\n}\n\nexport function flush(sink) {\n  timer = null;\n  sink.push(...pending.splice(0));\n}\n",
      'src/metrics.js': "import { enqueue } from './queue.js';\n\nexport function track(event, sink) {\n  if (event.sampled !== false) enqueue({ type: 'metric', event }, sink);\n}\n",
      'test/queue.test.js': "import { expect, test } from 'bun:test';\nimport { enqueue } from '../src/queue.js';\n\ntest('three jobs reach the sink', async () => {\n  const sink = [];\n  enqueue(1, sink); enqueue(2, sink); enqueue(3, sink);\n  await new Promise(r => setTimeout(r, 10));\n  expect(sink.length).toBe(3);\n});\n",
      'test/metrics.test.js': "import { expect, test } from 'bun:test';\nimport { track } from '../src/metrics.js';\n\ntest('sampled events are tracked', async () => {\n  const sink = [];\n  track({ name: 'signup' }, sink);\n  await new Promise(r => setTimeout(r, 10));\n  expect(sink.length).toBe(1);\n});\n",
    },
    request: "test/queue.test.js fails about one CI run in five with 'expected 3, received 2'. It has never failed on my machine. Can you fix it?",
  },
];

function routerSection(): string {
  const skill = ARM === 'before'
    ? spawnSync('git', ['show', `${process.env.EVALS_BASE || 'origin/main'}:SKILL.md`], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).stdout
    : fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  return sliceBetween(skill, '## Route first', 'Best-effort, record') + sliceBetween(skill, '**Routing rules', 'If the user opts out');
}

function makeRepo(fixture: Fixture): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-routing-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'bun test' } }, null, 2));
  for (const [file, body] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  for (const skill of ['investigate', 'qa', 'review', 'ship']) {
    fs.mkdirSync(path.join(repo, '.claude', 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', skill, 'SKILL.md'), extractSkillHead(path.join(ROOT, skill, 'SKILL.md')));
  }
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { cwd: repo, timeout: 10_000 });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repo;
}

function sourceSnapshot(repo: string, fixture: Fixture): string {
  return Object.keys(fixture.files).filter(f => !f.startsWith('test/')).map(f => fs.readFileSync(path.join(repo, f), 'utf8')).join('\0');
}

function routing(result: SkillTestResult) {
  const calls = result.toolCalls;
  const investigateAt = calls.findIndex(c => c.tool === 'Skill' && String(c.input?.skill ?? '').includes('investigate'));
  const firstEditAt = calls.findIndex(isEdit);
  const before = investigateAt >= 0 ? calls.slice(0, investigateAt) : firstEditAt >= 0 ? calls.slice(0, firstEditAt) : calls;
  return {
    investigated: investigateAt >= 0,
    editedFirst: firstEditAt >= 0 && (investigateAt < 0 || firstEditAt < investigateAt),
    readsBeforeRoute: before.filter(c => READ_TOOLS.has(c.tool) && !isEdit(c)).length,
    sequence: calls.map(c => c.tool === 'Skill' ? `Skill(${c.input?.skill})` : c.tool).join(' → '),
  };
}

describeIfSelected('Router failure routing (#3157, #3158)', FIXTURES.map(f => f.name), () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    finalizeEvalCollector(collector);
  });

  for (const fixture of FIXTURES) {
    testConcurrentIfSelected(fixture.name, async () => {
      const repo = makeRepo(fixture);
      dirs.push(repo);
      const sourceBefore = sourceSnapshot(repo, fixture);
      const result = await runSkillTest({
        prompt: `The user invoked the gstack router skill (/gstack) in this repository. The router's instructions:\n\n${routerSection()}\n\nThe user's request: "${fixture.request}"`,
        workingDirectory: repo,
        maxTurns: 6,
        tools: ['Skill', 'Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        allowedTools: ['Skill', 'Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        timeout: CAPTURE_MS,
        testName: fixture.name,
        runId,
      });
      logCost(`router ${fixture.name} (${ARM})`, result);
      const r = routing(result);
      const suite = spawnSync(process.execPath, [...bunIsolationArgs(), 'test'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
      const green = suite.status === 0;
      const sourceChanged = sourceSnapshot(repo, fixture) !== sourceBefore;
      const summary = `arm=${ARM} route=${r.investigated ? 'investigate' : 'direct'} reads=${r.readsBeforeRoute} green=${green} tools: ${r.sequence}`;
      const bounded = r.readsBeforeRoute >= 1 && r.readsBeforeRoute <= 4;
      const passed = bounded && (fixture.route === 'direct' ? !r.investigated && green : r.investigated && !r.editedFirst);
      recordE2E(collector, fixture.name, 'Router failure routing', result, { passed, output: summary });

      if (fixture.route === 'investigate') {
        expectContract(!r.editedFirst && (r.investigated || !sourceChanged), `edited before /investigate on an unverified cause: ${summary}`, { collector, name: fixture.name });
        expect(r.investigated, summary).toBe(true);
      } else {
        expect(r.investigated, summary).toBe(false);
        expect(green, `suite still red after the direct fix: ${summary}\n${suite.stdout}${suite.stderr}`).toBe(true);
      }
      expect(r.readsBeforeRoute, `no read-only check before routing: ${summary}`).toBeGreaterThanOrEqual(1);
      expect(r.readsBeforeRoute, `triage was not bounded: ${summary}`).toBeLessThanOrEqual(4);
    }, CAPTURE_MS);
  }
});
