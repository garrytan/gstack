import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { mkdirpSync } from './fs-utils';

export interface DurableOwnerLock {
  database: Database;
}

function ownerUid(): number {
  if (process.platform === 'win32') throw new Error('ecpe_native_windows_unsupported');
  const value = process.geteuid?.();
  if (!Number.isSafeInteger(value) || value! < 0) throw new Error('owner_lock_invalid');
  return value!;
}

function validateOwnerDirectory(directory: string, uid: number): void {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new Error('owner_lock_invalid');
  }
}

function validateExistingDatabase(databasePath: string, uid: number): boolean {
  try {
    const info = fs.lstatSync(databasePath);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o777) !== 0o600
    ) {
      throw new Error('owner_lock_invalid');
    }
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function createPrivateDatabase(databasePath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(databasePath, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function acquireDurableOwnerLock(target: string, busyError: string, busyTimeoutMs = 3000): DurableOwnerLock {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('owner_lock_timeout_invalid');
  const uid = ownerUid();
  const directory = path.dirname(path.resolve(target));
  mkdirpSync(directory, 0o700);
  validateOwnerDirectory(directory, uid);
  const databasePath = `${target}.owner.sqlite`;
  if (!validateExistingDatabase(databasePath, uid)) createPrivateDatabase(databasePath);
  validateExistingDatabase(databasePath, uid);
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { create: true, strict: true });
    const info = fs.lstatSync(databasePath);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o777) !== 0o600
    ) {
      throw new Error('owner_lock_invalid');
    }
    database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    try { database.exec('BEGIN EXCLUSIVE'); }
    catch { throw new Error(busyError); }
    return { database };
  } catch (error) {
    database?.close();
    throw error;
  }
}

export function releaseDurableOwnerLock(owned: DurableOwnerLock): void {
  try { owned.database.exec('COMMIT'); }
  finally { owned.database.close(); }
}
