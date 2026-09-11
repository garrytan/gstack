import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveInstalledRuntimeRoot(moduleDir = import.meta.dir): string {
  const directory = path.resolve(moduleDir);
  if (path.basename(directory) === 'authority' && path.basename(path.dirname(directory)) === 'dist') {
    return path.resolve(directory, '..', '..');
  }
  return path.resolve(directory, '..');
}

const ROOT = resolveInstalledRuntimeRoot();
const VERSION_ARGS = {
  git: ['--version'],
  gh: ['--version'],
  glab: ['--version'],
  bun: ['--version'],
  ssh: ['-V'],
} as const;

export type InstalledToolName = keyof typeof VERSION_ARGS;

export interface InstalledTool {
  realpath: string;
  ownerUid: number;
  mode: number;
  sha256: string;
  version: string;
}

interface ToolEntry {
  realpath?: unknown;
  owner_uid?: unknown;
  mode?: unknown;
  sha256?: unknown;
  version?: unknown;
}

function defaultManifestPath(): string {
  if (process.env.ECPE_TESTING === '1' && process.env.ECPE_TEST_RUNTIME_MANIFEST) {
    return path.resolve(process.env.ECPE_TEST_RUNTIME_MANIFEST);
  }
  return path.join(ROOT, '.ecpe-installed-runtime.json');
}

function sha256(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateEntry(name: InstalledToolName, entry: ToolEntry): InstalledTool {
  if (
    typeof entry.realpath !== 'string' || !path.isAbsolute(entry.realpath)
    || typeof entry.owner_uid !== 'number' || typeof entry.mode !== 'number'
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || typeof entry.version !== 'string' || !entry.version
  ) throw new Error(`tool_manifest_invalid:${name}`);
  const observed = fs.lstatSync(entry.realpath);
  if (
    !observed.isFile() || observed.isSymbolicLink()
    || fs.realpathSync(entry.realpath) !== entry.realpath
    || observed.uid !== entry.owner_uid
    || (observed.mode & 0o777) !== entry.mode
    || (observed.mode & 0o022) !== 0
    || (observed.mode & 0o111) === 0
  ) throw new Error(`tool_attestation_failed:${name}`);
  if (sha256(entry.realpath) !== entry.sha256) throw new Error(`tool_hash_mismatch:${name}`);
  return {
    realpath: entry.realpath,
    ownerUid: entry.owner_uid,
    mode: entry.mode,
    sha256: entry.sha256,
    version: entry.version,
  };
}

export async function resolveInstalledTool(
  name: InstalledToolName,
  options: { manifestPath?: string } = {},
): Promise<InstalledTool> {
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath());
  const info = fs.lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('runtime_manifest_invalid');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    schema?: unknown;
    tools?: Record<string, ToolEntry>;
  };
  if (manifest.schema !== 'ecpe.gstack-runtime.v1' || !manifest.tools?.[name]) {
    throw new Error(`tool_manifest_missing:${name}`);
  }
  const tool = validateEntry(name, manifest.tools[name]);
  const child = Bun.spawn([tool.realpath, ...VERSION_ARGS[name]], {
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...(process.env.ECPE_TOOL_LOG ? { ECPE_TOOL_LOG: process.env.ECPE_TOOL_LOG } : {}) },
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`tool_version_probe_failed:${name}`);
  const firstLine = `${stdout}${stderr}`.split(/\r?\n/, 1)[0];
  if (firstLine !== tool.version) throw new Error(`tool_version_mismatch:${name}`);
  return tool;
}
