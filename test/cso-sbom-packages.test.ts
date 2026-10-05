import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const jq = Bun.which('jq');
const run = (filter: string, input: unknown, check = false) => spawnSync(jq!, [check ? '-e' : '-c', '-f', path.join(ROOT, 'scripts', filter)], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
const document = {
  spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', name: 'image',
  packages: [{ SPDXID: 'SPDXRef-Package-rails', name: 'rails', versionInfo: '8.0.2', hasFiles: ['SPDXRef-File-a'] }, { SPDXID: 'SPDXRef-Package-rack', name: 'rack', versionInfo: '3.1.0' }],
  files: [{ SPDXID: 'SPDXRef-File-a', fileName: '/usr/local/bundle/gems/rails/a.rb' }, { SPDXID: 'SPDXRef-File-b', fileName: '/b' }],
  relationships: [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-rails' },
    { spdxElementId: 'SPDXRef-Package-rails', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-Package-rack' },
    { spdxElementId: 'SPDXRef-Package-rails', relationshipType: 'CONTAINS', relatedSpdxElement: 'SPDXRef-File-a' },
    { spdxElementId: 'SPDXRef-File-b', relationshipType: 'OTHER', relatedSpdxElement: 'SPDXRef-Package-rack' },
  ],
};

describe.skipIf(!jq)('CSO signed SBOMs carry the package inventory only', () => {
  test('file entries and every relationship that names a file are removed; packages and package edges stay', () => {
    const result = run('cso-sbom-packages.jq', document);
    expect(result.status, result.stderr).toBe(0);
    const compact = JSON.parse(result.stdout);
    expect(compact.files).toBeUndefined();
    expect(compact.packages.map((p: any) => [p.name, p.versionInfo, 'hasFiles' in p])).toEqual([['rails', '8.0.2', false], ['rack', '3.1.0', false]]);
    expect(compact.relationships.map((r: any) => r.relationshipType)).toEqual(['DESCRIBES', 'DEPENDS_ON']);
    expect(run('cso-sbom-packages-check.jq', compact, true).status).toBe(0);
  });
  test('the check rejects file-bearing, empty, wrong-version, or dangling documents', () => {
    expect(run('cso-sbom-packages-check.jq', document, true).status).not.toBe(0);
    const compact = JSON.parse(run('cso-sbom-packages.jq', document).stdout);
    expect(run('cso-sbom-packages-check.jq', { ...compact, packages: [] }, true).status).not.toBe(0);
    expect(run('cso-sbom-packages-check.jq', { ...compact, spdxVersion: 'SPDX-2.2' }, true).status).not.toBe(0);
    expect(run('cso-sbom-packages-check.jq', { ...compact, relationships: [...compact.relationships, { spdxElementId: 'SPDXRef-Package-rails', relationshipType: 'CONTAINS', relatedSpdxElement: 'SPDXRef-File-gone' }] }, true).status).not.toBe(0);
  });
});
