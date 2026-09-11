import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertPublicPackageMetadata,
  parsePublicGhcrTarget,
  verifyPublicGhcrImage,
  type PublicGhcrDependencies,
} from '../scripts/cso-public-ghcr';

const HASH = 'a'.repeat(64);
const IMAGE = `ghcr.io/garrytan/gstack/cso-staging/node-amd64@sha256:${HASH}`;

describe('CSO public GHCR release proof', () => {
  test('binds an exact CSO package and digest to its declared platform', () => {
    expect(parsePublicGhcrTarget(IMAGE, 'linux/amd64', 'GarryTan/GStack')).toEqual({
      image: IMAGE,
      owner: 'garrytan',
      repository: 'gstack',
      packageName: 'gstack/cso-staging/node-amd64',
      digest: `sha256:${HASH}`,
      platform: 'linux/amd64',
    });
    expect(parsePublicGhcrTarget(
      `ghcr.io/garrytan/gstack/cso-scanners/semgrep-arm64@sha256:${HASH}`,
      'linux/arm64',
      'garrytan/gstack',
    ).packageName).toBe('gstack/cso-scanners/semgrep-arm64');
  });

  test('rejects tags, foreign repositories, unknown packages, and platform substitution', () => {
    for (const [image, platform, repository] of [
      ['ghcr.io/garrytan/gstack/cso-staging/node-amd64:latest', 'linux/amd64', 'garrytan/gstack'],
      [IMAGE.replace('garrytan/gstack', 'attacker/gstack'), 'linux/amd64', 'garrytan/gstack'],
      [IMAGE.replace('node-amd64', 'unknown-amd64'), 'linux/amd64', 'garrytan/gstack'],
      [IMAGE, 'linux/arm64', 'garrytan/gstack'],
    ]) expect(() => parsePublicGhcrTarget(image, platform, repository)).toThrow();
  });

  test('accepts only exact public container metadata for the expected owner', () => {
    const target = parsePublicGhcrTarget(IMAGE, 'linux/amd64', 'garrytan/gstack');
    const valid = { name: target.packageName, package_type: 'container', visibility: 'public', owner: { login: 'GarryTan' } };
    expect(() => assertPublicPackageMetadata(valid, target)).not.toThrow();
    for (const mutation of [
      { ...valid, visibility: 'private' },
      { ...valid, name: 'gstack/cso-staging/other-amd64' },
      { ...valid, package_type: 'npm' },
      { ...valid, owner: { login: 'attacker' } },
    ]) expect(() => assertPublicPackageMetadata(mutation, target)).toThrow('GHCR_PACKAGE_IS_NOT_PUBLIC');
  });

  test('pulls through an isolated empty Docker config and strips ambient credentials', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer metadata-token');
      const value = String(url).includes('/packages/container/')
        ? { name: 'gstack/cso-staging/node-amd64', package_type: 'container', visibility: 'public', owner: { login: 'garrytan' } }
        : { login: 'garrytan', type: 'User' };
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof globalThis.fetch;
    const runDocker: PublicGhcrDependencies['runDocker'] = async (args, env) => {
      calls.push({ args, env });
      const configRoot = args[args.indexOf('--config') + 1];
      expect(fs.readFileSync(`${configRoot}/config.json`, 'utf8')).toBe('{"auths":{}}\n');
      expect(env).not.toHaveProperty('GH_TOKEN');
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env.HOME).toBe(configRoot);
      expect(env.DOCKER_CONFIG).toBe(configRoot);
      if (args.includes('inspect')) return { exitCode: 0, stdout: JSON.stringify([IMAGE]), stderr: '' };
      return { exitCode: 0, stdout: IMAGE, stderr: '' };
    };
    const proof = await verifyPublicGhcrImage(
      { image: IMAGE, platform: 'linux/amd64', githubRepository: 'garrytan/gstack', removeAfter: true },
      { fetch, githubToken: 'metadata-token', dockerPath: '/usr/bin/docker', runDocker, now: () => '2026-09-11T00:00:00.000Z', sleep: async () => {} },
    );
    expect(proof).toMatchObject({ image: IMAGE, packageVisibility: 'public', anonymousPull: 'passed', dockerConfig: 'isolated-empty-auths' });
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toContain('pull');
    expect(calls[0].args).toContain('--quiet');
    expect(calls[2].args).toContain('rm');
  });

  test('fails closed before pulling a non-public package or accepting another digest', async () => {
    let dockerCalls = 0;
    const privateFetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/packages/container/')
        ? { name: 'gstack/cso-staging/node-amd64', package_type: 'container', visibility: 'private', owner: { login: 'garrytan' } }
        : { login: 'garrytan', type: 'User' },
    ), { status: 200 })) as typeof globalThis.fetch;
    await expect(verifyPublicGhcrImage(
      { image: IMAGE, platform: 'linux/amd64', githubRepository: 'garrytan/gstack' },
      { fetch: privateFetch, githubToken: 'metadata-token', dockerPath: '/usr/bin/docker', runDocker: async () => { dockerCalls++; return { exitCode: 0, stdout: '', stderr: '' }; }, sleep: async () => {} },
    )).rejects.toThrow('GHCR_PACKAGE_IS_NOT_PUBLIC');
    expect(dockerCalls).toBe(0);

    const publicFetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/packages/container/')
        ? { name: 'gstack/cso-staging/node-amd64', package_type: 'container', visibility: 'public', owner: { login: 'garrytan' } }
        : { login: 'garrytan', type: 'User' },
    ), { status: 200 })) as typeof globalThis.fetch;
    await expect(verifyPublicGhcrImage(
      { image: IMAGE, platform: 'linux/amd64', githubRepository: 'garrytan/gstack' },
      { fetch: publicFetch, githubToken: 'metadata-token', dockerPath: '/usr/bin/docker', runDocker: async args => args.includes('inspect')
        ? { exitCode: 0, stdout: JSON.stringify([IMAGE.replace(HASH, 'b'.repeat(64))]), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }, sleep: async () => {} },
    )).rejects.toThrow('ANONYMOUS_IMAGE_DIGEST_MISMATCH');
  });

  test('requires scoped GitHub authentication for visibility metadata without passing it to Docker', async () => {
    let fetched = false, pulled = false;
    await expect(verifyPublicGhcrImage(
      { image: IMAGE, platform: 'linux/amd64', githubRepository: 'garrytan/gstack' },
      {
        githubToken: '',
        dockerPath: '/usr/bin/docker',
        fetch: (async () => { fetched = true; return new Response('{}'); }) as typeof globalThis.fetch,
        runDocker: async () => { pulled = true; return { exitCode: 0, stdout: '', stderr: '' }; },
      },
    )).rejects.toThrow('GITHUB_PACKAGE_METADATA_TOKEN_REQUIRED');
    expect(fetched).toBe(false);
    expect(pulled).toBe(false);
  });

  // The public-image release verifier runs in Linux CI. This case exercises
  // its process-kill path with a POSIX shebang fixture; Windows CreateProcess
  // cannot execute that fixture, while the metadata contract above remains
  // portable and continues to run in the curated Windows lane.
  test.skipIf(process.platform === 'win32')('kills a Docker client as soon as bounded output exceeds the release limit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-public-docker-test-'));
    const docker = path.join(directory, 'docker');
    fs.writeFileSync(docker, '#!/bin/sh\npython3 -c "import sys; sys.stdout.write(chr(120) * 70000)"\n', { mode: 0o700 });
    const fetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/packages/container/')
        ? { name: 'gstack/cso-staging/node-amd64', package_type: 'container', visibility: 'public', owner: { login: 'garrytan' } }
        : { login: 'garrytan', type: 'User' },
    ), { status: 200 })) as typeof globalThis.fetch;
    try {
      await expect(verifyPublicGhcrImage(
        { image: IMAGE, platform: 'linux/amd64', githubRepository: 'garrytan/gstack' },
        { fetch, githubToken: 'metadata-token', dockerPath: docker, sleep: async () => {} },
      )).rejects.toThrow('ANONYMOUS_DOCKER_OUTPUT_LIMIT');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
