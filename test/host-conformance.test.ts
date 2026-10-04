/**
 * Host conformance kit (docs/ADDING_A_HOST.md "Certify your host").
 *
 * Runs the real ./setup into a clean temp HOME for every installable host in
 * hosts/index.ts and checks the install contract: the host's discovery
 * directory gets its skills, no other host's directory is created or changed,
 * no skill name is duplicated, the registry row is published, and
 * ./setup --status reports it. Upgrade cases start from the previous
 * release's on-disk layout (the same links, no registry, the marker in
 * ~/.gstack) and from a project-vendored copy that captured the global Codex
 * namespace (#2879). Instruction-only hosts must change nothing.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { accessSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, registryRows, runSetup, setVersion, tree } from './helpers/install-fixture';
import { expectTokens } from './helpers/prompt-structure';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

/** Skills directory each installable host discovers (global scope). */
const DISCOVERY: Record<string, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  kiro: '.kiro/skills',
  factory: '.factory/skills',
  opencode: '.config/opencode/skills',
  cursor: '.cursor/skills',
  copilot: '.copilot/skills',
};
/** Every directory any host (or a shared agents layout) reads. */
const ALL_DISCOVERY_DIRS = [...Object.values(DISCOVERY), '.agents/skills', '.copilot/skills', '.hermes/skills'];

const installable = ALL_HOST_CONFIGS.filter(c => c.tier !== 'instruction-only').map(c => c.name);
const instructionOnly = ALL_HOST_CONFIGS.filter(c => c.tier === 'instruction-only').map(c => c.name);

function skillNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir)) {
    const md = join(dir, entry, 'SKILL.md');
    if (!existsSync(md)) continue;
    const m = readFileSync(md, 'utf8').match(/^name:\s*(\S+)/m);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Every SKILL.md under dir that is itself a symlink; linked directories are not entered (INV-3). */
function symlinkedSkillMds(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { if (name === 'SKILL.md') found.push(p); continue; }
    if (st.isDirectory()) found.push(...symlinkedSkillMds(p));
  }
  return found;
}

/**
 * Section pointers in installed SKILL.md files that do not resolve to a
 * readable file (INV-3, ENG-1). A pointer is "Read `<path>/sections/<f>.md`",
 * optionally "relative to the installed `<skill>` SKILL.md directory". A bare
 * `sections/...` pointer counts in a carved skill (sections/ installed, or a
 * **STOP.** line); prefixed ones count everywhere. Same rule as ./setup --status.
 */
function brokenSectionPointers(dest: string, runtimeRoot: string, home: string): string[] {
  const readable = (p: string) => { try { accessSync(p); return true; } catch { return false; } };
  const broken: string[] = [];
  for (const skill of readdirSync(dest)) {
    const dir = join(dest, skill);
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    for (const line of readFileSync(join(dir, 'SKILL.md'), 'utf8').split('\n')) {
      const stop = line.includes('**STOP.**');
      for (const [, tok, rel] of line.matchAll(/Read `([^` ]*sections\/[A-Za-z0-9._-]+\.md)`((?: relative to the installed (?:`[^`]+`\/?)+)?)/g)) {
        const names = [...rel.matchAll(/`([^`]+)`/g)].map(m => m[1]);
        let targets: string[];
        if (tok.startsWith('sections/')) {
          if (names.length) targets = names.map(n => join(dest, n, tok));
          else if (existsSync(join(dir, 'sections')) || stop) targets = [join(dir, tok)];
          else continue;
        } else if (tok.startsWith('$GSTACK_ROOT/')) targets = [join(runtimeRoot, tok.slice('$GSTACK_ROOT/'.length))];
        else if (tok.startsWith('~/')) targets = [join(home, tok.slice(2))];
        else if (tok.startsWith('/')) targets = [tok];
        else if (tok.startsWith('../')) targets = [join(dir, tok)];
        else continue;
        if (!targets.some(readable)) broken.push(`${skill}: ${tok}`);
      }
    }
  }
  return [...new Set(broken)];
}

describe.skipIf(process.platform === 'win32')('host conformance kit', () => {
  test('the kit covers every installable host', () => {
    expect(Object.keys(DISCOVERY).sort()).toEqual([...installable].sort());
  });

  for (const host of installable) {
    test(`${host}: installs only into its own discovery directory, registers, and reports`, () => {
      const f = makeFixture();
      const src = makeSource(f, join(f.dir, 'gstack'));
      const r = runSetup(f, join(src, 'setup'), ['--host', host]);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const dest = join(f.home, DISCOVERY[host]);
      const names = skillNames(dest);
      expect(names.length, `${host} skills in ${dest}`).toBeGreaterThan(20);
      expect(new Set(names).size, `duplicate skill names in ${dest}`).toBe(names.length);
      for (const other of ALL_DISCOVERY_DIRS.filter(d => d !== DISCOVERY[host])) {
        expect(existsSync(join(f.home, other)), `${host} install created ${other}`).toBe(false);
      }
      if (host !== 'claude') {
        for (const name of readdirSync(dest).filter(n => n.startsWith('gstack-'))) {
          const md = join(dest, name, 'SKILL.md');
          if (existsSync(md)) expect(readFileSync(md, 'utf8'), `${host}/${name} carries Claude paths`).not.toContain('~/.claude/skills/gstack');
        }
      }
      // #2906: /cso skips the shared preamble, so it names its launcher by the
      // host's literal install path; that path must reach this install's bin/.
      const cso = ['cso', 'gstack-cso'].find(n => existsSync(join(dest, n, 'SKILL.md')));
      expect(cso, `${host} cso skill`).toBeDefined();
      const launcher = readFileSync(join(dest, cso!, 'SKILL.md'), 'utf8').match(/Use `([^`]+)\/gstack-cso-launcher\[\.exe\]`/);
      expect(launcher, `${host} cso names its launcher`).not.toBeNull();
      expect(realpathSync(launcher![1].replace(/^~(?=\/)/, f.home)), `${host} cso launcher dir`).toBe(realpathSync(join(src, 'bin')));
      const rows = registryRows(f);
      expect(rows.map(row => [row[0], row[1], row[3], row[5], row[6]])).toEqual([[host, 'global', dest, realpathSync(src), readFileSync(join(src, 'VERSION'), 'utf8').trim()]]);
      expect(r.stdout + r.stderr).toMatch(new RegExp(`Install summary:[\\s\\S]*\\b${host}\\s+\\S+\\s+global\\s+installed`));

      const status = runSetup(f, join(src, 'setup'), ['--status']);
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(new RegExp(`\\b${host}\\s+${ALL_HOST_CONFIGS.find(c => c.name === host)!.tier}\\s+global\\s+current`));

      // C5 (#2651): OpenCode's builtin /review shadows the review skill, so
      // /gstack-review loads it by the name the skill tool knows.
      if (host === 'opencode') expect(readFileSync(join(f.home, '.config/opencode/commands/gstack-review.md'), 'utf8')).toContain('Load the `review` skill with the skill tool');

      // INV-3 install-level checks (C2, C3, ENG-1, ENG-14).
      if (host !== 'claude') {
        const runtimeRoot = rows[0][4];
        expect(symlinkedSkillMds(dest), `${host}: symlinked SKILL.md files (Codex skips them)`).toEqual([]);
        for (const bin of ['design/dist/design', 'make-pdf/dist/pdf']) {
          expect(existsSync(join(runtimeRoot, bin)), `${host} runtime root ${bin}`).toBe(true);
        }
        expect(brokenSectionPointers(dest, runtimeRoot, f.home), `${host}: unresolved section pointers`).toEqual([]);
        expect(status.stdout).toMatch(new RegExp(`\\n  ${host} global: router is a real file; section links: \\d+ checked, all resolve\\n`));
      }
      if (host === 'codex') expect(existsSync(join(src, '.agents/skills/gstack/design/dist/design')), 'agents sidecar design/dist').toBe(true);
    }, 60_000);
  }

  test('opencode: every skill gets a managed /gstack-* command on the build agent; user commands survive (#2629)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    const commands = join(f.home, '.config/opencode/commands');
    put(join(commands, 'gstack-review.md'), 'my own review command\n');
    put(join(commands, 'gstack-retired.md'), '---\n---\n<!-- gstack-managed command (./setup --host opencode): edits are overwritten -->\nold\n');
    expect(runSetup(f, join(src, 'setup'), ['--host', 'opencode']).status).toBe(0);
    const ship = readFileSync(join(commands, 'gstack-ship.md'), 'utf8');
    expect(ship).toMatch(/^---\ndescription: "[^"]+"\nagent: build\nsubtask: false\n---\n/);
    // The skill tool loads by frontmatter name, not directory name (#2651).
    expectTokens(ship, ['`ship`'], 'ship');
    expect(ship).toContain('$ARGUMENTS');
    expect(readFileSync(join(commands, 'gstack-review.md'), 'utf8')).toBe('my own review command\n');
    expect(existsSync(join(commands, 'gstack-retired.md'))).toBe(false);
    const un = Bun.spawnSync(['bash', join(src, 'bin/gstack-uninstall'), '--force', '--keep-state'], { cwd: f.home, env: f.env, timeout: 30_000 });
    expect(un.exitCode).toBe(0);
    expect(readdirSync(commands)).toEqual(['gstack-review.md']);
  }, 60_000);

  test.each(instructionOnly)('%s (instruction-only): truthful instructions, nothing written', (host) => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    const before = tree(f.home);
    const r = runSetup(f, join(src, 'setup'), ['--host', host]);
    expect(r.status).toBe(0);
    expect(tree(f.home)).toEqual(before);
    expect(r.stdout).not.toMatch(/gstack ready|Install summary/);
  }, 30_000);

  test('--status is read-only and lists unregistered installs from before the registry', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    expect(runSetup(f, join(src, 'setup'), ['--host', 'codex']).status).toBe(0);
    rmSync(join(f.home, '.gstack/installs.tsv'));
    const before = tree(f.dir);
    const status = runSetup(f, join(src, 'setup'), ['--status']);
    expect(status.status).toBe(0);
    expect(tree(f.dir)).toEqual(before);
    expect(status.stdout).toMatch(/codex\s+experimental\s+global\s+unregistered/);
    expect(status.stdout).toContain(`register it: cd ${realpathSync(src)} && ./setup --host codex`);
  }, 60_000);

  test('--status names a symlinked router and a broken section link per host (C3)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    expect(runSetup(f, join(src, 'setup'), ['--host', 'codex']).status).toBe(0);
    const router = join(f.home, '.codex/skills/gstack/SKILL.md');
    rmSync(router);
    symlinkSync(join(src, '.agents/skills/gstack/SKILL.md'), router);
    const qa = join(src, '.agents/skills/gstack-qa/sections');
    rmSync(join(qa, readdirSync(qa).find(n => n.endsWith('.md'))!));
    const status = runSetup(f, join(src, 'setup'), ['--status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/codex global: router is a symlink, which Codex skips\. Fix: cd \S+ && \.\/setup --host codex; section links: [1-9]\d* of \d+ broken \(first: [^)]*\)\. Fix: cd /);
  }, 60_000);

  test('upgrade from the previous release layout refreshes every installed host (#1925)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'), '1.91.12.0');
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    // v1.91.13.0 and earlier: same links, no registry, marker in ~/.gstack.
    rmSync(join(f.home, '.gstack/installs.tsv'));
    setVersion(src, '1.91.14.0');
    // C3: a hand edit to the router copy is saved under the state root before
    // the runtime root is replaced, and the refresh rewrites the copy.
    const router = join(f.home, '.codex/skills/gstack/SKILL.md');
    expect(lstatSync(router).isSymbolicLink()).toBe(false);
    writeFileSync(router, readFileSync(router, 'utf8') + '\nmy local note\n');

    const oldUpgrade = runSetup(f, join(src, 'setup'), []);
    expect(oldUpgrade.status).toBe(0);
    expect(registryRows(f).map(r => r[0])).toEqual(['claude']);

    const upgrade = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.stdout).toContain(`Refreshing registered gstack installs from source: ${realpathSync(src)}`);
    expect(upgrade.stdout).toMatch(/Upgrade summary:\n[\s\S]*claude\s+full\s+global\s+unchanged\s+1\.91\.14\.0[\s\S]*codex\s+experimental\s+global\s+installed\s+1\.91\.14\.0/);
    expect(registryRows(f).map(r => [r[0], r[6]]).sort()).toEqual([['claude', '1.91.14.0'], ['codex', '1.91.14.0']]);
    // The refreshed Codex install runs the new checkout's render.
    expect(realpathSync(join(f.home, '.codex/skills/gstack-review/SKILL.md'))).toBe(join(realpathSync(src), '.agents/skills/gstack-review/SKILL.md'));
    expect(readFileSync(router, 'utf8')).toBe(readFileSync(join(src, '.agents/skills/gstack/SKILL.md'), 'utf8'));
    const saved = upgrade.stdout.match(/saved your edited (\S+) to (\S+) /);
    expect(saved, upgrade.stdout).not.toBeNull();
    expect(saved![1]).toBe(router);
    expect(saved![2].startsWith(join(f.home, '.gstack/backups/skill-copies/'))).toBe(true);
    expect(readFileSync(saved![2], 'utf8')).toEndWith('\nmy local note\n');
    expect(upgrade.stdout).toContain(`refreshed SKILL.md copies in ${join(f.home, '.codex/skills/gstack')}: SKILL.md gstack-upgrade/SKILL.md office-hours/SKILL.md`);
  }, 90_000);

  test('a Codex namespace captured by a vendored project copy is reported, never repointed (#2879)', () => {
    const f = makeFixture();
    const global = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const project = join(f.dir, 'proj');
    mkdirSync(join(project, '.git'), { recursive: true });
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'), '1.80.0.0');
    // Pre-fix capture: the vendored copy registered itself globally.
    expect(runSetup(f, join(vendored, 'setup'), ['--host', 'codex', '--global']).status).toBe(0);
    rmSync(join(f.home, '.gstack/installs.tsv'));
    const codexBefore = tree(join(f.home, '.codex'));

    const status = runSetup(f, join(global, 'setup'), ['--status']);
    expect(status.stdout).toContain(`captured by the project-vendored copy at ${realpathSync(vendored)} (#2879)`);
    const upgrade = runSetup(f, join(global, 'setup'), ['--refresh-registered']);
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.stdout).toMatch(/codex\s+experimental\s+global\s+skipped/);
    expect(upgrade.stdout).toContain('choose: refresh it there');
    expect(tree(join(f.home, '.codex'))).toEqual(codexBefore);
  }, 90_000);

  test('a host that fails mid-upgrade keeps its last install and gets a retry command', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'), '1.91.12.0');
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    setVersion(src, '1.91.14.0');
    const codexBefore = tree(join(f.home, '.codex'));
    // Break only the Codex arm: its skills directory refuses writes.
    chmodSync(join(f.home, '.codex/skills'), 0o555);
    let upgrade;
    try {
      upgrade = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    } finally {
      chmodSync(join(f.home, '.codex/skills'), 0o755);
    }
    expect(upgrade.status).toBe(1);
    expect(upgrade.stdout).toContain('NOT every install was refreshed');
    expect(upgrade.stdout).toMatch(/claude\s+full\s+global\s+updated\s+1\.91\.12\.0 -> 1\.91\.14\.0/);
    expect(upgrade.stdout).toMatch(/codex\s+experimental\s+global\s+failed/);
    expect(upgrade.stdout).toContain(`Retry: cd ${realpathSync(src)} && ./setup --host codex`);
    expect(tree(join(f.home, '.codex'))).toEqual(codexBefore);
    expect(registryRows(f).find(r => r[0] === 'codex')![6]).toBe('1.91.12.0');
  }, 90_000);

  test('first run from the published instructions ends in a skill that starts', () => {
    const f = makeFixture();
    // README: git clone … ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = runSetup(f, join(src, 'setup'), [], { cwd: src });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Chromium install skipped by request');
    const skill = readFileSync(join(f.home, '.claude/skills/office-hours/SKILL.md'), 'utf8');
    const fence = skill.slice(skill.indexOf('## Preamble')).match(/```bash\n([\s\S]*?)\n```/)![1];
    const work = join(f.dir, 'repo');
    mkdirSync(work);
    const start = Bun.spawnSync(['bash', '-c', fence], { cwd: work, env: { ...f.env }, timeout: 30_000 });
    const out = start.stdout.toString();
    expect(out, start.stderr.toString()).toContain('SKILL_START_PROTO: 1');
    expect(out).not.toContain('SKILL_START: unavailable');
    expect(readdirSync(work)).toEqual([]);
    // The default root serves the committed render.
    expect(registryRows(f).map(row => row[8])).toEqual(['committed']);
    expect(existsSync(join(f.home, '.gstack/render/installs'))).toBe(false);
  }, 90_000);

  // #1882 / #2763: an install outside ~/.claude/skills/gstack serves skills
  // rendered for its own root, with the one literal start line worktree-
  // isolated Claude Code runs (a plain path: a root with a space is named
  // through an alias), and never touches another install or the tracked render.
  test('renamed, vendored and space-in-path installs start skills from their own root (#1882)', () => {
    const f = makeFixture();
    const renamed = makeSource(f, join(f.home, '.claude/skills/gstack-dev'));
    const project = join(f.dir, 'my proj');
    mkdirSync(join(project, '.git'), { recursive: true });
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'));
    for (const [src, cwd] of [[renamed, renamed], [vendored, project]]) {
      const r = runSetup(f, join(src, 'setup'), [], { cwd });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).not.toContain('could not render skills');
    }
    const fence = (text: string, heading: string) => text.slice(text.indexOf(heading)).match(/```bash\n([\s\S]*?)\n```/)![1];
    const renders = new Set<string>();
    for (const [skills, root] of [[join(f.home, '.claude/skills'), renamed], [join(project, '.claude/skills'), vendored]]) {
      const row = registryRows(f).find(r => r[0] === 'claude' && r[3] === skills)!;
      expect(row[4]).toBe(root);
      const render = row[8];
      expect(render).toStartWith(join(f.home, '.gstack/render/installs/claude-'));
      renders.add(render);
      const md = join(skills, 'review/SKILL.md');
      expect(realpathSync(md)).toBe(join(realpathSync(render), 'review/SKILL.md'));
      const text = readFileSync(md, 'utf8');
      expect(text).not.toContain('~/.claude/skills/gstack/');
      const start = fence(text, '## Preamble');
      const named = start.slice(0, start.indexOf('/bin/gstack-skill-start'));
      expect(start).toBe(`${named}/bin/gstack-skill-start --skill "review" --model "claude"`);
      expect(named).toMatch(/^\/[A-Za-z0-9_.@+\/-]+$/);
      expect(realpathSync(named)).toBe(realpathSync(root));
      expect(named === root).toBe(!/\s/.test(root));
      expect(fence(text, '## Context Recovery')).toBe(`${named}/bin/gstack-context-recovery`);
      const work = mkdtempSync(join(f.dir, 'work-'));
      const run = Bun.spawnSync(['bash', '-c', start], { cwd: work, env: f.env, timeout: 30_000 });
      expect(run.stdout.toString(), run.stderr.toString()).toContain('SKILL_START_PROTO: 1');
      expect(Bun.spawnSync(['bash', '-c', fence(text, '## Context Recovery')], { cwd: work, env: f.env, timeout: 30_000 }).exitCode).toBe(0);
    }
    expect(renders.size).toBe(2);
    // The tracked render stays portable; no default install was created.
    expect(readFileSync(join(renamed, 'review/SKILL.md'), 'utf8')).toContain('~/.claude/skills/gstack/bin/gstack-skill-start --skill "review"');
    expect(existsSync(join(f.home, '.claude/skills/gstack'))).toBe(false);
    // A later relink keeps serving the recorded render.
    const relink = Bun.spawnSync(['bash', join(renamed, 'bin/gstack-relink')], { cwd: f.home, env: f.env, timeout: 60_000 });
    expect(relink.exitCode, relink.stderr.toString()).toBe(0);
    expect(realpathSync(join(f.home, '.claude/skills/review/SKILL.md')).startsWith(realpathSync(join(f.home, '.gstack/render/installs')))).toBe(true);
  }, 120_000);

  test('CLAUDE_CONFIG_DIR and CODEX_HOME installs name their own roots (#1882, #2906)', () => {
    const f = makeFixture();
    const config = join(f.dir, 'claude-config');
    const codexHome = join(f.dir, 'codex-home');
    const env = { CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome };
    const src = makeSource(f, join(config, 'skills/gstack'));
    for (const host of ['claude', 'codex']) {
      const r = runSetup(f, join(src, 'setup'), ['--host', host], { cwd: src, env });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    const claude = readFileSync(join(config, 'skills/review/SKILL.md'), 'utf8');
    expect(claude).toContain(`\n${src}/bin/gstack-skill-start --skill "review" --model "claude"\n`);
    const codex = readFileSync(join(codexHome, 'skills/gstack-review/SKILL.md'), 'utf8');
    expect(codex).toContain(`GSTACK_ROOT="${codexHome}/skills/gstack"`);
    expect(readFileSync(join(codexHome, 'skills/gstack-cso/SKILL.md'), 'utf8')).toContain(`Use \`${codexHome}/skills/gstack/bin/gstack-cso-launcher[.exe]\``);
    expect(realpathSync(join(codexHome, 'skills/gstack/bin'))).toBe(realpathSync(join(src, 'bin')));
    const rows = registryRows(f);
    expect(rows.map(r => [r[0], r[8].startsWith(join(f.home, '.gstack/render/installs/'))]).sort()).toEqual([['claude', true], ['codex', true]]);
    for (const dir of ['.claude', '.codex']) expect(existsSync(join(f.home, dir)), dir).toBe(false);
  }, 120_000);
});
