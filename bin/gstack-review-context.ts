#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { spawnSync } from 'node:child_process';
import { writeReviewContextPacket } from '../lib/review-context-packet';

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result) throw new Error(`Usage: gstack-review-context (--base <ref> | --base-from-input) --input <path>; missing ${flag}`);
  return result;
}

try {
  const input = value('--input');
  const base = process.argv.includes('--base-from-input') ? '' : value('--base');
  const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const root = rootResult.stdout?.trim();
  if (rootResult.status !== 0 || !root) {
    throw new Error(rootResult.stderr?.trim() || 'not in a git repository');
  }
  const bytes = writeReviewContextPacket(root, base, input);
  process.stderr.write(`gstack: bounded review packet ${bytes} bytes\n`);
} catch (error) {
  process.stderr.write(`gstack: review packet failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
