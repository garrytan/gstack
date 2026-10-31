/**
 * The NEEDS_ASIDE: Darwin download pitch is a recommendation, so it counts only where a recommendation can start: a
 * sentence, clause (after , : ; or a dash), bullet or line start, optionally led by "then/please/just/so/first/now" and
 * "you can/could/may/should/need to". A quoted, parenthesised or reported mention ("the line 'download Aside ...'",
 * "says to download ...") and a clause with a negation before the phrase ("you don't need to download ...", or "do not"
 * ending the previous line) never count. The canonical phrase may name Aside as "it" once the macOS 15+ floor follows
 * ("If you want to use Aside: download it (macOS 15+) at aside.com", gate 39315041557). The short forms without the
 * floor count only at the start of a sentence, bullet or quote. The passive form ("Aside runs on macOS 15+ and can be
 * downloaded at aside.com", gate 40987391676) counts when its clause starts with Aside or "it" and holds no negation.
 */
const ASIDE_DOWNLOAD_PITCH = String.raw`(?:^|[.!?;:]\s*|\n)\s*(?:[>*-]\s*)*["\u201C]?download (?:it|Aside) at aside\.com\b|(?:^|[.!?;:,\u2014\u2013\n])[\s>*_-]*(?<!(?:\b(?:not|never|no|cannot)|n['\u2019]t)\s+)(?:(?:then|please|just|so|first|now)\s+)?(?:you\s+(?:can|could|may|should|need\s+to)\s+)?download (?:Aside|it) \(macOS 15\+\) at aside\.com\b|(?:^|[.!?;:,\u2014\u2013\n])[\s>*_-]*(?:Aside|it)\b(?:(?!\b(?:not|never|no)\b|n['\u2019]t\b)[^.!?;:,\n])*?\b(?:can|may)\s+be\s+downloaded\s+(?:at|from)\s+aside\.com\b`;
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

/** Inspect lettered consent options, not narration that quotes an unavailable option. */
export function asideDriveOptions(text: string): string[] {
  return letteredOptions(text).filter(option => {
    const currentOffer = option.replace(
      /\b(?:I|we)(?:['’]ll| will) (?:re[- ]?ask|ask again)(?: (?:you|this question))? with (?:the )?(?:"[^"]+"|“[^”]+”|[\w -]+?) option(?: included)?\b/gi,
      '',
    );
    return /\bAside\b/.test(option) && (/\b(?:drive|driving|browse|browsing|navigate|click)\b/i.test(currentOffer)
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
 */
export const offersDefer = (text: string): boolean => letteredOptions(text).some(option =>
  /\b(?:defer\w*|postpone\w*|put (?:this|it)(?: step)? off|skip (?:this|it)(?: step)? for now|come back to (?:this|it)(?: step)? later|leave (?:this|it)(?: step)? for (?:now|later))\b/i.test(option)
  || !/drive|browse|Aside/i.test(option)
    && /(?:^|[.!?;:]\s+)(?:(?:we|I|let['\u2019]s) )?(?:wait|hold off)(?: on (?:this|it)(?: step)?)? for now\b(?=\s*(?:[.!?;:]|[-\u2013\u2014]|$))/i.test(option));

/** The manual option: "manual", or one sentence offering instructions or steps the user follows themselves. */
export function offersManualSteps(text: string): boolean {
  return /manual/i.test(text) || text.split(/[.!?](?:\s|$)|\n/).some(sentence => /\b(?:instructions?|steps?)\b/i.test(sentence) &&
    (/\byourself\b/i.test(sentence) || (/\bby\s+hand\b/i.test(sentence) && /\byour?\b/i.test(sentence))));
}
