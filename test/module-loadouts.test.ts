/**
 * Module loadouts (GSTA-140, PR 1a): modules/loadouts.json, the derived
 * catalog, --modules selection, the render filter, and gstack-modules render.
 * Every rung loads `full` today, so the synthetic ad-hoc arms below are the
 * only exclusion coverage; committed bytes are covered by Skill Docs Freshness.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { MODEL_CATALOG } from '../lib/model-catalog';
import { runGeneration } from '../scripts/gen-skill-docs';
import { ModuleError, excludedSkillDirs, loadLoadouts, moduleCatalog, normalizeModelId, rungFor, selectModules, validateLoadouts, type ModuleErrorCode } from '../scripts/modules';
import { LOCK_FILE, renderLoadout, type LoadoutLock } from '../scripts/modules-render';
import { applySectionGuards } from '../scripts/resolvers/sections';
import { PREAMBLE_MODULE_IDS, preambleSections } from '../scripts/resolvers/preamble';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const manifest = loadLoadouts();
const catalog = moduleCatalog(manifest);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadouts-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Model ids gstack runs on or GSTA-2 measures (Capy's model list, 2026-10-28). */
const CORPUS = [
  ...MODEL_CATALOG.map(e => e.model), 'gpt-6-astra',
  'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5-1',
  'openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-terra', 'deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4-pro',
  'zai/glm-5.3', 'zai/glm-5.3-flash', 'google/gemini-4-argon', 'google/gemini-3.8-flash', 'xai/grok-4.7',
  'moonshotai/kimi-k3.1-pro', 'qwen/qwen3.8-max', 'qwen/qwen3.8-flash', 'minimax/minimax-m3',
];

function codeOf(fn: () => unknown): ModuleErrorCode | 'none' {
  try { fn(); return 'none'; } catch (error) { if (error instanceof ModuleError) return error.code; throw error; }
}

describe('modules/loadouts.json', () => {
  test('validates against the derived catalog, with disjoint rungs over the model corpus', () => {
    expect(validateLoadouts(manifest, catalog, CORPUS)).toEqual([]);
  });

  test('every rung and unknown loads full until GSTA-2 measures a smaller loadout', () => {
    expect(Object.values(manifest.default)).toEqual(['full', 'full', 'full', 'full', 'full']);
  });

  test('the catalog derives every module kind from its source files', () => {
    const ids = new Set(catalog.map(e => e.id));
    expect(ids.has('skill:gstack')).toBe(true);
    expect(ids.has('section:office-hours/second-opinion')).toBe(true);
    expect(ids.has('overlay:opus-4-8')).toBe(true);
    for (const id of PREAMBLE_MODULE_IDS) expect(ids.has(id)).toBe(true);
    for (const entry of catalog) expect(fs.existsSync(path.join(ROOT, entry.source))).toBe(true);
    expect(catalog.filter(e => e.pinned).map(e => e.id)).toEqual(expect.arrayContaining(['preamble:bash', 'skill:gstack', 'skill:gstack-upgrade', ...manifest.pinned]));
  });

  test('model ids normalize and map to rungs', () => {
    expect(normalizeModelId(' Anthropic/Claude-Haiku-5-5[1m] ')).toBe('claude-haiku-5-5');
    expect(rungFor(manifest, 'anthropic/claude-opus-5-5')).toBe('strong');
    expect(rungFor(manifest, 'anthropic/claude-haiku-5-5')).toBe('mid');
    expect(rungFor(manifest, 'deepseek/deepseek-v4.1-flash-1017')).toBe('light');
    expect(rungFor(manifest, 'zai/glm-5.3-flash')).toBe('light');
    expect(rungFor(manifest, 'zai/glm-5.3')).toBe('mid');
    expect(rungFor(manifest, 'haiku')).toBe('mid');
    expect(rungFor(manifest, 'some-new-model')).toBe('unknown');
    expect(rungFor(manifest, 'constructor')).toBe('unknown');
    for (const model of MODEL_CATALOG) expect(rungFor(manifest, model.model)).not.toBe('unknown');
  });

  test('a broken manifest names each problem', () => {
    const bad = structuredClone(manifest);
    bad.loadouts.lean = { base: 'missing', exclude: ['preamble:bash', 'section:nope/none'] };
    bad.default.mid = 'ghost';
    bad.default.light = 'toString';
    bad.loadouts.noship = { base: 'constructor', exclude: ['skill:ship'] };
    bad.rungs.light.push('claude-opus-5*');
    const problems = validateLoadouts(bad, catalog, CORPUS).join('\n');
    expect(problems).toContain('loadouts.lean.base names no loadout');
    expect(problems).toContain('excludes pinned preamble:bash');
    expect(problems).toContain('"section:nope/none", which is not a module');
    expect(problems).toContain('default.mid names no loadout');
    expect(problems).toContain('default.light names no loadout');
    expect(problems).toContain('loadouts.noship.base names no loadout');
    expect(problems).toContain('excludes skill:ship, which holds pinned section:ship/');
    expect(problems).toContain('matches more than one rung');
  });
});

describe('selectModules', () => {
  test('full and an empty spec render today\'s bytes (no filter)', () => {
    expect(selectModules({ loadout: 'full' })).toBeNull();
    expect(selectModules({})).toBeNull();
    expect(selectModules({ modules: 'full,-section:office-hours/second-opinion,+section:office-hours/second-opinion' })).toBeNull();
  });

  test('an ad-hoc spec records its name, normalized spec and hash', () => {
    const s = selectModules({ modules: ' full , -skill:design-shotgun ' })!;
    expect(s.name).toBe('adhoc');
    expect(s.spec).toBe('full,-skill:design-shotgun');
    expect(s.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(excludedSkillDirs(s)).toEqual(['design-shotgun']);
  });

  test('bad input is refused with a code, never a fallback to full', () => {
    expect(codeOf(() => selectModules({ loadout: 'nope' }))).toBe('LOADOUT_UNKNOWN');
    expect(codeOf(() => selectModules({ modules: 'full,skill:qa' }))).toBe('MODULE_SPEC_INVALID');
    expect(codeOf(() => selectModules({ loadout: 'full', modules: 'full' }))).toBe('MODULE_SPEC_INVALID');
    expect(codeOf(() => selectModules({ loadout: 'full,-skill:qa' }))).toBe('MODULE_SPEC_INVALID');
    expect(codeOf(() => selectModules({ modules: 'full,-skill:nope' }))).toBe('MODULE_UNKNOWN');
    expect(codeOf(() => selectModules({ modules: 'full,-preamble:bash' }))).toBe('MODULE_PINNED');
    expect(codeOf(() => selectModules({ modules: 'full,-section:ship/adversarial' }))).toBe('MODULE_PINNED');
    expect(codeOf(() => selectModules({ modules: 'full,-skill:ship' }))).toBe('MODULE_PINNED');
    expect(codeOf(() => selectModules({ modules: 'full,-skill:autoplan' }))).toBe('MODULE_PINNED');
    expect(codeOf(() => selectModules({ loadout: 'constructor' }))).toBe('LOADOUT_UNKNOWN');
  });

  test('every error code has a troubleshooting section', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/troubleshooting.md'), 'utf-8');
    const codes: ModuleErrorCode[] = ['LOADOUTS_INVALID', 'LOADOUT_UNKNOWN', 'MODULE_SPEC_INVALID', 'MODULE_UNKNOWN', 'MODULE_PINNED', 'MODULE_EXCLUSION_UNSAFE', 'RENDER_FAILED', 'RENDER_DEST_NOT_OWNED'];
    for (const code of codes) {
      const anchor = code.toLowerCase().replaceAll('_', '-');
      const at = doc.indexOf(`<a id="${anchor}"></a>`);
      expect(at).toBeGreaterThan(-1);
      expect(doc.slice(at).split('\n')[1]).toMatch(new RegExp(`^### \`${code}`));
    }
  });
});

describe('render filter units', () => {
  const ctx = (extra: Partial<TemplateContext> = {}): TemplateContext => ({
    skillName: 'office-hours', tmplPath: 'office-hours/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude, preambleTier: 3, model: 'claude', ...extra,
  });
  const filter = (excluded: string[], preambleTierMax?: number) => ({
    name: 'test', excluded: new Set(excluded), pinned: new Set(catalog.filter(e => e.pinned).map(e => e.id)), preambleTierMax,
  });

  test('section guards vanish under full and drop their text when the section is excluded', () => {
    const text = 'a\n{{IF_SECTION:second-opinion}}offer\n{{/IF_SECTION}}b';
    expect(applySectionGuards(text, ctx())).toBe('a\noffer\nb');
    expect(applySectionGuards(text, ctx({ modules: filter(['section:office-hours/second-opinion']) }))).toBe('a\nb');
    expect(() => applySectionGuards('{{IF_SECTION:nope}}x{{/IF_SECTION}}', ctx())).toThrow('no section "nope"');
  });

  test('a tier cap drops unpinned pieces; pinned pieces follow full', () => {
    const full = preambleSections(ctx()).join('\n');
    const capped = preambleSections(ctx({ modules: filter([], 1) })).join('\n');
    expect(full).toContain('## Writing Style');
    expect(capped).not.toContain('## Writing Style');
    expect(capped).toContain('## AskUserQuestion Format');
    const tier1 = ctx({ preambleTier: 1 });
    expect(preambleSections({ ...tier1, modules: filter([], 1) })).toEqual(preambleSections(tier1));
  });

  test('excluding a base overlay drops its text from the overlay that inherits it', () => {
    const astra = ctx({ model: 'gpt-6-astra' as TemplateContext['model'] });
    const withBase = preambleSections(astra).join('\n');
    const withoutBase = preambleSections({ ...astra, modules: filter(['overlay:gpt']) }).join('\n');
    expect(withBase.length).toBeGreaterThan(withoutBase.length);
    expect(preambleSections({ ...astra, modules: filter(['overlay:gpt-6-astra']) }).join('\n')).not.toContain('Model-Specific Behavioral Patch');
  });
});

describe('gstack-modules render', () => {
  const spec = 'full,-section:office-hours/second-opinion,-section:office-hours/visual-design,-preamble:writing-style,-overlay:claude,-skill:design-shotgun';
  const readLock = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8')) as LoadoutLock;
  const ensureArm = async (dir: string) => { if (!fs.existsSync(path.join(dir, LOCK_FILE))) await renderLoadout({ host: 'claude', selection: selectModules({ modules: spec }), outDir: dir }); };

  test('claude: one arm excludes one module of each kind and locks every file', async () => {
    const out = path.join(tmp, 'claude-arm');
    const lock = await renderLoadout({ host: 'claude', selection: selectModules({ modules: spec }), outDir: out });
    const skill = fs.readFileSync(path.join(out, 'office-hours/SKILL.md'), 'utf-8');
    expect(skill).toContain('<!-- loadout: adhoc -->');
    expect(skill).not.toContain('Want a second opinion');
    expect(skill).not.toContain('## Phase 4.25: Visual design');
    expect(skill).toContain('> Not loaded in the adhoc loadout: skip running the Phase 3.5 second opinion');
    expect(skill).not.toContain('sections/second-opinion.md');
    expect(fs.existsSync(path.join(out, 'office-hours/sections/second-opinion.md'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'office-hours/sections/design-and-handoff.md'))).toBe(true);
    expect(skill).toContain(`${out}/office-hours/sections/design-and-handoff.md`);
    const preamble = fs.readFileSync(path.join(out, 'office-hours/sections/preamble.md'), 'utf-8');
    expect(preamble).not.toContain('## Writing Style');
    expect(preamble).not.toContain('Model-Specific Behavioral Patch');
    expect(preamble).toContain('## AskUserQuestion Format');
    expect(fs.existsSync(path.join(out, 'design-shotgun'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'gstack/llms.txt'), 'utf-8')).not.toContain('design-shotgun/SKILL.md');
    expect(fs.readFileSync(path.join(out, 'SKILL.md'), 'utf-8')).toContain('Disabled on this install (never invoke or suggest them): `/design-shotgun`');
    expect(lock).toMatchObject({ loadout: 'adhoc', spec, host: 'claude', model: 'claude' });
    expect(lock.excluded).toEqual(spec.split(',').slice(1).map(t => t.slice(1)).sort());
    expect(readLock(out).files.length).toBe(lock.files.length);
    expect(lock.files.find(f => f.path === 'office-hours/SKILL.md')!.bytes).toBe(Buffer.byteLength(skill));
    expect(fs.readdirSync(tmp).filter(n => n.includes('.stage-') || n.includes('.old-'))).toEqual([]);
  });

  test('codex: the same arm inlines nothing it excluded', async () => {
    const out = path.join(tmp, 'codex-arm');
    await renderLoadout({ host: 'codex', selection: selectModules({ modules: spec }), outDir: out, model: 'gpt-6-astra' });
    const skill = fs.readFileSync(path.join(out, '.agents/skills/gstack-office-hours/SKILL.md'), 'utf-8');
    expect(skill).not.toContain('Want a second opinion');
    expect(skill).toContain('> Not loaded in the adhoc loadout');
    expect(fs.existsSync(path.join(out, '.agents/skills/gstack-design-shotgun'))).toBe(false);
    expect(readLock(out).model).toBe('gpt-6-astra');
  });

  test('a dangling reference is refused and the earlier render survives', async () => {
    const out = path.join(tmp, 'claude-arm');
    await ensureArm(out);
    const before = readLock(out);
    const unsafe = renderLoadout({ host: 'claude', selection: selectModules({ modules: 'full,-section:plan-design-review/review-sections' }), outDir: out });
    await expect(unsafe).rejects.toMatchObject({ code: 'MODULE_EXCLUSION_UNSAFE' });
    await expect(unsafe).rejects.toThrow('referenced by plan-design-review/sections/checklist.md');
    await expect(renderLoadout({ host: 'claude', selection: selectModules({ modules: 'full,-skill:qa' }), outDir: out })).rejects.toThrow(/skill:qa: referenced by qa-only\//);
    expect(readLock(out)).toEqual(before);
    expect(fs.readdirSync(tmp).filter(n => n.includes('.stage-'))).toEqual([]);
  });

  test('a later render replaces an earlier one; a foreign directory is never replaced', async () => {
    const out = path.join(tmp, 'claude-arm');
    await ensureArm(out);
    expect(readLock(out).loadout).toBe('adhoc');
    const lock = await renderLoadout({ host: 'claude', selection: selectModules({ modules: 'full,-skill:design-shotgun' }), outDir: out });
    expect(readLock(out).spec_sha256).toBe(lock.spec_sha256);
    expect(fs.existsSync(path.join(out, 'office-hours/sections/second-opinion.md'))).toBe(true);
    const foreign = path.join(tmp, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
    await expect(renderLoadout({ host: 'claude', selection: null, outDir: foreign })).rejects.toMatchObject({ code: 'RENDER_DEST_NOT_OWNED' });
    expect(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf-8')).toBe('mine');
  });

  test('the full loadout regenerates the committed claude tree byte for byte', async () => {
    const result = await runGeneration({ host: 'claude', dryRun: true, modules: selectModules({ loadout: 'full' }) });
    expect(result.diagnostics.filter(d => d.kind === 'stale' || d.kind === 'error')).toEqual([]);
  });
});

describe('modules/loadouts.schema.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/loadouts.schema.json'), 'utf-8'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/loadouts.json'), 'utf-8'));

  test('the manifest carries every required key and no key the schema lacks', () => {
    for (const key of schema.required) expect(raw).toHaveProperty(key);
    for (const key of Object.keys(raw)) expect(Object.keys(schema.properties)).toContain(key);
    expect(raw.version).toBe(schema.properties.version.const);
  });

  test('rung names and patterns agree between the schema and the manifest', () => {
    const rungs = schema.properties.rungs.required as string[];
    expect(Object.keys(raw.rungs).sort()).toEqual([...rungs].sort());
    expect([...schema.properties.aliases.additionalProperties.enum].sort()).toEqual([...rungs].sort());
    const pattern = new RegExp(schema.properties.rungs.properties.frontier.items.pattern);
    for (const rung of rungs) for (const glob of raw.rungs[rung]) expect(glob).toMatch(pattern);
  });
});

describe('bin/gstack-modules', () => {
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'bin/gstack-modules'), ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  test('validate and list read the committed manifest', () => {
    expect(run('validate')).toMatchObject({ code: 0, stdout: expect.stringContaining('LOADOUTS: ok') });
    const listed = JSON.parse(run('list', '--json').stdout);
    expect(listed.modules.map((m: { id: string }) => m.id)).toEqual(catalog.map(e => e.id));
    const pinned = run('list', '--pinned').stdout;
    expect(pinned).toContain('preamble:bash');
    expect(pinned).not.toContain('skill:design-shotgun');
  });

  test('refused inputs exit 2 with their code; unknown commands print usage', () => {
    const out = path.join(tmp, 'cli-refused');
    expect(run('render', '--host', 'claude', '--modules', 'full,-skill:nope', '--out-dir', out)).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_UNKNOWN') });
    expect(run('render', '--host', 'claude', '--modules', 'full,-preamble:bash', '--out-dir', out)).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_PINNED') });
    expect(run('render', '--host', 'claude', '--loadout', 'full', '--out-dir', out, '--plan-mode', 'maybe')).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_SPEC_INVALID') });
    expect(run('render', '--host', 'claude', '--loadout', 'full', '--out-dir', out, '--model', 'no-such-model')).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_SPEC_INVALID') });
    expect(run('render', '--host', 'claude', '--out-dir', out)).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_SPEC_INVALID') });
    expect(fs.existsSync(out)).toBe(false);
    expect(run('bogus')).toMatchObject({ code: 2, stderr: expect.stringContaining('Usage:') });
    expect(run('--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('gstack-modules render') });
  });

  test('gen:skill-docs refuses an exclusion render into the committed tree', () => {
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 }).stdout;
    for (const extra of [[], ['--out-dir', '.']]) {
      const result = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'scripts/gen-skill-docs.ts'), '--host', 'claude', '--modules', 'full,-skill:design-shotgun', ...extra], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('MODULE_SPEC_INVALID');
    }
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 }).stdout).toBe(before);
  });

  test('render prints one RENDERED line and writes the lock', () => {
    const out = path.join(tmp, 'cli-render');
    const result = run('render', '--host', 'claude', '--modules', 'full,-skill:design-shotgun', '--out-dir', out);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^RENDERED: loadout=adhoc host=claude files=\d+ bytes=\d+ excluded=1 lock=/);
    expect(JSON.parse(fs.readFileSync(path.join(out, LOCK_FILE), 'utf-8')).excluded).toEqual(['skill:design-shotgun']);
  });
});
