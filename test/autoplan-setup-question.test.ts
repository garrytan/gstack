import { describe, expect, test } from 'bun:test';
import { autoplanRoutingSetupInput, autoplanSetupDecision } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIPPED_ROUTING_N = fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-routing-n-screen.txt'), 'utf8');

describe('current routing title survives a scrolled native header before metadata flushes', () => {
  test('exact N frame selects the offered Add action once with a native digit only', () => {
    expect(CLIPPED_ROUTING_N).not.toMatch(/[☐□]/);
    const seen = new Set<string>();
    const decision = autoplanSetupDecision(CLIPPED_ROUTING_N, seen);
    expect(decision.kind).toBe('input');
    if (decision.kind !== 'input') throw Error('Expected native setup input');
    expect(decision.input).toBe('1');
    expect(seen.size).toBe(0);
    for (const signature of decision.signatures) seen.add(signature);
    expect(autoplanSetupDecision(CLIPPED_ROUTING_N, seen).kind).toBe('waiting');
    expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain('test/fixtures/autoplan-routing-n-screen.txt');
  });

  test('equivalent direct title and reordered opposed choices retain picker binding', () => {
    const frame = CLIPPED_ROUTING_N.replace('D1 — Add skill', 'D9 — Add gstack skill');
    const swapped = frame.replace('1. Add routing rules (Recommended)', '1. Skip, invoke manually')
      .replace('2. Skip, invoke manually', '2. Add routing rules (Recommended)');
    expect(autoplanSetupDecision(frame, new Set())).toMatchObject({kind:'input',input:'1'});
    expect(autoplanSetupDecision(swapped, new Set())).toMatchObject({kind:'input',input:'2'});
  });

  test('copied, stale, incomplete, ambiguous and substantive panels cannot borrow the top routing identity', () => {
    for (const frame of [
      'Example panel:\n' + CLIPPED_ROUTING_N,
      'Quoted source:\n' + CLIPPED_ROUTING_N,
      '```text\n' + CLIPPED_ROUTING_N + '\n```',
      '~~~~text\n' + CLIPPED_ROUTING_N,
      CLIPPED_ROUTING_N.split('\n').map(line => '    ' + line).join('\n'),
      CLIPPED_ROUTING_N.split('\n').map(line => '> ' + line).join('\n'),
      CLIPPED_ROUTING_N + '\n⏺ Continuing the review.',
      CLIPPED_ROUTING_N.replace('Esc to cancel', 'Esc to'),
      CLIPPED_ROUTING_N.replace('❯ 1.', '  1.'),
      CLIPPED_ROUTING_N.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'),
      CLIPPED_ROUTING_N.replace('  2.', '❯ 2.'),
      CLIPPED_ROUTING_N.replace('1. Add', '1. [ ] Add'),
      CLIPPED_ROUTING_N.replace('│\n│ Project', '│ ← ☐ Routing ✔ Submit →\n│ Project'),
      CLIPPED_ROUTING_N.replace('  4. Chat about this', ''),
      CLIPPED_ROUTING_N.replace('2. Skip, invoke manually', '2. Add routing rules (Recommended)'),
      CLIPPED_ROUTING_N.replace('2. Skip, invoke manually', '2. Delete routing and migrate the product'),
      CLIPPED_ROUTING_N.replace('routing-injection>', 'product-routing>'),
      CLIPPED_ROUTING_N.replace('routing-injection>', 'routing-injection'),
      CLIPPED_ROUTING_N.replace('│ Project/branch:', '│ <gstack-qid:routing-injection>\n│ Project/branch:'),
      CLIPPED_ROUTING_N.replace('Add skill routing rules to CLAUDE.md?', 'Choose the product API router for CLAUDE.md?'),
      CLIPPED_ROUTING_N.replace('Add skill routing rules to CLAUDE.md?', 'The spec quotes Add skill routing rules to CLAUDE.md?'),
      CLIPPED_ROUTING_N.replace('Add skill routing rules to CLAUDE.md?', 'Add skill routing rules to README.md?'),
      CLIPPED_ROUTING_N.replace(' <gstack-qid:routing-injection>', '').replace('│ Net:', '│ <gstack-qid:routing-injection> Net:'),
      CLIPPED_ROUTING_N.replace('│ ELI10:', '│ ```text\n│ ELI10:'),
      CLIPPED_ROUTING_N.replace('│ ELI10:', '│ > Quoted source:\n│ ELI10:'),
    ]) expect(autoplanSetupDecision(frame, new Set()).kind, frame).not.toBe('input');
  });

  test('present native metadata keeps its full existing identity binding', () => {
    const before = CLIPPED_ROUTING_N.split('❯ 1.')[0]!.replace(/^[│┃] ?/gm, '').trim();
    const call: any = {toolUseId:'n-routing',sessionId:'n',timestamp:'2026-09-09T01:10:05Z',answered:false,failed:false,
      questions:[{header:'Routing',question:before,options:[{label:'Add routing rules (Recommended)'},{label:'Skip, invoke manually'}]}]};
    expect(autoplanSetupDecision(CLIPPED_ROUTING_N,new Set(),call)).toMatchObject({kind:'input',input:'1'});
    for (const mutate of [
      (q:any) => {q.failed=true;}, (q:any) => {q.answered=true;}, (q:any) => {q.questions=[];},
      (q:any) => {q.questions.push(structuredClone(q.questions[0]));},
      (q:any) => {q.questions[0].multiSelect=true;},
      (q:any) => {q.questions[0].question='Unrelated finding <gstack-qid:routing-injection>';},
      (q:any) => {q.questions[0].options[1].label='Another choice';},
    ]) {const changed=structuredClone(call);mutate(changed);expect(autoplanSetupDecision(CLIPPED_ROUTING_N,new Set(),changed).kind).not.toBe('input');}
    const seen=new Set<string>();
    const early=autoplanSetupDecision(CLIPPED_ROUTING_N,seen);
    if(early.kind!=='input')throw Error('Expected initial input');
    for(const signature of early.signatures)seen.add(signature);
    expect(autoplanSetupDecision(CLIPPED_ROUTING_N,seen,call).kind).toBe('waiting');
  });
});

test.skipIf(process.platform === 'win32')('real PTY clipped routing advances from the exact current panel with one digit and no Enter', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-clipped-routing-'));
  const fake=path.join(dir,'fake-claude');const events=path.join(dir,'events.jsonl');
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';
const emit=value=>fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify(value)+'\n');
emit({kind:'started',pid:process.pid});
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',data=>{emit({kind:'input',data:data.toString()});process.stdout.write('\r\nNATIVE_SETUP_ACCEPTED\r\n');});
process.stdout.write(fs.readFileSync(process.env.ROUTING_SCREEN,'utf8').replace(/\n/g,'\r\n'));
process.on('SIGINT',()=>process.exit(0));
`);fs.chmodSync(fake,0o755);
  const worker=path.join(dir,'worker.ts');const resultFile=path.join(dir,'result.json');
  const helper=(name:string)=>pathToFileURL(path.resolve(import.meta.dir,'helpers',name)).href;
  fs.writeFileSync(worker,`
import * as fs from 'node:fs';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
import {autoplanSetupDecision} from ${JSON.stringify(helper('autoplan-setup-question.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('Fake binary binding failed before launch');
const session=await launchClaudePty({cwd:${JSON.stringify(dir)},observeScreen:true,timeoutMs:15000,
  env:{ROUTING_EVENTS:process.env.ROUTING_EVENTS,ROUTING_SCREEN:process.env.ROUTING_SCREEN}});
try{
  await session.waitFor('Enter to select',{timeoutMs:10000,pollMs:20});
  const screen=await session.currentScreen();
  const decision=autoplanSetupDecision(screen,new Set());
  if(decision.kind!=='input'||decision.input!=='1')throw Error('Expected current setup: '+JSON.stringify(decision));
  session.send(decision.input);
  await session.waitFor('NATIVE_SETUP_ACCEPTED',{timeoutMs:3000,pollMs:20});
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({screen,decision}));
}finally{await session.close();}
`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,
    ROUTING_EVENTS:events,ROUTING_SCREEN:path.join(import.meta.dir,'fixtures/autoplan-routing-n-screen.txt')},stdout:'pipe',stderr:'pipe'});
  const killer=setTimeout(()=>child.kill('SIGKILL'),17000);
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit,stdout+stderr).toBe(0);
    const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
    expect(result.screen).not.toMatch(/[☐□]/);
    expect(result.decision).toMatchObject({kind:'input',input:'1'});
    const recorded=fs.readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(recorded.filter(e=>e.kind==='input')).toEqual([{kind:'input',data:'1'}]);
    expect(()=>process.kill(recorded[0].pid,0)).toThrow();
  } finally {
    clearTimeout(killer);child.kill('SIGKILL');
    if(fs.existsSync(events)){
      const pid=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!).pid;
      if(process.platform==='linux')try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(pid,'SIGKILL');}catch{}
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},20000);

// Sanitized terminal frame from the 2026-09-08 autoplan timeout. The qid is
// visibly incomplete; the prompt body and explicit choices remain intact.
const CAPTURE = [
  '─'.repeat(120),
  'Planning: /tmp/hermetic/.claude/plans/modular-bouncing-swing.md',
  '─'.repeat(120),
  ' ☐ Routing rules',
  "│ gstack works best when your project's CLAUDE.md includes skill routing rules. Add them now?",
  '│<gstck-qid:routing-injectin>',
  '❯1.Addroutingrules(Recommended)',
  'CreatesCLAUDE.mdwithskillroutingrulessogstackknowswhentoinvoke/office-hours,/autoplan,/ship,/qa,',
  "etc.automatically.We'lldothisafterthereview.",
  '2.Nothanks',
  "Skip—I'llinvokeskillsmanually.Youcanenablethislaterbyrunninggstack-configsetrouting_declinedfalse.",
  '3.Typesomething.',
  '4.Chataboutthis',
  'Entertoselect·↑/↓tonavigate·Esctocancel',
].join('\r\r');

// Targeted-a stalled on this complete menu for the full test budget. Parsing
// retained its identity and choices; the setup helper rejected their wording.
const CURRENT_CAPTURE = [
  ' ☐ Routing rules',
  '',
  'Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>',
  '',
  '❯1.AddtoCLAUDE.md(recommended)',
  '',
  'Appendsa##SkillroutingsectiontoCLAUDE.mdandcommitsit.Futuresessionswillauto-invoketherightskill',
  '(/investigateforbugs,/shipforPRs,/qafortesting,etc.)withoutmanualinvocation.',
  '',
  '2.Skip—invokemanually',
  '',
  "Nofilechanges.You'llcontinuecallingskillsbyname.Canaddroutingruleslater.",
  '',
  '3.Typesomething.',
  '─'.repeat(120),
  '4.Chataboutthis',
  'Entertoselect·↑/↓tonavigate·Esctocancel',
].join('\n');

// Targeted-b's first attempt stayed on this complete setup menu until its
// 15-minute deadline. The parser retained the prompt and both labels, but
// the setup selector rejected "No thanks, invoke manually".
const B_CAPTURE = [
  ' ☐ CLAUDE.md',
  '',
  '│ D1 — Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>',
  '│',
  '│ELI10:ThisprojecthasnoCLAUDE.md.Thatfileiswheregstacklooksforroutingrules—instructionstellingClaude',
  '│Codewhichskilltoauto-invokeforwhichrequest(e.g."ship→/ship","bugs→/investigate").Withoutityoutype',
  '│theskillnameeverytime.Withit,gstackcanrecognizeyourintentandrouteautomatically.',
  '│',
  '│Stakesifweskip:Noauto-routing;youinvokeskillsmanuallyeachsession.',
  '│',
  '│Recommendation:A—one-timesetup,saveskeystrokesoneveryfuturesession.',
  '│Completeness:A=9/10,B=5/10',
  '',
  '❯1.AddroutingrulestoCLAUDE.md(Recommended)',
  'AppendsthestandardgstackroutingblocktoanewCLAUDE.mdandcommitsit.Doneonce,activeforever.',
  '2.Nothanks,invokemanually',
  'SkipCLAUDE.mdsetup.Youcontinuecalling/autoplan,/ship,/qa,etc.bynameeachtime.',
  '3.Typesomething.',
  '─'.repeat(120),
  '4.Chataboutthis',
  'Entertoselect·↑/↓tonavigate·Esctocancel',
].join('\r\r');

// Fresh broad retry: the complete setup menu uses a noun for the manual
// alternative. This is the same opposed setup action as "invoke manually".
const FRESH_RETRY_CAPTURE = [
  '☐Routingsetup',
  "│gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Addthemnow?",
  '❯1.Addroutingrules(Recommended)',
  'AppendskillroutingrulestoCLAUDE.mdsoClaudeautomaticallyinvokestherightskillforproduct,engineering,',
  'design,andshipworkflows.Willbedoneafterplanapproval(planmodeisactivenow).',
  '2.Nothanks,manualinvocation',
  "Skip—I'llinvokeskillsmanually.Thispromptwon'tappearagain.",
  '3.Typesomething.',
  '─'.repeat(120),
  '4.Chataboutthis',
  'Entertoselect·↑/↓tonavigate·Esctocancel',
].join('\n');

describe('autoplan routing setup handling', () => {
  // Source-F retry's first complete frame preceded damaged terminal redraws.
  const F_SETUP_CAPTURE = [
    'Planning: /tmp/hermetic/.claude/plans/deep-coalescing-valiant.md',
    '☐Skillrouting',
    "│gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Addthemnow?",
    '❯1.AddroutingrulestoCLAUDE.md',
    'AppendsskillroutingrulestoCLAUDE.mdsogstackauto-invokestherightskillforcommonrequests(review,ship,',
    'investigate,etc.).Willbecommittedtotherepo.(recommended)',
    '2.Nothanks,skip',
    "I'llinvokeskillsmanually.Youcanaddroutinglater.",
    '3.Typesomething.',
    '4.Chataboutthis',
    'Entertoselect·↑/↓tonavigate·Esctocancel',
  ].join('\r\r');

  test('answers the captured combined decline action once, regardless of option order', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE, seen)).toBeNull();
    const reordered = F_SETUP_CAPTURE.replace('❯1.AddroutingrulestoCLAUDE.md', '❯1.Nothanks,skip')
      .replace('2.Nothanks,skip', '2.AddroutingrulestoCLAUDE.md');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2');
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE.replace('Nothanks,skip', 'No thanks, skip—invoke skills manually'), new Set())).toBe('1');
  });

  test('does not infer a routing answer from damaged, ambiguous, or unrelated setup choices', () => {
    for (const frame of [
      F_SETUP_CAPTURE.replace('Addroutingrules', 'Addrutingrules'),
      F_SETUP_CAPTURE.replace('Nothanks,skip', 'Nothank,skip'),
      F_SETUP_CAPTURE.replace('Nothanks,skip', 'No thanks, skip the review'),
      F_SETUP_CAPTURE.replace('Nothanks,skip', 'No thanks, skip then delete CLAUDE.md'),
      F_SETUP_CAPTURE.replace('3.Typesomething.', '3.Skip'),
      F_SETUP_CAPTURE.replace("gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Addthemnow?", 'Which routing design should the application use?'),
    ]) expect(autoplanRoutingSetupInput(frame, new Set()), frame).toBeNull();
  });

  test('answers the fresh retry manual-invocation setup once in either option order', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE, seen)).toBeNull();
    const reordered = FRESH_RETRY_CAPTURE.replace('❯1.Addroutingrules(Recommended)', '❯1.Nothanks,manualinvocation')
      .replace('2.Nothanks,manualinvocation', '2.Addroutingrules(Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2');
  });

  test('requires opposed manual setup actions and rejects ambiguous or unrelated choices', () => {
    for (const decline of [
      'No thanks, delete the file manually',
      'No thanks, manual data migration',
      'No thanks, invoke the deploy manually',
      'Manual deployment invocation',
      'Accept recommendation',
      'No thanks, manual invocation then delete CLAUDE.md',
    ]) {
      const frame = FRESH_RETRY_CAPTURE.replace('Nothanks,manualinvocation', decline);
      expect(autoplanRoutingSetupInput(frame, new Set()), decline).toBeNull();
    }
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE.replace('3.Typesomething.', '3.Add routing rules'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE.replace('3.Typesomething.', '3.Skip—invoke manually'), new Set())).toBeNull();
    const review = FRESH_RETRY_CAPTURE.replace(
      "gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Addthemnow?",
      'Which product routing design should we ship? <gstack-qid:routing-injection>',
    );
    expect(autoplanRoutingSetupInput(review, new Set())).toBeNull();
  });

  test('answers the captured setup once, using the full question identity', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBeNull();
    expect(autoplanRoutingSetupInput(CAPTURE.replace('works best', 'works   best'), seen)).toBeNull();
  });

  test('chooses Add routing rules by label when option order changes', () => {
    const reordered = CAPTURE.replace('❯1.Addroutingrules(Recommended)', '❯1.Nothanks')
      .replace('2.Nothanks', '2.Add routing rules (Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2');
  });

  test('accepts the full option labels captured from the subsequent live setup prompt', () => {
    const fullLabels = CAPTURE.replace('Addroutingrules(Recommended)', 'Add routing rules to CLAUDE.md (Recommended)')
      .replace('2.Nothanks', "2.No thanks, I'll invoke skills manually");
    expect(autoplanRoutingSetupInput(fullLabels, new Set())).toBe('1');
    expect(autoplanRoutingSetupInput(fullLabels.replace('CLAUDE.md (Recommended)', 'product routes (Recommended)'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(fullLabels.replace("I'll invoke skills manually", 'delete the existing rules'), new Set())).toBeNull();
  });

  test('answers the current captured CLAUDE.md setup, including reordered choices, once', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE, seen)).toBeNull();
    const reordered = CURRENT_CAPTURE.replace('❯1.AddtoCLAUDE.md(recommended)', '❯1.Skip—invokemanually')
      .replace('2.Skip—invokemanually', '2.AddtoCLAUDE.md(recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2');
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE.replace('to CLAUDE.md?', "to this project's CLAUDE.md?"), new Set())).toBe('1');
  });

  test('the current wording still requires both explicit setup choices and the CLAUDE.md target', () => {
    for (const frame of [
      CURRENT_CAPTURE.replace('to CLAUDE.md?', 'to the application API?'),
      CURRENT_CAPTURE.replace('AddtoCLAUDE.md(recommended)', 'Acceptrecommendation'),
      CURRENT_CAPTURE.replace('Skip—invokemanually', 'Deferthisfinding'),
      CURRENT_CAPTURE.replace('AddtoCLAUDE.md(recommended)', 'Deletetheexistingroutingrules'),
      CURRENT_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md?', 'Should we expand the current feature?'),
    ]) expect(autoplanRoutingSetupInput(frame, new Set())).toBeNull();
  });

  test('recognizes the native A retry packet with its abbreviated manual-decline label', () => {
    const retry = CAPTURE.replace('Addroutingrules(Recommended)', 'Add to CLAUDE.md (Recommended)')
      .replace('2.Nothanks', '2.No thanks, manual');
    expect(autoplanRoutingSetupInput(retry, new Set())).toBe('1');
    expect(autoplanRoutingSetupInput(retry.replace('No thanks, manual', 'No thanks, delete it'), new Set())).toBeNull();
  });

  test('answers the exact B timeout menu by its routing label, in either order', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(B_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(B_CAPTURE, seen)).toBeNull();
    const reordered = B_CAPTURE.replace('❯1.AddroutingrulestoCLAUDE.md(Recommended)', '❯1.Nothanks,invokemanually')
      .replace('2.Nothanks,invokemanually', '2.AddroutingrulestoCLAUDE.md(Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2');
    expect(autoplanRoutingSetupInput(B_CAPTURE.replace('Nothanks,invokemanually', 'Nothanks,deletethefilemanually'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(B_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md?', 'Which routing design should the application use?'), new Set())).toBeNull();
  });

  test('recognizes the setup premise without depending on its closing sentence', () => {
    const openings = [
      "gstack works best when your project's CLAUDE.md includes skill routing rules. Would you like to add them?",
      "gstack works best when your project's CLAUDE.md includes skill routing rules. Enable them for this repository?",
      'Should we configure skill routing rules for gstack in CLAUDE.md?',
      'Set up gstack skill routing rules in CLAUDE.md.',
    ];
    for (const opening of openings) {
      const frame = CURRENT_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>', opening);
      expect(autoplanRoutingSetupInput(frame, new Set()), opening).toBe('1');
    }
  });

  test('recognizes an intact setup qid with an explicit CLAUDE.md action and opposed manual decline', () => {
    const frame = CURRENT_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md?', 'Configure this project’s CLAUDE.md?');
    expect(autoplanRoutingSetupInput(frame, new Set())).toBe('1');
    expect(autoplanRoutingSetupInput(frame.replace('gstack-qid:routing-injection', 'gstack-qid:product-routing'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(frame.replace('AddtoCLAUDE.md(recommended)', 'Acceptrecommendation'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(frame.replace('Skip—invokemanually', 'Deferthisfinding'), new Set())).toBeNull();
  });

  test('keeps generic review, quoted premises and different routing targets out of setup handling', () => {
    for (const question of [
      'Which dashboard layout should we ship?',
      'Add routing rules to the application API? <gstack-qid:product-routing>',
      'The plan quotes gstack CLAUDE.md skill routing rules. Which API design should we use?',
      'The document references gstack skill routing rules in CLAUDE.md. Should we expand the feature?',
    ]) {
      const frame = CURRENT_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>', question);
      expect(autoplanRoutingSetupInput(frame, new Set()), question).toBeNull();
    }
  });

  test('waits for complete recognized choices rather than guessing a default', () => {
    expect(autoplanRoutingSetupInput(CAPTURE.replace('2.Nothanks', '2.Ask me later'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(CAPTURE.replace('Addroutingrules(Recommended)', 'Accept recommendation'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput('❯1.Addroutingrules(Recommended)\r2.Nothanks', new Set())).toBeNull();
  });

  test('never answers review or taste questions, even with a routing qid or the same choices', () => {
    const prompts = [
      'Which visual direction should this settings page use?',
      'Should the payment handler bypass the existing dispatcher?',
      'Add routing rules to the product API now? <gstack-qid:routing-injection>',
      'The plan quotes CLAUDE.md skill routing rules. Should we change this feature?',
    ];
    for (const prompt of prompts) {
      const frame = `☐ Review decision\r${prompt}\r❯1.Addroutingrules(Recommended)\r2.Nothanks`;
      expect(autoplanRoutingSetupInput(frame, new Set())).toBeNull();
    }
  });

  test('setup helper and captured-frame changes select the autoplan eval only', () => {
    for (const file of ['test/helpers/autoplan-setup-question.ts', 'test/autoplan-setup-question.test.ts', 'test/fixtures/autoplan-routing-n-screen.txt']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
    }
  });
});

// Source-G's retry remained at this actual captured menu until shard timeout.
// The action is intact; cumulative ANSI stripping loses the courtesy's 'o'.
// A real xterm replay retains it in the prior screen cell.
const G_ROUTING_CAPTURE = [
  '☐Routingrules',
  "│gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Wouldyouliketoaddthem?",
  '❯1.AddroutingrulestoCLAUDE.md',
  'AppendsstandardskillroutingrulestoCLAUDE.md(creatingitifabsent)andcommits.Meansgstackskillslike',
  '/autoplan,/ship,/qaetc.getinvokedautomaticallywhenthetaskmatches.(recommended)',
  "2. N thanks, I'll invokeskillsmanually",
  'Skiprouting setup. You can re-enable later by removing the routing_declined flag.',
  '3.Typesomething.',
  '4.Chataboutthis',
  'Enter toselect · ↑/↓ to navigate · Esc to cancel',
].join('\r');

describe('autoplan routing action survives courtesy repaint', () => {
  test('selects the explicit Add action once in the captured G menu, in both orders', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(G_ROUTING_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(G_ROUTING_CAPTURE, seen)).toBeNull();
    const reversed = G_ROUTING_CAPTURE.replace('❯1.AddroutingrulestoCLAUDE.md', "❯1.N thanks, I'll invokeskillsmanually")
      .replace("2. N thanks, I'll invokeskillsmanually", '2.AddroutingrulestoCLAUDE.md');
    expect(autoplanRoutingSetupInput(reversed, new Set())).toBe('2');
  });

  test('the actual manual-invocation action needs no courtesy formula', () => {
    for (const action of ['Manual invocation', 'Invoke skills manually', "I'll invoke skills manually", 'Thanks, invoke manually']) {
      expect(autoplanRoutingSetupInput(G_ROUTING_CAPTURE.replace("N thanks, I'll invokeskillsmanually", action), new Set()), action).toBe('1');
    }
  });

  test('still requires exact opposed setup actions and a genuine routing premise', () => {
    for (const label of [
      'N thanks', 'Invoke the deployment manually', 'N thanks, manual data migration',
      'Delete CLAUDE.md, invoke skills manually', 'No thanks, invoke skills manually then delete CLAUDE.md',
      'Skip the review, invoke skills manually', 'Skip the review thanks, invoke skills manually',
    ]) expect(autoplanRoutingSetupInput(G_ROUTING_CAPTURE.replace("N thanks, I'll invokeskillsmanually", label), new Set()), label).toBeNull();
    for (const frame of [
      G_ROUTING_CAPTURE.replace("gstackworksbestwhenyourproject'sCLAUDE.mdincludesskillroutingrules.Wouldyouliketoaddthem?", 'Which application router should we implement?'),
      G_ROUTING_CAPTURE.replace('AddroutingrulestoCLAUDE.md', 'AddrutingrulestoCLAUDE.md'),
      G_ROUTING_CAPTURE.replace('3.Typesomething.', '3.Invoke skills manually'),
      G_ROUTING_CAPTURE.replace('3.Typesomething.', '3.Add routing rules'),
    ]) expect(autoplanRoutingSetupInput(frame, new Set()), frame).toBeNull();
  });
});


const PREREQUISITE_CAPTURE = " ☐ Design doc\n\n│ No design doc found for this branch. /office-hours produces a structured problem statement, premise challenge, and\n│ explored alternatives — it gives this review much sharper input to work with. Takes about 10 minutes. The design doc\n│ is per-feature, not per-product — it captures the thinking behind this specific change. Run /office-hours first?\n\n❯ 1. Run /office-hours now\n     Runs /office-hours to produce a design doc first, then picks up the full autoplan review right after. (~10 min)\n  2. Skip — proceed with standard review\n     Skips /office-hours and runs the autoplan review pipeline now using the existing plan file as input.\n  3. Type something.\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n";
const prerequisiteQuestion = {
  header: 'Design doc',
  question: "No design doc found for this branch. /office-hours produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input to work with. Takes about 10 minutes. The design doc is per-feature, not per-product — it captures the thinking behind this specific change. Run /office-hours first?",
  options: [{ label: 'Run /office-hours now' }, { label: 'Skip — proceed with standard review' }],
};
const prerequisiteCall = () => ({
  sessionId: 'prerequisite-session', toolUseId: 'prerequisite-call',
  answered: false, failed: false, questions: [structuredClone(prerequisiteQuestion)],
});
function prerequisiteMenu(reverse = false) {
  if (!reverse) return PREREQUISITE_CAPTURE;
  return PREREQUISITE_CAPTURE
    .replace('1. Run /office-hours now', '1. Skip — proceed with standard review')
    .replace('2. Skip — proceed with standard review', '2. Run /office-hours now');
}

describe('autoplan optional design-doc prerequisite', () => {
  test('the exact K native screen declines the optional prerequisite by label', () => {
    for (const reverse of [false, true]) {
      const frame = prerequisiteMenu(reverse);
      expect(autoplanRoutingSetupInput(frame, new Set())).toBe(reverse ? '1' : '2');
      const native = prerequisiteCall(); if (reverse) native.questions[0]!.options.reverse();
      expect(autoplanRoutingSetupInput(frame, new Set(), native)).toBe(reverse ? '1' : '2');
    }
  });

  test('quoted panels and menus followed by new output are not active input', () => {
    for (const frame of [
      'Example panel:\n```text\n' + PREREQUISITE_CAPTURE + '\n```\n',
      'Example panel:\n~~~text\n' + PREREQUISITE_CAPTURE,
      'Example panel:\n' + PREREQUISITE_CAPTURE,
      PREREQUISITE_CAPTURE.split('\n').map(line => '    ' + line).join('\n'),
      'The document quotes this panel:\n────────────────────\n' + PREREQUISITE_CAPTURE,
      PREREQUISITE_CAPTURE + '\n⏺ Continuing the review without office hours.\n',
      PREREQUISITE_CAPTURE + '\n❯ 1. A new menu\n  2. Another choice\n',
    ]) for (const native of [undefined, prerequisiteCall()]) {
      expect(autoplanRoutingSetupInput(frame, new Set(), native)).toBeNull();
    }
    expect(autoplanRoutingSetupInput('```text\nearlier real code\n```\n────────────────────\n' + PREREQUISITE_CAPTURE, new Set())).toBe('2');
  });

  test('late native identity does not re-answer the retained menu', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(PREREQUISITE_CAPTURE, seen)).toBe('2');
    expect(autoplanRoutingSetupInput(PREREQUISITE_CAPTURE, seen, prerequisiteCall())).toBeNull();
    expect(autoplanRoutingSetupInput(PREREQUISITE_CAPTURE, seen)).toBeNull();
  });

  test('unrelated, failed, mixed and checkbox native calls do not borrow the setup menu', () => {
    for (const mutate of [
      (call: ReturnType<typeof prerequisiteCall>) => { call.questions[0]!.question = 'Should we change the dashboard design?'; },
      (call: ReturnType<typeof prerequisiteCall>) => { call.failed = true; },
      (call: ReturnType<typeof prerequisiteCall>) => { call.answered = true; },
      (call: ReturnType<typeof prerequisiteCall>) => { call.questions.push({ header:'Finding', question:'Fix missing auth?', options:[{label:'Fix it'},{label:'Defer'}] }); },
      (call: ReturnType<typeof prerequisiteCall>) => { Object.assign(call.questions[0]!, {multiSelect:true}); },
    ]) {
      const native = prerequisiteCall(); mutate(native);
      const seen = new Set<string>();
      expect(autoplanRoutingSetupInput(PREREQUISITE_CAPTURE, seen, native)).toBeNull();
      // Waiting for correct metadata must not mark an unanswered UI as sent.
      expect(autoplanRoutingSetupInput(PREREQUISITE_CAPTURE, seen, prerequisiteCall())).toBe('2');
    }
  });

  test('arbitrary skip, outside offers, mixed actions and prose examples remain unanswered', () => {
    for (const frame of [
      PREREQUISITE_CAPTURE.replace('Skip — proceed with standard review', 'Skip this security check'),
      PREREQUISITE_CAPTURE.replaceAll('/office-hours', '/codex'),
      PREREQUISITE_CAPTURE.replace('3. Type something.', '3. Fix the missing authorization check'),
      PREREQUISITE_CAPTURE.replace('No design doc found for this branch.', 'A dashboard design issue was found.'),
      PREREQUISITE_CAPTURE.replace(' ☐ Design doc', 'Example choices:').replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
    ]) expect(autoplanRoutingSetupInput(frame, new Set())).toBeNull();
  });
});

test.skipIf(process.platform === 'win32')('real PTY prerequisite answer survives early and deferred native records without a second key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-prereq-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const resultFile = path.join(dir, 'result.json');
  const cases = [false, true].flatMap(early => [false, true].map(reverse => {
    const name = `${early ? 'early' : 'deferred'}-${reverse ? 'reversed' : 'original'}`;
    const q = structuredClone(prerequisiteQuestion); if (reverse) q.options.reverse();
    return { name, early, cwd: path.join(dir, name), record: path.join(dir, name + '.jsonl'),
      question: q, frame: prerequisiteMenu(reverse), expected: reverse ? '1' : '2' };
  }));
  for (const item of cases) fs.mkdirSync(item.cwd);
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const item = JSON.parse(process.env.PREREQUISITE_REPLAY);
const record = event => fs.appendFileSync(item.record, JSON.stringify(event) + '\n');
record({type:'startup',pid:process.pid});
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
fs.mkdirSync(folder, {recursive:true});
const transcript = path.join(folder, item.name + '.jsonl');
let logged = false;
function writeCall() {
  if (logged) return; logged = true;
  fs.appendFileSync(transcript, JSON.stringify({type:'assistant',sessionId:item.name,isSidechain:false,cwd:process.cwd(),timestamp:new Date().toISOString(),
    message:{role:'assistant',content:[{type:'tool_use',id:'prerequisite',name:'AskUserQuestion',input:{questions:[item.question]}}]}})+'\n');
}
if (item.early) writeCall();
process.stdin.setRawMode?.(true);
let answered = false;
process.stdin.on('data', data => {
  record({type:'input',data:data.toString()});
  for (const key of data.toString()) if (/^[12]$/.test(key) && !answered) {
    answered = true; writeCall();
    const label = item.question.options[Number(key)-1].label;
    fs.appendFileSync(transcript, JSON.stringify({type:'user',sessionId:item.name,isSidechain:false,cwd:process.cwd(),timestamp:new Date().toISOString(),
      toolUseResult:{answers:{[item.question.question]:label}},
      message:{role:'user',content:[{type:'tool_result',tool_use_id:'prerequisite',content:'answered'}]}})+'\n');
    process.stdout.write('\x1b[2J\x1b[H'+item.frame+'\nSETUP_ANSWERED\n');
  }
});
process.stdout.write('\x1b[2J\x1b[H'+item.frame);
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  const moduleUrl = (name: string) => pathToFileURL(path.resolve(import.meta.dir, 'helpers', name)).href;
  fs.writeFileSync(worker, `
import {launchClaudePty} from ${JSON.stringify(moduleUrl('claude-pty-runner.ts'))};
import {autoplanRoutingSetupInput} from ${JSON.stringify(moduleUrl('autoplan-setup-question.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(moduleUrl('plan-count-transcript.ts'))};
const results = await Promise.all(${JSON.stringify(cases)}.map(async item => {
  const session = await launchClaudePty({cwd:item.cwd,observeScreen:true,timeoutMs:20000,env:{PREREQUISITE_REPLAY:JSON.stringify(item)}});
  try {
    await session.waitFor('Enter to select', {timeoutMs:10000,pollMs:20});
    const screen = await session.currentScreen();
    const before = readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
    const pending = before.calls.find(call => !call.answered && !call.failed);
    if (Boolean(pending) !== item.early) throw Error('Wrong initial native persistence state');
    const seen = new Set();
    const input = autoplanRoutingSetupInput(screen,seen,pending);
    if (input !== item.expected) throw Error('Expected skip input '+item.expected+', got '+JSON.stringify(input));
    session.send(input);
    await session.waitFor('SETUP_ANSWERED', {timeoutMs:10000,pollMs:20});
    const after = readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
    const call = after.calls[0];
    if (after.calls.length !== 1 || !call.answered) throw Error('Native answer was not persisted');
    const retained = await session.currentScreen();
    return {name:item.name,input,answer:call.answers[item.question.question],
      redraw:autoplanRoutingSetupInput(retained,seen),
      delayedIdentity:autoplanRoutingSetupInput(screen,seen,{...call,answered:false})};
  } finally {await session.close();}
}));
await Bun.write(${JSON.stringify(resultFile)},JSON.stringify(results));
`);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stdout + stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual(cases.map(item => ({
      name:item.name,input:item.expected,answer:'Skip — proceed with standard review',redraw:null,delayedIdentity:null,
    })));
    for (const item of cases) {
      const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.type === 'input').map(event => event.data).join('')).toBe(item.expected);
      expect(() => process.kill(events[0].pid, 0)).toThrow();
    }
  } finally {
    clearTimeout(killer); child.kill('SIGKILL');
    for (const item of cases) {
      if (!fs.existsSync(item.record)) continue;
      const first = JSON.parse(fs.readFileSync(item.record, 'utf8').split('\n')[0]!);
      try { process.kill(first.pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
    fs.rmSync(dir, {recursive:true,force:true});
  }
}, 30000);


// Exact current viewport from source-M's routing stall. Owned temporary paths
// are retained as display text; no fixture path is accessed by this replay.
const M_ROUTING_CAPTURE = "\n\n❯ /autoplan\n\n● Starting the autoplan pipeline — running the preamble first.\n\n● Bash(_SS=\"$HOME/.claude/skills/gstack/bin/gstack-skill-start\"\n      [ -x \"$_SS\" ] || _SS=\".claude/skills/gstack/bin/gstack-skill-start\"…)\n  ⎿  SKILL_START_PROTO: 1\n     BRANCH: main\n     PROACTIVE: true \n     … +54 lines (ctrl+o to expand)\n  ⎿  Allowed by auto mode classifier\n\n● The preamble ran. SESSION_KIND is interactive, SESSION_ID is 1144263-1788912944-701e8cc4. There's a one-time routing\n  instruction to handle first.\n\n  Let me check if CLAUDE.md exists and explore the repo before presenting the routing question.\n\n  Read 1 file, listed 1 directory (ctrl+o to expand)\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\nPlanning:\n/tmp/gstack-paid-shard-2DwzUD/tmp/gstack-hermetic-1144068-Ep9FFb/with-skills/.claude/plans/scalable-bouncing-moth.md\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Skill routing\n\n│ gstack works best when your project's CLAUDE.md includes skill routing rules. Should I add them now?\n│ <gstack-qid:routing-injection>\n\n❯ 1. Add routing rules (Recommended)\n     Append skill routing rules to CLAUDE.md and commit it — /autoplan, /ship, /qa, and other skills will be suggested\n     automatically when relevant.\n  2. No thanks, manual only\n     Skip for now; you can invoke skills manually anytime. You won't be asked again.\n  3. Type something.\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n";

describe('M routing manual-only action grammar', () => {
  test('answers the exact native panel once and preserves the Add choice in either order', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(M_ROUTING_CAPTURE, seen)).toBe('1');
    expect(autoplanRoutingSetupInput(M_ROUTING_CAPTURE, seen)).toBeNull();
    const reversed = M_ROUTING_CAPTURE
      .replace('❯ 1. Add routing rules (Recommended)', '❯ 1. No thanks, manual only')
      .replace('  2. No thanks, manual only', '  2. Add routing rules (Recommended)');
    expect(autoplanRoutingSetupInput(reversed, new Set())).toBe('2');
  });

  test('equivalent manual actions use the same grammar with or without a courtesy prefix', () => {
    for (const label of [
      'No thanks, manual', 'No thanks, manual only', 'Skip — manual only',
      'Manual', 'Manual only', 'Manual-only', 'Manual invocation', 'Manual invocation only',
      'No thanks, manual invocation only', 'Invoke skills manually only',
      "No thanks, I'll invoke skills manually only",
    ]) expect(autoplanRoutingSetupInput(M_ROUTING_CAPTURE.replace('No thanks, manual only', label), new Set()), label).toBe('1');
  });

  test('manual modifiers do not admit extra actions, other workflows or ambiguous choices', () => {
    for (const label of [
      'No thanks, manual data migration only', 'Manual deployment only',
      'No thanks, invoke the deployment manually only', 'No thanks, manual only then delete CLAUDE.md',
      'No thanks, skip the review', 'No thanks, proceed with implementation',
      'No thanks, manual invocation only after deleting the rules', 'Manual only approval',
    ]) expect(autoplanRoutingSetupInput(M_ROUTING_CAPTURE.replace('No thanks, manual only', label), new Set()), label).toBeNull();
    for (const frame of [
      M_ROUTING_CAPTURE.replace('  3. Type something.', '  3. Manual only'),
      M_ROUTING_CAPTURE.replace('  3. Type something.', '  3. Add routing rules'),
      M_ROUTING_CAPTURE.replace('Add routing rules (Recommended)', 'Add product routes (Recommended)'),
      M_ROUTING_CAPTURE.replace('Add routing rules (Recommended)', 'Add ruting rules (Recommended)'),
      M_ROUTING_CAPTURE.replace("gstack works best when your project's CLAUDE.md includes skill routing rules. Should I add them now?", 'Which application API routing design should we choose?'),
      M_ROUTING_CAPTURE.replace("gstack works best when your project's CLAUDE.md includes skill routing rules. Should I add them now?", 'The plan quotes gstack skill routing rules in CLAUDE.md. Should we expand the feature?'),
    ]) expect(autoplanRoutingSetupInput(frame, new Set()), frame).toBeNull();
  });
});


const UNSUPPORTED_ROUTING = M_ROUTING_CAPTURE.replace('No thanks, manual only', 'Ask me after this review');
const unsupportedNative = () => ({
  sessionId: 'unsupported-routing', toolUseId: 'routing-call', answered: false, failed: false,
  questions: [{ header: 'Skill routing', question: "gstack works best when your project's CLAUDE.md includes skill routing rules. Should I add them now? <gstack-qid:routing-injection>",
    options: [{label:'Add routing rules (Recommended)'},{label:'Ask me after this review'}] }],
});

describe('unsupported setup diagnostic state', () => {
  test('a complete recognized unsupported setup fails explicitly without selecting an action', () => {
    const seen = new Set<string>();
    for (const pending of [undefined, unsupportedNative()]) {
      const result = autoplanSetupDecision(UNSUPPORTED_ROUTING, seen, pending);
      expect(result.kind).toBe('unsupported_setup');
      if (result.kind === 'unsupported_setup') {
        expect(result.setup).toBe('routing');
        expect(result.options).toEqual([{index:1,label:'Add routing rules (Recommended)'},{index:2,label:'Ask me after this review'}]);
        expect(result.identitySource).toBe(pending ? 'native-bound' : 'current-native-panel');
      }
      expect(seen.size).toBe(0);
    }
    expect(autoplanSetupDecision(PREREQUISITE_CAPTURE.replace('Skip — proceed with standard review', 'Ask me later'), new Set()).kind).toBe('unsupported_setup');
  });

  test('supported input is pure until sent; redraw and delayed metadata then wait', () => {
    const seen = new Set<string>();
    const decision = autoplanSetupDecision(M_ROUTING_CAPTURE, seen);
    expect(decision.kind).toBe('input'); expect(seen.size).toBe(0);
    if (decision.kind !== 'input') throw Error('Expected supported setup');
    expect(decision.input).toBe('1');
    for (const signature of decision.signatures) seen.add(signature);
    expect(autoplanSetupDecision(M_ROUTING_CAPTURE, seen).kind).toBe('waiting');
    const native = unsupportedNative(); native.questions[0]!.options[1]!.label = 'No thanks, manual only';
    expect(autoplanSetupDecision(M_ROUTING_CAPTURE, seen, native).kind).toBe('waiting');
    expect(autoplanSetupDecision(M_ROUTING_CAPTURE + '\n⏺ Continuing…', seen).kind).toBe('waiting');
    expect(autoplanSetupDecision(PREREQUISITE_CAPTURE, new Set()).kind).toBe('input');
  });

  test('a substantive product or taste question mentioning office hours is not an unsupported prerequisite', () => {
    const fullQuestion = prerequisiteQuestion.question;
    const unsupported = PREREQUISITE_CAPTURE.replace('Skip — proceed with standard review', 'Ask me after this review');
    for (const [prompt, first, second] of [
      ['No design doc exists for /office-hours integration. Should we build X or defer Y?', 'Build X', 'Defer Y'],
      ['We should produce a design doc for /office-hours. Which visual style should this product use?', 'Minimal', 'Expressive'],
      ['No design doc exists for /office-hours integration. Should we build X or defer Y?', 'Run /office-hours now', 'Defer Y'],
      ['No design doc found. Run /office-hours first?', 'Run /office-hours now and delete the feature', 'Ask me later'],
    ]) {
      const native = prerequisiteCall();
      native.questions[0]!.question = prompt!;
      native.questions[0]!.options = [{label:first!},{label:second!}];
      // Reconstruct from the actual full native layout, including footer.
      const frame = unsupported.replace(/│ No design doc[\s\S]*?Run \/office-hours first\?/, prompt!)
        .replace('1. Run /office-hours now', '1. ' + first)
        .replace('2. Ask me after this review', '2. ' + second);
      for (const pending of [undefined, native]) {
        expect(autoplanSetupDecision(frame, new Set(), pending).kind, prompt).toBe('unrelated');
      }
    }
    // Existing unsupported offer remains positively identified independently
    // of the unsupported opposite label; no exact question wording is needed.
    const native = prerequisiteCall();
    native.questions[0]!.question = fullQuestion.replace('Run /office-hours first?', 'Would you like to run /office-hours now?');
    native.questions[0]!.options[1]!.label = 'Ask me after this review';
    expect(autoplanSetupDecision(unsupported.replace('Run /office-hours first?', 'Would you like to run /office-hours now?'), new Set(), native).kind).toBe('unsupported_setup');
  });

  test('routing identity still needs its explicit setup action before an unsupported failure', () => {
    for (const [first, second] of [['React', 'Vue'], ['Accept recommendation', 'Defer finding'], ['Add routing rules (Recommended)', 'Add routing rules (Recommended)']]) {
      const frame = UNSUPPORTED_ROUTING.replace('1. Add routing rules (Recommended)', '1. ' + first)
        .replace('2. Ask me after this review', '2. ' + second);
      const native = unsupportedNative();
      native.questions[0]!.options = [{label:first!},{label:second!}];
      for (const pending of [undefined,native]) expect(autoplanSetupDecision(frame,new Set(),pending).kind).toBe('waiting');
    }
  });

  test('incomplete, stale, quoted, indented or mixed UI cannot establish unsupported setup', () => {
    const panel = UNSUPPORTED_ROUTING.slice(UNSUPPORTED_ROUTING.indexOf(' ☐ Skill routing'));
    for (const frame of [
      panel.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
      panel.replace('  2. Ask me after this review', ''),
      panel.replace('  4. Chat about this', ''),
      panel.replace('❯ 1.', '  1.'),
      panel.replace('  2.', '❯ 2.'),
      panel.replace('1. Add', '1. [ ] Add'),
      panel.replace(' ☐ Skill routing', '← ☐ Skill routing ✔ Submit →'),
      panel + '\n⏺ Continuing the review now.',
      panel + '\n❯ 1. Different menu\n  2. Other choice',
      'Example panel:\n' + panel,
      'Quoted source:\n' + panel,
      '```text\n' + panel,
      '~~~~text\n```\n' + panel,
      panel.split('\n').map(line => '    ' + line).join('\n'),
      panel.split('\n').map(line => '> ' + line).join('\n'),
    ]) expect(autoplanSetupDecision(frame, new Set()).kind, frame).not.toBe('unsupported_setup');
    expect(autoplanSetupDecision('```text\nearlier code\n```\n' + panel, new Set()).kind).toBe('unsupported_setup');
    const product = panel.replace("gstack works best when your project's CLAUDE.md includes skill routing rules. Should I add them now?", 'Which product API router should we use?');
    expect(autoplanSetupDecision(product, new Set()).kind).toBe('unrelated');
  });

  test('mismatched, failed, answered, empty and multi-question metadata cannot diagnose this panel', () => {
    for (const mutate of [
      (call: ReturnType<typeof unsupportedNative>) => { call.failed = true; },
      (call: ReturnType<typeof unsupportedNative>) => { call.answered = true; },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions = []; },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions.push(structuredClone(call.questions[0]!)); },
      (call: ReturnType<typeof unsupportedNative>) => { Object.assign(call.questions[0]!, {multiSelect:true}); },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions[0]!.header = 'Other question'; },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions[0]!.question = 'Different question <gstack-qid:routing-injection>'; },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions[0]!.options[1]!.label = 'Different choice'; },
      (call: ReturnType<typeof unsupportedNative>) => { call.questions[0]!.options[1]!.label = 'No thanks, manual only'; },
    ]) {
      const native = unsupportedNative(); mutate(native);
      expect(autoplanSetupDecision(UNSUPPORTED_ROUTING, new Set(), native).kind).not.toBe('unsupported_setup');
    }
  });

  test('a supported native question clipped by the actual viewport preserves its existing input policy', async () => {
    const {createPtyScreen} = await import('./helpers/pty-screen');
    const {matchesNativePlanQuestion} = await import('./helpers/claude-pty-runner');
    const native = unsupportedNative();
    native.questions[0]!.question += '\n' + Array.from({length:41}, (_,i) =>
      `Routing context line ${i+1}: keep current project conventions and existing commands.`).join('\n');
    native.questions[0]!.options[1]!.label = 'No thanks, invoke manually';
    const frame = `☐ Skill routing\n${native.questions[0]!.question}\n❯ 1. Add routing rules (Recommended)\n  2. No thanks, invoke manually\n  3. Type something.\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
    const screen = await createPtyScreen(120,40);
    try {
      screen.write(frame.replace(/\n/g,'\r\n'));
      const visible = await screen.read();
      expect(visible).not.toContain('☐ Skill routing');
      expect(matchesNativePlanQuestion(visible,native)).toBe(true);
      const seen = new Set<string>();
      const decision = autoplanSetupDecision(visible,seen,native);
      expect(decision.kind).toBe('input');
      if (decision.kind !== 'input') throw new Error('Expected supported native input');
      expect(decision.input).toBe('1');
      expect(seen.size).toBe(0);
      for (const signature of decision.signatures) seen.add(signature);
      expect(autoplanSetupDecision(visible,seen,native).kind).toBe('waiting');
    } finally { await screen.dispose(); }
  });
});

test.skipIf(process.platform === 'win32')('real PTY unsupported setup fails after ready with zero input and durable parsed evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-unsupported-setup-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const resultFile = path.join(dir, 'result.json');
  const cases = [false, true].map(early => ({
    name: early ? 'early' : 'deferred', early, cwd: path.join(dir, early ? 'early' : 'deferred'),
    events: path.join(dir, early ? 'early.jsonl' : 'deferred.jsonl'),
    evalDir: path.join(dir, early ? 'early-artifacts' : 'deferred-artifacts'),
    frame: UNSUPPORTED_ROUTING, native: unsupportedNative(),
  }));
  for (const item of cases) fs.mkdirSync(item.cwd);
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const item=JSON.parse(process.env.SETUP_DIAGNOSTIC_CASE);
const event=value=>fs.appendFileSync(item.events,JSON.stringify(value)+'\n');
event({kind:'startup',pid:process.pid});
if(item.early){
  const folder=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,item.name+'.jsonl'),JSON.stringify({type:'assistant',sessionId:item.name,isSidechain:false,cwd:process.cwd(),timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'tool_use',id:'setup',name:'AskUserQuestion',input:{questions:item.native.questions}}]}})+'\n');
}
process.stdin.setRawMode?.(true);
process.stdin.on('data',data=>event({kind:'input',data:data.toString()}));
process.stdout.write('\x1b[2J\x1b[H'+item.frame);
process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  const url = (name: string) => pathToFileURL(path.resolve(import.meta.dir, 'helpers', name)).href;
  fs.writeFileSync(worker, `
import * as fs from 'node:fs';
import {launchClaudePty} from ${JSON.stringify(url('claude-pty-runner.ts'))};
import {autoplanSetupDecision,autoplanRoutingSetupInput} from ${JSON.stringify(url('autoplan-setup-question.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(url('plan-count-transcript.ts'))};
import {createPlanCountSnapshotWriter} from ${JSON.stringify(url('plan-count-artifacts.ts'))};
const results=[];
for(const item of ${JSON.stringify(cases)}){
  const session=await launchClaudePty({cwd:item.cwd,observeScreen:true,timeoutMs:20000,env:{SETUP_DIAGNOSTIC_CASE:JSON.stringify(item)}});
  const result={name:item.name,config:session.hermeticConfigDir};
  try{
    await session.waitFor('Enter to select',{timeoutMs:10000,pollMs:20});
    const viewport=await session.currentScreen();
    const native=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
    const pending=native.calls.find(call=>!call.answered&&!call.failed);
    if(Boolean(pending)!==item.early)throw Error('Readiness did not establish expected metadata state');
    result.legacyInput=autoplanRoutingSetupInput(viewport,new Set(),pending);
    const decision=autoplanSetupDecision(viewport,new Set(),pending);
    if(decision.kind==='input')throw Error('Unexpected guessed input');
    if(decision.kind!=='unsupported_setup')throw Error('Expected unsupported_setup, got '+decision.kind);
    const save=createPlanCountSnapshotWriter({EVALS_RUN_ID:item.name,GSTACK_EVAL_DIR:item.evalDir});
    Object.assign(result,save({skillName:'autoplan',cwd:item.cwd,claudeConfigDir:session.hermeticConfigDir,raw:session.rawOutput(),visible:session.visibleText(),viewport,
      observation:{state:'unsupported_setup',unsupportedSetup:decision,native,retention:'UI and parsed metadata only; full parent JSONL not guaranteed.'}}));
    throw Error('UNSUPPORTED_SETUP_DIAGNOSTIC: '+decision.prompt);
  }catch(error){result.failed=true;result.error=String(error);}
  finally{await session.close();fs.rmSync(item.cwd,{recursive:true,force:true});}
  results.push(result);
}
await Bun.write(${JSON.stringify(resultFile)},JSON.stringify(results));
process.exitCode=results.some(result=>result.failed)?1:0;
`);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stdout + stderr).toBe(1);
    const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(results.length).toBe(2);
    for (const [index, result] of results.entries()) {
      const item = cases[index]!;
      expect(result.failed).toBe(true);
      expect(result.error).toContain('UNSUPPORTED_SETUP_DIAGNOSTIC:');
      expect(result.legacyInput).toBeNull();
      expect(result.artifactError).toBeUndefined();
      const artifact = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'observation.json'), 'utf8'));
      expect(artifact.state).toBe('unsupported_setup');
      expect(artifact.native.calls.length).toBe(item.early ? 1 : 0);
      expect(artifact.retention).toContain('full parent JSONL not guaranteed');
      expect(fs.readFileSync(path.join(result.artifactDir, 'terminal.screen.log'), 'utf8')).toContain('Ask me after this review');
      expect(fs.readFileSync(path.join(result.artifactDir, 'terminal.raw.log'), 'utf8')).toContain('routing-injection');
      expect(fs.existsSync(item.cwd)).toBe(false);
      expect(fs.existsSync(result.config)).toBe(false);
      const events = fs.readFileSync(item.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.kind === 'input')).toEqual([]);
      expect(() => process.kill(events[0].pid, 0)).toThrow();
    }
  } finally {
    clearTimeout(killer); child.kill('SIGKILL');
    for (const item of cases) {
      if (!fs.existsSync(item.events)) continue;
      const pid = JSON.parse(fs.readFileSync(item.events, 'utf8').split('\n')[0]!).pid;
      if (process.platform === 'linux') {
        try { if (fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').includes(fake)) process.kill(pid, 'SIGKILL'); }
        catch { /* already reaped or PID no longer belongs to this fixture */ }
      }
    }
    fs.rmSync(dir, {recursive:true,force:true});
  }
}, 30000);
