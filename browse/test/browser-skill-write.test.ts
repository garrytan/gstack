/**
 * D3 helper tests — staging, atomic commit, and discard for /skillify.
 *
 * These tests use synthetic tier paths and a synthetic tmp root so they
 * never touch the user's real ~/.gstack/ tree. The contract under test:
 *
 *   stageSkill    → writes files into ~/.gstack/.tmp/skillify-<spawnId>/<name>/
 *   commitSkill   → atomic rename to <tier-root>/<name>/, refuses to clobber
 *   discardStaged → rm -rf the staged dir + per-spawn wrapper, idempotent
 *
 * Failure-mode coverage:
 *   - simulated test failure between stage and commit → discardStaged leaves
 *     no on-disk artifact (the bug class the helper exists to prevent)
 *   - commit refuses to clobber an existing skill dir
 *   - commit refuses to follow a symlinked staging dir
 *   - discardStaged is idempotent (safe to call twice)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  stageSkill,
  commitSkill,
  discardStaged,
  validateSkillName,
} from '../src/browser-skill-write';
import type { TierPaths } from '../src/browser-skills';

let tmpRoot: string;
let tiers: TierPaths;
let stagingTmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-skill-write-test-'));
  tiers = {
    project: path.join(tmpRoot, 'project', '.gstack', 'browser-skills'),
    global: path.join(tmpRoot, 'home', '.gstack', 'browser-skills'),
    bundled: path.join(tmpRoot, 'gstack-install', 'browser-skills'),
  };
  // Synthetic tmp root keeps tests off the real ~/.gstack/.tmp/.
  stagingTmpRoot = path.join(tmpRoot, 'home', '.gstack', '.tmp');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sampleFiles(): Map<string, string | Buffer> {
  return new Map<string, string | Buffer>([
    ['SKILL.md', '---\nname: test-skill\nhost: example.com\ntriggers: []\nargs: []\ntrusted: false\n---\nbody\n'],
    ['script.ts', 'console.log("hi");\n'],
    ['_lib/browse-client.ts', '// fake SDK\n'],
    ['fixtures/example-com-2026-04-27.html', '<html></html>\n'],
    ['script.test.ts', 'import { describe, it, expect } from "bun:test"; describe("x", () => { it("y", () => expect(1).toBe(1)); });\n'],
  ]);
}

// ─── validateSkillName ──────────────────────────────────────────

describe('validateSkillName', () => {
  it.each([
    ['hackernews-frontpage'],
    ['scrape'],
    ['lobsters-frontpage-v2'],
    ['a'],
    ['a1'],
  ])('accepts valid name: %s', (name) => {
    expect(() => validateSkillName(name)).not.toThrow();
  });

  it.each([
    [''],
    ['UPPERCASE'],
    ['has space'],
    ['../escape'],
    ['/abs/path'],
    ['-leading-dash'],
    ['trailing-dash-'],
    ['double--dash'],
    ['1starts-with-digit'],
    ['has.dot'],
    ['has_underscore'],
    ['a'.repeat(65)],
  ])('rejects invalid name: %s', (name) => {
    expect(() => validateSkillName(name)).toThrow();
  });
});

// ─── stageSkill ─────────────────────────────────────────────────

describe('stageSkill', () => {
  it('writes all files into the staged dir and returns the path', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'aaaa1111-test',
      tmpRoot: stagingTmpRoot,
    });

    expect(stagedDir).toBe(path.join(stagingTmpRoot, 'skillify-aaaa1111-test', 'test-skill'));
    expect(fs.existsSync(path.join(stagedDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'script.ts'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, '_lib', 'browse-client.ts'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'fixtures', 'example-com-2026-04-27.html'))).toBe(true);
    expect(fs.readFileSync(path.join(stagedDir, 'script.ts'), 'utf-8')).toContain('hi');
  });

  it('creates the wrapper dir with restrictive perms', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'bbbb2222-test',
      tmpRoot: stagingTmpRoot,
    });
    const wrapperDir = path.dirname(stagedDir);
    const stat = fs.statSync(wrapperDir);
    // 0o700 = owner-only; mode mask off everything else.
    expect((stat.mode & 0o077)).toBe(0);
  });

  it('rejects empty file maps', () => {
    expect(() =>
      stageSkill({
        name: 'test-skill',
        files: new Map(),
        spawnId: 'cccc3333-test',
        tmpRoot: stagingTmpRoot,
      }),
    ).toThrow(/files map is empty/);
  });

  it('rejects file paths that try to escape', () => {
    const bad = new Map<string, string | Buffer>([
      ['SKILL.md', 'ok\n'],
      ['../escape.ts', 'bad\n'],
    ]);
    expect(() =>
      stageSkill({
        name: 'test-skill',
        files: bad,
        spawnId: 'dddd4444-test',
        tmpRoot: stagingTmpRoot,
      }),
    ).toThrow(/Invalid file path/);
  });

  it('rejects invalid skill names', () => {
    expect(() =>
      stageSkill({
        name: 'BAD/NAME',
        files: sampleFiles(),
        spawnId: 'eeee5555-test',
        tmpRoot: stagingTmpRoot,
      }),
    ).toThrow(/Invalid skill name/);
  });

  it('keeps concurrent stages isolated by spawnId', () => {
    const a = stageSkill({ name: 'shared-name', files: sampleFiles(), spawnId: 'spawn-a', tmpRoot: stagingTmpRoot });
    const b = stageSkill({ name: 'shared-name', files: sampleFiles(), spawnId: 'spawn-b', tmpRoot: stagingTmpRoot });
    expect(a).not.toBe(b);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });
});

// ─── commitSkill ────────────────────────────────────────────────

describe('commitSkill', () => {
  it('atomically renames staged dir into the global tier path', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'commit-1',
      tmpRoot: stagingTmpRoot,
    });

    const dest = commitSkill({
      name: 'test-skill',
      tier: 'global',
      stagedDir,
      tiers,
    });

    expect(dest).toBe(path.join(fs.realpathSync(tiers.global), 'test-skill'));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    // The staged dir is gone (rename moved it).
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  it('refuses to clobber an existing skill at the same path', () => {
    // Pre-create a colliding skill at the global tier.
    fs.mkdirSync(path.join(tiers.global, 'collide-skill'), { recursive: true });
    fs.writeFileSync(path.join(tiers.global, 'collide-skill', 'marker.txt'), 'existing\n');

    const stagedDir = stageSkill({
      name: 'collide-skill',
      files: sampleFiles(),
      spawnId: 'commit-2',
      tmpRoot: stagingTmpRoot,
    });

    expect(() =>
      commitSkill({ name: 'collide-skill', tier: 'global', stagedDir, tiers }),
    ).toThrow(/already exists/);

    // Existing skill is untouched.
    expect(fs.readFileSync(path.join(tiers.global, 'collide-skill', 'marker.txt'), 'utf-8')).toBe('existing\n');
    // Staged dir is still there (caller decides whether to discard or rename).
    expect(fs.existsSync(stagedDir)).toBe(true);
  });

  it('refuses to follow a symlinked staging dir', () => {
    const realDir = path.join(tmpRoot, 'real-staging');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'SKILL.md'), 'fake\n');
    const symlink = path.join(tmpRoot, 'symlinked-staging');
    fs.symlinkSync(realDir, symlink);

    expect(() =>
      commitSkill({ name: 'sym-skill', tier: 'global', stagedDir: symlink, tiers }),
    ).toThrow(/symlink/);
  });

  it('throws when project tier is unresolved', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'commit-3',
      tmpRoot: stagingTmpRoot,
    });

    const tiersNoProject: TierPaths = { project: null, global: tiers.global, bundled: tiers.bundled };
    expect(() =>
      commitSkill({ name: 'test-skill', tier: 'project', stagedDir, tiers: tiersNoProject }),
    ).toThrow(/has no resolved path/);
  });

  it('rejects invalid skill names at commit time too', () => {
    // Caller could pass a bad name even after a successful stage.
    const stagedDir = stageSkill({
      name: 'good-name',
      files: sampleFiles(),
      spawnId: 'commit-4',
      tmpRoot: stagingTmpRoot,
    });
    expect(() =>
      commitSkill({ name: 'BAD/NAME', tier: 'global', stagedDir, tiers }),
    ).toThrow(/Invalid skill name/);
  });
});

// ─── discardStaged ──────────────────────────────────────────────

describe('discardStaged', () => {
  it('removes the staged dir and the wrapper when no siblings remain', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'discard-1',
      tmpRoot: stagingTmpRoot,
    });
    const wrapperDir = path.dirname(stagedDir);
    expect(fs.existsSync(stagedDir)).toBe(true);
    expect(fs.existsSync(wrapperDir)).toBe(true);

    discardStaged(stagedDir);

    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.existsSync(wrapperDir)).toBe(false);
  });

  it('is idempotent — safe to call twice', () => {
    const stagedDir = stageSkill({
      name: 'test-skill',
      files: sampleFiles(),
      spawnId: 'discard-2',
      tmpRoot: stagingTmpRoot,
    });
    discardStaged(stagedDir);
    expect(() => discardStaged(stagedDir)).not.toThrow();
  });

  it('does not nuke unrelated parents when stagedDir is not under a skillify wrapper', () => {
    // Synthetic: stagedDir parent is just /tmp/xxx, not skillify-<id>. discardStaged
    // should clean the leaf only and leave the parent alone (defense in depth
    // against a buggy caller passing a path outside the staging tree).
    const lonelyParent = path.join(tmpRoot, 'unrelated-parent');
    const lonelyChild = path.join(lonelyParent, 'leaf');
    fs.mkdirSync(lonelyChild, { recursive: true });
    fs.writeFileSync(path.join(lonelyParent, 'sibling.txt'), 'do not touch\n');

    discardStaged(lonelyChild);

    expect(fs.existsSync(lonelyChild)).toBe(false);
    expect(fs.existsSync(path.join(lonelyParent, 'sibling.txt'))).toBe(true);
    expect(fs.existsSync(lonelyParent)).toBe(true);
  });
});

// ─── End-to-end failure flow (D3 contract) ──────────────────────

describe('D3 contract: simulated test failure leaves no on-disk artifact', () => {
  it('stage → simulated test fail → discard → no skill at final path', () => {
    const stagedDir = stageSkill({
      name: 'failing-skill',
      files: sampleFiles(),
      spawnId: 'd3-fail-1',
      tmpRoot: stagingTmpRoot,
    });
    const finalPath = path.join(tiers.global, 'failing-skill');

    // Simulate $B skill test failing — caller's catch block runs discardStaged.
    discardStaged(stagedDir);

    // Final tier path never received the skill.
    expect(fs.existsSync(finalPath)).toBe(false);
    // Staging is cleaned.
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  it('stage → user rejects in approval gate → discard → no skill at final path', () => {
    const stagedDir = stageSkill({
      name: 'rejected-skill',
      files: sampleFiles(),
      spawnId: 'd3-reject-1',
      tmpRoot: stagingTmpRoot,
    });

    // Tests passed but user said no in the approval gate.
    discardStaged(stagedDir);

    expect(fs.existsSync(path.join(tiers.global, 'rejected-skill'))).toBe(false);
  });

  it('stage → tests pass → commit succeeds → skill is at final path', () => {
    const stagedDir = stageSkill({
      name: 'happy-skill',
      files: sampleFiles(),
      spawnId: 'd3-happy-1',
      tmpRoot: stagingTmpRoot,
    });
    const dest = commitSkill({ name: 'happy-skill', tier: 'global', stagedDir, tiers });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
  });
});
