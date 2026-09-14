#!/usr/bin/env bun
import * as fs from 'node:fs';
import { connect } from 'node:net';
import { HttpAssertion, VerificationObservation, object } from './contracts';

interface Config { phase:'before'|'after'; port:number; legitimate:HttpAssertion[]; security:HttpAssertion }
function matches(status:number,body:string,oracle:HttpAssertion['expected']):boolean{return status===oracle.status&&(oracle.includes===undefined||body.includes(oracle.includes))&&(oracle.excludes===undefined||!body.includes(oracle.excludes));}
export async function boundedResponseBody(response:Response,limit=65536):Promise<string>{
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('invalid response limit');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(/^\d+$/.test(declared)?Number(declared)>limit:true)){await response.body?.cancel();throw new Error('response too large');}
  if(!response.body)return'';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{
    for(;;){const next=await reader.read();if(next.done)break;if(!next.value)continue;total+=next.value.byteLength;if(total>limit){await reader.cancel();throw new Error('response too large');}chunks.push(next.value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder().decode(bytes);
}
async function request(a:HttpAssertion,port:number):Promise<{status:number;body:string}>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{const response=await fetch(`http://127.0.0.1:${port}${a.path}`,{method:a.method,headers:a.headers,body:['GET'].includes(a.method)?undefined:a.body,redirect:'manual',signal:controller.signal});return{status:response.status,body:await boundedResponseBody(response)};}finally{clearTimeout(timer);}
}
async function ready(port:number):Promise<boolean>{return await new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port}),done=(value:boolean)=>{socket.removeAllListeners();socket.destroy();resolve(value);},timer=setTimeout(()=>done(false),500);socket.once('connect',()=>{clearTimeout(timer);done(true);});socket.once('error',()=>{clearTimeout(timer);done(false);});});}
async function main(){
  const file=process.argv[2];if(!file||!file.startsWith('/policy/'))throw new Error('trusted policy path required');const raw=fs.readFileSync(file,'utf8');if(Buffer.byteLength(raw)>1024*1024)throw new Error('policy too large');const v=object(JSON.parse(raw),'verifier policy') as any;
  if(!['before','after'].includes(v.phase)||!Number.isInteger(v.port)||v.port<1024||v.port>65535||!Array.isArray(v.legitimate)||!v.security)throw new Error('invalid verifier policy');const config=v as Config;
  let booted=false;for(let attempt=0;attempt<60;attempt++){if(await ready(config.port)){booted=true;break;}await Bun.sleep(250);}
  let legitimate=false,security:VerificationObservation['security']='inconclusive',summary='application did not answer a legitimate control';
  if(booted){try{legitimate=(await Promise.all(config.legitimate.map(async a=>{const r=await request(a,config.port);return matches(r.status,r.body,a.expected);}))).every(Boolean);const r=await request(config.security,config.port),fixed=matches(r.status,r.body,config.security.expected),vulnerable=matches(r.status,r.body,config.security.vulnerable!);security=config.phase==='before'?(vulnerable&&!fixed?'intended_failure':fixed&&!vulnerable?'pass':'inconclusive'):(fixed&&!vulnerable?'pass':'inconclusive');summary=`boot=true legitimate=${legitimate} security=${security}`;}catch{summary='bounded verifier request failed';}}
  process.stdout.write(JSON.stringify({booted,legitimate,security,existingTests:false,output:summary,inputHash:''})+'\n');
}
if(import.meta.main)main().catch(()=>{process.stdout.write(JSON.stringify({booted:false,legitimate:false,security:'inconclusive',existingTests:false,output:'verifier setup failed',inputHash:''})+'\n');process.exitCode=1;});
