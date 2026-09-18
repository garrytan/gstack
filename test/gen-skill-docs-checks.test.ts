import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { runGeneration, type GeneratedArtifact, type GenerationResult } from '../scripts/gen-skill-docs';
import { includesSkill } from '../scripts/discover-skills';
import { getHostConfig, ALL_HOST_NAMES } from '../hosts/index';
import { checkGeneratedFreshness, validateGeneratedArtifact } from '../scripts/skill-check';

const ROOT = path.resolve(import.meta.dir, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-check-contract-'));
const render = path.join(base, 'render');
let generated: GenerationResult;

/** Hashes AND mtimes catch rewriting identical files; directory entries catch
 * mkdir-only side effects. Do not follow symlinks back into the checkout. */
function inventory(root: string): unknown[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return [[file, stat.mtimeMs, stat.isDirectory() ? 'directory'
      : stat.isSymbolicLink() ? fs.readlinkSync(file)
      : createHash('sha256').update(fs.readFileSync(file)).digest('hex')],
      ...(stat.isDirectory() ? inventory(file) : [])];
  });
}

beforeAll(async () => {
  generated = await runGeneration({ host: 'all', outputRoot: render, contentLinkRoot: null });
  expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
}, 120_000);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('generator artifact and dry-run contract', () => {
  test('all host artifacts validate, with canonical links and host exclusions', () => {
    expect([...new Set(generated.artifacts.filter(a => a.host).map(a => a.host))].sort()).toEqual([...ALL_HOST_NAMES].sort());
    expect([...new Set(generated.artifacts.map(a => a.kind))].sort()).toEqual(['asset', 'digest', 'index', 'metadata', 'openclaw', 'section', 'skill']);
    expect(generated.artifacts.some(a => a.relativePath === 'claude-code/SKILL.md')).toBe(false);
    expect(generated.artifacts.some(a => a.relativePath === '.agents/skills/gstack-claude-code/SKILL.md')).toBe(true);
    expect(generated.artifacts.some(a => a.relativePath === '.agents/skills/gstack-codex/SKILL.md')).toBe(false);
    expect(fs.readFileSync(path.join(render, 'ship/SKILL.md'), 'utf-8')).toContain('~/.claude/skills/gstack/ship/sections/');
    expect(generated.artifacts.flatMap(a => validateGeneratedArtifact(render, a))).toEqual([]);
    expect(generated.artifacts.filter(a => a.kind === 'asset')).toEqual([
      { relativePath: 'review/design-checklist.md', kind: 'asset', host: 'claude' },
      { relativePath: 'lib/dom-dump.js', kind: 'asset', host: 'claude' },
    ]);
  });

  test('include-minus-skip semantics share one predicate', () => {
    const host = getHostConfig('claude');
    expect(includesSkill(host, 'claude-code')).toBe(false);
    expect(includesSkill(host, '.')).toBe(true);
    const filtered = { ...host, generation: { ...host.generation, includeSkills: ['ship', 'claude-code'] } };
    expect(includesSkill(filtered, 'ship')).toBe(true);
    expect(includesSkill(filtered, 'claude-code')).toBe(false);
    expect(includesSkill(filtered, 'review')).toBe(false);
  });

  test('fresh all-host dry run does not change bytes, mtimes, or directories', async () => {
    const before = inventory(render);
    const result = await runGeneration({ host: 'all', outputRoot: render, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toEqual(generated.artifacts);
    expect(inventory(render)).toEqual(before);
  });

  test('missing nested output root reports every artifact family without creating anything', async () => {
    const parent = fs.mkdtempSync(path.join(base, 'missing-'));
    const outputRoot = path.join(parent, 'not-created', 'nested');
    const before = inventory(parent);
    const result = await runGeneration({ host: 'all', outputRoot, dryRun: true });
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.filter(d => d.kind === 'stale')).toHaveLength(generated.artifacts.length);
    expect(result.diagnostics.filter(d => d.kind === 'error')).toEqual([]);
    expect(inventory(parent)).toEqual(before);
    expect(fs.existsSync(outputRoot)).toBe(false);
  });

  for (const relativePath of [
    'ship/SKILL.md', 'ship/sections/adversarial.md',
    '.agents/skills/gstack-ship/agents/openai.yaml',
    'openclaw/gstack-lite-CLAUDE.md', 'openclaw/gstack-full-CLAUDE.md', 'openclaw/gstack-plan-CLAUDE.md',
    'gstack/llms.txt', 'agents-digest/gstack-AGENTS.md',
    'review/design-checklist.md', 'lib/dom-dump.js',
  ]) {
    test(`changed ${relativePath} is stale and never repaired by dry-run`, async () => {
      const file = path.join(render, relativePath);
      const original = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, 'deliberately stale\n');
        const before = inventory(render);
        const result = await runGeneration({ host: 'all', outputRoot: render, dryRun: true });
        expect(result.exitCode).toBe(1);
        expect(result.diagnostics.filter(d => d.kind === 'stale').map(d => d.relativePath)).toEqual([relativePath]);
        expect(inventory(render)).toEqual(before);
      } finally {
        fs.writeFileSync(file, original);
      }
    });
  }

  test('missing metadata directory is reported and remains absent', async () => {
    const dir = path.join(render, '.agents/skills/gstack-ship/agents');
    const file = path.join(dir, 'openai.yaml');
    const original = fs.readFileSync(file);
    try {
      fs.rmSync(dir, { recursive: true });
      const result = await runGeneration({ host: 'codex', outputRoot: render, dryRun: true });
      expect(result.exitCode).toBe(1);
      expect(result.diagnostics.some(d => d.kind === 'stale' && d.relativePath === '.agents/skills/gstack-ship/agents/openai.yaml')).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.mkdirSync(dir);
      fs.writeFileSync(file, original);
    }
  });

  test('single-host filesystem errors reach the CLI exit code with actionable diagnostics', () => {
    const outputRoot = fs.mkdtempSync(path.join(base, 'not-dir-'));
    fs.writeFileSync(path.join(outputRoot, '.agents'), 'not a directory');
    const before = inventory(outputRoot);
    const result = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--dry-run', '--out-dir', outputRoot], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR (codex)');
    expect(result.stderr).toContain('ENOTDIR');
    expect(inventory(outputRoot)).toEqual(before);
  });

  test('all-host generation reports a partial failure and still renders subsequent hosts', async () => {
    const outputRoot = fs.mkdtempSync(path.join(base, 'partial-host-error-'));
    fs.writeFileSync(path.join(outputRoot, '.agents'), 'blocks only the Codex output tree');
    const result = await runGeneration({ host: 'all', outputRoot });
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.filter(d => d.kind === 'error').map(d => d.host)).toEqual(['codex']);
    for (const relativePath of [
      'ship/SKILL.md', '.factory/skills/gstack-ship/SKILL.md', '.gbrain/skills/gstack-ship/SKILL.md',
      'openclaw/gstack-plan-CLAUDE.md', 'gstack/llms.txt', 'agents-digest/gstack-AGENTS.md',
    ]) {
      expect(result.artifacts.some(a => a.relativePath === relativePath)).toBe(true);
      expect(fs.readFileSync(path.join(outputRoot, relativePath)).length).toBeGreaterThan(0);
    }
    expect(fs.readFileSync(path.join(outputRoot, '.agents'), 'utf-8')).toBe('blocks only the Codex output tree');
  });

  for (const relativePath of ['gstack/llms.txt', 'agents-digest/gstack-AGENTS.md', 'review/design-checklist.md', 'lib/dom-dump.js']) {
    for (const dryRun of [true, false]) {
      test(`shared artifact failure is awaited: ${relativePath}, dryRun=${dryRun}`, async () => {
        const outputRoot = fs.mkdtempSync(path.join(base, 'shared-error-'));
        fs.mkdirSync(path.join(outputRoot, relativePath), { recursive: true });
        const result = await runGeneration({ host: 'claude', outputRoot, dryRun });
        expect(result.exitCode).toBe(1);
        expect(result.diagnostics.some(d => d.kind === 'error' && d.relativePath === relativePath)).toBe(true);
      });
    }
  }

  test.skipIf(process.platform === 'win32')('repo-root sidecar symlink skips skill and metadata without touching source', async () => {
    const outputRoot = fs.mkdtempSync(path.join(base, 'sidecar-'));
    const skills = path.join(outputRoot, '.agents/skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(ROOT, path.join(skills, 'gstack'), 'dir');
    const source = path.join(ROOT, 'SKILL.md');
    const before = fs.statSync(source).mtimeMs;
    const result = await runGeneration({ host: 'codex', outputRoot });
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics.some(d => d.kind === 'skipped' && d.relativePath === '.agents/skills/gstack/SKILL.md')).toBe(true);
    expect(result.artifacts.some(a => a.relativePath.startsWith('.agents/skills/gstack/'))).toBe(false);
    expect(fs.statSync(source).mtimeMs).toBe(before);
  });

  test('explicit content link root preserves literal dollar signs', async () => {
    const outputRoot = path.join(base, 'link-render');
    const contentLinkRoot = path.join(base, 'live$&');
    expect((await runGeneration({ host: 'claude', outputRoot, contentLinkRoot })).exitCode).toBe(0);
    const content = fs.readFileSync(path.join(outputRoot, 'ship/SKILL.md'), 'utf-8');
    expect(content).toContain(`${contentLinkRoot}/ship/sections/`);
    expect(content).not.toContain(`${outputRoot}/ship/sections/`);
  });
});

describe('repository freshness without installed caches', () => {
  const repo = path.join(base, 'fixture-repo');
  function git(...args: string[]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  }
  beforeAll(() => {
    fs.mkdirSync(repo);
    fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(repo, '.gitignore'));
    for (const artifact of generated.artifacts.filter(a => !a.relativePath.startsWith('.'))) {
      const file = path.join(repo, artifact.relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(render, artifact.relativePath), file);
    }
    git('init', '--quiet');
    git('add', '--all');
  });

  test('clean checkout passes without external host caches', () => {
    expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    const result = checkGeneratedFreshness(repo, render, generated.artifacts);
    expect(result.diagnostics).toEqual([]);
    expect(result.checked).toBe(generated.artifacts.filter(a => !a.relativePath.startsWith('.')).length);
  });

  test('ignored stale caches and unrelated dirty files do not affect freshness', () => {
    fs.mkdirSync(path.join(repo, '.agents/skills/gstack-ship'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents/skills/gstack-ship/SKILL.md'), 'stale cache');
    fs.writeFileSync(path.join(repo, 'unrelated-notes.txt'), 'unrelated work');
    const before = inventory(repo);
    expect(checkGeneratedFreshness(repo, render, generated.artifacts).diagnostics).toEqual([]);
    expect(inventory(repo)).toEqual(before);
  });

  test.skipIf(process.platform === 'win32')('ignored symlink cache leaves foreign files and freshness unchanged', () => {
    const foreign = fs.mkdtempSync(path.join(base, 'foreign-cache-'));
    const foreignSkill = path.join(foreign, 'skills/gstack-ship/SKILL.md');
    fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
    fs.writeFileSync(foreignSkill, 'foreign sentinel: must never be rewritten');
    const link = path.join(repo, '.factory');
    fs.symlinkSync(foreign, link, 'dir');
    try {
      const beforeForeign = inventory(foreign);
      const beforeRepo = inventory(repo);
      expect(checkGeneratedFreshness(repo, render, generated.artifacts).diagnostics).toEqual([]);
      expect(inventory(foreign)).toEqual(beforeForeign);
      expect(inventory(repo)).toEqual(beforeRepo);
      expect(fs.readlinkSync(link)).toBe(foreign);
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('scratch ignore evaluation preserves nested ignore rules and exceptions', () => {
    const dir = path.join(repo, 'local-generated');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.md\n!required.md\n');
    const extra: GeneratedArtifact[] = [
      { relativePath: 'local-generated/ignored.md', kind: 'index' },
      { relativePath: 'local-generated/required.md', kind: 'index' },
    ];
    const result = checkGeneratedFreshness(repo, render, [...generated.artifacts, ...extra]);
    expect(result.diagnostics.map(d => [d.kind, d.relativePath])).toEqual([
      ['untracked', 'local-generated/required.md'],
    ]);
  });

  test('scratch ignore evaluation preserves configured excludes with a relative path', () => {
    const excludes = path.join(repo, '.git', 'task-excludes');
    fs.writeFileSync(excludes, 'global-generated/\n');
    git('config', '--local', 'core.excludesFile', '.git/task-excludes');
    try {
      git('check-ignore', 'global-generated/SKILL.md');
      const extra: GeneratedArtifact = { relativePath: 'global-generated/SKILL.md', kind: 'skill', host: 'claude' };
      expect(checkGeneratedFreshness(repo, render, [...generated.artifacts, extra]).diagnostics).toEqual([]);
    } finally {
      git('config', '--local', '--unset', 'core.excludesFile');
    }
  });

  test('missing tracked output fails without being recreated', () => {
    const file = path.join(repo, 'ship/SKILL.md');
    const original = fs.readFileSync(file);
    try {
      fs.unlinkSync(file);
      expect(checkGeneratedFreshness(repo, render, generated.artifacts).diagnostics).toContainEqual({ kind: 'stale', relativePath: 'ship/SKILL.md', message: 'generated or tracked output is missing' });
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.writeFileSync(file, original); }
  });

  test('new nonignored output must be tracked even when bytes match', () => {
    git('update-index', '--force-remove', '--', 'ship/SKILL.md');
    try {
      expect(checkGeneratedFreshness(repo, render, generated.artifacts).diagnostics.some(d => d.kind === 'untracked' && d.relativePath === 'ship/SKILL.md')).toBe(true);
    } finally { git('add', '--', 'ship/SKILL.md'); }
  });

  test('tracked ignored output is still freshness-checked', () => {
    const relativePath = '.agents/skills/gstack-ship/SKILL.md';
    git('add', '--force', '--', relativePath);
    try {
      expect(checkGeneratedFreshness(repo, render, generated.artifacts).diagnostics.some(d => d.kind === 'stale' && d.relativePath === relativePath)).toBe(true);
    } finally { git('update-index', '--force-remove', '--', relativePath); }
  });

  test('Git failures are errors rather than stale results', () => {
    const empty = fs.mkdtempSync(path.join(base, 'not-a-repo-'));
    const result = checkGeneratedFreshness(empty, render, generated.artifacts);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('error');
    expect(result.diagnostics[0].message).toContain('git ls-files');
  });
});

describe('shared content validators', () => {
  const file = path.join(base, 'validation/SKILL.md');
  const artifact: GeneratedArtifact = { relativePath: 'validation/SKILL.md', host: 'codex', kind: 'skill' };
  const frontmatter = '---\nname: fixture\ndescription: fixture skill\n---\n';
  beforeAll(() => fs.mkdirSync(path.dirname(file)));

  for (const [content, message] of [
    ['body only', 'frontmatter'],
    ['---\nname: fixture\ndescription: broken: mapping\n---\nBody.', 'valid YAML'],
    ['---\nname: 123\ndescription: fixture skill\n---\nBody.', 'name must be a nonempty string'],
    ['---\nname: fixture\ndescription: [one, two]\n---\nBody.', 'description must be a nonempty string'],
    ['---\nname: fixture\ndescription: ""\n---\nBody.', 'description must be a nonempty string'],
    [frontmatter + '```bash\n$B nonexistent-command\n```', 'unknown command'],
    [frontmatter + '```bash\n$B snapshot --bogus\n```', 'Unknown snapshot flag'],
    [frontmatter + 'Read ~/.claude/skills/gstack/SKILL.md', 'outside a bash block'],
  ]) {
    test(`rejects ${message}`, () => {
      fs.writeFileSync(file, content);
      expect(validateGeneratedArtifact(base, artifact).some(d => d.message.includes(message))).toBe(true);
    });
  }

  test('legitimate fallback paths in bash examples pass', () => {
    fs.writeFileSync(file, frontmatter + '```bash\nROOT=~/.claude/skills/gstack\n$B snapshot -i\n```');
    expect(validateGeneratedArtifact(base, artifact)).toEqual([]);
  });

  test('quoted names and multiline descriptions remain valid for every host', () => {
    fs.writeFileSync(file, '---\nname: "custom-skill"\ndescription: |\n  A legitimate multiline\n  description: with a colon.\n---\nBody.');
    for (const host of ALL_HOST_NAMES) {
      expect(validateGeneratedArtifact(base, { ...artifact, host })).toEqual([]);
    }
  });

  test('carved sections also validate commands without requiring frontmatter', () => {
    fs.writeFileSync(file, '```bash\n$B snapshot --bogus\n```');
    const diagnostics = validateGeneratedArtifact(base, { ...artifact, kind: 'section', host: 'claude' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('Unknown snapshot flag');
  });
});
