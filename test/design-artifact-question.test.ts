import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import calls from './fixtures/design-artifacts-w-calls.json';
import { isDesignArtifactGeneration } from './helpers/design-artifact-question';
import { nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const fp = (call: any) => nativePlanCallFingerprint(call as NativePlanQuestionCall, 0, false);
const artifacts = [calls[2]!, calls[3]!];

test('all eight W calls remain visible: five seeded findings, one shell decision and two artifact approvals', () => {
  const phases = calls.map(call => planCountQuestionPhase(fp(call), true, () => false,
    undefined, undefined, undefined, isDesignArtifactGeneration));
  expect(phases.map(p => p.administrative ?? 'review')).toEqual([
    'review', 'review', 'artifact-generation', 'artifact-generation', 'review', 'review', 'review', 'review',
  ]);
  for (const call of artifacts) {
    expect(planCountQuestionPhase(fp(call), false, () => false, () => true,
      undefined, undefined, isDesignArtifactGeneration)).toEqual({
      preReview: false, reviewStarted: false, administrative: 'artifact-generation',
    });
  }
});

test('new decisions, missing coverage, altered artifacts, deferrals and quoted examples remain findings', () => {
  for (const original of artifacts) {
    for (const mutate of [
      (c: any) => { c.questions[0].options[0].description += ' Also change the Save behavior.'; },
      (c: any) => { c.questions[0].options[0].description += ' Drop the error state.'; },
      (c: any) => { c.questions[0].options[0].description = c.questions[0].options[0].description.replace('No new design decisions', 'Choose new design decisions'); },
      (c: any) => { c.questions[0].options[1].description += ' The failure contract is still missing.'; },
      (c: any) => { c.questions[0].options[0].preview = 'Change the save contract'; },
      (c: any) => { c.answers[c.questions[0].question] = c.questions[0].options[1].label; },
      (c: any) => { const q = c.questions[0]; const a = c.answers[q.question]; q.question = 'Example: ' + q.question; c.answers = { [q.question]: a }; },
      (c: any) => { c.questions.push(calls[7]!.questions[0]); },
      (c: any) => { c.answered = false; }, (c: any) => { c.failed = true; },
      (c: any) => { delete c.failed; }, (c: any) => { delete c.unansweredQuestionIndices; },
      (c: any) => { c.unansweredQuestionIndices = [0]; }, (c: any) => { c.answeredAt = 'invalid'; },
      (c: any) => { c.sessionId = ''; },
    ]) {
      const call = structuredClone(original); mutate(call);
      expect(isDesignArtifactGeneration(fp(call))).toBe(false);
    }
    const reordered = structuredClone(original); reordered.questions[0]!.options.reverse();
    expect(isDesignArtifactGeneration(fp(reordered))).toBe(true);
    expect(isDesignArtifactGeneration({ ...fp(original), signature: 'foreign' })).toBe(false);
  }
});

const REPORT = '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n| Review | Status | Findings |\n|---|---|---|\n| Design | clean | recorded |\n\nVERDICT: Review complete\n\nNO UNRESOLVED DECISIONS\n';
const GATE = 'Exit plan mode?\n\nClaude wants to exit plan mode\n❯ 1. Yes, and switch to default (ask each time) for this session\n  2. No\n';

test.skipIf(process.platform === 'win32').each(['only-artifacts', 'freshness'] as const)('real fake-PTY artifact %s preserves coverage and fresh-report requirements', async mode => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-artifact-free-'));
  const fake = path.join(dir, 'fake-claude'), worker = path.join(dir, 'worker.ts');
  const report = path.join(dir, 'report.md'), output = path.join(dir, 'result.json');
  const pidFile = path.join(dir, 'pid.json'), inputs = path.join(dir, 'inputs.jsonl');
  const refreshed = path.join(dir, 'refreshed');
  const selected = mode === 'only-artifacts' ? artifacts : [calls[0]!, artifacts[0]!];
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs'; import * as path from 'node:path';
const stat = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat','utf8') : null;
fs.writeFileSync(process.env.PID_FILE, JSON.stringify({pid:process.pid,start:stat?.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));
let sent=false; process.stdin.setRawMode?.(true);
process.stdin.on('data', data => {
  fs.appendFileSync(process.env.INPUT_FILE,JSON.stringify(data.toString())+'\n');
  if(sent)return;sent=true;
  const at=Date.now(),sid='artifact-free';
  const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned');fs.mkdirSync(project,{recursive:true});
  const events=JSON.parse(process.env.CALLS).flatMap((call,i)=>[
    {cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(at-100+i*10).toISOString(),message:{role:'assistant',content:[{type:'tool_use',id:call.toolUseId,name:'AskUserQuestion',input:{questions:call.questions}}]}},
    {cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(at-99+i*10).toISOString(),toolUseResult:{answers:call.answers},message:{role:'user',content:[{type:'tool_result',tool_use_id:call.toolUseId,content:'Your questions have been answered: '+Object.entries(call.answers).map(([q,a])=>JSON.stringify(q)+'='+JSON.stringify(a)).join(', ')+'. You can now continue with these answers in mind.'}]}}
  ]);
  events.push({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(at).toISOString(),message:{role:'assistant',content:[{type:'text',text:'Design review complete.'},{type:'tool_use',id:'exit',name:'ExitPlanMode',input:{}}]}});
  fs.writeFileSync(path.join(project,sid+'.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
  fs.writeFileSync(process.env.REPORT_FILE,process.env.REPORT);
  if(process.env.MODE==='freshness') {
    fs.utimesSync(process.env.REPORT_FILE,(at-95)/1000,(at-95)/1000);
    setTimeout(()=>{fs.writeFileSync(process.env.REPORT_FILE,process.env.REPORT);fs.writeFileSync(process.env.REFRESHED,'yes');},5500);
  }
  process.stdout.write(process.env.GATE);
});process.stdin.resume();
`); fs.chmodSync(fake,0o755);
  const runner = pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
  const artifactHelper = pathToFileURL(path.join(import.meta.dir,'helpers/design-artifact-question.ts')).href;
  const env = {PID_FILE:pidFile,INPUT_FILE:inputs,REPORT_FILE:report,REPORT,GATE,CALLS:JSON.stringify(selected),MODE:mode,REFRESHED:refreshed};
  fs.writeFileSync(worker, `import {runPlanSkillCounting} from ${JSON.stringify(runner)};\nimport {isDesignArtifactGeneration} from ${JSON.stringify(artifactHelper)};\nconst result=await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',followUpPrompt:'# Artifact control',expectedPlanPath:${JSON.stringify(report)},isLastStep0AUQ:()=>false,isFirstReviewAUQ:()=>true,isArtifactGenerationAUQ:isDesignArtifactGeneration,reviewCountCeiling:8,timeoutMs:33000,env:${JSON.stringify(env)}});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));\n`);
  const child = Bun.spawn([process.execPath,worker],{env:{...process.env,EVALS_HERMETIC:'1',EVALS_RUN_ID:'',BROWSE_TERMINAL_BINARY:fake},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
  try {
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,out+err).toBe(0);const result=JSON.parse(fs.readFileSync(output,'utf8'));
    expect(result.transcript.calls).toHaveLength(2);
    expect(result.administrativeCount).toBe(mode==='only-artifacts'?2:1);
    expect(result.reviewCount).toBe(mode==='only-artifacts'?0:1);
    expect(result.outcome).toBe(mode==='only-artifacts'?'no_review_questions':'plan_ready');
    if(mode==='freshness') expect(fs.existsSync(refreshed)).toBe(true);
    expect(fs.readFileSync(inputs,'utf8').trim().split('\n').map(x=>JSON.parse(x))).toEqual(['/plan-design-review\r']);
  } finally {
    clearTimeout(timer);child.kill('SIGKILL');
    if(fs.existsSync(pidFile))try {
      const p=JSON.parse(fs.readFileSync(pidFile,'utf8'));let owned=false;
      if(process.platform==='linux') {
        const s=fs.readFileSync(`/proc/${p.pid}/stat`,'utf8');owned=s.slice(s.lastIndexOf(')')+2).split(' ')[19]===p.start && fs.readFileSync(`/proc/${p.pid}/cmdline`,'utf8').split('\0').includes(fake);
      } else owned=execFileSync('ps',['-p',String(p.pid),'-o','command='],{encoding:'utf8',timeout:1000}).includes(fake);
      if(owned)process.kill(p.pid,'SIGKILL');
    }catch{/* owned fake already gone */}
    fs.rmSync(dir,{recursive:true,force:true});
  }
},40000);
