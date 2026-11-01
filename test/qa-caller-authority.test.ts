import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { RESOLVERS } from '../scripts/resolvers';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { applySessionGuards } from '../scripts/resolvers/unattended';
import { qaProbeNames } from './helpers/qa-probe-names';

const root = join(import.meta.dir, '..');
const callers = ['qa', 'qa-only', 'review', 'ship'];

function context(host: string, skillName: string): TemplateContext {
  return { host, skillName, tmplPath: '', paths: HOST_PATHS[host] };
}

function render(file: string, ctx: TemplateContext): string {
  let body = applySessionGuards(readFileSync(join(root, file), 'utf8'), ctx);
  for (let pass = 0; pass < 10; pass++) {
    const next = body.replace(/\{\{([A-Z_]+)(?::([^}]+))?\}\}/g, (_match, name, args) => {
      if (!RESOLVERS[name]) throw new Error(`Unknown resolver ${name}`);
      return RESOLVERS[name](ctx, args?.split(':'));
    });
    if (next === body) return body;
    body = next;
  }
  throw new Error(`Unresolved template ${file}`);
}

function assertProbeLocalBlocker(body: string): void {
  expect(body).toMatch(/QA setup blocker/i);
  expect(body).toMatch(/affected probes as blocked/i);
  expect(body).toMatch(/continue other safe probes/i);
  expect(body).toMatch(/independent functional\/static checks/i);
  expect(body).not.toContain('stop that workflow');
  expect(body).not.toContain('stop all checks');
}

function assertSharedBrowserAuthority(body: string): void {
  const decision = body.slice(body.indexOf('## Browser access decision'), body.indexOf('## BROWSER SETUP'));
  expect(decision).toMatch(/invoking workflow, not this file/i);
  const reportOnly = decision.slice(decision.indexOf('**Report-only'), decision.indexOf('**Standalone /qa'));
  expect(reportOnly).toContain('/qa-only, /review and /ship');
  expect(reportOnly).toMatch(/do not run the fallback's setup\/install or cookie-import workflow/i);
  expect(reportOnly).toMatch(/never bootstrap or invoke another skill/i);
  expect(reportOnly).toMatch(/block only the affected browser probes/i);
  expect(reportOnly).toMatch(/continue independent functional\/static checks/i);
  expect(reportOnly).not.toContain('run `cd');
  const standalone = decision.slice(decision.indexOf('**Standalone /qa'));
  const ask = standalone.search(/explicit approval/i);
  const gate = standalone.search(/only after approval/i);
  const setup = standalone.indexOf('`cd <SKILL_DIR> && ./setup`');
  expect(ask).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(ask);
  expect(setup).toBeGreaterThan(gate);
  expect(standalone).toContain('/setup-browser-cookies');
  expect(standalone).toMatch(/declined, unavailable or unsuccessful[\s\S]{0,40}blocked/i);
  expect(decision).toMatch(/unknown caller[^\n]*report-only/i);
  expect(body).not.toContain('If `NEEDS_SETUP`: tell the user');
  expect(body).not.toContain('An authenticated page needs /setup-browser-cookies');
}

describe('QA caller authority in pure host renders', () => {
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: a scope handoff requires the actual prior method read`, () => {
      for (const caller of callers) {
        const body = RESOLVERS.QA_EXPLORATORY(context(host.name, caller));
        const scope = body.indexOf('Read `sections/scope.md`');
        const methods = body.indexOf('**Functional surfaces:**');
        expect(scope).toBeGreaterThan(-1);
        expect(methods).toBeGreaterThan(scope);
        expect(body.indexOf('## 1. Charter and preflight')).toBeGreaterThan(methods);
        expect(body).not.toContain('If the caller has not selected surfaces and established isolation');
      }
    });

    test(`${host.name}: exploratory scope defines its controller and timing before probes`, () => {
      for (const caller of callers) {
        const body = RESOLVERS.QA_EXPLORATORY(context(host.name, caller));
        expect(body).toContain('The **caller** (/qa, /qa-only, /review or /ship)');
        const n = qaProbeNames(body);
        const start = `bun ${n.guard} start ${n.deadline} SECONDS [EARLIER_UTC]`;
        expect(body).toContain(start);
        expect(body).toContain(`${n.guard} enforces the deadline`);
        expect(body.indexOf(start)).toBeLessThan(body.indexOf('1. First demonstrate success'));
        expect(body).toMatch(/stop when scoped contracts are tested or blocked/i);
      }
    });

    test(`${host.name}: final QA cannot omit caller-required rechecks as unaffected`, () => {
      const body = render('qa/SKILL.md.tmpl', {
        ...context(host.name, 'qa'), tmplPath: 'qa/SKILL.md.tmpl', preambleTier: 4,
      });
      const final = body.slice(body.indexOf('## Phase 9: Final QA'), body.indexOf('## Phase 10: Report'));
      expect(final).toMatch(/caller-required rechecks cannot be skipped as unaffected/i);
      expect(final).toMatch(/blocked\/inconclusive rechecks never verify repairs/i);
    });

    test(`${host.name}: prior learnings name QA findings without changing review callers`, () => {
      for (const skill of ['qa', 'qa-only']) {
        const body = RESOLVERS.LEARNINGS_SEARCH(context(host.name, skill));
        expect(body).toContain('When a QA finding');
        expect(body).not.toContain('When a review finding');
        expect(body).toContain('Prior learning applied');
      }
      for (const skill of ['review', 'ship']) {
        expect(RESOLVERS.LEARNINGS_SEARCH(context(host.name, skill))).toContain('When a review finding');
      }
    });

    test(`${host.name}: report-only learning lookup cannot configure or initialize stores`, () => {
      const ctx = context(host.name, 'qa-only');
      const search = RESOLVERS.LEARNINGS_SEARCH(ctx, ['query=webhook retries']);
      expect(search).toMatch(/learnings\.jsonl only if its directory is already known/i);
      expect(search).toMatch(/the caller permits that Read/i);
      expect(search).toContain('"webhook retries"');
      expect(search).toMatch(/do not run gstack-learnings-search here/i);
      expect(search).not.toContain('```bash');
      expect(search).not.toContain('gstack-config');
      expect(search).not.toContain('AskUserQuestion');
      expect(() => RESOLVERS.LEARNINGS_SEARCH(ctx, ['query=$(touch outside)'])).toThrow();
    });

    test(`${host.name}: missing lazy sections stop affected probes, not independent checks`, () => {
      for (const skill of ['qa', 'qa-only']) {
        const ctx = context(host.name, skill);
        for (const id of ['browser-setup', 'exploratory']) {
          const sharedSetup = skill === 'qa-only' && id === 'browser-setup';
          const pointer = sharedSetup ? RESOLVERS.QA_RESOURCE(ctx, [id]) : RESOLVERS.SECTION(ctx, [id]);
          assertProbeLocalBlocker(pointer);
          expect(pointer).toContain(`\`sections/${id}.md\``);
          expect(pointer).toContain('SKILL.md directory');
          expect(pointer).toMatch(sharedSetup ? /no product-directory or cross-host substitutes/i : /never the product working directory/i);
          expect(pointer).not.toContain('## BROWSER SETUP');
          expect(pointer).not.toContain('aside repl');
        }
      }
    });

    test(`${host.name}: each installed caller resource uses the same blocker rule`, () => {
      for (const caller of callers) {
        const resource = RESOLVERS.QA_RESOURCE(context(host.name, caller), ['browser-setup']);
        assertProbeLocalBlocker(resource);
        if (caller === 'review' || caller === 'ship') {
          expect(resource).toContain(`../${host.name === 'claude' ? 'qa' : 'gstack-qa'}/sections/browser-setup.md`);
          expect(resource).toContain(`installed /${caller} SKILL.md`);
        } else {
          expect(resource).toContain('installed');
          expect(resource).toContain('sections/browser-setup.md');
        }
      }
    });

    test(`${host.name}: shared QA setup chooses runtime caller authority before readiness`, () => {
      const ctx = context(host.name, 'qa');
      const body = render('qa/sections/browser-setup.md.tmpl', ctx);
      assertSharedBrowserAuthority(body);
      expect(body.indexOf('## Browser access decision')).toBeLessThan(body.indexOf('## BROWSER SETUP'));
      expect(body.indexOf('## BROWSER SETUP')).toBeLessThan(body.indexOf('## Browser fallback'));
      expect(body.replace(/\s+/g, ' ')).toMatch(/functional-only targets do not probe Aside/i);
      expect(body).toMatch(/ownership rules apply even to local browser targets/i);
      expect(body).toMatch(/never substitute unit tests or curl for the browser step/i);
      expect(body).toMatch(/never type passwords, one-time codes, or payment details/i);
      expect(body).toMatch(/never read, screenshot, navigate, or close any other tab/i);
      expect((body.match(/cd <SKILL_DIR> && \.\/setup/g) ?? [])).toHaveLength(1);
    });

    test(`${host.name}: QA fallback delegates setup and authentication without new authority`, () => {
      for (const caller of callers) {
        const fallback = RESOLVERS.BROWSE_FALLBACK(context(host.name, caller));
        expect(fallback).toContain('Browser access decision');
        expect(fallback).not.toContain('OK to proceed?');
        expect(fallback).not.toContain('run `cd <SKILL_DIR>');
        expect(fallback).not.toContain('An authenticated page needs /setup-browser-cookies');
        expect(fallback).toContain('$B snapshot -i');
        expect(fallback).toContain('DIFF_START');
        expect(fallback).toContain('CONSOLE_ERRORS=');
      }
    });

    test(`${host.name}: browser methodology routes auth through the decision instead of importing`, () => {
      const body = render('qa/sections/qa-patterns.md.tmpl', context(host.name, 'qa'));
      const auth = body.slice(body.indexOf('### Phase 2:'), body.indexOf('### Phase 3:'));
      expect(auth).toContain('Browser access decision');
      expect(auth).not.toContain('Fallback: /setup-browser-cookies or');
      expect(auth).toMatch(/never handle credentials/i);
    });

    test(`${host.name}: functional-only and report-only paths preserve independent checks and gates`, () => {
      const scope = RESOLVERS.QA_SCOPE(context(host.name, 'qa'));
      expect(scope).toMatch(/functional-only runs must not read browser setup/i);
      expect(scope).not.toContain('command -v aside');
      expect(scope).not.toContain('curl -sI');
      for (const caller of callers) {
        const ctx = context(host.name, caller);
        const body = RESOLVERS.QA_EXPLORATORY(ctx);
        const compact = body.replace(/\s+/g, ' ');
        expect(compact).toMatch(/block affected probes, not independent safe checks/i);
        expect(compact).not.toContain('stop all checks');
        expect(body).toContain('2. Read the selected surface methods below in full');
        expect(body.indexOf('2. Read the selected surface methods below in full')).toBeLessThan(body.indexOf('1. First demonstrate success'));
        const reads = RESOLVERS.QA_METHOD_READS(context(host.name, caller));
        expect(reads).toContain('**Functional surfaces:**');
        expect(reads).toContain('sections/system-functional.md');
        expect(reads).toContain('**Browser surfaces only:**');
        expect(reads).toContain('sections/qa-patterns.md');
        expect(body).toMatch(/no workflows, framework installs or publication/i);
        expect(body).toMatch(/owns decisions, tests, fixes and publication/i);
        expect(body).toMatch(/timeouts and refusal never pass/i);
        expect(body).toMatch(/pass requires all required current-input contracts to pass/i);
        if (caller !== 'qa-only') {
          expect(body).toContain('leaves /review incomplete');
          expect(body).toMatch(/unless the user explicitly accepts that named risk/i);
          expect(body).toMatch(/noninteractive runs return blocked/i);
          expect(body).toMatch(/test_stub proposals require ASK approval/i);
        }
      }
      const review = RESOLVERS.QA_REVIEW(context(host.name, 'review'));
      const ship = RESOLVERS.QA_REVIEW(context(host.name, 'ship'));
      expect(review).toMatch(/a ship waiver cannot complete it/i);
      expect(ship).toMatch(/explicit named-risk acceptance/i);
      expect(ship.replace(/\s+/g, ' ')).toMatch(/report clean\/completed only when all required checks pass on current inputs/i);
    });

    test(`${host.name}: non-QA fallback retains its existing setup and human sign-in flow`, () => {
      const fallback = RESOLVERS.BROWSE_FALLBACK(context(host.name, 'browse'));
      expect(fallback).toContain('OK to proceed?');
      expect(fallback).toMatch(/stop for the answer, then run `cd <SKILL_DIR> && \.\/setup`/i);
      expect(fallback.indexOf('OK to proceed?')).toBeLessThan(fallback.indexOf('cd <SKILL_DIR> && ./setup'));
      expect(fallback).toContain('An authenticated page needs /setup-browser-cookies');
      expect(fallback).toContain('$B handoff');
      expect(fallback).toContain('$B resume');
      expect(fallback).not.toContain('Browser access decision');
    });

    test(`${host.name}: orchestration declares required probes before execution`, () => {
      for (const caller of ['review', 'ship']) {
        const ctx = context(host.name, caller);
        const body = (caller === 'review' ? RESOLVERS.QA_REVIEW_PREFLIGHT(ctx) : '') + RESOLVERS.QA_REVIEW(ctx);
        const exploration = body.indexOf('{{QA_RESOURCE:exploratory}}');
        expect(exploration).toBeGreaterThan(-1);
        const resource = RESOLVERS.QA_RESOURCE(ctx, ['exploratory']);
        expect(resource).toContain(`../${host.name === 'claude' ? 'qa' : 'gstack-qa'}/sections/exploratory.md`);
        const shared = render('qa/sections/exploratory.md.tmpl', context(host.name, 'qa'));
        expect(shared.indexOf('Read `sections/scope.md`')).toBeLessThan(shared.indexOf('Read `sections/system-functional.md`'));
        const required = body.indexOf(caller === 'review'
          ? '2. Check readiness and list required checks' : '2. List required checks');
        expect(required).toBeGreaterThan(-1);
        expect(exploration).toBeLessThan(required);
        expect(body).toContain('5 minutes/12 probes');
        expect(body.replace(/\s+/g, ' ')).toMatch(/report clean\/completed only when all required checks pass on current inputs/i);
      }
      const ship = RESOLVERS.QA_REVIEW(context(host.name, 'ship'));
      expect(ship).toContain('Step 9.4');
      expect(ship).toMatch(/explicit named-risk acceptance; otherwise blocked/i);
    });

    test(`${host.name}: caller QA selects surfaces directly and links checkpoints in one final section`, () => {
      for (const caller of ['review', 'ship']) {
        const ctx = context(host.name, caller);
        const body = (caller === 'review' ? RESOLVERS.QA_REVIEW_PREFLIGHT(ctx) : '') + RESOLVERS.QA_REVIEW(ctx);
        const exploration = body.indexOf('{{QA_RESOURCE:exploratory}}');
        const shared = render('qa/sections/exploratory.md.tmpl', context(host.name, 'qa'));
        const scope = shared.indexOf('Read `sections/scope.md`');
        const methods = shared.indexOf('**Functional surfaces:**');
        const probes = body.indexOf(caller === 'review'
          ? '2. Check readiness and list required checks' : '2. List required checks');
        expect(scope).toBeGreaterThan(-1);
        expect(exploration).toBeGreaterThan(-1);
        expect(methods).toBeGreaterThan(scope);
        expect(shared.indexOf('## 1. Charter and preflight')).toBeGreaterThan(methods);
        expect(exploration).toBeLessThan(probes);
        expect(body).not.toContain('**Functional surfaces:**');
        expect(RESOLVERS.QA_RESOURCE(ctx, ['exploratory'])).toContain(`../${host.name === 'claude' ? 'qa' : 'gstack-qa'}/sections/exploratory.md`);
        if (caller === 'review') {
          const flat = body.replace(/\s+/g, ' ');
          expect(flat).toContain('`## Exploratory QA and Verification Results`');
          expect(flat).toContain('`### Browser results`');
          expect(flat).toMatch(/link every checkpoint/i);
          expect(flat).toMatch(/no second report/i);
        } else {
          expect(body.replace(/\s+/g, ' ')).toContain('`## Exploratory QA');
          expect(body).toMatch(/link every checkpoint; no second report/i);
        }
        expect(body).toContain('templates/functional-report-template.md');
        expect(body).not.toContain('not a second report');
      }
    });

    test(`${host.name}: orchestration logs reviewer attempts before parent-owned edits`, () => {
      const body = RESOLVERS.ADVERSARIAL_STEP(context(host.name, 'review'));
      const flat = body.replace(/\s+/g, ' ');
      expect(flat).toMatch(/Fix-First handling at Step 5; do not edit during Step 4\.8/i);
      expect(flat).toMatch(/do not start an inner repair loop/i);
      expect(flat).toMatch(/do not overwrite the parent's REVIEW_START/i);
      expect(flat).toMatch(/one record per source, phase and attempt/i);
      expect(flat).toMatch(/each token is consumed once/i);
      expect(body).not.toContain('address the findings. Re-run the same shared structured invocation');
      expect(flat).toMatch(/native pass is required for Step 5\.8 completion/i);
    });

    test(`${host.name}: orchestration skips only history matching without user skips`, () => {
      for (const caller of ['review', 'ship']) {
        const body = RESOLVERS.CROSS_REVIEW_DEDUP(context(host.name, caller));
        if (caller === 'ship') {
          const flat = body.replace(/\s+/g, ' ');
          expect(body.indexOf('2. **Read decisions.**')).toBeLessThan(body.indexOf('3. **Match evidence.**'));
          expect(flat).toMatch(/only explicit `skipped` actions qualify, never `fixed`, `auto-fixed` or unanswered questions/i);
        } else {
          expect(body).toMatch(/still classify current findings/i);
          expect(body.indexOf('If no prior reviews exist')).toBeLessThan(body.indexOf('For each JSONL entry'));
          expect(body).toMatch(/only suppress `skipped` findings — never `fixed` or `auto-fixed`/i);
        }
        expect(body).not.toContain('skip this step silently');
      }
    });

    test(`${host.name}: orchestration consumes the existing generation allowance at both coverage gates`, () => {
      const body = RESOLVERS.TEST_COVERAGE_GATE_SHIP(context(host.name, 'ship'));
      expect(body).toContain("Step 7's remaining generation allowance");
      expect(body.match(/If A and allowance remains:/g)).toHaveLength(2);
      expect(body).toMatch(/at the cap, offer only B\/C or stop/i);
      expect(body).toMatch(/at the cap, offer only B or stop/i);
      expect(body).toMatch(/at the cap, omit A's generation pass and recommend stopping/i);
      expect(body).toContain('Minimum = 60%, Target = 80%');
      expect(body).not.toContain('Maximum 2 passes total');
    });
  }

  test('report-only recommendations cannot dispatch a repair skill during discovery', () => {
    const skill = readFileSync(join(root, 'qa-only/SKILL.md.tmpl'), 'utf8');
    expect(skill).toMatch(/never invoke \/qa or another skill from this report-only run/i);
    expect(skill).toMatch(/separate, user-authorized/i);
    expect(skill).toMatch(/never commit, stash or bootstrap/i);
  });

  test('standalone QA scopes its general test rule around the approved browser bootstrap', () => {
    const skill = readFileSync(join(root, 'qa/SKILL.md.tmpl'), 'utf8');
    const rule = skill.split('\n').find(line => line.startsWith('**Outside an explicitly approved browser bootstrap:**'));
    expect(skill).not.toMatch(/^13\. /m);
    expect(rule).toMatch(/authorized codification in Phase 8a\.5/i);
    expect(rule).toMatch(/never modify CI configuration or weaken existing tests/i);
    const bootstrap = readFileSync(join(root, 'qa/sections/test-bootstrap.md.tmpl'), 'utf8');
    expect(bootstrap).toMatch(/browser \/qa only, never functional\/report-only/i);
    const ask = bootstrap.search(/AskUserQuestion and wait/i);
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(bootstrap.search(/install only the actual choice/i));
    expect(bootstrap).toMatch(/never silently delete a valid red regression/i);
    expect(bootstrap).toContain('create/extend `.github/workflows/test.yml`');
  });

  test('negative controls reject workflow-wide stopping and ungated installation', () => {
    const ctx = context('claude', 'qa');
    const pointer = RESOLVERS.SECTION(ctx, ['browser-setup']);
    expect(() => assertProbeLocalBlocker(pointer + '\nstop that workflow')).toThrow();
    expect(() => assertProbeLocalBlocker(pointer.replace('continue other safe probes', 'stop all checks'))).toThrow();
    const setup = render('qa/sections/browser-setup.md.tmpl', ctx);
    expect(() => assertSharedBrowserAuthority(setup.replace('Only after approval', 'Immediately'))).toThrow();
    expect(() => assertSharedBrowserAuthority(setup.replace('explicit approval', 'a status update'))).toThrow();
    expect(() => assertSharedBrowserAuthority(setup.replace('Never bootstrap or invoke another skill', 'Invoke another skill'))).toThrow();
    expect(() => assertSharedBrowserAuthority(setup + '\nIf `NEEDS_SETUP`: tell the user')).toThrow();
    expect(() => assertSharedBrowserAuthority(setup + '\nAn authenticated page needs /setup-browser-cookies')).toThrow();
  });
});
