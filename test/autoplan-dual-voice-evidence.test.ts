import {afterEach, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareMethodology, createSnapshot} from '../bin/gstack-autoplan-snapshot';
import {autoplanDualVoiceEvidence, loadAutoplanDualCommandContract} from './helpers/autoplan-dual-voice-evidence';
import captured from './fixtures/autoplan-dual-false-positive-6bd.json';
const ROOT=resolve(import.meta.dir,'..'), owned:string[]=[];
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
afterEach(()=>{for(const dir of owned.splice(0))rmSync(dir,{recursive:true,force:true});});
const use=(id:string,name:string,input:any,session='parent')=>({type:'assistant',session_id:session,message:{content:[{type:'tool_use',id,name,input}]}});
const ack=(id:string,content:string,is_error=false,session='parent')=>({type:'user',session_id:session,message:{content:[{type:'tool_result',tool_use_id:id,content,is_error}]}});
function fixture(plan?:string){
 const dir=mkdtempSync(join(tmpdir(),'autoplan-dual-evidence-'));owned.push(dir);
 const active=join(dir,'active.md'),restore=join(dir,'restore.md');
 writeFileSync(active,'## Implementation plan\n'+(plan??'# Greet\nPrint hello.\n\n')+'## Review record\n');writeFileSync(restore,plan??'# Greet\nPrint hello.\n');
 const method=prepareMethodology('ceo',join(ROOT,'plan-ceo-review/SKILL.md'),restore);
 const snapshot=createSnapshot('ceo',active,restore,method.methodologyPath);
 const commands=loadAutoplanDualCommandContract(ROOT);
 const file=join(dir,'outside-prompt.md'),body='You are a CEO/founder advisor reviewing a development plan.\nFile: '+snapshot.snapshotPath+'\n'+readFileSync(snapshot.snapshotPath,'utf8');
 writeFileSync(file,body);
 const events=[use('probe','Bash',{command:commands.probe}),ack('probe','MODEL_OK\nCODEX_MODE: ready'),
 use('native','Agent',{prompt:snapshot.nativeDispatchPrompt}),ack('native','INPUT: ceo '+snapshot.sha256+'\nReview findings.'),
 use('write','Write',{file_path:file,content:body}),ack('write','File created successfully.'),
 use('outside','Bash',{command:commands.outside.replace("'<prepared-prompt-file>'","'"+file+"'")}),
 ack('outside','Recommendation: proceed because the existing generator covers registration.\nOUTSIDE_STATUS: completed provider=codex host=claude')];
 const options={ownedRoots:[dir],cwd:dir,activePlan:active,methodologySha256:method.sha256,commands};
 return {dir,method,snapshot,file,events,options,read:(rows=events)=>autoplanDualVoiceEvidence(rows,options)};
}
test('actual6bd source Read, unused probe branch and0Hspec Agent earn zero phase voice credit',()=>{
 const f=fixture(),actual=f.read(clone(captured.events));
 expect(actual).toMatchObject({claudeVoiceFired:false,codexVoiceFired:false,codexUnavailable:false,reviewDispatched:false,probeMode:'ready'});
});
test('actual snapshot producer and complete parent request/ACK pairs establish both voices',()=>{
 const f=fixture();expect(f.read()).toMatchObject({claudeVoiceFired:true,codexVoiceFired:true,codexUnavailable:false,reviewDispatched:true,nativeToolUseId:'native',outsideToolUseId:'outside'});
});
test.each(['not_installed','not_authed','broken_install','model_unusable'])('actual final probe result supports unavailable fallback: %s',mode=>{
 const f=fixture();f.events.splice(4);f.events[1]=ack('probe','CODEX_MODE: '+mode);
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexVoiceFired:false,codexUnavailable:true});
});
test.each(['ready','disabled','under_codex','unknown'])('probe outcome supplies no unavailable credit: %s',mode=>{
 const f=fixture();f.events.splice(4);f.events[1]=ack('probe','CODEX_MODE: '+mode);expect(f.read().codexUnavailable).toBe(false);
});
test.each(['missing','error','foreign','child','unowned','method','phase','math','no-launch','wrong-input','mutable'])('native dispatch rejects %s evidence',kind=>{
 const f=fixture();
 if(kind==='missing')f.events.splice(3,1);
 if(kind==='error')f.events[3]=ack('native','INPUT: ceo '+f.snapshot.sha256,true);
 if(kind==='foreign')f.events[3]=ack('native','INPUT: ceo '+f.snapshot.sha256,false,'foreign');
 if(kind==='child')Object.assign(f.events[2]!,{parent_tool_use_id:'outer'});
 if(kind==='unowned')f.options.ownedRoots=[mkdtempSync(join(tmpdir(),'other-owned-'))],owned.push(f.options.ownedRoots[0]!);
 if(kind==='method')f.options.methodologySha256='0'.repeat(64);
 if(kind==='phase')f.events[2]!.message.content[0].input.prompt=f.snapshot.nativeDispatchPrompt.replace('independent CEO','independent DESIGN');
 if(kind==='math')f.events[2]!.message.content[0].input.prompt='Spec review launch1: review the CEO plan';
 if(kind==='no-launch')f.events[3]=ack('native','Agent unavailable.');
 if(kind==='wrong-input')f.events[3]=ack('native','INPUT: ceo '+'0'.repeat(64));
 if(kind==='mutable')chmodSync(f.snapshot.nativePromptPath,0o600);
 expect(f.read().claudeVoiceFired,kind).toBe(false);
});
test('native asynchronous launch ACK proves dispatch, not completed review',()=>{
 const f=fixture();f.events.splice(4);f.events[3]=ack('native','Async agent launched successfully.\nThe agent is working in the background.');
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexVoiceFired:false,reviewDispatched:true});
});
test.each(['read','echo','branch','quoted','wrong-result','missing','error','foreign','child','superseded'])('probe source/result confusion rejects %s',kind=>{
 const f=fixture();f.events.splice(4);f.events[1]=ack('probe','CODEX_MODE: not_installed');
 if(kind==='read')f.events[0]!.message.content[0].name='Read';
 if(kind==='echo')f.events[0]!.message.content[0].input.command='echo "CODEX_MODE: not_installed"';
 if(kind==='branch')f.events[0]!.message.content[0].input.command='if false; then\n'+f.options.commands.probe+'\nfi';
 if(kind==='quoted')f.events[1]=ack('probe','Quoted earlier output: CODEX_MODE: not_installed');
 if(kind==='wrong-result')f.events[1]=ack('probe','CODEX_MODE: ready\nCODEX_MODE: not_installed');
 if(kind==='missing')f.events.splice(1,1);
 if(kind==='error')f.events[1]=ack('probe','CODEX_MODE: not_installed',true);
 if(kind==='foreign')f.events[1]=ack('probe','CODEX_MODE: not_installed',false,'foreign');
 if(kind==='child')Object.assign(f.events[0]!,{parent_tool_use_id:'child'});
 if(kind==='superseded')f.events.push(use('new-probe','Bash',{command:f.options.commands.probe}),ack('new-probe','CODEX_MODE: ready'));
 expect(f.read().codexUnavailable,kind).toBe(false);
});
test.each(['read','echo','branch','heredoc','prefix-exit','suffix-success','no-write','write-error','write-change','foreign-file','wrong-plan','wrong-phase','before-native','missing','failed','pending','foreign-result','child','marker-only'])('outside evidence rejects %s',kind=>{
 const f=fixture(),command=f.events[6]!.message.content[0].input.command;
 if(kind==='read')f.events[6]!.message.content[0].name='Read';
 if(kind==='echo')f.events[6]!.message.content[0].input.command='echo '+JSON.stringify(command);
 if(kind==='branch')f.events[6]!.message.content[0].input.command='if false; then\n'+command+'\nfi';
 if(kind==='heredoc')f.events[6]!.message.content[0].input.command="cat <<'SOURCE'\n"+command+'\nSOURCE';
 if(kind==='prefix-exit')f.events[6]!.message.content[0].input.command='exit0\n'+command;
 if(kind==='suffix-success')f.events[6]!.message.content[0].input.command=command+'\ntrue';
 if(kind==='no-write')f.events.splice(4,2);
 if(kind==='write-error')f.events[5]=ack('write','Denied',true);
 if(kind==='write-change')f.events.splice(6,0,use('edit','Edit',{file_path:f.file,new_string:'Different plan'}),ack('edit','Updated'));
 if(kind==='foreign-file')f.events[4]!.message.content[0].input.file_path='/tmp/foreign-prompt';
 if(kind==='wrong-plan')f.events[4]!.message.content[0].input.content='You are a CEO/founder advisor reviewing a development plan.\nFile: '+f.snapshot.snapshotPath+'\nDifferent plan';
 if(kind==='wrong-phase')f.events[4]!.message.content[0].input.content=f.events[4]!.message.content[0].input.content.replace('CEO/founder','Design');
 if(kind==='before-native'){const pairs=f.events.splice(6);f.events.splice(2,0,...pairs);}
 if(kind==='missing')f.events.pop();
 if(kind==='failed')f.events[7]=ack('outside','OUTSIDE_STATUS: completed provider=codex host=claude',true);
 if(kind==='pending')f.events[7]=ack('outside','Command running in background with ID: pending. Output is being written to: /tmp/tasks/pending.output. You will be notified when it completes. To check interim output, use Read on that file path.');
 if(kind==='foreign-result')f.events[7]=ack('outside','OUTSIDE_STATUS: completed provider=codex host=claude',false,'foreign');
 if(kind==='child')Object.assign(f.events[6]!,{parent_tool_use_id:'child'});
 if(kind==='marker-only')f.events[6]!.message.content[0].input.command='echo "OUTSIDE_STATUS: completed provider=codex host=claude"';
 expect(f.read().codexVoiceFired,kind).toBe(false);
});
test('an optional literal fixture cd and removed source comments preserve executable contract',()=>{
 const f=fixture();for(const index of [0,6]){const input=f.events[index]!.message.content[0].input;input.command='cd '+f.dir+'\n'+input.command.split('\n').filter((s:string)=>!s.trim().startsWith('#')).join('\n');}
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexVoiceFired:true,probeMode:'ready'});
});
test('conflicting same-ID public requests/results fail closed',()=>{
 const f=fixture();f.events.push(ack('outside','Changed output'));expect(f.read().codexVoiceFired).toBe(false);
});
test('private/unknown blocks and parent prose cannot supply any missing evidence',()=>{
 const f=fixture();const rows:any[]=[{type:'assistant',session_id:'parent',message:{content:[{type:'thinking',thinking:'Agent codex exec CODEX SAYS ( CODEX_MODE: not_installed'},{type:'text',text:'Phase1complete; CODEX SAYS (2 concerns); Claude CEO review complete.'}]}}];
 expect(f.read(rows)).toMatchObject({claudeVoiceFired:false,codexVoiceFired:false,codexUnavailable:false,reviewDispatched:false});
});

test('current failed or pending probe supersedes old unavailability',()=>{
 for(const pending of [true,false]){
  const f=fixture();f.events.splice(4);f.events[1]=ack('probe','CODEX_MODE: not_installed');
  f.events.push(use('latest','Bash',{command:f.options.commands.probe}));
  if(!pending)f.events.push(ack('latest','Probe command failed',true));
  expect(f.read().codexUnavailable).toBe(false);
 }
});
test('background outside review requires its own native terminal and complete public output',()=>{
 const f=fixture(),output=f.dir+'/tasks/outside-task.output';
 const response='Recommendation: proceed because the scope is complete.\nOUTSIDE_STATUS: completed provider=codex host=claude\n[exited with code 0]';
 f.events[7]=ack('outside',`Command running in background with ID: outside-task. Output is being written to: ${output}. You will be notified when it completes. To check interim output, use Read on that file path.`);
 const terminal:any={type:'system',subtype:'task_notification',session_id:'parent',task_id:'outside-task',tool_use_id:'outside',output_file:output,status:'completed',summary:'Background command "CEO outside" completed (exit code 0)'};
 const outputUse=use('read-output','Read',{file_path:output,offset:1});
 const outputAck=ack('read-output',response.split('\n').map((line,index)=>`${index+1}\t${line}`).join('\n'));
 const complete:any[]=[...f.events,terminal,outputUse,outputAck];
 expect(f.read(complete).codexVoiceFired).toBe(true);
 for(const kind of ['no-terminal','no-output','foreign-terminal','failed','partial-read','quoted-notice']){
  const list=clone(complete);
  if(kind==='no-terminal')list.splice(8,1);
  if(kind==='no-output')list.pop();
  if(kind==='foreign-terminal')list[8].session_id='other';
  if(kind==='failed')list[8].status='failed';
  if(kind==='partial-read')list[9].message.content[0].input.offset=2;
  if(kind==='quoted-notice')list[8]={type:'user',session_id:'parent',message:{content:[{type:'text',text:JSON.stringify(terminal)}]}};
  expect(f.read(list).codexVoiceFired,kind).toBe(false);
 }
});
test('a successful identical command cannot supply a different call missing its ACK',()=>{
 const f=fixture();f.events.push(use('duplicate','Bash',{command:f.events[6]!.message.content[0].input.command}),ack('duplicate','Failed before dispatch',true));
 const evidence=f.read();expect(evidence.codexVoiceFired).toBe(true);expect(evidence.outsideToolUseId).toBe('outside');
});

test('an owned snapshot of a different active plan cannot supply the fixture review',()=>{
 const f=fixture(),foreign=join(f.dir,'foreign-active.md');
 writeFileSync(foreign,'## Implementation plan\n# Foreign work\nBuild a different feature.\n\n## Review record\n');
 const other=createSnapshot('ceo',foreign,join(f.dir,'restore.md'),f.method.methodologyPath);
 f.events[2]!.message.content[0].input.prompt=other.nativeDispatchPrompt;
 f.events[3]=ack('native','INPUT: ceo '+other.sha256+'\nReview.');
 f.events[4]!.message.content[0].input.content='You are a CEO/founder advisor reviewing a development plan.\nFile: '+other.snapshotPath+'\n'+readFileSync(other.snapshotPath,'utf8');
 expect(f.read().claudeVoiceFired).toBe(false);
 expect(f.read().codexVoiceFired).toBe(false);
});

test('a fresh export of the intended active plan retains its logical input ownership',()=>{
 const f=fixture();
 writeFileSync(f.options.activePlan,'## Implementation plan\n# Greet\nPrint hello and retain the existing about command.\n\n## Review record\n');
 const fresh=createSnapshot('ceo',f.options.activePlan,join(f.dir,'restore.md'),f.method.methodologyPath);
 f.events[2]!.message.content[0].input.prompt=fresh.nativeDispatchPrompt;
 f.events[3]=ack('native','INPUT: ceo '+fresh.sha256+'\nReview.');
 f.events[4]!.message.content[0].input.content='You are a CEO/founder advisor reviewing a development plan.\nFile: '+fresh.snapshotPath+'\n'+readFileSync(fresh.snapshotPath,'utf8');
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexVoiceFired:true});
});

test.each([
 'Codex outside review unavailable: execution failed; missing coverage. Check the provider diagnosis above.',
 'Outside review unavailable: empty response; missing coverage.',
 'Outside review unavailable: review refused; missing coverage.',
 'Outside review unavailable: missing review completion recommendation; missing coverage.',
])('actual owned post-execution error proves attempted outside voice, not completion: %s',diagnostic=>{
 const f=fixture();f.events[7]=ack('outside','Exit code 1\n'+diagnostic,true);
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexAttempted:true,codexVoiceFired:false,codexUnavailable:true,failedOutsideToolUseId:'outside'});
});
test('pre-execution, arbitrary, copied and unowned failures supply no outside-attempt credit',()=>{
 const marker='Codex outside review unavailable: execution failed; missing coverage. Check the provider diagnosis above.';
 for(const kind of ['generic','harness','source','echo','read','missing-ack','foreign-ack','duplicate-ack','not-error','pending','prepared-missing','source-missing','probe-failure','quoted']){
  const f=fixture();f.events[7]=ack('outside',marker,true);
  if(kind==='generic')f.events[7]=ack('outside','AUTH_FAILED: provider transport unavailable',true);
  if(kind==='harness')f.events[7]=ack('outside','Codex outside review unavailable: harness mismatch; no outside process started.',true);
  if(kind==='source')f.events[6]!.message.content[0].input.command='cat /path/to/source';
  if(kind==='echo')f.events[6]!.message.content[0].input.command='echo '+JSON.stringify(marker);
  if(kind==='read')f.events[6]!.message.content[0].name='Read';
  if(kind==='missing-ack')f.events.pop();
  if(kind==='foreign-ack')f.events[7]=ack('outside',marker,true,'other');
  if(kind==='duplicate-ack')f.events.push(ack('outside','Different error',true));
  if(kind==='not-error')f.events[7]=ack('outside',marker,false);
  if(kind==='pending')f.events[7]=ack('outside','Command running in background with ID: task. Output is being written to: /tmp/tasks/task.output. You will be notified when it completes. To check interim output, use Read on that file path.');
  if(kind==='prepared-missing')f.events[7]=ack('outside','cat: prepared-prompt: No such file or directory',true);
  if(kind==='source-missing')f.events[7]=ack('outside','bash: gstack-codex-probe: No such file or directory',true);
  if(kind==='probe-failure')f.events[6]!.message.content[0].input.command=f.options.commands.probe;
  if(kind==='quoted')f.events[7]=ack('outside','Quoted diagnostic: "'+marker+'"',true);
  expect(f.read().codexAttempted,kind).toBe(false);
  expect(f.read().codexUnavailable,kind).toBe(false);
 }
});

// Availability rechecks may stop before dispatch; they cannot supply a voice.
const configRead=(f:ReturnType<typeof fixture>)=>f.options.commands.probe.split('\n').find(line=>line.startsWith('_CODEX_CFG='))!;
const configStop=(f:ReturnType<typeof fixture>,status=77)=>configRead(f)+`\n[ "$_CODEX_CFG" = "disabled" ] && { echo 'CODEX_MODE: disabled (recheck)'; exit ${status}; }`;
const cliStop="command -v codex >/dev/null 2>&1 || { echo 'CODEX_MODE: not_installed (recheck)' >&2; exit 76; }";
function addGuards(f:ReturnType<typeof fixture>,guards:string,where='after'){
 const input=f.events[6]!.message.content[0].input;
 input.command=where==='before'?guards+'\n'+input.command:input.command.replace('\n_REPO_ROOT=','\n'+guards+'\n_REPO_ROOT=');
}
test.each(['before','after'])('source-bound config and CLI stop forms preserve exact dispatch: %s',where=>{
 for(const kind of ['config','cli','both','reverse','if','if-cli','silent','quoted']){
  const f=fixture();
  const config=configStop(f), cli=cliStop;
  const guards=kind==='config'?config:kind==='cli'?cli:kind==='both'?config+'\n'+cli:kind==='reverse'?cli+'\n'+config:
   kind==='if'?configRead(f)+'\nif [ "$_CODEX_CFG" == disabled ]; then\necho "CODEX_MODE: disabled before dispatch" >&2\nexit 1\nfi':
   kind==='if-cli'?'if ! command -v codex >/dev/null 2>&1; then\necho "CODEX_MODE: not_installed"\nexit 127\nfi':
   kind==='silent'?configRead(f)+'\n[ "$_CODEX_CFG" = disabled ] && { exit 0; }':
   configRead(f)+"\n[ \"$_CODEX_CFG\" = 'disabled' ] && { echo \"CODEX_MODE: disabled\"; exit 255; }";
  addGuards(f,guards,where);
  expect(f.read(),kind).toMatchObject({claudeVoiceFired:true,codexVoiceFired:true,codexAttempted:true,probeMode:'ready'});
 }
});
test('guarded execution still accepts only a literal owned cd and source comments',()=>{
 const f=fixture();addGuards(f,configStop(f));
 f.events[6]!.message.content[0].input.command='cd "'+f.dir+'" &&\n# Dispatch-time availability\n'+f.events[6]!.message.content[0].input.command;
 expect(f.read().codexVoiceFired).toBe(true);
});
test.each(['before','after'])('guard blocks retain command separators around the exact harness: %s',where=>{
 const f=fixture(),guard=configStop(f);addGuards(f,guard,where);
 const input=f.events[6]!.message.content[0].input;
 input.command=input.command.split('\n').map((line:string)=>line.trim()).filter((line:string)=>line&&!line.startsWith('#')).join('\n');
 input.command=where==='before'?input.command.replace(guard+'\n',guard):input.command.replace('fi\n'+guard,'fi'+guard);
 expect(f.read().codexVoiceFired).toBe(false);
});
test.each(['assignment-only','set-config','other-config','foreign-reader','or-config','and-cli','inverted-cli','no-exit','return','dynamic-exit','out-of-range-exit','command-substitution','backticks','redirect','diagnostic-command','completed-diagnostic','variable-change','duplicate-config','duplicate-cli','extra-command','conditional-body','inside-harness','inside-body','before-cd','changed-harness','changed-timeout','changed-sandbox','changed-prompt','skipped-validator','suffix'])('availability guards reject changed dispatch or non-stop shell: %s',kind=>{
 const f=fixture();let guards=configStop(f)+'\n'+cliStop;
 if(kind==='assignment-only')guards=configRead(f);
 if(kind==='set-config')guards=guards.replace('get codex_reviews','set codex_reviews enabled');
 if(kind==='other-config')guards=guards.replace('get codex_reviews','get telemetry');
 if(kind==='foreign-reader')guards=guards.replace('~/.claude/skills/gstack/bin/gstack-config','/tmp/gstack-config');
 if(kind==='or-config')guards=guards.replace('] && {','] || {');
 if(kind==='and-cli')guards=guards.replace('2>&1 || {','2>&1 && {');
 if(kind==='inverted-cli')guards='if command -v codex >/dev/null 2>&1; then\nexit 0\nfi';
 if(kind==='no-exit')guards=guards.replace('exit 77;','true;');
 if(kind==='return')guards=guards.replace('exit 77;','return 77;');
 if(kind==='dynamic-exit')guards=guards.replace('exit 77;','exit "$CODE";');
 if(kind==='out-of-range-exit')guards=guards.replace('exit 77;','exit 256;');
 if(kind==='command-substitution')guards=guards.replace("'CODEX_MODE: disabled (recheck)'",'"CODEX_MODE: disabled $(touch /tmp/side-effect)"');
 if(kind==='backticks')guards=guards.replace("'CODEX_MODE: disabled (recheck)'",'"CODEX_MODE: disabled `touch /tmp/side-effect`"');
 if(kind==='redirect')guards=guards.replace('; exit 77;',' > /tmp/side-effect; exit 77;');
 if(kind==='diagnostic-command')guards=guards.replace('; exit 77;','; touch /tmp/side-effect; exit 77;');
 if(kind==='completed-diagnostic')guards=guards.replace('CODEX_MODE: disabled (recheck)','OUTSIDE_STATUS: completed provider=codex host=claude');
 if(kind==='variable-change')guards+='\nGSTACK_ACTIVE_HOST=claude';
 if(kind==='duplicate-config')guards+='\n'+configStop(f);
 if(kind==='duplicate-cli')guards+='\n'+cliStop;
 if(kind==='extra-command')guards+='\necho ready';
 addGuards(f,guards);
 const input=f.events[6]!.message.content[0].input;
 if(kind==='conditional-body')input.command='if false; then\n'+input.command+'\nfi';
 if(kind==='inside-harness')input.command=input.command.replace(guards+'\n','').replace('  exit 78','  '+guards+'\n  exit 78');
 if(kind==='inside-body')input.command=input.command.replace(guards+'\n','').replace('_OUTSIDE_EXIT=0','_OUTSIDE_EXIT=0\n'+guards);
 if(kind==='before-cd')input.command=guards+'\ncd '+f.dir+'\n'+f.options.commands.outside.replace("'<prepared-prompt-file>'","'"+f.file+"'");
 if(kind==='changed-harness')input.command=input.command.replace('exit 78','exit 0');
 if(kind==='changed-timeout')input.command=input.command.replace('_gstack_codex_timeout_wrapper 600','_gstack_codex_timeout_wrapper 1');
 if(kind==='changed-sandbox')input.command=input.command.replace('-s read-only','-s danger-full-access');
 if(kind==='changed-prompt')input.command=input.command.replace('codex exec "$_OUTSIDE_PROMPT"','codex exec "Different plan"');
 if(kind==='skipped-validator')input.command=input.command.replace(/^bun .*outside-review-result.*\n/m,'');
 if(kind==='suffix')input.command+='\ntrue';
 expect(f.read().codexVoiceFired,kind).toBe(false);
 expect(f.read().codexAttempted,kind).toBe(false);
});
test.each(['disabled','missing-cli','missing-ack','failed-ack','foreign-ack','child','wrong-owner','wrong-method','changed-write','changed-native','pending','marker-only'])('accepted guard syntax never replaces execution, input or ownership evidence: %s',kind=>{
 const f=fixture();addGuards(f,configStop(f,0)+'\n'+cliStop);
 if(kind==='disabled')f.events[7]=ack('outside','CODEX_MODE: disabled (recheck)');
 if(kind==='missing-cli')f.events[7]=ack('outside','CODEX_MODE: not_installed (recheck)',true);
 if(kind==='missing-ack')f.events.pop();
 if(kind==='failed-ack')f.events[7]=ack('outside','OUTSIDE_STATUS: completed provider=codex host=claude',true);
 if(kind==='foreign-ack')f.events[7]=ack('outside','OUTSIDE_STATUS: completed provider=codex host=claude',false,'other');
 if(kind==='child')Object.assign(f.events[6]!,{parent_tool_use_id:'child'});
 if(kind==='wrong-owner')f.events[4]!.message.content[0].input.file_path='/tmp/foreign-prompt';
 if(kind==='wrong-method')f.options.methodologySha256='0'.repeat(64);
 if(kind==='changed-write')f.events.splice(6,0,use('edit','Edit',{file_path:f.file,new_string:'Changed plan'}),ack('edit','Updated'));
 if(kind==='changed-native')f.events[3]=ack('native','INPUT: ceo '+'0'.repeat(64));
 if(kind==='pending')f.events[7]=ack('outside','Command running in background with ID: pending. Output is being written to: /tmp/tasks/pending.output. You will be notified when it completes. To check interim output, use Read on that file path.');
 if(kind==='marker-only')f.events[6]!.message.content[0].input.command=configStop(f)+'\necho "OUTSIDE_STATUS: completed provider=codex host=claude"';
 expect(f.read().codexVoiceFired,kind).toBe(false);
 expect(f.read().codexAttempted,kind).toBe(false);
});

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function capturedGuardFixture(attempt:typeof captured.sourceBoundB176.attempts[number]){
 const f=fixture(attempt.plan),old=attempt.snapshot;
 // Authenticate the original public payload before adapting only fixture paths
 // and the native prompt's path-derived byte count/hash to real owned artifacts.
 expect(hash(attempt.plan)).toBe(old.sha256);
 expect(hash(attempt.nativePrompt)).toBe(old.nativePromptSha256);
 expect(attempt.events[2]!.message.content[0].input!.prompt).toBe(old.nativeDispatchPrompt);
 expect(f.snapshot.sha256).toBe(old.sha256);
 expect(attempt.nativePrompt.replaceAll(old.snapshotPath,f.snapshot.snapshotPath)).toBe(f.snapshot.nativePrompt);
 const dispatch=old.nativeDispatchPrompt.replaceAll(old.nativePromptPath,f.snapshot.nativePromptPath)
  .replace(old.nativePromptSha256,f.snapshot.nativePromptSha256)
  .replace(old.nativePromptBytes+' UTF-8 bytes',f.snapshot.nativePromptBytes+' UTF-8 bytes');
 expect(dispatch).toBe(f.snapshot.nativeDispatchPrompt);
 const rows:any[]=clone(attempt.events);
 for(const event of rows){
  for(const part of event.message.content){
   if(part.type==='tool_use'&&part.name==='Agent')part.input.prompt=dispatch;
   if(part.type==='tool_use'&&part.name==='Write'){
    part.input.file_path=f.file;part.input.content=part.input.content.replaceAll(old.snapshotPath,f.snapshot.snapshotPath);
    writeFileSync(f.file,part.input.content);
   }
   if(part.type==='tool_use'&&part.name==='Bash')part.input.command=part.input.command.replaceAll(attempt.preparedPromptPath,f.file);
  }
 }
 f.events.splice(0,f.events.length,...rows);
 return f;
}
test.each(captured.sourceBoundB176.attempts)('actual b176 attempt $attempt retains successful owned voices despite its availability recheck',attempt=>{
 const f=capturedGuardFixture(attempt);
 expect(f.read()).toMatchObject({claudeVoiceFired:true,codexAttempted:true,codexVoiceFired:true,codexUnavailable:false,reviewDispatched:true,
  nativeToolUseId:attempt.events[2]!.message.content[0].id,outsideToolUseId:attempt.events[6]!.message.content[0].id});
 expect(attempt.originalPaidVerdict).toBe('FAIL');
 expect(captured.sourceBoundB176.originalPaidVerdicts).toEqual(['FAIL','FAIL']);
 expect(captured.sourceBoundB176.paidOutcomesReclassified).toBe(false);
});
test.each(['missing-native','foreign-outside-result','changed-prompt','changed-owner','changed-method','changed-harness','changed-exec','no-marker'])('actual b176 captures still reject %s',kind=>{
 for(const attempt of captured.sourceBoundB176.attempts){
  const f=capturedGuardFixture(attempt),outside=f.events[6]!.message.content[0].input;
  if(kind==='missing-native')f.events.splice(3,1);
  if(kind==='foreign-outside-result')f.events[7]!.session_id='other';
  if(kind==='changed-prompt')f.events[4]!.message.content[0].input.content='Different plan';
  if(kind==='changed-owner')f.events[4]!.message.content[0].input.file_path='/tmp/foreign-prompt';
  if(kind==='changed-method')f.options.methodologySha256='0'.repeat(64);
  if(kind==='changed-harness')outside.command=outside.command.replace('exit 78','exit 0');
  if(kind==='changed-exec')outside.command=outside.command.replace('-s read-only','-s danger-full-access');
  if(kind==='no-marker')f.events[7]!.message.content[0].content='CODEX_MODE: disabled (recheck)';
  expect(f.read().codexVoiceFired,kind).toBe(false);
  expect(f.read().codexAttempted,kind).toBe(false);
 }
});
