#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  ABI, ApplicationModel, CoverageRecord, CsoError, FindingV3, PreparationProof, RunPolicy, RunReportV3, SnapshotEntry, SnapshotManifest, SubmissionV3,
  canonical, completeness, importLegacy, object, relativePath, renderReport, rootCauseIdentity, sha256, snapshotPathHandle, snapshotPathHandleId, snapshotPathId, snapshotReference, string, strings, validateCoverage, validateFinding, validateVerificationRequest,
} from './contracts';
import { capture, containedFile, assertSnapshot } from './snapshot';
import { assertStateOutside, event, finalizeReplayTemporary, loadReport, newRun, privateRoot, readJson, repoId, requireTime, retention, runDirectory, saveReport, secureDirectory, withLock, writeHelperJson, writeJson, writeJsonExclusive } from './state';
import { dockerEndpoint, dockerProbe, ISOLATION_POLICY_HASH } from './docker';
import { executable, git, redact, sanitizeForJson, sanitizeHelperForJson } from './process';
import { inspectPreparation } from './preparation';
import { assertRuntimeCompatible, RUNTIME_CATALOG, selectRuntime, validateRuntimeCatalog, type RuntimeCatalog } from './runtime-catalog';
import { PublicArchiveCache, publicArchiveCacheRoot } from './cache';
import { admitPreparationRuntime, admitPreparationSidecar, PreparationExecutor, type DependencyClosure, type RailsDatabaseSelection } from './preparation-executor';
import { DockerPreparationSandboxRunner } from './preparation-docker';
import { importSarif, SCANNER_IDS, ScannerId } from './scanners';
import { SCANNER_CATALOG, selectScanner, validateScannerCatalog, type ScannerCatalog } from './scanner-catalog';
import { executeScanner, scannerCoverage, validateScannerRequest } from './scanner-executor';
import { canonicalStartPlan, canonicalTestPlan, DockerVerificationExecutor, makeReviewArtifact, patchHash, validateRepairBundle, validateReviewArtifact, VerificationAttemptError, verificationHarnessHash, verifyRepair, type VerificationExecutor } from './verification';
import { readBoundedStable } from './bounded-file';
import { assertionWitnessReplayHash, runAssertionWitnessChild } from './witness';
import { historyForPath } from './history';
import { catalogImageProvisioningPolicy, inspectCatalogImages, openLocalCatalogImageSession, provisionCatalogImages, qualifiedCatalogImages, type CatalogImageSessionFactory } from './image-provisioning';

const VERSION = '3.0.0';
const RETENTION_MAINTENANCE_MS=1_000,RETENTION_MAX_ENTRIES=100_000,REPLAY_LOOKUP_MAX_ENTRIES=10_000;
const productionCatalogImageSession:CatalogImageSessionFactory=deadline=>openLocalCatalogImageSession(process.env,deadline);
/** Internal qualification seam. The public entrypoint below always supplies committed dependencies. */
export interface CsoCliDependencies {
  readonly runtimeCatalog: RuntimeCatalog;
  readonly scannerCatalog?: ScannerCatalog;
  readonly catalogImageSession?: CatalogImageSessionFactory;
  readonly watchdogPath: () => string;
}
const GENERATION_LOCK_FD=(()=>{
  // Source-mode developer/test runs use Bun directly. For installed builds,
  // this catches accidental direct use of the internal payload. It is not an
  // authentication mechanism against the trusted same-user host: that user
  // can reproduce an inherited descriptor or environment value. The public
  // native launcher is the security boundary because it scrubs runtime and
  // loader variables before Bun starts.
  if(/^bun(?:\.exe)?$/i.test(basename(process.execPath)))return undefined;
  if(process.platform==='win32'){
    if(process.env.GSTACK_CSO_GENERATION_GUARD!=='inherited-windows-generation-handle-v3')throw new CsoError('ISOLATION_FAILED','Direct use of the internal CSO payload is unsupported; invoke gstack-cso-launcher');
    delete process.env.GSTACK_CSO_GENERATION_GUARD;return undefined;
  }
  const raw=process.env.GSTACK_CSO_GENERATION_LOCK_FD;if(raw===undefined||!/^(?:[3-9]|[1-9][0-9]+)$/.test(raw))throw new CsoError('ISOLATION_FAILED','Direct use of the internal CSO payload is unsupported; invoke gstack-cso-launcher');const fd=Number(raw);let stat:fs.Stats;try{stat=fs.fstatSync(fd);}catch{throw new CsoError('ISOLATION_FAILED','The launcher publication lease was not preserved by the runtime');}const install=fs.statSync(dirname(process.execPath));if(!stat.isDirectory()||stat.dev!==install.dev||stat.ino!==install.ino)throw new CsoError('ISOLATION_FAILED','The launcher publication lease does not name the helper installation directory');delete process.env.GSTACK_CSO_GENERATION_LOCK_FD;return fd;
})();
void GENERATION_LOCK_FD;
const HELP = `gstack-cso ${VERSION} (helper ABI ${ABI})
Usage:
  gstack-cso start --repo PATH [--comprehensive] [--diff] [--base REF] [--budget SECONDS] [--offline] [--infra|--code|--skills|--supply-chain|--owasp|--scope DOMAIN]
  gstack-cso doctor --repo PATH
  gstack-cso provision-images [--setup-summary] [--per-image-seconds 5..300]
  gstack-cso resume RUN
  gstack-cso inspect RUN
  gstack-cso read RUN PATH_OR_HANDLE
  gstack-cso history RUN [PATH_OR_HANDLE]
  gstack-cso submit RUN SUBMISSION.json
  gstack-cso scan RUN gitleaks|osv|semgrep|zizmor|trivy|schemathesis [REQUEST.json]
  gstack-cso scanner-outcome RUN ARTIFACT_ID
  gstack-cso import-sarif RUN REPORT.sarif
  gstack-cso record-review RUN REQUEST.json --producer ID
  gstack-cso test-plan RUN node|bun|python|rails
  gstack-cso runtime-plan RUN node|bun|python|rails --port PORT
  gstack-cso verify RUN REQUEST.json
  gstack-cso patch-hash REQUEST.json
  gstack-cso finish RUN
  gstack-cso replay BUNDLE_ID [--source MATCHING_SOURCE]
  gstack-cso recheck FINDING --repo PATH [--run RUN]
  gstack-cso import-v2 REPORT.json
  gstack-cso schema

Static runs never execute application code. Target and scanner execution is Docker-only and requires a qualified immutable catalog.`;

const SCHEMA = {
  version:3,
  scanner:{profile:'optional exact qualified scanner profile ID',api:{runtimeProfile:'qualified app runtime ID; comprehensive mode only',port:'1024..65535',start:{executable:'absolute in-container path',args:['helper-derived literal argv with optional inspect handles']},control:{name:'legitimate control',path:'/path',method:'GET|POST|PUT|PATCH|DELETE',expected:{status:'100..599',includes:'optional',excludes:'optional'}},boundaryFiles:['untransformed snapshot-relative path or inspect handle'],schema:'reviewed OpenAPI 3.0/3.1 JSON; internal references; no server overrides, hooks, callbacks or external examples',operationIds:['1..20 unique declared path operation IDs'],seed:'optional 1..2147483647',maxExamples:'optional 1..100'}},
  submission:{application:{actors:['string'],assets:['string'],entrypoints:['string'],tenantBoundaries:['string'],sensitiveOperations:['string'],invariants:['string']},findings:[{title:'string',rootCause:'stable root cause',location:{path:'exact path or opaque handle returned by inspect',line:'positive integer',symbol:'string'},advisoryIds:['normalized advisory identity or empty'],severity:'critical|high|medium|low|informational',confidence:'high|medium|low',confidenceRationale:'why available evidence supports that confidence',evidence:'supported|hypothesis',attackerControl:'specific input/control',impact:'specific consequence',scenario:'concrete attacker scenario',trace:['entrypoint','caller','sink'],references:['supporting source/advisory reference'],recommendation:'concrete root-cause repair',challenge:{reviewer:'identity or exact sequential fallback label',independent:'boolean',mode:'independent_agent|sequential_fallback',callers:'checked callers',controls:'checked controls',counterevidence:'checked counterevidence',conclusion:'reasoned outcome'},dependency:{affectedVersion:'optional exact range/version',reachability:'reachable|unreachable|unknown',exposure:'production/build/development context',exploitation:'published exploitation evidence or unknown'}}],coverage:[{domain:'string',scope:'string',status:'assessed|partial|not_assessed|not_applicable',method:'string',gaps:['required for partial/not_assessed'],exclusions:['string'],evidence:['required for assessed/partial/not_applicable'],tool:{name:'optional',version:'exact',freshness:'timestamp/status',outcome:'string'}}],gaps:['string'],modelUsage:{source:'host-reported source',tokens:'nonnegative integer',cost:'optional finite nonnegative number'},recheck:{findingId:'original stable ID',outcome:'open|resolved|unknown',evidence:[{kind:'caller|security_boundary',path:'fresh snapshot path or inspect handle',line:'positive integer',observation:'fresh source observation'}],rootCause:'same root cause'}},
  verification:{findingId:'stable ID',runtimeProfile:'qualified runtime ID',port:'1024..65535',start:{executable:'absolute in-container path',args:['literal argv']},legitimate:[{name:'control name',path:'/numeric-loopback-relative path',method:'GET|POST|PUT|PATCH|DELETE',headers:{'optional-name':'value'},body:'optional body',expected:{status:'100..599',includes:'optional',excludes:'optional'}}],security:{name:'security assertion',path:'/path',method:'GET|POST|PUT|PATCH|DELETE',expected:{status:'fixed status',includes:'optional',excludes:'optional'},vulnerable:{status:'provably mutually-exclusive vulnerable status',includes:'optional',excludes:'optional'}},existingTests:[{executable:'must exactly match the helper-derived canonical stack suite',args:['helper-derived argv']}],testFiles:['exact immutable canonical path or inspect handle'],fixtures:{'relative/path':'content mounted read-only at /fixtures'},boundaryFiles:['snapshot path or inspect handle for the security boundary'],changes:[{path:'snapshot path or inspect handle',beforeSha256:'hash or null',after:'replacement or null',effect:'source|configuration|dependency'}],review:{artifactId:'helper-issued after record-review',reviewer:'self-attested identity distinct from producer',independent:'self-attested boolean',rootCauseRepaired:'self-attested boolean',featurePreserved:'self-attested boolean',boundaryMocks:'self-attested boolean',rationale:'specific review',reviewedPatchHash:'canonical patch hash'}},
  helperOwned:['run/report completeness','stable IDs','reproduction outcome','repair result and label','current-source closure','verification/bundle hashes'],
};

function emit(value: unknown): void { process.stdout.write((typeof value === 'string' ? redact(value) : JSON.stringify(sanitizeHelperForJson(value),null,2)) + '\n'); }
function persistableArtifact<T>(value:T,label:string):T{
  const sanitized=sanitizeHelperForJson(value) as T;
  if(canonical(sanitized)!==canonical(value))throw new CsoError('REDACTION_FAILED',`${label} contains material that cannot be persisted without changing its authenticated identity`);
  return sanitized;
}
function rejectUnexpected(value:Record<string,unknown>,allowed:readonly string[],name:string):void{
  for(const key of Object.keys(value))if(!allowed.includes(key))throw new CsoError('INVALID_SCHEMA',`Unexpected ${name} field: ${key}`);
}
function need(args:string[],flag:string):string { const i=args.indexOf(flag); if(i<0||i===args.length-1||args[i+1].startsWith('--')) throw new CsoError('INVALID_ARGUMENT',`${flag} requires a value`); const v=args[i+1]; args.splice(i,2); return v; }
function take(args:string[],flag:string):boolean { const i=args.indexOf(flag); if(i<0)return false;args.splice(i,1);return true; }
function callerPath(value:string):string {
  if(isAbsolute(value))return resolve(value);
  const cwd=process.env.GSTACK_CSO_CALLER_CWD;
  if(!cwd||!isAbsolute(cwd))throw new CsoError('INVALID_ARGUMENT','Relative paths require the trusted gstack-cso launcher');
  return resolve(cwd,value);
}
function readInput(path:string,max=1024*1024):unknown {
  let data:Buffer;try{data=readBoundedStable(callerPath(path),max,'Input file');}catch(error){if(error instanceof CsoError)throw error;throw new CsoError('MISSING_INPUT',`Input file does not exist: ${path}`);}
  try{return JSON.parse(data.toString('utf8'));}catch{throw new CsoError('INVALID_SCHEMA','Input is not valid JSON');}
}
function model(v:unknown):ApplicationModel {
  const x=object(v,'application model');rejectUnexpected(x,['actors','assets','entrypoints','tenantBoundaries','sensitiveOperations','invariants'],'application model'); const out:ApplicationModel={actors:strings(x.actors,'actors'),assets:strings(x.assets,'assets'),entrypoints:strings(x.entrypoints,'entrypoints'),tenantBoundaries:strings(x.tenantBoundaries,'tenantBoundaries'),sensitiveOperations:strings(x.sensitiveOperations,'sensitiveOperations'),invariants:strings(x.invariants,'invariants')};
  if(Object.values(out).some(a=>!a.length))throw new CsoError('INVALID_SCHEMA','Every application-model dimension needs at least one evidence-backed entry');return out;
}
function planned(scope:string):CoverageRecord[]{
  const domains = scope==='infra'?['secrets','dependencies','ci-cd','infrastructure','integrations']
    : scope==='code'?['llm-agentic-mcp','owasp-2025','stride','data-classification']
    : scope==='skills'?['skill-supply-chain'] : scope==='supply-chain'?['dependencies'] : scope==='owasp'?['owasp-2025']
    : scope.startsWith('domain:')?[scope.slice(7)]
    :['secrets','dependencies','ci-cd','infrastructure','integrations','llm-agentic-mcp','skill-supply-chain','owasp-2025','stride','data-classification'];
  return ['application-model','attack-surface',...domains].map(domain=>({domain,scope,status:'not_assessed',method:'pending investigation',gaps:['Assessment has not been submitted'],exclusions:[],evidence:[]}));
}
function snapshotCoverage(manifest:Awaited<ReturnType<typeof capture>>,scope:string):CoverageRecord{
  const omitted=manifest.entries.filter(entry=>!entry.executionHash),excluded=omitted.filter(entry=>entry.transformation?.startsWith('excluded:'));
  // Classify every unexplained omission as a material coverage gap. Coverage
  // must not depend on transformation prose retaining a particular prefix.
  const unread=omitted.filter(entry=>!excluded.includes(entry));
  const deleted=manifest.deletedPaths??[],captured=manifest.entries.filter(entry=>entry.executionHash).length,missing=unread.length+deleted.length;
  return {domain:'snapshot-inputs',scope,status:missing?(captured?'partial':'not_assessed'):'assessed',method:'fail-closed captured source inventory',
    gaps:[...unread.map(entry=>`${publicSnapshotPath(manifest,entry.path).path}: in-scope source payload was unread and withheld from static and runtime assessment`),...deleted.map(item=>`${publicSnapshotPath(manifest,item.path).path}: tracked source is deleted from the worktree; only retained history is available for assessment`)],
    exclusions:excluded.map(entry=>`${publicSnapshotPath(manifest,entry.path).path}: ${entry.transformation}`),
    evidence:[`${captured} sanitized execution input${captured===1?'':'s'} captured; ${excluded.length} explicit non-executable exclusion${excluded.length===1?'':'s'}; ${unread.length} unread in-scope input${unread.length===1?'':'s'}; ${deleted.length} tracked deletion${deleted.length===1?'':'s'}`]};
}
function historyCoverage(status:any,scope:string):CoverageRecord{return status?.status==='captured'
  ?{domain:'history-inputs',scope,status:'assessed',method:'bounded helper-retained Git history',gaps:[],exclusions:[],evidence:[`Captured ${String(status.commits??'bounded commits')} from ${String(status.range??'the pinned source range')}`]}
  :{domain:'history-inputs',scope,status:'not_assessed',method:'bounded helper-retained Git history',gaps:[typeof status?.gap==='string'&&status.gap.trim()?status.gap:'Historical evidence was not safely retained'],exclusions:[],evidence:[]};}
function helperOwnedCoverage(domain:string):boolean{return domain==='snapshot-inputs'||domain==='history-inputs'||domain==='runtime-readiness'||domain.startsWith('scanner:')||domain.startsWith('preparation:')||domain.startsWith('execution:');}
function parseStart(args:string[]):{repo:string;policy:RunPolicy;comparisonBase?:string}{
  const repo=callerPath(need(args,'--repo')),comprehensive=take(args,'--comprehensive'),diff=take(args,'--diff'),offline=take(args,'--offline');
  const scopeFlags=['--infra','--code','--skills','--supply-chain','--owasp'].filter(f=>args.includes(f));
  const named=args.includes('--scope')?need(args,'--scope'):undefined;
  if(scopeFlags.length+(named?1:0)>1)throw new CsoError('INVALID_ARGUMENT','Select only one scope');
  for(const f of scopeFlags)take(args,f);
  const explicitBase=args.includes('--base'),base=explicitBase?need(args,'--base'):'origin/main';
  const rawBudget=args.includes('--budget')?need(args,'--budget'):String(comprehensive?1800:600),budgetSeconds=Number(rawBudget);
  if(!Number.isInteger(budgetSeconds)||budgetSeconds<120||budgetSeconds>(comprehensive?1800:600))throw new CsoError('INVALID_ARGUMENT',`Budget must be an integer from 120 to ${comprehensive?1800:600} seconds`);
  if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown argument: ${args[0]}`);
  if(!fs.existsSync(repo)||!fs.statSync(repo).isDirectory())throw new CsoError('MISSING_INPUT','Repository directory does not exist');
  const scope=named?`domain:${string(named,'scope',100)}`:scopeFlags[0]?.slice(2)??'default';
  return {repo,policy:{mode:comprehensive?'comprehensive':'daily',scope,diff,base,offline,budgetSeconds,maxWorkers:3,maxRepairs:3},...(diff||explicitBase?{comparisonBase:base}:{})};
}
async function start(args:string[],dependencies:CsoCliDependencies,parent?:RunReportV3['parent'],requiredAncestor?:string,startedAt=new Date()):Promise<RunReportV3>{
  const {repo,policy,comparisonBase}=parseStart(args),createdAt=startedAt;assertStateOutside(repo);if(!parent)retention(createdAt.getTime(),{deadlineMs:Math.min(createdAt.getTime()+RETENTION_MAINTENANCE_MS,createdAt.getTime()+policy.budgetSeconds*1000-60_000),maxEntries:RETENTION_MAX_ENTRIES});const run=newRun(repo);
  let manifest:Awaited<ReturnType<typeof capture>>;try{manifest=await capture(repo,run.dir,comparisonBase,requiredAncestor,{deadlineMs:createdAt.getTime()+policy.budgetSeconds*1000-60_000});}catch(error){fs.rmSync(run.dir,{recursive:true,force:true});throw error;}
  const report:RunReportV3={schemaVersion:3,runId:run.runId,repoId:run.repoId,createdAt:createdAt.toISOString(),deadline:new Date(createdAt.getTime()+policy.budgetSeconds*1000).toISOString(),status:'running',completeness:'not assessed',policy,
    source:{root:repo,snapshotHash:manifest.executionHash,originalHash:manifest.originalHash,baseCommit:manifest.baseCommit,
      transformations:[...manifest.entries.filter(entry=>entry.transformation).map(entry=>({path:publicSnapshotPath(manifest,entry.path).path,handling:entry.transformation!})),...(manifest.deletedPaths??[]).map(item=>({path:publicSnapshotPath(manifest,item.path).path,handling:'tracked source deleted; retained history only'}))]},
    application:{actors:[],assets:[],entrypoints:[],tenantBoundaries:[],sensitiveOperations:[],invariants:[]},coverage:[snapshotCoverage(manifest,policy.scope),historyCoverage(readJson(join(run.dir,'history-status.json')),policy.scope),...planned(policy.scope)],findings:[],gaps:[],events:[],...(parent?{parent}:{})};
  event(report,'snapshot',`Captured ${manifest.entries.length} source entries; ${manifest.entries.filter(e=>e.transformation).length+(manifest.deletedPaths?.length??0)} transformations disclosed`);
  if(policy.mode==='comprehensive'){
    const plan=inspectPreparation(join(run.dir,'snapshot'));writeJson(join(run.dir,'preparation.json'),plan);
    const c:CoverageRecord={domain:'runtime-readiness',scope:plan.stack,status:plan.status==='ready'?'partial':'not_assessed',method:'inert lockfile and runtime-catalog inspection',gaps:plan.prerequisites.map(p=>p.message),exclusions:[],evidence:[`Preparation metadata: ${plan.status}`]};
    try{validateRuntimeCatalog(dependencies.runtimeCatalog);selectRuntime(plan.runtimeProfile,platform(),dependencies.runtimeCatalog);c.evidence.push(`Qualified runtime catalog: ${dependencies.runtimeCatalog.revision}`);}catch(error:any){c.gaps.push(error?.message?.startsWith('MISSING_QUALIFIED_RUNTIME')?error.message:'Runtime catalog validation failed');}
    try{const runtimeHome=secureDirectory(join(run.dir,'home')),endpoint=await dockerEndpoint(runtimeHome);const probe=await dockerProbe(endpoint,runtimeHome);c.evidence.push(`Local Docker ${probe.version} admitted at ${endpoint.uri}`);}catch(error:any){c.gaps.push(error instanceof CsoError?error.message:'Local Docker isolation admission failed');}
    if(plan.status==='ready'&&!c.gaps.length)c.status='assessed';else if(c.evidence.length>1)c.status='partial';
    report.coverage.push(c);
  }
  saveReport(run.dir,report);return report;
}
async function doctor(args:string[],dependencies:CsoCliDependencies){
  const started=Date.now(),repo=callerPath(need(args,'--repo'));if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown argument: ${args[0]}`);
  const staticCheck=(async()=>{let home='';try{const stat=fs.statSync(repo);if(!stat.isDirectory())throw new CsoError('MISSING_INPUT','Repository path is not a directory');const g=executable('git');home=secureDirectory(fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()),'gstack-cso-doctor-git-')));if((await git(repo,['rev-parse','--is-inside-work-tree'],home)).trim()!=='true')throw new CsoError('MISSING_INPUT','Repository path is not a Git working tree');return{capability:'static-snapshot',status:'ready',detail:g};}catch(e:any){return{capability:'static-snapshot',status:'missing',detail:e instanceof CsoError?e.message:'Repository path is missing or unreadable'};}finally{if(home)fs.rmSync(home,{recursive:true,force:true});}})();
  let preparation:ReturnType<typeof inspectPreparation>|undefined;
  try{const stat=fs.statSync(repo);if(!stat.isDirectory())throw new CsoError('MISSING_INPUT','Repository path is not a directory');preparation=inspectPreparation(repo);}catch{}
  const scannerCatalog=dependencies.scannerCatalog??SCANNER_CATALOG,imageSession=dependencies.catalogImageSession??productionCatalogImageSession,deadline=started+30_000;
  let targetPlatform:'linux/amd64'|'linux/arm64'|undefined,entries:ReturnType<typeof qualifiedCatalogImages>=[];
  try{targetPlatform=platform();entries=qualifiedCatalogImages(dependencies.runtimeCatalog,scannerCatalog,targetPlatform);}catch{}
  const inspectedPromise=inspectCatalogImages(entries,imageSession,deadline);
  const checks:any[]=[await staticCheck];
  checks.push(preparation?{capability:'application-preparation',status:preparation.status==='ready'?'ready':'missing',detail:{stack:preparation.stack,prerequisites:preparation.prerequisites}}:{capability:'application-preparation',status:'missing',detail:'Repository source is unavailable for inert preparation inspection'});
  const inspected=await inspectedPromise;checks.push({capability:'local-docker-isolation',status:inspected.docker.status,detail:inspected.docker.detail});
  try{
    if(!preparation||preparation.status!=='ready')throw new CsoError('PREREQUISITE','Resolve the application-preparation prerequisites first');
    if(!targetPlatform)throw new CsoError('PREREQUISITE','Qualified runtimes require an amd64/arm64 Linux Docker platform');
    validateRuntimeCatalog(dependencies.runtimeCatalog);const runtime=selectRuntime(preparation.runtimeProfile,targetPlatform,dependencies.runtimeCatalog),availability=inspected.images.find(item=>item.kind==='runtime'&&item.id===runtime.id),requiredSidecars:Array<Record<string,unknown>>=[],prerequisites:string[]=[];
    if(!availability||availability.status!=='available')prerequisites.push(availability?.reason??'Exact qualified runtime image is not present in the local Docker daemon; rerun setup with Docker and public registry access');
    if(preparation.stack==='rails'&&preparation.database?.selected==='postgresql'){
      const sidecar=selectRuntime('postgresql',targetPlatform,dependencies.runtimeCatalog),sidecarAvailability=inspected.images.find(item=>item.kind==='runtime'&&item.id===sidecar.id),sidecarReady=sidecarAvailability?.status==='available',prerequisite=sidecarReady?undefined:sidecarAvailability?.reason??'Exact qualified PostgreSQL sidecar image is not present in the local Docker daemon; rerun setup with Docker and public registry access';
      if(prerequisite)prerequisites.push(prerequisite);requiredSidecars.push({kind:'postgresql',profile:sidecar.id,image:sidecar.image,platform:targetPlatform,availability:sidecarReady?'available':'unavailable',...(prerequisite?{prerequisite}:{})});
    }
    const ready=!prerequisites.length;checks.push({capability:'qualified-runtimes',status:ready?'ready':'missing',detail:{catalog:dependencies.runtimeCatalog.revision,profile:runtime.id,image:runtime.image,platform:targetPlatform,availability:ready?'available':'unavailable',...(requiredSidecars.length?{requiredSidecars}:{}),...(prerequisites.length?{prerequisite:prerequisites[0],prerequisites}:{})}});
  }catch(error:any){checks.push({capability:'qualified-runtimes',status:'missing',detail:error instanceof CsoError?error.message:error?.message??'Qualified runtime catalog is invalid'});}
  for(const id of SCANNER_IDS){try{
    if(!targetPlatform)throw new CsoError('PREREQUISITE','Scanner containers require an amd64/arm64 Linux Docker platform');validateScannerCatalog(scannerCatalog);
    const profile=selectScanner(id,targetPlatform,undefined,scannerCatalog),availability=inspected.images.find(item=>item.kind==='scanner'&&item.id===profile.id);
    if(!availability||availability.status!=='available')checks.push({capability:`scanner:${id}`,status:'missing',detail:{catalog:scannerCatalog.revision,profile:profile.id,image:profile.image,version:profile.version,qualifiedAt:profile.qualifiedAt,availability:'unavailable',prerequisite:availability?.reason??'Exact qualified scanner image is not present in the local Docker daemon; rerun setup with Docker and public registry access'}});
    else checks.push({capability:`scanner:${id}`,status:'ready',detail:{catalog:scannerCatalog.revision,profile:profile.id,image:profile.image,version:profile.version,qualifiedAt:profile.qualifiedAt,availability:'available'}});
  }catch(error:any){checks.push({capability:`scanner:${id}`,status:'missing',detail:error instanceof CsoError?error.message:error?.message??'Qualified scanner catalog is invalid'});}}
  return{schemaVersion:3,downloads:false,elapsedMs:Date.now()-started,checks};
}
async function provisionImages(args:string[],dependencies:CsoCliDependencies):Promise<unknown>{
  const setupSummary=take(args,'--setup-summary'),requestedSeconds=args.includes('--per-image-seconds')?need(args,'--per-image-seconds'):undefined;if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown argument: ${args[0]}`);
  if(requestedSeconds!==undefined)catalogImageProvisioningPolicy(0,requestedSeconds);
  let targetPlatform:'linux/amd64'|'linux/arm64';
  try{targetPlatform=platform();}catch(error){
    const reason=error instanceof CsoError?error.message:'Qualified image provisioning requires an amd64/arm64 Linux Docker platform',result={schemaVersion:1,status:'not_available',downloads:true,platform:'unsupported',requested:0,inspected:0,alreadyPresent:0,downloaded:0,deadlineReached:false,unavailable:[],summary:`Qualified CSO images were not preloaded: ${reason}. Static audits remain available.`};
    return setupSummary?result.summary:result;
  }
  const scannerCatalog=dependencies.scannerCatalog??SCANNER_CATALOG,entries=qualifiedCatalogImages(dependencies.runtimeCatalog,scannerCatalog,targetPlatform),policy=catalogImageProvisioningPolicy(entries.length,requestedSeconds),deadline=Date.now()+policy.aggregateMs,result=await provisionCatalogImages(entries,targetPlatform,dependencies.catalogImageSession??productionCatalogImageSession,deadline,policy.perImageMs);
  return setupSummary?result.summary:result;
}
function run(args:string[]){if(!args.length)throw new CsoError('INVALID_ARGUMENT','Run ID is required');return {dir:runDirectory(args.shift()!),report:null as any};}
function recoveryEvents(dir:string):string[]{const out:string[]=[];let visited=0;const walk=(at:string,depth:number)=>{if(depth>6||visited++>4000)return;let entries:fs.Dirent[];try{entries=fs.readdirSync(at,{withFileTypes:true});}catch{return;}for(const entry of entries){if(!/^[A-Za-z0-9._-]{1,120}$/.test(entry.name))continue;const path=join(at,entry.name);let stat:fs.Stats;try{stat=fs.lstatSync(path);}catch{continue;}if(stat.isSymbolicLink())continue;if(stat.isDirectory()){walk(path,depth+1);continue;}if(!['attempt.event','watchdog.event'].includes(entry.name)||!stat.isFile()||stat.size>8192)continue;try{const message=redact(fs.readFileSync(path,'utf8').trim());if(message&&!out.includes(message))out.push(message);}catch{}}};for(const name of ['supervision','preparation-execution']){const root=join(dir,name);if(!fs.existsSync(root))continue;const stat=fs.lstatSync(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new CsoError('UNSAFE_PATH','Watchdog recovery state is not a private directory');walk(root,0);}return out;}
function publicSnapshotPath(manifest:SnapshotManifest,path:string):{path:string;displayPath?:string}{
  const entry=manifest.entries.find(item=>item.path===path),handle=snapshotPathHandle(entry?.pathId??snapshotPathId(manifest.root,path));let displayPath:string;
  try{displayPath=redact(path);}catch{displayPath='[sensitive path withheld]';}
  return displayPath===path?{path}:{path:handle,displayPath};
}
function publicSnapshotManifest(manifest:SnapshotManifest):Record<string,unknown>{
  return {...manifest,entries:manifest.entries.map(entry=>{const {path,pathId:_,...rest}=entry;return{...rest,...publicSnapshotPath(manifest,path)};}),
    ...(manifest.deletedPaths?.length?{deletedPaths:manifest.deletedPaths.map(item=>publicSnapshotPath(manifest,item.path))}:{}),
    ...(manifest.changedPaths?{changedPaths:manifest.changedPaths.map(path=>publicSnapshotPath(manifest,path).path)}:{})};
}
function resolveSnapshotPath(manifest:SnapshotManifest,value:unknown,requireEntry:boolean,label='Snapshot path',allowDeleted=false):{path:string;entry?:SnapshotEntry}{
  const reference=snapshotReference(value),handleId=snapshotPathHandleId(reference);
  if(handleId){const entry=manifest.entries.find(item=>item.pathId===handleId);if(entry)return{path:entry.path,entry};const deleted=manifest.deletedPaths?.find(item=>item.pathId===handleId),changed=manifest.changedPaths?.find(path=>snapshotPathId(manifest.root,path)===handleId);if(allowDeleted&&deleted)return{path:deleted.path};if(!requireEntry&&changed)return{path:changed};throw new CsoError('INVALID_SCHEMA',`${label} handle is outside the retained inventory: ${reference}`);}
  const path=relativePath(reference),entry=manifest.entries.find(item=>item.path===path),deleted=manifest.deletedPaths?.find(item=>item.path===path),changed=manifest.changedPaths?.includes(path);if(entry)return{path,entry};if(allowDeleted&&deleted)return{path};if(!requireEntry&&changed)return{path};throw new CsoError('INVALID_SCHEMA',`${label} is outside the retained inventory: ${reference}`);
}
type BoundRecheckEvidence={kind:'caller'|'security_boundary';path:string;line:number;observation:string;sourceState:'present'|'absent';snapshotHash:string;sourceHash?:string;executionHash?:string};
type BoundRecheckClaim={findingId:string;outcome:'open'|'resolved'|'unknown';evidence:BoundRecheckEvidence[];rootCause:string};
function assertRecheckLine(runDir:string,path:string,entry:SnapshotEntry,line:number,label:string):void{
  if(!entry.executionHash)throw new CsoError('INVALID_SCHEMA',`${label} must reference source available in the fresh execution snapshot`);
  const body=readBoundedStable(containedFile(join(runDir,'snapshot'),path),64*1024*1024,label).toString('utf8'),lines=body.length?(body.endsWith('\n')?body.slice(0,-1):body).split('\n').length:0;
  if(line>lines)throw new CsoError('INVALID_SCHEMA',`${label} line is outside the fresh source file`);
}
function originalBoundary(report:RunReportV3):{dir:string;report:RunReportV3;manifest:SnapshotManifest;finding:FindingV3;path:string}{
  if(!report.parent)throw new CsoError('INVALID_SCHEMA','Recheck evidence requires a linked original finding');
  const dir=runDirectory(report.parent.runId),original=loadReport(dir),manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest,
    finding=original.findings.find(item=>item.id===report.parent!.findingId);
  if(report.repoId!==original.repoId)throw new CsoError('INCOMPATIBLE_INPUT','Recheck repository identity differs from the original audit');
  if(!finding)throw new CsoError('MISSING_INPUT','Original recheck finding no longer exists');
  const path=resolveSnapshotPath(manifest,finding.location.path,false,'Original finding boundary',true).path;
  return{dir,report:original,manifest,finding,path};
}
function bindRecheckEvidence(value:unknown,runDir:string,manifest:SnapshotManifest,boundary:ReturnType<typeof originalBoundary>,outcome:BoundRecheckClaim['outcome']):BoundRecheckEvidence[]{
  if(!Array.isArray(value)||value.length<1||value.length>20)throw new CsoError('INVALID_SCHEMA','Recheck evidence must contain 1 to 20 fresh source observations');
  const evidence=value.map((raw,index)=>{
    const item=object(raw,`recheck evidence[${index}]`);rejectUnexpected(item,['kind','path','line','observation'],`recheck evidence[${index}]`);
    const kind=string(item.kind,`recheck evidence[${index}].kind`,32);if(!['caller','security_boundary'].includes(kind))throw new CsoError('INVALID_SCHEMA','Recheck evidence kind must be caller or security_boundary');
    if(!Number.isSafeInteger(item.line)||item.line<1)throw new CsoError('INVALID_SCHEMA',`recheck evidence[${index}].line must be a positive integer`);
    const observation=redact(string(item.observation,`recheck evidence[${index}].observation`,2048)),reference=snapshotReference(item.path);
    let selected:{path:string;entry?:SnapshotEntry}|undefined;
    try{selected=resolveSnapshotPath(manifest,reference,true,`recheck evidence[${index}].path`);}catch(error){
      if(kind!=='security_boundary')throw error;
      let old:{path:string};try{old=resolveSnapshotPath(boundary.manifest,reference,false,`recheck evidence[${index}].path`,true);}catch{throw error;}
      if(old.path!==boundary.path||manifest.entries.some(entry=>entry.path===boundary.path))throw error;
      if(item.line!==boundary.finding.location.line)throw new CsoError('INVALID_SCHEMA','Absent security-boundary evidence must cite the original finding line');
      return{kind:'security_boundary' as const,path:snapshotPathHandle(snapshotPathId(manifest.root,boundary.path)),line:item.line as number,observation,sourceState:'absent' as const,snapshotHash:manifest.originalHash};
    }
    if(!selected.entry||selected.entry.originalHash==='not-read')throw new CsoError('INVALID_SCHEMA','Recheck evidence must reference freshly captured readable source');
    assertRecheckLine(runDir,selected.path,selected.entry,item.line as number,`recheck evidence[${index}]`);
    if(kind==='security_boundary'&&selected.path!==boundary.path)throw new CsoError('INVALID_SCHEMA','Security-boundary evidence must reference the original finding location');
    return{kind:kind as BoundRecheckEvidence['kind'],path:snapshotPathHandle(selected.entry.pathId),line:item.line as number,observation,sourceState:'present' as const,snapshotHash:manifest.originalHash,sourceHash:selected.entry.originalHash,executionHash:selected.entry.executionHash};
  });
  const identities=new Set(evidence.map(item=>canonical(item)));if(identities.size!==evidence.length)throw new CsoError('INVALID_SCHEMA','Recheck evidence contains duplicate observations');
  if(outcome==='resolved'&&(!evidence.some(item=>item.kind==='caller'&&item.sourceState==='present')||!evidence.some(item=>item.kind==='security_boundary')))
    throw new CsoError('INVALID_SCHEMA','Resolved closure requires fresh caller evidence and evidence for the original security boundary');
  return evidence;
}
function validateBoundRecheckClaim(value:unknown,runDir:string,manifest:SnapshotManifest,boundary:ReturnType<typeof originalBoundary>):BoundRecheckClaim{
  const raw=object(value,'retained recheck claim');rejectUnexpected(raw,['findingId','outcome','evidence','rootCause'],'retained recheck claim');
  const findingId=string(raw.findingId,'retained recheck findingId'),rootCause=string(raw.rootCause,'retained recheck rootCause'),outcome=raw.outcome;
  if(!['open','resolved','unknown'].includes(outcome as string))throw new CsoError('INVALID_SCHEMA','Retained recheck outcome is invalid');
  if(!Array.isArray(raw.evidence)||raw.evidence.length<1||raw.evidence.length>20)throw new CsoError('INVALID_SCHEMA','Retained recheck evidence is invalid');
  const evidence=raw.evidence.map((itemRaw,index)=>{
    const item=object(itemRaw,`retained recheck evidence[${index}]`);rejectUnexpected(item,['kind','path','line','observation','sourceState','snapshotHash','sourceHash','executionHash'],`retained recheck evidence[${index}]`);
    const kind=string(item.kind,`retained recheck evidence[${index}].kind`,32),sourceState=string(item.sourceState,`retained recheck evidence[${index}].sourceState`,16);
    if(!['caller','security_boundary'].includes(kind)||!['present','absent'].includes(sourceState))throw new CsoError('INVALID_SCHEMA','Retained recheck evidence type is invalid');
    if(!Number.isSafeInteger(item.line)||item.line<1)throw new CsoError('INVALID_SCHEMA','Retained recheck evidence line is invalid');
    const observation=string(item.observation,`retained recheck evidence[${index}].observation`,2048),reference=snapshotReference(item.path);
    if(item.snapshotHash!==manifest.originalHash)throw new CsoError('INCOMPATIBLE_INPUT','Retained recheck evidence is not bound to the complete fresh snapshot inventory');
    if(sourceState==='present'){
      const selected=resolveSnapshotPath(manifest,reference,true,'Retained recheck evidence path');
      if(!selected.entry||selected.entry.originalHash==='not-read'||typeof item.sourceHash!=='string'||item.sourceHash!==selected.entry.originalHash||typeof item.executionHash!=='string'||item.executionHash!==selected.entry.executionHash)
        throw new CsoError('INCOMPATIBLE_INPUT','Retained recheck evidence is not bound to the fresh snapshot');
      assertRecheckLine(runDir,selected.path,selected.entry,item.line as number,`retained recheck evidence[${index}]`);
      if(kind==='security_boundary'&&selected.path!==boundary.path)throw new CsoError('INCOMPATIBLE_INPUT','Retained security-boundary evidence changed location');
      return{kind:kind as BoundRecheckEvidence['kind'],path:snapshotPathHandle(selected.entry.pathId),line:item.line as number,observation,sourceState:'present' as const,snapshotHash:item.snapshotHash as string,sourceHash:item.sourceHash,executionHash:item.executionHash};
    }
    if(kind!=='security_boundary'||item.sourceHash!==undefined||item.executionHash!==undefined)throw new CsoError('INVALID_SCHEMA','Only an absent original security boundary can use absent evidence');
    const old=resolveSnapshotPath(boundary.manifest,reference,false,'Retained absent security boundary',true);
    if(old.path!==boundary.path||manifest.entries.some(entry=>entry.path===boundary.path)||item.line!==boundary.finding.location.line)throw new CsoError('INCOMPATIBLE_INPUT','Retained absent-boundary evidence does not match the fresh snapshot');
    return{kind:'security_boundary' as const,path:snapshotPathHandle(snapshotPathId(manifest.root,boundary.path)),line:item.line as number,observation,sourceState:'absent' as const,snapshotHash:item.snapshotHash as string};
  });
  if(outcome==='resolved'&&(!evidence.some(item=>item.kind==='caller'&&item.sourceState==='present')||!evidence.some(item=>item.kind==='security_boundary')))
    throw new CsoError('INVALID_SCHEMA','Resolved closure lacks caller or original security-boundary evidence');
  if(new Set(evidence.map(item=>canonical(item))).size!==evidence.length)throw new CsoError('INVALID_SCHEMA','Retained recheck evidence contains duplicates');
  return{findingId,outcome:outcome as BoundRecheckClaim['outcome'],evidence,rootCause};
}
function requireReportingTime(report:RunReportV3):void{if(Date.now()>=Date.parse(report.deadline))throw new CsoError('DEADLINE','Audit deadline reached; no further evidence can be accepted');}
function submit(args:string[]){
  const {dir}=run(args);if(args.length!==1)throw new CsoError('INVALID_ARGUMENT','submit requires one JSON file');const rawInput=object(readInput(args[0]),'submission');rejectUnexpected(rawInput,['application','findings','coverage','gaps','modelUsage','recheck'],'submission');const input=rawInput as SubmissionV3;
  return withLock(dir,()=>{const report=loadReport(dir),manifest=readJson(join(dir,'snapshot.json'));assertSnapshot(dir,manifest);requireReportingTime(report);if(report.status!=='running')throw new CsoError('INVALID_SCHEMA','Only a running audit accepts evidence');
    if(input.findings!==undefined&&!Array.isArray(input.findings))throw new CsoError('INVALID_SCHEMA','submission.findings must be an array');
    if(input.coverage!==undefined&&!Array.isArray(input.coverage))throw new CsoError('INVALID_SCHEMA','submission.coverage must be an array');
    if(input.application)report.application=model(input.application);
    for(const raw of input.findings??[]){const sourceFinding=validateFinding(raw),sourceLocation=resolveSnapshotPath(manifest,sourceFinding.location.path,false,'Finding path',true);if(report.policy.diff&&(!Array.isArray(manifest.changedPaths)||!manifest.changedPaths.includes(sourceLocation.path)))throw new CsoError('INVALID_SCHEMA',`Diff-scope finding root cause is outside the captured changed paths: ${sourceFinding.location.path}`);const safeRaw=object(sanitizeForJson(raw),'finding'),safeLocation=object(safeRaw.location,'location');safeLocation.path=publicSnapshotPath(manifest,sourceLocation.path).path;const f=validateFinding(safeRaw),normalizedLocation=resolveSnapshotPath(manifest,f.location.path,false,'Finding path',true);if(normalizedLocation.path!==sourceLocation.path)throw new CsoError('INVALID_SCHEMA','Finding path identity changed during redaction');if(report.policy.mode==='daily'&&f.evidence==='hypothesis')throw new CsoError('INVALID_SCHEMA','Daily reports contain supported findings only');const old=report.findings.findIndex(x=>x.fingerprint===f.fingerprint);if(old<0){report.findings.push(f);event(report,'early-finding',`${f.severity} ${f.evidence} finding ${f.id}`);}else report.findings[old]={...f,reproduction:report.findings[old].reproduction,repair:report.findings[old].repair,closure:report.findings[old].closure,verificationId:report.findings[old].verificationId,reproductionAttemptId:report.findings[old].reproductionAttemptId,verificationAssurance:report.findings[old].verificationAssurance};}
    for(const raw of input.coverage??[]){const c=validateCoverage(raw);if(helperOwnedCoverage(c.domain))throw new CsoError('INVALID_SCHEMA',`Coverage domain is helper-owned: ${c.domain}`);const i=report.coverage.findIndex(x=>x.domain===c.domain&&x.scope===c.scope);if(i<0)report.coverage.push(c);else report.coverage[i]=c;}
    if(input.gaps)report.gaps=strings(input.gaps,'gaps');
    if(input.modelUsage){const u=object(input.modelUsage,'model usage');rejectUnexpected(u,['source','tokens','cost'],'model usage');if(!Number.isInteger(u.tokens)||u.tokens<0||('cost'in u&&(typeof u.cost!=='number'||!Number.isFinite(u.cost)||u.cost<0)))throw new CsoError('INVALID_SCHEMA','Model usage must be host-reported finite nonnegative numbers');report.modelUsage={source:string(u.source,'usage source'),tokens:u.tokens,...(typeof u.cost==='number'?{cost:u.cost}:{})};}
    let recheckClaim:BoundRecheckClaim|undefined;
    if(input.recheck){const rawClaim=object(input.recheck,'recheck claim');rejectUnexpected(rawClaim,['findingId','outcome','evidence','rootCause'],'recheck claim');if(!report.parent||input.recheck.findingId!==report.parent.findingId)throw new CsoError('INVALID_SCHEMA','Recheck claim must target the linked original finding');const outcome=input.recheck.outcome;if(!['open','resolved','unknown'].includes(outcome))throw new CsoError('INVALID_SCHEMA','Recheck needs an open, resolved, or unknown outcome');const boundary=originalBoundary(report),claim={findingId:string(input.recheck.findingId,'findingId'),outcome,evidence:bindRecheckEvidence(input.recheck.evidence,dir,manifest,boundary,outcome),rootCause:string(input.recheck.rootCause,'rootCause')};recheckClaim=claim;}
    // A claim can close a prior finding. Publish it only after every report
    // mutation it relies on is durably accepted, so a failed submission never
    // leaves closure evidence behind.
    saveReport(dir,report);if(recheckClaim)writeHelperJson(join(dir,'recheck-claim.json'),recheckClaim);return {runId:report.runId,findings:report.findings.length,completeness:report.completeness};});
}
function finish(args:string[]){const {dir}=run(args);if(args.length)throw new CsoError('INVALID_ARGUMENT','finish takes only a run ID');return withLock(dir,()=>{
  const report=loadReport(dir),manifest=readJson(join(dir,'snapshot.json'));assertSnapshot(dir,manifest);for(const c of report.coverage)if(c.status==='not_assessed'&&!c.domain.startsWith('scanner:')&&!report.gaps.includes(`${c.domain}: not assessed`))report.gaps.push(`${c.domain}: not assessed`);
  if(!report.application.actors.length&&!report.gaps.includes('Application model was not completed'))report.gaps.push('Application model was not completed');report.completeness=completeness(report);
  const persistTerminal=()=>{report.status='finished';if(!report.events.some(e=>e.kind==='terminal'))event(report,'terminal','Audit finished and retained according to the private-state policy');saveReport(dir,report);return{runId:report.runId,status:report.status,completeness:report.completeness,report:'report.md'};};
  if(report.parent&&fs.existsSync(join(dir,'recheck-claim.json'))){const boundary=originalBoundary(report),claim=validateBoundRecheckClaim(readJson(join(dir,'recheck-claim.json')),dir,manifest,boundary);if(claim.outcome==='resolved'){
    if(report.completeness!=='complete')throw new CsoError('INVALID_SCHEMA','Partial or incompatible rechecks cannot establish closure');
    const originalDir=boundary.dir;return withLock(originalDir,()=>{const original=loadReport(originalDir),finding=original.findings.find(f=>f.id===claim.findingId);
      if(report.repoId!==original.repoId)throw new CsoError('INCOMPATIBLE_INPUT','Recheck repository identity differs from the original audit');
      const survivingVariant=!!finding&&report.findings.some(candidate=>candidate.fingerprint===finding.fingerprint||rootCauseIdentity(candidate.rootCause)===rootCauseIdentity(finding.rootCause)||(candidate.advisoryIds.length>0&&candidate.advisoryIds.some(id=>finding.advisoryIds.includes(id))));
      if(!finding||finding.id!==boundary.finding.id||rootCauseIdentity(finding.rootCause)!==rootCauseIdentity(claim.rootCause)||survivingVariant)throw new CsoError('INVALID_SCHEMA','Closure needs matching root cause, fresh caller and original-boundary evidence, and no surviving root-cause or advisory variant');
      const result=persistTerminal();if(finding.closure!=='resolved'){finding.closure='resolved';event(original,'closure',`Fresh recheck ${report.runId} resolved ${finding.id}`);saveReport(originalDir,original);}return result;});
  }}return persistTerminal();});}

async function inspect(args:string[]){const {dir}=run(args);if(args.length)throw new CsoError('INVALID_ARGUMENT','inspect takes one run ID');const report=loadReport(dir),manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);const rawSensitive=readJson(join(dir,'sensitive-evidence.json')),sensitiveEvidence=Array.isArray(rawSensitive)?rawSensitive.map(item=>{if(!item||typeof item!=='object'||typeof item.path!=='string')return item;const id=snapshotPathHandleId(item.path),exact=id?manifest.entries.find(entry=>entry.pathId===id)?.path:item.path;if(!exact)throw new CsoError('INCOMPATIBLE_INPUT','Sensitive-evidence path handle is outside the snapshot');return{...item,...publicSnapshotPath(manifest,exact)};}):rawSensitive;emit({report,manifest:publicSnapshotManifest(manifest),history:readJson(join(dir,'history-status.json')),sensitiveEvidence,preparation:fs.existsSync(join(dir,'preparation.json'))?readJson(join(dir,'preparation.json')):undefined,recovery:recoveryEvents(dir)});}
async function read(args:string[]){const {dir}=run(args);if(args.length!==1)throw new CsoError('INVALID_ARGUMENT','read requires one path or opaque handle');const manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);const selected=resolveSnapshotPath(manifest,args[0],true),full=containedFile(join(dir,'readable'),selected.path),data=readBoundedStable(full,1024*1024,'Snapshot path');emit(data.toString('utf8'));}
async function history(args:string[]){const {dir}=run(args),manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);let selected:string|undefined;if(args.length)selected=resolveSnapshotPath(manifest,args.shift(),false,'History path',true).path;if(args.length)throw new CsoError('INVALID_ARGUMENT','history accepts at most one path or opaque handle');const status=readJson(join(dir,'history-status.json'));if(status.status!=='captured'||!fs.existsSync(join(dir,'history.txt')))throw new CsoError('MISSING_INPUT',status.gap||'Historical evidence was not retained');const raw=fs.readFileSync(join(dir,'history.txt'),'utf8');if(!selected){emit(raw);return;}
  const displayPath=publicSnapshotPath(manifest,selected).displayPath??selected,retained=historyForPath(raw,displayPath);emit(retained??`No retained patch hunks for ${displayPath}`);}
function resume(args:string[]){const {dir}=run(args);if(args.length)throw new CsoError('INVALID_ARGUMENT','resume takes one run ID');return withLock(dir,()=>{const report=loadReport(dir),manifest=readJson(join(dir,'snapshot.json'));if(report.status==='finished')throw new CsoError('INVALID_SCHEMA','A finished audit cannot be resumed');assertSnapshot(dir,manifest);for(const message of recoveryEvents(dir))if(!report.events.some(e=>e.kind==='watchdog-recovery'&&e.message===message))event(report,'watchdog-recovery',message);if(Date.now()>=Date.parse(report.deadline)){report.status='interrupted';event(report,'deadline','Original budget is exhausted; resume did not replenish it');saveReport(dir,report);throw new CsoError('DEADLINE','Original run budget is exhausted');}report.status='running';event(report,'resume','Continued retained snapshot under original policy');saveReport(dir,report);return {runId:report.runId,deadline:report.deadline,policy:report.policy,recovery:recoveryEvents(dir)};});}
function importV2(args:string[]){if(args.length!==1)throw new CsoError('INVALID_ARGUMENT','import-v2 requires one report file');const legacy=sanitizeForJson(importLegacy(readInput(args[0]))) as ReturnType<typeof importLegacy>,id=sha256(JSON.stringify(legacy)),dir=secureDirectory(join(privateRoot(),'legacy-imports'));writeJson(join(dir,`${id}.json`),legacy);return {id,path:`legacy-imports/${id}.json`,warning:legacy.warning};}
async function scanner(args:string[],sarif=false){
  const {dir}=run(args);
  if(sarif?args.length!==1:(args.length<1||args.length>2||!SCANNER_IDS.includes(args[0] as ScannerId)))throw new CsoError('INVALID_ARGUMENT',sarif?'import-sarif needs one file':'scan requires a supported scanner ID and optional request JSON');
  const id=args[0] as ScannerId,request=!sarif?validateScannerRequest(args[1]?readInput(args[1]):{},id):undefined;
  // A live writer owns the lock throughout the bounded scan. Finish, submit and
  // concurrent imports cannot replace coverage or retire the run underneath it.
  return await withLock(dir,async()=>{
    const report=loadReport(dir);requireTime(report);if(report.status!=='running')throw new CsoError('INVALID_SCHEMA','Scanner evidence can only enter a running audit');
    let record:any;
    if(sarif){
      const file=callerPath(args[0]);
      try{
        const data=readBoundedStable(file,1024*1024,'SARIF file'),out=importSarif(data.toString('utf8'),{sourceRoot:'/source'});record={outcome:out,coverage:scannerCoverage(out,report.policy.scope),provenance:{kind:'untrusted SARIF import',sourceHash:sha256(data)}};
      }catch(error){if(error instanceof CsoError)throw error;throw new CsoError('MISSING_INPUT','SARIF file is missing or unreadable');}
    }else{
      event(report,`scanner-attempt:${id}`,'Started bounded scanner collection; completion requires an immutable outcome artifact');saveReport(dir,report);
      record=await executeScanner({id,runId:report.runId,runDir:dir,manifest:readJson(join(dir,'snapshot.json')),policy:report.policy,executionDeadline:Date.parse(report.deadline)-60_000,platform:platform(),request,watchdogPath:join(dirname(process.execPath),'gstack-cso-watchdog')});
    }
    const outcome=record.outcome,originalCount=outcome.candidates.length;
    // Normalization can expand a 1 MiB scanner payload. Retain supported-size
    // candidate evidence and disclose omissions instead of saving unreadable state.
    while(Buffer.byteLength(JSON.stringify(record,null,2))>950_000&&outcome.candidates.length)outcome.candidates.splice(Math.max(0,outcome.candidates.length-Math.max(1,Math.ceil(outcome.candidates.length/4))));
    if(outcome.candidates.length<originalCount){outcome.status='partial';outcome.gaps.push({code:'OUTPUT_LIMIT',message:`${originalCount-outcome.candidates.length} scanner candidates withheld to fit the bounded immutable artifact`});record.coverage=scannerCoverage(outcome,report.policy.scope);}
    if(Buffer.byteLength(JSON.stringify(record,null,2))>1024*1024)throw new CsoError('PERSISTENCE_FAILED','Scanner result exceeds the private artifact limit; no saved report is claimed');
    record=persistableArtifact(record,'Scanner outcome');const artifactId=`${outcome.tool}-${sha256(canonical(record)).slice(0,16)}-${randomBytes(8).toString('hex')}`,file=join(dir,'scanner-outcomes',`${artifactId}.json`);
    writeJsonExclusive(file,record);
    record.coverage.evidence.push(`Immutable outcome: ${artifactId}`);
    report.coverage.push(record.coverage);event(report,'scanner-outcome',`${artifactId}: ${outcome.status}; ${outcome.candidates.length} candidates`);saveReport(dir,report);
    return {...outcome,artifactId,artifact:`scanner-outcomes/${artifactId}.json`,provenance:record.provenance};
  });
}
function scannerOutcome(args:string[]){const {dir}=run(args);if(args.length!==1||!/^[a-z0-9-]{1,40}-[a-f0-9]{16}-[a-f0-9]{16}$/.test(args[0]))throw new CsoError('INVALID_ARGUMENT','scanner-outcome requires one immutable scanner artifact ID');return readJson(join(dir,'scanner-outcomes',`${args[0]}.json`));}
function recheckOriginalDirectory(repo:string,findingId:string,requestedRun?:string):{dir:string;runId:string}{
  const currentRepoId=repoId(repo),root=privateRoot(),repoDir=join(root,currentRepoId),runPattern=/^\d{13}-[a-f0-9]{16}$/;
  if(requestedRun){
    if(!runPattern.test(requestedRun))throw new CsoError('INVALID_ARGUMENT','Run identifier must be the ID returned by start');
    const dir=join(repoDir,requestedRun);if(!fs.existsSync(dir))throw new CsoError('MISSING_INPUT','Original run was not found for the current repository or has expired');
    return{dir:secureDirectory(dir),runId:requestedRun};
  }
  if(!fs.existsSync(repoDir))throw new CsoError('MISSING_INPUT','No finished original audit contains this finding in the current repository');
  const matches:{dir:string;runId:string}[]=[],directory=fs.opendirSync(secureDirectory(repoDir));let visited=0;
  try{let entry:fs.Dirent|null;while((entry=directory.readSync())!==null){
    if(++visited>REPLAY_LOOKUP_MAX_ENTRIES)throw new CsoError('INSUFFICIENT_CAPACITY',`Recheck lookup exceeded ${REPLAY_LOOKUP_MAX_ENTRIES} private state entries`);
    if(!entry.isDirectory()||!runPattern.test(entry.name))continue;const dir=join(repoDir,entry.name),reportPath=join(dir,'report.json');if(!fs.existsSync(reportPath))continue;const report=loadReport(dir);
    if(report.runId!==entry.name||report.repoId!==currentRepoId)throw new CsoError('INCOMPATIBLE_INPUT','Retained original audit identity does not match its repository state path');
    if(report.status==='finished'&&!report.parent&&report.findings.some(f=>f.id===findingId))matches.push({dir,runId:entry.name});
  }}finally{directory.closeSync();}
  if(!matches.length)throw new CsoError('MISSING_INPUT','No finished original audit contains this finding in the current repository');
  if(matches.length>1)throw new CsoError('INVALID_ARGUMENT',`Finding matches ${matches.length} finished original audits; use --run RUN to select one`);
  return matches[0];
}
async function recheck(args:string[],dependencies:CsoCliDependencies){const startedAt=new Date();if(!args.length)throw new CsoError('INVALID_ARGUMENT','recheck requires a finding ID');const findingId=args.shift()!;if(!/^[a-f0-9]{32}$/.test(findingId))throw new CsoError('INVALID_ARGUMENT','Finding identifier must be the 32-character ID reported by CSO');const repo=callerPath(need(args,'--repo')),requestedRun=args.includes('--run')?need(args,'--run'):undefined;if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown recheck argument: ${args[0]}`);if(!fs.existsSync(repo)||!fs.statSync(repo).isDirectory())throw new CsoError('MISSING_INPUT','Repository directory does not exist');assertStateOutside(repo);retention(startedAt.getTime(),{deadlineMs:startedAt.getTime()+RETENTION_MAINTENANCE_MS,maxEntries:RETENTION_MAX_ENTRIES});const selected=recheckOriginalDirectory(repo,findingId,requestedRun),runId=selected.runId,originalDir=selected.dir;return await withLock(originalDir,async()=>{const original=loadReport(originalDir);if(original.runId!==runId||original.repoId!==repoId(repo))throw new CsoError('INCOMPATIBLE_INPUT','Retained original audit identity does not match its repository state path');const finding=original.findings.find(f=>f.id===findingId);if(!finding)throw new CsoError('MISSING_INPUT','Original finding does not exist');if(original.status!=='finished'||original.parent)throw new CsoError('INVALID_SCHEMA','Recheck requires a finished original audit');
    // Keep the original immutable while the fresh snapshot is captured and
    // until its child lineage report has been durably published.
    const oldManifest=readJson(join(originalDir,'snapshot.json'));
    const preserveBase=original.policy.diff||Boolean(original.source.baseCommit),report=await start(['--repo',repo,...(original.policy.mode==='comprehensive'?['--comprehensive']:[]),...(original.policy.diff?['--diff']:[]),...(preserveBase?['--base',original.policy.base]:[]),'--budget',String(original.policy.budgetSeconds),...(original.policy.offline?['--offline']:[]),...(original.policy.scope==='default'?[]:original.policy.scope.startsWith('domain:')?['--scope',original.policy.scope.slice(7)]:[`--${original.policy.scope}`])],dependencies,{runId,findingId,kind:'recheck'},oldManifest.headCommit,startedAt);
    return {runId:report.runId,parent:report.parent};});}

function recordReview(args:string[]){
  const {dir}=run(args);if(!args.length)throw new CsoError('INVALID_ARGUMENT','record-review requires a request JSON file and --producer ID');const raw=readInput(args.shift()!),producer=need(args,'--producer');if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown record-review argument: ${args[0]}`);const request=validateVerificationRequest(raw);
  return withLock(dir,()=>{const report=loadReport(dir);requireTime(report);if(report.policy.mode!=='comprehensive'||report.status!=='running'||!report.findings.some(f=>f.id===request.findingId&&f.evidence==='supported'))throw new CsoError('MISSING_INPUT','Review artifact must target a supported finding in a running comprehensive audit');const artifact=persistableArtifact(makeReviewArtifact(report.runId,request,string(producer,'producer identity',200)),'Repair review artifact');writeJsonExclusive(join(dir,'reviews',`${artifact.id}.json`),artifact);event(report,'repair-review',`Self-attested review artifact ${artifact.id} bound the proposed repair; reviewer independence is not host-verifiable`);saveReport(dir,report);return{reviewArtifactId:artifact.id,reviewAssurance:artifact.assurance,patchHash:artifact.patchHash,requestHash:artifact.requestHash};});
}
function publicPlanArgument(manifest:SnapshotManifest,arg:string,paths:string[]):string{
  for(const path of [...paths].sort((a,b)=>b.length-a.length)){const reference=publicSnapshotPath(manifest,path).path;if(reference===path)continue;if(arg===path)return reference;if(arg===`./${path}`)return `./${reference}`;}
  return arg;
}
function publicTestPlan(manifest:SnapshotManifest,plan:ReturnType<typeof canonicalTestPlan>){return{...plan,commands:plan.commands.map(command=>({...command,args:command.args.map(arg=>publicPlanArgument(manifest,arg,plan.files))})),files:plan.files.map(path=>publicSnapshotPath(manifest,path).path)};}
function publicStartPlan(manifest:SnapshotManifest,plan:ReturnType<typeof canonicalStartPlan>){return{...plan,command:{...plan.command,args:plan.command.args.map(arg=>publicPlanArgument(manifest,arg,plan.entrypointFiles))},entrypointFiles:plan.entrypointFiles.map(path=>publicSnapshotPath(manifest,path).path)};}
function testPlan(args:string[]){const {dir}=run(args);if(args.length!==1||!['node','bun','python','rails'].includes(args[0]))throw new CsoError('INVALID_ARGUMENT','test-plan requires one supported stack');const stack=args[0] as 'node'|'bun'|'python'|'rails',manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);const preparation=inspectPreparation(join(dir,'snapshot'),stack);if(preparation.status!=='ready')throw new CsoError('PREREQUISITE',preparation.prerequisites.map(item=>item.message).join('; ')||`${stack} preparation metadata is incomplete`);return{stack,runtimeProfile:preparation.runtimeProfile,...publicTestPlan(manifest,canonicalTestPlan(join(dir,'snapshot'),stack))};}
function runtimePlan(args:string[]){const {dir}=run(args);if(!args.length||!['node','bun','python','rails'].includes(args[0]))throw new CsoError('INVALID_ARGUMENT','runtime-plan requires one supported stack and --port PORT');const stack=args.shift() as 'node'|'bun'|'python'|'rails',rawPort=need(args,'--port');if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown runtime-plan argument: ${args[0]}`);const port=Number(rawPort);if(!Number.isInteger(port)||port<1024||port>65535)throw new CsoError('INVALID_ARGUMENT','--port must be an integer from 1024 to 65535');const manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);const preparation=inspectPreparation(join(dir,'snapshot'),stack);if(preparation.status!=='ready')throw new CsoError('PREREQUISITE',preparation.prerequisites.map(item=>item.message).join('; ')||`${stack} preparation metadata is incomplete`);return{stack,runtimeProfile:preparation.runtimeProfile,start:publicStartPlan(manifest,canonicalStartPlan(join(dir,'snapshot'),stack,port)),tests:publicTestPlan(manifest,canonicalTestPlan(join(dir,'snapshot'),stack))};}

function platform(): 'linux/amd64'|'linux/arm64'{if(!['linux','darwin'].includes(process.platform)||!['x64','arm64'].includes(process.arch))throw new CsoError('PREREQUISITE','Contained target execution requires a Linux or macOS host with amd64/arm64 Linux Docker images');return process.arch==='arm64'?'linux/arm64':'linux/amd64';}
function watchdog():string{const p=join(dirname(process.execPath),process.platform==='win32'?'gstack-cso-watchdog.exe':'gstack-cso-watchdog');if(!fs.existsSync(p))throw new CsoError('ISOLATION_FAILED','Trusted detached watchdog is missing');return p;}

function closureStateFile(dir:string,findingId:string,phase:'before'|'after',plan:unknown):string{
  return join(dir,'dependency-closures',`${findingId}-${phase}-${sha256(canonical(plan)).slice(0,16)}.json`);
}
function retainClosure(path:string,closure:DependencyClosure):void{
  if(fs.existsSync(path)){if(canonical(readJson(path))!==canonical(closure))throw new CsoError('INCOMPATIBLE_INPUT','Retained dependency closure conflicts with this preparation plan');return;}
  writeJsonExclusive(path,persistableArtifact(closure,'Dependency closure'));
}
function bindArchiveHashes(target:string[],closures:{before:DependencyClosure;after:DependencyClosure}):void{
  const hashes=[...new Set([...closures.before.archives,...closures.after.archives].map(archive=>archive.sha256))].sort();target.splice(0,target.length,...hashes);
}
function preparedVerificationExecutor(options:{dir:string;findingId:string;runtimeProfile:string;stack:'node'|'bun'|'python'|'rails';targetPlatform:'linux/amd64'|'linux/arm64';deadline:number;offline:boolean;runtimeCatalog:RuntimeCatalog;preparation:PreparationExecutor;delegate:VerificationExecutor;beforePlan:ReturnType<typeof inspectPreparation>;beforeAdmission:ReturnType<typeof admitPreparationRuntime>;beforeClosure:DependencyClosure;closures:{before:DependencyClosure;after:DependencyClosure};archiveHashes:string[];proofs:{before:PreparationProof;after:PreparationProof};replay?:{before:DependencyClosure;after:DependencyClosure};persistClosures:boolean;}):VerificationExecutor{
  let beforeProjectToolchainHash:string|undefined;
  return {observe:async(source,phase,request,runtime,verifier,work,control,_execution,testEvidence,witness)=>{
    const plan=phase==='before'?options.beforePlan:inspectPreparation(source,options.stack);
    if(plan.status!=='ready')throw new CsoError('PREREQUISITE',plan.prerequisites.map(item=>item.message).join('; ')||`${options.stack} dependency metadata is not ready`);
    const admission=phase==='before'?options.beforeAdmission:admitPreparationRuntime({plan,platform:options.targetPlatform,profile:options.runtimeProfile,catalog:options.runtimeCatalog});
    if(admission.runtime.id!==runtime.id||admission.runtime.image!==runtime.image)throw new CsoError('INCOMPATIBLE_INPUT','Prepared verification runtime changed between source phases');
    const state=closureStateFile(options.dir,options.findingId,phase,plan),supplied=options.replay?.[phase],retained=!supplied&&fs.existsSync(state)?readJson(state) as DependencyClosure:undefined;
    const closure=phase==='before'?(supplied??options.beforeClosure):await options.preparation.acquire({plan,admission,snapshot:source,deadline:options.deadline,offline:options.offline||Boolean(supplied),existingClosure:supplied??retained});
    options.closures[phase]=closure;
    bindArchiveHashes(options.archiveHashes,options.closures);
    if(options.persistClosures)retainClosure(state,closure);
    let database:RailsDatabaseSelection|undefined;
    if(options.stack==='rails'){
      const selected=plan.database?.selected;
      if(!selected)throw new CsoError('PREREQUISITE','Rails automatic verification could not select one locked database adapter from static test configuration');
      database=selected==='postgresql'?{adapter:'postgresql',sidecar:admitPreparationSidecar({platform:options.targetPlatform,catalog:options.runtimeCatalog})}:{adapter:'sqlite'};
    }
    const prepared=await options.preparation.prepareOffline({plan,admission,snapshot:source,closure,deadline:options.deadline,database});
    try{
      options.proofs[phase]={schemaVersion:1,dependencyClosureHash:prepared.dependencyClosureHash,configurationHash:prepared.configurationHash,
        sourceProjectionHash:prepared.sourceProjectionHash,preparedManifestHash:prepared.preparedManifestHash,preparedDependencyHash:prepared.preparedDependencyHash,receiptHash:prepared.receiptHash,
        executionEnvironmentHash:sha256(canonical(prepared.executionEnvironment)),databaseHash:prepared.databaseHash,
        transformations:prepared.transformations};
      const sourceTests=canonicalTestPlan(source,options.stack),preparedTests=canonicalTestPlan(prepared.preparedRoot,options.stack),
        sourceStart=canonicalStartPlan(source,options.stack,request.port),preparedStart=canonicalStartPlan(prepared.preparedRoot,options.stack,request.port);
      if(sourceTests.signature!==preparedTests.signature||sourceStart.signature!==preparedStart.signature||verificationHarnessHash(request,source)!==verificationHarnessHash(request,prepared.preparedRoot))throw new CsoError('ISOLATION_FAILED','Offline lifecycle execution changed the canonical start, test, or harness inputs');
      if(sourceTests.toolchain==='project'){
        if(phase==='before')beforeProjectToolchainHash=prepared.preparedDependencyHash;
        else if(!beforeProjectToolchainHash||prepared.preparedDependencyHash!==beforeProjectToolchainHash)throw new CsoError('ASSERTION_FAILED','Offline preparation changed the project-installed test toolchain between source phases');
      }
      const protectedPaths=new Set([...request.boundaryFiles,...request.testFiles,...sourceStart.entrypointFiles,...request.changes.map(item=>item.path)]);
      if(prepared.transformations.some(item=>protectedPaths.has(item.path)))throw new CsoError('ISOLATION_FAILED','Synthetic preparation transformation overlaps a security boundary, startup input, or test input');
      return await options.delegate.observe(prepared.preparedRoot,phase,request,runtime,verifier,work,control,
        {environment:prepared.executionEnvironment,database:prepared.database},testEvidence,witness);
    }
    finally{await options.preparation.dispose(prepared);}
  }};
}
async function verify(args:string[],dependencies:CsoCliDependencies){const {dir}=run(args);if(args.length!==1)throw new CsoError('INVALID_ARGUMENT','verify requires one request JSON file');const raw=readInput(args[0]),request=validateVerificationRequest(raw);
  return await withLock(dir,async()=>{const report=loadReport(dir),manifest=readJson(join(dir,'snapshot.json')) as SnapshotManifest;assertSnapshot(dir,manifest);requireTime(report);if(report.policy.mode!=='comprehensive'||report.status!=='running')throw new CsoError('INVALID_SCHEMA','Only a running comprehensive audit can request target execution');const finding=report.findings.find(f=>f.id===request.findingId&&f.evidence==='supported');if(!finding)throw new CsoError('MISSING_INPUT','Verification must target a supported finding in this run');
    if(!request.review.artifactId)throw new CsoError('MISSING_INPUT','Verification requires a separately persisted independent repair-review artifact');const reviewArtifact=validateReviewArtifact(readJson(join(dir,'reviews',`${request.review.artifactId}.json`)),report.runId,request);
    const findingPath=resolveSnapshotPath(manifest,finding.location.path,true,'Finding path').path;if(!request.boundaryFiles.some(path=>resolveSnapshotPath(manifest,path,true,'Boundary path').path===findingPath))throw new CsoError('INVALID_SCHEMA','Boundary files must include the finding location');
    const attempts=report.events.filter(e=>e.kind===`verification-attempt:${finding.id}`).length;if(attempts>=3)throw new CsoError('DEADLINE','Three bounded harness/repair attempts have already been used for this finding');if(report.findings.filter(f=>['runtime_tested','tested'].includes(f.repair)).length>=3)throw new CsoError('INSUFFICIENT_CAPACITY','This run already produced three runtime-tested repairs');
    const targetPlatform=platform();let runtime;try{runtime=selectRuntime(request.runtimeProfile,targetPlatform,dependencies.runtimeCatalog);}catch(error:any){throw new CsoError('PREREQUISITE',error?.message||'Qualified runtime is unavailable');}const verifier=runtime;
    if(!['node','bun','python','rails'].includes(runtime.stack))throw new CsoError('INCOMPATIBLE_INPUT','Application verification requires an application runtime profile');const plan=inspectPreparation(join(dir,'snapshot'),runtime.stack as any);if(plan.status!=='ready')throw new CsoError('PREREQUISITE',plan.prerequisites.map(p=>p.message).join('; ')||'Runtime preparation metadata is incomplete');assertRuntimeCompatible(plan,runtime);writeJson(join(dir,`preparation-${runtime.stack}.json`),plan);
    const endpoint=await dockerEndpoint(secureDirectory(join(dir,'home'))),watchdogPath=dependencies.watchdogPath(),attemptDeadline=Math.min(Date.now()+300_000,Date.parse(report.deadline)-60_000);
    const admission=admitPreparationRuntime({plan,platform:targetPlatform,profile:runtime.id,catalog:dependencies.runtimeCatalog}),staging=secureDirectory(join(dir,'archive-staging')),
      runner=new DockerPreparationSandboxRunner({endpoint,watchdogPath,runRoot:dir,controlRoot:secureDirectory(join(dir,'preparation-execution')),admission}),
      preparation=new PreparationExecutor({cache:new PublicArchiveCache({root:publicArchiveCacheRoot(),stagingRoot:staging}),runner,materializationRoot:secureDirectory(join(dir,'archive-materializations'))});
    const beforeState=closureStateFile(dir,finding.id,'before',plan),retainedBefore=fs.existsSync(beforeState)?readJson(beforeState) as DependencyClosure:undefined;
    const beforeClosure=await preparation.acquire({plan,admission,snapshot:join(dir,'snapshot'),deadline:attemptDeadline,offline:report.policy.offline,existingClosure:retainedBefore});retainClosure(beforeState,beforeClosure);
    const closures={before:beforeClosure,after:beforeClosure},archiveHashes=[...new Set(beforeClosure.archives.map(archive=>archive.sha256))].sort(),proofs={} as {before:PreparationProof;after:PreparationProof},delegate=new DockerVerificationExecutor(endpoint,watchdogPath,attemptDeadline,()=>{event(report,`verification-attempt:${finding.id}`,`Started bounded repair verification attempt ${attempts+1}`);saveReport(dir,report);});
    const executor=preparedVerificationExecutor({dir,findingId:finding.id,runtimeProfile:runtime.id,stack:runtime.stack as 'node'|'bun'|'python'|'rails',targetPlatform,deadline:attemptDeadline,offline:report.policy.offline,runtimeCatalog:dependencies.runtimeCatalog,preparation,delegate,beforePlan:plan,beforeAdmission:admission,beforeClosure,closures,archiveHashes,proofs,persistClosures:true});
    let result:Awaited<ReturnType<typeof verifyRepair>>;try{result=await verifyRepair({runId:report.runId,runDir:dir,manifest,rawRequest:raw,runtime,verifier,policyHash:ISOLATION_POLICY_HASH,auditPolicyHash:sha256(canonical(report.policy)),archives:archiveHashes,dependencyClosures:closures,preparation:proofs,reviewArtifact,executor,watchdogPath,attemptDeadline});}catch(error){if(error instanceof VerificationAttemptError){finding.reproduction=error.attempt.reproduction;finding.repair=error.attempt.repair;finding.reproductionAttemptId=error.attempt.id;event(report,error.attempt.repair==='proposed'?'repair-candidate':'verification-failed',error.attempt.repair==='proposed'?`${error.attempt.id}: external repair assertions passed; helper-authenticated external assertion witness required before certification`:`${error.attempt.id}: ${error.attempt.reproduction}; repair validation failed without issuing a bundle`);saveReport(dir,report);}throw error;}
    finding.reproduction=result.manifest.before.security==='intended_failure'&&result.manifest.before.booted&&result.manifest.before.legitimate?'reproduced':result.manifest.before.security==='pass'?'disproved':result.manifest.before.booted?'inconclusive':'blocked';
    finding.repair=result.manifest.result==='tested'?'tested':result.manifest.result==='runtime_tested'?'runtime_tested':'failed';if(['tested','runtime_tested'].includes(result.manifest.result)){finding.verificationId=result.manifest.id;finding.verificationAssurance={assertions:result.manifest.assertionAssurance!,testCompletion:result.manifest.testCompletionAssurance,review:result.manifest.reviewAssurance};delete finding.reproductionAttemptId;}event(report,'verification',`${result.manifest.id}: ${result.manifest.result}; assertion assurance ${result.manifest.assertionAssurance}; test completion assurance ${result.manifest.testCompletionAssurance}; review assurance ${result.manifest.reviewAssurance}`);saveReport(dir,report);return{result:result.manifest.result,verification:result.manifest,bundle:`bundles/${result.bundle.id}.json`};});}
function replayBundle(stored:{path:string;dir:string},id:string):any{const bundle=validateRepairBundle(readJson(stored.path),id),report=loadReport(stored.dir),finding=report.findings.find(f=>f.verificationId===id&&['tested','runtime_tested'].includes(f.repair));if(!['tested','runtime_tested'].includes(bundle.verification.result)||!finding)throw new CsoError('INCOMPATIBLE_INPUT','Only a helper-recorded runtime-tested or host-reviewed repair bundle can be replayed');return bundle;}
async function withReplayBundle<T>(id:string,deadline:number,fn:(stored:{path:string;dir:string},bundle:any)=>Promise<T>):Promise<T>{
  if(!/^[a-f0-9]{32}$/.test(id))throw new CsoError('INVALID_ARGUMENT','Bundle identifier must be the 32-character ID returned by verify');
  let visited=0,stored:{path:string;dir:string}|undefined;const admit=()=>{if(Date.now()>=deadline)throw new CsoError('DEADLINE','Replay exhausted its five-minute budget while locating the recorded bundle');if(++visited>REPLAY_LOOKUP_MAX_ENTRIES)throw new CsoError('INSUFFICIENT_CAPACITY',`Replay bundle lookup exceeded ${REPLAY_LOOKUP_MAX_ENTRIES} private state entries`);};
  const root=privateRoot(),repos=fs.opendirSync(root);try{let repo:fs.Dirent|null;search:while((repo=repos.readSync())!==null){admit();if(!repo.isDirectory()||!/^[a-f0-9]{24}$/.test(repo.name))continue;const repoDir=join(root,repo.name),runs=fs.opendirSync(repoDir);try{let run:fs.Dirent|null;while((run=runs.readSync())!==null){admit();if(!run.isDirectory()||!/^\d{13}-[a-f0-9]{16}$/.test(run.name))continue;const candidate={dir:join(repoDir,run.name),path:join(repoDir,run.name,'bundles',`${id}.json`)};if(fs.existsSync(candidate.path)){stored=candidate;break search;}}}finally{runs.closeSync();}}}finally{repos.closeSync();}
  if(!stored)throw new CsoError('MISSING_INPUT','Repair bundle was not found or expired');let matched=false,value!:T;await withLock(stored.dir,async()=>{if(!fs.existsSync(stored!.path))return;const bundle=replayBundle(stored!,id);matched=true;value=await fn(stored!,bundle);});if(matched)return value;throw new CsoError('MISSING_INPUT','Repair bundle was not found or expired');
}
function replayManifestValue(manifest:any):unknown{const {id:_,createdAt:__,witnessHash:___,before,after,...stable}=manifest,observation=(value:any)=>{const{output:_,...rest}=value;return rest;};return{...stable,before:observation(before),after:observation(after)};}
async function replay(args:string[],dependencies:CsoCliDependencies){const replayStarted=Date.now(),replayDeadline=replayStarted+300_000;retention(replayStarted,{deadlineMs:replayStarted+RETENTION_MAINTENANCE_MS,maxEntries:RETENTION_MAX_ENTRIES});if(!args.length)throw new CsoError('INVALID_ARGUMENT','replay requires a bundle ID');const id=args.shift()!,source=args.includes('--source')?callerPath(need(args,'--source')):undefined;if(args.length)throw new CsoError('INVALID_ARGUMENT',`Unknown replay argument: ${args[0]}`);return await withReplayBundle(id,replayDeadline,async(stored,bundle)=>{
  if(bundle.requiredInputs.archives?.length&&!bundle.requiredInputs.dependencyClosures)throw new CsoError('MISSING_INPUT','Replay bundle predates retained dependency closures and cannot substitute current dependency state');
  let workDir=stored.dir,manifest:any,temporary:string|undefined;const retained=join(stored.dir,'snapshot');
  try{
    const captureSupplied=async()=>{if(!source)throw new CsoError('MISSING_INPUT','Retained source expired; supply explicitly matching source');const temp=newRun(source);temporary=temp.dir;workDir=temp.dir;manifest=await capture(source,workDir,undefined,undefined,{deadlineMs:replayDeadline});if(manifest.executionHash!==bundle.requiredInputs.sourceHash||manifest.originalHash!==bundle.requiredInputs.originalHash)throw new CsoError('INCOMPATIBLE_INPUT','Supplied source does not match the bundle input hashes');};
    if(fs.existsSync(retained)){manifest=readJson(join(stored.dir,'snapshot.json'));const expiresAt=typeof manifest?.expiresAt==='string'?Date.parse(manifest.expiresAt):Number.NaN;if(!Number.isFinite(expiresAt)||new Date(expiresAt).toISOString()!==manifest.expiresAt)throw new CsoError('INCOMPATIBLE_INPUT','Retained snapshot expiry is invalid');if(expiresAt<=Date.now())await captureSupplied();else assertSnapshot(stored.dir,manifest);}else await captureSupplied();
    if(manifest.executionHash!==bundle.requiredInputs.sourceHash||manifest.originalHash!==bundle.requiredInputs.originalHash)throw new CsoError('INCOMPATIBLE_INPUT','Retained source hashes do not match the bundle');validateRepairBundle(bundle,id,join(workDir,'snapshot'),manifest);if(bundle.verification.policyHash!==ISOLATION_POLICY_HASH)throw new CsoError('INCOMPATIBLE_INPUT','Current helper isolation policy does not match the recorded bundle');const targetPlatform=bundle.requiredInputs.platform as 'linux/amd64'|'linux/arm64';let runtime;try{runtime=selectRuntime(bundle.verification.runtime.profile,targetPlatform,dependencies.runtimeCatalog);}catch(error:any){throw new CsoError('PREREQUISITE',error?.message||'Qualified replay runtime is unavailable');}const verifier=runtime;if(runtime.image!==bundle.requiredInputs.runtimeImage)throw new CsoError('INCOMPATIBLE_INPUT','Qualified runtime digest does not match the bundle');
    const endpoint=await dockerEndpoint(secureDirectory(join(workDir,'home'))),watchdogPath=dependencies.watchdogPath(),attemptDeadline=replayDeadline,delegate=new DockerVerificationExecutor(endpoint,watchdogPath,attemptDeadline);let executor:VerificationExecutor=delegate,archives:string[]=[],dependencyClosures:{before:DependencyClosure;after:DependencyClosure}|undefined,proofs:{before:PreparationProof;after:PreparationProof}|undefined;
    if(bundle.requiredInputs.dependencyClosures){if(!['node','bun','python','rails'].includes(runtime.stack))throw new CsoError('INCOMPATIBLE_INPUT','Replay dependency closure requires an application runtime');const replayClosures=bundle.requiredInputs.dependencyClosures as {before:DependencyClosure;after:DependencyClosure},plan=inspectPreparation(join(workDir,'snapshot'),runtime.stack as any);if(plan.status!=='ready')throw new CsoError('PREREQUISITE',plan.prerequisites.map((item:any)=>item.message).join('; ')||'Replay dependency metadata is not ready');const admission=admitPreparationRuntime({plan,platform:targetPlatform,profile:runtime.id,catalog:dependencies.runtimeCatalog}),runner=new DockerPreparationSandboxRunner({endpoint,watchdogPath,runRoot:workDir,controlRoot:secureDirectory(join(workDir,'preparation-execution')),admission}),preparation=new PreparationExecutor({cache:new PublicArchiveCache({root:publicArchiveCacheRoot(),stagingRoot:secureDirectory(join(workDir,'archive-staging'))}),runner,materializationRoot:secureDirectory(join(workDir,'archive-materializations'))}),beforeClosure=await preparation.acquire({plan,admission,snapshot:join(workDir,'snapshot'),deadline:attemptDeadline,offline:true,existingClosure:replayClosures.before});dependencyClosures={before:beforeClosure,after:replayClosures.after};archives=[...new Set([...beforeClosure.archives,...replayClosures.after.archives].map(archive=>archive.sha256))].sort();proofs={} as {before:PreparationProof;after:PreparationProof};executor=preparedVerificationExecutor({dir:workDir,findingId:bundle.request.findingId,runtimeProfile:runtime.id,stack:runtime.stack as any,targetPlatform,deadline:attemptDeadline,offline:true,runtimeCatalog:dependencies.runtimeCatalog,preparation,delegate,beforePlan:plan,beforeAdmission:admission,beforeClosure,closures:dependencyClosures,archiveHashes:archives,proofs,replay:replayClosures,persistClosures:false});}
    const result=await verifyRepair({runId:bundle.runId,runDir:workDir,manifest,rawRequest:bundle.request,runtime,verifier,policyHash:ISOLATION_POLICY_HASH,auditPolicyHash:bundle.verification.auditPolicyHash,archives,dependencyClosures,preparation:proofs,reviewArtifact:bundle.reviewArtifact,executor,persist:false,watchdogPath,attemptDeadline});if(canonical(replayManifestValue(result.manifest))!==canonical(replayManifestValue(bundle.verification))||assertionWitnessReplayHash(result.bundle.witness!)!==assertionWitnessReplayHash(bundle.witness))throw new CsoError('INCOMPATIBLE_INPUT','Replay changed verification outcomes, preparation, or provenance inputs');const replayId=`${Date.now()}-${randomBytes(8).toString('hex')}`;writeJsonExclusive(join(stored.dir,'replays',`${replayId}.json`),{replayId,bundleId:id,verification:result.manifest,witness:result.bundle.witness});return{bundle:id,result:result.manifest.result,replay:result.manifest,replayId};
  }finally{if(temporary)finalizeReplayTemporary(temporary);}
  });
}

export async function dispatchCsoCommand(command:string,args:string[],dependencies:CsoCliDependencies):Promise<unknown>{
  args=[...args];if(!['start','recheck','replay','doctor','provision-images'].includes(command)){const started=Date.now();retention(started,{deadlineMs:started+RETENTION_MAINTENANCE_MS,maxEntries:RETENTION_MAX_ENTRIES});}
  let result:unknown;
  switch(command){case'start':result=await start(args,dependencies);break;case'doctor':result=await doctor(args,dependencies);break;case'provision-images':result=await provisionImages(args,dependencies);break;case'resume':result=resume(args);break;case'inspect':await inspect(args);return;case'read':await read(args);return;case'history':await history(args);return;case'submit':result=submit(args);break;case'finish':result=finish(args);break;case'import-v2':result=importV2(args);break;case'scan':result=await scanner(args);break;case'scanner-outcome':result=scannerOutcome(args);break;case'import-sarif':result=await scanner(args,true);break;case'record-review':result=recordReview(args);break;case'test-plan':result=testPlan(args);break;case'runtime-plan':result=runtimePlan(args);break;case'recheck':result=await recheck(args,dependencies);break;
    case'verify':result=await verify(args,dependencies);break;case'replay':result=await replay(args,dependencies);break;case'patch-hash':if(args.length!==1)throw new CsoError('INVALID_ARGUMENT','patch-hash requires one request JSON file');result={patchHash:patchHash(validateVerificationRequest(readInput(args[0])))};break;default:throw new CsoError('INVALID_ARGUMENT',`Unknown command: ${command}`);}
  return result;
}
const PRODUCTION_CLI_DEPENDENCIES:CsoCliDependencies=Object.freeze({runtimeCatalog:RUNTIME_CATALOG,scannerCatalog:SCANNER_CATALOG,catalogImageSession:productionCatalogImageSession,watchdogPath:watchdog});
async function main(){const args=process.argv.slice(2),command=args.shift();if(!command||command==='--help'||command==='help'){process.stdout.write(HELP+'\n');return;}if(command==='--version'){emit({version:VERSION,abi:ABI});return;}if(command==='schema'){emit(SCHEMA);return;}if(command==='__cso-assertion-witness'){if(args.length)throw new CsoError('INVALID_ARGUMENT','Assertion witness does not accept command arguments');await runAssertionWitnessChild();return;}const result=await dispatchCsoCommand(command,args,PRODUCTION_CLI_DEPENDENCIES);if(result!==undefined)emit(result);}
if(import.meta.main)main().catch(error=>{const e=error instanceof CsoError?error:new CsoError('INVALID_SCHEMA','The helper rejected an unexpected or unsafe input');try{process.stderr.write(redact(JSON.stringify({ok:false,error:{code:e.code,message:e.message}}))+'\n');}catch{process.stderr.write('{"ok":false,"error":{"code":"REDACTION_FAILED","message":"Error payload withheld"}}\n');}process.exitCode=1;});
