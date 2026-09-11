import { expect, test } from 'bun:test';
import awFixture from './fixtures/plan-scope-target-aw.json';
import agFixture from './fixtures/design-plan-scope-ag.json';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import { isScopeGateQuestionVisible } from './helpers/claude-pty-runner';
import { readPlanCountTranscript, type NativePublicToolEvent, type PlanCountTranscript } from './helpers/plan-count-transcript';
import { selectTests, E2E_TOUCHFILES } from './helpers/touchfiles';

const START = Date.parse('2026-09-10T00:25:00Z');
const opts = { seed: '# Plan: Marketing landing page\n\n## Layout\nA draft.', skillName: 'plan-design-review', sessionId: 'owned', commandStartedAt: START };
const timestamp = (delta: number) => new Date(START + delta).toISOString();
const announcements = [
  `I'll review the "Marketing landing page" draft plan pasted here, starting with a parallel check of the pre-review audit, base branch, design setup, and brain context.`,
  `I'm proceeding with reviewing the "Marketing landing page" draft you pasted. Next, I'll run the pre-review audit: checking git context, DESIGN.md/TODOS.md, design binary setup, and brain context.`,
];
const agAnnouncement = agFixture.observations[1]!.transcript.assistantMessages.find(message => message.text.startsWith("I've selected"))!.text;
const fixture = (text = announcements[0]!) => ({
  transcript: { status: 'ready', calls: [], assistantMessages: [{ sessionId: 'owned', timestamp: timestamp(3), text }] } as PlanCountTranscript,
  tools: [
    { kind: 'use', name: 'Skill', input: { skill: 'plan-design-review' }, toolUseId: 'load', sessionId: 'owned', timestamp: timestamp(1) },
    { kind: 'result', isError: false, toolUseId: 'load', sessionId: 'owned', timestamp: timestamp(2) },
  ] as NativePublicToolEvent[],
});
const verdict = (f = fixture(), options = opts) => nativeSeededPlanSelection(f.transcript, f.tools, options);

test('actual AF public selection wording needs this seed, parent and completed skill boundary', () => {
  for (const text of announcements) expect(verdict(fixture(text))).toBe(true);
  const f = fixture(); f.tools[0]!.input!.skill = 'gstack:plan-design-review'; expect(verdict(f)).toBe(true);
  expect(verdict(fixture(), { ...opts, seed: '# Plan: Other page' })).toBe(false);
  expect(verdict(fixture(), { ...opts, seed: opts.seed + '\n# Another plan' })).toBe(false);
});

test('a late seed reply, wrong parent, failed load or missing native data supplies no selection', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.transcript.status = 'missing'; },
    (f: ReturnType<typeof fixture>) => { f.transcript.status = 'error'; },
    (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.sessionId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = timestamp(0); },
    (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = 'unknown'; },
    (f: ReturnType<typeof fixture>) => { f.tools[0]!.timestamp = timestamp(-2); f.tools[1]!.timestamp = timestamp(-1); },
    (f: ReturnType<typeof fixture>) => { f.tools[0]!.name = 'Read'; },
    (f: ReturnType<typeof fixture>) => { f.tools[0]!.input!.skill = 'plan-ceo-review'; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.isError = true; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.sessionId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.toolUseId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.timestamp = timestamp(0); },
    (f: ReturnType<typeof fixture>) => { f.tools.pop(); },
    (f: ReturnType<typeof fixture>) => { f.tools.push({ ...f.tools[1]! }); },
  ]) { const f = fixture(); mutate(f); expect(verdict(f)).toBe(false); }
});

test('quotes, examples, questions, wrong targets and conditional intentions remain negative', () => {
  const text = announcements[0]!;
  for (const invalid of [
    `> ${text}`, `    ${text}`, `	${text}`, `"${text}"`, `Example:
${text}`, `Expected output:

${text}`, `Original message:
${text}`, `An unproven hypothesis:
${text}`, `A proposed response:

${text}`,
    `\`\`\`text\n${text}\n\`\`\``, `\`\`\`\`markdown\n\`\`\`\n${text}\n\`\`\`\``,
    text.replace("I'll review", 'Should I review'), text.replace("I'll review", 'I might review'),
    text.replace("I'll review", "I won't review"), text.replace('Marketing landing page', 'Other plan'),
    text.replace('draft plan pasted here', 'branch diff'),
    text.replace(', starting with', ', if approved, starting with'),
    text.replace(', starting with', '. Unless you object, starting with'),
    `I'll review the supplied plan.`, `I'll run the /plan-design-review skill.`,
  ]) expect(verdict(fixture(invalid)), invalid).toBe(false);
});

test('native reader rejects foreign cwd and source/tool text even when they contain the announcement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-native-'));
  try {
    const journals = path.join(dir, 'projects', 'fixture'); fs.mkdirSync(journals, { recursive: true });
    const make = (cwd: string, textKind = 'text') => [
      { type: 'assistant', isSidechain: false, cwd, sessionId: 'owned', timestamp: timestamp(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'load', name: 'Skill', input: { skill: opts.skillName } }] } },
      { type: 'user', isSidechain: false, cwd, sessionId: 'owned', timestamp: timestamp(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'load', content: 'loaded', is_error: false }] } },
      { type: 'assistant', isSidechain: false, cwd, sessionId: 'owned', timestamp: timestamp(3), message: { role: 'assistant', content: [{ type: textKind, text: announcements[0] }] } },
    ];
    for (const [cwd, kind, expected] of [[dir, 'text', true], [dir + '-foreign', 'text', false], [dir, 'thinking', false]] as const) {
      fs.writeFileSync(path.join(journals, 'owned.jsonl'), make(cwd, kind).map(row => JSON.stringify(row)).join('\n') + '\n');
      const tools: NativePublicToolEvent[] = [], transcript = readPlanCountTranscript(dir, dir, e => tools.push(e));
      expect(nativeSeededPlanSelection(transcript, tools, opts)).toBe(expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('design scope question still requires the actual branch option', () => {
  expect(isScopeGateQuestionVisible('D1—What should I design-review?\nA) Current branch diff\nB) A plan or design doc')).toBe(true);
  expect(isScopeGateQuestionVisible('What should I design-review?')).toBe(false);
  expect(isScopeGateQuestionVisible('I should design-review the current branch diff.')).toBe(false);
});

test('seeded plan selection dependencies select the existing design and Eng mode checks', () => {
  for (const file of ['test/helpers/plan-scope-selection.ts', 'test/plan-scope-selection.test.ts']) {
    const selection = selectTests([file], E2E_TOUCHFILES);
    expect(selection.selected).toContain('plan-design-review-plan-mode'); expect(selection.selected).toContain('plan-eng-review-plan-mode');
  }
});

test('real PTY observation binds its explicit session and retains public diagnostics before cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pty-'));
  const cli = path.join(dir, 'fake-claude');
  fs.writeFileSync(cli, `#!/usr/bin/env bun
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), id = args[args.indexOf('--session-id') + 1];
fs.writeFileSync(process.env.SCOPE_TEST_ARGV, JSON.stringify(args));
let sent = false;
process.stdin.on('data', chunk => {
  if (sent || !chunk.toString().includes('/plan-design-review')) return;
  sent = true;
  const base = Date.now(), root = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
  fs.mkdirSync(root, {recursive:true});
  const rows = [
    ['assistant', 1, [{type:'tool_use',id:'load',name:'Skill',input:{skill:'plan-design-review'}}]],
    ['user', 2, [{type:'tool_result',tool_use_id:'load',content:'loaded',is_error:false}]],
    ['assistant', 3, [{type:'text',text:${JSON.stringify(agAnnouncement)}}]],
  ].map(([type,n,content]) => JSON.stringify({type,isSidechain:false,cwd:process.cwd(),sessionId:id,timestamp:new Date(base+n).toISOString(),message:{role:type,content}}));
  fs.writeFileSync(path.join(root,id+'.jsonl'), rows.join('\\n')+'\\n');
  process.stdout.write('Reviewing the named draft.\\nA) Fix hierarchy\\nB) Keep hierarchy\\nRecommendation: A because the primary action needs emphasis.\\nReply with A or B.\\n');
});
setInterval(()=>{},1000);
`, { mode: 0o755 });
  try {
    // The executable override belongs to a separate process: parallel free
    // tests cannot inherit it, and resolution is asserted before any spawn.
    const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    const childFile = path.join(dir, 'observe.ts');
    fs.writeFileSync(childFile, `import { runPlanSkillObservation, resolveClaudeBinary } from ${JSON.stringify(runner)};
if (resolveClaudeBinary() !== process.env.BROWSE_TERMINAL_BINARY) throw new Error('Fake CLI resolution failed');
const obs = await runPlanSkillObservation({skillName:'plan-design-review',inPlanMode:true,initialPlanContent:${JSON.stringify(opts.seed)},timeoutMs:25000,env:{SCOPE_TEST_ARGV:process.env.SCOPE_TEST_ARGV}});
console.log(JSON.stringify(obs));
`);
    const child = Bun.spawn([process.execPath, childFile], { cwd: process.cwd(),
      env: { ...process.env, BROWSE_TERMINAL_BINARY: cli, SCOPE_TEST_ARGV: path.join(dir, 'argv.json'),
        EVALS_RUN_ID: 'scope-fake', GSTACK_EVAL_DIR: path.join(dir, 'evidence') }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0);
    const obs = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(obs.outcome, JSON.stringify(obs)).toBe('asked'); expect(obs.scopeGateAutoSelectObserved).toBe(true);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    expect(args.filter((arg: string) => arg === '--session-id')).toHaveLength(1);
    const id = args[args.indexOf('--session-id') + 1]; expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const artifacts = obs.artifactDir; expect(typeof artifacts).toBe('string');
    const saved = JSON.parse(fs.readFileSync(path.join(artifacts, 'observation.json'), 'utf8'));
    expect(saved.scopeSessionId).toBe(id); expect(saved.native.assistantMessages.some((m: any) => m.sessionId === id)).toBe(true);
    expect(saved.scopeGateAutoSelectObserved).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 40_000);


test('AG actual first declaration absence stays negative while the explicit retry selection binds', () => {
  const [first, retry] = agFixture.observations;
  expect(nativeSeededPlanSelection(first!.transcript as PlanCountTranscript, first!.tools as NativePublicToolEvent[], first!.opts)).toBe(false);
  expect(nativeSeededPlanSelection(retry!.transcript as PlanCountTranscript, retry!.tools as NativePublicToolEvent[], retry!.opts)).toBe(true);
});


test('AG completed selection accepts ordinary grammar and the exact named pasted target', () => {
  for (const text of [
    `I've selected reviewing the pasted "Marketing landing page" draft plan since we're in plan mode. Now I'll run the pre-review audit.`,
    'I have selected to review the pasted “Marketing landing page” plan because we are in plan mode. Next, I will run the audit.',
    'I have selected reviewing the pasted `Marketing landing page` draft.',
  ]) expect(verdict(fixture(text)), text).toBe(true);
  expect(verdict(fixture('I have selected to review the pasted "Other page" plan.')), 'wrong seed title').toBe(false);
});

test('AG completed selection rejects source text, conditional intent, wrong scope and questions', () => {
  const text = `I've selected reviewing the pasted "Marketing landing page" draft plan since we're in plan mode.`;
  for (const invalid of [
    `> ${text}`, `    ${text}`, `\t${text}`, `"${text}"`, `Example:\n${text}`, `Expected output:\n\n${text}`,
    `Original message:\n${text}`, `An unproven hypothesis:\n${text}`, `A proposed response:\n\n${text}`,
    `\`\`\`text\n${text}\n\`\`\``,
    text.replace("I've selected", 'I will select'), text.replace("I've selected", 'I might select'),
    text.replace("I've selected", 'Have I selected'), text.replace("I've selected", "I haven't selected"),
    text.replace('reviewing', 'not reviewing'), text.replace('since', 'if'),
    text.replace("since we're in plan mode.", 'pending approval.'),
    text.replace("since we're in plan mode.", 'tomorrow.'),
    text.replace("since we're in plan mode.", 'unless you object.'),
    text.replace("since we're in plan mode.", 'only after approval.'),
    text.replace('draft plan since', 'branch diff since'), text.replace(/\.$/, '?'),
    text + " Now I'll review the branch diff instead.",
    'I have selected reviewing the supplied plan.',
  ]) expect(verdict(fixture(invalid)), invalid).toBe(false);
});

test('AG completed selection still requires this parent and a successful prior skill load', () => {
  const text = `I've selected reviewing the pasted "Marketing landing page" draft plan since we're in plan mode.`;
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.transcript.status = 'missing'; },
    (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.sessionId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = timestamp(0); },
    (f: ReturnType<typeof fixture>) => { f.tools[0]!.input!.skill = 'plan-eng-review'; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.isError = true; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.sessionId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.tools[1]!.toolUseId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.tools.pop(); },
    (f: ReturnType<typeof fixture>) => { f.tools.push({ ...f.tools[1]! }); },
  ]) { const f = fixture(text); mutate(f); expect(verdict(f)).toBe(false); }
  expect(verdict(fixture(text), { ...opts, commandStartedAt: START + 10 })).toBe(false);
  expect(verdict(fixture(text), { ...opts, sessionId: '' })).toBe(false);
  expect(verdict(fixture(text), { ...opts, seed: opts.seed + '\n# Another plan' })).toBe(false);
});

test('AG actual scope fixture has exactly the existing two plan-mode owners', () => {
  const selected = selectTests(['test/fixtures/design-plan-scope-ag.json'], E2E_TOUCHFILES).selected;
  expect([...selected].sort()).toEqual(['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']);
});


test('AG audit continuation cannot withdraw or relabel the current selection', () => {
  const text = `I've selected reviewing the pasted "Marketing landing page" draft plan since we're in plan mode.`;
  for (const tail of [
    ' Now I retract that selection.',
    ' Then cancel that selection; review the branch diff.',
    ' Next, treat that declaration as a hypothetical example.',
    " Now I'll run the audit and retract that selection.",
    " Next, I will start the audit and treat that declaration as a hypothetical example.",
    " Now I'll run the audit. That selection was hypothetical.",
    " Now I'll run the audit. That selection is cancelled.",
  ]) expect(verdict(fixture(text + tail)), tail).toBe(false);
  expect(verdict(fixture(text + " Now I'll run the audit, including the examples in DESIGN.md."))).toBe(true);
  expect(verdict(fixture(text + '\n\n> Example: cancel that selection.'))).toBe(true);
});

// These are public observation projections. Synthetic mutations below are
// controls; the recorded failed paid outcomes are never rewritten.
const awInput = (i = 0) => structuredClone(awFixture[i]!);
const awCheck = (p = awInput()) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);
test('AW first and retry select the unique pasted draft before loading the requested skill', () => {
  expect(awFixture).toHaveLength(4);
  for (const p of awFixture) {
    expect(p.observed.scopeGateAutoSelectObserved).toBe(false);
    expect(awCheck(p)).toBe(true);
    expect(Date.parse(p.transcript.assistantMessages[0]!.timestamp)).toBeLessThan(Date.parse(p.tools[0]!.timestamp));
  }
});

test('a current target may be announced before or after load, but always before review work', () => {
  for (const i of [0, 1, 2, 3]) {
    const p = awInput(i), m = p.transcript.assistantMessages[0]!;
    m.timestamp = new Date(Date.parse(p.tools[1]!.timestamp) + 1).toISOString();
    expect(awCheck(p)).toBe(true);
    const title = /^#\s+(?:Plan:\s*)?(.+)$/m.exec(p.opts.seed)![1]!;
    m.timestamp = new Date(p.opts.commandStartedAt + 1).toISOString();
    m.text = `I'll review "${title}" plan.`;
    expect(awCheck(p)).toBe(true);
    m.timestamp = p.tools[2]!.timestamp;
    expect(awCheck(p)).toBe(false);
  }
});

test('new scope route rejects stale, foreign, premature or unsuccessful evidence', () => {
  const controls: Array<(p: ReturnType<typeof awInput>) => void> = [
    p => { p.transcript.assistantMessages[0]!.timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); },
    p => { p.transcript.assistantMessages[0]!.timestamp = 'unknown'; },
    p => { p.transcript.assistantMessages[0]!.sessionId = 'foreign'; },
    p => { p.transcript.status = 'error'; },
    p => { p.opts.seed += '\n# Plan: Another plan'; },
    p => { p.tools[0]!.input!.skill = 'plan-ceo-review'; },
    p => { p.tools[0]!.sessionId = 'foreign'; },
    p => { p.tools[1]!.isError = true; },
    p => { p.tools[1]!.toolUseId = 'unrelated'; },
    p => { p.tools[1]!.sessionId = 'foreign'; },
    p => { p.tools.splice(1, 1); },
    p => { p.tools.push(structuredClone(p.tools[1]!)); },
    p => { p.tools[2]!.timestamp = new Date(p.opts.commandStartedAt + 1).toISOString(); },
    p => { p.tools[2]!.timestamp = new Date(Date.parse(p.tools[1]!.timestamp) - 1).toISOString(); },
    p => { p.tools[2]!.timestamp = 'unknown'; },
    p => { p.tools[0]!.timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); },
  ];
  for (const [index, mutate] of controls.entries()) { const p = awInput(); mutate(p); expect(awCheck(p), `control ${index}`).toBe(false); }
});

test('unique-draft declarations must be affirmative and owned, not merely a skill introduction', () => {
  for (const text of [
    `I'll run the /plan-design-review skill.`, `I'll run the /plan-eng-review skill on this draft plan.`,
    `I'll run the plan-design-review skill on this draft plan if approved.`,
    `I'll run the plan-design-review skill on this draft plan?`,
    `I'll run the plan-design-review skill on a draft plan.`,
    `I might run the plan-design-review skill on this draft plan.`,
    `I won't run the plan-design-review skill on this draft plan.`,
    `I'll run the plan-design-review skill on this draft plan or another plan.`,
    `If approved, I'll review this draft plan.`, `Provided the plan exists, I'll review this draft plan.`,
    `> I'll review this draft plan.`, `"I'll review this draft plan."`, `    I'll review this draft plan.`,
    `Source excerpt:\nI'll review this draft plan.`, `Historical note:\nI'll review this draft plan.`,
    '```text\nI\'ll review this draft plan.\n```',
  ]) { const p = awInput(); p.transcript.assistantMessages[0]!.text = text; expect(awCheck(p), text).toBe(false); }
  for (const text of [`I'll review this draft plan.`, `I will review your draft plan.`, `I'll run the gstack:plan-design-review skill against the draft plan.`]) {
    const p = awInput(); p.transcript.assistantMessages[0]!.text = text; expect(awCheck(p), text).toBe(true);
  }
});

test('Skill arguments cannot override the announced target or borrow a quoted matching title', () => {
  for (const args of [
    'branch diff', 'Review the draft plan "Another plan".',
    'Review the branch diff; the old draft was "Marketing landing page".',
    'Example: Review the draft plan "Marketing landing page".',
    '"Review the draft plan \\"Marketing landing page\\"."',
    'Review the draft plan "Marketing landing page" if approved.',
    'Review the draft plan "Marketing landing page". Instead review the branch diff.',
    'Review the draft plan "Marketing landing page" (not the target; review another plan).',
  ]) { const p = awInput(1); p.tools[0]!.input!.args = args; expect(awCheck(p), args).toBe(false); }
  for (const args of ['Review the pasted \"Marketing landing page\" draft plan.', 'Review the draft plan \"Marketing landing page\".']) {
    const p = awInput(1); p.tools[0]!.input!.args = args; expect(awCheck(p), args).toBe(true);
  }
  const p = awInput(1); p.opts.seed = p.opts.seed.replace('Marketing landing page', 'Checkout page');
  p.tools[0]!.input!.args = p.tools[0]!.input!.args!.replace('Marketing landing page', 'Checkout page');
  expect(awCheck(p)).toBe(true);
});

test('later current corrections defeat the draft selection while quoted history does not', () => {
  for (const text of [
    'This selection is withdrawn.', "This selection is 'withdrawn'.", 'This selection is `no longer current`.',
    'This declaration is “no longer current”.',
    'Historical note:\nThat selection is withdrawn.\n## Current status\nThat selection is withdrawn.', 'This selection is superseded.', 'This selection is rejected.',
    'The selected target is now the branch diff.', 'I will review the branch diff instead.',
    'I will review "Another plan" plan.',
  ]) {
    const p = awInput(), m = p.transcript.assistantMessages[0]!;
    p.transcript.assistantMessages.push({...m, timestamp:new Date(Date.parse(m.timestamp)+1).toISOString(), text});
    expect(awCheck(p), text).toBe(false);
  }
  for (const text of ['> This selection is withdrawn.', 'Historical note: "This selection is withdrawn."', 'Source excerpt:\nI will review the branch diff instead.']) {
    const p = awInput(), m = p.transcript.assistantMessages[0]!;
    p.transcript.assistantMessages.push({...m, timestamp:new Date(Date.parse(m.timestamp)+1).toISOString(), text});
    expect(awCheck(p), text).toBe(true);
  }
});

test('the AW public fixture selects the existing scope helper owners without a new paid test', () => {
  expect(selectTests(['test/fixtures/plan-scope-target-aw.json'], E2E_TOUCHFILES, []).selected)
    .toEqual(selectTests(['test/helpers/plan-scope-selection.ts'], E2E_TOUCHFILES, []).selected);
});
