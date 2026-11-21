/**
 * GST-1243: the owner-words rule behind `gstack-autoplan export --public` (lib/autoplan-owner-words.ts). Replies of 1-2
 * words and gate grammar are never scanned for; a reply of 3+ words is a quote wherever it appears whole, and from 8
 * words any 8 consecutive words are a quote; glued punctuation, entities, zero-width characters, Markdown, wraps and
 * contractions don't hide one; a quote extends over neighboring reply words; echoes of earlier text stay; gstack's
 * renderings of a human's deferral reason are matched with their delimiters; code export keeps is never rewritten.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIN_TOKENS, OWNER_WORDS_MARK as MARK, WINDOW, dropOwnerFields, ownerIndex, ownerSpans, redactOwnerWords } from '../lib/autoplan-owner-words';

const LONG = 'Keep the backoff cap at thirty seconds and log every retry attempt so we can see it.';
const quoted = (text: string, ...replies: string[]) => { const o = ownerIndex(replies.map(r => ({ text: r }))); return ownerSpans(text, o).map(([s, e]) => text.slice(s, e)); };

describe('the quote rule', () => {
  test(`replies under ${MIN_TOKENS} words are never scanned for; from ${MIN_TOKENS} words a reply is matched whole at word boundaries`, () => {
    expect(quoted('Do it. Yes. Ship it, the owner said.', 'do it', 'yes', 'ship it')).toEqual([]);
    expect(quoted('Context: Jane Doe vetoed it, per the relay.', 'Jane Doe vetoed it')).toEqual(['Jane Doe vetoed it']);
    expect(quoted('Jane Doe vetoed items in March.', 'Jane Doe vetoed it')).toEqual([]);
  });

  test('a reply that parsed as gate grammar is the decision code, not scanned for', () => {
    expect(ownerSpans('reply: rec except p2b p3a c4b', ownerIndex([{ text: 'rec except p2b p3a c4b', parsed: true }]))).toEqual([]);
    expect(quoted('reply: rec except p2b p3a c4b', 'rec except p2b p3a c4b')).toEqual(['rec except p2b p3a c4b']);
  });

  test(`a reply shorter than ${WINDOW} words matches only whole; any ${WINDOW} consecutive words of a longer one are a quote`, () => {
    expect(quoted('They said: please drop the Redis cache layer.', 'Drop the Redis cache layer entirely')).toEqual([]);
    expect(quoted('Per the owner, log every retry attempt so we can see it. Fine.', LONG)).toEqual(['log every retry attempt so we can see it']);
    expect(quoted('We will log every retry attempt so we can tell.', LONG)).toEqual([]);
    expect(quoted(`A: ${LONG} B: ${LONG}`, LONG)).toHaveLength(2);
  });

  const REPLY = 'take the flag first, I do not want a big bang rollout';
  test.each([
    ['an em dash', 'take the flag first\u2014I do not want a big bang rollout'],
    ['slashes', 'take/the/flag/first/I/do/not/want/a/big/bang/rollout'],
    ['an ellipsis', 'take the flag first...I do not want a big bang rollout'],
    ['HTML entities', 'take&nbsp;the&#32;flag&#x20;first, I do not want a big bang rollout'],
    ['a zero-width character', 'take the fl\u200bag first, I do not want a big bang rollout'],
    ['Markdown links and emphasis', '[take the flag first](https://x.test/a) I do *not* want a **big bang** rollout'],
    ['a hyphenated line wrap', 'take the flag first, I do not want a big bang roll-\n> out'],
    ['JSON glue', '{"evidence":"take the flag first, I do not want a big bang rollout"}'],
    ['attribute glue', '<q quote="take the flag first, I do not want a big bang rollout">'],
    ['a label', 'owner:take the flag first, I do not want a big bang rollout'],
    ['a contraction', "take the flag first, I don't want a big bang rollout"],
  ])('%s does not hide a quote', (_, text) => {
    const r = redactOwnerWords(text, ownerIndex([{ text: REPLY }]));
    expect(r.redacted).toBe(1);
    for (const word of ['take', 'flag', 'want', 'bang', 'roll']) expect(r.text).not.toContain(word);
  });

  test.each([
    ['an HTML tag', 'Jane Doe<br>vetoed it'],
    ['bold tags', '<b>Jane Doe</b> vetoed it'],
    ['an HTML comment', 'Jane <!-- aside --> Doe vetoed it'],
    ['a reference link', '[Jane Doe][1] vetoed it\n\n[1]: https://x.test "the source"'],
    ['a footnote marker', 'Jane Doe[^1] vetoed it'],
    ['a link title', '[Jane Doe](https://x.test "the source") vetoed it'],
    ['a literal JSON newline escape', '{"q": "Jane\\nDoe vetoed it"}'],
    ['a zero-width space entity', 'Jane Do&#8203;e vetoed it'],
    ['a soft hyphen entity', 'Jane Do&#173;e vetoed it'],
    ['a named zero-width entity', 'Jane Do&ZeroWidthSpace;e vetoed it'],
    ['a left-to-right mark', 'Jane Do\u200ee vetoed it'],
    ['a right-to-left mark', 'Jane Do\u200fe vetoed it'],
    ['a directional isolate', 'Jane \u2066Doe\u2069 vetoed it'],
    ['a combining grapheme joiner', 'Jane Do\u034fe vetoed it'],
    ['a variation selector', 'Jane Doe\ufe0f vetoed it'],
    ['an HTML tag with attributes', 'Jane <span class="highlight">Doe</span> vetoed it'],
  ])('%s does not hide a short quote', (_, text) => {
    const r = redactOwnerWords(text, ownerIndex([{ text: 'Jane Doe vetoed it' }]));
    expect(r.redacted).toBeGreaterThanOrEqual(1);
    for (const word of ['Jane', 'vetoed']) expect(r.text).not.toContain(word);
  });

  test('an accented letter written as a named entity, an astral character reference and a private link target do not hide a quote', () => {
    const accented = redactOwnerWords('Context: Jos&eacute; Alvarez vetoed it.', ownerIndex([{ text: 'José Alvarez vetoed it' }]));
    expect(accented.text).toBe(`Context: ${MARK}.`);
    expect(redactOwnerWords('Hello &#x1f600; Jane Doe vetoed it', ownerIndex([{ text: 'Jane Doe vetoed it' }])).text).toBe(`Hello &#x1f600; ${MARK}`);
    const link = redactOwnerWords('Ref: https://x.test/acquisition-of-private-company-closes-next-monday', ownerIndex([{ text: 'see [the notes](https://x.test/acquisition-of-private-company-closes-next-monday) today' }]));
    expect(link.text).not.toContain('acquisition');
  });

  test('the redaction covers the original characters, markup inside the quote included', () => {
    expect(redactOwnerWords('X: <b>Jane Doe</b> vetoed it.', ownerIndex([{ text: 'Jane Doe vetoed it' }])).text).toBe(`X: <b>${MARK}.`);
    expect(redactOwnerWords('{"q": "I don\\u2019t want it now"}', ownerIndex([{ text: "I don't want it now" }])).text).toBe(`{"q": "${MARK}"}`);
  });

  test.each([
    ['I cannot accept it', "I can't accept it"],
    ['I cannot accept it', 'I can not accept it'],
    ['It is too risky now', "It's too risky now"],
    ['I would ship it today', "I'd ship it today"],
    ['We will not ship it', "We won't ship it"],
    ['They are not ready yet', "They aren't ready yet"],
    ['They are not ready yet', "They're not ready yet"],
  ])('the reply %p matches %p', (reply, text) => {
    expect(redactOwnerWords(text, ownerIndex([{ text: reply }])).redacted).toBe(1);
  });

  test('new words a reply adds to echoed text are a quote on their own, whatever the whole reply\'s length', () => {
    const line = 'Persist the attempt count on the job row so a restarted worker resumes the schedule.';
    const o = ownerIndex([{ text: `${line.slice(0, -1)}, and page Jane Doe on call.`, prior: [line] }]);
    expect(redactOwnerWords('Note: and page Jane Doe on call.', o).text).toBe(`Note: ${MARK}.`);
    expect(redactOwnerWords(line, o).redacted).toBe(0);
  });

  test('a quote extends over the neighboring words of the same reply, so none is left on either side', () => {
    const reply = 'Honestly I do not want a big bang rollout on the retry path';
    expect(quoted('Well honestly, I don\u2019t want a big bang rollout on the retry path!', reply)).toEqual(['honestly, I don\u2019t want a big bang rollout on the retry path']);
    expect(quoted('> \u201cDon\u2019t ship the backoff\n>   without the flag, EVER\u201d\n', "don't ship the backoff without the flag, ever")).toEqual(['Don\u2019t ship the backoff\n>   without the flag, EVER']);
  });

  test('words the owner echoed from text recorded before the reply stay; the new words around them are redacted', () => {
    const line = 'Persist the attempt count on the job row so a restarted worker resumes the schedule.';
    const reply = `${line.slice(0, -1)}, and cap the retries at five attempts in total.`;
    const o = ownerIndex([{ text: reply, prior: [`## Implementation plan\n\n${line}`] }]);
    expect(redactOwnerWords(line, o)).toEqual({ text: line, redacted: 0 });
    expect(redactOwnerWords(`Relayed: "${reply}"`, o).text).toBe(`Relayed: "${line.slice(0, -1)}, ${MARK}."`);
    const title = 'Ship the backoff behind a flag first';
    expect(redactOwnerWords(`${title} [run-1-ceo-native-1]`, ownerIndex([{ text: title, prior: [title] }])).redacted).toBe(0);
  });
});

describe('redactOwnerWords', () => {
  test('replaces each quote with the marker, keeps the punctuation around it, and leaves other prose byte for byte', () => {
    const o = ownerIndex([{ text: LONG }]);
    expect(redactOwnerWords(`The owner: "${LONG}" Noted.`, o)).toEqual({ text: `The owner: "${MARK}." Noted.`, redacted: 1 });
    const control = 'Keep the backoff cap. Log every retry. Thirty seconds is fine.';
    expect(redactOwnerWords(control, o)).toEqual({ text: control, redacted: 0 });
  });

  test('a quote or placement overlapping a kept span (code) is left for the validator to refuse', () => {
    const o = ownerIndex([{ text: LONG }], { deferred: [{ text: 'no time' }] });
    for (const text of [`\`${LONG}\``, 'ceo closed deferred (no time) with this finding open']) {
      expect(redactOwnerWords(text, o, [[0, text.length]])).toEqual({ text, redacted: 0 });
      expect(ownerSpans(text, o)).toHaveLength(1);
    }
  });

  test("gstack's renderings of carried words and a human's deferral reason are replaced whatever their length, delimiters and all", () => {
    const o = ownerIndex([], { deferred: [{ text: 'no time' }], carried: ['Garry: do it'] });
    const cases: Array<[string, string]> = [
      ['CARRIED: gate_rev=2 <- gate_rev=1 words="Garry: do it" by=agent:x', `CARRIED: gate_rev=2 <- gate_rev=1 words=${MARK} by=agent:x`],
      ['Deferred ceo at round 1 (owner, by human): no time; 0 open finding(s)', `Deferred ceo at round 1 (owner, by human): ${MARK}; 0 open finding(s)`],
      ['ceo closed accepted-with-findings at round 1 (no time): 0 open', `ceo closed accepted-with-findings at round 1 (${MARK}): 0 open`],
      ['ceo closed deferred (no time) with this finding open; only you can accept it', `ceo closed deferred (${MARK}) with this finding open; only you can accept it`],
      ['round 1 (no time; by human); open findings', `round 1 (${MARK}; by human); open findings`],
      ['deferred: no time', `deferred: ${MARK}`],
    ];
    for (const [text, want] of cases) expect(redactOwnerWords(text, o).text).toBe(want);
    for (const kept of ['deferred: no time to spare', 'eng closed accepted-with-findings at round 1 (no time left): 0 open', '(no time; by agent:x)', 'we had no time to spare']) expect(redactOwnerWords(kept, o).text).toBe(kept);
  });

  test('every template that renders a deferral reason has a placement (add one to DEFERRAL_RENDERINGS with any new template)', () => {
    const root = path.resolve(import.meta.dir, '..');
    const count = Object.fromEntries(fs.readdirSync(path.join(root, 'lib')).filter(f => f.startsWith('autoplan-') && f.endsWith('.ts'))
      .map(f => [f, (fs.readFileSync(path.join(root, 'lib', f), 'utf8').match(/\$\{(?:o|def|d|ps\.deferred)\.reason\}|JSON\.stringify\(o\.reason\)/g) ?? []).length]).filter(([, n]) => n));
    expect(count).toEqual({ 'autoplan-gate.ts': 5, 'autoplan-export.ts': 1, 'autoplan-run.ts': 1 });
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
