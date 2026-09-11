import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readBoundedStable } from '../lib/cso/bounded-file';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('CSO caller control-file reader',()=>{
  test.skipIf(process.platform==='win32')('cannot block on a FIFO raced over a validated regular file',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-control-file-'));roots.push(root);const input=path.join(root,'request.json'),original=path.join(root,'request.original'),fifo=path.join(root,'request.fifo');fs.writeFileSync(input,'{}\n');expect(spawnSync('/usr/bin/mkfifo',[fifo],{timeout:5_000}).status).toBe(0);const open=fs.openSync;let checked=false;
    const patched=spyOn(fs,'openSync').mockImplementation(((candidate:any,flags:any,mode?:any)=>{if(String(candidate)===input){checked=true;if((Number(flags)&(fs.constants.O_NONBLOCK??0))===0)throw new Error('reader would block on raced FIFO');fs.renameSync(input,original);fs.renameSync(fifo,input);}return mode===undefined?open(candidate,flags):open(candidate,flags,mode);}) as typeof fs.openSync);
    try{expect(()=>readBoundedStable(input,1024,'Input file')).toThrow('changed before it could be read');}finally{patched.mockRestore();}
    expect(checked).toBe(true);
  });
});
