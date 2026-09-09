import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAutoplanArtifactRecorder, recordAutoplanArtifact, readPendingAutoplanArtifact,
  autoplanArtifactRecorderStatus } from './helpers/autoplan-artifact-recorder';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

// Synthetic hook envelopes and owned temp paths. The live pending hook envelope
// was unpublished; these controls do not reconstruct it or provide paid coverage.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-' quote $()-"));
  const cwd = path.join(root, 'repo with spaces'), config = path.join(root, 'config');
  const stateRoot = path.join(root, 'home', '.gstack');
  const project = path.join(config, 'projects', 'fixture');
  const plans = path.join(stateRoot, 'projects', path.basename(cwd), 'ceo-plans');
  fs.mkdirSync(cwd, {recursive:true}); fs.mkdirSync(project, {recursive:true}); fs.mkdirSync(plans, {recursive:true});
  const session = 'synthetic-parent-session', transcript = path.join(project, session+'.jsonl');
  fs.writeFileSync(transcript, '');
  const artifact = path.join(plans, '2026-09-09-reviewed-plan.md');
  fs.writeFileSync(artifact, 'Prior retained behavior.\n');
  const startedAt = Date.now()-10;
  const recorder = createAutoplanArtifactRecorder(cwd,config,stateRoot);
  const event = (kind='PreToolUse',toolUseId='toolu_pending') => ({hook_event_name:kind,tool_name:'Edit',
    session_id:session,tool_use_id:toolUseId,cwd,transcript_path:transcript,
    tool_input:{file_path:artifact,old_string:'BODY_OLD_SENTINEL',new_string:'BODY_NEW_SENTINEL'}});
  const write = (input:unknown) => recordAutoplanArtifact(typeof input==='string' ? input : JSON.stringify(input),recorder.file,cwd,config,stateRoot);
  const history:NativePublicToolEvent[] = [
    {kind:'use',sessionId:session,toolUseId:'toolu_prior',timestamp:new Date(startedAt).toISOString(),name:'Write',input:{file_path:artifact}},
    {kind:'result',sessionId:session,toolUseId:'toolu_prior',timestamp:new Date(startedAt+1).toISOString(),isError:false},
  ];
  const read = (tools=history,start=startedAt,now=Date.now()) => readPendingAutoplanArtifact(recorder.file,cwd,config,stateRoot,start,tools,now);
  const status = () => autoplanArtifactRecorderStatus(recorder.file,cwd,config,stateRoot);
  return {root,cwd,config,stateRoot,project,session,transcript,artifact,startedAt,recorder,event,write,history,read,status,
    dispose:()=>{recorder.dispose();fs.rmSync(root,{recursive:true,force:true})}};
}

describe('owned Autoplan pending artifact metadata recorder',()=>{
  test('pending authority is metadata only, with no body, result, success or phase evidence',()=>{
    const f=fixture();try{
      expect(f.status()).toEqual({status:'idle'});expect(f.read()).toBeUndefined();
      const e=f.event() as ReturnType<typeof f.event> & {tool_response?:unknown};e.tool_response={content:'RESULT_SENTINEL'};f.write(e);
      expect(f.read()).toEqual({source:'pre_tool_use',sessionId:f.session,toolUseId:'toolu_pending',tool:'Edit',file:f.artifact,timestamp:expect.any(String)});
      const raw=fs.readFileSync(f.recorder.file,'utf8');
      for(const secret of ['BODY_OLD_SENTINEL','BODY_NEW_SENTINEL','RESULT_SENTINEL','old_string','new_string','tool_response'])expect(raw).not.toContain(secret);
      expect(Object.keys(JSON.parse(raw).pending).sort()).toEqual(['file','sessionId','source','timestamp','tool','toolUseId','transcriptPath'].sort());
      expect(fs.statSync(f.recorder.file).mode&0o777).toBe(0o600);
    }finally{f.dispose()}
  });
  test.each(['PostToolUse','PostToolUseFailure'])('%s closes and tombstones without creating successful native history',kind=>{
    const f=fixture();try{
      f.write(f.event());expect(f.read()).toBeDefined();f.write(f.event(kind));expect(f.status()).toEqual({status:'idle'});expect(f.read()).toBeUndefined();
      f.write(f.event());expect(f.read()).toBeUndefined();f.write(f.event('PreToolUse','toolu_next'));expect(f.read()?.toolUseId).toBe('toolu_next');
      expect(f.history).toHaveLength(2);
    }finally{f.dispose()}
  });
  test('same pending replay never refreshes time; earlier completion cannot reopen',()=>{
    const f=fixture();try{
      f.write(f.event('PostToolUse','toolu_older'));
      f.write(f.event());const before=fs.readFileSync(f.recorder.file,'utf8');f.write(f.event());expect(fs.readFileSync(f.recorder.file,'utf8')).toBe(before);
      f.write(f.event('PostToolUse','toolu_older'));expect(f.read()?.toolUseId).toBe('toolu_pending');
      f.write(f.event('PreToolUse','toolu_older'));expect(f.read()?.toolUseId).toBe('toolu_pending');
      f.write(f.event('PostToolUse'));f.write(f.event('PreToolUse','toolu_older'));expect(f.read()).toBeUndefined();
    }finally{f.dispose()}
  });
  test.each(['cwd','session','subagent'])('foreign %s cannot clear, replace or poison an owned parent',kind=>{
    const f=fixture();try{
      f.write(f.event());const before=fs.readFileSync(f.recorder.file,'utf8');
      for(const hook of ['PreToolUse','PostToolUse','PostToolUseFailure']){
        const e:Record<string,unknown>=f.event(hook,'toolu_foreign');
        if(kind==='cwd')e.cwd=path.join(f.root,'foreign');
        if(kind==='session'){e.session_id='foreign-session';e.transcript_path=path.join(f.project,'foreign-session.jsonl');fs.writeFileSync(e.transcript_path as string,'')}
        if(kind==='subagent')e.agent_id='child-agent';
        f.write(e);expect(f.status().status).toBe('pending');expect(fs.readFileSync(f.recorder.file,'utf8')).toBe(before);
      }
    }finally{f.dispose()}
  });
  test('only allowlisted Edit can become pending; foreign concurrent mutation invalidates ambiguity',()=>{
    for(const kind of ['Write','unowned','different-id','different-path']){
      const f=fixture();try{
        const e=f.event('PreToolUse',kind==='different-id'?'toolu_other':'toolu_pending');
        if(kind==='Write')e.tool_name='Write';
        if(kind==='unowned')e.tool_input.file_path=path.join(f.stateRoot,'config');
        if(kind==='different-path'){e.tool_input.file_path=path.join(path.dirname(f.artifact),'2026-09-09-other.md');fs.writeFileSync(e.tool_input.file_path,'old')}
        if(kind==='Write'||kind==='unowned'){f.write(e);expect(f.status().status).toBe('idle')}
        f.write(f.event());f.write(e);expect(f.status().status).toBe('invalid');expect(f.read()).toBeUndefined();
        f.write(f.event('PostToolUse'));f.write(f.event('PreToolUse','toolu_later'));expect(f.status().status).toBe('invalid');
      }finally{f.dispose()}
    }
  });
  test.each(['same-file','foreign-path'])('unseen mutation completion on %s invalidates a pending request',target=>{
    const f=fixture();try{
      f.write(f.event());const e=f.event('PostToolUse','toolu_unseen');
      if(target==='foreign-path')e.tool_input.file_path=path.join(f.stateRoot,'config');
      f.write(e);expect(f.status().status).toBe('invalid');expect(f.read()).toBeUndefined();
    }finally{f.dispose()}
  });
  test('malformed owned requests fail closed without persisting their contents',()=>{
    for(const kind of ['bad-json','missing-cwd','outside-transcript','wrong-tool','empty-old','same-body','replace-all','oversized']){
      const f=fixture();try{
        const e:Record<string,any>=f.event();
        if(kind==='missing-cwd')delete e.cwd;
        if(kind==='outside-transcript'){e.transcript_path=path.join(f.root,f.session+'.jsonl');fs.writeFileSync(e.transcript_path,'')}
        if(kind==='wrong-tool')e.tool_name='Read';
        if(kind==='empty-old')e.tool_input.old_string='';
        if(kind==='same-body')e.tool_input.new_string=e.tool_input.old_string;
        if(kind==='replace-all')e.tool_input.replace_all=true;
        if(kind==='oversized')e.tool_input.new_string='x'.repeat(4*1024*1024);
        f.write(kind==='bad-json'?'{not-json':e);expect(f.status().status).toBe('invalid');expect(f.read()).toBeUndefined();
        expect(fs.readFileSync(f.recorder.file,'utf8')).not.toContain('BODY_NEW_SENTINEL');
      }finally{f.dispose()}
    }
  });
  test('read binds actual session, interval and published identity precedence',()=>{
    const f=fixture();try{
      f.write(f.event());expect(f.read()).toBeDefined();
      expect(f.read([],f.startedAt)).toBeUndefined();
      expect(f.read(f.history.map(e=>({...e,sessionId:'other'})))).toBeUndefined();
      expect(f.read([...f.history,{...f.history[0]!,sessionId:'other'}])).toBeUndefined();
      expect(f.read(f.history,Date.now()+1000)).toBeUndefined();expect(f.read(f.history,f.startedAt,f.startedAt)).toBeUndefined();
      for(const kind of ['use','result'] as const)expect(f.read([...f.history,{kind,sessionId:f.session,toolUseId:'toolu_pending',timestamp:new Date().toISOString()}])).toBeUndefined();
      expect(readPendingAutoplanArtifact(undefined,f.cwd,f.config,f.stateRoot,f.startedAt,f.history)).toBeUndefined();
      expect(readPendingAutoplanArtifact(f.recorder.file,f.cwd,null,f.stateRoot,f.startedAt,f.history)).toBeUndefined();
      expect(readPendingAutoplanArtifact(f.recorder.file,f.cwd,f.config,path.join(f.root,'other'),f.startedAt,f.history)).toBeUndefined();
    }finally{f.dispose()}
  });
  test.each([NaN, Infinity])('a non-finite reader clock %s cannot supply pending authority',now=>{
    const f=fixture();try{f.write(f.event());expect(f.read(f.history,f.startedAt,now)).toBeUndefined()}finally{f.dispose()}
  });
  test('busy, oversized, symlinked and exhausted state cannot supply authority',()=>{
    for(const kind of ['busy','oversized','symlinked','exhausted']){
      const f=fixture();try{
        f.write(f.event());
        if(kind==='busy')fs.writeFileSync(f.recorder.file+'.lock','');
        if(kind==='oversized')fs.writeFileSync(f.recorder.file,' '.repeat(64*1024+1));
        if(kind==='symlinked'){const backup=f.recorder.file+'.backup';fs.renameSync(f.recorder.file,backup);fs.symlinkSync(backup,f.recorder.file)}
        if(kind==='exhausted'){f.write(f.event('PostToolUse'));const s=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));s.seenIds=Array.from({length:128},(_,i)=>'toolu_'+i);fs.writeFileSync(f.recorder.file,JSON.stringify(s));f.write(f.event('PreToolUse','toolu_overflow'))}
        expect(f.read()).toBeUndefined();expect(f.status().status).toBe(kind==='busy'?'busy':'invalid');
      }finally{f.dispose()}
    }
  });
  test('all generated hook commands are bounded, correctly quoted and silent',()=>{
    const f=fixture();try{
      expect(Object.keys(f.recorder.hooks).sort()).toEqual(['PostToolUse','PostToolUseFailure','PreToolUse']);
      for(const kind of ['PreToolUse','PostToolUse','PostToolUseFailure'] as const){
        const entries=f.recorder.hooks[kind];expect(entries).toHaveLength(1);expect(entries[0]!.matcher).toBe('^(Write|Edit)$');
        const hook=entries[0]!.hooks[0]!;expect(hook.timeout).toBe(5);
        for(const input of [JSON.stringify(f.event(kind)),'{broken']){
          const child=spawnSync('bash',['-c',hook.command],{cwd:f.cwd,input,encoding:'utf8',timeout:6000});
          expect(child.error).toBeUndefined();expect(child.status).toBe(0);expect(child.stdout).toBe('');expect(child.stderr).toBe('');
        }
      }
    }finally{f.dispose()}
  });
  test('a hook without input EOF exits silently within its internal timeout',async()=>{
    const f=fixture(),hook=f.recorder.hooks.PreToolUse[0]!.hooks[0]!;
    const child=Bun.spawn(['bash','-c','exec '+hook.command],{cwd:f.cwd,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    let forced=false;const timer=setTimeout(()=>{forced=true;child.kill('SIGKILL')},6000);
    try{
      const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(forced).toBe(false);expect(code).toBe(0);expect(out).toBe('');expect(err).toBe('');
      expect(f.status()).toEqual({status:'invalid',reason:'stdin_timeout'});
    }finally{clearTimeout(timer);child.stdin.end();if(child.exitCode===null){child.kill('SIGKILL');await child.exited}f.dispose()}
  },7000);
  test('recorder disposal removes all owned state and the new inputs select only Autoplan',()=>{
    const f=fixture();f.write(f.event());f.dispose();expect(fs.existsSync(f.recorder.file)).toBe(false);
    for(const file of ['test/helpers/autoplan-artifact-recorder.ts','test/autoplan-artifact-recorder.test.ts','test/autoplan-pending-artifact.test.ts','test/fixtures/autoplan-pending-artifact-ae.json'])
      expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
  });
});
