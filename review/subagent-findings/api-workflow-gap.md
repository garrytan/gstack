Severity: medium
File: lib/factory-review-workflow.ts:11; .pi/extensions/pi-gstack/index.ts:156
Issue: The review workflow advertises a read-only contract (`defaultPolicy.allowWrites: false`), but the only shipped `/factory-review` entrypoint hard-codes `policy: { allowWrites: true }` because `git` is treated as write-capable.
Why it matters: Workflow metadata, UI approvals, and future clients cannot trust whether review is actually read-only, so they will either over-block a diff-only flow or silently grant broader write authority than the contract promises.
Recommendation: Split repo-read from repo-write capability/policy and remove the forced override; until then, mark the review workflow as write-required everywhere the contract is exposed.
