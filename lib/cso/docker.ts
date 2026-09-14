import * as fs from 'node:fs';
import { join } from 'node:path';
import { canonical, CsoError, MAX_OUTPUT, sha256 } from './contracts';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { GROUP_LIMITS, Role, ROLE_LIMITS, Lease, admit, markSupervised, release, total } from './admission';
import { childEnvironment, executable, runProcess } from './process';
import { secureDirectory } from './state';
export const CONTAINER_SHM_BYTES=8*1024*1024;
export const ISOLATION_POLICY_HASH=sha256(canonical({version:'cso-isolation-v1',network:'none-shared-loopback',root:'readonly',capabilities:'drop-all',privilegeEscalation:false,seccomp:'builtin',pull:'never',logging:'none',limits:GROUP_LIMITS,roles:ROLE_LIMITS,shmBytes:CONTAINER_SHM_BYTES,maxOutput:MAX_OUTPUT}));

export interface DockerEndpoint { uri: string; socket: string; executable: string; device:number; inode:number }
function dockerTimeout(deadline:number|undefined,maximum:number):number{
  if(deadline===undefined)return maximum;const remaining=deadline-Date.now();
  if(remaining<=0)throw new CsoError('DEADLINE','Docker operation reached its aggregate deadline');
  return Math.max(1,Math.min(maximum,remaining));
}
function deadlineExpired(deadline:number|undefined):boolean{return deadline!==undefined&&Date.now()>=deadline;}
export async function dockerEndpoint(home: string, env: Record<string,string|undefined> = process.env, deadline?:number): Promise<DockerEndpoint> {
  const docker = executable('docker');
  const requestedHost = env.DOCKER_HOST;
  if (requestedHost && !requestedHost.startsWith('unix:///')) throw new CsoError('ISOLATION_FAILED','Remote TCP, HTTP, SSH, and TLS Docker endpoints are refused');
  let uri = requestedHost;
  if (!uri) {
    const config = env.DOCKER_CONFIG || (env.HOME ? join(env.HOME,'.docker') : '');
    if (config && (!config.startsWith('/') || config.includes('\0') || config.split('/').includes('..'))) throw new CsoError('ISOLATION_FAILED','Docker config must be an absolute host path');
    const inspectEnv = {...childEnvironment(home),HOME:env.HOME || home,...(config?{DOCKER_CONFIG:config}:{})};
    let context = env.DOCKER_CONTEXT;
    if (!context) {
      const shown = await runProcess(docker,['context','show'],{cwd:home,env:inspectEnv,raw:true,timeoutMs:dockerTimeout(deadline,5000),maxBytes:8192});
      if(deadlineExpired(deadline))throw new CsoError('DEADLINE','Docker context discovery reached the aggregate image-provisioning deadline');
      if (shown.code || shown.timedOut || shown.truncated) throw new CsoError('ISOLATION_FAILED','Effective Docker context could not be determined');
      context = shown.stdout.trim();
    }
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(context)) throw new CsoError('ISOLATION_FAILED','Invalid Docker context name');
    const result = await runProcess(docker,['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'],{cwd:home,env:inspectEnv,raw:true,timeoutMs:dockerTimeout(deadline,5000),maxBytes:8192});
    if(deadlineExpired(deadline))throw new CsoError('DEADLINE','Docker context inspection reached the aggregate image-provisioning deadline');
    if (result.code || result.timedOut || result.truncated) throw new CsoError('ISOLATION_FAILED','Docker context could not be inspected without target execution');
    try { uri = JSON.parse(result.stdout.trim()); } catch { throw new CsoError('ISOLATION_FAILED','Docker context returned invalid endpoint data'); }
  }
  if (typeof uri !== 'string' || !uri.startsWith('unix:///') || uri.includes('\0') || uri.includes('..')) throw new CsoError('ISOLATION_FAILED','Only a local absolute Unix Docker socket is supported');
  const requestedSocket = uri.slice('unix://'.length);let socket='';try{socket=fs.realpathSync(requestedSocket);}catch{throw new CsoError('ISOLATION_FAILED','Pinned local Docker socket is unavailable');}
  let s: fs.Stats; try { s=fs.statSync(socket); } catch { throw new CsoError('ISOLATION_FAILED','Pinned local Docker socket is unavailable'); }
  if (!s.isSocket()) throw new CsoError('ISOLATION_FAILED','Docker endpoint is not a local Unix socket');
  if(deadlineExpired(deadline))throw new CsoError('DEADLINE','Docker endpoint admission reached the aggregate image-provisioning deadline');
  return {uri:`unix://${socket}`,socket,executable:docker,device:s.dev,inode:s.ino};
}
function assertEndpoint(endpoint:DockerEndpoint):void{let s:fs.Stats;try{s=fs.statSync(endpoint.socket);}catch{throw new CsoError('ISOLATION_FAILED','Pinned Docker socket disappeared');}if(!s.isSocket()||s.dev!==endpoint.device||s.ino!==endpoint.inode)throw new CsoError('ISOLATION_FAILED','Pinned Docker socket identity changed');}
const EXACT_CATALOG_IMAGE=/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
function assertExactCatalogImage(image:string):void{
  if(!EXACT_CATALOG_IMAGE.test(image)||image.includes('..')||image.includes('//'))throw new CsoError('INCOMPATIBLE_INPUT','Catalog image must name a fully qualified registry repository at an exact sha256 digest');
}
export function dockerEnvironment(endpoint: DockerEndpoint, config: string): Record<string,string> {
  return {...childEnvironment(config),HOME:config,DOCKER_CONFIG:config,DOCKER_HOST:endpoint.uri,DOCKER_CONTEXT:'',DOCKER_TLS_VERIFY:'',DOCKER_CERT_PATH:''};
}
export function linuxCgroupAdmission(procCgroup='/proc/self/cgroup',cgroupRoot='/sys/fs/cgroup'):string[]{
  if(process.platform!=='linux')return ['cpu','memory','pids'];
  let line='';try{line=fs.readFileSync(procCgroup,'utf8').split('\n').find(x=>x.startsWith('0::'))??'';}catch{return[];}
  if(line){const rel=line.slice(3).replace(/^\//,''),dir=join(cgroupRoot,rel),file=join(dir,'cgroup.controllers');try{return fs.readFileSync(file,'utf8').trim().split(/\s+/).filter(Boolean);}catch{return[];}}
  // Legacy cgroup v1: each independently mounted controller is sufficient.
  return ['cpu','memory','pids'].filter(controller=>fs.existsSync(join(cgroupRoot,controller)));
}
export async function dockerProbe(endpoint: DockerEndpoint, home: string, deadline?:number): Promise<{version:string;security:string[]}> {
  assertEndpoint(endpoint);
  const config=secureDirectory(join(home,'docker-config'));
  const r=await runProcess(endpoint.executable,['info','--format','{{json .}}'],{cwd:home,env:dockerEnvironment(endpoint,config),raw:true,timeoutMs:dockerTimeout(deadline,10_000),maxBytes:128*1024});
  if(deadlineExpired(deadline))throw new CsoError('DEADLINE','Docker capability inspection reached the aggregate image-provisioning deadline');
  if (r.code || r.timedOut || r.truncated) throw new CsoError('ISOLATION_FAILED','Local Docker daemon is not usable');
  let v:any; try {v=JSON.parse(r.stdout);} catch {throw new CsoError('ISOLATION_FAILED','Docker returned invalid capability data');}
  const security=Array.isArray(v.SecurityOptions)?v.SecurityOptions:[];
  if (!v.ServerVersion || !v.MemoryLimit || !v.CpuCfsQuota || !v.PidsLimit || !security.some((x:string)=>x.includes('seccomp')))
    throw new CsoError('ISOLATION_FAILED','Docker lacks required memory, CPU, PID, or seccomp enforcement');
  const delegated=linuxCgroupAdmission();if(!['cpu','memory','pids'].every(x=>delegated.includes(x)))throw new CsoError('ISOLATION_FAILED','Linux host has not delegated CPU, memory, and PID controllers to this helper; target execution is blocked');
  if (v.LoggingDriver && typeof v.LoggingDriver !== 'string') throw new CsoError('ISOLATION_FAILED','Docker logging capability is invalid');
  return {version:v.ServerVersion,security};
}
/** Read-only local image admission probe. Docker image inspect never pulls. */
export async function dockerExactImagePresent(endpoint:DockerEndpoint,home:string,image:string,platform:'linux/amd64'|'linux/arm64',deadline?:number):Promise<boolean>{
  assertExactCatalogImage(image);assertEndpoint(endpoint);
  const config=secureDirectory(join(home,'docker-config'));
  const result=await runProcess(endpoint.executable,['image','inspect','--format','{{json .}}',image],{
    cwd:home,env:dockerEnvironment(endpoint,config),raw:true,timeoutMs:dockerTimeout(deadline,5_000),maxBytes:128*1024,
  });
  assertEndpoint(endpoint);
  if(deadlineExpired(deadline)||result.timedOut)throw new CsoError('DEADLINE','Exact image inspection reached its bounded image-provisioning deadline');
  if(result.code||result.truncated)return false;
  let inspected:any;try{inspected=JSON.parse(result.stdout);}catch{return false;}
  const expectedArch=platform==='linux/arm64'?'arm64':'amd64';
  return inspected?.Os==='linux'&&inspected?.Architecture===expectedArch&&
    typeof inspected?.Id==='string'&&/^sha256:[a-f0-9]{64}$/.test(inspected.Id)&&
    Array.isArray(inspected?.RepoDigests)&&inspected.RepoDigests.includes(image)&&
    canonical(inspected?.Config?.Entrypoint)===canonical(['/opt/cso/entrypoint'])&&
    (!inspected?.Config?.Volumes||Object.keys(inspected.Config.Volumes).length===0);
}
/** Installation-only acquisition. Audits never call this and still use --pull=never. */
export async function dockerPullExactCatalogImage(endpoint:DockerEndpoint,home:string,image:string,platform:'linux/amd64'|'linux/arm64',deadline?:number):Promise<void>{
  assertExactCatalogImage(image);assertEndpoint(endpoint);
  const config=secureDirectory(join(home,'docker-config'));
  const result=await runProcess(endpoint.executable,['pull','--quiet','--platform',platform,image],{
    cwd:home,env:dockerEnvironment(endpoint,config),timeoutMs:dockerTimeout(deadline,300_000),maxBytes:128*1024,
  });
  assertEndpoint(endpoint);
  if(deadlineExpired(deadline)||result.timedOut)throw new CsoError('DEADLINE','Qualified image pull reached its bounded preload deadline');
  if(result.code||result.truncated)throw new CsoError('PREREQUISITE','Anonymous pull of a qualified CSO image failed; allow public registry access and rerun setup');
  if(!await dockerExactImagePresent(endpoint,home,image,platform,deadline))throw new CsoError('INCOMPATIBLE_INPUT','Docker did not retain the exact qualified image digest and platform after acquisition');
}
export interface ContainerSpec {
  role: Role; image: string; source?: string; command: string[]; env?: Record<string,string>;
  readonlyFiles?: {host:string;container:string}[];
  readonlyDirectories?: {host:string;container:'/fixtures'}[];
  /** Preparation-only mounts. Every destination is fixed by the helper. */
  readonlyMetadata?: string;
  readonlyInputMetadata?: string;
  metadataTmpfsBytes?: number;
  archiveTmpfsBytes?: number;
  /** Explicit preparation layouts replace the role defaults but stay within group admission. */
  workTmpfsBytes?: number;
  temporaryTmpfsBytes?: number;
  readonlyArchiveDirectory?: string;
  registrySocket?: string;
  /** Non-secret, fixed-user-readable PostgreSQL database-name policy. */
  postgresDatabasePolicy?: string;
}
export function writableAllocation(role:Role,spec:Pick<ContainerSpec,'temporaryTmpfsBytes'|'workTmpfsBytes'|'metadataTmpfsBytes'|'archiveTmpfsBytes'>={}):{temporaryBytes:number;workBytes:number;shmBytes:number;totalBytes:number}{
  const l=ROLE_LIMITS[role],mib=1024*1024,shmMiB=CONTAINER_SHM_BYTES/mib,
    defaultTmpMiB=Math.min(256,Math.max(1,l.writableMiB-shmMiB-1)),
    bounded=(value:number|undefined,fallback:number,label:string)=>{const selected=value??fallback;if(!Number.isSafeInteger(selected)||selected<=0||selected>GROUP_LIMITS.writableMiB*mib)throw new CsoError('INVALID_SCHEMA',`${label} tmpfs size is outside the aggregate writable-storage policy`);return selected;},
    temporaryBytes=bounded(spec.temporaryTmpfsBytes,defaultTmpMiB*mib,'Temporary'),
    workBytes=bounded(spec.workTmpfsBytes,(l.writableMiB-defaultTmpMiB-shmMiB)*mib,'Work'),
    extra=(spec.metadataTmpfsBytes??0)+(spec.archiveTmpfsBytes??0),totalBytes=temporaryBytes+workBytes+CONTAINER_SHM_BYTES+extra;
  if(!Number.isSafeInteger(totalBytes)||totalBytes<=0)throw new CsoError('INVALID_SCHEMA','Writable mount sizes are outside the aggregate writable-storage policy');
  return{temporaryBytes,workBytes,shmBytes:CONTAINER_SHM_BYTES,totalBytes};
}
export function validatePostgresDatabasePolicy(path:string):string[]{
  const stat=fs.lstatSync(path),real=fs.realpathSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>4096||(stat.mode&0o777)!==0o444||real.includes(','))throw new CsoError('UNSAFE_PATH','PostgreSQL database policy must be one public-readable, immutable synthetic file');
  const body=fs.readFileSync(real,'utf8');if(!body.endsWith('\n')||body.includes('\0')||body.includes('\r'))throw new CsoError('INVALID_SCHEMA','PostgreSQL database policy framing is invalid');
  const names=body.slice(0,-1).split('\n');if(!names.length||names.length>64||new Set(names).size!==names.length||names.some(name=>!/^cso_[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)))throw new CsoError('INVALID_SCHEMA','PostgreSQL database policy contains an invalid or duplicate database name');
  return names;
}
export function validateSingleContainerProcessOutput(output:string):void{
  const lines=output.split('\n').map(line=>line.trim()).filter(Boolean);
  if(lines.length!==2||!/^PID$/i.test(lines[0])||!/^\d+$/.test(lines[1]))throw new CsoError('ISOLATION_FAILED','Offline lifecycle left a background process; prepared output was withheld');
}
export class DockerGroup {
  private ids: {role:Role;id:string}[]=[]; private roles:Role[]=['anchor']; private writableBytesById=new Map<string,number>(); private lease:Lease; private config:string; private admittedImages=new Set<string>(); private remainingOutput=MAX_OUTPUT;
  anchor='';
  private constructor(public endpoint:DockerEndpoint, public runId:string, public dir:string, public deadline:number, lease:Lease) {
    this.lease=lease; this.config=secureDirectory(join(dir,'docker-config'));
  }
  static async create(endpoint:DockerEndpoint,runId:string,dir:string,deadline:number,anchorImage:string,watchdogPath?:string):Promise<DockerGroup>{
    if(!/^[A-Za-z0-9_.-]{1,100}$/.test(runId))throw new CsoError('INVALID_ARGUMENT','Reproduction group label is invalid');
    await dockerProbe(endpoint,dir); const group=new DockerGroup(endpoint,runId,dir,deadline,admit(endpoint.uri,runId,deadline));
    try { await group.launchWatchdog(watchdogPath); group.anchor=await group.createContainer({role:'anchor',image:anchorImage,command:['/bin/sleep','2147483647']},false); await group.docker(['start',group.anchor]); return group; }
    catch(e){await group.cleanup();throw e;}
  }
  private async launchWatchdog(explicit?:string):Promise<void>{
    const watchdog=explicit??join(dirname(process.execPath),'gstack-cso-watchdog');
    if(!fs.existsSync(watchdog)||fs.lstatSync(watchdog).isSymbolicLink())throw new CsoError('ISOLATION_FAILED','Independent watchdog is missing from the trusted helper distribution');
    const ready=join(this.dir,'watchdog.ready');try{fs.unlinkSync(ready);}catch{}
    let spawnFailed=false;
    const child=spawn(watchdog,['--owner',String(process.pid),'--deadline',String(Math.ceil(this.deadline/1000)),'--run-dir',this.dir,'--docker',this.endpoint.executable,'--endpoint',this.endpoint.uri,'--socket-device',String(this.endpoint.device),'--socket-inode',String(this.endpoint.inode),'--run-label',this.runId,'--lease-path',this.lease.path,'--lease-token',this.lease.token],{cwd:this.dir,env:{PATH:'/usr/bin:/bin'},detached:true,stdio:'ignore'});
    child.once('error',()=>{spawnFailed=true;});child.unref();
    for(let i=0;i<100&&!spawnFailed&&!fs.existsSync(ready);i++)await new Promise(resolve=>setTimeout(resolve,10));
    let alive=false;try{if(child.pid){process.kill(child.pid,0);alive=true;}}catch{}
    if(spawnFailed||!fs.existsSync(ready)||!alive){try{if(child.pid)process.kill(child.pid,'SIGKILL');}catch{}throw new CsoError('ISOLATION_FAILED','Independent watchdog failed its startup handshake');}
    markSupervised(this.lease);
    fs.writeFileSync(join(this.dir,'watchdog.pid'),String(child.pid)+'\n',{mode:0o600});
  }
  private async docker(args:string[],max=128*1024){
    assertEndpoint(this.endpoint);
    const remaining=Math.max(1,Math.min(300_000,this.deadline-Date.now()));
    const r=await runProcess(this.endpoint.executable,args,{cwd:this.dir,env:dockerEnvironment(this.endpoint,this.config),raw:true,timeoutMs:remaining,maxBytes:max});
    if(r.timedOut)throw new CsoError('DEADLINE','Docker operation exceeded the reproduction deadline');
    if(r.truncated)throw new CsoError('REDACTION_FAILED','Docker output exceeded the bounded capture limit and was withheld');
    if(r.code)throw new CsoError('ISOLATION_FAILED',`Docker operation failed (${args[0]}): ${r.stderr.slice(0,200)}`);
    return r.stdout.trim();
  }
  private async admitLocalImage(image:string):Promise<void>{
    if(this.admittedImages.has(image))return;
    let raw='';try{raw=await this.docker(['image','inspect','--format','{{json .}}',image],128*1024);}catch{throw new CsoError('MISSING_INPUT',`Pinned runtime image is not already present locally: ${image}`);}
    let inspected:any;try{inspected=JSON.parse(raw);}catch{throw new CsoError('ISOLATION_FAILED','Local image metadata is invalid');}
    const expectedArch=process.arch==='arm64'?'arm64':'amd64',digest=image.slice(image.lastIndexOf('sha256:'));
    if(inspected.Os!=='linux'||inspected.Architecture!==expectedArch||typeof inspected.Id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(inspected.Id)||canonical(inspected.Config?.Entrypoint)!==canonical(['/opt/cso/entrypoint']))throw new CsoError('INCOMPATIBLE_INPUT','Pinned runtime image does not match the admitted Linux platform and fixed entrypoint');
    if(inspected.Config?.Volumes&&Object.keys(inspected.Config.Volumes).length)throw new CsoError('INCOMPATIBLE_INPUT','Pinned runtime image declares writable volumes outside the bounded storage policy');
    if(image.startsWith('sha256:')){if(inspected.Id!==image)throw new CsoError('INCOMPATIBLE_INPUT','Local image ID does not match the requested digest');}
    else if(!Array.isArray(inspected.RepoDigests)||!inspected.RepoDigests.includes(image))throw new CsoError('INCOMPATIBLE_INPUT',`Local image metadata does not bind the requested repository digest ${digest}`);
    this.admittedImages.add(image);
  }
  async createContainer(spec:ContainerSpec,joinAnchor=true):Promise<string>{
    if(!/^(?:[-./:@a-zA-Z0-9_]+@)?sha256:[a-f0-9]{64}$/.test(spec.image))throw new CsoError('INCOMPATIBLE_INPUT','Container image must use an immutable sha256 digest');
    if(!spec.command.length||!spec.command[0].startsWith('/'))throw new CsoError('INVALID_SCHEMA','Container command needs an absolute executable');
    await this.admitLocalImage(spec.image);
    if(spec.role!=='anchor')total([...this.roles,spec.role]);
    const l=ROLE_LIMITS[spec.role],mib=1024*1024,
      allocation=writableAllocation(spec.role,spec),tmpBytes=allocation.temporaryBytes,workBytes=allocation.workBytes,candidateWritable=allocation.totalBytes;
    if(!Number.isSafeInteger(candidateWritable)||candidateWritable<=0||[...this.writableBytesById.values()].reduce((sum,value)=>sum+value,0)+candidateWritable>GROUP_LIMITS.writableMiB*mib)
      throw new CsoError('INSUFFICIENT_CAPACITY','Requested tmpfs mounts exceed the aggregate reproduction-group writable-storage limit');
    const memoryReserve=Math.min(256*mib,Math.max(16*mib,Math.floor(l.memoryMiB*mib/8)));
    if(candidateWritable>l.memoryMiB*mib-memoryReserve)throw new CsoError('INSUFFICIENT_CAPACITY','Requested tmpfs mounts leave insufficient admitted memory for the container process');
    const hostUid=process.getuid?.(),hostGid=process.getgid?.();if(!Number.isInteger(hostUid)||!Number.isInteger(hostGid)||(hostUid as number)<=0||(hostGid as number)<0)throw new CsoError('ISOLATION_FAILED','Target execution requires a non-root host identity for readable private bind mounts');
    const uid=spec.role==='postgres'?10001:hostUid as number,gid=spec.role==='postgres'?10001:hostGid as number;
    const args=['create','--pull=never','--label',`com.gstack.cso.run=${this.runId}`,'--label',`com.gstack.cso.role=${spec.role}`,'--log-driver=none',
      '--read-only','--user',`${uid}:${gid}`,'--cap-drop','ALL','--security-opt','no-new-privileges:true','--security-opt','seccomp=builtin',
      '--cpus',String(l.cpu),'--memory',`${l.memoryMiB}m`,'--memory-swap',`${l.memoryMiB}m`,'--pids-limit',String(l.pids),
      '--shm-size',`${CONTAINER_SHM_BYTES}b`,
      '--tmpfs',`/tmp:rw,noexec,nosuid,nodev,size=${tmpBytes},mode=1777`,
      '--tmpfs',`/work:rw,nosuid,nodev,size=${workBytes},mode=700,uid=${uid},gid=${gid}`,
      '--network',joinAnchor?`container:${this.anchor}`:'none','--platform',process.arch==='arm64'?'linux/arm64':'linux/amd64'];
    const expectedTmpfs=new Set(['/tmp','/work']),expectedMounts=new Set<string>();
    for(const [k,v] of Object.entries(spec.env??{})){if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)||v.includes('\0'))throw new CsoError('INVALID_SCHEMA','Invalid explicit container environment');args.push('--env',`${k}=${v}`);}
    if(spec.source){const stat=fs.lstatSync(spec.source),real=fs.realpathSync(spec.source);if(!stat.isDirectory()||stat.isSymbolicLink()||real.includes(','))throw new CsoError('UNSAFE_PATH','Execution source must be one unambiguous private directory');args.push('--mount',`type=bind,src=${real},dst=/source,readonly,bind-nonrecursive`);expectedMounts.add('/source');}
    for(const f of spec.readonlyFiles??[]){const stat=fs.lstatSync(f.host),real=fs.realpathSync(f.host);if(!stat.isFile()||stat.isSymbolicLink()||real.includes(',')||!f.container.startsWith('/policy/'))throw new CsoError('UNSAFE_PATH','Trusted policy mounts must be regular files under /policy');args.push('--mount',`type=bind,src=${real},dst=${f.container},readonly,bind-nonrecursive`);expectedMounts.add(f.container);}
    if(spec.postgresDatabasePolicy){if(spec.role!=='postgres')throw new CsoError('INVALID_SCHEMA','PostgreSQL database policy can only be mounted into the fixed database role');validatePostgresDatabasePolicy(spec.postgresDatabasePolicy);args.push('--mount',`type=bind,src=${fs.realpathSync(spec.postgresDatabasePolicy)},dst=/policy/postgresql.databases,readonly,bind-nonrecursive`);expectedMounts.add('/policy/postgresql.databases');}
    for(const d of spec.readonlyDirectories??[]){const stat=fs.lstatSync(d.host),real=fs.realpathSync(d.host);if(!stat.isDirectory()||stat.isSymbolicLink()||real.includes(',')||d.container!=='/fixtures')throw new CsoError('UNSAFE_PATH','Fixture mounts must be private directories at /fixtures');args.push('--mount',`type=bind,src=${real},dst=${d.container},readonly,bind-nonrecursive`);expectedMounts.add(d.container);}
    if(Boolean(spec.readonlyArchiveDirectory)&&Boolean(spec.archiveTmpfsBytes))throw new CsoError('INVALID_SCHEMA','Preparation requires exactly one archive storage policy');
    if(Boolean(spec.readonlyMetadata)&&Boolean(spec.metadataTmpfsBytes))throw new CsoError('INVALID_SCHEMA','Preparation requires exactly one metadata storage policy');
    if(Boolean(spec.readonlyInputMetadata)!==Boolean(spec.metadataTmpfsBytes))throw new CsoError('INVALID_SCHEMA','Writable metadata tmpfs requires a separate read-only metadata input');
    const directoryMount=(host:string,destination:string,readonly:boolean)=>{const stat=fs.lstatSync(host),real=fs.realpathSync(host);if(!stat.isDirectory()||stat.isSymbolicLink()||real.includes(',')||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o022)!==0)throw new CsoError('UNSAFE_PATH',`Preparation ${destination} mount must be one private owned directory`);args.push('--mount',`type=bind,src=${real},dst=${destination}${readonly?',readonly':''},bind-nonrecursive`);expectedMounts.add(destination);};
    if(spec.readonlyMetadata)directoryMount(spec.readonlyMetadata,'/metadata',true);
    if(spec.readonlyInputMetadata)directoryMount(spec.readonlyInputMetadata,'/input-metadata',true);
    if(spec.metadataTmpfsBytes){if(!Number.isSafeInteger(spec.metadataTmpfsBytes)||spec.metadataTmpfsBytes<=0||spec.metadataTmpfsBytes>1024*1024*1024)throw new CsoError('INVALID_SCHEMA','Preparation metadata tmpfs exceeds the 1 GiB policy');args.push('--tmpfs',`/metadata:rw,noexec,nosuid,nodev,size=${spec.metadataTmpfsBytes},mode=700,uid=${uid},gid=${gid}`);expectedTmpfs.add('/metadata');}
    if(spec.archiveTmpfsBytes){if(!Number.isSafeInteger(spec.archiveTmpfsBytes)||spec.archiveTmpfsBytes<=0||spec.archiveTmpfsBytes>2*1024*1024*1024)throw new CsoError('INVALID_SCHEMA','Preparation archive tmpfs exceeds the 2 GiB group storage policy');args.push('--tmpfs',`/archives:rw,noexec,nosuid,nodev,size=${spec.archiveTmpfsBytes},mode=700,uid=${uid},gid=${gid}`);expectedTmpfs.add('/archives');}
    if(spec.readonlyArchiveDirectory)directoryMount(spec.readonlyArchiveDirectory,'/archives',true);
    if(spec.registrySocket){const stat=fs.lstatSync(spec.registrySocket),real=fs.realpathSync(spec.registrySocket);if(!stat.isSocket()||stat.isSymbolicLink()||real.includes(',')||(process.getuid&&stat.uid!==process.getuid()))throw new CsoError('UNSAFE_PATH','Registry broker mount must be one owned Unix socket');args.push('--mount',`type=bind,src=${real},dst=/run/cso-registry.sock,readonly,bind-nonrecursive`);expectedMounts.add('/run/cso-registry.sock');}
    args.push('--entrypoint','/opt/cso/entrypoint',spec.image,...spec.command);
    const id=await this.docker(args,8192); if(!/^[a-f0-9]{64}$/.test(id))throw new CsoError('ISOLATION_FAILED','Docker did not return a stable container ID');
    let inspectedContainer:any;try{inspectedContainer=JSON.parse(await this.docker(['inspect','--format','{{json .}}',id],64*1024));}catch{throw new CsoError('ISOLATION_FAILED','Docker did not return valid admitted-container configuration');}const hostConfig=inspectedContainer?.HostConfig,mounts=inspectedContainer?.Mounts;
    if(hostConfig?.ReadonlyRootfs!==true||hostConfig?.ShmSize!==CONTAINER_SHM_BYTES||
      !hostConfig.Tmpfs||Object.keys(hostConfig.Tmpfs).sort().join('\0')!==[...expectedTmpfs].sort().join('\0')||!Array.isArray(mounts)||
      mounts.some((mount:any)=>!mount||!((mount.Type==='bind'&&expectedMounts.has(mount.Destination))||(mount.Type==='tmpfs'&&expectedTmpfs.has(mount.Destination))))||
      mounts.filter((mount:any)=>mount?.Type==='bind').length!==expectedMounts.size)
      throw new CsoError('ISOLATION_FAILED','Docker did not preserve the bounded writable-storage policy');
    // Durable journal publication precedes in-memory admission. If this write
    // fails, label recovery still owns the just-created container and no
    // phantom role is retained in the live group.
    try{fs.appendFileSync(join(this.dir,'resources.journal'),`container:${id}\n`,{mode:0o600});}
    catch{throw new CsoError('PERSISTENCE_FAILED','Container resource journal could not be extended');}
    this.ids.push({role:spec.role,id});this.writableBytesById.set(id,candidateWritable);if(spec.role!=='anchor')this.roles.push(spec.role);return id;
  }
  async start(id:string):Promise<void>{await this.docker(['start',id]);}
  async pause(id:string):Promise<void>{
    if(!this.ids.some(item=>item.id===id))throw new CsoError('ISOLATION_FAILED','Attempted to pause a container outside this reproduction group');
    await this.docker(['pause',id],8192);
    let paused:unknown;try{paused=JSON.parse(await this.docker(['inspect','--format','{{json .State.Paused}}',id],8192));}catch{throw new CsoError('ISOLATION_FAILED','Prepared container pause state could not be proven');}
    if(paused!==true)throw new CsoError('ISOLATION_FAILED','Prepared container was not frozen before export');
  }
  async wait(id:string):Promise<{code:number;output:string}>{
    const code=Number(await this.docker(['wait',id],8192));
    // --log-driver=none means daemon logs are unavailable by design. Bounded output must come from attached runs; callers use execAttach.
    return {code,output:''};
  }
  async execCapture(id:string,command:string[],options:{workdir?:string;env?:Record<string,string>}={}):Promise<{code:number;stdout:string;stderr:string}>{
    if(!command.length||!command[0].startsWith('/'))throw new CsoError('INVALID_SCHEMA','Exec needs an absolute executable');
    if(options.workdir&&!['/metadata','/work','/archives'].includes(options.workdir))throw new CsoError('INVALID_SCHEMA','Exec working directory is outside the preparation contract');
    if(this.remainingOutput<=0)throw new CsoError('REDACTION_FAILED','Reproduction-group output budget is exhausted');
    const remaining=Math.max(1,Math.min(300_000,this.deadline-Date.now()));
    const args=['exec'];if(options.workdir)args.push('--workdir',options.workdir);for(const [key,value] of Object.entries(options.env??{})){if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)||value.includes('\0'))throw new CsoError('INVALID_SCHEMA','Exec environment is invalid');args.push('--env',`${key}=${value}`);}args.push(id,...command);
    const r=await runProcess(this.endpoint.executable,args,{cwd:this.dir,env:dockerEnvironment(this.endpoint,this.config),timeoutMs:remaining,maxBytes:this.remainingOutput});this.remainingOutput=Math.max(0,this.remainingOutput-r.capturedBytes);
    if(r.timedOut)throw new CsoError('DEADLINE','Target command exceeded the reproduction deadline');if(r.truncated)throw new CsoError('REDACTION_FAILED','Aggregate reproduction output exceeded 1 MiB and was withheld');
    return {code:r.code,stdout:r.stdout,stderr:r.stderr};
  }
  async execAttach(id:string,command:string[]):Promise<{code:number;output:string}>{
    const result=await this.execCapture(id,command);return{code:result.code,output:result.stdout+result.stderr};
  }
  async execDetached(id:string,command:string[],workdir='/work'):Promise<void>{
    if(!command.length||!command[0].startsWith('/')||!workdir.startsWith('/'))throw new CsoError('INVALID_SCHEMA','Detached exec needs absolute paths');
    await this.docker(['exec','--detach','--workdir',workdir,id,...command],8192);
  }
  async startAttach(id:string):Promise<{code:number;output:string}>{
    if(this.remainingOutput<=0)throw new CsoError('REDACTION_FAILED','Reproduction-group output budget is exhausted');
    const remaining=Math.max(1,Math.min(300_000,this.deadline-Date.now()));
    const r=await runProcess(this.endpoint.executable,['start','--attach',id],{cwd:this.dir,env:dockerEnvironment(this.endpoint,this.config),timeoutMs:remaining,maxBytes:this.remainingOutput});this.remainingOutput=Math.max(0,this.remainingOutput-r.capturedBytes);
    if(r.timedOut)throw new CsoError('DEADLINE','Target command exceeded the reproduction deadline');if(r.truncated)throw new CsoError('REDACTION_FAILED','Aggregate reproduction output exceeded 1 MiB and was withheld');
    return {code:r.code,output:r.stdout+r.stderr};
  }
  async assertOnlyInitProcess(id:string):Promise<void>{
    if(!this.ids.some(item=>item.id===id))throw new CsoError('ISOLATION_FAILED','Attempted to inspect a container outside this reproduction group');
    validateSingleContainerProcessOutput(await this.docker(['top',id,'-eo','pid'],64*1024));
  }
  async copyPreparedExport(id:string,containerPath:string,destination:string):Promise<void>{
    if(!this.ids.some(item=>item.id===id))throw new CsoError('ISOLATION_FAILED','Attempted to copy from a container outside this reproduction group');
    if(!/^\/work\/\.gstack-cso-export-[a-f0-9]{24}$/.test(containerPath))throw new CsoError('INVALID_SCHEMA','Prepared export path is outside the fixed helper contract');
    const stat=fs.lstatSync(destination),real=fs.realpathSync(destination);if(!stat.isDirectory()||stat.isSymbolicLink()||real.includes(',')||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o022)!==0||fs.readdirSync(real).length)throw new CsoError('UNSAFE_PATH','Prepared inert export destination must be one empty private owned directory');
    // Only the qualified helper's regular-blob export is copied. Application
    // output is reconstructed later by host no-follow writes.
    await this.docker(['cp',`${id}:${containerPath}/.`,real],8192);
  }
  async copyAcquisitionExport(id:string,containerPath:string,destination:string):Promise<void>{
    if(!this.ids.some(item=>item.id===id))throw new CsoError('ISOLATION_FAILED','Attempted to copy output from a container outside this reproduction group');
    if(!/^\/archives\/\.gstack-cso-acquisition-export-[a-f0-9]{24}$/.test(containerPath))throw new CsoError('INVALID_SCHEMA','Acquisition export path is outside the fixed helper contract');
    const stat=fs.lstatSync(destination),real=fs.realpathSync(destination);if(!stat.isDirectory()||stat.isSymbolicLink()||real.includes(',')||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o022)!==0||fs.readdirSync(real).length)throw new CsoError('UNSAFE_PATH','Acquisition output must be one empty private owned directory');
    await this.docker(['cp',`${id}:${containerPath}/.`,real],8192);
  }
  async removeContainer(id:string):Promise<void>{
    const index=this.ids.findIndex(item=>item.id===id);if(index<0)throw new CsoError('ISOLATION_FAILED','Attempted to remove a container outside this reproduction group');
    const present=await this.docker(['ps','--all','--quiet','--no-trunc','--filter',`id=${id}`],8192);if(present&&present!==id)throw new CsoError('ISOLATION_FAILED','Docker returned an inexact resource identity during cleanup');if(present)await this.docker(['rm','--force','--volumes',id],8192);
    const [{role}]=this.ids.splice(index,1);this.writableBytesById.delete(id);const roleIndex=this.roles.lastIndexOf(role);if(roleIndex>=0)this.roles.splice(roleIndex,1);
  }
  async cleanup():Promise<void>{
    let failure:unknown;try{
      const labeled=await this.docker(['ps','--all','--quiet','--no-trunc','--filter',`label=com.gstack.cso.run=${this.runId}`],128*1024),targets=new Set(this.ids.map(item=>item.id));
      for(const id of labeled.split('\n').filter(Boolean)){if(!/^[a-f0-9]{64}$/.test(id))throw new CsoError('ISOLATION_FAILED','Docker returned an invalid labeled resource identity during cleanup');targets.add(id);}
      for(const id of [...targets].reverse()){const present=await this.docker(['ps','--all','--quiet','--no-trunc','--filter',`id=${id}`],8192);if(present&&present!==id)throw new CsoError('ISOLATION_FAILED','Docker returned an inexact resource identity during cleanup');if(present)await this.docker(['rm','--force','--volumes',id],8192);}
      const remaining=await this.docker(['ps','--all','--quiet','--no-trunc','--filter',`label=com.gstack.cso.run=${this.runId}`],8192);if(remaining)throw new CsoError('ISOLATION_FAILED','Run-owned Docker resources remain after cleanup');
    }catch(error){failure=error;}
    if(failure)throw new CsoError('ISOLATION_FAILED','Exact reproduction cleanup failed; verification evidence was withheld and the watchdog remains responsible');
    this.ids=[];this.writableBytesById.clear();release(this.lease);fs.writeFileSync(join(this.dir,'watchdog.terminal'),'cleanup complete\n',{mode:0o600,flag:'wx'});
    const stopped=join(this.dir,'watchdog.stopped');for(let i=0;i<500&&!fs.existsSync(stopped);i++)await new Promise(resolve=>setTimeout(resolve,10));if(!fs.existsSync(stopped))throw new CsoError('ISOLATION_FAILED','Docker watchdog did not acknowledge exact lease cleanup');
  }
}
