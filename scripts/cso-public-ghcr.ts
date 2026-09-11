#!/usr/bin/env bun
/** Release-only proof that a CSO image is public and anonymously pullable. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLATFORM = /^linux\/(amd64|arm64)$/;
const RUNTIME = /^(node|bun|python|rails|postgresql)-(amd64|arm64)$/;
const SCANNER = /^(gitleaks|osv|semgrep|zizmor|trivy|schemathesis)-(amd64|arm64)$/;
const MAX_HTTP_BYTES = 64 * 1024;
const MAX_DOCKER_OUTPUT = 64 * 1024;
const DOCKER_TIMEOUT_MS = 10 * 60 * 1000;

export interface PublicGhcrTarget {
  image: string;
  owner: string;
  repository: string;
  packageName: string;
  digest: string;
  platform: 'linux/amd64' | 'linux/arm64';
}

export interface PublicImageProof {
  schemaVersion: 1;
  image: string;
  platform: 'linux/amd64' | 'linux/arm64';
  packageName: string;
  packageVisibility: 'public';
  packageApiUrl: string;
  anonymousPull: 'passed';
  dockerConfig: 'isolated-empty-auths';
  verifiedAt: string;
}

interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface PublicGhcrDependencies {
  fetch: typeof globalThis.fetch;
  githubToken: string;
  dockerPath: string;
  runDocker: (args: string[], env: Record<string, string>) => Promise<CommandResult>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

function fail(message: string): never { throw new Error(message); }

export function parsePublicGhcrTarget(image: string, platform: string, githubRepository: string): PublicGhcrTarget {
  if (!REPOSITORY.test(githubRepository)) fail('INVALID_GITHUB_REPOSITORY');
  const platformMatch = PLATFORM.exec(platform);
  if (!platformMatch) fail('INVALID_PUBLIC_IMAGE_PLATFORM');
  const normalizedRepository = githubRepository.toLowerCase();
  const prefix = `ghcr.io/${normalizedRepository}/`;
  if (!image.startsWith(prefix)) fail('PUBLIC_IMAGE_REPOSITORY_MISMATCH');
  const at = image.lastIndexOf('@');
  if (at < prefix.length || image.indexOf('@') !== at) fail('PUBLIC_IMAGE_MUST_BE_DIGEST_PINNED');
  const suffix = image.slice(prefix.length, at), digest = image.slice(at + 1);
  if (!DIGEST.test(digest)) fail('PUBLIC_IMAGE_MUST_BE_DIGEST_PINNED');
  const [namespace, name, extra] = suffix.split('/');
  if (extra || !name || !['cso-staging', 'cso-scanners'].includes(namespace)) fail('INVALID_PUBLIC_IMAGE_PACKAGE');
  const nameMatch = namespace === 'cso-staging' ? RUNTIME.exec(name) : SCANNER.exec(name);
  if (!nameMatch || nameMatch[2] !== platformMatch[1]) fail('PUBLIC_IMAGE_PLATFORM_MISMATCH');
  const [owner, repository] = normalizedRepository.split('/');
  return {
    image,
    owner,
    repository,
    packageName: `${repository}/${namespace}/${name}`,
    digest,
    platform: platform as PublicGhcrTarget['platform'],
  };
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > MAX_HTTP_BYTES) fail(`${label}_RESPONSE_TOO_LARGE`);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { fail(`${label}_INVALID_RESPONSE`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label}_INVALID_RESPONSE`);
  return parsed as Record<string, unknown>;
}

function publicHeaders(githubToken: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gstack-cso-public-image-verifier',
  };
}

export function assertPublicPackageMetadata(value: Record<string, unknown>, target: PublicGhcrTarget): void {
  const owner = value.owner;
  if (value.name !== target.packageName || value.package_type !== 'container' || value.visibility !== 'public' ||
      !owner || typeof owner !== 'object' || Array.isArray(owner) ||
      typeof (owner as Record<string, unknown>).login !== 'string' ||
      ((owner as Record<string, unknown>).login as string).toLowerCase() !== target.owner) {
    fail('GHCR_PACKAGE_IS_NOT_PUBLIC');
  }
}

async function publicPackageApi(target: PublicGhcrTarget, deps: PublicGhcrDependencies): Promise<string> {
  const ownerUrl = `https://api.github.com/users/${encodeURIComponent(target.owner)}`;
  const ownerResponse = await deps.fetch(ownerUrl, { headers: publicHeaders(deps.githubToken), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (ownerResponse.status !== 200) fail(`PUBLIC_OWNER_LOOKUP_FAILED: HTTP ${ownerResponse.status}`);
  const owner = await responseJson(ownerResponse, 'PUBLIC_OWNER_LOOKUP');
  if (typeof owner.login !== 'string' || owner.login.toLowerCase() !== target.owner || !['User', 'Organization'].includes(String(owner.type))) {
    fail('PUBLIC_OWNER_LOOKUP_IDENTITY_MISMATCH');
  }
  const collection = owner.type === 'Organization' ? 'orgs' : 'users';
  const packageUrl = `https://api.github.com/${collection}/${encodeURIComponent(target.owner)}/packages/container/${encodeURIComponent(target.packageName)}`;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await deps.fetch(packageUrl, { headers: publicHeaders(deps.githubToken), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    lastStatus = response.status;
    if (response.status === 200) {
      assertPublicPackageMetadata(await responseJson(response, 'PUBLIC_PACKAGE_LOOKUP'), target);
      return packageUrl;
    }
    await response.body?.cancel();
    if (attempt < 6 && [404, 429, 500, 502, 503, 504].includes(response.status)) await deps.sleep(attempt * 2_000);
    else break;
  }
  fail(`GHCR_PACKAGE_IS_NOT_PUBLIC: authenticated GitHub Packages metadata lookup returned HTTP ${lastStatus}`);
}

function cleanDockerEnvironment(configRoot: string, dockerHost: string): Record<string, string> {
  return {
    HOME: configRoot,
    DOCKER_CONFIG: configRoot,
    DOCKER_HOST: dockerHost,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: configRoot,
  };
}

async function defaultRunDocker(dockerPath: string, args: string[], env: Record<string, string>): Promise<CommandResult> {
  const process = Bun.spawn([dockerPath, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => process.kill(), DOCKER_TIMEOUT_MS);
  const boundedText = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DOCKER_OUTPUT) {
          process.kill();
          await reader.cancel();
          fail('ANONYMOUS_DOCKER_OUTPUT_LIMIT');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
    } finally { reader.releaseLock(); }
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedText(process.stdout),
      boundedText(process.stderr),
      process.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

function dockerError(label: string, result: CommandResult): never {
  const detail = result.stderr.trim().slice(0, 2048);
  fail(`${label}${detail ? `: ${detail}` : ''}`);
}

export async function verifyPublicGhcrImage(
  options: { image: string; platform: string; githubRepository: string; dockerHost?: string; removeAfter?: boolean },
  dependencies?: Partial<PublicGhcrDependencies>,
): Promise<PublicImageProof> {
  const target = parsePublicGhcrTarget(options.image, options.platform, options.githubRepository);
  const dockerHost = options.dockerHost ?? 'unix:///var/run/docker.sock';
  if (dockerHost !== 'unix:///var/run/docker.sock') fail('UNTRUSTED_PUBLIC_IMAGE_DOCKER_HOST');
  const dockerPath = dependencies?.dockerPath ?? Bun.which('docker') ?? '';
  if (!path.isAbsolute(dockerPath)) fail('DOCKER_UNAVAILABLE');
  const githubToken = dependencies?.githubToken ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  if (!githubToken || githubToken.length > 2048 || /[\r\n]/.test(githubToken)) fail('GITHUB_PACKAGE_METADATA_TOKEN_REQUIRED');
  const deps: PublicGhcrDependencies = {
    fetch: dependencies?.fetch ?? globalThis.fetch,
    githubToken,
    dockerPath,
    runDocker: dependencies?.runDocker ?? ((args, env) => defaultRunDocker(dockerPath, args, env)),
    now: dependencies?.now ?? (() => new Date().toISOString()),
    sleep: dependencies?.sleep ?? (ms => Bun.sleep(ms)),
  };
  const packageApiUrl = await publicPackageApi(target, deps);
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cso-anonymous-docker-'));
  fs.chmodSync(configRoot, 0o700);
  fs.writeFileSync(path.join(configRoot, 'config.json'), '{"auths":{}}\n', { flag: 'wx', mode: 0o600 });
  const env = cleanDockerEnvironment(configRoot, dockerHost);
  let pulled = false;
  try {
    const pull = await deps.runDocker([
      '--config', configRoot, '--host', dockerHost, 'image', 'pull', '--quiet', '--platform', target.platform, target.image,
    ], env);
    if (pull.exitCode !== 0) dockerError('ANONYMOUS_IMAGE_PULL_FAILED', pull);
    pulled = true;
    const inspect = await deps.runDocker([
      '--config', configRoot, '--host', dockerHost, 'image', 'inspect', target.image, '--format', '{{json .RepoDigests}}',
    ], env);
    if (inspect.exitCode !== 0) dockerError('ANONYMOUS_IMAGE_INSPECT_FAILED', inspect);
    let repoDigests: unknown;
    try { repoDigests = JSON.parse(inspect.stdout.trim()); } catch { fail('ANONYMOUS_IMAGE_INSPECT_INVALID'); }
    if (!Array.isArray(repoDigests) || !repoDigests.includes(target.image)) fail('ANONYMOUS_IMAGE_DIGEST_MISMATCH');
    return {
      schemaVersion: 1,
      image: target.image,
      platform: target.platform,
      packageName: target.packageName,
      packageVisibility: 'public',
      packageApiUrl,
      anonymousPull: 'passed',
      dockerConfig: 'isolated-empty-auths',
      verifiedAt: deps.now(),
    };
  } finally {
    if (pulled && options.removeAfter) {
      const remove = await deps.runDocker([
        '--config', configRoot, '--host', dockerHost, 'image', 'rm', '--force', target.image,
      ], env);
      if (remove.exitCode !== 0) dockerError('ANONYMOUS_IMAGE_CLEANUP_FAILED', remove);
    }
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`MISSING_${name.slice(2).toUpperCase().replaceAll('-', '_')}`);
  args.splice(index, 2);
  return value;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), command = args.shift();
    const image = option(args, '--image'), platform = option(args, '--platform'), repository = option(args, '--repository');
    const output = option(args, '--output'), dockerHost = option(args, '--docker-host');
    const removeAt = args.indexOf('--remove-after'), removeAfter = removeAt >= 0;
    if (removeAfter) args.splice(removeAt, 1);
    if (command !== 'verify' || !image || !platform || !repository || !output || args.length) {
      fail('Usage: cso-public-ghcr.ts verify --image IMAGE@sha256:DIGEST --platform linux/ARCH --repository OWNER/REPO --output PROOF.json [--docker-host unix:///var/run/docker.sock] [--remove-after]');
    }
    const proof = await verifyPublicGhcrImage({ image, platform, githubRepository: repository, dockerHost, removeAfter });
    fs.writeFileSync(path.resolve(output), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(`ANONYMOUS PULL VERIFIED ${proof.image}\n`);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'PUBLIC_IMAGE_VERIFICATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
