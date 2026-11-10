/**
 * The NEEDS_ASIDE: Darwin download pitch is a recommendation, so it counts only where a recommendation can start: a
 * sentence, clause (after , : ; or a dash), bullet or line start, optionally led by "then/please/just/so/first/now" and
 * "you can/could/may/should/need to". A quoted, parenthesised or reported mention ("the line 'download Aside ...'",
 * "says to download ...") and a clause with a negation before the phrase ("you don't need to download ...", or "do not"
 * ending the previous line) never count. The canonical phrase may name Aside as "it" once the macOS 15+ floor follows
 * ("If you want to use Aside: download it (macOS 15+) at aside.com", gate 39315041557). The short forms without the
 * floor count only at the start of a sentence, bullet or quote. The passive form ("Aside runs on macOS 15+ and can be
 * downloaded at aside.com", gate 40987391676) counts when its clause starts with Aside or "it" and the download
 * predicate's own coordinate clause holds no negation: "Aside is not installed but can be downloaded at aside.com"
 * counts, "Aside is not something that can be downloaded" and "... but cannot be downloaded" never do.
 */
const ASIDE_DOWNLOAD_PITCH = String.raw`(?:^|[.!?;:]\s*|\n)\s*(?:[>*-]\s*)*["\u201C]?download (?:it|Aside) at aside\.com\b|(?:^|[.!?;:,\u2014\u2013\n])[\s>*_-]*(?<!(?:\b(?:not|never|no|cannot)|n['\u2019]t)\s+)(?:(?:then|please|just|so|first|now)\s+)?(?:you\s+(?:can|could|may|should|need\s+to)\s+)?download (?:Aside|it) \(macOS 15\+\) at aside\.com\b|(?:^|[.!?;:,\u2014\u2013\n])[\s>*_-]*(?:Aside|it)\b(?:(?=(?<clause>(?:(?!\b(?:can|may)\s+be\s+downloaded\b)[^.!?;:,\n])*\b(?:but|and|yet)\b))\k<clause>)?(?:(?!\b(?:not|never|no)\b|n['\u2019]t\b)[^.!?;:,\n])*?\b(?:can|may)\s+be\s+downloaded\s+(?:at|from)\s+aside\.com\b`;
export const asideDownloadPitch = new RegExp(ASIDE_DOWNLOAD_PITCH, 'im');
export const asideDownloadPitchCount = (text: string): number => [...text.matchAll(new RegExp(ASIDE_DOWNLOAD_PITCH, 'gim'))].length;

/** Lettered consent options (A-D), bulleted, bold or blockquoted, with indented continuation lines. */
export function letteredOptions(text: string): string[] {
  const options: string[] = [];
  let current: string | undefined;
  for (const line of text.replaceAll('**', '').split('\n')) {
    const option = line.match(/^[ \t]*(?:>[ \t]*)?(?:[-*+][ \t]+)?[A-D][).][ \t]+(.*)$/);
    if (option) {
      if (current !== undefined) options.push(current);
      current = option[1];
    } else if (current !== undefined && /^[ \t]+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current !== undefined) {
      options.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) options.push(current);
  return options;
}

/**
 * A mention that says Aside is missing ("since Aside isn't available", "Aside was not detected", "with no Aside
 * installed") names the browser the option does not use, so it never makes a drive option an Aside drive (gate
 * 42748129558: "I drive it in gstack's own visible browser (recommended, since Aside isn't available)").
 */
const ASIDE_UNAVAILABLE = /\bAside(?:['’]s)?(?:\s+(?:browser|app))?\s+(?:is|was)(?:n['’]t|\s+not)\b|\bAside(?:\s+(?:browser|app))?\s+(?:is|was)\s+(?:unavailable|missing|absent)\b|\b(?:no|without)\s+(?:the\s+|your\s+)?Aside\b/gi;

/** Inspect lettered consent options, not narration that quotes an unavailable option. */
export function asideDriveOptions(text: string): string[] {
  return letteredOptions(text).filter(option => {
    const currentOffer = option.replace(
      /\b(?:I|we)(?:['’]ll| will) (?:re[- ]?ask|ask again)(?: (?:you|this question))? with (?:the )?(?:"[^"]+"|“[^”]+”|[\w -]+?) option(?: included)?\b/gi,
      '',
    );
    return /\bAside\b/.test(option.replace(ASIDE_UNAVAILABLE, '')) && (/\b(?:drive|driving|browse|browsing|navigate|click)\b/i.test(currentOffer)
      || /\bI(?:['’]ll| will)? (?:do|handle|create|complete) (?:it|this)\b/i.test(currentOffer));
  });
}

/** Any lettered option offering a browser drive, for flows where no drive may be offered. */
export const offersDriveOption = (text: string): boolean => letteredOptions(text).some(option => /drive|browse|Aside/i.test(option));

/**
 * The defer option: a lettered option that defers, postpones or sets the step aside for now. "Wait for now" and
 * "hold off for now" count only as the option's own opening or sentence (gate 40290033102: "D) Wait for now. I'll
 * mark this step as blocked on you."), never as a drive option's "I wait while you sign in": the phrase must open the
 * option or a sentence and end it, and the option must not be a browser drive, so "I wait for now while you sign in",
 * "wait for now and do it yourself" and "I drive it in Aside. I wait for now." do not count.
 *
 * The contract's own defer outcome also counts, whatever the option calls it: an option that is neither a browser
 * drive nor manual steps and says the step is marked, left or kept as blocked or waiting on the user, with that clause
 * ending at "on you" (gate 42431616220: "D) Do it later. I'll mark this step as waiting on you."). A clause starts
 * at the option start, after sentence punctuation, after an en or em dash, or after a spaced hyphen; a mid-word hyphen
 * ("re-mark") starts none. A negation, refusal or condition anywhere in the clause before that verb or the
 * stays/remains/is predicate never counts, so "I will not mark this step as blocked on you", "I won't mark this step as
 * waiting on you", "I refuse to mark this step as blocked on you", "otherwise I'll mark this step as blocked on you",
 * "if you skip it, I'll mark this step as blocked on you", "the step is not blocked on you" and "nothing stays blocked
 * on you" do not count, and neither does "waiting on you to approve it".
 *
 * Marking the step is what choosing the option does, so that clause counts on its own. The stays/remains/is predicate
 * only describes the step's state, which any option can mention, so it counts only after an earlier part of the same
 * option puts the step off ("later", "not yet", "not now"): "Later. This step remains waiting on you." counts, but "Sign
 * in yourself. Until then the step stays blocked on you.", "Approve it in the dashboard. The step is waiting on you."
 * and "Do it now, not later. The step stays blocked on you." do not.
 */
const DEFER_OUTCOME = /(?:^|[.!?;:]\s+|\s-+\s+|[\u2013\u2014]\s*)(?:(?!\b(?:not|never|no|nothing|nobody|none|neither|nor|without|cannot|refus\w*|declin\w*|avoid\w*|rather|instead|if|unless|otherwise|else)\b|n['\u2019]t\b)[^.!?;:\u2013\u2014])*?\b(?:(?:I|we)(?:['\u2019]ll| will) |I |we )?(?:(?:mark|leave|keep)\w* (?:this|it|the)(?: [\w-]+)?(?: step)? (?:as )?|(?<status>(?:stays|remains|is) ))(?:blocked|waiting) on you(?=\s*(?:[.!?;:]|[-\u2013\u2014]|$))/gi;
const PUT_OFF = /(?<!\b(?:not|no)\s+)\blater\b|\bnot (?:yet|now)\b/i;
const offersDeferOutcome = (option: string): boolean => [...option.matchAll(DEFER_OUTCOME)]
  .some(match => !match.groups?.status || PUT_OFF.test(option.slice(0, match.index + match[0].lastIndexOf(match.groups.status))));
export const offersDefer = (text: string): boolean => letteredOptions(text).some(option =>
  /\b(?:defer\w*|postpone\w*|put (?:this|it)(?: step)? off|skip (?:this|it)(?: step)? for now|come back to (?:this|it)(?: step)? later|leave (?:this|it)(?: step)? for (?:now|later))\b/i.test(option)
  || !/drive|browse|Aside/i.test(option)
    && (/(?:^|[.!?;:]\s+)(?:(?:we|I|let['\u2019]s) )?(?:wait|hold off)(?: on (?:this|it)(?: step)?)? for now\b(?=\s*(?:[.!?;:]|[-\u2013\u2014]|$))/i.test(option)
      || !offersManualSteps(option) && offersDeferOutcome(option)));

/** The manual option: "manual", or one sentence offering instructions or steps the user follows themselves. */
export function offersManualSteps(text: string): boolean {
  return /manual/i.test(text) || text.split(/[.!?](?:\s|$)|\n/).some(sentence => /\b(?:instructions?|steps?)\b/i.test(sentence) &&
    (/\byourself\b/i.test(sentence) || (/\bby\s+hand\b/i.test(sentence) && /\byour?\b/i.test(sentence))));
}
