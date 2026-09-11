import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { CsoError } from './contracts';
import { dockerEndpoint, dockerExactImagePresent, dockerProbe, dockerPullExactCatalogImage } from './docker';
import { validateRuntimeCatalog, type RuntimeCatalog, type RuntimePlatform } from './runtime-catalog';
import { validateScannerCatalog, type ScannerCatalog } from './scanner-catalog';
import { secureDirectory } from './state';

export interface QualifiedCatalogImage {
  kind:'runtime'|'scanner';
  id:string;
  image:string;
  platform:RuntimePlatform;
}
export interface CatalogImageSession {
  readonly docker:{endpoint:string;version:string;security:string[]};
  present(entry:QualifiedCatalogImage):Promise<boolean>;
  pull(entry:QualifiedCatalogImage):Promise<void>;
  close():void;
}
/** Keep the automatic preload stage within the advertised setup-time budget. */
export const CATALOG_IMAGE_PROVISIONING_BUDGET_MS=30_000;
export type CatalogImageSessionFactory=(deadline:number)=>Promise<CatalogImageSession>;
export interface CatalogImageAvailability extends QualifiedCatalogImage {
  status:'available'|'unavailable';
  reason?:string;
}
export interface CatalogImageInspection {
  docker:{status:'ready'|'missing';detail:unknown};
  images:CatalogImageAvailability[];
}
export interface CatalogImageProvisionResult {
  schemaVersion:1;
  status:'complete'|'partial'|'not_available';
  downloads:true;
  platform:RuntimePlatform;
  requested:number;
  inspected:number;
  alreadyPresent:number;
  downloaded:number;
  deadlineReached:boolean;
  unavailable:CatalogImageAvailability[];
  summary:string;
}

export function qualifiedCatalogImages(runtimeCatalog:RuntimeCatalog,scannerCatalog:ScannerCatalog,platform:RuntimePlatform):QualifiedCatalogImage[]{
  validateRuntimeCatalog(runtimeCatalog);validateScannerCatalog(scannerCatalog);
  const entries:QualifiedCatalogImage[]=[
    ...runtimeCatalog.runtimes.filter(item=>item.platform===platform).map(item=>({kind:'runtime' as const,id:item.id,image:item.image,platform:item.platform})),
    ...scannerCatalog.scanners.filter(item=>item.platform===platform).map(item=>({kind:'scanner' as const,id:item.id,image:item.image,platform:item.platform})),
  ];
  const identities=new Set<string>();
  for(const entry of entries){
    const identity=`${entry.kind}:${entry.id}`;
    if(identities.has(identity))throw new CsoError('INCOMPATIBLE_INPUT','Qualified image catalogs contain a duplicate identity');
    identities.add(identity);
  }
  return entries.sort((left,right)=>`${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function controlledReason(error:unknown,fallback:string):string{
  return error instanceof CsoError?error.message:fallback;
}
export async function inspectCatalogImages(entries:QualifiedCatalogImage[],open:CatalogImageSessionFactory,deadline=Date.now()+CATALOG_IMAGE_PROVISIONING_BUDGET_MS):Promise<CatalogImageInspection>{
  let session:CatalogImageSession;
  try{session=await open(deadline);}catch(error){
    const detail=controlledReason(error,'Local Docker is unavailable for exact catalog image inspection');
    return{docker:{status:'missing',detail},images:entries.map(entry=>({...entry,status:'unavailable',reason:detail}))};
  }
  try{
    // Read-only daemon lookups run together so doctor remains within its
    // 30-second contract even when a local Docker client is slow to fail.
    const images=await Promise.all(entries.map(async(entry):Promise<CatalogImageAvailability>=>{
      try{const present=await session.present(entry);if(Date.now()>=deadline)throw new CsoError('DEADLINE','Exact image inspection reached the aggregate image-provisioning deadline');return{...entry,status:present?'available':'unavailable',...(present?{}:{reason:'Exact qualified image is not present in the local Docker daemon'})};}
      catch(error){return{...entry,status:'unavailable',reason:controlledReason(error,'Exact qualified image could not be inspected safely')};}
    }));
    return{docker:{status:'ready',detail:session.docker},images};
  }finally{session.close();}
}

export async function provisionCatalogImages(entries:QualifiedCatalogImage[],platform:RuntimePlatform,open:CatalogImageSessionFactory,deadline=Date.now()+CATALOG_IMAGE_PROVISIONING_BUDGET_MS):Promise<CatalogImageProvisionResult>{
  if(!entries.length)return{schemaVersion:1,status:'complete',downloads:true,platform,requested:0,inspected:0,alreadyPresent:0,downloaded:0,deadlineReached:false,unavailable:[],summary:'No qualified CSO images are published for this platform; static audits remain available.'};
  const deadlineReason='The 30-second aggregate CSO image preload deadline was reached';
  if(Date.now()>=deadline){const unavailable=entries.map(entry=>({...entry,status:'unavailable' as const,reason:deadlineReason}));return{schemaVersion:1,status:'partial',downloads:true,platform,requested:entries.length,inspected:0,alreadyPresent:0,downloaded:0,deadlineReached:true,unavailable,summary:`Qualified CSO image preload partial: 0/${entries.length} available; ${deadlineReason.toLowerCase()}. Rerun setup to continue.`};}
  let session:CatalogImageSession;
  try{session=await open(deadline);}catch(error){
    const reason=controlledReason(error,'Local Docker is unavailable for qualified image provisioning'),unavailable=entries.map(entry=>({...entry,status:'unavailable' as const,reason}));
    const deadlineReached=error instanceof CsoError&&error.code==='DEADLINE';
    return{schemaVersion:1,status:deadlineReached?'partial':'not_available',downloads:true,platform,requested:entries.length,inspected:0,alreadyPresent:0,downloaded:0,deadlineReached,unavailable,summary:deadlineReached?`Qualified CSO image preload partial: 0/${entries.length} available; ${reason}. Rerun setup to continue.`:`Qualified CSO images were not preloaded: ${reason}. Rerun setup after the prerequisite is available.`};
  }
  let inspected=0,alreadyPresent=0,downloaded=0,pullBlocked='',deadlineReached=false;const unavailable:CatalogImageAvailability[]=[];
  try{
    for(let index=0;index<entries.length;index++){
      const entry=entries[index];
      if(Date.now()>=deadline){deadlineReached=true;for(const remaining of entries.slice(index))unavailable.push({...remaining,status:'unavailable',reason:deadlineReason});break;}
      let present=false;
      try{
        present=await session.present(entry);if(Date.now()>=deadline)throw new CsoError('DEADLINE','Exact image inspection reached the aggregate image-provisioning deadline');inspected++;
        if(present){alreadyPresent++;continue;}
      }catch(error){
        if(error instanceof CsoError&&error.code==='DEADLINE'){deadlineReached=true;unavailable.push({...entry,status:'unavailable',reason:error.message});for(const remaining of entries.slice(index+1))unavailable.push({...remaining,status:'unavailable',reason:deadlineReason});break;}
        unavailable.push({...entry,status:'unavailable',reason:controlledReason(error,'Exact qualified image could not be inspected safely')});continue;
      }
      // A registry failure blocks further network attempts, but read-only local
      // inspection continues so the setup summary never calls a cached digest
      // unavailable merely because it sorts after the failed pull.
      if(pullBlocked){unavailable.push({...entry,status:'unavailable',reason:`Network provisioning stopped after an anonymous registry prerequisite failed: ${pullBlocked}`});continue;}
      if(Date.now()>=deadline){deadlineReached=true;unavailable.push({...entry,status:'unavailable',reason:deadlineReason});for(const remaining of entries.slice(index+1))unavailable.push({...remaining,status:'unavailable',reason:deadlineReason});break;}
      try{await session.pull(entry);if(Date.now()>=deadline)throw new CsoError('DEADLINE','Qualified image pull reached the 30-second aggregate preload deadline');downloaded++;}
      catch(error){pullBlocked=controlledReason(error,'Qualified image provisioning failed');deadlineReached=error instanceof CsoError&&error.code==='DEADLINE';unavailable.push({...entry,status:'unavailable',reason:pullBlocked});}
    }
  }finally{session.close();}
  const status=deadlineReached?'partial':unavailable.length?(alreadyPresent||downloaded?'partial':'not_available'):'complete';
  const summary=deadlineReached
    ?`Qualified CSO image preload partial: ${alreadyPresent+downloaded}/${entries.length} available; inspected ${inspected}/${entries.length}; the 30-second aggregate deadline was reached. Rerun setup to continue.`
    :unavailable.length
    ?`Qualified CSO image preload ${status}: ${alreadyPresent+downloaded}/${entries.length} available; inspected ${inspected}/${entries.length}; ${unavailable.length} require local Docker and anonymous public registry access. Rerun setup after the prerequisite is available.`
    :`Qualified CSO images ready: ${entries.length} available (${downloaded} downloaded, ${alreadyPresent} already local).`;
  return{schemaVersion:1,status,downloads:true,platform,requested:entries.length,inspected,alreadyPresent,downloaded,deadlineReached,unavailable,summary};
}

export async function openLocalCatalogImageSession(env:Record<string,string|undefined>=process.env,deadline=Date.now()+CATALOG_IMAGE_PROVISIONING_BUDGET_MS):Promise<CatalogImageSession>{
  let home='';
  try{
    home=secureDirectory(fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()),'gstack-cso-images-')));
    const endpoint=await dockerEndpoint(home,env,deadline),config=secureDirectory(join(home,'docker-config'));
    // dockerEnvironment pins both HOME and DOCKER_CONFIG here. An explicit
    // empty auth map prevents inherited credential stores/helpers from being
    // consulted during installation-time public pulls.
    fs.writeFileSync(join(config,'config.json'),'{"auths":{}}\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    const probe=await dockerProbe(endpoint,home,deadline),docker={endpoint:endpoint.uri,...probe};
    let closed=false;
    return{
      docker,
      present:entry=>{if(closed)throw new CsoError('ISOLATION_FAILED','Catalog image session is closed');return dockerExactImagePresent(endpoint,home,entry.image,entry.platform,deadline);},
      pull:entry=>{if(closed)throw new CsoError('ISOLATION_FAILED','Catalog image session is closed');return dockerPullExactCatalogImage(endpoint,home,entry.image,entry.platform,deadline);},
      close:()=>{if(closed)return;closed=true;fs.rmSync(home,{recursive:true,force:true});},
    };
  }catch(error){if(home)fs.rmSync(home,{recursive:true,force:true});throw error;}
}
