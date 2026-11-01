/**
 * #1694: renders of hosts an install does not serve are pruned safely.
 *
 * Every ./setup (and the gstack-upgrade migration) removes the render dirs of
 * hosts missing from the installed-hosts record with bin/gstack-relink's proof
 * rules: a symlink into the checkout (STRONG) goes; a file proven generated
 * (WEAK: gen-skill-docs' banner, the generator's openai.yaml shape, byte
 * identity) is moved to $GSTACK_STATE_ROOT/backups/host-renders/; anything
 * else stays; only emptied directories are removed. The legacy layout here is
 * a real `--host all` render.
 *
 * Split by test so the free-suite packer can balance the suite (60 s seed ceiling):
 * test/host-renders-prune-shared-root.test.ts and test/host-renders-prune-migration.test.ts hold the rest.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put } from './helpers/install-fixture';
import { backups, legacyRender, setupOk, skillFiles } from './helpers/host-renders-prune-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup prunes unrecorded host renders without losing a file (#1694)', () => {
  test('a legacy all-host render inside a Claude install: generated files backed up, user files kept, links handled', async () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    await legacyRender(src);
    const before = skillFiles(src).length;
    expect(before).toBeGreaterThan(600);
    const customized = path.join(src, '.factory/skills/gstack-qa/SKILL.md');
    fs.appendFileSync(customized, '\nMy own QA note.\n');
    put(path.join(src, '.factory/notes.md'), 'my notes, no banner\n');
    put(path.join(src, '.kiro/skills/my-skill/SKILL.md'), '---\nname: my-skill\n---\nHand-written.\n');
    fs.mkdirSync(path.join(src, '.cursor/skills/gstack'), { recursive: true });
    fs.symlinkSync(path.join(src, 'bin'), path.join(src, '.cursor/skills/gstack/bin'));
    fs.mkdirSync(path.join(f.dir, 'outside'));
    fs.symlinkSync(path.join(f.dir, 'outside'), path.join(src, '.cursor/skills/gstack/elsewhere'));

    const r = setupOk(f, src);
    expect(fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8')).toEndWith('\nclaude\n');
    // Only the Claude skills and the hand-written look-alike remain.
    const left = skillFiles(src).filter(rel => rel.startsWith('.'));
    expect(left).toEqual(['.kiro/skills/my-skill/SKILL.md']);
    expect(before - skillFiles(src).length).toBeGreaterThan(550);
    expect(fs.readdirSync(path.join(src, '.factory'), { recursive: true })).toEqual(['notes.md']);
    expect(fs.lstatSync(path.join(src, '.cursor/skills/gstack/elsewhere')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(f.dir, 'outside'))).toBe(true);
    expect(fs.existsSync(path.join(src, '.cursor/skills/gstack/bin'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'bin/gstack-config'))).toBe(true);
    for (const dir of ['.agents', '.opencode', '.copilot', '.agy', '.gemini-cli', '.slate', '.openclaw', '.hermes', '.gbrain']) expect(fs.existsSync(path.join(src, dir)), dir).toBe(false);

    expect(r.stdout).toContain('kept .factory/notes.md: not proven generated (no gstack banner or byte match)');
    expect(r.stdout).toContain('kept .kiro/skills/my-skill/SKILL.md: not proven generated');
    expect(r.stdout).toContain('kept .cursor/skills/gstack/elsewhere: links outside this checkout');
    expect(r.stdout).toMatch(/pruned \.factory \(factory is not installed from this checkout\): \d+ generated files backed up, 0 links removed, \d+ empty dirs removed, 1 kept/);
    const [backup] = backups(f);
    expect(backups(f)).toHaveLength(1);
    expect(r.stdout).toContain(`host-render backup: ${backup} (every path: ${backup}/prune.log; restore a file with mv)`);
    expect(fs.readFileSync(path.join(backup!, '.factory/skills/gstack-qa/SKILL.md'), 'utf8')).toEndWith('\nMy own QA note.\n');
    const log = fs.readFileSync(path.join(backup!, 'prune.log'), 'utf8');
    expect(log).toContain('backed up\t.agents/skills/gstack-qa/agents/openai.yaml\tgenerated');
    expect(log).toContain('backed up\t.hermes/skills/gstack-qa/SKILL.md\tgenerated');
    expect(log).toContain(`removed link\t.cursor/skills/gstack/bin\t-> ${src}/bin`);
    expect(log).toContain('kept\t.factory/notes.md\tnot proven generated');
    expect(log).toContain('removed dir\t.agents\tempty');

    const again = setupOk(f, src);
    expect(again.stdout).not.toContain('pruned ');
    expect(again.stdout).not.toContain('host-render backup');
    expect(backups(f)).toHaveLength(1);
  }, 240_000);
});
