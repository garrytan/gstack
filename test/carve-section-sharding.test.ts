import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { isPaidTestFile } from './helpers/paid-test-set';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { CASE_SHARDED_FILES, DEFAULT_SHARD_TIMEOUT_MS, caseFile, expandCaseShards, retriesForFiles, selectPaidTestFiles } from '../scripts/test-paid-shards';
import { carveSectionCaseId } from './helpers/carve-section-case';
import { E2E_TIERS, E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { E2E_KINDS } from './helpers/touchfiles-data';

describe('carved-skill cases each get a complete paid process budget', () => {
  const FILE = 'test/carve-section-loading.test.ts';
  const ROOT = path.resolve(import.meta.dir, '..');
  const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  const cases = [...source.matchAll(/test\('carve-section-loading-([a-z-]+)', \(\) => runCarveSectionCase\('([a-z-]+)'\), CAPTURE_LONG_MS\)/g)]
    .map(match => ({ id: `carve-section-loading-${match[1]}`, skill: match[2]! }));
  const generic = Object.values(CARVE_GUARDS).filter(guard => guard.behavioral === 'plan' || guard.behavioral === 'prompt').map(guard => guard.skill).sort();

  test('every generic registry entry has exactly one periodic case, under its own case id, and no external entry does', () => {
    expect(source).toContain("describeE2ETier('periodic')");
    expect(isPaidTestFile(FILE)).toBe(true);
    expect(cases.map(c => c.skill).sort()).toEqual(generic);
    for (const c of cases) {
      expect(c.id).toBe(carveSectionCaseId(c.skill));
      expect(E2E_TIERS[c.id], c.id).toBe('periodic');
      expect(E2E_KINDS[c.id], c.id).toBe('rule');
    }
    expect(CASE_SHARDED_FILES).toContain(FILE);
    expect(selectPaidTestFiles([FILE], 'periodic').selected).toEqual([FILE]);
    expect(selectPaidTestFiles([FILE], 'gate').selected).toHaveLength(0);
    expect(expandCaseShards([FILE], 'periodic').sort()).toEqual(cases.map(c => `${FILE}#${c.id}`).sort());
    expect(fs.readdirSync(import.meta.dir).filter(name => /^carve-section-loading-.*\.test\.ts$/.test(name))).toEqual([]);
  });

  test('every case run plus teardown fits its own process wall', () => {
    expect(retriesForFiles([FILE])).toBe(0);
    expect(CAPTURE_LONG_MS + 10_000).toBeLessThan(DEFAULT_SHARD_TIMEOUT_MS);
  });

  test('an edit to one carved skill selects only its case; the shared registry selects every case; --case runs one', () => {
    for (const { id, skill } of cases) {
      const selected = selectTests([`${skill}/SKILL.md.tmpl`], E2E_TOUCHFILES).selected.filter(name => name.startsWith('carve-section-loading'));
      expect(selected, skill).toEqual([id]);
      expect(caseFile(id)).toBe(FILE);
    }
    expect(selectTests(['test/helpers/carve-guards.ts'], E2E_TOUCHFILES).selected.filter(name => name.startsWith('carve-section-loading')).sort())
      .toEqual(cases.map(c => c.id).sort());
    // The retired GSTACK_CARVE_SKILL scope can no longer suppress a planned case: nothing reads it.
    for (const file of ['scripts/test-paid-shards.ts', 'scripts/lib/paid-select.ts', 'test/helpers/carve-section-case.ts', FILE]) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).not.toContain('GSTACK_CARVE_SKILL');
    }
  });
});

describe('design-consultation section completion (census 36641820398 slice 8)', () => {
const DC_ROOT = path.resolve(import.meta.dir, '..');
// DESIGN.md content from the Write call of the census 36641820398 slice 8
// design-consultation capture. That run Read its section at 11s and wrote
// DESIGN.md and CLAUDE.md, then timed out composing the duplicate REPORT.md
// the generic fixture requested.
const designConsultationMd = fs.readFileSync(path.join(import.meta.dir, 'fixtures/design-consultation-section-design-md.md'), 'utf8');
const genericReport = '# Design report\n' + 'The design review summary is complete. '.repeat(8);

interface Fixture {
  output?: string;
  file?: 'DESIGN.md' | 'REPORT.md' | null;
  exitReason?: string;
  missingRead?: boolean;
}

// Run the actual paid registration and capture helper in an isolated free
// child; only the session-runner/provider boundary is replaced.
function exercise(fixture: Fixture = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-consultation-completion-'));
  const script = path.join(dir, 'capture.test.ts');
  const facts = path.join(dir, 'facts.json');
  const input = { output: designConsultationMd, file: 'DESIGN.md', exitReason: 'success', missingRead: false, ...fixture };
  fs.writeFileSync(script, `
import { expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from ${JSON.stringify(path.join(DC_ROOT, 'test/helpers/carve-guards.ts'))};
const input = ${JSON.stringify(input)};
const guard = CARVE_GUARDS['design-consultation'];
mock.module(${JSON.stringify(path.join(DC_ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ prompt: opts.prompt, timeout: opts.timeout, allowedTools: opts.allowedTools }));
    if (input.file) fs.writeFileSync(path.join(opts.workingDirectory, input.file), input.output);
    return {
      exitReason: input.exitReason, output: 'Wrote DESIGN.md and CLAUDE.md.',
      toolCalls: input.missingRead ? [] : guard.requiredReads.map(section => ({
        tool: 'Read', input: { file_path: path.join(opts.workingDirectory, 'design-consultation', 'sections', section) },
      })), transcript: [],
    };
  },
}));
const { registerCarveSectionCase } = await import(${JSON.stringify(path.join(DC_ROOT, 'test/helpers/carve-section-case.ts'))});
registerCarveSectionCase('design-consultation');
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: DC_ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 10_000,
    });
    expect(fs.existsSync(facts), child.stderr.toString()).toBe(true);
    expect(child.signalCode ?? null).toBeNull();
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString(),
      facts: JSON.parse(fs.readFileSync(facts, 'utf8')) as { prompt: string; timeout: number; allowedTools: string[] } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the captured DESIGN.md is the completed output; no duplicate report is requested', () => {
  expect(designConsultationMd.split('\n')[1]).toBe('# gstack: design-md-format=spec');
  const result = exercise();
  expect(result.code, result.output).toBe(0);
  expect(result.facts.timeout).toBe(480_000);
  expect(result.facts.prompt).toContain('declined the optional outside design voices');
  expect(result.facts.prompt).toMatch(/write the skill's final output[^\n]*DESIGN\.md/);
  expect(result.facts.prompt).not.toContain('REPORT.md');
}, 20_000);

test('the census timeout still fails even after DESIGN.md was written', () => {
  expect(exercise({ exitReason: 'timeout' }).code).not.toBe(0);
}, 20_000);

test('a generic report without the DESIGN.md format marker does not count as completion', () => {
  expect(exercise({ output: genericReport }).code).not.toBe(0);
  expect(exercise({ output: genericReport, file: 'REPORT.md' }).code).not.toBe(0);
});

test('a terminal-only claim without writing DESIGN.md fails', () => {
  expect(exercise({ file: null }).code).not.toBe(0);
}, 20_000);

test('skipping the section Read fails', () => {
  expect(exercise({ missingRead: true }).code).not.toBe(0);
}, 20_000);

});
