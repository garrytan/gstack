export interface Payment { key: string; amount: number; currency: 'usd' }
export interface Receipt { chargeId: string; amount: number; currency: 'usd' }
export interface PaymentIO {
  /** Existing transport makes exactly one request, with no SDK retry layer. */
  chargeOnce(payment: Readonly<Payment>): Promise<{ id: string }>;
  sleep(ms: number): Promise<void>;
}
export class ProviderError extends Error {
  constructor(public readonly code: '502' | 'timeout' | 'declined' | 'invalid' | 'auth') {
    super(code);
  }
}
export class PaymentFailure extends Error {
  constructor(public readonly key: string, public readonly outcomeUnknown: boolean, cause: unknown) {
    super('Payment could not be confirmed', { cause });
  }
}

/** Existing function; this review proposes tests, not a new payment design. */
export async function processPayment(payment: Payment, io: PaymentIO): Promise<Receipt> {
  if (!payment || typeof payment.key !== 'string' || !payment.key || payment.key.length > 128
    || !Number.isSafeInteger(payment.amount) || payment.amount <= 0 || payment.currency !== 'usd') {
    throw new TypeError('Invalid payment');
  }
  // Snapshot once: caller mutation cannot change the idempotency key on retry.
  const request = Object.freeze({ key: payment.key, amount: payment.amount, currency: payment.currency });
  let outcomeUnknown = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const charge = await io.chargeOnce(request);
      // Receipt is a value, with no storage, email, formatting or second I/O.
      return { chargeId: charge.id, amount: request.amount, currency: request.currency };
    } catch (error) {
      const retryable = error instanceof ProviderError && (error.code === '502' || error.code === 'timeout');
      outcomeUnknown ||= retryable;
      if (!retryable || attempt === 1) throw new PaymentFailure(request.key, outcomeUnknown, error);
    }
    try {
      await io.sleep(100);
    } catch (cause) {
      throw new PaymentFailure(request.key, outcomeUnknown, cause);
    }
  }
}
