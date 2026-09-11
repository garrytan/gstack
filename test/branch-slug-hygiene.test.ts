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
import { ledgerCandidates, readJsonlUnion, resolveProjectIdentity } from '../lib/project-identity';

const ROOT = path.join(import.meta.dir, '..');

// Raw $_BRANCH (either spelling) immediately before/after a path separator.
const PATH_ADJACENT = /\/\$\{?_BRANCH|\$\{_BRANCH\}\/|\$_BRANCH\//;
// Raw $_BRANCH as a filename prefix (…-reviews.jsonl and friends).
const FILENAME_PREFIX = /\$\{?_BRANCH\}?[A-Za-z0-9._-]*\.(?:jsonl|json|md|txt|log)/;

function renderedSkillFiles(): string[] {
  const out = execSync(
    `find "${ROOT}" -name 'SKILL.md' -not -path '*/node_modules/*' -not -path '*/.claude/*' ; find "${ROOT}" -path '*/sections/*.md' -not -path '*/node_modules/*' -not -path '*/.claude/*'`,
    { encoding: 'utf-8', timeout: 30_000 },
  );
  return out.split('\n').filter(Boolean);
}

describe('branch slug hygiene (#2550, #1851)', () => {
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

  test('Context Recovery reads ledgers through canonical identity adapters', () => {
    const ctx: TemplateContext = {
      skillName: 'test-skill',
      tmplPath: 'test.tmpl',
      host: 'claude',
      paths: HOST_PATHS.claude,
      preambleTier: 2,
    };
    const out = generateContextRecovery(ctx);
    expect(out).toContain('gstack-review-read');
    expect(out).toContain('gstack-timeline-read --limit 5 --branch "$_BRANCH"');
    expect(out).not.toContain('-reviews.jsonl');
    expect(out).not.toContain('grep "\\"branch');
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

  test('live round-trip: canonical ledger identity and reader agree for a slash branch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-repo-'));
    try {
      const env = { ...process.env, GSTACK_HOME: home };
      execSync(
        'git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feat/slug-hygiene',
        { cwd: repo, encoding: 'utf-8', timeout: 30_000 },
      );

      // Resolve the same canonical identity used by the installed writer and
      // reader adapters. The checkout wrappers themselves require an installed
      // authority manifest, so this unit test exercises their shared library.
      const identity = resolveProjectIdentity(repo);
      const slugVars = execSync(`"${path.join(ROOT, 'bin', 'gstack-slug')}"`, {
        cwd: repo, env, encoding: 'utf-8', timeout: 30_000,
      });
      const legacySlug = slugVars.match(/^SLUG=(.*)$/m)![1];
      const legacyBranch = slugVars.match(/^BRANCH=(.*)$/m)![1];
      const identitySlug = identity.write_slug;
      const identityBranch = identity.write_branch;
      const projectDir = path.join(home, 'projects', identitySlug);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${identityBranch}-reviews.jsonl`),
        `${JSON.stringify({ skill: 'ship', status: 'ok', repo_id: identity.repo_id })}\n`,
      );
      expect(legacyBranch).toBe('feat-slug-hygiene');
      expect(identityBranch).toBe('feat%2Fslug-hygiene');
      expect(fs.existsSync(path.join(home, 'projects', identitySlug, `${identityBranch}-reviews.jsonl`))).toBe(true);

      const reviews = readJsonlUnion<Record<string, unknown>>(ledgerCandidates(identity, 'reviews', home));
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ skill: 'ship', status: 'ok' });

      expect(fs.existsSync(path.join(home, 'projects', legacySlug, 'feat-slug-hygiene-reviews.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'projects', legacySlug, 'feat/slug-hygiene-reviews.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
