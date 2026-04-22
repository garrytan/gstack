# API Contract Lenses

This reference keeps the review practical and compatibility-focused.

## Start with the client

Ask:

- who calls this interface?
- can they update in lockstep with the server?
- what do they need to know to recover from errors?
- what assumptions will they make after reading one example?

Contracts fail when teams optimize for server implementation details instead of client behavior.

## REST by default

Prefer REST/HTTP unless the plan clearly benefits from something else.

REST is usually the right choice when:

- clients are heterogeneous
- debugging with curl/browser/devtools matters
- the interface is ordinary request/response CRUD or workflow endpoints
- operational simplicity matters more than raw throughput

## When gRPC is justified

Consider gRPC when:

- service-to-service contracts are the primary audience
- strong schemas and generated clients are valuable
- streaming or high-call-volume internal traffic matters
- the team already operates protobuf tooling well

Do not recommend gRPC just because it feels more "serious."

## Async and webhook contracts

Async contracts need only a light v1 artifact:

- event or message name
- producer
- consumer
- payload fields that matter
- delivery semantics
- retry or dedup expectations

Critical questions:

- can messages be delivered more than once?
- in what order, if any?
- how does the consumer know it already processed one?
- what happens when the receiver is down?

## Compatibility and versioning

Default bias: additive change over breaking change.

Watch for:

- new required inputs on existing routes
- removed or renamed fields
- changed response shapes
- changed status codes or auth rules
- mixed versioning strategies

Only bump versions when the break is real and worth the migration cost.

## Error models

The error format should be more consistent than the success payloads.

Minimal useful shape:

- machine-readable code
- human-readable message
- optional field-level details
- correlation/request id when appropriate

Avoid:

- stack traces in public responses
- 200 responses for failures
- one-off error bodies per endpoint

## Idempotency and retries

If a client or upstream system might retry, the plan should say whether the operation is:

- naturally idempotent
- protected by an idempotency key
- duplicate-safe only through dedup later

This matters especially for:

- payment-like operations
- webhook receivers
- create endpoints with slow downstream side effects

## Pagination and rate limits

List endpoints need a pagination stance, even if basic.

The plan should answer:

- cursor or offset?
- default page size?
- how clients know there is more?

Rate-limit guidance matters when one client can accidentally create broad load.

## Documentation readiness

v1 does not need generated specs, but the plan should be ready for them.

That means the plan has already decided:

- interface style
- inventory of endpoints/services/events
- request and response shapes at a useful level
- compatibility promises
- error conventions

If those are missing, spec generation later will simply move the ambiguity around.
