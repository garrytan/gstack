/**
 * One Bun version across every CI surface.
 *
 * The drift class this pins: Dockerfile.ci's comment records that the old
 * `| BUN_VERSION=x.y.z bash` form silently installed latest on every image
 * rebuild (observed 1.3.13/1.3.14 drift vs the 1.3.10 devs ran locally),
 * and before 2026-08-29 the lanes disagreed four ways (1.3.13 / latest /
 * unpinned / 1.3.10). Different Bun versions change test-runner OUTPUT
 * SHAPES the strict classifiers regex-match, spawn semantics, and shell
 * parsing — a lane on a different Bun is testing a different product.
 *
 * Bumping Bun: change every surface in one commit; this test names each one.
 *
 * E1: bin/gstack-bun-version.sh is the one source setup and the auto-updater
 * read. Its tested version is the CI pin, engines.bun's lower bound, setup's
 * install hint and README's requirement; its floor (1.3.3) is the security
 * boundary below which the no-autoload compile flags are silently ignored.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

interface Pin {
  surface: string;
  version: string;
}

function collectPins(): Pin[] {
  const pins: Pin[] = [];

  for (const name of fs.readdirSync(WORKFLOWS_DIR).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/uses:\s*oven-sh\/setup-bun@/.test(lines[i])) continue;
      // A pinned stanza is `with:` + `bun-version: <v>` within the next few
      // lines; an unpinned setup-bun is itself drift (installs latest).
      const window = lines.slice(i + 1, i + 4).join('\n');
      const m = window.match(/bun-version:\s*["']?([\w.]+)["']?/);
      pins.push({
        surface: `${name}:${i + 1}`,
        version: m ? m[1] : '<unpinned setup-bun — installs latest>',
      });
    }
  }

  const dockerfile = fs.readFileSync(
    path.join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf-8');
  const dockerPin = dockerfile.match(/^ARG BUN_VERSION=["']?([\w.]+)["']?$/m);
  pins.push({
    surface: 'Dockerfile.ci',
    version: dockerPin ? dockerPin[1] : '<no ARG BUN_VERSION=X.Y.Z>',
  });

  const gitlab = fs.readFileSync(path.join(ROOT, '.gitlab-ci.yml'), 'utf-8');
  const gitlabPin = gitlab.match(/BUN_VERSION:\s*["']?([\w.]+)["']?/);
  pins.push({
    surface: '.gitlab-ci.yml',
    version: gitlabPin ? gitlabPin[1] : '<no BUN_VERSION>',
  });

  return pins;
}

describe('bun version pins', () => {
  test('every CI surface pins the same bun version', () => {
    const pins = collectPins();
    // Sanity: the scan found the known surfaces (a regex rot that finds
    // nothing must fail loudly, not vacuously pass).
    expect(pins.length).toBeGreaterThanOrEqual(6);

    const versions = [...new Set(pins.map((p) => p.version))];
    const detail = pins.map((p) => `${p.surface} → ${p.version}`).join('\n');
    expect(versions, `bun version drift across CI surfaces:\n${detail}`).toHaveLength(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('every CI surface requires Bun 1.4.0 or newer for safe extra-stdio ownership', () => {
    // Matching pins alone would allow every lane to regress together. Older
    // Linux Bun releases double-close extra stdio FDs during subprocess GC,
    // which can close unrelated listeners after the OS reuses an FD number.
    // https://github.com/oven-sh/bun/issues/34785#issuecomment-5020318035
    for (const pin of collectPins()) {
      expect(pin.version, `${pin.surface} must pin a stable numeric version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        Bun.semver.satisfies(pin.version, '>=1.4.0'),
        `${pin.surface} pins Bun ${pin.version}; Bun >=1.4.0 is required for safe extra-stdio ownership`,
      ).toBe(true);
    }
  });
});

function bunVersionsFile(): { floor: string; tested: string } {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-bun-version.sh'), 'utf-8');
  return {
    floor: src.match(/^GSTACK_BUN_FLOOR="([^"]+)"$/m)?.[1] ?? '<no GSTACK_BUN_FLOOR>',
    tested: src.match(/^GSTACK_BUN_TESTED="([^"]+)"$/m)?.[1] ?? '<no GSTACK_BUN_TESTED>',
  };
}

describe('Bun requirement surfaces agree (E1)', () => {
  const { floor, tested } = bunVersionsFile();

  test('tested version == every CI pin == engines.bun lower bound; floor sits below it', () => {
    const ciVersions = [...new Set(collectPins().map((p) => p.version))];
    expect(ciVersions).toEqual([tested]);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.engines?.bun).toBe(`>=${tested}`);
    expect(floor).toBe('1.3.3');
    expect(Bun.semver.order(floor, tested)).toBe(-1);
  });

  test('README states the tested version and the floor', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
    expect(readme).toContain(`[Bun](https://bun.sh/) v${tested}+`);
    expect(readme).toContain(`refuses Bun older than ${floor}`);
  });

  test.skipIf(process.platform === 'win32')('setup install hint pins the tested version', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-hint-'));
    try {
      const nobun = path.join(base, 'bin');
      fs.mkdirSync(nobun);
      for (const tool of ['dirname', 'cat', 'uname', 'mkdir']) {
        const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8', timeout: 10_000 }).stdout.trim();
        if (found) fs.symlinkSync(found, path.join(nobun, tool));
      }
      const r = spawnSync('/bin/bash', [path.join(ROOT, 'setup')], {
        encoding: 'utf-8', env: { PATH: nobun, HOME: base }, timeout: 30_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('bun is required but not installed');
      expect(r.stderr).toContain(`BUN_VERSION="${tested}"`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('the Capy installer\'s linux-x64 archive checksum is the one Dockerfile.ci verifies', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-bun-version.sh'), 'utf-8');
    const dockerfile = fs.readFileSync(path.join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf-8');
    const shSha = src.match(/^\s*linux-x64\) echo ([0-9a-f]{64}) ;;$/m)?.[1];
    const dockerSha = dockerfile.match(/bun_target=linux-x64; bun_sha256=([0-9a-f]{64})/)?.[1];
    expect(shSha, 'gstack_bun_archive_sha256 linux-x64').toBeDefined();
    expect(shSha).toBe(dockerSha);
    const r = spawnSync('bash', ['-c', `. "${path.join(ROOT, 'bin', 'gstack-bun-version.sh')}" && gstack_bun_archive_sha256 linux-x64 && gstack_bun_archive_sha256 linux-x64-baseline && gstack_bun_archive_sha256 linux-aarch64 && ! gstack_bun_archive_sha256 darwin-arm64`], { encoding: 'utf-8', timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(3);
  });

  test('BROWSE SETUP install hint pins the tested version', () => {
    const resolver = fs.readFileSync(path.join(ROOT, 'scripts', 'resolvers', 'browse.ts'), 'utf-8');
    expect([...resolver.matchAll(/BUN_VERSION="([0-9][^"]*)"/g)].map((m) => m[1])).toEqual([tested]);
  });

  // Compiled probe of the security floor: a binary built with the four
  // no-autoload flags must not read a .env beside it. Run by hand against
  // released binaries on 2026-10-04: Bun 1.3.2 accepted the flags and still
  // loaded .env; 1.3.3 and 1.4.0 did not. This keeps the probe honest on the
  // Bun under test (the CI pin); the control build proves the probe can see a leak.
  test.skipIf(process.platform === 'win32')('compiled probe: the no-autoload flags hold on the Bun under test', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-probe-'));
    try {
      fs.writeFileSync(path.join(base, 'probe.ts'), 'console.log(process.env.GSTACK_BUN_PROBE ?? "absent");\n');
      const run = path.join(base, 'run');
      fs.mkdirSync(run);
      fs.writeFileSync(path.join(run, '.env'), 'GSTACK_BUN_PROBE=leaked\n');
      const build = (out: string, flags: string[]) => {
        const r = spawnSync(process.execPath, ['build', '--compile', ...flags, 'probe.ts', '--outfile', out], {
          cwd: base, encoding: 'utf-8', timeout: 120_000,
        });
        expect(r.status, r.stderr).toBe(0);
        return spawnSync(path.join(base, out), [], { cwd: run, encoding: 'utf-8', timeout: 30_000 }).stdout.trim();
      };
      expect(build('control', [])).toBe('leaked');
      expect(build('guarded', [
        '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
        '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json',
      ])).toBe('absent');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);
});
