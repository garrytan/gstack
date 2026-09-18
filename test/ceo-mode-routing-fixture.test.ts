/** Actual paid caller lifecycle with only provider/native boundaries replaced. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test.each(['success', 'next-modal', 'mode-submit', 'pacing', 'pacing-unacknowledged', 'pacing-unsupported', 'pacing-repeated', 'launch', 'navigation', 'posture', 'close'])('native mode fixture delivery and cleanup: %s', scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-body-'));
  const script = path.join(dir, 'body.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)}, scenario = ${JSON.stringify(scenario)};
const facts = [];
let current, clock = 0;
Date.now = () => clock;
Bun.sleep = async ms => { clock += ms; };
const question = { promptSnippet:'Select review mode', signature:'mode',
  options:[{index:1,label:'SCOPE EXPANSION'},{index:2,label:'HOLD SCOPE'}] };
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({describeE2ETier: () => describe}));
mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
  launchClaudePty: async opts => {
    current = {cwd:opts.cwd, options:opts, sends:[], closed:false, reads:[], selected:false, continued:false, submitted:false, pacingSent:false, pacingChecks:0, pacingChoices:0, continuationChecks:[]};
    facts.push(current);
    const git = file => execFileSync('git', ['show','HEAD:'+file], {cwd:opts.cwd,encoding:'utf8',timeout:5000});
    current.plan = fs.readFileSync(path.join(opts.cwd,'PLAN.md'),'utf8');
    current.committed = git('PLAN.md'); current.instructions = git('CLAUDE.md');
    current.status = execFileSync('git',['status','--porcelain'],{cwd:opts.cwd,encoding:'utf8',timeout:5000});
    if (scenario === 'launch') throw new Error('fixture launch failed');
    return {
      hermeticConfigDir:path.join(opts.cwd,'.native'), mark:()=>current.selected ? 23 : 11,
      send:value=>{current.sends.push(value); if (value==='\\r') current.submitted=true; if (/^[12]$/.test(value)) {
        if (current.selected) { if (scenario.startsWith('pacing') && current.mode==='SCOPE EXPANSION' && !current.pacingSent) current.pacingSent=true; else current.continued=true; } else current.selected=true;
      }}, exited:()=>false, exitCode:()=>null,
      visibleSince:()=>current.selected ? 'Current native posture' : 'Current mode menu',
      rawOutput:()=>'', visibleText:()=>'', currentScreen:async()=>current.selected ? 'Downstream question' : 'Mode menu',
      close:async()=>{current.closed=true;if(scenario==='close')throw new Error('fixture close failed');},
    };
  },
  isNumberedOptionListVisible:()=>false, isPlanReadyVisible:()=>false,
  planCountQuestionInput:(_visible,_question,index)=>String(index),
  capturePlanCountQuestion:()=>question,
  selectPtyNumberedOption:async(session,index)=>session.send(String(index)),
}));
mock.module(path.join(root,'test/helpers/ceo-mode-option.ts'),()=>({
  ceoExpansionPacingChoice:()=>{current.pacingChoices++;return scenario.startsWith('pacing')&&(!current.pacingSent||scenario==='pacing-repeated')?{call:{questions:[]},index:scenario==='pacing-unsupported'?0:1}:null;},
  ceoExpansionPacingReady:()=>{current.pacingChecks++;return (scenario==='pacing'||scenario==='pacing-repeated')&&current.pacingChecks>=3;},
  ceoModeSubmissionInput:()=>scenario==='mode-submit'&&!current.submitted?'\\r':null,
  nextCeoModeNavigation:(_visible,target)=>{
    if(scenario==='navigation')throw new Error('fixture navigation failed');
    current.mode=target; return {kind:'mode',index:target==='HOLD SCOPE'?2:1,question};
  },
  hasNativePostAnswerCeoPosture:(_transcript,target,_pattern,selectedAt,_events,source)=>{
    current.posture={target,selectedAt,source};
    return (!scenario.startsWith('pacing')||target==='HOLD SCOPE'||current.continued) && scenario!=='posture' && (scenario!=='next-modal'||current.continued) && (scenario!=='mode-submit'||current.submitted);
  },
  nextCeoPostureContinuation:()=>{current.continuationChecks.push(current.pacingChecks);return (scenario==='next-modal'||scenario==='pacing')&&!current.continued?'question':null;},
}));
// This lifecycle adapter supplies no native HOLD decision. The dedicated
// HOLD callback controls exercise the real helper with an injected evaluator.
mock.module(path.join(root,'test/helpers/ceo-hold-posture-review.ts'),()=>({
  buildCeoHoldPostureReview:()=>{throw new Error('unexpected semantic HOLD branch');},
  evaluateCeoHoldPostureReview:()=>{throw new Error('unexpected semantic HOLD assessment');},
}));
mock.module(path.join(root,'test/helpers/plan-count-transcript.ts'),()=>({
  readPlanCountTranscript:(config,cwd)=>{
    current.reads.push({config,cwd});return {status:'ready',calls:[],assistantMessages:[]};
  },
}));
mock.module(path.join(root,'test/helpers/plan-count-pending-question.ts'),()=>({
  readPendingQuestion:()=>undefined,pendingQuestionRecorderStatus:()=>({status:'idle'}),
}));
mock.module(path.join(root,'test/helpers/plan-count-artifacts.ts'),()=>({createPlanCountSnapshotWriter:()=>()=>({})}));
afterAll(()=>fs.writeFileSync(${JSON.stringify(factsPath)},JSON.stringify(facts)));
await import(path.join(root,'test/skill-e2e-plan-ceo-mode-routing.test.ts'));
`);
  try {
    const child = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_TIER: '', TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(['success', 'next-modal', 'mode-submit', 'pacing'].includes(scenario) ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts).toHaveLength(2);
    expect(facts[0].cwd).not.toBe(facts[1].cwd);
    for (const [index, fact] of facts.entries()) {
      expect(fact.plan).toContain('# Plan: Add saved project views');
      expect(fact.committed).toBe(fact.plan);
      expect(fact.instructions).toContain(fact.plan);
      expect(fact.status).toBe('');
      expect(fact.options).toMatchObject({permissionMode:'plan',seedSkills:true,observeScreen:true,observeSetupQuestions:true});
      expect(fs.existsSync(fact.cwd)).toBe(false);
      expect(fact.closed).toBe(scenario !== 'launch');
      const modeInput = index === 0 ? '2' : '1';
      expect(fact.sends).toEqual(scenario === 'launch' ? [] : scenario === 'navigation' ? ['/plan-ceo-review\r']
        : scenario === 'mode-submit' ? ['/plan-ceo-review\r', modeInput, '\r']
        : scenario.startsWith('pacing') && index===1 ? ['/plan-ceo-review\r', modeInput, ...(scenario==='pacing-unsupported'?[]:['1']), ...(scenario==='pacing'?['1']:[])]
        : scenario === 'next-modal' ? ['/plan-ceo-review\r', modeInput, '1'] : ['/plan-ceo-review\r', modeInput]);
      if(scenario.startsWith('pacing')) {
        expect(fact.pacingChoices).toBe(index===0?0:['pacing','pacing-repeated'].includes(scenario)?2:1);
        expect(fact.continuationChecks).toEqual(scenario==='pacing'&&index===1?[3]:[]);
        if(index===1)expect(fact.pacingChecks).toBeGreaterThanOrEqual(scenario==='pacing-unsupported'?0:3);
      }
      for (const read of fact.reads) expect(read).toEqual({config:path.join(fact.cwd,'.native'),cwd:fact.cwd});
      if (!['launch','navigation'].includes(scenario)) {
        expect(fact.posture.target).toBe(index === 0 ? 'HOLD SCOPE' : 'SCOPE EXPANSION');
        expect(fact.posture.selectedAt).toBeGreaterThan(0);
        expect(fact.posture.source).toEqual({path:path.join(fact.cwd,'PLAN.md'),content:fact.plan});
      }
    }
    if (scenario === 'posture' || scenario === 'pacing-unacknowledged') expect(child.stderr).toContain('no posture match');
    else if (['pacing-unsupported','pacing-repeated'].includes(scenario))expect(child.stderr).toContain('Unsupported or repeated CEO pacing menu');
    else if (!['success','next-modal','mode-submit','pacing'].includes(scenario)) expect(child.stderr).toContain('fixture ' + scenario + ' failed');
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-plan-count-'))).toEqual([]);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
}, 20_000);
