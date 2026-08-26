/**
 * cleanup_old_claude_symlinks destination scan (#2204).
 *
 * The helper used to iterate the payload skill dirs. When the payload is
 * gone the glob matches nothing, so leftover flat skill dirs in $skills_dir
 * stay forever. This suite extracts the REAL function from setup and drives
 * it against a temp skills tree — payload-missing orphans must go, user
 * skills must stay.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

function cleanupBody(): string {
  return extractFn('cleanup_old_claude_symlinks');
}

describe('setup: cleanup_old_claude_symlinks — static (#2204)', () => {
  test('scans the skills dir, not only the payload', () => {
    const body = cleanupBody();
    expect(body).toContain('for old_target in "$skills_dir"/*');
    expect(body).toContain('[ "$skill_name" = "gstack" ] && continue');
    expect(body).toContain('readlink');
    expect(body).toContain('gstack/*');
    expect(body).toContain('gstack-*) continue');
    expect(body).toContain('-d "$old_target"');
    expect(body).toContain('-L "$old_target/SKILL.md"');
    expect(body).toContain('rm -rf "$old_target"');
    // SKILL.md arm must use path-segment provenance, not a bare substring.
    expect(body).toContain('gstack/*|*/gstack/*|*/.gstack/render/claude/*');
    expect(body).not.toMatch(/\*gstack\*\)/);
  });

  test('Windows real-file reap still requires a live payload name list', () => {
    const body = cleanupBody();
    expect(body).toContain('for skill_dir in "$gstack_dir"/*/');
    expect(body).toContain('[ "${IS_WINDOWS:-0}" -eq 1 ] && [ -d "$gstack_dir" ]');
  });
});

describe.skipIf(process.platform === 'win32')('setup: cleanup_old_claude_symlinks — behavior (#2204)', () => {
  function runCleanup(opts: {
    isWindows?: '0' | '1';
    payload?: boolean;
    plant: (skills: string, payload: string) => void;
  }): { status: number; stdout: string; stderr: string; names: string[]; tmp: string } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-orphans-'));
    const skills = path.join(tmp, 'skills');
    const payload = path.join(skills, 'gstack');
    fs.mkdirSync(skills, { recursive: true });
    if (opts.payload) {
      fs.mkdirSync(payload, { recursive: true });
    }
    opts.plant(skills, payload);
    const gstackArg = opts.payload ? payload : path.join(skills, 'missing-payload');
    const script = [
      'set -e',
      `IS_WINDOWS=${opts.isWindows ?? '0'}`,
      extractFn('cleanup_old_claude_symlinks'),
      `cleanup_old_claude_symlinks "${gstackArg}" "${skills}"`,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const names = fs.existsSync(skills)
      ? fs.readdirSync(skills).sort()
      : [];
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      names,
      tmp,
    };
  }

  function plantDanglingSkillMd(skills: string, name: string) {
    const dir = path.join(skills, name);
    fs.mkdirSync(dir);
    fs.symlinkSync(`gstack/${name}/SKILL.md`, path.join(dir, 'SKILL.md'));
  }

  function plantUserSkill(skills: string, name: string) {
    const dir = path.join(skills, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: user-owned\n---\n');
  }

  test('payload gone: dangling SKILL.md orphan is removed, user skill stays', () => {
    const r = runCleanup({
      payload: false,
      plant(skills) {
        plantDanglingSkillMd(skills, 'qa');
        plantUserSkill(skills, 'my-own');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('cleaned up old entries: qa');
      expect(r.names).toEqual(['my-own']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('payload gone: whole-dir symlink into gstack/ is removed', () => {
    const r = runCleanup({
      payload: false,
      plant(skills) {
        fs.symlinkSync('gstack/qa', path.join(skills, 'qa'));
        plantUserSkill(skills, 'my-own');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['my-own']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('payload present: leftover flat name pointing at gstack is still removed', () => {
    const r = runCleanup({
      payload: true,
      plant(skills, payload) {
        const src = path.join(payload, 'qa');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: qa\n---\n');
        plantDanglingSkillMd(skills, 'qa');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['gstack']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('payload present: dangling name absent from the payload is still removed', () => {
    // Unique dest-scan win: the old "$gstack_dir"/*/ loop only considered
    // names that still exist in the payload. A retired leftover must go.
    const r = runCleanup({
      payload: true,
      plant(skills, payload) {
        const src = path.join(payload, 'ship');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: ship\n---\n');
        plantDanglingSkillMd(skills, 'qa');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['gstack']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('does not remove a SKILL.md symlink that does not point at gstack', () => {
    const r = runCleanup({
      payload: false,
      plant(skills) {
        const dir = path.join(skills, 'elsewhere');
        fs.mkdirSync(dir);
        fs.symlinkSync('other/SKILL.md', path.join(dir, 'SKILL.md'));
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.names).toEqual(['elsewhere']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('does not remove a SKILL.md whose target merely contains the substring gstack', () => {
    const r = runCleanup({
      payload: false,
      plant(skills) {
        const dir = path.join(skills, 'notes');
        fs.mkdirSync(dir);
        fs.symlinkSync('../../archive/my-gstack-backup/SKILL.md', path.join(dir, 'SKILL.md'));
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.names).toEqual(['notes']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('reaps a leftover whose SKILL.md points at the user render dir', () => {
    const r = runCleanup({
      payload: false,
      plant(skills) {
        const dir = path.join(skills, 'qa');
        fs.mkdirSync(dir);
        fs.symlinkSync('../../.gstack/render/claude/qa/SKILL.md', path.join(dir, 'SKILL.md'));
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('cleaned up old entries: qa');
      expect(r.names).toEqual([]);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('does not remove prefixed gstack-* names or the payload dir', () => {
    const r = runCleanup({
      payload: true,
      plant(skills, payload) {
        fs.writeFileSync(path.join(payload, 'SKILL.md'), '---\nname: gstack\n---\n');
        const prefixed = path.join(skills, 'gstack-qa');
        fs.mkdirSync(prefixed);
        fs.symlinkSync('gstack/qa/SKILL.md', path.join(prefixed, 'SKILL.md'));
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['gstack', 'gstack-qa']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('Windows real-file orphan is left alone when the payload is gone', () => {
    const r = runCleanup({
      isWindows: '1',
      payload: false,
      plant(skills) {
        plantUserSkill(skills, 'qa');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['qa']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  test('Windows real-file leftover is removed when the payload still names it', () => {
    const r = runCleanup({
      isWindows: '1',
      payload: true,
      plant(skills, payload) {
        const src = path.join(payload, 'qa');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: qa\n---\n');
        plantUserSkill(skills, 'qa');
        plantUserSkill(skills, 'my-own');
      },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.names).toEqual(['gstack', 'my-own']);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });
});
