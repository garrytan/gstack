/**
 * CSO scanner boundary: declarative sandbox plans and bounded, untrusted evidence.
 * This module never spawns tools, downloads rules, reads project config, or grants
 * findings a supported/reproduced/tested status. The runner enforces every plan.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { redactFindingSpans } from '../redact-engine';

export const SCANNER_IDS = ['gitleaks', 'osv', 'semgrep', 'zizmor', 'trivy', 'schemathesis'] as const;
export type ScannerId = typeof SCANNER_IDS[number];
export type ScannerFormat = 'gitleaks-json' | 'osv-json' | 'semgrep-json' | 'sarif' | 'trivy-json' | 'schemathesis-json';
export const MAX_SCANNER_OUTPUT_BYTES = 1_048_576;
const MAX_CANDIDATES = 5_000;

export interface ScannerPlan {
  id: ScannerId;
  executableName: string;
  args: string[];
  versionArgs: string[];
  requiredFeatures: string[];
  format: ScannerFormat;
  execution: 'sandbox';
  network: 'none' | 'loopback';
  /** No inherited environment, PATH, tokens, or project configuration. */
  env: Record<string, string>;
  cwd: string;
  sourceRoot: string;
  outputPath?: string;
  trustedFiles: Array<{ path: string; content: string }>;
  prerequisites: string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  coverage: { domain: string; scope: string[]; exclusions: string[] };
  provenanceSources: string[];
  documentationInspectedAt: string;
}

export interface ScannerOptions {
  snapshotRoot: string;
  offline: boolean;
  tools?: Partial<Record<ScannerId, { available: boolean; version?: string; capabilities?: string[] }>>;
  selected?: ScannerId[];
  /** Paths below policyRoot must be trusted, immutable inputs, never repo files. */
  policyRoot?: string;
  semgrepRules?: string;
  advisoryCache?: string;
  schemaPath?: string;
  baseUrl?: string;
  seed?: number;
  maxExamples?: number;
  operationIds?: string[];
  deadlineSeconds?: number;
  /** A separately sanitized inert Git history, not the original .git directory. */
  gitHistory?: string;
}

export interface ScannerCandidate {
  id: string;
  tool: ScannerId | 'sarif';
  ruleId: string;
  message: string;
  reportedSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';
  location?: { path: string; line?: number; column?: number };
  advisoryIds: string[];
  dependency?: { name: string; version?: string; ecosystem?: string; reachability: 'unknown'; exposure: 'unknown' };
  operation?: string;
  suppressed: boolean;
  evidence: 'scanner-candidate';
  trust: 'untrusted';
}

export interface ScannerGap {
  code: 'UNAVAILABLE' | 'PREREQUISITE' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'INVALID_OUTPUT' | 'TOOL_FAILED' |
    'REDACTION_FAILED' | 'ISOLATION_FAILED' | 'PERSISTENCE_FAILED' | 'SNAPSHOT_RACE' | 'CANCELLED' |
    'INSUFFICIENT_CAPACITY' | 'UNSAFE_PATH' | 'MISSING_INPUT' | 'INCOMPATIBLE_INPUT' |
    'UNSAFE_LOCATION' | 'SKIPPED_INPUT' | 'UNKNOWN_FRESHNESS';
  message: string;
}

export interface ScannerOutcome {
  tool: ScannerId | 'sarif';
  version: string | null;
  status: 'complete' | 'partial' | 'not_assessed';
  candidates: ScannerCandidate[];
  gaps: ScannerGap[];
  scope: string[];
  exclusions: string[];
  databaseUpdatedAt: string | null;
  exitCode: number | null;
  evidence: 'scanner-candidate';
  provenanceSources: string[];
  /** Binds the deterministic command/config to its execution record. */
  planSha256: string;
  documentationInspectedAt: string;
}

export interface ScannerExecution {
  /** Complete bounded report; stdout chunks must be joined BEFORE this call. */
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  version?: string;
  databaseUpdatedAt?: string;
  timedOut?: boolean;
  unavailable?: boolean;
  truncated?: boolean;
}

const SOURCES: Record<ScannerId, string[]> = {
  gitleaks: ['https://github.com/gitleaks/gitleaks/blob/master/README.md'],
  osv: ['https://google.github.io/osv-scanner/usage/scan-source/', 'https://google.github.io/osv-scanner/usage/offline-mode/'],
  semgrep: ['https://docs.semgrep.dev/cli-reference'],
  zizmor: ['https://docs.zizmor.sh/usage/', 'https://docs.zizmor.sh/quickstart/'],
  trivy: ['https://trivy.dev/docs/dev/docs/advanced/telemetry/', 'https://trivy.dev/docs/latest/guide/advanced/air-gap/'],
  schemathesis: ['https://schemathesis.readthedocs.io/en/stable/reference/cli/', 'https://github.com/schemathesis/schemathesis/blob/master/src/schemathesis/cli/json_report.py'],
};

function absolutePath(value: string, name: string): string {
  if (value === '/' || !value.startsWith('/') || value.startsWith('//') || /[\x00-\x1f\\]/.test(value) || value.split('/').includes('..')) {
    throw new Error(`${name} must be an absolute sandbox path without traversal`);
  }
  return posix.normalize(value);
}

function positiveInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`);
  return value;
}

/** Numeric loopback only: no DNS, URL credentials, redirected targets, or remote schemas. */
export function validateScannerBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Schemathesis requires a numeric loopback HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search) {
    throw new Error('Schemathesis requires a numeric loopback HTTP URL without credentials, query, or fragment');
  }
  // URL canonicalization accepts integer, hex, and shorthand IPv4. Reject these spellings.
  if (!/^https?:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(raw)) throw new Error('Schemathesis requires canonical numeric loopback');
  return url.href;
}

/**
 * Even online CSO runs collect scanner evidence without external egress. Database
 * refresh belongs to the separate registry/advisory acquisition phase. A missing
 * optional scanner is a gap in THIS assessment, not automatically the whole run.
 */
export function scannerPlans(opts: ScannerOptions): ScannerPlan[] {
  const root = absolutePath(opts.snapshotRoot, 'snapshotRoot');
  const policy = absolutePath(opts.policyRoot ?? '/policy', 'policyRoot');
  if (policy === root || policy.startsWith(`${root}/`) || root.startsWith(`${policy}/`)) throw new Error('policyRoot must be separate from source');
  const cache = opts.advisoryCache ? absolutePath(opts.advisoryCache, 'advisoryCache') : undefined;
  if (cache && (cache === root || cache.startsWith(`${root}/`))) throw new Error('advisoryCache must be separate from source');
  const timeout = positiveInteger(opts.deadlineSeconds ?? 120, 300, 'deadlineSeconds');
  const selected = opts.selected ?? [...SCANNER_IDS];
  if (new Set(selected).size !== selected.length || selected.some(id => !SCANNER_IDS.includes(id))) throw new Error('Invalid or duplicate scanner selection');
  return selected.map(id => {
    const plan: ScannerPlan = {
      id, executableName: id === 'osv' ? 'osv-scanner' : id, args: [], versionArgs: ['--version'], requiredFeatures: [],
      format: 'sarif', execution: 'sandbox', network: 'none', cwd: '/work', sourceRoot: root,
      env: { HOME: '/work/home', TMPDIR: '/tmp', LANG: 'C.UTF-8', NO_COLOR: '1' }, trustedFiles: [], prerequisites: [],
      timeoutSeconds: timeout, maxOutputBytes: MAX_SCANNER_OUTPUT_BYTES,
      coverage: { domain: id, scope: [root], exclusions: ['Snapshot transformations apply; inspect the snapshot manifest.'] },
      provenanceSources: SOURCES[id], documentationInspectedAt: '2026-09-09',
    };
    if (opts.tools?.[id]?.available === false) plan.prerequisites.push(`Install a reviewed ${plan.executableName} executable in the scanner image.`);
    switch (id) {
      case 'gitleaks': {
        const target = opts.gitHistory ? absolutePath(opts.gitHistory, 'gitHistory') : root;
        plan.format = 'gitleaks-json';
        plan.coverage.domain = 'secrets';
        plan.coverage.scope = [target];
        plan.trustedFiles.push({ path: `${policy}/gitleaks.toml`, content: '[extend]\nuseDefault = true\n' }, { path: `${policy}/gitleaksignore`, content: '' });
        plan.args = [opts.gitHistory ? 'git' : 'dir', '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow', '--gitleaks-ignore-path', `${policy}/gitleaksignore`, '--config', `${policy}/gitleaks.toml`, '--report-format=json', '--report-path=-', '--exit-code=10', '--timeout', String(timeout), target];
        if (opts.gitHistory) plan.prerequisites.push('History input must be a sanitized Git object store with trusted config and no hooks, filters, alternates, or external helpers.');
        else plan.coverage.exclusions.push('Historical revisions are not scanned by this directory pass.');
        plan.requiredFeatures = ['dir', '--redact', '--ignore-gitleaks-allow'];
        break;
      }
      case 'osv':
        plan.format = 'osv-json'; plan.coverage.domain = 'dependencies';
        plan.trustedFiles.push({ path: `${policy}/osv-scanner.toml`, content: '' });
        plan.args = ['scan', 'source', '--format=json', '--offline', '--no-call-analysis=all', '--config', `${policy}/osv-scanner.toml`, '--recursive', root];
        plan.requiredFeatures = ['scan source', '--offline', '--no-call-analysis'];
        if (cache) plan.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = cache;
        else plan.prerequisites.push('Provide verified offline OSV databases for every assessed ecosystem.');
        plan.coverage.exclusions.push('Call analysis is disabled; dependency reachability remains unknown until independently investigated.');
        break;
      case 'semgrep': {
        plan.format = 'semgrep-json'; plan.coverage.domain = 'code';
        const rules = opts.semgrepRules ? absolutePath(opts.semgrepRules, 'semgrepRules') : `${policy}/semgrep.yml`;
        if (!rules.startsWith(`${policy}/`)) throw new Error('Semgrep rules must be below the trusted policyRoot');
        if (!opts.semgrepRules) plan.prerequisites.push('Provide a reviewed, pinned local Semgrep ruleset; registry aliases and repo rules are not accepted.');
        plan.args = ['scan', '--json', '--config', rules, '--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore', '--no-secrets-validation', '--oss-only', '--no-autofix', '--timeout=10', '--timeout-threshold=3', '--jobs=1', root];
        plan.env.SEMGREP_SEND_METRICS = 'off'; plan.env.SEMGREP_ENABLE_VERSION_CHECK = '0'; plan.env.SEMGREP_APP_TOKEN = '';
        plan.requiredFeatures = ['scan', '--metrics', '--disable-version-check', '--no-secrets-validation', '--oss-only'];
        plan.coverage.exclusions.push('Semgrep language support, built-in file selection, and .semgrepignore rules can exclude inputs; independently inspect these exclusions.');
        break;
      }
      case 'zizmor':
        plan.coverage.domain = 'github-actions';
        plan.args = ['--offline', '--no-config', '--no-ignores', '--no-exit-codes', '--no-progress', '--color=never', '--format=sarif', root];
        plan.env.ZIZMOR_OFFLINE = '1'; plan.requiredFeatures = ['--offline', '--no-config', '--no-ignores'];
        plan.coverage.exclusions.push('Online GitHub audits and remote reusable action inspection require separate assessment.');
        break;
      case 'trivy':
        plan.format = 'trivy-json'; plan.coverage.domain = 'dependencies-and-infrastructure';
        plan.trustedFiles.push({ path: `${policy}/trivy.yaml`, content: '{}\n' }, { path: `${policy}/trivyignore`, content: '' });
        plan.args = ['fs', '--format=json', '--config', `${policy}/trivy.yaml`, '--ignorefile', `${policy}/trivyignore`, '--scanners=vuln,misconfig,secret', '--cache-backend=memory', '--disable-telemetry', '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-check-update', '--skip-version-check', '--skip-vex-repo-update', '--timeout', `${timeout}s`, ...(cache ? ['--cache-dir', cache] : []), root];
        plan.env.TRIVY_DISABLE_TELEMETRY = 'true';
        plan.requiredFeatures = ['--cache-backend', '--disable-telemetry', '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-check-update', '--skip-version-check', '--skip-vex-repo-update'];
        if (!cache) plan.prerequisites.push('Provide verified offline Trivy vulnerability, Java, and misconfiguration databases as needed.');
        break;
      case 'schemathesis': {
        plan.format = 'schemathesis-json'; plan.network = 'loopback'; plan.coverage.domain = 'api-runtime';
        plan.outputPath = '/work/schemathesis.json';
        // The upstream image enables a Python hook module and coverage plugin by
        // default. Qualified CSO scans use only the reviewed schema/config.
        plan.env.SCHEMATHESIS_HOOKS = ''; plan.env.SCHEMATHESIS_COVERAGE = 'false';
        plan.trustedFiles.push({ path: `${policy}/schemathesis.toml`, content: '' });
        const schema = opts.schemaPath ? absolutePath(opts.schemaPath, 'schemaPath') : `${policy}/openapi.json`;
        if (!schema.startsWith(`${policy}/`)) throw new Error('Schemathesis schema must be below trusted policyRoot');
        if (!opts.schemaPath) plan.prerequisites.push('Provide a reviewed local schema with resolved local references, no remote references, and no hook imports.');
        const base = opts.baseUrl ? validateScannerBaseUrl(opts.baseUrl) : 'http://127.0.0.1:3000/';
        if (!opts.baseUrl) plan.prerequisites.push('Start the application and a legitimate control in the admitted loopback namespace.');
        const seed = positiveInteger(opts.seed ?? 1, 2_147_483_647, 'seed');
        const examples = positiveInteger(opts.maxExamples ?? 20, 100, 'maxExamples');
        const operations = opts.operationIds ?? [];
        if (operations.length === 0 || operations.length > 20) plan.prerequisites.push('Declare between 1 and 20 reviewed operation IDs to bound the API assessment.');
        if (operations.some(op => !op || op.length > 200 || /[\x00-\x1f]/.test(op))) throw new Error('Invalid Schemathesis operation ID');
        plan.args = ['--config-file', `${policy}/schemathesis.toml`, '--no-color', 'run', schema, '--url', base, '--workers=1', '--phases=fuzzing', '--max-examples', String(examples), '--max-failures=10', '--max-time', String(timeout), '--seed', String(seed), '--request-timeout=5', '--request-retries=0', '--max-redirects=0', '--rate-limit=10/s', '--output-sanitize=true', '--generation-database=none', '--report-json-path', plan.outputPath, ...operations.flatMap(op => ['--include-operation-id', op])];
        plan.requiredFeatures = ['--report-json-path', '--max-time', '--seed', '--max-redirects', '--include-operation-id'];
        plan.coverage.scope = operations.map(op => `operation:${op}`);
        plan.coverage.exclusions.push('Only declared operations and generated examples are exercised; API failures are candidates, not security proofs.');
        break;
      }
    }
    const capabilities = opts.tools?.[id]?.capabilities;
    if (capabilities) for (const required of plan.requiredFeatures) {
      if (!capabilities.includes(required)) plan.prerequisites.push(`${plan.executableName} lacks required capability ${required}.`);
    }
    const version = opts.tools?.[id]?.version;
    if (id === 'osv' && version && !/\b(?:v)?2\./.test(version)) plan.prerequisites.push('OSV-Scanner major version 2 is required.');
    return plan;
  });
}

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Obj;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
function str(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('Expected bounded string');
  return value;
}
function optionalString(value: unknown): string | undefined { return value === undefined || value === null ? undefined : str(value); }
function integer(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid source coordinate');
  return value as number;
}
function severity(value: unknown): ScannerCandidate['reportedSeverity'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (['critical', 'high', 'medium', 'low', 'info'].includes(normalized)) return normalized as ScannerCandidate['reportedSeverity'];
  return ({ error: 'high', warning: 'medium', note: 'info', informational: 'info', unknown: 'unknown' } as const)[normalized] ?? 'unknown';
}

/** No path is opened by this module. Normalization refuses URI/traversal escapes. */
export function scannerLocation(raw: string, sourceRoot: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new Error('Unsafe location'); }
  if (/[\x00-\x1f\x7f]/.test(decoded) || /%[\da-f]{2}/i.test(decoded) || decoded.includes('\\')) throw new Error('Unsafe location');
  if (decoded.startsWith('file:')) {
    const url = new URL(decoded);
    if (url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Unsafe file URI');
    decoded = decodeURIComponent(url.pathname);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) throw new Error('Unsafe location');
  if (decoded.split('/').includes('..')) throw new Error('Unsafe location');
  const root = absolutePath(sourceRoot, 'sourceRoot');
  const absolute = decoded.startsWith('/') ? posix.normalize(decoded) : posix.join(root, decoded);
  if (!absolute.startsWith(`${root}/`)) throw new Error('Location outside source root');
  const result = posix.relative(root, absolute);
  if (!result || result === '.' || result.startsWith('../')) throw new Error('Unsafe location');
  return result;
}

class RedactionFailure extends Error {}
/** Scan decoded leaves as well as raw JSON: JSON escapes must not hide secrets. */
function decodedDocument(raw: string): unknown {
  if (redactFindingSpans(raw) === null) throw new RedactionFailure();
  const document: unknown = JSON.parse(raw);
  const pending: Array<{ value: unknown; depth: number }> = [{ value: document, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 100_000 || depth > 64) throw new Error('Output structure limit');
    if (!value || typeof value !== 'object') continue;
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe object key');
      const item = (value as Obj)[key];
      if (typeof item === 'string') {
        const safe = redactFindingSpans(item);
        if (safe === null) throw new RedactionFailure();
        // Terminal escape sequences cannot carry instructions through a report renderer.
        (value as Obj)[key] = safe.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      } else pending.push({ value: item, depth: depth + 1 });
    }
  }
  return document;
}

function candidate(tool: ScannerCandidate['tool'], fields: Omit<ScannerCandidate, 'id' | 'tool' | 'evidence' | 'trust' | 'suppressed'> & { suppressed?: boolean }): ScannerCandidate {
  const identity = [tool, fields.ruleId, fields.location?.path ?? fields.operation ?? '', fields.location?.line ?? '', ...fields.advisoryIds.slice().sort()];
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { ...fields, id, tool, suppressed: fields.suppressed ?? false, evidence: 'scanner-candidate', trust: 'untrusted' };
}

function location(path: unknown, line: unknown, column: unknown, root: string): ScannerCandidate['location'] {
  return { path: scannerLocation(str(path), root), line: integer(line), column: integer(column) };
}

function parseSarif(document: unknown, tool: ScannerCandidate['tool'], root: string, add: (value: ScannerCandidate) => void, gap: (code: ScannerGap['code'], message: string) => void): void {
  const sarif = obj(document);
  if (sarif.version !== '2.1.0') throw new Error('SARIF 2.1.0 required');
  const runs = arr(sarif.runs);
  if (!runs.length) { gap('SKIPPED_INPUT', 'SARIF contains no assessment runs.'); return; }
  for (const input of runs) {
    const run = obj(input); const driver = obj(obj(run.tool).driver);
    str(driver.name);
    if (run.externalPropertyFileReferences !== undefined) {
      const refs = obj(run.externalPropertyFileReferences);
      if (refs.results !== undefined && arr(refs.results).length) gap('SKIPPED_INPUT', 'External SARIF result files were not fetched or assessed.');
    }
    for (const invocation of run.invocations === undefined ? [] : arr(run.invocations)) {
      const inv = obj(invocation);
      if (inv.executionSuccessful === false) gap('TOOL_FAILED', 'SARIF records an unsuccessful tool invocation.');
      if (Array.isArray(inv.toolExecutionNotifications) && inv.toolExecutionNotifications.some(n => obj(n).level === 'error')) gap('TOOL_FAILED', 'SARIF records tool execution errors.');
    }
    const rules = driver.rules === undefined ? [] : arr(driver.rules);
    const results = arr(run.results);
    for (const inputResult of results) {
      try {
        const result = obj(inputResult);
        // SARIF also represents passing checks and informational inventory.
        if (['pass', 'notApplicable', 'informational'].includes(String(result.kind))) continue;
        const ruleIndex = result.ruleIndex;
        const rule = Number.isSafeInteger(ruleIndex) && (ruleIndex as number) >= 0 && rules[ruleIndex as number] ? obj(rules[ruleIndex as number]) : undefined;
        const ruleId = str(result.ruleId ?? rule?.id);
        const message = obj(result.message);
        let loc: ScannerCandidate['location'];
        if (result.locations !== undefined && arr(result.locations).length) {
          const physical = obj(obj(arr(result.locations)[0]).physicalLocation);
          let artifact = obj(physical.artifactLocation);
          if (artifact.uri === undefined && Number.isSafeInteger(artifact.index)) {
            const index = artifact.index as number;
            if (index < 0 || !Array.isArray(run.artifacts) || !run.artifacts[index]) throw new Error('Invalid artifact index');
            artifact = obj(obj(run.artifacts[index]).location);
          }
          let uri = str(artifact.uri);
          if (artifact.uriBaseId !== undefined) {
            const baseId = str(artifact.uriBaseId);
            const bases = obj(run.originalUriBaseIds);
            const base = str(obj(bases[baseId]).uri);
            // The base is evidence, not authority to access another directory.
            if (base !== `file://${root}/` && base !== `file://${root}`) throw new Error('Unsafe location');
          }
          const region = physical.region === undefined ? {} : obj(physical.region);
          loc = location(uri, region.startLine, region.startColumn, root);
        }
        const properties = result.properties === undefined ? {} : obj(result.properties);
        const aliases = properties.tags === undefined ? [] : arr(properties.tags).filter(v => typeof v === 'string' && /^(CVE-|GHSA-|OSV-)/.test(v));
        add(candidate(tool, { ruleId, message: str(message.text ?? message.markdown ?? message.id), location: loc, reportedSeverity: severity(result.level ?? (rule?.defaultConfiguration as Obj | undefined)?.level), advisoryIds: aliases as string[], suppressed: Array.isArray(result.suppressions) && result.suppressions.length > 0 }));
      } catch (error) { gap(error instanceof Error && /[Ll]ocation|URI|source root/.test(error.message) ? 'UNSAFE_LOCATION' : 'INVALID_OUTPUT', 'A SARIF result could not be safely normalized.'); }
    }
  }
}

function parseResults(plan: ScannerPlan, document: unknown, add: (value: ScannerCandidate) => void, gap: (code: ScannerGap['code'], message: string) => void): void {
  const root = plan.sourceRoot;
  if (plan.format === 'sarif') { parseSarif(document, plan.id, root, add, gap); return; }
  if (plan.format === 'gitleaks-json') {
    for (const value of arr(document)) {
      const row = obj(value);
      // Never retain Match, Secret, Line, commit message, author, or scanner fingerprint.
      add(candidate(plan.id, { ruleId: str(row.RuleID), message: str(row.Description), reportedSeverity: 'unknown', location: location(row.File, row.StartLine, row.StartColumn, root), advisoryIds: [] }));
    }
    return;
  }
  const doc = obj(document);
  switch (plan.format) {
    case 'semgrep-json':
      for (const value of arr(doc.results)) {
        const row = obj(value), extra = obj(row.extra), start = obj(row.start);
        add(candidate(plan.id, { ruleId: str(row.check_id), message: str(extra.message), reportedSeverity: severity(extra.severity), location: location(row.path, start.line, start.col, root), advisoryIds: [], suppressed: extra.is_ignored === true }));
      }
      if (arr(doc.errors).length) gap('TOOL_FAILED', 'Semgrep reported parser, rule, or execution errors; inspect affected coverage.');
      if (!arr(obj(doc.paths).scanned).length) gap('SKIPPED_INPUT', 'Semgrep did not scan any source files.');
      if (Array.isArray(obj(doc.paths).skipped) && (obj(doc.paths).skipped as unknown[]).length) gap('SKIPPED_INPUT', 'Semgrep skipped source files.');
      return;
    case 'osv-json':
      for (const value of arr(doc.results)) {
        const result = obj(value), source = obj(result.source);
        for (const entry of arr(result.packages)) {
          const pkg = obj(entry), detail = obj(pkg.package);
          for (const input of arr(pkg.vulnerabilities)) {
            const vuln = obj(input), id = str(vuln.id);
            const aliases = vuln.aliases === undefined ? [] : arr(vuln.aliases).map(str);
            add(candidate(plan.id, { ruleId: id, message: optionalString(vuln.summary) ?? id, reportedSeverity: 'unknown', location: location(source.path, undefined, undefined, root), advisoryIds: [...new Set([id, ...aliases])], dependency: { name: str(detail.name), version: optionalString(detail.version), ecosystem: optionalString(detail.ecosystem), reachability: 'unknown', exposure: 'unknown' } }));
          }
        }
      }
      return;
    case 'trivy-json':
      if (doc.SchemaVersion !== 2) throw new Error('Trivy schema version 2 required');
      if (doc.Results === undefined && (typeof doc.ArtifactName !== 'string' || doc.ArtifactType !== 'filesystem')) throw new Error('Missing Trivy assessment metadata');
      for (const value of arr(doc.Results ?? [])) {
        const result = obj(value);
        for (const key of ['Vulnerabilities', 'Misconfigurations', 'Secrets'] as const) {
          for (const input of result[key] === undefined ? [] : arr(result[key])) {
            const row = obj(input), id = str(row.VulnerabilityID ?? row.ID ?? row.RuleID);
            const cause = row.CauseMetadata === undefined ? {} : obj(row.CauseMetadata);
            // Some filesystem package scanners add " (type)" after their target.
            const target = str(result.Target).replace(/ \([a-zA-Z0-9_. -]+\)$/, '');
            add(candidate(plan.id, { ruleId: id, message: optionalString(row.Title) ?? optionalString(row.Description) ?? id, reportedSeverity: severity(row.Severity), location: location(target, cause.StartLine ?? row.StartLine, undefined, root), advisoryIds: row.VulnerabilityID ? [id] : [], ...(key === 'Vulnerabilities' ? { dependency: { name: str(row.PkgName), version: optionalString(row.InstalledVersion), ecosystem: optionalString(result.Type), reachability: 'unknown' as const, exposure: 'unknown' as const } } : {}) }));
          }
        }
      }
      return;
    case 'schemathesis-json': {
      str(doc.schemathesis_version);
      const operations = doc.operations === null ? null : obj(doc.operations);
      if (doc.complete !== true || doc.stop_reason !== 'completed') gap('SKIPPED_INPUT', 'Schemathesis did not finish its declared operation assessment.');
      if (!operations || typeof operations.tested !== 'number' || operations.tested === 0) gap('SKIPPED_INPUT', 'Schemathesis exercised no operations.');
      if (operations && (Number(operations.errored) > 0 || Number(operations.skipped) > 0 || Number(operations.tested) < Number(operations.selected))) gap('SKIPPED_INPUT', 'Schemathesis skipped or failed to exercise selected operations.');
      if (arr(doc.errors).length) gap('TOOL_FAILED', 'Schemathesis reported setup or test-generation errors.');
      for (const value of arr(doc.failures)) {
        const row = obj(value);
        for (const op of arr(row.operations)) add(candidate(plan.id, { ruleId: str(row.type), message: str(row.title), reportedSeverity: severity(row.severity), advisoryIds: [], operation: str(op) }));
      }
      return;
    }
  }
}

/** Failed or malformed tools never become an empty-clean assessment. */
export function parseScannerOutput(plan: ScannerPlan, execution: ScannerExecution): ScannerOutcome {
  const outcome: ScannerOutcome = {
    tool: plan.id, version: null, status: 'not_assessed', candidates: [], gaps: [], scope: plan.coverage.scope.slice(), exclusions: plan.coverage.exclusions.slice(),
    databaseUpdatedAt: null, exitCode: execution.exitCode, evidence: 'scanner-candidate', provenanceSources: plan.provenanceSources.slice(),
    planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'), documentationInspectedAt: plan.documentationInspectedAt,
  };
  const gap = (code: ScannerGap['code'], message: string) => { if (!outcome.gaps.some(g => g.code === code && g.message === message)) outcome.gaps.push({ code, message }); };
  if (execution.unavailable) { gap('UNAVAILABLE', `${plan.id} was unavailable; this scanner assessment did not run.`); return outcome; }
  if (plan.prerequisites.length) { for (const value of plan.prerequisites) gap('PREREQUISITE', value); return outcome; }
  if (execution.timedOut) gap('TIMEOUT', 'Scanner exceeded its execution deadline.');
  const outputBytes = Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr ?? '');
  if (execution.truncated || outputBytes > Math.min(plan.maxOutputBytes, MAX_SCANNER_OUTPUT_BYTES)) { gap('OUTPUT_LIMIT', 'Scanner output exceeded the capture limit; payload withheld.'); return outcome; }
  try {
    if (execution.version) {
      const safe = redactFindingSpans(execution.version);
      if (safe === null) throw new RedactionFailure();
      outcome.version = safe.slice(0, 200).replace(/[\x00-\x1f\x7f]/g, '');
    }
    if (redactFindingSpans(execution.stderr ?? '') === null) throw new RedactionFailure();
    if (/\b(?:error|fatal|panic|failed to|unable to|no offline version)\b/i.test(execution.stderr ?? '')) gap('TOOL_FAILED', 'Scanner diagnostic output reported a failure; the JSON result does not establish complete coverage.');
    const doc = decodedDocument(execution.stdout);
    const seen = new Set<string>();
    parseResults(plan, doc, item => {
      if (outcome.candidates.length >= MAX_CANDIDATES) throw new Error('Candidate limit exceeded');
      if (!seen.has(item.id)) { seen.add(item.id); outcome.candidates.push(item); }
    }, gap);
    outcome.status = 'complete';
  } catch (error) {
    if (error instanceof RedactionFailure) { outcome.candidates = []; gap('REDACTION_FAILED', 'Scanner payload could not be safely redacted and was withheld.'); }
    else gap('INVALID_OUTPUT', 'Scanner report is malformed, unsupported, or exceeds structural limits.');
  }
  const successCodes = plan.id === 'gitleaks' ? [0, 10] : ['osv', 'schemathesis'].includes(plan.id) ? [0, 1] : [0];
  if (execution.exitCode === null || !successCodes.includes(execution.exitCode)) gap('TOOL_FAILED', 'Scanner did not exit with a recognized assessment status.');
  if ((plan.id === 'gitleaks' && execution.exitCode === 10 || plan.id === 'osv' && execution.exitCode === 1) && !outcome.candidates.length) gap('INVALID_OUTPUT', 'Scanner finding exit status disagrees with its empty report.');
  if (['osv', 'trivy'].includes(plan.id)) {
    if (execution.databaseUpdatedAt && /^\d{4}-\d\d-\d\dT/.test(execution.databaseUpdatedAt) && Number.isFinite(Date.parse(execution.databaseUpdatedAt))) outcome.databaseUpdatedAt = execution.databaseUpdatedAt;
    else gap('UNKNOWN_FRESHNESS', 'The advisory database freshness is unknown.');
  }
  if (outcome.gaps.length) outcome.status = outcome.status === 'complete' || outcome.candidates.length ? 'partial' : 'not_assessed';
  return outcome;
}

/** Import CodeQL or other SARIF as read-only candidates; never trust its verdict. */
export function importSarif(raw: string, opts: { sourceRoot: string; version?: string; scope?: string[] }): ScannerOutcome {
  const root = absolutePath(opts.sourceRoot, 'sourceRoot');
  const plan = scannerPlans({ snapshotRoot: root, offline: true, selected: ['zizmor'] })[0];
  plan.coverage.scope = opts.scope ?? [root];
  plan.provenanceSources = ['https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html'];
  plan.coverage.exclusions = ['Imported scanner scope and suppressions require independent validation.'];
  const outcome = parseScannerOutput(plan, { stdout: raw, exitCode: 0, version: opts.version });
  outcome.tool = 'sarif';
  outcome.candidates = outcome.candidates.map(item => candidate('sarif', item));
  return outcome;
}
