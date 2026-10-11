/**
 * C4: the generated-file registry. Pins the wire contract (exit codes, result
 * codes, the `regen <id>:` lines, the trust boundary) on fixture repos under
 * os.tmpdir(). Incident p0-4-stale-goldens: a generator input changed, the
 * committed output did not, and `check` catches it in a scratch worktree
 * without touching the tree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { parseRegistry, selectEntries, validateRegistry } from '../lib/regen';
import { BASE_REGISTRY, cleanup, commit, makeFixtureRepo, readFile, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('validateRegistry (schema + containment, pure)', () => {
  test('the fixture registry validates; command null is a listed entry; inputs default to always', () => {
    expect(validateRegistry(BASE_REGISTRY)).toEqual([]);
    const parsed = parseRegistry(JSON.stringify({ entries: [{ id: 'a', command: 'x', outputs: ['out/**'] }] }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.registry.entries[0]!.inputs).toEqual([]);
    expect(selectEntries(parsed.registry, ['anything']).map(e => e.id)).toEqual(['a']);
  });

  test('unknown keys, duplicate ids, empty outputs and bad commands are REGEN_REGISTRY_INVALID with the path named', () => {
    const codes = (r: unknown) => validateRegistry(r).map(e => `${e.code}:${e.path}`);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: ['o'], extra: 1 }] })).toEqual(['REGEN_REGISTRY_INVALID:entries[0].extra']);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: ['o'] }, { id: 'a', command: 'y', outputs: ['p'] }] })).toEqual(['REGEN_REGISTRY_INVALID:entries[1].id']);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: [] }] })).toEqual(['REGEN_REGISTRY_INVALID:entries[0].outputs']);
    expect(codes({ entries: [{ id: 'A b', command: 'x', outputs: ['o'] }] })).toEqual(['REGEN_REGISTRY_INVALID:entries[0].id']);
    expect(codes({ entries: [{ id: 'a', command: '', outputs: ['o'] }] })).toEqual(['REGEN_REGISTRY_INVALID:entries[0].command']);
    expect(codes([])).toEqual(['REGEN_REGISTRY_INVALID:']);
    expect(codes({ entries: 'x' })).toEqual(['REGEN_REGISTRY_INVALID:entries']);
  });

  test('containment: `..`, absolute paths, newline commands, size and list caps are REGEN_CONTAINMENT', () => {
    const codes = (r: unknown) => validateRegistry(r).map(e => `${e.code}:${e.path}`);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: ['../victim/**'] }] })).toEqual(['REGEN_CONTAINMENT:entries[0].outputs[0]']);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: ['/etc/*'] }] })).toEqual(['REGEN_CONTAINMENT:entries[0].outputs[0]']);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: ['o'], inputs: ['a/../../b'] }] })).toEqual(['REGEN_CONTAINMENT:entries[0].inputs[0]']);
    expect(codes({ entries: [{ id: 'a', command: 'x\nrm -rf /', outputs: ['o'] }] })).toEqual(['REGEN_CONTAINMENT:entries[0].command']);
    expect(codes({ entries: [{ id: 'a', command: 'x'.repeat(513), outputs: ['o'] }] })).toEqual(['REGEN_CONTAINMENT:entries[0].command']);
    expect(codes({ entries: [{ id: 'a', command: 'x', outputs: Array.from({ length: 65 }, (_, i) => `o${i}`) }] })).toEqual(['REGEN_CONTAINMENT:entries[0].outputs']);
    expect(codes({ entries: Array.from({ length: 65 }, (_, i) => ({ id: `e${i}`, command: 'x', outputs: ['o'] })) })).toEqual(['REGEN_REGISTRY_INVALID:entries']);
  });

  test('selectEntries: touched inputs or outputs select an entry; untouched entries with inputs are skipped', () => {
    const { registry } = parseRegistry(JSON.stringify(BASE_REGISTRY));
    expect(selectEntries(registry, ['src/version.js']).map(e => e.id)).toEqual(['digest', 'goldens']);
    expect(selectEntries(registry, ['generated/digest.md']).map(e => e.id)).toEqual(['digest']);
    expect(selectEntries(registry, ['README.md']).map(e => e.id)).toEqual([]);
    expect(selectEntries(registry).map(e => e.id)).toEqual(['digest', 'goldens']);
  });
});

describe('gstack-regen (bin)', () => {
  test('--help prints the exit table; no command and unknown commands are usage (2)', () => {
    const repo = fixture();
    expect(runBin(repo, 'gstack-regen', ['--help']).out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(runBin(repo, 'gstack-regen', []).status).toBe(EXIT.usage);
    expect(runBin(repo, 'gstack-regen', ['bogus']).status).toBe(EXIT.usage);
  });

  test('trust boundary: check lists the commands and exits 3 without --allow-repo-commands; nothing runs', () => {
    const repo = fixture();
    const r = runBin(repo, 'gstack-regen', ['check', '--base', 'main']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(REPO_COMMANDS_NOT_ALLOWED)');
    expect(r.out).toContain('COMMAND: digest="node gen.js" outputs=generated/**');
    expect(r.out).toContain('GSTACK_RESULT: skill=regen status=refused run=');
    expect(runBin(repo, 'gstack-regen', ['check', '--registry-from', 'head']).status).toBe(EXIT.refused);
  });

  test('the registry is read from origin/<base>: a command smuggled into the branch copy is not what runs', () => {
    const repo = fixture();
    commit(repo, { '.gstack/generated.json': JSON.stringify({ entries: [{ id: 'digest', command: 'node -e "require(\'fs\').writeFileSync(\'pwned\',\'x\')"', outputs: ['generated/**'] }] }) + '\n' });
    const r = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('registry: origin/main@');
    expect(r.out).toContain('regen digest: fresh');
    expect(fs.existsSync(path.join(repo.work, 'pwned'))).toBe(false);
    const head = runBin(repo, 'gstack-regen', ['check', '--registry-from', 'head', '--allow-repo-commands']);
    expect(head.out).toContain('registry: head (unreviewed)');
  });

  test('POLICY_SOURCE_UNAVAILABLE when origin/<base> does not resolve; never a silent working-tree fallback', () => {
    const repo = fixture();
    const r = runBin(repo, 'gstack-regen', ['check', '--base', 'nope', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(POLICY_SOURCE_UNAVAILABLE)');
    expect(r.err).toContain('.gstack/generated.json');
  });

  test('p0-4-stale-goldens: a changed input with an unchanged output is stale, caught in a scratch worktree, tree untouched', () => {
    const repo = fixture();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n" });
    const before = readFile(repo, 'generated/digest.md');
    const r = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^regen digest: stale \(\d+ ms\) — stale: generated\/digest\.md — fix: node gen\.js  # then commit generated\/\*\* \(REGEN_STALE\)$/m);
    expect(r.out).toContain('regen goldens: listed — regenerate by hand: test/golden/*.txt (copy the rendered output by hand)');
    expect(r.out).toContain('REGEN: check 1 stale or failed (2 entries)');
    expect(r.out).toMatch(/GSTACK_RESULT: skill=regen status=complete run=[0-9a-f]{40}/);
    expect(readFile(repo, 'generated/digest.md')).toBe(before);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('write regenerates in place and reports the written outputs; a second run is fresh', () => {
    const repo = fixture();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n" });
    const w = runBin(repo, 'gstack-regen', ['write', '--base', 'main', '--allow-repo-commands']);
    expect(w.status).toBe(EXIT.ok);
    expect(w.out).toContain('regen digest: written');
    expect(w.out).toContain('stale: generated/digest.md');
    expect(readFile(repo, 'generated/digest.md')).toBe('# digest v1.1.0\n');
    const again = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands', '--json']);
    expect(again.status).toBe(EXIT.ok);
    const parsed = JSON.parse(again.out);
    expect(parsed.results.map((x: any) => [x.id, x.status])).toEqual([['digest', 'fresh'], ['goldens', 'listed']]);
    expect(parsed.wtree).toMatch(/^[0-9a-f]{40}$/);
  });

  test('a failing command is failed (exit 1, REGEN_COMMAND_FAILED, status incomplete); an output outside the declared globs is stale', () => {
    const repo = fixture({ registry: { entries: [{ id: 'boom', command: 'node -e "process.exit(7)"', outputs: ['generated/**'] }, { id: 'leak', command: 'node -e "require(\'fs\').writeFileSync(\'docs/extra.md\',\'x\')"', outputs: ['generated/**'] }] } });
    const r = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/regen boom: failed .*exit 7.*\(REGEN_COMMAND_FAILED\)/);
    expect(r.out).toMatch(/regen leak: stale .*outside declared outputs: docs\/extra\.md/);
    expect(r.out).toContain('GSTACK_RESULT: skill=regen status=incomplete');
    expect(fs.existsSync(path.join(repo.work, 'docs', 'extra.md'))).toBe(false);
  });

  test('--only and --touched restrict the entries; untracked edits count through the wtree seed', () => {
    const repo = fixture();
    write(repo.work, 'src/version.js', "module.exports = { VERSION: '2.0.0' };\n");
    const only = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands', '--only', 'goldens']);
    expect(only.out).not.toContain('regen digest');
    expect(only.status).toBe(EXIT.ok);
    const touched = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands', '--touched', 'README.md']);
    expect(touched.out).toContain('REGEN: check fresh (0 entries)');
    const all = runBin(repo, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands']);
    expect(all.status).toBe(EXIT.fail);
    expect(all.out).toContain('regen digest: stale');
  });

  test('validate, list and init: an invalid working-tree registry is REGEN_REGISTRY_INVALID; init refuses to overwrite', () => {
    const repo = fixture();
    expect(runBin(repo, 'gstack-regen', ['validate']).out).toContain('REGISTRY_VALID: .gstack/generated.json');
    expect(runBin(repo, 'gstack-regen', ['list']).out).toContain('digest: command="node gen.js" outputs=generated/** inputs=src/version.js,gen.js');
    write(repo.work, '.gstack/generated.json', '{"entries": [{"id": "x", "command": "y", "outputs": ["../z"]}]}\n');
    const v = runBin(repo, 'gstack-regen', ['validate']);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain('(REGEN_CONTAINMENT)');
    expect(runBin(repo, 'gstack-regen', ['init']).status).toBe(EXIT.refused);
    fs.rmSync(path.join(repo.work, '.gstack/generated.json'));
    expect(runBin(repo, 'gstack-regen', ['init']).out).toContain('REGISTRY_WRITTEN: .gstack/generated.json');
    expect(runBin(repo, 'gstack-regen', ['validate']).status).toBe(EXIT.ok);
    // A branch registry that fails validation refuses before any command runs.
    const bad = fixture({ registry: { entries: [{ id: 'x', command: 'y', outputs: ['../z'] }] } });
    const r = runBin(bad, 'gstack-regen', ['check', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(REGEN_CONTAINMENT)');
  });
});

describe("gstack's own registry", () => {
  test('.gstack/generated.json validates and names the renders, the doctor table, the digest and the ship goldens', () => {
    const { registry, errors } = parseRegistry(fs.readFileSync(path.join(path.resolve(import.meta.dir, '..'), '.gstack/generated.json'), 'utf8'));
    expect(errors).toEqual([]);
    const skill = registry.entries.find(e => e.id === 'skill-docs')!;
    expect(skill.command).toBe('bun run gen:skill-docs --host all');
    for (const out of ['bin/gstack-doctor-components.sh', 'agents-digest/gstack-AGENTS.md', 'gstack/llms.txt', '*/SKILL.md']) expect(skill.outputs).toContain(out);
    expect(registry.entries.find(e => e.id === 'ship-goldens')!.outputs).toEqual(['test/fixtures/golden/*-ship-SKILL.md']);
  });
});
