// Recall regressions for /cso, from the gstack-evals#443 real-advisory run (52 GitHub
// security advisories, Opus 5.5): with /cso the audit named 3 of 51 advisories against 12
// for a plain audit, reported 0.75 findings per session against 14.8, and in 5 of 10 misses
// never opened a file the fix changed. Pinned here against the real helper: a refused start
// the skill told the model never to retry, a file list the model could not see past a cut-off
// shell result, and a report rule (enforced by the helper) that dropped every finding short of proof.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const MIB = 1024 * 1024;
const skill = () => fs.readFileSync(path.join(ROOT, 'cso/SKILL.md'), 'utf8');
let root = '';
let state = '';
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cso-recall-')));
  state = path.join(root, 'state');
  fs.mkdirSync(state);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH ?? '' }, timeout: 60_000 });
  if (result.status) throw new Error(result.stderr);
}
function cso(repo: string, args: string[]) {
  return spawnSync(launcher, args, { cwd: repo, encoding: 'utf8', env: { HOME: root, GSTACK_HOME: state, PATH: process.env.PATH ?? '' }, timeout: 120_000, maxBuffer: 64 * MIB });
}
function findReport(dir: string, run: string, name: string): string {
  for (const entry of fs.readdirSync(dir, { recursive: true }) as string[])
    if (entry.endsWith(path.join(run, name))) return path.join(dir, entry);
  throw new Error('no ' + name + ' for ' + run);
}
function json(stdout: string): any {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}
/** A library shaped like the eval's units: many ordinary modules, with the vulnerable parser late in the inventory. */
function library(name: string): { repo: string; files: string[] } {
  const repo = path.join(root, name);
  const files: Record<string, string> = { 'package.json': '{"name":"fixture-lib","version":"1.0.0","main":"src/index.js"}\n' };
  for (let i = 0; i < 320; i++) files[`src/modules/m${String(i).padStart(3, '0')}.js`] = `module.exports = (x) => x + ${i};\n`;
  files['src/zz-format/parse.js'] = 'module.exports = (input) => { const o = {}; for (const [k, v] of input) o[k] = v; return o; };\n';
  files['src/index.js'] = "module.exports = { parse: require('./zz-format/parse') };\n";
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  return { repo, files: Object.keys(files).sort() };
}

describe('/cso recall (gstack-evals#443)', () => {
  test('a refused start is corrected and retried, and the source-cap correction is --paths', () => {
    const text = skill();
    const invariant = text.slice(text.indexOf('**One-run invariant.**'), text.indexOf('**Audited-source access invariant.**'));
    expect(invariant).toContain('A refused `start` (`"ok":false`) holds no run');
    expect(invariant).toContain('start again');
    expect(invariant).toContain('64 MiB');
    expect(invariant).toContain('--paths');
    expect(invariant).toMatch(/Once a `start` returns a run ID, never call `start` again/);
    expect(invariant).not.toMatch(/On failure, make one correction, then finish partial/);
  });

  test('the skill names a command that lists the whole inventory from real inspect output', () => {
    const { repo, files } = library('inventory');
    const start = cso(repo, ['start', '--repo', repo, '--offline']);
    expect(start.status).toBe(0);
    const run = json(start.stdout).runId as string;
    const inspect = cso(repo, ['inspect', run]);
    expect(inspect.status).toBe(0);
    const filter = skill().match(/jq -r '([^']+)'/)?.[1];
    expect(filter).toBe('.manifest.entries[].path');
    const listed = (json(inspect.stdout).manifest.entries as Array<{ path: string }>).map((entry) => entry.path).sort();
    expect(listed).toEqual(files);
    const read = cso(repo, ['read', run, 'src/zz-format/parse.js']);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('o[k] = v');
    expect(cso(repo, ['finish', run]).status).toBe(0);
  });

  test('search reads every file in one call, never runs a file name, and lists what it could not search', () => {
    const repo = path.join(root, 'hostile');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const hostile = 'src/a$(touch PWNED).js';
    fs.writeFileSync(path.join(repo, hostile), 'eval(input)\n');
    fs.writeFileSync(path.join(repo, 'src/parse.js'), 'const x = 1;\neval(input)\n');
    fs.writeFileSync(path.join(repo, 'src/big.js'), 'eval(input)\n' + 'x'.repeat(MIB + 16));
    fs.writeFileSync(path.join(repo, 'src/min.js'), 'a(b,c);'.repeat(140_000) + 'eval(late)');
    fs.mkdirSync(path.join(repo, '.gstack'));
    fs.writeFileSync(path.join(repo, '.gstack/state.js'), 'eval(input)\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
    const run = json(cso(repo, ['start', '--repo', repo, '--offline']).stdout).runId as string;
    expect(skill()).toContain("gstack-cso search <run> '<regex>'");
    const found = cso(repo, ['search', run, 'eval\\(']);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain('src/parse.js:2:eval(input)');
    expect(found.stdout).toContain(hostile + ':1:eval(input)');
    expect(found.stdout).toMatch(/src\/min\.js:1:[a-c(),;]{100}eval\(late\)/);
    expect(found.stdout).toMatch(/1 unsearched paths .*coverage gap: src\/big\.js\]/);
    expect(found.stdout).not.toContain('.gstack/state.js');
    expect(found.stdout).toContain('1 paths the snapshot excluded or withheld have no readable copy');
    expect(found.stdout).toMatch(/1 paths have lines over 4096 characters.*: src\/min\.js\]/);
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'PWNED'))).toBe(false);
    const none = cso(repo, ['search', run, 'zzz-no-such-text']).stdout;
    expect(none).toContain('[gstack-cso search: no matches]');
    expect(none).toMatch(/1 unsearched paths .*src\/big\.js/);
    const bad = cso(repo, ['search', run, '(']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('not a valid regular expression');
    expect(cso(repo, ['search', run, 'x', '--seconds', '61']).stderr).toContain('--seconds must be a whole number from 1 to 60');
    expect(cso(repo, ['finish', run]).status).toBe(0);
  });

  test('search stays fast on a one-line 1 MiB file and stops a runaway pattern at its time limit with the hits found so far', () => {
    const repo = path.join(root, 'minified');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'eval(first)\n');
    fs.writeFileSync(path.join(repo, 'src/b.min.js'), 'eval(second)\n' + 'x'.repeat(MIB - 64));
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
    const run = json(cso(repo, ['start', '--repo', repo, '--offline']).stdout).runId as string;
    let started = Date.now();
    const quadratic = cso(repo, ['search', run, '.*password']);
    expect(quadratic.status).toBe(0);
    expect(quadratic.stdout).toContain('[gstack-cso search: no matches]');
    expect(Date.now() - started).toBeLessThan(30_000);
    started = Date.now();
    const runaway = cso(repo, ['search', run, '(x+x+)+y|eval\\((first|second)', '--seconds', '2']);
    expect(runaway.status).toBe(0);
    expect(runaway.stdout).toContain('src/a.js:1:eval(first)');
    expect(runaway.stdout).toContain('src/b.min.js:1:eval(second)');
    expect(runaway.stdout).toMatch(/stopped at the 2-second limit; 1 paths not searched, a coverage gap: src\/b\.min\.js/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(cso(repo, ['finish', run]).status).toBe(0);
  }, 90_000);

  test('the report rule keeps every supported finding and lists hypotheses instead of dropping them', () => {
    const text = skill();
    for (const dropped of ['Daily reports hold only', 'Omit daily candidates', 'Prioritize unresolved high impact', 'demonstrated in-scope impact']) expect(text).not.toContain(dropped);
    for (const kept of ['jq -r .runId', "sed -n '1,500p'", 'gstack-cso search', 'Report every finding the code supports', 'never omission', 'Hypotheses (unconfirmed)', 'even with callers outside the snapshot', 'Drop one only when code you read disproves it', 'Never narrow by file name']) expect(text).toContain(kept);
  });

  test('a daily run saves supported findings and low-confidence hypotheses, and report.md lists them in separate sections', () => {
    const { repo } = library('report');
    const run = json(cso(repo, ['start', '--repo', repo, '--offline']).stdout).runId as string;
    const finding = (evidence: string, confidence: string, title: string, rootCause: string) => ({
      title, rootCause,
      location: { path: 'src/zz-format/parse.js', line: 1, symbol: 'parse' }, advisoryIds: [], severity: 'high', confidence,
      confidenceRationale: 'the loop assigns every key without a guard', evidence,
      attackerControl: 'entries passed to the public parse API', impact: 'a __proto__ entry sets the returned object\'s prototype, so properties the caller reads but never set come from the attacker',
      scenario: 'a caller parses untrusted entries including __proto__', trace: ['index.js parse', 'parse.js loop'],
      references: ['src/zz-format/parse.js:1'], recommendation: 'reject __proto__, constructor and prototype keys',
      challenge: { reviewer: 'sequential challenge; independent agent unavailable', independent: false, mode: 'sequential_fallback', callers: 'public API', controls: 'none found', counterevidence: 'none', conclusion: 'holds' },
    });
    const submit = (evidence: string, confidence: string, title: string, rootCause: string) => {
      const dir = fs.mkdtempSync(path.join(root, 'submission-'));
      const file = path.join(dir, 'submission.json');
      fs.writeFileSync(file, JSON.stringify({ findings: [finding(evidence, confidence, title, rootCause)] }));
      return cso(repo, ['submit', run, file]);
    };
    const supported = submit('supported', 'medium', 'Prototype injection in parse', 'parse copies attacker keys onto a plain object');
    expect(supported.status).toBe(0);
    expect(json(supported.stdout).findings).toBe(1);
    const hypothesis = submit('hypothesis', 'low', "Prototype injection through caller-named keys $' and $&", 'parse copies keys named by the caller');
    expect(hypothesis.status).toBe(0);
    expect(json(hypothesis.stdout).findings).toBe(2);
    expect(cso(repo, ['finish', run]).status).toBe(0);
    const saved = json(fs.readFileSync(findReport(state, run, 'report.json'), 'utf8')).findings as Array<{ title: string; evidence: string; confidence: string }>;
    expect(saved.map((f) => [f.title, f.evidence, f.confidence]).sort()).toEqual([
      ['Prototype injection in parse', 'supported', 'medium'],
      ["Prototype injection through caller-named keys $' and $&", 'hypothesis', 'low'],
    ]);
    const report = fs.readFileSync(findReport(state, run, 'report.md'), 'utf8');
    const supportedSection = report.slice(report.indexOf('Supported findings:'), report.indexOf('Hypotheses (unconfirmed):'));
    const hypotheses = report.slice(report.indexOf('Hypotheses (unconfirmed):'), report.indexOf('Snapshot transformations:'));
    expect(report.indexOf('Hypotheses (unconfirmed):')).toBeGreaterThan(report.indexOf('Supported findings:'));
    expect(supportedSection).toContain('Prototype injection in parse');
    expect(supportedSection).not.toContain('caller-named keys');
    expect(hypotheses).toContain('Prototype injection through caller-named keys');
    expect(hypotheses).not.toContain('Prototype injection in parse');
    expect(hypotheses).toContain('$&');
    expect(report.split('Snapshot transformations:').length).toBe(2);
  });
});
