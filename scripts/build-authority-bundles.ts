import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { AUTHORITY_COMMANDS } from '../lib/authority-command-registry';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from '../lib/durable-owner-lock';

const root = path.resolve(import.meta.dir, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(dist, 'authority');
const lock = path.join(dist, '.authority-build.lock');
fs.mkdirSync(dist, { recursive: true });

interface BuildOwnerRecord {
  schema: 'ecpe.authority-build-lock.v1';
  pid: number;
  nonce: string;
  created_at: string;
}

interface BuildOwnerLock {
  release: () => void;
}

function acquireBuildOwnerLock(): BuildOwnerLock {
  if (process.platform !== 'win32') {
    const owned = acquireDurableOwnerLock(lock, 'authority_bundle_build_locked', 10_000);
    return { release: () => releaseDurableOwnerLock(owned) };
  }

  // Native Windows reports synthetic uid/mode values, so use the same SQLite
  // ownership primitive without the POSIX metadata checks.
  const databasePath = `${lock}.owner.sqlite`;
  const existing = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('owner_lock_invalid');
  if (!existing) {
    const descriptor = fs.openSync(databasePath, 'wx', 0o600);
    fs.closeSync(descriptor);
  }
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.exec('PRAGMA busy_timeout=10000');
    try { database.exec('BEGIN EXCLUSIVE'); }
    catch { throw new Error('authority_bundle_build_locked'); }
    return {
      release: () => {
        try { database.exec('COMMIT'); }
        finally { database.close(); }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function publishOwnerRecord(record: BuildOwnerRecord): void {
  const temporary = `${lock}.${record.pid}.${record.nonce}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    // The durable lock is held, so any visible record is from a dead prior owner.
    fs.rmSync(lock, { force: true });
    fs.renameSync(temporary, lock);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function removeOwnedRecord(record: BuildOwnerRecord): void {
  try {
    const current = JSON.parse(fs.readFileSync(lock, 'utf8')) as Partial<BuildOwnerRecord>;
    if (current.schema === record.schema && current.pid === record.pid && current.nonce === record.nonce) {
      fs.rmSync(lock, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function installStagedAuthority(stage: string, nonce: string): void {
  const retired = path.join(dist, `.authority-retired-${process.pid}-${nonce}`);
  let previousRetired = false;
  if (fs.existsSync(outDir)) {
    fs.renameSync(outDir, retired);
    previousRetired = true;
  }
  try {
    fs.renameSync(stage, outDir);
  } catch (installError) {
    if (previousRetired) {
      try {
        fs.renameSync(retired, outDir);
      } catch (rollbackError) {
        throw new Error(`authority_bundle_swap_rollback_failed:backup_retained:${retired}`, {
          cause: new AggregateError([installError, rollbackError]),
        });
      }
    }
    throw installError;
  }
  if (previousRetired) fs.rmSync(retired, { recursive: true, force: true });
}

const executableTypeScript = {
  name: 'authority-extensionless-typescript',
  setup(builder: { onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => { contents: string; loader: 'ts' }) => void }) {
    builder.onLoad(
      { filter: /\/bin\/gstack-(?:next-version|version-bump|pr-title-rewrite)$/ },
      ({ path: filename }) => ({ contents: fs.readFileSync(filename, 'utf8'), loader: 'ts' }),
    );
  },
};

function sha256(bytes: Uint8Array | string): string { return new Bun.CryptoHasher('sha256').update(bytes).digest('hex'); }

const ownerLock = acquireBuildOwnerLock();
const owner: BuildOwnerRecord = {
  schema: 'ecpe.authority-build-lock.v1',
  pid: process.pid,
  nonce: crypto.randomUUID(),
  created_at: new Date().toISOString(),
};
let stage: string | undefined;
try {
  publishOwnerRecord(owner);
  stage = fs.mkdtempSync(path.join(dist, '.authority-stage-'));
  const manifest: Record<string, { entrypoint: string; output: string; sha256: string; size: number; mode: number }> = {};
  for (const command of Object.keys(AUTHORITY_COMMANDS).sort() as Array<keyof typeof AUTHORITY_COMMANDS>) {
    const entrypoint = AUTHORITY_COMMANDS[command]; const output = `dist/authority/${command}.mjs`;
    const result = await Bun.build({ entrypoints: [path.join(root, entrypoint)], target: 'bun', format: 'esm', minify: false, sourcemap: 'none', naming: command + '.mjs', outdir: stage, plugins: [executableTypeScript] });
    if (!result.success) throw new Error(`authority_bundle_failed:${command}`);
    const file = path.join(stage, `${command}.mjs`); const bytes = fs.readFileSync(file); fs.chmodSync(file, 0o755);
    manifest[command] = { entrypoint, output, sha256: sha256(bytes), size: bytes.byteLength, mode: 0o755 };
  }
  const payload = JSON.stringify({ schema: 'ecpe.authority-bundles.v1', commands: manifest }) + '\n';
  fs.writeFileSync(path.join(stage, 'manifest.json'), payload, { mode: 0o644 }); fs.writeFileSync(path.join(stage, 'manifest.sha256'), `${sha256(payload)}  manifest.json\n`, { mode: 0o644 });
  installStagedAuthority(stage, owner.nonce);
} finally {
  try {
    if (stage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    removeOwnedRecord(owner);
  } finally {
    ownerLock.release();
  }
}
