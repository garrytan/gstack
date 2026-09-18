/**
 * Branch-name slug hygiene in file-path positions (#2550, #1851/#1127).
 *
 * gstack-review-log WRITES `<canonical-branch>-reviews.jsonl` where the
 * canonical form comes from bin/gstack-slug (tr '/' '-' then
 * tr -cd 'a-zA-Z0-9._-'). Context Recovery used to PROBE the same file with
 * raw $_BRANCH (`git branch --show-current`) — so for any branch containing
 * a `/` (most feature branches) the REVIEWS line never fired. Same class:
 * review.ts's plan content-search sanitized with tr '/' '-' only, missing
 * the tr -cd half of the canonical pipeline.
 *
 * Discipline pinned here:
 *   - FILE-PATH positions interpolate the slug-canonical $BRANCH (set by the
 *     gstack-slug eval that opens Context Recovery).
 *   - Raw $_BRANCH stays for display (BRANCH: echo) and for timeline.jsonl
 *     content greps — the timeline writer stores the RAW branch, so slugging
 *     the reader would break that pairing.
 *
 * Reader-side fix folded from community PR #1851 by @harjothkhara.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync, execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateContextRecovery } from '../scripts/resolvers/preamble/generate-context-recovery';
import { ALL_HOST_CONFIGS } from '../hosts';
import { discoverSkillFiles } from '../scripts/discover-skills';

const ROOT = path.join(import.meta.dir, '..');

// Raw $_BRANCH (either spelling) immediately before/after a path separator.
const PATH_ADJACENT = /\/\$\{?_BRANCH|\$\{_BRANCH\}\/|\$_BRANCH\//;
// Raw $_BRANCH as a filename prefix (…-reviews.jsonl and friends).
const FILENAME_PREFIX = /\$\{?_BRANCH\}?[A-Za-z0-9._-]*\.(?:jsonl|json|md|txt|log)/;

function renderedSkillFiles(root = ROOT): string[] {
  // Repository files, including new outputs, exclude ignored workspaces/archives.
  const files = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'SKILL.md', '**/SKILL.md', '**/sections/*.md',
  ], { cwd: root, encoding: 'utf-8', timeout: 30_000 })
    .split('\0').filter(Boolean).map(file => path.join(root, file));
  // Host outputs are deliberately gitignored; inspect only their registered roots.
  for (const host of ALL_HOST_CONFIGS.filter(host => host.name !== 'claude')) {
    const hostRoot = path.join(root, host.hostSubdir);
    const skillsRoot = path.join(hostRoot, 'skills');
    if (!fs.existsSync(skillsRoot) || fs.lstatSync(hostRoot).isSymbolicLink()
      || fs.lstatSync(skillsRoot).isSymbolicLink()) continue;
    files.push(...discoverSkillFiles(skillsRoot).map(file => path.join(skillsRoot, file)));
  }
  return [...new Set(files)];
}

describe('branch slug hygiene (#2550, #1851)', () => {
  test('inventory covers repository outputs and host caches without ignored candidate trees', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill inventory-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, timeout: 30_000 });
      const write = (file: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        fs.writeFileSync(path.join(repo, file), '# Skill\n');
      };
      const source = ['SKILL.md', 'health/SKILL.md', 'health/sections/checks.md'];
      const hosts = ALL_HOST_CONFIGS.filter(host => host.name !== 'claude');
      fs.writeFileSync(path.join(repo, '.gitignore'),
        ['.context/', 'node_modules/', ...hosts.map(host => `${host.hostSubdir}/`)].join('\n'));
      source.forEach(write);
      execFileSync('git', ['add', '--', ...source], { cwd: repo, timeout: 30_000 });
      source.push('new skill/SKILL.md');
      write(source.at(-1)!); // New, untracked output must still be checked.
      write('.context/candidate/SKILL.md');
      write('.context/candidate/health/sections/checks.md');
      write('node_modules/other/SKILL.md');
      expect(renderedSkillFiles(repo).sort())
        .toEqual(source.map(file => path.join(repo, file)).sort());
      const caches = hosts.map(host => `${host.hostSubdir}/skills/gstack-health/SKILL.md`);
      caches.forEach(write);
      expect(renderedSkillFiles(repo).sort())
        .toEqual([...source, ...caches].map(file => path.join(repo, file)).sort());
      // Old find never followed host or skills directory symlinks into another tree.
      write('.context/outside/skills/gstack-foreign/SKILL.md');
      for (const [index, host] of hosts.slice(0, 2).entries()) {
        const link = path.join(repo, host.hostSubdir, index ? 'skills' : '');
        fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(path.join(repo, '.context/outside', index ? 'skills' : ''), link, 'junction');
      }
      expect(renderedSkillFiles(repo).sort())
        .toEqual([...source, ...caches.slice(2)].map(file => path.join(repo, file)).sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('no generated SKILL.md or section interpolates raw $_BRANCH in a path position', () => {
    const offenders: string[] = [];
    for (const file of renderedSkillFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      if (PATH_ADJACENT.test(content) || FILENAME_PREFIX.test(content)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('Context Recovery probes reviews.jsonl with the slug-canonical $BRANCH', () => {
    const ctx: TemplateContext = {
      skillName: 'test-skill',
      tmplPath: 'test.tmpl',
      host: 'claude',
      paths: HOST_PATHS.claude,
      preambleTier: 2,
    };
    const out = generateContextRecovery(ctx);
    expect(out).toContain('${BRANCH:-unknown}-reviews.jsonl');
    expect(out).not.toContain('${_BRANCH}-reviews.jsonl');
    // The gstack-slug eval that defines $BRANCH must render BEFORE the probe.
    const evalIdx = out.indexOf('gstack-slug');
    const probeIdx = out.indexOf('${BRANCH:-unknown}-reviews.jsonl');
    expect(evalIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeLessThan(probeIdx);
    // Raw $_BRANCH stays for the timeline.jsonl content greps (writer stores raw).
    expect(out).toContain('"branch\\":\\"${_BRANCH}');
  });

  test('plan content-search BRANCH uses the full gstack-slug canonical pipeline', () => {
    const rendered = fs.readFileSync(
      path.join(ROOT, 'ship', 'sections', 'plan-completion.md'),
      'utf-8',
    );
    expect(rendered).toContain(
      `BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-' | tr -cd 'a-zA-Z0-9._-')`,
    );
  });

  test('live round-trip: Context Recovery finds slugged reviews and raw timeline branches in a fresh shell', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-repo-'));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      execSync(
        'git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feat/slug-hygiene',
        { cwd: repo, encoding: 'utf-8', timeout: 30_000 },
      );

      // Writer: the real gstack-review-log (canonicalizes via gstack-slug).
      execSync(
        `"${path.join(ROOT, 'bin', 'gstack-review-log')}" '{"skill":"ship","status":"ok"}'`,
        { cwd: repo, env, encoding: 'utf-8', timeout: 30_000 },
      );

      // The slug-canonical filename must exist; the raw form must not.
      const slugVars = execSync(`"${path.join(ROOT, 'bin', 'gstack-slug')}"`, {
        cwd: repo, env, encoding: 'utf-8', timeout: 30_000,
      });
      const slug = slugVars.match(/^SLUG=(.*)$/m)![1];
      const branch = slugVars.match(/^BRANCH=(.*)$/m)![1];
      expect(branch).toBe('feat-slug-hygiene');
      const proj = path.join(home, 'projects', slug);
      expect(fs.existsSync(path.join(proj, 'feat-slug-hygiene-reviews.jsonl'))).toBe(true);

      // Reader: execute the complete rendered block without inheriting the
      // external skill-start process's private shell variables.
      const ctx: TemplateContext = {
        skillName: 'test-skill', tmplPath: 'test.tmpl', host: 'claude',
        paths: { ...HOST_PATHS.claude, binDir: '"$TEST_BIN"' }, preambleTier: 2,
      };
      const script = generateContextRecovery(ctx).match(/```bash\n([\s\S]*?)\n```/)![1];
      fs.writeFileSync(path.join(proj, 'timeline.jsonl'), [
        { branch: 'feat/slug-hygiene', event: 'completed', skill: 'review' },
        { branch: 'feat/slug-hygiene', event: 'started', skill: 'unfinished' },
        { branch, event: 'completed', skill: 'slugged-decoy' },
        { branch: 'stale/parent-branch', event: 'completed', skill: 'inherited-decoy' },
        { branch: 'unknown', event: 'completed', skill: 'fallback' },
        { branch: 'feat/slug-hygiene', event: 'completed', skill: 'ship' },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const recover = (cwd: string, inheritedBranch?: string) => {
        const result = spawnSync('bash', ['-c', script], {
          cwd, encoding: 'utf8', timeout: 30_000,
          env: { ...env, GSTACK_PROJECT_SLUG: slug, TEST_BIN: path.join(ROOT, 'bin'), _BRANCH: inheritedBranch },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain('not a git repository');
        return result.stdout;
      };
      for (const inheritedBranch of [undefined, 'stale/parent-branch']) {
        const out = recover(repo, inheritedBranch);
        expect(out).toContain('REVIEWS: 1 entries');
        expect(out.split('\n').filter(line => line.startsWith('LAST_SESSION:'))).toEqual([
          'LAST_SESSION: {"branch":"feat/slug-hygiene","event":"completed","skill":"ship"}',
        ]);
        expect(out.split('\n').filter(line => line.startsWith('RECENT_PATTERN:'))).toEqual([
          'RECENT_PATTERN: review,ship,',
        ]);
      }

      // Negative control: the raw-branch probe (the pre-fix shape) misses.
      expect(fs.existsSync(path.join(proj, 'feat/slug-hygiene-reviews.jsonl'))).toBe(false);

      // Both an unnamed checkout and a non-repository use the same unknown
      // timeline identity as skill-start/end, never an inherited branch.
      execSync('git checkout -q --detach', { cwd: repo, timeout: 30_000 });
      for (const cwd of [repo, home]) {
        const out = recover(cwd, 'stale/parent-branch');
        expect(out.split('\n').filter(line => line.startsWith('LAST_SESSION:'))).toEqual([
          'LAST_SESSION: {"branch":"unknown","event":"completed","skill":"fallback"}',
        ]);
        expect(out.split('\n').filter(line => line.startsWith('RECENT_PATTERN:'))).toEqual([
          'RECENT_PATTERN: fallback,',
        ]);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
