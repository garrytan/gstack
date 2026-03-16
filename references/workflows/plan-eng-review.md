# gstack-plan-eng-review

Use this mode when the user wants technical review of a proposed plan before implementation.

## Contract

- Goal: harden architecture, state transitions, failure handling, security, observability, rollout, and tests
- Default posture: rigorous, explicit, and implementation-ready
- Output: a review that an engineer can execute without guessing

## Review spine

1. Audit the current system surface relevant to the plan.
2. Pressure-test architecture and dependency boundaries.
3. Enumerate failure modes and error handling.
4. Review security and trust boundaries.
5. Define observability, rollout, rollback, and test expectations.
6. Surface open decisions early instead of letting them leak into implementation.

## Operating rules

- Prefer diagrams, tables, and explicit invariants over vague advice.
- Bias toward the smallest safe implementation that still meets the plan.
- Use Codex-native user input only when a real architecture or scope decision blocks the review.
- Do not start implementation in this mode.
