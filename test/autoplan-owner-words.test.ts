/**
 * GST-1243: the owner-words rule behind `gstack-autoplan export --public` (lib/autoplan-owner-words.ts). Short replies
 * and gate grammar are never scanned for; a quote is WINDOW consecutive words of an owner text (all of it when shorter),
 * matched across line breaks, blockquote markers, case and curly quotes; code export keeps is never rewritten.
 */
import { describe, expect, test } from 'bun:test';
import { MIN_WORDS, OWNER_WORDS_MARK as MARK, WINDOW, dropOwnerFields, ownerSpans, ownerWords, redactOwnerWords } from '../lib/autoplan-owner-words';

const LONG = 'Keep the backoff cap at thirty seconds and log every retry attempt so we can see it.';
const owners = (...replies: Array<string | { owner_reply: string; owner_reply_parsed: boolean }>) =>
  ownerWords({ phases: {} } as never, replies.map(r => (typeof r === 'string' ? { owner_reply: r } : r)));
const quoted = (text: string, ...replies: string[]) => ownerSpans(text, owners(...replies)).map(([s, e]) => text.slice(s, e));

describe('the quote rule', () => {
  test(`replies under ${MIN_WORDS} words or 20 characters are never scanned for`, () => {
    const prose = 'Do it. Yes. Garry: do it. Ship it now please, the owner said.';
    expect(quoted(prose, 'do it', 'yes', 'Garry: do it', 'Ship it now please')).toEqual([]);
    expect(quoted('a b c d e f', 'a b c d e')).toEqual([]);
  });

  test('a reply that parsed as gate grammar is the decision code, not scanned for', () => {
    const o = owners({ owner_reply: 'rec except p2b p3a c4b', owner_reply_parsed: true });
    expect(ownerSpans('reply: rec except p2b p3a c4b', o)).toEqual([]);
    expect(quoted('reply: rec except p2b p3a c4b', 'rec except p2b p3a c4b')).toEqual(['rec except p2b p3a c4b']);
  });

  test(`a reply shorter than ${WINDOW} words matches only whole`, () => {
    expect(quoted('They said: please drop the Redis cache layer, entirely.', 'Drop the Redis cache layer entirely')).toEqual(['drop the Redis cache layer, entirely']);
    expect(quoted('They said: please drop the Redis cache layer.', 'Drop the Redis cache layer entirely')).toEqual([]);
  });

  test(`any ${WINDOW} consecutive words of a longer reply are a quote; ${WINDOW - 1} are not`, () => {
    expect(quoted('Per the owner, log every retry attempt so we can see it. Fine.', LONG)).toEqual(['log every retry attempt so we can see it']);
    expect(quoted('We will log every retry attempt so we can tell.', LONG)).toEqual([]);
    expect(quoted(`A: ${LONG} B: ${LONG}`, LONG)).toHaveLength(2);
  });

  test('line breaks, blockquote markers, indentation, case and curly quotes do not hide a quote', () => {
    const text = '> \u201cDon\u2019t ship the backoff\n>   without the flag, EVER\u201d\n';
    expect(quoted(text, "don't ship the backoff without the flag, ever")).toEqual(['Don\u2019t ship the backoff\n>   without the flag, EVER']);
  });
});

describe('redactOwnerWords', () => {
  test('replaces each quote with the marker, keeps the punctuation around it, and leaves other prose byte for byte', () => {
    const o = owners(LONG);
    expect(redactOwnerWords(`The owner: "${LONG}" Noted.`, o)).toEqual({ text: `The owner: "${MARK}." Noted.`, redacted: 1 });
    const control = 'Keep the backoff cap. Log every retry. Thirty seconds is fine.';
    expect(redactOwnerWords(control, o)).toEqual({ text: control, redacted: 0 });
  });

  test('a quote overlapping a kept span (code) is left for the validator to refuse', () => {
    const text = `\`${LONG}\``;
    expect(redactOwnerWords(text, owners(LONG), [[0, text.length]])).toEqual({ text, redacted: 0 });
  });

  test("gstack's verbatim copies of carried words and a human's deferral reason are replaced whatever their length", () => {
    const o = ownerWords({ phases: { ceo: { deferred: { reason: 'no time', by: 'human' } } }, carry: { words: 'Garry: do it' } } as never, []);
    expect(redactOwnerWords('CARRIED: gate_rev=2 <- gate_rev=1 words="Garry: do it" by=agent:x', o).text).toBe(`CARRIED: gate_rev=2 <- gate_rev=1 words=${MARK} by=agent:x`);
    expect(redactOwnerWords('Deferred ceo at round 1 (owner, by human): no time; 0 open', o).text).toBe(`Deferred ceo at round 1 (owner, by human): ${MARK}; 0 open`);
    expect(redactOwnerWords('ceo closed accepted-with-findings at round 1 (no time): 0 open', o).text).toBe(`ceo closed accepted-with-findings at round 1 (${MARK}): 0 open`);
    expect(redactOwnerWords('round 1 (no time; by human); open findings', o).text).toBe(`round 1 (${MARK}; by human); open findings`);
    expect(redactOwnerWords('deferred: no time', o).text).toBe(`deferred: ${MARK}`);
    expect(redactOwnerWords('we had no time to spare', o).text).toBe('we had no time to spare');
  });
});

describe('dropOwnerFields', () => {
  test("drops owner_reply and a carry record's words, marks a human's deferral reason, keeps an agent's", () => {
    const run = {
      gate: { reply: 'p1b', owner_reply: LONG, owner_reply_parsed: false }, carry: { verdict: 'carried', words: LONG, lines: [] },
      phases: { ceo: { deferred: { reason: 'no time', by: 'human', cause: 'owner' } }, eng: { deferred: { reason: 'budget', by: 'agent:x', cause: 'owner' } } },
    };
    expect(dropOwnerFields(run)).toEqual({ dropped: 3, value: {
      gate: { reply: 'p1b', owner_reply_parsed: false }, carry: { verdict: 'carried', lines: [] },
      phases: { ceo: { deferred: { reason: MARK, by: 'human', cause: 'owner' } }, eng: { deferred: { reason: 'budget', by: 'agent:x', cause: 'owner' } } },
    } });
    expect(run.gate.owner_reply).toBe(LONG);
  });
});
