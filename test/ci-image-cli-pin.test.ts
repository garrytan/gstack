/**
 * Provider CLIs baked into the CI image must be pinned to EXACT versions.
 *
 * The PTY harness (test/helpers/claude-pty-runner.ts) screen-scrapes the
 * claude CLI's TUI — trust dialog, input-prompt ready marker, spinner glyphs.
 * The image used to install `npm i -g @anthropic-ai/claude-code` UNPINNED and
 * rebuild weekly "to pick up CLI updates", while bun sat carefully pinned at
 * 1.3.13 two RUN lines above — the exact drift class the bun pin exists for.
 * Receipts: TUI drift broke the harness three separate times (welcome-screen
 * wedge vs CLI 2.1.233, skillify HOME discovery on 2.1.237, guard/freeze
 * hooks on 2.1.162), each debugged as a "flake" before being traced to an
 * unpinned weekly-latest CLI.
 *
 * This tripwire fails the free suite when any globally-installed npm package
 * in Dockerfile.ci lacks an exact `@X.Y.Z` pin. Bumps are deliberate: edit
 * the pin in a PR and run the PTY gate against the new TUI before merging.
 *
 * Bun comes from its release archive, verified by SHA-256 for every
 * architecture the image builds (#1706): nothing in the image is piped from
 * curl into a shell.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = path.join(ROOT, '.github', 'docker', 'Dockerfile.ci');

/** Package specs from every `npm i -g` / `npm install -g` in the Dockerfile. */
export function globalNpmInstallSpecs(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(/npm\s+(?:i|install)\s+(?:-g|--global)\s+([^\n\\&|;]+)/g)) {
    for (const spec of match[1].trim().split(/\s+/)) {
      if (spec.startsWith('-')) continue; // flags like --no-fund
      specs.push(spec);
    }
  }
  return specs;
}

/** Exact pin = a trailing @<semver> with no range operator (no ^ ~ x *). */
export function isExactlyPinned(spec: string): boolean {
  // Scoped (@scope/name@1.2.3) or bare (name@1.2.3); version must be exact.
  const at = spec.lastIndexOf('@');
  if (at <= 0) return false; // no version at all (or a bare scope)
  const version = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version);
}

describe('ci image provider-CLI pins', () => {
  const source = fs.readFileSync(DOCKERFILE, 'utf-8');
  const specs = globalNpmInstallSpecs(source);

  test('the image installs at least the claude CLI globally (scan must not rot)', () => {
    expect(
      specs.some((s) => s.startsWith('@anthropic-ai/claude-code@')),
      `expected a pinned @anthropic-ai/claude-code install in ${path.relative(ROOT, DOCKERFILE)}; found: ${specs.join(', ') || '(none)'}`,
    ).toBe(true);
  });

  test('every global npm install carries an exact @X.Y.Z pin', () => {
    const unpinned = specs.filter((s) => !isExactlyPinned(s));
    expect(
      unpinned,
      `unpinned global npm installs in Dockerfile.ci: ${unpinned.join(', ')}\n`
      + 'Pin the exact version (name@X.Y.Z) and bump via a PR that runs the '
      + 'PTY gate against the new TUI — weekly-latest CLI drift broke the '
      + 'harness three times before this tripwire existed.',
    ).toHaveLength(0);
  });

  test('the image installs the codex CLI globally so the Codex evals execute in CI', () => {
    expect(
      specs.some((s) => s.startsWith('@openai/codex@')),
      `expected a pinned @openai/codex install in ${path.relative(ROOT, DOCKERFILE)}; found: ${specs.join(', ')}`,
    ).toBe(true);
  });
});

/** Dockerfile source with `\`-continued lines joined into logical lines. */
function logicalLines(source: string): string[] {
  return source.replace(/\\\n/g, ' ').split('\n');
}

/** Logical lines that pipe a download straight into a shell. */
export function curlPipedToShell(source: string): string[] {
  return logicalLines(source).filter((line) => !/^\s*#/.test(line) &&
    /\b(?:curl|wget)\b/.test(line) && /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(line));
}

/** `<arch>) bun_target=...; bun_sha256=<hex>` arms of the Bun install `case`. */
export function bunArchiveArms(source: string): Map<string, string> {
  const arms = new Map<string, string>();
  for (const m of source.matchAll(/^\s*([\w|]+)\)\s*bun_target=[\w-]+;\s*bun_sha256=([0-9a-f]+)\s*;;/gm)) {
    for (const arch of m[1].split('|')) arms.set(arch, m[2]);
  }
  return arms;
}

/** Docker architectures each build of Dockerfile.ci produces (no `platforms:` = the amd64 runner's). */
export function builtArchitectures(workflowsDir: string): Set<string> {
  const archs = new Set<string>();
  for (const name of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf-8')) as any;
    for (const job of Object.values<any>(workflow?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (!String(step?.uses ?? '').startsWith('docker/build-push-action@')) continue;
        if (step.with?.file !== '.github/docker/Dockerfile.ci') continue;
        const platforms = String(step.with?.platforms ?? 'linux/amd64').split(/[\s,]+/).filter(Boolean);
        for (const platform of platforms) archs.add(platform.replace(/^linux\//, ''));
      }
    }
  }
  return archs;
}

describe('ci image Bun install (#1706)', () => {
  const source = fs.readFileSync(DOCKERFILE, 'utf-8');
  const bunRun = logicalLines(source).find((line) => line.includes('oven-sh/bun/releases/download/bun-v${BUN_VERSION}/')) ?? '';

  test('nothing is piped from a download into a shell', () => {
    expect(curlPipedToShell(source), 'download the release archive and verify its SHA-256 instead').toEqual([]);
  });

  test('the tripwire recognizes the old installer pipe and leaves non-shell pipes alone', () => {
    expect(curlPipedToShell('RUN curl -fsSL https://bun.sh/install \\\n    | bash -s "bun-v1.4.0"\n')).toHaveLength(1);
    expect(curlPipedToShell('RUN curl -fsSL https://example.test/x.sh | sh\n')).toHaveLength(1);
    expect(curlPipedToShell('RUN curl -fsSL https://example.test/key.gpg | gpg --dearmor -o /k.gpg\n')).toEqual([]);
  });

  test('every architecture the image builds has a SHA-256-verified Bun archive', () => {
    const built = builtArchitectures(path.join(ROOT, '.github', 'workflows'));
    expect([...built], 'scan found no Dockerfile.ci build').toContain('amd64');
    const arms = bunArchiveArms(source);
    for (const arch of built) {
      expect(arms.get(arch), `no verified Bun archive for ${arch}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the archive is checked before it is unpacked, and unknown architectures fail closed', () => {
    expect(bunRun, 'Bun must come from the GitHub release archive').not.toBe('');
    const download = bunRun.indexOf('releases/download/');
    const verify = bunRun.indexOf('sha256sum -c');
    const unpack = bunRun.indexOf('unzip');
    expect(verify).toBeGreaterThan(download);
    expect(unpack).toBeGreaterThan(verify);
    expect(bunRun).toMatch(/\*\)(?:(?!;;).)*exit 1\s*;;/);
    expect(bunRun).toContain('test "$(bun --version)" = "${BUN_VERSION}"');
  });
});

describe('ci image codex authentication', () => {
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  const lanes: Array<{ lane: string; steps: any[] }> = [];
  for (const name of fs.readdirSync(workflowsDir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf-8')) as any;
    for (const [id, job] of Object.entries<any>(workflow?.jobs ?? {})) {
      const steps: any[] = job?.steps ?? [];
      if (job?.container && steps.some((step) => /test-paid-shards\.ts .*--slice/.test(String(step?.run ?? '')))) {
        lanes.push({ lane: `${name}:${id}`, steps });
      }
    }
  }

  test('every paid lane in the image logs the codex CLI in from the secret before it runs', () => {
    expect(lanes.length, 'scan found no paid lanes').toBeGreaterThanOrEqual(4);
    for (const { lane, steps } of lanes) {
      const login = steps.findIndex((step) => /codex"? login --with-api-key/.test(String(step?.run ?? '')));
      const run = steps.findIndex((step) => /test-paid-shards\.ts .*--slice/.test(String(step?.run ?? '')));
      expect(login, `${lane}: no codex login step`).toBeGreaterThanOrEqual(0);
      expect(login, `${lane}: codex login must precede the paid run`).toBeLessThan(run);
      const step = steps[login];
      expect(step.env?.OPENAI_API_KEY, `${lane}: key must arrive through env`).toBe('${{ secrets.OPENAI_API_KEY }}');
      expect(String(step.run), `${lane}: never inline a secret into run`).not.toContain('secrets.');
      expect(String(step.run)).toMatch(/codex"? login status/);
      expect(String(step.if ?? ''), `${lane}: same-repo runs only`)
        .toBe("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
    }
  });
});

describe('other CI Bun installs match the image (#1713, #1706)', () => {
  const docker = fs.readFileSync(DOCKERFILE, 'utf-8');
  const imageSha = bunArchiveArms(docker).get('amd64');
  const imageVersion = docker.match(/^ARG BUN_VERSION=(\S+)$/m)?.[1];
  const engines = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).engines.bun;

  for (const rel of ['.gitlab-ci.yml', 'scripts/ubicloud/setup-free-suite.sh']) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} downloads the verified linux-x64 archive instead of piping an installer into a shell`, () => {
      expect(curlPipedToShell(source)).toEqual([]);
      const download = source.indexOf('/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip');
      const verify = source.indexOf('sha256sum -c');
      const unpack = source.indexOf('unzip -q');
      expect(download).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(download);
      expect(unpack).toBeGreaterThan(verify);
      expect(source).toContain('test "$(bun --version)" = "$BUN_VERSION"');
    });

    test(`${rel} links bunx next to the verified bun, as the bun.sh installer did`, () => {
      expect(source).toContain('ln -sf bun "$HOME/.bun/bin/bunx"');
      expect(source.indexOf('ln -sf bun "$HOME/.bun/bin/bunx"')).toBeGreaterThan(source.indexOf('unzip -q'));
    });

    test(`${rel} pins the same Bun version and SHA-256 as Dockerfile.ci`, () => {
      expect(imageSha).toMatch(/^[0-9a-f]{64}$/);
      const hashes = [...source.matchAll(/echo "([0-9a-f]{64}) /g)].map((m) => m[1]);
      expect(hashes).toEqual([imageSha!]);
      const version = source.match(/^\s*BUN_VERSION[=:]\s*"?([\d.]+)"?\s*$/m)?.[1];
      expect(version).toBe(imageVersion!);
      expect(engines).toBe(`>=${imageVersion}`);
    });
  }
});
