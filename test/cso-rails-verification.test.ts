import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DockerGroup } from '../lib/cso/docker';
import { DockerVerificationExecutor } from '../lib/cso/verification';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('CSO Rails database verification lifecycle',()=>{
  test('creates fresh multi-database PostgreSQL per phase and prepares every private work tree',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-rails-verification-'));roots.push(root);
    const source=path.join(root,'source'),work=path.join(root,'work'),control=path.join(root,'control');for(const dir of [source,work,control])fs.mkdirSync(dir);
    const events:string[]=[],policies:string[][]=[];let groupNumber=0;
    const create=spyOn(DockerGroup,'create').mockImplementation(async()=>{
      const group=++groupNumber;let next=0;
      return {
        anchor:`anchor-${group}`,
        createContainer:async(spec:any)=>{const id=`${group}-${spec.role}-${++next}`;events.push(`create:${id}:${spec.command.join(' ')}`);if(spec.postgresDatabasePolicy){policies.push(fs.readFileSync(spec.postgresDatabasePolicy,'utf8').trim().split('\n'));expect(fs.statSync(spec.postgresDatabasePolicy).mode&0o777).toBe(0o444);}return id;},
        start:async(id:string)=>{events.push(`start:${id}`);},
        execCapture:async(id:string,command:string[])=>{events.push(`exec:${id}:${command.join(' ')}`);return{code:0,stdout:'',stderr:''};},
        execDetached:async(id:string,command:string[])=>{events.push(`detach:${id}:${command.join(' ')}`);},
        startAttach:async(id:string)=>{events.push(`attach:${id}`);return{code:0,output:JSON.stringify({booted:true,legitimate:true,security:'pass',existingTests:false,output:'ok',inputHash:''})};},
        removeContainer:async(id:string)=>{events.push(`remove:${id}`);},cleanup:async()=>{events.push(`cleanup:${group}`);},
      } as any;
    });
    try{
      const runtime:any={id:'rails',stack:'rails',image:`runtime@sha256:${'a'.repeat(64)}`,platform:'linux/amd64'};
      const request:any={findingId:'b'.repeat(32),port:3456,start:{executable:'/usr/local/bin/bundle',args:['exec','rails','server']},
        legitimate:[],security:{},fixtures:{},existingTests:[{executable:'/usr/local/bin/bundle',args:['exec','rspec']},{executable:'/usr/local/bin/bundle',args:['exec','rails','test']}]};
      const executor=new DockerVerificationExecutor({} as any,'/watchdog',Date.now()+60_000);
      const execution:any={environment:{BUNDLE_PATH:'/work/vendor/bundle'},database:{adapter:'postgresql',connections:['primary','queue'],sidecar:{id:'postgresql-17',image:`postgres@sha256:${'c'.repeat(64)}`}}};
      await executor.observe(source,'before',request,runtime,runtime,work,control,execution);
      await executor.observe(source,'after',request,runtime,runtime,work,control,execution);
    }finally{create.mockRestore();}
    expect(policies).toEqual([['cso_primary','cso_queue'],['cso_primary','cso_queue']]);
    expect(events.filter(event=>event.includes('/opt/cso/postgresql-ready'))).toHaveLength(2);
    expect(events.filter(event=>event.includes('/usr/local/bin/bundle exec rails db:prepare'))).toHaveLength(6);
    for(const group of [1,2]){
      const removeApp=events.findIndex(event=>event===`remove:${group}-app-2`),createFirstTest=events.findIndex(event=>event.startsWith(`create:${group}-tests-4:`));
      expect(removeApp).toBeGreaterThan(-1);expect(createFirstTest).toBeGreaterThan(removeApp);
    }
  });

  test('SQLite prepares the app and each test copy without a sidecar',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-rails-sqlite-'));roots.push(root);for(const name of ['source','work','control'])fs.mkdirSync(path.join(root,name));
    const commands:string[]=[];let next=0;
    const create=spyOn(DockerGroup,'create').mockResolvedValue({
      createContainer:async(spec:any)=>{commands.push(`create:${spec.role}`);return`${spec.role}-${++next}`;},start:async()=>{},
      execCapture:async(_id:string,command:string[])=>{commands.push(command.join(' '));return{code:0,stdout:'',stderr:''};},execDetached:async()=>{},
      startAttach:async()=>({code:0,output:JSON.stringify({booted:true,legitimate:true,security:'pass',existingTests:false,output:'ok',inputHash:''})}),removeContainer:async()=>{},cleanup:async()=>{},
    } as any);
    try{const runtime:any={stack:'rails',image:`runtime@sha256:${'a'.repeat(64)}`},request:any={findingId:'d'.repeat(32),port:3456,start:{executable:'/usr/local/bin/bundle',args:['exec','rails','server']},legitimate:[],security:{},fixtures:{},existingTests:[{executable:'/usr/local/bin/bundle',args:['exec','rails','test']}]};await new DockerVerificationExecutor({} as any,'/watchdog',Date.now()+60_000).observe(path.join(root,'source'),'before',request,runtime,runtime,path.join(root,'work'),path.join(root,'control'),{environment:{},database:{adapter:'sqlite',connections:['primary']}});}finally{create.mockRestore();}
    expect(commands.some(command=>command==='create:postgres')).toBe(false);expect(commands.filter(command=>command.includes('exec rails db:prepare'))).toHaveLength(2);
  });
});
