/** CSO's versioned, host-independent evidence contract. Runtime claims are helper-owned. */
import { createHash } from 'node:crypto';

export const ABI = 3;
export const MAX_OUTPUT = 1024 * 1024;
export type Completeness = 'complete' | 'partial' | 'not assessed';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';
export type ErrorCode = 'INVALID_ARGUMENT' | 'INVALID_SCHEMA' | 'MISSING_INPUT' | 'SNAPSHOT_RACE' |
  'UNSAFE_PATH' | 'REDACTION_FAILED' | 'PERSISTENCE_FAILED' | 'TOOL_UNAVAILABLE' | 'TOOL_FAILED' |
  'ISOLATION_FAILED' | 'INSUFFICIENT_CAPACITY' | 'DEADLINE' | 'CANCELLED' | 'PREREQUISITE' |
  'INCOMPATIBLE_INPUT' | 'ASSERTION_FAILED';
export class CsoError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); this.name = 'CsoError'; }
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
export interface CoverageRecord {
  domain: string; scope: string; status: 'assessed' | 'partial' | 'not_assessed' | 'not_applicable';
  method: string; gaps: string[]; exclusions: string[]; evidence: string[];
  tool?: { name: string; version: string; freshness: string; outcome: string };
}
export interface ApplicationModel {
  actors: string[]; assets: string[]; entrypoints: string[]; tenantBoundaries: string[];
  sensitiveOperations: string[]; invariants: string[];
}
export interface FindingV3 {
  id: string; fingerprint: string; title: string; rootCause: string;
  location: { path: string; line: number; symbol: string }; advisoryIds: string[];
  severity: Severity; confidence: 'high' | 'medium' | 'low'; confidenceRationale:string; evidence: 'supported' | 'hypothesis' | 'legacy_review';
  attackerControl: string; impact: string; scenario: string; trace: string[]; references: string[]; recommendation: string;
  challenge: { reviewer: string; independent: boolean; mode:'independent_agent'|'sequential_fallback'; callers: string; controls: string; counterevidence: string; conclusion: string };
  dependency?: { affectedVersion: string; reachability: 'reachable' | 'unreachable' | 'unknown'; exposure: string; exploitation: string };
  reproduction: 'not_attempted' | 'blocked' | 'inconclusive' | 'disproved' | 'reproduced';
  repair: 'not_attempted' | 'proposed' | 'failed' | 'runtime_tested' | 'tested';
  closure: 'open' | 'resolved' | 'unknown'; verificationId?: string; reproductionAttemptId?:string;
  verificationAssurance?: { assertions:'authenticated_out_of_process'; testCompletion:'self_reported'|'authenticated_out_of_process'; review:'self_attested'|'host_verified' };
}
export interface RunPolicy {
  mode: 'daily' | 'comprehensive'; scope: string; diff: boolean; base: string;
  offline: boolean; budgetSeconds: number; maxWorkers: 3; maxRepairs: 3;
}
export interface RunReportV3 {
  schemaVersion: 3; runId: string; repoId: string; createdAt: string; deadline: string;
  status: 'running' | 'finished' | 'interrupted'; completeness: Completeness; policy: RunPolicy;
  source: { root: string; snapshotHash: string; originalHash: string; baseCommit?: string;
    transformations?: Array<{ path: string; handling: string }> };
  application: ApplicationModel; coverage: CoverageRecord[]; findings: FindingV3[];
  gaps: string[]; events: { at: string; kind: string; message: string }[];
  parent?: { runId: string; findingId: string; kind: 'recheck' }; modelUsage?: { source: string; tokens: number; cost?: number };
}
export interface SnapshotEntry { path: string; pathId: string; originalHash: string; executionHash?: string; bytes: number; mode: number; transformation?: string }
export interface SnapshotPathIdentity { path: string; pathId: string }
export interface SnapshotManifest {
  version: 3; createdAt: string; expiresAt: string; root: string; originalHash: string; executionHash: string;
  entries: SnapshotEntry[]; deletedPaths?: SnapshotPathIdentity[]; headCommit?: string; baseCommit?: string; changedPaths?: string[];
}
export interface HttpAssertion {
  name: string; path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string,string>; body?: string;
  expected: { status: number; includes?: string; excludes?: string };
  vulnerable?: { status: number; includes?: string; excludes?: string };
}
export interface Command { executable: string; args: string[] }
export interface VerificationRequest {
  findingId: string; runtimeProfile: string; port: number; start: Command;
  legitimate: HttpAssertion[]; security: HttpAssertion; existingTests: Command[];
  fixtures: Record<string,string>;
  boundaryFiles: string[]; testFiles:string[];
  changes: { path: string; beforeSha256: string | null; after: string | null; effect: 'source' | 'configuration' | 'dependency' }[];
  review: { reviewer: string; independent: boolean; rootCauseRepaired: boolean; featurePreserved: boolean;
    boundaryMocks: boolean; rationale: string; reviewedPatchHash: string; artifactId?:string };
}
export interface RepairReviewArtifact {schemaVersion:3;id:string;runId:string;findingId:string;createdAt:string;producer:string;reviewer:string;assurance:'self_attested'|'host_verified';requestHash:string;patchHash:string;rootCauseRepaired:boolean;featurePreserved:boolean;boundaryMocks:boolean;rationale:string}
export interface RecheckEvidenceV3 {
  kind: 'caller' | 'security_boundary';
  path: string;
  line: number;
  observation: string;
}
export interface SubmissionV3 {
  application?: ApplicationModel;
  findings?: unknown[];
  coverage?: unknown[];
  gaps?: string[];
  modelUsage?: { source: string; tokens: number; cost?: number };
  recheck?: { findingId: string; outcome: 'open' | 'resolved' | 'unknown'; evidence: RecheckEvidenceV3[]; rootCause: string };
}
export interface VerificationObservation {
  booted: boolean; legitimate: boolean; security: 'pass' | 'intended_failure' | 'inconclusive';
  existingTests: boolean; output: string; inputHash: string;
}
export interface AssertionWitnessBinding {
  schemaVersion: 1; protocol: 'gstack-cso-assertion-witness-v1'; nonce: string; phase: 'before' | 'after';
  issuedAt: string; expiresAt: string; runId: string; findingId: string;
  policyHash: string; auditPolicyHash: string;
  runtime: { image: string; verifierImage: string; platform: string; profile: string };
  runner: { testToolchain: 'runtime' | 'project'; startPlanHash: string; testPlanHash: string;
    commandsHash: string; minimumPassingTestsHash: string };
  sourceHash: string; dependencyHash: string; configurationHash: string; requestHash: string;
  patchHash: string; harnessHash: string; assertionHash: string; fixturesHash: string;
}
export interface AssertionWitnessReceipt {
  schemaVersion: 1; binding: AssertionWitnessBinding; keyId: string; publicKey: string;
  observationHash: string; externalAssertionsPassed: boolean; diagnosticTestsPassed: boolean;
  executions: Array<{ commandHash: string; exitCode: number; outputHash: string; minimumPassingTests: number;
    executedTests: number; passingTests: number; reportedPassed: boolean }>;
  signature: string;
}
export interface PreparationProof {
  schemaVersion: 1; dependencyClosureHash: string; configurationHash: string; sourceProjectionHash: string;
  preparedManifestHash: string; preparedDependencyHash: string; receiptHash: string; executionEnvironmentHash: string; databaseHash: string;
  transformations: Array<{ path: string; sha256: string; mode: number; reason: string }>;
}
export interface VerificationManifest {
  version: 3; id: string; runId: string; findingId: string; createdAt: string;
  helperAbi: 3; runtime: { image: string; platform: string; profile: string };
  testToolchain: 'runtime' | 'project';
  policyHash: string; harnessHash: string; requestHash:string; startPlanHash:string; testPlanHash:string; fixturesHash: string; patchHash: string;
  auditPolicyHash:string; originalSourceHash:string; transformationsHash:string; archivesHash:string; preparationHash?:string;
  beforeSourceHash: string; afterSourceHash: string; beforeDependencies: string; afterDependencies: string;
  beforeConfiguration: string; afterConfiguration: string;
  before: VerificationObservation; after: VerificationObservation;
  review: VerificationRequest['review']; reviewAssurance:'self_attested'|'host_verified';
  assertionAssurance?:'authenticated_out_of_process';
  testCompletionAssurance:'self_reported'|'authenticated_out_of_process';
  witnessHash?: string;
  result: 'runtime_tested' | 'tested' | 'failed' | 'inconclusive';
}
export interface RepairBundle {
  schemaVersion: 3; runId: string; id: string; createdAt: string; expiresAt: string;
  requiredInputs: { sourceHash: string; originalHash: string; runtimeImage: string; platform: string; archives: string[];
    dependencyClosures?: { before: unknown; after: unknown } };
  request: VerificationRequest; verification: VerificationManifest; transformations: SnapshotEntry[];
  preparation?: { before: PreparationProof; after: PreparationProof }; reviewArtifact?:RepairReviewArtifact;
  witness?: { before: AssertionWitnessReceipt; after: AssertionWitnessReceipt };
}

export function object(value: unknown, name = 'input'): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CsoError('INVALID_SCHEMA', `${name} must be an object`);
  return value as Record<string,any>;
}
function exact(value:Record<string,any>,allowed:readonly string[],name:string):void{
  for(const key of Object.keys(value))if(!allowed.includes(key))throw new CsoError('INVALID_SCHEMA',`Unexpected ${name} field: ${key}`);
}
function boolean(value:unknown,name:string):boolean{
  if(typeof value!=='boolean')throw new CsoError('INVALID_SCHEMA',`${name} must be a boolean`);return value;
}
export function string(value: unknown, name: string, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new CsoError('INVALID_SCHEMA', `${name} must be a nonempty string without unsafe control characters (maximum ${max})`);
  return value;
}
export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new CsoError('INVALID_SCHEMA', `${name} must be an array`);
  return value.map((v,i) => string(v, `${name}[${i}]`));
}
export function oneOf<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (!choices.includes(value as T)) throw new CsoError('INVALID_SCHEMA', `${name} must be one of ${choices.join(', ')}`);
  return value as T;
}
export function relativePath(value: unknown): string {
  const p = string(value, 'relative path', 4096);
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..') || /[\x00-\x1f\x7f]/.test(p))
    throw new CsoError('UNSAFE_PATH', 'Expected a contained relative path');
  return p;
}
const SNAPSHOT_PATH_HANDLE=/^@cso-path\/\/([a-f0-9]{32})$/;
export function snapshotPathId(root:string,path:string):string{
  // Validate the root for callers, but do not salt the opaque identity with its
  // absolute checkout path. Replay must resolve the same retained path after a
  // matching source tree is supplied from another checkout.
  string(root,'snapshot root',8192);const relative=relativePath(path);
  return sha256(canonical({kind:'cso-path-v3',path:relative})).slice(0,32);
}
export function snapshotPathHandle(pathId:string):string{
  if(!/^[a-f0-9]{32}$/.test(pathId))throw new CsoError('INVALID_SCHEMA','Snapshot path ID must be 32 lowercase hexadecimal characters');
  return `@cso-path//${pathId}`;
}
export function snapshotPathHandleId(value:unknown):string|undefined{
  if(typeof value!=='string')return;
  return SNAPSHOT_PATH_HANDLE.exec(value)?.[1];
}
export function snapshotReference(value:unknown):string{
  const reference=string(value,'snapshot path or handle',4096);
  return snapshotPathHandleId(reference)?reference:relativePath(reference);
}
export function snapshotOriginalIdentity(entries:Array<Pick<SnapshotEntry,'path'|'originalHash'|'mode'>>,deletedPaths:Array<Pick<SnapshotPathIdentity,'path'>>=[]):string{
  const present=entries.map(entry=>[entry.path,entry.originalHash,entry.mode]);
  // Preserve the original no-deletion identity for v3 artifacts already
  // retained by pre-release builds. Any deletion changes the identity and is
  // therefore impossible to strip from a manifest without detection.
  return sha256(canonical(deletedPaths.length?{entries:present,deletedPaths:deletedPaths.map(item=>item.path).sort()}:present));
}
export function rootCauseIdentity(value:string):string{return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();}
function advisoryIdentities(values:string[]):string[]{return [...new Set(values.map(value=>value.normalize('NFKC').trim().toUpperCase()))].sort();}
export function fingerprint(f: Pick<FindingV3,'rootCause'|'location'|'advisoryIds'>): string {
  // Titles, line shifts, severity, and generated descriptions are deliberately absent.
  return sha256(canonical({ rootCause: rootCauseIdentity(f.rootCause), path: f.location.path, symbol: f.location.symbol, advisories: advisoryIdentities(f.advisoryIds) })).slice(0,32);
}
export function validateFinding(input: unknown): FindingV3 {
  const v = object(input, 'finding'), loc = object(v.location,'location'), c = object(v.challenge,'challenge');
  for (const reserved of ['reproduction','repair','closure','verificationId','reproductionAttemptId','verificationAssurance']) if (reserved in v)
    throw new CsoError('INVALID_SCHEMA', `${reserved} is helper-owned`);
  exact(v,['title','rootCause','location','advisoryIds','severity','confidence','confidenceRationale','evidence','attackerControl','impact','scenario','trace','references','recommendation','challenge','dependency'],'finding');
  exact(loc,['path','line','symbol'],'location');
  exact(c,['reviewer','independent','mode','callers','controls','counterevidence','conclusion'],'challenge');
  const f: FindingV3 = {
    id: '', fingerprint: '', title: string(v.title,'title'), rootCause: string(v.rootCause,'rootCause'),
    location: { path: snapshotReference(loc.path), line: loc.line, symbol: string(loc.symbol,'symbol') },
    advisoryIds: advisoryIdentities(strings(v.advisoryIds ?? [],'advisoryIds')),
    severity: oneOf(v.severity,['critical','high','medium','low','informational'],'severity'),
    confidence: oneOf(v.confidence,['high','medium','low'],'confidence'),
    confidenceRationale: string(v.confidenceRationale,'confidenceRationale'),
    evidence: oneOf(v.evidence,['supported','hypothesis'],'evidence'),
    attackerControl: string(v.attackerControl,'attackerControl'), impact: string(v.impact,'impact'), scenario: string(v.scenario,'scenario'), trace: strings(v.trace,'trace'),
    references: strings(v.references,'references'), recommendation: string(v.recommendation,'recommendation'),
    challenge: { reviewer: string(c.reviewer,'reviewer'), independent: boolean(c.independent,'challenge.independent'), mode:oneOf(c.mode,['independent_agent','sequential_fallback'],'challenge.mode'), callers: string(c.callers,'callers'),
      controls: string(c.controls,'controls'), counterevidence: string(c.counterevidence,'counterevidence'), conclusion: string(c.conclusion,'conclusion') },
    reproduction: 'not_attempted', repair: 'not_attempted', closure: 'open',
  };
  if (!Number.isInteger(f.location.line) || f.location.line < 1) throw new CsoError('INVALID_SCHEMA','line must be a positive integer');
  const fallbackLabel='sequential challenge; independent agent unavailable';
  if((f.challenge.independent&&(f.challenge.mode!=='independent_agent'||f.challenge.reviewer===fallbackLabel))||(!f.challenge.independent&&(f.challenge.mode!=='sequential_fallback'||f.challenge.reviewer!==fallbackLabel)))throw new CsoError('INVALID_SCHEMA',`Challenge mode must bind either an independent agent or the exact fallback label: ${fallbackLabel}`);
  if (f.evidence === 'supported' && (f.confidence === 'low' || !f.trace.length || !f.references.length)) throw new CsoError('INVALID_SCHEMA','Supported findings require a challenge, a trace, supporting references, and medium/high confidence');
  if (v.dependency) {
    const d = object(v.dependency);
    exact(d,['affectedVersion','reachability','exposure','exploitation'],'dependency');
    f.dependency = { affectedVersion: string(d.affectedVersion,'affectedVersion'), reachability: oneOf(d.reachability,['reachable','unreachable','unknown'],'reachability'), exposure: string(d.exposure,'exposure'), exploitation: string(d.exploitation,'exploitation') };
  }
  f.fingerprint = fingerprint(f); f.id = f.fingerprint; return f;
}
export function validateCoverage(input: unknown): CoverageRecord {
  const v = object(input,'coverage');
  exact(v,['domain','scope','status','method','gaps','exclusions','evidence','tool'],'coverage');
  const c: CoverageRecord = { domain: string(v.domain,'domain'), scope: string(v.scope,'scope'),
    status: oneOf(v.status,['assessed','partial','not_assessed','not_applicable'],'coverage status'),
    method: string(v.method,'method'), gaps: strings(v.gaps,'gaps'), exclusions: strings(v.exclusions,'exclusions'), evidence: strings(v.evidence,'evidence') };
  if (c.status === 'assessed' && (c.gaps.length || !c.evidence.length)) throw new CsoError('INVALID_SCHEMA','Assessed coverage needs evidence and no outstanding gaps');
  if (c.status === 'partial' && (!c.gaps.length || !c.evidence.length)) throw new CsoError('INVALID_SCHEMA','Partial coverage needs assessed evidence and a concrete gap');
  if (c.status === 'not_assessed' && !c.gaps.length) throw new CsoError('INVALID_SCHEMA','Unassessed coverage needs a concrete gap');
  if (c.status === 'not_applicable' && (!c.evidence.length || c.gaps.length)) throw new CsoError('INVALID_SCHEMA','Non-applicability requires evidence and cannot retain an assessment gap');
  if (v.tool) { const t = object(v.tool);exact(t,['name','version','freshness','outcome'],'coverage tool'); c.tool = {name:string(t.name,'tool name'), version:string(t.version,'tool version'), freshness:string(t.freshness,'freshness'), outcome:string(t.outcome,'outcome')}; }
  return c;
}
export function validateCommand(value: unknown, name: string): Command {
  const v=object(value,name), executable=string(v.executable,`${name}.executable`,4096), args=strings(v.args??[],`${name}.args`);
  exact(v,['executable','args'],name);
  if(!executable.startsWith('/')||executable.includes('..'))throw new CsoError('INVALID_SCHEMA',`${name}.executable must be an absolute in-container path`);
  return {executable,args};
}
export function validateVerificationObservation(value:unknown):VerificationObservation{
  const v=object(value,'verification observation');
  for(const key of Object.keys(v))if(!['booted','legitimate','security','existingTests','output','inputHash'].includes(key))throw new CsoError('INVALID_SCHEMA',`Unexpected verification observation field: ${key}`);
  if(typeof v.booted!=='boolean'||typeof v.legitimate!=='boolean'||typeof v.existingTests!=='boolean')throw new CsoError('INVALID_SCHEMA','Verification observation outcomes must be booleans');
  if(typeof v.output!=='string'||v.output.length>8192||v.output.includes('\0'))throw new CsoError('INVALID_SCHEMA','Verification observation output must be a bounded string');
  if(typeof v.inputHash!=='string'||(!/^$/.test(v.inputHash)&&!/^[a-f0-9]{64}$/.test(v.inputHash)))throw new CsoError('INVALID_SCHEMA','Verification observation inputHash must be empty or a sha256 hash');
  return{booted:v.booted,legitimate:v.legitimate,security:oneOf(v.security,['pass','intended_failure','inconclusive'],'verification security outcome'),existingTests:v.existingTests,output:v.output,inputHash:v.inputHash};
}
function assertion(value: unknown,name:string):HttpAssertion {
  const v=object(value,name), expected=object(v.expected,`${name}.expected`);
  exact(v,['name','path','method','headers','body','expected','vulnerable'],name);
  const oracle=(x:Record<string,any>,n:string)=>{exact(x,['status','includes','excludes'],n);if(!Number.isInteger(x.status)||x.status<100||x.status>599)throw new CsoError('INVALID_SCHEMA',`${n}.status must be an HTTP status`);return {status:x.status,...(x.includes===undefined?{}:{includes:string(x.includes,`${n}.includes`)}),...(x.excludes===undefined?{}:{excludes:string(x.excludes,`${n}.excludes`)})};};
  const path=string(v.path,`${name}.path`,4096);if(!path.startsWith('/')||path.startsWith('//')||/[\r\n]/.test(path))throw new CsoError('INVALID_SCHEMA',`${name}.path must stay on numeric loopback`);
  const headers:Record<string,string>={};if(v.headers!==undefined)for(const [k,val] of Object.entries(object(v.headers,`${name}.headers`))){if(!/^[A-Za-z0-9-]{1,100}$/.test(k)||typeof val!=='string'||val.length>8192||/[\r\n]/.test(val))throw new CsoError('INVALID_SCHEMA',`Invalid ${name} header`);headers[k]=val;}
  return {name:string(v.name,`${name}.name`),path,method:oneOf(v.method,['GET','POST','PUT','PATCH','DELETE'],`${name}.method`),...(Object.keys(headers).length?{headers}:{}),...(v.body===undefined?{}:{body:string(v.body,`${name}.body`,65536)}),expected:oracle(expected,`${name}.expected`),...(v.vulnerable===undefined?{}:{vulnerable:oracle(object(v.vulnerable),`${name}.vulnerable`)})};
}
export function validateVerificationRequest(input:unknown):VerificationRequest {
  const v=object(input,'verification request'),changes=v.changes,fixtures=object(v.fixtures??{},'fixtures'),review=object(v.review,'review');
  exact(v,['findingId','runtimeProfile','port','start','legitimate','security','existingTests','fixtures','boundaryFiles','testFiles','changes','review'],'verification request');
  exact(review,['reviewer','independent','rootCauseRepaired','featurePreserved','boundaryMocks','rationale','reviewedPatchHash','artifactId'],'review');
  if(!Array.isArray(changes)||!changes.length||changes.length>100)throw new CsoError('INVALID_SCHEMA','changes must contain 1..100 declared patch effects');
  const cleanFixtures:Record<string,string>={};for(const [p,body] of Object.entries(fixtures)){cleanFixtures[relativePath(p)]=string(body,`fixture ${p}`,1024*1024);}
  const request:VerificationRequest={findingId:string(v.findingId,'findingId'),runtimeProfile:string(v.runtimeProfile,'runtimeProfile',100),port:v.port,
    start:validateCommand(v.start,'start'),legitimate:(Array.isArray(v.legitimate)?v.legitimate:[]).map((x,i)=>assertion(x,`legitimate[${i}]`)),security:assertion(v.security,'security'),existingTests:(Array.isArray(v.existingTests)?v.existingTests:[]).map((x,i)=>validateCommand(x,`existingTests[${i}]`)),fixtures:cleanFixtures,boundaryFiles:strings(v.boundaryFiles,'boundaryFiles').map(snapshotReference),testFiles:strings(v.testFiles,'testFiles').map(snapshotReference),
    changes:changes.map((raw:any,i:number)=>{const x=object(raw,`changes[${i}]`),before=x.beforeSha256;exact(x,['path','beforeSha256','after','effect'],`changes[${i}]`);if(before!==null&&(typeof before!=='string'||!/^[a-f0-9]{64}$/.test(before)))throw new CsoError('INVALID_SCHEMA',`changes[${i}].beforeSha256 must be a hash or null`);return{path:snapshotReference(x.path),beforeSha256:before,after:x.after===null?null:string(x.after,`changes[${i}].after`,1024*1024),effect:oneOf(x.effect,['source','configuration','dependency'],`changes[${i}].effect`)};}),
    review:{reviewer:string(review.reviewer,'reviewer'),independent:boolean(review.independent,'review.independent'),rootCauseRepaired:boolean(review.rootCauseRepaired,'review.rootCauseRepaired'),featurePreserved:boolean(review.featurePreserved,'review.featurePreserved'),boundaryMocks:boolean(review.boundaryMocks,'review.boundaryMocks'),rationale:string(review.rationale,'review rationale'),reviewedPatchHash:string(review.reviewedPatchHash,'reviewedPatchHash'),...(review.artifactId===undefined?{}:{artifactId:string(review.artifactId,'review artifact ID')})},};
  if(!/^[a-f0-9]{32}$/.test(request.findingId))throw new CsoError('INVALID_SCHEMA','findingId must be a helper-issued identifier');
  if(request.review.artifactId!==undefined&&!/^[a-f0-9]{32}$/.test(request.review.artifactId))throw new CsoError('INVALID_SCHEMA','review artifact ID must be a helper-issued identifier');
  if(!Number.isInteger(request.port)||request.port<1024||request.port>65535)throw new CsoError('INVALID_SCHEMA','port must be 1024..65535');
  if(!request.legitimate.length||!request.security.vulnerable||!request.existingTests.length||!request.boundaryFiles.length||!request.testFiles.length)throw new CsoError('INVALID_SCHEMA','Verification needs a legitimate control, distinct before/fixed security oracles, existing tests, immutable test files, and boundary files');
  const secure=request.security.expected,vulnerable=request.security.vulnerable;
  const mutuallyExclusive=secure.status!==vulnerable.status
    ||(secure.includes!==undefined&&vulnerable.excludes!==undefined&&secure.includes.includes(vulnerable.excludes))
    ||(vulnerable.includes!==undefined&&secure.excludes!==undefined&&vulnerable.includes.includes(secure.excludes));
  if(!mutuallyExclusive)throw new CsoError('INVALID_SCHEMA','The vulnerable and fixed security oracles must be provably mutually exclusive');
  if(new Set(request.changes.map(x=>x.path)).size!==request.changes.length)throw new CsoError('INVALID_SCHEMA','Patch paths must be unique');
  if(new Set(request.testFiles).size!==request.testFiles.length||request.changes.some(change=>request.testFiles.includes(change.path)))throw new CsoError('INVALID_SCHEMA','Existing-test source files must be unique and unchanged by the repair');
  if(request.existingTests.some(command=>/(?:^|\/)(?:true|false|echo|printf|env|sh|bash)$/.test(command.executable)))throw new CsoError('INVALID_SCHEMA','Generic success or shell commands cannot stand in for a project test suite');
  if(!request.changes.some(change=>change.beforeSha256===null||change.after===null||sha256(change.after)!==change.beforeSha256))throw new CsoError('INVALID_SCHEMA','A tested repair must contain at least one material patch effect');
  return request;
}
export function completeness(report: Pick<RunReportV3,'coverage'|'gaps'>): Completeness {
  // Scanner adapters preserve operational outcomes, but scanner output is only
  // candidate evidence. The corresponding investigation domain decides whether
  // assessment work remains; an optional tool failure cannot override it.
  // A successful snapshot is a prerequisite, not security assessment work by
  // itself. Its helper-owned partial/not-assessed state remains material.
  const work = report.coverage.filter(c => c.status !== 'not_applicable'&&!c.domain.startsWith('scanner:')&&!(['snapshot-inputs','history-inputs'].includes(c.domain)&&c.status==='assessed'));
  if (!report.gaps.length && work.length && work.every(c => c.status === 'assessed')) return 'complete';
  return work.some(c => c.status === 'assessed' || c.status === 'partial') ? 'partial' : 'not assessed';
}
export function renderReport(report: RunReportV3): string {
  const supported = report.findings.filter(f => f.evidence === 'supported');
  const gaps = [...new Set([...report.gaps,...report.coverage.filter(c=>!c.domain.startsWith('scanner:')).flatMap(c => c.gaps)])];
  const transformations=report.source.transformations??[];
  // Report JSON is canonical evidence. Markdown is a safe plain-text view:
  // collapse line breaks and escape all Markdown control characters so model,
  // repository, scanner, and advisory strings cannot forge report structure.
  const plain=(value:unknown):string=>String(value).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu,' ').replace(/\s{2,}/g,' ').trim().replace(/[\\`*_[\]{}()#+!|<>]/g,'\\$&');
  const list=(values:string[]):string=>values.length?values.map(plain).join('; '):'none';
  const terminal=[...report.events].reverse().find(item=>item.kind==='terminal'),startedAt=Date.parse(report.createdAt),terminalAt=terminal?Date.parse(terminal.at):NaN;
  const elapsed=Number.isFinite(startedAt)&&Number.isFinite(terminalAt)&&terminalAt>=startedAt?`; elapsed ${terminalAt-startedAt} ms`:'';
  const timing=`Timing: started ${plain(report.createdAt)}; deadline ${plain(report.deadline)}${terminal?`; terminal ${plain(terminal.at)}${elapsed}`:''}.`;
  const usage=report.modelUsage?`Model usage: ${report.modelUsage.tokens} host-reported tokens from ${plain(report.modelUsage.source)}${report.modelUsage.cost===undefined?'':`; host-reported cost ${report.modelUsage.cost}`}.`:undefined;
  const findingLines=(f:FindingV3):string[]=>[
    `- ${plain(f.severity.toUpperCase())} ${plain(f.title)} [${plain(f.id)}]`,
    `  Location: ${plain(f.location.path)}:${f.location.line} (${plain(f.location.symbol)}). Confidence: ${plain(f.confidence)} — ${plain(f.confidenceRationale)}. Evidence: ${plain(f.evidence)}.`,
    `  Attacker scenario: ${plain(f.scenario)}`,
    `  Attacker control: ${plain(f.attackerControl)}. Impact: ${plain(f.impact)}.`,
    `  Trace: ${list(f.trace)}. Supporting references: ${list(f.references)}.`,
    `  Counterevidence considered: ${plain(f.challenge.counterevidence)}. Challenge: ${plain(f.challenge.mode)} by ${plain(f.challenge.reviewer)}. Conclusion: ${plain(f.challenge.conclusion)}.`,
    `  Repair recommendation: ${plain(f.recommendation)}`,
    `  Reproduction: ${plain(f.reproduction)}${f.reproductionAttemptId?` (attempt ${plain(f.reproductionAttemptId)})`:''}. Repair: ${plain(f.repair)}. Closure: ${plain(f.closure)}.`,
    ...(f.verificationId?[`  Verification: ${plain(f.verificationId)}. Bundle: bundles/${plain(f.verificationId)}.json. Assertion assurance: ${plain(f.verificationAssurance?.assertions??'unknown')}. Test completion assurance: ${plain(f.verificationAssurance?.testCompletion??'unknown')}. Review assurance: ${plain(f.verificationAssurance?.review??'unknown')}.`]:[]),
  ];
  const model=report.application;
  return [ `${report.completeness} — ${plain(report.policy.scope)}${report.policy.diff ? ` (diff against ${plain(report.policy.base)})` : ''}`,
    `Run: ${plain(report.runId)}. Mode: ${plain(report.policy.mode)}.`,
    timing, ...(usage?[usage]:[]),
    `Material gaps: ${gaps.length ? list(gaps) : 'none reported'}.`, '',
    'Application model:',
    `- Actors: ${list(model.actors)}.`, `- Assets: ${list(model.assets)}.`, `- Entrypoints: ${list(model.entrypoints)}.`,
    `- Tenant boundaries: ${list(model.tenantBoundaries)}.`, `- Sensitive operations: ${list(model.sensitiveOperations)}.`, `- Security invariants: ${list(model.invariants)}.`, '',
    ...(supported.length ? ['Supported findings:',...supported.flatMap(findingLines)] : ['No supported findings in the assessed scope.']),
    ...(report.policy.mode === 'comprehensive' ? ['', 'Hypotheses (unconfirmed):', ...report.findings.filter(f => f.evidence === 'hypothesis').flatMap(findingLines)] : []),
    '', 'Snapshot transformations:', ...(transformations.length?transformations.map(item=>`- ${plain(item.path)}: ${plain(item.handling)}`):['- none']),
    '', 'Coverage:', ...report.coverage.flatMap(c=>[
      `- ${plain(c.domain)}: ${plain(c.status)}; ${plain(c.method)}${c.tool?`; tool ${plain(c.tool.name)} ${plain(c.tool.version)}, freshness ${plain(c.tool.freshness)}, outcome ${plain(c.tool.outcome)}`:''}.`,
      `  Scope: ${plain(c.scope)}. Evidence: ${list(c.evidence)}. Gaps: ${list(c.gaps)}. Exclusions: ${list(c.exclusions)}.`,
    ]), '',
  ].join('\n');
}
export function importLegacy(input: unknown): { schemaVersion: 2; readOnly: true; findings: any[]; warning: string } {
  const v = object(input,'legacy report');
  if (!Array.isArray(v.findings) || ![2,'2','2.0','2.0.0'].includes(v.schemaVersion ?? v.schema_version ?? v.version)) throw new CsoError('INVALID_SCHEMA','Expected a v2 report with findings');
  return { schemaVersion: 2, readOnly: true, warning: 'Legacy VERIFIED is review evidence only; it does not establish reproduction, tested repair, or closure.',
    findings: v.findings.map((raw: any,index:number) => {const f=object(raw,`legacy finding ${index+1}`);return{
      title:typeof f.title==='string'?string(f.title,'legacy title'): `Legacy finding ${index+1}`,
      status:typeof f.status==='string'?string(f.status,'legacy status'): 'unknown',
      ...(typeof f.severity==='string'?{severity:string(f.severity,'legacy severity')}:{ }),
      ...(typeof f.description==='string'?{description:string(f.description,'legacy description')}:{ }),
      evidence:'legacy_review', reproduction:'not_attempted', repair:'not_attempted', closure:'unknown'};}) };
}
