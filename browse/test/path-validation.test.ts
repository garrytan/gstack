import { describe, it, expect } from 'bun:test';
import { validateOutputPath } from '../src/meta-commands';
import { validateReadPath, SENSITIVE_COOKIE_NAME, SENSITIVE_COOKIE_VALUE } from '../src/read-commands';
import { BLOCKED_METADATA_HOSTS } from '../src/url-validation';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'fs';
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

describe('upload command path validation', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'write-commands.ts'), 'utf-8');

  it('validates upload paths with isPathWithin', () => {
    const uploadBlock = src.slice(src.indexOf("case 'upload'"), src.indexOf("case 'dialog-accept'"));
    expect(uploadBlock).toContain('isPathWithin');
  });

  it('blocks path traversal in upload', () => {
    const uploadBlock = src.slice(src.indexOf("case 'upload'"), src.indexOf("case 'dialog-accept'"));
    expect(uploadBlock).toContain("'..'");
  });

  it('checks absolute paths against safe directories', () => {
    const uploadBlock = src.slice(src.indexOf("case 'upload'"), src.indexOf("case 'dialog-accept'"));
    expect(uploadBlock).toContain('path.isAbsolute');
    expect(uploadBlock).toContain('SAFE_DIRECTORIES');
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

describe('validateOutputPath — symlink resolution', () => {
  it('blocks symlink inside /tmp pointing outside safe dirs', () => {
    const linkPath = join(tmpdir(), 'test-output-symlink-' + Date.now() + '.png');
    try {
      symlinkSync('/etc/crontab', linkPath);
      expect(() => validateOutputPath(linkPath)).toThrow(/Path must be within/);
    } finally {
      try { unlinkSync(linkPath); } catch {}
    }
  });

  it('allows symlink inside /tmp pointing to another /tmp path', () => {
    // Use /tmp (TEMP_DIR on macOS/Linux), not os.tmpdir() which may be a different path
    const realTmp = realpathSync('/tmp');
    const targetPath = join(realTmp, 'test-output-real-' + Date.now() + '.png');
    const linkPath = join(realTmp, 'test-output-link-' + Date.now() + '.png');
    try {
      writeFileSync(targetPath, '');
      symlinkSync(targetPath, linkPath);
      expect(() => validateOutputPath(linkPath)).not.toThrow();
    } finally {
      try { unlinkSync(linkPath); } catch {}
      try { unlinkSync(targetPath); } catch {}
    }
  });

  it('blocks new file in symlinked directory pointing outside', () => {
    const linkDir = join(tmpdir(), 'test-dirlink-' + Date.now());
    try {
      symlinkSync('/etc', linkDir);
      expect(() => validateOutputPath(join(linkDir, 'evil.png'))).toThrow(/Path must be within/);
    } finally {
      try { unlinkSync(linkDir); } catch {}
    }
  });
});

describe('cookie redaction — production patterns', () => {
  it('detects sensitive cookie names', () => {
    expect(SENSITIVE_COOKIE_NAME.test('session_id')).toBe(true);
    expect(SENSITIVE_COOKIE_NAME.test('auth_token')).toBe(true);
    expect(SENSITIVE_COOKIE_NAME.test('csrf-token')).toBe(true);
    expect(SENSITIVE_COOKIE_NAME.test('api_key')).toBe(true);
    expect(SENSITIVE_COOKIE_NAME.test('jwt.payload')).toBe(true);
  });

  it('ignores non-sensitive cookie names', () => {
    expect(SENSITIVE_COOKIE_NAME.test('theme')).toBe(false);
    expect(SENSITIVE_COOKIE_NAME.test('locale')).toBe(false);
    expect(SENSITIVE_COOKIE_NAME.test('_ga')).toBe(false);
  });

  it('detects sensitive cookie value prefixes', () => {
    expect(SENSITIVE_COOKIE_VALUE.test('eyJhbGciOiJIUzI1NiJ9')).toBe(true); // JWT
    expect(SENSITIVE_COOKIE_VALUE.test('sk-ant-abc123')).toBe(true); // Anthropic
    expect(SENSITIVE_COOKIE_VALUE.test('ghp_xxxxxxxxxxxx')).toBe(true); // GitHub PAT
    expect(SENSITIVE_COOKIE_VALUE.test('xoxb-token')).toBe(true); // Slack
  });

  it('ignores non-sensitive values', () => {
    expect(SENSITIVE_COOKIE_VALUE.test('dark')).toBe(false);
    expect(SENSITIVE_COOKIE_VALUE.test('en-US')).toBe(false);
    expect(SENSITIVE_COOKIE_VALUE.test('1234567890')).toBe(false);
  });
});

describe('DNS rebinding — production blocklist', () => {
  it('blocks fd00:: IPv6 metadata address via validateNavigationUrl', async () => {
    const { validateNavigationUrl } = await import('../src/url-validation');
    await expect(validateNavigationUrl('http://[fd00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks AWS/GCP IPv4 metadata address', () => {
    expect(BLOCKED_METADATA_HOSTS.has('169.254.169.254')).toBe(true);
  });

  it('does not block normal addresses', () => {
    expect(BLOCKED_METADATA_HOSTS.has('8.8.8.8')).toBe(false);
    expect(BLOCKED_METADATA_HOSTS.has('2001:4860:4860::8888')).toBe(false);
  });
});
