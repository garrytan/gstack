import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { durableAtomicWrite, readDurableAtomic, type DurableWritePhase } from '../lib/durable-atomic-write';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})});

async function childResult(child:ReturnType<typeof Bun.spawn>){const stdout=await new Response(child.stdout).text();const stderr=await new Response(child.stderr).text();return{exitCode:await child.exited,stdout,stderr}}

describe('durable atomic writer crash boundaries',()=>{
  test('publishes bytes only after the ordered durable boundaries',()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-write-')));roots.push(root);const target=path.join(root,'state.json');const phases:DurableWritePhase[]=[];
    durableAtomicWrite(target,'{"value":1}\n',{fault:phase=>phases.push(phase)});
    expect(phases).toEqual(['temporary_created','bytes_written','file_fsynced','renamed','directory_fsynced']);
    expect(fs.readFileSync(target,'utf8')).toBe('{"value":1}\n');
    expect(fs.statSync(target).mode&0o777).toBe(0o600);
  });

  for(const phase of ['temporary_created','bytes_written','file_fsynced','renamed','directory_fsynced'] as const){
    test(`a fresh process recovers after SIGKILL at ${phase}`,async()=>{
      const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-kill-')));roots.push(root);const target=path.join(root,'state.json');const marker=path.join(root,'phase');const driver=path.join(root,'driver.ts');const moduleUrl=new URL('../lib/durable-atomic-write.ts',import.meta.url).href;
      fs.writeFileSync(driver,`import * as fs from 'node:fs';import {durableAtomicWrite} from ${JSON.stringify(moduleUrl)};durableAtomicWrite(process.argv[2],process.argv[3],{fault:(phase)=>{if(phase===process.argv[4]){fs.writeFileSync(process.argv[5],phase);process.kill(process.pid,'SIGKILL')}}});\n`);
      const killed=await childResult(Bun.spawn([process.execPath,driver,target,'first\n',phase,marker],{stdout:'pipe',stderr:'pipe'}));expect(killed.exitCode).toBe(137);expect(fs.readFileSync(marker,'utf8')).toBe(phase);
      if(['renamed','directory_fsynced'].includes(phase))expect(fs.readFileSync(target,'utf8')).toBe('first\n');else expect(fs.existsSync(target)).toBeFalse();
      const recovered=await childResult(Bun.spawn([process.execPath,driver,target,'second\n','none',marker],{stdout:'pipe',stderr:'pipe'}));expect(recovered.exitCode).toBe(0);expect(fs.readFileSync(target,'utf8')).toBe('second\n');expect(fs.statSync(target).mode&0o777).toBe(0o600);
      expect(fs.readdirSync(root).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    });
  }

  test('a competing writer never observes or publishes partial bytes',async()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-race-')));roots.push(root);const target=path.join(root,'state.json');const marker=path.join(root,'phase');const driver=path.join(root,'driver.ts');const moduleUrl=new URL('../lib/durable-atomic-write.ts',import.meta.url).href;
    fs.writeFileSync(driver,`import * as fs from 'node:fs';import {durableAtomicWrite} from ${JSON.stringify(moduleUrl)};durableAtomicWrite(process.argv[2],process.argv[3],{fault:(phase)=>{if(phase===process.argv[4]){fs.writeFileSync(process.argv[5],phase);process.kill(process.pid,'SIGKILL')}}});\n`);
    const first=Bun.spawn([process.execPath,driver,target,'first-complete\n','file_fsynced',marker],{stdout:'pipe',stderr:'pipe'});for(let i=0;i<200&&!fs.existsSync(marker);i++)await Bun.sleep(5);expect(fs.existsSync(marker)).toBeTrue();const second=await childResult(Bun.spawn([process.execPath,driver,target,'second-complete\n','none',marker],{stdout:'pipe',stderr:'pipe'}));expect(await first.exited).toBe(137);expect(second.exitCode).toBe(0);expect(fs.readFileSync(target,'utf8')).toBe('second-complete\n');
    expect(fs.readdirSync(root).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  });

  test('a fresh reader adopts a complete owner-bound temporary publication',()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-read-')));roots.push(root);const target=path.join(root,'state.json');const temporary=path.join(root,'.state.json.durable.tmp');
    fs.writeFileSync(target,'{"value":1}\n',{mode:0o600});fs.writeFileSync(temporary,'{"value":2}\n',{mode:0o600});
    const value=readDurableAtomic(target,{decode:bytes=>JSON.parse(bytes.toString('utf8'))});
    expect(value).toEqual({value:2});expect(fs.readFileSync(target,'utf8')).toBe('{"value":2}\n');expect(fs.existsSync(temporary)).toBeFalse();
  });

  test('a fresh reader removes only a truncated temporary and preserves the target',()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-read-')));roots.push(root);const target=path.join(root,'state.json');const temporary=path.join(root,'.state.json.durable.tmp');
    fs.writeFileSync(target,'{"value":1}\n',{mode:0o600});fs.writeFileSync(temporary,'{"value":',{mode:0o600});
    const value=readDurableAtomic(target,{decode:bytes=>JSON.parse(bytes.toString('utf8')),isTruncatedTemporary:error=>error instanceof SyntaxError});
    expect(value).toEqual({value:1});expect(fs.readFileSync(target,'utf8')).toBe('{"value":1}\n');expect(fs.existsSync(temporary)).toBeFalse();
  });

  test('an unsafe temporary is rejected without changing its bytes or mode',()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-durable-read-')));roots.push(root);const target=path.join(root,'state.json');const temporary=path.join(root,'.state.json.durable.tmp');
    fs.writeFileSync(temporary,'sentinel',{mode:0o644});fs.chmodSync(temporary,0o644);
    expect(()=>durableAtomicWrite(target,'replacement')).toThrow('durable_write_temp_invalid');
    expect(fs.readFileSync(temporary,'utf8')).toBe('sentinel');expect(fs.statSync(temporary).mode&0o777).toBe(0o644);
  });
});
