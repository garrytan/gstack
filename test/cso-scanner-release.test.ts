import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { sha256 } from '../lib/cso/contracts';
import { SCANNER_CATALOG, ScannerCatalog, scannerVersionHash } from '../lib/cso/scanner-catalog';
import { SCANNER_IDS, ScannerId, scannerPlans } from '../lib/cso/scanners';
import { scannerCatalogProposal, scannerAssetHash, validateScannerCatalogTransition } from '../scripts/cso-scanner-catalog';
import { scannerBuildMatrix } from '../scripts/cso-scanner-matrix';
import { verifiedStatementSetDigest } from '../scripts/cso-attestation-evidence';

const ROOT = path.resolve(import.meta.dir, '..'), HASH = 'a'.repeat(64), DIGEST = `sha256:${HASH}`;
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const image = (id: string) => `ghcr.io/garrytan/gstack/cso-scanners/${id}@sha256:${HASH}`;
const attested=(id:string,repository=`https://github.com/example/${id}`)=>({image:image(id),repository,sourceCommit:'b'.repeat(40),release:`v${id}-1.2.3`,signerWorkflow:`example/${id}/.github/workflows/release.yml`,signerDigest:'c'.repeat(40),provenanceStatementDigest:DIGEST,sbomStatementDigest:DIGEST});
function reviewedInputs() {
  return { schemaVersion: 1, helperAbi: 3, state: 'reviewed', sbomGenerator: attested('sbom'), profiles: SCANNER_IDS.map(scanner => ({
    scanner, version: scanner === 'gitleaks' ? '8.30.1' : '1.2.3', executable: `/usr/local/bin/${scanner === 'osv' ? 'osv-scanner' : scanner}`,
    baseImages: { 'linux/amd64': attested(`${scanner}-base-amd64`, `https://github.com/example/${scanner}`), 'linux/arm64': attested(`${scanner}-base-arm64`, `https://github.com/example/${scanner}`) },
    ...(scanner === 'semgrep' ? { assets: { semgrepRules: { path: '/policy/catalog/semgrep.yml', sha256: HASH } } }
      : ['osv', 'trivy'].includes(scanner) ? { assets: { advisoryDatabase: { path: `/opt/cso/scanner-data/${scanner}`, contentSha256: HASH, updatedAt: '2026-09-10T00:00:00.000Z', ecosystems: ['npm', 'PyPI'] } } } : {}),
    ...(scanner === 'schemathesis' ? { applicationExecutable: '/usr/local/bin/python' } : {}),
  })) };
}
function qualified(scanner: ScannerId, platform: 'linux/amd64' | 'linux/arm64') {
  const arch = platform.endsWith('arm64') ? 'arm64' : 'amd64', version = scanner === 'gitleaks' ? '8.30.1' : '1.2.3';
  return { id: `${scanner}-${version}-${arch}`, scanner, state: 'qualified' as const, platform, image: image(`${scanner}-${arch}`), entrypoint: '/opt/cso/entrypoint' as const, executable: '/opt/cso/bin/scanner', version,
    versionOutputSha256: scannerVersionHash(`${scanner} ${version}\n`), helperAbi: 3 as const, isolationPolicyHash: ISOLATION_POLICY_HASH,
    capabilities: scannerPlans({ snapshotRoot: '/source', offline: true, selected: [scanner] })[0].requiredFeatures,
    ...(scanner === 'semgrep' ? { assets: { semgrepRules: { path: '/policy/catalog/semgrep.yml', sha256: HASH } } }
      : ['osv', 'trivy'].includes(scanner) ? { assets: { advisoryDatabase: { path: `/opt/cso/scanner-data/${scanner}`, contentSha256: HASH, updatedAt: '2026-09-10T00:00:00.000Z', ecosystems: ['npm'] } } } : {}),
    qualifiedAt: '2026-09-10T00:00:00.000Z', qualification: { sourceCommit: 'c'.repeat(40), workflow: 'https://github.com/garrytan/gstack/actions/runs/42', sbomDigest: DIGEST, provenanceDigest: DIGEST, verifiedProvenance: true as const, containmentPassed: true as const, adapterContractPassed: true as const, offlineAssetsPassed: true as const } };
}

describe('CSO scanner release inputs', () => {
  test('requires all six scanners on both native architectures with derived adapter capabilities', () => {
    const matrix = scannerBuildMatrix(reviewedInputs()); expect(matrix.include).toHaveLength(12);
    for (const scanner of SCANNER_IDS) {
      const rows = matrix.include.filter(row => row.scanner === scanner);
      expect(rows.map(row => row.platform)).toEqual(['linux/amd64', 'linux/arm64']);
      expect(rows.map(row => row.runner)).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm']);
      expect(rows[0].capabilities).toEqual([...scannerPlans({ snapshotRoot: '/source', offline: true, selected: [scanner] })[0].requiredFeatures].sort());
    }
  });
  test('pending, partial, mutable, assetless, or unverified input cannot publish', () => {
    const pending = reviewedInputs() as any; pending.state = 'pending'; expect(() => scannerBuildMatrix(pending)).toThrow('MISSING_REVIEWED_SCANNER_INPUTS');
    const partial = reviewedInputs() as any; partial.profiles.pop(); expect(() => scannerBuildMatrix(partial)).toThrow('INCOMPLETE_SCANNER_MATRIX');
    const tagged = reviewedInputs() as any; tagged.profiles[0].baseImages['linux/amd64'].image = 'ghcr.io/example/gitleaks:latest'; expect(() => scannerBuildMatrix(tagged)).toThrow('INVALID_UPSTREAM_EVIDENCE');
    const assetless = reviewedInputs() as any; delete assetless.profiles.find((p: any) => p.scanner === 'osv').assets; expect(() => scannerBuildMatrix(assetless)).toThrow('MISSING_OFFLINE_ASSET');
    const unverified = reviewedInputs() as any; delete unverified.profiles[0].baseImages['linux/amd64'].signerDigest; expect(() => scannerBuildMatrix(unverified)).toThrow('INVALID_UPSTREAM_EVIDENCE');
    const generator = reviewedInputs() as any; generator.sbomGenerator.provenanceStatementDigest = 'unreviewed'; expect(() => scannerBuildMatrix(generator)).toThrow('UNVERIFIED_SBOM_GENERATOR');
  });
  test('binds verified attestation statements to the reviewed subject and predicate',()=>{
    const predicate='https://slsa.dev/provenance/v1',statement={_type:'https://in-toto.io/Statement/v1',subject:[{name:'image',digest:{sha256:HASH}}],predicateType:predicate,predicate:{buildType:'https://example.test/builder'}};
    const value=[{attestation:{},verificationResult:{statement}}],digest=verifiedStatementSetDigest(value,predicate,HASH);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);expect(verifiedStatementSetDigest(value,predicate,HASH)).toBe(digest);
    expect(()=>verifiedStatementSetDigest(value,'https://spdx.dev/Document/v2.3',HASH)).toThrow('VERIFIED_ATTESTATION_IDENTITY_MISMATCH');
    expect(()=>verifiedStatementSetDigest(value,predicate,'d'.repeat(64))).toThrow('VERIFIED_ATTESTATION_IDENTITY_MISMATCH');
  });
  test('paths and matrix strings cannot inject build commands', () => {
    for (const executable of ['/usr/bin/scanner;id', '../../scanner', '/usr/bin/scan ner', '/usr/bin/scanner\nBAD=1']) {
      const input = reviewedInputs() as any; input.profiles[0].executable = executable; expect(() => scannerBuildMatrix(input)).toThrow('INVALID_SCANNER_EXECUTABLE');
    }
    const extra = reviewedInputs() as any; extra.profiles[0].buildArgs = ['EVIL=1']; expect(() => scannerBuildMatrix(extra)).toThrow('INVALID_SCANNER_PROFILE');
  });
});

describe('CSO scanner catalog promotion', () => {
  const expected = { sourceCommit: 'c'.repeat(40), workflow: 'https://github.com/garrytan/gstack/actions/runs/42', imagePrefix: 'ghcr.io/garrytan/gstack/cso-scanners/' };
  const fragments = () => SCANNER_IDS.flatMap(scanner => ['linux/amd64', 'linux/arm64'].map(platform => qualified(scanner, platform as any)));
  test('assembles only a complete qualified matrix and records rollback identity', () => {
    const proposal = scannerCatalogProposal(SCANNER_CATALOG, fragments(), 'cso-scanners-qualified-42', expected);
    expect(proposal.scanners).toHaveLength(12); expect(proposal.previousRevision).toBe(SCANNER_CATALOG.revision);
    expect(proposal.promotion).toMatchObject({ sourceCommit: expected.sourceCommit, workflow: expected.workflow });
    expect(proposal.promotion!.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proposal.scanners.map(profile => `${profile.scanner}:${profile.platform}`)).toEqual([...proposal.scanners.map(profile => `${profile.scanner}:${profile.platform}`)].sort());
  });
  test('rejects missing platforms, claimed capabilities, provenance substitution, and foreign image repositories', () => {
    const missing = fragments(); missing.pop(); expect(() => scannerCatalogProposal(SCANNER_CATALOG, missing, 'missing-profile', expected)).toThrow('INCOMPLETE_SCANNER_CATALOG_MATRIX');
    const capabilities = fragments() as any[]; capabilities[0].capabilities = ['invented']; expect(() => scannerCatalogProposal(SCANNER_CATALOG, capabilities, 'bad-capability', expected)).toThrow('capabilities do not match');
    const source = fragments() as any[]; source[0].qualification.sourceCommit = 'd'.repeat(40); expect(() => scannerCatalogProposal(SCANNER_CATALOG, source, 'wrong-source', expected)).toThrow('SOURCE_COMMIT_MISMATCH');
    const foreign = fragments() as any[]; foreign[0].image = image('foreign').replace('garrytan/gstack', 'other/repo'); expect(() => scannerCatalogProposal(SCANNER_CATALOG, foreign, 'foreign-image', expected)).toThrow('Scanner profile is not qualified');
  });
  test('promotion is a compare-and-swap against the currently reviewed revision', () => {
    const proposal = scannerCatalogProposal(SCANNER_CATALOG, fragments(), 'cso-scanners-qualified-43', expected);
    expect(() => validateScannerCatalogTransition(SCANNER_CATALOG, proposal)).not.toThrow();
    expect(() => validateScannerCatalogTransition({ ...SCANNER_CATALOG, revision: 'catalog-advanced-concurrently' }, proposal)).toThrow('SCANNER_CATALOG_BASE_REVISION_MISMATCH');
  });
  test('hashes files and trees deterministically and rejects linked asset payloads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-scanner-assets-')); temps.push(root); fs.mkdirSync(path.join(root, 'nested')); fs.writeFileSync(path.join(root, 'nested', 'b'), 'two'); fs.writeFileSync(path.join(root, 'a'), 'one');
    const first = scannerAssetHash(root); expect(first).toMatch(/^[a-f0-9]{64}$/); expect(scannerAssetHash(root)).toBe(first); expect(scannerAssetHash(path.join(root, 'a'))).toBe(sha256('one'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'linked')); expect(() => scannerAssetHash(root)).toThrow('UNSAFE_SCANNER_ASSET');
    const top = path.join(path.dirname(root), `${path.basename(root)}-link`); temps.push(top); fs.symlinkSync(root, top); expect(() => scannerAssetHash(top)).toThrow('UNSAFE_SCANNER_ASSET');
  });
});

describe('CSO scanner qualification workflow', () => {
  test('is branch-testable while catalog promotion is protected-main and review gated', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/cso-scanner-images.yml'), 'utf8'), workflow = Bun.YAML.parse(raw) as any;
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']); expect(workflow.jobs['reviewed-inputs'].if).toBeUndefined(); expect(workflow.jobs['stage-and-qualify'].if).toBeUndefined();
    expect(workflow.jobs['stage-and-qualify'].environment).toBeUndefined();
    expect(workflow.jobs['promote-catalog'].if).toContain("github.ref == 'refs/heads/main'"); expect(workflow.jobs['promote-catalog'].if).toContain('inputs.promote_catalog == true'); expect(workflow.jobs['promote-catalog'].environment).toBe('cso-scanner-release');
    expect(workflow.jobs['promote-catalog'].permissions.packages).toBe('read');
    expect(raw).toContain('test/cso-scanners.test.ts test/cso-scanner-executor.test.ts test/cso-scanner-release.test.ts');
    expect(raw).toContain('test/cso-scanner-docker-integration.test.ts'); expect(raw).toContain('GSTACK_CSO_SCANNER_VERSION_HASH'); expect(raw).toContain('hash-asset scanner-asset');
    expect(raw).toContain('Require a public package and anonymously load the verified immutable image');
    expect(raw).toContain('scripts/cso-public-ghcr.ts verify');
    expect(raw).toContain('--repository "$GITHUB_REPOSITORY" --output public-image.json');
    expect(raw).toContain('sha256sum "$output" staged-profile.json version.sha256 declared-assets.json public-image.json');
    const anonymousStage = workflow.jobs['stage-and-qualify'].steps.find((step: any) => step.run?.includes('scripts/cso-public-ghcr.ts verify'));
    expect(anonymousStage.env.GH_TOKEN).toBe('${{ github.token }}');
    for(const value of ['--signer-workflow "$signer_workflow"','--signer-digest "$signer_digest"','--source-digest "$source_commit"','cso-attestation-evidence.ts digest','provenanceStatementDigest','sbomStatementDigest'])expect(raw).toContain(value);
    expect(raw).not.toContain('cso-scanner-staging');
    const docker = fs.readFileSync(path.join(ROOT, 'lib/cso/docker.ts'), 'utf8');
    for (const flag of ["'--pull=never'", "'--read-only'", "'--cap-drop','ALL'", "'no-new-privileges:true'", "'seccomp=builtin'", "'--log-driver=none'", "'--network'"]) expect(docker).toContain(flag);
    expect(docker).toContain("['rm','--force','--volumes',id]"); expect(docker).toContain('Pinned runtime image declares writable volumes');
    expect(raw).toContain('cso-scanner-catalog.ts assemble'); expect(raw).toContain('cso-scanner-catalog.ts validate-transition lib/cso/scanner-images/catalog.json promotion/catalog-proposal.json'); expect(raw).toContain('gh pr create --base main');
    const publicPromotion = raw.indexOf('Recheck public visibility and anonymous pulls before promotion');
    const sourcePromotion = raw.indexOf('Revalidate and open the reviewable source catalog PR');
    expect(publicPromotion).toBeGreaterThanOrEqual(0); expect(sourcePromotion).toBeGreaterThan(publicPromotion);
    expect(raw.slice(publicPromotion, sourcePromotion)).toContain('--remove-after');
    for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });
  test('commits no invented release input and normalizes scanner images to the constrained helper contract', () => {
    const inputs = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/cso/scanner-images/build-inputs.json'), 'utf8'));
    expect(inputs).toMatchObject({ state: 'pending', profiles: [], sbomGenerator: null });
    const dockerfile = fs.readFileSync(path.join(ROOT, 'lib/cso/scanner-images/scanner.Dockerfile'), 'utf8');
    for (const value of ['/opt/cso/entrypoint', '/opt/cso/bin/scanner', 'USER 10001:10001', 'test -x /bin/sleep', 'test -x /bin/cat']) expect(dockerfile).toContain(value);
    expect(fs.readFileSync(path.join(ROOT, 'lib/cso/scanner-executor.ts'), 'utf8')).toContain("capture(['/bin/cat', plan.outputPath])");
    const postgres = fs.readFileSync(path.join(ROOT, 'lib/cso/images/postgresql.Dockerfile'), 'utf8');
    for (const value of ['FROM ${BASE_IMAGE} AS upstream', 'FROM scratch', 'COPY --from=upstream / /']) expect(postgres).toContain(value);
  });
});
