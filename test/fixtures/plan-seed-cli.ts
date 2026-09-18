
import * as fs from 'node:fs';
import * as path from 'node:path';
const dir=process.env.CLAUDE_CONFIG_DIR, scenario=process.env.SEED_CASE;
const cliArgs=process.argv.slice(2), sessionIndex=cliArgs.indexOf('--session-id');
const sid=sessionIndex>=0?cliArgs[sessionIndex+1]:'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', cwd=process.cwd();
const file=path.join(dir,'projects','fixture',sid+'.jsonl');
const events=path.join(dir,'events.jsonl'), statusFile=path.join(dir,'sessions',process.pid+'.json');
fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(statusFile),{recursive:true});
const status={pid:process.pid,sessionId:sid,cwd,startedAt:Date.now(),kind:'interactive',entrypoint:'cli',version:'fixture',
 procStart:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ').pop().split(' ')[19]:'opaque-test-start',
 pidDomain:process.platform==='linux'?'linux:'+fs.readFileSync('/etc/machine-id','utf8').trim()+':'+fs.readlinkSync('/proc/self/ns/pid'):'test-domain'};
if(scenario==='wrong-pid')status.pid++;
if(scenario==='wrong-start')status.procStart+='0';
if(scenario==='wrong-domain')status.pidDomain+='-different';
if(scenario==='startup-waiting')status.waitingFor='permission prompt';
fs.writeFileSync(statusFile,JSON.stringify(status));
fs.writeFileSync(path.join(dir,'launch.json'),JSON.stringify({argv:process.argv.slice(2),planModeHint:process.env.GSTACK_PLAN_MODE??null,planModeForce:process.env.GSTACK_PLAN_MODE_FORCE??null}));
const event=(kind,value)=>fs.appendFileSync(events,JSON.stringify({kind,value,at:Date.now()})+'\n');
const row=(type,content,stop)=>JSON.stringify({type,sessionId:sid,cwd,message:{role:type,content,stop_reason:stop}})+'\n';
const text=s=>[{type:'text',text:s}];
const append=(type,content,stop)=>fs.appendFileSync(file,row(type,content,stop));
const rule='─'.repeat(120);
const frame=(s,history='',top=rule,bottom=rule)=>{
 const inputRows=1+(s.match(/\r\n/g)||[]).length;
 const topRow=(process.stdout.rows||40)-inputRows-2;
 process.stdout.write('\x1b[2J\x1b[H'+history+'\x1b['+topRow+';1H'+top+'\r\n❯ '+s+'\r\n'+bottom+'\r\npaste again to expand');
};
let input='',seed='',submitted=false;
process.stdin.setRawMode(true);process.stdin.resume();
const hint='Try "refactor <filepath>"';
if(scenario==='startup-prior-conversation')append('user',text('An earlier request'));
if(scenario==='startup-terminal-placeholder-cursor')frame(process.env.TERM==='dumb'||!process.env.TERM?hint:'\x1b[7mT\x1b[27m\x1b[2m'+hint.slice(1)+'\x1b[22m');
else if(scenario==='startup-placeholder-cursor')frame('\x1b[7mT\x1b[27m\x1b[2m'+hint.slice(1)+'\x1b[22m');
else if(scenario==='startup-placeholder-unicode')frame('\x1b[2mTry "refactor src/設定.ts"\x1b[22m');
else if(['startup-placeholder','startup-prior-conversation','startup-missing-styles','startup-waiting','startup-prose-question','startup-permission','startup-fresh-waiting'].includes(scenario))frame('\x1b[2m'+hint+'\x1b[22m');
else if(scenario==='startup-typed-hint')frame(hint);
else if(scenario==='startup-partial-dim')frame('\x1b[2mTry \x1b[22m"refactor <filepath>"');
else frame('');
if(scenario==='startup-prose-question')process.stdout.write('Which option do you prefer?\r\nA) Full review (recommended)\r\nB) Skip review\r\n');
if(scenario==='startup-permission')process.stdout.write('Bash command run checks requires permission\r\n');
process.stdin.on('data',chunk=>{
 input+=chunk.toString();
 if(input.startsWith('\x1b[200~')&&input.endsWith('\x1b[201~')){
  seed=input.slice(6,-6);input='';event('paste',seed);
  frame('[Pasted text #1 +'+(seed.match(/\n/g)||[]).length+' lines]');return;
 }
 if(input==='\r'&&!submitted){
  submitted=true;input='';event('enter',seed);frame('');
  if(scenario==='no-ack')return;
  append('user',text(scenario==='fused'?seed+'\n/plan-eng-review':seed));
  if(scenario==='duplicate')append('user',text(seed));
  if(scenario==='session-switch'){status.sessionId='bbbbbbbb-1111-2222-3333-aaaaaaaaaaaa';fs.writeFileSync(statusFile,JSON.stringify(status));return;}
  if(scenario==='foreign-cwd'){fs.writeFileSync(file,row('user',text(seed)).replace(cwd,cwd+'-other'));return;}
  if(scenario==='pending-tool'||scenario==='completed-tool'||scenario==='question'){
   append('assistant',[{type:'tool_use',id:'call1',name:scenario==='question'?'AskUserQuestion':'Read',input:{}}],'tool_use');
  }
  if(scenario==='status-updating'){fs.writeFileSync(statusFile,'{\"pid\":');setTimeout(()=>fs.writeFileSync(statusFile,JSON.stringify(status)),120);}
  if(scenario==='permission'){status.waitingFor='permission prompt';fs.writeFileSync(statusFile,JSON.stringify(status));}
  setTimeout(()=>{
   if(scenario==='no-end-turn')return;
   if(scenario==='completed-tool')append('user',[{type:'tool_result',tool_use_id:'call1',content:'Read complete'}]);
   append('assistant',text('Draft received; waiting for your skill command.'),'end_turn');event('end_turn',seed);
   if(scenario==='partial')fs.appendFileSync(file,'{"type":');
   // Keep the submitted message visible, as the native CLI does. An older
   // boxed example must never supply the current input's empty state.
   const olderBox=scenario.startsWith('history-')||scenario==='unframed-current'?rule+'\r\n❯ \r\n'+rule+'\r\n':'';
   const history='❯ '+seed.replace(/\n/g,'\r\n')+'\r\n● Draft received; waiting for your skill command.\r\n'+olderBox;
   if(scenario==='history-no-current'){
    process.stdout.write('\x1b[2J\x1b[H'+history+'This was only an example.\r\n');return;
   }
   const current=scenario==='prose-question'?'\r\nWhich option do you prefer?\r\nA) Full review (recommended)\r\nB) Skip review\r\n❯ '
    :scenario.endsWith('multiline-current')?'\r\n  keep this draft'
    :scenario.endsWith('typed-current')?'keep this draft':'';
   frame(current,history,scenario.endsWith('missing-current-top')||scenario==='unframed-current'?'':rule,
    scenario.endsWith('missing-current-bottom')||scenario==='unframed-current'?'':scenario==='mismatched-current-rules'?rule.slice(1):rule);
   if(scenario==='stray-prompt-after-current')process.stdout.write('\r❯ keep this later draft');
  },180);return;
 }
 if(/^\/plan-[a-z-]+\r$/.test(input)){
  const command=input;event('slash',command);input='';
  if(scenario==='native-replay')process.emit('gstack-seeded-slash',command);
  if(scenario==='observation-scope-hint')process.stdout.write('\r\n❯ 1. Review changes\r\n  2. Keep current plan\r\nEnter to select\r\n');
 }
});
setTimeout(()=>process.exit(0),scenario==='native-replay'?40000:scenario==='observation-scope-hint'?15000:scenario==='wrong-pid'?12000:5000);
