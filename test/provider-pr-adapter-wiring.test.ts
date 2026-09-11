import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '..', 'lib', 'closed-effect-adapters.ts'), 'utf8');

describe('provider PR adapter wiring', () => {
  test('validates the exact numbered branch before consuming the update grant or mutating', () => {
    const updateStart = source.indexOf("if (input.action === 'update') {");
    const preView = source.indexOf('buildProviderPrViewArgs(provider, repositorySelector, input.pr!)', updateStart);
    const preValidation = source.indexOf('validateProviderPrSnapshot(provider, remote, { pr: input.pr!, head }, before)', preView);
    const grant = source.indexOf("const capability = input.action === 'create' ? 'pr_create' : 'pr_update'", updateStart);
    const mutation = source.indexOf("provider, action: 'update'", grant);
    expect(updateStart).toBeGreaterThan(0);
    expect(preView).toBeGreaterThan(updateStart);
    expect(preValidation).toBeGreaterThan(preView);
    expect(grant).toBeGreaterThan(preValidation);
    expect(mutation).toBeGreaterThan(grant);
  });

  test('sends the captured reviewed bytes on stdin instead of reopening the body path', () => {
    expect(source.match(/bodyFile: '-'/g)).toHaveLength(2);
    expect(source.split('})], root, {}, body)').length - 1).toBe(2);
    expect(source).not.toMatch(/buildProviderPrMutationArgs\([\s\S]{0,300}bodyFile,\n/);
    expect(source).toContain("if (hashBytes(body) !== input.assertBodySha256) throw new Error('provider_pr_body_changed')");
  });

  test('uses attested discovery and rechecks absence immediately before create', () => {
    expect(source).toContain('export async function discoverProviderPr');
    const adapterStart = source.indexOf('export async function executeProviderPr');
    const discovery = source.indexOf('buildProviderPrDiscoveryArgs(provider, repositorySelector, head)', adapterStart);
    const absence = source.indexOf("throw new Error('provider_pr_already_exists')", discovery);
    const grant = source.indexOf("const capability = input.action === 'create' ? 'pr_create' : 'pr_update'", absence);
    const mutation = source.indexOf("provider, action: 'create'", grant);
    expect(adapterStart).toBeGreaterThan(0);
    expect(discovery).toBeGreaterThan(adapterStart);
    expect(absence).toBeGreaterThan(discovery);
    expect(grant).toBeGreaterThan(absence);
    expect(mutation).toBeGreaterThan(grant);
  });
});
