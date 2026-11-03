import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { RESOLVERS } from '../scripts/resolvers';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const BIN = path.resolve(import.meta.dir, '../bin');
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-report-dir-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const IDENTITY = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };

function product() {
  const root = fs.mkdtempSync(path.join(ROOT, 'product-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...IDENTITY } });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const x = 1;\n');
  git('add', 'app.ts');
  git('commit', '-q', '-m', 'seed');
  const tool = (name: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(BIN, name), ...args], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(r.error, r.error?.message).toBeUndefined();
    return r;
  };
  const tree = () => git('status', '--porcelain', '--untracked-files=all', '--ignored=no') + git('ls-files', '--others', '--exclude-standard');
  return { root, tool, tree };
}

function reportDir(f: ReturnType<typeof product>): string {
  const r = f.tool('gstack-qa-evidence', 'report-dir');
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().slice('QA_EVIDENCE '.length)).reportDir;
}

test('the /ship QA report root leaves a product tree without a .gstack ignore rule unchanged', () => {
  const f = product();
  expect(f.tree()).toBe('');
  const dir = reportDir(f);
  expect(path.relative(f.root, dir).split(path.sep).slice(0, 3)).toEqual(['.gstack', 'tmp', 'qa-reports']);
  const deadline = path.join(dir, 'deadline.json');
  expect(f.tool('gstack-qa-deadline', 'start', deadline, '300').status).toBe(0);
  const capture = f.tool('gstack-qa-evidence', 'capture', dir, '001', '--public', '--deadline', deadline, '--', process.execPath, '-e', 'console.log(JSON.stringify({ ok: true }))');
  expect(capture.status, capture.stderr).toBe(0);
  fs.writeFileSync(path.join(dir, 'report.md'), '## Exploratory QA\n');
  expect(f.tree()).toBe('');
});

test('each report-dir call owns a fresh run so a second QA run never overwrites the first', () => {
  const f = product();
  const first = reportDir(f);
  const second = reportDir(f);
  expect(second).not.toBe(first);
  expect(fs.readdirSync(first)).toEqual([]);
  expect(fs.readdirSync(second)).toEqual([]);
});

test('report-dir refuses a linked .gstack instead of creating directories through it', () => {
  const f = product();
  const elsewhere = fs.mkdtempSync(path.join(ROOT, 'elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(f.root, '.gstack'));
  const r = f.tool('gstack-qa-evidence', 'report-dir');
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('report-dir refuses the linked .gstack');
  expect(fs.readdirSync(elsewhere)).toEqual([]);
});

test('report-dir refuses when a product .gitignore un-ignores .gstack/tmp', () => {
  const f = product();
  fs.writeFileSync(path.join(f.root, '.gitignore'), '!/.gstack/tmp/\n!/.gstack/tmp/**\n');
  const r = f.tool('gstack-qa-evidence', 'report-dir');
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('.gstack/tmp is not git-ignored here');
});

test('report-dir names the filesystem cause when .gstack is not a directory', () => {
  const f = product();
  fs.writeFileSync(path.join(f.root, '.gstack'), 'not a directory\n');
  const r = f.tool('gstack-qa-evidence', 'report-dir');
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(process.platform === 'win32' ? /report-dir failed: (ENOTDIR|ENOENT)/ : /report-dir failed: ENOTDIR/);
});

test('report-dir refuses outside a git work tree instead of guessing a location', () => {
  const outside = fs.mkdtempSync(path.join(ROOT, 'plain-'));
  const r = spawnSync(process.execPath, [path.join(BIN, 'gstack-qa-evidence'), 'report-dir'], { cwd: outside, encoding: 'utf8', timeout: 15_000, env: { ...process.env, GIT_CEILING_DIRECTORIES: ROOT } });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('report-dir needs a git work tree');
  expect(fs.readdirSync(outside)).toEqual([]);
});

test('caller QA without a resolved REPORT_DIR (/review, /ship) falls back to report-dir, not the product tree', () => {
  const line = 'Reuse resolved REPORT_DIR; otherwise use the `reportDir` `EVIDENCE_TOOL report-dir` prints.';
  const ctx: TemplateContext = { host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude };
  expect(RESOLVERS.QA_EXPLORATORY(ctx)).toContain(line);
  expect(fs.readFileSync(path.resolve(import.meta.dir, '../qa/sections/exploratory.md'), 'utf8')).toContain(line);
  expect(fs.readFileSync(path.resolve(import.meta.dir, '../qa/SKILL.md.tmpl'), 'utf8')).toContain('Use the directory as `REPORT_DIR`');
});
