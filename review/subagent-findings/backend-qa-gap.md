Severity: high
File: lib/factory-qa-workflow.ts:8
Issue: Structured QA is modeled as read-only (`defaultPolicy.allowWrites: false`), but the execution path still dispatches `/skill:gstack-qa`, the write-capable "test and fix" workflow, without declaring write capabilities.
Why it matters: This breaks the factory policy boundary, so a browser-facing QA run that appears review-only can still edit the repo and bypass the write-risk checks meant to guard mutating workflows.
Recommendation: Dispatch `/skill:gstack-qa-only` whenever writes are disabled, or make QA explicitly write-capable by adding filesystem/git capabilities plus an explicit `allowWrites: true` override before invoking `/skill:gstack-qa`.
