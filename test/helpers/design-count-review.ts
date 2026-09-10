import { designFirstReviewAUQ } from './claude-pty-runner';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { pickDesignCountOutsideVoices } from './design-count-outside';

/** Choosing reviewer participation is setup, even when numbered or asked late. */
export function isDesignCountSetup(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || call.questions.length !== 1 ||
      call.unansweredQuestionIndices?.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^outside(?: design)? voices$/i.test(q.header.trim()) ||
      (q.question.match(/<gstack-qid:/g)?.length ?? 0) !== 1 ||
      !/<gstack-qid:(?:plan-design-review-outside-voices|outside-voices-design)>\s*$/.test(q.question) ||
      (q.question.match(/\?/g)?.length ?? 0) !== 1 ||
      !/^(?:D\s*\d+(?:\s*\(Step\s*0[A-Z]?\))?\s*[—–:-]\s*)?(?:Run|Want|Include|Enable)\s+outside(?: design)? voices\s+(?:before|for)\s+the\s+(?:detailed\s+)?(?:design\s+)?review(?:\s+passes)?\?/i.test(q.question.trim())) return false;
  const labels = q.options.map(option => option.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  // Consume the entire menu, not just its opening question or action labels.
  // Unknown explanatory prose can contain a second product decision.
  const remainder = q.question.slice(q.question.indexOf('?') + 1).replace(/<gstack-qid:[^>]+>\s*$/, '').trim();
  if (remainder && !/^(?:Codex evaluates the design; a Claude subagent reviews completeness\.|Codex evaluates against OpenAI's design hard rules \+ litmus checks; a Claude subagent does an independent completeness review\. \(Requires Codex CLI to be installed\.\))$/.test(remainder)) return false;
  const descriptions = q.options.map(option => (option.description ?? '').trim().replace(/\s+/g, ' '));
  const noDescription = /^(?:Skip Codex \+ Claude subagent outside pass\. Best for this case: it's a scoped settings form update with a complete DESIGN\.md; hard-rejection checks apply to marketing surfaces, not OPERATE\/settings UI\.|Skip outside voices and go straight to the 7 review passes\. Faster; sufficient for most plans\.)$/;
  const yesDescription = /^(?:Run Codex against OpenAI design hard rules \+ litmus checks, and a separate Claude subagent for an independent completeness review\. Adds time but catches anything a single-model pass misses\.|Launches Codex design critique \+ Claude subagent completeness review in parallel before the 7 passes\. Adds 1[–-]2 minutes\.)$/;
  if (labels.some((label, index) => descriptions[index] &&
      !(/^No\b/.test(label) ? noDescription : yesDescription).test(descriptions[index]!))) return false;
  const no = labels.filter(label => /^No(?:\s*[,—–-]\s*|\s+)proceed without$/i.test(label));
  const yes = labels.filter(label => /^Yes(?:\s*[,—–-]\s*|\s+)run (?:outside(?: design)? voices|Codex \+ Claude subagent)$/i.test(label));
  return labels.length === 2 && no.length === 1 && yes.length === 1 &&
    q.options.some(option => option.label === call.answers?.[q.question]);
}

/** A numbered design-system amendment can be the first review decision. */
function numberedVisualHierarchyFinding(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call || call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      call.questions.length !== 1 || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0)) return false;
  const q = call.questions[0]!;
  const finding = /^Gap ([1-9]\d*) of ([1-9]\d*)\s*[—–-]\s*([A-Za-z][A-Za-z0-9_-]{0,39}) button visual hierarchy: apply DESIGN\.md primary button style\?$/i.exec(q.question.trim());
  if (!finding || Number(finding[1]) > Number(finding[2]) ||
      !new RegExp(`^Gap ${finding[1]}: Button$`, 'i').test(q.header.trim()) || q.multiSelect || q.options.length !== 2 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  const apply = labels.findIndex(s => /^Apply DESIGN\.md fix$/i.test(s));
  const defer = labels.findIndex(s => /^Defer to implementation$/i.test(s));
  if (apply < 0 || defer < 0 || apply === defer) return false;
  const control = '[A-Za-z][A-Za-z0-9_-]{0,39}';
  const amendment = new RegExp(`^Add to plan: ${finding[3]} gets #[0-9a-f]{6} filled \\+ (?:white|black) text \\(primary\\); ${control}(?:, ${control})*(?:,? and ${control})? get neutral ghost style\\. Closes the visual hierarchy gap exactly as DESIGN\\.md specifies\\. Implementation task T[1-9]\\d* becomes committed\\.$`, 'i');
  // Both offered bodies describe the actual style amendment or its deferral;
  // readiness, a source-selection question, or an example is not this finding.
  return amendment.test(q.options[apply]!.description?.trim() ?? '') &&
    /^Leave the gap named but unresolved\. Engineer decides the button styles at implementation time without a spec\. Risk: inconsistency with the design system or re-work after review\.$/i.test(q.options[defer]!.description?.trim() ?? '');
}

/** A qidless Issue with its own design gap is a finding, independent of D numbering. */
function ordinaryDesignIssue(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call || call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      call.questions.length !== 1 || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0)) return false;
  const q = call.questions[0]!;
  const title = q.question.split('\n')[0]!.trim();
  const issue = /^(?:D[1-9]\d*\s*[—–:-]\s*)?Issue ([1-9]\d*)(?: \((?:(?:G[1-9]\d*|Pass [1-7]), )?(?:Visual Hierarchy|Spacing|Color|Typography|Motion)\))?: ([^?]+)\?$/i.exec(title);
  if (!issue || !new RegExp(`^Issue ${issue[1]}(?:: [A-Za-z][A-Za-z0-9 _-]{0,39})?$`, 'i').test(q.header.trim()) ||
      /<gstack-qid:/i.test(q.question) || q.multiSelect ||
      q.options.length < 2 || new Set(q.options.map(o => o.label)).size !== q.options.length ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  // The numbered headline must ask about a concrete design requirement.
  // Reviewer participation or workflow navigation can also use Issue labels.
  if (!/\b(?:buttons?|primary actions?|hierarchy|spacing|contrast|colou?rs?|labels?|typography|fonts?|loading|spinner|skeleton|motion)\b/i.test(issue[2]!)) return false;
  const opposed = q.options.filter(o => /^(?:[1-9]\d*[A-Z](?:[).:]\s*|\s+))?(?:Defer|Decline|Leave|Keep|Accept the gap)\b/i.test(o.label));
  const repair = /\b(?:fix|resolve|address)\b/i.test(title) &&
    q.options.some(o => /\b(?:closing|closes|fixes|resolves?|applies?)\b/i.test(o.description ?? ''));
  // A source citation alone can describe a report or the next reviewer.
  // Bind the alternate wording to a named control's concrete style amendment
  // and the opposed choice that leaves the documented violation unresolved.
  const primary = /^Make ([A-Za-z][A-Za-z0-9 _-]{0,39}) the (?:visible|(?:only|single)(?: filled)?) primary action(?: in the header)?$/i.exec(issue[2]!) ??
    /^How should (?:the )?(?:header )?actions establish that ([A-Za-z][A-Za-z0-9 _-]{0,39}) is the primary action$/i.exec(issue[2]!);
  const explicitStyle = primary && `${primary[1]} filled (?:primary )?#[0-9a-f]{6}(?:/| with )(?:white|black)(?: text)?; ` +
    '[A-Za-z][A-Za-z0-9 ,/_-]{0,99} neutral ghost(?: buttons)?\\.';
  const amendments = primary && [
    new RegExp(`^(?:✅\\s*)?Matches DESIGN\\.md exactly: ${primary[1]} filled #[0-9a-f]{6} with (?:white|black) text; ` +
      '[A-Za-z][A-Za-z0-9 ,_-]{0,99} as neutral ghost buttons\\.', 'i'),
    new RegExp(`^(?:✅\\s*)?${primary[1]} becomes the single filled primary \\(#[0-9a-f]{6}, (?:white|black) text\\); ` +
      '[A-Za-z][A-Za-z0-9 /,_-]{0,99} become neutral ghost buttons exactly as DESIGN\\.md specifies\\b', 'i'),
    new RegExp(`^(?:✅\\s*)?${primary[1]} is the single filled #[0-9a-f]{6} button; ` +
      '[A-Za-z][A-Za-z0-9 /,_-]{0,99} become neutral ghosts, exactly per DESIGN\\.md\\b', 'i'),
    new RegExp(`^(?:✅\\s*)?Apply DESIGN\\.md tokens: ${primary[1]} #[0-9a-f]{6} filled with (?:white|black) text; ` +
      '[A-Za-z][A-Za-z0-9 ,/_-]{0,99} neutral ghost(?: buttons)?\\.', 'i'),
    // The same concrete style can cite DESIGN.md before or after its tokens.
    new RegExp(`^(?:✅\\s*)?(?:Apply DESIGN\\.md(?: tokens)?: ${explicitStyle}|${explicitStyle} Exact DESIGN\\.md\\.)`, 'i'),
  ];
  const primaryHeader = !q.header.includes(':') || q.header.split(':')[1]!.trim().toLowerCase() === primary?.[1]?.toLowerCase();
  // The style wordings share one owned decision: a current equal-weight gap,
  // a named control's DESIGN.md amendment, and a different choice retaining it.
  const currentText = (text: string) => text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/`([^`]+)`/g, (_, body: string) => /\s/.test(body) ? '' : body)
    // A quoted status scalar remains a current assertion when its unquoted
    // subject names this decision; whole quoted historical prose stays absent.
    .replace(/"[^"\n]*"|“[^”\n]*”/g, (quoted: string, index: number, source: string) =>
      /^(?:withdrawn|resolved|closed|hypothetical|rejected|cancelled|canceled|not current|no longer current)$/i.test(quoted.slice(1, -1)) &&
      /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:(?:This (?:issue|finding|question|amendment|deferral|style|fix|remedy|choice|option)|Issue [1-9]\d*) (?:is|was|has been)|(?:these|the|this) (?:tokens?|styles?|primary treatment) (?:are|is|were|was|have been|has been)) $/i.test(source.slice(0, index))
        ? quoted.slice(1, -1) : '').replace(/\*\*/g, '');
  const questionText = currentText(q.question);
  const assessments = [...questionText.matchAll(/^ELI10: (.+)$/gm)];
  const prefix = questionText.slice(0, assessments[0]?.index ?? 0)
    .split('\n').filter(line => line.trim()).slice(1);
  const sourceAssessment = /\b(?:historical|hypothetical|quoted|source)\s+(?:example|excerpt|assessment|material|text)\b|\bnot\s+(?:the\s+)?current\s+(?:UI|assessment|finding|amendment|deferral|remedy|choice|option)\b/i;
  const assessment = assessments.length === 1 &&
    prefix.every(line => /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line)) &&
    !/^(?:Project\/branch\/task:|\[P[0-3]\])\s*(?:If|When|Unless)\b/im.test(prefix.join('\n')) &&
    !sourceAssessment.test(prefix.join(' ')) && !sourceAssessment.test(assessments[0]![1]!)
    ? assessments[0]![1]! : '';
  const primaryAssessment = primary && new RegExp(`^(?:Right now|Today) ${primary[1]}(?:, [A-Za-z][A-Za-z0-9 _-]{0,39})+(?:,? and [A-Za-z][A-Za-z0-9 _-]{0,39})? (?:(?:all )?look (?:the same|identical)|are (?:all )?(?:(?:two|three|four|five|six|seven|eight|nine|ten|[1-9]\\d*) )?identical buttons)\\b`, 'i').exec(assessment)?.[0];
  const premiseSentence = assessment.split(/[.!?](?:\s|$)/)[0] ?? '';
  const currentPrimary = !!primaryAssessment && !/\b(?:not|never|no longer)\b/i.test(primaryAssessment) &&
    !/\b(?:archived|historical|hypothetical|quoted|example|previous|earlier)\b/i.test(premiseSentence);
  // The current assessment can state the full token contract while an offered
  // amendment names the existing component variants that implement it.
  const numberValue = (value: string) => /^\d+$/.test(value) ? Number(value) :
    ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(value.toLowerCase());
  const otherControls = primary && primaryAssessment
    ? primaryAssessment.replace(new RegExp(`^(?:Right now|Today) ${primary[1]},\\s*`, 'i'), '')
      .replace(/\s+(?:(?:all )?look (?:the same|identical)|are (?:all )?(?:(?:two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) )?identical buttons)$/, '')
      .split(/,\s*(?:and\s+)?|\s+and\s+/).length : 0;
  const variantContract = primary && new RegExp(`(?:^|[.!?]\\s+)DESIGN\\.md already says ${primary[1]} is the only filled button ` +
    '\\(#[0-9a-f]{6} with (?:white|black) text(?:, about [0-9]+(?:\\.[0-9]+)?:1 contrast)?\\) and the other ' +
    '(two|three|four|five|six|seven|eight|nine|ten|[1-9]\\d*) are neutral ghost buttons\\.', 'i').exec(assessment);
  const invalidContract = /(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:this|that|the) (?:(?:DESIGN\.md|token) )?(?:requirement|contract) (?:is|was|has been) (?:withdrawn|superseded|not current|no longer current)\b/i;
  const namedContract = primary && new RegExp(`(?:^|[.!?]\\s+)DESIGN\\.md already says ${primary[1]} is the only filled primary button and the other (two|three|four|five|six|seven|eight|nine|ten|[1-9]\\d*) are neutral ghost buttons\\.`, 'i').exec(assessment);
  const statedVariant = (variantContract || namedContract) &&
    numberValue((variantContract || namedContract)![1]!) === otherControls &&
    !/\b(?:proposed|hypothetical|quoted|historical|source)\s+(?:example|contract|requirement)\b/i.test(assessment.slice(0, (variantContract || namedContract)!.index)) &&
    !invalidContract.test(questionText);
  const withdrawn = new RegExp(`(?:^|[.!?]\\s+|\\n)(?:Correction:\\s*)?(?:(?:This (?:issue|finding|question|amendment|deferral|style|fix|remedy|choice|option)|Issue ${issue[1]}) (?:is|was|has been) (?:withdrawn|resolved|closed|hypothetical|rejected|cancelled|canceled|not current|no longer current)|We have (?:resolved|closed|withdrawn) this (?:issue|finding)|No current (?:issue|finding|gap|violation) (?:remains|exists))\\b`, 'i');
  const closedGap = /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:this|the|that) (?:gap|violation) (?:is|was|has been) (?:already\s+|now\s+)?(?:resolved|fixed|closed)\b/i;
  const cancelledStyle = /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw)\s+(?:apply|use|add|keep)\s+(?:(?:these|the|this)\s+)?(?:tokens?|styles?|primary treatment)\b/i;
  const withdrawnStyles = /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:these|the|this) (?:tokens?|styles?|primary treatment) (?:are|is|were|was|have been|has been) (?:withdrawn|rejected|cancelled|canceled|not current|no longer current)\b/i;
  const choiceIds = q.options.map(o => /^([1-9]\d*)[A-Z](?:[).:]?\s+)/.exec(o.label));
  const primaryRepair = primaryHeader && amendments && currentPrimary &&
    !!call.answeredAt && Number.isFinite(Date.parse(call.answeredAt)) &&
    choiceIds.every(id => id?.[1] === issue[1]) &&
    !withdrawn.test(questionText) && !closedGap.test(questionText) && !withdrawnStyles.test(questionText) &&
    q.options.some(amendment => {
      const body = currentText(amendment.description ?? '');
      const style = amendments.map(pattern => pattern.exec(body)).find(Boolean)?.[0];
      const variantLine = /^✅\s*Uses the existing Button primary and ghost variants from DESIGN\.md; no new styles\./m.exec(body);
      const benefits = variantLine ? body.slice(0, variantLine.index).trim().split('\n').filter(Boolean) : [];
      const labelledRoles = /^✅ Matches DESIGN\.md exactly: one filled primary, (two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) neutral ghosts, [1-9]\d*px targets kept\./.exec(body);
      const labelledStyle = statedVariant && namedContract && labelledRoles &&
        numberValue(labelledRoles[1]!) === otherControls &&
        new RegExp(`^[1-9]\\d*[A-Z]\\) ${primary![1]} filled #[0-9a-f]{6}/(?:white|black), others ghost(?: \\(recommended\\))?$`, 'i').test(amendment.label);
      const variantRepair = (labelledStyle || (statedVariant && variantContract && variantLine &&
        new RegExp(`^[1-9]\\d*[A-Z] Filled ${primary![1]}, ghost others(?: \\(recommended\\))?$`, 'i').test(amendment.label) &&
        benefits.every(line => /^✅\s*(?!(?:If|When|Unless|Historical|Hypothetical|Quoted|Source|Example)\b)\S/i.test(line)) &&
        !/\b(?:archived|historical|hypothetical|quoted|previous|earlier)\b/i.test(benefits.join(' ')))) &&
        !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:apply|use|add|keep) (?:the |these )?(?:Button )?primary and ghost variants\b/i.test(body) &&
        !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:these|the|this) (?:tokens?|styles?|variants?) (?:do|does) not match DESIGN\.md\b/i.test(body) &&
        !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:the|this) (?:current )?amendment keeps all (?:two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) buttons identical\b/i.test(body);
      // A named primary cannot simultaneously occur in the ghost-control list.
      if ((!style && !variantRepair) || (style && new RegExp(`\\b${primary![1]}\\b`, 'i').test(style.slice(style.indexOf(';') + 1))) ||
          sourceAssessment.test(body) || withdrawn.test(body) || closedGap.test(body) || cancelledStyle.test(body) || withdrawnStyles.test(body)) return false;
      return opposed.some(defer => {
        const declined = currentText(defer.description ?? '');
        // Native menus can list current benefits before the gap retained by
        // declining. Only consume a complete affirmative pro/con prefix; prose
        // framing a source example or a future condition cannot expose an icon.
        const pros = /^(?:✅(?!\s*(?:If|When|Unless|Historical|Hypothetical|Quoted|Source|Example)\b)\s*[^✅❌]+)+❌\s*/i.exec(declined);
        const remaining = pros && !sourceAssessment.test(pros[0]) ? declined.slice(pros[0].length) : declined;
        const retainedButtons = /^(?:❌\s*)?Keep all (two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) (?:header )?buttons identical; gap stays documented\./i.exec(remaining);
        const cancelledRetainedButtons = /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:keep|leave) (?:all )?(two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) (?:header )?buttons identical\b/i.exec(declined);
        return defer !== amendment && !sourceAssessment.test(declined) && !withdrawn.test(declined) && !closedGap.test(declined) &&
          ((retainedButtons && numberValue(retainedButtons[1]!) === otherControls + 1 &&
              (!cancelledRetainedButtons || numberValue(cancelledRetainedButtons[1]!) !== otherControls + 1)) ||
            /^(?:❌\s*)?(?:Leaves a documented DESIGN\.md violation in place|Ships the documented violation;[^.\n]*\bthe gap remains open|Primary-action ambiguity ships; documented DESIGN\.md violation remains|Decline the fix; gap stays documented and lowers the score|Keep all (?:two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) identical; record as an open DESIGN\.md violation)\b/i.test(remaining) ||
            (variantRepair && /^(?:Violates DESIGN\.md and leaves users guessing which action is primary; Pass [1-7] stays at [0-9](?:\.[0-9]+)?\/10|Documented DESIGN\.md violation ships and Pass [1-7] stays at [0-9](?:\.[0-9]+)?\/10)\.$/i.test(remaining)));
      });
    });
  return opposed.length > 0 && !!(repair || primaryRepair);
}

/** A design-system choice can name the gap without using an imperative repair verb. */
function designSystemChoiceIssue(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call || call.answered !== true || call.failed !== false || !call.sessionId || !call.toolUseId ||
      call.questions.length !== 1 || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      !call.answeredAt || !Number.isFinite(Date.parse(call.answeredAt))) return false;
  const q = call.questions[0]!;
  const lines = q.question.trim().split('\n');
  const issue = /^(?:D[1-9]\d*\s*[—–:-]\s*)?Issue ([1-9]\d*): (.+)\?$/.exec(lines[0]!);
  if (!issue || q.header.trim() !== `Issue ${issue[1]}` || lines.length !== 7 ||
      !/^Project\/branch\/task: [^\n,]+ on [^\n,]+, PLAN\.md design review, Pass [1-7] [A-Za-z][A-Za-z &()-]+\.$/.test(lines[1]!) ||
      !/^ELI10: \S/.test(lines[2]!) || !/\bDESIGN\.md\b/.test(lines[2]!) ||
      !/^Stakes if we pick wrong: \S/.test(lines[3]!) || !/^Recommendation: \S/.test(lines[4]!) ||
      !/^Completeness: \S/.test(lines[5]!) || !/^Net: \S/.test(lines[6]!) ||
      /<gstack-qid:|```|^ELI10: (?:Example|Hypothetical|Quoted)\b/im.test(q.question) || q.multiSelect ||
      q.options.length < 2 || q.options.length > 4 || new Set(q.options.map(o => o.label)).size !== q.options.length ||
      !q.options.every(o => new RegExp(`^${issue[1]}[A-Z]: \\S`).test(o.label)) ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  // These are current visual/interaction choices, not reviewer participation or next-step routing.
  const subjects = [
    /^How should [A-Z][A-Za-z0-9 _/-]{0,79} be distinguished from [A-Z][A-Za-z0-9 ,/_-]{0,119}$/,
    /^What does the user see while [A-Z][A-Za-z0-9 _/-]{0,79} is pending for [1-9]\d*(?:[-–][1-9]\d*)? seconds$/,
    /^What type scale should (?:form )?labels(?: and section headings)? use$/,
    /^What vertical spacing rhythm should the form use$/,
    /^How should (?:the )?error message meet WCAG AA contrast$/,
  ];
  const subject = subjects.findIndex(pattern => pattern.test(issue[2]!));
  if (subject < 0) return false;
  const assessments = [/^ELI10: The header shows\b/, /^ELI10: After clicking\b/,
    /^ELI10: Labels on the form are set\b/, /^ELI10: Gaps between sections are\b/, /^ELI10: The error message is\b/];
  if (!assessments[subject]!.test(lines[2]!) ||
      /(?:^|[.!?]\s+)(?:This (?:issue|finding) (?:is|has been) (?:withdrawn|resolved|closed)|We have (?:resolved|closed|withdrawn) this (?:issue|finding)|No current (?:issue|finding|gap|defect|violation) (?:remains|exists))\b/i.test(lines[2]!.slice(7))) return false;
  const control = /^How should (.+) be distinguished from /.exec(issue[2]!)?.[1];
  const concrete = [new RegExp(`^${control}\\b[^\\n]*\\b(?:filled|ghost|outlined|primary)\\b`, 'i'),
    /^(?:Spinner|InlineStatus|Static indicator)\b/i, /^[1-9]\d*px\b/i, /^[1-9]\d*px\b/i, /^#[0-9a-f]{6}\b/i][subject]!;
  const conforming = q.options.filter(o => concrete.test(o.label.replace(/^[1-9]\d*[A-Z]: /, '')) &&
    (/^✅ Exact(?:ly)? (?:the (?:two )?)?DESIGN\.md\b/.test(o.description ?? '') ||
      (subject === 0 && new RegExp(`^✅ ${control} is [^\\n]+\\bexactly per DESIGN\\.md\\b`).test(o.description ?? ''))));
  return conforming.some(choice => q.options.some(o => o !== choice &&
    /^❌ (?:Ships (?:the documented violation|a known WCAG AA failure)\b|Deviates from the DESIGN\.md\b)/m.test(o.description ?? '')));
}

/** A completed finding can start the passes when the caller already supplied the focus. */
export function isDesignCountFirstReview(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  if (isDesignCountSetup(fp)) return false;
  if (numberedVisualHierarchyFinding(fp) || ordinaryDesignIssue(fp) || designSystemChoiceIssue(fp)) return true;
  if (designFirstReviewAUQ(fp)) return true;
  return call.questions.some(q => {
    if (!call.answers?.[q.question] || q.options.length < 2) return false;
    if (/^(?:focus|scope|learnings|routing|next steps?|outside(?: design)? voices)$/i.test(q.header.trim())) return false;
    const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1] ?? '';
    if (/(?:^|-)(?:focus|scope|setup|routing|learnings|onboarding|next-steps?|posture|mockups?|target)(?:-|$)/i.test(id)) return false;
    // Native fingerprints prepend the menu header. Inspect the actual question
    // for an explicit finding that offers a plan amendment and deferral.
    if (call.answered === true && call.failed === false && /^Pass\s*[1-7]\s*\([^)]*\)\s*[—–:]\s*Finding\s*[1-9]\d*:\s+\S/i.test(q.question.trim()) &&
        /^plan-design-review-[a-z0-9-]+$/i.test(id) &&
        (q.question.match(/<gstack-qid/gi)?.length ?? 0) === 1 &&
        /\b(?:Apply|Add|Fix|Specify|Define|Restore)\b[^?\n]*\b(?:to|in) the plan\?\s*<gstack-qid:[^>]+>\s*$/i.test(q.question) &&
        q.options.some(option => /^(?:Apply|Add|Fix|Specify|Define|Restore)\b/i.test(option.label)) &&
        q.options.some(option => /^(?:Defer|Leave|Keep as-is|Accept the gap)\b/i.test(option.label)) &&
        q.options.some(option => option.label === call.answers?.[q.question]) &&
        Array.isArray(call.unansweredQuestionIndices) && !call.unansweredQuestionIndices.length &&
        fp.signature === `${call.sessionId}:${call.toolUseId}`) return true;
    // A named or scored pass can ask for a missing design requirement before a
    // numbered finding heading appears. Its actual decision and opposed
    // choices establish review; a score or familiar qid alone cannot.
    const scoredPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*\([^)]*\)\s*[—–:-]\s*(?:10|[0-9])(?:\.[0-9]+)?\/10[.!:]/i.test(q.question.trim());
    const namedPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*[—–:-]\s*[A-Za-z][A-Za-z ]{3,60}:\s+/i.test(q.question.trim());
    const chosen = q.options.some(option => option.label === call.answers?.[q.question]);
    const fixChoice = q.options.some(option => /^(?:Add|Fix|Specify|Define|Restore)\b/i.test(option.label));
    const leaveChoice = q.options.some(option => /^(?:Leave as-is|Keep as-is|Defer|Accept the gap)\b/i.test(option.label) ||
      /^Skip\s*[—–-]\s*implied by\s+[^.!?]+\bgap$/i.test(option.label));
    if ((scoredPass || namedPass) && /^plan-design-review-[a-z0-9-]+$/i.test(id) &&
        (q.question.match(/<gstack-qid/gi)?.length ?? 0) === 1 &&
        /\b(?:gap|problem|defect|missing|inconsisten\w*)\b|\b(?:doesn['’]t|does not)\s+(?:record|specify|define|describe)\b/i.test(q.question) &&
        /\bShould I (?:add|fix|specify|define|restore)\b[^?]+\?\s*<gstack-qid:[^>]+>\s*$/i.test(q.question) &&
        fixChoice && leaveChoice && chosen &&
        !(call.unansweredQuestionIndices?.length) &&
        fp.signature === `${call.sessionId}:${call.toolUseId}`) return true;
    // Native pass decisions can carry a D-number before the pass title and
    // use plan-design-passN rather than plan-design-review-... identities.
    // Bind both forms to the same explicit pass and an offered choice that
    // leaves a named gap unresolved. Pass readiness is only setup.
    const numberedPass = /^D\s*\d+\s*[—–:-]\s*Pass\s*([1-7])\s*\([^)]*\)\s*:/i.exec(q.question.trim());
    const passId = /^plan-design-pass([1-7])-/i.exec(id);
    const unresolvedChoice = q.options.some(option =>
      /\b(?:leave|keep|defer|accept)\b/i.test(option.label) &&
      /\b(?:gap|problem|defect|inconsisten\w*)\b/i.test(`${option.label} ${option.description ?? ''}`));
    if (numberedPass && passId && numberedPass[1] === passId[1] && unresolvedChoice && /\?/.test(q.question)) return true;
    // These are issue-bearing pass statements in actual answered calls,
    // not a setup request that merely mentions the seven review passes.
    return /^Pass\s*[1-7]\s+(?:surfaces|(?:also\s+)?(?:found|flagged))\b/i.test(q.question.trim()) &&
      /\?/.test(q.question);
  });
}

/** A closed recap may explain why Eng is next; it cannot request another fix. */
function closedDesignGateRecap(tail: string, descriptions: string[]): boolean {
  const navigation = /\bWhat(?:['’]s)?\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.exec(tail);
  if (!navigation) return false;
  const body = tail.slice(0, navigation.index).trim();
  const gate = /^(?:Eng(?:ineering)? Review is (?:the )?required (?:shipping gate|gate before shipping))[.!]?$/i;
  const sentences = (text: string) => text.split(/[.!]\s+|[.!]$/).map(s => s.trim()).filter(Boolean);
  const recap = (text: string): boolean => {
    // Each count describes completed or explicitly absent work. A positive
    // deferred/open count is not a closed review, regardless of its title.
    const count = /^(?:(?:\d+|all)\s+(?:design\s+)?(?:decisions|findings|issues)\s+(?:(?:are|were)\s+)?(?:resolved|approved|addressed|closed)|\d+\s+(?:implementation\s+)?tasks\s+(?:(?:are|were)\s+)?(?:added|recorded|ready)|(?:no|zero|0)\s+(?:deferred(?:\s+(?:decisions|findings|issues|tasks|items))?|(?:unresolved|open|pending|outstanding)\s+(?:decisions|findings|issues|tasks|items)))$/i;
    if (text.split(/,\s*(?:and\s+)?|\s+and\s+/i).every(part => count.test(part))) return true;
    // Only a declarative completed-review subject can introduce explanatory
    // content. Separate clauses, questions and conditional/future work fail.
    if (!/^(?:The|This)\s+(?:design\s+)?review\s+(?:has\s+)?(?:added|recorded|approved|addressed|specified|covered|resolved)\s+\S/i.test(text)) return false;
    if (/[;?<>]|\b(?:if|unless|until|once|when|should|must|need|needs|will|would|could|please|then|also|still|missing|unresolved)\b|\b(?:and|but)\s+(?:first\s+)?(?:do|add|fix|repair|implement|resolve|decide|configure|remove|delete|pick|choose)\b/i.test(text)) return false;
    const clauses = text.split(/\s+[—–]\s+/);
    return clauses.length <= 2 && (clauses.length === 1 || /^(?:architectural|engineering|implementation)\s+(?:implications|considerations|details)\b/i.test(clauses[1]!));
  };
  const parts = sentences(body);
  if (parts.filter(part => gate.test(part)).length !== 1 ||
      !parts.every(part => gate.test(part) || recap(part))) return false;
  return descriptions.every(description => sentences(description).every(part =>
    gate.test(part) || recap(part) ||
    /^Exit plan mode and proceed on your own$/i.test(part) ||
    /^You have \d+ (?:concrete )?(?:implementation )?tasks ready to build from$/i.test(part)));
}

/** A qidless closed handoff must consume every question/description clause. */
function resolvedDesignHandoff(q: NonNullable<AskUserQuestionFingerprint['nativeCall']>['questions'][number]): number | null {
  if (!/^next review$/i.test(q.header.trim()) || q.options.length !== 2) return null;
  const completed = /^Design review complete [—–-] (?:10|[0-9](?:\.\d+)?)\/10 (?:→|->) (?:10|[0-9](?:\.\d+)?)\/10\. All ([1-9]\d*) decisions resolved\. The plan is design-complete; next is the required shipping gate\. What['’]s next\?$/.exec(q.question.trim());
  if (!completed) return null;
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  const review = labels.findIndex(label => /^Run \/plan-eng-review$/i.test(label));
  const manual = labels.findIndex(label => /^Skip\s*[—–-]\s*I['’]ll handle next steps manually$/i.test(label));
  if (review < 0 || manual < 0 || review === manual) return null;
  const description = (index: number) => (q.options[index]!.description ?? '').trim().replace(/\s+/g, ' ');
  const topics = '(?:spinner|skeleton|(?:button|switch|field) (?:keyboard|focus|loading|error|disabled|pending|success)|(?:keyboard|focus|loading|error|disabled|pending|success) (?:states?|behavior|navigation))';
  const recap = new RegExp('^Eng review is the required shipping gate\\. It validates architecture, component wiring, tests, and accessibility implementation against the ' + completed[1] + ' approved design decisions\\. This design review added interaction specs \\(' + topics + '(?:, ' + topics + ')*\\), so eng review needs to validate their architectural fit\\.$');
  if (!recap.test(description(review)) ||
      !/^End the review workflow here\. The improved plan is at the (?:e2e output|approved plan) path; implementation can begin\. Run \/plan-eng-review later before shipping\.$/.test(description(manual))) return null;
  return manual + 1;
}

function designHandoff(fp: AskUserQuestionFingerprint): { manualIndex: number | null } | null {
  const call = fp.nativeCall;
  if (!call || call.failed || call.questions.length !== 1 ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2) return null;
  const pending = call.answered === false && call.answers === undefined && call.answeredAt === undefined &&
    (call.unansweredQuestionIndices === undefined || (Array.isArray(call.unansweredQuestionIndices) &&
      call.unansweredQuestionIndices.length === 1 && call.unansweredQuestionIndices[0] === 0));
  const resolvedManual = call.failed === false && (call.answered === true || pending) ? resolvedDesignHandoff(q) : null;
  if (resolvedManual !== null) return { manualIndex: resolvedManual };
  if (!/^next\s+steps?$/i.test(q.header.trim())) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)].map(match => match[1]);
  if ((q.question.match(/<gstack-qid\b/gi) ?? []).length !== 1 || ids.length !== 1 || !/^plan-design-(?:review-)?next-steps?$/i.test(ids[0]!)) return null;
  const declaration = q.question.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+steps?\s*:\s*/i, '');
  // Scores and a completed decision count describe a closed review. A
  // condition or unresolved gap cannot masquerade as its next-step menu.
  const completed = /^Design\s+review\s+(?:is\s+)?complete(?:[.!]|\s+\((?:\d+(?:\.\d+)?(?:\/10)?\s*(?:→|->|to)\s*)?\d+(?:\.\d+)?\/10(?:,\s*\d+\s+decisions?(?:\s+(?:made|added))?)?\)[.!])(?:\s|$)/i.exec(declaration);
  if (!completed) return null;
  const requiredGateOffer = /^The required next gate is Eng(?:ineering)? Review\s*[—–-]\s*want me to run it now\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  const closedRecap = q.options.length === 2 && closedDesignGateRecap(
    declaration.slice(completed[0].length).trim(), q.options.map(option => option.description ?? ''));
  const requiredGateQuestion = requiredGateOffer || closedRecap || /^(?:\d+ implementation tasks ready\.\s*)?Eng(?:ineering)? Review is the required shipping gate\.\s*What next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  // The offered Eng action can carry the required-gate declaration while the
  // closed question asks only what is next. Its descriptions remain part of
  // the decision, so they cannot conceal a new repair or conditional closure.
  const describedRequiredGate = /^What['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim()) &&
    q.options.some(option => /^Run \/plan-eng-review(?:\s*\(recommended\))?$/i.test(option.label.trim()) &&
      /^Required gate before shipping[.!]/i.test(option.description ?? ''));
  const guardedNavigation = requiredGateQuestion || describedRequiredGate;
  if (!requiredGateQuestion && !/\bWhat['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration)) return null;
  // A routing label cannot conceal a new repair in its description.
  if (guardedNavigation && q.options.some(option =>
    /(?:^|[.!?;]\s+|\b(?:proceed to|continue to|must|need to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|repair|implement|resolve|decide)\b|\b(?:(?:should|could|can|would)\s+(?:we|I)|(?:we|I)\s+(?:should|could|can|would))\s+(?:add|fix|repair|implement|resolve|decide)\b/i.test(option.description ?? '') ||
    /\b(?:Design|the|this)\s+review\s+(?:(?:is|remains)\s+)?(?:not\s+(?:complete|done|resolved)|incomplete|unfinished)\b|\bnot\s+all\s+(?:decisions|findings|issues|gaps)\s+(?:are\s+)?(?:resolved|complete|done)\b|\b(?:decisions|findings|issues|gaps)\s+(?:are\s+)?not\s+(?:resolved|complete|done)\b/i.test(option.description ?? '') ||
    /\b(?:once|after|when|if|unless|until)\b[^.!?]*\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b|\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b[^.!?]*\b(?:once|after|when|if|unless|until)\b/i.test(option.description ?? ''))) return null;
  // A closed heading does not override an affirmative outstanding-work claim
  // in its recap. Zero/no outstanding work is a compatible completion claim.
  const outstanding = (guardedNavigation ? [declaration, ...q.options.map(o => o.description ?? '')].join('\n') : declaration)
    .replace(/\b(?:no|zero|0)\s+(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b/gi, '')
    .replace(/\bno\s+(?:gaps?|issues?|decisions?|requirements?|work)\s+remains?\b/gi, '');
  if (/\b(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:still\s+)?remains?\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:is|are)\s+still\s+(?:unresolved|open|pending|unaddressed)\b/i.test(outstanding)) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '')
    .replace(/\s*\(recommended\)\s*$/i, '').trim());
  const manual = labels.map(label => /^(?:Handle next steps manually|Skip\s*[—–-]\s*I['’]ll handle next steps manually)$/i.test(label) ||
    (guardedNavigation && /^Skip\s*[—–-]\s*handle (?:next steps )?manually$/i.test(label)));
  const review = labels.map(label => /^Run \/plan-eng-review(?: next)?(?: \(required gate\))?$/i.test(label));
  const navigation = labels.map(label => /^(?:Skip to implementation|Run \/plan-ceo-review(?: first)?|Run \/design-(?:shotgun|html))$/i.test(label));
  if (manual.filter(Boolean).length > 1 || !review.some(Boolean) ||
      !labels.every((_, i) => manual[i] || review[i] || navigation[i])) return null;
  // Classification does not invent a missing stop option. Only an offered
  // manual action can steer a pending question away from another workflow.
  const index = manual.findIndex(Boolean);
  return { manualIndex: index < 0 ? null : index + 1 };
}

/** Completed handoffs retain raw evidence and their own administrative count. */
export function isDesignCompletionHandoff(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || designHandoff(fp) === null) return false;
  const q = call.questions[0]!;
  return q.options.some(option => call.answers?.[q.question] === option.label);
}

/** Preserve the native-only outside opt-out, then finish this review at its actual handoff. */
export function pickDesignCountQuestion(
  routing: AskUserQuestionFingerprint,
  active: AskUserQuestionFingerprint,
): number | null {
  const outside = pickDesignCountOutsideVoices(routing, active);
  if (outside !== null) return outside;
  return active.nativeCall?.answered ? null : designHandoff(active)?.manualIndex ?? null;
}
