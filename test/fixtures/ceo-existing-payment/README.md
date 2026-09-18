# Existing payment integration baseline

This small synthetic application models an integration after Stripe has settled a
payment. It does not charge a card. The existing ingress adapter verifies the raw
Stripe signature and signing account and supplies the event context. Its userId
metadata remains untrusted. The local user status is a projection of settled
payments; the financial ledger and credentials are unchanged outside this model.

`src/platform.ts` contains the existing transaction boundary and WebhookDispatcher.
The dispatcher only registers and invokes a handler: it supplies no lookup,
notification or order-reading policy. `applyPaidProjection` owns early receipt
deduplication, account/customer checks, account/user-scoped order readers and the
atomic status/receipt/audit commit. A missing order or database exception rolls
back this transaction; ordinary request-error handling stays outside the handler.
It orders the distinct requested line items by ID for the existing mail template.
Notifications run after commit, with no catch, outbox or retry provided by the
facade. A notification failure cannot undo the database commit.
The existing invoice tests exercise atomicity by aborting the audit insert after
the user-status update and receipt insert, then checking that all three writes
rolled back. This covers the shared transaction, not the proposed handler.

`src/existing-invoice-handler.ts` registers only the current `invoice.paid` path. That
path updates the local projection and audit without sending notification mail.
It uses `createBoundUserLookup` and `readOrdersInBatch` from `src/platform.ts`.
These callbacks are independently reusable; choosing one does not choose the other,
and neither dispatcher registration nor the facade selects them for a handler.
`src/application.ts` materializes the application composition API and request
adaptation described by this fixture: handlers can access `services.db`, `mail`,
`logger` and `metrics`, and register with this application's existing dispatcher.
It accepts already-admitted requests without changing userId. It passes committed,
duplicate, unknown-user and forbidden outcomes through; exceptions produce scoped
logs/metrics and a 503. Every request metric and failure log includes the supplied
event type, so existing telemetry distinguishes registered and unregistered routes.
The signature verifier, provider I/O, database statement
deadline and production telemetry sinks remain external dependencies.

The shared callbacks and request event-type telemetry above are **NEW executable
synthetic baseline contracts**, not approvals of their use in the proposed handler.
The following synthetic baseline contracts also remain in place:
- An unregistered event returns a visible 503 without projection or mail work.
  This does not specify external Stripe retry behavior or preapprove registration.
- `src/application-services.ts` observes the already-bounded confirmation client
  independently of a handler's catch. Each send records sent/timeout/rejected/failed;
  failures are logged and the exact original error is rethrown. Telemetry is best
  effort and cannot change the transport outcome. The supplied transport retains
  its existing template, recipient and five-second timeout; there is no retry,
  outbox, handler recovery policy, alert threshold or dashboard in this contract.

The proposed PaymentService for `payment_intent.succeeded` is absent. Its proposed
raw user lookup, inline uncaught email, per-order read loop, dispatcher bypass and
missing new-path tests remain the review target in `review-input.md`.

There is no new schema, migration, quarantine service or handler-specific routing
flag to build in this proposal. Deploy and rollback use the application's existing
release procedure. Review actual problems in the proposed handler and baseline;
these fixture assumptions do not preapprove any remedy or exempt a review section.

Run the existing invoice and shared-boundary checks with `bun test contract.test.ts`.
