#!/usr/bin/env bun

import { collectFreeTestFiles } from '../test-free-shards';
import { runStrictTestShard } from '../test-free-strict';

const GSTACK2_TEST_TIMEOUT_MS = 30_000;
const files = collectFreeTestFiles().filter((file) => /^test\/gstack2-.*\.test\.ts$/.test(file));

if (files.length === 0) {
  throw new Error('No GStack 2 test files were discovered.');
}

console.log(`[test:gstack2] ${files.length} files across ${files.length} isolated processes`);
for (let index = 0; index < files.length; index += 1) {
  const file = files[index];
  console.log(`[test:gstack2] file ${index + 1}/${files.length}: ${file}`);
  const exitCode = await runStrictTestShard([file], GSTACK2_TEST_TIMEOUT_MS);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
