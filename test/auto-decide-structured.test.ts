import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-structured-77.json';
const clone = () => structuredClone(capture) as any;
const decision = (f = clone()) => findNativeAutoDecision(f.transcript, f.tools, f.options);
test('actual slash expansion with completed preference log and current mode is an auto-decision', () => {
  const f = clone();
  expect(f.tools.some((e: any) => e.name === 'Skill')).toBe(false);
  expect(f.transcript.calls).toEqual([]);
  const result = decision(f);
  expect(result).not.toBeNull();
  expect(result!.option).toBe('HOLD SCOPE');
});

const use = (f: any, name: string) => f.tools.find((e: any) => e.kind === 'use' && e.input?.command?.includes(name));
const ack = (f: any, request: any) => f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === request.toolUseId);
const modeMessage = (f: any) => f.transcript.assistantMessages.find((m: any) => m.text.includes('**Mode:'));
const changeLog = (f: any, modify: (log: any) => void) => {
  const request = use(f, 'gstack-question-log'), match = /'(\{.*\})'/.exec(request.input.command)!;
  const value = JSON.parse(match[1]!); modify(value);
  request.input.command = request.input.command.replace(match[1], JSON.stringify(value));
};

for (const [label, mutate] of Object.entries({
  'missing transcript': (f: any) => { f.transcript.status = 'missing'; },
  'foreign owned session': (f: any) => { f.options.sessionId = 'foreign'; },
  'wrong invoked skill': (f: any) => { f.options.skillName = 'plan-eng-review'; },
  'pre-command evidence': (f: any) => { f.options.commandStartedAt = Date.parse(modeMessage(f).timestamp); },
  'future final statement': (f: any) => { f.options.now = Date.parse(modeMessage(f).timestamp) - 1; },
  'invalid final timestamp': (f: any) => { modeMessage(f).timestamp = 'invalid'; },
  'native question': (f: any) => { f.transcript.calls.push({ sessionId: f.options.sessionId, toolUseId: 'asked' }); },
  'malformed native question tool': (f: any) => { f.tools.push({ ...use(f, 'gstack-question-log'), toolUseId: 'asked', name: 'mcp__ask__AskUserQuestion', input: {} }); },
  'earlier visible prose question': (f: any) => { f.options.proseQuestionObserved = true; },
  'public reply request': (f: any) => { modeMessage(f).text += '\nReply with A or B.'; },
  'public option list': (f: any) => { modeMessage(f).text += '\nA) Hold scope\nB) Expand scope'; },
  'no preamble': (f: any) => { const request = use(f, 'gstack-skill-start'); f.tools = f.tools.filter((e: any) => e.toolUseId !== request.toolUseId); },
  'preamble failed': (f: any) => { ack(f, use(f, 'gstack-skill-start')).isError = true; },
  'preamble missing ACK': (f: any) => { const request = use(f, 'gstack-skill-start'); f.tools = f.tools.filter((e: any) => e !== ack(f, request)); },
  'preamble duplicate': (f: any) => { f.tools.push({ ...use(f, 'gstack-skill-start') }); },
  'wrong preamble skill': (f: any) => { use(f, 'gstack-skill-start').input.command = use(f, 'gstack-skill-start').input.command.replace('--skill "plan-ceo-review"', '--skill "plan-eng-review"'); },
  'question tuning disabled': (f: any) => { const result = ack(f, use(f, 'gstack-skill-start')); result.content = result.content.replace('QUESTION_TUNING: true', 'QUESTION_TUNING: false'); },
  'ambiguous preamble session': (f: any) => { ack(f, use(f, 'gstack-skill-start')).content = 'SKILL_START_PROTO: 1\nQUESTION_TUNING: true\nSESSION_ID: duplicate\n' + ack(f, use(f, 'gstack-skill-start')).content; },
  'nonzero preference': (f: any) => { ack(f, use(f, 'gstack-question-preference')).content = 'AUTO_DECIDE\nEXIT: 1'; },
  'ASK preference': (f: any) => { ack(f, use(f, 'gstack-question-preference')).content = 'ASK\nEXIT: 0'; },
  'preference error': (f: any) => { ack(f, use(f, 'gstack-question-preference')).isError = true; },
  'wrong preference id': (f: any) => { use(f, 'gstack-question-preference').input.command = use(f, 'gstack-question-preference').input.command.replace('--check "plan-ceo-review-mode"', '--check "plan-ceo-review-other"'); },
  'no preference check': (f: any) => { const request = use(f, 'gstack-question-preference'); f.tools = f.tools.filter((e: any) => e.toolUseId !== request.toolUseId); },
  'unacknowledged log': (f: any) => { const request = use(f, 'gstack-question-log'); f.tools = f.tools.filter((e: any) => e !== ack(f, request)); },
  'failed log': (f: any) => { ack(f, use(f, 'gstack-question-log')).isError = true; },
  'fallback log result': (f: any) => { ack(f, use(f, 'gstack-question-log')).content = 'log unavailable (best-effort)'; },
  'wrong log session': (f: any) => changeLog(f, log => { log.session_id = 'foreign'; }),
  'wrong log skill': (f: any) => changeLog(f, log => { log.skill = 'plan-eng-review'; }),
  'wrong log question id': (f: any) => changeLog(f, log => { log.question_id = 'plan-ceo-review-scope'; }),
  'nonautomatic log': (f: any) => changeLog(f, log => { log.auto_decided = false; }),
  'string automatic flag': (f: any) => changeLog(f, log => { log.auto_decided = 'true'; }),
  'unmatched recommendation': (f: any) => changeLog(f, log => { log.recommended = 'SCOPE_EXPANSION'; }),
  'different logged mode': (f: any) => changeLog(f, log => { log.recommended = log.user_choice = 'SCOPE_EXPANSION'; }),
  'arbitrary logged value': (f: any) => changeLog(f, log => { log.recommended = log.user_choice = 'APPROVE_SCOPE'; }),
  'nondecision summary': (f: any) => changeLog(f, log => { log.question_summary = ''; }),
  'later checked preference': (f: any) => { ack(f, use(f, 'gstack-question-preference')).timestamp = modeMessage(f).timestamp; },
  'mode before log ACK': (f: any) => { modeMessage(f).timestamp = use(f, 'gstack-question-log').timestamp; },
  'reversed log ACK': (f: any) => { ack(f, use(f, 'gstack-question-log')).timestamp = use(f, 'gstack-question-preference').timestamp; },
  'duplicate log ACK': (f: any) => { f.tools.push({ ...ack(f, use(f, 'gstack-question-log')) }); },
  'foreign log ACK': (f: any) => { ack(f, use(f, 'gstack-question-log')).sessionId = 'foreign'; },
  'missing current statement': (f: any) => { modeMessage(f).text = 'Done. Waiting for your next instruction.'; },
})) test(`structured current mode rejects ${label}`, () => {
  const f = clone(); mutate(f); expect(decision(f)).toBeNull();
});

for (const name of ['gstack-skill-start', 'gstack-question-preference', 'gstack-question-log']) {
  for (const [label, change] of Object.entries({
    'echoed source': (s: string) => `echo '${s.replaceAll("'", "'\\''")}'`,
    'conditional command': (s: string) => `false && ${s}`,
    'commented source': (s: string) => `# ${s}`,
    'extra prefix command': (s: string) => `true; ${s}`,
    'extra suffix command': (s: string) => `${s}; true`,
    'command substitution': (s: string) => `echo "$(${s})"`,
  })) test(`${name} cannot authenticate ${label}`, () => {
    const f = clone(); use(f, name).input.command = change(use(f, name).input.command); expect(decision(f)).toBeNull();
  });
}

for (const [label, text] of Object.entries({
  'plain current field': 'Mode: HOLD SCOPE.',
  'parenthetical explanation with punctuation': 'Mode: HOLD SCOPE (saved preference, confirmed).',
  'parenthetical review explanation': '**Review mode: HOLD SCOPE (saved preference; confirmed).**',
  'current review field': '**Review mode: HOLD SCOPE.**',
  'compact completion': '**STATUS: DONE**\n\nMode: HOLD SCOPE',
  'bullet conclusion': 'The requested routing decision is complete.\n\n- **Mode: HOLD SCOPE**, using the saved preference.\n\nThe substantive review is deferred.',
  'quoted historical contradiction': 'Mode: HOLD SCOPE.\n\nEarlier example: "Review mode: SCOPE EXPANSION."',
})) test(`completed structured log supports ${label} without exact annotation prose`, () => {
  const f = clone(); modeMessage(f).text = text;
  const result = decision(f); expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.skillToolUseId).toBeUndefined();
  expect(result?.preambleToolUseId).toBe(use(f, 'gstack-skill-start').toolUseId);
  expect(result?.annotation).toBe(text);
});

for (const text of [
  '> Mode: HOLD SCOPE.', '    Mode: HOLD SCOPE.', '`Mode: HOLD SCOPE.`',
  '```text\nMode: HOLD SCOPE.\n```', 'Example:\n\nMode: HOLD SCOPE.',
  'Previous transcript:\n\nMode: HOLD SCOPE.', 'If approved, Mode: HOLD SCOPE.',
  'Mode: HOLD SCOPE, if you approve.', 'Mode: HOLD SCOPE, pending approval.',
  'Mode: HOLD SCOPE?', 'Mode: HOLD SCOPELESS.',
  'Mode: HOLD SCOPE (withdrawn).', 'Mode: HOLD SCOPE (retracted).',
  'Mode: HOLD SCOPE.\n\nMode: HOLD SCOPE (pending approval).',
  'Mode: HOLD SCOPE.\n\nCorrection: I withdraw this decision.',
  'Mode: HOLD SCOPE.\n\nI did not auto-decide the review mode.',
  'Mode: HOLD SCOPE.\n\nCorrection: Mode: SCOPE EXPANSION.',
  'Mode: HOLD SCOPE.\n\nMode: SCOPE EXPANSION.',
]) test(`quoted, conditional or withdrawn mode has no completed choice: ${JSON.stringify(text)}`, () => {
  const f = clone(); modeMessage(f).text = text; expect(decision(f)).toBeNull();
});

test('the same command contracts also support direct literal invocations and quiet ACKs', () => {
  const f = clone();
  use(f, 'gstack-skill-start').input.command = '"$HOME/.claude/skills/gstack/bin/gstack-skill-start" --model claude --skill plan-ceo-review --parent-pid "$PPID"';
  use(f, 'gstack-question-preference').input.command = '~/.claude/skills/gstack/bin/gstack-question-preference --check plan-ceo-review-mode';
  ack(f, use(f, 'gstack-question-preference')).content = 'AUTO_DECIDE\n';
  use(f, 'gstack-question-log').input.command = use(f, 'gstack-question-log').input.command.split(' 2>/dev/null')[0];
  ack(f, use(f, 'gstack-question-log')).content = '';
  expect(decision(f)?.option).toBe('HOLD SCOPE');
});

import priorAnnotation from './fixtures/auto-decide-saved-ai.json';
for (const status of ['undecided', 'not selected', 'pending approval', 'none']) {
  test(`later Review mode: ${status} withdraws both existing annotation and structured decision`, () => {
    const previous: any = structuredClone(priorAnnotation);
    previous.transcript.assistantMessages.find((m: any) => m.text.includes('Auto-decided')).text += `\n\nReview mode: ${status}.`;
    expect(findNativeAutoDecision(previous.transcript, previous.tools, previous.options)).toBeNull();
    const f = clone(); modeMessage(f).text += `\n\nReview mode: ${status}.`;
    expect(decision(f)).toBeNull();
  });
  test(`later Mode: ${status} withdraws a structured decision`, () => {
    const f = clone(); modeMessage(f).text += `\n\n- **Mode: ${status}.**`;
    expect(decision(f)).toBeNull();
  });
}

for (const name of ['gstack-question-preference', 'gstack-question-log']) test(`${name} cannot borrow an earlier success after a contradictory current call`, () => {
  const f = clone(), request = structuredClone(use(f, name)), result = structuredClone(ack(f, request));
  request.toolUseId += '-later'; result.toolUseId = request.toolUseId;
  request.timestamp = result.timestamp = new Date(Date.parse(modeMessage(f).timestamp) - 1).toISOString();
  if (name === 'gstack-question-preference') result.content = 'ASK\nEXIT: 0';
  else request.input.command = request.input.command.replace('"auto_decided":true', '"auto_decided":false');
  f.tools.push(request, result); expect(decision(f)).toBeNull();
});

test('a literal command cannot treat a physical newline as argument whitespace', () => {
  const f = clone();
  use(f, 'gstack-question-log').input.command = use(f, 'gstack-question-log').input.command.replace("gstack-question-log '", "gstack-question-log\n'");
  expect(decision(f)).toBeNull();
});

for (const fallback of ['"LOGGED"', '" LOGGED "', '"\\x4cOGGED"', '-e "\\x4cOGGED"'])
  test(`a failure branch cannot impersonate the question-log success marker: ${fallback}`, () => {
    const f = clone(), request = use(f, 'gstack-question-log');
    request.input.command = request.input.command.replace('"log unavailable (best-effort)"', fallback);
    expect(decision(f)).toBeNull();
  });

import completedModeCapture from './fixtures/auto-decide-completed-mode-f359.json';
{
const copy=()=>structuredClone(completedModeCapture);
const check=(f:any)=>findNativeAutoDecision(f.transcript,f.tools,f.options);
const message=(f:any)=>f.transcript.assistantMessages.find((m:any)=>m.text.includes('Mode decision done:'));
const logUse=(f:any)=>f.tools.find((t:any)=>t.kind==='use'&&t.input?.command?.includes('gstack-question-log'));
test('actual owned public attempt fails original and completes mode-only with full acknowledged authority',()=>{
 const f=copy();const v=check(f);expect(v?.option).toBe('HOLD SCOPE');expect(v?.questionLogToolUseId).toBe(logUse(f).toolUseId);
});
const mutations:Record<string,(f:any)=>void>={
 'unlogged':f=>{const id=logUse(f).toolUseId;f.tools=f.tools.filter((t:any)=>t.toolUseId!==id)},
 'failed log':f=>{f.tools.find((t:any)=>t.kind==='result'&&t.toolUseId===logUse(f).toolUseId).isError=true},
 'masked log failure':f=>{logUse(f).input.command=logUse(f).input.command.replace('&& echo','; echo')},
 'wrong returned marker':f=>{f.tools.find((t:any)=>t.kind==='result'&&t.toolUseId===logUse(f).toolUseId).content='LOG_FAILED (best-effort)'},
 'unmatched quote':f=>{logUse(f).input.command=logUse(f).input.command.replace('"LOGGED"','"LOGGED')},
 'foreign session':f=>{f.options.sessionId='foreign'},
 'wrong mode':f=>{message(f).text=message(f).text.replace('done: HOLD SCOPE','done: SCOPE EXPANSION')},
 'unfinished':f=>{message(f).text=message(f).text.replace('Mode decision done:','Mode decision pending:')},
 'late declaration':f=>{message(f).timestamp=new Date(f.options.now+1000).toISOString()},
 'prior declaration':f=>{message(f).timestamp=new Date(f.options.commandStartedAt-1000).toISOString()},
 'cancelled':f=>{message(f).text+='\n\nI cancel this decision.'},
 'wrong later completed mode':f=>{message(f).text+='\n\nMode decision done: SCOPE EXPANSION'},
 'quoted declaration':f=>{message(f).text='> '+message(f).text},
 'hypothetical':f=>{message(f).text='Example:\n'+message(f).text},
 'conditional':f=>{message(f).text=message(f).text.replace('done: HOLD SCOPE','done: HOLD SCOPE (if approved)')},
 'native question surfaced':f=>{f.transcript.calls.push({sessionId:f.options.sessionId})},
 'wrong logged mode':f=>{logUse(f).input.command=logUse(f).input.command.replace('"user_choice":"HOLD SCOPE"','"user_choice":"SCOPE EXPANSION"')},
};
for(const [name,mutate] of Object.entries(mutations))test(name,()=>{const f=copy();mutate(f);expect(check(f)).toBeNull()});

for(const completion of ['done','complete','completed']) {
 test(`completed mode class ${completion}`,()=>{const f=copy();message(f).text=message(f).text.replace('decision done:','decision '+completion+':');expect(check(f)?.option).toBe('HOLD SCOPE')});
 test(`conflicting later completed mode ${completion}`,()=>{const f=copy();message(f).text+='\n\nMode decision '+completion+': SCOPE EXPANSION';expect(check(f)).toBeNull()});
 test(`unfinished completed mode ${completion}`,()=>{const f=copy();message(f).text=message(f).text.replace('done: HOLD SCOPE',completion+': HOLD SCOPE (pending approval)');expect(check(f)).toBeNull()});
}
test('paired single-quoted success token retains exact shell ACK',()=>{const f=copy();logUse(f).input.command=logUse(f).input.command.replace('"LOGGED"',"'LOGGED'");expect(check(f)?.option).toBe('HOLD SCOPE')});
test('unpaired single-quoted success token cannot authenticate log',()=>{const f=copy();logUse(f).input.command=logUse(f).input.command.replace('"LOGGED"',"'LOGGED");expect(check(f)).toBeNull()});

}

import statusFixture from './fixtures/auto-decide-completed-mode-f359.json';
{
const fixture=statusFixture;
const fixed=findNativeAutoDecision;
const copy=()=>structuredClone(fixture) as any;
const message=(f:any)=>f.transcript.assistantMessages.find((m:any)=>m.text.includes('Mode decision done:'));
const check=(f:any)=>fixed(f.transcript,f.tools,f.options);
test('current pending status retracts the completed owned mode',()=>{const f=copy();message(f).text+='\n\nMode decision pending: HOLD SCOPE';expect(check(f)).toBeNull()});
for(const status of ['pending','pending approval','unfinished','incomplete','cancelled','canceled','withdrawn','retracted','revoked','undecided','proposed','not selected','not decided','not yet complete','in progress','on hold','unknown']){
 test(`unfinished declaration ${status}`,()=>{const f=copy();message(f).text=message(f).text.replace('decision done:','decision '+status+':');expect(check(f)).toBeNull()});
 test(`later unfinished status ${status}`,()=>{const f=copy();message(f).text+='\n\nMode decision '+status+': HOLD SCOPE';expect(check(f)).toBeNull()});
 test(`quoted historical status ${status}`,()=>{const f=copy();message(f).text+='\n\n> Historical example:\n> Mode decision '+status+': HOLD SCOPE';expect(check(f)?.option).toBe('HOLD SCOPE')});
}
for(const status of ['done','complete','completed']){
 test(`same current completed field ${status}`,()=>{const f=copy();message(f).text+='\n\nMode decision '+status+': HOLD SCOPE';expect(check(f)?.option).toBe('HOLD SCOPE')});
 test(`completed conflicting field ${status}`,()=>{const f=copy();message(f).text+='\n\nMode decision '+status+': SCOPE EXPANSION';expect(check(f)).toBeNull()});
}
for(const status of ['unfinished','incomplete','pending approval','cancelled','not completed'])test(`unfinished value suffix ${status}`,()=>{const f=copy();message(f).text+='\n\nMode decision done: HOLD SCOPE ('+status+')';expect(check(f)).toBeNull()});
for(const text of ['Historical example: Mode decision pending: HOLD SCOPE','```\nMode decision pending: HOLD SCOPE\n```','"Mode decision cancelled: HOLD SCOPE"'])test(`unasserted historical field ${text}`,()=>{const f=copy();message(f).text+='\n\n'+text;expect(check(f)?.option).toBe('HOLD SCOPE')});
}
