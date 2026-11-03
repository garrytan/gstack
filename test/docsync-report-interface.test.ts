import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CALLBACK_TEST_MS, callbackBudgetMs } from './helpers/docsync-fault-callbacks';

test('actual registered documentation callbacks stage the generated report contract and consume their builders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-report-interface-'));
  const root = path.resolve(import.meta.dir, '..');
  try {
    const script = path.join(dir, 'capture.test.ts');
    fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(root)};
const fixtureModule = path.join(root, 'test/helpers/docsync-fixture.ts');
const observerModule = path.join(root, 'test/helpers/docsync-observer.ts');
const fixtures = { ...await import(fixtureModule) };
const observers = { ...await import(observerModule) };
const callbacks = new Map();
const stopped = new Error('stopped before model launch');
let fixture, launched = 0;
mock.module(fixtureModule, () => ({ ...fixtures,
  fixtureDocs(scenario) { fixture = fixtures.fixtureDocs(scenario); return fixture; },
  preserveDocsEvidence() {},
}));
mock.module(observerModule, () => ({ ...observers,
  docsSessionOptions(input) {
    const options = observers.docsSessionOptions(input);
    return { ...options, prompt: options.prompt + '\\nOPTIONS_BUILDER_USED' };
  },
  docsShipPhase(...args) { return observers.docsShipPhase(...args) + '\\nPHASE_BUILDER_USED'; },
  docsBoundedStageInterface(...args) { return observers.docsBoundedStageInterface(...args) + '\\nBOUNDED_BUILDER_USED'; },
}));
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({
  describeE2ETier: () => (_name, body) => body(),
}));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  runId: 'free-docsync-interface',
  describeIfSelected: (_name, _names, body) => body(),
  testConcurrentIfSelected: (name, body) => callbacks.set(name, body),
  createEvalCollector: () => ({}),
  finalizeEvalCollector() {},
  recordE2E() { throw new Error('no model result may be recorded'); },
  logCost() { throw new Error('no model result may be graded'); },
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  async runSkillTest(options) {
    launched++;
    if (options.testName === 'ship-docsync-failure') {
      expect(options.prompt).toContain('BOUNDED_BUILDER_USED');
      expect(options.prompt).toContain('Execute the actual next phase from ' + path.join(fixture.home, 'phase.md'));
      expect(options.prompt).toContain('deterministic child transport instead of Agent/Task');
      expect(options.prompt).toContain('no user risk exception or risky edit is approved');
      expect(options.allowedTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
    } else {
      expect(options.prompt).toContain('OPTIONS_BUILDER_USED');
      expect(options.prompt).toContain('Execute the next phase from ' + path.join(fixture.home, 'phase.md'));
      expect(options.prompt).toContain('No real PR, push, store action or later ship phase is authorized.');
      expect(options.prompt).toContain('no risk exception is granted');
      expect(options.allowedTools).toEqual(['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Task']);
    }
    expect(options.workingDirectory).toBe(fixture.repo);
    expect(options.maxTurns).toBe(30);
    expect(options.timeout).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(fixture.skills, 'document-release/SKILL.md'), 'utf8')).not.toContain('This fixture child returns a deliberately obsolete completion');
    const phase = fs.readFileSync(path.join(fixture.home, 'phase.md'), 'utf8');
    expect(phase).toContain('PHASE_BUILDER_USED');
    if (options.testName === 'ship-docsync-store') {
      expect(phase).toContain('**Documentation preflight:**');
      expect(phase).not.toContain('## Documentation');
    } else {
      const prBody = fs.readFileSync(path.join(fixture.skills, 'ship/sections/pr-body.md'), 'utf8');
      const start = prBody.indexOf('## Documentation');
      const end = prBody.indexOf('## Test plan', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      expect(phase).toContain(prBody.slice(start, end));
      expect(phase).toContain('documentation_section');
      expect(phase).not.toContain('## Step 15: Commit');
      expect(phase).not.toContain('#### Redaction scan');
    }
    throw stopped;
  },
}));
await import(path.join(root, 'test/skill-e2e-ship-docsync.test.ts'));
expect(callbacks.size).toBe(12);
for (const name of ['ship-docsync-completion', 'ship-docsync-current', 'ship-docsync-failure', 'ship-docsync-store']) {
  test(name + ' constructs its real native request without launching it', async () => {
    const before = launched;
    await expect(callbacks.get(name)()).rejects.toBe(stopped);
    expect(launched).toBe(before + 1);
    expect(fs.existsSync(fixture.home)).toBe(false);
  }, ${CALLBACK_TEST_MS});
}
`);
    const result = Bun.spawnSync([process.execPath, 'test', script], {
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '', EVALS_RUN_ID: 'free-docsync-interface',
        GSTACK_EVAL_DIR: path.join(dir, 'evidence'), GSTACK_HOME: path.join(dir, 'state') },
      stdout: 'pipe', stderr: 'pipe', timeout: callbackBudgetMs(4),
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('4 pass');
    expect(output).toContain('0 fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, callbackBudgetMs(4) + 10_000);
