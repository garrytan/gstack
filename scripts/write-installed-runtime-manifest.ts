import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECTION_BATCHES } from '../lib/section-delivery';
import { getHostConfig } from '../hosts';
import { releaseRuntimeBinding, resolveRegisteredRuntimeBinding } from '../lib/validator-runtime';

const VERSION_ARGS = {
  bun: ['--version'],
  git: ['--version'],
  gh: ['--version'],
  glab: ['--version'],
  ssh: ['-V'],
} as const;

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

function sha256(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

function preservedRuntimes(manifestPath: string): Record<string, unknown> {
  let info: fs.Stats;
  try { info = fs.lstatSync(manifestPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    fail('registered_runtime_manifest_invalid');
  }
  // Replacement never follows an old symlink or imports its target's metadata.
  if (info.isSymbolicLink()) return {};
  if (!info.isFile() || info.nlink !== 1) fail('registered_runtime_manifest_invalid');
  let manifest: any;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { fail('registered_runtime_manifest_invalid'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('registered_runtime_manifest_invalid');
  if (manifest.execution_environment === undefined) return {};
  const environment = manifest.execution_environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).join(',') !== 'runtimes' || !environment.runtimes
    || typeof environment.runtimes !== 'object' || Array.isArray(environment.runtimes)
    || manifest.schema !== 'ecpe.gstack-runtime.v1'
    || (info.mode & 0o022) !== 0 || ![0, process.geteuid?.()].includes(info.uid)) fail('registered_runtime_manifest_invalid');
  const runtimes: Record<string, unknown> = {};
  for (const [runtimeId, entry] of Object.entries(environment.runtimes)) {
    if (!['harness_test_python', 'cdo_preview_python'].includes(runtimeId)) fail('registered_runtime_manifest_invalid');
    if (process.platform === 'win32') fail('registered_runtime_attestation_failed');
    try {
      // Reuse the consuming validator's interpreter hash/version, package
      // metadata and safe library-directory checks before retaining authority.
      const binding = resolveRegisteredRuntimeBinding({
        repositoryRoot: path.dirname(manifestPath), manifestPath,
        runtimeId: runtimeId as 'harness_test_python' | 'cdo_preview_python',
        sourceRoots: [], binding: { mode: 'argv0' }, argv: ['python', '--version'],
      });
      releaseRuntimeBinding(binding);
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith('registered_runtime_') ? error.message : 'registered_runtime_attestation_failed');
    }
    runtimes[runtimeId] = entry;
  }
  return runtimes;
}

// Setup chooses a host, never a caller-supplied list of sections to attest.
// Kiro is installed from the temporary Claude-profile Codex render.
const SECTION_HOST_TREES = { codex: '.agents', factory: '.factory', opencode: '.opencode', cursor: '.cursor', kiro: '.agents' } as const;

function stageHostSections(source: string, root: string, host: keyof typeof SECTION_HOST_TREES): void {
  const skipped = getHostConfig(host).generation.skipSkills ?? [];
  for (const [skill, stages] of Object.entries(SECTION_BATCHES)) {
    if (skipped.includes(skill)) continue;
    for (const id of new Set(Object.values(stages).flat())) {
      const file = path.join(source, SECTION_HOST_TREES[host], 'skills', `gstack-${skill}`, 'sections', `${id}.md`);
      const info = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!info) fail('runtime_artifact_missing');
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('runtime_artifact_invalid');
      const output = path.join(root, 'sections', skill, `${id}.md`);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (host === 'kiro') {
        const text = fs.readFileSync(file, 'utf8')
          .replaceAll('$HOME/.codex/skills/gstack', '$HOME/.kiro/skills/gstack')
          .replaceAll('~/.codex/skills/gstack', '~/.kiro/skills/gstack')
          .replaceAll('~/.claude/skills/gstack', '~/.kiro/skills/gstack')
          .replaceAll('./setup --host codex', './setup --host kiro');
        fs.writeFileSync(output, text, { flag: 'wx', mode: info.mode & 0o777 });
      } else fs.copyFileSync(file, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, info.mode & 0o777);
    }
  }
}

function attestArtifacts(rootValue: string | undefined, host?: keyof typeof SECTION_HOST_TREES, sourceHost?: 'claude' | 'codex'): Record<string, { sha256: string; size: number; mode: number }> {
  if (!rootValue) return {};
  let root: string;
  let rootInfo: fs.Stats;
  try {
    root = fs.realpathSync(path.resolve(rootValue));
    rootInfo = fs.lstatSync(root);
  } catch { fail('runtime_artifact_root_invalid'); }
  if (!rootInfo!.isDirectory() || rootInfo!.isSymbolicLink()) fail('runtime_artifact_root_invalid');
  const artifacts: Record<string, { sha256: string; size: number; mode: number }> = {};
  for (const [skill, stages] of Object.entries(SECTION_BATCHES)) {
    if ((host || sourceHost) && getHostConfig(host ?? sourceHost!).generation.skipSkills?.includes(skill)) continue;
    const sectionIds = [...new Set(Object.values(stages).flat())].sort();
    for (const sectionId of sectionIds) {
      const paths = [
        path.join(root!, skill, 'sections', `${sectionId}.md`),
        path.join(root!, '.agents', 'skills', `gstack-${skill}`, 'sections', `${sectionId}.md`),
        path.join(root!, 'sections', skill, `${sectionId}.md`),
      ];
      const candidates = host ? [paths[2]] : sourceHost === 'claude' ? [paths[0]] : sourceHost === 'codex' ? [paths[1]] : paths;
      let found = 0;
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const info = fs.lstatSync(candidate);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('runtime_artifact_invalid');
        const relative = path.relative(root!, candidate).split(path.sep).join('/');
        artifacts[relative] = { sha256: sha256(candidate), size: info.size, mode: info.mode & 0o777 };
        found++;
      }
      if (found === 0) fail('runtime_artifact_missing');
    }
  }
  return Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)));
}

function attest(name: keyof typeof VERSION_ARGS, candidate: string | null): Record<string, unknown> | null {
  if (!candidate) return null;
  let realpath: string;
  let info: fs.Stats;
  try {
    realpath = fs.realpathSync(candidate);
    info = fs.lstatSync(realpath);
  } catch {
    if (name === 'bun') fail('runtime_bun_identity_invalid');
    return null;
  }
  if (!path.isAbsolute(realpath) || !info.isFile() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0))) {
    if (name === 'bun') fail('runtime_bun_identity_invalid');
    return null;
  }
  // Some CLIs (notably gh) create per-user state even for --version when
  // HOME is absent. Isolate probes so setup never writes .local/ into the
  // source checkout or consults mutable user configuration.
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-probe-'));
  let probe: ReturnType<typeof Bun.spawnSync>;
  try {
    probe = Bun.spawnSync([realpath, ...VERSION_ARGS[name]], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
      env: {
        // Native Windows synthesizes uid/mode and needs its system directory;
        // neither the user's PATH nor a POSIX mode check attests an .exe there.
        ...(process.platform === 'win32' && (process.env.SystemRoot || process.env.SYSTEMROOT) ? {
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT!,
          PATH: path.join(process.env.SystemRoot || process.env.SYSTEMROOT!, 'System32'),
          USERPROFILE: probeHome,
          TEMP: probeHome,
          TMP: probeHome,
        } : { PATH: '/usr/bin:/bin' }),
        LC_ALL: 'C',
        HOME: probeHome,
        XDG_CONFIG_HOME: path.join(probeHome, 'config'),
        XDG_STATE_HOME: path.join(probeHome, 'state'),
        GH_CONFIG_DIR: path.join(probeHome, 'gh'),
      },
    });
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
  if (probe.exitCode !== 0) {
    if (name === 'bun') fail('runtime_bun_probe_failed');
    return null;
  }
  const version = `${probe.stdout.toString()}${probe.stderr.toString()}`.split(/\r?\n/, 1)[0];
  if (!version) {
    if (name === 'bun') fail('runtime_bun_probe_failed');
    return null;
  }
  return {
    // JSON escaped backslashes cannot be consumed by the pre-Bun shell anchor.
    // A normalized native absolute path can be converted by Git Bash cygpath.
    realpath: process.platform === 'win32' ? realpath.replaceAll('\\', '/') : realpath,
    ...(process.platform === 'win32' ? { identity_kind: 'windows-sha256-v1' } : {}),
    owner_uid: info.uid,
    mode: info.mode & 0o777,
    sha256: sha256(realpath),
    version,
  };
}

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  if (!['--output', '--bun-path', '--artifact-root', '--section-host', '--section-source', '--source-host', '--runtime-metadata-from'].includes(args[index]) || !args[index + 1] || values.has(args[index])) {
    fail('runtime_manifest_arguments_invalid');
  }
  values.set(args[index], args[index + 1]);
}
if (!values.has('--output')) fail('runtime_manifest_arguments_invalid');
const sectionHost = values.get('--section-host') as keyof typeof SECTION_HOST_TREES | undefined;
const sourceHost = values.get('--source-host') as 'claude' | 'codex' | undefined;
if (sourceHost !== undefined && (!['claude', 'codex'].includes(sourceHost) || sectionHost
  || values.has('--section-source') || !values.has('--artifact-root'))) fail('runtime_manifest_arguments_invalid');
if ((sectionHost !== undefined || values.has('--section-source')) && (!sectionHost
  || !Object.hasOwn(SECTION_HOST_TREES, sectionHost) || !values.has('--section-source') || !values.has('--artifact-root'))) {
  fail('runtime_manifest_arguments_invalid');
}
const output = path.resolve(values.get('--output')!);
const runtimes = {
  ...preservedRuntimes(output),
  ...(values.has('--runtime-metadata-from') ? preservedRuntimes(path.resolve(values.get('--runtime-metadata-from')!)) : {}),
};
const tools: Record<string, unknown> = {};
for (const name of Object.keys(VERSION_ARGS).sort() as Array<keyof typeof VERSION_ARGS>) {
  const entry = attest(name, name === 'bun' ? values.get('--bun-path') ?? process.execPath : Bun.which(name));
  if (entry) tools[name] = entry;
}
if (!tools.bun) fail('runtime_bun_identity_invalid');
if (sectionHost) stageHostSections(values.get('--section-source')!, values.get('--artifact-root')!, sectionHost);
const artifacts = attestArtifacts(values.get('--artifact-root'), sectionHost, sourceHost);
const sectionLayout = sectionHost ? 'runtime' : sourceHost ? `${sourceHost}-source` : undefined;

if (!fs.existsSync(path.dirname(output))) fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const stage = `${output}.tmp.${process.pid}`;
try {
  fs.writeFileSync(stage, `${JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', tools, artifacts,
    ...(sectionLayout ? { section_layout: sectionLayout } : {}),
    ...(Object.keys(runtimes).length ? { execution_environment: { runtimes } } : {}),
  })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(stage, 0o600);
  try {
    fs.renameSync(stage, output);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const existing = fs.lstatSync(output);
    if (!existing.isFile() && !existing.isSymbolicLink()) throw new Error('runtime_manifest_destination_invalid');
    // Native Windows can reject rename-over-existing. Preserve that leaf,
    // including a symlink, until the second rename succeeds on this filesystem.
    const backupDirectory = fs.mkdtempSync(`${output}.backup.`);
    const backup = path.join(backupDirectory, 'previous');
    try {
      fs.renameSync(output, backup);
      try {
        fs.renameSync(stage, output);
      } catch (installError) {
        try { fs.renameSync(backup, output); }
        catch { throw new Error(`runtime_manifest_rollback_failed:backup_retained:${backup}`); }
        throw installError;
      }
      fs.rmSync(backup, { force: true });
    } finally {
      // Leave a recoverable preimage if the filesystem also refused rollback.
      if (!fs.lstatSync(backup, { throwIfNoEntry: false })) fs.rmdirSync(backupDirectory);
    }
  }
} finally {
  fs.rmSync(stage, { force: true });
}
