import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { installFakeBrain } from "./helpers/fake-gbrain-brain";
import { MAX_TIMELINE_PAGE_BYTES, timelinePageFits } from "../lib/memory-ingest-timeline";
const script = join(import.meta.dir, "../bin/gstack-memory-ingest.ts");
describe("complete project timeline ingestion", () => {
  let home: string, root: string, state: string, env: Record<string, string>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "timeline-")); root = join(home, ".gstack");
    state = join(root, ".transcript-ingest-state.json");
    mkdirSync(join(home, "bin")); mkdirSync(root);
    env = { HOME: home, GSTACK_HOME: root, PATH: `${home}/bin:/usr/bin:/bin` };
    writeFileSync(join(home, "bin/gbrain"), `#!${process.execPath}
import {appendFileSync,readFileSync,readdirSync,statSync,writeFileSync} from 'fs';
import {join} from 'path';
const a=process.argv.slice(2); appendFileSync(join(process.env.HOME,'calls'),JSON.stringify(a)+'\\n');
if(a[0]==='--help') console.log('  import <dir>');
else if(a[0]==='doctor') console.log(JSON.stringify({engine:'pglite'}));
else if(a[0]==='import') {
 const pages=[]; function walk(d){ for(const n of readdirSync(d)){const p=join(d,n); if(statSync(p).isDirectory())walk(p);else if(n.endsWith('.md'))pages.push(readFileSync(p,'utf8'));}} walk(a[1]);
 writeFileSync(join(process.env.HOME,'pages'),JSON.stringify(pages));
 if(process.env.MUTATE)appendFileSync(process.env.MUTATE,'changed');
 if(process.env.REFUSE) process.exit(1);
 console.log(JSON.stringify({status:'ok',imported:pages.length,skipped:0,errors:0,total_files:pages.length}));
} else process.exit(2);
`, {mode: 0o700});
  });
  afterEach(() => rmSync(home, {recursive:true,force:true}));
  function timeline(project: string, raw: string): string {
    const dir=join(root,'projects',project);mkdirSync(dir,{recursive:true});const path=join(dir,'timeline.jsonl');writeFileSync(path,raw);return path;
  }
  function run(extra: string[] = [], more: Record<string,string> = {}) {
    const result = spawnSync(process.execPath,[script,'--incremental','--sources','timeline',...extra],{env:{...env,...more},encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
    return result;
  }
  function pages(): string[] {return JSON.parse(readFileSync(join(home,'pages'),'utf8'));}
  function entry(path: string) { return JSON.parse(readFileSync(state,'utf8')).sessions[path]; }
  const large = () => Array.from({length:2703},(_,i)=>JSON.stringify({id:i,text:'x'.repeat(170)})).join('\n')+'\n';
  it('keeps all complete JSONL rows including newest beyond the old prefix',()=>{
    const raw=large(),path=timeline('alpha',raw);const r=run(['--project','alpha']);expect(r.status).toBe(0);
    expect(pages()).toHaveLength(1);expect(pages()[0]).toContain(raw);expect(entry(path).timeline_renderer_version).toBe(1);
    expect(entry(path).status).toBe('imported_unverified');
  });
  it('reprocesses old same-hash renderer stamps and then deduplicates',()=>{
    const path=timeline('alpha',large());run();const s=JSON.parse(readFileSync(state,'utf8'));delete s.sessions[path].timeline_renderer_version;s.sessions[path].status='ingested';writeFileSync(state,JSON.stringify(s));
    rmSync(join(home,'pages'));expect(run().status).toBe(0);expect(pages()[0]).toContain('"id":2702');expect(entry(path).timeline_renderer_version).toBe(1);
    rmSync(join(home,'pages'));expect(run().status).toBe(0);expect(existsSync(join(home,'pages'))).toBe(false);
  });
  it('preserves unrelated project state and pending reconciliation',()=>{
    timeline('alpha',large());const other=timeline('beta','{"private":"other"}\n');const prior={mtime_ns:1,sha256:'old',page_slug:'beta/private',status:'imported_unverified',source_id:'other'};
    writeFileSync(state,JSON.stringify({schema_version:2,sessions:{[other]:prior},reconcile:{pending:true},last_full_walk:'unchanged'}));
    expect(run(['--project','alpha']).status).toBe(0);expect(pages()).toHaveLength(1);expect(pages()[0]).not.toContain('other');
    const s=JSON.parse(readFileSync(state,'utf8'));expect(s.sessions[other]).toEqual(prior);expect(s.reconcile).toEqual({pending:true});expect(s.last_full_walk).toBe('unchanged');
  });
  it('separates same-day projects under a custom state root',()=>{
    root=join(home,'custom-state');mkdirSync(root);state=join(root,'.transcript-ingest-state.json');env.GSTACK_HOME=root;
    const a=timeline('alpha','ALPHA'),b=timeline('beta','BETA');expect(run().status).toBe(0);
    expect(pages()).toHaveLength(2);expect(entry(a).page_slug).not.toBe(entry(b).page_slug);
    expect(entry(a).page_slug).toContain('/alpha/');expect(entry(b).page_slug).toContain('/beta/');
  });
  it('keeps all-project default behavior',()=>{timeline('alpha','A');timeline('beta','B');expect(run().status).toBe(0);expect(pages()).toHaveLength(2);});
  it('refuses complete rendered timelines above the conservative byte ceiling without stamping',()=>{
    const path=timeline('alpha','x'.repeat(MAX_TIMELINE_PAGE_BYTES));const r=run();expect(r.status).toBe(0);expect(r.stderr).toContain('timeline-too-large');expect(existsSync(join(home,'pages'))).toBe(false);expect(entry(path)).toBeUndefined();
  });
  it('measures UTF-8 bytes instead of JS code units',()=>{expect(timelinePageFits('😀'.repeat(MAX_TIMELINE_PAGE_BYTES/4))).toBe(true);expect(timelinePageFits('😀'.repeat(MAX_TIMELINE_PAGE_BYTES/4+1))).toBe(false);});
  it('does not stamp a refused import or changed source',()=>{
    const path=timeline('alpha',large());expect(run([], {REFUSE:'1'}).status).toBe(1);expect(entry(path)).toBeUndefined();
    expect(run([], {MUTATE:path}).status).toBe(0);expect(entry(path)).toBeUndefined();
  });
  for(const args of [['--project','../alpha'],['--project','alpha','--sources','learning'],['--project','alpha','--reconcile']]) {
    it(`rejects invalid scoped command ${args.join(' ')}`,()=>{timeline('alpha','A');expect(run(args).status).not.toBe(0);expect(existsSync(state)).toBe(false);});
  }
  it('rejects shared resume and project aliases before side effects',()=>{
    timeline('alpha','A');expect(run(['--project','alpha'],{GSTACK_INGEST_RESUME_DIR:home}).status).not.toBe(0);
    symlinkSync(join(root,'projects/alpha'),join(root,'projects/alias'));
    expect(run(['--project','alias']).status).not.toBe(0);expect(existsSync(state)).toBe(false);
  });
  it('rejects global schema migration in project scope without rewriting state',()=>{
    timeline('alpha','A');const original=JSON.stringify({schema_version:1,sessions:{}});writeFileSync(state,original);
    expect(run(['--project','alpha']).status).not.toBe(0);expect(readFileSync(state,'utf8')).toBe(original);
  });
  it('verifies a full native-shaped get response larger than the default subprocess buffer',()=>{
    const brain=installFakeBrain(home);env.PATH=`${brain.binDir}:/usr/bin:/bin`;
    const fake=join(brain.binDir,'gbrain');
    writeFileSync(fake,readFileSync(fake,'utf8').replace('brain.pages[source][slug] = { sha };','brain.pages[source][slug] = { sha, body };').replace('slug: args[1], source_id: source,','slug: args[1], body: page.body, source_id: source,'));
    const path=timeline('alpha',large().repeat(4));expect(run(['--project','alpha']).status).toBe(0);
    const response=spawnSync(join(brain.binDir,'gbrain'),['get',entry(path).page_slug,'--source-id','default','--json'],{env,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
    expect(response.status).toBe(0);expect(Buffer.byteLength(response.stdout)).toBeGreaterThan(1024*1024);
    expect(entry(path).status).toBe('ingested');expect(entry(path).timeline_renderer_version).toBe(1);
  });
  it('scans the complete tail and withholds a secret-bearing page',()=>{
    timeline('alpha',large()+'TAIL_SYNTHETIC_SECRET');
    writeFileSync(join(home,'bin/gitleaks'),`#!${process.execPath}
import {readFileSync,writeFileSync} from 'fs'; const a=process.argv.slice(2);
if(a[0]==='version'){console.log('8.30.1');process.exit(0);}
const text=readFileSync(a[a.indexOf('--source')+1],'utf8');const report=a[a.indexOf('--report-path')+1];
const hit=text.includes('TAIL_SYNTHETIC_SECRET'); const body=JSON.stringify(hit?[{RuleID:'synthetic',Description:'fixture',StartLine:1,Match:'redacted',Secret:'redacted'}]:[]);
if(report==='/dev/stdout')process.stdout.write(body);else writeFileSync(report,body);process.exit(0);
`,{mode:0o700});
    const r=run(['--scan-secrets']);expect(r.status).toBe(0);expect(existsSync(join(home,'pages'))).toBe(false);expect(r.stderr).toContain('secret-scan match');
  });
});
