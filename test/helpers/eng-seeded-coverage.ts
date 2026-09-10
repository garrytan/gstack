import type { NativePlanQuestionCall, PlanCountTranscript } from './plan-count-transcript';

/** Evidence for this fixture's four decision seeds; regression coverage is auto-added by the skill. */
export const ENG_DECISION_SEEDS = ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] as const;
type Seed = typeof ENG_DECISION_SEEDS[number];

// Ignore displayed examples/code, while retaining inline code identifiers.
function prose(text: string, omitLiteralProse = false): string {
  let fence: string | undefined;
  const lines = text.split('\n').filter(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  }).join('\n');
  return (omitLiteralProse ? lines.replace(/`([^`]+)`/g, (span, body: string) => /\s/.test(body) ? '' : span) : lines).replace(/[`*]/g, '');
}

function seedSubjects(q: NativePlanQuestionCall['questions'][number]): Seed[] {
  // The actual issue subject, not cross-references in recommendations or other options,
  // assigns credit. ELI10 can identify what a terse Promise.all title operates on.
  const subject = q.question.split('\n').find(line => line.trim())?.trim() ?? '';
  if (/^(?:>|`{3}|~{3}|example\b|quote\b|["“])|\b(?:no (?:issue|defect)|already (?:fixed|resolved)|hypothetical)\b/i.test(subject)) return [];
  const title = subject.replace(/[`*]/g, '');
  const offered = q.options.map(o => `${o.label} ${o.description ?? ''}`).join('\n');
  const directAction = title.match(/\b(?:should|shall|can|do|would)\s+(?:we|I)\s+([^?]+)\?\s*$/i)?.[1];
  const action = (re: RegExp) => re.test(offered) || Boolean(directAction && new RegExp(`^(?:${re.source})`, re.flags).test(directAction));
  // A shared adapter title may name its cache in the issue's own asserted
  // explanation. Options alone or a neighboring source excerpt cannot do so.
  const adapterPublic = prose(q.question, true);
  const adapterExplanations = [...adapterPublic.matchAll(/^ELI10:\s*(.+)$/gm)];
  const adapterPrefix = adapterPublic.slice(0, adapterExplanations[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
  const adapterMetadata = adapterPrefix.join(' ').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const adapterExplanation = adapterExplanations.length === 1 && adapterPrefix.every(line => /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line))
    && !/\b(?:copied|quoted|source|hypothetical|historical)\s+(?:(?:source|quoted)\s+)?(?:example|excerpt|text|material)\b|\b(?:ELI10|assessment|finding)\s+is\s+not\s+(?:a\s+)?current\b/i.test(adapterMetadata)
    ? adapterExplanations[0]![1]! : '';
  const adapterAssessment = adapterPublic.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const sharedAdapter = /\bwrite-after-invalidate race\b/i.test(title)
    && /\bSessionMint\b/.test(title) && /\bAuthBroker\b/.test(title) && /\bshared adapter\b/i.test(title)
    && /^(?:Even after injection,\s*)?(?:both|the two) services (?:write into|mutate) the same cache\./i.test(adapterExplanation)
    && !/\b(?:(?:this|that|the) (?:issue|finding|race)|Issue\s+[1-9]\d*)\s+(?:is|was|has been)\s+(?:withdrawn|retracted|rejected|resolved|fixed)\b|\bno (?:current )?shared-cache race\b/i.test(adapterAssessment);
  const ids: Seed[] = [];
  if (/\b(?:scope|complexity|classes|types|abstractions)\b/i.test(title) &&
      /\b(?:files|classes|types|abstractions)\b/i.test(title) &&
      action(/\b(?:reduce|cut|simplify|remove|collapse|merge|pure function)\b/i)) ids.push('complexity');
  if ((sharedAdapter || /\b(?:AuthCache|cache)\b/i.test(title) &&
      /\b(?:global|module[ -]level|mutab\w*|both|shar\w*|ownership|writers|same\s+(?:AuthCache|cache))\b/i.test(title)) &&
      action(/\b(?:inject\w*|DI|serializ\w*|single[ -]writer|ownership|composition root)\b/i)) ids.push('shared-cache');
  if (/\b(?:validateAndDispatch|catch\w*)\b/i.test(title) &&
      /\b(?:swallow\w*|nested|silent\w*|hidden|suppres\w*)\b/i.test(title) &&
      action(/\b(?:split|rethrow|typed|flatten|propagat\w*)\b/i)) ids.push('swallowed-errors');
  if (/\b(?:sequential|parallel\w*|Promise\.all(?:Settled)?)\b/i.test(title) &&
      /\b(?:IDP|identity provider)\b/i.test(prose(q.question)) &&
      action(/\b(?:parallel\w*|Promise\.all(?:Settled)?)\b/i)) ids.push('sequential-idp');
  return ids;
}

function completedDecision(call: NativePlanQuestionCall, startedAt: number, finishedAt: number): boolean {
  const answeredAt = Date.parse(call.answeredAt ?? '');
  if (!call.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      !Number.isFinite(answeredAt) || answeredAt < startedAt || answeredAt > finishedAt ||
      call.questions.length < 1 || call.questions.length > 4 || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length !== 0) return false;
  return new Set(call.questions.map(q => q.question)).size === call.questions.length &&
    Object.keys(call.answers ?? {}).length === call.questions.length &&
    call.questions.every(q => q.question.trim() && !q.multiSelect && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every(o => o.label.trim()) && new Set(q.options.map(o => o.label)).size === q.options.length &&
    q.options.some(o => call.answers?.[q.question] === o.label));
}

/** A named required test can specify characterization without an "Add" prefix. */
function requiredLegacyCharacterization(task: string): boolean {
  const text = task.replace(/\s+/g, ' ');
  return /^legacyAuthFlow(?:\(\))?\s+(?:regression|characterization)\s+tests?\.\s+Before\s+(?:the\s+)?(?:rewrite|refactor|change),\s+(?:capture|pin|record)\s+(?:the\s+)?(?:current|existing|prior)\b[^.;!?]{0,240}\bbehavior\s+of\s+legacyAuthFlow(?:\(\))?\b[^.;!?]*\.\s+The\s+rewritten\s+(?:path|flow|implementation)\s+must\s+pass\s+the\s+same\s+assertions\./i.test(text)
    && !/["“”]|\b(?:not|never|skip\w*|defer\w*|maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(text)
    && !/\bno\s+(?:(?:regression|characterization)\s+)?(?:tests?|fixtures?)\s+(?:are\s+)?(?:needed|required)\b/i.test(text);
}

/** Required suites bind a numbered task to an untouched legacy baseline or parity oracle. */
function declaredLegacyCharacterization(text: string): boolean {
  const sections: Array<{ title: string; body: string[]; asserted: boolean }> = [];
  const owners: Array<{ level: number; asserted: boolean }> = [];
  let preamble = '', sourcePreamble = false;
  const sourceFrame = (body: string) => /\b(?:(?:hypothetical|historical) example|unproven hypothesis|(?:source|quoted) (?:material|text) only|(?:are|is) not requirements? of this plan)\b/i.test(body.replace(/\s+/g, ' '));
  for (const line of prose(text).split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      while (owners.length && owners.at(-1)!.level >= heading[1]!.length) owners.pop();
      if (/^Current reviewed plan$/i.test(heading[2]!) && owners.length === 0) sourcePreamble = false;
      const asserted = !sourcePreamble && owners.every(owner => owner.asserted)
        && !/\b(?:source|example|hypothetical|proposed|optional|quoted|historical|template|unproven)\b/i.test(heading[2]!);
      owners.push({ level: heading[1]!.length, asserted });
      sections.push({ title: heading[2]!, body: [], asserted });
    } else if (sections.length) {
      const section = sections.at(-1)!;
      section.body.push(line);
      if (sourceFrame(section.body.join(' '))) section.asserted = owners.at(-1)!.asserted = false;
    } else {
      preamble += ' ' + line;
      sourcePreamble = sourceFrame(preamble);
    }
  }
  const current = sections.filter(section => section.asserted);
  const mandatory = current.filter(section => /^CRITICAL regression \(mandatory, regression rule\)$/i.test(section.title));
  const declaration = /^legacyAuthFlow(?:\(\))? is (?:existing|current) behavior being (?:modified|refactored)\b[^!?]{0,240}\.\s+(?:A|The) characterization test suite for legacyAuthFlow(?:\(\))? is (?:added|required) as a (?:critical|mandatory) requirement:\s*(?:capture|pin|record) (?:current|existing|prior)\b[^.!?]{1,400}\.\s+This suite runs against the flag-OFF path and is the oracle the new path is compared to during rollout\./i;
  const withdrawn = (body: string, task?: string) => new RegExp(
    `\\b(?:${task ? `${task}|` : ''}(?:this|the|that)\\s+(?:(?:characterization|regression|contract)\\s+)?(?:suite|task|test|requirement)|(?:characterization|regression)\\s+(?:suite|tests?))\\s+(?:(?:is|was|has been)\\s+)?(?:(?:not|no longer)\\s+(?:required|needed)|cancelled|canceled|withdrawn|rejected|deferred|optional)\\b`, 'i').test(body)
    || /\b(?:do not|never|skip|defer|cancel|withdraw)\s+(?:run(?:ning)?\s+)?(?:the|this)\s+(?:characterization\s+)?suite\b/i.test(body);
  const declared = mandatory.some(section => {
    const body = section.body.join(' ').replace(/\s+/g, ' ').trim();
    const claim = declaration.exec(body)?.[0];
    return claim && !/["“”]|\b(?:maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(claim)
      && !withdrawn(body);
  });
  if (declared) for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
    const tasks = section.body.join('\n').split(/\n(?=-\s)/);
    for (const task of tasks) {
      const match = /^\s*-\s+(?:\[[ xX]\]\s*)?(T[1-9]\d*)(?:\s+\([^\n)]*\))?\s+[—–:-]\s+(?:[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+(?:\s+tests)?\s+[—–]\s+)?CRITICAL regression:\s+characterization suite for legacyAuthFlow(?:\(\))? prior behavior[\t ]*(?:\n|$)/i.exec(task);
      if (!match || withdrawn(task, match[1])) continue;
      const baseline = new RegExp(`^[1-9]\\d*\\. Run the characterization suite \\(${match[1]}\\) against the untouched legacyAuthFlow(?:\\(\\))? first and commit it green\\. This is the baseline\\.`, 'i');
      if (current.some(s => s.title === 'Verification' && baseline.test(s.body.join(' ').replace(/\s+/g, ' ').trim())
        && !withdrawn(s.body.join(' '), match[1]))) return true;
    }
  }
  for (const section of current.filter(s => /^CRITICAL: regression contract test for legacyAuthFlow\(\) \(iron rule, no decision needed\)$/.test(s.title))) {
    const body = section.body.join(' ').replace(/\s+/g, ' ').trim();
    const parity = /^The rewrite modifies existing behavior with no covering test \([^)]{1,120}\)\. Add ([A-Za-z][\w/-]*\.contract\.test\.[jt]s): a fixture table of \(tenant, token, policy\) cases covering [^.!?]{1,300}\. Run each fixture through legacyAuthFlow\(\) and ([A-Za-z][\w]*)\.authenticate\(\) and assert identical ([A-Za-z][\w]*) shape on success and identical error code on failure\. This test is also the gate for flipping any tenant's flag and for TODO [1-9]\d* removal\./.exec(body);
    if (!parity || withdrawn(body) || /["“”]|\b(?:maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(parity[0])) continue;
    const unchanged = current.some(s => {
      if (!s.title.endsWith(`: Per-tenant flag routes legacy vs ${parity[2]}`)
        || !/^Issue [1-9]\d* \(D[1-9]\d*, chose [1-9]\d*[A-D]\): /.test(s.title)) return false;
      const body = s.body.join('\n');
      const release = /(?:^|\n)- A tenant-keyed flag [A-Za-z][\w.]*\[tenantId\] \(default off\) selects the path at the\s+login entry point\. legacyAuthFlow\(\) stays callable and unchanged this release\./.exec(body);
      const prefix = release ? body.slice(0, release.index).trim().split(/\n\s*\n/).at(-1) ?? '' : '';
      return Boolean(release) && !/^(?:if|unless|maybe|perhaps|proposed|optional)\b/i.test(prefix)
        && !/\blegacyAuthFlow(?:\(\))?\s+(?:(?:is|was|will be|has been)\s+)?(?:changed|modified|rewritten|removed|withdrawn|not unchanged|no longer unchanged)\b/i.test(s.body.join(' '));
    });
    if (!unchanged) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      for (const task of tasks.body.join('\n').split(/\n(?=-\s)/)) {
        const match = /^\s*-\s+(?:\[[ xX]\]\s*)?(T[1-9]\d*)(?:\s+\([^\n)]*\))?\s+[—–:-]\s+Tests\s+[—–]\s+CRITICAL regression contract test: same fixtures through legacyAuthFlow\(\) and ([A-Za-z][\w]*), identical ([A-Za-z][\w]*) \/ error codes[\t ]*(?:\n|$)/.exec(task);
        if (!match || match[2] !== parity[2] || match[3] !== parity[3] || withdrawn(task, match[1])) continue;
        const files = /^\s+- Files: ([^\n]+)$/m.exec(task);
        if (files?.[1] === parity[1] && /^\s+- Verify: contract suite green on both paths[\t ]*$/m.test(task)) return true;
      }
    }
  }
  // A mandatory snapshot can state the legacy oracle as a required test
  // list item, then bind it to the numbered task's unchanged-code verification.
  const snapshotSource = prose(text, true).replace(/\s+/g, ' ');
  const unquoted = (body: string) => body.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const suiteWithdrawn = current.some(s => {
    // A named foreign suite owns its generic withdrawal; it cannot cancel
    // the legacy obligation in another section of the same report.
    const namedSuite = /^(.*?)\b(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(s.title);
    const foreignSuite = Boolean(namedSuite?.[1]?.trim() && !/^(?:legacy(?:AuthFlow(?:\(\))?)?|final|current|updated)[\s:—–-]*$/i.test(namedSuite[1]));
    return unquoted(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => {
      const subject = /^(?:Correction:\s*)?(?:the|this|that)\s+(legacy\s+)?(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(statement.trim());
      return Boolean(subject && (!foreignSuite || subject[1]) && withdrawn(statement));
    });
  });
  for (const section of current.filter(s => /^Required tests(?: \([^\n]*\))?$/i.test(s.title))) {
    const body = section.body.join('\n').trim();
    if (!body.startsWith('- ')) continue;
    for (const block of body.split(/\n(?=-\s)/)) {
      const claim = block.replace(/\s+/g, ' ').trim();
      if (suiteWithdrawn || !/^- CRITICAL regression legacyAuthFlow(?:\(\))? snapshot: capture current outputs for [^;.!?]{1,240} BEFORE any change; assert both legacy \(flag OFF\) and new \(flag ON\) paths produce identical observable results\. Mandatory under the coverage-audit regression rule\./.test(claim)
          || !snapshotSource.includes(claim) || withdrawn(unquoted(claim))
          || /["“”]|\b(?:not|never|maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(claim)) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        const body = tasks.body.join('\n').trim();
        const taskPrefix = body.split(/\n(?=-\s)/)[0]?.trim() ?? '';
        if (!body.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix)
            || /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(taskPrefix))) continue;
        for (const task of body.split(/\n(?=-\s)/)) {
          const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+ [—–] Snapshot legacyAuthFlow\(\) behavior as regression tests before any change[\t ]*(?:\n|$)/.exec(task);
          if (!match || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim())
              || !/^\s+- Verify: tests pass against unmodified legacy code, then against flag-OFF route[\t ]*$/m.test(task)
              || withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
          const taskWithdrawal = new RegExp(`\\b${match[1]}\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
          if (!current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) return true;
        }
      }
    }
  }
  return false;
}

function regressionEvidence(text: string): boolean {
  if (declaredLegacyCharacterization(text)) return true;
  return prose(text).split(/\n\s*\n|\n(?=\s*[-#])/).some(block => {
    let task = block.trim().replace(/^[-+]\s+(?:\[[ xX]\]\s*)?/, '');
    const numbered = /^T\d+(?:\s*\([^\n)]*\))?\s*[—–:-]\s*/.exec(task);
    if (numbered) {
      // A numbered task may place a simple component path before its action.
      // Do not remove arbitrary prose or let this metadata assign the test target.
      task = task.slice(numbered[0].length)
        .replace(/^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)+[\t ]+[—–][\t ]+/, '');
    }
    if (requiredLegacyCharacterization(task)) return true;
    const legacySubject = /^legacyAuthFlow(?:\(\))?\s*[—–:-]\s*/i;
    const action = task.replace(legacySubject, '');
    const instruction = action.match(/^(?:(?:I|we)\s+)?(?:add(?:ed)?|record(?:ed)?|write|wrote|require(?:d)?|include(?:d)?)\s+((?:(?:a|the|new|required|legacyAuthFlow(?:\(\))?|regression|characterization|baseline|prior-behavior)\s+)*(?:tests?|fixtures?|suites?))\b([^.;\n]*)/i);
    const explicitTarget = instruction && /^\s+(?:for|of|covering|characterizing|pinning)\b/i.test(instruction[2]!);
    const legacyTarget = instruction && (
      /^\s+(?:for|of|covering|characterizing)\s+(?:the\s+)?(?:prior behavior of\s+)?legacyAuthFlow\b/i.test(instruction[2]!) ||
      /^\s+pinning\s+(?:the\s+)?legacyAuthFlow(?:\(\))?(?:'s)?\s+(?:current|existing|prior)\s+behavior\b/i.test(instruction[2]!));
    const target = instruction && (!explicitTarget || legacyTarget) &&
      (legacySubject.test(task) || /\blegacyAuthFlow\b/.test(instruction[1]!) || legacyTarget);
    // An affirmative task or completed addition, not an example, quotation,
    // conditional proposal or an uncertain discussion of whether to add it.
    return Boolean(target) &&
    /\b(?:regression|characterization)\b/i.test(instruction![0]) &&
    /\b(?:before|prior behavior|parity|compatibility|characterization)\b/i.test(instruction![0]) &&
    !/\b(?:no|not|never|skip\w*|defer\w*|maybe|might|could|if|unless|optional)\b/i.test(block);
  });
}

export function evaluateEngSeedCoverage(transcript: PlanCountTranscript, plan: string,
  startedAt: number, finishedAt: number) {
  const decisions: Partial<Record<Seed, string>> = {};
  const problems: string[] = [];
  const sessions = new Set(transcript.calls.map(c => c.sessionId));
  const identities = transcript.calls.map(c => `${c.sessionId}:${c.toolUseId}`);
  const bound = transcript.status === 'ready' && sessions.size === 1 && !sessions.has('') &&
    identities.length === new Set(identities).size && Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) && startedAt <= finishedAt;
  if (!bound) problems.push('missing, ambiguous or unbound native transcript');
  if (bound) for (const call of transcript.calls) {
    if (!completedDecision(call, startedAt, finishedAt)) continue;
    const seeds = call.questions.flatMap(seedSubjects);
    // One combined approval cannot replace separate decisions for independent seeds.
    // An unrelated, separately answered setup tab may accompany the one seed;
    // multiple seeded questions still cannot lend this call ID to several seeds.
    if (seeds.length === 1) decisions[seeds[0]!] ??= `${call.sessionId}:${call.toolUseId}`;
  }
  const missing = ENG_DECISION_SEEDS.filter(seed => !decisions[seed]);
  const regression = regressionEvidence(plan) ? 'plan' : bound && transcript.assistantMessages.some(m =>
    sessions.has(m.sessionId) && Date.parse(m.timestamp) >= startedAt && Date.parse(m.timestamp) <= finishedAt &&
    regressionEvidence(m.text)) ? 'public-narration' : undefined;
  if (!regression) problems.push('mandatory legacy regression coverage absent');
  // The caller also retains the existing fresh owned-path/native completion and D19 checks.
  if (!/^## GSTACK REVIEW REPORT[\t ]*\n\s*\S/m.test(prose(plan))) problems.push('final review report absent or empty');
  return { ok: bound && missing.length === 0 && problems.length === 0, decisions, missing, regression, problems };
}
