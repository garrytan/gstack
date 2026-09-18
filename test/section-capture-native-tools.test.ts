import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('Eng carve executes its required canonical review helpers only in capture-owned state', async () => {
  const root = path.resolve(import.meta.dir, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-local-review-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const observedFile = path.join(dir, 'observed.jsonl');
  const source = path.join(root, 'test/helpers/auq-sdk-capture.ts');
  const operatorState = path.join(dir, 'operator-state'); fs.mkdirSync(operatorState);
  fs.writeFileSync(path.join(operatorState, 'config.yaml'), 'codex_reviews: enabled\n');
  fs.writeFileSync(path.join(bin, 'claude'), String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const prompt = await Bun.stdin.text(), args = process.argv.slice(2);
const state = process.env.GSTACK_HOME;
const helpers = [...prompt.matchAll(/\x60([^\x60]+\/bin\/gstack-review-(?:log|read))\x60/g)].map(m => m[1]);
if (helpers.length !== 2) throw new Error('Missing canonical helpers');
if (process.env.GSTACK_STATE_ROOT !== state || path.dirname(state) !== process.cwd()) throw new Error('Foreign state');
if (!/^codex_reviews: disabled$/m.test(fs.readFileSync(path.join(state,'config.yaml'),'utf8'))) throw new Error('Outside dispatch enabled');
const tools = args[args.indexOf('--tools') + 1].split(',');
if (!tools.includes('Bash') || tools.includes('Agent')) throw new Error('Wrong local tool capability');
console.log(JSON.stringify({type:'system',subtype:'init'}));
const emit = (id, name, input, output, failed=false) => {
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}}));
 console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output,is_error:failed}]}}));
};
const section=path.join(process.cwd(),'plan-eng-review/sections/review-sections.md');
emit('section','Read',{file_path:section},fs.readFileSync(section,'utf8'));
const report=path.join(process.cwd(),'PLAN.md');
fs.appendFileSync(report,'\n## GSTACK REVIEW REPORT\nSynthetic smoke artifact; no model review credit.\n');
const record={skill:'plan-eng-review',timestamp:new Date().toISOString(),status:'issues_open',unresolved:1,critical_gaps:0,issues_found:1,mode:'BIG_CHANGE',outside_status:'disabled',plan_sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(report)).digest('hex')};
const input=prompt.includes('invalid-json-control') ? '{' : JSON.stringify(record);
const write=spawnSync(helpers[0],[input],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:5000});
emit('log','Bash',{command:helpers[0]+' '+JSON.stringify(input)},write.stdout+write.stderr,write.status!==0);
const read=spawnSync(helpers[1],[],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:5000});
emit('dashboard','Bash',{command:helpers[1]},read.stdout+read.stderr,read.status!==0);
const files = fs.readdirSync(state,{recursive:true}).map(String).filter(f=>f.endsWith('-reviews.jsonl'));
fs.appendFileSync(${JSON.stringify(observedFile)},JSON.stringify({args,prompt,state,stateRoot:process.env.GSTACK_STATE_ROOT,helpers,record,writeStatus:write.status,readStatus:read.status,readOutput:read.stdout,files,rows:files.flatMap(file=>fs.readFileSync(path.join(state,file),'utf8').trim().split('\n').map(JSON.parse))})+'\n');
console.log(JSON.stringify({type:'result',subtype:write.status===0&&read.status===0?'success':'error_during_execution',is_error:write.status!==0||read.status!==0,result:'Local executable smoke only.'}));
`, { mode: 0o755 });
  const script = path.join(dir, 'capture.fixture.test.ts');
  fs.writeFileSync(script, `import {mock,describe,expect} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
mock.module(${JSON.stringify(path.join(root,'test/helpers/eval-store.ts'))},()=>({getProjectEvalDir:()=>${JSON.stringify(path.join(dir,'evals'))}}));
const capture=await import(${JSON.stringify(source)});
const actualCapture=capture.captureSectionReads;
mock.module(${JSON.stringify(path.join(root,'test/helpers/e2e-gate.ts'))},()=>({describeE2ETier:()=>describe}));
mock.module(${JSON.stringify(source)},()=>({...capture,captureSectionReads:async opts=>{
  expect(opts.nativeReviewOnly).toBe(true); expect(opts.timeout).toBe(480000); expect(opts.maxTurns).toBeUndefined();
  expect(opts.artifactCommands).toContain('Do not run other shell commands, provider tools, git mutations, implementation, or tests');
  expect(opts.decisionPolicy).toContain('Do not authorize optional scope');
  const stateDirs=()=>fs.readdirSync(opts.planDir).filter(n=>n.startsWith('.gstack-section-state-'));
  try {
    const successful=await actualCapture({...opts,runId:undefined,timeout:5000,model:'fake-model'});
    expect(successful.exitReason).toBe('success'); expect(successful.reportProduced).toBe(true);
    expect(successful.toolCalls.map(c=>c.tool)).toEqual(['Read','Bash','Bash']);
    expect(stateDirs()).toEqual([]);
    const failed=await actualCapture({...opts,scenario:'invalid-json-control',runId:undefined,timeout:5000,model:'fake-model'});
    expect(failed.reportWritten).toBe(true); expect(failed.reportProduced).toBe(false);
    expect(failed.exitReason).not.toBe('success'); expect(stateDirs()).toEqual([]);
    const outside=path.join(${JSON.stringify(dir)},'foreign-report.md'); fs.writeFileSync(outside,'preserve');
    const check=async reportFile=>expect(actualCapture({...opts,reportFile,runId:undefined,model:'fake-model'})).rejects.toThrow();
    await check(path.relative(opts.planDir,outside));
    fs.symlinkSync(outside,path.join(opts.planDir,'foreign-link.md')); await check('foreign-link.md');
    fs.symlinkSync(outside+'.missing',path.join(opts.planDir,'dangling.md')); await check('dangling.md');
    fs.symlinkSync(${JSON.stringify(dir)},path.join(opts.planDir,'foreign-dir')); await check('foreign-dir/new.md');
    const alias=opts.planDir+'-alias'; fs.symlinkSync(opts.planDir,alias);
    try { await expect(actualCapture({...opts,planDir:alias,runId:undefined,model:'fake-model'})).rejects.toThrow('root must not be a symlink'); }
    finally { fs.unlinkSync(alias); }
    expect(fs.readFileSync(outside,'utf8')).toBe('preserve'); expect(fs.existsSync(outside+'.missing')).toBe(false);
    expect(stateDirs()).toEqual([]);
    return successful;
  } finally { fs.rmSync(opts.planDir,{recursive:true,force:true}); }
}}));
await import(${JSON.stringify(path.join(root,'test/carve-section-loading-plan-eng-review.test.ts'))});
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir,
    GSTACK_HOME: operatorState, GSTACK_STATE_ROOT: operatorState, EVALS_HERMETIC: '1', EVALS: '', EVALS_ALL: '', GSTACK_CARVE_SKILL: '' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, 'test', script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    const launches = fs.readFileSync(observedFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(launches).toHaveLength(2); // Rejected foreign roots never start a child.
    expect(new Set(launches.map(c=>c.state)).size).toBe(2);
    for (const launch of launches) {
      expect(launch.state).not.toBe(operatorState); expect(launch.stateRoot).toBe(launch.state);
      expect(fs.existsSync(launch.state)).toBe(false);
      expect(launch.helpers).toEqual(['gstack-review-log','gstack-review-read'].map(name=>path.join(root,'bin',name)));
      expect(launch.args[launch.args.indexOf('--tools')+1]).toBe('Read,Grep,Glob,Write,Edit,Bash');
      expect(launch.args[launch.args.indexOf('--max-turns')+1]).toBe('25');
      expect(launch.readStatus).toBe(0);
    }
    expect(launches[0].writeStatus).toBe(0); expect(launches[0].rows).toHaveLength(1);
    expect(launches[0].rows[0]).toMatchObject(launches[0].record);
    expect(launches[0].readOutput).toContain(JSON.stringify(launches[0].rows[0]));
    expect(launches[1].writeStatus).not.toBe(0); expect(launches[1].rows).toEqual([]);
    expect(launches[1].readOutput).toContain('NO_REVIEWS');
    expect(fs.readdirSync(operatorState)).toEqual(['config.yaml']);
    expect(fs.readFileSync(path.join(operatorState,'config.yaml'),'utf8')).toBe('codex_reviews: enabled\n');
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited;
    fs.rmSync(dir,{recursive:true,force:true});
  }
}, 25_000);

test('Eng section producer checkpoints complete outcomes and never credits an exhausted draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-section-checkpoints-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  // Public boundary from 749df444, first Eng carve attempt, session
  // 9cefb69f-60b7-49fe-bec3-f5b3d50118d4. The incomplete input was hashed,
  // never an executed Write. Replay its metadata, not reconstructed content.
  const exhausted = {
    type: 'public_stream_diagnostic', kind: 'message_delta',
    messageId: 'msg_011Cf75reetor7sBHhJw7xwT', elapsedMs: 454169,
    stopReason: 'max_tokens',
  };
  const incompleteWrite = {
    type: 'public_stream_diagnostic', kind: 'content_block_delta',
    messageId: exhausted.messageId, index: 2, elapsedMs: 454148,
    blockType: 'tool_use', toolName: 'Write', deltaType: 'input_json_delta',
    inputBytes: 27568, inputSha256: '01688dc5f6d704461620a43b8d0d5950c302801b2687bd8793b005dbfb06757d',
  };
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = await Bun.stdin.text();
fs.appendFileSync('observed.jsonl',JSON.stringify({prompt,args:process.argv.slice(2)})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init'}));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_01WP9DBmwzdGhTYMJ3Tw8xrT',name:'Read',input:{file_path:process.cwd()+'/plan-eng-review/sections/review-sections.md'}}]}}));
if (prompt.includes('capture-case:timeout')) {
  console.log(JSON.stringify(${JSON.stringify(incompleteWrite)}));
  console.log(JSON.stringify(${JSON.stringify(exhausted)}));
  if (prompt.includes('capture-case:timeout-partial')) fs.writeFileSync('PLAN.md','# Partial review\\n\\n## GSTACK REVIEW REPORT\\nDraft only.\\n');
  await Bun.sleep(5000);
}
if (prompt.includes('capture-case:synthetic-success')) fs.writeFileSync('PLAN.md','# Synthetic complete fixture\\n\\n## GSTACK REVIEW REPORT\\nSynthetic complete review.\\n');
console.log(JSON.stringify({type:'result',subtype:'success',result:'Request delivered only.'}));
`, { mode: 0o755 });
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))},()=>({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {captureSectionReads}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const fs=await import('node:fs');
const results=[];
for(const scenario of ['delivery','timeout','timeout-partial','synthetic-success']) {
  fs.writeFileSync('PLAN.md','# Original accepted requirements\\n');
  const capture=await captureSectionReads({planDir:${JSON.stringify(dir)},skillName:'plan-eng-review',scenario:'capture-case:'+scenario,decisionPolicy:'- Preserve the supplied author scope; do not approve excluded work.',reportFile:'PLAN.md',reportMarker:/^## GSTACK REVIEW REPORT\\s*$/m,testName:'eng-checkpoints',timeout:scenario.startsWith('timeout')?300:480000,model:'fake-model'});
  results.push({scenario,reads:[...capture.readSections],report:capture.reportProduced,written:capture.reportWritten,exit:capture.exitReason,executedWrites:capture.toolCalls.filter(t=>t.tool==='Write').length});
}
console.log(JSON.stringify(results));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const results = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(results.map((r: any) => [r.scenario, r.exit, r.written, r.report, r.executedWrites])).toEqual([
      ['delivery', 'success', false, false, 0],
      ['timeout', 'timeout', false, false, 0],
      ['timeout-partial', 'timeout', true, false, 0],
      ['synthetic-success', 'success', true, true, 0],
    ]);
    for (const result of results) expect(result.reads).toEqual(['review-sections.md']);
    const launches = fs.readFileSync(path.join(dir, 'observed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toHaveLength(4);
    for (const launch of launches) {
      expect(launch.prompt).toContain('When Scope Challenge finishes, save its outcome');
      expect(launch.prompt).toContain('After each completed review section, save');
      expect(launch.prompt).toContain('Check the Write/Edit result and Read the saved outcome before advancing');
      expect(launch.prompt).toContain('also apply when no new choice needs approval');
      expect(launch.prompt).toContain('all four review sections, including an explicit "No issues found" when applicable');
      expect(launch.prompt).toContain('Finish missing required outputs with scoped Edits');
      expect(launch.prompt).toContain("perform the skill's full final Read-back gate");
      expect(launch.prompt).not.toContain("When the workflow is complete, write the skill's final output");
      expect(launch.args[launch.args.indexOf('--max-turns') + 1]).toBe('25');
      expect(launch.args[launch.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Write,Edit,Agent,Bash');
      expect(launch.args[launch.args.indexOf('--model') + 1]).toBe('fake-model');
    }
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('CEO section caller supplies the author scope instead of blanket recommendation authority', () => {
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-ceo-review-section-loading.test.ts'), 'utf8');
  expect(caller).toContain('decisionPolicy: CEO_SECTION_DECISION_POLICY');
  expect(caller).toContain('validateCeoReviewCompletion(capture)');
  expect(caller).toContain('expect(hasStaleFillRaceFinding(output)).toBe(true)');
  expect(caller).toContain('timeout: LONG_SECTION_CAPTURE_MS');
  expect(caller).toContain('CAPTURE_LONG_MS');
});

test('actual CEO capture delivers the author scope and fixture without granting excluded recommendations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-scope-capture-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  // This CLI records the actual request only. It performs no review, section
  // Read or report write, so its successful exit cannot earn completion credit.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = await Bun.stdin.text();
fs.writeFileSync('observed.json', JSON.stringify({prompt,args:process.argv.slice(2),plan:fs.readFileSync('PLAN.md','utf8')}));
console.log(JSON.stringify({type:'system',subtype:'init'}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'Request delivered only.'}));
`, { mode: 0o755 });
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))}, () => ({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {captureSectionReads,LONG_SECTION_CAPTURE_MS}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const {CEO_SECTION_CACHE_PLAN,CEO_SECTION_DECISION_POLICY}=await import(${JSON.stringify(helper('ceo-section-loading-fixture'))});
await Bun.write('PLAN.md',CEO_SECTION_CACHE_PLAN);
const capture=await captureSectionReads({planDir:${JSON.stringify(dir)},skillName:'plan-ceo-review',scenario:'Review PLAN.md. Consider weaker consistency, a new alert project, or full implementation code.',decisionPolicy:CEO_SECTION_DECISION_POLICY,reportFile:'PLAN.md',reportMarker:/^## GSTACK REVIEW REPORT\\s*$/m,nativeReviewOnly:true,testName:'ceo-scope-delivery',timeout:LONG_SECTION_CAPTURE_MS,model:'fake-model'});
console.log(JSON.stringify({reads:[...capture.readSections],report:capture.reportProduced,written:capture.reportWritten,exit:capture.exitReason}));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ reads: [], report: false, written: false, exit: 'success' });
    const observed = JSON.parse(fs.readFileSync(path.join(dir, 'observed.json'), 'utf8'));
    const { CEO_SECTION_CACHE_PLAN, CEO_SECTION_DECISION_POLICY } = await import('./helpers/ceo-section-loading-fixture');
    expect(observed.plan).toBe(CEO_SECTION_CACHE_PLAN);
    expect(observed.prompt).toContain(CEO_SECTION_DECISION_POLICY);
    expect(observed.prompt).not.toContain("silently pick the skill's recommended option");
    expect(observed.prompt).toContain('Do not authorize weaker consistency, changed limits, optional scope');
    expect(observed.prompt).toContain('never hide it or claim approval when no offered alternative satisfies these constraints');
    expect(observed.prompt).toContain('all 11 sections, giving each an explicit outcome');
    expect(observed.prompt).toContain('Complete every required artifact and verification before returning');
    expect(observed.args[observed.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Write,Edit,Bash');
    expect(observed.args[observed.args.indexOf('--max-turns') + 1]).toBe('25');
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// POSIX executable shebang; parent environment and mocks stay untouched.
test('section capture keeps the native Read contract, tool availability and work deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-native-tools-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'argv.jsonl');
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const prompt = await Bun.stdin.text();
const log = ${JSON.stringify(log)};
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + JSON.stringify({args:process.argv.slice(2), config:process.env.CLAUDE_CONFIG_DIR, prompt}) + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init'}));
if (prompt === 'deadline') await Bun.sleep(3000);
const file = process.cwd() + '/fixture/sections/actual.md';
const tool = prompt.includes('shell-only') ? {name:'Bash',input:{command:'cat '+file}} : {name:'Read',input:{file_path:file}};
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'read-1',...tool}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'Review report complete',num_turns:1}));
`, { mode: 0o755 });
  const literal = 'Use Read.\nKeep "quotes", $(printf unsafe), and `literal` as text.';
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))}, () => ({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {runSkillTest}=await import(${JSON.stringify(helper('session-runner'))});
const {captureSectionReads}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const base={workingDirectory:${JSON.stringify(dir)},model:'fake-model',maxTurns:7,timeout:3000,allowedTools:['Read','Bash']};
const plain=await runSkillTest({...base,prompt:'default'});
const literal=await runSkillTest({...base,prompt:'literal',appendSystemPrompt:${JSON.stringify(literal)}});
const capture={planDir:${JSON.stringify(dir)},skillName:'fixture',testName:'native-tool-contract',model:'fake-model',maxTurns:7,timeout:3000};
const section=await captureSectionReads({...capture,scenario:'native-read',artifactCommands:'Run the existing program when required.'});
const shell=await captureSectionReads({...capture,scenario:'shell-only'});
const started=Date.now();
const deadline=await runSkillTest({...base,prompt:'deadline',appendSystemPrompt:${JSON.stringify(literal)},timeout:200,startupGraceMs:200});
console.log(JSON.stringify({plain:plain.exitReason,literal:literal.exitReason,section:{reads:[...section.readSections],report:section.reportProduced},shell:{reads:[...shell.readSections],report:shell.reportProduced},deadline:{reason:deadline.exitReason,wall:Date.now()-started}}));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.plain).toBe('success'); expect(result.literal).toBe('success');
    expect(result.section).toEqual({ reads: ['actual.md'], report: true });
    expect(result.shell).toEqual({ reads: [], report: true });
    expect(result.deadline.reason).toBe('timeout'); expect(result.deadline.wall).toBeLessThan(2000);
    const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toHaveLength(5);
    const args = (i: number) => launches[i].args as string[];
    expect(args(0)).not.toContain('--append-system-prompt');
    const added = args(1).indexOf('--append-system-prompt');
    expect(added).toBeGreaterThan(-1); expect(args(1)[added + 1]).toBe(literal);
    expect(args(1).filter((_, i) => i !== added && i !== added + 1)).toEqual(args(0));
    const sectionArgs = args(2);
    const instruction = launches[2].prompt.split('\n').find((line: string) => line.includes('with the Read tool BEFORE'));
    expect(sectionArgs).not.toContain('--append-system-prompt');
    expect(instruction).toContain('you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers');
    expect(instruction).not.toContain('actual.md'); expect(instruction).not.toContain(dir);
    expect(sectionArgs.slice(sectionArgs.indexOf('--allowed-tools') + 1, sectionArgs.indexOf('--allowed-tools') + 8))
      .toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Bash']);
    for (const [index, launch] of launches.entries()) {
      if (index === 2 || index === 3) {
        const expected = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', ...(index === 2 ? ['Bash'] : [])];
        expect(launch.args[launch.args.indexOf('--tools') + 1]).toBe(expected.join(','));
      } else expect(launch.args).not.toContain('--tools');
      expect(launch.args).not.toContain('--disallowed-tools');
      expect(launch.args).toContain('--dangerously-skip-permissions'); expect(launch.args).toContain('--strict-mcp-config');
      expect(launch.args[launch.args.indexOf('--max-turns') + 1]).toBe('7');
      expect(launch.args[launch.args.indexOf('--model') + 1]).toBe('fake-model');
      expect(path.relative(dir, launch.config).startsWith('..')).toBe(false);
    }
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);


test('section completion clock includes setup and queueing without extending the work deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-completion-clock-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  const log = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const prompt=await Bun.stdin.text();
await Bun.sleep(100); // CLI/API startup stays inside the same deadline.
const clock=spawnSync('bash',['-c','date -u +%Y-%m-%dT%H:%M:%SZ'],{encoding:'utf8'});
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({prompt,args:process.argv.slice(2),at:Date.now(),clock:{code:clock.status,text:clock.stdout.trim()}})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init'}));
if(prompt==='hold') await Bun.sleep(5000);
console.log(JSON.stringify({type:'result',subtype:'success',result:'Finished',num_turns:1}));
`, {mode: 0o755});
  const script = path.join(dir, 'run.ts');
  const literal = 'Keep "quotes", $(printf unsafe), and `literal` as text.';
  fs.writeFileSync(script, `import {mock} from 'bun:test';
let setupMs=0; const setups=[];
mock.module(${JSON.stringify(helper('eval-store'))},()=>({getProjectEvalDir:()=>${JSON.stringify(path.join(dir,'evals'))}}));
mock.module(${JSON.stringify(helper('hermetic-env'))},()=>({isHermeticEnabled:()=>true,hermeticChildEnv:extra=>{const start=Date.now();Bun.sleepSync(setupMs);setups.push({start,end:Date.now()});return {...process.env,...extra};}}));
const {runSkillTest}=await import(${JSON.stringify(helper('session-runner'))});
const base={workingDirectory:${JSON.stringify(dir)},model:'fake-model',maxTurns:7,tools:['Read','Bash'],allowedTools:['Read','Bash'],timeout:2000};
const plain=await runSkillTest({...base,prompt:'plain',appendSystemPrompt:${JSON.stringify(literal)}});
setupMs=250;
const normal=await runSkillTest({...base,prompt:'normal',appendSystemPrompt:${JSON.stringify(literal)},completionReserveMs:500});
setupMs=0;
const defaultBudget=await runSkillTest({...base,timeout:undefined,prompt:'default-budget',completionReserveMs:30000});
setupMs=500;
const started=Date.now();
const hold=await runSkillTest({...base,prompt:'hold',timeout:1000,startupGraceMs:1000,completionReserveMs:400});
const wall=Date.now()-started;
setupMs=150;
const exhausted=await runSkillTest({...base,prompt:'must-not-launch',timeout:100,startupGraceMs:100,completionReserveMs:25});
const rejected=[];
for(const completionReserveMs of [0,-1,NaN,Infinity,null,1000,1001]){
 try{await runSkillTest({...base,prompt:'invalid',timeout:1000,completionReserveMs});rejected.push(false);}
 catch(e){rejected.push(e.message.includes('positive and smaller'));}
}
for(const timeout of [0,-1,NaN,Infinity]){
 try{await runSkillTest({...base,prompt:'invalid-timeout',timeout,completionReserveMs:1});rejected.push(false);}
 catch(e){rejected.push(e.message.includes('positive and smaller'));}
}
const unavailable=[];
for(const unavailableTools of [{tools:['Read']},{allowedTools:['Read']},{tools:[]}]){
 try{await runSkillTest({...base,...unavailableTools,prompt:'missing-clock-tool',completionReserveMs:200});unavailable.push(false);}
 catch(e){unavailable.push(e.message.includes('clock requires Bash'));}
}
console.log(JSON.stringify({setups,plain:plain.exitReason,normal:normal.exitReason,defaultBudget:defaultBudget.exitReason,hold:hold.exitReason,wall,exhausted:exhausted.exitReason,rejected,unavailable}));`);
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`};
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], {cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => child.kill(), 12_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect([result.plain, result.normal, result.defaultBudget]).toEqual(['success','success','success']);
    expect(result.hold).toBe('timeout'); expect(result.wall).toBeGreaterThanOrEqual(950); expect(result.wall).toBeLessThan(2000);
    expect(result.exhausted).toBe('timeout_startup'); expect(result.rejected).toEqual(Array(11).fill(true));
    expect(result.unavailable).toEqual([true,true,true]);
    const launches = fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(launches.map(x=>x.prompt)).toEqual(['plain','normal','default-budget','hold']);
    const notice = (x: any) => x.args[x.args.indexOf('--append-system-prompt')+1] as string;
    expect(notice(launches[0])).toBe(literal);
    expect(notice(launches[1]).startsWith(literal+'\n\nSection completion clock')).toBe(true);
    for (const [i, timeout, reserve] of [[1,2000,500],[2,120000,30000],[3,1000,400]]) {
      const x=launches[i]!, text=notice(x);
      const time=(label:string)=>Date.parse(new RegExp('^'+label+' UTC: (.+)$','m').exec(text)![1]!);
      const start=time('Runner entry'), deadline=time('Hard deadline'), completion=time('Completion reserve starts');
      expect(deadline-start).toBe(timeout); expect(deadline-completion).toBe(reserve);
      expect(start).toBeLessThanOrEqual(result.setups[i].start);
      expect(result.setups[i].end-start).toBeGreaterThanOrEqual(i===1?250:i===3?500:0);
      expect(x.at-result.setups[i].end).toBeGreaterThanOrEqual(90);
      expect(x.clock.code).toBe(0); expect(x.clock.text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Math.abs(Date.parse(x.clock.text)-x.at)).toBeLessThan(1500);
      expect(text).toContain('If the clock read fails, report timing unavailable');
      expect(text).toContain('No required content or gate may be skipped');
      expect(text).toContain('it never resets');
      expect(x.args.filter((v:string)=>v==='--append-system-prompt')).toHaveLength(1);
      if(i===3) expect(x.at).toBeGreaterThanOrEqual(completion);
    }
    const omitNotice=(args:string[])=>args.filter((_,i)=>i!==args.indexOf('--append-system-prompt')&&i!==args.indexOf('--append-system-prompt')+1);
    expect(omitNotice(launches[1].args)).toEqual(omitNotice(launches[0].args));
  } finally {
    clearTimeout(timer); if(child.exitCode===null)child.kill(); await child.exited;
    fs.rmSync(dir,{recursive:true,force:true});
  }
}, 15_000);

test('full review capture exposes its actual timeout while other skill requests stay unchanged', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'section-deadline-routing-'));
  const helper=(name:string)=>path.resolve(import.meta.dir,'helpers',name+'.ts');
  const script=path.join(dir,'capture.ts');
  fs.writeFileSync(script,`import {mock} from 'bun:test';
const observed=[];
mock.module(${JSON.stringify(helper('session-runner'))},()=>({runSkillTest:async opts=>{observed.push(opts);return {exitReason:'success',toolCalls:[],transcript:[],output:''};}}));
const {captureSectionReads}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
for(const skillName of ['plan-ceo-review','plan-eng-review','fixture','ship','office-hours'])for(const timeout of [undefined,480000])await captureSectionReads({planDir:${JSON.stringify(dir)},skillName,scenario:'Complete the supplied scenario.',testName:'deadline-routing',model:'fake-model',...(timeout===undefined?{}:{timeout})});
console.log(JSON.stringify(observed));`);
  const child=Bun.spawn([process.execPath,script],{cwd:dir,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  try{
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,err).toBe(0);
    const requests=JSON.parse(out.trim().split('\n').at(-1)!);
    expect(requests).toHaveLength(10);
    for(const [i,request] of requests.entries()){
      const timeout=i%2===0?300000:480000;
      expect(request.timeout).toBe(timeout);expect(request.model).toBe('fake-model');expect(request.maxTurns).toBe(25);
      expect(request.tools).toEqual(['Read','Grep','Glob','Write','Edit','Agent',...(i<4?['Bash']:[])]);
      expect(request.allowedTools).toEqual(request.tools);
      if(i<4){
        expect(request.completionReserveMs).toBe(timeout/4);
        expect(request.prompt).toContain('runner-bound deadline and the observed clock');
        expect(request.prompt).toContain('Bash may additionally run exactly `date -u +%Y-%m-%dT%H:%M:%SZ`');
        expect(request.prompt).toContain('Native execution window: '+timeout/1000+' seconds');
        expect(request.prompt).toContain('reserve the final '+timeout/4000+' seconds');
        expect(request.prompt).toContain('Every required section, finding, approval and output still has to be completed');
        if(i<2){
          expect(request.prompt).toContain('Follow each workflow save/readback checkpoint as it occurs');
          expect(request.prompt).toContain('As sections finish, add each finding once');
          expect(request.prompt).not.toContain('When Scope Challenge finishes, save its outcome');
          expect(request.prompt).not.toContain('After each completed review section, save');
          expect(request.prompt).not.toContain('Read the saved outcome before advancing');
        }else{
          expect(request.prompt).toContain('When Scope Challenge finishes, save its outcome');
          expect(request.prompt).toContain('After each completed review section, save');
          expect(request.prompt).toContain('Read the saved outcome before advancing to the next section');
        }
      }else{
        expect(request.prompt).not.toContain('Native execution window:');
        expect(request).not.toHaveProperty('completionReserveMs');
        expect(request).not.toHaveProperty('appendSystemPrompt');
        const skill=['fixture','ship','office-hours'][Math.floor((i-4)/2)]!;
        const skillPath=path.join(dir,skill,'SKILL.md');
        const expected=`You are running an automated skill-execution test. No human is present, so AskUserQuestion is unavailable. The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT Glob/find/search for any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and EXECUTE its workflow for this scenario:

Complete the supplied scenario.

Rules for this run:
- Skip system-audit, environment-setup, telemetry, and unrelated codebase exploration. Read the supplied plan's referenced fixture files when its review requires them.
- At any decision point that would call AskUserQuestion, silently pick the skill's recommended option and continue. Do NOT stop to ask.
- This skill's body has been carved into on-demand sections/. When the skill gives a STOP-Read directive (for example "Read \`.../sections/<file>\` and execute it in full"), you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers. Do not work from memory.
- Resolve installed-root paths for section and companion Markdown files under ${dir}, where this fixture's skill package is copied.
- Do NOT run git, gh, commit, push, or any mutating command.
- When the workflow is complete, write the skill's final output (the full review report / ship plan, including any required report table) to ${path.join(dir,'REPORT.md')}.
- After all required writes are complete, return a brief completion message and STOP. Do not reproduce the full report in the final response.`;
        expect(request.prompt).toBe(expected);
      }
    }
  }finally{if(child.exitCode===null)child.kill();await child.exited;fs.rmSync(dir,{recursive:true,force:true});}
},10000);
