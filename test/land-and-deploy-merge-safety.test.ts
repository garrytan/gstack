import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runGeneration, type GenerationResult } from '../scripts/gen-skill-docs';
import { includesSkill } from '../scripts/discover-skills';
import { ALL_HOST_NAMES, getHostConfig } from '../hosts/index';

// #4770: /land-and-deploy armed GitHub auto-merge (a stopped run left a live
// request that could merge later with nobody watching) and always passed
// --delete-branch, which on a main-to-production promotion asks GitHub to delete
// main. Every host's rendered skill must merge directly and delete the head
// branch only behind the default-branch, main and open-base checks.
const root = join(import.meta.dir, '..');
const base = mkdtempSync(join(tmpdir(), 'land-merge-safety-'));
const render = join(base, 'render');
let generated: GenerationResult;
let hosts: Array<{ host: string; paths: string[]; text: string }> = [];

beforeAll(async () => {
  generated = await runGeneration({ host: 'all', outputRoot: render, contentLinkRoot: null });
  expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
  const rendered = generated.artifacts.filter(a => a.host && (a.kind === 'skill' || a.kind === 'section') && /(^|\/)(gstack-)?land-and-deploy\//.test(a.relativePath));
  hosts = [...new Set(rendered.map(a => a.host!))].map(host => {
    const paths = rendered.filter(a => a.host === host).map(a => a.relativePath).sort();
    return { host, paths, text: paths.map(file => readFileSync(join(render, file), 'utf8')).join('\n') };
  });
}, 180_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

const bashBlocks = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(m => m[1]);

describe('land-and-deploy merge safety on every host (#4770)', () => {
  test('every host that ships the skill renders its merge step', () => {
    const shipping = ALL_HOST_NAMES.filter(host => includesSkill(getHostConfig(host), 'land-and-deploy'));
    expect(shipping.length).toBeGreaterThan(1);
    expect(hosts.map(h => h.host).sort()).toEqual([...shipping].sort());
    for (const h of hosts) expect(h.text, h.host).toContain('## Step 4: Merge the PR');
  });

  test('no rendered file asks GitHub for auto-merge', () => {
    const hits = hosts.flatMap(h => h.text.split('\n').filter(line => /--auto(?![\w-])/.test(line)).map(line => `${h.host}: ${line}`));
    expect(hits).toEqual([]);
  });

  test('--delete-branch appears only as the guarded DELETE_FLAG assignment', () => {
    for (const h of hosts) {
      const lines = h.text.split('\n').filter(line => line.includes('--delete-branch'));
      expect(lines.map(line => line.trim()), h.host).toEqual(['DELETE_FLAG=--delete-branch']);
      const guard = bashBlocks(h.text).find(block => block.includes('DELETE_FLAG=--delete-branch'));
      expect(guard, h.host).toBeDefined();
      const condition = guard!.slice(0, guard!.indexOf('DELETE_FLAG=--delete-branch'));
      for (const check of ['"$HEAD_REPO" = "$REPO"', '"$HEAD_BRANCH" != "$DEFAULT_BRANCH"', '"$HEAD_BRANCH" != main', '"$OPEN_BASES" = 0']) {
        expect(condition, `${h.host}: ${check}`).toContain(check);
      }
      const merges = h.text.split('\n').filter(line => line.includes('gh pr merge "$MERGE_FLAG"'));
      expect(merges, h.host).toHaveLength(1);
      expect(merges[0]).toContain('${DELETE_FLAG:+"$DELETE_FLAG"}');
      expect(merges[0]).toContain('--match-head-commit "$PR_HEAD"');
    }
  });
});

describe('head-branch deletion guard decides from live PR data', () => {
  const template = readFileSync(join(root, 'land-and-deploy', 'sections', 'merge-and-deploy.md.tmpl'), 'utf8');
  const guard = bashBlocks(template).find(block => block.startsWith('DELETE_FLAG=\n'));
  const run = (env: Record<string, string>) => {
    expect(guard).toBeDefined();
    const fake = [
      'gh() {',
      '  case "$1 $2" in',
      '    "pr view") [ "$FAIL" = view ] && return 1; printf "%s\\t%s\\n" "$T_HEAD_REPO" "$T_HEAD_BRANCH" ;;',
      '    "api repos/owner/project") [ "$FAIL" = api ] && return 1; printf "%s\\n" "$T_DEFAULT" ;;',
      '    "pr list") [ "$FAIL" = list ] && return 1; printf "%s\\n" "$T_OPEN" ;;',
      '    *) return 99 ;;',
      '  esac',
      '}',
    ].join('\n');
    const result = spawnSync('bash', ['-c', `${fake}\n${guard}`], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, REPO: 'owner/project', PR_NUMBER: '42', T_HEAD_REPO: 'owner/project', T_HEAD_BRANCH: 'feature', T_DEFAULT: 'main', T_OPEN: '0', ...env },
    });
    return result.stdout.trim().split('\n').at(-1);
  };

  test('a feature branch no open PR targets is deleted', () => {
    expect(run({})).toBe('DELETE_FLAG=--delete-branch owner/project feature');
  });

  for (const [name, env] of [
    ['main promoted to production', { T_HEAD_BRANCH: 'main', T_DEFAULT: 'trunk' }],
    ['the default branch', { T_HEAD_BRANCH: 'develop', T_DEFAULT: 'develop' }],
    ['a branch another open PR targets', { T_OPEN: '1' }],
    ['a fork branch', { T_HEAD_REPO: 'someone/project' }],
    ['a failed PR lookup', { FAIL: 'view' }],
    ['a failed default-branch lookup', { FAIL: 'api' }],
    ['a failed open-PR lookup', { FAIL: 'list' }],
  ] as const) {
    test(`${name} is kept`, () => {
      expect(run(env)).toStartWith('DELETE_FLAG=none');
    });
  }
});
