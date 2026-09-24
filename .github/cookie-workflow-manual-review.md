# Cookie workflow manual-review exception

`cookie-workflow-manual-review.json` records the maintainer's approval for one
exact cookie-workflow judge request. It is not generated content. Do not update
its hash, model, budget, thresholds, or provenance just to make a changed test
pass; a changed request needs a new explicit review and approval.

The ordinary judge request still runs. Only an explicit provider refusal with
complete request/response identifiers, zero output tokens, and no text blocks
can use this approval. Low scores, malformed output or evidence, other errors,
timeouts, and late or superseded attempts remain failures. Every other case
remains subject to its existing gate.

Manual acceptance is first-attempt-only: a retry refusal cannot erase an earlier
scored failure, timeout, or other error. Normal configured retries are unchanged.

The collector preserves `passed: false`, `execution: executed`, the refusal,
and the manual approval, without a score or score-cache receipt. Reports count
manual acceptance separately from automated passes and failures; “executed”
counts the actual provider request, not a completed scored evaluation. Historical
records retain that distinction. CI also checks manual claims against the
current source and committed approval before accepting them.
