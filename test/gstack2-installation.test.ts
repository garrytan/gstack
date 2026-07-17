import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_MATRIX,
  COLLISION_SKILLS,
  DEFAULT_REPO_ROOT,
  PUBLIC_SKILLS,
  createCanonicalSourceProjection,
  expectedInstallRoot,
  inspectRepository,
  runFullMatrix,
  skillsCliArgv,
} from '../scripts/gstack2/test-install-matrix';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack install test '));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('GStack 2 standard installer surface', () => {
  test('publishes exactly six uniquely named canonical skills', () => {
    const result = inspectRepository(DEFAULT_REPO_ROOT);

    expect(result.passed).toBe(true);
    expect(result.publicSkills).toEqual([...PUBLIC_SKILLS]);
    expect(result.skillFiles).toEqual(PUBLIC_SKILLS.map((skill) => `${skill}/SKILL.md`).sort());
    for (const skill of COLLISION_SKILLS) {
      expect(result.checks.find((check) => check.id === `repository.collision.${skill}.canonical`)).toMatchObject({
        passed: true,
        detail: `frontmatter name ${skill} resolves to skills/${skill}/SKILL.md`,
      });
    }
  });

  test('canonical projection works through a path with spaces and a source symlink', () => {
    const root = temporaryRoot();
    const projected = path.join(root, 'canonical package', 'source with spaces');
    const linked = path.join(root, 'source symlink');

    createCanonicalSourceProjection(DEFAULT_REPO_ROOT, projected);
    fs.symlinkSync(projected, linked, process.platform === 'win32' ? 'junction' : 'dir');

    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(projected));
    expect(inspectRepository(projected)).toMatchObject({
      passed: true,
      publicSkills: [...PUBLIC_SKILLS],
    });
  });

  test('matrix covers project and global scope for all required standards hosts', () => {
    expect(AGENT_MATRIX.map((entry) => entry.agent)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'pi',
      'openclaw',
      'github-copilot',
    ]);

    const project = '/isolated/project with spaces';
    const home = '/isolated/home with spaces';
    for (const entry of AGENT_MATRIX) {
      expect(expectedInstallRoot(entry, 'project', project, home)).toBe(path.join(project, ...entry.projectPath));
      expect(expectedInstallRoot(entry, 'global', project, home)).toBe(path.join(home, ...entry.globalPath));
    }
  });

  test('constructs subprocess argv without shell interpolation', () => {
    const source = '/tmp/source path with spaces';
    expect(skillsCliArgv('npx', ['add', source, '--skill', 'qa', 'review', 'ship', '--copy', '--yes'])).toEqual([
      'npx',
      '--yes',
      'skills',
      'add',
      source,
      '--skill',
      'qa',
      'review',
      'ship',
      '--copy',
      '--yes',
    ]);
  });

  test('runs the live npx skills matrix when explicitly enabled', () => {
    if (process.env.GSTACK_INSTALL_MATRIX_FULL !== '1') {
      expect(process.env.GSTACK_INSTALL_MATRIX_FULL).not.toBe('1');
      return;
    }

    const root = temporaryRoot();
    const output = path.join(root, 'evidence', 'install-matrix.json');
    const result = runFullMatrix({ repoRoot: DEFAULT_REPO_ROOT, outputPath: output });

    expect(result.summary.passed).toBe(true);
    expect(result.discovery).toMatchObject({ count: 6, names: [...PUBLIC_SKILLS], passed: true });
    expect(result.installs).toHaveLength(AGENT_MATRIX.length * 2 + 2);
    expect(result.removals).toHaveLength(2);
    expect(fs.existsSync(output)).toBe(true);
  }, 600_000);
});
