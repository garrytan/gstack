import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

describe('skill text fixes from user reports', () => {
  test('/ship checks the sections gstack-post kept on an existing PR (#4379)', () => {
    const body = read('ship/sections/pr-body.md');
    expect(body).toContain('If `pr-body` printed `kept` sections, open each in the PR: keep one a person wrote.');
    expect(body).toContain('rerun the body command with `--replace`');
  });

  test('/spec --execute points the archive at the branch the spawned session ships from (#4616)', () => {
    const spec = read('spec/sections/gate-and-file.md');
    expect(spec).toContain('also set `spec_branch: $SPAWN_BRANCH`');
    expect(read('ship/sections/pr-body.md')).toContain('`spec_branch` match to `CURRENT_BRANCH`');
  });

  test('/design-shotgun passes a reason the taste updater can read (#4618)', () => {
    const shotgun = read('design-shotgun/SKILL.md');
    expect(shotgun).toMatch(/gstack-taste-update approved <approved image path> --reason "<why>"/);
    expect(shotgun).toMatch(/gstack-taste-update rejected <variant-path> --reason "<why>"/);
    expect(shotgun).toContain('`fonts: <a>; colors: <b>; layouts: <c>; aesthetics: <d>`');
  });

  test('/build-check says what CHECKS: none means and how to declare a check (#4346)', () => {
    const verify = read('build-check/SKILL.md');
    expect(verify).toContain('this never reaches `READY_FOR_SHIP`');
    expect(verify).toContain('`gstack:verify: <command>`');
  });

  test('/codex keeps installed skills off-limits and reads the repo agents/ folder as code (#3924)', () => {
    for (const file of ['codex/SKILL.md', 'codex/sections/consult-mode.md', 'codex/sections/challenge-mode.md', 'codex/sections/review-mode.md']) {
      const text = read(file);
      expect(text).toContain('files under ~/.claude/, ~/.agents/, .claude/skills/, .agents/, or any agents/openai.yaml.');
      expect(text).toContain('other files in the repository agents/ folder are code to review.');
      expect(text).not.toContain('.claude/skills/, or agents/');
    }
  });

  test('the second-model review in /ship, /review and every other skill that sends it reads the repo agents/ folder as code (#3924)', () => {
    const ls = spawnSync('git', ['grep', '-l', 'Filesystem boundary: do not read or execute'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    const files = ls.stdout.split('\n').filter(f => f.endsWith('.md'));
    expect(files).toEqual(expect.arrayContaining(['review/sections/adversarial.md', 'ship/sections/adversarial.md']));
    for (const file of files) {
      const text = read(file);
      expect(text).toContain('Filesystem boundary: do not read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, .agents/, or any agents/openai.yaml.');
      expect(text).toContain('other files in the repository agents/ folder are code to review.');
      expect(text).not.toContain('.claude/skills/, or agents/');
    }
  });

  test('Captain docs say crew threads read CREW.md, not the drive-root AGENTS.md (#4296)', () => {
    expect(read('crew/docs/captain.md')).toContain('crew threads read `CREW.md` on every turn but never the drive-root `AGENTS.md`');
    expect(read('crew/docs/captain.md')).not.toContain('apply to every thread in the crew, so a rule written there needs no relaying');
    expect(read('captain/templates/AGENTS.md')).toContain("On Capy, crew threads don't read it; they read `CREW.md`.");
  });
});
