/**
 * The build receipt end to end in a real browser (browser tier): the preview
 * template serves a page whose rows come from the fixture API, the real
 * gstack-design-lint measures two scenarios through the exact command
 * gstack-design-build plan prints, and the receipt reads the lint's JSON and
 * the preview's record. One scenario's page swallows a 501 and still renders
 * its section clean; the receipt must still call that state incomplete.
 * Runs whenever a browser is available, except in CI, where a missing browser
 * fails.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { browserAvailable, NO_BROWSER_REASON } from './helpers/browser-available';
import { runPreview, startPreview, type Preview } from './helpers/preview-template';

const ROOT = path.resolve(import.meta.dir, '..');
const hasBrowser = browserAvailable();
if (!hasBrowser && process.env.CI) throw new Error('design-build-e2e: CI needs a browser for the build receipt tier: ' + NO_BROWSER_REASON);
const tmp: string[] = [];
const live: Preview[] = [];
afterAll(() => { for (const p of live) p.proc.kill(); for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
const env = { ...process.env, PATH: path.join(ROOT, 'bin') + path.delimiter + process.env.PATH };

describe.skipIf(!hasBrowser)('build receipt through the real lint (T26, T2, T3, T12, T36)', () => {
  test('a caught 501 behind a clean, measured section is still incomplete; the other scenario is linted with its expect recorded', async () => {
    const repo = tmpDir('design-build-e2e-');
    execFileSync('git', ['-C', repo, 'init', '-q'], { timeout: 30_000 });
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'ui-spacing', 'preview'), path.join(repo, 'preview'), { recursive: true });
    execFileSync('git', ['-C', repo, 'add', '-A'], { timeout: 30_000 });
    execFileSync('git', ['-C', repo, '-c', 'user.name=gstack test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed'], { timeout: 30_000 });
    const state = tmpDir('design-build-e2e-pv-');
    const p = await startPreview(['--static', '--root', path.join(repo, 'preview'), '--fixtures', path.join(repo, 'preview', 'fixtures'), '--port', '0', '--state', state]);
    live.push(p);
    const work = tmpDir('design-build-e2e-run-');
    const inv = path.join(work, 'inventory.json');
    fs.writeFileSync(inv, JSON.stringify({ version: 1, within: 'section.access', fixtures: 'preview/fixtures', states: [
      { name: 'owner', url: p.url + '?as=owner', expect: '.rows .row' },
      { name: 'lastowner', url: p.url + '?as=lastowner', expect: '.rows .row' },
    ] }));
    const runDir = path.join(work, 'run');
    const sh = (args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-design-build'), args, { cwd: repo, encoding: 'utf8', env, timeout: 60_000 });
    expect(sh(['preflight', '--inventory', inv]).stdout).toMatch(/^PREFLIGHT: ok engine=\S+ states=2 targets=loopback mutations=fixtures-only$/m);
    const planned = sh(['plan', '--inventory', inv, '--run-dir', runDir]).stdout;
    expect(sh(['verify-start', '--inventory', inv, '--run-dir', runDir]).status).toBe(0);
    const lintCmd = /^LINT_CMD: (.*)$/m.exec(planned)![1]!;
    const lanePath = (process.env.PATH ?? '').split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'gstack-design-lint'))).join(path.delimiter);
    spawnSync('bash', ['-c', lintCmd], { cwd: repo, env: { ...process.env, PATH: lanePath }, timeout: 180_000 });
    const lint = JSON.parse(fs.readFileSync(path.join(runDir, 'lint.json'), 'utf8'));
    expect(lint.app.verdict).toBe('clean');
    expect(lint.app.states.map((s: { name: string; viewport: string; status: string }) => [s.name, s.viewport, s.status])).toEqual([
      ['owner', '1440x900', 'measured'], ['owner', '375x812', 'measured'], ['lastowner', '1440x900', 'measured'], ['lastowner', '375x812', 'measured'],
    ]);
    const log = fs.readFileSync(path.join(state, 'preview.log'), 'utf8');
    expect(log).toContain('GET /api/members 200 scenario=lastowner');
    expect(log).toContain('GET /api/audit 501 PREVIEW_UNHANDLED scenario=lastowner');
    for (const m of planned.matchAll(/^SHOT: \S+ \S+ \S+ -> (\S+)$/gm)) fs.writeFileSync(m[1]!, 'png');
    const r = sh(['receipt', '--inventory', inv, '--run-dir', runDir, '--rounds', '1', '--preview', state, '--out-root', path.join(work, 'out')]);
    expect(r.status).toBe(4);
    expect(r.stdout).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED linted=2/2 shot=2/2');
    expect(r.stdout).toContain('lastowner: GET /api/audit (scenario lastowner)');
    const rec = JSON.parse(fs.readFileSync(/receipt=(\S+)/.exec(r.stdout)![1]!, 'utf8'));
    expect(rec.states.map((s: { name: string; linted: boolean; expect: unknown; unhandled: unknown[] }) => [s.name, s.linted, s.expect, s.unhandled.length])).toEqual([
      ['owner', true, { selector: '.rows .row', passed: true }, 0],
      ['lastowner', true, { selector: '.rows .row', passed: true }, 1],
    ]);
    expect(runPreview(['stop', '--state', state]).code).toBe(0);
  }, 240_000);
});
