# GST-766 part (b) no-loss replay: preregistration

Committed before the collector edit. Approved by the owner gate (autoplan run-20261101155438, gate_rev 2; Garry's "Do it" on A1, relayed with the Captain's approval of A2 B2 C2 D2 and the proof changes). Nothing below changes after a result is seen.

## Change under test

The native adversarial voice's FIXABLE tag forces CRITICAL (lib/review-ledger.ts `named`, and a `## FIXABLE` heading). After the change, a finding forced that way that carries its own `Blocks: no` field (a Blocks field line, or a trailing "Severity: X. Blocks: no" clause on the finding's own line, outside backticks and quotes) collects at the stronger of its stated Severity and any non-FIXABLE label written on it (Medium when neither). Never lowered: a finding with any `Blocks: yes`, a written Critical/High/P0, JSON findings, any other role.

## Corpus (fixed now)

Saved raw outputs, role adversarial-native unless named:

- test/fixtures/review-ledger/gsta-196-native.txt, harn15-ship2-p2-adversarial-native.txt, harn15-152-p1-adversarial-native.txt (in repo)
- GSTA-189 Step 11 (gstack-evals #36): adversarial-native.txt and outside-voice.txt (outside: confinement control)
- This lane's /ship runs with saved raw Step 11 outputs: GST-691 p2/p3/p4, GST-713 p1, GST-716 p1, GST-732 p1/p2, GST-743 p1, GST-766 p1/p2 (positive controls), GST-770 p1
- GSTA-197/198: merged lines only, replayed through the settle step (no raw output)
- replay6c/7e/8g/9g-36: no saved raw output; listed, not replayed

Fresh capture on garrytan/gstack-evals PR #36 at 42ff510 (merge base 1b68e637), the pinned Step 11 briefs rendered by this branch's gstack-review-dispatch (adversarial-native sha256 a84fdce2…, outside-voice sha256 4033bec0…), each sent unchanged as the subagent prompt and its reply saved as raw output:

- 4 adversarial-native runs, anthropic/claude-opus-5-5 high
- 1 outside-voice run, openai/gpt-6.1-sol medium

Run counts are fixed; no run is added or repeated after a result is seen. A run that fails to produce a review is reported as failed, not replaced.

#3803's negated-line fixtures and test cases: every one must still collect as it does at 6e6685f6.

## Baseline

Each entry's findings as the collector at 6e6685f6 parses them, frozen into manifest.json (id, label, raw sha256) before the edit.

## Gold

Candidates: every adversarial-native finding the baseline collects CRITICAL whose written labels include FIXABLE (the superset the change can touch, whatever its Blocks field says). Each is adjudicated blind by two judges, openai/gpt-6.1-sol and google/gemini-4-argon, given the checkout, base, head, diff and the finding text with its Severity and Blocks fields and its FIXABLE/INVESTIGATE tag removed, using the judge prompt below. Gold-blocking if either judge says BLOCKING. Judges never see collector output. Findings outside the candidate set may not change label at all (confinement).

## Positive controls (must lower)

gsta-196-native findings 2 and 3; GST-766 Step 11 adversarial-native findings 4 and 5 (ship-766 run).

## Bar (one miss fails the change)

- lost = 0: no gold-blocking finding stops collecting CRITICAL
- negated_lost = 0
- controls_lowered = all
- confinement = ok: head equals baseline on finding count, ids, raw text and every label except lowered candidates
- fail-closed: a missing or hash-mismatched input, a wrong role or an unresolved gold match exits nonzero

Reported beside it, not a bar: affected (lowered) count, lowered gold-nonblocking count. If affected < 10, READY says so plainly. A null or negative result gets the R48 "Why null?" cycle and a KEEP / FIX-METHOD / CUT-CANDIDATE verdict.

## No-gstack arm (R44)

anthropic/claude-opus-5-5 (high) and openai/gpt-6.1-sol (medium), once each, on the same #36 checkout with the plain prompt below and no gstack text. Both collectors read the outputs (role adversarial-native for Opus, outside-voice for Sol); their findings are adjudicated by the same panel and reported beside the gstack arm as baseline context. Expected: identical labels under both collectors, because a plain prompt emits no FIXABLE.

## Spend

About $15-25 for the capture, the no-gstack arm and adjudication, inside the $150 part (b) cap.

## Plain no-gstack prompt

```text
Review the changes on the current branch of the git checkout at /home/user/.capy/work/cap36/wt against its merge base with origin/main (1b68e637c07cea38f01c01120e02d184575da82c). Find real bugs and risks in the changed code. For each problem, say where it is (file:line), what goes wrong, and how serious it is. If you find nothing worth reporting, say so.
```

## Judge prompt

```text
You are judging code-review findings for one diff. You do not know who wrote them or what label they carried.

The diff is the output of `git diff <BASE>...<HEAD>` in the checkout named on each item (the file named "diff" on the item has it too). Read the code you need.

For each item in the input JSONL (fields: id, checkout, base, head, diff, finding), decide whether the finding, if it is true, would make the change fail a test, break production, or lose data or secrets. Check that it is true against the code; a finding that is false or speculative is NOT_BLOCKING.

Write one JSON line per item to the output file, in input order: {"id":"<id>","verdict":"BLOCKING"|"NOT_BLOCKING","reason":"<one sentence naming the code that decides it>"}. Write nothing else to that file.
```
