import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
// Exact REPORT.md from the completed native design-html capture, session
// 7fded9af-0cb9-44ce-8aed-4cb25cd054a0. Only the report is retained here; no
// transcript, private paths, thinking, or signatures are needed by the test.
const report = fs.readFileSync(path.join(import.meta.dir, 'fixtures/design-html-section-complete.md'), 'utf8');
const genericReport = '# Review report\n' + 'The requested section work is complete. '.repeat(8);

interface Fixture {
  skill?: string;
  output?: string;
  writeReport?: boolean;
  exitReason?: string;
  missingRead?: string;
}

// Run the actual paid registration and actual capture helper in an isolated
// free child. Only the session-runner/provider boundary is replaced. This
// covers file-vs-stdout selection, native completion, and the real assertions.
function exercise(fixture: Fixture = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-html-completion-'));
  const script = path.join(dir, 'capture.test.ts');
  const facts = path.join(dir, 'facts.json');
  const input = { skill: 'design-html', output: report, writeReport: true, exitReason: 'success', ...fixture };
  fs.writeFileSync(script, `
import { expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/carve-guards.ts'))};
import { resolveEvalModel } from ${JSON.stringify(path.join(ROOT, 'lib/eval-model.ts'))};
const input = ${JSON.stringify(input)};
const guard = CARVE_GUARDS[input.skill];
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    expect(opts.prompt).toContain(guard.scenario);
    expect(opts).toMatchObject({ maxTurns: 25, timeout: 480000, model: resolveEvalModel('capture') });
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent']);
    if (input.writeReport) fs.writeFileSync(path.join(opts.workingDirectory, 'REPORT.md'), input.output);
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ called: true }));
    return {
      exitReason: input.exitReason, output: input.output,
      toolCalls: guard.requiredReads.filter(section => section !== input.missingRead).map(section => ({
        tool: 'Read', input: { file_path: path.join(opts.workingDirectory, input.skill, 'sections', section) },
      })), transcript: [],
    };
  },
}));
const { registerCarveSectionCase } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/carve-section-case.ts'))});
registerCarveSectionCase(input.skill);
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 10_000,
    });
    expect(fs.existsSync(facts), child.stderr.toString()).toBe(true);
    expect(JSON.parse(fs.readFileSync(facts, 'utf8'))).toEqual({ called: true });
    expect(child.signalCode ?? null).toBeNull();
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts the exact completed HTML report without generic review keywords', () => {
  expect(new Bun.CryptoHasher('sha256').update(report).digest('hex')).toBe('82818f5b3c5ded9acda285d7115f7b1aee1e3dce6c456a3f2833ead52e268038');
  expect(/report|review|summary|design doc|handoff/i.test(report)).toBe(false);
  const result = exercise();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each([
  ['missing file despite complete terminal HTML', { writeReport: false }],
  ['generic prose instead of HTML', { output: genericReport }],
  ['missing doctype', { output: report.replace('<!DOCTYPE html>', '') }],
  ['missing html opening', { output: report.replace('<html lang="en">', '') }],
  ['missing head closing', { output: report.replace('</head>', '') }],
  ['missing body opening', { output: report.replace('<body>', '') }],
  ['missing body closing', { output: report.replace('</body>', '') }],
  ['truncated document', { output: report.slice(0, report.indexOf('</html>')) }],
  ['failed native run with complete file', { exitReason: 'error_api' }],
  ['timed out native run with complete file', { exitReason: 'timeout' }],
  ['missing doctrine Read', { missingRead: 'doctrine.md' }],
  ['missing Pretext Read', { missingRead: 'pretext-patterns.md' }],
  ['short complete document below the existing floor', { output: '<!doctype html><html><head><title>Pricing</title></head><body>Pricing</body></html>' }],
] satisfies Array<[string, Fixture]>)('rejects %s', (_name, fixture) => {
  const result = exercise(fixture);
  expect(result.code, result.output).toBe(1);
}, 20_000);

test('other carved skills preserve their generic report and stdout rules', () => {
  const generic = exercise({ skill: 'review', output: genericReport, writeReport: false });
  expect(generic.code, generic.output).toBe(0);
  const html = exercise({ skill: 'review' });
  expect(html.code, html.output).toBe(1);
}, 20_000);
