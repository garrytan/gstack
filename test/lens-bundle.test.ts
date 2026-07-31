import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBundle,
  lensBundlePath,
  purgeLensBundleRun,
  readLensBundle,
  writeLensBundle,
} from '../scripts/lenses/bundle';

describe('bounded stakeholder lens evidence bundles', () => {
  test('writes and reads a secure bounded bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lens-bundle-'));
    const gstackHome = path.join(root, 'home');
    const bundle = createBundle({
      run_id: 'run-1',
      lens: 'insider-abuse',
      manifest: [{ name: 'diff', source: 'diff' }],
      context: { deployment_model: 'single-tenant SaaS' },
      required_missing: [],
      evidence: [{ name: 'diff', source: 'diff', content: '<untrusted_evidence>diff</untrusted_evidence>' }],
      omissions: [],
    });
    const written = writeLensBundle(bundle, { gstackHome });
    expect(readLensBundle('run-1', 'insider-abuse', { gstackHome })).toEqual(bundle);
    if (process.platform !== 'win32') {
      expect(fs.statSync(written.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(written.path)).mode & 0o777).toBe(0o700);
    }
    expect(purgeLensBundleRun('run-1', { gstackHome })).toContain('run-1');
    expect(fs.existsSync(lensBundlePath('run-1', 'insider-abuse', { gstackHome }))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects traversal-shaped run and lens identifiers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lens-bundle-traversal-'));
    const gstackHome = path.join(root, 'home');
    expect(() => lensBundlePath('../escape', 'insider-abuse', { gstackHome })).toThrow(/run_id/);
    expect(() => lensBundlePath('run-3', '../escape', { gstackHome })).toThrow(/lens/);
    expect(() => purgeLensBundleRun('../escape', { gstackHome })).toThrow(/run_id/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects bundles over the configured limit instead of truncating', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lens-bundle-size-'));
    const gstackHome = path.join(root, 'home');
    const bundle = createBundle({
      run_id: 'run-2',
      lens: 'insider-abuse',
      manifest: [],
      context: {},
      required_missing: [],
      evidence: [{ name: 'large', source: 'diff', content: 'x'.repeat(1024) }],
    });
    expect(() => writeLensBundle(bundle, { gstackHome, maxBytes: 256 })).toThrow(/exceeding/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
