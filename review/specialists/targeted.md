# Targeted Review Brief: money, gate, auth and secret code

Scope: every diff whose `gstack-review-plan` TARGETED line names a class, at every depth; the reader gets the preamble and the block of each class that hit.
Output: JSON objects, one finding per line. Schema:
{"severity":"CRITICAL|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"money|gate|auth|secret","summary":"...","fix":"...","fingerprint":"path:line:category","specialist":"targeted"}
Optional: line, fix, fingerprint, evidence, test_stub, cause.
If no findings: output `NO FINDINGS` and nothing else. `NO FINDINGS` is a complete result, not a failure to look.

---

Read-only: read the diff and the code it reaches, and edit, commit, post or run nothing that writes.
Read deleted lines as closely as added ones: a removed cap, check or redaction is the change under review.
Follow each changed value to where it is enforced: a cap, check or redaction that exists but is never reached is missing.

CRITICAL is the blocking floor: a finding that would fail a test, break production, lose data or secrets, or open a security hole (injection, auth bypass, secret exposure). Everything else is INFORMATIONAL.

## money
The checklist's Forced-CRITICAL line covers this block (review/checklist.md): uncapped spend, "a paid call, retry or loop with no cap", is "CRITICAL on sight", and no lane, specialist, dedup step or saved decision downgrades it.
- A paid call (a model API, a cloud VM, a paid search) reachable without a cap, or a retry, loop or fan-out around one with no bound on count or spend.
- A cap read but not enforced: checked after the spend, compared in the wrong unit (cents and dollars, tokens and USD), or a missing value read as unlimited.
- A cap check removed, loosened, or moved behind a flag that defaults to off.
- Spend recorded wrong: an estimate stored as actual cost, a failed call recorded as zero, a double count, or a ledger write that can be skipped.

## gate
- A check that fails open: an error, timeout, missing input or unreadable file read as a pass, or an empty result read as green.
- A threshold, required check, allowlist or rule loosened, skipped or made optional; a test skipped or deleted together with the guard it covered.
- A verdict bound to the wrong subject: another commit, tree, branch, PR or run than the one being merged, or a stale result reused.
- A rule hash, pin or ratchet that detects such an edit changed in the same diff without the evidence it asks for.

## auth
- A bypass: a route, command or path reachable without the identity check its siblings run, or a default that allows.
- A permission checked on the wrong subject: the caller instead of the owner, a role read from input, or a check made before the object is resolved.
- A session or token accepted after expiry, revocation or a role change, or a callback that skips its single-use state value.

## secret
- A secret written where others can read it: logs, error messages, PR bodies, comments, artifacts, URLs, readable files, or a child process's arguments.
- A redaction, scrub, mask or file mode removed or bypassed, or a new output path that skips the existing redactor.
- A key read from a broader source than before, a fallback to a hardcoded value, or a real credential committed in code or fixtures.
