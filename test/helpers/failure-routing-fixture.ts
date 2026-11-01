/**
 * Router failure-routing fixtures and scoring (#3157, #3158), shared by
 * test/skill-e2e-failure-routing.test.ts and its free arm test (GST-470).
 * GSTACK_ROUTER_ARM picks what the candidate sees: `current` (the default) the
 * rendered router section of SKILL.md, `before` the base branch's router, and
 * `none` the user's request alone in a repository with no installed skills.
 * Any other value throws, so a typo cannot run one arm under another's label.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SkillTestResult } from './session-runner';
import { extractSkillHead, sliceBetween } from './skill-fixture';

const ROOT = path.resolve(import.meta.dir, '..', '..');

export type RouterArm = 'before' | 'current' | 'none';

export function routerArm(env: NodeJS.ProcessEnv = process.env): RouterArm {
  const arm = env.GSTACK_ROUTER_ARM ?? 'current';
  if (arm !== 'before' && arm !== 'current' && arm !== 'none') throw new Error(`GSTACK_ROUTER_ARM must be before, current or none, got ${arm}`);
  return arm;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
const SHELL_WRITE = /\b(?:sed|perl)\b[^|;&]*\s-[a-z]*i|(?<![=0-9&>])>>?\s*(?!&|\/dev\/null)\S|\btee\b|\b(?:mv|cp|rm)\s|\bgit\s+(?:apply|checkout|restore)\b/;

export function isEdit(call: { tool: string; input: any }): boolean {
  return EDIT_TOOLS.has(call.tool) || (call.tool === 'Bash' && SHELL_WRITE.test(String(call.input?.command ?? '')));
}

export interface Fixture {
  name: string;
  route: 'direct' | 'investigate';
  files: Record<string, string>;
  request: string;
}

export const FIXTURES: Fixture[] = [
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

export function routerSection(arm: Exclude<RouterArm, 'none'>, base = process.env.EVALS_BASE || 'origin/main'): string {
  const skill = arm === 'before'
    ? spawnSync('git', ['show', `${base}:SKILL.md`], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).stdout
    : fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  return sliceBetween(skill, '## Route first', 'Best-effort, record') + sliceBetween(skill, '**Routing rules', 'If the user opts out');
}

/** The candidate's prompt: the router section and the request, or under `none` the request alone. */
export function routerPrompt(fixture: Fixture, arm: RouterArm, base?: string): string {
  if (arm === 'none') return fixture.request;
  return `The user invoked the gstack router skill (/gstack) in this repository. The router's instructions:\n\n${routerSection(arm, base)}\n\nThe user's request: "${fixture.request}"`;
}

/** The fixture repository; under `none` it has no installed skills. */
export function makeRepo(fixture: Fixture, arm: RouterArm): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-routing-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'bun test' } }, null, 2));
  for (const [file, body] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  for (const skill of arm === 'none' ? [] : ['investigate', 'qa', 'review', 'ship']) {
    fs.mkdirSync(path.join(repo, '.claude', 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', skill, 'SKILL.md'), extractSkillHead(path.join(ROOT, skill, 'SKILL.md')));
  }
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { cwd: repo, timeout: 10_000 });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repo;
}

export function sourceSnapshot(repo: string, fixture: Fixture): string {
  return Object.keys(fixture.files).filter(f => !f.startsWith('test/')).map(f => fs.readFileSync(path.join(repo, f), 'utf8')).join('\0');
}

export function routing(result: SkillTestResult) {
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

/**
 * The no-gstack arm's plain metrics: no skill exists to route to, so they say
 * only whether the agent read before it edited.
 */
export function plainMetrics(calls: SkillTestResult['toolCalls']) {
  const firstEditAt = calls.findIndex(isEdit);
  const firstReadAt = calls.findIndex(c => READ_TOOLS.has(c.tool) && !isEdit(c));
  const before = firstEditAt >= 0 ? calls.slice(0, firstEditAt) : calls;
  return {
    editedBeforeRead: firstEditAt >= 0 && (firstReadAt < 0 || firstEditAt < firstReadAt),
    readsBeforeEdit: before.filter(c => READ_TOOLS.has(c.tool) && !isEdit(c)).length,
    sequence: calls.map(c => c.tool === 'Skill' ? `Skill(${c.input?.skill})` : c.tool).join(' → '),
  };
}
