// Recall regressions for /cso, from the gstack-evals#443 real-advisory run (52 GitHub
// security advisories, Opus 5.5): with /cso the audit named 3 of 51 advisories against 12
// for a plain audit, reported 0.75 findings per session against 14.8, and in 5 of 10 misses
// never opened a file the fix changed. Three causes are pinned here against the real helper:
// a refused start that the skill told the model never to retry, an inventory the model could
// not see in a shell result, and a report rule that dropped every finding short of proof.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const MIB = 1024 * 1024;
const skill = () => fs.readFileSync(path.join(ROOT, 'cso/SKILL.md'), 'utf8');
// Claude Code keeps at most this many characters of one Bash result by default.
const SHELL_RESULT_CHARS = 30_000;
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

  test('inspect hides the inventory from a shell result, and the skill names a command that lists all of it', () => {
    const { repo, files } = library('inventory');
    const start = cso(repo, ['start', '--repo', repo, '--offline']);
    expect(start.status).toBe(0);
    const run = json(start.stdout).runId as string;
    const inspect = cso(repo, ['inspect', run]);
    expect(inspect.status).toBe(0);
    const shown = inspect.stdout.slice(0, SHELL_RESULT_CHARS);
    expect(shown).not.toContain('src/zz-format/parse.js');
    const filter = skill().match(/jq -r '([^']+)'/)?.[1];
    expect(filter).toBe('.manifest.entries[].path');
    const listed = (json(inspect.stdout).manifest.entries as Array<{ path: string }>).map((entry) => entry.path).sort();
    expect(listed).toEqual(files);
    const read = cso(repo, ['read', run, 'src/zz-format/parse.js']);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('o[k] = v');
    expect(cso(repo, ['finish', run]).status).toBe(0);
  });

  test('the report rule keeps every supported finding and lists candidates instead of dropping them', () => {
    const text = skill();
    for (const dropped of ['Daily reports hold only', 'Omit daily candidates', 'Prioritize unresolved high impact', 'demonstrated in-scope impact']) expect(text).not.toContain(dropped);
    for (const kept of ['Report every finding the code supports', 'never omission', 'Candidates (unconfirmed)', 'even with callers outside the snapshot', 'Drop one only when code you read disproves it', 'Never narrow by file name']) expect(text).toContain(kept);
  });

  test('the helper takes supported findings in a daily run and refuses hypotheses, as the skill says', () => {
    const { repo } = library('report');
    const run = json(cso(repo, ['start', '--repo', repo, '--offline']).stdout).runId as string;
    const finding = (evidence: string, confidence: string) => ({
      title: 'Prototype pollution in parse', rootCause: 'parse copies attacker keys onto a plain object',
      location: { path: 'src/zz-format/parse.js', line: 1, symbol: 'parse' }, advisoryIds: [], severity: 'high', confidence,
      confidenceRationale: 'the loop assigns every key without a guard', evidence,
      attackerControl: 'entries passed to the public parse API', impact: 'Object.prototype pollution in the caller',
      scenario: 'a caller parses untrusted entries including __proto__', trace: ['index.js parse', 'parse.js loop'],
      references: ['src/zz-format/parse.js:1'], recommendation: 'reject __proto__, constructor and prototype keys',
      challenge: { reviewer: 'sequential challenge; independent agent unavailable', independent: false, mode: 'sequential_fallback', callers: 'public API', controls: 'none found', counterevidence: 'none', conclusion: 'holds' },
    });
    const submit = (evidence: string, confidence: string) => {
      const dir = fs.mkdtempSync(path.join(root, 'submission-'));
      const file = path.join(dir, 'submission.json');
      fs.writeFileSync(file, JSON.stringify({ findings: [finding(evidence, confidence)] }));
      return cso(repo, ['submit', run, file]);
    };
    const hypothesis = submit('hypothesis', 'low');
    expect(hypothesis.status).not.toBe(0);
    expect(hypothesis.stderr).toContain('Daily reports contain supported findings only');
    const supported = submit('supported', 'medium');
    expect(supported.status).toBe(0);
    expect(json(supported.stdout).findings).toBe(1);
    expect(cso(repo, ['finish', run]).status).toBe(0);
  });
});
