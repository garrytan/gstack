import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dir, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sol-generation-test-'));
const source = path.join(base, 'source');
const temporaryParent = path.join(base, 'renders');
let createFixture: typeof import('./helpers/sol-skill-fixture').createSolSkillFixture;
let fullSkill: unknown[];

// Include directory identity and nanosecond mtimes: delete/copy-back is a
// mutation even when file bytes agree. Never follow a cache symlink.
function inventory(root: string, metadata = true): unknown[] {
  const rows: unknown[] = [];
  function visit(file: string, relative: string) {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file';
    const value = kind === 'symlink' ? fs.readlinkSync(file)
      : kind === 'file' ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
    rows.push([relative, kind, value, ...(metadata ? [String(stat.ino), String(stat.mtimeNs), String(stat.mode)] : [])]);
    if (kind === 'directory') {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    }
  }
  visit(root, '.');
  return rows;
}

function sourceOutputs() {
  return ['.agents', 'gstack/llms.txt', 'agents-digest/gstack-AGENTS.md']
    .map(relative => [relative, inventory(path.join(source, relative))]);
}

beforeAll(async () => {
  // Copy current tracked source bytes, not HEAD: the real generator and helper
  // must resolve their own ROOT inside this disposable checkout. This also
  // makes the legacy in-place comparison safe in parallel free-test shards.
  fs.mkdirSync(source);
  fs.mkdirSync(temporaryParent);
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  expect(files.status, files.stderr).toBe(0);
  for (const relative of files.stdout.split('\0').filter(Boolean)) {
    const from = path.join(ROOT, relative);
    const to = path.join(source, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
  // The helper can be a new, not-yet-indexed file during a repair.
  fs.copyFileSync(path.join(ROOT, 'test/helpers/sol-skill-fixture.ts'), path.join(source, 'test/helpers/sol-skill-fixture.ts'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  const legacy = spawnSync(process.execPath, ['scripts/gen-skill-docs.ts', '--host', 'codex', '--model', 'gpt-5.6-sol'], {
    cwd: source, encoding: 'utf8', timeout: 120_000,
  });
  expect(legacy.status, `${legacy.stderr}\n${legacy.stdout}`).toBe(0);
  fullSkill = inventory(path.join(source, '.agents/skills/gstack-investigate'), false);
  expect(fullSkill.length).toBeGreaterThan(1);

  // Replace only this disposable cache with an operator's profile and a
  // linked sidecar. The live checkout's cache is never touched by this test.
  fs.rmSync(path.join(source, '.agents'), { recursive: true });
  const custom = path.join(source, '.agents/skills/operator-profile');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'SKILL.md'), 'operator-owned profile\n');
  fs.mkdirSync(path.join(base, 'sidecar'));
  fs.writeFileSync(path.join(base, 'sidecar/note'), 'linked content must survive\n');
  fs.symlinkSync(path.join(base, 'sidecar'), path.join(source, '.agents/skills/linked-sidecar'), 'dir');
  ({ createSolSkillFixture: createFixture } = await import(pathToFileURL(path.join(source, 'test/helpers/sol-skill-fixture.ts')).href));
}, 120_000);

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

test('private Sol render matches the full in-place artifact and leaves cache bytes, metadata and links unchanged', async () => {
  const before = sourceOutputs();
  const sidecar = inventory(path.join(base, 'sidecar'));
  const fixture = await createFixture(temporaryParent);
  try {
    expect(inventory(fixture.skillDir, false)).toEqual(fullSkill);
    const skill = fs.readFileSync(path.join(fixture.skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: investigate');
    expect(skill).toContain('Model-Specific Behavioral Patch (gpt-5.6-sol)');
    expect(skill).not.toContain(fixture.outputRoot);
    expect(fs.existsSync(path.join(fixture.outputRoot, 'gstack/llms.txt'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.outputRoot, 'agents-digest/gstack-AGENTS.md'))).toBe(true);
    expect(sourceOutputs()).toEqual(before);
    expect(inventory(path.join(base, 'sidecar'))).toEqual(sidecar);
  } finally {
    fixture.cleanup();
    fixture.cleanup(); // afterAll may repeat cleanup following a setup failure.
  }
  expect(fs.readdirSync(temporaryParent)).toEqual([]);
  expect(sourceOutputs()).toEqual(before);
});

test('real generation failure removes partial skills and shared outputs without changing the installed cache', async () => {
  const before = sourceOutputs();
  const template = path.join(source, 'investigate/SKILL.md.tmpl');
  const original = fs.readFileSync(template);
  fs.appendFileSync(template, '\n{{SOL_FIXTURE_UNKNOWN_PLACEHOLDER}}\n');
  try {
    await expect(createFixture(temporaryParent)).rejects.toThrow('Unknown placeholder {{SOL_FIXTURE_UNKNOWN_PLACEHOLDER}}');
    expect(fs.readdirSync(temporaryParent)).toEqual([]);
    expect(sourceOutputs()).toEqual(before);
  } finally {
    fs.writeFileSync(template, original);
  }
});

test('a symlinked installed cache remains the same symlink and its target is unchanged', async () => {
  const cache = path.join(source, '.agents');
  const target = path.join(base, 'installed-cache');
  fs.renameSync(cache, target);
  fs.symlinkSync(target, cache, 'dir');
  const before = sourceOutputs();
  const targetBefore = inventory(target);
  const fixture = await createFixture(temporaryParent);
  try {
    expect(inventory(fixture.skillDir, false)).toEqual(fullSkill);
    expect(sourceOutputs()).toEqual(before);
    expect(inventory(target)).toEqual(targetBefore);
  } finally {
    fixture.cleanup();
    fs.unlinkSync(cache);
    fs.renameSync(target, cache);
  }
  expect(fs.readdirSync(temporaryParent)).toEqual([]);
});
