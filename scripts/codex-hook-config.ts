#!/usr/bin/env bun
import fs from 'node:fs';import path from 'node:path';
const descriptor=JSON.parse(fs.readFileSync(path.resolve(import.meta.dir,'../codex/hooks/gstack-runtime-health.json'),'utf8'));
export const isManagedGstackHook=(hook:any)=>typeof hook?.command==='string'&&(/gstack-codex-runtime-health/.test(hook.command)||/ensure-gstack-model\.sh/.test(hook.command));
export function updateCodexHook(file:string,action:'install'|'uninstall'|'check'){
  const doc=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{hooks:{}};doc.hooks??={};const groups=Array.isArray(doc.hooks.SessionStart)?doc.hooks.SessionStart:[];const managed=groups.flatMap((g:any)=>(g.hooks||[]).filter(isManagedGstackHook).map((h:any)=>({g,h})));
  if(action==='check')return managed.length===1&&managed[0].g.matcher===descriptor.matcher&&JSON.stringify(managed[0].h)===JSON.stringify(descriptor.handler);
  let installed=false;const rewritten=groups.flatMap((g:any)=>{if(!Array.isArray(g.hooks))return[g];const hooks=g.hooks.flatMap((h:any)=>{if(!isManagedGstackHook(h))return[h];if(action==='install'&&!installed){installed=true;return[descriptor.handler]}return[]});return hooks.length?[{...g,hooks}]:[]});
  if(action==='install'&&!installed)rewritten.push({matcher:descriptor.matcher,hooks:[descriptor.handler]});if(rewritten.length)doc.hooks.SessionStart=rewritten;else delete doc.hooks.SessionStart;
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,`${JSON.stringify(doc,null,2)}\n`,{mode:0o600});fs.renameSync(temp,file);return true;
}
if(import.meta.main){const action=process.argv[2] as any,file=process.argv[3]||path.join(process.env.CODEX_HOME||path.join(process.env.HOME||'','.codex'),'hooks.json');if(!updateCodexHook(file,action))process.exit(1);}
