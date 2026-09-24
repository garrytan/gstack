import type { SharedQuestionSelector } from './shared-libs-eval-fixture';

/** Separate explicit exclusions from proposals; do not erase a following "but" clause. */
function affirmativeCommitments(text: string): string {
  return text.split(/\n|;|(?<=[.!?])\s+|\s+but\s+|\s+however,?\s+/i).map(raw => {
    let clause = raw.replace(/^[✅❌\s]+/, '').trim();
    if (/^(?:do not|don't|never|no\b|without\b)/i.test(clause)) return '';
    if (/\b(?:is|are|remains?)\s+(?:outside\b|out of scope\b|excluded\b|not part\b)/i.test(clause)) return '';
    clause = clause.replace(/\b(?:without|do not|don't|never)\b.*$/i, '');
    return clause;
  }).filter(Boolean).join('\n');
}

/** A repeated option menu is context, not approval of every displayed alternative. */
function questionParts(text: string, optionIndex: number): { context: string; option: string } {
  let copiedOption: number | undefined;
  const context: string[] = [], option: string[] = [];
  for (const line of text.split('\n')) {
    const selector = line.match(/^\s*([A-D])[).]\s+/);
    if (selector) copiedOption = selector[1].charCodeAt(0) - 65;
    if (/^\s*Net:/i.test(line)) copiedOption = undefined;
    if (copiedOption === undefined || copiedOption === optionIndex) context.push(line);
    if (copiedOption === optionIndex) option.push(line);
  }
  return { context: context.join('\n'), option: option.join('\n') };
}

/** This fixture actor can approve reuse under the fixed scheduler contract, not redesign it. */
export function createSharedPlanReuseSelector(): SharedQuestionSelector {
  let answered = false;
  return input => {
    const refuse = (why: string): never => { throw new Error(`shared-libs-plan-callers actor: ${why}`); };
    if (answered) refuse('only the bounded parser-reuse choice is supported; another choice needs a different fixture');
    const questions = input.questions;
    if (!Array.isArray(questions) || questions.length !== 1) refuse('expected one native question for one reuse choice');
    const question = questions[0];
    if (!question || typeof question.question !== 'string' || question.multiSelect === true ||
        !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4 ||
        question.options.some((option: any) => typeof option?.label !== 'string' || typeof option?.description !== 'string')) {
      refuse('unsupported native question shape');
    }
    const choices = question.options.map((option: any, index: number) => {
      const parts = questionParts(question.question, index);
      return { option, index, context: parts.context + '\n' + (question.header || ''),
        commitment: option.label + '\n' + option.description + '\n' + parts.option };
    });
    const candidates = choices.filter(({ option, commitment, context }: any) =>
      !/\b(?:do not|don't|never|avoid|reject|skip|decline)\b.*\b(?:reuse|use|import|delegate|share|call)\b/i.test(option.label) &&
      /\b(?:reus(?:e|es|ing)|us(?:e|es|ing)|import(?:s|ing)?|delegat(?:e|es|ing)|shar(?:e|es|ing)|call(?:s|ing)?)\b/i.test(affirmativeCommitments(commitment)) &&
      (/lib\/retry-after\.ts|\bretrySeconds\b/.test(commitment) ||
        (/\b(?:helper|parser)\b/i.test(commitment) && /lib\/retry-after\.ts|\bretrySeconds\b/.test(context))));

    // Recommendation placement is not part of the native schema. Accept its
    // explicit brief, repeated menu or label form, and reconcile every form present.
    const recommendations = new Set<number>();
    choices.forEach(({ option, index }: any) => { if (/\(recommended\)/i.test(option.label)) recommendations.add(index); });
    for (const marker of question.question.matchAll(/^\s*([A-D])[).]\s+[^\n]*\(recommended\)/gim)) recommendations.add(marker[1].toUpperCase().charCodeAt(0) - 65);
    for (const statement of question.question.matchAll(/^\s*Recommendation:\s*(.+)$/gim)) {
      const value = statement[1].trim();
      const selector = value.match(/^(?:option\s+)?([A-D])\b/i);
      if (selector) recommendations.add(selector[1].toUpperCase().charCodeAt(0) - 65);
      else {
        const matches = choices.filter(({ option }: any) => value.toLowerCase().startsWith(option.label.replace(/\s*\(recommended\)/ig, '').trim().toLowerCase()));
        if (matches.length !== 1) refuse('explicit recommendation is ambiguous or does not name an offered option');
        recommendations.add(matches[0].index);
      }
    }
    if (recommendations.size > 1) refuse('explicit recommendation does not identify one supported reuse option');
    const recommendedIndex = [...recommendations][0];
    const selected = recommendedIndex === undefined ? (candidates.length === 1 ? candidates[0] : undefined)
      : candidates.find(({ index }: any) => index === recommendedIndex);
    if (!selected) {
      refuse('explicit recommendation does not identify the supported reuse option');
    }
    if (candidates.length > 1 && !candidates.every(({ commitment }: any) => /\b(?:proof|test\w*|coverage|verification)\b/i.test(commitment))) {
      refuse('multiple reuse options must differ only in proof depth');
    }
    // All reuse alternatives must keep the same runtime contract. Only their
    // proof depth may differ; recommendation cannot authorize another behavior.
    for (const { context, commitment } of candidates) {
      // The supplied PLAN owns the two future caller identities and fixed scope.
      // Native questions may refer to them without repeating file names, and an
      // option may inherit unchanged semantics from its complete decision brief.
      if (/\b(?:not|never|no longer)\s+(?:identical|the same|unchanged|preserv\w*|match\w*)\b/i.test(commitment) ||
          !/\b(?:identical|same|unchanged|preserv\w*|match\w*|keep\w*)\b[^.!?\n]{0,120}\b(?:scheduler|semantics|behavior|contract)\b|\b(?:scheduler|semantics|behavior|contract)\b[^.!?\n]{0,120}\b(?:identical|same|unchanged|preserv\w*|match\w*|keep\w*)\b/i.test(affirmativeCommitments(context + '\n' + commitment))) {
        refuse('the selected option must explicitly preserve the current scheduler contract');
      }
      // Inspect the question as well as the selected option: a harmless label must
      // not authorize an extra commitment hidden in its brief or description.
      const proposed = affirmativeCommitments(context + '\n' + commitment);
      const expansions = [
        /\b(?:harden\w*|tighten\w*|strict(?:er)?|saniti[sz]\w*|coerc\w*)\b/i,
        /\b(?:add(?:s|ing)?|insert(?:s|ing)?|introduc(?:e|es|ing)|implement(?:s|ing)?|appl(?:y|ies|ying)|enabl(?:e|es|ing)|creat(?:e|es|ing))\s+(?:(?:a|an|the|one|new|shared|extra|explicit|validation|numeric|malformed|input|parser)\s+)*(?:guard|validator|validation|normalization)\b/i,
        /\b(?:chang(?:e|es|ing)|alter(?:s|ing)?|modif(?:y|ies|ying)|patch(?:es|ing)?|fix(?:es|ing)?|updat(?:e|es|ing)|replac(?:e|es|ing))\s+(?:(?:the|existing|shared|current|its|our)\s+)*(?:(?:retry-after|numeric|malformed|header)\s+)*(?:helper|parser|scheduler|behavior|semantics|contract|parsing|fallback|ceiling|cap|retrySeconds|lib\/retry-after\.ts)\b/i,
        /\b(?:raise|lower|increase|decrease|remove|drop|bypass|disable)\b[^.!?\n]{0,60}\b(?:ceiling|cap|fallback|limit|bound)\b/i,
        /\b(?:reject|normalize|convert|round|clamp)\b[^.!?\n]{0,60}\b(?:malformed|numeric|invalid|header|input)\b/i,
        /\b(?:migrat\w*|rewir\w*|refactor\w*)\b[^.!?\n]{0,100}\b(?:existing|current|scheduler|retry-worker|retry-route)\b/i,
        /\b(?:header|input|value|numeric|retrySeconds|scheduler|helper|parser|fallback|ceiling|cap)\w*\b[^.!?\n,;]{0,100}\b(?:now|will)\s+(?:return|use|be|wait|fallback|zero|limit|cap)\b/i,
        /\b(?:existing|current|retry-worker\.ts|retry-route\.ts)\b[^\n;]{0,100}\b(?:will|now|also)\s+(?:import|use|call|delegate|share)\b/i,
        /\bsrc\/(?!import-worker\.ts\b|sync-route\.ts\b)[\w.-]+\.ts\b[^\n;]{0,100}\b(?:will|now|also)\s+(?:import|use|call|delegate|share)\b/i,
      ];
      const expansion = expansions.map(pattern => proposed.match(pattern)?.[0]).find(Boolean);
      if (expansion) refuse(`question expands beyond unchanged-helper reuse and its required proof: ${expansion}`);
    }
    answered = true;
    return { [question.question]: selected.option.label };
  };
}
