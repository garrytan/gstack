import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

describe('Apple release effect boundary', () => {
  test('is report-only and has no legacy writer commands', () => {
    const body = fs.readFileSync('ship/sections/apple-release.md.tmpl', 'utf8');
    expect(body).toContain('adapter_operation_unsupported');
    for (const forbidden of ['brew install', 'fastlane pilot', 'fastlane deliver', 'app-store-connect']) expect(body).not.toContain(forbidden);
  });
});
