import { describe, it, expect } from 'bun:test';
import { validateOutputPath } from '../src/meta-commands';
import { validateReadPath } from '../src/read-commands';
import { symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('validateOutputPath', () => {
  it('allows paths within /tmp', () => {
    expect(() => validateOutputPath('/tmp/screenshot.png')).not.toThrow();
  });

  it('allows paths in subdirectories of /tmp', () => {
    expect(() => validateOutputPath('/tmp/browse/output.png')).not.toThrow();
  });

  it('allows paths within cwd', () => {
    expect(() => validateOutputPath(`${process.cwd()}/output.png`)).not.toThrow();
  });

  it('blocks paths outside safe directories', () => {
    expect(() => validateOutputPath('/etc/cron.d/backdoor.png')).toThrow(/Path must be within/);
  });

  it('blocks /tmpevil prefix collision', () => {
    expect(() => validateOutputPath('/tmpevil/file.png')).toThrow(/Path must be within/);
  });

  it('blocks home directory paths', () => {
    expect(() => validateOutputPath('/Users/someone/file.png')).toThrow(/Path must be within/);
  });

  it('blocks path traversal via ..', () => {
    expect(() => validateOutputPath('/tmp/../etc/passwd')).toThrow(/Path must be within/);
  });
});

describe('validateReadPath', () => {
  it('allows absolute paths within /tmp', () => {
    expect(() => validateReadPath('/tmp/script.js')).not.toThrow();
  });

  it('allows absolute paths within cwd', () => {
    expect(() => validateReadPath(`${process.cwd()}/test.js`)).not.toThrow();
  });

  it('allows relative paths without traversal', () => {
    expect(() => validateReadPath('src/index.js')).not.toThrow();
  });

  it('blocks absolute paths outside safe directories', () => {
    expect(() => validateReadPath('/etc/passwd')).toThrow(/Path must be within/);
  });

  it('blocks /tmpevil prefix collision', () => {
    expect(() => validateReadPath('/tmpevil/file.js')).toThrow(/Path must be within/);
  });

  it('blocks path traversal sequences', () => {
    expect(() => validateReadPath('../../../etc/passwd')).toThrow(/Path must be within/);
  });

  it('blocks nested path traversal', () => {
    expect(() => validateReadPath('src/../../etc/passwd')).toThrow(/Path must be within/);
  });

  it('blocks symlink inside safe dir pointing outside', () => {
    const linkPath = join(tmpdir(), 'test-symlink-bypass-' + Date.now());
    try {
      symlinkSync('/etc/passwd', linkPath);
      expect(() => validateReadPath(linkPath)).toThrow(/Path must be within/);
    } finally {
      try { unlinkSync(linkPath); } catch {}
    }
  });

  it('throws clear error on non-ENOENT realpathSync failure', () => {
    // Attempting to resolve a path through a non-directory should throw
    // a descriptive error (ENOTDIR), not silently pass through.
    // Create a regular file, then try to resolve a path through it as if it were a directory.
    const filePath = join(tmpdir(), 'test-notdir-' + Date.now());
    try {
      writeFileSync(filePath, 'not a directory');
      // filePath is a file, so filePath + '/subpath' triggers ENOTDIR
      const invalidPath = join(filePath, 'subpath');
      expect(() => validateReadPath(invalidPath)).toThrow(/Cannot resolve real path|Path must be within/);
    } finally {
      try { unlinkSync(filePath); } catch {}
    }
  });
});
