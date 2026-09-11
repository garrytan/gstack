// Emulate the Windows replace-existing fallback, then fail its install rename.
// File reads, version probes, backup moves and restores remain real operations.
const fs = require('node:fs');
const original = fs.renameSync;
let attempts = 0;
fs.renameSync = (source: string, destination: string) => {
  if (source.includes('.tmp.') && destination.endsWith('runtime.json')) {
    attempts++;
    if (attempts === 1 || process.env.GSTACK_TEST_FAIL_SECOND_RENAME === '1') {
      throw Object.assign(new Error('injected_manifest_rename_failure'), { code: attempts === 1 ? 'EEXIST' : 'EIO' });
    }
  }
  return original(source, destination);
};
