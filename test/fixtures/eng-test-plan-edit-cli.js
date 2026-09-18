
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const fixture=JSON.parse(fs.readFileSync(process.env.QA_FIXTURE,'utf8'));
const args=process.argv.slice(2),settings=JSON.parse(args[args.indexOf('--settings')+1]);
const hook=settings.hooks?.PreToolUse?.flatMap(e=>e.hooks).find(h=>h.command.includes('autoplan-artifact-recorder.ts'));
const result={pid:process.pid,cwd:process.cwd(),home:process.env.HOME,nativeState:process.env.GSTACK_HOME,hook:hook?.command};
const save=()=>fs.writeFileSync(process.env.QA_RESULT,JSON.stringify(result));
save();
process.stdin.setRawMode(true);process.stdin.resume();
let received='';
process.stdin.on('data',async bytes=>{
 received+=bytes.toString();if(!received.includes('\r')||result.input)return;
 result.input=received;
 try {
  if(hook){
   const stateFile=/'--record' '([^']+)'/.exec(hook.command)?.[1];
   const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
   result.approvalStartedAt=state.approvalStartedAt;result.commandReceivedAt=Date.now();result.boundRoot=state.stateRoot;
   const sourceRoot=process.env.QA_MODE==='native-state'?process.env.GSTACK_HOME:path.join(process.env.HOME,'.gstack');
   const target=path.join(sourceRoot,'projects',path.basename(process.cwd()),path.basename(fixture.file));
   result.target=target;fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,fixture.before);
   const current=fixture.publicEvents.at(-1),sid=current.sessionId;
   const journal=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','qa-launch',sid+'.jsonl');
   fs.mkdirSync(path.dirname(journal),{recursive:true});
   const time=state.approvalStartedAt;
   const use=(id,input,offset,name='Edit')=>({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(time+offset).toISOString(),requestId:'req_launch_'+offset,
    message:{role:'assistant',id:'msg_launch_'+offset,content:[{type:'tool_use',id,name,input}]}});
   const ack=(id,offset)=>({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(time+offset).toISOString(),
    message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:false,content:'Synthetic fixture write succeeded'}]}});
   const input={...current.input,file_path:target};
   const rows=process.env.QA_MODE==='withheld'?[]:[use('prior_write',{file_path:target,content:fixture.before},1,'Write'),ack('prior_write',2)];
   rows.push(use(current.id,input,3));fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
   await Bun.sleep(20);
   const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:sid,tool_use_id:current.id,cwd:process.cwd(),transcript_path:journal,tool_input:input};
   const invoke=()=>spawnSync('bash',['-c',hook.command],{input:JSON.stringify(event),encoding:'utf8',timeout:6000});
   const first=invoke(),repeat=invoke();result.first=first.stdout;result.repeat=repeat.stdout;result.hookStatuses=[first.status,repeat.status];
   result.unchanged=fs.readFileSync(target,'utf8')===fixture.before;
   if(first.stdout){
    fs.writeFileSync(target,fixture.before.replace(input.old_string,input.new_string));
    fs.appendFileSync(journal,JSON.stringify(ack(current.id,Date.now()-time))+'\n');
    event.hook_event_name='PostToolUse';
    result.postStatus=spawnSync('bash',['-c',hook.command],{input:JSON.stringify(event),encoding:'utf8',timeout:6000}).status;
   }
   result.stateFile=stateFile;
  }
 }catch(error){result.error=String(error);}
 save();setTimeout(()=>process.exit(0),100);
});
process.on('SIGINT',()=>process.exit(0));
