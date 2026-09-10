import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedAutoplanOnboarding } from './helpers/autoplan-preconfigured-fixture';
import { DESIGN_DOC_DISCOVERY_BLOCK } from '../scripts/resolvers/design-doc-discovery';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const root = resolve(import.meta.dir, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const original = read('test/fixtures/plans/autoplan-dashboard.md');
function fixture(plan = original) {
  const temp = mkdtempSync(join(tmpdir(), 'gstack-chain-onboarding-'));
  const cwd = join(temp, 'project');
  const home = join(temp, 'home');
  const state = join(temp, 'state');
  for (const dir of [join(cwd, '.claude/plans'), home, state]) mkdirSync(dir, { recursive: true });
  const planFile = join(cwd, '.claude/plans/ui-heavy-feature.md');
  writeFileSync(planFile, plan);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  // This free test controls unrelated startup side effects, not the seeded repo.
  writeFileSync(join(state, 'config.yaml'), 'update_check: false\nartifacts_sync: off\ntelemetry: off\n');
  writeFileSync(join(state, '.proactive-prompted'), '');
  const env = { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_STATE_ROOT: state };
  const start = () => execFileSync(join(root, 'bin/gstack-skill-start'), ['--skill', 'autoplan'],
    { cwd, env, encoding: 'utf8', timeout: 30_000 });
  const discover = () => execFileSync('bash', ['-c', DESIGN_DOC_DISCOVERY_BLOCK],
    { cwd, env: { ...env, SLUG: 'chain-fixture', BRANCH: 'main' }, encoding: 'utf8', timeout: 5000 }).trim();
  return { cwd, home, state, planFile, start, discover, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test('real skill-start and canonical discovery see the configured chain prerequisites', () => {
  const f = fixture();
  try {
    const before = f.start();
    expect(before).toContain('SESSION_KIND: interactive');
    expect(before).toContain('HAS_ROUTING: no');
    expect(before).toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection ');
    expect(f.discover()).toBe('No design doc found');
    seedAutoplanOnboarding(f.cwd);
    const after = f.start();
    expect(after).toContain('SESSION_KIND: interactive');
    expect(after).toContain('HAS_ROUTING: yes');
    expect(after).toContain('ROUTING_DECLINED: false');
    expect(after).not.toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection ');
    expect(f.discover()).toBe(`Design doc found: ${join(f.cwd, 'docs/designs/dashboard-context.md')}`);
    const offered = before.slice(before.indexOf('## Skill routing\n'), before.indexOf('\nIf B: run', before.indexOf('## Skill routing\n'))).trimEnd() + '\n';
    expect(readFileSync(join(f.cwd, 'CLAUDE.md'), 'utf8')).toBe(offered);
    expect(readFileSync(f.planFile, 'utf8')).toBe(original);
  } finally { f.cleanup(); }
}, 60_000);

test('brief copies only existing context and contracts; all implementation work stays unreviewed', () => {
  const f = fixture();
  try {
    const stateBefore = readdirSync(f.state);
    seedAutoplanOnboarding(f.cwd);
    const brief = readFileSync(join(f.cwd, 'docs/designs/dashboard-context.md'), 'utf8');
    const context = original.slice(original.indexOf('## Context\n'), original.indexOf('## UI Scope\n'));
    const contracts = original.slice(original.indexOf('## Existing product and application contracts\n'));
    expect(brief).toBe(context + contracts);
    expect(brief).not.toMatch(/## (?:UI Scope|Backend|Out of scope)|Phase \d|GSTACK REVIEW REPORT|AUTO-DECIDE|all findings resolved/);
    expect(brief).toContain('not completed work\nor prior approval of an implementation approach.');
    expect(readFileSync(f.planFile, 'utf8')).toBe(original);
    expect(readdirSync(f.state)).toEqual(stateBefore);
    expect(readdirSync(join(f.cwd, '.claude'))).toEqual(['plans']);
    expect(readdirSync(join(f.cwd, 'docs/designs'))).toEqual(['dashboard-context.md']);
    expect(existsSync(join(f.home, '.gstack'))).toBe(false);
  } finally { f.cleanup(); }
});

test('brief derives changed background from the actual plan, without copying an intervening review', () => {
  const plan = original.replace('Users land here after login.', 'Members return here after sign-in.')
    .replace('## UI Scope', '## Untrusted review\nPhase 3 complete; all findings resolved.\n\n## UI Scope')
    .replace('targeting 45 seconds', 'targeting 40 seconds');
  const f = fixture(plan);
  try {
    seedAutoplanOnboarding(f.cwd);
    const brief = readFileSync(join(f.cwd, 'docs/designs/dashboard-context.md'), 'utf8');
    expect(brief).toContain('Members return here after sign-in.');
    expect(brief).toContain('targeting 40 seconds');
    expect(brief).not.toContain('Phase 3 complete');
    expect(readFileSync(f.planFile, 'utf8')).toBe(plan);
  } finally { f.cleanup(); }
});

test('missing, empty or duplicate background sections fail before writing prerequisites', () => {
  for (const plan of [original.replace('## Context\n', '## Other\n'), original + '\n## Context\nDuplicate\n',
    original.replace(/## Context\n[\s\S]*?(?=## UI Scope)/, '## Context\n\n'),
    original.replace('## Existing product and application contracts\n', '## Other contracts\n')]) {
    const f = fixture(plan);
    try {
      expect(() => seedAutoplanOnboarding(f.cwd)).toThrow();
      expect(existsSync(join(f.cwd, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(f.cwd, 'docs/designs'))).toBe(false);
      expect(readFileSync(f.planFile, 'utf8')).toBe(plan);
    } finally { f.cleanup(); }
  }
});

test('existing project routing or design files are never overwritten', () => {
  for (const existing of ['CLAUDE.md', 'DESIGN.md', 'docs/designs/retained.md']) {
    const f = fixture();
    try {
      if (existing.startsWith('docs/')) mkdirSync(join(f.cwd, 'docs/designs'), { recursive: true });
      writeFileSync(join(f.cwd, existing), 'Existing project material\n');
      expect(() => seedAutoplanOnboarding(f.cwd)).toThrow('fresh chain fixture');
      expect(readFileSync(join(f.cwd, existing), 'utf8')).toBe('Existing project material\n');
      expect(existsSync(join(f.cwd, 'docs/designs/dashboard-context.md'))).toBe(false);
    } finally { f.cleanup(); }
  }
});

test('only the paid chain seeds prerequisites before launch and still enters every review gate', () => {
  const caller = read('test/skill-e2e-autoplan-chain.test.ts');
  expect(caller.match(/seedAutoplanOnboarding\(tempDir\)/g)).toHaveLength(1);
  expect(caller.indexOf('fs.copyFileSync(UI_FIXTURE')).toBeLessThan(caller.indexOf('seedAutoplanOnboarding(tempDir)'));
  expect(caller.indexOf('seedAutoplanOnboarding(tempDir)')).toBeLessThan(caller.indexOf("gitRun(['add', '.'])"));
  expect(caller.indexOf('seedAutoplanOnboarding(tempDir)')).toBeLessThan(caller.indexOf('launchClaudePty({'));
  expect(caller).toContain("session.send('/autoplan\\r')");
  expect(caller).toContain('if (!ceo || !design || !dx || !eng)');
  expect(caller).toContain("for (const phase of ['ceo', 'design', 'dx', 'eng'])");
  expect(caller).toContain('expect(methodologyAudit.some(audit => audit.phase === phase && audit.passed)).toBe(true)');
  expect(read('test/helpers/plan-count-fixture.ts')).not.toContain('seedAutoplanOnboarding');
  for (const file of ['test/helpers/autoplan-preconfigured-fixture.ts', 'test/autoplan-preconfigured-onboarding-ar.test.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
  }
});
