/**
 * gate-diff classify — the path floor of the gate-edit detector (W1 of
 * docs/designs/HONEST_WORK_GATE_INTEGRITY.md).
 *
 * A path's class decides whether every hunk in it is LISTED (test, CI/runner/
 * lint config, snapshot/golden) before any tag is considered. The matcher is
 * gstack's own, not gstack-diff-scope's: any depth, case-insensitive, with the
 * Java/Kotlin/Swift/Go/Elixir idioms diff-scope's root-anchored globs miss.
 * `spec/` counts as a test directory only when the candidate's tree holds
 * `*_spec.*` or `*.spec.*` files under it (gstack's own `spec/` skill is prose).
 *
 * Projects extend the floor through a CLAUDE.md `## Gate Integrity` block
 * (`Extra test paths:` and `Snapshot paths:`, comma-separated globs), parsed by
 * `parseGateIntegrityBlock`. Pure: no git, no filesystem.
 */

export type PathClass = 'test' | 'ci' | 'config' | 'snapshot' | 'golden';

export interface GateProjectConfig {
  /** Globs from `Extra test paths:`; listed as tests. */
  extraTestPaths: string[];
  /** Globs from `Snapshot paths:`; listed as goldens (RH-3?: owner unresolved). */
  snapshotPaths: string[];
}

export const EMPTY_PROJECT_CONFIG: GateProjectConfig = { extraTestPaths: [], snapshotPaths: [] };

export interface ClassifyContext {
  project: GateProjectConfig;
  /** True when the candidate tree has `*_spec.*`/`*.spec.*` files under a `spec/` directory. */
  specIsTestPath: boolean;
}

const TEST_DIRS = new Set(['test', 'tests', '__tests__']);

const TEST_BASENAMES: RegExp[] = [
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /_test\.[^.]+$/i,
  /_spec\.[^.]+$/i,
  /^test_.*\.py$/i,
  /Test\.(java|kt|scala)$/i,
  /Tests\.swift$/i,
  /_test\.go$/i,
  /_test\.exs$/i,
];

/** CI, runner and lint configuration: an exact basename, a basename prefix, or a directory. */
const CI_DIRS = ['.github/workflows/', '.gitlab/ci/', '.circleci/'];
const CI_BASENAMES = new Set(['.gitlab-ci.yml', 'jenkinsfile', '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml']);
const CONFIG_BASENAMES = new Set([
  'pytest.ini', 'setup.cfg', 'tox.ini', 'bunfig.toml', '.rubocop.yml', '.mocharc.yml', '.mocharc.json', '.nycrc', 'codecov.yml', '.codecov.yml',
  'karma.conf.js', 'playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js', 'phpunit.xml', 'phpunit.xml.dist',
  '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', 'mypy.ini', '.flake8', 'ruff.toml', '.ruff.toml', 'biome.json', '.prettierrc',
]);
const CONFIG_BASENAME_PREFIXES = ['vitest.config', 'jest.config', '.eslintrc', 'eslint.config', 'tsconfig', 'golangci', '.golangci'];
/** Files whose hunks are config only inside a tool section (checked per hunk by `hunkTouchesToolSection`). */
const SECTIONED_CONFIG = new Set(['package.json', 'pyproject.toml']);

const SNAPSHOT_DIRS = new Set(['__snapshots__']);
const SNAPSHOT_EXT = /\.snap$/i;
const GOLDEN_EXT = /\.golden$/i;
const GOLDEN_DIRS = new Set(['testdata']);

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean);
}

/** Minimal glob → RegExp: `**` any path, `*` within a segment, `?` one char; a trailing `/` or a bare directory name matches its subtree. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const anchored = g.startsWith('/') ? '^' + re.slice(1) : '^(?:.*/)?' + re;
  return new RegExp(anchored + (dirOnly || !/[.*?]/.test(g) ? '(?:/.*)?$' : '$'), 'i');
}

function matchesAny(p: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(p));
}

export function isTestPath(p: string, ctx: ClassifyContext): boolean {
  const segs = segments(p);
  const base = segs[segs.length - 1] ?? '';
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.some((d) => TEST_DIRS.has(d))) return true;
  if (ctx.specIsTestPath && dirs.includes('spec')) return true;
  if (TEST_BASENAMES.some((re) => re.test(base))) return true;
  return matchesAny(p, ctx.project.extraTestPaths);
}

export function isSnapshotPath(p: string): boolean {
  const segs = segments(p);
  const base = segs[segs.length - 1] ?? '';
  return segs.slice(0, -1).some((d) => SNAPSHOT_DIRS.has(d.toLowerCase())) || SNAPSHOT_EXT.test(base);
}

export function isGoldenPath(p: string, ctx: ClassifyContext): boolean {
  const segs = segments(p);
  const base = segs[segs.length - 1] ?? '';
  if (GOLDEN_EXT.test(base)) return true;
  if (segs.slice(0, -1).some((d) => GOLDEN_DIRS.has(d.toLowerCase()))) return true;
  return matchesAny(p, ctx.project.snapshotPaths);
}

export function isCiPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  if (CI_DIRS.some((d) => norm.startsWith(d) || norm.includes('/' + d))) return true;
  const base = segments(norm).pop() ?? '';
  return CI_BASENAMES.has(base);
}

export function isConfigPath(p: string): boolean {
  const base = (segments(p).pop() ?? '').toLowerCase();
  if (CONFIG_BASENAMES.has(base)) return true;
  if (CONFIG_BASENAME_PREFIXES.some((pre) => base.startsWith(pre) && base !== pre + '.d.ts')) return true;
  return false;
}

export function isSectionedConfigPath(p: string): boolean {
  return SECTIONED_CONFIG.has((segments(p).pop() ?? '').toLowerCase());
}

/**
 * For package.json and pyproject.toml, a hunk joins the config floor only when
 * its lines (context included) sit in a tool section: `"scripts"`, a test or
 * lint runner key, or a `[tool.*]` table.
 */
export function hunkTouchesToolSection(p: string, lines: string[]): boolean {
  const base = (segments(p).pop() ?? '').toLowerCase();
  if (base === 'package.json') {
    return lines.some((l) =>
      /^\s*"(scripts|jest|vitest|eslintConfig|husky|lint-staged|mocha|ava|c8|nyc|prettier|browserslist)"\s*:/.test(l)
      || /^\s*"(pre)?(test|lint|typecheck|check|ci|push|commit|prepare|coverage)[^"]*"\s*:\s*"/.test(l));
  }
  if (base === 'pyproject.toml') return lines.some((l) => /^\s*\[tool\./.test(l));
  return false;
}

/** The path's floor class, or null when the path is outside the floor. */
export function classifyPath(p: string, ctx: ClassifyContext): PathClass | null {
  if (isSnapshotPath(p)) return 'snapshot';
  if (isGoldenPath(p, ctx)) return 'golden';
  if (isTestPath(p, ctx)) return 'test';
  if (isCiPath(p)) return 'ci';
  if (isConfigPath(p)) return 'config';
  return null;
}

/** Removed lines matching a test-declaration idiom admit a hunk even outside the floor (content backstop). */
export const TEST_DECLARATION = /^\s*(?:(?:export\s+)?(?:async\s+)?(?:test|it|describe|context|suite|specify|scenario|feature)\s*(?:\.\w+)?\s*\(|def\s+test_\w+|async\s+def\s+test_\w+|func\s+Test\w*\s*\(|@Test\b|@pytest\.mark\.parametrize|#\[test\]|#\[tokio::test\]|@testable|func\s+test\w*\s*\(\)\s*(?:async\s+)?(?:throws\s+)?\{|RSpec\.describe|\bit\s+["'])/;

export function hunkHasRemovedTestDeclaration(removed: string[]): boolean {
  return removed.some((l) => TEST_DECLARATION.test(l));
}

/**
 * Parse CLAUDE.md's optional `## Gate Integrity` block. Keys are
 * `Extra test paths:` and `Snapshot paths:`; values are comma-separated globs.
 * Unknown keys are ignored; a missing block yields the empty config.
 */
export function parseGateIntegrityBlock(claudeMd: string): GateProjectConfig {
  const out: GateProjectConfig = { extraTestPaths: [], snapshotPaths: [] };
  const lines = claudeMd.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    if (/^##\s+/.test(raw)) {
      inBlock = /^##\s+gate integrity\s*$/i.test(raw.trim());
      continue;
    }
    if (!inBlock) continue;
    const m = /^\s*[-*]?\s*(extra test paths|snapshot paths)\s*:\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const values = m[2].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
    if (m[1].toLowerCase() === 'extra test paths') out.extraTestPaths.push(...values);
    else out.snapshotPaths.push(...values);
  }
  return out;
}

/** Whether a tree's path list makes `spec/` a test directory: any `*_spec.*`/`*.spec.*` under a `spec` segment. */
export function specDirectoryHoldsSpecs(treePaths: Iterable<string>): boolean {
  for (const p of treePaths) {
    const segs = segments(p);
    if (!segs.slice(0, -1).some((d) => d.toLowerCase() === 'spec')) continue;
    const base = segs[segs.length - 1] ?? '';
    if (/(_spec|\.spec)\.[^.]+$/i.test(base)) return true;
  }
  return false;
}

/** Code extensions whose test idioms the floor and tags cover, and the ones they do not. */
const COVERED_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  swift: 'swift', ex: 'elixir', exs: 'elixir', rs: 'rust',
};
const UNCOVERED_LANGUAGES: Record<string, string> = {
  php: 'php', cs: 'csharp', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', m: 'objective-c', mm: 'objective-c',
  dart: 'dart', pl: 'perl', pm: 'perl', lua: 'lua', clj: 'clojure', hs: 'haskell', erl: 'erlang', zig: 'zig', nim: 'nim',
  fs: 'fsharp', vb: 'visualbasic', groovy: 'groovy', r: 'r', jl: 'julia', ml: 'ocaml',
};

/** Languages present in the changed set whose test/skip idioms the detector does not know (sorted, deduplicated). */
export function languagesUnlisted(paths: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const p of paths) {
    const ext = (segments(p).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
    if (ext in COVERED_LANGUAGES) continue;
    if (ext in UNCOVERED_LANGUAGES) found.add(UNCOVERED_LANGUAGES[ext]);
  }
  return [...found].sort();
}
