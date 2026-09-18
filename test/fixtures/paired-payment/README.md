# Existing payment function

This private application module already runs in Bun. The proposal considers
verification of `processPayment()` in `src/payment.ts`; it changes no runtime
behavior, dependency, public API, persistence or deployment. Run the existing
contract tests with `bun test contract.test.ts`. No install, credentials,
network service or real clock is needed.

Repository convention: public-function contracts live in `contract.test.ts`,
with inline `PaymentIO` stubs in each case, as in the existing tests. Extend that
suite for additional contracts; there is no separate test framework or shared
mock-helper layer to design for this change.

The injected `chargeOnce` transport makes one Stripe request per invocation and
returns a validated charge ID or a `ProviderError`. It has no automatic retries.
`processPayment` owns the sole retry: a 502 or timeout waits 100 ms, then tries
once more with the same frozen request and idempotency key. A second such failure
throws `PaymentFailure` with the last cause, key and `outcomeUnknown: true`.
An earlier uncertain outcome stays unknown even if the retry fails with a different
error. This means the charge is unconfirmed, never proof that no charge happened; the
existing caller reconciles that key instead of starting a fresh payment. Decline,
invalid-request and authentication errors are not retried.
If the injected wait rejects, no second transport call starts: `PaymentFailure`
preserves that wait error as its cause and the earlier unknown charge outcome.

A receipt here is the returned scalar value (charge ID, amount in minor units,
currency). No separate receipt builder, storage or email can fail after the
charge. Input validation runs before transport. The module never handles card
data, credentials, logging, webhooks or request admission; those remain in the
unchanged calling application and transport. No API or SDK migration is proposed.

Existing tests cover invalid input, nonretryable errors (including cause identity),
and recovery after a first 502 or timeout. Recovery checks retry ownership, a frozen request
and receipt despite caller mutation, and that the second transport call cannot
start until the injected 100 ms wait resolves. Mixed retryable-then-nonretryable
failures preserve the unknown outcome and final cause. A rejecting wait is wrapped
without another transport call. These are existing tested contracts.
The function and these existing contracts are available for inspection; report
any actual additional defect rather than assuming undocumented payment features.
