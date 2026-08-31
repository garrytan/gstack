/**
 * TEMP_DIRS portability allowlist (platform.ts) and its path-security wiring.
 *
 * TEMP_DIRS widens LOCAL path validation to include os.tmpdir() — on macOS
 * that is the per-user /var/folders dir, and TMPDIR-honoring CI/sandbox
 * environments point it elsewhere entirely. The load-bearing SECURITY
 * invariant is asymmetry: SAFE_DIRECTORIES (local read/write) gains
 * os.tmpdir(), while validateTempPath (REMOTE file serving, GET /file) stays
 * pinned to classic TEMP_DIR alone — widening that one would let a tunnel
 * client fetch files from an arbitrary TMPDIR (e.g. $HOME/tmp).
 */
import { describe, it, expect } from 'bun:test';
import { TEMP_DIR, TEMP_DIRS, IS_WINDOWS, isPathWithin } from '../src/platform';
import { SAFE_DIRECTORIES, validateOutputPath, validateReadPath, validateTempPath } from '../src/path-security';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
const tmpdirIsDistinct = real(os.tmpdir()) !== real(TEMP_DIR);

describe('TEMP_DIRS allowlist shape', () => {
  it('contains exactly TEMP_DIR + os.tmpdir() deduped, and SAFE_DIRECTORIES wires them realpathed alongside cwd', () => {
    expect(TEMP_DIRS).toContain(TEMP_DIR);
    expect(TEMP_DIRS).toContain(os.tmpdir());
    expect(new Set(TEMP_DIRS).size).toBe(TEMP_DIRS.length);
    // Nothing else sneaks into the allowlist.
    for (const d of TEMP_DIRS) {
      expect([TEMP_DIR, os.tmpdir()]).toContain(d);
    }
    expect(SAFE_DIRECTORIES).toContain(real(os.tmpdir()));
    expect(SAFE_DIRECTORIES).toContain(real(process.cwd()));
  });
});

describe('local commands accept os.tmpdir() paths (TMPDIR-honoring environments)', () => {
  it('validateReadPath allows an existing file under os.tmpdir()', () => {
    const f = path.join(os.tmpdir(), `browse-tempdirs-read-${Date.now()}.js`);
    fs.writeFileSync(f, 'document.title');
    try {
      expect(() => validateReadPath(f)).not.toThrow();
    } finally {
      fs.unlinkSync(f);
    }
  });

  it('validateOutputPath allows a new (not-yet-existing) file under os.tmpdir()', () => {
    const f = path.join(os.tmpdir(), `browse-tempdirs-out-${Date.now()}.png`);
    expect(() => validateOutputPath(f)).not.toThrow();
    expect(fs.existsSync(f)).toBe(false); // validation never creates the file
  });
});

describe('remote file serving stays pinned to TEMP_DIR alone (no exfil widening)', () => {
  it('validateTempPath REJECTS a project file the local allowlist accepts — the actual exfil boundary, on every topology', () => {
    // cwd is in SAFE_DIRECTORIES (local commands read project files) but must
    // NEVER be servable to a remote agent. Unlike the os.tmpdir() case below,
    // this holds regardless of where the environment points TMPDIR.
    const f = path.join(process.cwd(), 'package.json');
    expect(() => validateReadPath(f)).not.toThrow();
    expect(() => validateTempPath(f)).toThrow(/temp directory/i);
  });

  it('validateTempPath and a distinct os.tmpdir(): rejected outside TEMP_DIR, allowed when nested inside it', () => {
    if (!tmpdirIsDistinct) {
      // On hosts where os.tmpdir() IS /tmp the widening is a no-op — the
      // allowlist must have collapsed to the single dir.
      expect(TEMP_DIRS).toEqual([TEMP_DIR]);
      return;
    }
    const f = path.join(os.tmpdir(), `browse-tempdirs-remote-${Date.now()}.txt`);
    fs.writeFileSync(f, 'served?');
    try {
      // Local commands accept it on every topology.
      expect(() => validateReadPath(f)).not.toThrow();
      if (isPathWithin(real(os.tmpdir()), real(TEMP_DIR))) {
        // CI shard topology: the runner nests each child's TMPDIR INSIDE
        // /tmp (e.g. /tmp/gstack-free-shard-*/tmp). The file is under
        // TEMP_DIR, so serving it remotely is legitimate — the boundary
        // under test is TEMP_DIR, not os.tmpdir() identity.
        expect(() => validateTempPath(f)).not.toThrow();
      } else {
        // os.tmpdir() genuinely outside TEMP_DIR (macOS /var/folders,
        // TMPDIR=$HOME/tmp sandboxes): the local-only allowlist must never
        // reach the remote surface.
        expect(() => validateTempPath(f)).toThrow(/temp directory/i);
      }
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe('untrustable TMPDIR values never widen the allowlist', () => {
  // TEMP_DIRS is computed at module load from os.tmpdir(), which honors
  // TMPDIR — so a daemon launched with TMPDIR=/ or TMPDIR=$HOME must not
  // trust that subtree for its whole lifetime. Probed via a subprocess so
  // each case gets a fresh module load.
  //
  // POSIX-only: on Windows TEMP_DIR is DEFINED as os.tmpdir() (which reads
  // TEMP/TMP, not TMPDIR), so the fixed-dir + movable-dir topology the guard
  // filters does not exist — overriding the temp env vars there moves
  // TEMP_DIR itself, and there is never a second entry to distrust.
  const itPosix = IS_WINDOWS ? it.skip : it;

  const probe = (tmpdir: string): string[] => {
    const r = Bun.spawnSync([
      process.execPath, '-e',
      "import { TEMP_DIRS } from './browse/src/platform'; console.log(JSON.stringify(TEMP_DIRS));",
    ], { env: { ...process.env, TMPDIR: tmpdir }, cwd: path.resolve(import.meta.dir, '..', '..') });
    return JSON.parse(r.stdout.toString().trim().split('\n').pop()!);
  };

  itPosix('TMPDIR=/ and TMPDIR=$HOME collapse to TEMP_DIR alone; a cwd ancestor is rejected too', () => {
    expect(probe('/')).toEqual([TEMP_DIR]);
    expect(probe(os.homedir())).toEqual([TEMP_DIR]);
    // Parent of the daemon cwd (the repo checkout's parent) — rejected.
    expect(probe(path.resolve(import.meta.dir, '..', '..', '..'))).toEqual([TEMP_DIR]);
  });

  itPosix('a benign distinct TMPDIR (e.g. $HOME/tmp) is still honored for local paths', () => {
    const benign = fs.mkdtempSync(path.join(os.homedir(), 'browse-tmp-probe-'));
    try {
      expect(probe(benign).map(real)).toContain(real(benign));
    } finally {
      fs.rmdirSync(benign);
    }
  });
});
