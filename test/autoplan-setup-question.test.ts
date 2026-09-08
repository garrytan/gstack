import { describe, expect, test } from 'bun:test';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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
    for (const file of ['test/helpers/autoplan-setup-question.ts', 'test/autoplan-setup-question.test.ts']) {
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
