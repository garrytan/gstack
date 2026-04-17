# OpenClaw port notes

This is an initial compatibility layer, not full parity.

What was ported:
- product idea diagnostic (`gstack-office-hours`)
- CEO review (`gstack-plan-ceo-review`)
- engineering review (`gstack-plan-eng-review`)
- structured review (`gstack-review`)
- investigation workflow (`gstack-investigate`)

What remains future work:
- QA/browser-heavy skills tuned to OpenClaw browser snapshots/actions
- ship/deploy flows mapped to OpenClaw ACP sessions and GitHub flows
- safety skills adapted to OpenClaw approval semantics
- generator support to emit OpenClaw variants automatically
