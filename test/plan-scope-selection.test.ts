import { expect, test } from 'bun:test';
import awFixture from './fixtures/plan-scope-target-aw.json';
import agFixture from './fixtures/design-plan-scope-ag.json';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeBunCli } from './helpers/fake-bun-cli';
import { fakePlanSeedPrelude } from './helpers/fake-plan-seed';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import { isScopeGateQuestionVisible } from './helpers/claude-pty-runner';
import { readPlanCountTranscript, type NativePublicToolEvent, type PlanCountTranscript } from './helpers/plan-count-transcript';
import captured_design_scope_announcement_ao from './fixtures/design-scope-announcement-ao.json';
import fixture_design_scope_declaration_ak from './fixtures/design-scope-declaration-ak.json';
import fs_design_scope_entry_aq from 'node:fs';
import path_design_scope_entry_aq from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generatePreamble } from '../scripts/resolvers/preamble';
import { generateBaseBranchDetect } from '../scripts/resolvers/utility';
import failedScopes_design_scope_entry_aq from './fixtures/design-scope-checkpoint-at.json';
import { isScopeGateAutoSelectVisible } from './helpers/claude-pty-runner';
import capture_design_scope_selection_aj from './fixtures/design-scope-selection-aj.json';
import fixture_eng_option_b_scope_al from './fixtures/eng-option-b-scope-al.json';
import observedFailures_plan_scope_recovery_av from './fixtures/plan-scope-recovery-av.json';
import { describe } from 'bun:test';
import { expectMentions, expectTokens } from './helpers/prompt-structure';

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

const axAnnouncements = [
  `I'll invoke the /plan-design-review skill to review this landing page plan.`,
  `I'll run the plan-design-review skill on your draft landing-page plan.`,
];
test('AX title-derived descriptors bind the unique pasted plan before or after skill load', () => {
  for (const text of axAnnouncements) for (const delta of [1, 6]) {
    const f = fixture(text); f.transcript.assistantMessages[0]!.timestamp = timestamp(delta);
    f.tools[0]!.timestamp = timestamp(4); f.tools[1]!.timestamp = timestamp(5);
    expect(verdict(f), text).toBe(true);
  }
  for (const text of [
    `I will review this MARKETING landing-page plan.`,
    `I'll review your draft landing   page plan.`,
    `I'll review the landing-page plan.`,
  ]) expect(verdict(fixture(text))).toBe(true);
  expect(verdict(fixture(axAnnouncements[0]!), { ...opts, seed: '# Plan: MARKETING landing-page\n' })).toBe(true);
  expect(verdict(fixture(`I'll review this checkout plan.`), { ...opts, seed: '# Plan: Checkout page\n' })).toBe(true);
});

test('a descriptor must be a contiguous whole-word portion of the unique seed title', () => {
  for (const descriptor of ['pricing page', 'Marketing page', 'land', 'landing pages', 'checkout', 'other landing page']) {
    const text = `I'll review this ${descriptor} plan.`;
    expect(verdict(fixture(text), { ...opts, seed: opts.seed + `\nBody mentions ${descriptor}.` }), descriptor).toBe(false);
  }
  expect(verdict(fixture(axAnnouncements[0]!), { ...opts, seed: opts.seed + '\n# Plan: Another landing page' })).toBe(false);
});

test('described targets retain the affirmative, Skill, timing and current-selection guards', () => {
  for (const text of axAnnouncements) {
    for (const invalid of [
      `> ${text}`, `"${text}"`, `    ${text}`, `Source:\n${text}`, `\`\`\`\n${text}\n\`\`\``,
      text.replace("I'll", 'I might'), text.replace("I'll", "I won't"), text.replace(/\.$/, '?'),
      `If approved, ${text}`, text.replace(/\.$/, ' if approved.'),
      text.replace('plan-design-review', 'plan-eng-review'), text.replace(/\.$/, ' or another plan.'),
    ]) expect(verdict(fixture(invalid)), invalid).toBe(false);
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.sessionId = 'foreign'; },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = timestamp(0); },
      (f: ReturnType<typeof fixture>) => { f.tools[1]!.isError = true; },
      (f: ReturnType<typeof fixture>) => { f.tools[0]!.input!.skill = 'plan-eng-review'; },
      (f: ReturnType<typeof fixture>) => { f.tools[0]!.input!.args = 'Review the branch diff.'; },
      (f: ReturnType<typeof fixture>) => { f.tools.push({kind:'use',name:'Read',sessionId:'owned',toolUseId:'work',timestamp:timestamp(2.5)}); },
    ]) { const f = fixture(text); mutate(f); expect(verdict(f)).toBe(false); }
    for (const correction of ['This selection is withdrawn.', 'The selected target is now the branch diff.', 'I will review "Another plan" plan.', 'I will review your checkout page plan.']) {
      const f = fixture(text); f.transcript.assistantMessages.push({sessionId:'owned',timestamp:timestamp(4),text:correction});
      expect(verdict(f), correction).toBe(false);
    }
  }
});

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
test('real PTY observation binds its explicit session and retains public diagnostics before cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pty-'));
  const cli = createFakeBunCli(path.join(dir, 'fake-claude'), fakePlanSeedPrelude() + `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), id = args[args.indexOf('--session-id') + 1];
fs.writeFileSync(process.env.SCOPE_TEST_ARGV, JSON.stringify(args));
let sent = false;
process.on('gstack-seeded-slash', chunk => {
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
`);
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


test('AG spoken first declaration and explicit retry selection both bind their requested skill', () => {
  const [first, retry] = agFixture.observations;
  // The recorded failed outcome is unchanged; the first public intro names the design review skill.
  expect(nativeSeededPlanSelection(first!.transcript as PlanCountTranscript, first!.tools as NativePublicToolEvent[], first!.opts)).toBe(true);
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
    p => { p.tools.push(structuredClone(p.tools[1]!) as never); },
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
// Exact public AZ intros; identities and timestamps use the existing synthetic fixture.
const spokenEngIntros = [
  "I'll run the eng review skill against your draft plan.",
  "I'll run the eng-manager plan review skill against this draft plan.",
];
const spokenEngFixture = (text: string) => {
  const f = fixture(text); f.tools[0]!.input!.skill = 'plan-eng-review';
  f.transcript.assistantMessages[0]!.timestamp = timestamp(2);
  f.tools[0]!.timestamp = timestamp(4); f.tools[1]!.timestamp = timestamp(5);
  return f;
};
const engScope = { ...opts, skillName: 'plan-eng-review' };
test('human-readable role names bind only the successfully requested skill', () => {
  for (const text of [...spokenEngIntros, "I'll run the plan eng review skill against this draft plan.", "I'll run the eng  review skill against this draft plan.", "I'll run the gstack:plan-eng-review skill against this draft plan."]) {
    expect(verdict(spokenEngFixture(text), engScope), text).toBe(true);
  }
  expect(verdict(fixture("I'll run the design review skill against this draft plan."))).toBe(true);
});
test('spoken skill names retain scope ownership, currentness and target boundaries', () => {
  for (const text of spokenEngIntros) {
    for (const invalid of [text.replace(/(?:eng review|eng-manager plan review)/, 'design review'), text.replace(/(?:eng review|eng-manager plan review)/, 'eng review and design review'), text.replace(/(?:eng review|eng-manager plan review)/, 'Claude reviewer'), `"${text}"`, `Source:\n${text}`, `If approved, ${text}`])
      expect(verdict(spokenEngFixture(invalid), engScope), invalid).toBe(false);
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.tools[0]!.input!.skill = 'plan-design-review'; },
      (f: ReturnType<typeof fixture>) => { f.tools[1]!.isError = true; },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.sessionId = 'foreign'; },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = timestamp(-1); },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages[0]!.timestamp = timestamp(0); },
      (f: ReturnType<typeof fixture>) => { f.tools.push({kind:'use',name:'Read',sessionId:'owned',toolUseId:'work',timestamp:timestamp(1)}); },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages.push({sessionId:'owned',timestamp:timestamp(4),text:'This selection is "withdrawn".'}); },
      (f: ReturnType<typeof fixture>) => { f.transcript.assistantMessages.push({sessionId:'owned',timestamp:timestamp(4),text:'I will review your checkout plan.'}); },
    ]) { const f=spokenEngFixture(text); mutate(f); expect(verdict(f,engScope)).toBe(false); }
    expect(verdict(spokenEngFixture(text),{...engScope,seed:opts.seed+'\n# Another plan'})).toBe(false);
  }
});

describe('design-scope-announcement-ao', () => {
const captured = captured_design_scope_announcement_ao;
const input = () => structuredClone(captured.projection);
type Input = ReturnType<typeof input>;
const announcement = (p: Input) => p.transcript.assistantMessages.find(m => m.sessionId === p.opts.sessionId && m.text.startsWith("I'll auto-select"))!;
const verdict = (p: Input) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);

test('the exact owned post-load option B announcement selects the seeded title', () => {
  expect(captured.rawScopeGateAutoSelectObserved).toBe(false);
  expect(verdict(input())).toBe(true);
});

test('equivalent explicit selection words and balanced title quotes retain identity', () => {
  for (const prefix of ["I'll auto-select", 'I will auto-select', "I'll auto select"]) {
    for (const title of ['Marketing landing page', '"Marketing landing page"', '“Marketing landing page”', '`Marketing landing page`']) {
      const p = input(), m = announcement(p);
      m.text = m.text.replace("I'll auto-select", prefix).replace('Marketing landing page', title);
      expect(verdict(p)).toBe(true);
    }
  }
  const p = input(), m = announcement(p);
  p.opts.seed = p.opts.seed.replace('Marketing landing page', 'Account settings');
  m.text = m.text.replace('Marketing landing page', 'Account settings');
  expect(verdict(p)).toBe(true);
});

const rejected: Array<[string, (p: Input) => void]> = [
  ['wrong option', p => { announcement(p).text = announcement(p).text.replace('option B', 'option A'); }],
  ['wrong target', p => { announcement(p).text = announcement(p).text.replace('Marketing landing page', 'Account settings'); }],
  ['target prefix only', p => { announcement(p).text = announcement(p).text.replace('page draft', 'page experiment draft'); }],
  ['conditional selection', p => { announcement(p).text = 'If approved: ' + announcement(p).text; }],
  ['source selection', p => { announcement(p).text = 'Source excerpt:\n' + announcement(p).text; }],
  ['quoted selection', p => { announcement(p).text = '> ' + announcement(p).text; }],
  ['wholly quoted selection', p => { announcement(p).text = '"' + announcement(p).text + '"'; }],
  ['unbalanced target quotes', p => { announcement(p).text = announcement(p).text.replace('Marketing landing page', '"Marketing landing page'); }],
  ['question instead of assertion', p => { announcement(p).text = announcement(p).text.replace(/\.$/, '?'); }],
  ['conditional tail', p => { announcement(p).text = announcement(p).text.replace(', running', ' if approved, running'); }],
  ['cancelled selection', p => { announcement(p).text += '\nCorrection: this selection is withdrawn.'; }],
  ['quoted status cancellation', p => { announcement(p).text += '\nThis selection is "withdrawn".'; }],
  ['replaced target', p => { announcement(p).text += '\nThe selected target is now the branch diff.'; }],
  ['pre-invocation announcement', p => { announcement(p).timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); }],
  ['foreign announcement', p => { announcement(p).sessionId = 'foreign'; }],
  ['foreign load result', p => { p.tools[1]!.sessionId = 'foreign'; }],
  ['failed skill load', p => { p.tools[1]!.isError = true; }],
  ['wrong skill', p => { p.tools[0]!.input!.skill = 'plan-eng-review'; }],
  ['late command start', p => { p.opts.commandStartedAt = Date.parse(p.tools[1]!.timestamp) + 1; }],
  ['multiple seed titles', p => { p.opts.seed += '\n# Another plan\n'; }],
];
test.each(rejected)('%s supplies no scope selection', (_, change) => {
  const p = input(); p.transcript.assistantMessages = [announcement(p)]; change(p); expect(verdict(p)).toBe(false);
});

test('quoted historical or foreign withdrawals do not replace the current selection', () => {
  for (const correction of ['> This selection is withdrawn.', 'Historical note: "This selection is withdrawn."']) {
    const p = input(); announcement(p).text += '\n' + correction; expect(verdict(p)).toBe(true);
  }
  const p = input(), m = announcement(p);
  p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'This selection is withdrawn.' });
  expect(verdict(p)).toBe(true);
});

test('a later current withdrawal invalidates selection until a later reselection', () => {
  const p = input(), m = announcement(p);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' });
  expect(verdict(p)).toBe(false);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() });
  expect(verdict(p)).toBe(true);
});
});

describe('design-scope-declaration-ak', () => {
const fixture = fixture_design_scope_declaration_ak;
const input = (attempt = 0) => structuredClone(fixture.attempts[attempt]!.projection);
const verdict = (p = input()) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);
const declaration = (p: ReturnType<typeof input>) => p.transcript.assistantMessages.find(m => /^(?:I'll proceed with reviewing|Scope gate confirms plan mode)/.test(m.text))!;

test('both exact owned post-load announcements select the named pasted draft', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt);
    expect(fixture.attempts[attempt]!.rawScopeGateAutoSelectObserved).toBe(false);
    expect(verdict(p)).toBe(true);
  }
});

test('the prior AJ fresh unique-draft introduction now binds without changing its recorded outcome', () => {
  const p = fixture.priorGenuineFailure.projection;
  expect(nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts)).toBe(true);
});

test('target identity and ordinary equivalent current review wording remain bound', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt); p.opts.seed = p.opts.seed.replace('Marketing landing page', 'Account settings');
    p.transcript.assistantMessages.forEach(m => { m.text = m.text.replaceAll('Marketing landing page', 'Account settings'); });
    for (const t of p.tools) if (t.input?.args) t.input.args = t.input.args.replaceAll('Marketing landing page', 'Account settings');
    expect(verdict(p)).toBe(true);
  }
  const p = input(); declaration(p).text = declaration(p).text.replace("I'll proceed", 'I will proceed'); expect(verdict(p)).toBe(true);
});

test('source, historical, quoted, hypothetical and conditional introductions do not select', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const prefix of [
    '> ', '    ', 'Source excerpt:\n', 'Historical example only.\n', 'The following is hypothetical. ', 'If approved, ', '```\n', '"',
  ]) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m]; m.text = prefix + m.text;
    expect(verdict(p)).toBe(false);
  }
});

test('a different target or conditional scope announcement cannot borrow the draft name', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const change of [
    (s: string) => s.replaceAll('Marketing landing page', 'Checkout redesign'),
    (s: string) => s.replace(/draft(?: plan)?/, 'draft plan if approved'),
  ]) { const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m]; m.text = change(m.text); expect(verdict(p)).toBe(false); }
  for (const prefix of ['Scope gate might confirm plan mode, so', 'Scope gate confirms branch mode, so']) {
    const p = input(1); p.transcript.assistantMessages = [declaration(p)]; declaration(p).text = declaration(p).text.replace('Scope gate confirms plan mode, so', prefix); expect(verdict(p)).toBe(false);
  }
});

test('the same successful Skill load and post-command current session remain necessary', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const change of [
    (p: ReturnType<typeof input>) => { p.opts.sessionId = 'foreign'; },
    (p: ReturnType<typeof input>) => { p.tools[1]!.isError = true; },
    (p: ReturnType<typeof input>) => { p.tools[1]!.toolUseId = 'foreign'; },
    (p: ReturnType<typeof input>) => { p.tools[0]!.input!.skill = 'plan-eng-review'; },
    (p: ReturnType<typeof input>) => { p.opts.commandStartedAt = Date.parse(p.tools[1]!.timestamp) + 1; },
    (p: ReturnType<typeof input>) => { declaration(p).timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); p.transcript.assistantMessages = [declaration(p)]; },
  ]) { const p = input(attempt); change(p); expect(verdict(p)).toBe(false); }
});

test('same-message and later current withdrawals or replacement targets defeat selection', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const correction of [
    'Correction: this selection is withdrawn.',
    'The selected target is now the branch diff.',
    'This declaration has been retracted.',
  ]) for (const later of [false, true]) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m];
    if (later) p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: correction });
    else m.text += '\n' + correction;
    expect(verdict(p)).toBe(false);
  }
});

test('literal or foreign corrections preserve the actual declaration and a later reselection is current', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m];
    p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'The selected target is now the branch diff.' });
    p.transcript.assistantMessages.push({ ...m, text: '> This selection is withdrawn.' }); expect(verdict(p)).toBe(true);
    p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(false);
    p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() }); expect(verdict(p)).toBe(true);
  }
});
});

describe('design-scope-entry-aq', () => {
const fs = fs_design_scope_entry_aq;
const path = path_design_scope_entry_aq;
const failedScopes = failedScopes_design_scope_entry_aq;
const template = fs.readFileSync(path.join(import.meta.dir, '../plan-design-review/SKILL.md.tmpl'), 'utf8');
const scope = template.slice(template.indexOf('## Scope gate'), template.indexOf('## Design Philosophy'));
const announcement = 'Scope gate: plan mode — auto-selected B (reviewing <target>).';

test('Design resolves scope before either executable bootstrap placeholder', () => {
  const gate = template.indexOf('## Scope gate');
  expect(gate).toBeGreaterThan(0);
  for (const token of ['{{PREAMBLE}}', '{{BASE_BRANCH_DETECT}}']) {
    expect(template.split(token)).toHaveLength(2);
    expect(template.indexOf(announcement)).toBeLessThan(template.indexOf(token));
    expect(template.indexOf('Reply with A, B, or C')).toBeGreaterThan(gate);
    expect(template.indexOf('Reply with A, B, or C')).toBeLessThan(template.indexOf(token));
  }
  expect(template.indexOf('{{PREAMBLE}}')).toBeLessThan(template.indexOf('{{BASE_BRANCH_DETECT}}'));
  expect(template.indexOf('{{BASE_BRANCH_DETECT}}')).toBeLessThan(template.indexOf('## Design Philosophy'));
});

test('every host expands its real bootstrap after the mandatory entry gate', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx: TemplateContext = {skillName: 'plan-design-review', tmplPath: 'plan-design-review/SKILL.md.tmpl',
      host: host.name, paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
    const preamble = generatePreamble(ctx);
    const brain = host.suppressedResolvers?.includes('BASE_BRANCH_DETECT') ? '' : generateBaseBranchDetect(ctx);
    const expanded = template.replace('{{PREAMBLE}}', preamble).replace('{{BASE_BRANCH_DETECT}}', brain);
    expect(expanded.indexOf(announcement)).toBeLessThan(expanded.indexOf('## Preamble (after scope gate)'));
    expect(expanded.indexOf('Reply with A, B, or C')).toBeGreaterThan(-1);
    expect(expanded.indexOf('Reply with A, B, or C')).toBeLessThan(expanded.indexOf('```bash'));
    expect(expanded.indexOf('```bash')).toBeLessThan(expanded.indexOf('gstack-skill-start', expanded.indexOf('```bash')));
    if (brain) expect(expanded.indexOf(announcement)).toBeLessThan(expanded.indexOf(brain));
  }
});

test('entry binds a current target and delays bootstrap until scope resolves', () => {
  expectMentions(scope, [['before', 'resolve', 'after']], 'scope');
  expect(scope).toContain('including preamble and base-branch detection.');
  expectMentions(scope, [['wait', 'askuserquestion', 'first']], 'scope');
  expectMentions(scope, [['before', 'auto-selection', 'plan-mode']], 'scope');
  // Order after resolution: preamble, base branch, audit, Step 0, then Step 0.5 mockups.
  const order = scope.slice(scope.indexOf('After resolution:')).split('\n')[0]!;
  const steps = ['preamble', 'base branch', 'audit', 'Step 0', 'mockups'].map(step => order.indexOf(step));
  expect(steps.every((offset, i) => offset >= 0 && (i === 0 || offset > steps[i - 1]!))).toBe(true);
});

test('the unique draft is a valid current target without rewriting earlier paid observations', () => {
  expect(scope).toContain(announcement);
  expect(scope).toContain('Name the selected plan by its title or path; use "this draft" only for an untitled pasted plan.');
  expectMentions(scope, [['does not', 'acknowledgment/wait', 'followed']], 'scope');
  expect(scope).not.toContain('After this skill finishes loading');
  for (const row of failedScopes) {
    expect(row.observed.scopeGateAutoSelectObserved).toBe(false);
    expect(nativeSeededPlanSelection(row.transcript as any, row.tools as any, row.opts)).toBe(true);
    const title = /^# Plan: (.+)$/m.exec(row.opts.seed)![1]!;
    expect(isScopeGateAutoSelectVisible(announcement.replace('<target>', title))).toBe(true);
  }
});

test('existing plan selection exceptions and the unseeded stop remain explicit', () => {
  expectMentions(scope, [['does not', 'plan-shaped', 'documents']], 'scope');
  expectMentions(scope, [['ask', 'host-referenced', 'candidates']], 'scope');
  expectMentions(scope, [['no', 'indicated', 'exists']], 'scope');
  expect(scope).toContain('First tool call = AskUserQuestion (tool_use). Confirm what to review.');
  expectTokens(scope, ['`--disallowedTools`'], 'scope');
  expect(scope).toContain('A) The current branch diff — the work in progress on this branch.\nB) A plan or design doc I\'ll paste or point you to.\nC) A specific page, file, or path.');
  expect(scope).toContain('Reply with A, B, or C');
  expectMentions(scope, [['stop', 'answer', 'after']], 'scope');
});
});

describe('design-scope-selection-aj', () => {
const capture = capture_design_scope_selection_aj;
const originals = capture.observations;
const check = (observation = structuredClone(originals[0]!)) => nativeSeededPlanSelection(
  observation.transcript as PlanCountTranscript,
  observation.tools as NativePublicToolEvent[],
  observation.opts,
);
const selectedMessage = (o: typeof originals[number]) => o.transcript.assistantMessages.find(m => m.text.includes('"Marketing landing page"'))!;

test('both actual explicit draft selections bind the named seed after this session loaded the skill', () => {
  for (const o of originals) expect(check(o)).toBe(true);
  for (const verb of ["I'll review", 'I will review', "I'll go with reviewing", 'I will go with reviewing']) {
    const o = structuredClone(originals[1]!);
    selectedMessage(o).text = `${verb} the "Marketing landing page" draft, starting by checking the design system.`;
    expect(check(o)).toBe(true);
  }
});

test('a named target still requires the successful current skill and invocation', () => {
  for (const original of originals) {
    for (const mutate of [
      (o: typeof original) => { o.opts.seed = '# Plan: Other page'; },
      (o: typeof original) => { o.opts.seed += '\n# Plan: Another'; },
      (o: typeof original) => { o.opts.sessionId = 'foreign'; },
      (o: typeof original) => { o.opts.commandStartedAt = Date.parse(selectedMessage(o).timestamp) + 1; },
      (o: typeof original) => { o.tools[0]!.input!.skill = 'plan-ceo-review'; },
      (o: typeof original) => { o.tools[1]!.isError = true; },
      (o: typeof original) => { o.tools[1]!.toolUseId = 'foreign'; },
      (o: typeof original) => { o.tools.pop(); },
    ]) {
      const o = structuredClone(original); o.transcript.assistantMessages = [selectedMessage(o)]; mutate(o); expect(check(o)).toBe(false);
    }
  }
});

test('quoted, hypothetical, conditional and withdrawn selections do not select the seed', () => {
  for (const original of originals) {
    const text = selectedMessage(original).text.trim();
    for (const invalid of [
      '> ' + text, '    ' + text, '"' + text + '"', 'Example:\n' + text,
      'The following is a source excerpt.\n' + text, 'An unproven hypothesis.\n' + text,
      text.replace("I'll", 'I might'), text.replace("I'll", "I won't"),
      text.replace('Marketing landing page', 'Other page'),
      text.replace('draft', 'branch diff'), text.replace(/,$/, '?'),
      text.replace(', ', ', if approved, '),
      text + ' I retract that selection.', text + ' This selection is withdrawn.',
      text + ' Treat that declaration as a hypothetical example.',
    ].filter(value => value !== text)) {
      const o = structuredClone(original); o.transcript.assistantMessages = [selectedMessage(o)]; selectedMessage(o).text = invalid;
      expect(check(o), invalid).toBe(false);
    }
  }
});
test('a complete owned observation cannot use a withdrawn selection or a replacement target', () => {
  for (const original of originals) {
    for (const correction of ['The selection has been withdrawn.', 'The selected target is now the branch diff.', 'I have withdrawn this selection.', 'Correction: The selected target is now the branch diff.']) {
      for (const separator of [' ', '\n\n']) {
        const o = structuredClone(original);
        selectedMessage(o).text = selectedMessage(o).text.trim() + separator + correction;
        expect(check(o)).toBe(false);
      }
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + 1000).toISOString(), text: correction });
      expect(check(o)).toBe(false);
    }
  }
});

test('old, unrelated, foreign and quoted assessments do not withdraw the current target', () => {
  for (const original of originals) {
    for (const text of [
      'Old note: "The selection has been withdrawn."',
      '> The selection has been withdrawn.',
      '```text\nThe selected target is now the branch diff.\n```',
      'Source excerpt:\nThe selection has been withdrawn.',
      'The following is a hypothetical example.\nThe selected target is now the branch diff.',
      'An unrelated payment selection has been withdrawn.',
      'The selected target is now the "Marketing landing page" draft.',
      'If approved, the selection has been withdrawn.',
      'The selected target is now the branch diff?',
      'The selected target is now the branch diff? This is a question.',
      'I have withdrawn this selection?',
    ]) {
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + 1000).toISOString(), text });
      expect(check(o), text).toBe(true);
    }
    for (const foreign of [false, true]) {
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: foreign ? 'foreign' : o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + (foreign ? 1000 : -1000)).toISOString(), text: 'The selection has been withdrawn.' });
      expect(check(o)).toBe(true);
    }
    const o = structuredClone(original), selected = structuredClone(selectedMessage(o));
    o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selected.timestamp) + 1000).toISOString(), text: 'The selection has been withdrawn.' });
    o.transcript.assistantMessages.push({ ...selected, timestamp: new Date(Date.parse(selected.timestamp) + 2000).toISOString() });
    expect(check(o)).toBe(true);
  }
});
});

describe('eng-option-b-scope-al', () => {
const fixture = fixture_eng_option_b_scope_al;
const actualInput = (attempt = 1) => structuredClone(fixture.attempts[attempt]!.projection);
const input = () => {
  const p = actualInput();
  // Mutate the named declaration alone; the earlier spoken introduction is
  // independently valid and remains present in the exact replays below.
  p.transcript.assistantMessages = p.transcript.assistantMessages.filter(m => m.text !== "I'll run the eng review skill on this draft plan.");
  return p;
};
type Input = ReturnType<typeof input>;
const verdict = (p = input()) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);
const declaration = (p: Input) => p.transcript.assistantMessages.find(m => m.text.startsWith("I've selected option B,"))!;

test('both named retry and fresh unique-draft first introduction bind; original outcomes stay intact', () => {
  expect(fixture.attempts.map(a => a.rawScopeGateAutoSelectObserved)).toEqual([false, false]);
  expect(verdict(actualInput(0))).toBe(true);
  expect(verdict(actualInput(1))).toBe(true);
});

test('an unnamed option-B notice supplies no selection without a draft introduction', () => {
  const p = input(); p.transcript.assistantMessages = p.transcript.assistantMessages.filter(m => m !== declaration(p));
  expect(verdict(p)).toBe(false);
  for (const replacement of ['option A,', 'option C,', 'option B if approved,', 'option B, possibly']) {
    const p = input(); declaration(p).text = declaration(p).text.replace('option B,', replacement); expect(verdict(p)).toBe(false);
  }
  for (const target of ['Unrelated draft', 'branch diff']) {
    const p = input(); declaration(p).text = declaration(p).text.replace('Parallelize unit tests', target); expect(verdict(p)).toBe(false);
  }
});

test('equivalent current wording and consistently renamed title preserve selection', () => {
  for (const change of [
    (s: string) => s.replace("I've", 'I have'),
    (s: string) => s.replace('Next I', 'Next, I'),
    (s: string) => s.replace('reviewing the pasted', 'to review the pasted'),
    (s: string) => s.replace(/\. Next.*$/, '.'),
    (s: string) => s.replace('Design Doc Check, brain context, and context recovery, along with the Aside probe', 'audit for DESIGN.md'),
  ]) { const p = input(); declaration(p).text = change(declaration(p).text); expect(verdict(p)).toBe(true); }
  const p = input(); p.opts.seed = p.opts.seed.replace('Parallelize unit tests', 'Build cache invalidation');
  declaration(p).text = declaration(p).text.replace('Parallelize unit tests', 'Build cache invalidation'); expect(verdict(p)).toBe(true);
});

test('quoted, source, hypothetical, historical and conditional first lines cannot select', () => {
  for (const prefix of ['> ', '    ', '\t', '```\n', 'Source excerpt:\n', 'Historical example only.\n', 'The following is a hypothetical example. ', 'If approved, ', '"']) {
    const p = input(); declaration(p).text = prefix + declaration(p).text; expect(verdict(p)).toBe(false);
  }
});

test('the same successful post-command Skill completion and current native session are required', () => {
  for (const change of [
    (p: Input) => { p.opts.sessionId = 'foreign'; },
    (p: Input) => { p.transcript.status = 'unavailable'; },
    (p: Input) => { p.tools = []; },
    (p: Input) => { p.tools[0]!.input!.skill = 'plan-design-review'; },
    (p: Input) => { p.tools[1]!.isError = true; },
    (p: Input) => { p.tools[1]!.sessionId = 'foreign'; },
    (p: Input) => { p.tools[1]!.toolUseId = 'unrelated'; },
    (p: Input) => { p.opts.commandStartedAt = Date.parse(p.tools[0]!.timestamp) + 1; },
    (p: Input) => { declaration(p).timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); },
    (p: Input) => { declaration(p).sessionId = 'foreign'; },
    (p: Input) => { p.tools.push(structuredClone(p.tools[1]!)); },
  ]) { const p = input(); change(p); expect(verdict(p)).toBe(false); }
});

test('conditional, questioning and replacement continuations cannot borrow a completed selection', () => {
  for (const change of [
    (s: string) => s.replace('draft plan.', 'draft plan if approved.'),
    (s: string) => s.replace('Next I', 'If approved, I'),
    (s: string) => s.replace('Aside probe.', 'Aside probe?'),
    (s: string) => s.replace('Design Doc Check', 'branch diff review instead'),
    (s: string) => s.replace('Design Doc Check', 'unrelated work'),
  ]) { const p = input(); declaration(p).text = change(declaration(p).text); expect(verdict(p)).toBe(false); }
});

test('same-message or later owned withdrawals and target changes defeat the declaration', () => {
  for (const correction of ['Correction: this selection is withdrawn.', 'This declaration has been retracted.', 'The selected target is now the branch diff.']) {
    for (const placement of ['same-line', 'same-message', 'later']) {
      const p = input(), m = declaration(p);
      if (placement === 'later') p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: correction });
      else m.text += (placement === 'same-line' ? ' ' : '\n') + correction;
      expect(verdict(p)).toBe(false);
    }
  }
});

test('foreign, historical and literal corrections do not retract a current named selection', () => {
  for (const text of ['> This selection is withdrawn.', 'Source excerpt:\nThis selection is withdrawn.', 'A prior assistant said "This selection is withdrawn."', 'The verification suite is withdrawn.', 'Is this selection withdrawn?']) {
    const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text }); expect(verdict(p)).toBe(true);
  }
  const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(true);
});

test('a later explicit reselection follows the existing currentness rule', () => {
  const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(false);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() }); expect(verdict(p)).toBe(true);
});
});

describe('plan-scope-recovery-av', () => {
const fs = fs_design_scope_entry_aq;
const path = path_design_scope_entry_aq;
const observedFailures = observedFailures_plan_scope_recovery_av;
const skills = ['plan-eng-review', 'plan-design-review'] as const;
const read = (skill: string) => fs.readFileSync(path.join(import.meta.dir, '..', skill, 'SKILL.md.tmpl'), 'utf8');
const recovery = (text: string) => text.split('\n').find(line => line.startsWith('> Before ') && line.includes('publicly identified'))!;

test('the review handoff repairs a missing public declaration without claiming timely compliance', () => {
  for (const skill of skills) {
    const text = read(skill), check = recovery(text);
    expect(check).toBeDefined();
    expect(check).toContain('require resolved scope');
    expectMentions(check, [['before', 'auto-selection', 'identified']], 'check');
    expect(check).toContain('If missing, send "Scope gate: plan mode — auto-selected B (reviewing <target>)." now');
    expectMentions(check, [['do not', 'announcement', 'earlier']], 'check');
    const start = skill === 'plan-eng-review' ? '### Step 0: Scope Challenge' : '## PRE-REVIEW SYSTEM AUDIT';
    expect(text.indexOf(check)).toBeGreaterThan(text.indexOf('{{PREAMBLE}}'));
    expect(text.indexOf(check)).toBeGreaterThan(text.indexOf(start));
    const reviewStart = text.indexOf(skill === 'plan-eng-review' ? '{{SECTION:review-sections}}' : 'Before reviewing the plan, gather context');
    expect(reviewStart).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(check)).toBeLessThan(reviewStart);
    if (skill === 'plan-eng-review') {
      const section = fs.readFileSync(path.join(import.meta.dir, '..', skill, 'sections/review-sections.md.tmpl'), 'utf8');
      expect(section).toContain('### A. Assess the target');
      expectMentions(section, [['before', 'complexity', 'complete']], 'section');
      expect(section.indexOf('### A. Assess the target')).toBeLessThan(section.indexOf('### B. Resolve complexity selectors'));
      expect(section.indexOf('### B. Resolve complexity selectors')).toBeLessThan(section.indexOf('### C. Resolve findings'));
      expectMentions(text.slice(text.indexOf(check), reviewStart), [['before', 'challenge', 'mandatory']], 'section');
    }
  }
});

test('unseeded, explicit-target and early announcement rules remain authoritative on every host', () => {
  for (const skill of skills) {
    const template = read(skill);
    const gate = template.slice(template.indexOf('## Scope gate'), template.indexOf('{{PREAMBLE}}'));
    const entry = skill === 'plan-eng-review'
      ? 'Before discovery tools or preamble, check provided messages, listed tools and explicit host metadata for a target'
      : 'After this skill loads, resolve this gate before any tool';
    const announce = skill === 'plan-eng-review'
      ? 'Announce an auto-selected plan in one line so the user can interrupt'
      : 'Announce plan-mode auto-selection before review tools';
    expect(gate).toContain(entry);
    expect(gate).toContain(announce);
    expectMentions(gate, [['ask', 'host-referenced', 'candidates']], 'gate');
    expectMentions(gate, [['no', 'indicated', 'exists']], 'gate');
    expect(gate).toContain('When no exception above applied:');
    expect(gate).toContain(skill === 'plan-eng-review'
      ? 'First tool call = AskUserQuestion (tool_use). Send this exact menu and wait'
      : 'First tool call = AskUserQuestion (tool_use). Confirm what to review.');
    expectMentions(gate, [['stop', 'answer', 'wait']], 'gate');
    for (const host of ALL_HOST_CONFIGS) {
      const ctx: TemplateContext = {skillName: skill, tmplPath: `${skill}/SKILL.md.tmpl`, host: host.name,
        paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
      const expanded = template.replace('{{PREAMBLE}}', generatePreamble(ctx));
      expect(expanded.indexOf(announce)).toBeLessThan(expanded.indexOf('```bash'));
      const wait = expanded.search(/stop and wait for the answer/i);
      expect(wait).toBeGreaterThan(-1);
      expect(wait).toBeLessThan(expanded.indexOf('```bash'));
      expect(expanded.indexOf(recovery(template))).toBeGreaterThan(expanded.indexOf('```bash'));
    }
  }
});

test('recorded failures stay intact while fresh unique-draft introductions now bind', () => {
  expect(observedFailures).toHaveLength(4);
  for (const [index, row] of observedFailures.entries()) {
    expect(row.observed.scopeGateAutoSelectObserved).toBe(false);
    expect(nativeSeededPlanSelection(row.transcript as any, row.tools as any, row.opts)).toBe(index !== 0);
    const title = /^#\s+(?:Plan:\s*)?(.+)$/m.exec(row.opts.seed)![1]!;
    const loaded = row.tools.find(tool => tool.kind === 'result')!;
    const timestamp = new Date(Date.parse(loaded.timestamp) + 1).toISOString();
    const message = {sessionId: row.opts.sessionId, timestamp, text: `I'll review "${title}" plan.`};
    const amended = {...row.transcript, assistantMessages: [message]};
    // Explicit synthetic control only: no changed message is paid evidence.
    expect(nativeSeededPlanSelection(amended as any, row.tools as any, row.opts)).toBe(true);
    for (const text of [`> ${message.text}`, `Example:\n${message.text}`, `I'll review "Another plan" plan.`]) {
      expect(nativeSeededPlanSelection({...amended, assistantMessages: [{...message, text}]} as any, row.tools as any, row.opts)).toBe(false);
    }
  }
});
});
