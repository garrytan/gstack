const fs = require('node:fs');

if (process.env.GSTACK_TEST_AUTHORITY_NATIVE_WINDOWS === '1') {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

const originalRenameSync = fs.renameSync;
fs.renameSync = (source: string, destination: string) => {
  const sourcePath = String(source);
  const destinationPath = String(destination);
  const installsAuthority = sourcePath.includes('.authority-stage-') && destinationPath.endsWith('/dist/authority');
  const restoresAuthority = sourcePath.includes('.authority-retired-') && destinationPath.endsWith('/dist/authority');

  if (installsAuthority && process.env.GSTACK_TEST_AUTHORITY_SWAP_DELAY_MS) {
    const delay = Number(process.env.GSTACK_TEST_AUTHORITY_SWAP_DELAY_MS);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if (installsAuthority && process.env.GSTACK_TEST_FAIL_AUTHORITY_INSTALL_RENAME === '1') {
    throw Object.assign(new Error('injected_authority_install_rename_failure'), { code: 'EIO' });
  }
  if (restoresAuthority && process.env.GSTACK_TEST_FAIL_AUTHORITY_ROLLBACK_RENAME === '1') {
    throw Object.assign(new Error('injected_authority_rollback_rename_failure'), { code: 'EIO' });
  }
  return originalRenameSync(source, destination);
};
