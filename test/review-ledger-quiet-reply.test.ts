/**
 * GST-2972 (#4431, twice): the collector minted Critical findings from a reader's confirmation prose. A fix-check whose own
 * REVIEW_VERDICT said blocking=0 (p1fc at 00155f5) wrote "a High or Critical challenge" in a paragraph naming
 * autoplan-revise.ts:103, and a clean one (blocking=0 and NO FINDINGS, p3fc at b1b3c3c) had a nested bullet under a line naming
 * lib/autoplan-gate.ts:197. The file:line made each an anchored Critical that lead judgment could not lower, so each cost an owner
 * ruling. Captain ruling D1 (2026-11-14, test/review-verdict.test.ts) holds: a verdict line lowers nothing by itself, and neither
 * does NO FINDINGS (Captain, 2026-11-17: prose that names a real blocker must not vanish). So the prose rows still collect and block,
 * but a file:line in prose, or a list item in a NO FINDINGS reply, no longer anchors them: under a valid verdict that declares fewer
 * blockers each is a summary candidate the lead may lower with a reason, instead of an owner ruling.
 */
import { describe, expect, test } from 'bun:test';
import { parseReply } from '../lib/review-ledger';

// The two replies as the readers returned them (GSTA-573 subagents 3.3 and 3.9).
const P1FC = "REVIEWED_TREE: 00155f52976c3d27c8c874c16ba0f16b401ed97f /workspace/gstack\nREVIEW_VERDICT: blocking=0\n\n{\"severity\":\"INFORMATIONAL\",\"path\":\"lib/autoplan-confirm.ts\",\"line\":125,\"summary\":\"Fix 1 still lets an ordinary finding close an unrelated open challenge when that finding is marked settled_by. annotateConfirm (line 163) sets row.correlates to every earlier row whose title scores at least 0.6, but it sets settled_by from only one of them (`prior`). Take a later-round Low row whose title matches both earlier challenge A, which was answered at the gate, and earlier challenge B, which is still open. That row gets settled_by A's decision and correlates [A, B], so openEarlier counts B as covered, and buildGate (line 221) never carries B to the owner. Fix 1 was meant to stop this kind of silent close. Fix: count a settled row's correlates only for the ids that settledIds actually contains.\"}\n\nFixes 2 and 3 look sound. Fix 2 now sends a quoted-plan user_challenge that has no valid owner_quote to propose(), whatever its severity. The one behaviour change is for a High or Critical challenge like that: it used to become a `|finding` item with a \"carry into the build as a blocking task\" option, and now it becomes a proposal. That is the same treatment challenges that carry `changes` already get, the twin bundling is unchanged, and the rerun agentDecision path isn't reachable from the new branch. Fix 3 only appends a fourth origin segment. Every origin parser I found (settledIds, decisionSeverity in autoplan-revise.ts:103, and autoplan-shadow.ts:198) reads segments [0] and [1], so none of them break. The day-one titles it hashes are stable (the `reason` strings in autoplan-owner-text.ts are fixed text), so a change only asks again when the list or a row's wording actually changed. A gate answered before this commit gets re-asked once after the upgrade, which errs on the side of asking again. The commit only adds tests and doesn't weaken any existing one. I reran `bun test test/autoplan-day-one-gate.test.ts` at this tree: 21 pass, 0 fail.\n";
const P3FC = "REVIEWED_TREE: b1b3c3cca68f1087cbca0d4f24c94e168daeb920 /workspace/gstack\nREVIEW_VERDICT: blocking=0\n\nNO FINDINGS\n\nEvery statement in 9c1e407 and ed1dd85 matches the code at HEAD ed1dd85. I checked each one against its source:\n\n- **Result-format contract (docs/unattended.md).** It matches `RESULT_FORMAT` in lib/autoplan-prompts.ts:126 and the parser. `CHANGES` in lib/autoplan-reconcile.ts:36 accepts scope, cost, direction, packaging and ordering, and the parser takes `owner_quote` (positive integer) and `resolves`.\n- **Gate step.** It matches `buildGate` (lib/autoplan-gate.ts:197-288) and lib/autoplan-gate-items.ts:\n  - With an Owner's words section, a `changes` or `user_challenge` row that names no quote becomes a `proposal` uc approval item. Its `b` keeps the draft, and that becomes a blocking build task when any row is Critical or High (`blockingProposal`, `FINDING_ORIGIN`).\n  - Without that section, `confirm_direction` is a d/auto item, added only when a one-voice challenge1 was kept.\n  - Earlier open challenges come back through `openEarlier`, and only a later `resolves` row or an owner's answer closes them.\n  - `day_one` items (missing page when `scope.ui` is set, plus each assumed row) and `cut` items (a cut that drops a day-one row or quote) are uc approvals. The other cuts form one `cuts` d/auto item.\n- **Owner-only replies (troubleshooting `OWNER_REPLY_REQUIRED`, unattended step 4).** The guard at lib/autoplan-gate.ts:455 refuses agent words on any non-p1 `approval` item. That covers proposal, day_one and cut, and correctly leaves out the auto items `cuts` and `confirm_direction`.\n- **Redaction (`ARTIFACT_OWNER_WORDS` and the public-copy text).** lib/autoplan-owner-words.ts:277-278 reads quotes from plan-active, plan-source*, plan-at-gate.r*, and plan-file.* files, so a quote a later revision removed stays redacted.\n- **Shadow item_class list.** It equals `ItemClass` in lib/gate-list.ts:51-52.\n- **Brief order, owner brief.** lib/owner-brief.ts:89-96 renders URGENT, then `renderDayOne`, then the summary.\n- **Brief order, captain.md.** lib/captain-brief.ts:146 renders URGENT, the header, then Day one / What it won't do yet / \"Your words this plan follows\" (each only when present), then ELI5 and the sections. So captain.md's new order still tells agents the right thing.\n- **Changelog.** The High/Critical decline sentence matches `proposalItem`'s `b` text and `settledIds` (a finding-origin decision settles only on `a`). The removed-quote redaction sentence matches the redaction code above. Dropping the tracker code passes `changelog-fragments.test.ts`.\n\n**Tests.** The fix list's 10 files (730 pass) didn't cover the files that read these docs or the fragment, so I also ran changelog-fragments, capy-skill-wrapper, captain-brief, host-conformance and docs-only at this tree: 155 pass, 0 fail.\n\nThe fixes change no code symbols, so there are no callers to break.\n";

const blocking = (r: ReturnType<typeof parseReply>) => r.findings.filter(f => /^(CRITICAL|P0|P1|HIGH)$/i.test(f.label));

describe('confirmation prose in a reply that says nothing blocks (GST-2972)', () => {
  // Value: protects=the two #4431 replies: each prose Critical is a summary candidate the lead may lower, and p1fc keeps its JSON
  //   finding; fails_when=either prose row is an anchored Critical (the owner-ruling stop), or the JSON line is lost;
  //   seam=parseReply as collect calls it (verdict asked); no_claim=what the lead decides about the candidate
  test('p3fc and p1fc prose rows are summary candidates, not anchored Criticals; p1fc keeps its JSON finding', () => {
    const p3 = parseReply('fix-check', P3FC, true, true);
    expect(p3.findings.map(f => [f.label, f.summary ?? false])).toEqual([['Critical', true]]);
    expect(p3.findings[0]!.raw).toStartWith("- With an Owner's words section");
    expect(p3.verdict).toMatchObject({ state: 'valid', declared: 0, parsed: 1, agrees: false });
    const p1 = parseReply('fix-check', P1FC, true, true);
    expect(p1.findings.map(f => [f.label, f.summary ?? false])).toEqual([['INFORMATIONAL', false], ['Critical', true]]);
    expect(p1.findings[0]!.raw).toContain('"path":"lib/autoplan-confirm.ts"');
    expect(p1.findings[1]!.raw).toStartWith('Fixes 2 and 3 look sound.');
    expect(p1.verdict).toMatchObject({ state: 'valid', declared: 0, parsed: 1, agrees: false });
  });

  // Value: protects=negative controls: a structured blocker in a blocking=0 or NO FINDINGS reply still collects as CRITICAL, is no summary candidate, and the
  //   verdict disagrees, and the same prose under a verdict that declares a blocker still collects; fails_when=the quiet rule drops a
  //   lead-labelled, Severity-field, Blocks: yes or JSON blocker, or prose in a reply that declares one; seam=parseReply
  test('a structured blocker still collects in a quiet reply, and prose still collects when the verdict declares a blocker', () => {
    const head = 'REVIEWED_TREE: ' + 'a'.repeat(40) + ' /workspace/gstack\nREVIEW_VERDICT: blocking=0\n\n';
    for (const line of [
      '**CRITICAL** lib/store.ts:40: the migration drops the rows it was meant to copy.',
      'lib/store.ts:40: the migration drops the rows it was meant to copy.\nSeverity: Critical',
      'lib/store.ts:40: the migration drops the rows it was meant to copy. Blocks: yes',
      '{"severity":"CRITICAL","path":"lib/store.ts","line":40,"summary":"the migration drops the rows it was meant to copy"}',
    ]) {
      for (const tail of ['', '\nNO FINDINGS\n']) {
        const r = parseReply('fix-check', head + line + '\n' + tail, true, true);
        expect(blocking(r).length).toBe(1);
        expect(blocking(r)[0]!.summary).toBeUndefined();
        expect(r.verdict).toMatchObject({ declared: 0, parsed: 1, agrees: false });
      }
    }
    const declared = parseReply('fix-check', P1FC.replace('REVIEW_VERDICT: blocking=0', 'REVIEW_VERDICT: blocking=1 at=lib/autoplan-gate.ts:257'), true, true);
    expect(blocking(declared).length).toBeGreaterThanOrEqual(1);
    expect(blocking(declared).every(f => !f.summary)).toBe(true);
    const unasked = parseReply('fix-check', P1FC, true, false);
    expect(blocking(unasked).map(f => f.summary ?? false)).toEqual([false]);
  });

  // Value: protects=a NO FINDINGS reply whose prose names a real blocker still blocks (Captain, 2026-11-17; the GPT-6.1 Sol trail read
  //   on #4449): under blocking=0 it is a summary candidate the lead must lower with a reason, and with no verdict asked it is an
  //   ordinary CRITICAL; negative control: NO FINDINGS prose with no file:line still collects nothing (GST-2122);
  //   fails_when=the token-leak line vanishes or the verdict agrees, or unlocated prose starts collecting; seam=parseReply
  test('a NO FINDINGS reply whose prose names a token leak still blocks', () => {
    const leak = 'No CRITICAL issues except the token leak in log.ts:3.';
    const head = 'REVIEWED_TREE: ' + 'a'.repeat(40) + ' /workspace/gstack\nREVIEW_VERDICT: blocking=0\n\nNO FINDINGS\n\n';
    const asked = parseReply('fix-check', head + leak + '\n', true, true);
    expect(blocking(asked).map(f => [f.raw, f.summary ?? false])).toEqual([[leak, true]]);
    expect(asked.verdict).toMatchObject({ state: 'valid', declared: 0, parsed: 1, agrees: false });
    const unasked = parseReply('fix-check', 'NO FINDINGS\n\n' + leak + '\n', true, false);
    expect(blocking(unasked).map(f => [f.raw, f.summary ?? false])).toEqual([[leak, false]]);
    const unlocated = parseReply('fix-check', head + 'I read every changed file and the critical paths look right.\n', true, true);
    expect(unlocated.findings).toEqual([]);
    expect(unlocated.verdict).toMatchObject({ state: 'valid', declared: 0, parsed: 0, agrees: true });
  });

  // Value: protects=the native voice's FIXABLE tag does not anchor a prose row in a NO FINDINGS reply (#4449's read-only final review),
  //   so under blocking=0 it stays a summary candidate as on main; negative control: with no verdict asked it is a plain CRITICAL;
  //   fails_when=the FIXABLE-only row is anchored (an owner stop) or stops blocking; seam=parseReply with the native voice
  test('a FIXABLE-only prose row in a NO FINDINGS reply is a summary candidate, not an anchored Critical', () => {
    const row = "The cache key ignores the user id, so one user can read another user's cached page. FIXABLE: key on the user id too.";
    const head = 'REVIEWED_TREE: ' + 'a'.repeat(40) + ' /workspace/gstack\nREVIEW_VERDICT: blocking=0\n\nNO FINDINGS\n\n';
    const asked = parseReply('adversarial-native', head + row + '\n', true, true);
    expect(blocking(asked).map(f => [f.label, f.summary ?? false])).toEqual([['CRITICAL', true]]);
    expect(asked.verdict).toMatchObject({ state: 'valid', declared: 0, parsed: 1, agrees: false });
    const unasked = parseReply('adversarial-native', 'NO FINDINGS\n\n' + row + '\n', true, false);
    expect(blocking(unasked).map(f => [f.label, f.summary ?? false])).toEqual([['CRITICAL', false]]);
  });
});
