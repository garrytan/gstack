#!/usr/bin/env bun
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawnSync } from 'node:child_process';
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const contentHash = (root: string): string | null => {
  const skill = path.join(root, 'SKILL.md'), deps = path.join(root, 'runtime-dependencies.json'), meta = path.join(root, 'agents/openai.yaml');
  return fs.existsSync(skill) && fs.existsSync(deps) ? sha(canonical({ skill: sha(fs.readFileSync(skill)), metadata: fs.existsSync(meta) ? sha(fs.readFileSync(meta)) : null, dependencies: sha(fs.readFileSync(deps)) })) : null;
};
const hashPath = (absolute: string): string => {
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return sha(fs.readFileSync(absolute));
  const rows: string[] = [];
  const walk = (dir: string) => fs.readdirSync(dir).sort().forEach(name => {
    const child = path.join(dir, name); const rel = path.relative(absolute, child); const childStat = fs.lstatSync(child);
    if (childStat.isDirectory()) { rows.push(`D ${rel}`); walk(child); }
    else if (childStat.isSymbolicLink()) rows.push(`L ${rel} ${fs.readlinkSync(child)}`);
    else rows.push(`F ${rel} ${sha(fs.readFileSync(child))}`);
  });
  walk(absolute); return sha(rows.join('\n'));
};
export interface HealthOptions { root?: string; cwd?: string; entrypoint?: string; discoveredSkillsRoot?: string; skipEnvironment?: boolean; allowDirtySource?: boolean; environment?: { versions?: Record<string,string|null>; platform?: string; codexHome?: string; openAIConfigured?: boolean; networkAvailable?: boolean }; }
export function selectRoot(cwd: string, explicit?: string) {
  if (explicit) return { root: path.resolve(explicit), source: 'explicit' as const };
  for (let cursor = path.resolve(cwd);; cursor = path.dirname(cursor)) { const local = path.join(cursor,'.agents/skills/gstack'); if (fs.existsSync(local)) return { root: local, source: 'sidecar' as const }; if (path.dirname(cursor) === cursor) break; }
  return { root: path.join(os.homedir(),'.codex/skills/gstack'), source: 'global' as const };
}
export function satisfiesVersion(value: string, range?: string) { if (!range) return true; const a=value.match(/(\d+)\.(\d+)\.(\d+)/), b=range.match(/^>=(\d+)\.(\d+)\.(\d+)$/); if(!a||!b)return false; for(const i of [1,2,3]){if(+a[i]!==+b[i])return +a[i]>+b[i];} return true; }
export function verifyCodexRuntime(options: HealthOptions = {}) {
  const selected=selectRoot(options.cwd||process.cwd(),options.root); const checks:any[]=[]; const check=(id:string,ok:boolean,detail:string)=>checks.push({id,status:ok?'pass':'fail',detail});
  const contractFile=path.join(selected.root,'runtime/codex-runtime-contract.json'), receiptFile=path.join(selected.root,'.gstack-install.json'); let contract:any,receipt:any;
  try { contract=JSON.parse(fs.readFileSync(contractFile,'utf8')); check('contract-present',true,contract.contract_version); } catch { check('contract-present',false,'missing/malformed'); }
  try { receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8')); check('receipt-present',true,receipt.selected_installation_digest); } catch { check('receipt-present',false,'missing/malformed'); }
  if (contract&&receipt) {
    for (const key of ['capability_registry_digest','runtime_asset_digest','release_artifact_digest']) check(`receipt:${key}`,receipt[key]===contract.identifiers[key],'digest binding');
    for (const asset of contract.assets) {
      if (asset.destination === 'runtime/codex-runtime-contract.json') continue;
      const installed = path.join(selected.root, asset.destination);
      if (!fs.existsSync(installed)) { check(`asset:${asset.destination}`, !!asset.optional, 'missing'); continue; }
      const actual = hashPath(installed);
      check(`asset-receipt:${asset.destination}`, receipt.asset_hashes?.[asset.destination] === actual, 'installed bytes');
      if (asset.content_sha256) check(`asset-contract:${asset.destination}`, asset.content_sha256 === actual, 'release bytes');
    }
    const entry=options.entrypoint ? contract.entrypoints.find((e:any)=>e.source_skill===options.entrypoint||e.name===options.entrypoint||e.name===`gstack-${options.entrypoint}`):null;
    if (options.entrypoint) check('entrypoint',!!entry,entry?.name||'unknown');
    const roots=entry?[entry]:contract.entrypoints; const embeddedRoot=path.dirname(selected.root);
    for (const e of roots) {
      const entryRoot=e.name==='gstack'?selected.root:path.join(embeddedRoot,e.name); check(`entrypoint:${e.name}`,contentHash(entryRoot)===e.content_sha256,'content/overlay');
      const text=fs.existsSync(path.join(entryRoot,'SKILL.md'))?fs.readFileSync(path.join(entryRoot,'SKILL.md'),'utf8'):''; check(`overlay:${e.name}`,/MODEL_OVERLAY:\s*gpt\b/.test(text),'MODEL_OVERLAY: gpt');
      for (const d of e.dependencies.filter((d:any)=>d.required)) { const base=d.kind==='generated-entrypoint'?embeddedRoot:selected.root; check(`dependency:${e.name}:${d.destination}`,fs.existsSync(path.join(base,d.destination)),d.kind); }
    }
    if (receipt.source_root&&fs.existsSync(receipt.source_root)) { const rev=spawnSync('git',['-C',receipt.source_root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(); const dirty=spawnSync('git',['-C',receipt.source_root,'status','--porcelain'],{encoding:'utf8'}).stdout.trim(); check('source-commit',rev===receipt.source_commit,'immutable source'); if(!options.allowDirtySource)check('source-clean',!dirty&&receipt.source_clean,'clean source'); }
    if (!options.skipEnvironment) for (const id of new Set(entry?[...entry.requirements.inherited,...entry.requirements.explicit]:[])) {
      const req=contract.requirements.find((r:any)=>r.id===id); if(!req){check(`requirement:${id}`,false,'undeclared');continue;}
      if(req.kind==='executable-version'){const name=req.names.find((n:string)=>(options.environment?.versions?.[n]??spawnSync(n,['--version'],{encoding:'utf8'}).stdout));const version=name?(options.environment?.versions?.[name]??spawnSync(name,['--version'],{encoding:'utf8'}).stdout):'';check(`requirement:${id}`,!!version&&satisfiesVersion(version,req.versionRange),version||'absent');}
      else if(id==='codex-auth-config'){const home=options.environment?.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');check(`requirement:${id}`,fs.existsSync(path.join(home,'config.toml'))&&(fs.existsSync(path.join(home,'auth.json'))||!!options.environment?.openAIConfigured),'config/auth');}
      else if(id==='openai-image-config')check(`requirement:${id}`,options.environment?.openAIConfigured??!!process.env.OPENAI_API_KEY,'configured');
      else if(req.kind==='platform')check(`requirement:${id}`,req.platforms.includes(options.environment?.platform||process.platform),'platform');
      else if(req.kind==='network')check(`requirement:${id}`,options.environment?.networkAvailable??spawnSync('curl',['-sS','-o','/dev/null','--max-time','5','https://github.com']).status===0,'network');
      else if(id==='filesystem-trust'){try{fs.accessSync(selected.root,fs.constants.R_OK);fs.accessSync(path.join(selected.root,'bin'),fs.constants.R_OK|fs.constants.X_OK);check(`requirement:${id}`,true,'permissions');}catch{check(`requirement:${id}`,false,'permissions');}}
      else if(id==='browser-runtime'){try{fs.accessSync(path.join(selected.root,'browse/dist/browse'),fs.constants.X_OK);check(`requirement:${id}`,true,'browser');}catch{check(`requirement:${id}`,false,'browser');}}
    }
  }
  return {ok:!checks.some(c=>c.status==='fail'),selected_root:selected.root,root_source:selected.source,checks};
}
