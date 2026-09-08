import { describe, expect, test } from 'bun:test';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

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
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE, seen)).toBeNull();
    const reordered = F_SETUP_CAPTURE.replace('❯1.AddroutingrulestoCLAUDE.md', '❯1.Nothanks,skip')
      .replace('2.Nothanks,skip', '2.AddroutingrulestoCLAUDE.md');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
    expect(autoplanRoutingSetupInput(F_SETUP_CAPTURE.replace('Nothanks,skip', 'No thanks, skip—invoke skills manually'), new Set())).toBe('1\r');
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
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(FRESH_RETRY_CAPTURE, seen)).toBeNull();
    const reordered = FRESH_RETRY_CAPTURE.replace('❯1.Addroutingrules(Recommended)', '❯1.Nothanks,manualinvocation')
      .replace('2.Nothanks,manualinvocation', '2.Addroutingrules(Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
  });

  test('requires opposed manual setup actions and rejects ambiguous or unrelated choices', () => {
    for (const decline of [
      'No thanks, delete the file manually',
      'No thanks, manual data migration',
      'No thanks, invoke the deploy manually',
      'Manual invocation',
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
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBeNull();
    expect(autoplanRoutingSetupInput(CAPTURE.replace('works best', 'works   best'), seen)).toBeNull();
  });

  test('chooses Add routing rules by label when option order changes', () => {
    const reordered = CAPTURE.replace('❯1.Addroutingrules(Recommended)', '❯1.Nothanks')
      .replace('2.Nothanks', '2.Add routing rules (Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
  });

  test('accepts the full option labels captured from the subsequent live setup prompt', () => {
    const fullLabels = CAPTURE.replace('Addroutingrules(Recommended)', 'Add routing rules to CLAUDE.md (Recommended)')
      .replace('2.Nothanks', "2.No thanks, I'll invoke skills manually");
    expect(autoplanRoutingSetupInput(fullLabels, new Set())).toBe('1\r');
    expect(autoplanRoutingSetupInput(fullLabels.replace('CLAUDE.md (Recommended)', 'product routes (Recommended)'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(fullLabels.replace("I'll invoke skills manually", 'delete the existing rules'), new Set())).toBeNull();
  });

  test('answers the current captured CLAUDE.md setup, including reordered choices, once', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE, seen)).toBeNull();
    const reordered = CURRENT_CAPTURE.replace('❯1.AddtoCLAUDE.md(recommended)', '❯1.Skip—invokemanually')
      .replace('2.Skip—invokemanually', '2.AddtoCLAUDE.md(recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
    expect(autoplanRoutingSetupInput(CURRENT_CAPTURE.replace('to CLAUDE.md?', "to this project's CLAUDE.md?"), new Set())).toBe('1\r');
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
    expect(autoplanRoutingSetupInput(retry, new Set())).toBe('1\r');
    expect(autoplanRoutingSetupInput(retry.replace('No thanks, manual', 'No thanks, delete it'), new Set())).toBeNull();
  });

  test('answers the exact B timeout menu by its routing label, in either order', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(B_CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(B_CAPTURE, seen)).toBeNull();
    const reordered = B_CAPTURE.replace('❯1.AddroutingrulestoCLAUDE.md(Recommended)', '❯1.Nothanks,invokemanually')
      .replace('2.Nothanks,invokemanually', '2.AddroutingrulestoCLAUDE.md(Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
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
      expect(autoplanRoutingSetupInput(frame, new Set()), opening).toBe('1\r');
    }
  });

  test('recognizes an intact setup qid with an explicit CLAUDE.md action and opposed manual decline', () => {
    const frame = CURRENT_CAPTURE.replace('Add gstack skill routing rules to CLAUDE.md?', 'Configure this project’s CLAUDE.md?');
    expect(autoplanRoutingSetupInput(frame, new Set())).toBe('1\r');
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
