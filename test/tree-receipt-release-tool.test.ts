/**
 * GST-1176 (HARN-7, harness-evals): a release_tool that renders content, not just the version, writes release
 * outputs whose hunks are more than version rewrites. The tree receipt classified them `changed`, so a stamp
 * over an unstamped merge was never same-modulo-stamps. With --allow-repo-commands the receipt accepts a release
 * output whose bytes equal release_tool's rerun on the current head at its version, the Version Gate's rule.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPolicyFromHead } from '../lib/ship-policy';
import { stampMismatch } from '../lib/ship-queue-train-stamp';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const FOLD = "const fs=require('fs');const v=fs.readFileSync('VERSION','utf8').trim();const items=fs.readdirSync('todos.d').filter(f=>f.endsWith('.md')).sort().map(f=>fs.readFileSync('todos.d/'+f,'utf8'));fs.writeFileSync('TODOS.md','# TODOS v'+v+'\\n'+items.join(''));\n";
const POLICY = { ...BASE_POLICY, release_tool: 'node fold.js', release_outputs: ['TODOS.md'] };

/** HARN-7's shape: M is the unstamped merge of a PR that adds only a todos.d/ file; S stamps it with the tool's output. */
function harn7(): { repo: FixtureRepo; merged: string; stamped: string } {
  const repo = makeFixtureRepo({ prefix: 'tree-receipt-release-tool-', policy: POLICY });
  repos.push(repo);
  const fold = () => expect(spawnSync('node', ['fold.js'], { cwd: repo.work, timeout: 30_000 }).status).toBe(0);
  fs.mkdirSync(path.join(repo.work, 'todos.d'));
  fs.writeFileSync(path.join(repo.work, 'fold.js'), FOLD);
  fs.writeFileSync(path.join(repo.work, 'todos.d', 'base.md'), '- base todo\n');
  fold();
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'todos fold');
  fs.writeFileSync(path.join(repo.work, 'todos.d', 'new.md'), '- new todo\n');
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'merge: a PR that adds only a todos.d file');
  const merged = repo.git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
  fold();
  repo.git('commit', '-qam', 'stamp 1.2.4.0');
  return { repo, merged, stamped: repo.git('rev-parse', 'HEAD') };
}

const receipt = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-tree-receipt', ['--base', 'main', ...args]);

describe('tree receipt: a release output release_tool regenerates (GST-1176)', () => {
  test('a rendered release output is a stamp when release_tool reruns to the same bytes, and only with --allow-repo-commands', () => {
    const { repo, merged, stamped } = harn7();
    expect(repo.git('show', `${stamped}:TODOS.md`)).toBe('# TODOS v1.2.4.0\n- base todo\n- new todo');
    expect(receipt(repo, ['--gated', merged, '--current', stamped]).out).toMatch(/^TREE: changed \(TODOS\.md\)$/m);
    const r = receipt(repo, ['--gated', merged, '--current', stamped, '--allow-repo-commands']);
    expect(r.out).toMatch(/^  stamp   VERSION \(version-file\)$/m);
    expect(r.out).toMatch(/^  stamp   TODOS\.md \(release_tool\)$/m);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
  });

  test('a release output the tool would not write stays changed, with the regeneration named', () => {
    const { repo, merged } = harn7();
    fs.appendFileSync(path.join(repo.work, 'TODOS.md'), '- a hand-written line\n');
    repo.git('commit', '-qam', 'hand edit');
    const j = JSON.parse(receipt(repo, ['--gated', merged, '--current', 'HEAD', '--allow-repo-commands', '--json']).out);
    expect(j.tree).toBe('changed');
    const todos = j.files.find((f: { path: string }) => f.path === 'TODOS.md');
    expect(todos).toMatchObject({ verdict: 'changed', rule: 'release_outputs' });
    expect(todos.residual).toContain('release_tool');
  });

  test('a stamped train prefix over the merge passes stampMismatch only when the train runs repo commands', () => {
    const { repo, merged, stamped } = harn7();
    const opts = { repoRoot: repo.work, base: 'main', policy: loadPolicyFromHead(repo.work).policy, policyLabel: 'head', baseSha: merged, slots: [], plain: [], now: new Date() };
    const plainTree = repo.git('rev-parse', `${merged}^{tree}`);
    expect(stampMismatch({ ...opts, allowRepoCommands: true }, merged, stamped, plainTree)).toBeNull();
    expect(stampMismatch({ ...opts, allowRepoCommands: false }, merged, stamped, plainTree)).toContain('TODOS.md');
  });
});
