import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeNativeAuq, displayedNativeAuq, nativeAuqPublicError, nativeAuqViewport, NATIVE_AUQ_CAPTURE_MS } from './helpers/auq-native-capture';
import { scoreAuqFormat } from './helpers/auq-sdk-capture';
import { createPendingQuestionRecorder, recordPendingQuestion, readFirstPendingQuestionForDisplay } from './helpers/plan-count-pending-question';
import type { NativePlanQuestion, NativePlanQuestionCall } from './helpers/plan-count-transcript';

const brief: NativePlanQuestion = {
  header:'Deploy café 🚀',
  question:'ELI10: Keep the café available.\nRecommendation: A because the existing worker handles 2,000 jobs per minute.\nPros / cons:\nNet: Prefer the existing worker.',
  options:[
    {label:'A) Keep (recommended)', description:'✅ Preserves résumé imports.\n❌ Adds one queue. 日本語 e\u0301'},
    {label:'B) Replace', description:'✅ Removes the queue.\n❌ Drops retries.'},
  ],
};
const plain: NativePlanQuestion = {header:'Scope', question:'Which scope should we review?', options:[{label:'Keep'}, {label:'Expand'}]};
const nativeCall = (questions = [brief]): NativePlanQuestionCall => ({sessionId:'owned-session', toolUseId:'first-call', questions, answered:false, failed:false});
const clippedElided = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/native-auq-clipped-elided-sep21.json'),'utf8')) as
  {publicCall:NativePlanQuestionCall; viewport:string};
const marginElided = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/native-auq-margin-elided-sep21.json'),'utf8')) as
  {publicCall:NativePlanQuestionCall; viewport:string};
const packetElided = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/native-auq-packet-clipped-elided-sep21.json'),'utf8')) as
  {publicCall:NativePlanQuestionCall; viewport:string};
const boxedFull = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/native-auq-boxed-full-body-sep21.json'),'utf8')) as
  {publicCall:NativePlanQuestionCall; viewport:string};
function screen(question: NativePlanQuestion): string {
  return `☐ ${question.header}\n${question.question}\n` + question.options.map((option, index) =>
    `${index ? ' ' : '❯'} ${index + 1}. ${option.label}`).join('\n')
    + '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
}

test('exact native fields preserve Unicode and existing format scores without synthesizing rubric text', () => {
  const expected = [brief.header, brief.question, ...brief.options.map(option => `${option.label}\n${option.description}`)].join('\n\n');
  expect(serializeNativeAuq(brief)).toBe(expected);
  expect(Buffer.from(serializeNativeAuq(brief))).toEqual(Buffer.from(expected));
  expect(scoreAuqFormat(serializeNativeAuq(brief))).toEqual(scoreAuqFormat(expected));
  expect(scoreAuqFormat(expected)).toEqual({present:7,total:7,missing:[]});
  expect(serializeNativeAuq(plain)).toBe('Scope\n\nWhich scope should we review?\n\nKeep\n\nExpand');
  expect(scoreAuqFormat(serializeNativeAuq(plain))).toEqual({present:0,total:7,
    missing:['ELI10:','Recommendation:','Pros / cons:','✅','❌','Net:','(recommended)']});
});

test('only a matching displayed native question supplies text, without packet aggregation', () => {
  expect(displayedNativeAuq(screen(brief), nativeCall())).toEqual({question:brief,questionIndex:0});
  for (const call of [undefined, {...nativeCall(),answered:true}, {...nativeCall(),failed:true}, nativeCall([plain])]) {
    expect(displayedNativeAuq(screen(brief), call)).toBeUndefined();
  }
  expect(displayedNativeAuq('Question: ' + brief.question, nativeCall())).toBeUndefined();
  const call = nativeCall([plain, brief]);
  const packetScreen = '← ☐ Scope  ☐ Deploy café 🚀  ✔ Submit →\n' + plain.question
    + '\n❯ 1. Keep\n  2. Expand\n  3. Type something.\n  4. Chat about this'
    + '\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
  const displayed = displayedNativeAuq(packetScreen, call);
  expect(displayed).toEqual({question:plain,questionIndex:0});
  expect(scoreAuqFormat(serializeNativeAuq(displayed!.question)).present).toBe(0);
  const laterTab = '← ☐ Scope  ☐ Deploy café 🚀  ✔ Submit →\n' + brief.question
    + '\n❯ 1. A) Keep (recommended)\n  2. B) Replace\n  3. Type something.\n  4. Chat about this'
    + '\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
  expect(displayedNativeAuq(laterTab, call)).toBeUndefined();
});

test('native capture rejects explicit option contradictions despite a matching question and footer', () => {
  const call = nativeCall([plain]);
  const exactRepro = '☐ Scope\nWhich scope should we review?\n❯ 1. Delete\n  2. Publish\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  for (const different of [exactRepro,
    screen(plain).replace('1. Keep','1. Expand').replace('2. Expand','2. Keep'),
    screen(plain).replace('2. Expand','2. Publish'),
    screen(plain).replace('1. Keep','1. Keep everything'),
    screen(plain).replace('1. Keep','1. Do not Keep'),
    screen(plain).replace('1. Keep','1. Delete…'),
    screen(plain).replace('2. Expand','2. ' ).replace('1. Keep','1. Delete'),
    screen(plain).replace('\nEnter to select','\n  3. Publish\nEnter to select'),
  ]) expect(displayedNativeAuq(different,call),different).toBeUndefined();
  const longer = {...plain,options:[{label:'Keep current scope'},{label:'Expand'}]};
  expect(displayedNativeAuq(screen(plain),nativeCall([longer]))).toBeUndefined();
});

test('label consistency preserves real wrapping, explicit ellipsis, empty redraws and native controls', () => {
  const question = {...plain,options:[{label:'Keep current scope 日本語'},{label:'Expand'}]};
  const call = nativeCall([question]);
  for (const rendered of [
    screen(question).replace('1. Keep current scope 日本語','1. Keep current\n    scope 日本語'),
    screen(question).replace('1. Keep current scope 日本語','1. Keep current…'),
    screen(question).replace('1. Keep current scope 日本語','1. …'),
    screen(question).replace('1. Keep current scope 日本語','1. '),
    screen(question).replace('\nEnter to select','\n  3. Type something.\n  4. Chat about this\nEnter to select'),
  ]) expect(displayedNativeAuq(rendered,call),rendered)?.toEqual({question,questionIndex:0});
  const edge = {...plain,options:[{label:'Keep '+ 'current '.repeat(30)},{label:'Expand'}]};
  const clipped = screen(edge).replace('1. '+edge.options[0]!.label,'1. '+edge.options[0]!.label.slice(0,115));
  expect(clipped.split('\n').find(line=>line.startsWith('❯ 1.'))!.length).toBe(120);
  expect(displayedNativeAuq(clipped,nativeCall([edge]))).toEqual({question:edge,questionIndex:0});
});

test('native label guard preserves captured preview columns and a real clipped viewport', async () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/ceo-preview-u-call.json'),'utf8'));
  const call = {...captured,answered:false,failed:false};
  const preview = fs.readFileSync(path.join(import.meta.dir,'fixtures/ceo-preview-u-screen.txt'),'utf8');
  expect(displayedNativeAuq(preview,call)).toEqual({question:call.questions[0],questionIndex:0});
  expect(displayedNativeAuq(preview.replace('1. A) Current plan as-is','1. X) Delete the project'),call)).toBeUndefined();
  expect(displayedNativeAuq(preview.replace('batch query (recommended)','publish credentials'),call)).toBeUndefined();
  const {createPtyScreen} = await import('./helpers/pty-screen');
  const question = {...plain,question:'Which scope should we review?\n'+
    Array.from({length:45},(_,i)=>`Context line ${i}: preserve the existing public contract and task scope.`).join('\n')};
  const terminal = await createPtyScreen(120,40);
  try {
    terminal.write(screen(question).replace(/\n/g,'\r\n'));
    const clipped = await terminal.read();
    expect(clipped).not.toContain('☐ Scope');
    expect(displayedNativeAuq(clipped,nativeCall([question]))).toEqual({question,questionIndex:0});
    expect(displayedNativeAuq(clipped.replace('2. Expand','2. Publish'),nativeCall([question]))).toBeUndefined();
  } finally {await terminal.dispose();}
});

test('the actual complete boxed no-qid question binds without changing public text or grades', () => {
  const {publicCall:call,viewport}=boxedFull;
  const question=call.questions[0]!;
  expect(question.question).not.toContain('<gstack-qid:');
  for(const rendered of [viewport,viewport.replace(/\n/g,'\r\n'),viewport.slice(viewport.indexOf(' ☐ Recipients'))]) {
    expect(displayedNativeAuq(rendered,call)).toEqual({question,questionIndex:0});
    expect(serializeNativeAuq(displayedNativeAuq(rendered,call)!.question)).toBe(serializeNativeAuq(question));
  }
  expect(scoreAuqFormat(serializeNativeAuq(question))).toEqual({present:7,total:7,missing:[]});
  // Complete native evidence must still capture an unformatted short question.
  for(const body of ['Which scope should we review?','Which literal │ delimiter should we preserve?',
    '│ Keep this literal leading box.\nSecond line keeps ┃ its delimiter.']) {
    const short={...plain,question:body};
    const rendered=screen(short).replace(body,body.split('\n').map(row=>'│ '+row).join('\n'));
    expect(displayedNativeAuq(rendered,nativeCall([short]))).toEqual({question:short,questionIndex:0});
    expect(scoreAuqFormat(serializeNativeAuq(short)).present).toBe(0);
    expect(serializeNativeAuq(short)).toContain(body);
  }
  const wrapped={...plain,options:[{label:'Keep current scope 日本語'},{label:'Expand'}]};
  const wrappedBody=screen(wrapped).replace(wrapped.question,'│ '+wrapped.question);
  for(const rendered of [
    wrappedBody.replace('1. Keep current scope 日本語','1. Keep current\n    scope 日本語'),
    wrappedBody.replace('1. Keep current scope 日本語','1. Keep current…'),
  ]) expect(displayedNativeAuq(rendered,nativeCall([wrapped]))).toEqual({question:wrapped,questionIndex:0});
  // Existing complete-suffix identity already handles the same pane clipped
  // at the top; the projection must not require a synthetic question ID.
  const bodyStart=viewport.indexOf('│ D1');
  const cursor=viewport.indexOf('❯ 1.');
  const rows=viewport.slice(bodyStart,cursor).trimEnd().split('\n');
  for(const start of [0,1,3,6]) {
    expect(displayedNativeAuq(rows.slice(start).join('\n')+'\n\n'+viewport.slice(cursor),call))
      .toEqual({question,questionIndex:0});
  }
  expect(displayedNativeAuq(viewport,{...call,answered:true})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,failed:true})).toBeUndefined();
  for(const questions of [[question,question],[plain,question]]) {
    expect(displayedNativeAuq(viewport,{...call,questions})).toBeUndefined();
  }
});

test('complete boxed body projection rejects altered, incomplete or quoted native evidence', () => {
  const {publicCall:call,viewport}=boxedFull;
  const pane=viewport.slice(viewport.indexOf(' ☐ Recipients'));
  const first='│ D1 — Who should receive the assignment notification email?\n';
  const second="│ Project/branch/task: On main, spec'ing a task-assignment email notification feature from a one-line intent.\n";
  for(const changed of [
    viewport.replace('☐ Recipients','☐ Different recipients'),
    viewport.replace(' ☐ Recipients\n',''),
    viewport.replace(first,''),
    viewport.replace(first+second,second+first),
    viewport.replace('But to whom?','Send it to everyone.'),
    viewport.replace('\n│ Net:','\n│ Foreign question text.\n│ Net:'),
    viewport.replace('\n│ Net:','\nNet:'),
    viewport.replace('\n│ Net:','\n\n│ Net:'),
    viewport.replace('1. Assignee only (recommended)','1. Delete all notifications'),
    viewport.replace('1. Assignee only (recommended)','1. Assignee + task creator')
      .replace('2. Assignee + task creator','2. Assignee only (recommended)'),
    viewport.replace('  2. Assignee + task creator\n',''),
    viewport.replace('5. Type something.','5. Send every email'),
    viewport.replace('6. Chat about this','7. Chat about this'),
    viewport.replace('\nEnter to select','\n  7. Extra option\nEnter to select'),
    viewport.replace('Enter to select · ↑/↓ to navigate · Esc to cancel',''),
    viewport.replace('↑/↓ to navigate','Tab/Arrow keys to navigate'),
    viewport+'\nLater unrelated output.',
    'Quoted tool output:\n'+pane,
    '```text\n'+viewport+'\n```',
    viewport.split('\n').map(row=>'> '+row).join('\n'),
  ]) expect(displayedNativeAuq(changed,call),changed).toBeUndefined();
  const literal={...plain,question:'Which literal │ delimiter should we preserve?'};
  const rendered=screen(literal).replace(literal.question,'│ '+literal.question);
  expect(displayedNativeAuq(rendered.replace('literal │','literal'),nativeCall([literal]))).toBeUndefined();
});

test('native capture binds the observed top-clipped and tail-elided public question exactly', () => {
  const {publicCall:call,viewport} = clippedElided;
  const question = call.questions[0]!;
  const expected = {question,questionIndex:0};
  expect(displayedNativeAuq(viewport,call)).toEqual(expected);
  // The repair matches display evidence; it never edits or synthesizes grade input.
  expect(serializeNativeAuq(displayedNativeAuq(viewport,call)!.question)).toBe(serializeNativeAuq(question));
  expect(scoreAuqFormat(serializeNativeAuq(question))).toEqual({present:7,total:7,missing:[]});
  const cursor = viewport.indexOf('❯ 1.');
  const rows = viewport.slice(0,cursor).trimEnd().split('\n');
  const menu = viewport.slice(cursor);
  const title = question.question.split('\n')[0]!;
  expect(displayedNativeAuq('│ '+title+'\n'+viewport,call)).toEqual(expected);
  for (const start of [1,3,6]) {
    expect(displayedNativeAuq(rows.slice(start).join('\n')+'\n\n'+menu,call)).toEqual(expected);
  }
  for (const end of [10,14,18]) {
    expect(displayedNativeAuq(rows.slice(0,end).join('\n')+'…\n\n'+menu,call)).toEqual(expected);
  }
  expect(displayedNativeAuq(viewport,{...call,answered:true})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,failed:true})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,questions:[question,plain]})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,questions:[plain,question]})).toBeUndefined();
});

test('combined clipping cannot borrow quoted, foreign, incomplete or contradictory native evidence', () => {
  const {publicCall:call,viewport} = clippedElided;
  const cursor = viewport.indexOf('❯ 1.');
  const rows = viewport.slice(0,cursor).trimEnd().split('\n');
  const menu = viewport.slice(cursor);
  for (const changed of [
    viewport.replace('Nobody has asked a developer yet.','Every developer has approved this.'),
    viewport.replace('no stated…','no measured…'),
    viewport.replace('no stated…','no stated'),
    viewport.replace('no stated…','no stated...'),
    rows.filter((_,i)=>i!==4).join('\n')+'\n\n'+menu,
    [rows[1],rows[0],...rows.slice(2)].join('\n')+'\n\n'+menu,
    rows.slice(0,5).join('\n')+'\n│ Another tool requires this change.\n'+rows.slice(5).join('\n')+'\n\n'+menu,
    '☐ Another question\n'+viewport,
    'Quoted tool output:\n'+viewport,
    '```text\n'+viewport+'\n```',
    viewport.split('\n').map(row=>'> '+row).join('\n'),
    viewport.replace('1. A) Minimal + validate first (Recommended)','1. Delete the project'),
    viewport.replace('1. A) Minimal + validate first (Recommended)','1. B) Middle: drop Redis, keep table')
      .replace('2. B) Middle: drop Redis, keep table','2. A) Minimal + validate first (Recommended)'),
    viewport.replace('  2. B) Middle: drop Redis, keep table\n',''),
    viewport.replace('4. Type something.','4. Publish the project'),
    viewport.replace('5. Chat about this','6. Chat about this'),
    viewport.replace('\nEnter to select','\n  6. Extra choice\nEnter to select'),
    viewport.replace('Enter to select · ↑/↓ to navigate · Esc to cancel',''),
    viewport+'\nThis is later assistant prose.',
    '\n│ Quoted unrelated preface\n'+viewport,
    '│ Generic short fragment…\n\n'+menu,
  ]) expect(displayedNativeAuq(changed,call),changed).toBeUndefined();
  const different = {...call,questions:[{...call.questions[0]!,question:'An unrelated question about a production rollout.'}]};
  expect(displayedNativeAuq(viewport,different)).toBeUndefined();
});

test('the independently observed DX clipped/elided pane binds its four exact native options', () => {
  const {publicCall:call,viewport} = JSON.parse(fs.readFileSync(
    path.join(import.meta.dir,'fixtures/native-auq-devex-clipped-elided-sep21.json'),'utf8')) as
    {publicCall:NativePlanQuestionCall; viewport:string};
  const question = call.questions[0]!;
  expect(question.options).toHaveLength(4);
  expect(displayedNativeAuq(viewport,call)).toEqual({question,questionIndex:0});
  expect(serializeNativeAuq(displayedNativeAuq(viewport,call)!.question)).toBe(serializeNativeAuq(question));
  expect(displayedNativeAuq(viewport.replace('forci…','droppi…'),call)).toBeUndefined();
  expect(displayedNativeAuq(viewport.replace('4. No DX surface, exit','4. Publish credentials'),call)).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,questions:[plain,question]})).toBeUndefined();
});

test('the actual native blank outer margin preserves boxed question identity without stripping foreign or interior rows', () => {
  const {publicCall:call,viewport} = marginElided;
  const question=call.questions[0]!;
  expect(viewport.startsWith('\n│ D1')).toBe(true);
  for(const rendered of [viewport,' \n\t\n'+viewport,viewport.replace(/^\n/,'')]) {
    expect(displayedNativeAuq(rendered,call)).toEqual({question,questionIndex:0});
    expect(serializeNativeAuq(displayedNativeAuq(rendered,call)!.question)).toBe(serializeNativeAuq(question));
  }
  for(const changed of [
    viewport.replace(/^\n/,'\n☐ Unrelated scope\n'),
    viewport.replace(/^\n/,'\nQuoted tool output:\n'),
    viewport.replace(/^\n/,'\n> copied question\n'),
    viewport.replace(/^\n/,'\n```text\n'),
    viewport.replace('\n│ ELI10:','\n\n│ ELI10:'),
    viewport.replace('\n│ ELI10:','\n \t\n│ ELI10:'),
    viewport.replace('│ ~…','│ really…'),
    viewport.replace('1. A) Minimal flagged build (recommended)','1. Publish credentials'),
    viewport+'\nUnrelated later output.',
  ]) expect(displayedNativeAuq(changed,call),changed).toBeUndefined();
});

test('the observed clipped packet binds only its uniquely displayed first question and never combines grades', () => {
  const {publicCall:call,viewport} = packetElided;
  const question=call.questions[0]!;
  expect(call.questions).toHaveLength(3);
  expect(displayedNativeAuq(viewport,call)).toEqual({question,questionIndex:0});
  expect(displayedNativeAuq(' \n\t\n'+viewport,call)).toEqual({question,questionIndex:0});
  expect(displayedNativeAuq(viewport,{...call,questions:[question,{...question,options:plain.options}]}))
    .toEqual({question,questionIndex:0});
  expect(serializeNativeAuq(displayedNativeAuq(viewport,call)!.question)).toBe(serializeNativeAuq(question));
  const malformedFirst={...question,question:question.question.replace('Pros / cons:','Tradeoffs:')};
  const incomplete=displayedNativeAuq(viewport.replace('Pros / cons:','Tradeoffs:'),
    {...call,questions:[malformedFirst,...call.questions.slice(1)]});
  expect(incomplete).toEqual({question:malformedFirst,questionIndex:0});
  expect(scoreAuqFormat(serializeNativeAuq(incomplete!.question))).toEqual({present:6,total:7,missing:['Pros / cons:']});
});

test('clipped packets reject later tabs, ambiguous shared evidence, contradictions and incomplete native menus', () => {
  const {publicCall:call,viewport} = packetElided;
  const first=call.questions[0]!;
  for(const question of call.questions.slice(1)) {
    const fragment=question.question.slice(40,-40).split('\n').map(row=>'│ '+row).join('\n')+'…';
    const menu=question.options.map((option,i)=>`${i?'  ':'❯ '}${i+1}. ${option.label}`).join('\n');
    const later=fragment+'\n\n'+menu+'\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
    expect(displayedNativeAuq(later,call)).toBeUndefined();
    // This exact body/menu is valid when it belongs to the first question.
    expect(displayedNativeAuq(later,{...call,questions:[question,plain]})).toEqual({question,questionIndex:0});
  }
  for(const questions of [
    [first,{...first,header:'Different unseen header'}],
    [first,{...first,question:'Other unseen introduction\n'+first.question+'\nOther unseen ending'}],
    [plain,...call.questions],
  ]) expect(displayedNativeAuq(viewport,{...call,questions})).toBeUndefined();
  for(const changed of [
    '← ☐ Different  ☐ Research  ✔ Submit →\n'+viewport,
    'Quoted tool output:\n'+viewport,
    viewport.replace('One coherent brand','An unrelated rollout'),
    viewport.replace('1. TUI + launch site (recommended)','1. Delete the project'),
    viewport.replace('1. TUI + launch site (recommended)','1. TUI only')
      .replace('2. TUI only','2. TUI + launch site (recommended)'),
    viewport.replace('  2. TUI only\n',''),
    viewport.replace('5. Type something.','5. Publish the project'),
    viewport.replace('6. Chat about this','7. Chat about this'),
    viewport.replace('Tab/Arrow keys to navigate','↑/↓ to navigate'),
    viewport.replace('Enter to select · Tab/Arrow keys to navigate · Esc to cancel',''),
    viewport+'\nLater assistant text.',
  ]) {
    expect(changed).not.toBe(viewport);
    expect(displayedNativeAuq(changed,call),changed).toBeUndefined();
  }
  expect(displayedNativeAuq(viewport,{...call,answered:true})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,failed:true})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,questions:[first]})).toBeUndefined();
});

test('packet identity stays unique across complete-body and elided-body display routes', () => {
  const {publicCall:call,viewport}=packetElided;
  const first=call.questions[0]!;
  const body=viewport.slice(0,viewport.indexOf('❯ 1.')).replace(/^[ \t]*│ ?/gm,'').trim();
  const short={...first,header:'Short first',question:body};
  const long={...first,header:'Long second'};
  for(const prefix of ['', '← ☐ Short first  ☐ Long second  ✔ Submit →\n']) {
    expect(displayedNativeAuq(prefix+viewport,{...call,questions:[short,long]})).toBeUndefined();
  }
  // A shared full-suffix match remains a candidate even when the stripped
  // ellipsis fragment repeats inside that question.
  expect(displayedNativeAuq(viewport,{...call,questions:[short,
    {...long,question:body+'\nAdditional context\n'+body}]})).toBeUndefined();
  expect(displayedNativeAuq(viewport,{...call,questions:[short,plain]})).toEqual({question:short,questionIndex:0});
  expect(displayedNativeAuq('← ☐ Short first  ☐ Scope  ✔ Submit →\n'+viewport,
    {...call,questions:[short,plain]})).toEqual({question:short,questionIndex:0});
  for(const footer of ['↑/↓ to navigate','']) {
    expect(displayedNativeAuq(viewport.replace('Tab/Arrow keys to navigate',footer),
      {...call,questions:[short,plain]})).toBeUndefined();
  }
  const singleton={...call,questions:[short]};
  expect(displayedNativeAuq(viewport.replace('Tab/Arrow keys to navigate','↑/↓ to navigate'),singleton))
    .toEqual({question:short,questionIndex:0});
  expect(displayedNativeAuq(viewport,singleton)).toBeUndefined();
  expect(displayedNativeAuq(viewport.replace('Enter to select · Tab/Arrow keys to navigate · Esc to cancel',''),singleton))
    .toBeUndefined();
});

function withRecorder(run: (f: {
  cwd:string; config:string; file:string; startedAt:number;
  event:Record<string,any>; read:()=>ReturnType<typeof readFirstPendingQuestionForDisplay>;
  write:(event:Record<string,any>)=>void;
}) => void) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-auq-reader-'));
  const config = path.join(cwd, '.claude');
  const transcript = path.join(config, 'projects', 'fixture', 'owned-session.jsonl');
  fs.mkdirSync(path.dirname(transcript), {recursive:true});
  // Invalid private contents are immaterial: the display API must not read them.
  fs.writeFileSync(transcript, 'PRIVATE_THINKING_AND_NARRATION_MUST_NEVER_BE_READ');
  const recorder = createPendingQuestionRecorder(cwd, config);
  const startedAt = Date.now();
  const event = {hook_event_name:'PreToolUse', tool_name:'AskUserQuestion', session_id:'owned-session',
    tool_use_id:'first-call', cwd, transcript_path:transcript, tool_input:{questions:[brief]}};
  try {
    run({cwd,config,file:recorder.file,startedAt,event,
      read:()=>readFirstPendingQuestionForDisplay(recorder.file,cwd,config,startedAt,'owned-session'),
      write:value=>recordPendingQuestion(JSON.stringify(value),recorder.file,cwd,config)});
  } finally { recorder.dispose(); fs.rmSync(cwd,{recursive:true,force:true}); }
}

describe('first native display reader', () => {
  test('requires exact owned session/cwd/config and leaves the call unanswered', () => withRecorder(f => {
    f.write(f.event);
    expect(f.read()).toEqual({...nativeCall(),source:'pre_tool_use'});
    expect(readFirstPendingQuestionForDisplay(f.file,f.cwd,f.config,f.startedAt,'foreign')).toBeUndefined();
    expect(readFirstPendingQuestionForDisplay(f.file,f.cwd+'-foreign',f.config,f.startedAt,'owned-session')).toBeUndefined();
    expect(readFirstPendingQuestionForDisplay(f.file,f.cwd,f.config+'-foreign',f.startedAt,'owned-session')).toBeUndefined();
    expect(readFirstPendingQuestionForDisplay(f.file,f.cwd,f.config,NaN,'owned-session')).toBeUndefined();
  }));
  test.each(['cwd','agent_id'])('ignores foreign %s hook events', key => withRecorder(f => {
    f.write({...f.event,[key]:'foreign'});
    expect(f.read()).toBeUndefined();
    f.write(f.event);
    expect(f.read()?.toolUseId).toBe('first-call');
  }));
  test.each([-1, 60_000])('rejects stale or future timestamp offset %s', offset => withRecorder(f => {
    f.write(f.event);
    const state = JSON.parse(fs.readFileSync(f.file,'utf8'));
    state.pending.timestamp = new Date(f.startedAt+offset).toISOString();
    fs.writeFileSync(f.file,JSON.stringify(state));
    expect(f.read()).toBeUndefined();
  }));
  test.each(['PostToolUse','PostToolUseFailure'])('never reopens or replaces a first call after %s', event => withRecorder(f => {
    f.write(f.event); f.write({...f.event,hook_event_name:event}); f.write(f.event);
    expect(f.read()).toBeUndefined();
    f.write({...f.event,tool_use_id:'second-call'});
    expect(f.read()).toBeUndefined();
  }));
  test('conflicting, concurrent, locked and symlinked sources cannot supply a question', () => {
    for (const change of ['conflict','concurrent','lock','symlink']) withRecorder(f => {
      f.write(f.event);
      if (change === 'conflict') f.write({...f.event,tool_input:{questions:[plain]}});
      if (change === 'concurrent') f.write({...f.event,tool_use_id:'other-call'});
      if (change === 'lock') fs.writeFileSync(f.file+'.lock','');
      if (change === 'symlink') {
        const target = f.event.transcript_path;
        fs.renameSync(target,target+'.real'); fs.symlinkSync(target+'.real',target);
      }
      expect(f.read()).toBeUndefined();
    });
  });
});

test('only explicit public API error panels are surfaced, and the total operation budget stays four minutes', () => {
  expect(NATIVE_AUQ_CAPTURE_MS).toBe(240_000);
  expect(nativeAuqPublicError('API Error: safeguards flagged this message. Details: [reasoning_extraction]. Request ID: req_fixture'))
    .toContain('[reasoning_extraction]');
  expect(nativeAuqPublicError('The documentation mentions API Error: as an example.')).toBeUndefined();
});

test('public viewport retention is exact within its bound and labels any truncation', () => {
  expect(nativeAuqViewport(screen(brief))).toEqual({viewport:screen(brief),viewportTruncated:false});
  const large = 'earlier viewport cells\n' + 'é'.repeat(20_000);
  const retained = nativeAuqViewport(large);
  expect(retained.viewport).toBe(large.slice(-16_384));
  expect(retained.viewport.length).toBe(16_384);
  expect(retained.viewportTruncated).toBe(true);
});

const FAKE_CLI = String.raw`
import * as fs from 'node:fs'; import * as path from 'node:path';
const cwd=process.cwd(), item=JSON.parse(fs.readFileSync(path.join(cwd,'case.json'),'utf8'));
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
const sessionId=value('--session-id'), config=process.env.CLAUDE_CONFIG_DIR;
const native=path.join(config,'projects','fixture',sessionId+'.jsonl');
fs.mkdirSync(path.dirname(native),{recursive:true});
fs.writeFileSync(native,'PRIVATE_THINKING_AND_NARRATION_MUST_NEVER_BE_READ');
const settings=JSON.parse(value('--settings'));
fs.writeFileSync(path.join(cwd,'observed.json'),JSON.stringify({args,config,pid:process.pid,headless:process.env.GSTACK_HEADLESS}));
fs.writeFileSync(path.join(cwd,'ask-capture.md'),'STALE_SYNTHETIC_CAPTURE');
const entries=settings.hooks.PreToolUse.filter(e=>e.matcher==='^AskUserQuestion$');
if(entries.length!==1)throw Error('missing exact AUQ observer');
async function hook(kind,id='first-call') {
 const payload={hook_event_name:kind,tool_name:'AskUserQuestion',session_id:sessionId,tool_use_id:id,
   cwd,transcript_path:native,tool_input:{questions:item.questions}};
 const p=Bun.spawn(['bash','-c',entries[0].hooks[0].command],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
 if(code||out||err)throw Error('observer changed the public tool invocation');
}
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data',data=>fs.appendFileSync(path.join(cwd,'unexpected-input'),data));
process.on('SIGINT',()=>process.exit(0));
// Public startup mechanism reproduced with the installed CLI on September 21.
// If the driver regresses to bypass mode, its first capture must fail instead
// of synthesizing an acceptance or overlooking this unanswered consent screen.
if(value('--permission-mode')!=='default') {
 process.stdout.write('WARNING: Claude Code running in Bypass Permissions mode\r\n❯ No, exit\r\n  Yes, I accept\r\nEnter to confirm · Esc to cancel\r\n');
 await Bun.sleep(150);fs.writeFileSync(path.join(cwd,'advance-clock'),'');
 await new Promise(()=>{});
}
process.stdout.write('HISTORY_ONLY_SCREEN_MUST_NOT_BE_RETAINED\r\n');
if(item.kind.startsWith('refusal')) {
 await hook('PreToolUse');
 process.stdout.write('\x1b[2J\x1b[HAPI Error: safeguards flagged this message. Details: [reasoning_extraction]. Request ID: req_fixture\r\n');
} else {
 if(item.kind!=='no-hook-timeout')await hook('PreToolUse');
 if(item.kind==='crash')process.exit(19);
 if(item.kind==='second') {await hook('PostToolUse');await hook('PreToolUse','second-call');}
 process.stdout.write('\x1b[2J\x1b[H'+item.screen.replace(/\n/g,'\r\n'));
}
if(['mismatch','hook-only','second','timeout','no-hook-timeout','packet-later'].includes(item.kind)) {
 await Bun.sleep(150); fs.writeFileSync(path.join(cwd,'advance-clock'),'');
}
await new Promise(()=>{});
`;

test.skipIf(process.platform === 'win32')('real PTY observes native public calls, preserves failures, model/tool scope and cleans every outcome', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-auq-pty-'));
  const fake=path.join(dir,'fake-claude'), worker=path.join(dir,'worker.ts');
  const temp=path.join(dir,'tmp'); fs.mkdirSync(temp);
  fs.writeFileSync(fake,`#!${process.execPath}\n`+FAKE_CLI,{mode:0o755});
  const helper=(name:string)=>path.join(import.meta.dir,'helpers',name);
  const cases=[
    {kind:'capture',questions:[brief],screen:screen(brief)},
    {kind:'plain',questions:[plain],screen:screen(plain)},
    {kind:'clipped-elided',questions:clippedElided.publicCall.questions,screen:clippedElided.viewport},
    {kind:'margin-elided',questions:marginElided.publicCall.questions,screen:marginElided.viewport},
    {kind:'packet-elided',questions:packetElided.publicCall.questions,screen:packetElided.viewport},
    {kind:'boxed-full',questions:boxedFull.publicCall.questions,screen:boxedFull.viewport},
    {kind:'packet-later',questions:packetElided.publicCall.questions,
      screen:screen(packetElided.publicCall.questions[1]!)
        .replace('☐ Research','← ☐ Product  ☐ Research  ☐ Memorable  ✔ Submit →')
        .replace('↑/↓ to navigate','Tab/Arrow keys to navigate')},
    {kind:'refusal',questions:[brief],screen:''},
    {kind:'crash',questions:[brief],screen:''},
    {kind:'mismatch',questions:[brief],screen:screen(plain)},
    {kind:'hook-only',questions:[brief],screen:'Preparing a question.'},
    {kind:'second',questions:[brief],screen:screen(brief)},
    {kind:'timeout',questions:[brief],screen:''},
    {kind:'no-hook-timeout',questions:[brief],screen:'Public startup confirmation\nWaiting for user input.'},
    {kind:'artifact-error',questions:[brief],screen:screen(brief)},
    {kind:'refusal-artifact-error',questions:[brief],screen:''},
  ];
  fs.writeFileSync(worker,`
import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';
import {captureFirstAuq,gradeAuqRecommendation} from ${JSON.stringify(helper('auq-sdk-capture.ts'))};
import {resolveClaudeBinary} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
import {mock,spyOn} from 'bun:test';
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake CLI binding failed before capture');
const gradeInputs=[];
mock.module(${JSON.stringify(helper('llm-judge.ts'))},()=>({judgeRecommendation:async text=>{
 gradeInputs.push(text); return {reason_substance:5,present:true,reason_text:'fixture',commits:true,has_because:true};
}}));
const read=fs.readFileSync;let privateReads=0,recorderReads=0,rejectReceipts=false;
spyOn(fs,'readFileSync').mockImplementation((file,...args)=>{
 if(String(file).endsWith('.jsonl')){privateReads++;throw Error('private transcript read');}
 if(String(file).endsWith('state.json'))recorderReads++;
 return read(file,...args);
});
const write=fs.writeFileSync;
spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{
 if(rejectReceipts&&String(file).endsWith('capture.json'))throw Error('fixture receipt disk full');
 return write(file,...args);
});
const root=${JSON.stringify(dir)}, cases=${JSON.stringify(cases)}, results=[];
const realNow=Date.now;let advanced=0;Date.now=()=>realNow()+advanced;
for(const item of cases){
 advanced=0;const cwd=path.join(root,item.kind);fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'case.json'),JSON.stringify(item));
 const before=fs.readdirSync(os.tmpdir());
 const timer=setInterval(()=>{if(fs.existsSync(path.join(cwd,'advance-clock')))advanced=237000;},5);
 rejectReceipts=item.kind.endsWith('artifact-error');
 let text,error;try{text=await captureFirstAuq({planDir:cwd,skillName:'plan-eng-review',scenario:'Review plan.md.',
 testName:item.kind,runId:'fixture-run',...(item.kind==='plain'?{}:{model:'explicit-model'})});}catch(e){error=String(e);}finally{clearInterval(timer);rejectReceipts=false;}
 const observed=JSON.parse(read(path.join(cwd,'observed.json'),'utf8'));
 const leaked=fs.readdirSync(os.tmpdir()).filter(name=>!before.includes(name)&&/^(gstack-native-auq-|gstack-pending-question-)/.test(name));
 let alive=false;try{process.kill(observed.pid,0);alive=true;}catch{}
 const artifact=fs.readdirSync(path.join(root,'artifacts','native-auq','fixture-run')).filter(name=>name.startsWith(item.kind+'-'));
 if(artifact.length!==1)throw Error('missing or duplicate receipt');
 const receiptPath=path.join(root,'artifacts','native-auq','fixture-run',artifact[0],'capture.json');
 const receipt=fs.existsSync(receiptPath)?JSON.parse(read(receiptPath,'utf8')):null;
 results.push({kind:item.kind,text,error,observed,receipt,leaked,alive,configExists:fs.existsSync(observed.config),inputs:fs.existsSync(path.join(cwd,'unexpected-input'))});
}
advanced=0;
const original=${JSON.stringify(serializeNativeAuq(brief))};
const grade=await gradeAuqRecommendation(results[0].text);
if(gradeInputs.length!==1||gradeInputs[0]!==original||grade.substance!==5)throw Error('grading input changed');
const spawn=Bun.spawn;Bun.spawn=()=>{throw Error('fixture spawn failure');};
let spawnError;try{await captureFirstAuq({planDir:root,skillName:'plan-eng-review',scenario:'Review plan.md.',testName:'spawn-error'});}catch(e){spawnError=String(e);}finally{Bun.spawn=spawn;}
const leftovers=fs.readdirSync(os.tmpdir()).filter(name=>/^(gstack-native-auq-|gstack-pending-question-)/.test(name));
fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({results,privateReads,recorderReads,spawnError,leftovers}));
`);
  try {
    const proc=Bun.spawn([process.execPath,worker],{stdout:'pipe',stderr:'pipe',env:{...process.env,
      BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1',GSTACK_EVAL_DIR:path.join(dir,'artifacts'),
      ANTHROPIC_API_KEY:'fake-key',ANTHROPIC_AUTH_TOKEN:'',ANTHROPIC_BASE_URL:'http://127.0.0.1:1',
      GSTACK_EVAL_MODEL_CAPTURE:'capture-env-model',EVALS_MODEL:'must-not-replace-capture-model',TMPDIR:temp}});
    const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
    expect({code,err}).toEqual({code:0,err:''});
    const data=JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8'));
    expect(data.privateReads).toBe(0);
    expect(data.recorderReads).toBeGreaterThan(0);
    expect(data.spawnError).toContain('fixture spawn failure');
    expect(data.leftovers).toEqual([]);
    for(const result of data.results){
      expect(result.leaked).toEqual([]);expect(result.alive).toBe(false);expect(result.configExists).toBe(false);expect(result.inputs).toBe(false);
      const args=result.observed.args;
      expect(args[args.indexOf('--tools')+1]).toBe('Read,Write,AskUserQuestion');
      expect(args[args.indexOf('--allowed-tools')+1]).toBe('Read,Write,AskUserQuestion');
      expect(args[args.indexOf('--permission-mode')+1]).toBe('default');
      expect(args).not.toContain('--dangerously-skip-permissions');expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args[args.indexOf('--model')+1]).toBe(result.kind==='plain'?'capture-env-model':'explicit-model');
      expect(args.filter((arg:string)=>arg==='--model')).toHaveLength(1);expect(args).not.toContain('--fallback-model');
      expect(args).toContain('--strict-mcp-config');expect(args).not.toContain('--mcp-config');expect(args).not.toContain('-p');
      expect(result.observed.headless).toBe('');
      const prompt=args.find((arg:string)=>arg.startsWith('The ONLY skill file'));
      expect(prompt).toContain(path.join(dir,result.kind,'plan-eng-review','SKILL.md'));
      expect(prompt).toContain('Review plan.md.');expect(prompt).toContain('Skip any system-audit / environment-setup / codebase-exploration steps.');
      expect(prompt).toContain('ask the user through the AskUserQuestion tool');
      for(const absent of ['verbatim','would call','write the','ELI10','Pros / cons:','Net:','private','reasoning']) expect(prompt).not.toContain(absent);
      if(result.kind.endsWith('artifact-error')){
        expect(result.receipt).toBeNull();expect(result.text).toBeUndefined();
        expect(result.error).toContain(result.kind==='artifact-error'?'fixture receipt disk full':'[reasoning_extraction]');
        continue;
      }
      expect(result.receipt.workflowCompleted).toBe(false);expect(JSON.stringify(result.receipt)).not.toContain('PRIVATE_');
      expect(result.receipt.billing).toBe('unavailable');expect(result.receipt.elapsedMs).toBeLessThanOrEqual(NATIVE_AUQ_CAPTURE_MS);
      expect(result.receipt.viewport.length).toBeLessThanOrEqual(16_384);
      expect(result.receipt.viewportTruncated).toBe(false);expect(Number.isFinite(Date.parse(result.receipt.viewportAt))).toBe(true);
      if(['capture','plain','clipped-elided','margin-elided','packet-elided','boxed-full'].includes(result.kind)){
        expect(result.error).toBeUndefined();expect(result.receipt.outcome).toBe('question_captured');
        const question=result.kind==='capture'?brief:result.kind==='plain'?plain:
          (result.kind==='clipped-elided'?clippedElided:result.kind==='margin-elided'?marginElided:
            result.kind==='boxed-full'?boxedFull:packetElided).publicCall.questions[0]!;
        expect(result.text).toBe(serializeNativeAuq(question));
        expect(result.receipt.publicCall.answered).toBe(false);expect(result.receipt.source).toBe('pre_tool_use');
        expect(result.receipt.displayMatched).toBe(true);
        expect(displayedNativeAuq(result.receipt.viewport,result.receipt.publicCall)?.question).toEqual(result.receipt.question);
        expect(result.receipt.viewport).not.toContain('HISTORY_ONLY_SCREEN');
        if(result.kind==='boxed-full') expect(result.receipt.viewport).toContain('│ D1 — Who should receive');
      } else {
        expect(result.text).toBeUndefined();expect(result.receipt.publicCall).toBeUndefined();
        expect(result.error).toContain(result.kind==='refusal'?'error_api':result.kind==='crash'?'exit_code_19':'timeout');
        expect(result.error).not.toContain('STALE_SYNTHETIC_CAPTURE');
        expect(result.receipt.displayMatched).toBe(false);
        if(result.kind==='refusal'){
          expect(result.error).toContain('[reasoning_extraction]');
          expect(result.receipt.pendingPublicCall.toolUseId).toBe('first-call');
          expect(result.receipt.viewport).toContain('[reasoning_extraction]');
          expect(result.receipt.pendingRecorder.status).toBe('pending');
        }
        if(result.kind==='no-hook-timeout'){
          expect(result.receipt.viewport).toContain('Public startup confirmation');
          expect(result.receipt.pendingRecorder.status).toBe('idle');
          expect(result.receipt.pendingPublicCall).toBeUndefined();
        }
      }
    }
    expect(out).toContain('outcome=question_captured workflowCompleted=false');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},30_000);
