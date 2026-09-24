import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeNativeAuq } from './helpers/auq-native-capture';

const question = {
  header: 'Mode', question: 'D1 — Choose the review mode.\nELI10: Review this pricing plan.\n'
    + 'Recommendation: SELECTIVE EXPANSION because the untested price premise calls for checking each proposed addition.\n'
    + 'Note: options differ in kind, not coverage — no completeness score.\nPros / cons:\nNet: Choose the scope of review.',
  options: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({
    label: label + (label === 'SELECTIVE EXPANSION' ? ' (recommended)' : ''),
    description: '✅ A concrete benefit belongs to this option.\n❌ An honest tradeoff belongs to this option.',
  })),
};

test('mode capture uses the actual SDK permission callback, preserves failures and retains only public evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-capture-free-'));
  const temp = path.join(dir, 'tmp'); fs.mkdirSync(temp);
  const worker = path.join(dir, 'worker.ts');
  const helper = path.join(import.meta.dir, 'helpers', 'auq-sdk-capture.ts');
  const sdk = require.resolve('@anthropic-ai/claude-agent-sdk');
  const cases = ['capture', 'short-labels', 'preview', 'native-metadata', 'missing-format', 'refusal', 'terminal-refusal', 'max-turns', 'missing-question', 'crash',
    'three-options', 'duplicate-options', 'wrong-modes', 'multi-select', 'preanswered', 'duplicate-call',
    'invalid-preview', 'annotated', 'invalid-metadata', 'unexpected-tool', 'late-question', 'timeout', 'artifact-error', 'cleanup-error'];
  fs.writeFileSync(worker, `
import {mock,spyOn} from 'bun:test';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
const root=${JSON.stringify(dir)}, cases=${JSON.stringify(cases)}, original=${JSON.stringify(question)};
let kind='', observed, queries=0, answers=0, closed=0, advanced=0;
const realNow=Date.now;Date.now=()=>realNow()+advanced;
const realTimer=setTimeout;globalThis.setTimeout=((fn,ms,...args)=>realTimer(fn,kind==='timeout'&&ms>200000?20:ms,...args));
mock.module(${JSON.stringify(sdk)},()=>({query:({prompt,options})=>{
 queries++;observed={prompt,maxTurns:options.maxTurns,tools:options.tools,allowedTools:options.allowedTools,
  permissionMode:options.permissionMode,settingSources:options.settingSources,model:options.model,
  binary:options.pathToClaudeCodeExecutable,config:options.env.CLAUDE_CONFIG_DIR,state:options.env.GSTACK_HOME,
  headless:options.env.GSTACK_HEADLESS};
 const q={async *[Symbol.asyncIterator](){
  yield {type:'system',subtype:'init',claude_code_version:'fixture-251'};
  if(kind==='crash')throw Error('CLI exited with code 19');
  if(['refusal','terminal-refusal','max-turns','missing-question'].includes(kind)){
   const privateBlock={type:'thinking',get thinking(){throw Error('private reasoning read');}};
   yield {type:'assistant',message:{content:[privateBlock,{type:'text',text:kind==='refusal'?'API Error: safeguards flagged this message. Details: [reasoning_extraction]. Request ID: req_fixture':''}]}};
   yield {type:'result',subtype:kind.endsWith('refusal')?'error_during_execution':kind==='max-turns'?'error_max_turns':'success',num_turns:12,total_cost_usd:0,
    ...(kind==='terminal-refusal'?{errors:['API Error: safeguards flagged this message. Details: [reasoning_extraction]. Request ID: req_terminal']}: {})};return;
  }
  if(kind==='timeout'){await new Promise(resolve=>options.abortController.signal.addEventListener('abort',resolve,{once:true}));return;}
  const input={questions:[structuredClone(original)]};const item=input.questions[0];
  if(kind==='short-labels'){item.question+='\\n'+item.options.map(o=>o.label).join('\\n');item.options.forEach((o,i)=>o.label=['Expand','Select additions','Hold','Reduce'][i]);}
  if(kind==='missing-format')item.question='Choose the review mode.';
  if(kind==='preview')item.options[0].preview='Visual comparison of proposed scope.';
  if(kind==='native-metadata'){input.metadata={source:'mode'};input.answers={};input.annotations={};}
  if(kind==='invalid-metadata')input.metadata={source:12};
  if(kind==='annotated')input.annotations={[item.question]:{notes:'User already responded'}};
  if(kind==='invalid-preview')item.options[0].preview={text:'not a native string'};
  if(kind==='three-options')item.options.pop();
  if(kind==='duplicate-options')item.options[3]=item.options[0];
  if(kind==='wrong-modes')item.options[3].label='Something unrelated';
  if(kind==='multi-select')item.multiSelect=true;
  if(kind==='preanswered')input.answers={[item.question]:item.options[0].label};
  if(kind==='late-question')advanced=240000;
  const callback=()=>options.canUseTool(kind==='unexpected-tool'?'Bash':'AskUserQuestion',input,{toolUseID:'native-call',signal:options.abortController.signal});
  void callback().then(()=>answers++);
  if(kind==='duplicate-call')void callback().then(()=>answers++);
  yield {type:'assistant',message:{content:[]}};
 },close(){closed++;}};return q;
}}));
const {captureModeSelectionAuq}=await import(${JSON.stringify(helper)});
const read=fs.readFileSync,write=fs.writeFileSync,remove=fs.rmSync;
let privateReads=0;
spyOn(fs,'readFileSync').mockImplementation((file,...args)=>{
 if(String(file).endsWith('.jsonl')){privateReads++;throw Error('private transcript read');}return read(file,...args);
});
spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{
 if(kind==='artifact-error'&&String(file).endsWith('capture.json'))throw Error('fixture receipt disk full');return write(file,...args);
});
spyOn(fs,'rmSync').mockImplementation((file,...args)=>{
 if(kind==='cleanup-error'&&path.basename(String(file)).startsWith('gstack-mode-auq-'))throw Error('fixture cleanup failed');return remove(file,...args);
});
const results=[];
for(kind of cases){
 advanced=0;queries=0;answers=0;closed=0;
 const cwd=path.join(root,kind);fs.mkdirSync(cwd);write(path.join(cwd,'ask-capture.md'),'STALE_SYNTHETIC_CAPTURE');
 let text,error;try{text=await captureModeSelectionAuq({planDir:cwd,testName:kind,runId:'free',model:'fixture-model'});}catch(e){error=String(e);}
 remove(cwd,{recursive:true,force:true});
 const artifacts=fs.readdirSync(path.join(root,'artifacts','native-auq','free')).filter(name=>name.startsWith(kind+'-'));
 const receiptPath=path.join(root,'artifacts','native-auq','free',artifacts[0],'capture.json');
 const receipt=fs.existsSync(receiptPath)?JSON.parse(read(receiptPath,'utf8')):undefined;
 results.push({kind,text,error,queries,answers,closed,observed,receipt,artifactCount:artifacts.length,
  configExists:fs.existsSync(observed.config),fixtureExists:fs.existsSync(cwd),directoryMode:fs.statSync(path.dirname(receiptPath)).mode&0o777,
  mode:fs.existsSync(receiptPath)?fs.statSync(receiptPath).mode&0o777:null});
}
console.log(JSON.stringify({results,privateReads}));
`);
  try {
    const proc = Bun.spawn([process.execPath, worker], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env,
      TMPDIR: temp, TMP: temp, TEMP: temp, EVALS_HERMETIC: '1', GSTACK_CLAUDE_BIN: '/fixture/claude',
      GSTACK_EVAL_DIR: path.join(dir, 'artifacts'), ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const data = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(data.privateReads).toBe(0);
    expect(data.results).toHaveLength(cases.length);
    for (const r of data.results) {
      expect(r.queries).toBe(1); expect(r.answers).toBe(0); expect(r.artifactCount).toBe(1);
      expect(r.fixtureExists).toBe(false);
      if (process.platform !== 'win32') expect(r.directoryMode).toBe(0o700);
      expect(r.observed).toMatchObject({ maxTurns: 12, tools: ['Read', 'Write', 'AskUserQuestion'],
        allowedTools: ['Read', 'Write', 'AskUserQuestion'], permissionMode: 'default', settingSources: [],
        model: 'fixture-model', binary: '/fixture/claude', headless: '' });
      expect(r.observed.prompt).toContain(path.join(dir, r.kind, 'plan-ceo-review', 'SKILL.md'));
      expect(r.observed.prompt).toContain('Proceed to Mode Selection,');
      expect(r.observed.prompt).toContain('Ask the user through the AskUserQuestion tool and wait for their answer.');
      expect(r.observed.prompt).not.toMatch(/verbatim|Do NOT call|would have|ELI10|Pros \/ cons:|Net:/);
      expect(r.configExists).toBe(r.kind === 'cleanup-error');
      if (r.kind === 'artifact-error') {
        expect(r.error).toContain('artifact_error'); expect(r.text).toBeUndefined(); expect(r.receipt).toBeUndefined(); continue;
      }
      if (process.platform !== 'win32') expect(r.mode).toBe(0o600);
      expect(r.receipt).toMatchObject({ source: 'can_use_tool', workflowCompleted: false, answered: false, maxTurns: 12, timeoutMs: 240_000 });
      expect(JSON.stringify(r.receipt)).not.toMatch(/PRIVATE|STALE_SYNTHETIC_CAPTURE/);
      if (['capture', 'short-labels', 'preview', 'native-metadata', 'missing-format'].includes(r.kind)) {
        expect(r.error).toBeUndefined(); expect(r.receipt.outcome).toBe('question_captured');
        expect(r.text).toBe(serializeNativeAuq(r.receipt.question)); expect(r.closed).toBe(1);
        if (r.kind === 'capture') expect(r.text).toBe(serializeNativeAuq(question));
        if (r.kind === 'preview') {
          expect(r.receipt.question.options[0].preview).toBe('Visual comparison of proposed scope.');
          expect(r.text).toBe(serializeNativeAuq(question));
        }
        if (r.kind === 'native-metadata') expect(r.receipt.input).toMatchObject({metadata:{source:'mode'},answers:{},annotations:{}});
        if (r.kind === 'missing-format') expect(r.text).not.toContain('ELI10:');
      } else {
        expect(r.text).toBeUndefined(); expect(r.receipt.outcome).not.toBe('question_captured');
        const reason = r.kind.endsWith('refusal') ? '[reasoning_extraction]' : r.kind === 'max-turns' ? 'error_max_turns'
          : r.kind === 'missing-question' ? 'missing_question' : r.kind === 'crash' ? 'code 19'
          : ['late-question', 'timeout'].includes(r.kind) ? 'timeout' : r.kind === 'duplicate-call' ? 'duplicate_capture'
          : r.kind === 'unexpected-tool' ? 'unexpected_tool' : r.kind === 'cleanup-error' ? 'cleanup_error' : 'invalid_mode_question';
        expect(r.error).toContain(reason);
        if (r.kind === 'terminal-refusal') expect(r.receipt.terminal.errors).toEqual([
          'API Error: safeguards flagged this message. Details: [reasoning_extraction]. Request ID: req_terminal',
        ]);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
