# Codex reply shapes from #3925

Issue #3925 reports two Codex consult replies that the outside-review helper
summarised as `VERDICT: clean / FINDINGS: none`. The issue describes them but
does not include them, so these files are synthesized from what it quotes:

- `cant-verify.txt`: a reply whose last line is `Verdict: Can't verify (...)`.
  The reviewer says it could not finish, so it is not `clean`.
- `nonblocking-numbered.txt`: one numbered finding labeled `Nonblocking`, no
  P0-P3 tag, then `Verdict: ready` and `END OF REPORT: 1 findings (0 blocking)`.
  The verdict is `clean`, but `FINDINGS:` must not say `none`.
- `ready-clean.txt`: the negative control, a real clean reply with
  `Verdict: ready` and no findings.

`test/outside-review-unparsed-severity.test.ts` holds the expected verdicts.
