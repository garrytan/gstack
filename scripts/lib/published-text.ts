/**
 * The one sanitizer for model- or fixture-written text that reaches a public
 * issue, PR comment or committed file (census report, tracking issue,
 * eval:pass-rates output). Control and bidi characters are stripped, the
 * repo's credential-scan patterns (lib/redact-engine, the engine the quality
 * gate's credential scan runs) are redacted, @-mentions are neutralized and
 * length is capped. Inline text also has HTML and Markdown link brackets
 * escaped; blocks go inside a code fence longer than any backtick run they
 * contain, so their content stays literal and cannot close the fence.
 */
import { redactFindingSpans } from '../../lib/redact-engine';

export const PUBLISHED_TEXT_MAX = 1000;

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 64 * 1024);
  const redacted = redactFindingSpans(stripped) ?? '[redacted: credential-shaped text that could not be isolated]';
  return redacted.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
}

/** One inline line: cleaned, HTML, Markdown link brackets and backticks neutralized, capped. */
export function sanitizePublishedText(text: string, max = PUBLISHED_TEXT_MAX): string {
  return cap(clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/`/g, "'"), max);
}

/** One line for a consumer that wraps it in a fixed three-backtick fence (the PR comment): backticks become quotes. */
export function sanitizeFixedFenceLine(text: string, max = PUBLISHED_TEXT_MAX): string {
  return cap(clean(text).replace(/`/g, "'"), max);
}

/** Cleaned, capped lines inside a fence longer than the longest backtick run they contain. */
export function publishedFence(lines: readonly string[], max = PUBLISHED_TEXT_MAX): string[] {
  const body = lines.map(line => cap(clean(line), max));
  const longest = Math.max(0, ...body.flatMap(line => (line.match(/`+/g) ?? []).map(run => run.length)));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, ...body, fence];
}
