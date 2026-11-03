/**
 * /review's PR-type step (GSTA-224 H1, issue #356). The checklist names the PR type from the changed paths, keeps every
 * category on application and mixed diffs, always runs five categories on CI/infra, scripts/tooling and docs-only diffs,
 * and reports the rest in one not-applicable line. The classifier below is built from the patterns the checklist itself
 * lists (its backticked globs, plus the compose, Terraform and README/CHANGELOG phrases the classifier hardcodes), so a
 * reworded rule that drops one fails here before a reviewer reads it.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const checklist = fs.readFileSync(path.join(import.meta.dir, '..', 'review', 'checklist.md'), 'utf8').replace(/\r\n/g, '\n');

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  expect(j).toBeGreaterThan(i);
  return text.slice(i, j);
}

const block = () => between(checklist, '**PR type', '**Two-pass review:**');
const TYPES = ['docs-only', 'CI/infra', 'scripts/tooling', 'application', 'mixed'] as const;
type PrType = typeof TYPES[number];

function rule(type: PrType): string {
  const line = block().split('\n').find(l => l.startsWith('- **' + type + ':**'));
  expect(line).toBeDefined();
  return line!;
}
const ticks = (line: string) => [...line.matchAll(/\x60([^\x60]+)\x60/g)].map(m => m[1]!);
const globRe = (glob: string) => new RegExp('^' + glob.replace(/[.+^\${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

const MANIFESTS = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock', 'pyproject.toml', 'uv.lock'];
const LINT_CONFIG = /^(\.eslintrc.*|eslint\.config\..*|\.prettierrc.*|prettier\.config\..*|biome\.json|\.shellcheckrc|\.editorconfig)$/;

function classifier() {
  const ci = ticks(rule('CI/infra')).map(globRe);
  const scriptRes = ticks(rule('scripts/tooling')).map(globRe);
  const app = rule('application');
  const appDirs = ticks(app).filter(t => t.endsWith('/'));
  const appGlobs = ticks(app).filter(t => t.startsWith('*')).map(globRe);
  expect(appDirs).toEqual(['bin/', 'scripts/', 'tools/']);
  expect(app).toContain('package manifests and lockfiles');
  expect(app).toContain('skill Markdown');
  expect(rule('docs-only')).toContain('\x60docs/\x60');
  expect(rule('docs-only')).toContain('README/CHANGELOG');
  expect(rule('CI/infra')).toContain('compose files');
  expect(rule('CI/infra')).toContain('Terraform');
  const isScript = (p: string) => scriptRes.some(r => r.test(base(p)));
  return (p: string): Exclude<PrType, 'mixed'> => {
    if (appDirs.some(d => p.startsWith(d)) && !isScript(p)) return 'application';
    if (MANIFESTS.includes(base(p)) || appGlobs.some(r => r.test(base(p))) || base(p) === 'SKILL.md') return 'application';
    if (/\.(md|txt)$/.test(p) && (p.startsWith('docs/') || /^(README|CHANGELOG)/.test(base(p)))) return 'docs-only';
    if (ci.some(r => r.test(p) || r.test(base(p))) || /(^|\/)(docker-)?compose\.ya?ml$|\.tf$/.test(p)) return 'CI/infra';
    if (isScript(p) || LINT_CONFIG.test(base(p))) return 'scripts/tooling';
    return 'application';
  };
}

function prType(paths: string[]): PrType {
  const one = classifier();
  const types = new Set(paths.map(one));
  return types.size > 1 ? 'mixed' : [...types][0]!;
}

describe('review checklist PR type (GSTA-224 H1)', () => {
  test('the PR type is decided first and names the five types in order', () => {
    const b = block();
    expect(checklist.indexOf('**PR type')).toBeLessThan(checklist.indexOf('## Review Categories'));
    expect(b).toContain('\x60PR type: <type>\x60');
    let at = -1;
    for (const type of TYPES) {
      const i = b.indexOf('- **' + type + ':**');
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(rule('application')).toContain('When in doubt, application.');
  });

  test.each(([
    ['a .tmpl change', ['review/SKILL.md.tmpl', 'review/SKILL.md'], 'application'],
    ['a bin/ TypeScript change', ['bin/gstack-design-detect.ts'], 'application'],
    ['an extensionless bin/ executable', ['bin/gstack-approval-classes'], 'application'],
    ['scripts/ TypeScript', ['scripts/skill-bin-drift.ts'], 'application'],
    ['package.json + bun.lock', ['package.json', 'bun.lock'], 'application'],
    ['a workflow-only change', ['.github/workflows/free-tests.yml'], 'CI/infra'],
    ['a Dockerfile', ['Dockerfile.ci'], 'CI/infra'],
    ['a .bat add at the root', ['build.bat'], 'scripts/tooling'],
    ['a .bat add under scripts/', ['scripts/build.bat'], 'scripts/tooling'],
    ['a shell script and the Makefile', ['scripts/release.sh', 'Makefile'], 'scripts/tooling'],
    ['docs only', ['docs/skills.md', 'README.md'], 'docs-only'],
    ['docs plus a checklist prompt', ['docs/skills.md', 'review/checklist.md'], 'mixed'],
    ['a workflow plus application code', ['.github/workflows/ci.yml', 'lib/review-brief.ts'], 'mixed'],
    ['a workflow plus a .bat script', ['.github/workflows/ci.yml', 'build.bat'], 'mixed'],
    ['an unplaceable path', ['assets/logo.svg'], 'application'],
  ] as Array<[string, string[], PrType]>).map(([name, paths, expected]) => [name + ' is ' + expected, paths, expected] as const))('%s', (_name, paths, expected) => {
    expect(prType(paths)).toBe(expected);
  });

  test('application and mixed diffs run everything; other types always run five categories and report the rest in one line', () => {
    const scope = block().slice(block().indexOf('On application and mixed diffs'));
    expect(scope).toContain('On application and mixed diffs, run every category below exactly as written; nothing is skipped.');
    const always = /always run (.+?), and report/.exec(scope);
    expect(always).not.toBeNull();
    const names = always![1]!.split(/, | and (?=Repo)/);
    expect(names).toEqual(['Gate Integrity', 'Shell Injection', 'Completeness Gaps', 'Distribution & CI/CD Pipeline', 'Repo Conventions & Platform Fit']);
    const headings = checklist.split('\n').filter(l => l.startsWith('#### ')).map(l => l.slice(5));
    for (const name of names) expect(headings.some(h => h.startsWith(name))).toBe(true);
    expect(scope).toContain('once, in one line: \x60Not applicable (PR type: <type>): <categories>\x60');
    expect(scope).toContain('never counts as passed');
  });

  test('Repo Conventions & Platform Fit needs a concrete consequence and Distribution gains the script checks', () => {
    const conventions = between(checklist, '#### Repo Conventions & Platform Fit', '\n---');
    expect(conventions).toContain('concrete consequence');
    expect(conventions).toContain('a \x60.bat\x60 script in a repo whose scripts are bash plus a Makefile is a finding');
    expect(conventions).toContain('platforms the CI runners and docs target');
    expect(conventions).toContain('repeats no existing tool');
    const distribution = between(checklist, '#### Distribution & CI/CD Pipeline', '#### Repo Conventions');
    for (const token of ['\x60set -euo pipefail\x60', 'quoted variables', "CI runners' OS", 'release tag or commit SHA', 'pinned version']) expect(distribution).toContain(token);
    expect(distribution).toContain('except for the script and pinning checks above');
    expect(between(checklist, '## Severity Classification', '## Fix-First Heuristic')).toContain('└─ Repo Conventions & Platform Fit');
  });

  test('the addition stays near 25 lines', () => {
    const conventions = between(checklist, '#### Repo Conventions & Platform Fit', '\n---');
    const scriptChecks = checklist.split('\n').filter(l => l.startsWith('- Scripts CI or a build relies on:') || l.startsWith('- Pinned versions:'));
    expect(scriptChecks).toHaveLength(2);
    const lines = (block() + conventions).trimEnd().split('\n').length + scriptChecks.length + 1;
    expect(lines).toBeLessThanOrEqual(25);
  });
});
