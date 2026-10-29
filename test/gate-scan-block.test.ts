/**
 * The shared gate-scan block, run: the parent gets the GATE_SUMMARY line and one index
 * line per read-level hunk, never the hunk text (the reviewer packets and the diff carry
 * that; the artifact holds the full listing). The fixture repository lives under the OS
 * temp directory, outside this checkout, and every seed commit is asserted.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateGateScanBlock } from '../scripts/resolvers/gate-scan';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between } from './helpers/prompt-structure';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

test('the block prints the summary and the hunk index; the hunk text stays out of the parent', () => {
  const dir = tmp('gate-scan-block-');
  expect(path.relative(ROOT, dir).startsWith('..')).toBe(true);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  const write = (text: string) => { fs.mkdirSync(path.join(dir, 'test'), { recursive: true }); fs.writeFileSync(path.join(dir, 'test', 'a.test.ts'), text); };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  write("test('a', () => {\n  expect(HUNK_BODY_MARKER).toBe(1);\n  expect(2).toBe(2);\n});\n");
  git('add', '.');
  expect(git('commit', '-qm', 'base').status).toBe(0);
  git('checkout', '-qb', 'feat');
  write("test.skip('a', () => {\n  expect(2).toBe(2);\n});\n");
  git('add', '.');
  expect(git('commit', '-qm', 'feat').status).toBe(0);

  const ctx: TemplateContext = { skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude };
  const bash = between(generateGateScanBlock(ctx), '```bash', '\n```').slice('```bash'.length).replaceAll(HOST_PATHS.claude.binDir, path.join(ROOT, 'bin')).replaceAll('<base>', 'main');
  const r = spawnSync('bash', ['-ec', bash], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: tmp('gate-scan-state-') } });
  expect(r.status).toBe(0);
  const out = r.stdout.trimEnd().split('\n');
  expect(out[0]).toMatch(/^GATE_SUMMARY: listed=\d+ eligible=[1-9]/);
  expect(out.slice(1).length).toBeGreaterThan(0);
  for (const l of out.slice(1)) expect(l).toMatch(/^\[[^\]]+\] \S+ test\/a\.test\.ts @@/);
  expect(r.stdout).not.toContain('HUNK_BODY_MARKER');
  expect(r.stdout).not.toContain('citation:');
  const artifact = /artifact=(\S+)/.exec(out[0]!)![1]!;
  expect(fs.readFileSync(artifact, 'utf8')).toContain('HUNK_BODY_MARKER');
});
