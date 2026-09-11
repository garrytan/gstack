import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';import * as os from 'node:os';import * as path from 'node:path';import { spawn, spawnSync } from 'node:child_process';
import { DockerGroup, dockerEndpoint, dockerProbe } from '../lib/cso/docker';import { admit, release } from '../lib/cso/admission';
const enabled=process.env.GSTACK_CSO_DOCKER_TESTS==='1',suite=enabled?describe:describe.skip;let root='',state='',image='',volumeImage='',endpoint:any,watchdog='';
function exec(file:string,args:string[],env:Record<string,string>={}){const r=spawnSync(file,args,{encoding:'utf8',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,GSTACK_HOME:state,DOCKER_HOST:'unix:///var/run/docker.sock',...env},timeout:120_000});if(r.status!==0)throw new Error(`${file} failed: ${r.stderr}`);return r.stdout.trim();}
beforeAll(()=>{if(!enabled)return;root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-docker-'));state=path.join(root,'state');process.env.GSTACK_HOME=state;watchdog=path.resolve(import.meta.dir,'../bin/gstack-cso-watchdog');if(!fs.existsSync(watchdog))throw new Error('GSTACK_CSO_DOCKER_TESTS=1 requires the compiled watchdog');
  const source=`#include <arpa/inet.h>\n#include <errno.h>\n#include <fcntl.h>\n#include <netdb.h>\n#include <netinet/in.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <sys/socket.h>\n#include <sys/stat.h>\n#include <sys/types.h>\n#include <unistd.h>\nstatic int blocked4(const char *ip,int port){int s=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port)};inet_pton(AF_INET,ip,&a.sin_addr);int r=connect(s,(void*)&a,sizeof a);close(s);return r!=0;}\nstatic int blocked6(void){int s=socket(AF_INET6,SOCK_STREAM,0);struct sockaddr_in6 a={.sin6_family=AF_INET6,.sin6_port=htons(443)};inet_pton(AF_INET6,"2606:4700:4700::1111",&a.sin6_addr);int r=connect(s,(void*)&a,sizeof a);close(s);return r!=0;}\nint main(int argc,char**argv){if(strstr(argv[0],"entrypoint")){if(argc<2||argv[1][0]!='/')return 64;execv(argv[1],argv+1);return 69;}if(strstr(argv[0],"sleep")){for(;;)sleep(3600);}if(strstr(argv[0],"reader")){char a[16]={0},b[16]={0};FILE*x=fopen("/source/source.txt","r"),*y=fopen("/policy/verification.json","r");if(!x||!y||!fgets(a,sizeof a,x)||!fgets(b,sizeof b,y))return 12;fclose(x);fclose(y);if(strcmp(a,"source\\n")||strcmp(b,"policy\\n"))return 13;puts("INPUTS_OK");return 0;}if(strstr(argv[0],"server")){int s=socket(AF_INET,SOCK_STREAM,0),c;struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(34567),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};int one=1;setsockopt(s,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);if(bind(s,(void*)&a,sizeof a)||listen(s,2))return 2;for(;;){c=accept(s,0,0);if(c>=0){write(c,"ok",2);close(c);}}}int fd=open("/should-not-write",O_WRONLY|O_CREAT,0600);if(fd>=0)return 10;FILE*f=fopen("/proc/self/status","r");char line[256];int caps=1,nnp=0;while(f&&fgets(line,sizeof line,f)){if(!strncmp(line,"CapEff:",7))caps=strtoull(line+7,0,16)!=0;if(!strncmp(line,"NoNewPrivs:",11))nnp=atoi(line+11);}if(f)fclose(f);int s=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(34567),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};int loop=connect(s,(void*)&a,sizeof a)==0;close(s);struct addrinfo*h=0;int dns=getaddrinfo("example.com",0,0,&h);if(h)freeaddrinfo(h);if(getuid()==0||caps||!nnp||!loop||!blocked4("8.8.8.8",443)||!blocked4("169.254.169.254",80)||!blocked6()||dns==0)return 11;puts("CONTAINMENT_OK");return 0;}\n`;
  fs.writeFileSync(path.join(root,'probe.c'),source);exec('/usr/bin/cc',['-static','-O2',path.join(root,'probe.c'),'-o',path.join(root,'probe')]);exec('/usr/bin/cc',['-static','-O2',path.join(import.meta.dir,'fixtures/cso-http-smoke.c'),'-o',path.join(root,'http-server')]);fs.writeFileSync(path.join(root,'Dockerfile'),'FROM scratch\nCOPY probe /opt/cso/entrypoint\nCOPY probe /bin/sleep\nCOPY probe /server\nCOPY probe /client\nCOPY probe /reader\nCOPY probe /policy/.keep\nCOPY probe /source/.keep\nCOPY http-server /http-server\nUSER 10001:10001\nENTRYPOINT ["/opt/cso/entrypoint"]\n');const tag=`gstack-cso-fixture:${process.pid}`;exec('/usr/bin/docker',['--host','unix:///var/run/docker.sock','build','--network=none','--tag',tag,root]);image=exec('/usr/bin/docker',['--host','unix:///var/run/docker.sock','image','inspect','--format','{{.Id}}',tag]);fs.writeFileSync(path.join(root,'VolumeDockerfile'),`FROM ${tag}\nVOLUME ["/unbounded"]\n`);const volumeTag=`gstack-cso-volume-fixture:${process.pid}`;exec('/usr/bin/docker',['--host','unix:///var/run/docker.sock','build','--network=none','--file',path.join(root,'VolumeDockerfile'),'--tag',volumeTag,root]);volumeImage=exec('/usr/bin/docker',['--host','unix:///var/run/docker.sock','image','inspect','--format','{{.Id}}',volumeTag]);});
afterAll(()=>{if(root){for(const candidate of [volumeImage,image])try{if(candidate)spawnSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','image','rm','--force',candidate],{stdio:'ignore',timeout:30_000});}catch{}fs.rmSync(root,{recursive:true,force:true});}delete process.env.GSTACK_HOME;});

suite('CSO Docker containment integration',()=>{
  test('hard fails when local daemon enforcement prerequisites are absent',async()=>{endpoint=await dockerEndpoint(root,{HOME:root,DOCKER_HOST:'unix:///var/run/docker.sock'});const info=await dockerProbe(endpoint,root);expect(info.security.some((x:string)=>x.includes('seccomp'))).toBe(true);});
  test('rejects image-declared writable volumes before container creation',async()=>{const dir=path.join(root,'volume-rejection');fs.mkdirSync(dir);const group=await DockerGroup.create(endpoint,`volume-${Date.now()}`,dir,Date.now()+60_000,image,watchdog);try{const before=exec('/usr/bin/docker',['--host',endpoint.uri,'volume','ls','--quiet']);await expect(group.createContainer({role:'app',image:volumeImage,command:['/bin/sleep','1']})).rejects.toThrow('declares writable volumes');expect(exec('/usr/bin/docker',['--host',endpoint.uri,'volume','ls','--quiet'])).toBe(before);}finally{await group.cleanup();}},120_000);
  test('shares only loopback while denying egress, privileges, and daemon logs, and reads private source/policy mounts',async()=>{const dir=path.join(root,'group');fs.mkdirSync(dir);const group=await DockerGroup.create(endpoint,`integration-${Date.now()}`,dir,Date.now()+60_000,image,watchdog);let server='',client='';try{server=await group.createContainer({role:'app',image,command:['/server']});await group.start(server);client=await group.createContainer({role:'verifier',image,command:['/client']});const result=await group.startAttach(client);expect(result).toEqual({code:0,output:'CONTAINMENT_OK\n'});const sourceDir=path.join(dir,'private-source'),policy=path.join(dir,'verification.json');fs.mkdirSync(sourceDir,{mode:0o700});fs.writeFileSync(path.join(sourceDir,'source.txt'),'source\n',{mode:0o600});fs.writeFileSync(policy,'policy\n',{mode:0o600});const reader=await group.createContainer({role:'browser',image,source:sourceDir,command:['/reader'],readonlyFiles:[{host:policy,container:'/policy/verification.json'}]});expect(await group.startAttach(reader)).toEqual({code:0,output:'INPUTS_OK\n'});const raw=exec('/usr/bin/docker',['--host',endpoint.uri,'inspect',client]),inspect=JSON.parse(raw)[0];expect(inspect.HostConfig).toMatchObject({ReadonlyRootfs:true,NetworkMode:`container:${group.anchor}`,PidsLimit:32,ShmSize:8*1024*1024,LogConfig:{Type:'none',Config:{}}});expect(inspect.Config.User).toBe(`${process.getuid?.()}:${process.getgid?.()}`);expect(inspect.HostConfig.CapDrop).toEqual(['ALL']);expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges:true');expect(inspect.HostConfig.PortBindings).toEqual({});expect(inspect.Mounts.every((m:any)=>m.Destination!=='/var/run/docker.sock')).toBe(true);}finally{await group.cleanup();}expect(spawnSync('/usr/bin/docker',['--host',endpoint.uri,'inspect',client],{timeout:30_000}).status).not.toBe(0);});
  test('machine-wide admission allows only two groups per endpoint',()=>{const a=admit(endpoint.uri,'a',Date.now()+60_000),b=admit(endpoint.uri,'b',Date.now()+60_000);try{expect(()=>admit(endpoint.uri,'c',Date.now()+60_000)).toThrow('Two reproduction groups');}finally{release(a);release(b);}});
  test('staged runtime executes its trusted verifier and checks every declared tool version', async () => {
    const staged = process.env.GSTACK_CSO_TEST_IMAGE;
    if (!staged) return;
    expect(staged).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(process.env.GSTACK_CSO_TEST_PLATFORM).toBe(process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64');
    const versions = JSON.parse(process.env.GSTACK_CSO_EXPECTED_VERSIONS || '{}');
    const commands: Record<string, Record<string, string[]>> = {
      node: {node: ['/usr/local/bin/node', '--version'], npm: ['/usr/local/bin/npm', '--version'], 'cso-preparation': ['/opt/cso/preparation', '--version']},
      bun: {bun: ['/usr/local/bin/bun', '--version'], 'cso-preparation': ['/opt/cso/preparation', '--version']},
      python: {python: ['/usr/local/bin/python', '--version'], uv: ['/usr/local/bin/uv', '--version'], 'cso-preparation': ['/opt/cso/preparation', '--version']},
      rails: {ruby: ['/usr/local/bin/ruby', '--version'], bundler: ['/usr/local/bin/bundle', '--version'], 'cso-preparation': ['/opt/cso/preparation', '--version']},
      postgresql: {postgresql: ['/opt/cso/bin/postgres', '--version']},
    };
    const prefixes: Record<string, string> = {node: 'v', npm: '', bun: '', python: 'Python ', uv: 'uv ', ruby: 'ruby ', bundler: 'Bundler version ', postgresql: 'postgres (PostgreSQL) ', 'cso-preparation': ''};
    const stack = commands[process.env.GSTACK_CSO_TEST_STACK || ''];
    expect(stack).toBeDefined();
    expect(Object.keys(versions).sort()).toEqual(Object.keys(stack).sort());
    const dir = path.join(root, 'staged'); fs.mkdirSync(dir, {mode: 0o700});
    const policy = {
      phase: 'after', port: 34568,
      legitimate: [{name: 'available feature', path: '/control', method: 'GET', expected: {status: 200, includes: 'CONTROL_OK'}}],
      security: {name: 'denied access', path: '/security', method: 'GET', expected: {status: 403, includes: 'DENIED'}, vulnerable: {status: 200, includes: 'SECRET'}},
    };
    const positivePath = path.join(dir, 'positive.json'), negativePath = path.join(dir, 'broken-control.json');
    fs.writeFileSync(positivePath, JSON.stringify(policy), {mode: 0o600});
    fs.writeFileSync(negativePath, JSON.stringify({...policy, legitimate: [{...policy.legitimate[0], expected: {status: 201, includes: 'CONTROL_OK'}}]}), {mode: 0o600});
    const group = await DockerGroup.create(endpoint, `staged-${Date.now()}`, dir, Date.now() + 90_000, staged, watchdog);
    try {
      for (const [tool, version] of Object.entries(versions)) {
        const result = await group.execAttach(group.anchor, stack[tool]);
        expect(result.code).toBe(0);
        const expected = `${prefixes[tool]}${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(result.output.trim()).toMatch(new RegExp(`^${expected}(?:$|\\s)`));
      }
      if(process.env.GSTACK_CSO_TEST_STACK==='postgresql'){
        const databases=path.join(dir,'postgresql.databases');fs.writeFileSync(databases,'cso_primary\ncso_queue\n',{mode:0o444});
        const postgres=await group.createContainer({role:'postgres',image:staged,command:['/opt/cso/run-postgresql','/policy/postgresql.databases'],postgresDatabasePolicy:databases});await group.start(postgres);
        let ready=false;for(let attempt=0;attempt<100&&!ready;attempt++){const checked=await group.execAttach(postgres,['/opt/cso/postgresql-ready','/policy/postgresql.databases']);ready=checked.code===0;if(!ready)await Bun.sleep(50);}expect(ready).toBe(true);
        const raw=exec('/usr/bin/docker',['--host',endpoint.uri,'inspect',postgres]),inspect=JSON.parse(raw)[0];expect(inspect.Config.User).toBe('10001:10001');
        await group.removeContainer(postgres);
      }
      const server = await group.createContainer({role: 'app', image, command: ['/http-server']});
      await group.start(server);
      const verifier = await group.createContainer({
        role: 'verifier', image: staged, command: ['/bin/sleep', '2147483647'],
        readonlyFiles: [{host: positivePath, container: '/policy/positive.json'}, {host: negativePath, container: '/policy/broken-control.json'}],
      });
      await group.start(verifier);
      const positive = await group.execAttach(verifier, ['/opt/cso/verifier', '/policy/positive.json']);
      expect(positive.code).toBe(0);
      expect(JSON.parse(positive.output)).toMatchObject({booted: true, legitimate: true, security: 'pass'});
      const negative = await group.execAttach(verifier, ['/opt/cso/verifier', '/policy/broken-control.json']);
      expect(negative.code).toBe(0);
      expect(JSON.parse(negative.output)).toMatchObject({booted: true, legitimate: false, security: 'pass'});
    } finally { await group.cleanup(); }
  }, 120_000);
});
