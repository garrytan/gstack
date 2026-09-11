import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT=resolve(import.meta.dir,'..'),temps:string[]=[];
afterEach(()=>{for(const dir of temps.splice(0))rmSync(dir,{recursive:true,force:true});});
function temporary(){const dir=mkdtempSync(join(tmpdir(),'cso-generation-'));temps.push(dir);return dir;}
function digest(path:string){return createHash('sha256').update(readFileSync(path)).digest('hex');}
function compileC(source:string,output:string,args:string[]=[]){const result=spawnSync('/usr/bin/cc',['-std=c11','-D_POSIX_C_SOURCE=200809L','-O2',...args,source,'-o',output],{encoding:'utf8',timeout:30_000});expect(result.status,result.stderr).toBe(0);chmodSync(output,0o755);}
function compileLauncher(directory:string,coreDigest:string,testing=false){const output=join(directory,'gstack-cso-launcher'),args=[`-DGSTACK_CSO_CORE_SHA256=\"${coreDigest}\"`,...(testing?['-DGSTACK_CSO_TESTING']:[])];compileC(join(ROOT,'lib/cso/launcher.c'),output,args);return output;}
async function waitFor(path:string){const deadline=Date.now()+5000;while(!existsSync(path)&&Date.now()<deadline)await Bun.sleep(10);expect(existsSync(path)).toBe(true);}

describe.skipIf(process.platform==='win32')('CSO native generation handoff',()=>{
  test('the launcher rejects changed core bytes even when the generation manifest is unchanged',()=>{
    const directory=temporary(),core=join(directory,'gstack-cso-core'),source=join(directory,'core.c');
    writeFileSync(source,'#include <stdio.h>\nint main(void){puts("OLD");return 0;}\n');compileC(source,core);const expected=digest(core),launcher=compileLauncher(directory,expected);writeFileSync(join(directory,'.gstack-cso-generation'),`${expected}\n`);
    writeFileSync(source,'#include <stdio.h>\nint main(void){puts("CHANGED");return 0;}\n');compileC(source,core);
    const result=spawnSync(launcher,[],{cwd:directory,encoding:'utf8',timeout:5000});expect(result.status).toBe(69);expect(result.stdout).not.toContain('CHANGED');expect(result.stderr).toContain('digest does not match');
  });

  test('the launcher rejects a multiply-linked core before execution',()=>{
    const directory=temporary(),core=join(directory,'gstack-cso-core'),source=join(directory,'core.c');
    writeFileSync(source,'#include <stdio.h>\nint main(void){puts("UNSAFE");return 0;}\n');compileC(source,core);const expected=digest(core),launcher=compileLauncher(directory,expected);writeFileSync(join(directory,'.gstack-cso-generation'),`${expected}\n`);linkSync(core,join(directory,'core-alias'));
    const result=spawnSync(launcher,[],{cwd:directory,encoding:'utf8',timeout:5000});expect(result.status).toBe(69);expect(result.stdout).not.toContain('UNSAFE');expect(result.stderr).toContain('trusted compiled helper is missing');
  });

  test.skipIf(process.platform!=='linux')('the launcher executes the verified descriptor across a noncooperative pathname swap',async()=>{
    const directory=temporary(),core=join(directory,'gstack-cso-core'),source=join(directory,'core.c'),ready=join(directory,'ready'),release=join(directory,'release');
    writeFileSync(source,'#include <stdio.h>\nint main(void){puts("VERIFIED");return 0;}\n');compileC(source,core);const expected=digest(core),launcher=compileLauncher(directory,expected,true);writeFileSync(join(directory,'.gstack-cso-generation'),`${expected}\n`);
    const running=Bun.spawn([launcher,'__cso-test-pause-after-core-verification',ready,release],{cwd:directory,stdout:'pipe',stderr:'pipe'});await waitFor(ready);
    const replacement=join(directory,'replacement-core');writeFileSync(source,'#include <stdio.h>\nint main(void){puts("SWAPPED");return 0;}\n');compileC(source,replacement);renameSync(replacement,core);writeFileSync(release,'go');
    const stdout=await new Response(running.stdout).text(),stderr=await new Response(running.stderr).text();expect(await running.exited,stderr).toBe(0);expect(stdout.trim()).toBe('VERIFIED');expect(stdout).not.toContain('SWAPPED');
  });

  test('an already-loaded old launcher rejects the publisher-winning core generation',async()=>{
    const directory=temporary(),core=join(directory,'gstack-cso-core'),source=join(directory,'core.c'),ready=join(directory,'ready'),release=join(directory,'release');
    writeFileSync(source,'#include <stdio.h>\nint main(void){puts("OLD");return 0;}\n');compileC(source,core);const oldDigest=digest(core),launcher=compileLauncher(directory,oldDigest,true);writeFileSync(join(directory,'.gstack-cso-generation'),`${oldDigest}\n`);
    const running=Bun.spawn([launcher,'__cso-test-pause-before-generation-lock',ready,release],{cwd:directory,stdout:'pipe',stderr:'pipe'});await waitFor(ready);
    const next=join(directory,'next-core');writeFileSync(source,'#include <stdio.h>\nint main(void){puts("NEW");return 0;}\n');compileC(source,next);const nextDigest=digest(next),manifest=join(directory,'next-generation');writeFileSync(manifest,`${nextDigest}\n`);renameSync(next,core);renameSync(manifest,join(directory,'.gstack-cso-generation'));writeFileSync(release,'go');
    const stdout=await new Response(running.stdout).text(),stderr=await new Response(running.stderr).text();expect(await running.exited).toBe(69);expect(stdout).not.toContain('NEW');expect(stderr).toContain('generations do not match');
  });

  test('Bun retains the shared generation lock while the core runs and drops it before detached children',async()=>{
    const directory=temporary(),source=join(directory,'core.ts'),core=join(directory,'gstack-cso-core'),launcher=join(directory,'gstack-cso-launcher'),locker=join(directory,'gstack-cso-publish-lock'),ready=join(directory,'ready'),release=join(directory,'release'),childReady=join(directory,'child-ready'),childRelease=join(directory,'child-release'),published=join(directory,'published');
    writeFileSync(source,`import{fstatSync,writeFileSync,existsSync}from'node:fs';const fd=Number(process.env.GSTACK_CSO_GENERATION_LOCK_FD);if(!Number.isInteger(fd)||!fstatSync(fd).isDirectory())process.exit(71);writeFileSync(${JSON.stringify(ready)},'ready');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);const child=Bun.spawn(['/bin/sh','-c',${JSON.stringify(`touch '${childReady}'; while [ ! -f '${childRelease}' ]; do sleep .01; done`)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});child.unref();`);
    const built=spawnSync(process.execPath,['build','--compile','--no-compile-autoload-dotenv','--no-compile-autoload-bunfig','--no-compile-autoload-tsconfig','--no-compile-autoload-package-json',source,'--outfile',core],{encoding:'utf8',timeout:60_000});expect(built.status,built.stderr).toBe(0);const coreDigest=digest(core);compileLauncher(directory,coreDigest);writeFileSync(join(directory,'.gstack-cso-generation'),`${coreDigest}\n`);compileC(join(ROOT,'lib/cso/publish-lock.c'),locker);
    const running=Bun.spawn([launcher],{cwd:directory,stdout:'pipe',stderr:'pipe'});await waitFor(ready);const blocked=spawnSync(locker,[directory,'/bin/sh','-c',`touch '${published}'`],{encoding:'utf8',timeout:5000});expect(blocked.status).toBe(73);expect(existsSync(published)).toBe(false);
    writeFileSync(release,'go');expect(await running.exited).toBe(0);await waitFor(childReady);const admitted=spawnSync(locker,[directory,'/bin/sh','-c',`touch '${published}'`],{encoding:'utf8',timeout:5000});expect(admitted.status,admitted.stderr).toBe(0);expect(existsSync(published)).toBe(true);writeFileSync(childRelease,'go');
  },70_000);
});
