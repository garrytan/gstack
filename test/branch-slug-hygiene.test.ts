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
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateContextRecovery } from '../scripts/resolvers/preamble/generate-context-recovery';

const ROOT = path.join(import.meta.dir, '..');

// Raw $_BRANCH (either spelling) immediately before/after a path separator.
const PATH_ADJACENT = /\/\$\{?_BRANCH|\$\{_BRANCH\}\/|\$_BRANCH\//;
// Raw $_BRANCH as a filename prefix (…-reviews.jsonl and friends).
const FILENAME_PREFIX = /\$\{?_BRANCH\}?[A-Za-z0-9._-]*\.(?:jsonl|json|md|txt|log)/;

function renderedSkillFiles(root = ROOT): string[] {
  // Enumerate managed render trees without buffering a shell's file census.
  // .context holds archived/experimental copies, not shipped skill output.
  const excluded = new Set(['node_modules', '.claude', '.context', '.git']);
  const files: string[] = [];
  function visit(dir: string, inSections = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(file, inSections || entry.name === 'sections');
      } else if (entry.name === 'SKILL.md' || (inSections && entry.name.endsWith('.md'))) {
        files.push(file);
      }
    }
  }
  visit(root);
  return files;
}

describe('branch slug hygiene (#2550, #1851)', () => {
  test('render discovery excludes scratch copies and retains every managed host without a pipe-size limit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-census-'));
    const add = (relative: string) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Render fixture\n');
      return file;
    };
    try {
      const expected = [
        add('review/SKILL.md'), add('review/sections/analysis.md'),
        add('.agents/skills/gstack-review/SKILL.md'),
        add('.kiro/skills/gstack-review/sections/nested/analysis.md'),
        add('skill with $quotes/sections/line\nbreak.md'),
      ];
      for (const excluded of ['.context', '.claude', '.git', 'node_modules']) {
        add(`${excluded}/old-render/review/SKILL.md`);
        add(`${excluded}/old-render/review/sections/analysis.md`);
      }
      // The old execSync census failed at its 1 MiB stdout default once
      // enough isolated host renders existed in a workspace.
      for (let i = 0; i < 4500; i++) {
        expected.push(add(`host-output/skill-${i}-${'x'.repeat(210)}/SKILL.md`));
      }
      expect(Buffer.byteLength(expected.join('\n'))).toBeGreaterThan(1024 * 1024);
      const actual = renderedSkillFiles(root);
      const expectedSet = new Set(expected);
      expect(actual).toHaveLength(expected.length);
      expect(new Set(actual).size).toBe(expected.length);
      expect(actual.every(file => expectedSet.has(file))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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

  test('live round-trip: gstack-review-log writes, Context Recovery probe finds it (slash branch)', () => {
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

      // Reader: execute the rendered probe line with $BRANCH from gstack-slug.
      const ctx: TemplateContext = {
        skillName: 'test-skill', tmplPath: 'test.tmpl', host: 'claude',
        paths: HOST_PATHS.claude, preambleTier: 2,
      };
      const probeLine = generateContextRecovery(ctx)
        .split('\n')
        .find((l) => l.includes('-reviews.jsonl'))!;
      const script = `_PROJ="${proj}"\nBRANCH="${branch}"\n${probeLine.trim()}`;
      const out = execSync(`bash -c '${script.replace(/'/g, `'\\''`)}'`, {
        cwd: repo, encoding: 'utf-8', timeout: 30_000,
      });
      expect(out).toContain('REVIEWS: 1 entries');

      // Negative control: the raw-branch probe (the pre-fix shape) misses.
      expect(fs.existsSync(path.join(proj, 'feat/slug-hygiene-reviews.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
