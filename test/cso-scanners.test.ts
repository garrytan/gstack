import { describe, expect, test } from 'bun:test';
import {
  importSarif, MAX_SCANNER_OUTPUT_BYTES, parseScannerOutput, scannerLocation,
  scannerPlans, validateScannerBaseUrl, type ScannerId, type ScannerPlan,
} from '../lib/cso/scanners';

function plan(id: ScannerId): ScannerPlan {
  return scannerPlans({
    snapshotRoot: '/src', offline: true, selected: [id], semgrepRules: '/policy/rules.yml', advisoryCache: '/advisories',
    schemaPath: '/policy/openapi.json', baseUrl: 'http://127.0.0.1:3000/', operationIds: ['readDocument'],
  })[0];
}

function parse(id: ScannerId, data: unknown, exitCode = 0) {
  return parseScannerOutput(plan(id), { stdout: JSON.stringify(data), exitCode, version: 'scanner 2.3.0', databaseUpdatedAt: '2026-09-09T00:00:00.000Z' });
}

function sarif(result?: Record<string, unknown>) {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', version: '2.22.0', rules: [{ id: 'js/sql-injection', defaultConfiguration: { level: 'error' } }] } }, results: result ? [result] : [] }] };
}
function sarifResult(uri = 'src/routes.ts') {
  return { ruleIndex: 0, message: { text: 'Untrusted input reaches a query.' }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 12, startColumn: 3 } } }] };
}

describe('CSO scanner execution plans', () => {
  test('all six plans require containment and never acquire dependencies or inherit credentials', () => {
    const plans = scannerPlans({ snapshotRoot: '/src', offline: false });
    expect(plans.map(p => p.id)).toEqual(['gitleaks', 'osv', 'semgrep', 'zizmor', 'trivy', 'schemathesis']);
    for (const p of plans) {
      expect(p.execution).toBe('sandbox');
      expect(p.network).toBe(p.id === 'schemathesis' ? 'loopback' : 'none');
      expect(p.timeoutSeconds).toBeLessThanOrEqual(300);
      expect(p.maxOutputBytes).toBe(MAX_SCANNER_OUTPUT_BYTES);
      expect(Object.keys(p.env)).not.toContain('GITHUB_TOKEN');
      expect(Object.keys(p.env)).not.toContain('PATH');
      expect(p.args.join(' ')).not.toMatch(/npx|uvx|--allow-local-builds|--call-analysis=|--autofix|download-offline/);
      expect(p.provenanceSources.length).toBeGreaterThan(0);
    }
  });

  test('OSV uses full offline v2 scanning with code analysis disabled', () => {
    const p = plan('osv');
    expect(p.args).toContain('--offline');
    expect(p.args).not.toContain('--offline-vulnerabilities');
    expect(p.args).toContain('--no-call-analysis=all');
    expect(p.args.slice(0, 2)).toEqual(['scan', 'source']);
    const old = scannerPlans({ snapshotRoot: '/src', offline: true, selected: ['osv'], advisoryCache: '/advisories', tools: { osv: { available: true, version: '1.9.0' } } })[0];
    expect(old.prerequisites.join(' ')).toContain('major version 2');
  });

  test('Gitleaks scans current files and bypasses project suppressions with full redaction', () => {
    const p = plan('gitleaks');
    expect(p.args[0]).toBe('dir');
    expect(p.args).toContain('--redact=100');
    expect(p.args).toContain('--report-path=-');
    expect(p.args).toContain('--ignore-gitleaks-allow');
    expect(p.trustedFiles.some(f => f.content.includes('useDefault = true'))).toBe(true);
    const history = scannerPlans({ snapshotRoot: '/src', offline: true, selected: ['gitleaks'], gitHistory: '/history' })[0];
    expect(history.args[0]).toBe('git');
    expect(history.prerequisites.join(' ')).toContain('no hooks');
  });

  test('Semgrep cannot select hosted rules, upload findings, or enable code builds', () => {
    const p = plan('semgrep');
    expect(p.args[0]).toBe('scan');
    expect(p.args).toContain('--metrics=off');
    expect(p.args).toContain('--disable-version-check');
    expect(p.args).toContain('--oss-only');
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, semgrepRules: 'p/security-audit' })).toThrow();
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, semgrepRules: '/src/rules.yml' })).toThrow();
  });

  test('zizmor ignores environment online defaults and repo config', () => {
    const p = plan('zizmor');
    expect(p.args).toContain('--offline');
    expect(p.args).toContain('--no-config');
    expect(p.args).toContain('--no-ignores');
    expect(p.env.ZIZMOR_OFFLINE).toBe('1');
  });

  test('Trivy suppresses telemetry, metadata calls, version checks, and every database update', () => {
    const p = plan('trivy');
    for (const flag of ['--disable-telemetry', '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-check-update', '--skip-version-check', '--skip-vex-repo-update']) expect(p.args).toContain(flag);
    expect(p.args).toContain('/policy/trivy.yaml');
    expect(p.args).toContain('/policy/trivyignore');
  });

  test('Schemathesis restricts operation count, redirects, seed, time, and report location', () => {
    const p = plan('schemathesis');
    expect(p.prerequisites).toEqual([]);
    for (const arg of ['--workers=1', '--phases=fuzzing', '--max-redirects=0', '--seed', '--max-examples', '--max-time', '--report-json-path', '--include-operation-id']) expect(p.args).toContain(arg);
    expect(p.outputPath).toBe('/work/schemathesis.json');
    expect(p.coverage.scope).toEqual(['operation:readDocument']);
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, schemaPath: 'https://example.test/api.json' })).toThrow();
  });

  test.each(['http://example.com', 'http://localhost:3000', 'http://169.254.169.254/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.0.0.1.evil.test/', 'http://user:pass@127.0.0.1/', 'file:///tmp/app', 'http://[::ffff:127.0.0.1]/', 'http://127.0.0.1/?x=secret'])('rejects non-canonical or credential-bearing target %s', url => {
    expect(() => validateScannerBaseUrl(url)).toThrow();
  });

  test('numeric IPv4 and IPv6 loopback are accepted', () => {
    expect(validateScannerBaseUrl('http://127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
    expect(validateScannerBaseUrl('http://[::1]:8080/api')).toBe('http://[::1]:8080/api');
  });

  test('invalid bounds and source-controlled policy are rejected before execution', () => {
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, deadlineSeconds: 301 })).toThrow();
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, policyRoot: '/src/policy' })).toThrow();
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, advisoryCache: '/src/cache' })).toThrow();
    expect(() => scannerPlans({ snapshotRoot: '/src/../etc', offline: true })).toThrow();
    expect(() => scannerPlans({ snapshotRoot: '/src', offline: true, selected: ['osv', 'osv'] })).toThrow();
  });
});

describe('CSO scanner candidate normalization', () => {
  test('Gitleaks retains location and rule while discarding secret-bearing fields', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const result = parse('gitleaks', [{ RuleID: 'github-pat', Description: 'Possible token', File: '/src/config.ts', StartLine: 2, StartColumn: 5, Secret: secret, Match: secret, Line: secret, Author: 'person@example.test' }], 10);
    expect(result.status).toBe('complete');
    expect(result.candidates[0].location?.path).toBe('config.ts');
    expect(result.candidates[0].evidence).toBe('scanner-candidate');
    expect(result.candidates[0].trust).toBe('untrusted');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('person@example.test');
  });

  test('OSV aliases and affected version never imply reachability or production exposure', () => {
    const result = parse('osv', { results: [{ source: { path: '/src/package-lock.json' }, packages: [{ package: { name: 'vulnerable-package', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-abcd-efgh-ijkl', aliases: ['CVE-2026-12345'], summary: 'Unsafe parsing' }] }] }] }, 1);
    expect(result.status).toBe('complete');
    expect(result.candidates[0].dependency).toEqual({ name: 'vulnerable-package', version: '1.0.0', ecosystem: 'npm', reachability: 'unknown', exposure: 'unknown' });
    expect(result.candidates[0].advisoryIds).toContain('CVE-2026-12345');
  });

  test('Semgrep keeps independent errors even with useful candidates', () => {
    const result = parse('semgrep', { results: [{ check_id: 'sql-injection', path: 'api.ts', start: { line: 7, col: 3 }, extra: { message: 'Query input', severity: 'ERROR' } }], errors: [{ type: 'ParseError' }], paths: { scanned: ['api.ts'], skipped: ['legacy.rb'] } });
    expect(result.status).toBe('partial');
    expect(result.candidates).toHaveLength(1);
    expect(result.gaps.map(g => g.code)).toEqual(['TOOL_FAILED', 'SKIPPED_INPUT']);
  });

  test('zizmor SARIF becomes candidate evidence and retains suppression', () => {
    const data = sarif({ ...sarifResult('.github/workflows/deploy.yml'), ruleId: 'dangerous-triggers', suppressions: [{ kind: 'inSource' }] });
    const result = parse('zizmor', data);
    expect(result.status).toBe('complete');
    expect(result.candidates[0].suppressed).toBe(true);
    expect(result.candidates[0].tool).toBe('zizmor');
  });

  test('Trivy normalizes dependency, secret, and infrastructure candidates separately', () => {
    const result = parse('trivy', { SchemaVersion: 2, Results: [
      { Target: 'package-lock.json', Type: 'npm', Vulnerabilities: [{ VulnerabilityID: 'CVE-2026-12345', PkgName: 'lib', InstalledVersion: '2.0.0', Severity: 'HIGH' }] },
      { Target: 'Dockerfile', Misconfigurations: [{ ID: 'DS002', Title: 'Root user', Severity: 'MEDIUM', CauseMetadata: { StartLine: 2 } }] },
      { Target: 'config.rb', Secrets: [{ RuleID: 'generic-api-key', Title: 'Key', Severity: 'CRITICAL', StartLine: 1 }] },
    ] });
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].dependency?.reachability).toBe('unknown');
    expect(result.candidates[1].location?.line).toBe(2);
  });

  test('Schemathesis assertion failures do not become reproduced vulnerabilities', () => {
    const result = parse('schemathesis', { schemathesis_version: '4.0.0', complete: true, stop_reason: 'completed', operations: { selected: 1, tested: 1, errored: 0, skipped: 0 }, errors: [], failures: [{ type: 'ServerError', title: 'Server error', severity: 'critical', operations: ['GET /documents'] }] }, 1);
    expect(result.status).toBe('complete');
    expect(result.candidates[0].operation).toBe('GET /documents');
    expect(result.candidates[0].evidence).toBe('scanner-candidate');
    expect(result.candidates[0]).not.toHaveProperty('reproduced');
  });

  test('startup failure and zero exercised operations remain not covered', () => {
    const result = parse('schemathesis', { schemathesis_version: '4.0.0', complete: false, stop_reason: 'interrupted', operations: null, errors: [{ title: 'Schema load failed' }], failures: [] }, 1);
    expect(result.status).toBe('partial');
    expect(result.candidates).toHaveLength(0);
    expect(result.gaps.some(g => g.message.includes('no operations'))).toBe(true);
  });

  test('fingerprints do not depend on generated descriptions', () => {
    const row = { RuleID: 'hardcoded-token', Description: 'Original title', File: 'config.ts', StartLine: 4 };
    const a = parse('gitleaks', [row], 10), b = parse('gitleaks', [{ ...row, Description: 'New generated wording' }], 10);
    expect(a.candidates[0].id).toBe(b.candidates[0].id);
    expect(a.planSha256).toBe(b.planSha256);
  });
});

describe('CSO scanner failure and hostile-input handling', () => {
  test('missing optional scanners do not return a clean assessment', () => {
    const result = parseScannerOutput(plan('gitleaks'), { stdout: '', exitCode: null, unavailable: true });
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('UNAVAILABLE');
  });

  test('missing local rules/databases become precise prerequisites without downloads', () => {
    const p = scannerPlans({ snapshotRoot: '/src', offline: true, selected: ['osv'] })[0];
    const result = parseScannerOutput(p, { stdout: '{"results":[]}', exitCode: 0 });
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('PREREQUISITE');
    expect(result.gaps[0].message).toContain('offline OSV');
  });

  test('an OSV extraction failure on stderr cannot produce empty-clean JSON coverage', () => {
    const result = parseScannerOutput(plan('osv'), { stdout: '{"results":[]}', stderr: 'Error during extraction: no offline version of the OSV database is available', exitCode: 0, databaseUpdatedAt: '2026-09-09T00:00:00.000Z' });
    expect(result.status).toBe('partial');
    expect(result.gaps.some(g => g.code === 'TOOL_FAILED')).toBe(true);
  });

  test.each(['', '{', 'null', '[]', '{"results":[]}'])('malformed Semgrep output %s never passes', raw => {
    const result = parseScannerOutput(plan('semgrep'), { stdout: raw, exitCode: 0 });
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('INVALID_OUTPUT');
  });

  test('unrecognized exit code and timeout remain gaps even with syntactically complete output', () => {
    const result = parseScannerOutput(plan('gitleaks'), { stdout: '[]', exitCode: 2, timedOut: true });
    expect(result.status).toBe('partial');
    expect(result.gaps.map(g => g.code)).toEqual(['TIMEOUT', 'TOOL_FAILED']);
  });

  test('truncation withholds the entire payload including a secret split across capture chunks', () => {
    const chunks = ['[{"RuleID":"x","Description":"gh', 'p_' + 'A'.repeat(36) + '","File":"x"}]'];
    const result = parseScannerOutput(plan('gitleaks'), { stdout: chunks.join(''), exitCode: 10, truncated: true });
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('OUTPUT_LIMIT');
    expect(result.candidates).toHaveLength(0);
  });

  test('capture budget applies to UTF-8 bytes and stderr together', () => {
    const result = parseScannerOutput(plan('gitleaks'), { stdout: '[]', stderr: 'λ'.repeat(MAX_SCANNER_OUTPUT_BYTES / 2), exitCode: 0 });
    expect(result.gaps[0].code).toBe('OUTPUT_LIMIT');
  });

  test('marker-only private keys withhold the entire decoded document', () => {
    const data = [{ RuleID: 'key', Description: '-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----', File: 'config' }];
    const result = parse('gitleaks', data, 10);
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('REDACTION_FAILED');
    expect(JSON.stringify(result)).not.toContain('secretbody');
  });

  test('JSON unicode escapes cannot bypass the decoded-string redactor', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const raw = JSON.stringify([{ RuleID: 'key', Description: secret, File: 'config' }]).replace('ghp_', '\\u0067hp_');
    const result = parseScannerOutput(plan('gitleaks'), { stdout: raw, exitCode: 10 });
    expect(result.status).toBe('complete');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.candidates[0].message).toContain('REDACTED');
  });

  test('prototype keys and extreme nesting are rejected without leaking raw content', () => {
    for (const raw of ['{"__proto__":{"polluted":true}}', '['.repeat(70) + '[]' + ']'.repeat(70)]) {
      const result = parseScannerOutput(plan('gitleaks'), { stdout: raw, exitCode: 0 });
      expect(result.status).toBe('not_assessed');
      expect(result.gaps[0].code).toBe('INVALID_OUTPUT');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('unknown database freshness is explicit even when there are no advisories', () => {
    const result = parseScannerOutput(plan('osv'), { stdout: '{"results":[]}', exitCode: 0 });
    expect(result.status).toBe('partial');
    expect(result.databaseUpdatedAt).toBeNull();
    expect(result.gaps[0].code).toBe('UNKNOWN_FRESHNESS');
  });

  test('finding exit codes cannot certify an empty-clean report', () => {
    const result = parse('gitleaks', [], 10);
    expect(result.status).toBe('partial');
    expect(result.gaps[0].code).toBe('INVALID_OUTPUT');
  });

  test('a schema version alone is not evidence of a completed Trivy scan', () => {
    const result = parse('trivy', { SchemaVersion: 2 });
    expect(result.status).toBe('not_assessed');
    expect(result.gaps[0].code).toBe('INVALID_OUTPUT');
  });
});

describe('CSO SARIF import boundary', () => {
  test('CodeQL SARIF imports read-only candidates with artifact-index locations', () => {
    const data = sarif(sarifResult());
    const run = data.runs[0] as Record<string, any>;
    run.artifacts = [{ location: { uri: 'src/routes.ts' } }];
    run.results[0].locations[0].physicalLocation.artifactLocation = { index: 0 };
    const result = importSarif(JSON.stringify(data), { sourceRoot: '/src' });
    expect(result.status).toBe('complete');
    expect(result.tool).toBe('sarif');
    expect(result.candidates[0].tool).toBe('sarif');
    expect(result.candidates[0].ruleId).toBe('js/sql-injection');
    expect(result.candidates[0].location).toEqual({ path: 'src/routes.ts', line: 12, column: 3 });
  });

  test.each(['../.ssh/id_rsa', '%2e%2e/.ssh/id_rsa', '%252e%252e/.ssh/id_rsa', 'file:///etc/passwd', 'file://remote/src/file.ts', 'https://evil.test/collect', 'javascript:alert(1)', '//evil.test/file', 'C:\\Users\\secret', 'src/../../secret', 'src/%00file'])('rejects unsafe artifact URI %s', uri => {
    const result = importSarif(JSON.stringify(sarif(sarifResult(uri))), { sourceRoot: '/src' });
    expect(result.status).toBe('partial');
    expect(result.candidates).toHaveLength(0);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(() => scannerLocation(uri, '/src')).toThrow();
  });

  test('failed invocation does not erase independently useful candidates or imply complete coverage', () => {
    const data = sarif(sarifResult());
    (data.runs[0] as Record<string, unknown>).invocations = [{ executionSuccessful: false }];
    const result = importSarif(JSON.stringify(data), { sourceRoot: '/src' });
    expect(result.status).toBe('partial');
    expect(result.candidates).toHaveLength(1);
    expect(result.gaps[0].code).toBe('TOOL_FAILED');
  });

  test('SARIF passing checks are not vulnerability candidates', () => {
    const result = importSarif(JSON.stringify(sarif({ ...sarifResult(), kind: 'pass' })), { sourceRoot: '/src' });
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(0);
  });

  test('an untrusted originalUriBaseIds map cannot change the assessment root', () => {
    const data = sarif(sarifResult('secret.ts'));
    const run = data.runs[0] as Record<string, any>;
    run.originalUriBaseIds = { ROOT: { uri: 'file:///etc/' } };
    run.results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'ROOT';
    const result = importSarif(JSON.stringify(data), { sourceRoot: '/src' });
    expect(result.candidates).toHaveLength(0);
    expect(result.status).toBe('partial');
  });

  test('SARIF external properties are not fetched and missing runs are not a clean scan', () => {
    const result = importSarif(JSON.stringify({ version: '2.1.0', runs: [], externalProperties: [{ uri: 'https://evil.test/' }] }), { sourceRoot: '/src' });
    expect(result.status).toBe('partial');
    expect(result.candidates).toHaveLength(0);
    expect(result.gaps[0].code).toBe('SKIPPED_INPUT');
  });

  test('external SARIF result references are an explicit coverage gap', () => {
    const data = sarif();
    (data.runs[0] as Record<string, unknown>).externalPropertyFileReferences = { results: [{ location: { uri: 'https://evil.test/results.json' } }] };
    const result = importSarif(JSON.stringify(data), { sourceRoot: '/src' });
    expect(result.status).toBe('partial');
    expect(result.gaps[0].message).toContain('External SARIF');
  });
});
