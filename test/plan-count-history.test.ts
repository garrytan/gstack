/** Exercise preceding-call context through the real PTY/native capture loop, without a provider. */
import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test.skipIf(process.platform === 'win32')('native issue callbacks receive earlier calls, never the current or future call', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-count-history-'));
  const fake=path.join(dir,'fake-claude'), worker=path.join(dir,'worker.ts');
  const report=path.join(dir,'report.md'), resultFile=path.join(dir,'result.json'), seen=path.join(dir,'history.jsonl');
  const runner=pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n`+String.raw`
import fs from 'node:fs'; import path from 'node:path';
const sessionId='history-fixture';
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',sessionId);
fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,sessionId+'.jsonl');
const native=(role,content,timestamp,extra={})=>fs.appendFileSync(file,JSON.stringify({
  cwd:process.cwd(),sessionId,isSidechain:false,timestamp,message:{role,content},...extra,
})+'\n');
let sent=false;process.stdin.setRawMode?.(true);
process.stdin.on('data',()=>{
  if(sent)return;sent=true;const now=Date.now();
  for(const [i,id] of ['first','second'].entries()){
    const q={header:'Finding',question:'Fix issue '+id+'?',options:[{label:'Fix it'},{label:'Keep it'}],multiSelect:false};
    native('assistant',[{type:'tool_use',id,name:'AskUserQuestion',input:{questions:[q]}}],new Date(now-1000+i*100).toISOString());
    native('user',[{type:'tool_result',tool_use_id:id,content:'Answered.'}],new Date(now-950+i*100).toISOString(),{toolUseResult:{answers:{[q.question]:q.options[0].label}}});
  }
  fs.writeFileSync(process.env.PROBE_PLAN,'# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n| Review | Status | Findings |\n|---|---|---|\n| DX Review | clean | two resolved |\n\nVERDICT: DX CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n');
  const text='DX review complete. Two findings resolved interactively.\n\nPlan written to: '+String.fromCharCode(96)+process.env.PROBE_PLAN+String.fromCharCode(96);
  native('assistant',[{type:'text',text}],new Date(Date.now()+5).toISOString());
  process.stdout.write('●'+text.replace(/ /g,'')+'\nCrunched ·done\n❯ ');
});process.stdin.resume();
`);
  fs.chmodSync(fake,0o755);
  fs.writeFileSync(worker,`import fs from 'node:fs';\nimport {runPlanSkillCounting} from ${JSON.stringify(runner)};\n`+
    `const result=await runPlanSkillCounting({skillName:'plan-devex-review',slashCommand:'/plan-devex-review',followUpPrompt:'# History fixture',expectedPlanPath:${JSON.stringify(report)},isLastStep0AUQ:()=>false,isReviewAUQ:(fp,prior)=>{fs.appendFileSync(${JSON.stringify(seen)},JSON.stringify({current:fp.nativeCall.toolUseId,prior:prior?.map(c=>c.toolUseId)??null})+'\\n');return true;},reviewCountCeiling:8,timeoutMs:33000,env:{PROBE_PLAN:${JSON.stringify(report)}}});\n`+
    `fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));\n`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,EVALS_HERMETIC:'1',EVALS_RUN_ID:'',BROWSE_TERMINAL_BINARY:fake},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
  try{
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,stdout+stderr).toBe(0);
    const obs=JSON.parse(fs.readFileSync(resultFile,'utf8'));
    expect(obs.outcome).toBe('completion_summary');expect(obs.reviewCount).toBe(2);
    expect(fs.readFileSync(seen,'utf8').trim().split('\n').map(line=>JSON.parse(line))).toEqual([
      {current:'first',prior:[]},{current:'second',prior:['first']},
    ]);
  } finally {clearTimeout(timer);child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
},40000);
