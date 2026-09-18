import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedEngFindingProject } from './helpers/eng-finding-fixture';
import { legacyAuthFlow, POLICIES, AuthFailure, type Platform, type Policy } from './fixtures/eng-existing-auth/legacy-auth';

const identity = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-a' });
const session = { id: 'opaque-session', expiresAt: 3_600_000 };

function suppliedCountPlan() {
  // Execute only the actual pure prompt builder, never import its paid test.
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-eng-finding-count.test.ts'), 'utf8');
  const start = source.indexOf('const planEng5Findings = ');
  const end = source.indexOf("].join('\\n');", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const builder = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + "].join('\\n');".length)) + '\nreturn planEng5Findings;')();
  return builder('/fixture-only/reviewed-plan.md') as string;
}

test('count fixture supplies the author-owned RequestPolicy contract before review', () => {
  const plan = suppliedCountPlan();
  const context = plan.split('## Context supplied by the plan author\n')[1]?.split('\n## ')[0];
  expect(context).toBeDefined();
  expect(context).toContain('without changing\nits product behavior');
  expect(context).toContain('given already-fetched claims and tenant/request context');
  expect(context).toContain('returns\nallow or deny under the existing access policy');
  expect(context).toContain('AuthBroker.validateAndDispatch()\ncalls it after validation and before dispatch');
  expect(context).toContain('adds no policy, network call,\ncache mutation or state');
  expect(context).toContain('class boundary remains a proposal to review');
  expect(plan).toContain('to /fixture-only/reviewed-plan.md (use Edit/Write to that exact path)');
});

test('count fixture retains all five seeded defects and a coherent class inventory', () => {
  const plan = suppliedCountPlan();
  for (const defect of [
    'Two new services (`AuthBroker` and `SessionMint`) share a global mutable\n`AuthCache` instance via module-level export. Both services mutate it.',
    'The `validateAndDispatch()` function is 60 lines with three nested\ntry/catch blocks; each catch swallows a different error class.',
    'The existing `legacyAuthFlow()` will get rewritten as part of this work;\nno regression test for the prior behavior is planned.',
    'Token validation issues 5 sequential API calls to the IDP; they could be\nparallelized via Promise.all trivially (calls are independent).',
    'This touches 12 files and introduces 5 new classes',
  ]) expect(plan).toContain(defect);
  expect(plan).toContain('unchanged validity and tenant-key rules; they do not serialize mutations');
  expect(plan).toContain('That coverage does not exercise legacyAuthFlow() or\nassert compatibility with its prior behavior');
  const inventory = /introduces (\d+) new classes \(([^)]+)\)/.exec(plan);
  expect(inventory).not.toBeNull();
  const names = inventory![2]!.split(/,\s*/);
  expect(names).toEqual(['AuthBroker', 'TokenStore', 'SessionMint', 'AuthCache', 'RequestPolicy']);
  expect(new Set(names).size).toBe(Number(inventory![1]));
});

test('Eng fixture commits a real legacy flow alongside the unchanged supplied defects', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-finding-fixture-'));
  try {
    const defects = '# Proposed refactor\nBoth services mutate a global cache.\nNo regression test is planned.\n';
    const input = seedEngFindingProject(cwd, defects);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    expect(input.startsWith(defects)).toBe(true);
    expect(git('show', 'HEAD:review-input.md')).toBe(input);
    expect(git('show', 'HEAD:src/legacy-auth.ts')).toBe(fs.readFileSync(path.resolve(import.meta.dir, 'fixtures/eng-existing-auth/legacy-auth.ts'), 'utf8'));
    const pkg = git('show', 'HEAD:package.json');
    expect(pkg).toBe(fs.readFileSync(path.resolve(import.meta.dir, 'fixtures/eng-existing-auth/package.json'), 'utf8'));
    expect(JSON.parse(pkg).scripts.test).toBe('bun test');
    expect(input).toContain('POLICIES order, not response-arrival order');
    expect(input).toContain('prior build artifact for rollback');
    expect(input).toContain('reserve concurrency and rate capacity for five policy calls');
    expect(input).not.toContain('reverting that\nflag restores');
    expect(git('diff', 'origin/main...HEAD')).toBe('');
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.readdirSync(path.join(cwd, 'src'))).toEqual(['legacy-auth.ts']);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('legacy flow has five sequential independent calls and issues a session only after all allow', async () => {
  const called: Policy[] = [];
  const pending: Array<(allow: boolean) => void> = [];
  let minted = 0;
  const result = legacyAuthFlow(identity, {
    checkPolicy: (actual, policy) => {
      expect(actual).toBe(identity);
      called.push(policy);
      return new Promise(resolve => pending.push(resolve));
    },
    issueSession: async actual => { expect(actual).toBe(identity); minted++; return session; },
  });
  for (let i = 0; i < POLICIES.length; i++) {
    expect(called).toEqual(POLICIES.slice(0, i + 1));
    expect(minted).toBe(0);
    pending[i]!(true);
    await Promise.resolve();
  }
  expect(await result).toBe(session);
  expect(minted).toBe(1);
});

test.each(['denied', 'provider_unavailable', 'session_unavailable'] as const)('legacy %s remains an explicit failure', async code => {
  const cause = new Error('dependency failure');
  let minted = 0;
  const platform: Platform = {
    checkPolicy: async () => { if (code === 'provider_unavailable') throw cause; return code !== 'denied'; },
    issueSession: async () => { minted++; throw cause; },
  };
  const failure = await legacyAuthFlow(identity, platform).catch(error => error);
  expect(failure).toBeInstanceOf(AuthFailure);
  expect(failure.code).toBe(code);
  expect(failure.cause).toBe(code === 'denied' ? undefined : cause);
  expect(minted).toBe(code === 'session_unavailable' ? 1 : 0);
});


test('existing policy-order failure and short-circuit behavior stay unchanged', async () => {
  const called: Policy[] = [];
  let minted = false;
  const result = await legacyAuthFlow(identity, {
    checkPolicy: async (_identity, policy) => {
      called.push(policy);
      if (policy === 'tenant') return false;
      if (policy === 'device') throw new Error('later unavailable policy');
      return true;
    },
    issueSession: async () => { minted = true; return session; },
  }).catch(error => error);
  expect(result).toBeInstanceOf(AuthFailure);
  expect(result.code).toBe('denied');
  expect(called).toEqual(['account', 'tenant']);
  expect(minted).toBe(false);
});


test.each(['synchronous throw', 'promise rejection'] as const)('legacy preserves the same provider failure contract for %s', async mode => {
  const cause = new Error('policy client failure');
  const called: Policy[] = [];
  let minted = false;
  const platform: Platform = {
    checkPolicy: (_identity, policy) => {
      called.push(policy);
      if (mode === 'synchronous throw') throw cause;
      return Promise.reject(cause);
    },
    issueSession: async () => { minted = true; return session; },
  };
  const failure = await legacyAuthFlow(identity, platform).catch(error => error);
  expect(failure).toBeInstanceOf(AuthFailure);
  expect(failure.code).toBe('provider_unavailable');
  expect(failure.cause).toBe(cause);
  expect(called).toEqual(['account']);
  expect(minted).toBe(false);
});
