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
  // A concise decision title can name the design choice while its own
  // current explanation states the defect. Keep these three forms bound to
  // that explanation and the same native option's concrete repair.
  const decisionTitle = title.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '');
  const tenantWriters = /^Architecture issue [1-9]\d*: two services write the same tenant-keyed cache with no serialized mutations\. Who owns writes\?$/i.test(decisionTitle);
  const explainedSeed: Seed | undefined = /^Reduce the new-class count before we review the rest\?$/.test(decisionTitle) ? 'complexity'
    : /^Who is allowed to write to the auth cache\?$/.test(decisionTitle) || tenantWriters ? 'shared-cache'
    : /^How should validateAndDispatch\(\) handle errors\?$/.test(decisionTitle) ? 'swallowed-errors' : undefined;
  if (explainedSeed) {
    const ordinal = /^D([1-9]\d*)\s*[—–:-]/.exec(title)?.[1];
    const status = '(?:withdrawn|rejected|cancelled|canceled|superseded|resolved|fixed|optional|hypothetical|unproven|not current|no longer current)';
    const owner = `(?:(?:this|the|that) (?:finding|issue|gap|defect|assessment|explanation)${ordinal ? `|D${ordinal}` : ''})`;
    const current = (value: string, option = false) => {
      const subject = option ? `(?:${owner}|(?:this|the|that) (?:option|action|remedy|correction))` : owner;
      const scalar = new RegExp(`((?:^|[.!?;]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?${subject} (?:is|was|has been) )["“'‘\x60](${status})["”'’\x60]`, 'gim');
      return prose(value.replace(scalar, '$1$2'), true).replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '');
    };
    const framed = /(?:^|[.!?;:]\s+|\n)(?:(?:Project\/branch\/task|ELI10):\s*)?(?:Source(?: excerpt| material)?|Quoted(?: source)?|Historical(?: assessment| example)?|If approved|Once approved|When approved|Pending approval|Assuming approval|Provided approval)[,:.]?\s/i;
    const active = (value: string, option = false) => {
      const text = current(value, option), subject = option ? `(?:${owner}|(?:this|the|that) (?:option|action|remedy|correction))` : owner;
      return !framed.test(text) && !new RegExp(`(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${subject} (?:is|was|has been) ${status}\\b`, 'i').test(text) &&
        !(option && /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:drop|reduce|inject|flatten|rethrow|make|apply)\b/i.test(text));
    };
    const text = current(q.question), explanations = [...text.matchAll(/^ELI10: (.+)$/gm)];
    const prefix = text.slice(text.indexOf('\n') + 1, explanations[0]?.index ?? 0).trim().split('\n').filter(Boolean);
    if (explanations.length !== 1 || (prefix.length !== 1 && !(tenantWriters && prefix.length === 2 && /^\[P[0-3]\]/.test(prefix[1]!))) ||
        !/^Project\/branch\/task: \S/.test(prefix[0]!) || !active(q.question)) return [];
    const explanation = explanations[0]![1]!;
    const options = q.options.filter(o => active(`${o.label}\n${o.description ?? ''}`, true))
      .map(o => ({ label: current(o.label).replace(/^[1-9]\d*[A-D]\s+/, ''), description: current(o.description ?? '') }));
    if (tenantWriters) return /\bAuthBroker\b/.test(prefix[0]!) && /\bSessionMint\b/.test(prefix[0]!) &&
      /^Two services writing the same cache entry at the same time is a race\./.test(explanation) &&
      !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:the|this) (?:cache|writes|writers) (?:is|are|have been) (?:now ordered|now serialized|no longer shared)\b/i.test(text) &&
      options.some(option => {
        const actors = /\b(AuthBroker|SessionMint) is the only service that writes validated entries;\s*(AuthBroker|SessionMint) reads\b/.exec(option.description);
        return /^[1-9]\d*[A-D][):.]\s*Single writer \+ generation check\b/.test(option.label) && actors && actors[1] !== actors[2] &&
          /\bEach write carries the tenant generation read at validation start; the adapter rejects a write whose generation is stale\b/.test(option.description);
      }) ? ['shared-cache'] : [];
    if (explainedSeed === 'complexity') {
      const wrapper = /^The plan invents a new cache wrapper \(([A-Za-z][\w]*)\) and a new token store on top of a cache adapter that already does tenant keying, expiry, and invalidation\./.exec(explanation);
      return wrapper && options.some(o => /^Reduce\b/.test(o.label) &&
        new RegExp(`\\bdrop ${wrapper[1]}\\/TokenStore classes\\.`).test(o.description)) ? [explainedSeed] : [];
    }
    if (explainedSeed === 'shared-cache') return /\bAuthBroker and SessionMint both mutating one backing cache\b/.test(prefix[0]!) &&
      /^Two services write to the same cache and nothing orders their writes\./.test(explanation) &&
      !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:the|this) (?:cache|writes|writers) (?:is|are|have been) (?:now ordered|now serialized|no longer shared)\b/i.test(text) &&
      options.some(o => /^Single writer\b/.test(o.label) && /^SessionMint writes\b/.test(o.description) && /\bAuthBroker reads\b/.test(o.description)) ? [explainedSeed] : [];
    return /\bvalidateAndDispatch\(\) is [1-9]\d* lines, (?:three|[1-9]\d*) nested try\/catch blocks, each catch swallows a different error class\b/.test(prefix[0]!) &&
      /^Right now when something goes wrong inside validation, the code catches the problem and keeps going as if nothing happened\./.test(explanation) &&
      options.some(o => /^Flatten \+ typed errors\b/.test(o.label) && /\bLinear pipeline, typed error classes, one fail-closed boundary\b/.test(o.description) ||
        /^Rethrow, one outer catch$/.test(o.label) && /\brethrow typed errors; outer catch denies\b/.test(o.description)) ? [explainedSeed] : [];
  }
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
  // The inventory alias needs its own current action; an inline quoted title
  // or actions reproduced only as source material cannot establish this seed.
  const inventoryProse = prose(q.question, true)
    .replace(/(\b(?:this|the) class[ -]inventory decision is )['"“](withdrawn|rejected|cancelled|canceled|resolved)['"”]/gi, '$1$2')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const inventoryAction = q.options.some(o => {
    const label = prose(o.label, true), description = prose(o.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”/g, '');
    return /^(?:[A-D][).:—–-]\s*)?(?:reduce|cut|simplify|remove|collapse|merge)\b[^.!?\n]{0,160}\b(?:classes|types|abstractions)\b/i.test(label)
      && !/^(?:source|quoted|historical|example|if approved|hypothetical)\b|\b(?:this|the) (?:option|action|remedy) is (?:withdrawn|rejected|cancelled|canceled)\b/i.test(description);
  });
  const classInventory = /^(?:D[1-9]\d*\s*[—–:-]\s*)?(?:Reduce|Simplify|Trim) the class inventory(?: before building)?\?$/i.test(prose(subject, true))
    && inventoryAction && !/\b(?:this|the) class[ -]inventory decision (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|resolved|not current)\b/i.test(inventoryProse);
  if (classInventory || /\b(?:scope|complexity|classes|types|abstractions)\b/i.test(title) &&
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
  const sourceFrame = (body: string) => {
    const text = body.replace(/"[^"\n]*"|“[^”\n]*”/g, '').replace(/\s+/g, ' ');
    return /\b(?:(?:hypothetical|historical) example|unproven hypothesis|(?:source|quoted) (?:material|text) only|(?:are|is) not requirements? of this plan)\b/i.test(text)
      || /^\s*(?:(?:quoted )?source(?: (?:excerpt|text|material))?|(?:historical|earlier|previous) (?:review )?assessment):(?:\s|$)/i.test(text);
  };
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
  // A mandatory declaration can require capture before touching the legacy
  // function, with a task and ordered verification on both router settings.
  const sourceOwner = (body: string) => sourceFrame(body) ||
    /\b(?:is|was|presents?|represents?)\s+(?:(?:only|just)\s+)?(?:an?\s+)?(?:quoted|hypothetical|historical|example|template)\b/i.test(body);
  const conditionalOwner = (prefix: string) => /^(?:if|unless|maybe|perhaps|proposed|optional)\b/i.test(prefix.trim().split('\n').at(-1)?.trim() ?? '');
  for (const section of current.filter(s => /^REGRESSION \(mandatory rule, no approval needed\) [—–-] CRITICAL$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const declaration = /(?:^|[.!?]\s+)Add a characterization (?:test )?suite for legacyAuthFlow\(\) before (?:touching|changing|refactoring) it:\s*(?:capture|pin|record) current inputs and outputs \([^()!?]{1,300}\) and run the same suite against ([A-Za-z][\w]*) on both flag settings\. A behavior difference between paths is a test failure\b/i.exec(body);
    if (!declaration || suiteWithdrawn || withdrawn(body) ||
        !snapshotSource.includes(declaration[0].trim()) || sourceOwner(body.slice(0, declaration.index)) ||
        /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(body.slice(0, declaration.index))) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim();
      const taskPrefix = taskBody.split(/\n(?=-\s)/)[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(taskPrefix))) continue;
      for (const task of taskBody.split(/\n(?=-\s)/)) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+ [—–-] CRITICAL characterization suite for legacyAuthFlow\(\), run on both router paths[\t ]*(?:\n|$)/i.exec(task);
        const verify = /^\s+- Verify: suite passes on legacy before any refactor; passes on new path before flag enable[\t ]*$/m.exec(task);
        const taskIntro = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            conditionalOwner(taskIntro) || sourceOwner(taskIntro) || conditionalOwner(task.slice(0, verify.index)) || sourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const taskWithdrawal = new RegExp(`\\b${match[1]}\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        if (current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) continue;
        for (const verification of current.filter(s => /^Verification(?: \([^\n]*\))?$/i.test(s.title))) {
          const body = unquoted(verification.body.join('\n')).trim();
          const baseline = /^([1-9]\d*)\. Run the characterization suite against legacyAuthFlow\(\) on the unmodified code; it must pass before any refactor lands\.[\t ]*$/m.exec(body);
          const compare = new RegExp(`^([1-9]\\d*)\\. Run the characterization suite through ${declaration[1]} with the flag on new; zero differences\\.[\\t ]*$`, 'm').exec(body);
          if (baseline && compare && Number(baseline[1]) < Number(compare[1]) && baseline.index < compare.index &&
              !conditionalOwner(body.slice(0, baseline.index)) && !conditionalOwner(body.slice(0, compare.index)) &&
              !sourceOwner(body.slice(0, baseline.index)) && !sourceOwner(body.slice(0, compare.index)) &&
              !withdrawn(body.replace(/\b(?:this|that|the)\s+(?:baseline|verification)\b/gi, 'this requirement'), match[1]) &&
              snapshotSource.includes(baseline[0]) && snapshotSource.includes(compare[0])) return true;
        }
      }
    }
  }
  // A golden-master requirement names the existing output oracle, then ties
  // its capture task to an untouched baseline and reruns after later tasks.
  const goldenSourceOwner = (body: string) => sourceOwner(body) || /(?:^|\n)\s*(?:Source|Quoted source) excerpt:\s*(?:\n|$)/i.test(body);
  // A staged refactor can bind its baseline and parity checks to two tasks,
  // with the release labels separate from their task identities.
  const staged = current.filter(s => /^REGRESSION \(CRITICAL, mandatory\)$/i.test(s.title));
  const taskSections = current.filter(s => s.title === 'Implementation Tasks');
  if (!suiteWithdrawn && staged.length === 1 && taskSections.length === 1) {
    const stagedSource = (value: string) => goldenSourceOwner(unquoted(value)) ||
      /(?:^|\n)\s*(?:Source|Quoted source|Earlier review assessment):/i.test(unquoted(value));
    const stagedConditional = (value: string) => conditionalOwner(value) ||
      /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(value));
    const body = unquoted(staged[0]!.body.join(' ')).replace(/\s+/g, ' ').trim();
    const declaration = /^(?:[A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)? [—–-]\s*)?This is existing behavior being modified with no covering test\. (PR[1-9]\d*) adds characterization tests that pin every observable outcome of legacyAuthFlow\(\) \(([^()!?]{1,600})\) before any rewrite\. They run against the legacy path in \1, against both paths in (PR[1-9]\d*), and are folded into pipeline tests in (PR[1-9]\d*)\. Pre-authorized by the regression rule\.$/.exec(body);
    const tasksText = taskSections[0]!.body.join('\n').trim();
    const taskBlocks = tasksText.split(/\n(?=-\s)/);
    const ids = taskBlocks.map(t => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(t)?.[1]).filter(Boolean);
    const taskPrefix = taskBlocks[0]!.startsWith('- ') ? '' : taskBlocks[0]!;
    if (declaration && Number(declaration[1]!.slice(2)) < Number(declaration[3]!.slice(2)) &&
        Number(declaration[3]!.slice(2)) < Number(declaration[4]!.slice(2)) &&
        !withdrawn(body) && !stagedSource(taskPrefix) && !stagedConditional(taskPrefix) &&
        ids.length === new Set(ids).size) {
      const baselinePattern = new RegExp(`^- (?:\\[[ xX]\\] )?(T[1-9]\\d*)(?: \\([^\\n)]*\\))? [—–-] ${declaration[1]} legacy auth [—–-] Write characterization \\(regression\\) tests pinning legacyAuthFlow\\(\\) prior behavior before any rewrite[\\t ]*(?:\\n|$)`);
      for (const baseline of taskBlocks) {
        const task = baselinePattern.exec(baseline);
        const verify = /^\s+- Verify: suite green against unmodified legacy path; ([1-9]\d*) cases recorded as oracle[\t ]*$/m.exec(baseline);
        if (!task || !verify || Number(verify[1]) !== declaration[2]!.split(',').length ||
            stagedSource(baseline) || stagedConditional(baseline.slice(0, verify.index))) continue;
        const parityPattern = new RegExp(`^- (?:\\[[ xX]\\] )?(T[1-9]\\d*)(?: \\([^\\n)]*\\))? [—–-] ${declaration[3]} strangler fig [—–-] Make legacyAuthFlow delegate to the new pipeline behind a feature flag; ${task[1]} characterization tests pass against both paths[\\t ]*(?:\\n|$)`);
        for (const parity of taskBlocks) {
          const rerun = parityPattern.exec(parity);
          const parityVerify = new RegExp(`^[\\t ]+- Verify: ${task[1]} suite green with flag on and off[\\t ]*$`, 'm').exec(parity);
          if (!rerun || task[1] === rerun[1] || !parityVerify || taskBlocks.indexOf(baseline) >= taskBlocks.indexOf(parity) ||
              stagedSource(parity) || stagedConditional(parity.slice(0, parityVerify.index))) continue;
          // Quoted old prose is evidence about history. A quoted status word
          // with a current task/suite subject still cancels its obligation.
          const status = (value: string) => unquoted(value.replace(new RegExp(`((?:${task[1]}|${rerun[1]})(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) |(?:this|the) (?:legacy )?(?:(?:characterization|regression|baseline|unchanged-code) )?(?:suite|requirement|verification) (?:is|was|has been) )["“'](withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”']`, 'gi'), '$1$2'));
          const canceled = new RegExp(`\\b(?:${task[1]}|${rerun[1]})(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\\b`, 'i');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${task[1]}\\b`, 'i');
          const noRerun = new RegExp(`\\b${rerun[1]} (?:no longer|does not|will not) (?:re)?runs? ${task[1]}\\b`, 'i');
          const inactive = (value: string) => withdrawn(status(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), task[1]) || canceled.test(status(value)) ||
            /\b(?:this|the) (?:legacy )?(?:(?:characterization|regression|baseline|unchanged-code) )?(?:suite|requirement|verification) (?:is|was|has been) (?:superseded|not current)\b/i.test(status(value));
          if (inactive(body) || inactive(baseline) || inactive(parity) || current.some(s => {
            const assessment = status(s.body.join('\n'));
            return /\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\b/i.test(assessment) ||
              canceled.test(assessment) || noRerun.test(assessment) ||
              assessment.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
          })) continue;
          return true;
        }
      }
    }
  }
  const goldenWithdrawn = current.some(s => {
    const namedSuite = /^(.*?)\b(?:regression|characterization|golden[ -]master)\s+(?:suite|fixtures?|tests?)\b/i.exec(s.title);
    const foreignSuite = Boolean(namedSuite?.[1]?.trim() && !/^(?:legacy(?:AuthFlow(?:\(\))?)?|final|current|updated)[\s:—–-]*$/i.test(namedSuite[1]));
    return unquoted(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => {
      const subject = /^(?:Correction:\s*)?(?:the|this|that)\s+(legacy(?:AuthFlow(?:\(\))?)?\s+)?golden[ -]master\s+(?:suite|fixtures?|tests?)\b/i.exec(statement.trim());
      return Boolean(subject && (!foreignSuite || subject[1]) && withdrawn(statement
        .replace(/golden[ -]master\s+(?:suite|fixtures?|tests?)/i, 'regression suite').replace(/\b(?:are|were|have been)\b/i, 'is')));
    });
  });
  for (const section of current.filter(s => /^Tests(?: \([^\n]*\))?$/i.test(s.title))) {
    const body = unquoted(section.body.join('\n')).split(/\n\s*\n/)
      .map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).join('\n\n');
    const claim = /^CRITICAL \(regression rule, mandatory\): legacyAuthFlow(?:\(\))? golden[ -]master\.\s+(?:Capture|Pin|Record) current outputs for [^.!?]{1,300} BEFORE any change, assert identical behavio[u]?r after the rewrite(?: and after [^.!?]{1,120})?\./im.exec(body);
    if (!claim || suiteWithdrawn || goldenWithdrawn || withdrawn(body) ||
        !snapshotSource.includes(claim[0].replace(/\s+/g, ' ')) ||
        goldenSourceOwner(body.slice(0, claim.index)) || conditionalOwner(body.slice(0, claim.index))) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim();
      const taskPrefix = taskBody.split(/\n(?=-\s)/)[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(unquoted(taskPrefix)))) continue;
      for (const task of taskBody.split(/\n(?=-\s)/)) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)* [—–-] Capture golden[ -]master regression fixtures for legacyAuthFlow(?:\(\))? before any change[\t ]*(?:\n|$)/i.exec(task);
        const verify = /^\s+- Verify: fixtures pass against untouched legacy; rerun after every later task[\t ]*$/m.exec(task);
        const taskIntro = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            /\b(?:if|unless|optional|hypothetical|source|quoted|unproven)\b/i.test(match[0]) ||
            conditionalOwner(taskIntro) || goldenSourceOwner(taskIntro) ||
            conditionalOwner(task.slice(0, verify.index)) || goldenSourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const taskWithdrawal = new RegExp(`\\b${match[1]}(?:\\s+rerun)?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        if (current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) continue;
        for (const verification of current.filter(s => /^Verification(?: \([^\n]*\))?$/i.test(s.title))) {
          const body = unquoted(verification.body.join('\n')).trim();
          const baseline = new RegExp(`^([1-9]\\d*)\\. Run ${match[1]} fixtures before touching anything; they must pass\\.[\\t ]*$`, 'm').exec(body);
          const rerun = new RegExp(`^([1-9]\\d*)\\. After each task, rerun the full suite plus ${match[1]} fixtures\\.[\\t ]*$`, 'm').exec(body);
          if (baseline && rerun && Number(baseline[1]) < Number(rerun[1]) && baseline.index < rerun.index &&
              !conditionalOwner(body.slice(0, baseline.index)) && !conditionalOwner(body.slice(0, rerun.index)) &&
              !goldenSourceOwner(body.slice(0, baseline.index)) && !goldenSourceOwner(body.slice(0, rerun.index)) &&
              !withdrawn(body.replace(/\b(?:this|that|the)\s+(?:baseline|verification)\b/gi, 'this requirement'), match[1]) &&
              snapshotSource.includes(baseline[0]) && snapshotSource.includes(rerun[0])) return true;
        }
      }
    }
  }
  // A current-output characterization declaration can bind the same file
  // and pre-rewrite task directly, without a separate Verification heading.
  for (const section of current.filter(s => /^REGRESSION \(mandatory, authorized by the coverage-audit regression rule [—–-] no question asked\)$/i.test(s.title))) {
    const body = unquoted(section.body.join('\n')).trim();
    const split = body.indexOf('\n- ');
    if (split < 0 || suiteWithdrawn) continue;
    const intro = body.slice(0, split).replace(/\s+/g, ' ').trim();
    if (!/^legacyAuthFlow\(\) is existing behavior being rewritten\b[^!?]{1,400}\. CRITICAL requirement added to the plan:$/.test(intro) ||
        goldenSourceOwner(intro) || /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(intro)) continue;
    const claim = body.slice(split).replace(/\s+/g, ' ').trim();
    const declaration = /^- ([A-Za-z][\w/.-]*\.test\.[jt]s) [—–-] record current outputs for: [^.!?]{1,600}\. Assert the new path \(behind the flag\) produces identical decisions and equivalent error surfaces\. These tests are written BEFORE any rewrite \((T[1-9]\d*)\) and stay green through cut-over\.$/.exec(claim);
    if (!declaration || withdrawn(body) || !snapshotSource.includes(claim) ||
        /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(claim)) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(unquoted(prefix)))) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write characterization tests for legacyAuthFlow\(\) before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
        const verify = /^\s+- Verify: suite green on current main; re-run after each later task[\t ]*$/m.exec(task);
        const beforeTask = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || match[1] !== declaration[2] || file?.[1] !== declaration[1] || !verify ||
            !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            conditionalOwner(beforeTask) || goldenSourceOwner(beforeTask) ||
            conditionalOwner(task.slice(0, verify.index)) || goldenSourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const cancelledTask = new RegExp(`\\b${match[1]}(?:\\s+(?:rerun|verification|baseline verification))?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        const changedBeforeBaseline = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${match[1]}\\b`, 'i');
        const assessment = (body: string) => unquoted(body.replace(new RegExp(`(\\b${match[1]}(?:\\s+(?:rerun|verification|baseline verification))?\\s+(?:is|was|has been)\\s+)["“](withdrawn|rejected|cancelled|canceled)["”]`, 'gi'), '$1$2'));
        if (!current.some(s => cancelledTask.test(assessment(s.body.join('\n'))) ||
            assessment(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => changedBeforeBaseline.test(statement.trim())))) return true;
      }
    }
  }
  // The same mandatory characterization can precede a behavior-preserving
  // extraction: its untouched baseline and the extraction's rerun share a task ID.
  const extractionSourceOwner = (body: string) => goldenSourceOwner(body) ||
    /(?:^|\n)\s*(?:(?:quoted )?source(?: (?:excerpt|text|material))?|(?:historical|earlier|previous)(?: review)?(?: assessment)?|(?:hypothetical )?example):\s*(?:\n|$)/i.test(unquoted(body));
  for (const section of current.filter(s => s.title === 'Tests')) {
    const body = unquoted(section.body.join('\n'));
    const claim = /^CRITICAL [—–-] regression rule \(mandatory, not a decision\): (T[1-9]\d*) adds a characterization test for legacyAuthFlow\(\)'s current behavior \([^\n)]{1,300}\) and lands before the ([1-9]\d*[A-D]) extraction\./m.exec(body);
    if (!claim || suiteWithdrawn || withdrawn(body, claim[1]) || !snapshotSource.includes(claim[0]) ||
        extractionSourceOwner(body.slice(0, claim.index)) || conditionalOwner(body.slice(0, claim.index))) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(unquoted(prefix)) || conditionalOwner(prefix))) continue;
      const active = (task: string, id: string, verifyAt: number) => {
        const beforeTask = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        return snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) &&
          !conditionalOwner(beforeTask) && !extractionSourceOwner(beforeTask) &&
          !conditionalOwner(task.slice(0, verifyAt)) && !extractionSourceOwner(unquoted(task.slice(0, verifyAt))) &&
          !withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), id);
      };
      for (const baseline of blocks) {
        const task = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Add characterization\/regression test for legacyAuthFlow\(\) current behavior[\t ]*(?:\n|$)/.exec(baseline);
        const file = /^\s+- Files: ([A-Za-z][\w/.-]*\.test\.[jt]s)$/m.exec(baseline);
        const verify = /^\s+- Verify: test passes against unmodified legacy before any other commit[\t ]*$/m.exec(baseline);
        if (!task || task[1] !== claim[1] || !file || !verify || !active(baseline, task[1], verify.index)) continue;
        for (const extraction of blocks) {
          const task2 = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Extract IDP checks \+ token validation into shared ([A-Za-z][\w]*)\(\); legacy calls it, behavior unchanged[\t ]*(?:\n|$)/.exec(extraction);
          const origin = /^\s+- Surfaced by: Code quality Issue [1-9]\d* \(D[1-9]\d*, ([1-9]\d*[A-D])\)[\t ]*$/m.exec(extraction);
          const rerun = /^\s+- Verify: (T[1-9]\d*) still green; diff to legacy is call-site only[\t ]*$/m.exec(extraction);
          if (!task2 || task2[1] === task[1] || origin?.[1] !== claim[2] || rerun?.[1] !== task[1] || !active(extraction, task2[1], rerun.index)) continue;
          const canceled = new RegExp(`\\b(?:${task[1]}|${task2[1]})(?:\\s+(?:rerun|verification|baseline verification|regression test|characterization test))?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${task[1]}\\b`, 'i');
          const assessment = (value: string) => unquoted(value.replace(new RegExp(`(\\b(?:${task[1]}|${task2[1]})(?:\\s+(?:rerun|verification|baseline verification|regression test|characterization test))?\\s+(?:is|was|has been)\\s+)["“](withdrawn|rejected|cancelled|canceled)["”]`, 'gi'), '$1$2'));
          const rerunWithdrawn = new RegExp(`\\b${task2[1]} (?:no longer|does not|will not) reruns? ${task[1]}\\b`, 'i');
          if (!current.some(s => canceled.test(assessment(s.body.join('\n'))) || rerunWithdrawn.test(assessment(s.body.join('\n'))) ||
              assessment(s.body.join('\n')).split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim())))) return true;
        }
      }
    }
  }

  // A golden requirement can name its parity oracle in a test-list item,
  // with the same task capturing current outputs on untouched legacy code.
  for (const section of current.filter(s => s.title === 'Test requirements')) {
    const requirements = section.body.join('\n').trim();
    for (const block of requirements.split(/\n(?=-\s)/)) {
      const claim = unquoted(block).replace(/\s+/g, ' ').trim();
      const rule = /^- CRITICAL [—–-] ([A-Za-z][\w/.-]*\/legacyAuthFlow\.regression\.test\.[jt]s) \((T[1-9]\d*), REGRESSION RULE, no approval needed\): golden tests for ([^.!?]{1,300})\./.exec(claim);
      if (!rule || suiteWithdrawn || goldenWithdrawn || !snapshotSource.includes(claim) ||
          !/(?:^|\. )These tests are the parity oracle for the D[1-9]\d* flag-off path\./.test(claim) ||
          extractionSourceOwner(block) || conditionalOwner(block) ||
          extractionSourceOwner(requirements.slice(0, requirements.indexOf(block))) ||
          conditionalOwner(requirements.slice(0, requirements.indexOf(block)))) continue;
      const id = rule[2]!;
      const assessment = (value: string) => value.replace(/"[^"\n]*"|“[^”\n]*”/g,
        (quoted: string, index: number, source: string) =>
          /^(?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)$/i.test(quoted.slice(1, -1)) &&
          new RegExp(`(?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been)|(?:this|the) (?:(?:unchanged-code|baseline) )?verification (?:is|was|has been)|(?:the|this) legacy golden (?:tests|suite) (?:are|is|were|was|have been|has been)) $`, 'i').test(source.slice(0, index))
            ? quoted.slice(1, -1) : '');
      const inactive = (value: string) => {
        const body = assessment(value).replace(/\b(?:these|the|this)\s+tests\s+(?:are|were|have been)\b/gi, 'this suite is')
          .replace(/\b(?:these|the|this)\s+tests\b/gi, 'this suite')
          .replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
        return withdrawn(body, id) || /\b(?:this|the|that) (?:requirement|suite|test) (?:is|was|has been) (?:not current|no longer current)\b/i.test(body) || new RegExp(`\\b${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\\b`, 'i').test(body);
      };
      if (inactive(block)) continue;
      const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\\b`, 'i');
      const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow(?:\\(\\))? (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'i');
      if (current.some(s => {
        const body = assessment(s.body.join('\n'));
        return cancelled.test(body) || /\b(?:the|this) legacy golden (?:tests|suite) (?:are|is|were|was|have been|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\b/i.test(body) ||
          body.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
      })) continue;
      const ordering = current.some(s => {
        if (s.title !== 'Implementation steps') return false;
        const body = unquoted(s.body.join('\n'));
        const step = new RegExp(`^[1-9]\\d*\\. Golden regression tests for legacyAuthFlow \\(${id}\\) [—–-] pin current outputs\\s+per input class before any other code moves\\. CRITICAL, lands first\\.`, 'm').exec(body);
        return Boolean(step && !extractionSourceOwner(body.slice(0, step.index)) && !conditionalOwner(body.slice(0, step.index)) &&
          !inactive(body) && snapshotSource.includes(step[0].replace(/\s+/g, ' ')));
      });
      if (!ordering) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        const body = tasks.body.join('\n').trim();
        for (const task of body.split(/\n(?=-\s)/)) {
          const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] ([A-Za-z][\w/.-]*\/legacyAuthFlow) tests [—–-] CRITICAL golden regression tests, land first[\t ]*(?:\n|$)/.exec(task);
          const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
          const verify = /^\s+- Verify: (one|two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) input classes pinned; suite green against unmodified legacy code before any refactor commit[\t ]*$/m.exec(task);
          const prefix = unquoted(body.slice(0, body.indexOf(task))).trim().split('\n').at(-1) ?? '';
          if (!match || match[1] !== id || file?.[1] !== rule[1] || !verify ||
              !rule[1].startsWith(match[2] + '.regression.test.') ||
              !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
              extractionSourceOwner(prefix) || conditionalOwner(prefix) ||
              extractionSourceOwner(unquoted(task.slice(0, verify.index))) || conditionalOwner(task.slice(0, verify.index)) || inactive(task)) continue;
          const count = /^\d+$/.test(verify[1]!) ? Number(verify[1]) : ['zero','one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(verify[1]!);
          if (count === rule[3]!.split(',').length) return true;
        }
      }
    }
  }


  // A mandatory before-rewrite declaration binds exact captured behavior to
  // the same task file's current-code baseline and flag-on rerun.
  const approvalPending = (value: string) => unquoted(value).split('\n').some(line =>
    /^\s*(?:once|when|pending)\b[^.!?\n]{0,80}\bapprov(?:e[ds]?|al)\b/i.test(line));
  // A required fixture file can own the legacy oracle while its read-only
  // baseline task gates the scheduled task that changes the legacy module.
  for (const section of current.filter(s => /^CRITICAL: regression test for legacyAuthFlow\(\) \(regression rule, mandatory\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /(?:^|\. )Before any rewrite: - ([A-Za-z][\w/.-]*\.test(?:\.[jt]s)?) records, for a fixture set of tenants and tokens, the exact claims returned and the exact error for each failure case \(([^()!?]{1,300})\)\. - The same fixture set is the shadow comparator's assertion set and stays as the permanent behavioral spec after legacy is deleted\./.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0].trim()) || withdrawn(body) ||
        extractionSourceOwner(body) || conditionalOwner(body) || approvalPending(body) ||
        !['expired', 'wrong audience', 'wrong issuer', 'suspended tenant', 'revoked token', 'malformed token'].every(kind => rule[2]!.split(',').map(item => item.trim()).includes(kind))) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || conditionalOwner(prefix) || approvalPending(prefix) || /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] CRITICAL regression test capturing legacyAuthFlow\(\) behavior before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: test passes against unmodified legacy; same fixtures drive shadow compare[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== rule[1] || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        const id = match[1]!, status = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|not current|no longer current|not required|no longer required)';
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `((?:^|[.!?;]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:baseline requirement|verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
          .replace(/(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '')
          .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
        const cancelled = new RegExp(`\\b${id}(?: (?:baseline requirement|verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
        const inactive = (value: string) => {
          const owned = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(owned, id) || cancelled.test(owned) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(owned);
        };
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
        if (inactive(body) || inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
            new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
        })) continue;
        for (const strategy of current.filter(s => s.title === 'Worktree parallelization strategy')) {
          const schedule = unquoted(strategy.body.join('\n'));
          const rows = [...schedule.matchAll(/^\| (T[1-9]\d*) ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
          if (rows.length !== new Set(rows.map(row => row[1])).size || extractionSourceOwner(schedule) || approvalPending(schedule) || inactive(schedule) ||
              schedule.split('\n').some(line => conditionalOwner(line) || /^\s*(?:assuming|provided)\b/i.test(line))) continue;
          const baseline = rows.find(row => row[1] === id && row[2] === 'legacy regression test' && row[4] === '—');
          const modules = baseline && /^([A-Za-z][\w/-]*) \(read\), ([A-Za-z][\w/-]*)$/.exec(baseline[3]!);
          const writers = modules ? rows.filter(row => row[1] !== id && row[3]!.split(',').map(item => item.trim()).includes(modules[1]!)) : [];
          if (modules && rule[1]!.startsWith(modules[2] + '/') && writers.length > 0 &&
              writers.every(row => row[4]!.split(',').map(item => item.trim()).includes(id)) &&
              snapshotSource.includes(baseline![0].replace(/\s+/g, ' ').trim())) return true;
        }
      }
    }
  }
  for (const section of current.filter(s => s.title === 'REGRESSION RULE (mandatory, no decision required)')) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^legacyAuthFlow\(\) is existing behavior being rewritten\b[^!?]{1,240}\. CRITICAL: before any rewrite, record a characterization suite in ([A-Za-z][\w/.-]*\.test\.[jt]s): for each supported tenant configuration, capture inputs \([^()!?]{1,300}\) and the exact output \([^()!?]{1,300}\)\. The new path must pass the same suite with the flag on\. This is the parity gate for D[1-9]\d*\.$/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(body) || withdrawn(body) ||
        /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(body)) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write the legacyAuthFlow\(\) characterization \(regression\) suite before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
        const verify = /^\s+- Verify: suite green on current code; green again with flag on after rewrite[\t ]*$/m.exec(task);
        const preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || file?.[1] !== rule[1] || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify.index)) || conditionalOwner(task.slice(0, verify.index)) || approvalPending(task.slice(0, verify.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify.index)))) continue;
        const id = match[1]!;
        // Preserve a quoted status word on a current subject, while still
        // ignoring quoted historical sentences and foreign suite withdrawals.
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `(\\b(?:${id}(?: (?:verification|baseline verification|rerun))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“](withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”]`, 'gi'), '$1$2'));
        const inactive = (value: string) => {
          const body = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(body, id) || /\b(?:this|the) (?:suite|requirement) (?:is|was|has been) (?:superseded|not current|no longer current)\b/i.test(body);
        };
        const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\\b`, 'i');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'i');
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“]?(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”]?\\s*\\|`, 'im');
        if (inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || /\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\b/i.test(value) ||
            value.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
        })) continue;
        return true;
      }
    }
  }

  // A mandatory current-output baseline can land before all other tasks.
  // This obligation does not imply an identical suite on the flag-on path:
  // a plan may specify its rollout parity check separately.
  for (const section of current.filter(s => /^CRITICAL [—–-] regression \(mandatory, REGRESSION RULE\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^legacyAuthFlow\(\) is (?:live|existing|current) behavior being (?:changed|modified|refactored) with no covering test(?: \([^()!?]{1,120}\))?\. Before any (?:rewrite|refactor|change): ([A-Za-z][\w/.-]*\.test\.[jt]s) (?:records|captures|pins) (?:current|existing) outputs \(including quirks\) for [^.!?]{1,300} inputs\. This suite runs against the legacy path now\b/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0]) || withdrawn(body) ||
        extractionSourceOwner(body) || approvalPending(body) || /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(body)) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] CRITICAL regression: characterization suite for legacyAuthFlow\(\) (?:current|existing|prior) behavior[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: ([^\n]+)$/gm)];
        const verify = verifies[0];
        const preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== rule[1] || verifies.length !== 1 ||
            !/^suite green against unmodified legacy before any other task merges[\t ]*$/.test(verify![1]!) ||
            !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        const id = match[1]!;
        const status = '(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer current|not required|no longer required)';
        // Current scalar statuses retain their owner; whole-sentence quoted
        // history and conditional future statuses cannot cancel this baseline.
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
          .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
        const inactive = (value: string) => {
          const body = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(body, id) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(body);
        };
        const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
        if (inactive(body) || inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
            new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
        })) continue;
        return true;
      }
    }
  }

  // A directory-owned characterization task can name changed worktree steps
  // in its baseline check, with the baseline's own lane merging first.
  for (const section of current.filter(s => /^Tests(?: \([^\n)]+\))?$/.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^CRITICAL regression suite \(mandatory, IRON RULE\)\. legacyAuthFlow\(\) is existing behavior being rewritten and the original plan had no regression coverage\. Before any rewrite, write a characterization suite that pins current behavior: [^.!?]{1,300}\. The suite runs against both the legacy path and the new flow \(via the flag\) for the whole rollout window\./.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0]) || withdrawn(body) ||
        /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(rule[0])) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) || extractionSourceOwner(prefix) ||
          approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] ([A-Za-z][\w/-]*) [—–-] Write the CRITICAL characterization suite for legacyAuthFlow\(\) before any rewrite; run it against legacy and new flow[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: suite green on legacy path before (S[1-9]\d*)\/(S[1-9]\d*) land; green on both paths after[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== `${match[2]}/, router flag stub` || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        for (const strategy of current.filter(s => s.title === 'Worktree parallelization strategy')) {
          const schedule = unquoted(strategy.body.join('\n'));
          const steps = [...schedule.matchAll(/^\| (S[1-9]\d*)\b/gm)].map(row => row[1]);
          if (steps.length !== new Set(steps).size) continue;
          const baseline = /^\| (S[1-9]\d*) Regression suite for legacyAuthFlow\(\) \| ([A-Za-z][\w/-]*) \| [—–-] \|$/m.exec(schedule);
          const lanes = baseline ? [...schedule.matchAll(new RegExp(`^\\s*Lane ([A-Z]): ${baseline[1]} \\(independent\\)$`, 'gm'))] : [];
          const lane = lanes.length === 1 ? lanes[0] : undefined;
          const order = lane && new RegExp(`^Execution order: launch [A-Z](?:, [A-Z])+ in parallel worktrees\\. Merge ${lane[1]} first \\(it is\\s+pure tests and gates the rewrite\\)\\.`, 'm').exec(schedule);
          if (!baseline || baseline[2] !== match[2] || !lane || !order || verify![1] === verify![2] ||
              !new RegExp(`^\\| ${verify![1]} AuthBroker \\+ SessionMint \\| [^|]+ \\| [^|]+ \\|$`, 'm').test(schedule) ||
              !new RegExp(`^\\| ${verify![2]} Flattened dispatcher \\+ flag router \\+ fallback \\| [^|]+ \\| [^|]+ \\|$`, 'm').test(schedule) ||
              extractionSourceOwner(schedule.slice(0, order.index)) || conditionalOwner(schedule.slice(0, order.index)) || approvalPending(schedule.slice(0, order.index)) ||
              !snapshotSource.includes(order[0].replace(/\s+/g, ' '))) continue;
          const id = `(?:${match[1]}|${baseline[1]})`, status = '(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer current|not required|no longer required)';
          const assessment = (value: string) => unquoted(value.replace(new RegExp(
            `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
            .replace(/(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '')
            .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
          const inactive = (value: string) => {
            const text = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
            return withdrawn(text, id) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(text);
          };
          const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
          const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
          if (inactive(body) || inactive(task) || current.some(s => {
            const value = assessment(s.body.join('\n'));
            return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
              new RegExp(`\\b(?:the|this) (?:legacy (?:regression|characterization) (?:suite|tests?|requirement)|(?:baseline|unchanged-code) verification) (?:is|was|has been) ${status}\\b`, 'i').test(value);
          })) continue;
          return true;
        }
      }
    }
  }

  // A blocking declaration can bind its task to the first ordered step:
  // characterize both existing entry points before any implementation changes.
  for (const section of current.filter(s => /^REGRESSION \(CRITICAL, mandatory under the regression rule, no question asked\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /(?:^|\. )(T[1-9]\d*) is a blocking requirement: before any rewrite, (?:capture|record|pin) the current behavior of legacyAuthFlow\(\) and validateAndDispatch\(\) as a characterization suite: every accepted token shape, every rejected token shape, every error response, for at least (?:two|[2-9]\d*) tenants\. The same suite runs against the AuthBroker path behind the flag and must produce identical outcomes\b/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0].trim()) ||
        extractionSourceOwner(body) || conditionalOwner(body) || approvalPending(body)) continue;
    const id = rule[1]!;
    const status = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|not current|no longer current|not required|no longer required)';
    const taskSubject = `${id}(?: (?:baseline requirement|verification|baseline verification|regression tests?))?`;
    const assessment = (value: string) => unquoted(value.replace(new RegExp(
      `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${taskSubject}|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
      .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
    const cancelled = new RegExp(`\\b${taskSubject} (?:is|was|has been) ${status}\\b`, 'i');
    const inactive = (value: string) => {
      const owned = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
      return withdrawn(owned, id) || cancelled.test(owned) ||
        new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(owned);
    };
    const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
    const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
    if (inactive(body) || current.some(s => {
      const value = assessment(s.body.join('\n'));
      return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
        new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
    })) continue;
    const baseline = current.some(s => {
      if (s.title !== 'Implementation steps (ordered)') return false;
      const schedule = unquoted(s.body.join('\n')).trim();
      const first = new RegExp(`^1\\. ${id} Characterization suite for legacyAuthFlow\\(\\) and validateAndDispatch\\(\\)\\. Green on current code before anything else changes\\.[\\t ]*(?:\\n|$)`).exec(schedule);
      return Boolean(first && !inactive(schedule) && snapshotSource.includes(first[0].replace(/\s+/g, ' ').trim()));
    });
    if (!baseline) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || conditionalOwner(prefix) || approvalPending(prefix) ||
          /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write the characterization\/regression suite for legacyAuthFlow\(\) and validateAndDispatch\(\) before any rewrite \(CRITICAL\)[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: [^,\n]+, (?:tests?|__tests__)\/[A-Za-z][\w/.-]*[\t ]*$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: suite green on current code; later green on both flag states[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || match[1] !== id || files.length !== 1 || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index))) || inactive(task)) continue;
        return true;
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
