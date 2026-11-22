/**
 * The daemon's project slug names the per-project domain-skill bucket. An
 * install without ~/.claude/skills/gstack (Codex, repo-local, other hosts)
 * used to fall back to one shared "unknown" bucket for every project.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODULE = path.resolve(import.meta.dir, '../src/project-slug.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-project-slug-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function slugIn(cwd: string, extra: Record<string, string> = {}): string {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: path.join(root, 'home'), GSTACK_STATE_ROOT: path.join(root, 'state') };
  delete env.GSTACK_PROJECT_SLUG;
  delete env.GSTACK_HOME;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, ['-e', `import { getCurrentProjectSlug } from ${JSON.stringify(MODULE)}; console.log(getCurrentProjectSlug());`], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  return (r.stdout ?? '').trim();
}

describe('getCurrentProjectSlug', () => {
  test('a repository resolves to its remote slug with no ~/.claude install', () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 30_000 });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: repo, timeout: 30_000 });
    expect(slugIn(repo)).toBe('acme-widgets');
  });

  test('two projects never share a bucket', () => {
    const a = path.join(root, 'alpha');
    const b = path.join(root, 'beta');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const sa = slugIn(a);
    const sb = slugIn(b);
    expect(sa).not.toBe('unknown');
    expect(sa).not.toBe(sb);
  });

  test('GSTACK_PROJECT_SLUG wins', () => {
    expect(slugIn(root, { GSTACK_PROJECT_SLUG: 'pinned' })).toBe('pinned');
  });
});
