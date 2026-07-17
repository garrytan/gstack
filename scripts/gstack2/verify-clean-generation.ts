#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_RUNTIME_PAYLOADS } from './ensure-runtime-payloads';

const ROOT = path.resolve(import.meta.dir, '../..');
const payloadPaths = REQUIRED_RUNTIME_PAYLOADS.map((entry) => entry.path);
const preexisting = payloadPaths.filter((relativePath) => fs.existsSync(path.join(ROOT, relativePath)));

if (preexisting.length > 0) {
  throw new Error(`Clean-generation probe requires absent runtime payloads: ${preexisting.join(', ')}`);
}

const result = spawnSync(process.execPath, ['run', 'gen:gstack2'], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const missing = payloadPaths.filter((relativePath) => {
  try {
    const stat = fs.statSync(path.join(ROOT, relativePath));
    return !stat.isFile() || stat.size === 0;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  throw new Error(`Clean-generation probe did not produce runtime payloads: ${missing.join(', ')}`);
}

console.log(`Clean-generation probe passed: ${payloadPaths.length} runtime payloads built before generation.`);
